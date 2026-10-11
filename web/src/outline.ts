import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import type { Nodes } from 'mdast'

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml', 'toml'])
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

/** These constructs do not round-trip through Crepe's CommonMark/GFM schema. */
export function richEditingIssue(content: string): string | null {
  let issue: string | null = null
  function visit(node: Nodes, parent?: Nodes) {
    // Crepe writes standalone <br /> placeholders for empty paragraphs.
    const emptyLine = node.type === 'html' && /^<br\s*\/?\s*>$/i.test(node.value.trim()) && parent
      && (['root', 'blockquote', 'listItem'].includes(parent.type)
        || ((parent.type === 'paragraph' || parent.type === 'tableCell') && parent.children.length === 1))
    if ((node.type === 'html' && !emptyLine)
      || ['yaml', 'toml', 'definition', 'linkReference', 'imageReference', 'footnoteDefinition', 'footnoteReference'].includes(node.type)
      || (node.type === 'code' && node.meta)) issue = '这篇文章包含需要保留原样的 Markdown 扩展，已使用源码编辑。'
    if ('children' in node) node.children.forEach(child => visit(child, node))
  }
  visit(parser.parse(content))
  return issue
}
