import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AISettings } from '../server/ai-settings'
import { createApp } from '../server/app'
import { NoteStore } from '../server/store'
import { EventBus } from '../server/events'
import { ResearchStore, ancestry } from '../server/discussions'
import { contextFor, estimateTokens } from '../server/explore'
import type { ContextPreviewDTO, DiscussionDTO, RunDTO, TurnDTO } from '../shared/types'

let dir: string, store: NoteStore, research: ResearchStore
const tasks = new Set<Promise<unknown>>()
const J = { host: 'localhost:3001', 'content-type': 'application/json' }
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cn-branches-'))
  store = new NoteStore(path.join(dir, 'notes'))
  await store.init()
  research = new ResearchStore(store)
})
afterEach(async () => { await Promise.allSettled([...tasks]); await fs.rm(dir, { recursive: true, force: true }) })

/** R → A (only knows aluminium) and R → B (only knows wood). */
async function tree() {
  const discussion = await research.createDiscussion({ title: '材料' })
  const turn = async (key: string, question: string, parents: string[], answer?: string) => {
    const created = await research.addTurn(discussion.id, { question, parents, requestKey: key })
    if (answer) await research.addAnswer(discussion.id, created.id, { text: answer, runId: key })
    return created
  }
  const root = await turn('r', '根问题：材料有哪些？', [], '根回答：金属与木材。')
  const a = await turn('a', 'A：铝呢？', [root.id], 'A 回答：铝的独有事实是轻。')
  const b = await turn('b', 'B：木呢？', [root.id], 'B 回答：木的独有事实是可燃。')
  return { discussionId: discussion.id, root, a, b }
}
const load = (id: string) => research.getDiscussion(id)
const texts = (context: ContextPreviewDTO) => context.messages.map(message => message.content).join('\n---\n')

describe('what each question sees', () => {
  it('continuing from B never contains A, and a merge contains the shared root once, parents before children', async () => {
    const { discussionId, root, a, b } = await tree()
    const onlyB = await research.addTurn(discussionId, { question: '只续 B', parents: [b.id], requestKey: 'only-b' })
    const forB = await contextFor(research, await load(discussionId), onlyB)
    expect(texts(forB)).toContain('B 回答')
    expect(texts(forB)).not.toContain('铝')
    expect(forB.turns.map(item => item.id)).toEqual([root.id, b.id, onlyB.id])

    const merged = await research.addTurn(discussionId, { question: '比较 A 和 B', parents: [a.id, b.id], requestKey: 'merge' })
    const forMerge = await contextFor(research, await load(discussionId), merged)
    expect(forMerge.turns.map(item => item.id)).toEqual([root.id, a.id, b.id, merged.id])
    expect(texts(forMerge).match(/根问题/g)).toHaveLength(1)
    expect(texts(forMerge).match(/根回答/g)).toHaveLength(1)
    expect(forMerge.messages[0]!.content).toContain('共识')
    expect(forMerge.messages[0]!.content).toContain('不要把它们混成一个观点')
    expect(forB.messages[0]!.content).not.toContain('共识')
  })

  it('orders parents first even when the file stores a child before its parent', async () => {
    const { discussionId, a, b, root } = await tree()
    const merged = await research.addTurn(discussionId, { question: '比较', parents: [b.id, a.id], requestKey: 'merge' })
    const file = path.join(store.paths.local, 'discussions', discussionId + '.json')
    const saved = JSON.parse(await fs.readFile(file, 'utf8')) as { turns: TurnDTO[] }
    saved.turns.reverse()
    await fs.writeFile(file, JSON.stringify(saved))
    const discussion = await load(discussionId)
    expect(discussion.turns[0]!.id).toBe(merged.id)
    expect(ancestry(discussion.turns, [merged.id]).map(item => item.id)).toEqual([root.id, b.id, a.id, merged.id])
    expect((await contextFor(research, discussion, merged)).turns.map(item => item.id)).toEqual([root.id, b.id, a.id, merged.id])
  })

  it('keeps a question tied to the answer versions that existed when it was asked', async () => {
    const { discussionId, a } = await tree()
    const child = await research.addTurn(discussionId, { question: '追问 A', parents: [a.id], requestKey: 'child' })
    await research.addAnswer(discussionId, a.id, { text: 'A 重试后的新回答', runId: 'a-retry' })
    const context = await contextFor(research, await load(discussionId), child)
    expect(texts(context)).toContain('A 回答：铝的独有事实是轻')
    expect(texts(context)).not.toContain('重试后')
    const later = await research.addTurn(discussionId, { question: '再追问 A', parents: [a.id], requestKey: 'later' })
    expect(texts(await contextFor(research, await load(discussionId), later))).toContain('重试后')
    expect((await load(discussionId)).turns.find(turn => turn.id === a.id)!.answers).toHaveLength(2)
  })

  it('sources of every ancestor are sent once, and only the selected passages are included', async () => {
    await store.create('N', '# 材料\n\n铝很轻。\n\n木很重。\n\n无关内容绝不外发。\n')
    const one = await research.createSource({ note: 'N.md', quote: '铝很轻。' })
    const two = await research.createSource({ note: 'N.md', quote: '木很重。' })
    const discussion = await research.createDiscussion({ title: 's' })
    const a = await research.addTurn(discussion.id, { question: '铝？', sourceIds: [one.id], requestKey: 'a' })
    const b = await research.addTurn(discussion.id, { question: '木？', sourceIds: [two.id], requestKey: 'b' })
    await research.addAnswer(discussion.id, a.id, { text: '铝回答', runId: 'a' }); await research.addAnswer(discussion.id, b.id, { text: '木回答', runId: 'b' })
    const merged = await research.addTurn(discussion.id, { question: '比较', parents: [a.id, b.id], requestKey: 'm' })
    const all = texts(await contextFor(research, await load(discussion.id), merged))
    expect(all.match(/铝很轻。/g)).toHaveLength(1)
    expect(all.match(/木很重。/g)).toHaveLength(1)
    expect(all).not.toContain('无关内容')
  })
})

describe('budget', () => {
  it('estimates CJK and other text differently and says it is an estimate', () => {
    expect(estimateTokens('你好世界')).toBe(4)
    expect(estimateTokens('abcdef')).toBe(2)
    expect(estimateTokens('')).toBe(0)
  })

  it('previews the exact request, and a start over budget is refused with the reason and creates no run', async () => {
    const ai = new AISettings(path.join(dir, 'notes'), path.join(dir, 'private'), {})
    await ai.save({ model: 'm', baseUrl: 'https://models.example/v1', key: 'k' })
    const sent: { messages: { role: string; content: string }[] }[] = []
    const app = createApp(store, new EventBus(), { aiSettings: ai, tasks, aiTransport: async (_, init) => {
      sent.push(JSON.parse(String(init!.body)))
      return new Response(JSON.stringify({ choices: [{ message: { content: '好' }, finish_reason: 'stop' }] }))
    } })
    const call = async <T>(method: string, url: string, body?: unknown, expected = 200): Promise<T> => {
      const response = await app.request(url, { method, headers: J, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      const text = await response.text()
      expect(response.status, text).toBe(expected)
      return JSON.parse(text) as T
    }
    const { discussionId, a, b } = await tree()
    const merged = await research.addTurn(discussionId, { question: '比较 A 和 B', parents: [a.id, b.id], requestKey: 'merge' })
    const preview = await call<ContextPreviewDTO>('GET', `/api/discussions/${discussionId}/turns/${merged.id}/context`)
    expect(preview).toMatchObject({ exceeded: false })
    expect(preview.estimatedTokens).toBeGreaterThan(0)
    let run = await call<RunDTO>('POST', `/api/discussions/${discussionId}/turns/${merged.id}/runs`, { requestKey: 'go' }, 202)
    for (let i = 0; i < 200 && ['queued', 'running'].includes(run.status); i++) { await new Promise(resolve => setTimeout(resolve, 10)); run = await call<RunDTO>('GET', `/api/runs/${run.id}`) }
    expect(run.status).toBe('completed')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.messages).toEqual(preview.messages)

    await research.addAnswer(discussionId, merged.id, { text: '长'.repeat(30000), runId: 'long' })
    const big = await research.addTurn(discussionId, { question: '继续', parents: [merged.id], requestKey: 'big' })
    const over = await call<ContextPreviewDTO>('GET', `/api/discussions/${discussionId}/turns/${big.id}/context`)
    expect(over.exceeded).toBe(true)
    const refused = await app.request(`/api/discussions/${discussionId}/turns/${big.id}/runs`, { method: 'POST', headers: J, body: JSON.stringify({ requestKey: 'too-big' }) })
    expect(refused.status).toBe(400)
    expect((await refused.json()).error).toContain('超过上限')
    expect(sent).toHaveLength(1)
    await expect(fs.readdir(path.join(store.paths.local, 'runs'))).resolves.toHaveLength(1)
  })
})

describe('summaries when the context does not fit', () => {
  const LONG = '甲'.repeat(15000)
  /** root (very long answer) → mid → leaf (very long answer, the branch picked directly), then a question on leaf. */
  async function longChain() {
    const discussion = await research.createDiscussion({ title: '长对话' })
    const root = await research.addTurn(discussion.id, { question: '起点', requestKey: 'r' })
    await research.addAnswer(discussion.id, root.id, { text: '起点回答。' + LONG, runId: 'r' })
    const leaf = await research.addTurn(discussion.id, { question: '中间', parents: [root.id], requestKey: 'l' })
    await research.addAnswer(discussion.id, leaf.id, { text: '中间回答。' + '乙'.repeat(15000), runId: 'l' })
    const next = await research.addTurn(discussion.id, { question: '继续', parents: [leaf.id], requestKey: 'n' })
    return { discussion, root, leaf, next }
  }
  const appWith = (reply: () => string) => {
    const sent: { messages: { role: string; content: string }[] }[] = []
    return { sent, build: async () => {
      const ai = new AISettings(path.join(dir, 'notes'), path.join(dir, 'private'), {})
      await ai.save({ model: 'm', baseUrl: 'https://models.example/v1', key: 'k' })
      const app = createApp(store, new EventBus(), { aiSettings: ai, tasks, aiTransport: async (_, init) => { sent.push(JSON.parse(String(init!.body))); return new Response(JSON.stringify({ choices: [{ message: { content: reply() }, finish_reason: 'stop' }] })) } })
      const call = async <T>(method: string, url: string, body?: unknown, expected = 200): Promise<T> => {
        const response = await app.request(url, { method, headers: J, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
        const text = await response.text()
        expect(response.status, text).toBe(expected)
        return JSON.parse(text) as T
      }
      return { app, call }
    } }
  }

  it('is over budget without summaries, and offers only the earlier answer — never the branch picked directly', async () => {
    const { discussion, root, leaf, next } = await longChain()
    const context = await contextFor(research, await load(discussion.id), next)
    expect(context.exceeded).toBe(true)
    expect(context.summarizable).toEqual([{ turnId: root.id, answerId: (await load(discussion.id)).turns.find(turn => turn.id === root.id)!.answers[0]!.id }])
    expect(context.summarizable.some(item => item.turnId === leaf.id)).toBe(false)
    expect(context.turns.every(turn => turn.mode === 'raw')).toBe(true)
  })

  it('generates the summary on request, then sends the earlier answer as a summary and the picked branch in full, and says so', async () => {
    const { discussion, root, next } = await longChain()
    const { sent, build } = appWith(() => '摘要：起点说了甲。')
    const { call } = await build()
    const after = await call<ContextPreviewDTO>('POST', `/api/discussions/${discussion.id}/turns/${next.id}/context/summaries`, {})
    expect(sent).toHaveLength(1)                                           // one model call, for the one earlier answer
    expect(after.exceeded).toBe(false); expect(after.summarizable).toEqual([])
    expect(after.turns.map(turn => [turn.id === root.id ? 'root' : 'other', turn.mode])).toEqual([['root', 'summary'], ['other', 'raw'], ['other', 'raw']])
    const all = texts(after)
    expect(all).toContain('以下是较早回答的摘要，不是原文'); expect(all).toContain('摘要：起点说了甲。')
    expect(all).not.toContain('甲'.repeat(100))                              // the long original is not sent
    expect(all).toContain('乙'.repeat(15000))                                // the direct parent is verbatim

    // The request that follows is exactly the previewed one, and its answer records that a summary stood in.
    let run = await call<RunDTO>('POST', `/api/discussions/${discussion.id}/turns/${next.id}/runs`, { requestKey: 'go' }, 202)
    for (let i = 0; i < 200 && ['queued', 'running'].includes(run.status); i++) { await new Promise(resolve => setTimeout(resolve, 10)); run = await call<RunDTO>('GET', `/api/runs/${run.id}`) }
    expect(run.status).toBe('completed')
    expect(sent.at(-1)!.messages).toEqual(after.messages)
    expect((await load(discussion.id)).turns.find(turn => turn.id === next.id)!.answers[0]!.summarizedTurns).toEqual([root.id])
  })

  it('keeps quoted passages verbatim, even in an answer that is replaced by its summary', async () => {
    await store.create('Notes', '# 笔记\n\n这是一句必须原样保留的引文。\n')
    const source = await research.createSource({ note: 'Notes.md', quote: '这是一句必须原样保留的引文。' })
    const discussion = await research.createDiscussion({ title: '带引用' })
    const root = await research.addTurn(discussion.id, { question: '起点', sourceIds: [source.id], requestKey: 'r' })
    const rootAnswer = await research.addAnswer(discussion.id, root.id, { text: LONG, runId: 'r' })
    const leaf = await research.addTurn(discussion.id, { question: '中间', parents: [root.id], requestKey: 'l' })
    await research.addAnswer(discussion.id, leaf.id, { text: '乙'.repeat(15000), runId: 'l' })
    const next = await research.addTurn(discussion.id, { question: '继续', parents: [leaf.id], requestKey: 'n' })
    await research.setSummary(rootAnswer.id, { text: '简短摘要', model: 'm' })
    const context = await contextFor(research, await load(discussion.id), next)
    expect(context.turns[0]!.mode).toBe('summary')
    expect(texts(context)).toContain('这是一句必须原样保留的引文。')
  })

  it('does not use a summary that is not needed, or one that is not shorter, and keeps the first summary of an answer', async () => {
    const { discussion, root, next } = await tree().then(base => ({ discussion: { id: base.discussionId }, root: base.root, next: base.a }))
    const rootAnswer = (await load(discussion.id)).turns.find(turn => turn.id === root.id)!.answers[0]!
    await research.setSummary(rootAnswer.id, { text: '摘', model: 'm' })
    // Fits already: the full answer is sent although a summary exists.
    const small = await research.addTurn(discussion.id, { question: '续', parents: [next.id], requestKey: 'small' })
    const fits = await contextFor(research, await load(discussion.id), small)
    expect(fits.turns.every(turn => turn.mode === 'raw')).toBe(true); expect(texts(fits)).toContain('根回答：金属与木材。')
    // First one wins.
    expect(await research.setSummary(rootAnswer.id, { text: '另一个摘要', model: 'm' })).toBe('摘')
    expect(await research.getSummary(rootAnswer.id)).toBe('摘')
    // A "summary" longer than the answer is never swapped in, however large the context.
    const long = await longChain()
    const longAnswer = (await load(long.discussion.id)).turns.find(turn => turn.id === long.root.id)!.answers[0]!
    await research.setSummary(longAnswer.id, { text: longAnswer.text + '多余', model: 'm' })
    expect((await contextFor(research, await load(long.discussion.id), long.next)).exceeded).toBe(true)
  })

  it('reports an unconfigured model for summaries and leaves the discussion untouched', async () => {
    const { discussion, next } = await longChain()
    const app = createApp(store, new EventBus(), { aiSettings: new AISettings(path.join(dir, 'notes'), path.join(dir, 'empty'), {}) })
    const response = await app.request(`/api/discussions/${discussion.id}/turns/${next.id}/context/summaries`, { method: 'POST', headers: J, body: '{}' })
    expect(response.status).toBe(502)
    expect((await contextFor(research, await load(discussion.id), next)).exceeded).toBe(true)
  })
})
