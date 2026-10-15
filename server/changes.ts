import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { ChangeSetSummary } from '../shared/types'
import { BadNameError, ConflictError, NotFoundError, contentVersion, folderOf, type LayoutPatch, type NoteIdentities, type NoteStore } from './store'
import type { MemoryFiles } from './memory-files'
import type { EventBus } from './events'
import { readRecord, StorageError, writeRecord } from './persistence'

export type FileArea = 'notes' | 'memory'
/** `before === null` creates, `after === null` deletes. A rename is a delete plus a create. */
export type FileOp = { area: FileArea; name: string; before: string | null; after: string | null; identityFrom?: string }
export type LayoutOp = { folder: string; before: LayoutPatch; after: LayoutPatch }
type IdentityOp = { before: NoteIdentities['paths']; after: NoteIdentities['paths'] }
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
  identities?: IdentityOp
  undone?: boolean
}

type Operation = {
  version: 1; id: string; signature: string; state: 'prepared' | 'committed' | 'rolled_back'
  files: FileOp[]; layouts: LayoutOp[]; identities: IdentityOp
  beforeSet: ChangeSet | null; afterSet: ChangeSet | null
}
const recordNames = async (directory: string) => fs.readdir(directory).then(names => names.filter(name => name.endsWith('.json'))).catch(error => { if (error.code === 'ENOENT') return []; throw error })

/**
 * Agent batches have a durable intent before the first write. Incomplete batches roll back on
 * restart; outside edits stop recovery rather than being overwritten. This is not a filesystem transaction.
 */
export class ChangeEngine {
  private readonly directory: string
  private readonly operations: string
  private recovered = false
  constructor(private store: NoteStore, private memory: MemoryFiles, private bus: EventBus) {
    this.directory = path.join(store.paths.local, 'changesets')
    this.operations = path.join(store.paths.local, 'operations')
  }

  exclusive<T>(action: () => Promise<T>) { return this.store.writer.run(action) }

  begin(request: string, options: { conversation?: string; origin?: ChangeSet['origin'] } = {}): ChangeSet {
    const now = Date.now()
    return { version: 1, id: randomUUID(), createdAt: now, updatedAt: now, request: request.slice(0, 300), origin: options.origin ?? 'request', files: [], layouts: [], ...(options.conversation ? { conversation: options.conversation } : {}) }
  }

  private area(area: FileArea) { return area === 'notes' ? this.store : this.memory }

  async apply(set: ChangeSet | null, files: FileOp[], layouts: { folder: string; patch: LayoutPatch; expected?: LayoutPatch }[] = [], operationId: string = randomUUID()): Promise<void> {
    return this.exclusive(async () => {
      await this.recover()
      const id = contentVersion((set?.id ?? '') + ':' + operationId), signature = contentVersion(JSON.stringify({ files, layouts }))
      const previous = await readRecord<Operation>(path.join(this.operations, id + '.json'))
      if (previous) {
        if (previous.signature !== signature) throw new ConflictError('同一操作编号不能用于不同修改。')
        if (previous.state !== 'committed') throw new ConflictError('这个操作未完成且已恢复，请重新检查内容后发起新的操作。')
        if (set) Object.assign(set, await this.get(set.id))
        return
      }
      const keys = new Set<string>()
      for (const op of files) {
        const key = op.area + ':' + op.name
        if (keys.has(key)) throw new BadNameError('同一批操作中重复修改了「' + op.name + '」。')
        keys.add(key)
        if (op.before === op.after) throw new BadNameError('空操作。')
        if (await this.current(op) !== op.before) throw new ConflictError('「' + op.name + '」已变化，整批修改未执行。')
      }
      const patches = new Map<string, LayoutPatch>()
      for (const { folder, patch, expected } of layouts) {
        if (expected && !isDeepStrictEqual(await this.store.inspectLayout(folder, patch), expected)) throw new ConflictError('提案依据的画布已变化，未覆盖。')
        const existing = patches.get(folder) ?? { positions: {} }
        Object.assign(existing.positions, patch.positions)
        if (patch.frames) existing.frames = patch.frames
        patches.set(folder, existing)
      }
      const layoutOps: LayoutOp[] = []
      for (const [folder, patch] of patches) layoutOps.push({ folder, before: await this.store.inspectLayout(folder, patch), after: patch })
      const registry = await this.store.identities(), before: NoteIdentities['paths'] = {}, after: NoteIdentities['paths'] = {}
      const notes = files.filter(op => op.area === 'notes')
      const moved = new Set<string>()
      for (const op of notes.filter(op => op.identityFrom)) {
        if (op.before !== null || op.after === null || moved.has(op.identityFrom!) || !notes.some(source => source.name === op.identityFrom && source.before !== null && source.after === null)) throw new BadNameError('笔记身份只能随同一批次中的移动保留。')
        moved.add(op.identityFrom!)
      }
      for (const op of [...notes.filter(op => !op.identityFrom), ...notes.filter(op => op.identityFrom)]) {
        const source = op.identityFrom ?? op.name
        const noteId = Object.keys(registry.paths).find(key => registry.paths[key] === source) ?? randomUUID()
        before[noteId] = registry.paths[noteId] ?? null
        after[noteId] = op.after === null ? null : op.name
      }
      const identities = { before, after }, next = set ? structuredClone(set) : null
      if (next) for (const op of files) this.merge(next, op)
      if (next) for (const op of layoutOps) {
        const existing = next.layouts.find(item => item.folder === op.folder)
        if (!existing) { next.layouts.push(op); continue }
        // Keep the earliest "before" of each touched entry and the latest "after".
        for (const [name, position] of Object.entries(op.before.positions)) if (!(name in existing.before.positions)) existing.before.positions[name] = position
        Object.assign(existing.after.positions, op.after.positions)
        if (op.after.frames) { if (!existing.before.frames) existing.before.frames = op.before.frames; existing.after.frames = op.after.frames }
      }
      if (next) {
        next.identities ??= { before: {}, after: {} }
        for (const [key, value] of Object.entries(before)) if (!(key in next.identities.before)) next.identities.before[key] = value
        Object.assign(next.identities.after, after)
        next.updatedAt = Date.now()
      }
      await this.transact({ version: 1, id, signature, state: 'prepared', files, layouts: layoutOps, identities, beforeSet: set ? await readRecord(path.join(this.directory, set.id + '.json')) : null, afterSet: next })
      if (set && next) Object.assign(set, next)
    })
  }

  /** Run before note discovery/welcome seeding and before accepting HTTP requests. */
  async recover(): Promise<void> {
    if (this.recovered) return
    await this.exclusive(async () => {
      if (this.recovered) return
      for (const name of await recordNames(this.operations)) {
        const op = await readRecord<Operation>(path.join(this.operations, name))
        if (!op || op.version !== 1 || name !== op.id + '.json' || !['prepared', 'committed', 'rolled_back'].includes(op.state)) throw new StorageError('操作恢复记录格式无效：' + name)
        if (!Array.isArray(op.files) || !Array.isArray(op.layouts) || !op.identities?.before || !op.identities.after ||
          [op.beforeSet, op.afterSet].some(set => set && !/^[a-f0-9-]{36}$/.test(set.id))) throw new StorageError('操作恢复内容格式无效：' + name)
        if (op.state === 'prepared') await this.rollback(op)
      }
      this.recovered = true
    })
  }

  async captureLayouts(layouts: { folder: string; patch: LayoutPatch }[]) {
    return this.exclusive(async () => Promise.all(layouts.map(async item => ({ ...item, expected: await this.store.inspectLayout(item.folder, item.patch) }))))
  }

  private async transact(op: Operation): Promise<void> {
    const file = path.join(this.operations, op.id + '.json')
    await writeRecord(file, op)
    try {
      for (const item of op.files) await this.area(item.area).replaceFile(item.name, item.before, item.after)
      for (const item of op.layouts) await this.store.replaceLayout(item.folder, item.before, item.after)
      if (Object.keys(op.identities.after).length) await this.store.replaceIdentities(op.identities.before, op.identities.after)
      if (op.afterSet) await this.save(op.afterSet)
      await writeRecord(file, { ...op, state: 'committed' })
    } catch (error) {
      await this.rollback(op)
      throw error
    }
    this.emit(op.files, op.layouts)
  }

  private async rollback(op: Operation): Promise<void> {
    try {
      // Verify ALL touched resources before compensating any of them.
      for (const item of op.files) {
        const current = await this.current(item)
        if (current !== item.before && current !== item.after) throw new ConflictError('恢复时发现外部修改：' + item.name)
      }
      for (const item of op.layouts) {
        const current = await this.store.inspectLayout(item.folder, item.after)
        if (!isDeepStrictEqual(current, item.before) && !isDeepStrictEqual(current, item.after)) throw new ConflictError('恢复时发现画布修改：' + item.folder)
      }
      const registry = await readRecord<NoteIdentities>(path.join(this.store.paths.research, 'note-identities.json'))
      for (const id of Object.keys(op.identities.before)) {
        const current = registry?.paths[id] ?? null
        if (current !== op.identities.before[id] && current !== op.identities.after[id]) throw new ConflictError('恢复时发现笔记身份修改。')
      }
      for (const item of [...op.layouts].reverse()) if (!isDeepStrictEqual(await this.store.inspectLayout(item.folder, item.after), item.before)) await this.store.replaceLayout(item.folder, item.after, item.before)
      for (const item of [...op.files].reverse()) if (await this.current(item) !== item.before) await this.area(item.area).replaceFile(item.name, item.after, item.before)
      if (Object.keys(op.identities.before).length) {
        const current = Object.fromEntries(Object.keys(op.identities.before).map(id => [id, registry?.paths[id] ?? null]))
        await this.store.replaceIdentities(current, op.identities.before)
      }
      if (op.beforeSet) await this.save(op.beforeSet)
      else if (op.afterSet) await fs.rm(path.join(this.directory, op.afterSet.id + '.json'), { force: true })
      await writeRecord(path.join(this.operations, op.id + '.json'), { ...op, state: 'rolled_back' })
      this.emit(op.files, op.layouts)
    } catch {
      const message = '有未完成的修改需要恢复，已暂停写入。请保留 local/operations 中的记录和当前文件；外部修改不会被覆盖。操作：' + op.id
      this.store.writer.halt(message)
      throw new StorageError(message)
    }
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
    await writeRecord(path.join(this.directory, set.id + '.json'), set)
  }

  async get(id: string): Promise<ChangeSet> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new BadNameError('修改记录无效。')
    const set = await readRecord<ChangeSet>(path.join(this.directory, id + '.json'))
    if (!set) throw new NotFoundError('找不到修改记录。')
    if (set.version !== 1 || set.id !== id || !Array.isArray(set.files) || !Array.isArray(set.layouts)) throw new StorageError('修改记录格式无效：' + id)
    return set
  }

  /** Whether every touched file and layout entry is still exactly as this change set left it. */
  async undoable(set: ChangeSet): Promise<boolean> {
    if (set.undone) return false
    for (const op of set.files) if (await this.current(op) !== op.after) return false
    for (const op of set.layouts) if (!isDeepStrictEqual(await this.store.inspectLayout(op.folder, op.after), op.after)) return false
    if (set.identities) {
      const current = await readRecord<NoteIdentities>(path.join(this.store.paths.research, 'note-identities.json'))
      if (Object.entries(set.identities.after).some(([id, name]) => (current?.paths[id] ?? null) !== name)) return false
    }
    return true
  }

  private async current(op: FileOp): Promise<string | null> {
    if (op.area === 'memory') return this.memory.read(op.name)
    try { return (await this.store.load(op.name)).content } catch (error) { if (error instanceof NotFoundError) return null; throw error }
  }

  async undo(id: string): Promise<ChangeSet> {
    return this.exclusive(async () => {
      await this.recover()
      const set = await this.get(id)
      if (set.undone) return set
      if (!await this.undoable(set)) throw new ConflictError('正文、笔记身份或画布在之后又被修改，为避免覆盖，整组修改未撤销。')
      // Reverse the accumulated file changes, preserving later edits through the checks above.
      const reverse = [...set.files].reverse().map(op => ({ ...op, before: op.after, after: op.before }))
      const next = { ...set, undone: true, updatedAt: Date.now() }
      await this.transact({ version: 1, id: contentVersion(id + ':undo'), signature: id, state: 'prepared', files: reverse,
        layouts: [...set.layouts].reverse().map(op => ({ folder: op.folder, before: op.after, after: op.before })),
        identities: { before: set.identities?.after ?? {}, after: set.identities?.before ?? {} }, beforeSet: set, afterSet: next })
      return next
    })
  }

  async list(filter: { folder?: string; name?: string; conversation?: string } = {}): Promise<ChangeSetSummary[]> {
    const files = (await recordNames(this.directory)).filter(file => /^[a-f0-9-]{36}\.json$/.test(file))
    const sets: ChangeSet[] = []
    for (const file of files) sets.push(await this.get(file.slice(0, -5)))
    sets.sort((a, b) => b.updatedAt - a.updatedAt)
    const result: ChangeSetSummary[] = []
    for (const set of sets) {
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
