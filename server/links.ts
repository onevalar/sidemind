import type { Nodes } from 'mdast'
import { linkedNoteName, relativeHref } from '../shared/links'
import { folderOf, parser } from './store'

/** A local note link: `start`/`end` delimit the raw destination text in the source Markdown. */
export type NoteLink = { start: number; end: number; href: string; target: string; fragment: string }

/** Finds inline links and reference definitions that point at other notes (fragments allowed). */
export function findLinks(content: string, source: string): NoteLink[] {
  const links: NoteLink[] = []
  const visit = (node: Nodes) => {
    if ((node.type === 'link' || node.type === 'definition') && node.position?.start.offset !== undefined) {
      const range = destination(content, node)
      if (range) {
        const raw = content.slice(range[0], range[1])
        const href = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw
        const hash = href.indexOf('#'), path = hash >= 0 ? href.slice(0, hash) : href
        const target = path ? linkedNoteName(path, source) : null
        if (target) links.push({ start: range[0], end: range[1], href, target, fragment: hash >= 0 ? href.slice(hash) : '' })
      }
    }
    if ('children' in node) for (const child of node.children) visit(child as Nodes)
  }
  visit(parser.parse(content))
  return links
}

/** Locates the destination of `[text](dest "title")` or `[id]: dest`, from the node's source text. */
function destination(content: string, node: Nodes): [number, number] | null {
  const start = node.position!.start.offset!, end = node.position!.end.offset!
  let at: number
  if (node.type === 'definition') {
    at = content.indexOf(']:', start)
    if (at < 0 || at >= end) return null
    at += 2
  } else {
    const children = 'children' in node ? node.children : []
    const textEnd = children.length ? children.at(-1)!.position?.end.offset ?? start + 1 : start + 1
    at = content.indexOf('](', textEnd)
    if (at < 0 || at >= end) return null // reference-style link: its definition carries the href
    at += 2
  }
  while (at < end && /[ \t\n]/.test(content[at]!)) at++
  if (content[at] === '<') { const close = content.indexOf('>', at); return close > 0 && close < end ? [at, close + 1] : null }
  let stop = at, depth = 0
  while (stop < end) {
    const character = content[stop]!
    if (/\s/.test(character)) break
    if (character === '(') depth++
    if (character === ')') { if (depth === 0) break; depth-- }
    stop++
  }
  return stop > at ? [at, stop] : null
}

/**
 * Rewrites note links in `content` after notes moved. `source`/`nextSource` are this note's old and new names.
 * Only links whose resolution would otherwise change are rewritten; everything else is left byte-for-byte.
 */
export function rewriteLinks(content: string, source: string, nextSource: string, moves: Map<string, string>): string {
  const links = findLinks(content, source)
  let result = '', last = 0
  for (const link of links) {
    const target = moves.get(link.target) ?? link.target
    const hash = link.href.indexOf('#'), path = hash >= 0 ? link.href.slice(0, hash) : link.href
    if (linkedNoteName(path, nextSource) === target) continue
    const raw = content.slice(link.start, link.end)
    const href = relativeHref(target, folderOf(nextSource)) + link.fragment
    result += content.slice(last, link.start) + (raw.startsWith('<') ? '<' + href + '>' : href)
    last = link.end
  }
  return last ? result + content.slice(last) : content
}
