import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../server/app'
import { EventBus } from '../server/events'
import { NoteStore } from '../server/store'
import type { CanvasFrame, CanvasLayout } from '../shared/types'

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
  it('creates real folders and creates, loads, saves and searches nested whole articles', async () => {
    const list = await (await app.request('/api/notes', { headers: H })).json()
    expect(list).toHaveLength(1)
    expect(await (await app.request('/api/folders', { headers: H })).json()).toEqual([''])
    for (const folder of ['Work', 'Work/Research']) {
      const response = await app.request('/api/folders', { method: 'POST', headers: J, body: JSON.stringify({ folder }) })
      expect(response.status).toBe(201)
      expect((await fs.stat(path.join(dir, folder))).isDirectory()).toBe(true)
    }
    expect(await (await app.request('/api/folders', { headers: H })).json()).toEqual(['', 'Work', 'Work/Research'])
    const content = '# Garden\r\n\r\nA botanical observation.\r\n'
    const created = await app.request('/api/notes', { method: 'POST', headers: J, body: JSON.stringify({ name: 'Garden notes', folder: 'Work/Research', content }) })
    expect(created.status).toBe(201)
    const { name } = await created.json()
    expect(name).toBe('Work/Research/Garden notes.md')
    const url = `/api/notes/${encodeURIComponent(name)}`
    expect(await (await app.request(url, { headers: H })).json()).toEqual({ name, space: 'Work/Research', content })
    const replacement = '# Garden revised\n\nA botanical discovery.\n'
    const saved = await app.request(url + '/content', { method: 'PUT', headers: J, body: JSON.stringify({ content: replacement, expectedContent: content }) })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual({ name, space: 'Work/Research', content: replacement })
    expect(await fs.readFile(path.join(dir, name), 'utf8')).toBe(replacement)
    expect((await app.request(url + '/content', { method: 'PUT', headers: J, body: JSON.stringify({ content: 'stale', expectedContent: content }) })).status).toBe(409)
    expect(await (await app.request('/api/search?q=BOTANICAL', { headers: H })).json()).toEqual([expect.objectContaining({ name, space: 'Work/Research', title: 'Garden revised', snippet: expect.stringContaining('botanical discovery') })])
  })

  it('PUT /api/canvas/positions persists article coordinates without touching Markdown', async () => {
    await fs.mkdir(path.join(dir, 'Work'))
    await fs.writeFile(path.join(dir, 'Work', 'Welcome.md'), '# Nested\r\n\r\nBody.\r\n')
    const positions = { 'Welcome.md': { x: -593, y: 127 }, 'Work/Welcome.md': { x: 281, y: -907 } }
    const originals = await Promise.all(Object.keys(positions).map(async name => ({ name, content: await fs.readFile(path.join(dir, name), 'utf8'), mtime: (await fs.stat(path.join(dir, name))).mtimeMs })))
    const res = await app.request('/api/canvas/positions', {
      method: 'PUT', headers: J, body: JSON.stringify({ positions }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const restarted = createApp(new NoteStore(dir), new EventBus())
    for (const current of [app, restarted]) {
      const notes = await (await current.request('/api/notes', { headers: H })).json()
      for (const [name, position] of Object.entries(positions)) expect(notes.find((note: { name: string }) => note.name === name)).toMatchObject({ name, position })
    }
    for (const { name, content, mtime } of originals) {
      expect(await fs.readFile(path.join(dir, name), 'utf8')).toBe(content)
      expect((await fs.stat(path.join(dir, name))).mtimeMs).toBe(mtime)
    }
  })

  it('validates folder creation and canvas position requests', async () => {
    for (const body of [{}, { folder: 7 }, { folder: '../outside' }, { folder: '.private' }]) {
      expect((await app.request('/api/folders', { method: 'POST', headers: J, body: JSON.stringify(body) })).status).toBe(400)
    }
    for (const body of [{}, { positions: [] }, { positions: { 'Welcome.md': { x: null, y: 3 } } }, { positions: { '../outside.md': { x: 17, y: -61 } } }]) {
      expect((await app.request('/api/canvas/positions', { method: 'PUT', headers: J, body: JSON.stringify(body) })).status).toBe(400)
    }
    expect((await app.request('/api/canvas/positions', { method: 'PUT', headers: J, body: JSON.stringify({ positions: { 'Missing.md': { x: -31, y: 71 } } }) })).status).toBe(404)
  })

  it('moves frame members by one shared delta, detaches and dissolves without changing Markdown or unrelated positions', async () => {
    const sources = { 'A.md': '# A\r\n\r\nFirst article.\r\n', 'B.md': '# B\n\nSecond article.\n' }
    for (const [name, source] of Object.entries(sources)) {
      await fs.writeFile(path.join(dir, name), source)
      await fs.utimes(path.join(dir, name), 1234567890, 1234567890)
    }
    const get = async (current = app) => (await (await current.request('/api/canvas?folder=', { headers: H })).json()) as CanvasLayout
    const save = async (frames: CanvasFrame[], positions: CanvasLayout['positions'] = {}) => {
      const expectedFrames = (await get()).frames
      const response = await app.request('/api/canvas', { method: 'PUT', headers: J, body: JSON.stringify({ folder: '', frames, positions, expectedFrames }) })
      expect(response.status).toBe(200)
      return await response.json() as CanvasLayout
    }
    await save([], { 'A.md': { x: 73, y: -51 }, 'B.md': { x: 392, y: 88 }, 'Welcome.md': { x: -593, y: 127 } })
    const frame: CanvasFrame = { id: 'reading', space: '', title: '阅读资料', position: { x: 40, y: -120 }, width: 720, height: 448, members: ['A.md', 'B.md'] }
    const created = await save([frame])
    expect(created.positions['A.md']).toEqual({ x: 73, y: -51 })
    expect((await get(createApp(new NoteStore(dir), new EventBus()))).frames).toEqual([frame])
    const moved = { ...frame, position: { x: -91, y: 173 } }
    expect((await save([moved])).positions).toEqual({ 'A.md': { x: -58, y: 242 }, 'B.md': { x: 261, y: 381 }, 'Welcome.md': { x: -593, y: 127 } })
    const renamed = { ...moved, title: '阅读与摘录', width: 800, height: 500 }
    expect((await save([renamed])).positions['B.md']).toEqual({ x: 261, y: 381 })
    const detached = { ...renamed, members: ['B.md'] }
    await save([detached], { 'A.md': { x: -410, y: 702 } })
    const again = { ...detached, position: { x: 127, y: -41 } }
    const expected = { 'A.md': { x: -410, y: 702 }, 'B.md': { x: 479, y: 167 }, 'Welcome.md': { x: -593, y: 127 } }
    expect((await save([again])).positions).toEqual(expected)
    expect((await save([])).positions).toEqual(expected)
    expect(await get(createApp(new NoteStore(dir), new EventBus()))).toEqual({ frames: [], positions: expected })
    for (const [name, source] of Object.entries(sources)) {
      expect(await fs.readFile(path.join(dir, name), 'utf8')).toBe(source)
      expect((await fs.stat(path.join(dir, name))).mtimeMs).toBe(1234567890000)
    }
  })

  it('isolates frame layouts by folder and rejects duplicate membership, invalid frames and stale group writes atomically', async () => {
    await fs.mkdir(path.join(dir, 'Work'))
    await fs.writeFile(path.join(dir, 'Work', 'A.md'), '# Nested article')
    const root = await (await app.request('/api/canvas?folder=', { headers: H })).json() as CanvasLayout
    const frame: CanvasFrame = { id: 'reading', space: '', title: '阅读资料', position: { x: -39, y: 17 }, width: 640, height: 320, members: ['Welcome.md'] }
    const request = (folder: string, frames: CanvasFrame[], positions: CanvasLayout['positions'] = {}, expectedFrames: CanvasFrame[] = []) => app.request('/api/canvas', { method: 'PUT', headers: J, body: JSON.stringify({ folder, frames, positions, expectedFrames }) })
    expect((await request('', [frame])).status).toBe(200)
    const nested = { ...frame, id: 'project', space: 'Work', members: ['Work/A.md'] }
    expect((await request('Work', [nested])).status).toBe(200)
    // Layout is split per folder: canvas/_canvas.json (root) and canvas/Work/_canvas.json.
    const layoutFiles = [path.join(dir, '.canvasnote', 'canvas', '_canvas.json'), path.join(dir, '.canvasnote', 'canvas', 'Work', '_canvas.json')]
    const snapshot = () => Promise.all(layoutFiles.map(file => fs.readFile(file, 'utf8'))), original = await snapshot()
    expect(JSON.parse(original[1]!)).toMatchObject({ frames: [{ id: 'project', members: ['A.md'] }] })
    for (const frames of [[{ ...frame, title: ' ' }], [{ ...frame, width: 20 }], [{ ...frame, position: { x: null, y: 4 } }], [frame, { ...frame, id: 'second' }], [{ ...frame, members: ['Work/A.md'] }], [{ ...frame, members: ['../outside.md'] }]]) {
      expect((await request('', frames as CanvasFrame[], {}, [frame])).status).toBe(400)
      expect(await snapshot()).toEqual(original)
    }
    expect((await request('', [frame], { 'Work/A.md': { x: 5, y: -17 } }, [frame])).status).toBe(400)
    expect((await request('', [frame], { 'Missing.md': { x: 5, y: -17 } }, [frame])).status).toBe(404)
    expect((await request('', [{ ...frame, title: 'stale' }], { 'Welcome.md': { x: 313, y: -719 } })).status).toBe(409)
    expect(await snapshot()).toEqual(original)
    expect(await (await app.request('/api/canvas?folder=Work', { headers: H })).json()).toMatchObject({ frames: [nested] })
    expect(await (await app.request('/api/canvas?folder=', { headers: H })).json()).toEqual({ frames: [frame], positions: root.positions })
  })

  it('returns a layout conflict without overwriting malformed library data or blocking Markdown reads', async () => {
    const original = await fs.readFile(path.join(dir, 'Welcome.md'), 'utf8')
    const library = path.join(dir, '.canvasnote', 'canvas', '_canvas.json')
    await fs.writeFile(library, '{broken')
    expect((await app.request('/api/notes', { headers: H })).status).toBe(409)
    expect((await app.request('/api/canvas/positions', { method: 'PUT', headers: J, body: JSON.stringify({ positions: { 'Welcome.md': { x: 107, y: -389 } } }) })).status).toBe(409)
    const loaded = await app.request('/api/notes/Welcome.md', { headers: H })
    expect(loaded.status).toBe(200)
    expect((await loaded.json()).content).toBe(original)
    expect(await fs.readFile(library, 'utf8')).toBe('{broken')
  })

  it('404s on a missing note and 400s on a bad name', async () => {
    expect((await app.request('/api/notes/nope.md', { headers: H })).status).toBe(404)
    for (const name of ['x.txt', '../outside.md', 'Work/../outside.md', '.private.md', '.canvasnote/private.md']) {
      expect((await app.request('/api/notes/' + encodeURIComponent(name), { headers: H })).status, name).toBe(400)
    }
  })

  it('refuses non-local Host headers (DNS rebinding) and non-JSON writes', async () => {
    expect((await app.request('/api/notes', { headers: { host: 'evil.example.com' } })).status).toBe(403)
    const res = await app.request('/api/notes', { method: 'POST', headers: { ...H, 'content-type': 'text/plain' }, body: '{}' })
    expect(res.status).toBe(415)
  })

  it('compresses built assets without changing their content, plain delivery or API responses', async () => {
    const staticDir = path.join(dir, '.static'), content = '/* 资源压缩检查 */\n' + 'export const message = "保留完整内容";\n'.repeat(100)
    await fs.mkdir(path.join(staticDir, 'assets'), { recursive: true })
    await fs.writeFile(path.join(staticDir, 'assets', 'app.js'), content)
    const production = createApp(new NoteStore(dir), new EventBus(), { staticDir })
    const compressed = await production.request('/assets/app.js', { headers: { ...H, 'accept-encoding': 'gzip' } })
    expect(compressed.status).toBe(200)
    expect(compressed.headers.get('content-encoding')).toBe('gzip')
    const body = Buffer.from(await compressed.arrayBuffer())
    expect(body.length).toBeLessThan(Buffer.byteLength(content))
    expect(gunzipSync(body).toString()).toBe(content)
    const plain = await production.request('/assets/app.js', { headers: H })
    expect(plain.headers.get('content-encoding')).toBeNull()
    expect(await plain.text()).toBe(content)
    const notes = await production.request('/api/notes', { headers: { ...H, 'accept-encoding': 'gzip' } })
    expect(notes.headers.get('content-encoding')).toBeNull()
    expect(await notes.json()).toHaveLength(1)
  })
})
