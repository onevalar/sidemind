import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SyncJobService } from '../server/sync-jobs'
import type { PushReport } from '../shared/types'
const dirs: string[] = []
async function local() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sidemind-sync-')); dirs.push(dir); return dir }
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))) })
const report: PushReport = { committed: 'abc123', message: 'Saved', notes: [], folders: [], stale: [], layout: [], pushed: false }
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
async function finished(job: SyncJobService) {
  for (let i = 0; i < 200; i++) { const state = await job.get(); if (state && !['running', 'stopping'].includes(state.status)) return state; await new Promise(r => setTimeout(r, 5)) }
  throw new Error('Job did not finish')
}
describe('server-owned sync jobs', () => {
  it('returns immediately, deduplicates concurrent starts, and retains result after observer disappears', async () => {
    const dir = await local(), gate = deferred(), started = deferred(); let calls = 0
    const service = new SyncJobService(dir, { execute: async (emit, _signal, options) => {
      calls++; started.resolve(); expect(options.enrich).toBe(false)
      await emit({ type: 'step', text: '正在保存' }); await gate.promise; return report
    } })
    const [first, duplicate] = await Promise.all([service.start(), service.start()])
    await started.promise
    expect(first.id).toBe(duplicate.id); expect(first.status).toBe('running'); expect(calls).toBe(1)
    gate.resolve()
    const done = await finished(service)
    expect(done.status).toBe('completed'); expect(done.report).toEqual(report)
    const reconnected = new SyncJobService(dir, { execute: async () => { throw new Error('must not rerun') } })
    expect(await reconnected.get()).toEqual(done)
  })
  it('stops only explicitly and keeps partial activity for recovery', async () => {
    const started = deferred()
    const service = new SyncJobService(await local(), { execute: async (emit, signal) => {
      await emit({ type: 'note', name: 'A.md', kind: 'updated' }); started.resolve()
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      return report
    } })
    const run = await service.start({ enrich: true }); await started.promise
    expect(run.enrich).toBe(true)
    expect((await service.stop(run.id)).status).toBe('stopping')
    const done = await finished(service)
    expect(done.status).toBe('cancelled'); expect(done.events).toContainEqual({ type: 'note', name: 'A.md', kind: 'updated' })
    await expect(service.stop('unknown')).rejects.toThrow()
  })
  it('recovers unfinished snapshots as interrupted rather than silently rerunning', async () => {
    const dir = await local()
    await fs.writeFile(path.join(dir, 'sync-job.json'), JSON.stringify({ id: 'old', enrich: false, status: 'running', startedAt: 1, updatedAt: 1, activity: 'old', events: [] }))
    const service = new SyncJobService(dir, { execute: async () => report })
    expect((await service.get())?.status).toBe('interrupted')
    expect((await service.start()).id).not.toBe('old')
    expect((await finished(service)).status).toBe('completed')
  })
  it('reports shutdown and failures independently of user cancellation', async () => {
    const shutdown = new AbortController(), started = deferred()
    const service = new SyncJobService(await local(), { shutdown: shutdown.signal, execute: async (_emit, signal) => {
      started.resolve()
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      return report
    } })
    await service.start(); await started.promise; shutdown.abort()
    expect((await finished(service)).status).toBe('interrupted')
    const failed = new SyncJobService(await local(), { execute: async () => { throw new Error('remote rejected') } })
    await failed.start(); expect((await finished(failed)).error).toBe('remote rejected')
  })
})
