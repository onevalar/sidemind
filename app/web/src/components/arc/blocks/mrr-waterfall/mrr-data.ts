/** Seeded MRR movement for a B2B SaaS workspace in Q3 2025. Every month balances: start + movements = end. */

export type PeriodId = "jul" | "aug" | "sep" | "q3";
export type MoveId = "new" | "expansion" | "reactivation" | "contraction" | "churn";
export type ColumnId = "start" | MoveId | "end";
export type Unit = "usd" | "pct";
export type Tone = "total" | "gain" | "loss";

export type Entry = { key: string; name: string; detail: string; amount: number };
export type Column = { id: ColumnId; name: string; axis: string; short: string; tone: Tone; amount: number; count: number; entries: Entry[] };
export type Period = {
  id: PeriodId; label: string; long: string; range: string; from: string; to: string;
  start: number; end: number; columns: Column[];
  /** Running total after each column except the last: start, then after new, expansion, reactivation, contraction and churn. */
  levels: number[];
  stats: { netNew: number; growth: number; nrr: number; quick: number };
};

type Row = readonly [name: string, detail: string, amount: number];
type Move = { count: number; total: number; top: readonly Row[] };
type Snapshot = { total: number; accounts: number; plans: (readonly [amount: number, accounts: number])[] };
type Month = { id: PeriodId; label: string; long: string; range: string; from: string; to: string; start: Snapshot; end: Snapshot; moves: Record<MoveId, Move> };

export const COLUMN_META: { id: ColumnId; name: string; axis: string; short: string; tone: Tone }[] = [
  { id: "start", name: "Starting MRR", axis: "Start", short: "Start", tone: "total" },
  { id: "new", name: "New business", axis: "New", short: "New", tone: "gain" },
  { id: "expansion", name: "Expansion", axis: "Expansion", short: "Exp.", tone: "gain" },
  { id: "reactivation", name: "Reactivation", axis: "Reactivation", short: "React.", tone: "gain" },
  { id: "contraction", name: "Contraction", axis: "Contraction", short: "Contr.", tone: "loss" },
  { id: "churn", name: "Churn", axis: "Churn", short: "Churn", tone: "loss" },
  { id: "end", name: "Ending MRR", axis: "End", short: "End", tone: "total" },
];
const MOVES: MoveId[] = ["new", "expansion", "reactivation", "contraction", "churn"];
const PLANS = ["Enterprise", "Scale", "Growth", "Starter"];
const LIMIT = 5;

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const count = new Intl.NumberFormat("en-US");

/** Starter is whatever the three larger plans leave, so every snapshot adds up exactly. */
function snap(total: number, accounts: number, plans: [number, number][]): Snapshot {
  return { total, accounts, plans: [...plans, [total - sum(plans.map(plan => plan[0])), accounts - sum(plans.map(plan => plan[1]))]] };
}

const JUL_1 = snap(412_380, 1241, [[151_200, 22], [137_760, 164], [96_880, 486]]);
const AUG_1 = snap(430_800, 1276, [[156_900, 23], [144_120, 171], [101_450, 503]]);
const SEP_1 = snap(442_080, 1287, [[158_300, 23], [149_660, 178], [105_230, 511]]);
const SEP_30 = snap(465_650, 1337, [[167_400, 25], [157_980, 186], [110_820, 531]]);

const MONTHS: Month[] = [
  { id: "jul", label: "Jul", long: "July 2025", range: "Jul 1 – 31, 2025", from: "Jul 1", to: "Jul 31", start: JUL_1, end: AUG_1, moves: {
    new: { count: 64, total: 18_640, top: [["Halcyon Health", "Enterprise, annual", 4800], ["Kestrel Freight", "Scale, 60 seats", 1740], ["Juniper Legal", "Scale, 45 seats", 1310], ["Oakridge Schools", "Growth, 30 seats", 990]] },
    expansion: { count: 41, total: 9870, top: [["Brightwater Labs", "Growth to Scale", 1520], ["Tessellate", "Added 40 seats", 1160], ["Quillon Bank", "Added audit logs", 900], ["Pinecrest Realty", "Added 25 seats", 725]] },
    reactivation: { count: 9, total: 2140, top: [["Fathom Studio", "Back after 4 months, Growth", 597], ["Vireo Travel", "Back after 7 months, Growth", 398], ["Bramble Foods", "Back after 2 months, Starter", 245]] },
    contraction: { count: 19, total: 4310, top: [["Castor Mobility", "Scale to Growth", 1080], ["Sable Insurance", "Removed 30 seats", 870], ["Lattice Robotics", "Removed SSO add-on", 400]] },
    churn: { count: 38, total: 7920, top: [["Copperline Energy", "Moved to an in-house tool", 1990], ["Monarch Dental Group", "Budget cut", 1195], ["Wren & Wolfe", "Acquired by Rhodes Group", 796], ["Arbor & Finch", "Went back to spreadsheets", 398]] },
  } },
  { id: "aug", label: "Aug", long: "August 2025", range: "Aug 1 – 31, 2025", from: "Aug 1", to: "Aug 31", start: AUG_1, end: SEP_1, moves: {
    new: { count: 52, total: 15_210, top: [["Northpeak Logistics", "Enterprise, annual", 5200], ["Solace Clinics", "Scale, 50 seats", 1450], ["Harbor Cooperative", "Growth, 35 seats", 1040], ["Ember Coffee", "Growth, 20 seats", 597]] },
    expansion: { count: 48, total: 12_460, top: [["Halcyon Health", "Added 120 seats", 2400], ["Tessellate", "Growth to Scale", 1380], ["Kestrel Freight", "Added 30 seats", 870], ["Oakridge Schools", "Added data retention", 600]] },
    reactivation: { count: 6, total: 1380, top: [["Cobalt Studio", "Back after 6 months, Growth", 398], ["Ferris Outdoor", "Back after 3 months, Starter", 196]] },
    contraction: { count: 26, total: 6040, top: [["Quillon Bank", "Scale to Growth", 1660], ["Juniper Legal", "Removed 20 seats", 580], ["Brightwater Labs", "Removed audit logs", 450]] },
    churn: { count: 47, total: 11_730, top: [["Atlas Freightways", "Consolidated vendors", 3980], ["Sable Insurance", "Budget cut", 1470], ["Morrow Architects", "Moved to a competitor", 796], ["Tidewater Fitness", "Closed the business", 398]] },
  } },
  { id: "sep", label: "Sep", long: "September 2025", range: "Sep 1 – 30, 2025", from: "Sep 1", to: "Sep 30", start: SEP_1, end: SEP_30, moves: {
    new: { count: 71, total: 21_950, top: [["Granite Mutual", "Enterprise, annual", 6400], ["Orchard Health", "Scale, 80 seats", 2320], ["Pioneer Robotics", "Scale, 55 seats", 1595], ["Lark & Co", "Growth, 25 seats", 750]] },
    expansion: { count: 36, total: 8730, top: [["Northpeak Logistics", "Added 60 seats", 1200], ["Solace Clinics", "Growth to Scale", 1090], ["Halcyon Health", "Added SSO", 800]] },
    reactivation: { count: 12, total: 3260, top: [["Copperline Energy", "Back after 2 months, Scale", 1990], ["Arbor & Finch", "Back after 2 months, Growth", 398], ["Marlow Books", "Back after 9 months, Starter", 147]] },
    contraction: { count: 15, total: 3480, top: [["Kestrel Freight", "Removed 15 seats", 435], ["Harbor Cooperative", "Growth to Starter", 350], ["Pinecrest Realty", "Removed SSO add-on", 300]] },
    churn: { count: 33, total: 6890, top: [["Castor Mobility", "Moved to a competitor", 1020], ["Ember Coffee", "Budget cut", 597], ["Vireo Travel", "Seasonal pause", 398]] },
  } },
];

/** The quarter merges each month's named accounts, so an account that moved twice shows once with both months. */
function mergeMove(months: Month[], id: MoveId): Move {
  const byName = new Map<string, { amount: number; months: string[]; detail: string }>();
  months.forEach(month => month.moves[id].top.forEach(([name, detail, amount]) => {
    const seen = byName.get(name);
    if (seen) { seen.amount += amount; seen.months.push(month.label); } else byName.set(name, { amount, months: [month.label], detail });
  }));
  const named = sum(months.map(month => month.moves[id].top.length));
  const top: Row[] = [...byName].map(([name, item]) => [name, item.months.length > 1 ? `${item.months.join(" and ")} · ${item.months.length} changes` : `${item.months[0]} · ${item.detail}`, item.amount]);
  return { count: sum(months.map(month => month.moves[id].count)) - (named - byName.size), total: sum(months.map(month => month.moves[id].total)), top };
}

const QUARTER: Month = {
  id: "q3", label: "Q3", long: "Q3 2025", range: "Jul 1 – Sep 30, 2025", from: "Jul 1", to: "Sep 30", start: JUL_1, end: SEP_30,
  moves: Object.fromEntries(MOVES.map(id => [id, mergeMove(MONTHS, id)])) as Record<MoveId, Move>,
};

function planEntries(snapshot: Snapshot): Entry[] {
  return snapshot.plans.map(([amount, accounts], index) => ({ key: PLANS[index], name: PLANS[index], detail: `${count.format(accounts)} accounts`, amount }));
}

/** The largest accounts are named; the rest fold into one row so the list always adds up to the bar. */
function moveEntries(move: Move): Entry[] {
  const top = [...move.top].sort((a, b) => b[2] - a[2]).slice(0, LIMIT);
  const entries: Entry[] = top.map(([name, detail, amount]) => ({ key: name, name, detail, amount }));
  const rest = move.count - top.length;
  if (rest > 0) entries.push({ key: "rest", name: "Other accounts", detail: `${count.format(rest)} accounts`, amount: move.total - sum(top.map(row => row[2])) });
  return entries;
}

function build(month: Month): Period {
  const { start, end, moves } = month;
  const columns = COLUMN_META.map((meta): Column => {
    if (meta.id === "start") return { ...meta, amount: start.total, count: start.accounts, entries: planEntries(start) };
    if (meta.id === "end") return { ...meta, amount: end.total, count: end.accounts, entries: planEntries(end) };
    const move = moves[meta.id];
    return { ...meta, amount: move.total, count: move.count, entries: moveEntries(move) };
  });
  const levels = [start.total];
  MOVES.forEach(id => levels.push(levels[levels.length - 1] + (id === "contraction" || id === "churn" ? -moves[id].total : moves[id].total)));
  const gains = moves.new.total + moves.expansion.total + moves.reactivation.total;
  const losses = moves.contraction.total + moves.churn.total;
  return {
    id: month.id, label: month.label, long: month.long, range: month.range, from: month.from, to: month.to,
    start: start.total, end: end.total, columns, levels,
    stats: { netNew: end.total - start.total, growth: (end.total - start.total) / start.total * 100, nrr: (start.total + moves.expansion.total - losses) / start.total * 100, quick: gains / losses },
  };
}

export const PERIODS: Record<PeriodId, Period> = Object.fromEntries([...MONTHS, QUARTER].map(month => [month.id, build(month)])) as Record<PeriodId, Period>;
export const PERIOD_OPTIONS = [...MONTHS, QUARTER].map(month => ({ value: month.id, label: month.label }));

/** Nice steps in 1, 2, 2.5 and 5; the smallest that fits in eight intervals wins. */
function niceStep(lo: number, hi: number) {
  const base = 10 ** Math.floor(Math.log10((hi - lo) / 8));
  for (const factor of [1, 2, 2.5, 5, 10, 20]) {
    const step = base * factor;
    if (Math.ceil(hi / step) - Math.floor(lo / step) <= 8) return step;
  }
  return base * 50;
}

/**
 * The axis starts above zero so movements a few percent in size stay readable; the total bars carry a break mark to say so.
 * Ticks are in the display unit; lo and hi come back in dollars so both units share one geometry.
 */
export function domainOf(period: Period, unit: Unit) {
  const scale = unit === "pct" ? 100 / period.start : 1;
  const values = period.levels.map(level => level * scale);
  const min = Math.min(...values), max = Math.max(...values), span = max - min;
  const rawLo = min - span * .6, rawHi = max + span * .06;
  const step = niceStep(rawLo, rawHi);
  const lo = Math.floor(rawLo / step) * step, hi = Math.ceil(rawHi / step) * step;
  const ticks = Array.from({ length: Math.round((hi - lo) / step) + 1 }, (_, index) => +(lo + index * step).toFixed(4));
  return { lo: lo / scale, hi: hi / scale, ticks };
}
