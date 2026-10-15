/** One lossless changed range, with identical leading/trailing lines kept as context. */
export function editPreview(original: string, replacement: string) {
  const before = original.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const after = replacement.match(/[^\n]*\n|[^\n]+$/g) ?? []
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let end = 0
  while (end < before.length - start && end < after.length - start && before[before.length - end - 1] === after[after.length - end - 1]) end++
  const prefix = before.slice(0, start)
  const suffix = end ? before.slice(-end) : []
  return {
    changed: original !== replacement,
    prefix: prefix.join(''),
    suffix: suffix.join(''),
    leadingContext: prefix.slice(-2).join(''),
    trailingContext: suffix.slice(0, 2).join(''),
    hiddenLeading: Math.max(0, prefix.length - 2),
    hiddenTrailing: Math.max(0, suffix.length - 2),
    removed: before.slice(start, before.length - end).join(''),
    added: after.slice(start, after.length - end).join(''),
  }
}
