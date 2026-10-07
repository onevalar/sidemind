import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { NoteDTO, NoteSummary } from '../shared/types'
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
      names.map(async (name) => ({ name, mtime: (await fs.stat(path.join(this.root, name))).mtimeMs })),
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
  async create(preferred?: string): Promise<string> {
    const stem = (preferred ?? '新笔记').replace(/\.md$/i, '').replace(/[\\/\0]/g, '-').replace(/^\.+/, '').trim() || '新笔记'
    for (let i = 0; i < 1000; i++) {
      const name = `${stem}${i === 0 ? '' : ` ${i + 1}`}.md`
      const target = this.resolveName(name)
      try {
        await fs.writeFile(target, `# ${stem}\n\n开始写作吧。\n`, { encoding: 'utf8', flag: 'wx' })
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
      return { name, content, blocks }
    })
  }

  async savePositions(name: string, positions: Record<string, { x: number; y: number }>): Promise<void> {
    this.resolveName(name)
    return this.withLock(name, async () => {
      const board = await this.readBoard(name)
      await this.writeBoard(name, applyPositions(board, positions))
    })
  }
}
