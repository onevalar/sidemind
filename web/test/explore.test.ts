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

async function ask(quote: string, question: string, extra: { discussionId?: string; parentIds?: string[] } = {}) {
  const source = await call<SourceRefDTO>('POST', '/api/sources', { note: 'Materials.md', quote }, 201)
  const draft = await call<DraftDTO>('POST', '/api/drafts', { ...extra, origin: extra.discussionId ? undefined : { kind: 'note', noteId: source.noteId, sourceId: source.id }, items: [{ id: 'q1', question, sourceIds: [source.id] }] }, 201)
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
