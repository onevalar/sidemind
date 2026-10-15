import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { runAgent } from './agent-run-helper'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AISettings } from '../server/ai-settings'
import { createApp } from '../server/app'
import { EventBus } from '../server/events'
import { NoteStore } from '../server/store'
import { openDataRepo } from '../server/repo'
import { PushService } from '../server/push'
import { MemoryFiles } from '../server/memory-files'
import { Models } from '../server/models'
import { ChatGPTConnection } from '../server/chatgpt'
import { ConversationStore } from '../server/conversations'
import { NoteIndex } from '../server/note-index'
import type { PushEvent, PushReport } from '../shared/types'

let dir: string
const H = { host: 'localhost:3001' }
const J = { ...H, 'content-type': 'application/json' }
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8' })
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cn-push-')) })
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

describe('data repository', () => {
  it('migrates a v0.2 workspace in place without changing Markdown bytes or card positions', async () => {
    const root = path.join(dir, 'data')
    await fs.mkdir(path.join(root, 'Work'), { recursive: true })
    await fs.mkdir(path.join(root, '.canvasnote', 'agent-changes'), { recursive: true })
    const a = '# A\r\n\r\nCRLF body.\r\n', b = '# B\n\nnested\n'
    await fs.writeFile(path.join(root, 'A.md'), a)
    await fs.writeFile(path.join(root, 'Work', 'B.md'), b)
    await fs.writeFile(path.join(root, 'Work', 'image.png'), 'binary')
    await fs.writeFile(path.join(root, '.canvasnote', 'library.json'), JSON.stringify({ version: 1, notes: { 'A.md': { position: { x: 11, y: 22 }, lastOpenedAt: 5 }, 'Work/B.md': { position: { x: -3, y: 4 }, lastOpenedAt: 0 } }, frames: [{ id: 'f', space: 'Work', title: '组', position: { x: -27, y: -60 }, width: 400, height: 300, members: ['Work/B.md'] }] }))
    await fs.writeFile(path.join(root, '.canvasnote', 'overviews.json'), '{}')
    await fs.writeFile(path.join(root, '.canvasnote', 'agent-changes', 'x.json'), '{}')
    const { paths, git: repo, migrated } = await openDataRepo(root)
    expect(migrated).toBe(true)
    expect(repo).not.toBeNull()
    expect((await fs.readdir(root)).sort()).toEqual(['.git', '.gitignore', 'cache', 'canvas', 'canvasnote.json', 'local', 'memory', 'notes', 'research', 'sidemind.json'])
    expect(await fs.readFile(path.join(root, 'notes', 'A.md'), 'utf8')).toBe(a)
    expect(await fs.readFile(path.join(root, 'notes', 'Work', 'image.png'), 'utf8')).toBe('binary')
    expect(JSON.parse(await fs.readFile(path.join(root, 'canvas', 'Work', '_canvas.json'), 'utf8'))).toEqual({ version: 1, notes: { 'B.md': { x: -3, y: 4 } }, frames: [{ id: 'f', title: '组', position: { x: -27, y: -60 }, width: 400, height: 300, members: ['B.md'] }] })
    expect(await fs.readFile(path.join(root, 'cache', 'legacy-agent-changes', 'x.json'), 'utf8')).toBe('{}')
    const store = new NoteStore(paths)
    const notes = await store.list()
    expect(notes.map(note => [note.name, note.position])).toEqual([['A.md', { x: 11, y: 22 }], ['Work/B.md', { x: -3, y: 4 }]])
    await expect(fs.access(path.join(paths.cache, 'recent.json'))).rejects.toThrow()
    expect((await store.canvas('Work')).frames[0]!.members).toEqual(['Work/B.md'])
    // Reopening is a no-op; cache stays out of git.
    expect((await openDataRepo(root)).migrated).toBe(false)
    expect(await fs.readFile(path.join(root, '.gitignore'), 'utf8')).toContain('cache/')
  })

  it('resumes an interrupted migration', async () => {
    const root = path.join(dir, 'data')
    await fs.mkdir(path.join(root, '.migrating-notes'), { recursive: true })
    await fs.writeFile(path.join(root, '.migrating-notes', 'Moved.md'), '# moved')
    await fs.writeFile(path.join(root, 'Left.md'), '# left')
    await fs.writeFile(path.join(root, '.canvasnote-migration.json'), JSON.stringify({ step: 'move' }))
    await openDataRepo(root, { git: false })
    expect((await fs.readdir(path.join(root, 'notes'))).sort()).toEqual(['Left.md', 'Moved.md'])
    await expect(fs.access(path.join(root, '.canvasnote-migration.json'))).rejects.toThrow()
  })
})

type Calls = { kind: string; input: any }[]
/** A fake summary model that answers each pipeline prompt by its instructions. */
function summaryModel(calls: Calls, overrides: { claimsChanged?: boolean; failFolder?: boolean; failLibrary?: boolean } = {}): typeof fetch {
  return async (url, init) => {
    const body = JSON.parse(String(init!.body)), system: string = body.messages[0].content, user: string = body.messages[1]?.content ?? ''
    const json = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: '```json\n' + JSON.stringify(value) + '\n```' }, finish_reason: 'stop' }] }))
    if (String(url).endsWith('/embeddings')) return new Response(JSON.stringify({ data: [] }))
    if (body.tools || system.includes('笔记 Agent，用用户的语言')) return new Response(JSON.stringify({ choices: [{ message: { content: '好的。' }, finish_reason: 'stop' }] }))
    if (system.includes('提炼')) { calls.push({ kind: 'distill', input: JSON.parse(user) }); return json({ items: [{ target: 'note', name: 'Work/A.md', section: '决定与约束', text: '只写给研究者', source: '用户' }] }) }
    if (system.includes('文章记忆')) {
      const input = JSON.parse(user); calls.push({ kind: 'note', input })
      if (input.task.includes('生成完整记忆')) return json({ types: ['观点/论述'], status: '活跃', sections: { '摘要': `关于 ${input.note} 的摘要。`, '用途': '- 回答测试问题 〔推断〕', '现行结论': '- 结论一 〔§开头 · 原文 · 已确认〕' }, commit: '新建 ' + input.note, claims_changed: false })
      return json({ sections: { '现行结论': '- 新结论 〔§开头 · 原文 · 已确认〕', '已废弃的观点': '- 结论一 → 新结论（正文改了）' }, commit: '修改结论', claims_changed: overrides.claimsChanged ?? true })
    }
    if (system.includes('整个笔记库')) { if (overrides.failLibrary) return new Response('unavailable', { status: 400 }); calls.push({ kind: 'library', input: JSON.parse(user) }); return json({ sections: { '跨文件夹主线': '- 主线' } }) }
    if (system.includes('一个文件夹')) { if (overrides.failFolder) return new Response('unavailable', { status: 400 }); calls.push({ kind: 'folder', input: JSON.parse(user) }); return json({ sections: { '全景与覆盖': '- 测试覆盖' } }) }
    if (system.includes('__unused__')) { calls.push({ kind: 'library', input: JSON.parse(user) }); return json({ sections: { '跨文件夹主线': '- 主线' } }) }
    if (system.includes('commit message')) { calls.push({ kind: 'commit', input: JSON.parse(user) }); return new Response(JSON.stringify({ choices: [{ message: { content: '更新笔记\n\n- 测试提交' }, finish_reason: 'stop' }] })) }
    throw new Error('unexpected prompt: ' + system.slice(0, 80))
  }
}

async function setup(calls: Calls, overrides: { claimsChanged?: boolean; failFolder?: boolean; failLibrary?: boolean } = {}) {
  const root = path.join(dir, 'data')
  const { paths, git: repo } = await openDataRepo(root)
  const store = new NoteStore(paths)
  await store.init()
  await store.createFolder('Work')
  await store.create('A', '# A\n\n结论一。\n\n## 细节\n\n这里有一些细节说明。\n', 'Work')
  await store.create('B', '# B\n\n引用 A。\n', 'Work')
  await store.list() // the canvas shows the library first, which writes layout files
  const ai = new AISettings(root, path.join(dir, 'private'), {})
  await ai.forSlot('summary').save({ model: 'cheap', baseUrl: 'https://cheap.example/v1', key: 'k' })
  const app = createApp(store, new EventBus(), { aiSettings: ai, aiTransport: summaryModel(calls, overrides), git: repo })
  const service = new PushService({ store, files: new MemoryFiles(store.paths.memory, store.writer), git: repo, models: new Models(ai, new ChatGPTConnection(ai.file + '.chatgpt.json'), summaryModel(calls, overrides)), conversations: new ConversationStore(path.join(store.paths.local, 'conversations'), store.writer), index: new NoteIndex(store), bus: new EventBus() })
  return { root, store, app, ai, service }
}
async function push(app: ReturnType<typeof createApp>): Promise<{ events: PushEvent[]; report: PushReport }> {
  const response = await app.request('/api/repo/push', { method: 'POST', headers: J, body: '{}' })
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line) as PushEvent)
  const report = events.find(event => event.type === 'report')
  if (report?.type !== 'report') throw new Error('no report: ' + JSON.stringify(events))
  return { events, report: report.report }
}

describe('push pipeline', () => {
  it('retries failed folder and library memories after notes are committed, without rebuilding notes', async () => {
    const calls: Calls = [], overrides = { failFolder: true, failLibrary: true }
    const { root, app } = await setup(calls, overrides)
    await push(app)
    const folderFile = path.join(root, 'memory', 'Work', '_folder.md'), libraryFile = path.join(root, 'memory', '_library.md')
    expect(await fs.readFile(folderFile, 'utf8')).toContain('pending: true')
    expect(await fs.readFile(libraryFile, 'utf8')).toContain('pending: true')
    expect(git(root, 'status', '--porcelain')).toBe('')
    calls.length = 0
    overrides.failFolder = false
    await push(app)
    expect(calls.some(call => call.kind === 'note')).toBe(false)
    expect(calls.some(call => call.kind === 'folder')).toBe(true)
    expect(await fs.readFile(folderFile, 'utf8')).not.toContain('pending: true')
    expect(await fs.readFile(libraryFile, 'utf8')).toContain('pending: true')
    calls.length = 0
    overrides.failLibrary = false
    await push(app)
    expect(calls.map(call => call.kind)).toEqual(['library'])
    expect(await fs.readFile(libraryFile, 'utf8')).not.toContain('pending: true')
    expect(git(root, 'status', '--porcelain')).toBe('')
  })

  it('syncs without model calls and later enriches committed notes from the durable backlog', async () => {
    const calls: Calls = []
    const { root, store, service } = await setup(calls)
    const run = (enrich: boolean) => store.writer.run(() => service.push(async () => {}, new AbortController().signal, { enrich }))
    const synced = await run(false)
    expect(calls).toHaveLength(0)
    expect(synced.committed).toBeTruthy()
    expect(synced.notes.every(note => note.memory === 'pending')).toBe(true)
    expect(git(root, 'status', '--porcelain')).toBe('')
    expect(await fs.readFile(path.join(root, 'memory', 'Work', 'A.md'), 'utf8')).toContain('pending: true')
    await run(true)
    expect(calls.filter(call => call.kind === 'note')).toHaveLength(3)
    const before = await fs.readFile(path.join(root, 'memory', 'Work', 'A.md'), 'utf8')
    expect(before).not.toContain('pending: true')
    const basedOn = before.match(/based_on: (\w+)/)![1]
    await fs.writeFile(path.join(root, 'notes', 'Work', 'A.md'), '# A\n\n结论已被证伪，现在采用完全不同的新解释。\n')
    calls.length = 0
    await run(false)
    expect(calls).toHaveLength(0)
    const deferred = await fs.readFile(path.join(root, 'memory', 'Work', 'A.md'), 'utf8')
    expect(deferred).toContain('pending: true')
    expect(deferred).toContain('based_on: ' + basedOn)
    await run(true)
    expect(calls.filter(call => call.kind === 'note')).toHaveLength(1)
    expect(await fs.readFile(path.join(root, 'memory', 'Work', 'A.md'), 'utf8')).not.toContain('pending: true')
    expect(git(root, 'status', '--porcelain')).toBe('')
  })

  it('builds memory on the first push, skips the model for wording edits and updates memory incrementally for real changes', async () => {
    const calls: Calls = []
    const { root, store, app } = await setup(calls)
    const status = await (await app.request('/api/repo/status', { headers: H })).json()
    expect(status).toMatchObject({ git: true, noteChanges: 3, remote: null, head: null })
    const first = await push(app)
    expect(first.report.committed).toMatch(/^[0-9a-f]{7}$/)
    expect(first.report.pushError).toContain('远端')
    expect(calls.filter(item => item.kind === 'note')).toHaveLength(3)
    const memory = await fs.readFile(path.join(root, 'memory', 'Work', 'A.md'), 'utf8')
    expect(memory).toMatch(/^---\nnote: Work\/A\.md\nbased_on: [0-9a-f]{12}\ntypes: \[观点\/论述\]\nstatus: 活跃\nupdated: \d{4}-\d\d-\d\d\n---\n## 摘要\n关于 Work\/A\.md 的摘要。/)
    expect(await fs.readFile(path.join(root, 'memory', 'Work', '_folder.md'), 'utf8')).toContain('测试覆盖')
    expect(await fs.readFile(path.join(root, 'memory', '_library.md'), 'utf8')).toContain('主线')
    expect(git(root, 'log', '-1', '--format=%B')).toContain('更新笔记')
    expect(git(root, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort()).toEqual(expect.arrayContaining(['notes/Work/A.md', 'memory/Work/A.md', 'canvas/Work/_canvas.json', 'memory/_library.md']))
    expect(git(root, 'status', '--porcelain')).toBe('')

    // A wording-only edit: no model call for the note, only based_on moves.
    calls.length = 0
    const a = (await store.load('Work/A.md')).content
    await store.saveContent('Work/A.md', a.replace('这里有一些细节说明。', '这里有一些细节的说明。'), a)
    const wording = await push(app)
    expect(calls.filter(item => item.kind === 'note')).toEqual([])
    expect(wording.report.notes).toEqual([{ name: 'Work/A.md', kind: 'wording', memory: 'unchanged' }])
    const after = await fs.readFile(path.join(root, 'memory', 'Work', 'A.md'), 'utf8')
    expect(after).not.toBe(memory)
    expect(after.replace(/based_on: \w+/, '')).toBe(memory.replace(/based_on: \w+/, ''))

    // A key statement changes: the model gets only the changed sections, before and after.
    calls.length = 0
    const current = (await store.load('Work/A.md')).content
    await store.saveContent('Work/A.md', current.replace('结论一。', '结论二，推翻了结论一。'), current)
    const semantic = await push(app)
    const call = calls.find(item => item.kind === 'note')!
    expect(call.input).toMatchObject({ change_kind: 'semantic', changed_sections: [{ section: 'A', severity: 'semantic', before: expect.stringContaining('结论一。'), after: expect.stringContaining('结论二') }] })
    expect(call.input.current_memory).toContain('结论一')
    expect(semantic.report.notes).toEqual([{ name: 'Work/A.md', kind: 'semantic', memory: 'updated' }])
    const updated = await fs.readFile(path.join(root, 'memory', 'Work', 'A.md'), 'utf8')
    expect(updated).toContain('## 已废弃的观点\n- 结论一 → 新结论（正文改了）')
    expect(updated).toContain('## 摘要\n关于 Work/A.md 的摘要。')
  })

  it('follows renames made outside the app: memory moves and the card keeps its position', async () => {
    const calls: Calls = []
    const { root, store, app } = await setup(calls)
    await push(app)
    const position = (await store.canvas('Work')).positions['Work/B.md']
    await fs.rename(path.join(root, 'notes', 'Work', 'B.md'), path.join(root, 'notes', 'Work', 'B2.md'))
    await store.list()
    calls.length = 0
    const { report } = await push(app)
    expect(report.notes).toEqual([{ name: 'Work/B2.md', kind: 'unchanged', memory: 'moved' }])
    expect(calls.filter(item => item.kind === 'note')).toEqual([])
    expect(await fs.readFile(path.join(root, 'memory', 'Work', 'B2.md'), 'utf8')).toContain('note: Work/B2.md')
    await expect(fs.access(path.join(root, 'memory', 'Work', 'B.md'))).rejects.toThrow()
    expect((await store.canvas('Work')).positions['Work/B2.md']).toEqual(position)
    expect(JSON.parse(await fs.readFile(path.join(root, 'canvas', 'Work', '_canvas.json'), 'utf8')).notes).not.toHaveProperty(['B.md'])
  })

  it('distills durable conclusions from conversations into memory once', async () => {
    const calls: Calls = []
    const { root, app, ai } = await setup(calls)
    await ai.save({ model: 'main', baseUrl: 'https://main.example/v1', key: 'm' })
    expect(JSON.stringify(await runAgent(app, { kind: 'note', folder: 'Work', name: 'Work/A.md' }, '这篇以后只写给研究者看'))).toContain('好的。')
    await push(app)
    const distill = calls.filter(item => item.kind === 'distill')
    expect(distill).toHaveLength(1)
    expect(distill[0]!.input.transcript).toContain('这篇以后只写给研究者看')
    expect(await fs.readFile(path.join(root, 'memory', 'Work', 'A.md'), 'utf8')).toMatch(/## 决定与约束\n- 只写给研究者 〔用户 · \d{4}-\d\d-\d\d〕/)
    calls.length = 0
    await push(app)
    expect(calls.filter(item => item.kind === 'distill')).toEqual([])
  })

  it('marks dependent notes when a cited source changes its claims', async () => {
    const calls: Calls = []
    const { root, store, app } = await setup(calls)
    await push(app)
    const file = path.join(root, 'memory', 'Work', 'A.md')
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')) + '\n## 被引用\n- 《B》（Work/B.md）用作素材 〔使用记录 · 2026-10-11〕\n')
    const a = (await store.load('Work/A.md')).content
    await store.saveContent('Work/A.md', a.replace('结论一。', '完全不同的结论。'), a)
    const { report } = await push(app)
    expect(report.stale).toEqual([{ name: 'Work/B.md', because: '来源「Work/A.md」的结论已变化' }])
    expect(await fs.readFile(path.join(root, 'memory', 'Work', 'B.md'), 'utf8')).toContain('依据已变化：来源「Work/A.md」的结论已变化')
  })

  it('pushes to a remote, merges remote memory edits and refuses to merge conflicting note text', async () => {
    const calls: Calls = []
    const { root, store, app } = await setup(calls)
    const remote = path.join(dir, 'remote.git')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
    expect((await app.request('/api/repo/remote', { method: 'PUT', headers: J, body: JSON.stringify({ url: remote }) })).status).toBe(200)
    const first = await push(app)
    expect(first.report).toMatchObject({ pushed: true })
    expect(git(remote, 'log', '-1', '--format=%s')).toContain('更新笔记')
    // Another device edits a memory file and a note.
    const other = path.join(dir, 'other')
    execFileSync('git', ['clone', '-q', remote, other])
    // A clean local workspace must still receive changes made only on another device.
    const localA = (await store.load('Work/A.md')).content
    expect(await (await app.request('/api/repo/status', { headers: H })).json()).toMatchObject({ changes: 0, ahead: 0 })
    const remoteNote = '# From remote\n\n只有另一台设备写入的内容。\n'
    await fs.writeFile(path.join(other, 'notes', 'Work', 'FromRemote.md'), remoteNote)
    git(other, 'add', '-A'); git(other, 'commit', '-qm', 'remote-only note'); git(other, 'push', '-q')
    const received = await push(app)
    expect(received.report).toMatchObject({ committed: null, pushed: true })
    expect((await store.load('Work/FromRemote.md')).content).toBe(remoteNote)
    expect((await store.load('Work/A.md')).content).toBe(localA)
    expect(git(root, 'rev-parse', 'HEAD')).toBe(git(other, 'rev-parse', 'HEAD'))
    await fs.appendFile(path.join(other, 'memory', 'Work', 'A.md'), '\n## 缺口\n- 另一台设备补充 〔用户〕\n')
    git(other, 'commit', '-qam', 'other device memory'); git(other, 'push', '-q')
    const a = (await store.load('Work/A.md')).content
    await store.saveContent('Work/A.md', a + '\n本机新增一段，含新的论述内容。\n', a)
    const merged = await push(app)
    expect(merged.report).toMatchObject({ pushed: true })
    expect(git(remote, 'log', '--format=%s', '-3')).toContain('other device memory')
    // Conflicting note text: the local commit is kept, nothing is force-pushed.
    await fs.writeFile(path.join(other, 'notes', 'Work', 'B.md'), '# B\n\n远端版本。\n')
    git(other, 'pull', '-q', '--no-rebase'); await fs.writeFile(path.join(other, 'notes', 'Work', 'B.md'), '# B\n\n远端版本。\n')
    git(other, 'commit', '-qam', 'remote note'); git(other, 'push', '-q')
    const b = (await store.load('Work/B.md')).content
    await store.saveContent('Work/B.md', '# B\n\n本机版本，完全不同。\n', b)
    const refused = await push(app)
    expect(refused.report.pushed).toBe(false)
    expect(refused.report.pushError).toContain('notes/Work/B.md')
    expect(refused.report.committed).toBeTruthy()
    expect(git(root, 'status', '--porcelain')).toBe('')
    expect(await fs.readFile(path.join(root, 'notes', 'Work', 'B.md'), 'utf8')).toBe('# B\n\n本机版本，完全不同。\n')
  })

  it('describes canvas changes locally and commits without any model when none is configured', async () => {
    const root = path.join(dir, 'data')
    const { paths, git: repo } = await openDataRepo(root)
    const store = new NoteStore(paths)
    await store.init()
    const app = createApp(store, new EventBus(), { aiSettings: new AISettings(root, path.join(dir, 'private'), {}), git: repo })
    await store.list() // the canvas shows the folder first, which writes its layout file
    await push(app)
    await store.saveCanvas('', [{ id: 'g', space: '', title: '新组', position: { x: 0, y: 0 }, width: 400, height: 300, members: ['Welcome.md'] }], { 'Welcome.md': { x: 30, y: 70 } }, [])
    const { report, events } = await push(app)
    expect(report.layout).toEqual(['根文件夹：移动 1 篇；新建文档区「新组」（1 篇）'])
    expect(events).toContainEqual({ type: 'warning', text: expect.stringContaining('没有可用的模型') })
    expect(git(root, 'log', '-1', '--format=%B')).toContain('画布 根文件夹：移动 1 篇')
  })
})
