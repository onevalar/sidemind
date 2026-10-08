import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { CanvasGroup, NoteDTO, NoteSummary } from '../shared/types'
import { applyPositions, emptyBoard, reconcile, type BoardFile } from './board'
import { parseBlocks } from './markdown'

const WELCOME = `# 欢迎使用画布笔记

每个段落、列表、代码块都是画布上的一张卡片。拖动卡片，位置会保存在笔记旁边的元数据里，Markdown 正文不会被改动。

你也可以用任何别的编辑器修改这个 \`.md\` 文件，画布会实时刷新。

\`\`\`ts
console.log('hello canvas')
\`\`\`

> 笔记永远是普通的 Markdown 文件。

- 可以带列表
- 也可以带 **加粗** 和 [链接](https://example.com)

| 列 A | 列 B |
| ---- | ---- |
| 表格 | 也行 |
`

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
    const files = await this.listNames()
    if (files.length === 0) await this.writeRaw('Welcome.md', WELCOME)
  }

  /** Only plain `*.md` files directly inside the notes folder; no paths, no dotfiles. */
  private resolveName(name: string): string {
    if (
      typeof name !== 'string' ||
      !name.endsWith('.md') ||
      name.length > 200 ||
      name.startsWith('.') ||
      /[\\/\0]/.test(name) ||
      name !== path.basename(name)
    ) {
      throw new BadNameError(`Invalid note name: ${name}`)
    }
    return path.join(this.root, name)
  }

  private boardPath(name: string): string {
    return path.join(this.metaDir, `${name}.board.json`)
  }

  /** Serializes read-modify-write cycles per note. */
  private async withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(name) ?? Promise.resolve()
    const run = prev.catch(() => undefined).then(fn)
    this.locks.set(name, run)
    try {
      return await run
    } finally {
      if (this.locks.get(name) === run) this.locks.delete(name)
    }
  }

  private async listNames(): Promise<string[]> {
    const entries = await fs.readdir(this.root, { withFileTypes: true })
    return entries.filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.')).map((e) => e.name)
  }

  async list(): Promise<NoteSummary[]> {
    const names = await this.listNames()
    const notes = await Promise.all(
      names.map(async (name) => {
        const content = await fs.readFile(path.join(this.root, name), 'utf8')
        const board = await this.readBoard(name)
        return { name, space: board.space ?? '个人灵感', mtime: (await fs.stat(path.join(this.root, name))).mtimeMs,
          lastOpenedAt: typeof board.lastOpenedAt === 'number' && Number.isFinite(board.lastOpenedAt) && board.lastOpenedAt > 0 ? board.lastOpenedAt : 0,
          title: /^#\s+(.+)$/m.exec(content)?.[1] ?? name.replace(/\.md$/, ''),
          excerpt: content.replace(/^#+\s+.*$/gm, '').replace(/[`*>\[\]#_]/g, '').trim().replace(/\s+/g, ' ').slice(0, 160),
          blockCount: parseBlocks(content).length }
      }),
    )
    return notes.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  }

  /** Atomic write: temp file in the same folder, then rename over the target. */
  private async writeRaw(name: string, content: string): Promise<void> {
    const target = this.resolveName(name)
    const tmp = path.join(this.root, `.${name}.${randomUUID()}.tmp`)
    await fs.writeFile(tmp, content, 'utf8')
    await fs.rename(tmp, target)
  }

  /** Creates a new note without ever overwriting an existing file. */
  async create(preferred?: string, content?: string): Promise<string> {
    const stem = (preferred ?? '新笔记').replace(/\.md$/i, '').replace(/[\\/\0]/g, '-').replace(/^\.+/, '').trim() || '新笔记'
    for (let i = 0; i < 1000; i++) {
      const name = `${stem}${i === 0 ? '' : ` ${i + 1}`}.md`
      const target = this.resolveName(name)
      try {
        await fs.writeFile(target, content ?? `# ${stem}\n\n开始写作吧。\n`, { encoding: 'utf8', flag: 'wx' })
        return name
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      }
    }
    throw new Error('Could not find a free note name')
  }

  private async readBoard(name: string): Promise<BoardFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.boardPath(name), 'utf8')) as BoardFile
      if (parsed?.version === 1 && Array.isArray(parsed.entries)) return parsed
    } catch {
      // missing or corrupt sidecar: start fresh; the Markdown itself is never at risk
    }
    return emptyBoard()
  }

  private async writeBoard(name: string, board: BoardFile): Promise<void> {
    const target = this.boardPath(name)
    const tmp = `${target}.${randomUUID()}.tmp`
    await fs.writeFile(tmp, JSON.stringify(board, null, 2), 'utf8')
    await fs.rename(tmp, target)
  }

  /** Reads a note, parses it into blocks, and syncs the sidecar so block identities persist. */
  async load(name: string): Promise<NoteDTO> {
    const file = this.resolveName(name)
    return this.withLock(name, async () => {
      let content: string
      try {
        content = await fs.readFile(file, 'utf8')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundError(name)
        throw e
      }
      const parsed = parseBlocks(content)
      const { board, changed } = reconcile(await this.readBoard(name), parsed)
      if (changed) await this.writeBoard(name, board)

      const blocks = parsed.map((b, i) => {
        const entry = board.entries[i]!
        return {
          id: entry.id,
          type: b.type,
          raw: b.raw,
          start: b.start,
          end: b.end,
          x: entry.x ?? null,
          y: entry.y ?? null,
        }
      })
      return { name, content, blocks, groups: board.groups ?? [], space: board.space ?? '个人灵感' }
    })
  }

  /** Compare-and-swap: an external editor can never be overwritten by a stale browser. */
  async saveContent(name: string, content: string, expectedContent: string): Promise<void> {
    const file = this.resolveName(name)
    await this.withLock(name, async () => {
      let current: string
      try { current = await fs.readFile(file, 'utf8') } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundError(name)
        throw e
      }
      if (current !== expectedContent) throw new ConflictError('笔记已在其他地方修改，请重新载入后再保存。')
      await this.writeRaw(name, content)
    })
  }

  /** Only explicit navigation records a visit; background loads never change recents. */
  async recordOpen(name: string): Promise<void> {
    const file = this.resolveName(name)
    await this.withLock(name, async () => {
      try { await fs.access(file) } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundError(name)
        throw e
      }
      const board = await this.readBoard(name)
      await this.writeBoard(name, { ...board, lastOpenedAt: Date.now() })
    })
  }

  async saveGroups(name: string, groups: CanvasGroup[]): Promise<void> {
    this.resolveName(name)
    await this.withLock(name, async () => {
      const board = await this.readBoard(name)
      const ids = new Set(board.entries.map((e) => e.id))
      const seen = new Set<string>()
      const groupIds = new Set<string>()
      for (const g of groups) {
        if (!g || typeof g.id !== 'string' || !g.id || ids.has(g.id) || groupIds.has(g.id) || typeof g.title !== 'string' || g.title.length > 120 || !Number.isFinite(g.x) || !Number.isFinite(g.y) || !Array.isArray(g.blockIds)) throw new BadNameError('Invalid group')
        groupIds.add(g.id)
        for (const id of g.blockIds) {
          if (!ids.has(id) || seen.has(id)) throw new BadNameError('Each block can belong to one group')
          seen.add(id)
        }
      }
      await this.writeBoard(name, { ...board, groups })
    })
  }

  async search(query: string): Promise<(NoteSummary & { snippet: string })[]> {
    const q = query.trim().toLocaleLowerCase()
    if (!q) return []
    const matches = await Promise.all((await this.list()).map(async (n) => {
      const content = await fs.readFile(this.resolveName(n.name), 'utf8')
      const at = content.toLocaleLowerCase().indexOf(q)
      return at >= 0 || n.title.toLocaleLowerCase().includes(q) ? { ...n, snippet: at < 0 ? n.excerpt : content.slice(Math.max(0, at - 45), at + 120).replace(/\s+/g, ' ') } : null
    }))
    return matches.filter((n) => n !== null)
  }

  async saveSpace(name: string, space: string): Promise<void> {
    this.resolveName(name)
    if (typeof space !== 'string' || !space.trim() || space.length > 80) throw new BadNameError('Invalid space')
    await this.withLock(name, async () => { const board = await this.readBoard(name); await this.writeBoard(name, { ...board, space: space.trim() }) })
  }

  async savePositions(name: string, positions: Record<string, { x: number; y: number }>): Promise<void> {
    this.resolveName(name)
    return this.withLock(name, async () => {
      const board = await this.readBoard(name)
      await this.writeBoard(name, applyPositions(board, positions))
    })
  }
}
