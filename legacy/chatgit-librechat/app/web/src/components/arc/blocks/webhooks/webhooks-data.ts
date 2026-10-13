/** Sample data for the webhooks console. Everything is deterministic: the same seed always yields the same volumes, ids, and signatures. */

export type EventType = "order.paid" | "order.refunded" | "customer.created" | "invoice.paid" | "invoice.payment_failed" | "payout.paid" | "payout.failed" | "refund.created" | "dispute.created";
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type Person = { name: string; photo: string };

export type Delivery = {
  id: string; eventId: string; event: EventType; status: number; latency: number;
  /** When this attempt was sent, and when the event itself was created. They differ on retries. */
  time: string; eventTime: string;
  attempt: number; response: string; data: { [key: string]: Json };
  resolved?: boolean; test?: boolean;
};

export type Endpoint = { id: string; name: string; url: string; events: EventType[]; version: string; secretTail: string; addedBy: Person; added: string; volume: number[]; deliveries: Delivery[] };

export const SLOTS = 48;
const people = {
  emma: { name: "Emma Collins", photo: "/media/people/emma-collins.jpg" },
  marcus: { name: "Marcus Johnson", photo: "/media/people/marcus-johnson.jpg" },
  ava: { name: "Ava Mitchell", photo: "/media/people/ava-mitchell.jpg" },
  sofia: { name: "Sofia Ramirez", photo: "/media/people/sofia-ramirez.jpg" },
};
export const currentUser: Person = people.sofia;

export const eventOptions: { id: EventType; description: string }[] = [
  { id: "order.paid", description: "An order is paid in full" },
  { id: "order.refunded", description: "An order is refunded, fully or in part" },
  { id: "invoice.paid", description: "A subscription invoice is paid" },
  { id: "invoice.payment_failed", description: "A renewal charge is declined" },
  { id: "payout.paid", description: "A payout reaches your bank" },
  { id: "dispute.created", description: "A customer disputes a charge" },
];

export const phrases: Record<number, string> = { 200: "OK", 404: "Not Found", 500: "Internal Server Error", 502: "Bad Gateway", 504: "Gateway Timeout" };

function hashOf(seed: string) {
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0 || 1;
}
function randomFrom(seed: string) {
  let state = hashOf(seed);
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 4294967296; };
}
export function tokenFrom(seed: string, length: number, alphabet = "0123456789abcdef") {
  const next = randomFrom(seed);
  let out = "";
  for (let index = 0; index < length; index++) out += alphabet[Math.floor(next() * alphabet.length)];
  return out;
}
const base62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const secretFor = (seed: string) => `whsec_${tokenFrom(seed, 32, base62)}`;

/** The console's clock is fixed at 14:32 on Sep 22, 2026. Slot 0 starts at 15:00 yesterday; slot 47 is the half hour in progress. */
const parts = (time: string) => time.split(":").map(Number) as [number, number, number];
export const unixAt = (time: string) => { const [h, m, s] = parts(time); return Date.UTC(2026, 8, 22, h, m, s) / 1000; };
export const slotAt = (time: string) => { const [h, m] = parts(time); return Math.min(SLOTS - 1, Math.floor(((h + 9) * 60 + m) / 30)); };
export const slotLabel = (slot: number) => {
  const start = (15 * 60 + slot * 30) % 1440, end = (start + 30) % 1440;
  const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return slot === SLOTS - 1 ? `${clock(start)} to now` : `${clock(start)} to ${clock(end)}`;
};
/** New attempts land a few seconds apart after 14:32:05. */
export const clockAfter = (step: number) => {
  const total = 14 * 3600 + 32 * 60 + 5 + step * 9;
  return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60].map(part => String(part).padStart(2, "0")).join(":");
};

/** Event volume per half hour follows the working day, with a little seeded jitter. */
function volumeFor(seed: string, peak: number) {
  const next = randomFrom(seed);
  return Array.from({ length: SLOTS }, (_, slot) => {
    const hour = (15 + slot / 2) % 24;
    const day = Math.max(0, Math.sin((Math.PI * (hour - 6)) / 16));
    const value = Math.round((.1 + .9 * day) * peak * (.72 + next() * .56));
    return slot === SLOTS - 1 ? Math.max(1, Math.round(value * .12)) : value;
  });
}
function sparseVolume(counts: Record<number, number>) { return Array.from({ length: SLOTS }, (_, slot) => counts[slot] ?? 0); }

type Row = [id: string, event: EventType, status: number, latency: number, time: string, data: { [key: string]: Json }, response?: string];
const ok = '{"received":true}';
function rows(list: Row[]): Delivery[] {
  return list.map(([id, event, status, latency, time, data, response]) => ({ id, eventId: `evt_${tokenFrom(id, 10, base62)}`, event, status, latency, time, eventTime: time, attempt: 1, response: response ?? ok, data }));
}
/** Every listed delivery falls inside a slot that has at least that many events. */
function endpoint(item: Omit<Endpoint, "volume"> & { volume: number[] }): Endpoint {
  const volume = [...item.volume];
  for (const delivery of item.deliveries) { const slot = slotAt(delivery.eventTime); volume[slot] = Math.max(volume[slot], item.deliveries.filter(other => slotAt(other.eventTime) === slot).length); }
  return { ...item, volume };
}

export const sampleEndpoints: Endpoint[] = [
  endpoint({
    id: "ledger", name: "Ledger sync", url: "https://ledger.fernway.example/v1/halden/events", events: ["invoice.paid", "invoice.payment_failed", "payout.paid", "refund.created"],
    version: "2026-08-01", secretTail: "7f3a", addedBy: people.emma, added: "Mar 4, 2026", volume: volumeFor("ledger", 14),
    deliveries: rows([
      ["dlv_8Kq2Lm4", "invoice.paid", 200, 142, "14:31:08", { id: "in_1Q8vRt2", object: "invoice", number: "FW-2026-1182", customer: "cus_R4bLw9", amount_paid: 48000, currency: "usd", status: "paid" }],
      ["dlv_7Hn1Pc9", "invoice.payment_failed", 500, 2318, "14:12:44", { id: "in_1Q8uXe7", object: "invoice", number: "FW-2026-1179", customer: "cus_P2mZr6", amount_due: 129900, currency: "usd", attempt_count: 2, next_payment_attempt: 1790265600 }, '{"error":"ledger_write_failed","message":"connection pool exhausted"}'],
      ["dlv_6Gm0Ob8", "payout.paid", 200, 98, "13:47:02", { id: "po_1Q9aZt4", object: "payout", amount: 1845210, currency: "usd", arrival_date: 1790035200, destination: "ba_1PzR7c", status: "paid" }],
      ["dlv_5Fl9Na7", "invoice.paid", 504, 30000, "11:05:19", { id: "in_1Q8pLk3", object: "invoice", number: "FW-2026-1164", customer: "cus_K9dQe2", amount_paid: 21900, currency: "usd", status: "paid" }, "upstream request timeout"],
      ["dlv_4Ek8Mz6", "refund.created", 200, 121, "10:22:51", { id: "re_1Q8nWb5", object: "refund", charge: "ch_3Q8mTz1", amount: 4800, currency: "usd", reason: "requested_by_customer", status: "succeeded" }],
      ["dlv_3Dj7Ly5", "invoice.paid", 500, 1904, "09:14:36", { id: "in_1Q8kFa9", object: "invoice", number: "FW-2026-1151", customer: "cus_H3vNp8", amount_paid: 9900, currency: "usd", status: "paid" }, '{"error":"ledger_write_failed","message":"deadlock detected on ledger_entries"}'],
      ["dlv_2Ci6Kx4", "invoice.paid", 200, 133, "08:59:10", { id: "in_1Q8jRm0", object: "invoice", number: "FW-2026-1149", customer: "cus_B7xLc4", amount_paid: 36000, currency: "usd", status: "paid" }],
    ]),
  }),
  endpoint({
    id: "orders", name: "Order fulfilment", url: "https://api.fernway.example/webhooks/halden", events: ["order.paid", "order.refunded", "customer.created"],
    version: "2026-08-01", secretTail: "c21e", addedBy: people.marcus, added: "Jan 18, 2026", volume: volumeFor("orders", 34),
    deliveries: rows([
      ["dlv_9Lr3Mn5", "order.paid", 200, 87, "14:30:52", { id: "ord_7Qm2Ks", object: "order", customer: "cus_T7wQx1", amount_total: 21400, currency: "usd", items: 3, shipping: "standard" }],
      ["dlv_9Ks2Ln4", "customer.created", 200, 64, "14:30:49", { id: "cus_T7wQx1", object: "customer", name: "Priya Raman", email: "priya@lumenhaus.co", country: "US" }],
      ["dlv_9Jt1Ko3", "order.paid", 200, 112, "14:26:13", { id: "ord_7Qk8Hd", object: "order", customer: "cus_M2pRz5", amount_total: 5800, currency: "usd", items: 1, shipping: "express" }],
      ["dlv_9Iu0Jp2", "order.refunded", 200, 95, "14:02:37", { id: "ord_7Qh4Wn", object: "order", customer: "cus_D8nVt3", amount_refunded: 5800, currency: "usd", reason: "damaged_in_transit" }],
      ["dlv_9Hv9Iq1", "order.paid", 200, 238, "13:58:04", { id: "ord_7Qg1Bc", object: "order", customer: "cus_F4kYs9", amount_total: 13250, currency: "usd", items: 2, shipping: "standard" }],
    ]),
  }),
  endpoint({
    id: "alerts", name: "Ops alerts", url: "https://hooks.fernway.example/ops/halden", events: ["dispute.created", "payout.failed"],
    version: "2026-05-12", secretTail: "90bd", addedBy: people.ava, added: "Jun 9, 2026", volume: sparseVolume({ 4: 1, 17: 1, 32: 1, 43: 2 }),
    deliveries: rows([
      ["dlv_1Aw5Cr8", "dispute.created", 200, 311, "12:40:18", { id: "dp_1Q8tYh6", object: "dispute", charge: "ch_3Q7wPx2", amount: 8900, currency: "usd", reason: "product_not_received", status: "needs_response" }],
      ["dlv_1Bx4Ds7", "payout.failed", 200, 276, "07:12:55", { id: "po_1Q8hVc2", object: "payout", amount: 212000, currency: "usd", failure_code: "account_closed", destination: "ba_1NcT3q" }],
    ]),
  }),
];

/** Test events for a new endpoint, so the inspector has something real-looking to show. */
export const testObjects: Record<EventType, { [key: string]: Json }> = {
  "order.paid": { id: "ord_test_4Tq9", object: "order", customer: "cus_test_Z1", amount_total: 2500, currency: "usd", items: 1, shipping: "standard" },
  "order.refunded": { id: "ord_test_4Tq9", object: "order", customer: "cus_test_Z1", amount_refunded: 2500, currency: "usd", reason: "requested_by_customer" },
  "customer.created": { id: "cus_test_Z1", object: "customer", name: "Test customer", email: "test@example.com", country: "US" },
  "invoice.paid": { id: "in_test_8Kd2", object: "invoice", number: "TEST-0001", customer: "cus_test_Z1", amount_paid: 2500, currency: "usd", status: "paid" },
  "invoice.payment_failed": { id: "in_test_8Kd2", object: "invoice", number: "TEST-0001", customer: "cus_test_Z1", amount_due: 2500, currency: "usd", attempt_count: 1 },
  "payout.paid": { id: "po_test_3Hs7", object: "payout", amount: 100000, currency: "usd", destination: "ba_test_9", status: "paid" },
  "payout.failed": { id: "po_test_3Hs7", object: "payout", amount: 100000, currency: "usd", failure_code: "account_closed" },
  "refund.created": { id: "re_test_6Pw1", object: "refund", charge: "ch_test_2", amount: 2500, currency: "usd", status: "succeeded" },
  "dispute.created": { id: "dp_test_5Lx3", object: "dispute", charge: "ch_test_2", amount: 2500, currency: "usd", reason: "fraudulent", status: "needs_response" },
};

export const failed = (delivery: Delivery) => delivery.status >= 300 && !delivery.resolved;

export function payloadFor(endpoint: Endpoint, delivery: Delivery) {
  return { id: delivery.eventId, type: delivery.event, created: unixAt(delivery.eventTime), api_version: endpoint.version, livemode: !delivery.test, data: { object: delivery.data } };
}

export function headersFor(endpoint: Endpoint, delivery: Delivery): [string, string][] {
  return [
    ["Content-Type", "application/json; charset=utf-8"],
    ["User-Agent", "Halden-Webhooks/2026-08"],
    ["Halden-Event-Id", delivery.eventId],
    ["Halden-Delivery-Id", delivery.id],
    ["Halden-Attempt", String(delivery.attempt)],
    ["Halden-Signature", `t=${unixAt(delivery.time)},v1=${tokenFrom(`${delivery.id}:${endpoint.secretTail}`, 64)}`],
  ];
}

/** Per slot: all events, and the ones whose latest attempt still failed. */
export function seriesFor(endpoint: Endpoint) {
  const fails = Array.from({ length: SLOTS }, () => 0);
  for (const delivery of endpoint.deliveries) if (failed(delivery)) fails[slotAt(delivery.eventTime)] += 1;
  const total = endpoint.volume.reduce((sum, value) => sum + value, 0);
  const failing = fails.reduce((sum, value) => sum + value, 0);
  return { volume: endpoint.volume, fails, total, failing };
}
