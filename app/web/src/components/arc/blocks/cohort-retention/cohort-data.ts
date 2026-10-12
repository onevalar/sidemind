/**
 * Seeded monthly cohorts for the retention block. Replace `simulate` with your own counts:
 * every figure in the block (rates, averages, headline and deltas) is derived from sizes and retained counts.
 * Only +, −, × and ÷ are used so the server and every browser produce identical numbers.
 */
export const COHORTS = 12;
export const MONTHS = 12;
/** Row index of the size-weighted average, drawn under the cohorts. */
export const AVG = 12;

export type SegmentKey = "all" | "self" | "sales";
export const SEGMENTS: { value: SegmentKey; label: string; noun: string }[] = [
  { value: "all", label: "All", noun: "all workspaces" },
  { value: "self", label: "Self-serve", noun: "self-serve workspaces" },
  { value: "sales", label: "Sales-led", noun: "sales-led workspaces" },
];

const NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The first cohort signed up in August 2025; data runs through August 2026. */
const FIRST = 2025 * 12 + 7;
export const cohortName = (r: number, short = false) => {
  if (r === AVG) return "Average";
  const m = FIRST + r, name = NAMES[m % 12], year = Math.floor(m / 12);
  return short ? `${name} ’${String(year).slice(2)}` : `${name} ${year}`;
};
export const lastMonth = (r: number) => (r === AVG ? MONTHS : MONTHS - r);

export interface CellDef { j: number; r: number; k: number; wave: number }
/** Every measured cell in reading order. `wave` runs 0 → 1 from the top left corner to the bottom right. */
export const CELLS: CellDef[] = [];
const lookup: number[] = [];
for (let r = 0; r <= AVG; r++) for (let k = 1; k <= lastMonth(r); k++) {
  lookup[r * MONTHS + k - 1] = CELLS.length;
  CELLS.push({ j: CELLS.length, r, k, wave: (r + k - 1) / (AVG + MONTHS - 1) });
}
export const cellAt = (r: number, k: number) => (k >= 1 && k <= lastMonth(r) ? lookup[r * MONTHS + k - 1] : -1);

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Profile { seed: number; size: number; growth: number; m1: number; m1Trend: number; floor: number; floorTrend: number; decay: number; dip?: Record<number, number> }

/** Month-one retention improves cohort over cohort after the onboarding rework; January carries a holiday promo dip. */
function simulate(p: Profile) {
  const rand = mulberry32(p.seed);
  const sizes: number[] = [], retained: number[][] = [];
  for (let c = 0; c < COHORTS; c++) {
    const size = Math.round(p.size * (1 + p.growth * c) * (.92 + rand() * .16));
    const top = p.m1 + p.m1Trend * c + (p.dip?.[c] ?? 0), floor = p.floor + p.floorTrend * c;
    const row: number[] = [];
    let weight = 1, prev = size;
    for (let k = 1; k <= lastMonth(c); k++) {
      const rate = floor + (top - floor) * weight + (rand() - .5) * .02;
      prev = Math.min(prev, Math.round(size * rate));
      row.push(prev);
      weight *= p.decay;
    }
    sizes.push(size); retained.push(row);
  }
  return { sizes, retained };
}

const self = simulate({ seed: 11, size: 300, growth: .035, m1: .688, m1Trend: .0068, floor: .305, floorTrend: .0055, decay: .7, dip: { 5: -.055 } });
const sales = simulate({ seed: 29, size: 62, growth: .045, m1: .925, m1Trend: .0025, floor: .715, floorTrend: .004, decay: .8 });

export interface SegmentData {
  /** Accounts retained, cohort size and rate for every entry in CELLS. Average cells sum every cohort that reached that month. */
  retained: number[]; base: number[]; rate: number[];
  sizes: number[]; total: number;
  m1: number; m6: number; m1Delta: number; m6Delta: number;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function derive(sizes: number[], retained: number[][]): SegmentData {
  const out: SegmentData = { retained: [], base: [], rate: [], sizes, total: sizes.reduce((a, b) => a + b, 0), m1: 0, m6: 0, m1Delta: 0, m6Delta: 0 };
  for (const cell of CELLS) {
    let n = 0, d = 0;
    if (cell.r === AVG) for (let c = 0; c < COHORTS; c++) { if (cell.k <= lastMonth(c)) { n += retained[c][cell.k - 1]; d += sizes[c]; } }
    else { n = retained[cell.r][cell.k - 1]; d = sizes[cell.r]; }
    out.retained.push(n); out.base.push(d); out.rate.push(n / d);
  }
  const rateAt = (r: number, k: number) => out.rate[cellAt(r, k)];
  const trend = (k: number) => {
    const rows = Array.from({ length: COHORTS }, (_, c) => c).filter(c => k <= lastMonth(c));
    return mean(rows.slice(-3).map(c => rateAt(c, k))) - mean(rows.slice(0, 3).map(c => rateAt(c, k)));
  };
  out.m1 = rateAt(AVG, 1); out.m6 = rateAt(AVG, 6);
  out.m1Delta = trend(1); out.m6Delta = trend(6);
  return out;
}

export const DATA: Record<SegmentKey, SegmentData> = {
  self: derive(self.sizes, self.retained),
  sales: derive(sales.sizes, sales.retained),
  all: derive(self.sizes.map((s, c) => s + sales.sizes[c]), self.retained.map((row, c) => row.map((n, k) => n + sales.retained[c][k]))),
};

/** Heatmap intensity steps. Each value lands in the highest step whose floor it reaches. */
export const STEPS = [0, .2, .35, .5, .65, .8];
export const stepOf = (rate: number) => { let s = 0; for (let i = 1; i < STEPS.length; i++) if (rate >= STEPS[i]) s = i; return s; };

const number = new Intl.NumberFormat("en-US");
export const count = (n: number) => number.format(n);
export const pct = (rate: number, digits = 1) => `${(rate * 100).toFixed(digits)}%`;
export const pts = (delta: number) => `${delta < 0 ? "−" : "+"}${Math.abs(delta * 100).toFixed(1)} pts`;
