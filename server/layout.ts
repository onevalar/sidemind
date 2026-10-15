import type { CanvasFrame, NotePosition } from '../shared/types'

/** Card geometry shared with the canvas UI (LibraryCanvas.tsx). */
export const CARD = { width: 280, height: 192, columnStep: 312, rowStep: 224 }

/** A frame tightly around its member cards, matching the UI's fitFrame. */
export function fitFrame(frame: CanvasFrame, positions: Record<string, NotePosition>): CanvasFrame {
  const cards = frame.members.map(name => positions[name]).filter((p): p is NotePosition => !!p)
  if (!cards.length) return frame
  const x = Math.min(...cards.map(p => p.x)) - 24, y = Math.min(...cards.map(p => p.y)) - 64
  return { ...frame, position: { x, y },
    width: Math.max(336, Math.max(...cards.map(p => p.x)) + 304 - x),
    height: Math.max(280, Math.max(...cards.map(p => p.y)) + 216 - y) }
}

/** Bounding box of every card and frame, to place new content without overlap. */
export function extent(positions: NotePosition[], frames: CanvasFrame[]): { bottom: number; left: number } {
  const bottoms = [...positions.map(p => p.y + CARD.height), ...frames.map(frame => frame.position.y + frame.height)]
  const lefts = [...positions.map(p => p.x), ...frames.map(frame => frame.position.x)]
  return { bottom: bottoms.length ? Math.max(...bottoms) : 0, left: lefts.length ? Math.min(...lefts) : 48 }
}

/** Grid positions for `count` cards starting at an origin, `columns` per row. */
export function grid(origin: NotePosition, count: number, columns = 3): NotePosition[] {
  return Array.from({ length: count }, (_, index) => ({ x: origin.x + (index % columns) * CARD.columnStep, y: origin.y + Math.floor(index / columns) * CARD.rowStep }))
}

/**
 * Lays out named groups as frames, left to right then wrapping, below/at an origin.
 * Returns member positions and fitted frames; coordinates are computed here, not by the model.
 */
export function layoutGroups(groups: { id: string; title: string; members: string[] }[], origin: NotePosition, space: string, rowWidth = 3200): { positions: Record<string, NotePosition>; frames: CanvasFrame[] } {
  const positions: Record<string, NotePosition> = {}, frames: CanvasFrame[] = []
  let x = origin.x, y = origin.y, rowHeight = 0
  for (const group of groups) {
    const columns = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(group.members.length))))
    const rows = Math.max(1, Math.ceil(group.members.length / columns))
    const width = 48 + columns * CARD.columnStep, height = 88 + rows * CARD.rowStep
    if (x > origin.x && x + width > origin.x + rowWidth) { x = origin.x; y += rowHeight + 64; rowHeight = 0 }
    grid({ x: x + 24, y: y + 64 }, group.members.length, columns).forEach((position, index) => { positions[group.members[index]!] = position })
    frames.push(fitFrame({ id: group.id, space, title: group.title, position: { x, y }, width, height, members: group.members }, positions))
    x += width + 64
    rowHeight = Math.max(rowHeight, height)
  }
  return { positions, frames }
}
