/** Seeded hourly activity for one workspace week. Monday first, hours in workspace time. */
export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
export const WEEK = "Sep 14 to 20, 2026";
export const ROWS = 7, COLS = 24, COUNT = ROWS * COLS;

export type MetricKey = "sessions" | "deploys" | "errors";
export type Cell = { d: number; h: number };
export type Peak = Cell & { i: number; value: number };
export type Metric = {
  key: MetricKey; label: string; unit: string; one: string;
  /** 0 paints with the accent, 1 with the danger color. */
  tone: 0 | 1;
  /** Whether a rise week over week is good news. */
  upIsGood: boolean;
  values: number[]; last: number[]; norm: number[]; max: number;
  total: number; change: number; days: number[]; busiest: number; working: number; top: Peak[];
};

export const indexOf = ({ d, h }: Cell) => d * COLS + h;
export const cellOf = (i: number): Cell => ({ d: Math.floor(i / COLS), h: i % COLS });
export const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;
export const hourRange = (h: number) => `${hourLabel(h)} to ${hourLabel((h + 1) % 24)}`;
export const count = (n: number) => Math.round(n).toLocaleString("en-US");
export const signedPct = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}%`;

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
const bell = (x: number, mu: number, s: number) => Math.exp(-((x - mu) ** 2) / (2 * s * s));
const ramp = (x: number, a: number, b: number) => Math.min(1, Math.max(0, (x - a) / (b - a)));

const SESSION_DAY = [.93, 1, 1.03, .97, .85, .5, .44];
/** A working day with a lunch dip and a small evening return; weekends are flatter and later. */
function sessionShape(d: number, h: number) {
  if (d >= 5) return .08 + .46 * bell(h, 13, 3) + .3 * bell(h, 20.5, 1.8);
  return .05 + .2 * ramp(h, 7.5, 9.5) * (1 - ramp(h, 17, 19.5)) + .82 * bell(h, 10.3, 1.5) + .9 * bell(h, 14.6, 1.6) + .22 * bell(h, 20.6, 1.4);
}

const DEPLOY_DAY = [.82, 1, .94, .9, .62, .05, .03];
/** Releases cluster late morning and mid afternoon; Friday afternoon is a freeze. */
function deployShape(d: number, h: number) {
  const s = .02 + .85 * bell(h, 11, 1.3) + bell(h, 15.3, 1.5) + .15 * bell(h, 19, 1.2);
  return s * DEPLOY_DAY[d] * (d === 4 && h >= 14 ? .12 : 1);
}

/** Wednesday's 14:00 release shipped a bad migration; errors spike and tail off over two hours. */
const INCIDENT: Record<number, number> = { [2 * COLS + 14]: 560, [2 * COLS + 15]: 214, [2 * COLS + 16]: 46 };

function week(seed: number, scale: { sessions: number; deploys: number; errors: number }, incident: boolean) {
  const r = seeded(seed);
  const sessions: number[] = [], deploys: number[] = [], errors: number[] = [];
  for (let i = 0; i < COUNT; i++) {
    const { d, h } = cellOf(i);
    sessions.push(Math.round(sessionShape(d, h) * SESSION_DAY[d] * 4050 * scale.sessions * (.94 + r() * .12)));
    const shape = deployShape(d, h);
    deploys.push(Math.max(0, Math.round(shape * 36 * scale.deploys + (r() - .5) * (shape > .05 ? 4 : .9))));
  }
  for (let i = 0; i < COUNT; i++) {
    const h = i % COLS;
    const base = sessions[i] * .0085 * (.8 + r() * .4) + (h > 0 ? deploys[i - 1] * 1.4 : 0);
    errors.push(Math.round(base * scale.errors + (incident ? INCIDENT[i] ?? 0 : 0)));
  }
  return { sessions, deploys, errors };
}

const THIS = week(20260914, { sessions: 1, deploys: 1, errors: 1 }, true);
const LAST = week(20260907, { sessions: .928, deploys: .9, errors: 1.04 }, false);

const META: Record<MetricKey, Pick<Metric, "label" | "unit" | "one" | "tone" | "upIsGood">> = {
  sessions: { label: "Sessions", unit: "sessions", one: "session", tone: 0, upIsGood: true },
  deploys: { label: "Deploys", unit: "deploys", one: "deploy", tone: 0, upIsGood: true },
  errors: { label: "Errors", unit: "errors", one: "error", tone: 1, upIsGood: false },
};

function build(key: MetricKey): Metric {
  const values = THIS[key], last = LAST[key];
  const max = Math.max(...values), total = values.reduce((a, b) => a + b, 0), lastTotal = last.reduce((a, b) => a + b, 0);
  const days = DAYS.map((_, d) => values.slice(d * COLS, d * COLS + COLS).reduce((a, b) => a + b, 0));
  const working = values.reduce((sum, v, i) => { const { d, h } = cellOf(i); return sum + (d < 5 && h >= 9 && h < 18 ? v : 0); }, 0) / total;
  const top = values.map((value, i) => ({ ...cellOf(i), i, value })).sort((a, b) => b.value - a.value || a.i - b.i).slice(0, 3);
  return { key, ...META[key], values, last, norm: values.map(v => v / max), max, total, change: total / lastTotal - 1, days, busiest: days.indexOf(Math.max(...days)), working, top };
}

export const METRICS: Record<MetricKey, Metric> = { sessions: build("sessions"), deploys: build("deploys"), errors: build("errors") };
export const METRIC_OPTIONS = (Object.keys(METRICS) as MetricKey[]).map(value => ({ value, label: METRICS[value].label }));
