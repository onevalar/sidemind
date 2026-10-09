import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Nodes } from 'mdast'
import type { CanvasFrame, CanvasLayout, NoteDTO, NotePosition, NoteSummary } from '../shared/types'

const parser = unified().use(remarkParse).use(remarkGfm)
function summaryText(node: Nodes): string {
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
const folderOf = (name: string) => name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : ''
const validPosition = (p: NotePosition) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) <= 10000000 && Math.abs(p.y) <= 10000000
const validFrame = (frame: CanvasFrame) => frame && typeof frame.id === 'string' && /^[\w-]{1,80}$/.test(frame.id) &&
  typeof frame.space === 'string' && typeof frame.title === 'string' && !!frame.title.trim() && frame.title.length <= 80 && validPosition(frame.position) &&
  Number.isFinite(frame.width) && frame.width >= 336 && frame.width <= 10000000 && Number.isFinite(frame.height) && frame.height >= 280 && frame.height <= 10000000 &&
  Array.isArray(frame.members) && frame.members.every(name => typeof name === 'string' && folderOf(name) === frame.space)

export class BadNameError extends Error {}
export class NotFoundError extends Error {}
export class ConflictError extends Error {}

export class NoteStore {
  readonly root: string
  private readonly metaDir: string
  private locks = new Map<string, Promise<unknown>>()

  constructor(root: string) {
    this.root = path.resolve(root)
    this.metaDir = path.join(this.root, '.canvasnote')
  }

  async init(): Promise<void> {
    await fs.mkdir(this.metaDir, { recursive: true })
    if (!(await this.scan()).names.length) await this.create('Welcome', WELCOME)
  }

  private validate(relative: string, folder = false): void {
    if (typeof relative !== 'string' || relative.length > 1000 || /[\\\0]/.test(relative) || (!folder && !relative.endsWith('.md')) ||
      (relative !== '' && relative.split('/').some(part => !part || part.startsWith('.') || part.length > 200)) || (!folder && !relative)) {
      throw new BadNameError('文件名或文件夹路径无效。')
    }
  }

  private async folderPath(folder: string): Promise<string> {
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

  private async readLibrary(): Promise<Library> {
    try {
      const library = JSON.parse(await fs.readFile(path.join(this.metaDir, 'library.json'), 'utf8')) as Library
      if (library.version !== 1 || !library.notes || typeof library.notes !== 'object' || Array.isArray(library.notes) ||
        Object.values(library.notes).some(entry => !entry || !validPosition(entry.position) || !Number.isFinite(entry.lastOpenedAt))) throw new Error()
      if (library.frames !== undefined) this.validateFrames(library.frames)
      return library
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, notes: {} }
      throw new ConflictError('画布布局文件无法读取，已停止保存布局以免丢失位置。Markdown 正文未受影响，请恢复 .canvasnote/library.json 后重试。')
    }
  }

  private async writeLibrary(library: Library): Promise<void> {
    const target = path.join(this.metaDir, 'library.json'), tmp = target + '.' + randomUUID() + '.tmp'
    try { await fs.writeFile(tmp, JSON.stringify(library, null, 2), 'utf8'); await fs.rename(tmp, target) }
    finally { await fs.rm(tmp, { force: true }) }
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
          const old = JSON.parse(await fs.readFile(path.join(this.metaDir, name + '.board.json'), 'utf8'))
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
