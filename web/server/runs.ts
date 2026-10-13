import fs from 'node:fs/promises'
import path from 'node:path'
import type { RunDTO, RunEvent } from '../shared/types'
import { AIRequestError } from './ai'
import { ChatGPTError } from './chatgpt'
import { AISettingsError } from './ai-settings'
import { MissingRecordError, type ResearchStore } from './discussions'
import { buildMessages, contextFor } from './explore'
import type { ModelCall } from './models'
import { readRecord, StorageError, writeRecord } from './persistence'
import { BadNameError, ConflictError, contentVersion, type NoteStore } from './store'

const PERSIST_EVERY = 500
const finished = (status: RunDTO['status']) => !['queued', 'running'].includes(status)

type Active = { controller: AbortController; run: RunDTO; listeners: Set<(event: RunEvent) => void>; saved: number; stopped: boolean; writing: Promise<unknown> }

/**
 * Answer generation that outlives the page. A run is accepted only after its record is on disk; progress is
 * published as sequenced events; closing a tab never stops it. A server restart marks unfinished runs
 * interrupted and keeps the text so far. Answer runs have no side effects, so retrying means a new run.
 */
export class RunService {
  private readonly directory: string
  private active = new Map<string, Active>()
  private recovered = false

  constructor(private store: NoteStore, private research: ResearchStore, private options: { track?: <T>(task: Promise<T>) => Promise<T>; shutdown?: AbortSignal } = {}) {
    this.directory = path.join(store.paths.local, 'runs')
  }

  private file = (id: string) => path.join(this.directory, id + '.json')
  private persist(run: RunDTO) { return writeRecord(this.file(run.id), { version: 1, ...run }) }
  private snapshot(run: RunDTO): RunDTO { return { ...run } }

  async get(id: string): Promise<RunDTO> {
    const live = this.active.get(id)
    if (live) return this.snapshot(live.run)
    if (!/^[a-f0-9]{32}$/.test(id)) throw new BadNameError('运行编号无效。')
    const record = await readRecord<RunDTO & { version: 1 }>(this.file(id))
    if (!record) throw new MissingRecordError('找不到这次运行。')
    if (record.version !== 1 || record.id !== id) throw new StorageError('运行记录格式无效，请保留文件并检查备份。')
    const { version, ...run } = record
    return run
  }

  /** Marks runs left unfinished by a stopped process; call once before serving. */
  async recover(): Promise<void> {
    if (this.recovered) return
    this.recovered = true
    let names: string[]
    try { names = (await fs.readdir(this.directory)).filter(name => /^[a-f0-9]{32}\.json$/.test(name)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    for (const name of names) {
      const run = await this.get(name.slice(0, -5))
      if (!finished(run.status) && !this.active.has(run.id)) await this.persist({ ...run, status: 'interrupted', error: '服务重启时这次回答尚未完成。已生成的内容保留，可以重新回答。', seq: run.seq + 1, updatedAt: Date.now() })
    }
  }

  /** The newest run of each turn that did not complete, for a page that is (re)opening. */
  async unfinished(turnIds: Set<string>): Promise<RunDTO[]> {
    await this.recover()
    let names: string[]
    try { names = (await fs.readdir(this.directory)).filter(name => /^[a-f0-9]{32}\.json$/.test(name)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const latest = new Map<string, RunDTO>()
    for (const name of names) {
      const run = await this.get(name.slice(0, -5))
      if (!turnIds.has(run.turnId)) continue
      const known = latest.get(run.turnId)
      if (!known || run.createdAt > known.createdAt) latest.set(run.turnId, run)
    }
    return [...latest.values()].filter(run => run.status !== 'completed')
  }

  /** Idempotent per request key: repeating a start returns the original run and never a second one. */
  async start(input: { discussionId: string; turnId: string; requestKey: string }, call: ModelCall): Promise<RunDTO> {
    if (typeof input.requestKey !== 'string' || !input.requestKey || input.requestKey.length > 200) throw new BadNameError('请求键无效。')
    await this.recover()
    const id = contentVersion('run\0' + input.requestKey).slice(0, 32)
    return this.store.writer.run(async () => {
      const existing = await this.get(id).catch(error => { if (error instanceof MissingRecordError) return null; throw error })
      if (existing) {
        if (existing.discussionId !== input.discussionId || existing.turnId !== input.turnId) throw new ConflictError('同一请求键不能用于不同问题。')
        return existing
      }
      const discussion = await this.research.getDiscussion(input.discussionId)
      if (!discussion.turns.some(turn => turn.id === input.turnId)) throw new MissingRecordError('找不到这个问题节点。')
      // Refuse an over-budget context now, with the reason, rather than after creating a run that cannot work.
      const context = await contextFor(this.research, discussion, discussion.turns.find(turn => turn.id === input.turnId)!)
      if (context.exceeded) throw new BadNameError(`这条分支的上下文约 ${context.estimatedTokens} 个单位，超过上限 ${context.budget}。请缩小选区、减少合并的分支，或从较短的分支继续提问。`)
      if ([...this.active.values()].some(item => item.run.turnId === input.turnId && !finished(item.run.status))) throw new ConflictError('这个问题正在回答，请等待或先停止。')
      const now = Date.now()
      const run: RunDTO = { id, discussionId: input.discussionId, turnId: input.turnId, requestKey: input.requestKey, status: 'queued', text: '', seq: 0, createdAt: now, updatedAt: now }
      await this.persist(run)
      const controller = new AbortController()
      const state: Active = { controller, run, listeners: new Set(), saved: 0, stopped: false, writing: Promise.resolve() }
      this.active.set(id, state)
      const task = this.execute(state, call).finally(() => this.active.delete(id))
      void (this.options.track ? this.options.track(task) : task).catch(() => undefined)
      return this.snapshot(run)
    })
  }

  private emit(state: Active, event: RunEvent extends infer E ? E extends RunEvent ? Omit<E, 'seq'> : never : never) {
    const full = { ...event, seq: ++state.run.seq } as RunEvent
    state.run.updatedAt = Date.now()
    for (const listener of state.listeners) listener(full)
  }

  private async finish(state: Active, status: RunDTO['status'], extra: Partial<RunDTO> = {}) {
    Object.assign(state.run, extra, { status })
    this.emit(state, { type: 'status', run: this.snapshot(state.run) })
    await this.save(state)
  }

  /** Writes are queued per run and always carry the newest state, so an older write can never land last. */
  private save(state: Active): Promise<void> {
    const write = state.writing.then(() => this.persist(state.run), () => this.persist(state.run))
    state.writing = write.catch(() => undefined)
    return write
  }

  private async execute(state: Active, call: ModelCall): Promise<void> {
    const { run } = state
    const signal = AbortSignal.any([state.controller.signal, AbortSignal.timeout(300000), ...(this.options.shutdown ? [this.options.shutdown] : [])])
    try {
      state.run.status = 'running'
      this.emit(state, { type: 'status', run: this.snapshot(run) })
      const discussion = await this.research.getDiscussion(run.discussionId)
      const turn = discussion.turns.find(item => item.id === run.turnId)!
      const { messages, summarizedTurns } = await buildMessages(this.research, discussion, turn)
      const reply = await call(messages, [], signal, text => {
        run.text += text
        this.emit(state, { type: 'delta', text })
        if (Date.now() - state.saved >= PERSIST_EVERY) { state.saved = Date.now(); void this.save(state).catch(() => undefined) }
      })
      signal.throwIfAborted()
      const text = (reply.text || run.text).trim()
      if (!text) throw new AIRequestError('模型没有返回内容，请重试。')
      const answer = await this.research.addAnswer(run.discussionId, run.turnId, { text, runId: run.id, summarizedTurns })
      await this.finish(state, 'completed', { text, answerId: answer.id })
    } catch (error) {
            if (signal.aborted) {
        const shutdown = !state.stopped && this.options.shutdown?.aborted
        const timedOut = !state.stopped && !shutdown
        await this.finish(state, shutdown ? 'interrupted' : timedOut ? 'failed' : 'cancelled', { error: shutdown ? '服务正在停止，这次回答被中断。已生成的内容保留。' : timedOut ? '回答超时，已生成的内容保留，可以重新回答。' : '已停止。已生成的内容保留，没有保存为回答。' })
        return
      }
      const known = error instanceof AIRequestError || error instanceof ChatGPTError || error instanceof AISettingsError || error instanceof BadNameError || error instanceof ConflictError
      if (!known) console.error(error)
      await this.finish(state, 'failed', { error: known ? (error as Error).message : '模型连接中断。已生成的内容保留，可以重新回答。' })
    }
  }

  async stop(id: string): Promise<RunDTO> {
    const live = this.active.get(id)
    if (live) { live.stopped = true; live.controller.abort() }
    return this.get(id)
  }

  /**
   * Returns the current state and then every later event. Because the first message is a full snapshot taken in
   * the same tick the listener is added, a reconnecting client can neither miss nor repeat a delta.
   */
  async subscribe(id: string, onEvent: (event: RunEvent) => void): Promise<{ run: RunDTO; unsubscribe: () => void }> {
    const live = this.active.get(id)
    if (!live) return { run: await this.get(id), unsubscribe: () => {} }
    live.listeners.add(onEvent)
    return { run: this.snapshot(live.run), unsubscribe: () => live.listeners.delete(onEvent) }
  }
}
