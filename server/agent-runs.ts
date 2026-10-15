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
const summary = (text: string, length = 180) => text.replace(/\s+/g, ' ').trim().slice(0, length)
const priority = (run: AgentRunDTO) => !finished(run.status) ? 0 : ['waiting_confirmation', 'recovery_required'].includes(run.status) ? 1 : 2
const RECOVERY = (count: number, why: string) => `${why}它已经修改了 ${count} 处笔记，但没有完成，可能只做了一部分。已完成的修改保留在修改记录中，不会自动重新执行或回滚；请检查修改记录，必要时撤销，再决定是否重新发起。`
type Listener = (entry: { seq: number; event: AgentEvent }) => void
type Active = { controller: AbortController; run: AgentRunDTO; events: { seq: number; event: AgentEvent }[]; listeners: Set<Listener>; stopped: boolean; writing: Promise<unknown> }

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
  private recovering?: Promise<void>
  private history?: { at: number; runs: AgentRunDTO[] }
  private listing?: Promise<AgentRunDTO[]>

  constructor(private store: NoteStore, private agent: NoteAgent, private options: { track?: <T>(task: Promise<T>) => Promise<T>; shutdown?: AbortSignal; guard?: () => void; /** Which of these proposals still await the user. */ pendingProposals?: (ids: string[]) => Promise<string[]>; /** Change sets this conversation's requests made since a time, from the change engine's own records. */ changesSince?: (session: string, since: number) => Promise<string[]> } = {}) {
    this.directory = path.join(store.paths.local, 'agent-runs')
  }

  private file = (id: string) => path.join(this.directory, id + '.json')

  /**
   * What an unfinished run changed: what it recorded as it went, plus anything the change engine committed for its
   * conversation since it began. The second source closes the window between a write committing and the run's own
   * record being saved, so a crash there is still reported as needing recovery.
   */
  private async touched(run: AgentRunDTO): Promise<string[]> {
    const found = run.session && this.options.changesSince ? await this.options.changesSince(run.session, run.createdAt).catch(() => []) : []
    return [...new Set([...(run.changes ?? []), ...found])]
  }

  /** The unfinished run writing to a conversation, so a page that opens mid-run can follow it. */
  runForSession(session: string): AgentRunDTO | null {
    for (const state of this.active.values()) if (state.run.session === session && !finished(state.run.status)) return { ...state.run }
    return null
  }

  /** True while any run is executing; used to hold back a sync. */
  get busy() { return [...this.active.values()].some(item => !finished(item.run.status)) }

  /** A run that finished while proposals were queued becomes completed once the user has decided all of them. */
  private async settle(run: AgentRunDTO): Promise<AgentRunDTO> {
    if (run.status !== 'waiting_confirmation') return run
    if ((await this.options.pendingProposals?.(run.proposals ?? []) ?? ['pending']).length) return run
    const done: AgentRunDTO = { ...run, status: 'completed', updatedAt: Date.now() }
    await writeRecord(this.file(run.id), { version: 1, ...done })
    const live = this.active.get(run.id)
    if (live) Object.assign(live.run, done)
    this.history = undefined
    return done
  }

  async get(id: string): Promise<AgentRunDTO> {
    const live = this.active.get(id)
    if (live) return this.settle({ ...live.run })
    if (!/^[a-f0-9]{32}$/.test(id)) throw new BadNameError('运行编号无效。')
    const record = await readRecord<AgentRunDTO & { version: 1 }>(this.file(id))
    if (!record) throw new MissingRecordError('找不到这次运行。')
    if (record.version !== 1 || record.id !== id) throw new StorageError('运行记录格式无效，请保留文件并检查备份。')
    const { version, ...run } = record
    return this.settle(run)
  }

  /** Discover tasks from any page, including after a reload. Active work is never buried by completed history. */
  async list(limit = 20): Promise<AgentRunDTO[]> {
    if (!Number.isInteger(limit) || limit < 1) throw new BadNameError('任务数量无效。')
    await this.recover()
    // Old terminal runs cannot change spontaneously. Scan their files at most once
    // per 30 seconds, retaining only one page. Live progress bypasses this cache.
    let historical = this.history?.runs
    if (!this.history || Date.now() - this.history.at >= 30000) {
      this.listing ??= this.readHistory().finally(() => { this.listing = undefined })
      historical = await this.listing
    }
    const combined = new Map(historical!.map(run => [run.id, run]))
    for (const { run } of this.active.values()) combined.set(run.id, { ...run })
    // A historical proposal can be decided without its run still being live.
    for (const [id, run] of combined) if (run.status === 'waiting_confirmation') combined.set(id, await this.get(id))
    return [...combined.values()].sort((a, b) => priority(a) - priority(b) || b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id)).slice(0, Math.min(limit, 20))
  }

  private async readHistory(): Promise<AgentRunDTO[]> {
    let names: string[]
    try { names = (await fs.readdir(this.directory)).filter(name => /^[a-f0-9]{32}\.json$/.test(name)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') names = []; else throw error }
    const runs: AgentRunDTO[] = []
    for (const name of names) runs.push(await this.get(name.slice(0, -5)))
    const recent = runs.sort((a, b) => priority(a) - priority(b) || b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id)).slice(0, 20)
    this.history = { at: Date.now(), runs: recent }
    return recent
  }

  /** Runs for this conversation that a restart stopped part-way through writing, until the user has looked at them. */
  async recoveryForSession(session: string): Promise<AgentRunDTO[]> {
    let names: string[]
    try { names = (await fs.readdir(this.directory)).filter(name => /^[a-f0-9]{32}\.json$/.test(name)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const found: AgentRunDTO[] = []
    for (const name of names) { const run = await this.get(name.slice(0, -5)); if (run.status === 'recovery_required' && run.session === session) found.push(run) }
    return found.sort((a, b) => a.createdAt - b.createdAt)
  }

  /** The user has checked the changes a stopped run left behind. */
  async acknowledge(id: string): Promise<AgentRunDTO> {
    return this.store.writer.run(async () => {
      const run = await this.get(id)
      if (run.status !== 'recovery_required') throw new ConflictError('这次任务不需要确认。')
      const next: AgentRunDTO = { ...run, status: 'interrupted', error: '你已确认检查过中断前的修改。', updatedAt: Date.now() }
      await writeRecord(this.file(id), { version: 1, ...next })
      const live = this.active.get(id)
      if (live) Object.assign(live.run, next)
      this.history = undefined
      return next
    })
  }

  async recover(): Promise<void> {
    if (this.recovered) return
    this.recovering ??= this.recoverRecords().then(() => { this.recovered = true }).finally(() => { this.recovering = undefined })
    await this.recovering
  }

  private async recoverRecords(): Promise<void> {
    let names: string[]
    try { names = (await fs.readdir(this.directory)).filter(name => /^[a-f0-9]{32}\.json$/.test(name)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    for (const name of names) {
      const run = await this.get(name.slice(0, -5))
      if (finished(run.status) || this.active.has(run.id)) continue
      const changes = await this.touched(run), changed = changes.length
      await writeRecord(this.file(run.id), { version: 1, ...run, ...(changed
        ? { status: 'recovery_required', changes, error: RECOVERY(changed, '服务重启时这次任务尚未完成。') }
        : { status: 'interrupted', error: '服务重启时这次任务尚未完成，还没有修改任何笔记。不会自动重新执行；请重新发起。' }), updatedAt: Date.now() })
    }
  }

  private save(state: Active): Promise<void> {
    const write = state.writing.then(() => writeRecord(this.file(state.run.id), { version: 1, ...state.run }), () => writeRecord(this.file(state.run.id), { version: 1, ...state.run }))
    state.writing = write.catch(() => undefined)
    return write
  }

  /** Idempotent per request key. The record is on disk before this returns. */
  async start(input: { requestKey: string; scope: AgentScope; session?: string; message: string; selection?: string }, model: AgentModel): Promise<AgentRunDTO> {
    if (typeof input.requestKey !== 'string' || !input.requestKey || input.requestKey.length > 200) throw new BadNameError('请求键无效。')
    await this.recover()
    const id = contentVersion('agent-run\0' + input.requestKey).slice(0, 32)
    return this.store.writer.run(async () => {
      const existing = await this.get(id).catch(error => { if (error instanceof MissingRecordError) return null; throw error })
      if (existing) return existing
      this.options.guard?.()
      const now = Date.now()
      const run: AgentRunDTO = { id, scope: input.scope, ...(input.session ? { session: input.session } : {}), requestKey: input.requestKey, request: summary(input.message), activity: '正在准备', status: 'queued', seq: 0, createdAt: now, updatedAt: now }
      const state: Active = { controller: new AbortController(), run, events: [], listeners: new Set(), stopped: false, writing: Promise.resolve() }
      await this.save(state)
      this.active.set(id, state)
      // A finished run stays attachable for a minute so a client that connects late still receives every event.
      const task = this.execute(state, input, model).finally(() => { setTimeout(() => this.active.delete(id), 60000).unref() })
      void (this.options.track ? this.options.track(task) : task).catch(() => undefined)
      return { ...run }
    })
  }

  private emit(state: Active, event: AgentEvent) {
    const entry = { seq: ++state.run.seq, event }
    state.run.updatedAt = Date.now()
    let durable = false
    const activity = event.type === 'activity' ? summary(event.text) : event.type === 'delta' ? '正在生成回复' : undefined
    if (activity && state.run.activity !== activity) { state.run.activity = activity; durable = true }
    if (event.type === 'session') { state.run.session = event.id; durable = true }
    // Written down as it happens: after a crash this is the only record of what the run had already done.
    if (event.type === 'changeset' && !state.run.changes?.includes(event.change.id)) { state.run.changes = [...(state.run.changes ?? []), event.change.id]; durable = true }
    if (event.type === 'proposal' && !state.run.proposals?.includes(event.proposal.id)) { state.run.proposals = [...(state.run.proposals ?? []), event.proposal.id]; durable = true }
    if (durable) void this.save(state).catch(() => undefined)
    state.events.push(entry)
    for (const listener of state.listeners) listener(entry)
  }

  private async execute(state: Active, input: { scope: AgentScope; session?: string; message: string; selection?: string }, model: AgentModel): Promise<void> {
    const { run } = state
    const signal = AbortSignal.any([state.controller.signal, AbortSignal.timeout(600000), ...(this.options.shutdown ? [this.options.shutdown] : [])])
    let status: AgentRunDTO['status'] = 'completed', error: string | undefined
    try {
      run.status = 'running'
      run.activity = '正在思考'
      await this.save(state)
      await this.agent.run({ session: input.session, scope: input.scope, message: input.message, ...(input.scope.kind === 'note' ? { selection: input.selection } : {}) }, model, signal, async event => { this.emit(state, event) })
    } catch (failure) {
      const known = failure instanceof BadNameError || failure instanceof ConflictError || failure instanceof ChatGPTError || failure instanceof AISettingsError || failure instanceof AIRequestError
      if (signal.aborted) {
        const shutdown = !state.stopped && !!this.options.shutdown?.aborted
        const changes = shutdown ? await this.touched(run) : run.changes ?? [], changed = changes.length
        if (shutdown && changed) run.changes = changes
        status = shutdown ? (changed ? 'recovery_required' : 'interrupted') : state.stopped ? 'cancelled' : 'failed'
        error = shutdown ? (changed ? RECOVERY(changed, '服务正在停止，任务被中断。') : '服务正在停止，任务被中断，还没有修改任何笔记。') : state.stopped ? '已停止。已完成的修改保留在修改记录中，可以撤销。' : '任务超时。已完成的修改保留在修改记录中。'
      } else {
        status = 'failed'
        error = known ? (failure as Error).message : '模型连接中断。已经完成的修改保留在记录中，请检查后再继续。'
        if (!known) console.error(failure)
        this.emit(state, { type: 'error', text: error })
      }
    } finally {
      if (status === 'completed' && run.proposals?.length && (await this.options.pendingProposals?.(run.proposals).catch(() => run.proposals!) ?? []).length) status = 'waiting_confirmation'
      // Publish completion only once its terminal record is durable. Until then,
      // polling and sync guards still see a running task, even for a fast model.
      await state.writing
      const terminal: AgentRunDTO = { ...run, status, seq: run.seq + 1, updatedAt: Date.now(), ...(error ? { error } : {}) }
      try { await writeRecord(this.file(run.id), { version: 1, ...terminal }) }
      catch (failure) {
        console.error(failure)
        terminal.status = 'failed'
        terminal.error = '任务结果未能保存。已完成的文件修改仍保留，请检查修改记录；不要重复执行写入。'
        this.emit(state, { type: 'error', text: terminal.error })
        terminal.seq = run.seq + 1
      }
      Object.assign(run, terminal)
      const done = { seq: run.seq, event: { type: 'done' } as AgentEvent }
      state.events.push(done)
      for (const listener of state.listeners) listener(done)
    }
  }

  async stop(id: string): Promise<AgentRunDTO> {
    const live = this.active.get(id)
    if (live && !finished(live.run.status)) { live.stopped = true; live.controller.abort() }
    return this.get(id)
  }

  /**
   * Attach to a run. Events after `after` that are still buffered are replayed in the same tick the listener is added,
   * so a reconnecting client neither misses nor repeats an event. Without a live run there is nothing to attach to.
   */
  attach(id: string, after: number, onEvent: Listener): { run: AgentRunDTO; replay: { seq: number; event: AgentEvent }[]; detach: () => void } | null {
    const state = this.active.get(id)
    if (!state) return null
    state.listeners.add(onEvent)
    return {
      run: { ...state.run }, replay: state.events.filter(entry => entry.seq > after),
      detach: () => { state.listeners.delete(onEvent) },
    }
  }
}
