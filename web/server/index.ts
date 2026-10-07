import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { createApp } from './app'
import { EventBus } from './events'
import { NoteStore } from './store'
import { watchNotes } from './watcher'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = process.env.NOTES_DIR ?? path.resolve(here, '../workspace')
const port = Number(process.env.PORT ?? 3001)

const store = new NoteStore(root)
await store.init()
const bus = new EventBus()
watchNotes(store.root, bus)

const app = createApp(store, bus, { staticDir: path.resolve(here, '../dist') })
// Bind to loopback only: this server edits local files and has no authentication.
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
  console.log(`画布笔记 API  http://127.0.0.1:${port}`)
  console.log(`笔记文件夹    ${store.root}`)
})
