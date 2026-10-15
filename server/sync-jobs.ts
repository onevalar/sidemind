import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PushEvent, PushReport, SyncJobDTO } from '../shared/types'
import { readRecord, writeRecord, WorkspaceWriter } from './persistence'
import { NotFoundError } from './store'

/** The transport observes this job; only an explicit stop (or server shutdown) cancels it. */
export class SyncJobService {
  private job: SyncJobDTO | null = null
  private controller: AbortController | null = null
  private recovered: Promise<void> | null = null
  private control = new WorkspaceWriter()
  private file: string
  constructor(local: string, private options: {
    execute: (emit: (event: PushEvent) => Promise<void>, signal: AbortSignal, options: { enrich: boolean }) => Promise<PushReport>
    guard?: () => void
    track?: (task: Promise<void>) => Promise<void>
    shutdown?: AbortSignal
  }) { this.file = path.join(local, 'sync-job.json') }

  get busy() { return this.job?.status === 'running' || this.job?.status === 'stopping' }
  private snapshot() { return this.job ? structuredClone(this.job) : null }
  recover() {
    return this.recovered ??= (async () => {
      this.job = await readRecord<SyncJobDTO>(this.file)
      if (this.busy) {
        this.job!.status = 'interrupted'
        this.job!.error = '服务重启中断了上次同步。已保存的改动仍保留，可以重新同步。'
        this.job!.finishedAt = this.job!.updatedAt = Date.now()
        await writeRecord(this.file, this.job)
      }
    })()
  }
  async get() { await this.recover(); return this.control.run(async () => this.snapshot()) }
  async start(options: { enrich?: boolean } = {}): Promise<SyncJobDTO> {
    await this.recover()
    return this.control.run(async () => {
      if (this.busy) return this.snapshot()!
      this.options.guard?.()
      const now = Date.now()
      this.job = { id: randomUUID(), status: 'running', startedAt: now, updatedAt: now, activity: '正在准备同步', enrich: options.enrich === true, events: [] }
      try { await writeRecord(this.file, this.job) }
      catch (error) { this.job = null; throw error }
      const controller = this.controller = new AbortController()
      const snapshot = this.snapshot()!
      // Leave the control transaction before running the job; event writes use their own queue.
      const task = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.execute(controller))
      // execute handles job errors; report storage failure without an unhandled rejection.
      void (this.options.track?.(task) ?? task).catch(error => console.error('Sync job persistence failed', error))
      return snapshot
    })
  }
  async stop(id: string): Promise<SyncJobDTO> {
    await this.recover()
    return this.control.run(async () => {
      if (!this.job || this.job.id !== id) throw new NotFoundError()
      if (this.busy) {
        this.job.status = 'stopping'
        this.job.activity = '正在停止同步'
        this.job.updatedAt = Date.now()
        await writeRecord(this.file, this.job)
        this.controller?.abort()
      }
      return this.snapshot()!
    })
  }
  private async execute(controller: AbortController) {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(1800000), ...(this.options.shutdown ? [this.options.shutdown] : [])])
    const emit = async (event: PushEvent) => {
      await this.control.run(async () => {
        const job = this.job!
        job.events.push(event)
        if (job.events.length > 500) job.events.splice(0, job.events.length - 500)
        if (event.type === 'step' && job.status !== 'stopping') job.activity = event.text
        if (event.type === 'report') job.report = event.report
        job.updatedAt = Date.now()
        await writeRecord(this.file, job)
      })
    }
    let report: PushReport | undefined, failure: unknown
    try { signal.throwIfAborted(); report = await this.options.execute(emit, signal, { enrich: this.job!.enrich }) }
    catch (error) { failure = error }
    await this.control.run(async () => {
      const job = this.job!
      if (report) job.report = report
      // A completed Git operation is authoritative even if stop arrived at its boundary.
      if (report) { job.status = 'completed'; job.activity = '同步已完成' }
      else if (this.options.shutdown?.aborted) { job.status = 'interrupted'; job.error = '服务停止中断了同步，已保存的改动保留。' }
      else if (controller.signal.aborted) { job.status = 'cancelled'; job.activity = '同步已停止' }
      else { job.status = 'failed'; job.error = signal.aborted ? '同步超时，请重试。' : failure instanceof Error ? failure.message : '同步失败，请重试。' }
      job.finishedAt = job.updatedAt = Date.now()
      this.controller = null
      await writeRecord(this.file, job)
    })
  }
}
