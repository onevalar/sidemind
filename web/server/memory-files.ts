import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { BadNameError, ConflictError } from './store'

export const LIBRARY_MEMORY = '_library.md'
export const folderMemory = (folder: string) => (folder ? folder + '/' : '') + '_folder.md'

/**
 * Memory files mirror the notes tree: `memory/<note path>` for an article, `_folder.md` per folder,
 * `_library.md` for the whole library. They are committed with the notes.
 */
export class MemoryFiles {
  private locks = new Map<string, Promise<unknown>>()
  constructor(readonly root: string) {}

  private file(name: string): string {
    if (typeof name !== 'string' || !name.endsWith('.md') || name.length > 1000 || /[\\\0]/.test(name) || name.split('/').some(part => !part || part === '..' || (part.startsWith('.')))) throw new BadNameError('记忆文件路径无效。')
    return path.join(this.root, name)
  }

  async read(name: string): Promise<string | null> {
    try { return await fs.readFile(this.file(name), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }

  async replaceFile(name: string, expected: string | null, next: string | null): Promise<void> {
    const file = this.file(name)
    const run = (this.locks.get(name) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const current = await this.read(name)
      if (current !== expected) throw new ConflictError(`记忆「${name}」已被修改，未覆盖。`)
      if (next === null) { await fs.rm(file, { force: true }); await this.prune(path.dirname(file)); return }
      await fs.mkdir(path.dirname(file), { recursive: true })
      const tmp = file + '.' + randomUUID() + '.tmp'
      try { await fs.writeFile(tmp, next, 'utf8'); await fs.rename(tmp, file) }
      finally { await fs.rm(tmp, { force: true }) }
    })
    this.locks.set(name, run)
    try { await run } finally { if (this.locks.get(name) === run) this.locks.delete(name) }
  }

  /** Writes unconditionally; for pipeline steps that already hold the latest content. */
  async write(name: string, next: string): Promise<void> { await this.replaceFile(name, await this.read(name), next) }

  async list(): Promise<string[]> {
    const names: string[] = []
    const visit = async (relative: string) => {
      let entries: import('node:fs').Dirent[]
      try { entries = await fs.readdir(path.join(this.root, relative), { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const name = relative ? relative + '/' + entry.name : entry.name
        if (entry.isDirectory()) await visit(name)
        else if (entry.isFile() && entry.name.endsWith('.md')) names.push(name)
      }
    }
    await visit('')
    return names.sort()
  }

  private async prune(directory: string): Promise<void> {
    while (directory.startsWith(this.root + path.sep)) {
      if ((await fs.readdir(directory).catch(() => ['x'])).length) return
      await fs.rmdir(directory).catch(() => {})
      directory = path.dirname(directory)
    }
  }
}

/** Article memory mirrors the note path; names reserved for folder/library memory are escaped. */
export const noteMemory = (note: string) => {
  const base = note.slice(note.lastIndexOf('/') + 1)
  return base === '_folder.md' || base === '_library.md' ? note.slice(0, -3) + ' (笔记).md' : note
}
