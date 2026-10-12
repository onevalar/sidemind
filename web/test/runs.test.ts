import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AISettings } from '../server/ai-settings'
import { createApp } from '../server/app'
import { NoteStore } from '../server/store'
import { EventBus } from '../server/events'
import { ResearchStore } from '../server/discussions'
import type { RunDTO } from '../shared/types'

const J = { host: 'localhost:3001', 'content-type': 'application/json' }
const note = '# 材料\n\n铝很轻，密度约 2.7。\n'
let dir: string, store: NoteStore, ai: AISettings, research: ResearchStore, shutdown: AbortController
/** A model whose output the test releases piece by piece. */
let gate: ReturnType<typeof makeGate>
let transports = 0
const running = new Set<Promise<unknown>>()

function makeGate() {
  const encoder = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>, begin!: () => void
  const started = new Promise<void>(resolve => { begin = resolve })
  const chunk = (value: unknown) => encoder.encode('data: ' + JSON.stringify(value) + '\n\n')
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; begin() } })
  return {
    body, started,
    send: (text: string) => controller.enqueue(chunk({ choices: [{ delta: { content: text }, finish_reason: null }] })),
    finish: () => { controller.enqueue(chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] })); controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close() },
    fail: () => controller.error(new Error('connection reset')),
  }
}

function build(options: { fresh?: boolean } = {}) {
  shutdown = new AbortController()
  gate = undefined as unknown as typeof gate
  const tasks = running
  const app = createApp(store, new EventBus(), { aiSettings: ai, shutdown: shutdown.signal, tasks, aiTransport: async (_, init) => {
    transports++
    const current = makeGate()
    gate = current
    init!.signal?.addEventListener('abort', () => { try { current.fail() } catch { /* already closed */ } }, { once: true })
    return new Response(current.body, { headers: { 'content-type': 'text/event-stream' } })
  } })
  return { app, tasks }
}

const call = async <T>(app: ReturnType<typeof createApp>, method: string, url: string, body?: unknown, expected = 200): Promise<T> => {
  const response = await app.request(url, { method, headers: J, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const text = await response.text()
  expect(response.status, text).toBe(expected)
  return JSON.parse(text) as T
}
const ready = async () => { await until(() => !!gate); await gate.started }
const until = async (check: () => Promise<boolean> | boolean) => { for (let i = 0; i < 300; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)) } throw new Error('timed out') }

async function turn() {
  await store.create('Materials', note)
  const source = await research.createSource({ note: 'Materials.md', quote: '铝很轻，密度约 2.7。' })
  const draft = await research.createDraft({ items: [{ id: 'q', question: '为什么轻？', sourceIds: [source.id] }] })
  const sent = await research.sendDraft(draft.id, [{ id: 'q', question: '为什么轻？' }])
  return { discussionId: sent.discussion.id, turnId: sent.turns[0]!.id }
}

/** Reads SSE frames until the predicate says stop, then cancels like a closing tab. */
async function listen(app: ReturnType<typeof createApp>, id: string, stop: (frames: { event: string; data: any }[]) => boolean) {
  const response = await app.request(`/api/runs/${id}/events`, { headers: { host: 'localhost:3001' } })
  expect(response.status).toBe(200)
  const reader = response.body!.getReader(), decoder = new TextDecoder(), frames: { event: string; data: any }[] = []
  let buffer = ''
  while (!stop(frames)) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
      const raw = buffer.slice(0, end); buffer = buffer.slice(end + 2)
      const event = /^event: (.*)$/m.exec(raw)?.[1] ?? 'message', data = /^data: (.*)$/m.exec(raw)?.[1]
      if (event !== 'ping' && data) frames.push({ event, data: JSON.parse(data) })
    }
  }
  await reader.cancel()
  return frames
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cn-runs-'))
  store = new NoteStore(path.join(dir, 'notes'))
  await store.init()
  ai = new AISettings(path.join(dir, 'notes'), path.join(dir, 'private'), {})
  await ai.save({ model: 'test-model', baseUrl: 'https://models.example/v1', key: 'test-only-key' })
  research = new ResearchStore(store)
  transports = 0
})
afterEach(async () => { await Promise.allSettled([...running]); await fs.rm(dir, { recursive: true, force: true }) })

describe('persistent answer runs', () => {
  it('accepts a run once, streams its progress, and saves the answer when it completes', async () => {
    const { app } = build()
    const ids = await turn()
    const run = await call<RunDTO>(app, 'POST', `/api/discussions/${ids.discussionId}/turns/${ids.turnId}/runs`, { requestKey: 'r1' }, 202)
    expect(['queued', 'running']).toContain(run.status)
    expect(run.text).toBe('')
    expect(JSON.parse(await fs.readFile(path.join(store.paths.local, 'runs', run.id + '.json'), 'utf8'))).toMatchObject({ id: run.id })
    await ready()
    const again = await call<RunDTO>(app, 'POST', `/api/discussions/${ids.discussionId}/turns/${ids.turnId}/runs`, { requestKey: 'r1' }, 202)
    expect(again.id).toBe(run.id)
    expect(transports).toBe(1)
    const events = listen(app, run.id, frames => frames.some(frame => frame.event === 'status' && frame.data.run.status === 'completed'))
    await until(async () => (await call<RunDTO>(app, 'GET', `/api/runs/${run.id}`)).status === 'running')
    gate.send('第一段，'); gate.send('第二段。'); gate.finish()
    const frames = await events
    expect(frames[0]!.event).toBe('snapshot')
    const text = frames.filter(frame => frame.event === 'delta').map(frame => frame.data.text).join('')
    expect((frames[0]!.data.text as string) + text).toBe('第一段，第二段。')
    const done = await call<RunDTO>(app, 'GET', `/api/runs/${run.id}`)
    expect(done).toMatchObject({ status: 'completed', text: '第一段，第二段。' })
    const saved = (await research.getDiscussion(ids.discussionId)).turns[0]!.answers
    expect(saved).toMatchObject([{ id: done.answerId, text: '第一段，第二段。', runId: run.id }])
  })

  it('keeps running when the page closes, and a reconnecting page neither misses nor repeats text', async () => {
    const { app } = build()
    const ids = await turn()
    const run = await call<RunDTO>(app, 'POST', `/api/discussions/${ids.discussionId}/turns/${ids.turnId}/runs`, { requestKey: 'r2' }, 202)
    await ready()
    await until(async () => (await call<RunDTO>(app, 'GET', `/api/runs/${run.id}`)).status === 'running')
    const first = listen(app, run.id, frames => frames.some(frame => frame.event === 'delta'))
    await new Promise(resolve => setTimeout(resolve, 30))
    gate.send('甲')
    const before = await first                          // tab closes after seeing 甲
    gate.send('乙'); gate.send('丙')
    await until(async () => (await call<RunDTO>(app, 'GET', `/api/runs/${run.id}`)).text === '甲乙丙')
    const second = listen(app, run.id, frames => frames.some(frame => frame.event === 'status' && frame.data.run.status === 'completed'))
    await new Promise(resolve => setTimeout(resolve, 30))
    gate.send('丁'); gate.finish()
    const after = await second
    expect(after[0]).toMatchObject({ event: 'snapshot', data: { text: '甲乙丙' } })
    expect(after[0]!.data.text + after.filter(frame => frame.event === 'delta').map(frame => frame.data.text).join('')).toBe('甲乙丙丁')
    expect(before.filter(frame => frame.event === 'delta').map(frame => frame.data.text).join('') + '乙丙丁').toContain('甲')
    expect((await call<RunDTO>(app, 'GET', `/api/runs/${run.id}`)).status).toBe('completed')
  })

  it('stops on request, keeps the partial text without saving it as an answer, and allows a retry', async () => {
    const { app } = build()
    const ids = await turn()
    const run = await call<RunDTO>(app, 'POST', `/api/discussions/${ids.discussionId}/turns/${ids.turnId}/runs`, { requestKey: 'r3' }, 202)
    await ready()
    await until(async () => (await call<RunDTO>(app, 'GET', `/api/runs/${run.id}`)).status === 'running')
    gate.send('写到一半')
    await until(async () => (await call<RunDTO>(app, 'GET', `/api/runs/${run.id}`)).text === '写到一半')
    await call(app, 'POST', `/api/discussions/${ids.discussionId}/turns/${ids.turnId}/runs`, { requestKey: 'r3b' }, 409)
    await call(app, 'POST', `/api/runs/${run.id}/stop`, {})
    await until(async () => (await call<RunDTO>(app, 'GET', `/api/runs/${run.id}`)).status === 'cancelled')
    expect(await call<RunDTO>(app, 'GET', `/api/runs/${run.id}`)).toMatchObject({ status: 'cancelled', text: '写到一半' })
    expect((await research.getDiscussion(ids.discussionId)).turns[0]!.answers).toEqual([])
    gate = undefined as unknown as typeof gate
    const retry = await call<RunDTO>(app, 'POST', `/api/discussions/${ids.discussionId}/turns/${ids.turnId}/runs`, { requestKey: 'r3c' }, 202)
    expect(retry.id).not.toBe(run.id)
    await ready()
    gate.send('重试成功'); gate.finish()
    await until(async () => (await call<RunDTO>(app, 'GET', `/api/runs/${retry.id}`)).status === 'completed')
    expect((await research.getDiscussion(ids.discussionId)).turns[0]!.answers.map(answer => answer.text)).toEqual(['重试成功'])
  })

  it('records a model failure with the text so far and no saved answer', async () => {
    const { app } = build()
    const ids = await turn()
    const run = await call<RunDTO>(app, 'POST', `/api/discussions/${ids.discussionId}/turns/${ids.turnId}/runs`, { requestKey: 'r4' }, 202)
    await ready()
    await until(async () => (await call<RunDTO>(app, 'GET', `/api/runs/${run.id}`)).status === 'running')
    gate.send('部分内容')
    await until(async () => (await call<RunDTO>(app, 'GET', `/api/runs/${run.id}`)).text === '部分内容')
    gate.fail()
    await until(async () => (await call<RunDTO>(app, 'GET', `/api/runs/${run.id}`)).status === 'failed')
    const failed = await call<RunDTO>(app, 'GET', `/api/runs/${run.id}`)
    expect(failed.text).toBe('部分内容')
    expect(failed.error).toBeTruthy()
    expect(JSON.stringify(failed)).not.toContain('test-only-key')
    expect((await research.getDiscussion(ids.discussionId)).turns[0]!.answers).toEqual([])
  })

  it('marks a run left unfinished by a restart as interrupted, keeping its text, and never resumes it by itself', async () => {
    const first = build()
    const ids = await turn()
    const run = await call<RunDTO>(first.app, 'POST', `/api/discussions/${ids.discussionId}/turns/${ids.turnId}/runs`, { requestKey: 'r5' }, 202)
    await ready()
    await until(async () => (await call<RunDTO>(first.app, 'GET', `/api/runs/${run.id}`)).status === 'running')
    gate.send('重启前的内容')
    await until(async () => JSON.parse(await fs.readFile(path.join(store.paths.local, 'runs', run.id + '.json'), 'utf8')).text === '重启前的内容' || false).catch(() => undefined)
    // Simulate the process dying: the record on disk still says running.
    const file = path.join(store.paths.local, 'runs', run.id + '.json')
    const crashed = { ...JSON.parse(await fs.readFile(file, 'utf8')), status: 'running', text: '重启前的内容' }
    await fs.writeFile(file, JSON.stringify(crashed))
    shutdown.abort()
    await Promise.allSettled([...first.tasks])
    await fs.writeFile(file, JSON.stringify(crashed))
    transports = 0
    const second = build()
    const seen = await call<RunDTO>(second.app, 'GET', `/api/runs/${run.id}`)
    expect(seen).toMatchObject({ status: 'interrupted', text: '重启前的内容' })
    expect(seen.error).toContain('重启')
    expect(transports).toBe(0)
    expect((await research.getDiscussion(ids.discussionId)).turns[0]!.answers).toEqual([])
    const view = await call<{ runs: RunDTO[] }>(second.app, 'GET', '/api/research/note?name=Materials.md')
    expect(view.runs).toEqual([])   // not started from a note, so not listed here
  })

  it('lists unfinished runs for the note a page reopens, newest per question', async () => {
    const { app } = build()
    await store.create('Materials', note)
    const source = await research.createSource({ note: 'Materials.md', quote: '铝很轻，密度约 2.7。' })
    const draft = await research.createDraft({ origin: { kind: 'note', noteId: source.noteId, sourceId: source.id }, items: [{ id: 'q', question: '为什么轻？', sourceIds: [source.id] }] })
    const sent = await research.sendDraft(draft.id, [{ id: 'q', question: '为什么轻？' }])
    const url = `/api/discussions/${sent.discussion.id}/turns/${sent.turns[0]!.id}/runs`
    const run = await call<RunDTO>(app, 'POST', url, { requestKey: 'a' }, 202)
    await ready()
    await until(async () => (await call<RunDTO>(app, 'GET', `/api/runs/${run.id}`)).status === 'running')
    gate.fail()
    await until(async () => (await call<RunDTO>(app, 'GET', `/api/runs/${run.id}`)).status === 'failed')
    expect((await call<{ runs: RunDTO[] }>(app, 'GET', '/api/research/note?name=Materials.md')).runs.map(item => [item.id, item.status])).toEqual([[run.id, 'failed']])
    gate = undefined as unknown as typeof gate
    const retry = await call<RunDTO>(app, 'POST', url, { requestKey: 'b' }, 202)
    await ready()
    gate.send('好'); gate.finish()
    await until(async () => (await call<RunDTO>(app, 'GET', `/api/runs/${retry.id}`)).status === 'completed')
    expect((await call<{ runs: RunDTO[] }>(app, 'GET', '/api/research/note?name=Materials.md')).runs).toEqual([])
  })

  it('rejects an unknown run, a reused key for another question and a missing question', async () => {
    const { app } = build()
    const ids = await turn()
    await call(app, 'GET', `/api/runs/${'a'.repeat(32)}`, undefined, 404)
    await call(app, 'GET', '/api/runs/not-an-id', undefined, 400)
    await call(app, 'POST', `/api/discussions/${ids.discussionId}/turns/${'b'.repeat(32)}/runs`, { requestKey: 'k' }, 404)
  })
})
