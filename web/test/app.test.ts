import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../server/app'
import { EventBus } from '../server/events'
import { NoteStore } from '../server/store'

let dir: string
let app: ReturnType<typeof createApp>
const H = { host: 'localhost:3001' }
const J = { ...H, 'content-type': 'application/json' }

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cn-api-'))
  const store = new NoteStore(dir)
  await store.init()
  app = createApp(store, new EventBus())
})
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

describe('API', () => {
  it('lists, creates and loads notes', async () => {
    const list = await (await app.request('/api/notes', { headers: H })).json()
    expect(list).toHaveLength(1)
    const created = await app.request('/api/notes', { method: 'POST', headers: J, body: '{}' })
    expect(created.status).toBe(201)
    const { name } = await created.json()
    const note = await (await app.request(`/api/notes/${encodeURIComponent(name)}`, { headers: H })).json()
    expect(note.blocks.length).toBeGreaterThan(0)
  })

  it('saves positions', async () => {
    const note = await (await app.request('/api/notes/Welcome.md', { headers: H })).json()
    const id = note.blocks[0].id
    const res = await app.request('/api/notes/Welcome.md/positions', {
      method: 'PUT', headers: J, body: JSON.stringify({ positions: { [id]: { x: 5, y: 6 } } }),
    })
    expect(res.status).toBe(200)
    const again = await (await app.request('/api/notes/Welcome.md', { headers: H })).json()
    expect(again.blocks[0]).toMatchObject({ x: 5, y: 6 })
  })

  it('404s on a missing note and 400s on a bad name', async () => {
    expect((await app.request('/api/notes/nope.md', { headers: H })).status).toBe(404)
    expect((await app.request('/api/notes/x.txt', { headers: H })).status).toBe(400)
  })

  it('refuses non-local Host headers (DNS rebinding) and non-JSON writes', async () => {
    expect((await app.request('/api/notes', { headers: { host: 'evil.example.com' } })).status).toBe(403)
    const res = await app.request('/api/notes', { method: 'POST', headers: { ...H, 'content-type': 'text/plain' }, body: '{}' })
    expect(res.status).toBe(415)
  })
})
