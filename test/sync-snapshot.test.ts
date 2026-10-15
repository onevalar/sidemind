import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SyncReadSnapshot } from '../server/sync-snapshot'
import { NoteStore } from '../server/store'
import { EventBus, type ServerEvent } from '../server/events'
let dir: string
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
afterEach(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }) })
it('serves coherent notes and canvas while sync holds the writer; refreshes afterwards and retains edit CAS', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sidemind-sync-view-'))
  const store = new NoteStore(dir); await store.init(); await store.createFolder('Work')
  const name = await store.create('A', '# Original', 'Work')
  const bus = new EventBus(), events: ServerEvent[] = []; bus.subscribe(event => events.push(event))
  const view = new SyncReadSnapshot(store, bus), began = gate(), release = gate()
  const beforeNotes = await store.list(), beforeCanvas = await store.canvas('Work')
  const sync = view.run(async () => {
    // Simulates remote merge while a Git hook/network/model operation holds the transaction.
    await store.saveContent(name, '# Pulled', '# Original')
    await store.create('Remote', '# Remote', 'Work')
    began.resolve(); await release.promise
  })
  await began.promise
  const reads = Promise.all([view.list(), view.folders(), view.load(name), view.canvas('Work')])
  const [notes, folders, note, canvas] = await Promise.race([reads, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('reads blocked by sync')), 500); reads.finally(() => clearTimeout(timer)) })])
  expect(notes).toEqual(beforeNotes); expect(folders).toContain('Work'); expect(note.content).toBe('# Original'); expect(canvas).toEqual(beforeCanvas)
  await expect(view.load('../outside.md')).rejects.toThrow()
  await expect(view.canvas('../outside')).rejects.toThrow()
  let saveSettled = false
  const save = store.saveContent(name, '# User draft', '# Original').then(() => 'saved', () => 'conflict').finally(() => { saveSettled = true })
  expect(saveSettled).toBe(false)
  release.resolve(); await sync
  expect(await save).toBe('conflict')
  expect((await view.load(name)).content).toBe('# Pulled')
  expect((await view.list()).map(note => note.name)).toContain('Work/Remote.md')
  expect(events).toContainEqual({ type: 'notes-changed' })
  expect(events).toContainEqual({ type: 'note-changed', name: 'Work/Remote.md' })
  expect(events).toContainEqual({ type: 'canvas-changed', folder: 'Work' })
})
it('clears the snapshot and releases readers after synchronization failure', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sidemind-sync-view-'))
  const store = new NoteStore(dir); await store.init()
  const view = new SyncReadSnapshot(store, new EventBus())
  await expect(view.run(async () => { throw new Error('network failed') })).rejects.toThrow('network failed')
  await store.create('After', '# After')
  expect((await view.list()).map(note => note.name)).toContain('After.md')
})
