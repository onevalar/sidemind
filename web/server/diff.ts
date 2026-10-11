export type DiffOp<T> = { kind: 'same' | 'add' | 'remove'; item: T }

/** Myers O(ND) diff over arrays; falls back to a coarse replace when the edit distance is huge. */
export function diff<T>(a: T[], b: T[], equal: (x: T, y: T) => boolean = (x, y) => x === y, maxD = 4000): DiffOp<T>[] {
  let start = 0, endA = a.length, endB = b.length
  while (start < endA && start < endB && equal(a[start]!, b[start]!)) start++
  while (endA > start && endB > start && equal(a[endA - 1]!, b[endB - 1]!)) { endA--; endB-- }
  const head = a.slice(0, start).map(item => ({ kind: 'same' as const, item }))
  const tail = a.slice(endA).map(item => ({ kind: 'same' as const, item }))
  const x = a.slice(start, endA), y = b.slice(start, endB)
  const n = x.length, m = y.length, max = Math.min(n + m, maxD)
  const offset = max + 1, v = new Int32Array(2 * max + 3), trace: Int32Array[] = []
  let found = n === 0 && m === 0
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let i = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1
      let j = i - k
      while (i < n && j < m && equal(x[i]!, y[j]!)) { i++; j++ }
      v[offset + k] = i
      if (i >= n && j >= m) { found = true; break }
    }
  }
  if (!found) return [...head, ...x.map(item => ({ kind: 'remove' as const, item })), ...y.map(item => ({ kind: 'add' as const, item })), ...tail]
  const ops: DiffOp<T>[] = []
  let i = n, j = m
  for (let d = trace.length - 1; d >= 0 && (i > 0 || j > 0); d--) {
    const vd = trace[d]!, k = i - j
    const prevK = k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!) ? k + 1 : k - 1
    const prevI = d === 0 ? 0 : vd[offset + prevK]!, prevJ = prevI - prevK
    while (i > prevI && j > prevJ) { ops.push({ kind: 'same', item: x[--i]! }); j-- }
    if (d > 0) { if (i === prevI) ops.push({ kind: 'add', item: y[--j]! }); else ops.push({ kind: 'remove', item: x[--i]! }) }
  }
  while (i > 0 && j > 0) { ops.push({ kind: 'same', item: x[--i]! }); j-- }
  return [...head, ...ops.reverse(), ...tail]
}

/** Compact unified-style line diff for showing to a model or a person. */
export function unifiedDiff(before: string, after: string, context = 2, limit = 12000): string {
  const ops = diff(before.replace(/\r\n?/g, '\n').split('\n'), after.replace(/\r\n?/g, '\n').split('\n'))
  const keep = new Set<number>()
  ops.forEach((op, index) => { if (op.kind !== 'same') for (let at = index - context; at <= index + context; at++) keep.add(at) })
  let out = '', gap = false
  ops.forEach((op, index) => {
    if (!keep.has(index)) { gap = true; return }
    if (gap && out) out += '…\n'
    gap = false
    out += (op.kind === 'add' ? '+ ' : op.kind === 'remove' ? '- ' : '  ') + op.item + '\n'
  })
  return out.length > limit ? out.slice(0, limit) + '\n…（差异过长，已截断）' : out
}
