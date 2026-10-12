import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AISettings } from '../server/ai-settings'
import { createApp } from '../server/app'
import { NoteStore } from '../server/store'
import { EventBus } from '../server/events'
import { ResearchStore } from '../server/discussions'
import { ChangeEngine } from '../server/changes'
import { MemoryFiles } from '../server/memory-files'
import { captureAnswer } from '../server/explore'
import { richEditingIssue } from '../src/outline'
import type { RunDTO, CaptureDTO, ChangeSetSummary, DiscussionDTO, DraftDTO, SourceRefDTO } from '../shared/types'

let dir: string, store: NoteStore, app: ReturnType<typeof createApp>, requests: { messages: { role: string; content: string }[] }[], replies: string[]
const J = { host: 'localhost:3001', 'content-type': 'application/json' }
const note = '# 材料\n\n铝很轻，密度约 2.7。\n\n## 木\n\n木材的密度因树种而异。\n\n## 另一支\n\n只属于另一支的事实：钛很贵。\n'
const call = async <T>(method: string, url: string, body?: unknown, expected = 200): Promise<T> => {
  const response = await app.request(url, { method, headers: J, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const text = await response.text()
  expect(response.status, text).toBe(expected)
  return JSON.parse(text) as T
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cn-explore-'))
  store = new NoteStore(path.join(dir, 'notes'))
  await store.init()
  await store.create('Materials', note)
  const ai = new AISettings(path.join(dir, 'notes'), path.join(dir, 'private'), {})
  await ai.save({ model: 'test-model', baseUrl: 'https://models.example/v1', key: 'test-only-key' })
  requests = []; replies = ['铝的密度低，约为钢的三分之一。']
  app = createApp(store, new EventBus(), { aiSettings: ai, aiTransport: async (_, init) => {
    requests.push(JSON.parse(String(init!.body)))
    return new Response(JSON.stringify({ choices: [{ message: { content: replies.shift() ?? '默认回答' }, finish_reason: 'stop' }] }))
  } })
})
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

async function ask(quote: string, question: string, extra: { discussionId?: string; parentIds?: string[]; note?: string } = {}) {
  const source = await call<SourceRefDTO>('POST', '/api/sources', { note: extra.note ?? 'Materials.md', quote }, 201)
  const draft = await call<DraftDTO>('POST', '/api/drafts', { discussionId: extra.discussionId, parentIds: extra.parentIds, origin: extra.discussionId ? undefined : { kind: 'note', noteId: source.noteId, sourceId: source.id }, items: [{ id: 'q1', question, sourceIds: [source.id] }] }, 201)
  const sent = await call<{ discussion: DiscussionDTO; turns: { id: string }[] }>('POST', `/api/drafts/${draft.id}/send`, { items: [{ id: 'q1', question }] }, 201)
  const answer = await generate(sent.discussion.id, sent.turns[0]!.id)
  return { source, discussionId: sent.discussion.id, turnId: sent.turns[0]!.id, answer }
}

/** Starts a run and waits for the saved answer version. */
async function generate(discussionId: string, turnId: string, requestKey: string = crypto.randomUUID()): Promise<{ id: string; text: string }> {
  let run = await call<RunDTO>('POST', `/api/discussions/${discussionId}/turns/${turnId}/runs`, { requestKey }, 202)
  for (let attempt = 0; attempt < 200 && ['queued', 'running'].includes(run.status); attempt++) { await new Promise(resolve => setTimeout(resolve, 10)); run = await call<RunDTO>('GET', `/api/runs/${run.id}`) }
  expect(run.status, run.error).toBe('completed')
  return { id: run.answerId!, text: run.text }
}

describe('select → ask → answer → write back → trace', () => {
  it('sends only the selected material, then appends the answer verbatim with its basis and can undo it', async () => {
    const { discussionId, turnId, answer, source } = await ask('铝很轻，密度约 2.7。', '为什么铝轻？')
    const sent = JSON.stringify(requests[0])
    expect(sent).toContain('铝很轻，密度约 2.7。')
    expect(sent).toContain('为什么铝轻？')
    expect(sent).not.toContain('钛很贵')
    expect(answer.text).toBe('铝的密度低，约为钢的三分之一。')

    const input = { requestKey: 'save-1', discussionId, turnId, answerId: answer.id, target: { kind: 'append', note: 'Materials.md' } }
    const { capture, change } = await call<{ capture: CaptureDTO; change: ChangeSetSummary }>('POST', '/api/captures', input, 201)
    const written = (await store.load('Materials.md')).content
    expect(written.startsWith(note)).toBe(true)
    expect(written).toContain('### 探索：为什么铝轻？\n\n铝的密度低，约为钢的三分之一。')
    expect(written).toContain('> 依据：《Materials》 · 材料：“铝很轻，密度约 2.7。”')
    // Plain Markdown only: raw HTML would force the note out of the rich editor.
    expect(written).not.toContain('<!--')
    expect(richEditingIssue(written)).toBeNull()
    expect(capture).toMatchObject({ mode: 'verbatim', sourceIds: [source.id], answers: [{ text: answer.text }], target: { kind: 'append', notePath: 'Materials.md' } })
    expect(change).toMatchObject({ undoable: true, files: [{ name: 'Materials.md', kind: 'edit' }] })

    // The saved evidence resolves back to the original passage.
    expect(await call('GET', `/api/sources/${source.id}`)).toMatchObject({ status: 'moved' })
    expect((await call<CaptureDTO[]>('GET', '/api/captures?note=' + capture.target.noteId))[0]!.id).toBe(capture.id)

    await call('POST', `/api/ai/changes/${change.id}/undo`, {})
    expect((await store.load('Materials.md')).content).toBe(note)
    expect(await call('GET', `/api/sources/${source.id}`)).toMatchObject({ status: 'current' })
  })

  it('writes the answer once however many times the same save is requested', async () => {
    const { discussionId, turnId, answer } = await ask('铝很轻，密度约 2.7。', '为什么铝轻？')
    const input = { requestKey: 'save-1', discussionId, turnId, answerId: answer.id, target: { kind: 'append', note: 'Materials.md' } }
    const first = await call<{ capture: CaptureDTO }>('POST', '/api/captures', input, 201)
    const again = await call<{ capture: CaptureDTO }>('POST', '/api/captures', input, 201)
    expect(again.capture.id).toBe(first.capture.id)
    expect(((await store.load('Materials.md')).content.match(/### 探索/g) ?? [])).toHaveLength(1)
    expect(await call<CaptureDTO[]>('GET', '/api/captures')).toHaveLength(1)
  })

  it('finishes the record, without a second write, when the first attempt stopped after writing the note', async () => {
    const { discussionId, turnId, answer } = await ask('铝很轻，密度约 2.7。', '为什么铝轻？')
    const research = new ResearchStore(store), changes = new ChangeEngine(store, new MemoryFiles(store.paths.memory, store.writer), new EventBus())
    const input = { requestKey: 'save-crash', discussionId, turnId, answerId: answer.id, target: { kind: 'append' as const, note: 'Materials.md' } }
    const failing = vi.spyOn(research, 'recordCapture').mockRejectedValueOnce(new Error('disk full'))
    await expect(captureAnswer(store, research, changes, input)).rejects.toThrow('disk full')
    failing.mockRestore()
    const written = (await store.load('Materials.md')).content
    expect(written).toContain('### 探索')
    const result = await captureAnswer(store, research, changes, input)
    expect((await store.load('Materials.md')).content).toBe(written)
    expect(result.capture.target.afterVersion).toBe((await import('../server/store')).contentVersion(written))
    expect(await research.listCaptures()).toHaveLength(1)
  })

  it('appends to the note as it is now and refuses to touch a note that no longer exists', async () => {
    const { discussionId, turnId, answer } = await ask('铝很轻，密度约 2.7。', '为什么铝轻？')
    await store.saveContent('Materials.md', note + '\n用户刚补的一句话。\n', note)
    await call('POST', '/api/captures', { requestKey: 'k', discussionId, turnId, answerId: answer.id, target: { kind: 'append', note: 'Materials.md' } }, 201)
    const written = (await store.load('Materials.md')).content
    expect(written).toContain('用户刚补的一句话。')
    expect(written.indexOf('用户刚补的一句话。')).toBeLessThan(written.indexOf('### 探索'))
    const missing = await app.request('/api/captures', { method: 'POST', headers: J, body: JSON.stringify({ requestKey: 'k2', discussionId, turnId, answerId: answer.id, target: { kind: 'append', note: 'Gone.md' } }) })
    expect(missing.status).toBe(404)
    expect(await call<CaptureDTO[]>('GET', '/api/captures')).toHaveLength(1)
  })

  it('saves into a new note placed on the canvas, and undo removes exactly that note', async () => {
    const { discussionId, turnId, answer } = await ask('铝很轻，密度约 2.7。', '为什么铝轻？')
    const { capture, change } = await call<{ capture: CaptureDTO; change: ChangeSetSummary }>('POST', '/api/captures', { requestKey: 'new-1', discussionId, turnId, answerId: answer.id, target: { kind: 'new', folder: '' } }, 201)
    expect(capture.target).toMatchObject({ kind: 'new', beforeVersion: null, notePath: '为什么铝轻？.md' })
    const created = (await store.load('为什么铝轻？.md')).content
    expect(created).toContain('# 为什么铝轻？')
    expect(created).toContain('铝的密度低，约为钢的三分之一。')
    expect(created).toContain('> 依据：《Materials》')
    expect((await store.layout('')).positions['为什么铝轻？.md']).toBeDefined()
    await call('POST', `/api/ai/changes/${change.id}/undo`, {})
    expect(await store.names()).not.toContain('为什么铝轻？.md')
    expect(await store.names()).toContain('Materials.md')
  })
})

describe('a note\'s explorations', () => {
  it('lists its discussions, unsent drafts, captures and cited sources, and nothing from other notes', async () => {
    const a = await ask('铝很轻，密度约 2.7。', '铝怎么样？')
    await store.create('Other', '# 另一篇\n\n别的内容。\n')
    const other = await call<SourceRefDTO>('POST', '/api/sources', { note: 'Other.md', quote: '别的内容。' }, 201)
    await call('POST', '/api/drafts', { origin: { kind: 'note', noteId: other.noteId, sourceId: other.id }, items: [{ id: 'q', question: '别处的问题', sourceIds: [other.id] }] }, 201)
    const pending = await call<DraftDTO>('POST', '/api/drafts', { origin: { kind: 'note', noteId: a.source.noteId }, items: [{ id: 'p', question: '稍后再问', sourceIds: [a.source.id] }] }, 201)
    await call('POST', '/api/captures', { requestKey: 'k', discussionId: a.discussionId, turnId: a.turnId, answerId: a.answer.id, target: { kind: 'append', note: 'Materials.md' } }, 201)
    const view = await call<{ noteId: string; discussions: DiscussionDTO[]; drafts: DraftDTO[]; captures: CaptureDTO[]; sources: Record<string, SourceRefDTO> }>('GET', '/api/research/note?name=Materials.md')
    expect(view.noteId).toBe(a.source.noteId)
    expect(view.discussions.map(item => item.id)).toEqual([a.discussionId])
    expect(view.drafts.map(item => item.id)).toEqual([pending.id])
    expect(view.captures).toHaveLength(1)
    expect(Object.keys(view.sources)).toEqual([a.source.id])
  })
})

describe('branches and retries', () => {
  it('answers a follow-up from its own branch only, and a retry keeps the version a note already cites', async () => {
    const a = await ask('铝很轻，密度约 2.7。', '铝怎么样？')
    replies.push('木材更轻，但强度不稳定。')
    const sibling = await ask('木材的密度因树种而异。', '木材呢？')
    expect(sibling.discussionId).not.toBe(a.discussionId)
    replies.push('接着说铝的强度。')
    const follow = await ask('铝很轻，密度约 2.7。', '强度呢？', { discussionId: a.discussionId, parentIds: [a.turnId] })
    const request = JSON.stringify(requests.at(-1))
    expect(request).toContain('铝怎么样？')
    expect(request).toContain(a.answer.text)
    expect(request).not.toContain('木材呢？')
    expect(request).not.toContain('木材更轻')
    expect(requests.at(-1)!.messages.filter(message => message.content.includes('问题：铝怎么样？'))).toHaveLength(1)

    const saved = await call<{ capture: CaptureDTO }>('POST', '/api/captures', { requestKey: 's', discussionId: a.discussionId, turnId: a.turnId, answerId: a.answer.id, target: { kind: 'append', note: 'Materials.md' } }, 201)
    replies.push('重试后的新回答。')
    const retry = await generate(a.discussionId, a.turnId)
    expect(retry.id).not.toBe(a.answer.id)
    expect((await call<DiscussionDTO>('GET', `/api/discussions/${a.discussionId}`)).turns.find(turn => turn.id === a.turnId)!.answers).toHaveLength(2)
    expect((await call<CaptureDTO>('GET', `/api/captures/${saved.capture.id}`)).answers[0]!.text).toBe(a.answer.text)
    expect(follow.answer.text).toBe('接着说铝的强度。')
  })

  it('reports an unconfigured model without losing the question or creating an answer', async () => {
    const bare = createApp(store, new EventBus(), { aiSettings: new AISettings(path.join(dir, 'notes'), path.join(dir, 'private2'), {}) })
    const research = new ResearchStore(store)
    const draft = await research.createDraft({ items: [{ id: 'q1', question: '没有模型？' }] })
    const { discussion, turns } = await research.sendDraft(draft.id, [{ id: 'q1', question: '没有模型？' }])
    const response = await bare.request(`/api/discussions/${discussion.id}/turns/${turns[0]!.id}/runs`, { method: 'POST', headers: J, body: JSON.stringify({ requestKey: 'x' }) })
    expect(response.status).toBe(502)
    expect((await response.json()).error).toContain('尚未连接模型')
    expect((await research.getDiscussion(discussion.id)).turns[0]!.answers).toEqual([])
    expect((await research.getDiscussion(discussion.id)).turns[0]!.question).toBe('没有模型？')
  })
})

describe('standalone conversations', () => {
  /** A conversation that never touched a note. */
  async function chat(question: string) {
    const draft = await call<DraftDTO>('POST', '/api/drafts', { items: [{ id: 'q1', question, sourceIds: [] }] }, 201)
    const sent = await call<{ discussion: DiscussionDTO; turns: { id: string }[] }>('POST', `/api/drafts/${draft.id}/send`, { items: [{ id: 'q1', question }] }, 201)
    const answer = await generate(sent.discussion.id, sent.turns[0]!.id)
    return { discussionId: sent.discussion.id, turnId: sent.turns[0]!.id, answer }
  }

  it('lists conversations with where they started, and shows one with its captures and sources', async () => {
    const plain = await chat('什么是弹性模量？')
    const { discussionId: fromNote, source } = await ask('铝很轻，密度约 2.7。', '为什么铝轻？')
    const rows = await call<{ id: string; title: string; turnCount: number; lastQuestion: string; notePath: string | null }[]>('GET', '/api/discussions')
    expect(rows.map(row => row.id).sort()).toEqual([plain.discussionId, fromNote].sort())
    expect(rows.find(row => row.id === plain.discussionId)).toMatchObject({ turnCount: 1, lastQuestion: '什么是弹性模量？', notePath: null })
    expect(rows.find(row => row.id === fromNote)).toMatchObject({ notePath: 'Materials.md' })
    expect(rows.every(row => !('turns' in row))).toBe(true)

    const view = await call<{ discussion: DiscussionDTO; captures: CaptureDTO[]; sources: Record<string, SourceRefDTO>; runs: RunDTO[] }>('GET', `/api/discussions/${fromNote}/view`)
    expect(view.discussion.id).toBe(fromNote)
    expect(Object.keys(view.sources)).toEqual([source.id])
    expect(view.captures).toEqual([]); expect(view.runs).toEqual([])
    await call('GET', '/api/discussions/00000000000000000000000000000000/view', undefined, 404)
  })

  it('tells the model it has read no note, and keeps that after a follow-up', async () => {
    const first = await chat('什么是弹性模量？')
    const system = (requests[0]!.messages[0]!.content)
    expect(system).toContain('没有读取任何笔记'); expect(system).not.toContain('原文片段')
    const draft = await call<DraftDTO>('POST', '/api/drafts', { discussionId: first.discussionId, parentIds: [first.turnId], items: [{ id: 'q2', question: '单位是什么？', sourceIds: [] }] }, 201)
    const sent = await call<{ turns: { id: string }[] }>('POST', `/api/drafts/${draft.id}/send`, { items: [{ id: 'q2', question: '单位是什么？' }] }, 201)
    await generate(first.discussionId, sent.turns[0]!.id)
    expect(requests[1]!.messages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(requests[1]!.messages[0]!.content).toContain('没有读取任何笔记')
  })

  it('writes a plain conversation\'s answer into a chosen note and shows the capture in its view', async () => {
    const first = await chat('什么是弹性模量？')
    const result = await call<{ capture: CaptureDTO; change: ChangeSetSummary }>('POST', '/api/captures', { requestKey: crypto.randomUUID(), discussionId: first.discussionId, turnId: first.turnId, answerId: first.answer.id, target: { kind: 'append', note: 'Materials.md' } }, 201)
    expect(result.capture.sourceIds).toEqual([])
    expect((await store.load('Materials.md')).content).toContain(first.answer.text)
    const view = await call<{ captures: CaptureDTO[] }>('GET', `/api/discussions/${first.discussionId}/view`)
    expect(view.captures.map(capture => capture.id)).toEqual([result.capture.id])
  })

  it('archives a conversation out of the default list and restores it', async () => {
    const first = await chat('什么是弹性模量？')
    await call('PUT', `/api/discussions/${first.discussionId}/archived`, { archived: true })
    expect(await call<unknown[]>('GET', '/api/discussions?archived=false')).toHaveLength(0)
    expect(await call<unknown[]>('GET', '/api/discussions?archived=true')).toHaveLength(1)
    await call('PUT', `/api/discussions/${first.discussionId}/archived`, { archived: false })
    expect(await call<unknown[]>('GET', '/api/discussions?archived=false')).toHaveLength(1)
  })
})

describe('organized and replace write-back', () => {
  type Saved = { capture: CaptureDTO; change: ChangeSetSummary }
  type Preview = { kind: string; noteName: string; before: string | null; after: string; expectedVersion: string | null; content: string }
  const QUOTE = '铝很轻，密度约 2.7。'
  const save = (base: { discussionId: string; turnId: string; answer: { id: string } }, extra: Record<string, unknown>, expected = 201) =>
    call<Saved>('POST', '/api/captures', { requestKey: crypto.randomUUID(), discussionId: base.discussionId, turnId: base.turnId, answerId: base.answer.id, ...extra }, expected)
  const preview = (base: { discussionId: string; turnId: string; answer: { id: string } }, extra: Record<string, unknown>, expected = 200) =>
    call<Preview>('POST', '/api/captures/preview', { discussionId: base.discussionId, turnId: base.turnId, answerId: base.answer.id, ...extra }, expected)

  it('organizes without writing, then saves exactly the text the user confirmed and never asks the model again', async () => {
    const base = await ask(QUOTE, '为什么铝轻？')
    const asked = requests.length
    replies.push('铝轻，因为密度低（约 2.7）。')
    const { text } = await call<{ text: string }>('POST', '/api/captures/organize', { discussionId: base.discussionId, turnId: base.turnId, answerId: base.answer.id })
    expect(text).toBe('铝轻，因为密度低（约 2.7）。')
    expect(requests).toHaveLength(asked + 1)
    expect(JSON.stringify(requests.at(-1))).toContain(QUOTE)               // the answer is organized together with its basis
    expect((await store.load('Materials.md')).content).toBe(note)           // nothing written yet

    const target = { kind: 'append', note: 'Materials.md' }
    const shown = await preview(base, { mode: 'organized', text, target })
    expect(shown).toMatchObject({ kind: 'append', noteName: 'Materials.md', before: note, expectedVersion: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(shown.after).toContain('铝轻，因为密度低（约 2.7）。'); expect(shown.after).not.toContain(base.answer.text)
    expect((await store.load('Materials.md')).content).toBe(note)           // previewing writes nothing

    const edited = text + '（已编辑）'
    const { capture, change } = await save(base, { mode: 'organized', text: edited, target, expectedVersion: shown.expectedVersion })
    const written = (await store.load('Materials.md')).content
    expect(written).toContain(edited); expect(written).not.toContain(base.answer.text)
    expect(capture).toMatchObject({ mode: 'organized', writtenText: edited, answers: [{ answerId: base.answer.id, text: base.answer.text }] })
    expect(requests).toHaveLength(asked + 1)                                // saving never calls the model
    await call('POST', `/api/ai/changes/${change.id}/undo`, {})
    expect((await store.load('Materials.md')).content).toBe(note)
  })

  it('verbatim never calls the model and refuses text it did not copy; organized needs confirmed text', async () => {
    const base = await ask(QUOTE, '为什么铝轻？')
    const asked = requests.length
    const target = { kind: 'append', note: 'Materials.md' }
    await save(base, { mode: 'verbatim', target, text: '改写过的' }, 400)
    await save(base, { mode: 'organized', target }, 400)
    await save(base, { mode: 'organized', target, text: '   ' }, 400)
    const { capture } = await save(base, { target })
    expect(capture.mode).toBe('verbatim'); expect(capture.writtenText).toBeUndefined()
    expect(requests).toHaveLength(asked)
    expect((await store.load('Materials.md')).content).toContain(base.answer.text)
  })

  it('saves organized text as a new note with its basis', async () => {
    const base = await ask(QUOTE, '为什么铝轻？')
    const { capture } = await save(base, { mode: 'organized', text: '整理后的结论。', target: { kind: 'new', folder: '' } })
    const created = (await store.load(capture.target.notePath)).content
    expect(created).toContain('整理后的结论。'); expect(created).toContain('> 依据：'); expect(created).not.toContain(base.answer.text)
    expect(capture).toMatchObject({ mode: 'organized', target: { kind: 'new', beforeVersion: null } })
  })

  it('replaces exactly the cited passage, once, and undo puts the passage back', async () => {
    const base = await ask(QUOTE, '为什么铝轻？')
    const input = { requestKey: 'replace-1', mode: 'verbatim', target: { kind: 'replace', sourceId: base.source.id } }
    const shown = await preview(base, input)
    expect(shown).toMatchObject({ kind: 'replace', noteName: 'Materials.md', before: note })
    expect(shown.after).toBe(note.replace(QUOTE, base.answer.text))
    const first = await save(base, input)
    expect((await store.load('Materials.md')).content).toBe(note.replace(QUOTE, base.answer.text))
    expect(first.capture).toMatchObject({ mode: 'verbatim', target: { kind: 'replace', notePath: 'Materials.md' }, sourceIds: [base.source.id] })
    await save(base, input)                                              // same request key
    expect((await store.load('Materials.md')).content).toBe(note.replace(QUOTE, base.answer.text))
    await call('POST', `/api/ai/changes/${first.change.id}/undo`, {})
    expect((await store.load('Materials.md')).content).toBe(note)
  })

  it('follows the passage after the note moved on, and refuses a missing, repeated or foreign one without writing', async () => {
    const base = await ask(QUOTE, '为什么铝轻？')
    const replace = { mode: 'verbatim', target: { kind: 'replace', sourceId: base.source.id } }
    // The passage moved: found by its unique text, replaced there.
    const moved = '# 前言\n\n一段新内容。\n\n' + note
    await store.saveContent('Materials.md', moved, note)
    expect((await preview(base, replace)).after).toBe(moved.replace(QUOTE, base.answer.text))
    // Repeated with identical surroundings: the position would be a guess, so nothing is replaced.
    const block = '背景'.repeat(70) + '关键句。\n'
    await store.create('Twice', block)
    const dup = await ask('关键句。', '这句什么意思？', { note: 'Twice.md' })
    await store.saveContent('Twice.md', block + block, block)
    const ambiguous = { mode: 'verbatim', target: { kind: 'replace', sourceId: dup.source.id } }
    expect((await preview(dup, ambiguous, 409) as unknown as { error: string }).error).toContain('多次')
    await save(dup, ambiguous, 409)
    expect((await store.load('Twice.md')).content).toBe(block + block)
    const twice = moved
    // Missing.
    await store.saveContent('Materials.md', '# 空\n', moved)
    expect((await preview(base, replace, 409) as unknown as { error: string }).error).toContain('找不到')
    // A source the question never cited.
    const other = await call<SourceRefDTO>('POST', '/api/sources', { note: 'Materials.md', quote: '空' }, 201)
    await save(base, { mode: 'verbatim', target: { kind: 'replace', sourceId: other.id } }, 400)
    expect(await call<CaptureDTO[]>('GET', '/api/captures')).toHaveLength(0)
  })

  it('refuses to save over a note that changed after the preview, for append and for replace', async () => {
    const base = await ask(QUOTE, '为什么铝轻？')
    for (const target of [{ kind: 'append', note: 'Materials.md' }, { kind: 'replace', sourceId: base.source.id }]) {
      const current = (await store.load('Materials.md')).content
      const shown = await preview(base, { mode: 'verbatim', target })
      const edited = current + '\n预览之后别处加的一行。\n'
      await store.saveContent('Materials.md', edited, current)
      await save(base, { mode: 'verbatim', target, expectedVersion: shown.expectedVersion }, 409)
      expect((await store.load('Materials.md')).content).toBe(edited)
      await store.saveContent('Materials.md', current, edited)
    }
    expect(await call<CaptureDTO[]>('GET', '/api/captures')).toHaveLength(0)
  })

  it('organizes several compared answers together, writes them as one capture citing every answer and source, and refuses the combinations that make no sense', async () => {
    const first = await ask('铝很轻，密度约 2.7。', '为什么铝轻？')
    replies.push('钛合金更强但更贵。')
    const second = await ask('只属于另一支的事实：钛很贵。', '钛怎么样？', { discussionId: first.discussionId, parentIds: [] })
    const refs = [first, second].map(item => ({ discussionId: item.discussionId, turnId: item.turnId, answerId: item.answer.id }))
    const asked = requests.length
    replies.push('共识：都与材料有关。分歧：钛更贵。')
    const { text } = await call<{ text: string }>('POST', '/api/captures/organize', { answers: refs })
    expect(requests).toHaveLength(asked + 1)
    const prompt = JSON.stringify(requests.at(-1))
    expect(prompt).toContain('共识'); expect(prompt).toContain('分歧'); expect(prompt).toContain('成立条件'); expect(prompt).toContain('待验证')
    expect(prompt).toContain('分支 1'); expect(prompt).toContain('分支 2')
    expect(prompt).toContain('铝很轻，密度约 2.7。'); expect(prompt).toContain('钛很贵')   // both bases are given
    expect((await store.load('Materials.md')).content).toBe(note)

    const target = { kind: 'append', note: 'Materials.md' }
    const shown = await call<Preview>('POST', '/api/captures/preview', { answers: refs, mode: 'organized', text, target })
    expect(shown.after).toContain('### 比较：为什么铝轻？ 等 2 条回答'); expect(shown.after).toContain(text)
    const { capture, change } = await call<Saved>('POST', '/api/captures', { requestKey: 'many-1', answers: refs, mode: 'organized', text, target, expectedVersion: shown.expectedVersion }, 201)
    expect(capture).toMatchObject({ mode: 'organized', writtenText: text })
    expect(capture.answers.map(item => item.answerId)).toEqual(refs.map(item => item.answerId))
    expect(capture.sourceIds.sort()).toEqual([first.source.id, second.source.id].sort())
    expect(requests).toHaveLength(asked + 1)                                   // saving never calls the model
    const written = (await store.load('Materials.md')).content
    expect(written).toContain(text); expect(written).not.toContain(first.answer.text)
    expect((written.match(/> 依据：/g) ?? [])).toHaveLength(2)
    await call('POST', `/api/ai/changes/${change.id}/undo`, {})
    expect((await store.load('Materials.md')).content).toBe(note)

    // Verbatim of several, replacing with several, a repeated answer, and too many are all refused.
    await call('POST', '/api/captures', { requestKey: 'many-2', answers: refs, target }, 400)
    await call('POST', '/api/captures', { requestKey: 'many-3', answers: refs, mode: 'organized', text, target: { kind: 'replace', sourceId: first.source.id } }, 400)
    await call('POST', '/api/captures/organize', { answers: [refs[0], refs[0]] }, 400)
    await call('POST', '/api/captures/organize', { answers: Array.from({ length: 9 }, (_, index) => ({ ...refs[0]!, answerId: 'a'.repeat(31) + index })) }, 400)
    expect(await call<CaptureDTO[]>('GET', '/api/captures')).toHaveLength(1)
  })

  /** Two answered sibling turns in one discussion, ready to be written together. */
  async function compared() {
    const first = await ask('铝很轻，密度约 2.7。', '为什么铝轻？')
    replies.push('钛合金更强但更贵。')
    const second = await ask('只属于另一支的事实：钛很贵。', '钛怎么样？', { discussionId: first.discussionId, parentIds: [] })
    const refs = [first, second].map(item => ({ discussionId: item.discussionId, turnId: item.turnId, answerId: item.answer.id }))
    return { first, second, refs, text: '共识：都与材料有关。分歧：钛更贵。（需人工审阅）', target: { kind: 'append', note: 'Materials.md' } }
  }

  it('writes several compared answers once however many times the same save is submitted', async () => {
    const { refs, text, target } = await compared()
    const input = { requestKey: 'many-once', answers: refs, mode: 'organized', text, target }
    const first = await call<Saved>('POST', '/api/captures', input, 201)
    const again = await call<Saved>('POST', '/api/captures', input, 201)
    const third = await call<Saved>('POST', '/api/captures', input, 201)
    expect(again.capture.id).toBe(first.capture.id); expect(third.change.id).toBe(first.change.id)
    const written = (await store.load('Materials.md')).content
    expect((written.match(/### 比较：/g) ?? [])).toHaveLength(1)
    expect((written.match(/共识：都与材料有关/g) ?? [])).toHaveLength(1)
    expect(await call<CaptureDTO[]>('GET', '/api/captures')).toHaveLength(1)
    // The same key again, even with different text, returns the first result and writes nothing more.
    expect((await call<Saved>('POST', '/api/captures', { ...input, text: '另一段整理文字' }, 201)).capture.id).toBe(first.capture.id)
    expect((await store.load('Materials.md')).content).toBe(written)
  })

  it('refuses to write several compared answers over a note that changed after the preview, writing nothing and recording nothing', async () => {
    const { refs, text, target } = await compared()
    const shown = await call<Preview>('POST', '/api/captures/preview', { answers: refs, mode: 'organized', text, target })
    const edited = note + '\n预览之后别处加的一行。\n'
    await store.saveContent('Materials.md', edited, note)
    const refused = await call<{ error: string }>('POST', '/api/captures', { requestKey: 'many-stale', answers: refs, mode: 'organized', text, target, expectedVersion: shown.expectedVersion }, 409)
    expect(refused.error).toContain('预览之后被修改')
    expect((await store.load('Materials.md')).content).toBe(edited)
    expect(await call<CaptureDTO[]>('GET', '/api/captures')).toHaveLength(0)
    // Re-previewing against the current note then succeeds.
    const fresh = await call<Preview>('POST', '/api/captures/preview', { answers: refs, mode: 'organized', text, target })
    const { capture } = await call<Saved>('POST', '/api/captures', { requestKey: 'many-fresh', answers: refs, mode: 'organized', text, target, expectedVersion: fresh.expectedVersion }, 201)
    expect(capture.mode).toBe('organized')
    expect((await store.load('Materials.md')).content).toContain('预览之后别处加的一行。')
  })

  it('refuses to organize an answer too long to send, and reports an unconfigured model', async () => {
    const base = await ask(QUOTE, '为什么铝轻？')
    const research = new ResearchStore(store)
    const long = await research.addAnswer(base.discussionId, base.turnId, { text: '很长的回答。'.repeat(8000), runId: 'long' })
    const asked = requests.length
    const refused = await call<{ error: string }>('POST', '/api/captures/organize', { discussionId: base.discussionId, turnId: base.turnId, answerId: long.id }, 400)
    expect(refused.error).toContain('超过整理的上限'); expect(requests).toHaveLength(asked)
    const bare = createApp(store, new EventBus(), { aiSettings: new AISettings(path.join(dir, 'notes'), path.join(dir, 'empty'), {}) })
    const response = await bare.request('/api/captures/organize', { method: 'POST', headers: J, body: JSON.stringify({ discussionId: base.discussionId, turnId: base.turnId, answerId: base.answer.id }) })
    expect(response.status).toBe(502)
  })
})
