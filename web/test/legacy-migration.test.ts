import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AISettings } from '../server/ai-settings'
import { createApp } from '../server/app'
import { backupRepository, restoreRepository } from '../server/backup'
import { ResearchStore } from '../server/discussions'
import { EventBus } from '../server/events'
import { readBatch, rollbackImport } from '../server/import-chatgit'
import { importLegacyConversations, legacyPreflight, verifyLegacyImport } from '../server/import-legacy'
import { openDataRepo, repoPaths } from '../server/repo'
import { NoteStore } from '../server/store'
import { IDS, NOTE_A, NOTE_B, PNG, makeV02, makeV1 } from './fixtures/legacy-canvas'

const run = promisify(execFile)
const J = { host: 'localhost:3001', 'content-type': 'application/json' }
let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cn-legacy-')) })
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

const tree = async (root: string): Promise<string[]> => {
  const out: string[] = []
  const walk = async (d: string) => { for (const e of await fs.readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); out.push(path.relative(root, p) + (e.isDirectory() ? '/' : '')); if (e.isDirectory()) await walk(p) } }
  await walk(root); return out.sort()
}
const open = async (root: string) => { const { paths } = await openDataRepo(root, { git: false }); const store = new NoteStore(paths); await store.init(); return { store, research: new ResearchStore(store), paths } }
const bytes = (file: string) => fs.readFile(file)

describe('v0.2 notes folder (Markdown in the root + .canvasnote/)', () => {
  it('migrates in place: Markdown and attachments byte-identical, positions and groups converted, old records kept, version marker written', async () => {
    const root = path.join(dir, 'old'); await makeV02(root)
    const { paths, migrated } = await openDataRepo(root, { git: false })
    expect(migrated).toBe(true)
    expect((await bytes(path.join(paths.notes, 'A.md'))).toString()).toBe(NOTE_A)
    expect((await bytes(path.join(paths.notes, 'Work', 'B.md'))).toString()).toBe(NOTE_B)
    expect((await bytes(path.join(paths.notes, 'Work', 'diagram.png'))).equals(PNG)).toBe(true)
    expect(JSON.parse(await fs.readFile(path.join(paths.canvas, '_canvas.json'), 'utf8'))).toMatchObject({ version: 1, notes: { 'A.md': { x: 10, y: 20 } } })
    expect(JSON.parse(await fs.readFile(path.join(paths.canvas, 'Work', '_canvas.json'), 'utf8'))).toMatchObject({ notes: { 'B.md': { x: 30, y: 40 } }, frames: [{ id: 'f1', title: '分组', members: ['B.md'] }] })
    expect(await fs.readFile(path.join(paths.cache, 'legacy-agent-changes', 'x.json'), 'utf8')).toBe('{"old":"v0.2 change record"}')
    expect((await fs.stat(path.join(paths.legacy, 'library.json'))).isFile()).toBe(true)      // the original library file is kept
    expect(JSON.parse(await fs.readFile(path.join(root, 'canvasnote.json'), 'utf8'))).toEqual({ format: 'canvas-note-repo', version: 2 })
  })

  it('opens compatibly afterwards: notes listed over HTTP with their positions, stable ids that survive a restart, and no second migration', async () => {
    const root = path.join(dir, 'old'); await makeV02(root)
    const first = await open(root)
    const app = createApp(first.store, new EventBus(), { aiSettings: new AISettings(dir, path.join(dir, 'private'), {}) })
    const reply = await app.request('/api/notes', { headers: J }); const notes = await reply.json() as { name: string }[]; if (!Array.isArray(notes)) throw new Error(reply.status + ' ' + JSON.stringify(notes))
    expect(notes.map(note => note.name).sort()).toEqual(['A.md', 'Work/B.md'])
    const ids = await first.store.identities()
    const layoutBefore = await tree(root)
    const again = await openDataRepo(root, { git: false })
    expect(again.migrated).toBe(false)
    expect(await tree(root)).toEqual(layoutBefore)                  // nothing moved by the second open
    const second = await open(root)
    expect((await second.store.identities()).paths).toEqual(ids.paths)
  })

  it('round-trips through backup and restore, and the restored copy opens without migrating again', async () => {
    const root = path.join(dir, 'old'); await makeV02(root)
    await open(root)
    const backup = path.join(dir, 'backup'), restored = path.join(dir, 'restored')
    await backupRepository(root, backup)
    await restoreRepository(backup, restored)
    const { paths, migrated } = await openDataRepo(restored, { git: false })
    expect(migrated).toBe(false)
    expect((await bytes(path.join(paths.notes, 'Work', 'B.md'))).toString()).toBe(NOTE_B)
    expect((await bytes(path.join(paths.notes, 'Work', 'diagram.png'))).equals(PNG)).toBe(true)
    expect(await fs.readFile(path.join(paths.canvas, 'Work', '_canvas.json'), 'utf8')).toBe(await fs.readFile(path.join(root, 'canvas', 'Work', '_canvas.json'), 'utf8'))
  })

  it('an interrupted migration resumes without losing a file', async () => {
    const root = path.join(dir, 'old'); await makeV02(root)
    await fs.mkdir(path.join(root, '.migrating-notes'), { recursive: true })
    await fs.rename(path.join(root, 'A.md'), path.join(root, '.migrating-notes', 'A.md'))                 // half moved
    await fs.writeFile(path.join(root, '.canvasnote-migration.json'), JSON.stringify({ step: 'move' }))
    const { paths } = await openDataRepo(root, { git: false })
    expect((await bytes(path.join(paths.notes, 'A.md'))).toString()).toBe(NOTE_A)
    expect((await bytes(path.join(paths.notes, 'Work', 'B.md'))).toString()).toBe(NOTE_B)
    await expect(fs.access(path.join(root, '.canvasnote-migration.json'))).rejects.toThrow()
  })
})

describe('a new-format directory is never taken for an old notes folder', () => {
  it('refuses a repository that lost its version marker, and moves nothing', async () => {
    const root = path.join(dir, 'data')
    const { paths } = await openDataRepo(root, { git: false })
    await fs.writeFile(path.join(paths.notes, 'Keep.md'), '# keep\n')
    await fs.mkdir(path.join(paths.local, 'discussions'), { recursive: true })
    await fs.rm(path.join(root, 'canvasnote.json'))
    const before = await tree(root)
    await expect(openDataRepo(root, { git: false })).rejects.toThrow('缺少版本标记')
    expect(await tree(root)).toEqual(before)
    expect((await bytes(path.join(paths.notes, 'Keep.md'))).toString()).toBe('# keep\n')
    // ...and putting the marker back is all it takes.
    await fs.writeFile(path.join(root, 'canvasnote.json'), JSON.stringify({ format: 'canvas-note-repo', version: 2 }))
    expect((await openDataRepo(root, { git: false })).migrated).toBe(false)
  })

  it('finishes a first start that stopped after creating the empty directories but before the marker', async () => {
    const root = path.join(dir, 'fresh')
    for (const name of ['notes', 'memory', 'canvas', 'cache']) await fs.mkdir(path.join(root, name), { recursive: true })
    const { migrated } = await openDataRepo(root, { git: false })
    expect(migrated).toBe(false)
    expect(JSON.parse(await fs.readFile(path.join(root, 'canvasnote.json'), 'utf8')).version).toBe(2)
    expect((await fs.readdir(path.join(root, 'notes')))).toEqual([])
  })

  it('still migrates a genuine old folder that happens to contain a subfolder named notes', async () => {
    const root = path.join(dir, 'old'); await makeV02(root)
    await fs.mkdir(path.join(root, 'notes'), { recursive: true }); await fs.writeFile(path.join(root, 'notes', 'Inner.md'), '# inner\n')
    const { paths, migrated } = await openDataRepo(root, { git: false })
    expect(migrated).toBe(true)
    expect((await bytes(path.join(paths.notes, 'notes', 'Inner.md'))).toString()).toBe('# inner\n')
  })

  it('refuses a directory written by a newer version rather than rewriting it', async () => {
    const root = path.join(dir, 'future'); await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, 'canvasnote.json'), JSON.stringify({ format: 'canvas-note-repo', version: 99 }))
    await expect(openDataRepo(root, { git: false })).rejects.toThrow('不支持这个数据仓库版本')
    expect(JSON.parse(await fs.readFile(path.join(root, 'canvasnote.json'), 'utf8')).version).toBe(99)
  })
})

describe('v1 repository: history in cache/', () => {
  it('upgrades by copying the history to local/ once and never changing cache/, even when some records are damaged', async () => {
    const root = path.join(dir, 'v1'); await makeV1(root)
    const before = await Promise.all((await fs.readdir(path.join(root, 'cache', 'conversations'))).map(async name => [name, (await bytes(path.join(root, 'cache', 'conversations', name))).toString()]))
    const { paths } = await openDataRepo(root, { git: false })
    expect(JSON.parse(await fs.readFile(path.join(root, 'canvasnote.json'), 'utf8')).version).toBe(2)
    for (const [name, text] of before) {
      expect((await bytes(path.join(paths.local, 'conversations', name!))).toString()).toBe(text)       // copied byte for byte, damaged ones too
      expect((await bytes(path.join(paths.cache, 'conversations', name!))).toString()).toBe(text)       // the original is untouched
    }
    expect((await fs.readFile(path.join(paths.cache, 'legacy-agent-changes', 'old.json'), 'utf8'))).toBe('{"v0.2":true}')
    expect((await bytes(path.join(paths.notes, 'Work', 'B.md'))).toString()).toBe(NOTE_B)
  })

  it('reports what is damaged, missing or unlinked one record at a time, without changing anything', async () => {
    const root = path.join(dir, 'v1'); await makeV1(root)
    const { paths } = await openDataRepo(root, { git: false })
    const before = await tree(root)
    const report = await legacyPreflight(paths)
    expect(await tree(root)).toEqual(before)
    expect(report.counts).toMatchObject({ conversations: 7, readable: 5, changesets: 3, proposals: 2, legacyAgentChanges: 1 })
    const at = (code: string) => report.issues.filter(issue => issue.code === code).map(issue => issue.where)
    expect(at('conversation-corrupt')).toEqual([`conversations/${IDS.corrupt}.json`])
    expect(at('conversation-format')).toEqual([`conversations/${IDS.wrong}.json`])
    expect(at('change-missing')).toEqual([`conversations/${IDS.good}.json`])                  // references …0ff which does not exist
    expect(at('change-unlinked')).toEqual(['changesets/c0000000-0000-4000-8000-000000000002.json'])
    expect(at('changeset-corrupt')).toEqual(['changesets/c0000000-0000-4000-8000-000000000003.json'])
    expect(at('proposal-corrupt')).toEqual(['proposals/p0000000-0000-4000-8000-000000000002.json'])
    expect(at('leading-assistant')).toEqual([`conversations/${IDS.lead}.json`])
    expect(at('note-gone')).toEqual([`conversations/${IDS.gone}.json`])
    expect(at('legacy-agent-changes-kept')).toHaveLength(1)
    expect(report.issues.find(issue => issue.code === 'change-unlinked')!.message).toContain('不编造来源')
    expect(report.conversations.find(item => item.id === IDS.empty)).toMatchObject({ status: 'skipped', reason: '没有可导入的问答。' })
  })

  it('says so plainly when there is no history at all', async () => {
    const root = path.join(dir, 'blank'); const { paths } = await openDataRepo(root, { git: false })
    const report = await legacyPreflight(paths)
    expect(report.counts.conversations).toBe(0)
    expect(report.issues.map(issue => issue.code)).toEqual(['no-conversations'])
  })
})

describe('old conversations become read-only linear discussions', () => {
  async function ready() {
    const root = path.join(dir, 'v1'); await makeV1(root)
    const opened = await open(root)
    return { root, ...opened }
  }
  const all = async (research: ResearchStore) => Promise.all((await research.listDiscussions()).map(item => research.getDiscussion(item.id)))

  it('maps each readable conversation to a linear chain, pairing a question with its replies, and skips what cannot be mapped', async () => {
    const { store, research } = await ready()
    const result = await importLegacyConversations(store, research)
    expect(result.totals).toEqual({ created: 4, identical: 0, conflict: 0, skipped: 1 })
    const discussions = await all(research)
    const good = discussions.find(item => item.title === '整理一下笔记')!
    expect(good.turns.map(turn => turn.question)).toEqual(['整理一下笔记', '再检查一遍'])
    expect(good.turns[0]!.answers.map(answer => answer.text)).toEqual(['我读了两篇。\n\n已经整理好了。'])     // two assistant lines are one answer
    expect(good.turns[1]!.parents).toEqual([good.turns[0]!.id])                                              // linear
    expect(good.turns[1]!.frozen).toEqual({ [good.turns[0]!.id]: good.turns[0]!.answers[0]!.id })
    expect(good.imported).toMatchObject({ source: 'canvas-conversation', canvasId: IDS.good, readOnly: true })
    expect(good.origin).toEqual({ kind: 'chat' })
    expect(good.createdAt).toBe(1000)
    // A note-scoped conversation stays tied to its note; one whose note is gone is a plain chat.
    const noted = discussions.find(item => item.title === '这篇讲什么？')!
    expect(noted.origin).toMatchObject({ kind: 'note', noteId: (await store.identity('A.md')).id })
    expect(discussions.find(item => item.title === '关于已删除笔记的问题')!.origin).toEqual({ kind: 'chat' })
    // The assistant line before any question is not invented into a question.
    expect(discussions.find(item => item.title === '问题')!.turns).toHaveLength(1)
    expect(result.items.find(item => item.id === IDS.empty)).toMatchObject({ result: 'skipped' })
  })

  it('never touches the original conversation, change and proposal records', async () => {
    const { store, research, paths } = await ready()
    const snapshot = async () => { const out: Record<string, string> = {}; for (const part of ['conversations', 'changesets', 'proposals']) for (const name of await fs.readdir(path.join(paths.local, part))) out[part + '/' + name] = await fs.readFile(path.join(paths.local, part, name), 'utf8'); return out }
    const before = await snapshot()
    await importLegacyConversations(store, research)
    expect(await snapshot()).toEqual(before)
  })

  it('cannot be continued as a question-and-answer discussion, by any route, but can still be read, archived and written into notes', async () => {
    const { store, research } = await ready()
    await importLegacyConversations(store, research)
    const good = (await all(research)).find(item => item.title === '整理一下笔记')!
    await expect(research.addTurn(good.id, { question: '继续', parents: [good.turns[1]!.id], requestKey: 'x' })).rejects.toThrow('只读历史')
    await expect(research.createDraft({ discussionId: good.id, parentIds: [good.turns[1]!.id], items: [{ id: 'q1', question: '继续' }] })).rejects.toThrow('只读历史')
    const app = createApp(store, new EventBus(), { aiSettings: new AISettings(dir, path.join(dir, 'private'), {}) })
    const response = await app.request('/api/drafts', { method: 'POST', headers: J, body: JSON.stringify({ discussionId: good.id, parentIds: [good.turns[1]!.id], items: [{ id: 'q1', question: '继续' }] }) })
    expect(response.status).toBe(400)
    expect((await research.setArchived(good.id, true)).archived).toBe(true)
    const note = await store.create('接收', '# 接收\n')
    const identity = await store.identity(note)
    const capture = await research.recordCapture({ requestKey: 'c', mode: 'verbatim', target: { kind: 'append', noteId: identity.id, notePath: note, beforeVersion: identity.version, afterVersion: 'a'.repeat(64) }, answers: [{ discussionId: good.id, turnId: good.turns[0]!.id, answerId: good.turns[0]!.answers[0]!.id }] })
    expect(capture.answers[0]!.text).toContain('已经整理好了。')
  })

  it('is idempotent and resumable, verifies, names the conversation that differs, and rolls back to an archive', async () => {
    const { store, research } = await ready()
    const first = await importLegacyConversations(store, research)
    const again = await importLegacyConversations(store, research)
    expect(again).toMatchObject({ resumed: true, totals: { created: 0, identical: 4, conflict: 0, skipped: 1 } })
    expect((await research.listDiscussions())).toHaveLength(4)
    expect(await verifyLegacyImport(store, research)).toMatchObject({ ok: true, mismatches: [], checked: { conversations: 4, turns: 5, answers: 5 } })
    const good = (await all(research)).find(item => item.title === '整理一下笔记')!
    const file = path.join(store.paths.local, 'discussions', good.id + '.json')
    const record = JSON.parse(await fs.readFile(file, 'utf8')); record.turns[1].answers[0].text = '被悄悄改了'; await fs.writeFile(file, JSON.stringify(record))
    expect((await verifyLegacyImport(store, research)).mismatches).toEqual([{ where: `${IDS.good}#1`, message: '回答的数量或校验值不一致。' }])
    await fs.writeFile(file, JSON.stringify({ ...record, turns: record.turns.map((turn: { answers: { text: string }[] }, index: number) => index === 1 ? { ...turn, answers: [{ ...turn.answers[0], text: '没有问题。' }] } : turn) }))
    const done = await rollbackImport(store, research, first.batch)
    expect(done).toMatchObject({ discussions: 4 })
    expect(await research.listDiscussions()).toEqual([])
    expect((await readBatch(store, first.batch))!.state).toBe('rolled-back')
    await expect(importLegacyConversations(store, research)).rejects.toThrow('已经回退过')
    expect((await fs.readdir(path.join(store.paths.local, 'conversations'))).length).toBe(7)     // the originals are still all there
  })
})

describe('command line', () => {
  const cli = (...args: string[]) => run('node', ['--import', 'tsx', 'server/import-cli.ts', ...args], { cwd: path.resolve(__dirname, '..'), timeout: 60000 }).then(out => ({ code: 0, out: out.stdout + out.stderr }), (error: { code: number; stdout: string; stderr: string }) => ({ code: error.code, out: error.stdout + error.stderr }))

  it('legacy-preflight reads without writing (and without migrating), legacy-import needs a backup, then verify and rollback', async () => {
    const root = path.join(dir, 'v2'); await makeV1(root)
    await openDataRepo(root, { git: false })                          // the normal upgrade: history is now in local/
    const before = await tree(root)
    const pre = await cli('legacy-preflight', root)
    expect(pre.code).toBe(1)                                          // errors in the old records are reported through the exit status
    expect(pre.out).toContain('conversation-corrupt'); expect(pre.out).toContain(IDS.corrupt); expect(pre.out).toContain('7 个文件，5 个可读')
    expect(await tree(root)).toEqual(before)

    const refused = await cli('legacy-import', root)
    expect(refused.code).toBe(1); expect(refused.out).toContain('--backup')
    const done = await cli('legacy-import', root, '--backup', path.join(dir, 'backup'))
    expect(done.out).toContain('备份已完成并校验'); expect(done.out).toContain('新建 4'); expect(done.out).toContain('核对：全部一致')
    expect((await cli('legacy-verify', root)).out).toContain('全部一致')
    const batch = /导入批次 (legacy-[a-f0-9]{16})/.exec(done.out)![1]!
    const back = await cli('rollback', batch, root, '--backup', path.join(dir, 'backup2'))
    expect(back.code, back.out).toBe(0); expect(back.out).toContain('已回退批次')
  }, 120000)
})
