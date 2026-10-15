import fs from 'node:fs/promises'
import path from 'node:path'
import { contentVersion, folderOf, parser, summaryText, type NoteStore } from './store'
import { headingText, splitSections, type Section } from './sections'

export type IndexedNote = {
  name: string
  folder: string
  title: string
  content: string
  version: string
  characters: number
  headings: { title: string; line: number }[]
  sections: Section[]
  /** Local extract sampled across the whole article, used until a memory summary exists. */
  extract: string
  mtime: number
  size: number
}

export type SearchMatch = { name: string; title: string; section: string; offset: number; excerpt: string }

/**
 * In-memory index over all notes. Each sync re-reads only files whose size or mtime changed,
 * so tools no longer read the whole library from disk on every call.
 */
export class NoteIndex {
  private notes = new Map<string, IndexedNote>()
  private running: Promise<Map<string, IndexedNote>> | null = null

  constructor(private store: NoteStore) {}

  sync(): Promise<Map<string, IndexedNote>> {
    // A sync that started before a write may miss it, so waiters run one more pass afterwards.
    if (this.running) return this.running.then(() => this.sync())
    this.running = this.refresh().finally(() => { this.running = null })
    return this.running
  }

  private async refresh(): Promise<Map<string, IndexedNote>> {
    const names = await this.store.names()
    const next = new Map<string, IndexedNote>()
    for (const name of names) {
      const file = path.join(this.store.root, name)
      const stat = await fs.stat(file).catch(() => null)
      if (!stat?.isFile()) continue
      const cached = this.notes.get(name)
      if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) { next.set(name, cached); continue }
      const content = await fs.readFile(file, 'utf8').catch(() => null)
      if (content === null) continue
      next.set(name, index(name, content, stat.mtimeMs, stat.size))
    }
    this.notes = next
    return next
  }

  async all(folder = '', recursive = true): Promise<IndexedNote[]> {
    const notes = [...(await this.sync()).values()]
    return notes.filter(note => recursive ? !folder || note.name.startsWith(folder + '/') : note.folder === folder)
  }

  async get(name: string): Promise<IndexedNote | undefined> { return (await this.sync()).get(name) }

  /** Case-insensitive text or regular-expression search; returns one excerpt per matching section. */
  async search(query: string, options: { folder?: string; regex?: boolean; limit?: number } = {}): Promise<{ total: number; matches: SearchMatch[] }> {
    let pattern: RegExp
    if (options.regex) pattern = new RegExp(query, 'giu')
    else pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
    const matches: SearchMatch[] = []
    for (const note of await this.all(options.folder ?? '')) {
      if (!options.regex && note.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && !pattern.test(note.content)) {
        matches.push({ name: note.name, title: note.title, section: '', offset: 0, excerpt: note.extract.slice(0, 300) })
        continue
      }
      pattern.lastIndex = 0
      const seen = new Set<string>()
      for (const match of note.content.matchAll(pattern)) {
        if (!match[0]) break
        const at = match.index!, section = note.sections.find(section => at >= section.start && at < section.end)
        const key = section?.key ?? ''
        if (seen.has(key)) continue
        seen.add(key)
        matches.push({ name: note.name, title: note.title, section: key, offset: at, excerpt: note.content.slice(Math.max(0, at - 120), at + 360) })
        if (seen.size >= 5) break
      }
    }
    return { total: matches.length, matches: matches.slice(0, options.limit ?? 40) }
  }
}

export function index(name: string, content: string, mtime = 0, size = content.length): IndexedNote {
  const tree = parser.parse(content)
  const headings = tree.children.filter(node => node.type === 'heading').map(node => ({ title: headingText(node), line: node.position!.start.line }))
  const paragraphs = tree.children.map(summaryText).map(text => text.trim().replace(/\s+/g, ' ')).filter(Boolean)
  const count = Math.min(6, paragraphs.length)
  const samples = Array.from({ length: count }, (_, i) => paragraphs[Math.floor(i * (paragraphs.length - 1) / Math.max(1, count - 1))]!.slice(0, 180))
  return {
    name, folder: folderOf(name), content, version: contentVersion(content), characters: content.length, headings,
    title: /^#\s+(.+)$/m.exec(content)?.[1]?.trim() ?? path.basename(name, '.md'),
    sections: splitSections(content), extract: samples.join('\n'), mtime, size,
  }
}
