/** Deterministic usage for the September 2026 billing period and a weekday-aware forecast. No randomness at render time. */

/** Point d is the running reading at the end of Sep d; point 0 is the start of the period. */
export const DAYS = 30;
/** Readings exist through today, Sep 22; the forecast runs from here to Sep 30. */
export const TODAY = 22;
export const RULES = [.5, .8, 1] as const;

export type MetricKey = "calls" | "storage" | "seats";
export interface Metric {
  key: MetricKey;
  label: string;
  /** Axis domain. Every metric uses five equal intervals so gridlines stay put while labels change. */
  lo: number;
  hi: number;
  /** Budget snapping step and draggable range. */
  step: number;
  min: number;
  budget: number;
  decimals: number;
  unit: string;
  /** Cost of one unit above budget, and how it reads. */
  price: number;
  priceNote: string;
  actual: number[];
  median: number[];
  upper: number[];
  lower: number[];
}

type Spec = Omit<Metric, "actual" | "median" | "upper" | "lower"> & {
  seed: number; start: number; weekday: number; weekend: number; growth: number; noise: number; spread: number;
  events?: Record<number, number>; readings?: number[]; round: number;
};

function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sep 1, 2026 is a Tuesday. */
const weekend = (day: number) => (day + 1) % 7 === 0 || (day + 1) % 7 === 6;

function build(spec: Spec): Metric {
  const rand = seeded(spec.seed);
  const snap = (v: number) => Math.round(v / spec.round) * spec.round;
  const rate = (day: number) => (weekend(day) ? spec.weekend : spec.weekday) * (1 + spec.growth * day);
  const actual = spec.readings ?? [spec.start];
  for (let day = actual.length; day <= TODAY; day++) actual.push(snap(actual[day - 1] + rate(day) * (1 + (rand() - .5) * 2 * spec.noise) + (spec.events?.[day] ?? 0)));
  // The forecast keeps the pace of the last two weeks relative to the weekday model.
  let seen = 0, expected = 0;
  for (let day = TODAY - 13; day <= TODAY; day++) { seen += actual[day] - actual[day - 1] - (spec.events?.[day] ?? 0); expected += rate(day); }
  const pace = expected ? seen / expected : 1;
  const median = [actual[TODAY]], upper = [actual[TODAY]], lower = [actual[TODAY]];
  for (let day = TODAY + 1; day <= DAYS; day++) {
    const k = day - TODAY, next = median[k - 1] + rate(day) * pace, spread = spec.spread * (Math.sqrt(k) + k * .35);
    median.push(next); upper.push(next + spread * 1.2); lower.push(next - spread * .85);
  }
  const { key, label, lo, hi, step, min, budget, decimals, unit, price, priceNote } = spec;
  return { key, label, lo, hi, step, min, budget, decimals, unit, price, priceNote, actual, median, upper, lower };
}

export const METRICS: Record<MetricKey, Metric> = {
  calls: build({
    key: "calls", label: "API calls", lo: 0, hi: 50, step: 1, min: 10, budget: 38, decimals: 1, unit: "M",
    price: 200, priceNote: "At $0.20 per 1k calls",
    seed: 20260922, start: 0, weekday: 1.6, weekend: .7, growth: .006, noise: .07, spread: .4, round: .01,
  }),
  storage: build({
    key: "storage", label: "Storage", lo: 2, hi: 4.5, step: .1, min: 2.5, budget: 4, decimals: 2, unit: " TB",
    price: 120, priceNote: "At $0.12 per GB",
    seed: 4101, start: 3.12, weekday: .031, weekend: .012, growth: .004, noise: .25, spread: .034, round: .001,
    events: { 10: -.15 },
  }),
  seats: build({
    key: "seats", label: "Seats", lo: 140, hi: 240, step: 5, min: 160, budget: 200, decimals: 0, unit: " seats",
    price: 24, priceNote: "At $24 per seat",
    seed: 77, start: 186, weekday: .72, weekend: .08, growth: 0, noise: 0, spread: .9, round: 1,
    readings: [186, 186, 187, 189, 190, 190, 190, 191, 193, 194, 195, 195, 195, 196, 197, 198, 199, 201, 202, 202, 202, 203, 205],
  }),
};
export const METRIC_KEYS: MetricKey[] = ["calls", "storage", "seats"];

/** The reading curve: actual through today, then the forecast median (or a band edge). Length DAYS + 1. */
export const curveOf = (actual: number[], forecast: number[]) => [...actual, ...forecast.slice(1)];

/** The first point where a curve reaches a level, in fractional days, or null if it stays below it. */
export function crossing(curve: number[], level: number) {
  if (curve[0] >= level) return 0;
  for (let i = 1; i < curve.length; i++) if (curve[i] >= level) return i - 1 + (level - curve[i - 1]) / Math.max(1e-9, curve[i] - curve[i - 1]);
  return null;
}

/** Linear reading between points, so markers ride exactly on the drawn polyline. */
export function valueAt(curve: number[], x: number) {
  const i = Math.max(0, Math.min(curve.length - 2, Math.floor(x))), t = Math.max(0, Math.min(1, x - i));
  return curve[i] + (curve[i + 1] - curve[i]) * t;
}

/** A crossing during Sep d happens between points d - 1 and d. */
export const dayOf = (x: number) => Math.min(DAYS, Math.max(1, Math.ceil(x - 1e-6)));
export const dateLabel = (x: number) => `Sep ${dayOf(x)}`;

const trim = (text: string) => (text.includes(".") ? text.replace(/\.?0+$/, "") : text);
/** Axis and budget values: 40M, 3.5 TB, 200 seats. */
export const short = (m: Metric, v: number) => v === 0 ? "0" : `${trim(v.toFixed(m.key === "seats" ? 0 : m.key === "storage" ? 1 : 0))}${m.unit === " seats" ? "" : m.unit}`;
export const fixed = (m: Metric, v: number) => v.toFixed(m.decimals);
export const full = (m: Metric, v: number) => `${fixed(m, v)}${m.unit}`;
export const money = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
export const ticksOf = (m: Metric) => Array.from({ length: 6 }, (_, i) => m.lo + (m.hi - m.lo) * i / 5);

/** Everything the copy and figures say for one metric at one budget. */
export function summarize(m: Metric, budget: number) {
  const curve = curveOf(m.actual, m.median);
  const at = crossing(curve, budget);
  const early = crossing(curveOf(m.actual, m.upper), budget), late = crossing(curveOf(m.actual, m.lower), budget);
  const used = m.actual[TODAY], end = m.median[m.median.length - 1];
  const kind: "past" | "future" | "none" = at === null ? "none" : at <= TODAY ? "past" : "future";
  const pct = (v: number) => Math.round(v / budget * 100);
  const endLabel = full(m, end);
  let headline: string, detail: string;
  if (kind === "past") {
    headline = `You passed the budget on ${dateLabel(at!)}`;
    const over = pct(used) - 100;
    detail = `Usage is ${over > 0 ? `${over}% over` : "at the budget"} today and heading for ${endLabel} by Sep 30.`;
  } else if (kind === "future") {
    const left = DAYS - dayOf(at!);
    headline = `At this pace you reach the budget on ${dateLabel(at!)}`;
    const lead = left === 0 ? "On the last day of the period" : `${left} ${left === 1 ? "day" : "days"} before the period closes`;
    const range = early !== null && late !== null && dayOf(early) !== dayOf(late) ? `, likely between ${dateLabel(early)} and ${dateLabel(late)}` : early !== null && dayOf(early) !== dayOf(at!) ? `, as early as ${dateLabel(early)}` : "";
    detail = `${lead}${range}.`;
  } else {
    headline = "At this pace you stay under budget";
    detail = `Heading for ${endLabel} by Sep 30, ${pct(end)}% of budget${early !== null ? `. A busy week could cross it on ${dateLabel(early)}` : ""}.`;
  }
  return {
    at, kind, headline, detail, used, end, usedPct: pct(used), endPct: pct(end),
    endLow: m.lower[m.lower.length - 1], endHigh: m.upper[m.upper.length - 1],
    cost: Math.max(0, end - budget) * m.price,
    rules: RULES.map(f => { const x = crossing(curve, f * budget); return x === null ? null : x; }),
  };
}
