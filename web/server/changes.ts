import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChangeSetSummary } from '../shared/types'
import { BadNameError, ConflictError, NotFoundError, folderOf, type LayoutPatch, type NoteStore } from './store'
import type { MemoryFiles } from './memory-files'
import type { EventBus } from './events'

export type FileArea = 'notes' | 'memory'
/** `before === null` creates, `after === null` deletes. A rename is a delete plus a create. */
export type FileOp = { area: FileArea; name: string; before: string | null; after: string | null }
export type LayoutOp = { folder: string; before: LayoutPatch; after: LayoutPatch }
export type ChangeSet = {
  version: 1
  id: string
  createdAt: number
  updatedAt: number
  conversation?: string
  /** The user's request that produced these changes, for the change list. */
  request: string
  origin: 'request' | 'proposal'
  files: FileOp[]
  layouts: LayoutOp[]
  undone?: boolean
}

const MAX_RECORDS = 300

/**
 * Every Agent write goes through here. A batch is atomic (validated, applied, rolled back on failure),
 * and all batches of one user request accumulate into one change set that can be undone as a whole.
 */
export class ChangeEngine {
  private readonly directory: string
  constructor(private store: NoteStore, private memory: MemoryFiles, private bus: EventBus) {
    this.directory = path.join(store.paths.cache, 'changesets')
  }

  begin(request: string, options: { conversation?: string; origin?: ChangeSet['origin'] } = {}): ChangeSet {
    const now = Date.now()
    return { version: 1, id: randomUUID(), createdAt: now, updatedAt: now, request: request.slice(0, 300), origin: options.origin ?? 'request', files: [], layouts: [], ...(options.conversation ? { conversation: options.conversation } : {}) }
  }

  private area(area: FileArea) { return area === 'notes' ? this.store : this.memory }

  /** Applies all file operations or none. Layout patches are applied after the files succeed. */
  async apply(set: ChangeSet | null, files: FileOp[], layouts: { folder: string; patch: LayoutPatch }[] = []): Promise<void> {
    const keys = new Set<string>()
    for (const op of files) {
      const key = op.area + ':' + op.name
      if (keys.has(key)) throw new BadNameError('同一批操作中重复修改了「' + op.name + '」。')
      keys.add(key)
      if (op.before === op.after) throw new BadNameError('空操作。')
    }
    const done: FileOp[] = []
    try {
      for (const op of files) { await this.area(op.area).replaceFile(op.name, op.before, op.after); done.push(op) }
    } catch (error) {
      const failed: string[] = []
      for (const op of done.reverse()) {
        try { await this.area(op.area).replaceFile(op.name, op.after, op.before) } catch { failed.push(op.name) }
      }
      if (failed.length) throw new ConflictError('操作失败且部分文件无法回滚：' + failed.join('、') + '。请检查这些文件。')
      throw error
    }
    const layoutOps: LayoutOp[] = []
    for (const { folder, patch } of layouts) layoutOps.push({ folder, before: await this.store.patchLayout(folder, patch), after: patch })
    this.emit(files, layoutOps)
    if (!set) return
    for (const op of files) this.merge(set, op)
    for (const op of layoutOps) {
      const existing = set.layouts.find(item => item.folder === op.folder)
      if (!existing) { set.layouts.push(op); continue }
      // Keep the earliest "before" of each touched entry and the latest "after".
      for (const [name, position] of Object.entries(op.before.positions)) if (!(name in existing.before.positions)) existing.before.positions[name] = position
      Object.assign(existing.after.positions, op.after.positions)
      if (op.after.frames) { if (!existing.before.frames) existing.before.frames = op.before.frames; existing.after.frames = op.after.frames }
    }
    set.updatedAt = Date.now()
    if (set.files.length || set.layouts.length) await this.save(set)
  }

  private merge(set: ChangeSet, op: FileOp): void {
    const index = set.files.findIndex(item => item.area === op.area && item.name === op.name)
    if (index < 0) { set.files.push({ ...op }); return }
    const merged = { ...set.files[index]!, after: op.after }
    if (merged.before === merged.after) set.files.splice(index, 1)
    else set.files[index] = merged
  }

  private emit(files: FileOp[], layouts: LayoutOp[]): void {
    const notes = files.filter(op => op.area === 'notes')
    for (const op of notes) if (op.after !== null) this.bus.emit({ type: 'note-changed', name: op.name })
    if (notes.length) this.bus.emit({ type: 'notes-changed' })
    if (files.some(op => op.area === 'memory')) this.bus.emit({ type: 'memory-changed' })
    for (const folder of new Set([...layouts.map(op => op.folder), ...notes.map(op => folderOf(op.name))])) this.bus.emit({ type: 'canvas-changed', folder })
  }

  private async save(set: ChangeSet): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true })
    const file = path.join(this.directory, set.id + '.json'), tmp = file + '.' + randomUUID() + '.tmp'
    try { await fs.writeFile(tmp, JSON.stringify(set), 'utf8'); await fs.rename(tmp, file) }
    finally { await fs.rm(tmp, { force: true }) }
  }

  async get(id: string): Promise<ChangeSet> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new BadNameError('修改记录无效。')
    try { return JSON.parse(await fs.readFile(path.join(this.directory, id + '.json'), 'utf8')) as ChangeSet }
    catch { throw new NotFoundError('找不到修改记录。') }
  }

  /** Whether every touched file and layout entry is still exactly as this change set left it. */
  async undoable(set: ChangeSet): Promise<boolean> {
    if (set.undone) return false
    for (const op of set.files) if (await this.current(op) !== op.after) return false
    return true
  }

  private async current(op: FileOp): Promise<string | null> {
    if (op.area === 'memory') return this.memory.read(op.name)
    try { return (await this.store.load(op.name)).content } catch (error) { if (error instanceof NotFoundError) return null; throw error }
  }

  async undo(id: string): Promise<ChangeSet> {
    const set = await this.get(id)
    if (set.undone) throw new ConflictError('这组修改已经撤销。')
    const changed: string[] = []
    for (const op of set.files) if (await this.current(op) !== op.after) changed.push(op.name)
    if (changed.length) throw new ConflictError('这些文件在之后又被修改，为避免覆盖，未撤销：' + changed.join('、'))
    // Restore creations last-to-first so a rename's target is removed before its source returns.
    const reverse = [...set.files].reverse().map(op => ({ ...op, before: op.after, after: op.before }))
    await this.apply(null, reverse)
    for (const layout of set.layouts) {
      try { await this.store.replaceLayout(layout.folder, layout.after, layout.before) } catch { /* Positions may have been moved by hand since; text is already restored. */ }
    }
    for (const folder of new Set(set.layouts.map(layout => layout.folder))) this.bus.emit({ type: 'canvas-changed', folder })
    set.undone = true
    await this.save(set)
    return set
  }

  async list(filter: { folder?: string; name?: string; conversation?: string } = {}): Promise<ChangeSetSummary[]> {
    let files: string[]
    try { files = (await fs.readdir(this.directory)).filter(file => /^[a-f0-9-]{36}\.json$/.test(file)) } catch { return [] }
    const sets: ChangeSet[] = []
    for (const file of files) { try { sets.push(JSON.parse(await fs.readFile(path.join(this.directory, file), 'utf8'))) } catch { /* skip unreadable record */ } }
    sets.sort((a, b) => b.updatedAt - a.updatedAt)
    for (const stale of sets.slice(MAX_RECORDS)) await fs.rm(path.join(this.directory, stale.id + '.json'), { force: true })
    const result: ChangeSetSummary[] = []
    for (const set of sets.slice(0, MAX_RECORDS)) {
      const notes = set.files.filter(op => op.area === 'notes')
      if (filter.conversation && set.conversation !== filter.conversation) continue
      if (filter.name && !notes.some(op => op.name === filter.name)) continue
      if (filter.folder && !notes.some(op => op.name.startsWith(filter.folder + '/')) && !set.layouts.some(op => op.folder === filter.folder || op.folder.startsWith(filter.folder + '/'))) continue
      result.push(summarize(set, await this.undoable(set)))
    }
    return result
  }
}

export function summarize(set: ChangeSet, undoable: boolean): ChangeSetSummary {
  return {
    id: set.id, request: set.request, createdAt: set.createdAt, origin: set.origin, undone: !!set.undone, undoable,
    files: set.files.filter(op => op.area === 'notes').map(op => ({ name: op.name, kind: op.before === null ? 'create' : op.after === null ? 'delete' : 'edit' })),
    memory: set.files.filter(op => op.area === 'memory').length,
    layouts: set.layouts.map(op => op.folder),
  }
}
