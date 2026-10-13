/**
 * measure.ts
 *
 * Markdown → pretext measurement pipeline.
 *
 * 1. Parse raw Markdown into typed blocks (heading, paragraph, list, code, table, …).
 * 2. For each block, call pretext's `prepare()` + `layout()` to get its height.
 * 3. Sum block heights + inter-block gaps + bubble padding = total node height.
 *
 * SSR guard: pretext needs a canvas context (OffscreenCanvas or DOM canvas).
 * When running server-side, we fall back to a character-based estimator
 * so the initial render doesn't crash.
 */

import type { Message } from '../types';
import {
  BUBBLE_CONTENT_WIDTH,
  BUBBLE_PAD_Y,
  BLOCK_GAP,
  HEADING_GAP_ABOVE,
  LIST_ITEM_GAP,
  LIST_INDENT,
  QUOTE_INDENT,
  CODE_BLOCK_PAD,
  TABLE_ROW_HEIGHT,
  MATH_BLOCK_HEIGHT,
  QUOTE_LINE_HEIGHT,
  QUOTE_MAX_LINES,
  QUOTE_STRIP_PAD,
  ERROR_NOTE_HEIGHT,
  FONT_BODY,
  FONT_H2,
  FONT_H3,
  LH_BODY,
  LH_H2,
  LH_H3,
  LH_CODE,
} from './typography';

// ─── Lazy pretext import (avoid SSR crash) ──────────────────────────────

type PrepareFn = (text: string, font: string) => unknown;
type LayoutFn = (
  prepared: unknown,
  maxWidth: number,
  lineHeight: number,
) => { height: number; lineCount: number };

let _prepare: PrepareFn | null = null;
let _layout: LayoutFn | null = null;
let _pretextAvailable: boolean | null = null;

function ensurePretext(): boolean {
  if (_pretextAvailable !== null) return _pretextAvailable;

  // Check for canvas context availability (pretext requirement)
  if (
    typeof OffscreenCanvas !== 'undefined' ||
    typeof document !== 'undefined'
  ) {
    try {
      // Dynamic require — the module is ESM but Next.js Turbopack handles it
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('@chenglou/pretext');
      _prepare = mod.prepare;
      _layout = mod.layout;
      _pretextAvailable = true;
    } catch {
      _pretextAvailable = false;
    }
  } else {
    _pretextAvailable = false;
  }
  return _pretextAvailable;
}

// ─── Markdown Block Parser ──────────────────────────────────────────────

type BlockType =
  | 'h2'
  | 'h3'
  | 'paragraph'
  | 'list-item'
  | 'quote'
  | 'code'
  | 'table'
  | 'hr'
  | 'math';

interface MarkdownBlock {
  type: BlockType;
  /** Plain text content (markdown syntax stripped) */
  text: string;
  /** Row / line count for blocks measured by counting lines (code, table) */
  lines?: number;
}

const LIST_MARKER_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;
const BLOCK_START_RE = /^(\s{0,3}#{1,6}\s|\s*```|\s*\$\$|\s*>|\s*\|)/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

/**
 * Lightweight markdown block splitter.
 * Handles: headings, paragraphs, lists, block quotes, fenced code,
 * tables, horizontal rules and $$ math blocks.
 */
export function parseMarkdownBlocks(raw: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = raw.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ── Blank line → skip ──
    if (line.trim() === '') {
      i++;
      continue;
    }

    // ── Fenced code block ── ```...```
    if (line.trimStart().startsWith('```')) {
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push({
        type: 'code',
        text: '',
        lines: Math.max(codeLines.length, 1),
      });
      continue;
    }

    // ── Math block ── $$...$$
    if (line.trimStart().startsWith('$$')) {
      // Single-line form: $$ ... $$ on the same line
      const rest = line.trimStart().slice(2);
      if (rest.includes('$$')) {
        i++;
      } else {
        i++;
        while (i < lines.length && !lines[i].includes('$$')) i++;
        i++; // skip closing $$
      }
      blocks.push({ type: 'math', text: '' });
      continue;
    }

    // ── Heading ──
    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({
        type: heading[1].length <= 2 ? 'h2' : 'h3',
        text: stripInlineMarkdown(heading[2].trim()),
      });
      i++;
      continue;
    }

    // ── Horizontal rule ──
    if (HR_RE.test(line)) {
      blocks.push({ type: 'hr', text: '' });
      i++;
      continue;
    }

    // ── Table ── consecutive lines that start with a pipe
    if (line.trimStart().startsWith('|')) {
      let rows = 0;
      while (i < lines.length && lines[i].trimStart().startsWith('|')) {
        // The |---|---| separator line is not a rendered row
        if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i]) || !lines[i].includes('-')) {
          rows++;
        }
        i++;
      }
      blocks.push({ type: 'table', text: '', lines: Math.max(rows, 1) });
      continue;
    }

    // ── Block quote ──
    if (/^\s*>/.test(line)) {
      const parts: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        parts.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push({
        type: 'quote',
        text: stripInlineMarkdown(parts.join(' ').trim()),
      });
      continue;
    }

    // ── List item ── (- / * / + / 1.)
    if (LIST_MARKER_RE.test(line)) {
      const text = line.replace(LIST_MARKER_RE, '');
      // Collect continuation lines (indented, non-blank, non-list-marker)
      const parts = [text];
      while (
        i + 1 < lines.length &&
        lines[i + 1].trim() !== '' &&
        !LIST_MARKER_RE.test(lines[i + 1]) &&
        !BLOCK_START_RE.test(lines[i + 1])
      ) {
        i++;
        parts.push(lines[i].trim());
      }
      blocks.push({ type: 'list-item', text: stripInlineMarkdown(parts.join(' ')) });
      i++;
      continue;
    }

    // ── Paragraph (default) ──
    const paraLines = [line];
    while (
      i + 1 < lines.length &&
      lines[i + 1].trim() !== '' &&
      !BLOCK_START_RE.test(lines[i + 1]) &&
      !LIST_MARKER_RE.test(lines[i + 1])
    ) {
      i++;
      paraLines.push(lines[i]);
    }
    blocks.push({
      type: 'paragraph',
      text: stripInlineMarkdown(paraLines.join(' ')),
    });
    i++;
  }

  return blocks;
}

/** Remove bold/italic/code markers for width-measurement accuracy */
function stripInlineMarkdown(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1') // bold
    .replace(/__(.+?)__/g, '$1') // bold (underscore)
    .replace(/\*(.+?)\*/g, '$1') // italic
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/\$([^$]+)\$/g, '$1') // inline math
    .replace(/!?\[([^\]]*)\]\([^)]+\)/g, '$1'); // links / images
}

// ─── Pretext Measurement ────────────────────────────────────────────────

const BLOCK_CONFIG: Record<
  'h2' | 'h3' | 'paragraph' | 'list-item' | 'quote',
  { font: string; lineHeight: number; widthOffset?: number }
> = {
  h2: { font: FONT_H2, lineHeight: LH_H2 },
  h3: { font: FONT_H3, lineHeight: LH_H3 },
  paragraph: { font: FONT_BODY, lineHeight: LH_BODY },
  'list-item': { font: FONT_BODY, lineHeight: LH_BODY, widthOffset: LIST_INDENT },
  quote: { font: FONT_BODY, lineHeight: LH_BODY, widthOffset: QUOTE_INDENT },
};

/** Measure a single block's height using pretext */
function measureBlock(block: MarkdownBlock): number {
  switch (block.type) {
    case 'math':
      return MATH_BLOCK_HEIGHT;
    case 'hr':
      return 1;
    case 'code':
      return (block.lines ?? 1) * LH_CODE + CODE_BLOCK_PAD;
    case 'table':
      return (block.lines ?? 1) * TABLE_ROW_HEIGHT;
  }

  if (!block.text) return 0;

  const cfg = BLOCK_CONFIG[block.type];
  const maxWidth = BUBBLE_CONTENT_WIDTH - (cfg.widthOffset ?? 0);

  if (ensurePretext() && _prepare && _layout) {
    try {
      const prepared = _prepare(block.text, cfg.font);
      const { height } = _layout(prepared, maxWidth, cfg.lineHeight);
      return Math.max(height, cfg.lineHeight); // at least one line
    } catch {
      // fall through to the estimator
    }
  }

  // Fallback: character-based estimation
  return estimateBlockHeight(block.text, maxWidth, cfg.lineHeight);
}

/** SSR / fallback estimator: chars-per-line heuristic */
function estimateBlockHeight(
  text: string,
  maxWidth: number,
  lineHeight: number,
): number {
  // Rough: CJK ≈ 14px wide, Latin ≈ 7px wide at 14px font
  const avgCharWidth = hasCJK(text) ? 14 : 7;
  const charsPerLine = Math.max(1, Math.floor(maxWidth / avgCharWidth));
  const lineCount = Math.max(1, Math.ceil(text.length / charsPerLine));
  return lineCount * lineHeight;
}

function hasCJK(s: string): boolean {
  return /[一-鿿　-〿぀-ヿ]/.test(s);
}

// ─── Public API ─────────────────────────────────────────────────────────

/** Height cache — streaming re-measures every message on every flush */
const heightCache = new Map<string, number>();
const HEIGHT_CACHE_LIMIT = 500;

/**
 * Compute the total rendered height of the Markdown body of a message.
 *
 * @param markdownContent - Raw Markdown string
 * @returns height in px (content + padding)
 */
export function measureMessageHeight(markdownContent: string): number {
  const cached = heightCache.get(markdownContent);
  if (cached !== undefined) return cached;

  const blocks = parseMarkdownBlocks(markdownContent);
  let height: number;

  if (blocks.length === 0) {
    height = BUBBLE_PAD_Y * 2 + LH_BODY; // empty: one line
  } else {
    let totalHeight = 0;

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const prev = blocks[i - 1];

      if (i > 0) {
        if (block.type === 'list-item' && prev.type === 'list-item') {
          totalHeight += LIST_ITEM_GAP;
        } else {
          totalHeight += BLOCK_GAP;
          if (block.type === 'h2' || block.type === 'h3') {
            totalHeight += HEADING_GAP_ABOVE;
          }
        }
      }

      totalHeight += measureBlock(block);
    }

    height = totalHeight + BUBBLE_PAD_Y * 2;
  }

  if (heightCache.size >= HEIGHT_CACHE_LIMIT) heightCache.clear();
  heightCache.set(markdownContent, height);
  return height;
}

/**
 * Total card height for a message, including the "quoted passage" strip on
 * user messages and the red error note under failed assistant messages.
 */
export function measureMessage(
  message: Pick<Message, 'content' | 'quote' | 'error'>,
): number {
  let height = measureMessageHeight(message.content);

  if (message.quote) {
    // ~12px per CJK char at text-xs, wrapped to the content width
    const lines = Math.min(
      QUOTE_MAX_LINES,
      Math.max(1, Math.ceil((message.quote.display.length * 12) / BUBBLE_CONTENT_WIDTH)),
    );
    height += lines * QUOTE_LINE_HEIGHT + QUOTE_STRIP_PAD;
  }

  if (message.error) height += ERROR_NOTE_HEIGHT;

  return height;
}
