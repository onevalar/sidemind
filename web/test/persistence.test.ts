import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openDataRepo } from '../server/repo'
import { NoteStore, type LayoutPatch } from '../server/store'
import { ChangeEngine, type FileOp } from '../server/changes'
import { ConversationStore } from '../server/conversations'
import { ProposalStore } from '../server/proposals'
import { EventBus } from '../server/events'
import { MemoryFiles } from '../server/memory-files'
import { acquireWorkspace } from '../server/workspace-lock'
import { backupRepository, restoreRepository } from '../server/backup'

let directory: string, store: NoteStore, changes: ChangeEngine, memory: MemoryFiles
const original = '# A\r\n\r\n原始文字。\r\n'
const run = promisify(execFile)
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cn-persistence-'))
  vi.stubEnv('CANVAS_CONFIG_DIR', path.join(directory, 'private'))
  const { paths } = await openDataRepo(path.join(directory, 'data'), { git: false })
  store = new NoteStore(paths)
  await store.init()
  await store.create('A', original)
  await store.createFolder('Work')
  await store.create('B', '# B\n', 'Work')
  await store.savePositions({ 'A.md': { x: 13, y: -27 }, 'Work/B.md': { x: -15, y: 203 } })
  await store.identities()
  memory = new MemoryFiles(paths.memory, store.writer)
  changes = new ChangeEngine(store, memory, new EventBus())
})
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(directory, { recursive: true, force: true }) })

const move = (): FileOp[] => [
  // Creation first exercises identity transfer independently of execution order.
  { area: 'notes', name: 'Moved.md', before: null, after: original, identityFrom: 'A.md' },
  { area: 'notes', name: 'A.md', before: original, after: null },
  { area: 'memory', name: '_library.md', before: null, after: 'new memory' },
]
const layouts = (): { folder: string; patch: LayoutPatch }[] => [
  { folder: '', patch: { positions: { 'A.md': null, 'Moved.md': { x: 51, y: 89 } } } },
  { folder: 'Work', patch: { positions: { 'Work/B.md': { x: 701, y: -3 } } } },
]
async function crashAfter(relative: string) {
  const code = `
    import fs from 'node:fs/promises';
    import { repoPaths } from './server/repo.ts';
    import { NoteStore } from './server/store.ts';
    import { ChangeEngine } from './server/changes.ts';
    import { MemoryFiles } from './server/memory-files.ts';
    import { EventBus } from './server/events.ts';
    const store = new NoteStore(repoPaths(${JSON.stringify(store.paths.root)}));
    const changes = new ChangeEngine(store, new MemoryFiles(store.paths.memory, store.writer), new EventBus());
    for (const method of ['rename', 'link']) {
      const original = fs[method].bind(fs);
      fs[method] = async (from, to) => {
        await original(from, to);
        if (String(to).includes(${JSON.stringify('/' + relative)})) process.kill(process.pid, 'SIGKILL');
      };
    }
    await changes.apply(changes.begin('crash test'), ${JSON.stringify(move())}, ${JSON.stringify(layouts())}, 'move-once');
  `
  await expect(run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code])).rejects.toMatchObject({ signal: 'SIGKILL' })
}

it.each(['notes/Moved.md', 'canvas/_canvas.json', 'research/note-identities.json', 'local/changesets/'])('recovers a real process death after publishing %s, before note discovery', async stage => {
  const identity = await store.identity('A.md')
  await crashAfter(stage)
  const reopened = new NoteStore(store.paths)
  const recovered = new ChangeEngine(reopened, new MemoryFiles(store.paths.memory, reopened.writer), new EventBus())
  await recovered.recover()
  await reopened.init()
  expect(await reopened.identity('A.md')).toEqual(identity)
  expect((await reopened.load('A.md')).content).toBe(original)
  await expect(reopened.load('Moved.md')).rejects.toThrow()
  expect((await reopened.canvas('')).positions['A.md']).toEqual({ x: 13, y: -27 })
  expect((await reopened.canvas('Work')).positions['Work/B.md']).toEqual({ x: -15, y: 203 })
  expect(await memory.read('_library.md')).toBeNull()
  expect(await recovered.list()).toEqual([])
  await recovered.recover()
})

it('preserves external edits and blocks further writes when recovery cannot safely compensate', async () => {
  await crashAfter('canvas/_canvas.json')
  await fs.writeFile(path.join(store.root, 'Moved.md'), '# 外部编辑，不能覆盖')
  await expect(changes.recover()).rejects.toThrow('已暂停写入')
  expect(await fs.readFile(path.join(store.root, 'Moved.md'), 'utf8')).toBe('# 外部编辑，不能覆盖')
  await expect(fs.access(path.join(store.root, 'A.md'))).rejects.toThrow()
  await expect(store.create('Must not write')).rejects.toThrow('已暂停写入')
})

it('rolls back files and earlier canvas writes when a later canvas write fails', async () => {
  const before = await store.identity('A.md'), rename = fs.rename.bind(fs)
  let failed = false
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (!failed && String(to) === path.join(store.paths.canvas, 'Work/_canvas.json')) { failed = true; throw new Error('disk failure') }
    return rename(from, to)
  })
  await expect(changes.apply(changes.begin('move'), move(), layouts())).rejects.toThrow('disk failure')
  expect(failed).toBe(true)
  expect(await store.identity('A.md')).toEqual(before)
  await expect(store.load('Moved.md')).rejects.toThrow()
  expect((await store.canvas('')).positions['A.md']).toEqual({ x: 13, y: -27 })
  expect((await store.canvas('Work')).positions['Work/B.md']).toEqual({ x: -15, y: 203 })
  expect(await memory.read('_library.md')).toBeNull()
  expect(await changes.list()).toEqual([])
})

it('keeps note identity through move, repeat, restart, backup/restore and undo', async () => {
  const identity = await store.identity('A.md'), set = changes.begin('move')
  await changes.apply(set, move(), layouts(), 'same-request')
  expect((await store.identity('Moved.md')).id).toBe(identity.id)
  await changes.apply(set, move(), layouts(), 'same-request')
  await expect(changes.apply(set, [{ area: 'notes', name: 'Moved.md', before: original, after: 'different' }], [], 'same-request')).rejects.toThrow('同一操作编号')
  expect(await changes.list()).toHaveLength(1)
  await backupRepository(store.paths.root, path.join(directory, 'backup'))
  await restoreRepository(path.join(directory, 'backup'), path.join(directory, 'restored'))
  const { paths } = await openDataRepo(path.join(directory, 'restored'), { git: false })
  const restored = new NoteStore(paths), engine = new ChangeEngine(restored, new MemoryFiles(paths.memory, restored.writer), new EventBus())
  await engine.recover(); await restored.init()
  expect((await restored.identity('Moved.md')).id).toBe(identity.id)
  await engine.undo(set.id)
  expect(await restored.identity('A.md')).toEqual(identity)
  await expect(restored.load('Moved.md')).rejects.toThrow()
  expect((await restored.canvas('Work')).positions['Work/B.md']).toEqual({ x: -15, y: 203 })
})

it('refuses stale canvas proposals and undo without changing any Markdown', async () => {
  const proposals = new ProposalStore(store.paths.local, changes)
  const proposal = await proposals.create({ reason: 'move', files: move(), layouts: layouts() })
  await store.savePositions({ 'A.md': { x: 99, y: 101 } })
  await expect(proposals.accept(proposal.id)).rejects.toThrow('已经变化')
  expect((await store.load('A.md')).content).toBe(original)
  const set = changes.begin('move now')
  await changes.apply(set, move(), layouts())
  await store.savePositions({ 'Moved.md': { x: 400, y: 500 } })
  expect(await changes.undoable(set)).toBe(false)
  await expect(changes.undo(set.id)).rejects.toThrow('未撤销')
  expect((await store.load('Moved.md')).content).toBe(original)
  expect((await store.canvas('')).positions['Moved.md']).toEqual({ x: 400, y: 500 })
})

it('does not report an undo as complete when its final history write fails', async () => {
  const set = changes.begin('move')
  await changes.apply(set, move(), layouts())
  const identity = await store.identity('Moved.md'), rename = fs.rename.bind(fs)
  let failed = false
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (!failed && String(to) === path.join(store.paths.local, 'changesets', set.id + '.json')) { failed = true; throw new Error('history write failed') }
    return rename(from, to)
  })
  await expect(changes.undo(set.id)).rejects.toThrow('history write failed')
  expect(await store.identity('Moved.md')).toEqual(identity)
  await expect(store.load('A.md')).rejects.toThrow()
  expect((await store.canvas('Work')).positions['Work/B.md']).toEqual({ x: 701, y: -3 })
  expect(await memory.read('_library.md')).toBe('new memory')
  expect((await changes.get(set.id)).undone).not.toBe(true)
  await changes.undo(set.id)
  expect((await store.load('A.md')).content).toBe(original)
})

it('resumes confirmation after effects commit but saving the proposal status fails', async () => {
  const proposals = new ProposalStore(store.paths.local, changes)
  const proposal = await proposals.create({ reason: 'move', files: move(), layouts: layouts() })
  const rename = fs.rename.bind(fs)
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to) === path.join(store.paths.local, 'proposals', proposal.id + '.json')) throw new Error('status write failed')
    return rename(from, to)
  })
  await expect(proposals.accept(proposal.id)).rejects.toThrow('status write failed')
  vi.restoreAllMocks()
  await expect(proposals.reject(proposal.id)).rejects.toThrow('已经保存')
  const retry = await proposals.accept(proposal.id)
  expect(retry.proposal.status).toBe('applied')
  expect(await changes.list()).toHaveLength(1)
  expect((await store.load('Moved.md')).content).toBe(original)
})

it('migrates history once and keeps it after cache deletion and a conflicting old copy', async () => {
  await fs.rm(path.join(store.paths.local, 'history-migration.json'))
  const legacy = new ConversationStore(path.join(store.paths.cache, 'conversations'))
  const conversation = legacy.create({ kind: 'chat', folder: '' })
  conversation.transcript.push({ role: 'user', text: '不能丢失', at: 1 })
  await legacy.save(conversation)
  await openDataRepo(store.paths.root, { git: false })
  const current = new ConversationStore(path.join(store.paths.local, 'conversations'), store.writer)
  const saved = await current.get(conversation.id)
  saved.transcript.push({ role: 'assistant', text: '新回复', at: 2 }); await current.save(saved)
  await openDataRepo(store.paths.root, { git: false })
  await fs.rm(store.paths.cache, { recursive: true })
  await openDataRepo(store.paths.root, { git: false })
  expect((await current.get(conversation.id)).transcript.map(message => message.text)).toEqual(['不能丢失', '新回复'])
  await expect(current.save(conversation)).rejects.toThrow('另一请求中更新')
  await fs.writeFile(path.join(store.paths.local, 'conversations', conversation.id + '.json'), 'null')
  await expect(current.get(conversation.id)).rejects.toThrow('无法读取保存记录')
})

it('refuses unknown data versions without rewriting the marker or notes', async () => {
  const marker = path.join(store.paths.root, 'canvasnote.json'), future = '{"format":"canvas-note-repo","version":99}'
  await fs.writeFile(marker, future)
  await expect(openDataRepo(store.paths.root)).rejects.toThrow('不支持')
  expect(await fs.readFile(marker, 'utf8')).toBe(future)
  expect((await store.load('A.md')).content).toBe(original)
})

it('rejects another process and CLI backup while owned, then permits backup after release', async () => {
  const release = await acquireWorkspace(store.paths.root)
  try {
    await expect(acquireWorkspace(store.paths.root)).rejects.toThrow('占用')
    await expect(run(process.execPath, ['--import', 'tsx', 'server/backup-cli.ts', 'backup', store.paths.root, path.join(directory, 'backup')])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('占用') })
    await expect(fs.access(path.join(directory, 'backup'))).rejects.toThrow()
  } finally { await release() }
  await run(process.execPath, ['--import', 'tsx', 'server/backup-cli.ts', 'backup', store.paths.root, path.join(directory, 'backup')])
  expect(await fs.readFile(path.join(directory, 'backup/payload/notes/A.md'), 'utf8')).toBe(original)
})
