/**
 * Sample data for the line replay: people on site every five minutes across a product launch day, Tuesday
 * 8 September 2026 in Pacific time, next to a typical Tuesday. The curve is a daily rhythm plus one pulse per
 * launch moment and a short dip while pages slowed, filled in with seeded noise so it is the same on server and
 * client. It is illustrative, not real traffic.
 */

export interface ReplayPoint {
  /** Minutes from the start of the replay (for a day: minutes after midnight). */
  time: number;
  /** The replayed value at that time. */
  value: number;
  /** The comparison value at that time, drawn in full as a quiet dashed line. Leave it out to hide the comparison. */
  baseline?: number;
}

export type MomentKind = "launch" | "press" | "email" | "incident" | "milestone";

export interface ReplayMoment {
  id: string;
  /** Minutes from the start, on the same clock as the points. */
  time: number;
  /** Short title shown on the chart and in the list. */
  title: string;
  /** One line of context shown in the list. */
  detail?: string;
  /** Picks the icon; incident is drawn in the warning color. */
  kind?: MomentKind;
}

/** Mulberry32: a small seeded generator, so the sample is the same on every render and every machine. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A pulse that starts at `start`, rises over about `rise` minutes and fades over about `decay` minutes. */
function pulse(minute: number, start: number, rise: number, decay: number) {
  if (minute < start) return 0;
  const x = minute - start;
  return (1 - Math.exp(-x / rise)) * Math.exp(-x / decay);
}

/** A typical Tuesday: quiet overnight, a working-day hump that peaks early afternoon, a small evening tail. */
function typical(minute: number) {
  const h = minute / 60;
  return 150 + 780 * Math.exp(-(((h - 12.8) / 4.3) ** 2)) + 120 * Math.exp(-(((h - 20.5) / 1.8) ** 2));
}

function build(): ReplayPoint[] {
  const random = seeded(20260908);
  const baseNoise = seeded(8092026);
  const points: ReplayPoint[] = [];
  let drift = 0;
  let baseDrift = 0;
  for (let minute = 0; minute < 24 * 60; minute += 5) {
    drift = drift * 0.82 + (random() - 0.5) * 0.09;
    baseDrift = baseDrift * 0.8 + (baseNoise() - 0.5) * 0.07;
    const base = typical(minute);
    const lift =
      1050 * pulse(minute, 360, 14, 260) +
      1500 * pulse(minute, 450, 45, 720) +
      5600 * pulse(minute, 580, 22, 150) +
      2300 * pulse(minute, 780, 10, 75) +
      900 * pulse(minute, 1200, 18, 150);
    const slowdown = 1 - 0.3 * pulse(minute, 680, 4, 22);
    const value = (base * 1.08 + lift) * slowdown * (1 + drift);
    points.push({ time: minute, value: Math.round(value), baseline: Math.round(base * (1 + baseDrift)) });
  }
  return points;
}

export const POINTS: ReplayPoint[] = build();

export const MOMENTS: ReplayMoment[] = [
  { id: "post", time: 360, title: "Launch post published", detail: "Blog, X and LinkedIn at the same minute", kind: "launch" },
  { id: "hunt", time: 450, title: "Live on Product Hunt", detail: "Maker comment pinned by 7:34 am", kind: "press" },
  { id: "hn", time: 580, title: "Hacker News front page", detail: "Reached third place in 40 minutes", kind: "press" },
  { id: "slow", time: 680, title: "Pages slowed under load", detail: "Load time hit 3.8 s until the cache scaled out", kind: "incident" },
  { id: "news", time: 780, title: "Newsletter sent", detail: "48,200 subscribers, 41% opened in the first hour", kind: "email" },
  { id: "top", time: 1200, title: "Product of the day", detail: "Top of Product Hunt with 1,184 upvotes", kind: "milestone" },
];

const clockFormat = (minutes: number) => {
  const total = Math.round(minutes) % (24 * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
};

/** 9:40 am. Deterministic, so server and client render the same text. */
export function formatClock(minutes: number): string {
  return clockFormat(minutes);
}

/** Short axis label: 6 am, 12 pm. */
export function formatHour(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour} ${h < 12 ? "am" : "pm"}`;
}

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function formatCount(value: number): string {
  return numberFormat.format(Math.round(value));
}

/** A round upper bound for the value axis with a little headroom for the moment labels. */
export function niceMax(value: number): number {
  const raw = value * 1.18;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].find(s => s * power >= raw / 4) ?? 10;
  return Math.ceil(raw / (step * power)) * step * power;
}
