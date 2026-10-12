"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import { FileText, Pause, Play } from "lucide-react";
import styles from "./vector-search.module.css";

export interface VectorSearchSource {
  /** Where the document lives, such as Notion. */
  name: string;
  /**
   * The mark. A string is either SVG path data on a 24 by 24 viewBox (the Simple Icons format), painted in color, or an
   * image URL for a full color logo. Any ReactNode works too and inherits the text color. Defaults to a file icon.
   */
  icon?: string | ReactNode;
  /** Brand color for a path mark. Leave it out for black and white brands so the mark follows the text color. */
  color?: string;
}

export interface VectorSearchDocument {
  /** Document title, shown on hover and in the results. */
  title: string;
  /** Index into topics. Documents of one topic cluster together. */
  topic: number;
  /** Where the document comes from, shown beside it in the results. */
  source?: VectorSearchSource;
  /** Position in the embedding plane, from -1 to 1 on each axis. Placed around its topic when left out. */
  x?: number;
  y?: number;
}

export interface VectorSearchTopic {
  /** Topic name, shown on its cluster. */
  name: string;
  /** Color of the topic's points and cluster. Defaults to the chart series colors. */
  color?: string;
}

export interface VectorSearchLabels {
  /** Stage names in the step bar. */
  embed?: string;
  index?: string;
  query?: string;
  rank?: string;
  /** Stat names in the legend. */
  embedded?: string;
  links?: string;
  hops?: string;
  /** Heading of the vector readout while documents are embedded, and while the query is. */
  embedding?: string;
  queryHeading?: string;
  /** Heading over the results. */
  results?: string;
  /** Chip on the query point. */
  queryChip?: string;
}

/**
 * An animated vector search. Documents drop onto a tilted embedding plane and fold into points that cluster by topic, while
 * a readout shows each one's vector. The index links near neighbours into a graph, a query is typed, embedded, and lowered
 * onto the plane, and a search signal hops along the graph from an entry point toward it. A ring then widens from the query
 * and the nearest documents light up with connecting lines and similarity scores, filling a ranked list beside the plane.
 * A step bar replays or jumps between stages.
 */
export interface VectorSearchProps {
  /** Documents in the index, from 6 to 24. */
  documents?: VectorSearchDocument[];
  /** Topics the documents cluster by, from two to four. */
  topics?: VectorSearchTopic[];
  /** The search query. */
  query?: string;
  /** Where the query lands, from -1 to 1 on each axis. Defaults to beside the first document of the second topic. */
  queryAt?: { x: number; y: number };
  /** How many nearest documents to return, from 1 to 5. */
  k?: number;
  /** Embedding size shown in the readout. */
  dimensions?: number;
  /** Stage names, stat names, and the short texts in the diagram. */
  labels?: VectorSearchLabels;
  /** Multiplies the pace. At 1 the whole story takes about 18 seconds. 0 holds still. */
  speed?: number;
  /** Holds the diagram still where it is. */
  paused?: boolean;
  /** Shows the step bar with play and pause. */
  controls?: boolean;
  /** Color of the query, the search path, and the matches. Defaults to the accent. */
  accent?: string;
  /** Accessible description of the diagram. Built from the query and the real matches when left out. */
  label?: string;
  /** Optional visible caption under the diagram. */
  caption?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

type Pt = { x: number; y: number };

const DEFAULT_TOPICS: VectorSearchTopic[] = [{ name: "Billing" }, { name: "Access" }, { name: "Deploys" }];
const DEFAULT_DOCUMENTS: VectorSearchDocument[] = [
  { title: "Refund a charge", topic: 0 },
  { title: "Update a card on file", topic: 0 },
  { title: "Download invoices", topic: 0 },
  { title: "Change your plan", topic: 0 },
  { title: "How proration works", topic: 0 },
  { title: "Retry a failed payment", topic: 0 },
  { title: "Rotate an API key", topic: 1 },
  { title: "Scope API tokens", topic: 1 },
  { title: "Set up SSO with Okta", topic: 1 },
  { title: "Revoke a session", topic: 1 },
  { title: "Require two-factor", topic: 1 },
  { title: "Export audit logs", topic: 1 },
  { title: "Roll back a deploy", topic: 2 },
  { title: "Preview environments", topic: 2 },
  { title: "Environment variables", topic: 2 },
  { title: "Add a custom domain", topic: 2 },
  { title: "Clear the build cache", topic: 2 },
  { title: "Deploy hooks", topic: 2 },
];
const DEFAULT_QUERY = "How do I rotate a leaked API key?";
const SERIES = ["var(--series-2)", "var(--series-3)", "var(--series-4)", "color-mix(in oklab, var(--series-2) 50%, var(--series-4))"];
/** Topic centers on the plane, in the -1 to 1 space, laid out per topic count so the clusters balance around the middle. */
const LAYOUTS: Record<number, Pt[]> = {
  2: [{ x: -0.45, y: 0.45 }, { x: 0.45, y: -0.45 }],
  3: [{ x: -0.3, y: 0.5 }, { x: 0.5, y: -0.3 }, { x: -0.5, y: -0.5 }],
  4: [{ x: -0.48, y: 0.48 }, { x: 0.48, y: -0.48 }, { x: -0.48, y: -0.48 }, { x: 0.48, y: 0.48 }],
};
const centersFor = (count: number) => LAYOUTS[count] ?? LAYOUTS[3];

/** Seconds, at speed 1. */
const DROP = 0.75;
const EDGE = 0.45;
const TYPE = 0.03;
const PIN = 0.9;
const HOP = 0.42;
const RING = 1.1;
const LINE = 0.35;
const RESET = 0.9;
const BARS = 16;
/** Plane tilt (steeper on phones, where height is cheap and points need room) and slab thickness. */
const K = 0.5;
const K_NARROW = 0.6;
const TH = 10;

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const mod = (a: number, b: number) => ((a % b) + b) % b;
const ease = (t: number) => 0.5 - Math.cos(Math.PI * clamp(t)) / 2;
const easeOut = (t: number) => 1 - (1 - clamp(t)) ** 3;
const easeIn = (t: number) => clamp(t) ** 2;
const f2 = (v: number) => v.toFixed(2);
/** The time within an eased sweep at which it reaches a fraction q of the way. */
const passAt = (q: number) => Math.acos(1 - 2 * clamp(q)) / Math.PI;
const isUrl = (value: string) => /^(\/|\.|https?:|data:|blob:)/.test(value);

function fnv(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

const subscribe = () => () => {};
function useReducedFlag() {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

/** A short vector that looks alike within a topic, so the readout echoes the clustering. */
function vectorOf(seed: string, topic: number, blend = 0.72) {
  return Array.from({ length: BARS }, (_, d) => {
    const signature = Math.sin((topic + 1) * 1.73 * (d + 1) + topic * 0.9);
    const noise = ((fnv(`${seed}:${d}`) % 1000) / 1000 - 0.5) * 2;
    return clamp(blend * signature + (1 - blend) * noise, -1, 1);
  });
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** The whole story as a pure function of time, so the loop repeats exactly and any stage can be jumped to. */
function buildTimeline(docs: VectorSearchDocument[], topicCount: number, queryText: string, queryAt: Pt | undefined, kProp: number) {
  const n = docs.length;
  /** Positions: given ones are kept, the rest spiral out from their topic center. */
  const perTopic = new Array<number>(topicCount).fill(0);
  const totals = new Array<number>(topicCount).fill(0);
  docs.forEach(d => { totals[d.topic]++; });
  const CENTERS = centersFor(topicCount);
  const spread = topicCount >= 4 ? 0.9 : 1.1;
  const pos: Pt[] = docs.map(d => {
    const j = perTopic[d.topic]++;
    if (d.x !== undefined && d.y !== undefined) return { x: clamp(d.x, -0.92, 0.92), y: clamp(d.y, -0.92, 0.92) };
    const c = CENTERS[d.topic] ?? CENTERS[0];
    const a = j * 2.39996 + d.topic * 1.1 + 0.6, r = spread * (j === 0 ? 0.08 : 0.13 + 0.21 * Math.sqrt(j / Math.max(1, totals[d.topic] - 1)));
    return { x: clamp(c.x + r * Math.cos(a), -0.9, 0.9), y: clamp(c.y + r * Math.sin(a), -0.9, 0.9) };
  });

  /** The query lands between the center of the second topic and its first document, unless told where. */
  const qTopic = topicCount > 1 ? 1 : 0;
  const firstOfTopic = docs.findIndex(d => d.topic === qTopic);
  const anchor = firstOfTopic >= 0 ? pos[firstOfTopic] : { x: 0, y: 0 };
  const hullCenter = (t: number) => {
    const members = pos.filter((_, i) => docs[i].topic === t);
    if (!members.length) return CENTERS[t] ?? { x: 0, y: 0 };
    return { x: members.reduce((s, p) => s + p.x, 0) / members.length, y: members.reduce((s, p) => s + p.y, 0) / members.length };
  };
  const qc = hullCenter(qTopic);
  const q: Pt = queryAt ? { x: clamp(queryAt.x, -0.92, 0.92), y: clamp(queryAt.y, -0.92, 0.92) } : { x: anchor.x + (qc.x - anchor.x) * 0.25 - 0.05, y: anchor.y + (qc.y - anchor.y) * 0.25 - 0.06 };
  /** A placed query is eased into the nearest gap, so the pin never sits on a match and the halos keep apart. */
  if (!queryAt) {
    const gap = 0.15;
    for (let pass = 0; pass < 6; pass++) {
      let at = -1, v = Infinity;
      pos.forEach((p, i) => { const dv = dist(p, q); if (dv < v) { v = dv; at = i; } });
      if (at < 0 || v >= gap) break;
      const dx = v < 1e-3 ? 0.7 : (q.x - pos[at].x) / v, dy = v < 1e-3 ? -0.7 : (q.y - pos[at].y) / v;
      q.x = clamp(pos[at].x + dx * gap, -0.92, 0.92); q.y = clamp(pos[at].y + dy * gap, -0.92, 0.92);
    }
  }

  /** Similarity falls off with distance on the plane, so the ranking and the scores always agree with the picture. */
  const d = pos.map(p => dist(p, q));
  const k = Math.round(clamp(kProp, 1, Math.min(5, n)));
  const ranked = d.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const nearest = ranked.slice(0, k).map(o => o.i);
  const score = d.map(v => clamp(0.99 - v * 0.6, 0.05, 0.99));

  /** The index: each point links to its two nearest points, and each pair of topics shares its shortest bridge. */
  const edgeSet = new Set<string>();
  const edges: [number, number][] = [];
  const addEdge = (a: number, b: number) => {
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (a === b || edgeSet.has(key)) return;
    edgeSet.add(key); edges.push(a < b ? [a, b] : [b, a]);
  };
  pos.forEach((p, i) => {
    pos.map((o, j) => ({ j, v: dist(p, o) })).filter(o => o.j !== i && docs[o.j].topic === docs[i].topic).sort((a, b) => a.v - b.v).slice(0, 2).forEach(o => addEdge(i, o.j));
  });
  const intra = edges.length;
  for (let a = 0; a < topicCount; a++) for (let b = a + 1; b < topicCount; b++) {
    let best: [number, number] | null = null, bv = Infinity;
    pos.forEach((p, i) => { if (docs[i].topic !== a) return; pos.forEach((o, j) => { if (docs[j].topic !== b) return; const v = dist(p, o); if (v < bv) { bv = v; best = [i, j]; } }); });
    if (best) addEdge(best[0], best[1]);
  }
  const adjacency = pos.map(() => [] as { to: number; edge: number }[]);
  edges.forEach(([a, b], e) => { adjacency[a].push({ to: b, edge: e }); adjacency[b].push({ to: a, edge: e }); });

  /** The search enters the graph at the point farthest from the query and follows the shortest route to the nearest one. */
  const entry = ranked[ranked.length - 1].i;
  const goal = nearest[0];
  const best = pos.map(() => Infinity), prev = pos.map(() => -1), prevEdge = pos.map(() => -1), done = pos.map(() => false);
  best[entry] = 0;
  for (;;) {
    let at = -1;
    best.forEach((v, i) => { if (!done[i] && v < Infinity && (at < 0 || v < best[at])) at = i; });
    if (at < 0 || at === goal) break;
    done[at] = true;
    adjacency[at].forEach(({ to, edge }) => { const v = best[at] + dist(pos[at], pos[to]); if (v < best[to]) { best[to] = v; prev[to] = at; prevEdge[to] = edge; } });
  }
  const path: number[] = [];
  for (let at = goal; at >= 0; at = prev[at]) { path.unshift(at); if (at === entry) break; }
  if (path[0] !== entry) path.splice(0, path.length, goal);
  const hops = path.length - 1;

  /** Timing. Documents drop in order along the plane, so they fall like a sweep rather than at random. */
  const order = pos.map((p, i) => ({ i, s: p.x + p.y * 0.6 })).sort((a, b) => a.s - b.s).map(o => o.i);
  const stagger = Math.min(0.17, 2.9 / n);
  const drop = new Array<number>(n);
  order.forEach((i, idx) => { drop[i] = 0.3 + idx * stagger; });
  const S1 = 0.3 + (n - 1) * stagger + DROP + 0.45;
  const hullAt = S1 + 0.1;
  const edgeOrder = edges.map((e, i) => ({ i, intra: i < intra, t: docs[e[0]].topic, v: dist(pos[e[0]], pos[e[1]]) }))
    .sort((a, b) => Number(b.intra) - Number(a.intra) || a.t - b.t || a.v - b.v).map(o => o.i);
  const edgeStagger = Math.min(0.06, 1.5 / edges.length);
  const edgeAt = new Array<number>(edges.length);
  edgeOrder.forEach((e, idx) => { edgeAt[e] = S1 + 0.35 + idx * edgeStagger; });
  const S2 = S1 + 0.35 + (edges.length - 1) * edgeStagger + EDGE + 0.6;
  const typeAt = S2 + 0.25;
  const typeEnd = typeAt + queryText.length * TYPE;
  const barsAt = typeEnd + 0.15;
  const pinAt = barsAt + 0.25;
  const pinLand = pinAt + PIN;
  const S3 = pinLand + 0.5;
  const hopAt = S3 + 0.3;
  /** Each hop takes longer over a longer link, so the signal keeps a calm, even pace. */
  const hopDur = path.slice(1).map((to, h) => clamp(HOP * 0.7 + dist(pos[path[h]], pos[to]) * 0.55, HOP * 0.8, HOP * 2.2));
  const hopStart = hopDur.map((_, h) => hopAt + hopDur.slice(0, h).reduce((sum, v) => sum + v, 0));
  const hopEnd = hopAt + hopDur.reduce((sum, v) => sum + v, 0);
  const ringAt = hopEnd + 0.15;
  const rMax = d[nearest[k - 1]] + 0.07;
  const lit = pos.map((_, i) => (nearest.includes(i) ? ringAt + RING * passAt(d[i] / rMax) : Infinity));
  const R0 = ringAt + RING + LINE + 3.2;
  const T = R0 + RESET + 0.3;
  const pathEdges = path.slice(1).map(i => prevEdge[i]);

  return {
    n, pos, q, d, k, nearest, score, edges, path, pathEdges, hops, hopDur, hopStart, entry, drop, S1, hullAt, edgeAt, S2, typeAt, typeEnd, barsAt,
    pinAt, pinLand, S3, hopAt, hopEnd, ringAt, rMax, lit, R0, T, vectors: docs.map(x => vectorOf(x.title, x.topic)),
    queryVector: vectorOf(queryText, qTopic, 0.62),
    stages: [
      { start: 0, end: S1, still: S1 - 0.3 },
      { start: S1, end: S2, still: S2 - 0.3 },
      { start: S2, end: S3, still: S3 - 0.2 },
      { start: S3, end: T, still: ringAt + RING + LINE + 1.2 },
    ],
  };
}

type Timeline = ReturnType<typeof buildTimeline>;

function buildGeometry(w: number, tl: Timeline, topicCount: number, docs: VectorSearchDocument[], topicNames: string[]) {
  const narrow = w < 560;
  const k = narrow ? K_NARROW : K;
  const A = Math.round(clamp((w - 20) / 4, 68, 140));
  const lift = Math.round(clamp(A * 0.46, 40, 64));
  const top = Math.round(clamp(A * 0.3, 26, 40));
  const cx = w / 2, cy = top + 2 * A * k;
  const h = Math.round(cy + 2 * A * k + TH + 14);
  const pt = (p: Pt): Pt => ({ x: cx + (p.x - p.y) * A, y: cy + (p.x + p.y) * A * k });
  const corners = [pt({ x: -1, y: -1 }), pt({ x: 1, y: -1 }), pt({ x: 1, y: 1 }), pt({ x: -1, y: 1 })];
  const face = `M${corners.map(c => `${f2(c.x)} ${f2(c.y)}`).join(" L")} Z`;
  const [tc, rc, bc, lc] = corners;
  const sideL = `M${f2(lc.x)} ${f2(lc.y)} L${f2(bc.x)} ${f2(bc.y)} L${f2(bc.x)} ${f2(bc.y + TH)} L${f2(lc.x)} ${f2(lc.y + TH)} Z`;
  const sideR = `M${f2(bc.x)} ${f2(bc.y)} L${f2(rc.x)} ${f2(rc.y)} L${f2(rc.x)} ${f2(rc.y + TH)} L${f2(bc.x)} ${f2(bc.y + TH)} Z`;
  let grid = "";
  for (let i = 1; i < 8; i++) {
    const s = -1 + i * 0.25;
    const a = pt({ x: s, y: -1 }), b = pt({ x: s, y: 1 }), c = pt({ x: -1, y: s }), e = pt({ x: 1, y: s });
    grid += `M${f2(a.x)} ${f2(a.y)} L${f2(b.x)} ${f2(b.y)} M${f2(c.x)} ${f2(c.y)} L${f2(e.x)} ${f2(e.y)} `;
  }
  /** A world circle of radius r is an axis aligned ellipse on the tilted plane. */
  const rx = (r: number) => r * A * Math.SQRT2;
  const points = tl.pos.map(pt);
  const q = pt(tl.q);
  const hulls = Array.from({ length: topicCount }, (_, t) => {
    const members = tl.pos.filter((_, i) => docs[i].topic === t);
    if (!members.length) return null;
    const c = { x: members.reduce((s, p) => s + p.x, 0) / members.length, y: members.reduce((s, p) => s + p.y, 0) / members.length };
    const r = Math.max(...members.map(p => dist(p, c))) + 0.09;
    const s = pt(c);
    /** Names sit above clusters at the back and below clusters at the sides, where the query and its scores never reach. */
    return { x: s.x, y: s.y, rx: rx(r), ry: rx(r) * k, below: s.y > cy - A * k * 0.5 };
  });
  /**
   * Score chips sit just outside each match. Twelve spots around the point are tried, and the one that stays clear of
   * the other points, the query pin, the drawn lines, the topic names, and the chips already placed wins; facing away
   * from the query breaks ties, so neighbouring chips part.
   */
  const dotR = narrow ? 3.4 : 4.2;
  const hw = 19, hh = 10;
  type Box = { x: number; y: number };
  const overlapCircle = (b: Box, c: Pt, r: number) => {
    const dx = Math.max(Math.abs(c.x - b.x) - hw, 0), dy = Math.max(Math.abs(c.y - b.y) - hh, 0);
    return Math.hypot(dx, dy) < r;
  };
  const overlapSegment = (b: Box, a: Pt, c: Pt, pad: number) => {
    const steps = Math.max(2, Math.ceil(Math.hypot(c.x - a.x, c.y - a.y) / 4));
    for (let s = 0; s <= steps; s++) {
      const x = a.x + ((c.x - a.x) * s) / steps, y = a.y + ((c.y - a.y) * s) / steps;
      if (Math.abs(x - b.x) < hw + pad && Math.abs(y - b.y) < hh + pad) return true;
    }
    return false;
  };
  const pathSegs = tl.path.slice(1).map((to, h) => [points[tl.path[h]], points[to]] as const);
  const linkSegs = tl.nearest.map(i => [q, points[i]] as const);
  const edgeSegs = tl.edges.map(([a, b]) => [points[a], points[b]] as const);
  const topicBoxes = Array.from({ length: topicCount }, (_, t) => {
    const members = tl.pos.filter((_, i) => docs[i].topic === t);
    if (!members.length) return null;
    const c = { x: members.reduce((s, p) => s + p.x, 0) / members.length, y: members.reduce((s, p) => s + p.y, 0) / members.length };
    const r = Math.max(...members.map(p => dist(p, c))) + 0.09;
    const s = pt(c), below = s.y > cy - A * k * 0.5, ry = rx(r) * k;
    const half = (topicNames[t]?.length ?? 6) * 3.4 + 16;
    return { x: s.x, y: below ? s.y + ry + 14 : s.y - ry - 14, half };
  });
  const placed: Box[] = [];
  const scores = tl.nearest.map(i => {
    const p = points[i];
    let ax = p.x - q.x, ay = p.y - q.y;
    const len = Math.hypot(ax, ay);
    if (len < 1) { ax = 0; ay = -1; } else { ax /= len; ay /= len; }
    let best = { x: p.x, y: p.y - dotR - 6 - hh, dx: 0, dy: -1 }, bestCost = Infinity;
    for (let c = 0; c < 36; c++) {
      const ang = ((c % 12) / 12) * Math.PI * 2, far = Math.floor(c / 12);
      const dx = Math.cos(ang), dy = Math.sin(ang);
      const reach = dotR + 5 + far * 8 + Math.abs(dx) * hw + Math.abs(dy) * hh;
      const b = { x: p.x + dx * reach, y: p.y + dy * reach };
      let cost = -1.5 * (dx * ax + dy * ay) + 0.4 * dy + far * 6;
      if (b.x - hw < 2 || b.x + hw > w - 2 || b.y - hh < 2 || b.y + hh > h - 2) cost += 60;
      if (overlapCircle(b, q, dotR + 6)) cost += 40;
      points.forEach((o, j) => { if (j !== i && overlapCircle(b, o, dotR + 1)) cost += 40; });
      /** A chip must read as its own point's: another point nearer to it makes it ambiguous. */
      const own = dist(b, p);
      points.forEach((o, j) => { if (j !== i && dist(b, o) < own) cost += tl.nearest.includes(j) ? 30 : 14; });
      placed.forEach(o => { if (Math.abs(o.x - b.x) < hw * 2 + 3 && Math.abs(o.y - b.y) < hh * 2 + 3) cost += 50; });
      topicBoxes.forEach(o => { if (o && Math.abs(o.x - b.x) < hw + o.half + 3 && Math.abs(o.y - b.y) < hh + 11 + 3) cost += 90; });
      pathSegs.forEach(([s0, s1]) => { if (overlapSegment(b, s0, s1, 2)) cost += 8; });
      linkSegs.forEach(([s0, s1]) => { if (overlapSegment(b, s0, s1, 2)) cost += 8; });
      edgeSegs.forEach(([s0, s1]) => { if (overlapSegment(b, s0, s1, 0)) cost += 1.5; });
      if (cost < bestCost) { bestCost = cost; best = { x: b.x, y: b.y, dx, dy }; }
    }
    placed.push(best);
    return best;
  });
  return {
    w, h, narrow, k, A, scores, lift, cx, cy, face, sideL, sideR, grid: grid.trim(), top: tc, points, q, hulls, rx,
    dot: narrow ? 3.4 : 4.2, dropH: Math.round(clamp(A * 0.26, 22, 36)), glyph: narrow ? 0.85 : 1,
  };
}

type Geometry = ReturnType<typeof buildGeometry>;

/** A small page with a folded corner, the document before it becomes a point. */
const GLYPH = "M-4.5 -6 H1.5 L4.5 -3 V6 H-4.5 Z";
const GLYPH_LINES = "M-2.4 -1.2 H2.4 M-2.4 1.2 H2.4 M-2.4 3.6 H0.8 M1.5 -6 V-3 H4.5";

function Mark({ source, className }: { source?: VectorSearchSource; className: string }) {
  const icon = source?.icon;
  if (typeof icon === "string") {
    // eslint-disable-next-line @next/next/no-img-element
    if (isUrl(icon)) return <img className={className} src={icon} alt="" draggable={false} />;
    return <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><path d={icon} fill={source?.color ?? "currentColor"} /></svg>;
  }
  if (icon) return <span className={className} style={source?.color ? { color: source.color } : undefined} aria-hidden="true">{icon}</span>;
  return <FileText className={className} size={14} strokeWidth={1.75} aria-hidden="true" />;
}

type Focus = { kind: "doc" | "topic"; index: number } | null;

export function VectorSearch({
  documents: documentsProp = DEFAULT_DOCUMENTS,
  topics: topicsProp = DEFAULT_TOPICS,
  query = DEFAULT_QUERY,
  queryAt,
  k: kProp = 3,
  dimensions = 1536,
  labels,
  speed = 1,
  paused = false,
  controls = true,
  accent,
  label,
  caption,
  className,
  style,
}: VectorSearchProps) {
  const reduced = useReducedFlag();
  const stageRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [focus, setFocus] = useState<Focus>(null);
  const [playing, setPlaying] = useState(true);

  const topics = useMemo(() => (topicsProp.length >= 2 ? topicsProp.slice(0, 4) : DEFAULT_TOPICS), [topicsProp]);
  const docs = useMemo(() => {
    const list = documentsProp.filter(d => d.topic >= 0 && d.topic < topics.length).slice(0, 24);
    return list.length >= 6 ? list : DEFAULT_DOCUMENTS;
  }, [documentsProp, topics.length]);
  const names = {
    embed: labels?.embed ?? "Embed",
    index: labels?.index ?? "Index",
    query: labels?.query ?? "Query",
    rank: labels?.rank ?? "Rank",
    embedded: labels?.embedded ?? "Embedded",
    links: labels?.links ?? "Links",
    hops: labels?.hops ?? "Hops",
    embedding: labels?.embedding ?? "Embedding",
    queryHeading: labels?.queryHeading ?? "Query",
    results: labels?.results ?? "Nearest documents",
    queryChip: labels?.queryChip ?? "Query",
  };

  const topicNames = useMemo(() => topics.map(t => t.name), [topics]);
  const qx = queryAt?.x, qy = queryAt?.y;
  const timeline = useMemo(
    () => buildTimeline(docs, topics.length, query, qx !== undefined && qy !== undefined ? { x: qx, y: qy } : undefined, kProp),
    [docs, topics.length, query, qx, qy, kProp],
  );
  const geometry = useMemo(() => (width > 0 ? buildGeometry(width, timeline, topics.length, docs, topicNames) : null), [width, timeline, topics.length, docs, topicNames]);

  const topicName = (t: number) => topics[t]?.name ?? "";
  const top = docs[timeline.nearest[0]];
  const status = [
    "Each document becomes a vector, a point placed by meaning",
    "Close points share a topic, and the index links them",
    "The query is embedded into the same space",
    `The ${timeline.k} closest points are the best matches`,
  ];

  const els = useRef({
    root: null as HTMLElement | null,
    segs: [] as (HTMLButtonElement | null)[],
    glyphs: [] as (SVGGElement | null)[],
    dots: [] as (SVGGElement | null)[],
    shadows: [] as (SVGEllipseElement | null)[],
    ripples: [] as (SVGEllipseElement | null)[],
    hulls: [] as (SVGEllipseElement | null)[],
    topicChips: [] as (HTMLDivElement | null)[],
    edges: [] as (SVGLineElement | null)[],
    edgeBox: null as SVGGElement | null,
    pathLines: [] as (SVGLineElement | null)[],
    signal: null as SVGCircleElement | null,
    entry: null as SVGEllipseElement | null,
    pin: null as SVGGElement | null,
    stem: null as SVGLineElement | null,
    pinShadow: null as SVGEllipseElement | null,
    pinRipple: null as SVGEllipseElement | null,
    queryChip: null as HTMLDivElement | null,
    ring: null as SVGEllipseElement | null,
    links: [] as (SVGLineElement | null)[],
    scores: [] as (HTMLDivElement | null)[],
    hits: [] as (HTMLDivElement | null)[],
    status: null as HTMLSpanElement | null,
    statEmbedded: null as HTMLSpanElement | null,
    statLinks: null as HTMLSpanElement | null,
    statHops: null as HTMLSpanElement | null,
    readout: null as HTMLDivElement | null,
    readoutKind: null as HTMLSpanElement | null,
    readoutText: null as HTMLSpanElement | null,
    caret: null as HTMLSpanElement | null,
    bars: [] as (HTMLSpanElement | null)[],
    rows: [] as (HTMLDivElement | null)[],
  });

  const sim = useRef({ t: NaN, rate: NaN, rateV: 0, frame: 0, running: false, visible: true, still: false, cache: new Map<Element, Record<string, string>>(), text: new Map<Element, string>() });
  const target = paused || !playing ? 0 : speed * (focus !== null ? 0.65 : 1);
  const live = useRef({ geometry, timeline, target, reduced, names, status, docs, query });
  useLayoutEffect(() => { live.current = { geometry, timeline, target, reduced, names, status, docs, query }; });

  /** Writes an attribute, style property, or custom property only when it changed, so resting elements cost nothing. */
  const put = useCallback((node: Element | null | undefined, key: string, value: string) => {
    if (!node) return;
    const cache = sim.current.cache;
    let entry = cache.get(node);
    if (!entry) { entry = {}; cache.set(node, entry); }
    if (entry[key] === value) return;
    entry[key] = value;
    if (key.startsWith("--")) (node as HTMLElement).style.setProperty(key, value);
    else if (key.startsWith("style:")) (node as HTMLElement).style.setProperty(key.slice(6), value);
    else node.setAttribute(key, value);
  }, []);

  const text = useCallback((node: Element | null | undefined, value: string) => {
    if (!node || sim.current.text.get(node) === value) return;
    sim.current.text.set(node, value);
    node.textContent = value;
  }, []);

  const paint = useCallback((time: number) => {
    const { geometry: g, timeline: tl, names: nm, status: lines, docs: list, query: qText } = live.current;
    const e = els.current;
    const u = mod(time, tl.T);
    const rs = ease((u - tl.R0) / RESET);
    const fade = 1 - rs;
    /** Draws a line to a fraction of its length. A zero length dash with a round cap still paints a dot, so an undrawn line is hidden. */
    const dash = (node: Element | null | undefined, p: number) => {
      put(node, "stroke-dasharray", `${p.toFixed(4)} 1`);
      put(node, "visibility", p > 0 ? "visible" : "hidden");
    };

    /** Step bar: the current stage fills as it plays, earlier stages stay full. */
    let current = 0;
    tl.stages.forEach((st, i) => {
      if (u >= st.start && u < st.end) current = i;
      put(e.segs[i], "--p", (u >= st.end ? 1 : u < st.start ? 0 : (u - st.start) / (st.end - st.start)).toFixed(4));
    });
    tl.stages.forEach((_, i) => {
      put(e.segs[i], "data-current", i === current ? "true" : "false");
      put(e.segs[i], "aria-current", i === current ? "step" : "false");
    });
    text(e.status, lines[current]);
    put(e.root, "data-stage", String(current));

    /** Legend stats. */
    let placed = 0, latest = -1, latestAt = -Infinity;
    for (let i = 0; i < tl.n; i++) {
      if (u >= tl.drop[i] + DROP * 0.85) placed++;
      if (u >= tl.drop[i] + DROP * 0.55 && tl.drop[i] > latestAt) { latestAt = tl.drop[i]; latest = i; }
    }
    let linked = 0;
    tl.edgeAt.forEach(at => { if (u >= at + EDGE * 0.6) linked++; });
    let hopped = 0;
    tl.hopStart.forEach((at, h) => { if (u >= at + tl.hopDur[h] * 0.5) hopped++; });
    const counting = u < tl.R0 + RESET * 0.5;
    text(e.statEmbedded, `${counting ? placed : 0}/${tl.n}`);
    text(e.statLinks, String(counting ? linked : 0));
    text(e.statHops, String(counting && u >= tl.hopAt ? hopped : 0));

    /** Vector readout: the latest document while embedding, then the query as it is typed and embedded. */
    const typing = u >= tl.typeAt && u < tl.R0 + RESET * 0.5;
    if (typing) {
      const chars = clamp(Math.floor((u - tl.typeAt) / TYPE), 0, qText.length);
      text(e.readoutKind, nm.queryHeading);
      text(e.readoutText, qText.slice(0, chars));
      put(e.caret, "data-on", chars < qText.length ? "true" : "false");
      put(e.readout, "data-kind", "query");
      put(e.readout, "--c", "var(--vs-accent)");
      tl.queryVector.forEach((v, b) => put(e.bars[b], "--v", (u >= tl.barsAt + b * 0.02 ? v : 0).toFixed(3)));
    } else {
      const showing = u < tl.R0 ? latest : -1;
      text(e.readoutKind, nm.embedding);
      text(e.readoutText, showing >= 0 ? list[showing].title : "");
      put(e.caret, "data-on", "false");
      put(e.readout, "data-kind", "doc");
      put(e.readout, "--c", showing >= 0 ? `var(--vs-t${list[showing].topic})` : "var(--text-muted)");
      const vec = showing >= 0 ? tl.vectors[showing] : null;
      for (let b = 0; b < BARS; b++) put(e.bars[b], "--v", (vec ? vec[b] * (u < tl.S1 ? 1 : 0.9) : 0).toFixed(3));
    }

    /** Ranked results fill in as the ring reaches each match. */
    tl.nearest.forEach((i, r) => {
      const on = u >= tl.lit[i] && counting;
      put(e.rows[r], "data-on", on ? "true" : "false");
    });

    if (!g) return;

    /** Documents drop onto the plane and fold into points. */
    for (let i = 0; i < tl.n; i++) {
      const p = g.points[i];
      const l = (u - tl.drop[i]) / DROP;
      const fall = easeIn(clamp(l / 0.8));
      const glyphOp = clamp(l * 5) * (1 - clamp((l - 0.72) / 0.22));
      const glyphScale = g.glyph * (1 - 0.5 * clamp((l - 0.7) / 0.3));
      put(e.glyphs[i], "transform", `translate(${f2(p.x)} ${f2(p.y - 7 - g.dropH * (1 - fall))}) scale(${glyphScale.toFixed(3)})`);
      put(e.glyphs[i], "opacity", (l > 0 && l < 1 ? glyphOp : 0).toFixed(3));
      const grow = easeOut((l - 0.74) / 0.26);
      const lift = 5 * rs;
      put(e.dots[i], "transform", `translate(${f2(p.x)} ${f2(p.y - lift)}) scale(${(0.2 + 0.8 * grow).toFixed(3)})`);
      put(e.dots[i], "opacity", (l > 0.74 ? clamp(grow * 2) * fade : 0).toFixed(3));
      put(e.shadows[i], "opacity", (clamp(l) * fade).toFixed(3));
      const rip = (u - tl.drop[i] - DROP) / 0.55;
      if (rip >= 0 && rip < 1) {
        const qq = easeOut(rip);
        put(e.ripples[i], "rx", f2(g.dot + 10 * qq)); put(e.ripples[i], "ry", f2((g.dot + 10 * qq) * g.k));
        put(e.ripples[i], "opacity", ((1 - qq) * 0.7).toFixed(3));
      } else put(e.ripples[i], "opacity", "0");
      put(e.hits[i], "data-present", l > 0.9 && fade > 0.5 ? "true" : "false");
      const matched = u >= tl.lit[i];
      put(e.dots[i], "data-lit", matched && counting ? "true" : "false");
      const onPath = u >= tl.hopAt && tl.path.some((pi, idx) => pi === i && u >= (idx === 0 ? tl.hopAt : tl.hopStart[idx - 1] + tl.hopDur[idx - 1]) - 0.02);
      put(e.dots[i], "data-visited", onPath && counting ? "true" : "false");
    }

    /** Clusters fade up around each topic once every point has landed. */
    g.hulls.forEach((hull, t) => {
      if (!hull) return;
      const h = easeOut((u - tl.hullAt - t * 0.12) / 0.8);
      const op = (u >= tl.hullAt ? h : 0) * fade;
      put(e.hulls[t], "transform", `translate(${f2(hull.x)} ${f2(hull.y)}) scale(${(0.86 + 0.14 * h).toFixed(3)})`);
      put(e.hulls[t], "opacity", op.toFixed(3));
      put(e.topicChips[t], "style:opacity", op.toFixed(3));
      put(e.topicChips[t], "style:transform", hull.below ? `translate3d(-50%, ${f2(-4 * (1 - h))}px, 0)` : `translate3d(-50%, calc(-100% + ${f2(4 * (1 - h))}px), 0)`);
      put(e.topicChips[t], "data-present", op > 0.3 ? "true" : "false");
    });

    /** Graph links draw out from each point to its neighbours. */
    tl.edges.forEach((_, j) => {
      const p = easeOut((u - tl.edgeAt[j]) / EDGE);
      dash(e.edges[j], u >= tl.edgeAt[j] ? p : 0);
    });
    put(e.edgeBox, "opacity", fade.toFixed(3));

    /** The search signal hops along the graph from the entry point toward the query. */
    const entry = g.points[tl.entry];
    const entryOp = u >= tl.hopAt - 0.25 ? clamp((u - tl.hopAt + 0.25) / 0.25) * fade : 0;
    put(e.entry, "opacity", entryOp.toFixed(3));
    put(e.entry, "transform", `translate(${f2(entry.x)} ${f2(entry.y)})`);
    tl.pathEdges.forEach((_, h) => {
      const p = ease((u - tl.hopStart[h]) / tl.hopDur[h]);
      dash(e.pathLines[h], u >= tl.hopStart[h] ? p : 0);
      put(e.pathLines[h], "opacity", fade.toFixed(3));
    });
    if (u >= tl.hopAt - 0.25 && u < tl.ringAt + 0.35 && tl.hops > 0) {
      let h = 0;
      while (h < tl.hops - 1 && u >= tl.hopStart[h + 1]) h++;
      const p = u < tl.hopAt ? 0 : ease((u - tl.hopStart[h]) / tl.hopDur[h]);
      const a = g.points[tl.path[h]], b = g.points[tl.path[h + 1]];
      const hopLift = 6 * Math.sin(Math.PI * p);
      const out = clamp((u - tl.hopEnd) / 0.3);
      put(e.signal, "transform", `translate(${f2(a.x + (b.x - a.x) * p)} ${f2(a.y + (b.y - a.y) * p - hopLift)}) scale(${(1 - 0.5 * out).toFixed(3)})`);
      put(e.signal, "opacity", (clamp((u - tl.hopAt + 0.25) / 0.25) * (1 - out)).toFixed(3));
    } else put(e.signal, "opacity", "0");

    /** The query is lowered onto the plane on a thin stem. */
    const pinIn = clamp((u - tl.pinAt + 0.3) / 0.3);
    const down = ease((u - tl.pinAt) / PIN);
    const pinLift = g.lift * (1 - down);
    const pinOp = (u >= tl.pinAt - 0.3 ? pinIn : 0) * fade;
    put(e.pin, "transform", `translate(${f2(g.q.x)} ${f2(g.q.y - pinLift - 5 * rs)})`);
    put(e.pin, "opacity", pinOp.toFixed(3));
    put(e.stem, "y1", f2(g.q.y - pinLift));
    put(e.stem, "opacity", (pinOp * (pinLift > 1 ? 1 : 0)).toFixed(3));
    put(e.pinShadow, "opacity", (pinOp * (0.35 + 0.65 * down)).toFixed(3));
    put(e.pinShadow, "rx", f2(4 + 3 * down)); put(e.pinShadow, "ry", f2((4 + 3 * down) * g.k));
    put(e.queryChip, "style:opacity", (pinOp * (1 - clamp((u - tl.pinLand - 0.2) / 0.35))).toFixed(3));
    put(e.queryChip, "style:transform", `translate3d(-50%, ${f2(-pinLift - 14 - 5 * rs)}px, 0) translateY(-100%)`);
    const qr = (u - tl.pinLand) / 0.6;
    if (qr >= 0 && qr < 1) {
      const qq = easeOut(qr);
      put(e.pinRipple, "rx", f2(6 + 16 * qq)); put(e.pinRipple, "ry", f2((6 + 16 * qq) * g.k));
      put(e.pinRipple, "opacity", ((1 - qq) * 0.8).toFixed(3));
    } else put(e.pinRipple, "opacity", "0");

    /** A ring widens from the query; each match it reaches lights up, links to the query, and shows its score. */
    const ringP = ease((u - tl.ringAt) / RING);
    const ringR = g.rx(tl.rMax * ringP);
    const ringOp = u >= tl.ringAt ? clamp((u - tl.ringAt) / 0.15) * (1 - 0.45 * clamp((u - tl.ringAt - RING) / 0.4)) * fade : 0;
    put(e.ring, "rx", f2(Math.max(0.5, ringR))); put(e.ring, "ry", f2(Math.max(0.5, ringR * g.k)));
    put(e.ring, "opacity", ringOp.toFixed(3));
    tl.nearest.forEach((i, r) => {
      const p = easeOut((u - tl.lit[i]) / LINE);
      const on = u >= tl.lit[i];
      dash(e.links[r], on ? p : 0);
      put(e.links[r], "opacity", fade.toFixed(3));
      put(e.scores[r], "style:opacity", ((on ? p : 0) * fade).toFixed(3));
      const sc = g.scores[r];
      put(e.scores[r], "style:transform", `translate3d(calc(-50% + ${f2(-4 * sc.dx * (1 - p))}px), calc(-50% + ${f2(-4 * sc.dy * (1 - p))}px), 0)`);
    });
  }, [put, text]);

  const loop = useCallback(() => {
    const s = sim.current;
    if (s.running || !s.visible || live.current.reduced) return;
    s.running = true;
    let last = performance.now();
    const tick = (now: number) => {
      if (!s.visible || live.current.reduced) { s.running = false; return; }
      const dt = clamp((now - last) / 1000, 0, 0.05);
      last = now;
      const goal = live.current.target;
      if (Number.isNaN(s.rate)) s.rate = goal;
      /** Speed changes, hover, and pausing ease on a critically damped spring, so the story never jolts. */
      s.rateV += (40 * (goal - s.rate) - 2 * Math.sqrt(40) * s.rateV) * dt;
      s.rate += s.rateV * dt;
      if (Math.abs(goal - s.rate) < 1e-4 && Math.abs(s.rateV) < 1e-4) { s.rate = goal; s.rateV = 0; }
      s.t += dt * s.rate;
      paint(s.t);
      if ((s.rate === 0 && goal === 0) || !s.visible || live.current.reduced) { s.running = false; return; }
      s.frame = requestAnimationFrame(tick);
    };
    s.frame = requestAnimationFrame(tick);
  }, [paint]);

  useLayoutEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const measure = () => setWidth(Math.floor(node.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  /** Repaint whenever layout changes, then run or rest the loop. The caches are cleared because new elements mounted. */
  useLayoutEffect(() => {
    const s = sim.current;
    if (Number.isNaN(s.t)) s.t = 0;
    /** Reduced motion rests on the answer: every point placed, the path walked, and the matches scored. */
    if (reduced && !s.still) s.t = Math.floor(s.t / timeline.T) * timeline.T + timeline.stages[3].still;
    s.still = reduced;
    s.cache = new Map();
    s.text = new Map();
    paint(s.t);
    if (!reduced) loop();
  }, [geometry, timeline, reduced, target, focus, paint, loop]);

  useEffect(() => {
    const node = stageRef.current, s = sim.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => {
      s.visible = entry.isIntersecting && !document.hidden;
      if (s.visible) loop(); else { cancelAnimationFrame(s.frame); s.running = false; }
    });
    const onVisibility = () => {
      s.visible = !document.hidden;
      if (s.visible) loop(); else { cancelAnimationFrame(s.frame); s.running = false; }
    };
    observer.observe(node);
    document.addEventListener("visibilitychange", onVisibility);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", onVisibility); cancelAnimationFrame(s.frame); s.running = false; };
  }, [loop]);

  /** Jumps to a stage. While playing it replays from the stage start; held still it shows the stage's key moment. */
  const jump = (i: number) => {
    const st = timeline.stages[i];
    if (!st) return;
    const s = sim.current;
    const still = reduced || paused || !playing;
    const base = Math.floor(Math.max(0, s.t) / timeline.T) * timeline.T;
    s.t = base + (still ? st.still : st.start + 0.001);
    paint(s.t);
    if (!still) loop();
  };

  const hover = (next: NonNullable<Focus>) => ({
    onPointerEnter: (event: ReactPointerEvent) => { if (event.pointerType === "mouse") setFocus(next); },
    onPointerLeave: () => setFocus(current => (current && current.kind === next.kind && current.index === next.index ? null : current)),
  });

  const stageNames = [names.embed, names.index, names.query, names.rank];
  const stageAria = ["Embed the documents", "Build the index", "Embed the query", "Rank the nearest documents"];
  const matches = timeline.nearest.map(i => `${docs[i].title} (${timeline.score[i].toFixed(2)})`).join(", ");
  const topicList = topics.map(t => t.name).join(", ");
  const aria = label ?? `Vector search. ${docs.length} documents are embedded as points on a plane, where similar documents land close together in ${topics.length} clusters: ${topicList}. The index links each point to its nearest neighbours. The query "${query}" is embedded into the same space and lands near ${topicName(top?.topic ?? 0)}. The search hops ${timeline.hops} times along the links to reach it, and the ${timeline.k} nearest documents are returned with their similarity: ${matches}.`;

  const g: Geometry | null = geometry;
  const colorVars: Record<string, string> = { "--vs-accent": accent ?? "var(--accent)" };
  topics.forEach((t, i) => { colorVars[`--vs-t${i}`] = t.color ?? SERIES[i]; });
  const rootStyle = { ...style, ...colorVars } as CSSProperties;
  const focusTopic = focus ? (focus.kind === "topic" ? focus.index : docs[focus.index]?.topic ?? -1) : -1;
  const focusDoc = focus?.kind === "doc" ? focus.index : -1;
  const dimDoc = (i: number) => focusTopic >= 0 && docs[i].topic !== focusTopic && i !== focusDoc;
  /** Points are painted back to front so nearer ones overlap farther ones. */
  const depthOrder = g ? g.points.map((p, i) => ({ i, y: p.y })).sort((a, b) => a.y - b.y).map(o => o.i) : [];
  const focused = focusDoc >= 0 && g ? { p: g.points[focusDoc], doc: docs[focusDoc] } : null;

  return <figure
    ref={el => { els.current.root = el; }}
    className={[styles.root, className].filter(Boolean).join(" ")}
    style={rootStyle}
    data-ready={g ? true : undefined}
    data-focus={focus ? true : undefined}
  >
    {controls && <div className={styles.controls} role="group" aria-label="Search stages">
      {!reduced && <button type="button" className={styles.play} aria-label={playing ? "Pause animation" : "Play animation"} onClick={() => setPlaying(p => !p)}>
        {playing ? <Pause size={14} strokeWidth={1.75} aria-hidden="true" /> : <Play size={14} strokeWidth={1.75} aria-hidden="true" />}
      </button>}
      <div className={styles.segments}>
        {stageNames.map((name, i) => <button
          key={`${name}-${i}`}
          ref={el => { els.current.segs[i] = el; }}
          type="button"
          className={styles.segment}
          aria-label={stageAria[i]}
          aria-current={i === 0 ? "step" : "false"}
          data-current={i === 0 ? "true" : "false"}
          onClick={() => jump(i)}
        >
          <span className={styles.segmentLabel}>{name}</span>
          <span className={styles.track}><span className={styles.fill} /></span>
        </button>)}
      </div>
    </div>}

    <div className={styles.body} role="img" aria-label={aria}>
      <div ref={stageRef} className={styles.stage} style={g ? { height: g.h } : undefined}>
        {g && <>
          <svg className={styles.layer} viewBox={`0 0 ${g.w} ${g.h}`} width={g.w} height={g.h} aria-hidden="true">
            <path className={styles.sideL} d={g.sideL} />
            <path className={styles.sideR} d={g.sideR} />
            <path className={styles.face} d={g.face} />
            <path className={styles.grid} d={g.grid} />

            {g.hulls.map((hull, t) => hull && <ellipse key={`hull-${t}`} ref={el => { els.current.hulls[t] = el; }} className={styles.hull} data-dim={focusTopic >= 0 && focusTopic !== t ? true : undefined} style={{ "--c": `var(--vs-t${t})` } as CSSProperties} cx={0} cy={0} rx={hull.rx} ry={hull.ry} opacity={0} />)}

            <g ref={el => { els.current.edgeBox = el; }}>
              {timeline.edges.map(([a, b], j) => {
                const on = focusDoc >= 0 && (a === focusDoc || b === focusDoc);
                return <line key={`e-${a}-${b}`} ref={el => { els.current.edges[j] = el; }} className={styles.edge} data-on={on || undefined} data-dim={(focus && !on && (focusDoc >= 0 || docs[a].topic !== focusTopic)) || undefined} x1={g.points[a].x} y1={g.points[a].y} x2={g.points[b].x} y2={g.points[b].y} pathLength={1} strokeDasharray="0 1" visibility="hidden" />;
              })}
            </g>
            {timeline.pathEdges.map((_, h) => {
              const a = g.points[timeline.path[h]], b = g.points[timeline.path[h + 1]];
              return <line key={`p-${h}`} ref={el => { els.current.pathLines[h] = el; }} className={styles.pathLine} x1={a.x} y1={a.y} x2={b.x} y2={b.y} pathLength={1} strokeDasharray="0 1" visibility="hidden" />;
            })}

            <ellipse ref={el => { els.current.ring = el; }} className={styles.ring} cx={g.q.x} cy={g.q.y} rx={1} ry={0.5} opacity={0} />
            {timeline.nearest.map((i, r) => <line key={`l-${i}`} ref={el => { els.current.links[r] = el; }} className={styles.link} data-on={focusDoc === i || undefined} x1={g.q.x} y1={g.q.y} x2={g.points[i].x} y2={g.points[i].y} pathLength={1} strokeDasharray="0 1" visibility="hidden" />)}

            {g.points.map((p, i) => <ellipse key={`s-${i}`} ref={el => { els.current.shadows[i] = el; }} className={styles.shadow} cx={p.x} cy={p.y + 1.5} rx={g.dot + 1.5} ry={(g.dot + 1.5) * g.k} opacity={0} />)}
            {g.points.map((p, i) => <ellipse key={`r-${i}`} ref={el => { els.current.ripples[i] = el; }} className={styles.ripple} style={{ "--c": `var(--vs-t${docs[i].topic})` } as CSSProperties} cx={p.x} cy={p.y} rx={g.dot} ry={g.dot * g.k} opacity={0} />)}
            <ellipse ref={el => { els.current.entry = el; }} className={styles.entry} cx={0} cy={0} rx={g.dot + 5} ry={(g.dot + 5) * g.k} opacity={0} />

            {depthOrder.map(i => <g key={`d-${i}`} ref={el => { els.current.dots[i] = el; }} className={styles.dot} data-dim={dimDoc(i) || undefined} data-on={focusDoc === i || undefined} style={{ "--c": `var(--vs-t${docs[i].topic})` } as CSSProperties} opacity={0}>
              <circle className={styles.halo} r={g.dot + 4} />
              <circle className={styles.dotFill} r={g.dot} />
            </g>)}
            {depthOrder.map(i => <g key={`g-${i}`} ref={el => { els.current.glyphs[i] = el; }} className={styles.glyph} style={{ "--c": `var(--vs-t${docs[i].topic})` } as CSSProperties} opacity={0}>
              <path className={styles.glyphPage} d={GLYPH} />
              <path className={styles.glyphLines} d={GLYPH_LINES} />
            </g>)}

            <circle ref={el => { els.current.signal = el; }} className={styles.signal} r={3.5} opacity={0} />

            <ellipse ref={el => { els.current.pinShadow = el; }} className={styles.pinShadow} cx={g.q.x} cy={g.q.y + 1} rx={4} ry={2} opacity={0} />
            <ellipse ref={el => { els.current.pinRipple = el; }} className={styles.pinRipple} cx={g.q.x} cy={g.q.y} rx={6} ry={3} opacity={0} />
            <line ref={el => { els.current.stem = el; }} className={styles.stem} x1={g.q.x} y1={g.q.y} x2={g.q.x} y2={g.q.y} opacity={0} />
            <g ref={el => { els.current.pin = el; }} className={styles.pin} opacity={0}>
              <circle className={styles.pinRing} r={g.dot + 3.5} />
              <circle className={styles.pinDot} r={g.dot + 0.8} />
            </g>
          </svg>

          {g.hulls.map((hull, t) => hull && <div
            key={`tc-${t}`}
            ref={el => { els.current.topicChips[t] = el; }}
            className={styles.topicChip}
            data-on={focusTopic === t ? true : undefined}
            data-dim={focusTopic >= 0 && focusTopic !== t ? true : undefined}
            style={{ left: hull.x, top: hull.below ? hull.y + hull.ry + 3 : hull.y - hull.ry - 3, "--c": `var(--vs-t${t})`, opacity: 0 } as CSSProperties}
            {...hover({ kind: "topic", index: t })}
          >
            <span className={styles.swatch} />
            <span>{topics[t].name}</span>
          </div>)}

          {timeline.nearest.map((i, r) => <div
            key={`sc-${i}`}
            ref={el => { els.current.scores[r] = el; }}
            className={styles.score}
            data-on={focusDoc === i || undefined}
            style={{ left: g.scores[r].x, top: g.scores[r].y, opacity: 0 }}
          >
            {timeline.score[i].toFixed(2)}
          </div>)}

          <div ref={el => { els.current.queryChip = el; }} className={styles.queryChip} style={{ left: g.q.x, top: g.q.y, opacity: 0 }}>{names.queryChip}</div>

          {g.points.map((p, i) => <div
            key={`hit-${i}`}
            ref={el => { els.current.hits[i] = el; }}
            className={styles.hit}
            data-present="false"
            style={{ left: p.x - 11, top: p.y - 11 }}
            {...hover({ kind: "doc", index: i })}
          />)}

          {focused && <div key={`tag-${focusDoc}`} className={styles.tag} style={{ left: focused.p.x, top: focused.p.y - 12 }} aria-hidden="true">
            <span className={styles.tagTitle}>{focused.doc.title}</span>
            <span className={styles.tagMeta}>{topicName(focused.doc.topic)}{focused.doc.source ? `, ${focused.doc.source.name}` : ""}</span>
          </div>}
        </>}
      </div>

      <div className={styles.panel}>
        <span ref={el => { els.current.status = el; }} className={styles.status}>{status[0]}</span>

        <div className={styles.stats}>
          <div className={styles.stat}><span className={styles.statLabel}>{names.embedded}</span><span ref={el => { els.current.statEmbedded = el; }} className={styles.statValue}>0/{docs.length}</span></div>
          <div className={styles.stat}><span className={styles.statLabel}>{names.links}</span><span ref={el => { els.current.statLinks = el; }} className={styles.statValue}>0</span></div>
          <div className={styles.stat}><span className={styles.statLabel}>{names.hops}</span><span ref={el => { els.current.statHops = el; }} className={styles.statValue}>0</span></div>
        </div>

        <div ref={el => { els.current.readout = el; }} className={styles.readout} data-kind="doc">
          <span className={styles.readoutHead}>
            <span ref={el => { els.current.readoutKind = el; }} className={styles.readoutKind}>{names.embedding}</span>
            <span className={styles.readoutDims}>{dimensions.toLocaleString("en-US")} dims</span>
          </span>
          <span className={styles.readoutLine}>
            <span ref={el => { els.current.readoutText = el; }} className={styles.readoutText} />
            <span ref={el => { els.current.caret = el; }} className={styles.caret} data-on="false" />
          </span>
          <span className={styles.bars}>
            {Array.from({ length: BARS }, (_, b) => <span key={b} ref={el => { els.current.bars[b] = el; }} className={styles.bar} />)}
          </span>
        </div>

        <div className={styles.results}>
          <span className={styles.resultsHead}>{names.results}</span>
          {timeline.nearest.map((i, r) => {
            const doc = docs[i];
            return <div
              key={`row-${i}`}
              ref={el => { els.current.rows[r] = el; }}
              className={styles.row}
              data-on="false"
              data-focus={focusDoc === i || undefined}
              style={{ "--c": `var(--vs-t${doc.topic})`, "--s": timeline.score[i].toFixed(3) } as CSSProperties}
              {...hover({ kind: "doc", index: i })}
            >
              <span className={styles.rowHead}>
                <span className={styles.rank}>{r + 1}</span>
                <Mark source={doc.source} className={styles.mark} />
                <span className={styles.rowTitle}>{doc.title}</span>
                <span className={styles.rowScore}>{timeline.score[i].toFixed(2)}</span>
              </span>
              <span className={styles.rowBar}><span className={styles.rowFill} /></span>
            </div>;
          })}
        </div>
      </div>
    </div>
    {caption && <figcaption className={styles.figcaption}>{caption}</figcaption>}
  </figure>;
}

export default VectorSearch;
