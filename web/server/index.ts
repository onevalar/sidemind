import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { createApp } from './app'
import { EventBus } from './events'
import { NoteStore } from './store'
import { watchNotes } from './watcher'
import { openDataRepo } from './repo'
import { acquireWorkspace } from './workspace-lock'
import { ChangeEngine } from './changes'
import { MemoryFiles } from './memory-files'

const here = path.dirname(fileURLToPath(import.meta.url))
// One Git repository holds all app data (notes/, memory/, canvas/). NOTES_DIR is the v0.2 name and is migrated in place.
const root = process.env.CANVAS_DATA_DIR ?? process.env.NOTES_DIR ?? path.resolve(here, '../workspace')
const port = Number(process.env.PORT ?? 3001)

await fs.mkdir(root, { recursive: true })
const release = await acquireWorkspace(root)
const { paths, git, migrated } = await openDataRepo(root)
const store = new NoteStore(paths)
const bus = new EventBus()
await new ChangeEngine(store, new MemoryFiles(paths.memory, store.writer), bus).recover()
await store.init()
const watcher = watchNotes(store.root, bus)
const shutdown = new AbortController(), tasks = new Set<Promise<unknown>>()

const app = createApp(store, bus, { staticDir: path.resolve(here, '../dist'), git, shutdown: shutdown.signal, tasks })
// Bind to loopback only: this server edits local files and has no authentication.
const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
  console.log(`Sidemind API  http://127.0.0.1:${port}`)
  console.log(`数据仓库      ${paths.root}${git ? '' : '（未找到 git，推送不可用）'}`)
  if (migrated) console.log('已将旧版工作区迁移为数据仓库结构：笔记位于 notes/，布局位于 canvas/。迁移不会自动提交。')
})

async function stop() {
  if (shutdown.signal.aborted) return
  shutdown.abort()
  server.close()
  if ('closeAllConnections' in server) server.closeAllConnections()
  await watcher.close()
  await Promise.allSettled([...tasks])
  // Drain writes already accepted before allowing another process to open the workspace.
  await store.writer.run(async () => {})
  await release()
  process.exit(0)
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void stop().catch(error => { console.error(error); process.exit(1) }) })
