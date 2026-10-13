/**
 * Seeded, deterministic sample data for the revenue globe. Every payment of the day is derived from the minute it
 * happened in, so any minute can be regenerated on demand and totals always agree with the arcs on screen.
 * Replace `minuteTx` with a query against your payments table to use real data.
 */

export type RegionId = "americas" | "emea" | "apac";
export type City = { name: string; country: string; lat: number; lon: number; tz: number; region: number; weight: number };
export type Tx = { id: number; t: number; city: number; amount: number; product: number };
export type Snapshot = {
  t: number; total: number; count: number; lastHour: number;
  regions: number[]; cityRevenue: number[]; cityCount: number[]; top: number[];
};

export const REGIONS: { id: RegionId; name: string }[] = [
  { id: "americas", name: "Americas" }, { id: "emea", name: "EMEA" }, { id: "apac", name: "APAC" },
];

const c = (name: string, country: string, lat: number, lon: number, tz: number, region: number, weight: number): City =>
  ({ name, country, lat, lon, tz, region, weight });

export const CITIES: City[] = [
  c("San Francisco", "US", 37.77, -122.42, -7, 0, 6),
  c("New York", "US", 40.71, -74.01, -4, 0, 9),
  c("Toronto", "CA", 43.65, -79.38, -4, 0, 3.5),
  c("Chicago", "US", 41.88, -87.63, -5, 0, 4),
  c("Austin", "US", 30.27, -97.74, -5, 0, 3),
  c("Seattle", "US", 47.61, -122.33, -7, 0, 3.5),
  c("Los Angeles", "US", 34.05, -118.24, -7, 0, 5),
  c("Miami", "US", 25.76, -80.19, -4, 0, 2.2),
  c("Mexico City", "MX", 19.43, -99.13, -6, 0, 2.5),
  c("Bogotá", "CO", 4.71, -74.07, -5, 0, 1.2),
  c("Lima", "PE", -12.05, -77.04, -5, 0, 1),
  c("São Paulo", "BR", -23.55, -46.63, -3, 0, 4),
  c("Buenos Aires", "AR", -34.6, -58.38, -3, 0, 1.6),
  c("Santiago", "CL", -33.45, -70.67, -3, 0, 1.2),
  c("London", "GB", 51.51, -0.13, 1, 1, 7),
  c("Dublin", "IE", 53.35, -6.26, 1, 1, 1.8),
  c("Paris", "FR", 48.86, 2.35, 2, 1, 4),
  c("Berlin", "DE", 52.52, 13.4, 2, 1, 4),
  c("Amsterdam", "NL", 52.37, 4.9, 2, 1, 2.8),
  c("Stockholm", "SE", 59.33, 18.07, 2, 1, 2),
  c("Madrid", "ES", 40.42, -3.7, 2, 1, 2.2),
  c("Milan", "IT", 45.46, 9.19, 2, 1, 2),
  c("Istanbul", "TR", 41.01, 28.98, 3, 1, 1.6),
  c("Tel Aviv", "IL", 32.09, 34.78, 3, 1, 2),
  c("Dubai", "AE", 25.2, 55.27, 4, 1, 2),
  c("Lagos", "NG", 6.52, 3.38, 1, 1, 1.2),
  c("Nairobi", "KE", -1.29, 36.82, 3, 1, .9),
  c("Cape Town", "ZA", -33.92, 18.42, 2, 1, 1),
  c("Tokyo", "JP", 35.68, 139.69, 9, 2, 5),
  c("Seoul", "KR", 37.57, 126.98, 9, 2, 3),
  c("Shanghai", "CN", 31.23, 121.47, 8, 2, 2.5),
  c("Hong Kong", "HK", 22.32, 114.17, 8, 2, 2.2),
  c("Singapore", "SG", 1.35, 103.82, 8, 2, 3),
  c("Bengaluru", "IN", 12.97, 77.59, 5.5, 2, 3),
  c("Mumbai", "IN", 19.08, 72.88, 5.5, 2, 2.2),
  c("Jakarta", "ID", -6.21, 106.85, 7, 2, 1.6),
  c("Manila", "PH", 14.6, 120.98, 8, 2, 1.2),
  c("Sydney", "AU", -33.87, 151.21, 10, 2, 3.5),
  c("Melbourne", "AU", -37.81, 144.96, 10, 2, 2.2),
  c("Auckland", "NZ", -36.85, 174.76, 12, 2, 1),
];

export const HQ = 0;
export const DAY = 86400;
/** The moment the section opens on: Tuesday, 22 September, 16:42 UTC. */
export const NOW = 16 * 3600 + 42 * 60;
export const DATE_LABEL = "Tuesday, 22 September";
export const N = CITIES.length;

export const PRODUCTS = [
  { name: "Plus monthly", amount: 8, weight: 45 },
  { name: "Pro monthly", amount: 16, weight: 25 },
  { name: "Seat added", amount: 12, weight: 16 },
  { name: "Usage top-up", amount: 20, weight: 8 },
  { name: "Plus annual", amount: 84, weight: 4 },
  { name: "Pro annual", amount: 168, weight: 1.6 },
  { name: "Team annual", amount: 1200, weight: .3 },
  { name: "Enterprise contract", amount: 0, weight: .006 },
];
const PRODUCT_TOTAL = PRODUCTS.reduce((sum, product) => sum + product.weight, 0);
/** Payments per second for a city of weight 1 at peak local hours. */
const RATE = .064;

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash(n: number) {
  let x = Math.imul((n ^ 0x5bd1e995) >>> 0 ^ (n >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return (x ^ (x >>> 16)) >>> 0;
}

/** Business hours with a small evening bump, by local hour. */
function activity(localHour: number) {
  const h = ((localHour % 24) + 24) % 24;
  const day = h - 13.5;
  const evening = h - 20.5;
  return .07 + .93 * Math.exp(-(day * day) / 21.8) + .16 * Math.exp(-(evening * evening) / 3.9);
}

function poisson(lambda: number, rng: () => number) {
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do { k++; p *= rng(); } while (p > limit && k < 200);
  return k - 1;
}

function pickProduct(rng: () => number) {
  let roll = rng() * PRODUCT_TOTAL;
  for (let i = 0; i < PRODUCTS.length; i++) {
    roll -= PRODUCTS[i].weight;
    if (roll <= 0) return i;
  }
  return 0;
}

/** Every payment in minute `m` of the day, sorted by time. */
export function minuteTx(m: number): Tx[] {
  const rng = mulberry32(hash(m * 7919 + 104729));
  const list: Tx[] = [];
  const hour = Math.floor(m / 60);
  for (let i = 0; i < N; i++) {
    const city = CITIES[i];
    const texture = .78 + .44 * (hash(i * 131 + hour * 977) / 4294967296);
    const lambda = city.weight * activity((m + .5) / 60 + city.tz) * RATE * 60 * texture;
    let count = poisson(lambda, rng);
    while (count-- > 0) {
      const product = pickProduct(rng);
      const amount = PRODUCTS[product].amount || 12000 + Math.floor(rng() * 37) * 1000;
      list.push({ id: 0, t: m * 60 + rng() * 60, city: i, amount, product });
    }
  }
  list.sort((a, b) => a.t - b.t);
  list.forEach((tx, index) => { tx.id = m * 4096 + index; });
  return list;
}

const cache = new Map<number, Tx[]>();
export function getMinute(m: number) {
  let list = cache.get(m);
  if (!list) {
    list = minuteTx(m);
    cache.set(m, list);
    if (cache.size > 24) cache.delete(cache.keys().next().value as number);
  }
  return list;
}

type Day = { revenue: Float64Array; counts: Float64Array; bins: number[]; forecast: number[] };
let dayData: Day | null = null;

/** Per-minute prefix sums for every city, computed once. Row `m` holds totals for everything before minute `m`. */
export function day(): Day {
  if (dayData) return dayData;
  const revenue = new Float64Array(1441 * N);
  const counts = new Float64Array(1441 * N);
  const bins = new Array(96).fill(0);
  for (let m = 0; m < 1440; m++) {
    const row = m * N;
    const next = row + N;
    for (let i = 0; i < N; i++) { revenue[next + i] = revenue[row + i]; counts[next + i] = counts[row + i]; }
    for (const tx of minuteTx(m)) {
      revenue[next + tx.city] += tx.amount;
      counts[next + tx.city] += 1;
      bins[Math.floor(m / 15)] += tx.amount;
    }
  }
  const forecast = REGIONS.map((_, r) => CITIES.reduce((sum, city, i) => sum + (city.region === r ? revenue[1440 * N + i] : 0), 0));
  dayData = { revenue, counts, bins, forecast };
  return dayData;
}

/** Visits every payment with a time in (from, to]. */
export function forEachTx(from: number, to: number, visit: (tx: Tx) => void) {
  const first = Math.max(0, Math.floor(from / 60));
  const last = Math.min(1439, Math.floor(to / 60));
  for (let m = first; m <= last; m++) {
    for (const tx of getMinute(m)) {
      if (tx.t > to) break;
      if (tx.t > from) visit(tx);
    }
  }
}

function totalsAt(t: number, revenue: Float64Array, counts: Float64Array) {
  const d = day();
  const clamped = Math.max(0, Math.min(DAY, t));
  const m = Math.min(1440, Math.floor(clamped / 60));
  const row = m * N;
  for (let i = 0; i < N; i++) { revenue[i] = d.revenue[row + i]; counts[i] = d.counts[row + i]; }
  if (m < 1440) {
    for (const tx of getMinute(m)) {
      if (tx.t > clamped) break;
      revenue[tx.city] += tx.amount;
      counts[tx.city] += 1;
    }
  }
}

const sum = (values: ArrayLike<number>) => { let total = 0; for (let i = 0; i < values.length; i++) total += values[i]; return total; };

/** Totals at time `t`. Payments still in flight on the globe are held back until they land. */
export function snapshotAt(t: number, pending: { city: number; amount: number }[] = []): Snapshot {
  const revenue = new Float64Array(N);
  const counts = new Float64Array(N);
  totalsAt(t, revenue, counts);
  for (const item of pending) { revenue[item.city] -= item.amount; counts[item.city] -= 1; }
  const before = new Float64Array(N);
  const beforeCounts = new Float64Array(N);
  totalsAt(t - 3600, before, beforeCounts);
  const total = sum(revenue);
  const regions = REGIONS.map((_, r) => CITIES.reduce((acc, city, i) => acc + (city.region === r ? revenue[i] : 0), 0));
  const order = CITIES.map((_, i) => i).sort((a, b) => revenue[b] - revenue[a]);
  return {
    t, total, count: sum(counts), lastHour: Math.max(0, total - sum(before)),
    regions, cityRevenue: Array.from(revenue), cityCount: Array.from(counts), top: order.slice(0, 5),
  };
}

/** The largest payments in the window before `t`, newest first. Used for the still frame. */
export function largestBefore(t: number, window: number, count: number) {
  const list: Tx[] = [];
  forEachTx(t - window, t, tx => { if (tx.city !== HQ) list.push(tx); });
  return list.sort((a, b) => b.amount - a.amount).slice(0, count);
}

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
export const formatMoney = (value: number) => money.format(Math.round(value));
export const formatInt = (value: number) => integer.format(Math.round(value));
export function formatCompact(value: number) {
  if (value >= 1e6) return `$${(value / 1e6).toFixed(value >= 1e7 ? 1 : 2)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(value >= 1e5 ? 0 : 1)}k`;
  return formatMoney(value);
}
const pad = (n: number) => String(n).padStart(2, "0");
export function formatClock(t: number, seconds = true) {
  const s = Math.max(0, Math.min(DAY - 1, Math.floor(t)));
  const base = `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}`;
  return seconds ? `${base}:${pad(s % 60)}` : base;
}
export const localTime = (t: number, tz: number) => formatClock((((t + tz * 3600) % DAY) + DAY) % DAY, false);
