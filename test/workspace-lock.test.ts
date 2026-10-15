import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { acquireWorkspace } from '../server/workspace-lock'

let root: string
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'cn-lock-')) })
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(root + '.lock', { recursive: true, force: true }) })

/** What a killed process leaves behind: a lease directory nobody refreshes any more. */
const abandoned = () => fs.mkdir(root + '.lock')

it('fails at once by default while another process holds the lease (backup and import commands rely on this)', async () => {
  await abandoned()
  const started = Date.now()
  await expect(acquireWorkspace(root, { stale: 30000 })).rejects.toThrow('正被另一服务或备份任务占用')
  expect(Date.now() - started).toBeLessThan(500)
})

it('a restarted server can wait out the lease of a killed process instead of exiting into a restart loop', async () => {
  await abandoned()
  const started = Date.now()
  const release = await acquireWorkspace(root, { stale: 1500, wait: 8000 })
  expect(Date.now() - started).toBeGreaterThanOrEqual(1000)      // it did wait for the lease to go stale
  expect(Date.now() - started).toBeLessThan(6000)
  await release()
})

it('still gives up with the usual message when a live process keeps holding the workspace', async () => {
  const live = await acquireWorkspace(root, { stale: 60000 })
  const started = Date.now()
  await expect(acquireWorkspace(root, { stale: 60000, wait: 1500 })).rejects.toThrow('正被另一服务或备份任务占用')
  expect(Date.now() - started).toBeGreaterThanOrEqual(1400)
  await live()
})
