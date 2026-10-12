/** Sample data for the connected scatter: monthly CAC against 12 month LTV for three acquisition channels. */

export type LabelSide = "left" | "right" | "above" | "below";

export interface ScatterPoint {
  /** Short date shown in the readout, tooltip and scrubber, for example "Mar 2026". */
  label: string;
  /** Value on the horizontal axis, in the unit the formatter prints. */
  x: number;
  /** Value on the vertical axis. */
  y: number;
}

export interface ScatterNote {
  /** Index of the month the note marks. */
  index: number;
  /** A few words, sentence case. */
  text: string;
  /** Side of the point the label sits on. */
  side: LabelSide;
}

export interface ScatterSeries {
  id: string;
  /** Name in the series switch. */
  name: string;
  /** One point per period, in time order. Every series has the same number of points so the path can morph. */
  points: ScatterPoint[];
  /** Key moments labelled on the chart. The first and last month are labelled automatically. */
  notes?: ScatterNote[];
}

export interface ScatterAxis {
  /** Short name used in the readout and tooltip. */
  name: string;
  /** Longer name printed on the axis. */
  title: string;
  /** Lower end of the axis. */
  min: number;
  /** Upper end of the axis. */
  max: number;
  /** Distance between gridlines. */
  step: number;
}

export const MONTHS = [
  "Jan 2025", "Feb 2025", "Mar 2025", "Apr 2025", "May 2025", "Jun 2025",
  "Jul 2025", "Aug 2025", "Sep 2025", "Oct 2025", "Nov 2025", "Dec 2025",
  "Jan 2026", "Feb 2026", "Mar 2026", "Apr 2026", "May 2026", "Jun 2026",
];

const build = (cac: number[], ltv: number[]): ScatterPoint[] => MONTHS.map((label, i) => ({ label, x: cac[i], y: ltv[i] }));

export const SERIES: ScatterSeries[] = [
  {
    id: "paid-search",
    name: "Paid search",
    points: build(
      [760, 800, 850, 905, 960, 1030, 1110, 1190, 1260, 1300, 1320, 1290, 1220, 1150, 1080, 1030, 990, 960],
      [3000, 3060, 3110, 3090, 3140, 3120, 3100, 3080, 3060, 3110, 3200, 3380, 3620, 3900, 4150, 4360, 4520, 4640],
    ),
    notes: [
      { index: 6, text: "Broad match on", side: "above" },
      { index: 12, text: "Annual plans", side: "left" },
    ],
  },
  {
    id: "organic",
    name: "Organic",
    points: build(
      [560, 540, 565, 520, 495, 505, 470, 450, 430, 405, 420, 390, 372, 385, 360, 350, 356, 340],
      [2350, 2410, 2380, 2500, 2560, 2620, 2700, 2790, 2900, 3150, 3380, 3520, 3610, 3700, 3790, 3860, 3950, 4020],
    ),
    notes: [{ index: 9, text: "Docs relaunch", side: "right" }],
  },
  {
    id: "partners",
    name: "Partners",
    points: build(
      [1700, 1660, 1630, 1650, 1580, 1520, 1470, 1490, 1420, 1370, 1330, 1345, 1290, 1240, 1210, 1225, 1180, 1150],
      [4200, 4280, 4390, 4340, 4520, 4650, 4760, 4720, 4910, 5040, 5130, 5200, 5330, 5420, 5510, 5560, 5660, 5740],
    ),
    notes: [{ index: 5, text: "Referral tiers", side: "right" }],
  },
];

export const X_AXIS: ScatterAxis = { name: "CAC", title: "Customer acquisition cost", min: 200, max: 1800, step: 200 };
export const Y_AXIS: ScatterAxis = { name: "LTV", title: "12 month lifetime value", min: 2000, max: 6000, step: 1000 };

/** The healthy ratio: LTV at least three times CAC. */
export const TARGET_RATIO = 3;
