/** Seeded sample book of 2,400 accounts. Every value comes from one PRNG, so server and client render the same numbers. */

export type GroupKey = "all" | "plan" | "region" | "health" | "industry";
/** Health index: 0 healthy (neutral), 1 expanding (success), 2 watch (warning), 3 at risk (danger). */
export type HealthIndex = 0 | 1 | 2 | 3;

export type Account = {
  id: number; name: string; plan: number; region: number; industry: number; health: HealthIndex;
  mrr: number; owner: string; note: string;
};

export const PLANS = ["Starter", "Growth", "Scale", "Enterprise"];
export const REGIONS = ["North America", "Europe", "Asia Pacific", "Latin America"];
export const INDUSTRIES = ["Software", "Fintech", "Healthcare", "Retail", "Media", "Logistics"];
export const HEALTH_LABELS = ["Healthy", "Expanding", "Watch", "At risk"];
/** Legend, bar and cluster order for health: good news first, risk last. */
export const HEALTH_ORDER: HealthIndex[] = [1, 0, 2, 3];
export const HEALTH_TONES = ["neutral", "success", "warning", "danger"] as const;

export const GROUPS: { key: GroupKey; label: string; noun: string }[] = [
  { key: "all", label: "All", noun: "health" },
  { key: "plan", label: "Plan", noun: "plan" },
  { key: "region", label: "Region", noun: "region" },
  { key: "health", label: "Health", noun: "health" },
  { key: "industry", label: "Industry", noun: "industry" },
];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20260922);
const pick = <T,>(list: readonly T[]) => list[Math.floor(rand() * list.length) % list.length];
const weighted = (weights: number[]) => {
  const total = weights.reduce((sum, w) => sum + w, 0);
  let roll = rand() * total;
  for (let i = 0; i < weights.length; i++) { roll -= weights[i]; if (roll <= 0) return i; }
  return weights.length - 1;
};
const gaussian = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

const PREFIXES = ["North", "Blue", "Iron", "Clear", "Bright", "Silver", "Harbor", "Summit", "Pine", "Cedar", "Atlas", "Nova", "Lumen", "Vector", "Kite", "Orbit", "Quill", "Ember", "Tidal", "Maple", "Echo", "Juniper", "Beacon", "Granite", "Copper", "Aster", "Birch", "Coral", "Delta", "Falcon", "Glacier", "Halo", "Indigo", "Lark", "Meadow", "Onyx", "Pioneer", "Ridge", "Sable", "Willow"];
const SUFFIXES = ["field", "stone", "works", "wind", "point", "line", "gate", "path", "bridge", "craft", "forge", "light", "well", "bay", "peak", "lane"];
const WORDS = [
  ["Labs", "Systems", "Cloud", "Software", "Data"],
  ["Pay", "Capital", "Ledger", "Finance", "Bank"],
  ["Health", "Clinics", "Care", "Bio", "Medical"],
  ["Goods", "Market", "Supply", "Outfitters", "Home"],
  ["Media", "Studios", "Press", "Sound", "Games"],
  ["Freight", "Logistics", "Fleet", "Transit", "Cargo"],
];
const OWNERS = [["Emma Collins", "Jonas Weber", "Ava Thompson"], ["Daniel Kim", "Elin Lund", "Noah Becker"], ["Kenji Sato", "Priya Raman"], ["Sofia Alvarez", "Mateo Rojas"]];
const PLAN_COUNTS = [1320, 700, 300, 80];
/** Median MRR, spread and bounds per plan. */
const PLAN_MRR = [[140, .55, 49, 480, 1], [1300, .45, 600, 3200, 10], [6200, .4, 3500, 14000, 50], [33000, .45, 16000, 92000, 100]];
const MONTHS = ["June", "July", "August"];
const NOTES: ((r: () => number) => string)[][] = [
  [() => "Usage steady", r => `Renewed in ${MONTHS[Math.floor(r() * 3)]}`, r => `${62 + Math.floor(r() * 30)}% weekly active`],
  [r => `Seats up ${12 + Math.floor(r() * 30)}% this quarter`, r => `Added ${2 + Math.floor(r() * 6)} workspaces`, () => "Upgrade call booked", r => `Usage up ${9 + Math.floor(r() * 24)}% month over month`],
  [r => `Champion left in ${MONTHS[Math.floor(r() * 3)]}`, r => `Usage down ${8 + Math.floor(r() * 14)}%`, r => `Support tickets up ${20 + Math.floor(r() * 40)}%`, r => `Renewal in ${30 + Math.floor(r() * 50)} days`],
  [r => `Usage down ${28 + Math.floor(r() * 30)}%`, r => `Renewal in ${9 + Math.floor(r() * 30)} days, no reply`, r => `${2 + Math.floor(r() * 4)} open escalations`, () => "Evaluating alternatives"],
];

function buildAccounts(): Account[] {
  const names = new Set<string>();
  const list: Account[] = [];
  PLAN_COUNTS.forEach((count, plan) => {
    const [median, spread, min, max, step] = PLAN_MRR[plan];
    for (let k = 0; k < count; k++) {
      const region = weighted([44, 31, 17, 8]);
      const industry = weighted([29, 16, 15, 15, 11, 14]);
      // Health leans on real drivers: larger plans expand, retail and small plans slip, Latin America needs watching.
      const w = [72, 10, 10, 8];
      if (plan === 3) { w[1] += 7; w[3] -= 4; }
      if (plan === 0) { w[3] += 3; w[1] -= 4; }
      if (industry === 3) { w[3] += 8; w[2] += 4; }
      if (industry === 1) w[1] += 5;
      if (industry === 4) w[2] += 4;
      if (region === 3) w[2] += 6;
      const health = weighted(w) as HealthIndex;
      const raw = Math.exp(Math.log(median) + spread * gaussian());
      const mrr = Math.round(Math.min(max, Math.max(min, raw)) / step) * step;
      let name = "";
      for (let tries = 0; tries < 12 && (!name || names.has(name)); tries++) {
        const base = rand() < .3 ? pick(PREFIXES) : `${pick(PREFIXES)}${pick(SUFFIXES)}`;
        name = `${base} ${pick(WORDS[industry])}`;
      }
      if (names.has(name)) name = `${name} Group`;
      names.add(name);
      const owner = plan === 0 ? "Digital success" : pick(OWNERS[region]);
      list.push({ id: list.length, name, plan, region, industry, health, mrr, owner, note: pick(NOTES[health])(rand) });
    }
  });
  return list;
}

export const ACCOUNTS: Account[] = buildAccounts();

export function categoriesOf(group: GroupKey): string[] {
  if (group === "plan") return PLANS;
  if (group === "region") return REGIONS;
  if (group === "industry") return INDUSTRIES;
  if (group === "health") return HEALTH_ORDER.map(h => HEALTH_LABELS[h]);
  return ["All accounts"];
}

/** Which cluster an account belongs to under a grouping. Health clusters follow HEALTH_ORDER. */
export function categoryOf(group: GroupKey, a: Account): number {
  if (group === "plan") return a.plan;
  if (group === "region") return a.region;
  if (group === "industry") return a.industry;
  if (group === "health") return HEALTH_ORDER.indexOf(a.health);
  return 0;
}

export type GroupStat = { index: number; label: string; count: number; mrr: number; healthMrr: number[]; healthCount: number[] };

const statCache = new Map<GroupKey, GroupStat[]>();
export function statsFor(group: GroupKey): GroupStat[] {
  const hit = statCache.get(group);
  if (hit) return hit;
  const stats = categoriesOf(group).map((label, index) => ({ index, label, count: 0, mrr: 0, healthMrr: [0, 0, 0, 0], healthCount: [0, 0, 0, 0] }));
  for (const a of ACCOUNTS) {
    const s = stats[categoryOf(group, a)];
    s.count++; s.mrr += a.mrr; s.healthMrr[a.health] += a.mrr; s.healthCount[a.health]++;
  }
  statCache.set(group, stats);
  return stats;
}

export const TOTAL = statsFor("all")[0];

/** Stats for the rows in the side panel. "All" breaks the book down by health so the rows still mean something. */
export const rowsFor = (group: GroupKey) => statsFor(group === "all" ? "health" : group);

const grouped = new Intl.NumberFormat("en-US");
export const formatCount = (value: number) => grouped.format(value);
export const formatMoney = (value: number) => `$${grouped.format(value)}`;
export function formatCompact(value: number) {
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e4) return `$${Math.round(value / 1e3)}K`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${Math.round(value)}`;
}
export const percent = (part: number, whole: number) => whole ? Math.round((part / whole) * 100) : 0;
