import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../server/app'
import { EventBus } from '../server/events'
import { NoteStore } from '../server/store'
import { FolderOpenError, openWorkspaceFolder } from '../server/workspace-folder'

let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-folder-')) })
afterEach(() => fs.rm(dir, { recursive: true, force: true }))
const headers = { host: 'localhost:3001', 'content-type': 'application/json' }

describe('configured workspace folder', () => {
  it('passes paths containing spaces and shell punctuation as one literal argument on each supported system', async () => {
    const root = path.join(dir, '笔记 空间 $name `literal`')
    await fs.mkdir(root)
    for (const [platform, command] of [['darwin', 'open'], ['win32', 'explorer.exe'], ['linux', 'xdg-open']] as const) {
      const calls: unknown[] = []
      await openWorkspaceFolder(root, platform, async (executable, args) => { calls.push([executable, args]) })
      expect(calls).toEqual([[command, [root]]])
    }
  })
  it('reports unavailable folders, unsupported systems and launcher errors without claiming success', async () => {
    let calls = 0
    const launcher = async () => { calls++; throw new Error('private platform error') }
    await expect(openWorkspaceFolder('relative', 'darwin', launcher)).rejects.toThrow('无法访问')
    await expect(openWorkspaceFolder(path.join(dir, 'missing'), 'darwin', launcher)).rejects.toThrow('不存在')
    await expect(openWorkspaceFolder(dir, 'freebsd', launcher)).rejects.toThrow('暂不支持')
    expect(calls).toBe(0)
    await expect(openWorkspaceFolder(dir, 'darwin', launcher)).rejects.toThrow('无法打开文件管理器')
    expect(calls).toBe(1)
  })
  it('opens only the actual NoteStore root and rejects client-supplied paths and cross-site forms before invoking the launcher', async () => {
    const store = new NoteStore(dir)
    const opened: string[] = []
    const app = createApp(store, new EventBus(), { openDirectory: async root => { opened.push(root) } })
    const request = (body: string, supplied = headers) => app.request('/api/workspace/open', { method: 'POST', headers: supplied, body })
    expect((await request('{}')).status).toBe(200)
    expect(opened).toEqual([store.root])
    for (const body of ['null', '[]', '{"path":"/another/folder"}', '{"command":"anything"}', 'invalid']) expect((await request(body)).status).toBe(400)
    expect((await request('{}', { ...headers, host: 'evil.example' })).status).toBe(403)
    expect((await request('{}', { ...headers, 'content-type': 'text/plain' })).status).toBe(415)
    expect(opened).toEqual([store.root])
  })
  it('returns a visible actionable error when the system file manager cannot be opened', async () => {
    const app = createApp(new NoteStore(dir), new EventBus(), { openDirectory: async () => { throw new FolderOpenError('无法打开文件管理器。') } })
    const response = await app.request('/api/workspace/open', { method: 'POST', headers, body: '{}' })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: '无法打开文件管理器。' })
  })
})
