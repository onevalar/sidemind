import { randomUUID } from 'node:crypto'
import type { ParsedBlock } from './markdown'

/** What we remember about one block between sessions (the "sidecar" metadata). */
export interface BoardEntry {
  id: string
  hash: string
  type: string
  /** Position of the block in the document the last time we saw it. */
  index: number
  x?: number
  y?: number
}

export interface BoardFile {
  version: 1
  entries: BoardEntry[]
}

export const emptyBoard = (): BoardFile => ({ version: 1, entries: [] })

/**
 * Matches the blocks currently in the file to what we remembered, so a block keeps its
 * identity (and its place on the canvas) when the text around it, or it, changes.
 *
 *  1. Blocks with identical content keep their entry (first-come, in document order,
 *     so duplicate blocks stay distinct and don't swap).
 *  2. Leftover blocks are paired in reading order with leftover entries of the same
 *     type: this is the "I edited this paragraph" case.
 *  3. Anything still unmatched is new (fresh id); unmatched entries are dropped.
 *
 * An empty block list is treated as "nothing parsed" and leaves the board alone, so a
 * transiently empty/unreadable file can never wipe a user's layout.
 */
export function reconcile(
  board: BoardFile,
  blocks: ParsedBlock[],
  newId: () => string = randomUUID,
): { board: BoardFile; changed: boolean } {
  if (blocks.length === 0) return { board, changed: false }

  const entryForBlock: (BoardEntry | undefined)[] = new Array(blocks.length).fill(undefined)
  const used = new Set<BoardEntry>()
  const byIndex = [...board.entries].sort((a, b) => a.index - b.index)

  // Pass 1: exact content
  blocks.forEach((b, i) => {
    const hit = byIndex.find((e) => !used.has(e) && e.hash === b.hash)
    if (hit) {
      used.add(hit)
      entryForBlock[i] = hit
    }
  })

  // Pass 2: same type, in reading order
  blocks.forEach((b, i) => {
    if (entryForBlock[i]) return
    const hit = byIndex.find((e) => !used.has(e) && e.type === b.type)
    if (hit) {
      used.add(hit)
      entryForBlock[i] = hit
    }
  })

  const entries: BoardEntry[] = blocks.map((b, i) => {
    const prev = entryForBlock[i]
    return {
      id: prev?.id ?? newId(),
      hash: b.hash,
      type: b.type,
      index: i,
      ...(prev?.x !== undefined && prev?.y !== undefined ? { x: prev.x, y: prev.y } : {}),
    }
  })

  const next: BoardFile = { version: 1, entries }
  const changed = JSON.stringify(next) !== JSON.stringify(board)
  return { board: changed ? next : board, changed }
}

/** Applies dragged positions; ids that no longer exist are ignored. */
export function applyPositions(
  board: BoardFile,
  positions: Record<string, { x: number; y: number }>,
): BoardFile {
  return {
    version: 1,
    entries: board.entries.map((e) => {
      const p = positions[e.id]
      return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { ...e, x: p.x, y: p.y } : e
    }),
  }
}
