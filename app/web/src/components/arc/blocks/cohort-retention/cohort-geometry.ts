import { AVG, CELLS, COHORTS, MONTHS, cellAt, lastMonth } from "./cohort-data";

export const DEFAULT_WIDTH = 720;
export const PANEL_W = 200;
export const PANEL_H = 124;
/** Share of the view transition spent on the diagonal stagger, top left corner first. */
const SPREAD = .5;
/** Curves keep a little air above 100% and below 0%. */
const PAD = 10;

export interface Layout { width: number; wide: boolean; gutter: number; rowH: number; sep: number; plotH: number; height: number; colW: number; radius: number; values: boolean }

export function layoutFor(width: number): Layout {
  const wide = width >= 600;
  const gutter = wide ? 136 : 56, rowH = wide ? 30 : 24, sep = wide ? 10 : 8;
  const plotH = COHORTS * rowH + sep + rowH;
  const colW = Math.max(1, (width - gutter) / MONTHS);
  return { width, wide, gutter, rowH, sep, plotH, height: plotH + 30, colW, radius: wide ? 5 : 3, values: colW >= 32 };
}

/** Column edges snap to whole pixels so every cell and gap renders crisp. */
export const colLeft = (L: Layout, k: number) => Math.round(L.gutter + (k - 1) * L.colW);
export const colMid = (L: Layout, k: number) => (colLeft(L, k) + colLeft(L, k + 1)) / 2;
export const rowTop = (L: Layout, r: number) => (r < AVG ? r * L.rowH : COHORTS * L.rowH + L.sep);
export const curveY = (L: Layout, rate: number) => PAD + (1 - rate) * (L.plotH - PAD * 2);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ramp = (from: number, to: number, t: number) => { const x = clamp((t - from) / (to - from), 0, 1); return x * x * (3 - 2 * x); };

export interface CellGeo { x: number; y: number; w: number; h: number; rx: number; cx: number; cy: number; size: number; ink: number; label: string }
export interface Box { x: number; y: number; w: number; h: number; rx: number }
export interface Geo {
  cells: CellGeo[]; paths: string[];
  lines: number; labels: number; grid: number;
  marker: Box; hoverPath: string; crossX: number; crossY: number; panel: { x: number; y: number };
}

const ROW_CELLS: number[][] = Array.from({ length: AVG + 1 }, (_, r) => CELLS.filter(c => c.r === r).map(c => c.j));

/** Where the value panel sits beside a cell: right, then left, then above or below when the chart is narrow. */
export function panelSpot(L: Layout, c: CellGeo) {
  const gap = 10;
  const right = c.x + c.w + gap, left = c.x - gap - PANEL_W;
  if (right + PANEL_W <= L.width) return { x: right, y: clamp(c.cy - PANEL_H / 2, 0, L.height - PANEL_H) };
  if (left >= 0) return { x: left, y: clamp(c.cy - PANEL_H / 2, 0, L.height - PANEL_H) };
  const x = clamp(c.cx - PANEL_W / 2, 0, Math.max(0, L.width - PANEL_W));
  const above = c.y - gap - PANEL_H;
  return { x, y: above >= 0 ? above : Math.min(c.y + c.h + gap, L.height - PANEL_H) };
}

/**
 * One progress value (`view`, 0 heatmap → 1 curves) drives the whole morph. Each cell first narrows into a dot at its
 * column centre, then slides to its retention on the curve axis; the row it belonged to bends into that cohort's line.
 */
export function geometry(view: number, width: number, hover: number, rates: number[]): Geo {
  const L = layoutFor(width);
  const cells = CELLS.map((cell): CellGeo => {
    const t = clamp(view * (1 + SPREAD) - SPREAD * cell.wave, 0, 1);
    const size = ramp(0, .6, t), move = ramp(.2, 1, t);
    const x0 = colLeft(L, cell.k) + 1, x1 = colLeft(L, cell.k + 1) - 1, y0 = rowTop(L, cell.r) + 1, h0 = L.rowH - 2;
    const dot = cell.r === AVG ? 7 : 5, rate = rates[cell.j];
    const cx = (x0 + x1) / 2, cy = lerp(y0 + h0 / 2, curveY(L, rate), move);
    const w = lerp(x1 - x0, dot, size), h = lerp(h0, dot, size);
    return { x: cx - w / 2, y: cy - h / 2, w, h, rx: lerp(L.radius, dot / 2, size), cx, cy, size, ink: L.values ? clamp(1 - t * 5, 0, 1) : 0, label: String(Math.round(rate * 100)) };
  });
  const paths = ROW_CELLS.map(row => row.map((j, i) => `${i ? "L" : "M"}${cells[j].cx.toFixed(1)} ${cells[j].cy.toFixed(2)}`).join(""));
  const h = cells[hover >= 0 ? hover : 0], o = lerp(1, 2.75, h.size);
  return {
    cells, paths,
    lines: ramp(.3, .85, view), labels: 1 - ramp(0, .4, view), grid: ramp(.45, 1, view),
    marker: { x: h.x - o, y: h.y - o, w: h.w + o * 2, h: h.h + o * 2, rx: h.rx + o },
    hoverPath: paths[CELLS[hover >= 0 ? hover : 0].r], crossX: Math.round(h.cx) + .5, crossY: h.cy,
    panel: panelSpot(L, h),
  };
}

/** Heatmap: the cell under the pointer. Curves: the column under the pointer and the line nearest to it there. */
export function hitTest(L: Layout, curves: boolean, rates: number[], x: number, y: number): { r: number; k: number } | null {
  if (x < L.gutter || x > L.width || y < 0 || y > L.plotH + 6) return null;
  const k = clamp(Math.floor((x - L.gutter) / L.colW) + 1, 1, MONTHS);
  if (curves) {
    let best = AVG, dist = Math.abs(curveY(L, rates[cellAt(AVG, k)]) - y) - 3;
    for (let r = 0; r < COHORTS; r++) {
      if (k > lastMonth(r)) continue;
      const d = Math.abs(curveY(L, rates[cellAt(r, k)]) - y);
      if (d < dist) { best = r; dist = d; }
    }
    return { r: best, k };
  }
  const r = y >= COHORTS * L.rowH + L.sep / 2 ? AVG : Math.min(COHORTS - 1, Math.floor(y / L.rowH));
  return k <= lastMonth(r) ? { r, k } : null;
}
