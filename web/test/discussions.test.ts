import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDataRepo } from '../server/repo'
import { NoteStore, contentVersion } from '../server/store'
import { ChangeEngine } from '../server/changes'
import { MemoryFiles } from '../server/memory-files'
import { EventBus } from '../server/events'
import { createApp } from '../server/app'
import { MissingRecordError, ResearchStore, validateTurns } from '../server/discussions'
import { backupRepository, restoreRepository } from '../server/backup'
import type { TurnDTO } from '../shared/types'

let directory: string, store: NoteStore, research: ResearchStore
const note = '# 铝\n\n铝很轻。\n\n## 木\n\n木很重。\n\n## 重复\n\n同一句话。\n\n同一句话。\n'
const sha = (text: string) => contentVersion(text)

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cn-discussions-'))
  vi.stubEnv('CANVAS_CONFIG_DIR', path.join(directory, 'private'))
  const { paths } = await openDataRepo(path.join(directory, 'data'), { git: false })
  store = new NoteStore(paths)
  await store.init()
  await store.create('Materials', note)
  research = new ResearchStore(store)
})
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(directory, { recursive: true, force: true }) })

describe('sources', () => {
  it('freezes a unique selection with its version, context and section, and repeats safely', async () => {
    const first = await research.createSource({ note: 'Materials.md', quote: '木很重。' })
    expect(first).toMatchObject({ notePath: 'Materials.md', quote: '木很重。', section: '木', noteVersion: sha(note), start: note.indexOf('木很重。') })
    expect(first.before).toContain('## 木')
    expect(await research.createSource({ note: 'Materials.md', quote: '木很重。' })).toEqual(first)
    expect(await fs.readdir(path.join(store.paths.research, 'sources'))).toHaveLength(1)
  })

  it('refuses an ambiguous or stale selection instead of guessing a position', async () => {
    await expect(research.createSource({ note: 'Materials.md', quote: '同一句话。' })).rejects.toThrow('出现多次')
    await expect(research.createSource({ note: 'Materials.md', quote: '不存在' })).rejects.toThrow('找不到')
    await expect(research.createSource({ note: 'Materials.md', quote: '木很重。', start: 3 })).rejects.toThrow('不一致')
    const second = note.lastIndexOf('同一句话。')
    expect((await research.createSource({ note: 'Materials.md', quote: '同一句话。', start: second })).start).toBe(second)
  })

  it('resolves current, moved, ambiguous, missing and deleted states', async () => {
    const { id } = await research.createSource({ note: 'Materials.md', quote: '木很重。' })
    expect(await research.resolveSource(id)).toMatchObject({ status: 'current', notePath: 'Materials.md' })
    const edited = '前言。\n' + note
    await store.saveContent('Materials.md', edited, note)
    expect(await research.resolveSource(id)).toMatchObject({ status: 'moved', start: edited.indexOf('木很重。') })
    const duplicated = edited + '\n木很重。\n'
    await store.saveContent('Materials.md', duplicated, edited)
    expect(await research.resolveSource(id)).toMatchObject({ status: 'moved' })
    await store.saveContent('Materials.md', '全部重写。', duplicated)
    expect((await research.resolveSource(id)).status).toBe('missing')
    expect((await research.getSource(id)).quote).toBe('木很重。')
  })

  it('reports ambiguous when identical context appears twice', async () => {
    const block = '背景'.repeat(70) + '关键句。\n'
    await store.create('Twice', block)
    const { id } = await research.createSource({ note: 'Twice.md', quote: '关键句。' })
    await store.saveContent('Twice.md', block + block, block)
    expect((await research.resolveSource(id)).status).toBe('ambiguous')
  })

  it('keeps pointing at the same note after an in-app move', async () => {
    const { id, noteId } = await research.createSource({ note: 'Materials.md', quote: '铝很轻。' })
    const changes = new ChangeEngine(store, new MemoryFiles(store.paths.memory, store.writer), new EventBus())
    await changes.apply(null, [
      { area: 'notes', name: 'Renamed.md', before: null, after: note, identityFrom: 'Materials.md' },
      { area: 'notes', name: 'Materials.md', before: note, after: null },
    ])
    expect(await research.resolveSource(id)).toMatchObject({ status: 'current', notePath: 'Renamed.md' })
    expect((await research.getSource(id)).noteId).toBe(noteId)
    await store.replaceFile('Renamed.md', note, null)
    await store.identities()
    expect((await research.resolveSource(id)).status).toBe('note-deleted')
  })
})

describe('selection matching', () => {
  const formatted = '# 标题\n\n- **铝**很轻，\n  密度约 *2.7*。\n- 木材更重。\n\n这是一句话。\n\n这是一句话。\n'
  it('finds a selection copied from rendered text and records the exact source range it covers', async () => {
    await store.create('Rich', formatted)
    const source = await research.createSource({ note: 'Rich.md', quote: '铝很轻，密度约 2.7。' })
    expect(source.quote).toBe('**铝**很轻，\n  密度约 *2.7*。')
    expect(formatted.slice(source.start, source.end)).toBe(source.quote)
    expect(await research.createSource({ note: 'Rich.md', quote: '铝很轻，密度约 2.7。' })).toEqual(source)
  })
  it('tolerates surrounding whitespace, still refuses ambiguity, and never matches on markers alone', async () => {
    await store.create('Rich', formatted)
    expect((await research.createSource({ note: 'Rich.md', quote: '  木材更重。\n' })).quote).toBe('木材更重。')
    await expect(research.createSource({ note: 'Rich.md', quote: '这是**一句话**。' })).rejects.toThrow('出现多次')
    await expect(research.createSource({ note: 'Rich.md', quote: '***' })).rejects.toThrow('找不到')
    await expect(research.createSource({ note: 'Rich.md', quote: '完全不同的内容' })).rejects.toThrow('找不到')
  })
})

describe('discussion graph', () => {
  it('adds idempotent turns, validates parents and keeps answers append-only', async () => {
    const discussion = await research.createDiscussion({ title: '材料比较' })
    const root = await research.addTurn(discussion.id, { question: '铝和木哪个更轻？', requestKey: 'k-root' })
    expect(await research.addTurn(discussion.id, { question: '铝和木哪个更轻？', requestKey: 'k-root' })).toEqual(root)
    await expect(research.addTurn(discussion.id, { question: '另一个问题', requestKey: 'k-root' })).rejects.toThrow('不能用于不同问题')
    await expect(research.addTurn(discussion.id, { question: 'x', requestKey: 'k-bad', parents: ['a'.repeat(32)] })).rejects.toThrow('父节点不在')
    // Continuing from, or comparing with, a question that has no answer yet is refused (as in ChatGit).
    await expect(research.addTurn(discussion.id, { question: '过早追问', parents: [root.id], requestKey: 'k-early' })).rejects.toThrow('还没有回答')
    await research.addAnswer(discussion.id, root.id, { text: '根的回答', runId: 'run-root' })
    const a = await research.addTurn(discussion.id, { question: '铝？', parents: [root.id], requestKey: 'k-a' })
    const b = await research.addTurn(discussion.id, { question: '木？', parents: [root.id], requestKey: 'k-b' })
    await expect(research.addTurn(discussion.id, { question: '提前比较', parents: [a.id, b.id], requestKey: 'k-early-merge' })).rejects.toThrow('还没有回答')
    await research.addAnswer(discussion.id, b.id, { text: '木的回答', runId: 'run-b' })
    await expect(research.addTurn(discussion.id, { question: '只有一边有回答', parents: [a.id, b.id], requestKey: 'k-half' })).rejects.toThrow('还没有回答')
    await research.addAnswer(discussion.id, a.id, { text: '铝的回答（先于第一版）', runId: 'run-a0' })
    const merged = await research.addTurn(discussion.id, { question: '比较', parents: [a.id, b.id], requestKey: 'k-m' })
    const first = await research.addAnswer(discussion.id, a.id, { text: '第一版', runId: 'run-1' })
    expect(await research.addAnswer(discussion.id, a.id, { text: '重复提交', runId: 'run-1' })).toEqual(first)
    const retry = await research.addAnswer(discussion.id, a.id, { text: '重试版', runId: 'run-2' })
    const saved = await research.getDiscussion(discussion.id)
    expect(saved.turns.find(turn => turn.id === a.id)!.answers.map(answer => answer.text)).toEqual(['铝的回答（先于第一版）', '第一版', '重试版'])
    expect(retry.id).not.toBe(first.id)
    expect(saved.turns.find(turn => turn.id === merged.id)!.parents).toEqual([a.id, b.id])
    expect(saved.revision).toBeGreaterThan(1)
  })

  it('rejects cycles, missing parents and duplicate ids however the turns are ordered', () => {
    const turn = (id: string, parents: string[], requestKey = id): TurnDTO => ({ id, parents, question: id, sourceIds: [], requestKey, answers: [], createdAt: 1 })
    expect(() => validateTurns([turn('c', ['b']), turn('b', ['a']), turn('a', [])])).not.toThrow()
    expect(() => validateTurns([turn('a', ['b']), turn('b', ['a'])])).toThrow('环')
    expect(() => validateTurns([turn('a', ['a'])])).toThrow('环')
    expect(() => validateTurns([turn('a', ['missing'])])).toThrow('不存在')
    expect(() => validateTurns([turn('a', []), turn('a', [], 'other')])).toThrow('重复')
  })

  it('refuses to open a discussion file whose graph is invalid, preserving it', async () => {
    const discussion = await research.createDiscussion({ title: '坏图' })
    const file = path.join(store.paths.local, 'discussions', discussion.id + '.json')
    const broken = JSON.parse(await fs.readFile(file, 'utf8'))
    broken.turns = [{ id: 'a', parents: ['b'], question: 'a', sourceIds: [], requestKey: 'a', answers: [], createdAt: 1 }, { id: 'b', parents: ['a'], question: 'b', sourceIds: [], requestKey: 'b', answers: [], createdAt: 1 }]
    await fs.writeFile(file, JSON.stringify(broken))
    await expect(research.getDiscussion(discussion.id)).rejects.toThrow('环')
    expect(JSON.parse(await fs.readFile(file, 'utf8')).turns).toHaveLength(2)
  })

  it('archives without deleting and reports missing records by name', async () => {
    const discussion = await research.createDiscussion({ title: '归档' })
    await research.setArchived(discussion.id, true)
    expect((await research.listDiscussions({ archived: false })).map(item => item.id)).not.toContain(discussion.id)
    expect((await research.listDiscussions({ archived: true })).map(item => item.id)).toContain(discussion.id)
    expect((await research.getDiscussion(discussion.id)).archived).toBe(true)
    await expect(research.getDiscussion('f'.repeat(32))).rejects.toBeInstanceOf(MissingRecordError)
    await expect(research.getDiscussion('../x')).rejects.toThrow('编号无效')
  })
})

describe('multi-question drafts', () => {
  it('collects questions with their sources, survives a restart, and rejects stale editors', async () => {
    const one = await research.createSource({ note: 'Materials.md', quote: '铝很轻。' })
    const two = await research.createSource({ note: 'Materials.md', quote: '木很重。' })
    const draft = await research.createDraft({ title: '材料', items: [{ id: 'q1', question: '为什么轻？', sourceIds: [one.id] }, { id: 'q2', question: '为什么重？', sourceIds: [two.id] }] })
    const reopened = await new ResearchStore(store).getDraft(draft.id)
    expect(reopened.items.map(item => [item.question, item.sourceIds])).toEqual([['为什么轻？', [one.id]], ['为什么重？', [two.id]]])
    const next = await research.updateDraft(draft.id, 1, { items: [...reopened.items, { id: 'q3', question: '还有吗？' }] })
    expect(next.revision).toBe(2)
    await expect(research.updateDraft(draft.id, 1, { items: [] })).rejects.toThrow('未覆盖较新')
    expect((await research.getDraft(draft.id)).items).toHaveLength(3)
    await expect(research.createDraft({ items: [{ question: 'x', sourceIds: ['0'.repeat(32)] }] })).rejects.toBeInstanceOf(MissingRecordError)
  })

  it('sends every question as a sibling turn with its own source and removes only what was sent', async () => {
    const one = await research.createSource({ note: 'Materials.md', quote: '铝很轻。' })
    const two = await research.createSource({ note: 'Materials.md', quote: '木很重。' })
    const draft = await research.createDraft({ items: [{ id: 'q1', question: '为什么轻？', sourceIds: [one.id] }, { id: 'q2', question: '为什么重？', sourceIds: [two.id] }, { id: 'q3', question: '稍后再问' }] })
    const sent = await research.sendDraft(draft.id, [{ id: 'q1', question: '为什么轻？' }, { id: 'q2', question: '为什么重？' }])
    expect(sent.turns.map(turn => [turn.question, turn.sourceIds, turn.parents])).toEqual([['为什么轻？', [one.id], []], ['为什么重？', [two.id], []]])
    expect(sent.draft.items.map(item => item.id)).toEqual(['q3'])
    expect(sent.draft.discussionId).toBe(sent.discussion.id)
    expect(sent.discussion.turns).toHaveLength(2)
    expect(sent.discussion.origin).toEqual({ kind: 'chat' })
  })

  it('retrying after a lost response creates no second discussion or turn', async () => {
    const draft = await research.createDraft({ items: [{ id: 'q1', question: '重复发送？' }] })
    const first = await research.sendDraft(draft.id, [{ id: 'q1', question: '重复发送？' }])
    const again = await research.sendDraft(draft.id, [{ id: 'q1', question: '重复发送？' }])
    expect(again.turns).toEqual(first.turns)
    expect(again.discussion.id).toBe(first.discussion.id)
    expect(await research.listDiscussions()).toHaveLength(1)
    expect((await research.getDiscussion(first.discussion.id)).turns).toHaveLength(1)
  })

  it('recovers when the process stopped after creating the turn but before cleaning the draft', async () => {
    const draft = await research.createDraft({ items: [{ id: 'q1', question: '崩溃前已落盘' }] })
    const discussion = await research.createDiscussion({ id: contentVersion('draft-discussion\0' + draft.id).slice(0, 32), title: 'x' })
    const key = 'draft:' + draft.id + ':q1:' + contentVersion('崩溃前已落盘').slice(0, 32)
    const turn = await research.addTurn(discussion.id, { question: '崩溃前已落盘', requestKey: key })
    const result = await research.sendDraft(draft.id, [{ id: 'q1', question: '崩溃前已落盘' }])
    expect(result.turns).toEqual([turn])
    expect(result.draft.items).toEqual([])
    expect(result.discussion.turns).toHaveLength(1)
  })

  it('keeps text typed while an earlier version was being sent', async () => {
    const draft = await research.createDraft({ items: [{ id: 'q1', question: '旧问题' }] })
    const typed = await research.updateDraft(draft.id, 1, { items: [{ id: 'q1', question: '旧问题，又补充了新想法' }] })
    const result = await research.sendDraft(draft.id, [{ id: 'q1', question: '旧问题' }])
    expect(result.turns[0]!.question).toBe('旧问题')
    expect(result.draft.items).toEqual([{ id: 'q1', question: '旧问题，又补充了新想法', sourceIds: [] }])
    expect(result.draft.revision).toBeGreaterThan(typed.revision)
    const second = await research.sendDraft(draft.id, [{ id: 'q1', question: '旧问题，又补充了新想法' }])
    expect(second.discussion.turns).toHaveLength(2)
    expect(second.draft.items).toEqual([])
  })

  it('leaves the draft untouched when sending is rejected', async () => {
    const draft = await research.createDraft({ items: [{ id: 'q1', question: '问题' }] })
    await expect(research.sendDraft(draft.id, [{ id: 'q9', question: '不在草稿里' }])).rejects.toThrow('没有这个问题')
    await expect(research.sendDraft(draft.id, [{ id: 'q1', question: '   ' }])).rejects.toThrow('无效')
    expect(await research.getDraft(draft.id)).toEqual(draft)
    expect((await research.getDraft(draft.id)).items).toHaveLength(1)
  })

  it('continues an existing discussion from chosen parents', async () => {
    const discussion = await research.createDiscussion({ title: '续问' })
    const root = await research.addTurn(discussion.id, { question: '根', requestKey: 'r' })
    await research.addAnswer(discussion.id, root.id, { text: '根的回答', runId: 'r' })
    await expect(research.createDraft({ parentIds: [root.id] })).rejects.toThrow('新讨论')
    const draft = await research.createDraft({ discussionId: discussion.id, parentIds: [root.id], items: [{ id: 'q1', question: '追问' }] })
    const result = await research.sendDraft(draft.id, [{ id: 'q1', question: '追问' }])
    expect(result.turns[0]!.parents).toEqual([root.id])
    expect(result.discussion.id).toBe(discussion.id)
  })
})

describe('source write failure', () => {
  it('reports the failure, sends nothing and keeps the draft when a source cannot be written', async () => {
    await fs.writeFile(path.join(store.paths.research, 'sources'), 'not a directory')
    await expect(research.createSource({ note: 'Materials.md', quote: '铝很轻。' })).rejects.toThrow()
    const draft = await research.createDraft({ items: [{ id: 'q1', question: '没有来源也能保存' }] })
    expect((await research.getDraft(draft.id)).items).toHaveLength(1)
    expect(await research.listDiscussions()).toEqual([])
    await expect(research.createDraft({ items: [{ question: 'x', sourceIds: ['a'.repeat(32)] }] })).rejects.toThrow()
  })

  it('does not report a turn as created when the discussion cannot be saved', async () => {
    const discussion = await research.createDiscussion({ title: '写入失败' })
    const file = path.join(store.paths.local, 'discussions', discussion.id + '.json')
    await fs.rm(file)
    await fs.mkdir(file)
    await expect(research.addTurn(discussion.id, { question: '问题', requestKey: 'k' })).rejects.toThrow()
    await fs.rm(file, { recursive: true })
    await expect(research.getDiscussion(discussion.id)).rejects.toBeInstanceOf(MissingRecordError)
  })
})

describe('captures', () => {
  async function answered() {
    const source = await research.createSource({ note: 'Materials.md', quote: '铝很轻。' })
    const discussion = await research.createDiscussion({ title: '写回' })
    const turn = await research.addTurn(discussion.id, { question: '铝？', sourceIds: [source.id], requestKey: 'k' })
    const answer = await research.addAnswer(discussion.id, turn.id, { text: '铝的密度较低。', runId: 'r1' })
    const identity = await store.identity('Materials.md')
    const target = { kind: 'append' as const, noteId: identity.id, notePath: 'Materials.md', beforeVersion: identity.version, afterVersion: sha('after') }
    return { source, discussion, turn, answer, target }
  }

  it('records the exact answer version and text, and keeps the evidence after a retry', async () => {
    const { source, discussion, turn, answer, target } = await answered()
    const capture = await research.recordCapture({ requestKey: 'cap-1', mode: 'verbatim', target, answers: [{ discussionId: discussion.id, turnId: turn.id, answerId: answer.id }] })
    expect(capture).toMatchObject({ mode: 'verbatim', sourceIds: [source.id], answers: [{ answerId: answer.id, text: '铝的密度较低。' }] })
    await research.addAnswer(discussion.id, turn.id, { text: '重试后的新回答', runId: 'r2' })
    expect((await research.getCapture(capture.id)).answers[0]!.text).toBe('铝的密度较低。')
    expect(await research.listCaptures(target.noteId)).toHaveLength(1)
    expect(await fs.readdir(path.join(store.paths.research, 'captures'))).toEqual([capture.id + '.json'])
  })

  it('is idempotent per request key and rejects reuse for different content or unknown answers', async () => {
    const { discussion, turn, answer, target } = await answered()
    const input = { requestKey: 'cap-1', mode: 'verbatim' as const, target, answers: [{ discussionId: discussion.id, turnId: turn.id, answerId: answer.id }] }
    const first = await research.recordCapture(input)
    expect(await research.recordCapture(input)).toEqual(first)
    expect(await research.listCaptures()).toHaveLength(1)
    await expect(research.recordCapture({ ...input, mode: 'organized', writtenText: '整理后的文字' })).rejects.toThrow('不能用于不同')
    await expect(research.recordCapture({ ...input, requestKey: 'cap-0', mode: 'organized' })).rejects.toThrow('必须记录写入的文字')
    await expect(research.recordCapture({ ...input, requestKey: 'cap-2', answers: [{ ...input.answers[0]!, answerId: 'f'.repeat(36) }] })).rejects.toBeInstanceOf(MissingRecordError)
    await expect(research.recordCapture({ ...input, requestKey: 'cap-3', target: { ...target, kind: 'new' } })).rejects.toThrow('目标无效')
    await expect(research.recordCapture({ ...input, requestKey: 'cap-4', target: { ...target, noteId: 'b'.repeat(36) } })).rejects.toBeInstanceOf(MissingRecordError)
  })
})

describe('durability and API', () => {
  it('survives clearing the rebuildable cache and a full backup restore', async () => {
    const source = await research.createSource({ note: 'Materials.md', quote: '铝很轻。' })
    const draft = await research.createDraft({ items: [{ id: 'q1', question: '未发送', sourceIds: [source.id] }, { id: 'q2', question: '已发送' }] })
    const sent = await research.sendDraft(draft.id, [{ id: 'q2', question: '已发送' }])
    await fs.rm(store.paths.cache, { recursive: true, force: true })
    await backupRepository(store.paths.root, path.join(directory, 'backup'))
    await restoreRepository(path.join(directory, 'backup'), path.join(directory, 'restored'))
    const { paths } = await openDataRepo(path.join(directory, 'restored'), { git: false })
    const restored = new ResearchStore(new NoteStore(paths))
    expect((await restored.getDraft(draft.id)).items.map(item => item.question)).toEqual(['未发送'])
    expect((await restored.getDiscussion(sent.discussion.id)).turns.map(turn => turn.question)).toEqual(['已发送'])
    expect(await restored.getSource(source.id)).toEqual(source)
  })

  it('keeps drafts and raw discussions out of Git but sources in the committed research folder', async () => {
    expect(await fs.readFile(path.join(store.paths.root, '.gitignore'), 'utf8')).toContain('/local/')
    expect(store.paths.local).not.toBe(store.paths.research)
    await research.createSource({ note: 'Materials.md', quote: '铝很轻。' })
    expect(await fs.readdir(path.join(store.paths.research, 'sources'))).toHaveLength(1)
  })

  it('serves the whole flow over HTTP with conflict and not-found statuses', async () => {
    const app = createApp(store, new EventBus())
    const headers = { host: 'localhost:3001', 'content-type': 'application/json' }
    const call = (method: string, url: string, body?: unknown) => app.request(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const source = await (await call('POST', '/api/sources', { note: 'Materials.md', quote: '木很重。' })).json()
    expect((await call('POST', '/api/sources', { note: 'Materials.md', quote: '同一句话。' })).status).toBe(409)
    const draft = await (await call('POST', '/api/drafts', { items: [{ id: 'q1', question: '为什么？', sourceIds: [source.id] }] })).json()
    expect((await call('PATCH', `/api/drafts/${draft.id}`, { revision: 7, title: 'x' })).status).toBe(409)
    expect((await call('PATCH', `/api/drafts/${draft.id}`, { revision: 1, title: '新标题' })).status).toBe(200)
    const sent = await call('POST', `/api/drafts/${draft.id}/send`, { items: [{ id: 'q1', question: '为什么？' }] })
    expect(sent.status).toBe(201)
    const { discussion } = await sent.json()
    expect((await (await call('GET', `/api/discussions/${discussion.id}`)).json()).turns[0].sourceIds).toEqual([source.id])
    expect((await call('GET', `/api/discussions/${'e'.repeat(32)}`)).status).toBe(404)
    expect((await (await call('GET', `/api/sources/${source.id}`)).json()).status).toBe('current')
    expect((await call('GET', '/api/drafts/not-an-id')).status).toBe(400)
    expect((await call('DELETE', `/api/drafts/${draft.id}?revision=1`)).status).toBe(409)
  })
})
