import { createHash } from 'node:crypto'
import type { Nodes } from 'mdast'
import { parser, summaryText } from './store'

/** A flat section: one heading up to the next heading of any level. Text before the first heading is "开头". */
export type Section = {
  /** Heading path plus a duplicate counter, stable while the heading text is unchanged. */
  key: string
  heading: string
  level: number
  start: number
  end: number
  text: string
  hash: string
}

export const PREAMBLE = '(开头)'
const normalize = (text: string) => text.replace(/\r\n?/g, '\n').split('\n').map(line => line.replace(/[ \t]+$/, '')).join('\n').trim()
export const sectionHash = (text: string) => createHash('sha256').update(normalize(text)).digest('hex')

export function headingText(node: Nodes): string {
  return 'children' in node ? node.children.map(child => 'value' in child ? child.value : headingText(child)).join('').trim() : ''
}

export function splitSections(content: string): Section[] {
  const tree = parser.parse(content)
  const headings = tree.children.filter(node => node.type === 'heading' && node.position?.start.offset !== undefined)
  const sections: Section[] = []
  const first = headings[0]?.position!.start.offset ?? content.length
  if (content.slice(0, first).trim()) sections.push(make(PREAMBLE, PREAMBLE, 0, 0, first, content))
  const stack: { level: number; title: string }[] = []
  const seen = new Map<string, number>()
  headings.forEach((node, index) => {
    if (node.type !== 'heading') return
    const title = headingText(node) || '(无标题)'
    while (stack.length && stack.at(-1)!.level >= node.depth) stack.pop()
    stack.push({ level: node.depth, title })
    const base = stack.map(item => item.title).join(' / ')
    const count = (seen.get(base) ?? 0) + 1
    seen.set(base, count)
    const start = node.position!.start.offset!, end = headings[index + 1]?.position!.start.offset ?? content.length
    sections.push(make(count > 1 ? `${base} #${count}` : base, title, node.depth, start, end, content))
  })
  return sections
}

function make(key: string, heading: string, level: number, start: number, end: number, content: string): Section {
  const text = content.slice(start, end)
  return { key, heading, level, start, end, text, hash: sectionHash(text) }
}

/** Plain text of a Markdown fragment, without heading markers or syntax. */
export function plainText(markdown: string): string {
  return summaryText(parser.parse(markdown)).replace(/\s+/g, ' ').trim()
}
