import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { compress } from 'hono/compress'
import { serveStatic } from '@hono/node-server/serve-static'
import type { EventBus } from './events'
import { BadNameError, ConflictError, NotFoundError, type NoteStore } from './store'
import { AIRequestError, proposeEdit } from './ai'
import { AISettings, AISettingsError, type AIConnectionInput } from './ai-settings'
import { FolderOpenError, openWorkspaceFolder } from './workspace-folder'
import { ChatGPTConnection, ChatGPTError } from './chatgpt'

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

export function createApp(store: NoteStore, bus: EventBus, opts: { staticDir?: string; aiSettings?: AISettings; chatgpt?: ChatGPTConnection; aiTransport?: typeof fetch; openDirectory?: (root: string) => Promise<void> } = {}) {
  const app = new Hono()
  const ai = opts.aiSettings ?? new AISettings(store.root)
  const chatgpt = opts.chatgpt ?? new ChatGPTConnection(ai.file + '.chatgpt.json', { transport: opts.aiTransport })

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
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) return c.json({ error: '此操作仅打开当前笔记工作区。' }, 400)
    await (opts.openDirectory ?? openWorkspaceFolder)(store.root)
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
