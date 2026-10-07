import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { serveStatic } from '@hono/node-server/serve-static'
import type { EventBus } from './events'
import { BadNameError, NotFoundError, type NoteStore } from './store'

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

export function createApp(store: NoteStore, bus: EventBus, opts: { staticDir?: string } = {}) {
  const app = new Hono()

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
    console.error(err)
    return c.json({ error: 'Internal error' }, 500)
  })

  app.get('/api/notes', async (c) => c.json(await store.list()))

  app.post('/api/notes', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const name = await store.create(typeof body?.name === 'string' ? body.name : undefined)
    bus.emit({ type: 'notes-changed' })
    return c.json({ name }, 201)
  })

  app.get('/api/notes/:name', async (c) => c.json(await store.load(c.req.param('name'))))

  app.put('/api/notes/:name/positions', async (c) => {
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body.positions !== 'object' || body.positions === null) {
      return c.json({ error: 'positions required' }, 400)
    }
    await store.savePositions(c.req.param('name'), body.positions)
    return c.json({ ok: true })
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
    app.use('/*', serveStatic({ root: rel }))
    app.get('*', serveStatic({ path: path.join(rel, 'index.html') }))
  }

  return app
}
