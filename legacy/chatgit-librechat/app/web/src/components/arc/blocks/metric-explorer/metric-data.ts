/** Seeded daily history for the metric explorer. Two years end on Sep 22, 2026, so every range has a full previous period and server and client render the same numbers. */

export type MetricId = "mrr" | "accounts" | "activation" | "nrr";
export type RangeId = "30d" | "90d" | "12m";
export type Metric = {
  id: MetricId; label: string;
  /** The tab label in the open view. */
  short: string;
  definition: string;
  /** How a change reads: relative for amounts and counts, points for rates. */
  change: "percent" | "points";
  daily: number[];
  /** The weekly series drawn through every day, so a 12 month view can blend into it point for point. */
  weekly: number[];
};

export const LAST = 729;
export const RANGES: Record<RangeId, { label: string; days: number; weekly: boolean; words: string }> = {
  "30d": { label: "30D", days: 30, weekly: false, words: "30 days" },
  "90d": { label: "90D", days: 90, weekly: false, words: "90 days" },
  // Fifty-two weeks, so the previous year lines up weekday for weekday.
  "12m": { label: "12M", days: 364, weekly: true, words: "12 months" },
};
export const RANGE_IDS: RangeId[] = ["30d", "90d", "12m"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const DATES = Array.from({ length: LAST + 1 }, (_, d) => {
  const t = new Date(Date.UTC(2026, 8, 22 - (LAST - d)));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), day: t.getUTCDate(), wd: t.getUTCDay() };
});
export const shortDate = (d: number) => `${MONTHS[DATES[d].m]} ${DATES[d].day}`;
export const longDate = (d: number) => `${shortDate(d)}, ${DATES[d].y}`;
export function windowLabel(range: RangeId) {
  const a = LAST - RANGES[range].days + 1;
  return DATES[a].y === DATES[LAST].y ? `${shortDate(a)} – ${shortDate(LAST)}` : `${longDate(a)} – ${longDate(LAST)}`;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Mean-reverting noise, so days wander a little and drift back instead of jittering. */
function walk(seed: number, keep: number, amp: number) {
  const r = rng(seed);
  let v = 0;
  return Array.from({ length: LAST + 1 }, () => (v = v * keep + (r() + r() + r() - 1.5) * 2 * amp));
}
const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
/** Shift a series so it ends exactly on today's reported figure, then round it to the precision the product reports. */
const settle = (raw: number[], end: number, unit: number) => raw.map(v => Math.round((v + end - raw[LAST]) / unit) * unit);

function weeklyOf(daily: number[]) {
  return daily.map((v, d) => {
    const back = (LAST - d) % 7;
    const hi = d + back, lo = hi - 7;
    if (back === 0 || lo < 0) return v;
    return daily[lo] + (daily[hi] - daily[lo]) * (7 - back) / 7;
  });
}

const days = Array.from({ length: LAST + 1 }, (_, i) => i);
const mrrNoise = walk(11, .94, .0021), accountNoise = walk(23, .9, 4.2), activationNoise = walk(37, .88, .15), nrrNoise = walk(51, .95, .045);

const mrr = settle(days.map(i => 790_000 * Math.exp(.00066 * i) * (1 + mrrNoise[i]) + 18_400 * ease((i - 402) / 3) + 23_900 * ease((i - 588) / 3) - 15_600 * ease((i - 668) / 2)), 1_284_600, 100);
const accounts = settle(days.map(i => 1_388 + 905 * Math.pow(i / LAST, 1.18) + 21 * Math.sin(i / 58) - 34 * Math.exp(-(((i - 322) / 16) ** 2)) + accountNoise[i]), 2_318, 1);
// Onboarding v2 shipped on Aug 8, 2026; the trailing 28-day rate climbs over the four weeks that follow.
const activation = settle(days.map(i => 33.4 + 2.2 * i / LAST + 4.4 * ease((i - 684) / 28) + .55 * Math.sin(i / 41) + activationNoise[i]), 41.8, .1);
const nrr = settle(days.map(i => 105.6 + 8.6 * ease((i - 120) / 560) - 1.9 * ease((i - 684) / 45) + nrrNoise[i]), 112.4, .1);

const make = (id: MetricId, label: string, short: string, definition: string, change: Metric["change"], daily: number[]): Metric => ({ id, label, short, definition, change, daily, weekly: weeklyOf(daily) });
export const METRICS: Metric[] = [
  make("mrr", "MRR", "MRR", "Monthly recurring revenue from active subscriptions, before refunds and credits.", "percent", mrr),
  make("accounts", "Active accounts", "Accounts", "Paying workspaces with at least one member active in the last 7 days.", "percent", accounts),
  make("activation", "Activation rate", "Activation", "New workspaces that invite a teammate within 7 days, trailing 28 days.", "points", activation),
  make("nrr", "Net revenue retention", "NRR", "Revenue kept and expanded from customers of a year ago, trailing 12 months.", "points", nrr),
];
export const METRIC_BY_ID = Object.fromEntries(METRICS.map(m => [m.id, m])) as Record<MetricId, Metric>;

/** A day's value, blended toward the weekly line by `k`. Fractional days interpolate, so a sliding comparison stays continuous. */
export function valueAt(metric: Metric, k: number, t: number) {
  const c = Math.min(LAST, Math.max(0, t)), i = Math.min(LAST - 1, Math.floor(c)), f = c - i;
  const a = metric.daily[i] + (metric.weekly[i] - metric.daily[i]) * k;
  const b = metric.daily[i + 1] + (metric.weekly[i + 1] - metric.daily[i + 1]) * k;
  return a + (b - a) * f;
}

export function changeOf(metric: Metric, now: number, then: number) {
  return metric.change === "percent" ? (now / then - 1) * 100 : now - then;
}
export const signOf = (v: number) => (Math.round(Math.abs(v) * 10) === 0 ? "" : v > 0 ? "+" : "−");
export const changeText = (metric: Metric, v: number) => `${signOf(v)}${Math.abs(v).toFixed(1)}${metric.change === "percent" ? "%" : " pts"}`;
export const changeWords = (metric: Metric, v: number) => `${Math.round(Math.abs(v) * 10) === 0 ? "flat" : v > 0 ? "up" : "down"} ${Math.abs(v).toFixed(1)}${metric.change === "percent" ? "%" : " points"}`;

/** The headline figure and its change against the same day one period earlier. */
export function summary(metric: Metric, range: RangeId) {
  const now = metric.daily[LAST], then = metric.daily[LAST - RANGES[range].days];
  return { now, then, change: changeOf(metric, now, then) };
}

/** Counter props: the value the odometer turns to and the text around it. */
export function counterOf(metric: Metric, v: number) {
  if (metric.id === "mrr") return { value: Math.round(v / 1e4) / 100, decimals: 2, prefix: "$", suffix: "M" };
  if (metric.id === "accounts") return { value: Math.round(v), decimals: 0, prefix: "", suffix: "" };
  return { value: Math.round(v * 10) / 10, decimals: 1, prefix: "", suffix: "%" };
}
const grouped = new Intl.NumberFormat("en-US");
export function formatValue(metric: Metric, v: number) {
  const c = counterOf(metric, v);
  return `${c.prefix}${metric.id === "accounts" ? grouped.format(c.value) : c.value.toFixed(c.decimals)}${c.suffix}`;
}

const decimalsFor = (step: number) => [0, 1, 2, 3].find(d => Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) < 1e-6) ?? 3;
export function formatTick(metric: Metric, v: number, step: number) {
  if (metric.id === "mrr") return `$${(v / 1e6).toFixed(Math.max(1, decimalsFor(step / 1e6)))}M`;
  if (metric.id === "accounts") return grouped.format(Math.round(v));
  return `${v.toFixed(decimalsFor(step))}%`;
}

export const INTERVALS = 4;
/** Four even intervals on a round step, so gridlines keep their places and only their labels change. */
export function domainOf(metric: Metric, range: RangeId) {
  const n = RANGES[range].days;
  let min = Infinity, max = -Infinity;
  for (let d = LAST - 2 * n + 1; d <= LAST; d++) { min = Math.min(min, metric.daily[d]); max = Math.max(max, metric.daily[d]); }
  const pad = Math.max(max - min, Math.abs(max) * .002) * .03;
  min -= pad; max += pad;
  // Steps stay on the precision each metric reports: whole $10k, tens of accounts, tenths of a point.
  const unit = metric.id === "mrr" ? 1e4 : metric.id === "accounts" ? 10 : .1;
  let mag = 10 ** Math.floor(Math.log10((max - min) / INTERVALS));
  for (;;) {
    for (const m of [1, 1.5, 2, 2.5, 3, 4, 5]) {
      const step = Math.round(m * mag / unit) * unit, lo = Math.floor(min / step) * step;
      if (!step || Math.abs(step - m * mag) > 1e-9 * mag) continue;
      if (lo + step * INTERVALS >= max) return { lo, hi: lo + step * INTERVALS, step };
    }
    mag *= 10;
  }
}

/** Sparkline points for a card: the range's days, or its weeks for the 12 month view. */
export function sparkOf(metric: Metric, range: RangeId) {
  const { days: n, weekly } = RANGES[range];
  const picks = weekly ? Array.from({ length: n / 7 + 1 }, (_, j) => LAST - n + 7 * j) : Array.from({ length: n }, (_, j) => LAST - n + 1 + j);
  const values = picks.map(d => metric.daily[d]);
  const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
  const pts = values.map((v, j) => [j / (values.length - 1) * 100, 2 + (1 - (v - lo) / span) * 28] as const);
  return { d: pts.map(([x, y], j) => `${j ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`).join(""), end: pts[pts.length - 1][1] / 32 * 100 };
}

/** Axis ticks for a range at a plot width: the densest calendar step whose labels keep a comfortable gap. */
export function xTicksOf(range: RangeId, plotWidth: number) {
  const n = RANGES[range].days, perDay = plotWidth / Math.max(1, n - 1), from = LAST - n + 1;
  const levels: { gap: number; every: number; test: (d: number) => boolean; label: (d: number) => string }[] = [
    { gap: 84, every: 7, test: d => DATES[d].wd === 1, label: shortDate },
    { gap: 84, every: 14, test: d => DATES[d].wd === 1 && ((LAST - 1 - d) / 7) % 2 === 0, label: shortDate },
    { gap: 84, every: 15, test: d => DATES[d].day === 1 || DATES[d].day === 15, label: shortDate },
    { gap: 48, every: 30.4, test: d => DATES[d].day === 1, label: d => MONTHS[DATES[d].m] },
    { gap: 80, every: 91, test: d => DATES[d].day === 1 && DATES[d].m % 3 === 0, label: d => `${MONTHS[DATES[d].m]} ${DATES[d].y}` },
  ];
  const level = levels.find(l => l.every * perDay >= l.gap) ?? levels[levels.length - 1];
  const ticks: { d: number; label: string }[] = [];
  for (let d = from; d <= LAST; d++) if (level.test(d)) ticks.push({ d, label: level.label(d) });
  return ticks;
}
