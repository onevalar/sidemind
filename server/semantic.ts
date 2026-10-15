import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Embedder } from './models'
import type { IndexedNote, NoteIndex } from './note-index'

type Chunk = { note: string; title: string; section: string; text: string; hash: string }
const CHUNK = 1500, BATCH = 64

function chunks(note: IndexedNote, model: string): Chunk[] {
  const result: Chunk[] = []
  for (const section of note.sections) {
    const pieces: string[] = []
    let current = ''
    for (const paragraph of section.text.split(/\n{2,}/)) {
      if (current && current.length + paragraph.length > CHUNK) { pieces.push(current); current = '' }
      current += (current ? '\n\n' : '') + paragraph.slice(0, CHUNK * 2)
    }
    if (current.trim()) pieces.push(current)
    for (const piece of pieces) {
      const text = `${note.title} / ${section.heading}\n${piece}`
      result.push({ note: note.name, title: note.title, section: section.key, text, hash: createHash('sha256').update(model + '\0' + text).digest('hex').slice(0, 32) })
    }
  }
  return result
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, x = 0, y = 0
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; x += a[i]! * a[i]!; y += b[i]! * b[i]! }
  return x && y ? dot / Math.sqrt(x * y) : 0
}

/**
 * Embedding vectors per section chunk, cached by content hash in cache/embeddings.json and
 * filled in incrementally. Brute-force cosine search is fast enough for thousands of notes.
 */
export class SemanticIndex {
  private vectors = new Map<string, Float32Array>()
  private loaded = false
  constructor(private index: NoteIndex, private embedder: Embedder, private file: string) {}

  get model() { return this.embedder.model }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8')) as { model: string; entries: Record<string, string> }
      if (data.model !== this.embedder.model) return
      for (const [hash, encoded] of Object.entries(data.entries)) { const buffer = Buffer.from(encoded, 'base64'); this.vectors.set(hash, new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)) }
    } catch { /* rebuilt on demand */ }
  }

  private async save(keep: Set<string>): Promise<void> {
    const entries: Record<string, string> = {}
    for (const [hash, vector] of this.vectors) if (keep.has(hash)) entries[hash] = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64')
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.' + randomUUID() + '.tmp'
    try { await fs.writeFile(tmp, JSON.stringify({ model: this.embedder.model, entries })); await fs.rename(tmp, this.file) }
    finally { await fs.rm(tmp, { force: true }) }
  }

  /** Embeds every chunk not yet cached; returns all current chunks. */
  async ensure(signal: AbortSignal): Promise<Chunk[]> {
    await this.load()
    const all = (await this.index.all()).flatMap(note => chunks(note, this.embedder.model))
    const missing = [...new Map(all.filter(chunk => !this.vectors.has(chunk.hash)).map(chunk => [chunk.hash, chunk])).values()]
    for (let start = 0; start < missing.length; start += BATCH) {
      signal.throwIfAborted()
      const batch = missing.slice(start, start + BATCH)
      const vectors = await this.embedder.embed(batch.map(chunk => chunk.text), signal)
      batch.forEach((chunk, index) => this.vectors.set(chunk.hash, Float32Array.from(vectors[index]!)))
    }
    if (missing.length) await this.save(new Set(all.map(chunk => chunk.hash)))
    return all
  }

  async search(query: string, options: { folder?: string; limit?: number; signal: AbortSignal }): Promise<{ name: string; title: string; section: string; score: number; excerpt: string }[]> {
    const all = await this.ensure(options.signal)
    const [vector] = await this.embedder.embed([query], options.signal)
    const target = Float32Array.from(vector!)
    const scored = all.filter(chunk => !options.folder || chunk.note.startsWith(options.folder + '/'))
      .map(chunk => ({ chunk, score: cosine(target, this.vectors.get(chunk.hash)!) })).sort((a, b) => b.score - a.score)
    const seen = new Set<string>(), result = []
    for (const { chunk, score } of scored) {
      const key = chunk.note + '\0' + chunk.section
      if (seen.has(key)) continue
      seen.add(key)
      result.push({ name: chunk.note, title: chunk.title, section: chunk.section, score: Math.round(score * 1000) / 1000, excerpt: chunk.text.slice(chunk.text.indexOf('\n') + 1, chunk.text.indexOf('\n') + 400) })
      if (result.length >= (options.limit ?? 10)) break
    }
    return result
  }

  /** Notes closest in meaning to `name`, using the mean of each note's chunk vectors. */
  async related(name: string, options: { limit?: number; signal: AbortSignal }): Promise<{ name: string; title: string; score: number }[]> {
    const all = await this.ensure(options.signal)
    const means = new Map<string, { title: string; vector: Float32Array }>()
    for (const chunk of all) {
      const vector = this.vectors.get(chunk.hash)!
      const entry = means.get(chunk.note) ?? { title: chunk.title, vector: new Float32Array(vector.length) }
      for (let i = 0; i < vector.length; i++) entry.vector[i] = entry.vector[i]! + vector[i]!
      means.set(chunk.note, entry)
    }
    const self = means.get(name)
    if (!self) return []
    return [...means].filter(([other]) => other !== name).map(([other, entry]) => ({ name: other, title: entry.title, score: Math.round(cosine(self.vector, entry.vector) * 1000) / 1000 }))
      .sort((a, b) => b.score - a.score).slice(0, options.limit ?? 8)
  }
}
