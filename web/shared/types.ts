/** A top-level Markdown block, as the client sees it. */
export interface BlockDTO {
  /** Stable across edits; assigned by the server, not derived from content. */
  id: string
  type: string
  /** Exact source text of the block. */
  raw: string
  /** Character offsets into the note's content (end exclusive). */
  start: number
  end: number
  /** Canvas position; null until the block has been placed. */
  x: number | null
  y: number | null
}

export interface NoteDTO {
  name: string
  content: string
  blocks: BlockDTO[]
  groups: CanvasGroup[]
  space: string
}

export interface CanvasGroup {
  id: string
  title: string
  x: number
  y: number
  blockIds: string[]
}

export interface NoteSummary {
  name: string
  mtime: number
  /** Explicit user visits, independent of file modification time. */
  lastOpenedAt: number
  title: string
  excerpt: string
  blockCount: number
  space: string
}

export interface PublicAIConfig {
  configured: boolean
  keySaved: boolean
  model: string
  baseUrl: string
  source: 'saved' | 'environment' | 'none'
  /** Recoverable configuration error; never includes credentials. */
  error?: string
}
export interface AIConnectionInput {
  model: string
  baseUrl: string
  key?: string
}
