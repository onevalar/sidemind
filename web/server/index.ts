import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { createApp } from './app'
import { EventBus } from './events'
import { NoteStore } from './store'
import { watchNotes } from './watcher'
import { openDataRepo } from './repo'

const here = path.dirname(fileURLToPath(import.meta.url))
// One Git repository holds all app data (notes/, memory/, canvas/). NOTES_DIR is the v0.2 name and is migrated in place.
const root = process.env.CANVAS_DATA_DIR ?? process.env.NOTES_DIR ?? path.resolve(here, '../workspace')
const port = Number(process.env.PORT ?? 3001)

const { paths, git, migrated } = await openDataRepo(root)
const store = new NoteStore(paths)
await store.init()
const bus = new EventBus()
watchNotes(store.root, bus)

const app = createApp(store, bus, { staticDir: path.resolve(here, '../dist'), git })
// Bind to loopback only: this server edits local files and has no authentication.
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
  console.log(`画布笔记 API  http://127.0.0.1:${port}`)
  console.log(`数据仓库      ${paths.root}${git ? '' : '（未找到 git，推送不可用）'}`)
  if (migrated) console.log('已将旧版工作区迁移为数据仓库结构：笔记位于 notes/，布局位于 canvas/。迁移不会自动提交。')
})
