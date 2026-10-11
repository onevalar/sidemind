import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AISettings, normalizeAIUrl } from '../server/ai-settings'
import { createApp } from '../server/app'
import { NoteStore } from '../server/store'
import { EventBus } from '../server/events'
import { proposeEdit } from '../server/ai'
import type { AgentEvent, AgentScope } from '../shared/types'

let dir: string
let ai: AISettings
const H = { host: 'localhost:3001' }
const J = { ...H, 'content-type': 'application/json' }
const input = { model: 'test-model', baseUrl: 'https://models.example/v1', key: 'test-only-key' }
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cn-ai-')); ai = new AISettings(path.join(dir, 'notes'), path.join(dir, 'private'), {}) })
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

describe('local AI connections', () => {
  it('persists outside notes with private permissions and never returns a key publicly', async () => {
    expect(await ai.publicConfig()).toMatchObject({ configured: false, keySaved: false })
    const saved = await ai.save(input)
    expect(saved).toMatchObject({ configured: true, model: 'test-model', keySaved: true, source: 'saved' })
    expect(JSON.stringify(saved)).not.toContain(input.key)
    expect(await fs.readFile(ai.file, 'utf8')).toContain(input.key)
    if (process.platform !== 'win32') {
      expect((await fs.stat(ai.file)).mode & 0o777).toBe(0o600)
      expect((await fs.stat(path.dirname(ai.file))).mode & 0o777).toBe(0o700)
    }
    expect(ai.file.startsWith(path.join(dir, 'notes'))).toBe(false)
    const reopened = new AISettings(path.join(dir, 'notes'), path.join(dir, 'private'), {})
    expect(await reopened.connection()).toEqual(input)
    const otherWorkspace = new AISettings(path.join(dir, 'another'), path.join(dir, 'private'), {})
    expect(await otherWorkspace.connection()).toBe(null)
  })

  it('preserves a key only for the same endpoint and clears without reviving an environment key', async () => {
    const environment = { CANVAS_AI_API_KEY: 'environment-key', CANVAS_AI_MODEL: 'environment-model' }
    const settings = new AISettings(path.join(dir, 'notes'), path.join(dir, 'private'), environment)
    expect(await settings.publicConfig()).toMatchObject({ configured: true, source: 'environment' })
    await settings.save(input)
    await settings.save({ model: 'new-model', baseUrl: 'https://MODELS.example/v1/' })
    expect(await settings.connection()).toMatchObject({ model: 'new-model', key: input.key })
    await expect(settings.save({ model: 'other-model', baseUrl: 'https://other.example/v1' })).rejects.toThrow('重新填写密钥')
    expect(await settings.connection()).toMatchObject({ model: 'new-model', key: input.key })
    await settings.clear()
    expect(await settings.connection()).toBe(null)
    expect(await fs.readFile(settings.file, 'utf8')).not.toContain(input.key)
    expect(await new AISettings(path.join(dir, 'notes'), path.join(dir, 'private'), environment).connection()).toBe(null)
    const legacy = new AISettings(path.join(dir, 'legacy'), path.join(dir, 'private'), { CANVAS_AI_KEY: 'legacy-key', CANVAS_AI_MODEL: 'legacy-model' })
    expect(await legacy.connection()).toMatchObject({ key: 'legacy-key', model: 'legacy-model' })
  })

  it('rejects credential-bearing, insecure remote and full completion URLs', () => {
    for (const url of ['http://remote.example/v1', 'https://user:secret@example.com/v1', 'https://example.com/v1?key=secret', 'https://example.com/v1#fragment', 'file:///tmp/service', 'https://example.com/v1/chat/completions']) expect(() => normalizeAIUrl(url)).toThrow()
    expect(normalizeAIUrl('http://127.0.0.1:5894/v1/')).toBe('http://127.0.0.1:5894/v1')
  })

  it('can recover malformed settings explicitly and does not fall back to another connection', async () => {
    await ai.save(input)
    await fs.writeFile(ai.file, '{invalid')
    await expect(ai.connection()).rejects.toThrow('重新保存')
    const store = new NoteStore(path.join(dir, 'notes'))
    await store.init()
    const app = createApp(store, new EventBus(), { aiSettings: ai })
    const response = await app.request('/api/settings', { headers: H })
    expect(response.status).toBe(200)
    const settings = await response.json()
    expect(settings.notesDirectory).toBe(store.root)
    expect(settings.ai).toMatchObject({ configured: false, keySaved: false, error: expect.stringContaining('重新保存') })
    expect(JSON.stringify(settings)).not.toContain(input.key)
    const refused = await app.request('/api/ai/propose', { method: 'POST', headers: J, body: JSON.stringify({ source: 'Private note', instruction: 'Rewrite' }) })
    expect(refused.status).toBe(502)
    await ai.save(input)
    expect(await ai.connection()).toEqual(input)
    await ai.clear()
    expect(await ai.connection()).toBe(null)
  })

  it('routes only requested source to the configured service; testing and proposing do not modify notes', async () => {
    const store = new NoteStore(path.join(dir, 'notes'))
    await store.init()
    const before = await fs.readFile(path.join(store.root, 'Welcome.md'), 'utf8')
    const requests: { url: string; init: RequestInit }[] = []
    const transport: typeof fetch = async (url, init) => {
      requests.push({ url: String(url), init: init! })
      return new Response(JSON.stringify({ choices: [{ message: { content: 'A revised paragraph.' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } })
    }
    const app = createApp(store, new EventBus(), { aiSettings: ai, aiTransport: transport })
    const save = await app.request('/api/ai/connection', { method: 'PUT', headers: J, body: JSON.stringify(input) })
    expect(save.status).toBe(200)
    expect(await save.text()).not.toContain(input.key)
    const settings = await app.request('/api/settings', { headers: H })
    expect(await settings.text()).not.toContain(input.key)
    const tested = await app.request('/api/ai/test', { method: 'POST', headers: J, body: JSON.stringify({ model: input.model, baseUrl: input.baseUrl }) })
    expect(tested.status).toBe(200)
    const proposed = await app.request('/api/ai/propose', { method: 'POST', headers: J, body: JSON.stringify({ source: 'Only this paragraph.', instruction: 'Make it clearer.' }) })
    expect(await proposed.json()).toEqual({ replacement: 'A revised paragraph.' })
    const request = requests[1]!
    expect(request.url).toBe(input.baseUrl + '/chat/completions')
    expect(request.init.redirect).toBe('error')
    expect(request.init.headers).toMatchObject({ authorization: 'Bearer ' + input.key })
    expect(JSON.parse(String(request.init.body)).messages[1].content).toBe(JSON.stringify({ instruction: 'Make it clearer.', source: 'Only this paragraph.' }))
    expect(String(request.init.body)).not.toContain(before)
    expect(await fs.readFile(path.join(store.root, 'Welcome.md'), 'utf8')).toBe(before)
    const bad = await app.request('/api/ai/connection', { method: 'PUT', headers: { ...J, host: 'evil.example.com' }, body: JSON.stringify(input) })
    expect(bad.status).toBe(403)
    expect((await app.request('/api/ai/connection', { method: 'DELETE', headers: { ...H, 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415)
    const removed = await app.request('/api/ai/connection', { method: 'DELETE', headers: J, body: '{}' })
    expect(await removed.json()).toMatchObject({ configured: false })
    const unconfigured = await app.request('/api/ai/propose', { method: 'POST', headers: J, body: JSON.stringify({ source: 'Text', instruction: 'Rewrite' }) })
    expect(await unconfigured.json()).toEqual({ error: '尚未连接模型服务，请先在设置中添加连接。' })
    expect(requests).toHaveLength(2)
  })

  it('rejects truncated or empty suggestions and passes cancellation through to the transport', async () => {
    const result = (content: string, finish_reason: string): typeof fetch => async () => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason }] }))
    await expect(proposeEdit(input, 'source', 'instruction', undefined, result('Partial', 'length'))).rejects.toThrow('被截断')
    await expect(proposeEdit(input, 'source', 'instruction', undefined, result('', 'stop'))).rejects.toThrow('有效修改')
    const controller = new AbortController()
    const transport: typeof fetch = async (_, init) => new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }))
    const pending = proposeEdit(input, 'source', 'instruction', controller.signal, transport)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('note Agent through the real HTTP and file interfaces', () => {
  const reply = (content: string | null, tool_calls?: unknown[]) => new Response(JSON.stringify({ choices: [{ message: { content, ...(tool_calls ? { tool_calls } : {}) }, finish_reason: tool_calls ? 'tool_calls' : 'stop' }] }))
  const call = (name: string, args: object, id = name) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
  const send = async (app: ReturnType<typeof createApp>, scope: AgentScope, message: string, session?: string) => {
    const response = await app.request('/api/ai/agent', { method: 'POST', headers: J, body: JSON.stringify({ scope, message, session }) })
    expect(response.status).toBe(200)
    return (await response.text()).trim().split('\n').map(line => JSON.parse(line) as AgentEvent)
  }
  const workspace = async () => {
    const store = new NoteStore(path.join(dir, 'notes'))
    await store.init(); await store.createFolder('Physics'); await store.createFolder('Private'); await ai.save(input)
    await store.create('A', '# 光\r\n\r\n学刁光的反射。\r\n\r\n[来源](https://example.com)\r\n', 'Physics')
    await store.create('B', '# 声\n\n回声是声音的反射。\n', 'Physics')
    await store.create('Secret', '# PRIVATE\n\nDo not send this private text.\n', 'Private')
    return store
  }

  it('converses with history without supplying notes or tools in pure chat, and refuses unexpected tool calls', async () => {
    const store = await workspace(), before = (await store.load('Physics/A.md')).content
    let requests = 0
    const app = createApp(store, new EventBus(), { aiSettings: ai, aiTransport: async (_, init) => {
      const body = JSON.parse(String(init!.body))
      expect(body.tools).toBeUndefined()
      expect(String(init!.body)).not.toContain('学刁')
      expect(String(init!.body)).not.toContain('Secret.md')
      if (++requests === 1) return reply('你好！你想聊些什么？')
      if (requests === 2) { expect(body.messages.some((message: { content: string }) => message.content === '你好！你想聊些什么？')).toBe(true); return reply(null, [call('edit_note', { name: 'Physics/A.md', version: 'invented', edits: [{ oldText: '学刁', newText: '学习' }] })]) }
      expect(JSON.parse(body.messages.at(-1).content).error).toContain('不允许')
      return reply('纯聊天不会修改笔记。')
    } })
    const events = await send(app, { kind: 'chat', folder: '' }, '你好')
    expect(events).toContainEqual({ type: 'message', text: '你好！你想聊些什么？' })
    const session = events.find(event => event.type === 'session')!
    if (session.type !== 'session') throw new Error()
    await send(app, { kind: 'chat', folder: '' }, '继续聊', session.id)
    expect((await store.load('Physics/A.md')).content).toBe(before)
    expect(await fs.readdir(path.join(store.root, '.canvasnote'))).not.toContain('agent-changes')
  })

  it('discovers overviews, reads on demand, fixes exact CRLF text and merges into a new note while keeping the sources', async () => {
    const store = await workspace(), before = (await store.load('Physics/A.md')).content, b = (await store.load('Physics/B.md')).content
    let step = 0, version = ''
    const app = createApp(store, new EventBus(), { aiSettings: ai, aiTransport: async (_, init) => {
      const body = JSON.parse(String(init!.body)), result = body.messages.at(-1).role === 'tool' ? JSON.parse(body.messages.at(-1).content) : null
      expect(String(init!.body)).not.toContain('Do not send this private text.')
      switch (++step) {
        case 1: expect(String(init!.body)).not.toContain('学刁'); return reply(null, [call('list_notes', {})])
        case 2: expect(result.total).toBe(2); return reply(null, [call('read_note', { name: 'Physics/A.md' })])
        case 3: version = result.version; expect(result.content).toBe(before); return reply(null, [call('edit_note', { name: 'Physics/A.md', version, edits: [{ oldText: '学刁', newText: '学习' }] })])
        case 4: expect(result.saved).toBe('Physics/A.md'); return reply(null, [call('read_note', { name: 'Physics/B.md' })])
        case 5: expect(result.content).toBe(b); return reply(null, [call('create_note', { title: '反射总结', content: '# 反射总结\n\n光与声均可反射。\n\n来源：[光](A.md)、[声](B.md)。\n' })])
        default: expect(result.created).toBe('Physics/反射总结.md'); return reply('错别字已修正，合并文章已创建，来源保留。')
      }
    } })
    const events = await send(app, { kind: 'folder', folder: 'Physics' }, '修正 A 的错别字，然后合并 A 和 B，保留来源。')
    expect(events.filter(event => event.type === 'change')).toHaveLength(2)
    expect((await store.load('Physics/A.md')).content).toBe('# 光\r\n\r\n学习光的反射。\r\n\r\n[来源](https://example.com)\r\n')
    expect((await store.load('Physics/B.md')).content).toBe(b)
    expect((await store.load('Physics/反射总结.md')).content).toContain('光与声均可反射。')
    const change = events.find(event => event.type === 'change' && event.change.kind === 'edit')!
    if (change.type !== 'change') throw new Error()
    const reopened = createApp(store, new EventBus(), { aiSettings: ai })
    const records = await (await reopened.request('/api/ai/changes?folder=Physics', { headers: H })).json()
    expect(records).toContainEqual(change.change)
    const savedEdit = await (await reopened.request('/api/ai/changes/' + change.change.id, { headers: H })).json()
    expect(savedEdit).toMatchObject({ before, after: before.replace('学刁', '学习') })
    expect((await reopened.request('/api/ai/changes/' + change.change.id + '/undo', { method: 'POST', headers: J, body: '{}' })).status).toBe(200)
    expect((await store.load('Physics/A.md')).content).toBe(before)
    expect((await reopened.request('/api/ai/changes/' + change.change.id + '/undo', { method: 'POST', headers: J, body: '{}' })).status).toBe(409)
  })

  it('refuses out-of-scope reads, ambiguous edits and a whole rewrite after only a partial read', async () => {
    const store = await workspace(), original = '# 光\n\n重复词\n\n中间\n\n重复词\n\n结束。\n'
    await store.saveContent('Physics/A.md', original, (await store.load('Physics/A.md')).content)
    let step = 0, version = ''
    const app = createApp(store, new EventBus(), { aiSettings: ai, aiTransport: async (_, init) => {
      const messages = JSON.parse(String(init!.body)).messages, result = messages.at(-1).role === 'tool' ? JSON.parse(messages.at(-1).content) : null
      switch (++step) {
        case 1: return reply(null, [call('read_note', { name: 'Private/Secret.md' })])
        case 2: expect(result.error).toContain('不在当前'); return reply(null, [call('read_note', { name: 'Physics/A.md', limit: 5 })])
        case 3: version = result.version; return reply(null, [call('rewrite_note', { name: 'Physics/A.md', version, content: '# Truncated\n' })])
        case 4: expect(result.error).toContain('尚未读取全文'); return reply(null, [call('edit_note', { name: 'Physics/A.md', version, edits: [{ oldText: '重复词', newText: '只改第二次' }] })])
        case 5: expect(result.error).toContain('出现多次'); return reply(null, [call('edit_note', { name: 'Physics/A.md', version, edits: [{ oldText: '重复词', newText: '只改第二次', occurrence: 2 }] })])
        default: return reply('第二处已修改。')
      }
    } })
    await send(app, { kind: 'note', folder: 'Physics', name: 'Physics/A.md' }, '只改第二处重复词。')
    expect((await store.load('Physics/A.md')).content).toBe('# 光\n\n重复词\n\n中间\n\n只改第二次\n\n结束。\n')
  })

  it('keeps a newer external edit rather than overwriting it with an Agent edit', async () => {
    const store = await workspace(), newer = '# 用户的新内容\n\n不要覆盖。\n'
    let step = 0
    const app = createApp(store, new EventBus(), { aiSettings: ai, aiTransport: async (_, init) => {
      const messages = JSON.parse(String(init!.body)).messages
      if (++step === 1) return reply(null, [call('read_note', { name: 'Physics/A.md' })])
      if (step === 2) {
        const read = JSON.parse(messages.at(-1).content)
        await fs.writeFile(path.join(store.root, 'Physics/A.md'), newer)
        return reply(null, [call('edit_note', { name: 'Physics/A.md', version: read.version, edits: [{ oldText: '学刁', newText: '学习' }] })])
      }
      expect(JSON.parse(messages.at(-1).content).error).toContain('已被修改')
      return reply('检测到新修改，没有写入。')
    } })
    const events = await send(app, { kind: 'note', folder: 'Physics', name: 'Physics/A.md' }, '改错别字。')
    expect(events.some(event => event.type === 'change')).toBe(false)
    expect((await store.load('Physics/A.md')).content).toBe(newer)
  })

  it('persists versioned overviews across the article and updates them after external edits without moving cards', async () => {
    const store = await workspace()
    const content = '# 首节\n\n开头。\n\n## 深处\n\n重要结论只在末尾。\n'
    await store.saveContent('Physics/A.md', content, (await store.load('Physics/A.md')).content)
    await store.list()
    const layout = await fs.readFile(path.join(store.root, '.canvasnote/library.json'), 'utf8')
    const first = (await store.overviews('Physics')).find(note => note.name === 'Physics/A.md')!
    expect(first.overview).toContain('重要结论只在末尾。')
    expect(first.headings).toEqual([{ title: '首节', line: 1 }, { title: '深处', line: 5 }])
    expect(first.overviewSource).toBe('local')
    const semantic = '文章由开头观察展开，在第二节提出仅在末尾出现的重要结论。'
    let step = 0
    const app = createApp(store, new EventBus(), { aiSettings: ai, aiTransport: async (_, init) => {
      const messages = JSON.parse(String(init!.body)).messages, result = messages.at(-1).role === 'tool' ? JSON.parse(messages.at(-1).content) : null
      if (++step === 1) return reply(null, [call('read_note', { name: 'Physics/A.md', limit: 5 })])
      if (step === 2) return reply(null, [call('remember_overview', { name: 'Physics/A.md', version: first.version, overview: semantic })])
      if (step === 3) { expect(result.error).toContain('尚未读取全文'); return reply(null, [call('read_note', { name: 'Physics/A.md', offset: 5 })]) }
      if (step === 4) return reply(null, [call('remember_overview', { name: 'Physics/A.md', version: first.version, overview: semantic })])
      expect(result.markdownUnchanged).toBe(true)
      return reply('已了解这篇文章。')
    } })
    await send(app, { kind: 'note', folder: 'Physics', name: 'Physics/A.md' }, '读一下这篇文章。')
    const remembered = (await new NoteStore(store.root).overviews('Physics')).find(note => note.name === 'Physics/A.md')!
    expect(remembered).toMatchObject({ overview: semantic, overviewSource: 'agent', version: first.version })
    expect((await store.load('Physics/A.md')).content).toBe(content)
    await fs.writeFile(path.join(store.root, 'Physics/A.md'), '# 新标题\n\n外部更新后的新结论。\n')
    const next = (await new NoteStore(store.root).overviews('Physics')).find(note => note.name === 'Physics/A.md')!
    expect(next.version).not.toBe(first.version)
    expect(next.overview).toBe('外部更新后的新结论。')
    expect(next.overviewSource).toBe('local')
    expect(next.title).toBe('新标题')
    expect(await fs.readFile(path.join(store.root, '.canvasnote/library.json'), 'utf8')).toBe(layout)
    expect(await fs.readFile(path.join(store.root, '.canvasnote/overviews.json'), 'utf8')).toContain('外部更新后的新结论。')
  })
})
