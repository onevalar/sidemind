import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Nodes } from 'mdast'
import { project } from '../shared/projection'

const parser = unified().use(remarkParse).use(remarkGfm)
let cached: { markdown: string; visible: string; starts: number[]; ends: number[] } | undefined

/** Map visible selection text back to the original Markdown, without serializing a cut block.
 * A ProseMirror slice can synthesize headings, bold delimiters or link destinations that were
 * never selected. AST leaf positions let links and partial inline selections retain real offsets.
 */
export function richSelectionSource(markdown: string, selectedText: string): string | null {
  const wanted = project(selectedText).text
  if (!wanted) return null
  if (cached?.markdown === markdown) return locateSelection(cached, wanted)
  let visible = ''
  const starts: number[] = [], ends: number[] = []
  const append = (text: string, start: number, end: number) => {
    const projected = project(text).text
    visible += projected
    for (let i = 0; i < projected.length; i++) { starts.push(start); ends.push(end) }
  }
  const decodeEntity = (raw: string) => {
    const root = parser.parse(raw), first = root.children[0]
    return first?.type === 'paragraph' && first.children.length === 1 && first.children[0]?.type === 'text' ? first.children[0].value : raw
  }
  const visit = (node: Nodes) => {
    if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code') {
      const start = node.position?.start.offset, end = node.position?.end.offset
      if (start === undefined || end === undefined) return
      let raw = markdown.slice(start, end), offset = start
      if (node.type === 'code' && /^\s*(`{3,}|~{3,})/.test(raw)) {
        const contentStart = raw.indexOf('\n') + 1
        const fence = /^\s*(`{3,}|~{3,})/.exec(raw)![1]!
        const closing = new RegExp('\\n[ \t]*' + (fence[0] === '`' ? '`' : '~') + '{' + fence.length + ',}[ \t]*$')
        offset += contentStart; raw = raw.slice(contentStart).replace(closing, '')
      }
      for (let at = 0; at < raw.length;) {
        // Only normal text decodes escapes and entities; code preserves them literally.
        const escape = node.type === 'text' ? /^\\[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.exec(raw.slice(at))?.[0] : undefined
        const entity = node.type === 'text' ? /^&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][a-zA-Z\d]+);/.exec(raw.slice(at))?.[0] : undefined
        const token = escape ?? entity ?? String.fromCodePoint(raw.codePointAt(at)!)
        append(escape ? escape.slice(1) : entity ? decodeEntity(entity) : token, offset + at, offset + at + token.length)
        at += token.length
      }
    } else if ('children' in node) node.children.forEach(visit)
  }
  visit(parser.parse(markdown))
  cached = { markdown, visible, starts, ends }
  return locateSelection(cached, wanted)
}

function locateSelection({ markdown, visible, starts, ends }: NonNullable<typeof cached>, wanted: string): string | null {
  const at = visible.indexOf(wanted)
  // Keep ambiguity explicit: the source API will refuse a repeated visible quote.
  if (at < 0 || visible.indexOf(wanted, at + 1) >= 0) return null
  return markdown.slice(starts[at]!, ends[at + wanted.length - 1]!)
}
