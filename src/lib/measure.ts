/**
 * measure.ts
 *
 * Markdown → pretext measurement pipeline.
 *
 * 1. Parse raw Markdown into typed blocks (heading, paragraph, list, code, math).
 * 2. For each block, call pretext's `prepare()` + `layout()` to get its height.
 * 3. Sum block heights + inter-block gaps + bubble padding = total node height.
 *
 * SSR guard: pretext needs a canvas context (OffscreenCanvas or DOM canvas).
 * When running server-side, we fall back to a character-based estimator
 * so the initial render doesn't crash.
 */

import {
  BUBBLE_CONTENT_WIDTH,
  BUBBLE_PAD_Y,
  BLOCK_GAP,
  HEADING_GAP_ABOVE,
  LIST_INDENT,
  MATH_BLOCK_HEIGHT,
  FONT_BODY,
  FONT_H2,
  FONT_H3,
  FONT_CODE,
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

type BlockType = 'h2' | 'h3' | 'paragraph' | 'list-item' | 'code' | 'math';

interface MarkdownBlock {
  type: BlockType;
  /** Plain text content (markdown syntax stripped) */
  text: string;
}

/**
 * Lightweight markdown block splitter.
 * Handles: headings, paragraphs, unordered/ordered lists,
 * fenced code blocks, and $$ math blocks.
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
      blocks.push({ type: 'code', text: codeLines.join('\n') });
      continue;
    }

    // ── Math block ── $$...$$
    if (line.trimStart().startsWith('$$')) {
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('$$')) {
        i++;
      }
      i++; // skip closing $$
      blocks.push({ type: 'math', text: '' });
      continue;
    }

    // ── Heading ──
    if (line.startsWith('## ')) {
      blocks.push({ type: 'h2', text: line.slice(3).trim() });
      i++;
      continue;
    }
    if (line.startsWith('### ')) {
      blocks.push({ type: 'h3', text: line.slice(4).trim() });
      i++;
      continue;
    }

    // ── List item ── (- or 1.)
    if (/^(\s*[-*]\s|(\s*\d+\.\s))/.test(line)) {
      const text = line.replace(/^\s*[-*]\s+/, '').replace(/^\s*\d+\.\s+/, '');
      // Collect continuation lines (indented, non-blank, non-list-marker)
      const parts = [text];
      while (
        i + 1 < lines.length &&
        lines[i + 1].trim() !== '' &&
        !lines[i + 1].match(/^(\s*[-*]\s|\s*\d+\.\s|#{2,}\s|```|\$\$)/)
      ) {
        i++;
        parts.push(lines[i].trim());
      }
      blocks.push({ type: 'list-item', text: parts.join(' ') });
      i++;
      continue;
    }

    // ── Paragraph (default) ──
    const paraLines = [line];
    while (
      i + 1 < lines.length &&
      lines[i + 1].trim() !== '' &&
      !lines[i + 1].match(/^(#{2,}\s|```|\$\$|\s*[-*]\s|\s*\d+\.\s)/)
    ) {
      i++;
      paraLines.push(lines[i]);
    }
    // Strip inline markdown (bold, italic, code) for measurement purposes
    const paraText = stripInlineMarkdown(paraLines.join(' '));
    blocks.push({ type: 'paragraph', text: paraText });
    i++;
  }

  return blocks;
}

/** Remove bold/italic/code markers for width-measurement accuracy */
function stripInlineMarkdown(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')  // bold
    .replace(/\*(.+?)\*/g, '$1')       // italic
    .replace(/`([^`]+)`/g, '$1')       // inline code
    .replace(/\$([^$]+)\$/g, '$1')     // inline math
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // links
}

// ─── Pretext Measurement ────────────────────────────────────────────────

const BLOCK_CONFIG: Record<
  BlockType,
  { font: string; lineHeight: number; widthOffset?: number }
> = {
  h2: { font: FONT_H2, lineHeight: LH_H2 },
  h3: { font: FONT_H3, lineHeight: LH_H3 },
  paragraph: { font: FONT_BODY, lineHeight: LH_BODY },
  'list-item': { font: FONT_BODY, lineHeight: LH_BODY, widthOffset: LIST_INDENT },
  code: { font: FONT_CODE, lineHeight: LH_CODE },
  math: { font: FONT_BODY, lineHeight: LH_BODY },
};

/** Measure a single block's height using pretext */
function measureBlock(block: MarkdownBlock): number {
  if (block.type === 'math') return MATH_BLOCK_HEIGHT;
  if (!block.text) return 0;

  const cfg = BLOCK_CONFIG[block.type];
  const maxWidth = BUBBLE_CONTENT_WIDTH - (cfg.widthOffset ?? 0);

  if (ensurePretext() && _prepare && _layout) {
    const prepared = _prepare(block.text, cfg.font);
    const { height } = _layout(prepared, maxWidth, cfg.lineHeight);
    return Math.max(height, cfg.lineHeight); // at least one line
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
  const charsPerLine = Math.floor(maxWidth / avgCharWidth);
  const lineCount = Math.max(1, Math.ceil(text.length / charsPerLine));
  return lineCount * lineHeight;
}

function hasCJK(s: string): boolean {
  return /[\u4e00-\u9fff\u3000-\u303f\u3040-\u30ff]/.test(s);
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Compute the total rendered height of a message bubble.
 *
 * @param markdownContent - Raw Markdown string
 * @returns height in px (content + padding)
 */
export function measureMessageHeight(markdownContent: string): number {
  const blocks = parseMarkdownBlocks(markdownContent);
  if (blocks.length === 0) return BUBBLE_PAD_Y * 2 + LH_BODY; // empty: one line

  let totalHeight = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    // Add heading gap
    if (
      (block.type === 'h2' || block.type === 'h3') &&
      i > 0
    ) {
      totalHeight += HEADING_GAP_ABOVE;
    }

    totalHeight += measureBlock(block);

    // Inter-block gap (except after last block)
    if (i < blocks.length - 1) {
      totalHeight += BLOCK_GAP;
    }
  }

  // Add vertical padding
  return totalHeight + BUBBLE_PAD_Y * 2;
}
