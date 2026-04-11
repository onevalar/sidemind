/**
 * typography.ts
 *
 * Physical constants for the bubble renderer.
 * pretext needs exact CSS-equivalent font strings and numeric constraints
 * to replicate the browser's line-breaking without touching the DOM.
 */

// ─── Bubble geometry ────────────────────────────────────────────────────

/** Outer width of every message card (px) */
export const BUBBLE_WIDTH = 400;

/** Horizontal inner padding per side (px) */
export const BUBBLE_PAD_X = 20;

/** Vertical inner padding top + bottom (px) */
export const BUBBLE_PAD_Y = 16;

/** The width available for text inside the bubble */
export const BUBBLE_CONTENT_WIDTH = BUBBLE_WIDTH - BUBBLE_PAD_X * 2;

// ─── Fonts (canvas shorthand — must mirror Tailwind/CSS declarations) ──

export const FONT_BODY = '400 14px Inter, system-ui, sans-serif';
export const FONT_BODY_BOLD = '700 14px Inter, system-ui, sans-serif';
export const FONT_H2 = '700 18px Inter, system-ui, sans-serif';
export const FONT_H3 = '700 16px Inter, system-ui, sans-serif';
export const FONT_CODE = '400 13px "SF Mono", ui-monospace, monospace';
export const FONT_LIST_MARKER = '400 14px Inter, system-ui, sans-serif';

// ─── Line heights (px, absolute — not unitless ratios) ─────────────────

export const LH_BODY = 22;      // 14px × 1.57
export const LH_H2 = 28;        // 18px × 1.56
export const LH_H3 = 25;        // 16px × 1.56
export const LH_CODE = 20;      // 13px × 1.54

// ─── Inter-block spacing (px) ──────────────────────────────────────────

/** Vertical gap between consecutive markdown blocks */
export const BLOCK_GAP = 12;

/** Extra gap above headings */
export const HEADING_GAP_ABOVE = 8;

/** Indent width for list items (bullet/number marker space) */
export const LIST_INDENT = 24;

/** Fixed height estimate for $$ math blocks (we can't measure TeX) */
export const MATH_BLOCK_HEIGHT = 48;

// ─── Dagre layout ──────────────────────────────────────────────────────

/** Horizontal distance between rank columns (LR mode) */
export const DAGRE_RANKSEP = 100;

/** Vertical distance between nodes in the same rank */
export const DAGRE_NODESEP = 40;
