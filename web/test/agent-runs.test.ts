import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AISettings } from '../server/ai-settings'
import { createApp } from '../server/app'
import { NoteStore } from '../server/store'
import { EventBus } from '../server/events'
import type { AgentEvent, AgentRunDTO, AgentScope } from '../shared/types'

const J = { host: 'localhost:3001', 'content-type': 'application/json' }
const scope: AgentScope = { kind: 'folder', folder: '' }
let dir: string, store: NoteStore, ai: AISettings, shutdown: AbortController
const running = new Set<Promise<unknown>>()
type Step = { text?: string; calls?: { name: string; args: object }[]; hold?: Promise<void> }
let script: Step[], transports: number

/** A model that answers from a script; a step with `hold` waits for the test before finishing its stream. */
const transport: typeof fetch = async (_, init) => {
  transports++
  const step = script.shift()
  if (!step) throw new Error('no scripted reply')
  const encoder = new TextEncoder(), chunk = (value: unknown) => encoder.encode('data: ' + JSON.stringify(value) + '\n\n')
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      init!.signal?.addEventListener('abort', () => { try { controller.error(new DOMException('aborted', 'AbortError')) } catch { /* closed */ } }, { once: true })
      if (step.text) controller.enqueue(chunk({ choices: [{ delta: { content: step.text }, finish_reason: null }] }))
      if (step.hold) await step.hold
      for (const [index, call] of (step.calls ?? []).entries()) controller.enqueue(chunk({ choices: [{ delta: { tool_calls: [{ index, id: 'call-' + transports + '-' + index, function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, finish_reason: null }] }))
      controller.enqueue(chunk({ choices: [{ delta: {}, finish_reason: step.calls?.length ? 'tool_calls' : 'stop' }] }))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      try { controller.close() } catch { /* aborted */ }
    },
  })
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}
const gate = () => { let open!: () => void; const hold = new Promise<void>(resolve => { open = resolve }); return { hold, open } }

function build() {
  shutdown = new AbortController()
  return createApp(store, new EventBus(), { aiSettings: ai, aiTransport: transport, shutdown: shutdown.signal, tasks: running })
}
const call = async <T>(app: ReturnType<typeof build>, method: string, url: string, body?: unknown, expected = 200): Promise<T> => {
  const response = await app.request(url, { method, headers: J, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const text = await response.text()
  expect(response.status, text).toBe(expected)
  return JSON.parse(text) as T
}
const until = async (check: () => Promise<boolean> | boolean) => { for (let i = 0; i < 300; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)) } throw new Error('timed out') }
const status = async (app: ReturnType<typeof build>, id: string) => (await call<AgentRunDTO>(app, 'GET', `/api/agent-runs/${id}`)).status

/** Reads agent-run SSE until `stop(entries)` or the stream ends; closing early is a browser tab going away. */
async function attach(app: ReturnType<typeof build>, id: string, lastEventId?: number, stop: (entries: { seq: number; event: AgentEvent }[]) => boolean = () => false) {
  const response = await app.request(`/api/agent-runs/${id}/events`, { headers: { host: 'localhost:3001', ...(lastEventId === undefined ? {} : { 'last-event-id': String(lastEventId) }) } })
  expect(response.status).toBe(200)
  const reader = response.body!.getReader(), decoder = new TextDecoder(), entries: { seq: number; event: AgentEvent }[] = []
  let snapshot: AgentRunDTO | null = null, buffer = ''
  while (!stop(entries)) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
      const raw = buffer.slice(0, end); buffer = buffer.slice(end + 2)
      const name = /^event: (.*)$/m.exec(raw)?.[1], data = /^data: (.*)$/m.exec(raw)?.[1]
      if (name === 'snapshot' && data) snapshot = JSON.parse(data)
      if (name === 'agent' && data) entries.push(JSON.parse(data))
    }
  }
  await reader.cancel()
  return { snapshot: snapshot!, entries }
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cn-agent-runs-'))
  store = new NoteStore(path.join(dir, 'notes'))
  await store.init()
  await store.create('Existing', '# 已有\n')
  ai = new AISettings(path.join(dir, 'notes'), path.join(dir, 'private'), {})
  await ai.save({ model: 'test-model', baseUrl: 'https://models.example/v1', key: 'test-only-key' })
  script = []; transports = 0
})
afterEach(async () => { await Promise.allSettled([...running]); await fs.rm(dir, { recursive: true, force: true }) })

describe('Note Agent on the run layer', () => {
  it('records the request, runs the unchanged tool loop once, and a repeated key does not run it again', async () => {
    script = [{ calls: [{ name: 'create_note', args: { title: '新笔记', content: '# 新笔记\n\n正文\n' } }] }, { text: '已创建。' }]
    const app = build()
    const body = { requestKey: 'k1', scope, message: '创建一篇新笔记' }
    const run = await call<AgentRunDTO>(app, 'POST', '/api/agent-runs', body, 202)
    expect(JSON.parse(await fs.readFile(path.join(store.paths.local, 'agent-runs', run.id + '.json'), 'utf8'))).toMatchObject({ id: run.id, status: expect.any(String) })
    expect((await call<AgentRunDTO>(app, 'POST', '/api/agent-runs', body, 202)).id).toBe(run.id)
    await until(async () => (await status(app, run.id)) === 'completed')
    expect(transports).toBe(2)
    expect(await store.names()).toContain('新笔记.md')
    const { snapshot, entries } = await attach(app, run.id, 0)
    expect(snapshot.status).toBe('completed')
    expect(entries.map(entry => entry.event.type)).toEqual(expect.arrayContaining(['session', 'activity', 'changeset', 'message', 'done']))
    expect(entries.map(entry => entry.seq)).toEqual(entries.map((_, index) => index + 1))
    expect((await call<AgentRunDTO>(app, 'GET', `/api/agent-runs/${run.id}`)).session).toBeTruthy()
  })

  it('keeps running when the listener goes away, and a reattached listener gets exactly the missed events', async () => {
    const release = gate()
    script = [{ text: '先想一想。', hold: release.hold }]
    const app = build()
    const run = await call<AgentRunDTO>(app, 'POST', '/api/agent-runs', { requestKey: 'k2', scope, message: '问个问题' }, 202)
    const first = await attach(app, run.id, 0, entries => entries.some(entry => entry.event.type === 'delta'))
    const seen = first.entries.at(-1)!.seq
    expect(await status(app, run.id)).toBe('running')
    release.open()
    await until(async () => (await status(app, run.id)) === 'completed')
    const second = await attach(app, run.id, seen)
    expect(second.entries.every(entry => entry.seq > seen)).toBe(true)
    const all = [...first.entries, ...second.entries]
    expect(all.map(entry => entry.seq)).toEqual(all.map((_, index) => index + 1))
    expect(all.filter(entry => entry.event.type === 'message').map(entry => (entry.event as { text: string }).text)).toEqual(['先想一想。'])
    expect(all.at(-1)!.event.type).toBe('done')
  })

  it('stops on request: no later tool call runs, finished work stays in the change record, and the conversation keeps what was said', async () => {
    const release = gate()
    script = [{ calls: [{ name: 'create_note', args: { title: '第一篇', content: '# 第一篇\n' } }] }, { text: '继续。', hold: release.hold }, { calls: [{ name: 'create_note', args: { title: '第二篇', content: '# 第二篇\n' } }] }, { text: '完成。' }]
    const app = build()
    const run = await call<AgentRunDTO>(app, 'POST', '/api/agent-runs', { requestKey: 'k3', scope, message: '创建两篇笔记' }, 202)
    await until(async () => (await store.names()).includes('第一篇.md'))
    await until(() => transports === 2)
    await call(app, 'POST', `/api/agent-runs/${run.id}/stop`, {})
    release.open()
    await until(async () => (await status(app, run.id)) === 'cancelled')
    expect(await store.names()).toContain('第一篇.md')
    expect(await store.names()).not.toContain('第二篇.md')
    expect(transports).toBe(2)
    const stopped = await call<AgentRunDTO>(app, 'GET', `/api/agent-runs/${run.id}`)
    expect(stopped.error).toContain('可以撤销')
    const state = await call<{ messages: { text: string }[]; changes: unknown[] } | null>(app, 'GET', `/api/ai/conversation?scope=${encodeURIComponent(JSON.stringify(scope))}`)
    expect(state!.messages.map(message => message.text)).toContain('创建两篇笔记')
    expect(state!.changes).toHaveLength(1)
  })

  it('after a restart an unfinished run is interrupted, nothing is replayed, and the conversation is intact', async () => {
    const release = gate()
    script = [{ calls: [{ name: 'create_note', args: { title: '重启前', content: '# 重启前\n' } }] }, { text: '还在写', hold: release.hold }]
    const first = build()
    const run = await call<AgentRunDTO>(first, 'POST', '/api/agent-runs', { requestKey: 'k5', scope, message: '创建并继续' }, 202)
    await until(() => transports === 2)
    const file = path.join(store.paths.local, 'agent-runs', run.id + '.json')
    const crashed = { ...JSON.parse(await fs.readFile(file, 'utf8')), status: 'running' }
    shutdown.abort(); release.open()
    await Promise.allSettled([...running])
    await fs.writeFile(file, JSON.stringify(crashed))
    transports = 0; script = []
    const second = build()
    const seen = await call<AgentRunDTO>(second, 'GET', `/api/agent-runs/${run.id}`)
    expect(seen.status).toBe('interrupted')
    expect(seen.error).toContain('不会自动重新执行')
    expect(transports).toBe(0)
    expect((await store.names()).filter(name => name === '重启前.md')).toHaveLength(1)
    const state = await call<{ messages: { text: string }[] } | null>(second, 'GET', `/api/ai/conversation?scope=${encodeURIComponent(JSON.stringify(scope))}`)
    expect(state!.messages[0]!.text).toBe('创建并继续')
  })

  it('holds back a sync while a run is active and refuses a run during a sync', async () => {
    const release = gate()
    script = [{ text: '处理中', hold: release.hold }]
    const app = build()
    const run = await call<AgentRunDTO>(app, 'POST', '/api/agent-runs', { requestKey: 'k6', scope, message: '占用' }, 202)
    await until(() => transports === 1)
    const push = await app.request('/api/repo/push', { method: 'POST', headers: J, body: '{}' })
    expect(await push.text()).toContain('助手任务或同步仍在进行')
    release.open()
    await until(async () => (await status(app, run.id)) === 'completed')
  })

  it('tells a page that opens mid-run which run to follow, and stops saying so once it ends', async () => {
    const release = gate()
    script = [{ text: '进行中', hold: release.hold }]
    const app = build()
    const run = await call<AgentRunDTO>(app, 'POST', '/api/agent-runs', { requestKey: 'k7', scope, message: '后台任务' }, 202)
    await until(async () => !!(await call<AgentRunDTO>(app, 'GET', `/api/agent-runs/${run.id}`)).session)
    const url = `/api/ai/conversation?scope=${encodeURIComponent(JSON.stringify(scope))}`
    const during = await call<{ id: string; activeRun?: AgentRunDTO } | null>(app, 'GET', url)
    expect(during!.activeRun).toMatchObject({ id: run.id, status: 'running', session: during!.id })
    release.open()
    await until(async () => (await status(app, run.id)) === 'completed')
    expect((await call<{ activeRun?: AgentRunDTO }>(app, 'GET', url)).activeRun).toBeUndefined()
  })

  it('does not give the snapshot an event id, so a reconnect resumes from the last real event', async () => {
    const app = build()
    script = [{ text: '好' }]
    const run = await call<AgentRunDTO>(app, 'POST', '/api/agent-runs', { requestKey: 'k8', scope, message: '快速' }, 202)
    await until(async () => (await status(app, run.id)) === 'completed')
    const raw = await (await app.request(`/api/agent-runs/${run.id}/events`, { headers: { host: 'localhost:3001' } })).text()
    const snapshot = raw.split('\n\n').find(block => block.includes('event: snapshot'))!
    expect(snapshot).not.toMatch(/^id:/m)
    expect(raw).toMatch(/^id: 1$/m)
  })

  it('rejects bad input, a missing run, and a conversation that is already busy', async () => {
    const app = build()
    await call(app, 'POST', '/api/agent-runs', { requestKey: 'x', scope: { kind: 'bogus' }, message: 'x' }, 400)
    await call(app, 'POST', '/api/agent-runs', { scope, message: 'x' }, 400)
    await call(app, 'GET', `/api/agent-runs/${'a'.repeat(32)}`, undefined, 404)
    await call(app, 'GET', '/api/agent-runs/bad', undefined, 400)
  })
})
