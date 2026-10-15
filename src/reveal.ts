import { project } from '../shared/projection'
// Finds a quoted passage in the rendered editor. Rendered text and Markdown source differ in spacing and
// markers, so both sides are compared with those removed; the same rule the server uses to save a source.
const NOISE = /[\s*_`\\>#]/u

export const plainText = (markdown: string) => project(markdown).text

type Spot = { node: Text; offset: number }

/** The first place `quote` appears in the text under `root`, as a DOM range, or null. */
export function findTextRange(root: Node, quote: string): Range | null {
  const walker = (root.ownerDocument ?? document).createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let projected = ''
  const spots: Spot[] = []
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    for (let offset = 0; offset < node.data.length;) {
      const char = String.fromCodePoint(node.data.codePointAt(offset)!)
      if (!NOISE.test(char)) { projected += char; for (let unit = 0; unit < char.length; unit++) spots.push({ node, offset: offset + unit }) }
      offset += char.length
    }
  }
  // Try the whole passage, then its longest line: a long selection may span blocks the editor wraps differently.
  const candidates = [quote, ...[...quote.split('\n')].sort((a, b) => plainText(b).length - plainText(a).length)].map(plainText).filter(text => text.length >= 2)
  for (const wanted of new Set(candidates)) {
    const at = projected.indexOf(wanted)
    if (at < 0) continue
    const first = spots[at]!, last = spots[at + wanted.length - 1]!
    const range = (root.ownerDocument ?? document).createRange()
    range.setStart(first.node, first.offset)
    range.setEnd(last.node, last.offset + 1)
    return range
  }
  return null
}
