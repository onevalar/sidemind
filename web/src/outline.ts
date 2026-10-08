import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Nodes } from 'mdast'

const parser = unified().use(remarkParse).use(remarkGfm)
export type OutlineHeading = { start: number; depth: number; title: string }

function text(node: Nodes): string {
  if ('value' in node) return node.value
  if ('alt' in node) return node.alt || ''
  return 'children' in node ? node.children.map(text).join('') : ''
}

/** The draft is the source, so unsaved edits cannot leave heading offsets stale. */
export function outlineHeadings(content: string): OutlineHeading[] {
  const headings: OutlineHeading[] = []
  function visit(node: Nodes) {
    if (node.type === 'heading' && node.position?.start.offset !== undefined) headings.push({ start: node.position.start.offset, depth: node.depth, title: text(node) || '未命名标题' })
    if ('children' in node) node.children.forEach(visit)
  }
  visit(parser.parse(content))
  return headings
}
