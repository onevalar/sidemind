/** Journey data and Sankey layout math. Everything here is pure, so the server and the browser render the same first frame. */

export type NodeKind = "step" | "exit" | "goal";
export interface FlowNode { id: string; name: string; col: number; kind: NodeKind; note: string }
export interface FlowLink { s: number; t: number }
export type TraceTarget = { kind: "node" | "link"; i: number };

export const NODES: FlowNode[] = [
  { id: "visited", name: "Visited", col: 0, kind: "step", note: "Opened the product site in August" },
  { id: "signed-up", name: "Signed up", col: 1, kind: "step", note: "Created an account" },
  { id: "bounced", name: "Bounced", col: 1, kind: "exit", note: "Left without creating an account" },
  { id: "onboarded", name: "Onboarded", col: 2, kind: "step", note: "Finished the setup checklist" },
  { id: "dropped", name: "Dropped", col: 2, kind: "exit", note: "Left before setup was finished" },
  { id: "activated", name: "Activated", col: 3, kind: "step", note: "Shared a first project in week one" },
  { id: "stalled", name: "Stalled", col: 3, kind: "exit", note: "No second session in week one" },
  { id: "paid", name: "Paid", col: 4, kind: "goal", note: "Started a paid plan" },
  { id: "free", name: "Free", col: 4, kind: "exit", note: "Stayed on the free plan" },
];
export const STAGES = ["Visit", "Account", "Setup", "First week", "Plan"];
export const COLUMNS = STAGES.length;
/** Order matters: links leave and enter each node in this order, top to bottom. */
export const LINKS: FlowLink[] = [
  { s: 0, t: 1 }, { s: 0, t: 2 }, { s: 1, t: 3 }, { s: 1, t: 4 }, { s: 3, t: 5 },
  { s: 3, t: 6 }, { s: 5, t: 7 }, { s: 5, t: 8 }, { s: 6, t: 7 }, { s: 6, t: 8 },
];

const channels = [
  { id: "organic", label: "Organic", values: [2863, 5563, 2172, 691, 1394, 778, 463, 931, 41, 737] },
  { id: "ads", label: "Paid ads", values: [1294, 4858, 823, 471, 409, 414, 148, 261, 9, 405] },
  { id: "referral", label: "Referral", values: [1118, 1269, 957, 161, 722, 235, 331, 391, 28, 207] },
];
export const SEGMENTS = [
  { id: "all", label: "All users", values: LINKS.map((_, i) => channels.reduce((sum, channel) => sum + channel.values[i], 0)) },
  ...channels,
];

export const NODE_W = 8;
/** Room above the top row for its labels, below the flows for the stage axis, and between stacked steps for their labels. */
export const TOP = 40, BOTTOM = 34, GAP = 44;
const MIN_NODE = 2;

export function nodeTotals(values: readonly number[]) {
  const inSum = NODES.map(() => 0), outSum = NODES.map(() => 0);
  LINKS.forEach((link, i) => { outSum[link.s] += values[i]; inSum[link.t] += values[i]; });
  return { inSum, outSum, totals: NODES.map((_, j) => Math.max(inSum[j], outSum[j])) };
}

export interface Layout {
  nodes: { x0: number; x1: number; y0: number; y1: number }[];
  links: { x0: number; x1: number; sy: number; ty: number; w: number }[];
}

/** Columns are spread across the measured width; each column stacks from the top, so the path to paid runs along the top edge and every exit falls away below it. */
export function computeLayout(values: readonly number[], width: number, height: number): Layout {
  const { totals } = nodeTotals(values);
  const k = Math.max(0, height - TOP - BOTTOM - GAP) / Math.max(1, totals[0]);
  const step = Math.max(0, width - NODE_W) / (COLUMNS - 1);
  const cursor = STAGES.map(() => TOP);
  const nodes = NODES.map((node, i) => {
    const x0 = Math.round(node.col * step), y0 = cursor[node.col];
    const y1 = y0 + Math.max(MIN_NODE, totals[i] * k);
    cursor[node.col] = y1 + GAP;
    return { x0, x1: x0 + NODE_W, y0, y1 };
  });
  const out = nodes.map(node => node.y0), into = nodes.map(node => node.y0);
  const links = LINKS.map((link, i) => {
    const w = values[i] * k, sy = out[link.s], ty = into[link.t];
    out[link.s] += w; into[link.t] += w;
    return { x0: nodes[link.s].x1, x1: nodes[link.t].x0, sy, ty, w };
  });
  return { nodes, links };
}

const n2 = (value: number) => value.toFixed(2);
/** A filled ribbon: two cubic edges with horizontal tangents at both ends, joined by vertical sides. */
export function ribbon(x0: number, x1: number, sy: number, ty: number, w: number) {
  const xm = (x0 + x1) / 2;
  return `M${n2(x0)} ${n2(sy)}C${n2(xm)} ${n2(sy)} ${n2(xm)} ${n2(ty)} ${n2(x1)} ${n2(ty)}V${n2(ty + w)}C${n2(xm)} ${n2(ty + w)} ${n2(xm)} ${n2(sy + w)} ${n2(x0)} ${n2(sy + w)}Z`;
}

/**
 * The share of each link that belongs to journeys passing through the target.
 * Downstream, a node passes on the share of its inflow that came through the target; upstream, a node
 * contributes the share of its outflow that later reaches it. Flows mix proportionally at each step.
 */
export function traceFractions(values: readonly number[], target: TraceTarget | null) {
  const fractions = LINKS.map(() => 0);
  if (!target) return fractions;
  const { inSum, outSum } = nodeTotals(values);
  const down = NODES.map(() => 0), up = NODES.map(() => 0);
  let downCol: number, upCol: number;
  if (target.kind === "node") {
    down[target.i] = up[target.i] = 1;
    downCol = upCol = NODES[target.i].col;
  } else {
    const link = LINKS[target.i];
    fractions[target.i] = 1;
    down[link.t] = values[target.i] / (inSum[link.t] || 1);
    up[link.s] = values[target.i] / (outSum[link.s] || 1);
    downCol = NODES[link.t].col; upCol = NODES[link.s].col;
  }
  for (let col = downCol + 1; col < COLUMNS; col++) NODES.forEach((node, j) => {
    if (node.col === col) LINKS.forEach((link, i) => { if (link.t === j) down[j] += values[i] / (inSum[j] || 1) * down[link.s]; });
  });
  for (let col = upCol - 1; col >= 0; col--) NODES.forEach((node, j) => {
    if (node.col === col) LINKS.forEach((link, i) => { if (link.s === j) up[j] += values[i] / (outSum[j] || 1) * up[link.t]; });
  });
  LINKS.forEach((link, i) => {
    if (NODES[link.s].col >= downCol) fractions[i] = down[link.s];
    else if (NODES[link.t].col <= upCol) fractions[i] = up[link.t];
  });
  return fractions;
}

const numberFormat = new Intl.NumberFormat("en-US");
export const fmt = (value: number) => numberFormat.format(Math.round(value));
export const pct = (ratio: number) => `${(ratio * 100).toFixed(1)}%`;
