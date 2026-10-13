/** Deterministic sample data, scales and path geometry for the revenue explorer. No randomness at render time. */

/** Months on screen (Sep 2024 to Aug 2026). The history before them feeds "previous period" comparisons. */
export const MONTHS = 24;
export const LAST = MONTHS - 1;
const HISTORY = 24;
/** The narrowest brush window, in months between the first and last point (three data points). */
export const MIN_SPAN = 2;
/** Left gutter for y labels. The overview aligns its months to the same plot edge. */
export const GUTTER = 48;
export const PAD_TOP = 14;
export const PAD_BOTTOM = 28;
export const OVERVIEW_H = 44;

export type SeriesKey = "newMrr" | "expansion" | "churn";
export type Month = { newMrr: number; expansion: number; churn: number; start: number; mrr: number };
export const SERIES: { key: SeriesKey; label: string }[] = [
  { key: "newMrr", label: "New" },
  { key: "expansion", label: "Expansion" },
  { key: "churn", label: "Churn" },
];

const NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** New business by calendar month: strong March and October, quiet summer and December. */
const SEASON = [1.08, 1, 1.12, 1.02, 1, 1.05, .9, .88, 1.06, 1.1, 1, .82];

function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 48 months from Sep 2022. A pricing change spikes churn in Feb 2025; usage add-ons lift expansion from Oct 2025. */
const DATA: Month[] = (() => {
  const rand = seeded(20260822);
  const round = (value: number) => Math.round(value / 100) * 100;
  const out: Month[] = [];
  let mrr = 486_000;
  for (let t = 0; t < MONTHS + HISTORY; t++) {
    const jitter = (spread: number) => 1 + (rand() - .5) * spread;
    const newMrr = round((27_000 + 900 * t) * SEASON[(8 + t) % 12] * jitter(.16));
    const expansion = round((5_400 + 420 * t) * (t >= 37 ? 1.34 : 1) * jitter(.22));
    const rate = .0205 - .00012 * t + (t === 29 ? .0105 : t === 30 ? .0045 : 0) + (rand() - .5) * .003;
    const churn = round(mrr * rate);
    out.push({ newMrr, expansion, churn, start: mrr, mrr: mrr + newMrr + expansion - churn });
    mrr = out[t].mrr;
  }
  return out;
})();

/** A month by on-screen index. Negative indices reach into the history. */
export const monthAt = (i: number) => DATA[Math.min(MONTHS + HISTORY - 1, Math.max(0, i + HISTORY))];
/** Linear read between months, so a comparison offset can glide instead of jumping. */
function valueAt(i: number, key: SeriesKey) {
  const lo = Math.floor(i), f = i - lo;
  return f ? monthAt(lo)[key] * (1 - f) + monthAt(lo + 1)[key] * f : monthAt(lo)[key];
}
export const netOf = (m: Month) => m.newMrr + m.expansion - m.churn;

const calendar = (i: number) => ({ m: (i + HISTORY + 8) % 12, y: 2022 + Math.floor((i + HISTORY + 8) / 12) });
export const isJanuary = (i: number) => calendar(i).m === 0;
export const monthLabel = (i: number) => { const { m, y } = calendar(i); return `${NAMES[m]} ${y}`; };
/** Axis labels name the month, and the year at each January. */
export const axisLabel = (i: number) => { const { m, y } = calendar(i); return m === 0 ? String(y) : NAMES[m]; };
export const monthStep = (i: number) => calendar(i).m;
export function rangeLabel(a: number, b: number) {
  const s = calendar(a), e = calendar(b);
  return s.y === e.y ? `${NAMES[s.m]} – ${NAMES[e.m]} ${e.y}` : `${NAMES[s.m]} ${s.y} – ${NAMES[e.m]} ${e.y}`;
}

const sum = (a: number, b: number, pick: (m: Month) => number) => { let total = 0; for (let i = a; i <= b; i++) total += pick(monthAt(i)); return total; };
/** Headline figures for whole months a..b, compared with the same number of months before them. */
export function summarize(a: number, b: number) {
  const months = b - a + 1;
  const net = (from: number, to: number) => sum(from, to, netOf) / months;
  const churnRate = (from: number, to: number) => sum(from, to, m => m.churn) / sum(from, to, m => m.start) * 100;
  const mrr = monthAt(b).mrr, base = monthAt(a - 1).mrr;
  const netNow = net(a, b), netBefore = net(a - months, b - months);
  const churnNow = churnRate(a, b);
  return {
    months, mrr, since: monthLabel(a - 1), mrrChange: (mrr - base) / base * 100,
    net: netNow, netChange: (netNow - netBefore) / netBefore * 100,
    churn: churnNow, churnChange: churnNow - churnRate(a - months, b - months),
  };
}

/** Vertical extent for the months a window touches, with headroom. Rounded so it only moves when the data does. */
export function yDomain(lo: number, hi: number, active: boolean[], compare: boolean, offset: number): [number, number] {
  let pos = 0, neg = 0;
  for (let i = Math.max(0, Math.floor(lo)); i <= Math.min(LAST, Math.ceil(hi)); i++) {
    for (const m of compare ? [monthAt(i), monthAt(i - offset)] : [monthAt(i)]) {
      pos = Math.max(pos, (active[0] ? m.newMrr : 0) + (active[1] ? m.expansion : 0));
      neg = Math.max(neg, active[2] ? m.churn : 0);
    }
  }
  if (!pos && !neg) return [0, 80_000];
  const r = (v: number) => Math.round(v / 500) * 500;
  return [neg ? -r(neg * 1.2) : 0, pos ? r(pos * 1.1) : r(neg * .2)];
}

function niceStep(raw: number) {
  const power = 10 ** Math.floor(Math.log10(raw)), f = raw / power;
  return (f < 1.5 ? 1 : f < 2.25 ? 2 : f < 3 ? 2.5 : f < 7 ? 5 : 10) * power;
}
export function yTicks([lo, hi]: [number, number], count: number) {
  const step = niceStep((hi - lo) / count), out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-6; v += step) out.push(Math.round(v) || 0);
  return out;
}
/** Month spacing for x labels: the smallest calendar-aligned step that keeps labels about 46px apart. */
export const xStep = (pxPerMonth: number) => [1, 2, 3, 6, 12].find(step => pxPerMonth * step >= 46) ?? 12;

export const money = (v: number) => {
  const sign = v < 0 ? "−" : "", a = Math.abs(v);
  return a >= 1e6 ? `${sign}$${(a / 1e6).toFixed(2)}M` : a >= 1000 ? `${sign}$${(a / 1000).toFixed(a >= 100_000 || a % 1000 === 0 ? 0 : 1)}k` : `${sign}$${Math.round(a)}`;
};

type Pt = [number, number];
/** Monotone cubic tangents (Fritsch–Carlson): smooth through every point without overshooting between them. */
function tangents(p: Pt[]) {
  const n = p.length, t = new Array<number>(n).fill(0);
  if (n < 2) return t;
  if (n === 2) return t.fill((p[1][1] - p[0][1]) / (p[1][0] - p[0][0] || 1));
  for (let i = 1; i < n - 1; i++) {
    const h0 = p[i][0] - p[i - 1][0], h1 = p[i + 1][0] - p[i][0];
    const s0 = (p[i][1] - p[i - 1][1]) / h0, s1 = (p[i + 1][1] - p[i][1]) / h1;
    t[i] = (Math.sign(s0) + Math.sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), .5 * Math.abs((s0 * h1 + s1 * h0) / (h0 + h1))) || 0;
  }
  t[0] = (3 * (p[1][1] - p[0][1]) / (p[1][0] - p[0][0]) - t[1]) / 2;
  t[n - 1] = (3 * (p[n - 1][1] - p[n - 2][1]) / (p[n - 1][0] - p[n - 2][0]) - t[n - 2]) / 2;
  return t;
}
const r1 = (v: number) => Math.round(v * 10) / 10;
/** A monotone curve through the points. Reversed point lists trace the identical curve backwards, which closes areas. */
function curve(p: Pt[], command = "M") {
  if (!p.length) return "";
  const t = tangents(p);
  let d = `${command}${r1(p[0][0])},${r1(p[0][1])}`;
  for (let i = 1; i < p.length; i++) {
    const dx = (p[i][0] - p[i - 1][0]) / 3;
    d += `C${r1(p[i - 1][0] + dx)},${r1(p[i - 1][1] + dx * t[i - 1])},${r1(p[i][0] - dx)},${r1(p[i][1] - dx * t[i])},${r1(p[i][0])},${r1(p[i][1])}`;
  }
  return d;
}
const back = (p: Pt[]) => curve([...p].reverse(), "L");

export const panelWidth = (width: number) => (width < 520 ? 172 : 204);
export const chartHeight = (width: number) => (width < 560 ? 216 : 256);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export type Frame = { x0: number; x1: number; yLo: number; yHi: number; w: [number, number, number]; compare: number; offset: number; width: number; height: number; hover: number };
export type Geometry = ReturnType<typeof geometry>;

/**
 * Every path for one animation frame, read from the animated domain, series weights and comparison progress.
 * Paths are rebuilt from data, so a zoom is a camera move rather than a redraw.
 */
export function geometry(f: Frame) {
  const right = f.width, bottom = f.height - PAD_BOTTOM;
  const sx = (i: number) => GUTTER + (i - f.x0) / Math.max(1e-6, f.x1 - f.x0) * (right - GUTTER);
  const sy = (v: number) => PAD_TOP + (f.yHi - v) / Math.max(1, f.yHi - f.yLo) * (bottom - PAD_TOP);
  const [wn, we, wc] = f.w, k = f.compare;
  const from = Math.max(0, Math.floor(f.x0) - 1), to = Math.min(LAST, Math.ceil(f.x1) + 1);
  const topN: Pt[] = [], topE: Pt[] = [], lowC: Pt[] = [], prevTop: Pt[] = [], prevLow: Pt[] = [];
  for (let i = from; i <= to; i++) {
    const m = monthAt(i), x = sx(i);
    const n = m.newMrr * wn, gross = n + m.expansion * we, c = m.churn * wc;
    const pastGross = valueAt(i - f.offset, "newMrr") * wn + valueAt(i - f.offset, "expansion") * we;
    const pastChurn = valueAt(i - f.offset, "churn") * wc;
    topN.push([x, sy(n)]); topE.push([x, sy(gross)]); lowC.push([x, sy(-c)]);
    /** The comparison peels off the current edge and settles on last period's values. */
    prevTop.push([x, sy(gross + (pastGross - gross) * k)]); prevLow.push([x, sy(-c - (pastChurn - c) * k)]);
  }
  const base = r1(sy(0)), first = r1(topN[0][0]), end = r1(topN[topN.length - 1][0]);
  const h = f.hover;
  const live = h >= from && h <= to;
  const cx = live ? Math.round(sx(h)) + .5 : -100;
  const m = monthAt(Math.max(0, h));
  const pw = panelWidth(f.width);
  return {
    areaNew: `${curve(topN)}L${end},${base}L${first},${base}Z`,
    areaExp: `${curve(topE)}${back(topN)}Z`,
    areaChurn: `M${first},${base}L${end},${base}${back(lowC)}Z`,
    lineNew: curve(topN), lineExp: curve(topE), lineChurn: curve(lowC),
    prevTop: curve(prevTop), prevLow: curve(prevLow),
    prevTopOpacity: clamp(k * 1.6, 0, 1) * clamp(wn + we, 0, 1), prevLowOpacity: clamp(k * 1.6, 0, 1) * wc,
    cross: cx, crossOpacity: live && cx >= GUTTER - 1 && cx <= right + 1 ? 1 : 0,
    dotNew: sy(m.newMrr * wn), dotExp: sy(m.newMrr * wn + m.expansion * we), dotChurn: sy(-m.churn * wc),
    panelX: cx + 14 + pw <= right ? cx + 14 : Math.max(0, cx - 14 - pw),
  };
}

/** The static overview across all 24 months: gross new revenue above the line, churn below. */
export function overview(width: number) {
  const x = (i: number) => GUTTER + i / LAST * (width - GUTTER);
  let pos = 0, neg = 0;
  for (let i = 0; i <= LAST; i++) { const m = monthAt(i); pos = Math.max(pos, m.newMrr + m.expansion); neg = Math.max(neg, m.churn); }
  const y = (v: number) => 4 + (pos - v) / (pos + neg) * (OVERVIEW_H - 8);
  const top: Pt[] = [], low: Pt[] = [];
  for (let i = 0; i <= LAST; i++) { const m = monthAt(i); top.push([x(i), y(m.newMrr + m.expansion)]); low.push([x(i), y(-m.churn)]); }
  const base = r1(y(0));
  return {
    base, top: curve(top), low: curve(low),
    areaTop: `${curve(top)}L${r1(width)},${base}L${GUTTER},${base}Z`,
    areaLow: `M${GUTTER},${base}L${r1(width)},${base}${back(low)}Z`,
    years: Array.from({ length: MONTHS }, (_, i) => i).filter(isJanuary).map(i => ({ i, x: Math.round(x(i)) + .5, label: axisLabel(i) })),
  };
}
