import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Nodes } from 'mdast'
import type { CanvasFrame, CanvasLayout, NoteDTO, NotePosition, NoteSummary } from '../shared/types'
import { standalonePaths, type DataPaths } from './repo'

export const parser = unified().use(remarkParse).use(remarkGfm)
export function summaryText(node: Nodes): string {
  if (node.type === 'heading' || node.type === 'html') return ''
  if ('value' in node) return node.value + (node.type === 'code' ? ' ' : '')
  if ('alt' in node) return node.alt || ''
  if (!('children' in node)) return node.type === 'break' ? ' ' : ''
  const text = node.children.map(summaryText).join('')
  return text + (node.type === 'paragraph' || node.type === 'tableCell' ? ' ' : '')
}

const WELCOME = `# 欢迎使用画布笔记

画布上的每张卡片都是一篇完整文章。拖动文章，按自己的习惯安排位置；修改标题或正文，不会改变它的位置。

单击选中文章，按空格预览；双击打开 Markdown 编辑器。使用文件夹区分不同的画布。

笔记仍然是普通的 Markdown 文件，可以用其他编辑器打开。布局独立保存，不会写进正文。
`

type Library = { version: 1; notes: Record<string, { position: NotePosition; lastOpenedAt: number }>; frames?: CanvasFrame[] }
export type LayoutPatch = { positions: Record<string, NotePosition | null>; frames?: CanvasFrame[] }
type CanvasFile = { version: 1; notes: Record<string, NotePosition>; frames: (Omit<CanvasFrame, 'space'>)[] }
export const folderOf = (name: string) => name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : ''
export const contentVersion = (content: string) => createHash('sha256').update(content).digest('hex')
const validPosition = (p: NotePosition) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) <= 10000000 && Math.abs(p.y) <= 10000000
const validFrame = (frame: CanvasFrame) => frame && typeof frame.id === 'string' && /^[\w-]{1,80}$/.test(frame.id) &&
  typeof frame.space === 'string' && typeof frame.title === 'string' && !!frame.title.trim() && frame.title.length <= 80 && validPosition(frame.position) &&
  Number.isFinite(frame.width) && frame.width >= 336 && frame.width <= 10000000 && Number.isFinite(frame.height) && frame.height >= 280 && frame.height <= 10000000 &&
  Array.isArray(frame.members) && frame.members.every(name => typeof name === 'string' && folderOf(name) === frame.space)

export class BadNameError extends Error {}
export class NotFoundError extends Error {}
export class ConflictError extends Error {}

export class NoteStore {
  /** The notes folder: every `.md` below it is an article; subfolders are canvases. */
  readonly root: string
  readonly paths: DataPaths
  private locks = new Map<string, Promise<unknown>>()

  constructor(location: string | DataPaths) {
    this.paths = typeof location === 'string' ? standalonePaths(location) : location
    this.root = this.paths.notes
  }

  async init(): Promise<void> {
    for (const directory of [this.paths.canvas, this.paths.cache]) await fs.mkdir(directory, { recursive: true })
    if (!(await this.scan()).names.length) await this.create('Welcome', WELCOME)
  }

  private validate(relative: string, folder = false): void {
    if (typeof relative !== 'string' || relative.length > 1000 || /[\\\0]/.test(relative) || (!folder && !relative.endsWith('.md')) ||
      (relative !== '' && relative.split('/').some(part => !part || part.startsWith('.') || part.length > 200)) || (!folder && !relative)) {
      throw new BadNameError('文件名或文件夹路径无效。')
    }
  }

  async folderPath(folder: string): Promise<string> {
    this.validate(folder, true)
    const target = path.join(this.root, folder)
    try {
      const [real, root] = await Promise.all([fs.realpath(target), fs.realpath(this.root)])
      if (real !== path.join(root, folder)) throw new BadNameError('只支持工作区内的真实文件夹，不支持符号链接。')
      if (!(await fs.stat(target)).isDirectory()) throw new BadNameError('这不是文件夹。')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundError(folder)
      throw error
    }
    return target
  }

  private async notePath(name: string, required = true): Promise<string> {
    this.validate(name)
    await this.folderPath(folderOf(name))
    const target = path.join(this.root, name)
    try {
      if (!(await fs.lstat(target)).isFile()) throw new BadNameError('只支持工作区内的普通 Markdown 文件。')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (required) throw new NotFoundError(name)
    }
    return target
  }

  private async withLock<T>(name: string, action: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(name) ?? Promise.resolve()).catch(() => undefined).then(action)
    this.locks.set(name, run)
    try { return await run } finally { if (this.locks.get(name) === run) this.locks.delete(name) }
  }

  private async scan(): Promise<{ names: string[]; folders: string[] }> {
    const names: string[] = [], folders = ['']
    const visit = async (folder: string) => {
      for (const entry of await fs.readdir(path.join(this.root, folder), { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue
        const relative = folder ? folder + '/' + entry.name : entry.name
        if (entry.isDirectory()) { folders.push(relative); await visit(relative) }
        else if (entry.isFile() && entry.name.endsWith('.md')) names.push(relative)
      }
    }
    await visit('')
    return { names: names.sort((a, b) => a.localeCompare(b, 'zh')), folders: folders.sort((a, b) => a.localeCompare(b, 'zh')) }
  }

  async folders(): Promise<string[]> { return (await this.scan()).folders }
  async names(): Promise<string[]> { return (await this.scan()).names }

  /**
   * Compare-and-swap for one note: `expected === null` means the file must not exist, `next === null` deletes it.
   * Used by the change engine for atomic batches and exact undo.
   */
  async replaceFile(name: string, expected: string | null, next: string | null): Promise<void> {
    this.validate(name)
    await this.withLock(name, async () => {
      const folder = folderOf(name)
      if (next !== null && folder) await this.ensureFolder(folder)
      const file = await this.notePath(name, false)
      const current = await fs.readFile(file, 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
      if (current !== expected) throw new ConflictError(expected === null ? `「${name}」已存在，未覆盖。` : `「${name}」已在其他地方修改，未覆盖新内容。`)
      if (next === null) { await fs.rm(file); return }
      if (expected === null) { await fs.writeFile(file, next, { encoding: 'utf8', flag: 'wx' }); return }
      const tmp = path.join(path.dirname(file), '.' + path.basename(name) + '.' + randomUUID() + '.tmp')
      try { await fs.writeFile(tmp, next, 'utf8'); await fs.rename(tmp, file) }
      finally { await fs.rm(tmp, { force: true }) }
    })
  }

  /** Creates missing intermediate folders inside the notes root (never through symlinks). */
  async ensureFolder(folder: string): Promise<void> {
    this.validate(folder, true)
    let current = ''
    for (const part of folder.split('/')) {
      current = current ? current + '/' + part : part
      try { await this.folderPath(current) }
      catch (error) { if (!(error instanceof NotFoundError)) throw error; await fs.mkdir(path.join(this.root, current)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }) }
    }
  }

  /** Removes a folder only if it is empty of notes and subfolders (hidden temp files are ignored). */
  async removeEmptyFolder(folder: string): Promise<boolean> {
    if (!folder) return false
    const directory = await this.folderPath(folder)
    const entries = await fs.readdir(directory)
    if (entries.some(name => !name.startsWith('.'))) return false
    await fs.rm(directory, { recursive: true })
    return true
  }

  async createFolder(folder: string): Promise<void> {
    this.validate(folder, true)
    if (!folder) throw new BadNameError('请输入文件夹名称。')
    const parent = folderOf(folder)
    await this.folderPath(parent)
    try { await fs.mkdir(path.join(this.root, folder)) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new BadNameError('这个文件夹已经存在。')
      throw error
    }
  }

  /** Canvas layout is split per folder (`canvas/<folder>/_canvas.json`, committed); visits live in the local cache. */
  private async readLibrary(): Promise<Library> {
    const library: Library = { version: 1, notes: {}, frames: [] }
    try {
      const recent = await this.readJSON<{ version: 1; notes: Record<string, number> }>(path.join(this.paths.cache, 'recent.json'))
      const visits = recent?.version === 1 && recent.notes && typeof recent.notes === 'object' ? recent.notes : {}
      for (const file of await this.canvasFiles()) {
        const folder = path.relative(this.paths.canvas, path.dirname(file)).split(path.sep).join('/')
        const layout = await this.readJSON<CanvasFile>(file)
        if (!layout) continue
        if (layout.version !== 1 || !layout.notes || typeof layout.notes !== 'object' || Array.isArray(layout.notes) || !Array.isArray(layout.frames ?? [])) throw new Error()
        const prefix = folder ? folder + '/' : ''
        for (const [file, position] of Object.entries(layout.notes)) {
          if (!validPosition(position)) throw new Error()
          library.notes[prefix + file] = { position: { x: position.x, y: position.y }, lastOpenedAt: 0 }
        }
        for (const frame of layout.frames ?? []) library.frames!.push({ ...frame, space: folder, members: (frame.members ?? []).map(name => prefix + name) })
      }
      for (const [name, entry] of Object.entries(library.notes)) { const visit = visits[name]; if (Number.isFinite(visit)) entry.lastOpenedAt = visit! }
      this.validateFrames(library.frames!)
      return library
    } catch {
      throw new ConflictError('画布布局文件无法读取，已停止保存布局以免丢失位置。Markdown 正文未受影响，请恢复 canvas/ 中的布局文件后重试。')
    }
  }

  private async readJSON<T>(file: string): Promise<T | null> {
    try { return JSON.parse(await fs.readFile(file, 'utf8')) as T }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }

  private async canvasFiles(): Promise<string[]> {
    const files: string[] = []
    const visit = async (directory: string) => {
      let entries: import('node:fs').Dirent[]
      try { entries = await fs.readdir(directory, { withFileTypes: true }) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) await visit(path.join(directory, entry.name))
        else if (entry.isFile() && entry.name === '_canvas.json') files.push(path.join(directory, entry.name))
      }
    }
    await visit(this.paths.canvas)
    return files
  }

  private async writeAtomic(file: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const tmp = file + '.' + randomUUID() + '.tmp'
    try { await fs.writeFile(tmp, content, 'utf8'); await fs.rename(tmp, file) }
    finally { await fs.rm(tmp, { force: true }) }
  }

  /** Writes only the folder files whose content changed, so a commit shows exactly which canvases moved. */
  private async writeLibrary(library: Library): Promise<void> {
    const folders = new Map<string, CanvasFile>()
    const folder = (name: string) => { if (!folders.has(name)) folders.set(name, { version: 1, notes: {}, frames: [] }); return folders.get(name)! }
    for (const file of await this.canvasFiles()) folder(path.relative(this.paths.canvas, path.dirname(file)).split(path.sep).join('/'))
    const visits: Record<string, number> = {}
    for (const name of Object.keys(library.notes).sort((a, b) => a.localeCompare(b, 'zh'))) {
      const entry = library.notes[name]!
      folder(folderOf(name)).notes[name.slice(name.lastIndexOf('/') + 1)] = { x: entry.position.x, y: entry.position.y }
      if (entry.lastOpenedAt > 0) visits[name] = entry.lastOpenedAt
    }
    for (const frame of library.frames ?? []) {
      const { space, ...rest } = frame
      folder(space).frames.push({ ...rest, members: frame.members.map(name => name.slice(name.lastIndexOf('/') + 1)) })
    }
    for (const [name, layout] of folders) {
      const file = path.join(this.paths.canvas, name, '_canvas.json'), next = JSON.stringify(layout, null, 2) + '\n'
      if (await fs.readFile(file, 'utf8').catch(() => null) !== next) await this.writeAtomic(file, next)
    }
    const recent = path.join(this.paths.cache, 'recent.json'), next = JSON.stringify({ version: 1, notes: visits })
    if (await fs.readFile(recent, 'utf8').catch(() => null) !== next) await this.writeAtomic(recent, next)
  }

  /** Place ONLY new files, below existing cards; content and sort order never change coordinates. */
  private async placeNew(library: Library, names: string[]): Promise<boolean> {
    const folders = new Set(names.map(folderOf))
    let changed = false
    for (const folder of folders) {
      const existing = names.filter(name => folderOf(name) === folder && library.notes[name])
      const missing = names.filter(name => folderOf(name) === folder && !library.notes[name])
      const top = existing.length ? Math.max(...existing.map(name => library.notes[name]!.position.y)) + 224 : 48
      for (const [index, name] of missing.entries()) {
        let lastOpenedAt = 0
        // Preserve visits from the previous version; old paragraph layouts are left untouched on disk.
        try {
          const old = JSON.parse(await fs.readFile(path.join(this.paths.legacy, name + '.board.json'), 'utf8'))
          if (Number.isFinite(old.lastOpenedAt) && old.lastOpenedAt > 0) lastOpenedAt = old.lastOpenedAt
        } catch { /* no previous visit metadata */ }
        library.notes[name] = { position: { x: 48 + index % 3 * 312, y: top + Math.floor(index / 3) * 224 }, lastOpenedAt }
        changed = true
      }
    }
    return changed
  }

  async list(): Promise<NoteSummary[]> {
    return this.withLock('library', async () => {
      const { names } = await this.scan()
      const library = await this.readLibrary()
      if (await this.placeNew(library, names)) await this.writeLibrary(library)
      return Promise.all(names.map(async name => {
        const file = await this.notePath(name), content = await fs.readFile(file, 'utf8')
        return {
          name, space: folderOf(name), mtime: (await fs.stat(file)).mtimeMs,
          ...library.notes[name]!,
          title: /^#\s+(.+)$/m.exec(content)?.[1]?.trim() ?? path.basename(name, '.md'),
          excerpt: summaryText(parser.parse(content)).trim().replace(/\s+/g, ' ').slice(0, 160),
        }
      }))
    })
  }

  async create(preferred?: string, content?: string, folder = ''): Promise<string> {
    await this.folderPath(folder)
    const stem = (preferred ?? '新笔记').replace(/\.md$/i, '').replace(/[\\/\0]/g, '-').replace(/^\.+/, '').trim() || '新笔记'
    for (let index = 0; index < 1000; index++) {
      const filename = `${stem}${index === 0 ? '' : ` ${index + 1}`}.md`
      const name = folder ? folder + '/' + filename : filename
      const target = await this.notePath(name, false)
      try {
        await fs.writeFile(target, content ?? `# ${stem}\n\n`, { encoding: 'utf8', flag: 'wx' })
        return name
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    throw new BadNameError('同名笔记过多，请使用另一个名称。')
  }

  async load(name: string): Promise<NoteDTO> {
    return { name, content: await fs.readFile(await this.notePath(name), 'utf8'), space: folderOf(name) }
  }

  async saveContent(name: string, content: string, expectedContent: string): Promise<void> {
    await this.withLock(name, async () => {
      const file = await this.notePath(name), current = await fs.readFile(file, 'utf8')
      if (current !== expectedContent) throw new ConflictError('笔记已在其他地方修改，请重新载入后再保存。')
      const tmp = path.join(path.dirname(file), '.' + path.basename(name) + '.' + randomUUID() + '.tmp')
      try { await fs.writeFile(tmp, content, 'utf8'); await fs.rename(tmp, file) }
      finally { await fs.rm(tmp, { force: true }) }
    })
  }

  async recordOpen(name: string): Promise<void> {
    await this.notePath(name)
    await this.withLock('library', async () => {
      const library = await this.readLibrary()
      await this.placeNew(library, (await this.scan()).names)
      library.notes[name]!.lastOpenedAt = Date.now()
      await this.writeLibrary(library)
    })
  }

  async savePositions(positions: Record<string, NotePosition>): Promise<void> {
    if (!positions || typeof positions !== 'object' || Array.isArray(positions) || Object.keys(positions).length > 1000 || Object.values(positions).some(position => !validPosition(position))) throw new BadNameError('文章位置无效。')
    await this.withLock('library', async () => {
      for (const name of Object.keys(positions)) await this.notePath(name)
      const library = await this.readLibrary()
      await this.placeNew(library, (await this.scan()).names)
      for (const [name, position] of Object.entries(positions)) library.notes[name]!.position = { x: position.x, y: position.y }
      await this.writeLibrary(library)
    })
  }

  private validateFrames(frames: CanvasFrame[]): void {
    if (!Array.isArray(frames) || frames.length > 1000 || frames.some(frame => !validFrame(frame))) throw new BadNameError('底板名称、位置或尺寸无效。')
    const ids = new Set<string>(), members = new Set<string>()
    for (const frame of frames) {
      this.validate(frame.space, true)
      if (ids.has(frame.id)) throw new BadNameError('底板编号重复。')
      ids.add(frame.id)
      for (const name of frame.members) {
        this.validate(name)
        if (members.has(name)) throw new BadNameError('一篇文章只能属于一个底板。')
        members.add(name)
      }
    }
  }

  private canvasLayout(library: Library, folder: string, names: string[]): CanvasLayout {
    const available = new Set(names)
    return {
      frames: (library.frames ?? []).filter(frame => frame.space === folder).map(frame => ({ ...frame, members: frame.members.filter(name => available.has(name)) })),
      positions: Object.fromEntries(names.filter(name => folderOf(name) === folder).map(name => [name, library.notes[name]!.position])),
    }
  }

  async canvas(folder: string): Promise<CanvasLayout> {
    await this.folderPath(folder)
    return this.withLock('library', async () => {
      const { names } = await this.scan(), library = await this.readLibrary()
      if (await this.placeNew(library, names)) await this.writeLibrary(library)
      return this.canvasLayout(library, folder, names)
    })
  }

  /** Commit frame membership and world coordinates together, never modifying Markdown. */
  async saveCanvas(folder: string, frames: CanvasFrame[], positions: Record<string, NotePosition>, expectedFrames: CanvasFrame[]): Promise<CanvasLayout> {
    await this.folderPath(folder)
    this.validateFrames(frames); this.validateFrames(expectedFrames)
    if (frames.some(frame => frame.space !== folder) || expectedFrames.some(frame => frame.space !== folder)) throw new BadNameError('底板必须属于当前文件夹。')
    if (!positions || typeof positions !== 'object' || Array.isArray(positions) || Object.keys(positions).length > 1000 || Object.values(positions).some(position => !validPosition(position))) throw new BadNameError('文章位置无效。')
    for (const name of Object.keys(positions)) {
      this.validate(name)
      if (folderOf(name) !== folder) throw new BadNameError('不能移动其他文件夹中的文章。')
    }
    return this.withLock('library', async () => {
      const { names } = await this.scan(), library = await this.readLibrary()
      await this.placeNew(library, names)
      const current = this.canvasLayout(library, folder, names)
      if (!isDeepStrictEqual(current.frames, expectedFrames)) throw new ConflictError('底板已在其他窗口修改。请先复制未保存的底板名称，再重新载入画布。')
      const available = new Set(names)
      for (const name of [...Object.keys(positions), ...frames.flatMap(frame => frame.members)]) if (!available.has(name)) throw new NotFoundError(name)
      const allFrames = [...(library.frames ?? []).filter(frame => frame.space !== folder), ...frames]
      this.validateFrames(allFrames)
      // Parent movement applies the same delta to current member coordinates. Dissolving a frame never moves them.
      for (const frame of frames) {
        const previous = current.frames.find(old => old.id === frame.id)
        if (!previous) continue
        const dx = frame.position.x - previous.position.x, dy = frame.position.y - previous.position.y
        for (const name of previous.members.filter(name => frame.members.includes(name))) {
          const position = library.notes[name]!.position
          const next = { x: position.x + dx, y: position.y + dy }
          if (!validPosition(next)) throw new BadNameError('移动后文章超出画布坐标范围。')
          library.notes[name]!.position = next
        }
      }
      for (const [name, position] of Object.entries(positions)) library.notes[name]!.position = { x: position.x, y: position.y }
      library.frames = allFrames
      await this.writeLibrary(library)
      return this.canvasLayout(library, folder, names)
    })
  }

  /**
   * Applies a partial layout change and returns the exact previous state of what it touched.
   * `positions[name] = null` removes a stale entry; `frames` replaces the folder's frame list.
   */
  async patchLayout(folder: string, next: LayoutPatch): Promise<LayoutPatch> {
    return this.withLock('library', async () => {
      const library = await this.readLibrary()
      const before = this.layoutState(library, folder, next)
      this.writePatch(library, folder, next)
      await this.writeLibrary(library)
      return before
    })
  }

  /** Strict variant for undo: refuses if anything touched has changed since `expected`. */
  async replaceLayout(folder: string, expected: LayoutPatch, next: LayoutPatch): Promise<void> {
    await this.withLock('library', async () => {
      const library = await this.readLibrary()
      if (!isDeepStrictEqual(this.layoutState(library, folder, expected), expected)) throw new ConflictError('画布布局已在之后被修改，未撤销布局。')
      this.writePatch(library, folder, next)
      await this.writeLibrary(library)
    })
  }

  private layoutState(library: Library, folder: string, shape: LayoutPatch): LayoutPatch {
    const positions: Record<string, NotePosition | null> = {}
    for (const name of Object.keys(shape.positions)) { const entry = library.notes[name]; positions[name] = entry ? { x: entry.position.x, y: entry.position.y } : null }
    return { positions, ...(shape.frames ? { frames: (library.frames ?? []).filter(frame => frame.space === folder) } : {}) }
  }

  private writePatch(library: Library, folder: string, next: LayoutPatch): void {
    for (const [name, position] of Object.entries(next.positions)) {
      this.validate(name)
      if (position === null) { delete library.notes[name]; continue }
      if (!validPosition(position)) throw new BadNameError('文章位置无效。')
      library.notes[name] = { position: { x: position.x, y: position.y }, lastOpenedAt: library.notes[name]?.lastOpenedAt ?? 0 }
    }
    if (next.frames) {
      if (next.frames.some(frame => frame.space !== folder)) throw new BadNameError('文档区必须属于当前文件夹。')
      library.frames = [...(library.frames ?? []).filter(frame => frame.space !== folder), ...next.frames]
      this.validateFrames(library.frames)
    }
  }

  /** Raw layout of one folder for tools: every positioned note (including stale entries) and frames. */
  async layout(folder: string): Promise<CanvasLayout> {
    await this.folderPath(folder)
    return this.withLock('library', async () => {
      const { names } = await this.scan(), library = await this.readLibrary()
      if (await this.placeNew(library, names)) await this.writeLibrary(library)
      return this.canvasLayout(library, folder, names)
    })
  }

  /**
   * After a rename made outside the app, carries the old path's position and frame membership to the
   * new path (same folder only); `to === null` forgets a deleted note's entry.
   */
  async moveLayoutEntry(from: string, to: string | null): Promise<void> {
    await this.withLock('library', async () => {
      const library = await this.readLibrary()
      const old = library.notes[from]
      if (!old) return
      delete library.notes[from]
      const same = to !== null && folderOf(to) === folderOf(from)
      if (same) library.notes[to] = { position: old.position, lastOpenedAt: Math.max(old.lastOpenedAt, library.notes[to]?.lastOpenedAt ?? 0) }
      library.frames = (library.frames ?? []).map(frame => frame.members.includes(from)
        ? { ...frame, members: same && !frame.members.includes(to!) ? frame.members.map(name => name === from ? to! : name) : frame.members.filter(name => name !== from) }
        : frame)
      await this.writeLibrary(library)
    })
  }

  /** Moves visit history with a renamed note; recent visits are local view state. */
  async renameVisit(from: string, to: string): Promise<void> {
    await this.withLock('library', async () => {
      const library = await this.readLibrary()
      const visit = library.notes[from]?.lastOpenedAt
      if (!visit || !library.notes[to]) return
      library.notes[to]!.lastOpenedAt = Math.max(library.notes[to]!.lastOpenedAt, visit)
      await this.writeLibrary(library)
    })
  }

  async search(query: string): Promise<(NoteSummary & { snippet: string })[]> {
    const q = query.trim().toLocaleLowerCase()
    if (!q) return []
    const matches = await Promise.all((await this.list()).map(async note => {
      const content = (await this.load(note.name)).content, at = content.toLocaleLowerCase().indexOf(q)
      return at >= 0 || note.title.toLocaleLowerCase().includes(q) ? { ...note, snippet: at < 0 ? note.excerpt : content.slice(Math.max(0, at - 45), at + 120).replace(/\s+/g, ' ') } : null
    }))
    return matches.filter(note => note !== null)
  }
}
