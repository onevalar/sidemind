import { createHash } from 'node:crypto'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'

/** A parsed top-level block; `id` is assigned later by reconcile(). */
export interface ParsedBlock {
  type: string
  raw: string
  start: number
  end: number
  /** SHA-256 prefix of type + normalized content; used only for matching, never as identity. */
  hash: string
}

const processor = unified().use(remarkParse).use(remarkGfm)

export function hashBlock(type: string, raw: string): string {
  const normalized = raw.replace(/\r\n?/g, '\n')
  return createHash('sha256').update(`${type}\n${normalized}`).digest('hex').slice(0, 16)
}

/**
 * Splits a Markdown document into its top-level blocks using exact character offsets.
 * Every top-level node becomes a block (headings, paragraphs, lists, tables, code,
 * quotes, rules, raw HTML ...), so nothing in the file is invisible on the canvas.
 * Blank lines and front matter-less gaps between blocks are not blocks.
 */
export function parseBlocks(content: string): ParsedBlock[] {
  const tree = processor.parse(content)
  const blocks: ParsedBlock[] = []
  for (const node of tree.children) {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined || end <= start) continue
    const type = node.type === 'heading' ? `heading-${node.depth}` : node.type
    const raw = content.slice(start, end)
    blocks.push({ type, raw, start, end, hash: hashBlock(type, raw) })
  }
  return blocks
}

/** Replaces exactly one block's source, leaving every other byte of the file untouched. */
export function replaceRange(content: string, start: number, end: number, replacement: string): string {
  return content.slice(0, start) + replacement + content.slice(end)
}
