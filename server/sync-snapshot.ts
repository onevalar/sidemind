import type { CanvasLayout, NoteDTO, NoteSummary } from '../shared/types'
import { NotFoundError, type NoteStore } from './store'
import type { EventBus } from './events'

type Snapshot = { notes: NoteSummary[]; folders: string[]; contents: Map<string, NoteDTO>; canvases: Map<string, CanvasLayout> }

/** Read-only, coherent view while sync owns the workspace transaction (including Git merge). */
export class SyncReadSnapshot {
  private pending: Promise<Snapshot | null> | null = null
  constructor(private store: NoteStore, private bus: EventBus) {}

  async run<T>(action: () => Promise<T>): Promise<T> {
    let publish!: (snapshot: Snapshot | null) => void
    this.pending = new Promise(resolve => { publish = resolve })
    let snapshot: Snapshot | null = null
    try {
      return await this.store.writer.run(async () => {
        const notes = await this.store.list(), folders = await this.store.folders()
        const contents = new Map<string, NoteDTO>(), canvases = new Map<string, CanvasLayout>()
        for (const note of notes) contents.set(note.name, await this.store.load(note.name))
        for (const folder of folders) canvases.set(folder, await this.store.canvas(folder))
        snapshot = { notes, folders, contents, canvases }
        publish(snapshot)
        return action()
      })
    } finally {
      // Release the view only after the writer releases its transaction. Failed capture must also unblock readers.
      this.pending = null
      publish(null)
      this.bus.emit({ type: 'notes-changed' })
      if (snapshot) {
        // Also invalidate names added by a pull. Reads now observe the committed working tree.
        const current = await this.store.list().catch(() => [])
        const previous = snapshot as Snapshot
        for (const name of new Set([...previous.contents.keys(), ...current.map(note => note.name)])) this.bus.emit({ type: 'note-changed', name })
        for (const folder of new Set([...previous.folders, ...current.map(note => note.space)])) this.bus.emit({ type: 'canvas-changed', folder })
      }
    }
  }
  async list() { return (await this.pending)?.notes ?? this.store.list() }
  async folders() { return (await this.pending)?.folders ?? this.store.folders() }
  async load(name: string) {
    const snapshot = await this.pending
    if (!snapshot) return this.store.load(name)
    const note = snapshot.contents.get(name)
    if (!note) throw new NotFoundError(name)
    return note
  }
  async canvas(folder: string) {
    const snapshot = await this.pending
    if (!snapshot) return this.store.canvas(folder)
    const canvas = snapshot.canvases.get(folder)
    if (!canvas) throw new NotFoundError(folder)
    return canvas
  }
}
