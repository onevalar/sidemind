export interface GraphTurn { id: string; parents: string[]; createdAt: number }
export interface GraphNode { id: string; depth: number; column: number; x: number; y: number }
export interface GraphEdge { from: string; to: string; /** The child merges several branches. */ merge: boolean }
export interface GraphLayout { nodes: GraphNode[]; edges: GraphEdge[]; width: number; height: number }

export const NODE_W = 196, NODE_H = 52, GAP_X = 20, GAP_Y = 38

/**
 * Layers a discussion: a turn sits one row below its deepest parent, so parents always come before children however the
 * turns are stored. Within a row, nodes are ordered by where their parents sit (keeping a branch under its parent and
 * limiting crossings), then by creation time. Parents that are not in the list are ignored and a cycle cannot loop:
 * every turn is placed at most once.
 */
export function layoutGraph(turns: GraphTurn[]): GraphLayout {
  const byId = new Map(turns.map(turn => [turn.id, turn]))
  const depth = new Map<string, number>(), visiting = new Set<string>()
  const depthOf = (turn: GraphTurn): number => {
    const known = depth.get(turn.id)
    if (known !== undefined) return known
    if (visiting.has(turn.id)) return 0
    visiting.add(turn.id)
    const parents = turn.parents.map(id => byId.get(id)).filter((parent): parent is GraphTurn => !!parent)
    const value = parents.length ? 1 + Math.max(...parents.map(depthOf)) : 0
    visiting.delete(turn.id)
    depth.set(turn.id, value)
    return value
  }
  for (const turn of turns) depthOf(turn)
  const rows: GraphTurn[][] = []
  for (const turn of turns) (rows[depth.get(turn.id)!] ??= []).push(turn)
  const column = new Map<string, number>()
  const order = (row: GraphTurn[]) => {
    const key = (turn: GraphTurn) => {
      const spots = turn.parents.map(id => column.get(id)).filter((value): value is number => value !== undefined)
      return spots.length ? spots.reduce((sum, value) => sum + value, 0) / spots.length : Number.POSITIVE_INFINITY
    }
    return [...row].sort((a, b) => (key(a) - key(b)) || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }
  const nodes: GraphNode[] = []
  let widest = 0
  rows.forEach((row, level) => {
    if (!row) return
    order(row).forEach((turn, index) => { column.set(turn.id, index); nodes.push({ id: turn.id, depth: level, column: index, x: index * (NODE_W + GAP_X), y: level * (NODE_H + GAP_Y) }) })
    widest = Math.max(widest, row.length)
  })
  const edges: GraphEdge[] = []
  for (const turn of turns) for (const parent of turn.parents) if (byId.has(parent)) edges.push({ from: parent, to: turn.id, merge: turn.parents.length > 1 })
  const levels = rows.filter(Boolean).length
  return { nodes, edges, width: Math.max(0, widest * (NODE_W + GAP_X) - GAP_X), height: Math.max(0, levels * (NODE_H + GAP_Y) - GAP_Y) }
}
