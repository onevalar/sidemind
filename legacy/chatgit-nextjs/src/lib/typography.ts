/**
 * typography.ts
 *
 * Physical constants for the bubble renderer.
 * pretext needs exact CSS-equivalent font strings and numeric constraints
 * to replicate the browser's line-breaking without touching the DOM.
 *
 * Keep these in sync with `.markdown-body` in globals.css — the canvas
 * layout predicts card heights from these numbers.
 */

// ─── Font stacks (identical strings are used in globals.css) ───────────

export const FONT_FAMILY_SANS =
  'system-ui, -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
export const FONT_FAMILY_MONO =
  'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

// ─── Bubble geometry ────────────────────────────────────────────────────

/** Outer width of every message card (px) */
export const BUBBLE_WIDTH = 400;

/** Horizontal inner padding per side (px) */
export const BUBBLE_PAD_X = 20;

/** Vertical inner padding top + bottom (px) */
export const BUBBLE_PAD_Y = 16;

/** The width available for text inside the bubble */
export const BUBBLE_CONTENT_WIDTH = BUBBLE_WIDTH - BUBBLE_PAD_X * 2;

/** Height of the branch-label badge shown on a branch's first card (px) */
export const BRANCH_LABEL_HEIGHT = 24;

// ─── Fonts (canvas shorthand — must mirror CSS declarations) ───────────

export const FONT_BODY = `400 14px ${FONT_FAMILY_SANS}`;
export const FONT_H2 = `700 18px ${FONT_FAMILY_SANS}`;
export const FONT_H3 = `700 16px ${FONT_FAMILY_SANS}`;

// ─── Line heights (px, absolute — not unitless ratios) ─────────────────

export const LH_BODY = 22;
export const LH_H2 = 28;
export const LH_H3 = 25;
export const LH_CODE = 20;

// ─── Inter-block spacing (px) ──────────────────────────────────────────

/** Vertical gap between consecutive markdown blocks */
export const BLOCK_GAP = 12;

/** Extra gap above headings */
export const HEADING_GAP_ABOVE = 8;

/** Vertical gap between consecutive list items */
export const LIST_ITEM_GAP = 4;

/** Indent width for list items (bullet/number marker space) */
export const LIST_INDENT = 24;

/** Left indent of block quotes (border + padding) */
export const QUOTE_INDENT = 15;

/** Vertical padding (top + bottom) inside fenced code blocks */
export const CODE_BLOCK_PAD = 24;

/** Height of one table row (line + padding + border) */
export const TABLE_ROW_HEIGHT = 35;

/** Fixed height estimate for $$ math blocks (we can't measure TeX) */
export const MATH_BLOCK_HEIGHT = 48;

/** Extra height of the "quoted passage" strip on a user message (max 3 lines) */
export const QUOTE_LINE_HEIGHT = 16;
export const QUOTE_MAX_LINES = 3;
export const QUOTE_STRIP_PAD = 10;

/** Extra height of the red error note under a failed assistant message */
export const ERROR_NOTE_HEIGHT = 44;

// ─── Dagre layout ──────────────────────────────────────────────────────

/** Horizontal distance between rank columns (LR mode) */
export const DAGRE_RANKSEP = 100;

/** Vertical distance between nodes in the same rank */
export const DAGRE_NODESEP = 40;
