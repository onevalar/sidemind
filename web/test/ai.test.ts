import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AISettings, normalizeAIUrl } from '../server/ai-settings'
import { createApp } from '../server/app'
import { NoteStore } from '../server/store'
import { EventBus } from '../server/events'
import { proposeEdit } from '../server/ai'

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
