import { describe, expect, it } from 'vitest'
import { GAP_X, GAP_Y, NODE_H, NODE_W, layoutGraph, type GraphTurn } from '../shared/graph'

let clock = 0
const turn = (id: string, parents: string[] = [], createdAt = ++clock): GraphTurn => ({ id, parents, createdAt })
const at = (turns: GraphTurn[]) => Object.fromEntries(layoutGraph(turns).nodes.map(node => [node.id, [node.depth, node.column]]))

describe('layoutGraph', () => {
  it('puts a turn one row below its deepest parent, and a root in row 0', () => {
    clock = 0
    expect(at([turn('r'), turn('a', ['r']), turn('a2', ['a'])])).toEqual({ r: [0, 0], a: [1, 0], a2: [2, 0] })
  })

  it('keeps sibling branches side by side under their parent and a merge below both of its sources', () => {
    clock = 0
    const layout = at([turn('r'), turn('a', ['r']), turn('b', ['r']), turn('b2', ['b']), turn('m', ['a', 'b2'])])
    expect(layout).toMatchObject({ r: [0, 0], a: [1, 0], b: [1, 1], b2: [2, 0], m: [3, 0] })
    const result = layoutGraph([turn('r'), turn('a', ['r']), turn('b', ['r']), turn('m', ['a', 'b'])])
    expect(result.edges.filter(edge => edge.to === 'm').every(edge => edge.merge)).toBe(true)
    expect(result.edges.filter(edge => edge.to !== 'm').every(edge => !edge.merge)).toBe(true)
  })

  it('does not depend on the order the turns are stored in', () => {
    clock = 0
    const turns = [turn('r'), turn('a', ['r']), turn('b', ['r']), turn('m', ['a', 'b'])]
    expect(at([...turns].reverse())).toEqual(at(turns))
  })

  it('orders a row by where the parents sit, then by creation time, so a branch stays under its own parent', () => {
    clock = 0
    const turns = [turn('r'), turn('a', ['r']), turn('b', ['r']), turn('b1', ['b'], 10), turn('a1', ['a'], 20)]
    expect(at(turns)).toMatchObject({ a: [1, 0], b: [1, 1], a1: [2, 0], b1: [2, 1] })
  })

  it('ignores parents that are not in the list and cannot loop on a cycle', () => {
    clock = 0
    expect(at([turn('x', ['gone'])])).toEqual({ x: [0, 0] })
    const cyclic = layoutGraph([turn('p', ['q']), turn('q', ['p'])])
    expect(cyclic.nodes).toHaveLength(2)
  })

  it('reports the pixel size of what it placed, and nothing for an empty discussion', () => {
    clock = 0
    const result = layoutGraph([turn('r'), turn('a', ['r']), turn('b', ['r'])])
    expect(result.width).toBe(2 * NODE_W + GAP_X)
    expect(result.height).toBe(2 * NODE_H + GAP_Y)
    expect(layoutGraph([])).toEqual({ nodes: [], edges: [], width: 0, height: 0 })
  })
})
