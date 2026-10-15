import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NoteAgent } from '../server/agent'
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
  it('discovers a running task outside its page with durable request and current activity', async () => {
    const release = gate()
    script = [{ text: '正在整理', hold: release.hold }]
    const app = build()
    try {
      expect(await call(app, 'GET', '/api/agent-runs')).toEqual([])
      const run = await call<AgentRunDTO>(app, 'POST', '/api/agent-runs', { requestKey: 'discover', scope: { kind: 'note', folder: '', name: 'Existing.md' }, message: '整理\n  这篇文章' }, 202)
      await until(async () => (await call<AgentRunDTO[]>(app, 'GET', '/api/agent-runs'))[0]?.activity === '正在生成回复')
      const found = await call<AgentRunDTO[]>(app, 'GET', '/api/agent-runs')
      expect(found).toEqual([expect.objectContaining({ id: run.id, request: '整理 这篇文章', activity: '正在生成回复', status: 'running', scope: { kind: 'note', folder: '', name: 'Existing.md' }, session: expect.any(String) })])
      await until(async () => JSON.parse(await fs.readFile(path.join(store.paths.local, 'agent-runs', run.id + '.json'), 'utf8')).activity === '正在生成回复')
      release.open()
      await until(async () => (await status(app, run.id)) === 'completed')
      expect((await call<AgentRunDTO[]>(build(), 'GET', '/api/agent-runs'))[0]).toMatchObject({ id: run.id, request: '整理 这篇文章', activity: '正在生成回复', status: 'completed' })
    } finally { release.open() }
  })

  it('bounds history, prioritizes tasks needing attention, and accepts older records without summaries', async () => {
    const directory = path.join(store.paths.local, 'agent-runs')
    await fs.mkdir(directory, { recursive: true })
    for (let i = 0; i < 24; i++) {
      const id = i.toString(16).padStart(32, '0')
      await fs.writeFile(path.join(directory, id + '.json'), JSON.stringify({ version: 1, id, requestKey: String(i), scope, status: i === 0 ? 'recovery_required' : 'completed', seq: 0, createdAt: i, updatedAt: i }))
    }
    const app = build()
    const all = await call<AgentRunDTO[]>(app, 'GET', '/api/agent-runs?limit=999')
    expect(all).toHaveLength(20)
    expect(all[0]).toMatchObject({ status: 'recovery_required', requestKey: '0' })
    expect(all[1]!.requestKey).toBe('23')
    expect(all[0]!.request).toBeUndefined()
    const reads = vi.spyOn(fs, 'readdir')
    try {
      expect(await call(app, 'GET', '/api/agent-runs?limit=1')).toEqual([all[0]])
      expect(await call(app, 'GET', '/api/agent-runs?limit=1')).toEqual([all[0]])
      expect(reads.mock.calls.filter(([directory]) => String(directory).endsWith('/agent-runs'))).toHaveLength(0)
    } finally { reads.mockRestore() }
    await call(app, 'GET', '/api/agent-runs?limit=-1', undefined, 400)
    await call(app, 'GET', '/api/agent-runs?limit=abc', undefined, 400)
  })

  it('returns the exact requested conversation rather than a newer one and validates its scope', async () => {
    const app = build(), chatScope = { kind: 'chat', folder: '' }
    script = [{ text: '第一段回答' }, { text: '第二段回答' }]
    const first = await call<AgentRunDTO>(app, 'POST', '/api/agent-runs', { requestKey: 'exact-first', scope: chatScope, message: '第一个任务' }, 202)
    await attach(app, first.id)
    const second = await call<AgentRunDTO>(app, 'POST', '/api/agent-runs', { requestKey: 'exact-second', scope: chatScope, message: '第二个任务' }, 202)
    await attach(app, second.id)
    const run = await call<AgentRunDTO>(app, 'GET', `/api/agent-runs/${first.id}`)
    const result = await call<{ id: string; messages: { text: string }[] }>(app, 'GET', `/api/ai/conversation?scope=${encodeURIComponent(JSON.stringify(chatScope))}&session=${run.session}`)
    expect(result.id).toBe(run.session)
    expect(result.messages.map(message => message.text)).toEqual(['第一个任务', '第一段回答'])
    await call(app, 'GET', `/api/ai/conversation?scope=${encodeURIComponent(JSON.stringify(scope))}&session=${run.session}`, undefined, 400)
    await call(app, 'GET', `/api/ai/conversation?scope=${encodeURIComponent(JSON.stringify(chatScope))}&session=bad`, undefined, 400)
  })

  it('preserves the full conversation and original goal when compaction fails', async () => {
    script = [{ text: '已理解目标。' }]
    const app = build()
    const first = await call<AgentRunDTO>(app, 'POST', '/api/agent-runs', { requestKey: 'long-history', scope, message: '整理资料，保留原文和所有来源' }, 202)
    await attach(app, first.id)
    const firstRun = await call<AgentRunDTO>(app, 'GET', `/api/agent-runs/${first.id}`)
    const file = path.join(store.paths.local, 'conversations', firstRun.session! + '.json')
    const conversation = JSON.parse(await fs.readFile(file, 'utf8'))
    conversation.messages = Array.from({ length: 6 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: index === 0 ? '原始目标：保留所有来源。' + '资料'.repeat(23000) : '旧上下文'.repeat(12000) }))
    await fs.writeFile(file, JSON.stringify(conversation))
    script = [{}] // Summary service returned no usable answer.
    const next = await call<AgentRunDTO>(app, 'POST', '/api/agent-runs', { requestKey: 'failed-compaction', scope, session: firstRun.session, message: '继续' }, 202)
    const { entries } = await attach(app, next.id)
    expect(entries.some(entry => entry.event.type === 'error' && entry.event.text.includes('压缩失败'))).toBe(true)
    expect(await status(app, next.id)).toBe('failed')
    const preserved = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(preserved.messages.slice(0, -1)).toEqual(conversation.messages)
    expect(preserved.messages.at(-1)).toEqual({ role: 'user', content: '继续' })
    expect(entries.some(entry => entry.event.type === 'changeset')).toBe(false)
  })

  it('persists the final status and event sequence before the client receives done', async () => {
    script = [{ text: '已完成。' }]
    const app = build()
    const run = await call<AgentRunDTO>(app, 'POST', '/api/agent-runs', { requestKey: 'durable-done', scope, message: '你好' }, 202)
    const { entries } = await attach(app, run.id)
    const finalEvent = entries.at(-1)!
    expect(finalEvent.event.type).toBe('done')
    const persisted = JSON.parse(await fs.readFile(path.join(store.paths.local, 'agent-runs', run.id + '.json'), 'utf8'))
    expect(persisted).toMatchObject({ status: 'completed', seq: finalEvent.seq })
  })

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

  it('cancels the remaining calls in one model response and durably records a result for each call', async () => {
    const firstChanged = gate(), release = gate(), runAgent = NoteAgent.prototype.run
    // Pause after the real first mutation and its changeset event. The HTTP stop lands at
    // this exact boundary, rather than racing a timer against subsequent file writes.
    const spy = vi.spyOn(NoteAgent.prototype, 'run').mockImplementation(function (this: NoteAgent, input, model, signal, emit) {
      return runAgent.call(this, input, model, signal, async event => {
        await emit(event)
        if (event.type === 'changeset') { firstChanged.open(); await release.hold }
      })
    })
    try {
      script = [{ calls: [
        { name: 'create_note', args: { title: '同批第一篇', content: '# 第一篇\n' } },
        { name: 'create_note', args: { title: '同批第二篇', content: '# 第二篇\n' } },
        { name: 'create_note', args: { title: '同批第三篇', content: '# 第三篇\n' } },
      ] }]
      const app = build()
      const run = await call<AgentRunDTO>(app, 'POST', '/api/agent-runs', { requestKey: 'stop-within-batch', scope, message: '创建三篇笔记' }, 202)
      await firstChanged.hold
      await call(app, 'POST', `/api/agent-runs/${run.id}/stop`, {})
      release.open()
      const { entries } = await attach(app, run.id)

      expect(transports).toBe(1)
      expect((await store.names()).filter(name => name.startsWith('同批'))).toEqual(['同批第一篇.md'])
      expect(await fs.readFile(path.join(store.root, '同批第一篇.md'), 'utf8')).toBe('# 第一篇\n')
      expect(entries.filter(entry => entry.event.type === 'changeset')).toHaveLength(1)
      expect(entries.at(-1)!.event.type).toBe('done')
      const persisted = JSON.parse(await fs.readFile(path.join(store.paths.local, 'agent-runs', run.id + '.json'), 'utf8'))
      expect(persisted).toMatchObject({ status: 'cancelled', seq: entries.at(-1)!.seq, changes: [expect.any(String)] })

      const conversation = JSON.parse(await fs.readFile(path.join(store.paths.local, 'conversations', persisted.session + '.json'), 'utf8'))
      expect(conversation.messages[0]).toEqual({ role: 'user', content: '创建三篇笔记' })
      const calls = conversation.messages.find((message: { role: string; tool_calls?: unknown[] }) => message.role === 'assistant' && message.tool_calls)?.tool_calls
      expect(calls).toHaveLength(3)
      const results = conversation.messages.filter((message: { role: string }) => message.role === 'tool')
      expect(results.map((result: { tool_call_id: string }) => result.tool_call_id)).toEqual(calls.map((tool: { id: string }) => tool.id))
      expect(JSON.parse(results[0].content)).toMatchObject({ created: '同批第一篇.md', changeSet: persisted.changes[0] })
      for (const result of results.slice(1)) expect(JSON.parse(result.content)).toMatchObject({ code: 'cancelled' })
      expect(conversation.changesets).toEqual(persisted.changes)
      const changeset = JSON.parse(await fs.readFile(path.join(store.paths.local, 'changesets', persisted.changes[0] + '.json'), 'utf8'))
      expect(changeset.files.filter((file: { area: string }) => file.area === 'notes').map((file: { name: string }) => file.name)).toEqual(['同批第一篇.md'])
    } finally { release.open(); spy.mockRestore() }
  })

  /** Runs a script until the model is mid-reply, then simulates a crash: the record on disk still says "running". */
  async function crashMidRun(requestKey: string, steps: Step[], message: string) {
    const release = gate()
    transports = 0
    script = steps.map((step, index) => index === steps.length - 1 ? { ...step, hold: release.hold } : step)
    const first = build()
    const run = await call<AgentRunDTO>(first, 'POST', '/api/agent-runs', { requestKey, scope, message }, 202)
    await until(() => transports === steps.length)
    const file = path.join(store.paths.local, 'agent-runs', run.id + '.json')
    const crashed = { ...JSON.parse(await fs.readFile(file, 'utf8')), status: 'running' }
    shutdown.abort(); release.open()
    await Promise.allSettled([...running])
    await fs.writeFile(file, JSON.stringify(crashed))
    transports = 0; script = []
    return { run, restarted: build() }
  }

  it('after a restart a run that had already changed notes needs recovery: nothing is replayed, the changes are listed, and it is not reported as a plain interruption', async () => {
    const { run, restarted } = await crashMidRun('k5', [{ calls: [{ name: 'create_note', args: { title: '重启前', content: '# 重启前\n' } }] }, { text: '还在写' }], '创建并继续')
    const seen = await call<AgentRunDTO>(restarted, 'GET', `/api/agent-runs/${run.id}`)
    expect(seen.status).toBe('recovery_required')
    expect(seen.error).toContain('已经修改了 1 处笔记'); expect(seen.error).toContain('不会自动重新执行或回滚')
    expect(seen.changes).toHaveLength(1)
    expect(transports).toBe(0)
    expect((await store.names()).filter(name => name === '重启前.md')).toHaveLength(1)
    const state = await call<{ messages: { text: string }[]; changes: { id: string }[]; recovery?: AgentRunDTO[] }>(restarted, 'GET', `/api/ai/conversation?scope=${encodeURIComponent(JSON.stringify(scope))}`)
    expect(state.messages[0]!.text).toBe('创建并继续')
    expect(state.recovery?.map(item => item.id)).toEqual([run.id])
    expect(state.changes.map(change => change.id)).toEqual(seen.changes)
  })

  it('still needs recovery when the crash came after the change committed but before the run recorded it', async () => {
    const { run, restarted } = await crashMidRun('k5e', [{ calls: [{ name: 'create_note', args: { title: '窗口内', content: '# 窗口内\n' } }] }, { text: '还在写' }], '创建并继续')
    // Simulate the crash window: the change set is committed, the run's own record never learned about it.
    const file = path.join(store.paths.local, 'agent-runs', run.id + '.json')
    const record = JSON.parse(await fs.readFile(file, 'utf8')); delete record.changes
    await fs.writeFile(file, JSON.stringify(record))
    const seen = await call<AgentRunDTO>(build(), 'GET', `/api/agent-runs/${run.id}`)
    expect(seen.status).toBe('recovery_required')
    expect(seen.changes).toHaveLength(1)
    expect(seen.error).toContain('已经修改了 1 处笔记')
    void restarted
  })

  it('does not count another conversation, an earlier request, or an accepted proposal as this run\'s changes', async () => {
    // An earlier, finished request in the same conversation, then a crashed run that changed nothing.
    script = [{ calls: [{ name: 'create_note', args: { title: '更早的', content: '# 更早的\n' } }] }, { text: '完成' }]
    const first = build()
    const earlier = await call<AgentRunDTO>(first, 'POST', '/api/agent-runs', { requestKey: 'k5f', scope, message: '先做一件事' }, 202)
    await until(async () => (await status(first, earlier.id)) === 'completed')
    await new Promise(resolve => setTimeout(resolve, 20))
    const { run, restarted } = await crashMidRun('k5g', [{ text: '只是在想' }], '再聊聊')
    const seen = await call<AgentRunDTO>(restarted, 'GET', `/api/agent-runs/${run.id}`)
    expect(seen.status).toBe('interrupted')
    expect(seen.changes).toBeUndefined()
  })

  it('stays flagged across further restarts until the user acknowledges it, and only a run that needs it can be acknowledged', async () => {
    const { run, restarted } = await crashMidRun('k5b', [{ calls: [{ name: 'create_note', args: { title: '待确认', content: '# 待确认\n' } }] }, { text: '还在写' }], '创建并继续')
    await call(restarted, 'GET', `/api/agent-runs/${run.id}`)
    const again = build()
    expect((await call<AgentRunDTO>(again, 'GET', `/api/agent-runs/${run.id}`)).status).toBe('recovery_required')
    const acknowledged = await call<AgentRunDTO>(again, 'POST', `/api/agent-runs/${run.id}/acknowledge`, {})
    expect(acknowledged.status).toBe('interrupted'); expect(acknowledged.error).toContain('确认检查过')
    expect(acknowledged.changes).toHaveLength(1)
    const state = await call<{ recovery?: unknown }>(again, 'GET', `/api/ai/conversation?scope=${encodeURIComponent(JSON.stringify(scope))}`)
    expect(state.recovery).toBeUndefined()
    await call(again, 'POST', `/api/agent-runs/${run.id}/acknowledge`, {}, 409)
  })

  it('after a restart a run that had not changed anything is a plain interruption', async () => {
    const { run, restarted } = await crashMidRun('k5c', [{ text: '只是在想' }], '随便聊聊')
    const seen = await call<AgentRunDTO>(restarted, 'GET', `/api/agent-runs/${run.id}`)
    expect(seen.status).toBe('interrupted')
    expect(seen.error).toContain('还没有修改任何笔记')
    expect(seen.changes).toBeUndefined()
    await call(restarted, 'POST', `/api/agent-runs/${run.id}/acknowledge`, {}, 409)
  })

  it('a graceful shutdown during a write run also needs recovery, with the same wording', async () => {
    const release = gate()
    script = [{ calls: [{ name: 'create_note', args: { title: '关机前', content: '# 关机前\n' } }] }, { text: '还在写', hold: release.hold }]
    const app = build()
    const run = await call<AgentRunDTO>(app, 'POST', '/api/agent-runs', { requestKey: 'k5d', scope, message: '创建' }, 202)
    await until(() => transports === 2)
    shutdown.abort(); release.open()
    await Promise.allSettled([...running])
    const seen = await call<AgentRunDTO>(build(), 'GET', `/api/agent-runs/${run.id}`)
    expect(seen).toMatchObject({ status: 'recovery_required', changes: [expect.any(String)] })
    expect(seen.error).toContain('服务正在停止')
  })

  it('finishes as waiting_confirmation while a queued proposal awaits the user, and becomes completed once it is decided', async () => {
    script = [{ calls: [{ name: 'propose_changes', args: { reason: '整理一下', operations: [{ tool: 'create_note', arguments: { title: '提案笔记', content: '# 提案笔记\n' } }] } }] }, { text: '我提了一个建议。' }]
    const app = build()
    const run = await call<AgentRunDTO>(app, 'POST', '/api/agent-runs', { requestKey: 'k7', scope, message: '有什么建议' }, 202)
    await until(async () => !['queued', 'running'].includes(await status(app, run.id)))
    const waiting = await call<AgentRunDTO>(app, 'GET', `/api/agent-runs/${run.id}`)
    expect(waiting.status).toBe('waiting_confirmation')
    expect(waiting.proposals).toHaveLength(1)
    expect(await store.names()).not.toContain('提案笔记.md')
    // Not "busy": a sync may proceed while the user decides.
    const push = await app.request('/api/repo/push', { method: 'POST', headers: J, body: '{}' })
    expect(await push.text()).not.toContain('助手任务或同步仍在进行')
    await call(app, 'POST', `/api/ai/proposals/${waiting.proposals![0]}/accept`, {})
    const settled = await call<AgentRunDTO>(app, 'GET', `/api/agent-runs/${run.id}`)
    expect(settled.status).toBe('completed')
    expect(await call(app, 'GET', `/api/agent-runs/${run.id}`)).toEqual(settled)
    const persisted = JSON.parse(await fs.readFile(path.join(store.paths.local, 'agent-runs', run.id + '.json'), 'utf8'))
    expect(persisted.updatedAt).toBe(settled.updatedAt)
    expect(await status(build(), run.id)).toBe('completed')
  })

  it('a rejected proposal also completes the run', async () => {
    script = [{ calls: [{ name: 'propose_changes', args: { reason: '另一个建议', operations: [{ tool: 'create_note', arguments: { title: '不要的笔记', content: '# 不要\n' } }] } }] }, { text: '建议如上。' }]
    const app = build()
    const run = await call<AgentRunDTO>(app, 'POST', '/api/agent-runs', { requestKey: 'k8', scope, message: '再提一个' }, 202)
    await until(async () => (await status(app, run.id)) === 'waiting_confirmation')
    const { proposals } = await call<AgentRunDTO>(app, 'GET', `/api/agent-runs/${run.id}`)
    await call(app, 'POST', `/api/ai/proposals/${proposals![0]}/reject`, {})
    expect(await status(app, run.id)).toBe('completed')
    expect(await store.names()).not.toContain('不要的笔记.md')
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
