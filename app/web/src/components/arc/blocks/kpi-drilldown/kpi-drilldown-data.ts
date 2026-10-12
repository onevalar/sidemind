/** Sample SaaS metrics for the KPI drilldown block. Replace with daily series and breakdowns from your warehouse. */

export type KpiFormat = { prefix?: string; suffix?: string; divisor?: number; decimals?: number };

export type BreakdownRow = { name: string; share: number; delta: number };

export type Kpi = {
  id: string;
  label: string;
  /** How the value prints: €184.2k is { prefix: "€", divisor: 1000, suffix: "k", decimals: 1 }. */
  format: KpiFormat;
  /** Rates compare in points, totals compare in percent. */
  kind: "total" | "rate";
  /** True when a falling value is good news, like churn. */
  lowerIsBetter?: boolean;
  /** One value per day, oldest first. The last 180 days. */
  series: number[];
  breakdowns: Record<string, BreakdownRow[]>;
  description: string;
};

export const breakdownDimensions = [
  { value: "plan", label: "Plan" },
  { value: "region", label: "Region" },
  { value: "channel", label: "Channel" },
];

export const seriesEnd = "2026-09-24";

/** Deterministic noise so server and client render the same series. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function series(seed: number, start: number, end: number, noise: number, weekly = 0) {
  const random = seeded(seed);
  let drift = 0;
  return Array.from({ length: 180 }, (_, day) => {
    const t = day / 179;
    drift = drift * .82 + (random() - .5) * noise;
    const curve = start + (end - start) * (t * t * .35 + t * .65);
    const week = weekly ? Math.sin((day / 7) * Math.PI * 2) * weekly : 0;
    return curve + drift + week;
  });
}

const plans = (a: number, b: number, c: number, d: number): BreakdownRow[] => [
  { name: "Enterprise", share: .46, delta: a }, { name: "Scale", share: .31, delta: b }, { name: "Pro", share: .17, delta: c }, { name: "Starter", share: .06, delta: d },
];
const regions = (a: number, b: number, c: number, d: number): BreakdownRow[] => [
  { name: "Europe", share: .41, delta: a }, { name: "North America", share: .37, delta: b }, { name: "Asia Pacific", share: .15, delta: c }, { name: "Latin America", share: .07, delta: d },
];
const channels = (a: number, b: number, c: number, d: number): BreakdownRow[] => [
  { name: "Self serve", share: .44, delta: a }, { name: "Sales led", share: .34, delta: b }, { name: "Partners", share: .14, delta: c }, { name: "Marketplace", share: .08, delta: d },
];

export const kpis: Kpi[] = [
  { id: "mrr", label: "Monthly recurring revenue", kind: "total", format: { prefix: "€", divisor: 1000, suffix: "k", decimals: 1 },
    series: series(11, 151_400, 184_200, 1_900, 600), description: "Recurring revenue from active subscriptions, before tax.",
    breakdowns: { plan: plans(.071, .064, .042, -.018), region: regions(.082, .051, .096, .034), channel: channels(.058, .077, .049, .112) } },
  { id: "accounts", label: "Active accounts", kind: "total", format: { decimals: 0 },
    series: series(23, 2_188, 2_418, 16, 9), description: "Workspaces with at least one paid seat and activity this week.",
    breakdowns: { plan: plans(.021, .035, .038, .012), region: regions(.033, .028, .052, .019), channel: channels(.041, .022, .026, .064) } },
  { id: "nrr", label: "Net revenue retention", kind: "rate", format: { suffix: "%", decimals: 1 },
    series: series(37, 114.2, 118.3, .5), description: "Revenue kept from customers a year ago, including expansion.",
    breakdowns: { plan: plans(.031, .022, -.008, -.024), region: regions(.019, .026, .014, -.011), channel: channels(.012, .028, .017, .006) } },
  { id: "churn", label: "Logo churn", kind: "rate", lowerIsBetter: true, format: { suffix: "%", decimals: 1 },
    series: series(41, 2.4, 1.9, .12), description: "Share of paying accounts that cancelled in the last 30 days.",
    breakdowns: { plan: plans(-.004, -.003, -.006, .002), region: regions(-.005, -.004, .001, -.002), channel: channels(-.006, -.002, -.003, .004) } },
  { id: "arpa", label: "Revenue per account", kind: "total", format: { prefix: "€", decimals: 1 },
    series: series(53, 69.2, 76.2, .6), description: "Monthly recurring revenue divided by active accounts.",
    breakdowns: { plan: plans(.038, .024, .011, .004), region: regions(.029, .021, .035, .012), channel: channels(.014, .041, .022, .018) } },
  { id: "trials", label: "Trial conversion", kind: "rate", format: { suffix: "%", decimals: 1 },
    series: series(67, 19.8, 22.4, .7, .4), description: "Trials that became paid within 14 days of starting.",
    breakdowns: { plan: plans(.018, .024, .031, .009), region: regions(.022, .017, .028, .006), channel: channels(.026, .012, .019, .033) } },
];
