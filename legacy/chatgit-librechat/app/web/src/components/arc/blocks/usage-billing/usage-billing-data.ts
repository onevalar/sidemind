/** Sample billing data for the usage billing block. Replace with figures from your billing provider. */

export type MeterUnit = "requests" | "gigabytes" | "minutes" | "invocations" | "seats";

export type Meter = {
  id: string;
  name: string;
  unit: MeterUnit;
  /** Usage so far this period, in the meter's base unit. */
  used: number;
  /** Included amount on the current plan. */
  limit: number;
  /** Price for usage past the limit, shown in the row. */
  overage: string;
};

export type SpendAlert = { id: string; amount: number; email: boolean; slack: boolean };

export type Invoice = { id: string; number: string; period: string; issued: string; amount: number; status: "paid" | "refunded" | "failed" };

export type Plan = { id: string; name: string; price: number; limits: Record<string, number>; perks: string[] };

export const billingPeriod = { label: "Sep 1 to Sep 30", start: "2026-09-01", days: 30, today: 24 };

/** Usage charges per day so far this period, in euros. */
export const dailySpend = [
  38.2, 41.6, 36.9, 44.1, 52.8, 29.4, 27.1, 47.3, 49.9, 51.2, 55.6, 58.3, 33.8, 31.2,
  54.7, 57.9, 62.4, 60.1, 64.8, 38.6, 35.1, 66.2, 69.4, 78.2,
];

export const monthlyBudget = 2000;

export const meters: Meter[] = [
  { id: "requests", name: "API requests", unit: "requests", used: 8_420_000, limit: 10_000_000, overage: "€2 per extra million" },
  { id: "bandwidth", name: "Bandwidth", unit: "gigabytes", used: 1_840, limit: 2_000, overage: "€0.08 per extra GB" },
  { id: "builds", name: "Build minutes", unit: "minutes", used: 3_120, limit: 6_000, overage: "€0.01 per extra minute" },
  { id: "functions", name: "Function invocations", unit: "invocations", used: 21_400_000, limit: 50_000_000, overage: "€0.60 per extra million" },
  { id: "seats", name: "Seats", unit: "seats", used: 18, limit: 20, overage: "€19 per extra seat" },
];

export const currentPlan: Plan = {
  id: "pro", name: "Pro", price: 249,
  limits: { requests: 10_000_000, bandwidth: 2_000, builds: 6_000, functions: 50_000_000, seats: 20 },
  perks: ["Email support", "7 day log retention"],
};

export const upgradePlan: Plan = {
  id: "scale", name: "Scale", price: 699,
  limits: { requests: 25_000_000, bandwidth: 5_000, builds: 12_000, functions: 100_000_000, seats: 50 },
  perks: ["Priority support", "30 day log retention", "SAML single sign-on"],
};

export const paymentMethod = { brand: "Visa", last4: "4242", expires: "08/28" };

export const spendAlerts: SpendAlert[] = [
  { id: "a1", amount: 1000, email: true, slack: false },
  { id: "a2", amount: 1500, email: true, slack: true },
];

export const invoices: Invoice[] = [
  { id: "inv-08", number: "NW-2026-008", period: "August 2026", issued: "Sep 1", amount: 1742.18, status: "paid" },
  { id: "inv-07", number: "NW-2026-007", period: "July 2026", issued: "Aug 1", amount: 1618.4, status: "paid" },
  { id: "inv-06", number: "NW-2026-006", period: "June 2026", issued: "Jul 1", amount: 1480.07, status: "paid" },
  { id: "inv-05", number: "NW-2026-005", period: "May 2026", issued: "Jun 1", amount: 1302.55, status: "refunded" },
  { id: "inv-04", number: "NW-2026-004", period: "April 2026", issued: "May 1", amount: 1211.9, status: "paid" },
];
