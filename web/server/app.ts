import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { stream, streamSSE } from 'hono/streaming'
import { compress } from 'hono/compress'
import { serveStatic } from '@hono/node-server/serve-static'
import type { EventBus } from './events'
import { BadNameError, ConflictError, NotFoundError, type NoteStore } from './store'
import { AIRequestError, chat, proposeEdit } from './ai'
import { AISettings, AISettingsError, type AIConnectionInput } from './ai-settings'
import { FolderOpenError, openWorkspaceFolder } from './workspace-folder'
import { ChatGPTConnection, ChatGPTError } from './chatgpt'
import { NoteAgent, type AgentModel } from './agent'
import type { AgentScope } from '../shared/types'

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

export function createApp(store: NoteStore, bus: EventBus, opts: { staticDir?: string; aiSettings?: AISettings; chatgpt?: ChatGPTConnection; aiTransport?: typeof fetch; openDirectory?: (root: string) => Promise<void> } = {}) {
  const app = new Hono()
  const ai = opts.aiSettings ?? new AISettings(store.root)
  const chatgpt = opts.chatgpt ?? new ChatGPTConnection(ai.file + '.chatgpt.json', { transport: opts.aiTransport })
  const agent = new NoteAgent(store, bus)

  // This server can read and write files on the user's machine and has no login, so:
  //  - only answer requests addressed to localhost (blocks DNS-rebinding from other sites)
  //  - only accept JSON bodies (a cross-site form/fetch can't send that without a CORS preflight)
  app.use('*', async (c, next) => {
    if (!LOCAL_HOSTS.test(c.req.header('host') ?? '')) return c.text('Forbidden', 403)
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      if (!(c.req.header('content-type') ?? '').startsWith('application/json')) {
        return c.text('Expected application/json', 415)
      }
    }
    await next()
  })

  app.onError((err, c) => {
    if (err instanceof BadNameError) return c.json({ error: err.message }, 400)
    if (err instanceof NotFoundError) return c.json({ error: 'Note not found' }, 404)
    if (err instanceof ConflictError) return c.json({ error: err.message }, 409)
    if (err instanceof AISettingsError) return c.json({ error: err.message }, 400)
    if (err instanceof ChatGPTError) return c.json({ error: err.message }, 502)
    if (err instanceof FolderOpenError) return c.json({ error: err.message }, 503)
    console.error(err)
    return c.json({ error: 'Internal error' }, 500)
  })

  app.get('/api/notes', async (c) => c.json(await store.list()))
  app.get('/api/folders', async (c) => c.json(await store.folders()))
  app.post('/api/folders', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (typeof body?.folder !== 'string') return c.json({ error: '请输入文件夹名称。' }, 400)
    await store.createFolder(body.folder)
    bus.emit({ type: 'notes-changed' })
    return c.json({ ok: true }, 201)
  })
  app.put('/api/canvas/positions', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body?.positions) return c.json({ error: '请提供文章位置。' }, 400)
    await store.savePositions(body.positions)
    bus.emit({ type: 'notes-changed' })
    return c.json({ ok: true })
  })
  app.get('/api/canvas', async (c) => c.json(await store.canvas(c.req.query('folder') ?? '')))
  app.put('/api/canvas', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (typeof body?.folder !== 'string') return c.json({ error: '请选择画布文件夹。' }, 400)
    const layout = await store.saveCanvas(body.folder, body.frames, body.positions, body.expectedFrames)
    bus.emit({ type: 'canvas-changed', folder: body.folder })
    return c.json(layout)
  })
  app.get('/api/search', async (c) => c.json(await store.search((c.req.query('q') ?? '').slice(0, 300))))
  app.get('/api/settings', async (c) => c.json({ notesDirectory: store.root, ai: await ai.publicConfig(), chatgpt: await chatgpt.publicConfig() }))
  app.post('/api/workspace/open', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'folder') || body.folder !== undefined && typeof body.folder !== 'string') return c.json({ error: '请选择笔记工作区内的文件夹。' }, 400)
    const directory = await store.folderPath(body.folder ?? '')
    await (opts.openDirectory ?? openWorkspaceFolder)(directory)
    return c.json({ ok: true })
  })
  app.put('/api/ai/connection', async (c) => c.json(await ai.save(await c.req.json().catch(() => null))))
  app.delete('/api/ai/connection', async (c) => c.json(await ai.clear()))
  app.get('/api/ai/chatgpt', async (c) => c.json(await chatgpt.publicConfig()))
  app.get('/api/ai/chatgpt/models', async (c) => c.json(await chatgpt.models()))
  app.post('/api/ai/chatgpt/login', async (c) => {
    // The official callback returns to the computer running this service, not a remote portal.
    let origin: URL
    try { origin = new URL(c.req.header('origin') ?? c.req.url) } catch { return c.json({ error: '请在本机打开应用后登录。' }, 400) }
    if (!LOCAL_HOSTS.test(origin.host) || !['http:', 'https:'].includes(origin.protocol)) return c.json({ error: 'ChatGPT 登录需在运行笔记服务的同一台电脑完成。远程预览不支持此回调。' }, 400)
    const body = await c.req.json().catch(() => null)
    if (!body || (body.accountId !== undefined && typeof body.accountId !== 'string')) return c.json({ error: '请选择 ChatGPT 账号。' }, 400)
    c.header('Cache-Control', 'no-store')
    return c.json(await chatgpt.startLogin(body.accountId))
  })
  app.delete('/api/ai/chatgpt/login', async (c) => { await chatgpt.cancelLogin(); return c.json(await chatgpt.publicConfig()) })
  app.put('/api/ai/chatgpt/account', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body || (body.accountId !== null && typeof body.accountId !== 'string') || (body.model !== undefined && typeof body.model !== 'string')) return c.json({ error: '请选择账号和模型。' }, 400)
    return c.json(await chatgpt.select(body.accountId, body.model))
  })
  app.post('/api/ai/chatgpt/logout', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (typeof body?.accountId !== 'string') return c.json({ error: '请选择要退出的账号。' }, 400)
    return c.json(await chatgpt.signOut(body.accountId))
  })
  app.post('/api/ai/test', async (c) => {
    const connection = await ai.resolve(await c.req.json().catch(() => null) as AIConnectionInput)
    try {
      await proposeEdit(connection, 'Connection test.', 'Return the supplied text unchanged.', c.req.raw.signal, opts.aiTransport)
      return c.json({ ok: true })
    } catch { return c.json({ error: '连接测试未通过，请检查地址、模型名称和密钥。' }, 502) }
  })
  app.post('/api/ai/agent', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 16000 || !['chat', 'note', 'folder'].includes(body.scope?.kind) || typeof body.scope?.folder !== 'string' || (body.scope.kind === 'note' && typeof body.scope.name !== 'string') || (body.session !== undefined && typeof body.session !== 'string') || (body.selection !== undefined && (typeof body.selection !== 'string' || body.selection.length > 20000))) return c.json({ error: '请输入消息并选择对话范围。' }, 400)
    const scope: AgentScope = body.scope.kind === 'note' ? { kind: 'note', folder: body.scope.folder, name: body.scope.name } : { kind: body.scope.kind, folder: body.scope.kind === 'chat' ? '' : body.scope.folder }
    let model: AgentModel
    try {
      const config = await chatgpt.publicConfig()
      if (config.unavailable) throw new ChatGPTError(config.error ?? '无法读取 ChatGPT 连接，请检查设置。')
      const connection = config.activeAccountId ? null : await ai.connection()
      if (!config.activeAccountId && !connection) throw new AIRequestError('尚未连接模型服务，请先在设置中添加连接。')
      model = config.activeAccountId ? (messages, tools, signal) => chatgpt.chat(messages, tools, signal) : (messages, tools, signal) => chat(connection, messages, tools, signal, opts.aiTransport)
    } catch (error) { return c.json({ error: error instanceof ChatGPTError || error instanceof AISettingsError || error instanceof AIRequestError ? error.message : '无法读取模型连接。' }, 502) }
    c.header('Content-Type', 'application/x-ndjson')
    c.header('Cache-Control', 'no-store')
    return stream(c, async output => {
      const controller = new AbortController()
      output.onAbort(() => controller.abort())
      const signal = AbortSignal.any([controller.signal, c.req.raw.signal, AbortSignal.timeout(600000)])
      const emit = async (event: import('../shared/types').AgentEvent) => { if (!output.aborted) await output.write(JSON.stringify(event) + '\n') }
      try { await agent.run({ scope, session: body.session, message: body.message.trim(), ...(scope.kind === 'note' ? { selection: body.selection } : {}) }, model, signal, emit) }
      catch (error) {
        if (!signal.aborted) await emit({ type: 'error', text: error instanceof BadNameError || error instanceof ConflictError || error instanceof ChatGPTError || error instanceof AISettingsError || error instanceof AIRequestError ? error.message : '模型连接中断。已经完成的修改保留在记录中，请检查后再继续。' })
      }
      finally { await emit({ type: 'done' }) }
    })
  })
  app.post('/api/ai/changes/:id/undo', async c => {
    await agent.undo(c.req.param('id'))
    return c.json({ ok: true })
  })
  app.get('/api/ai/changes/:id', async c => c.json(await agent.change(c.req.param('id'))))
  app.get('/api/ai/changes', async c => c.json(await agent.changes(c.req.query('folder') ?? '', c.req.query('name'))))
  app.post('/api/ai/propose', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body.source !== 'string' || typeof body.instruction !== 'string' || !body.source.trim() || !body.instruction.trim() || body.source.length > 100000 || body.instruction.length > 5000) return c.json({ error: '请选择内容并输入修改要求。' }, 400)
    try {
      const config = await chatgpt.publicConfig()
      if (config.unavailable) throw new ChatGPTError(config.error ?? '无法读取 ChatGPT 连接，请检查设置。')
      const replacement = config.activeAccountId ? await chatgpt.propose(body.source, body.instruction, c.req.raw.signal) : await proposeEdit(await ai.connection(), body.source, body.instruction, c.req.raw.signal, opts.aiTransport)
      return c.json({ replacement })
    } catch (e) { return c.json({ error: e instanceof ChatGPTError || e instanceof AISettingsError || e instanceof AIRequestError ? e.message : '无法连接模型服务，请检查设置后重试。' }, 502) }
  })

  app.post('/api/notes', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    if (body?.content !== undefined && (typeof body.content !== 'string' || body.content.length > 2000000)) return c.json({ error: 'Invalid content' }, 400)
    if (body?.folder !== undefined && typeof body.folder !== 'string') return c.json({ error: '文件夹路径无效。' }, 400)
    const name = await store.create(typeof body?.name === 'string' ? body.name : undefined, body?.content, body?.folder)
    bus.emit({ type: 'notes-changed' })
    return c.json({ name }, 201)
  })

  app.get('/api/notes/:name', async (c) => c.json(await store.load(c.req.param('name'))))

  app.post('/api/notes/:name/open', async (c) => {
    await store.recordOpen(c.req.param('name'))
    bus.emit({ type: 'notes-changed' })
    return c.json({ ok: true })
  })

  app.put('/api/notes/:name/content', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body.content !== 'string' || typeof body.expectedContent !== 'string' || body.content.length > 2000000) return c.json({ error: 'content and expectedContent required' }, 400)
    const name = c.req.param('name')
    await store.saveContent(name, body.content, body.expectedContent)
    bus.emit({ type: 'note-changed', name }); bus.emit({ type: 'notes-changed' })
    return c.json(await store.load(name))
  })

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      let closed = false
      const unsubscribe = bus.subscribe((event) => {
        if (!closed) void stream.writeSSE({ data: JSON.stringify(event) })
      })
      stream.onAbort(() => {
        closed = true
        unsubscribe()
      })
      await stream.writeSSE({ data: JSON.stringify({ type: 'hello' }) })
      // Keep the connection alive until the browser goes away.
      while (!closed) {
        await stream.sleep(15000)
        if (!closed) await stream.writeSSE({ event: 'ping', data: '' })
      }
    }),
  )

  // Production: serve the built frontend from the same origin.
  if (opts.staticDir && fs.existsSync(opts.staticDir)) {
    const rel = path.relative(process.cwd(), opts.staticDir)
    // Compress only built resources, never the live event stream or note responses.
    app.use('/assets/*', compress())
    app.use('/*', serveStatic({ root: rel }))
    app.get('*', serveStatic({ path: path.join(rel, 'index.html') }))
  }

  return app
}
