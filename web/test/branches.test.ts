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
const J = { host: 'localhost:3001', 'content-type': 'application/json' }
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cn-branches-'))
  store = new NoteStore(path.join(dir, 'notes'))
  await store.init()
  research = new ResearchStore(store)
})
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

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
    const app = createApp(store, new EventBus(), { aiSettings: ai, aiTransport: async (_, init) => {
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
