import fs from 'node:fs/promises'
import path from 'node:path'
import type { AgentEvent, AgentRunDTO, AgentScope } from '../shared/types'
import { AIRequestError } from './ai'
import { AISettingsError } from './ai-settings'
import type { NoteAgent, AgentModel } from './agent'
import { ChatGPTError } from './chatgpt'
import { MissingRecordError } from './discussions'
import { readRecord, StorageError, writeRecord } from './persistence'
import { BadNameError, ConflictError, contentVersion, type NoteStore } from './store'

const finished = (status: AgentRunDTO['status']) => !['queued', 'running'].includes(status)
const NEVER_ATTACHED_MS = 15000
type Listener = (entry: { seq: number; event: AgentEvent }) => void
type Active = { controller: AbortController; run: AgentRunDTO; events: { seq: number; event: AgentEvent }[]; listeners: Set<Listener>; attached: boolean; stopped: 'user' | 'disconnect' | null; writing: Promise<unknown>; timer?: ReturnType<typeof setTimeout> }

/**
 * Runs the Note Agent on the server. The model/tool loop, tools, prompts and write rules are the unchanged
 * `NoteAgent`; this layer only accepts a request once it is on disk, numbers and buffers its events so a client
 * can reattach, supports an explicit stop, and marks unfinished runs interrupted after a restart.
 * A run never replays tool calls after a restart: the conversation and change records hold what already happened.
 */
export class AgentRunService {
  private readonly directory: string
  private active = new Map<string, Active>()
  private recovered = false

  constructor(private store: NoteStore, private agent: NoteAgent, private options: { track?: <T>(task: Promise<T>) => Promise<T>; shutdown?: AbortSignal; guard?: () => void } = {}) {
    this.directory = path.join(store.paths.local, 'agent-runs')
  }

  private file = (id: string) => path.join(this.directory, id + '.json')

  /** True while any run is executing; used to hold back a sync. */
  get busy() { return [...this.active.values()].some(item => !finished(item.run.status)) }

  async get(id: string): Promise<AgentRunDTO> {
    const live = this.active.get(id)
    if (live) return { ...live.run }
    if (!/^[a-f0-9]{32}$/.test(id)) throw new BadNameError('运行编号无效。')
    const record = await readRecord<AgentRunDTO & { version: 1 }>(this.file(id))
    if (!record) throw new MissingRecordError('找不到这次运行。')
    if (record.version !== 1 || record.id !== id) throw new StorageError('运行记录格式无效，请保留文件并检查备份。')
    const { version, ...run } = record
    return run
  }

  async recover(): Promise<void> {
    if (this.recovered) return
    this.recovered = true
    let names: string[]
    try { names = (await fs.readdir(this.directory)).filter(name => /^[a-f0-9]{32}\.json$/.test(name)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    for (const name of names) {
      const run = await this.get(name.slice(0, -5))
      if (!finished(run.status) && !this.active.has(run.id)) await writeRecord(this.file(run.id), { version: 1, ...run, status: 'interrupted', error: '服务重启时这次任务尚未完成。已完成的修改保留在修改记录中，不会自动重新执行；请检查后再继续。', updatedAt: Date.now() })
    }
  }

  private save(state: Active): Promise<void> {
    const write = state.writing.then(() => writeRecord(this.file(state.run.id), { version: 1, ...state.run }), () => writeRecord(this.file(state.run.id), { version: 1, ...state.run }))
    state.writing = write.catch(() => undefined)
    return write
  }

  /** Idempotent per request key. The record is on disk before this returns. */
  async start(input: { requestKey: string; scope: AgentScope; session?: string; message: string; selection?: string }, model: AgentModel, options: { cancelOnDisconnect: boolean }): Promise<AgentRunDTO> {
    if (typeof input.requestKey !== 'string' || !input.requestKey || input.requestKey.length > 200) throw new BadNameError('请求键无效。')
    await this.recover()
    const id = contentVersion('agent-run\0' + input.requestKey).slice(0, 32)
    return this.store.writer.run(async () => {
      const existing = await this.get(id).catch(error => { if (error instanceof MissingRecordError) return null; throw error })
      if (existing) return existing
      this.options.guard?.()
      const now = Date.now()
      const run: AgentRunDTO = { id, scope: input.scope, ...(input.session ? { session: input.session } : {}), requestKey: input.requestKey, status: 'queued', seq: 0, cancelOnDisconnect: options.cancelOnDisconnect, createdAt: now, updatedAt: now }
      const state: Active = { controller: new AbortController(), run, events: [], listeners: new Set(), attached: false, stopped: null, writing: Promise.resolve() }
      await this.save(state)
      this.active.set(id, state)
      // A legacy run whose caller never connects must not run unattended.
      if (run.cancelOnDisconnect) state.timer = setTimeout(() => { if (!state.attached) this.stopState(state, 'disconnect') }, NEVER_ATTACHED_MS)
      // A finished run stays attachable for a minute so a client that connects late still receives every event.
      const task = this.execute(state, input, model).finally(() => { clearTimeout(state.timer); setTimeout(() => this.active.delete(id), 60000).unref() })
      void (this.options.track ? this.options.track(task) : task).catch(() => undefined)
      return { ...run }
    })
  }

  private emit(state: Active, event: AgentEvent) {
    const entry = { seq: ++state.run.seq, event }
    state.run.updatedAt = Date.now()
    if (event.type === 'session') state.run.session = event.id
    state.events.push(entry)
    for (const listener of state.listeners) listener(entry)
  }

  private async execute(state: Active, input: { scope: AgentScope; session?: string; message: string; selection?: string }, model: AgentModel): Promise<void> {
    const { run } = state
    const signal = AbortSignal.any([state.controller.signal, AbortSignal.timeout(600000), ...(this.options.shutdown ? [this.options.shutdown] : [])])
    let status: AgentRunDTO['status'] = 'completed', error: string | undefined
    try {
      run.status = 'running'
      await this.agent.run({ session: input.session, scope: input.scope, message: input.message, ...(input.scope.kind === 'note' ? { selection: input.selection } : {}) }, model, signal, async event => { this.emit(state, event) })
    } catch (failure) {
      const known = failure instanceof BadNameError || failure instanceof ConflictError || failure instanceof ChatGPTError || failure instanceof AISettingsError || failure instanceof AIRequestError
      if (signal.aborted) {
        const shutdown = !state.stopped && !!this.options.shutdown?.aborted
        status = shutdown ? 'interrupted' : state.stopped ? 'cancelled' : 'failed'
        error = shutdown ? '服务正在停止，任务被中断。已完成的修改保留在修改记录中。' : state.stopped ? '已停止。已完成的修改保留在修改记录中，可以撤销。' : '任务超时。已完成的修改保留在修改记录中。'
      } else {
        status = 'failed'
        error = known ? (failure as Error).message : '模型连接中断。已经完成的修改保留在记录中，请检查后再继续。'
        if (!known) console.error(failure)
        this.emit(state, { type: 'error', text: error })
      }
    } finally {
      run.status = status
      if (error) run.error = error
      this.emit(state, { type: 'done' })
      await this.save(state)
    }
  }

  private stopState(state: Active, reason: 'user' | 'disconnect') {
    if (finished(state.run.status)) return
    state.stopped ??= reason
    state.controller.abort()
  }

  async stop(id: string): Promise<AgentRunDTO> {
    const live = this.active.get(id)
    if (live) this.stopState(live, 'user')
    return this.get(id)
  }

  /**
   * Attach to a run. Events after `after` that are still buffered are replayed in the same tick the listener is added,
   * so a reconnecting client neither misses nor repeats an event. Without a live run there is nothing to attach to.
   */
  attach(id: string, after: number, onEvent: Listener): { run: AgentRunDTO; replay: { seq: number; event: AgentEvent }[]; detach: () => void } | null {
    const state = this.active.get(id)
    if (!state) return null
    state.attached = true
    state.listeners.add(onEvent)
    return {
      run: { ...state.run }, replay: state.events.filter(entry => entry.seq > after),
      detach: () => {
        state.listeners.delete(onEvent)
        if (!state.listeners.size && state.run.cancelOnDisconnect && !finished(state.run.status)) this.stopState(state, 'disconnect')
      },
    }
  }
}
