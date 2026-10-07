import { describe, expect, it } from 'vitest'
import { applyPositions, emptyBoard, reconcile } from '../server/board'
import { parseBlocks } from '../server/markdown'

let n = 0
const id = () => `id${++n}`
const run = (board = emptyBoard(), md = '') => reconcile(board, parseBlocks(md), id)

describe('reconcile', () => {
  it('assigns ids to new blocks and is stable on a second pass', () => {
    const first = run(emptyBoard(), 'A\n\nB')
    expect(first.changed).toBe(true)
    const again = run(first.board, 'A\n\nB')
    expect(again.changed).toBe(false)
    expect(again.board.entries.map((e) => e.id)).toEqual(first.board.entries.map((e) => e.id))
  })

  it('an edited block keeps its id and position; untouched siblings keep theirs', () => {
    let { board } = run(emptyBoard(), 'A\n\nB')
    board = applyPositions(board, { [board.entries[0]!.id]: { x: 10, y: 20 }, [board.entries[1]!.id]: { x: 300, y: 5 } })
    const before = board.entries.map((e) => e.id)
    const { board: after } = run(board, 'A (edited)\n\nB')
    expect(after.entries.map((e) => e.id)).toEqual(before)
    expect(after.entries[0]).toMatchObject({ x: 10, y: 20 })
    expect(after.entries[1]).toMatchObject({ x: 300, y: 5 })
  })

  it('reordering identical-content blocks by moving text keeps ids with content', () => {
    const { board } = run(emptyBoard(), 'A\n\nB\n\nC')
    const [a, b, c] = board.entries.map((e) => e.id)
    const { board: after } = run(board, 'C\n\nA\n\nB')
    expect(after.entries.map((e) => e.id)).toEqual([c, a, b])
  })

  it('duplicate blocks stay distinct', () => {
    const { board } = run(emptyBoard(), 'Same\n\nSame\n\nSame')
    expect(new Set(board.entries.map((e) => e.id)).size).toBe(3)
  })

  it('deleting a block drops only its entry; adding one creates a fresh id', () => {
    const { board } = run(emptyBoard(), 'A\n\nB\n\nC')
    const [a, , c] = board.entries.map((e) => e.id)
    const removed = run(board, 'A\n\nC').board
    expect(removed.entries.map((e) => e.id)).toEqual([a, c])
    const added = run(removed, 'A\n\n# New\n\nC').board
    expect(added.entries).toHaveLength(3)
    expect(added.entries[0]!.id).toBe(a)
    expect(added.entries[2]!.id).toBe(c)
  })

  it('an empty parse never wipes the board', () => {
    const { board } = run(emptyBoard(), 'A\n\nB')
    const res = reconcile(board, [], id)
    expect(res.changed).toBe(false)
    expect(res.board.entries).toHaveLength(2)
  })
})

describe('applyPositions', () => {
  it('ignores unknown ids and non-finite numbers', () => {
    const { board } = run(emptyBoard(), 'A')
    const out = applyPositions(board, { nope: { x: 1, y: 1 }, [board.entries[0]!.id]: { x: NaN, y: 2 } })
    expect(out.entries[0]!.x).toBeUndefined()
  })
})
