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
}

export interface NoteSummary {
  name: string
  mtime: number
}
