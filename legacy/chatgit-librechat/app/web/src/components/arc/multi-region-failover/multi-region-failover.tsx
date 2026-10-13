"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import { Pause, Play } from "lucide-react";
import styles from "./multi-region-failover.module.css";

export type MultiRegionFailoverNodeKey = "users" | "balancer" | "primary" | "secondary";

export interface MultiRegionFailoverNode {
  /** Short name under the node, such as Load balancer or US East. */
  label?: string;
  /** Secondary text under the name, such as the hostname or a region code like us-east-1. */
  meta?: string;
  /** One line shown in a small tag while the node is hovered. */
  detail?: string;
  /**
   * A mark beside the name. A string is either SVG path data on a 24 by 24 viewBox (the Simple Icons format), painted in color,
   * or an image URL for a full color logo. Any ReactNode works too and inherits the muted text color.
   */
  icon?: string | ReactNode;
  /** Brand color for a path mark. Leave it out for black and white brands so the mark follows the text color. */
  color?: string;
}

/**
 * An animated multi-region failover on a layered 2.5D stage. Users send a steady stream of requests to a global load
 * balancer that splits them between two regions. The instances in the primary region start failing, requests there return
 * errors and three health checks fail in a row, so the balancer marks the region unhealthy and shifts its weight smoothly to
 * the healthy region. The primary recovers, passes three checks and traffic ramps back until the split is even again.
 */
export interface MultiRegionFailoverProps {
  /** The hostname the balancer answers for, shown under it. */
  hostname?: string;
  /** Total requests per second from users, split between the regions. */
  requestsPerSecond?: number;
  /** Median latency of the primary region in milliseconds while the split is even. The secondary runs a little slower and climbs under full load. */
  latencyMs?: number;
  /** Overrides for each node: name, meta line, hover detail and an optional mark. */
  nodes?: Partial<Record<MultiRegionFailoverNodeKey, MultiRegionFailoverNode>>;
  /** Multiplies the pace. At 1 one full outage and recovery takes 21 seconds. 0 holds still. */
  speed?: number;
  /** Holds the animation. Paused from the start, it shows the moment traffic shifts away from the unhealthy region. */
  paused?: boolean;
  /** Any CSS color for the requests, the lit routes, the weight dial and the scrubber. Defaults to the theme accent. */
  accent?: string;
  /** Shows the step scrubber with a pause button, so viewers can replay or jump between stages. */
  controls?: boolean;
  /** Shows one line under the scrubber that narrates the current stage. */
  caption?: boolean;
  /** Accessible description. Defaults to a sentence built from the region names and the hostname. */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

type Pt = { x: number; y: number };
type RegionKey = "primary" | "secondary";
type Arc = {
  d: string; floorD: string; len: number; lift: number;
  xs: Float32Array; ys: Float32Array; fx: Float32Array; fy: Float32Array; acc: Float32Array;
};
type SlabGeo = { cx: number; cy: number; a: number; h: number; port: Pt; floor: number };
type Cube = { i: number; x: number; y: number; a: number; h: number };
type Layout = {
  w: number; h: number; wide: boolean;
  nodes: Record<MultiRegionFailoverNodeKey, SlabGeo>;
  cubes: Record<RegionKey, Cube[]>;
  trunk: Arc;
  route: Record<RegionKey, Arc>;
  /** One arc per instance, so each request lands on the exact instance that serves it. */
  lanes: Record<RegionKey, Arc[]>;
  /** Where each node's label sits, in drawing units, and whether it hangs above that point. */
  labels: Record<MultiRegionFailoverNodeKey, { x: number; y: number; above: boolean }>;
};

const NODE_KEYS: MultiRegionFailoverNodeKey[] = ["users", "balancer", "primary", "secondary"];
const REGIONS: RegionKey[] = ["primary", "secondary"];
/** The balancer's control tier sits this far above its base, and requests pass through its top face. */
const TIER = 12;
const TIER_A = 0.6;
/** Below this root width the stage switches to the portrait layout. */
const WIDE = 640;
const SAMPLES = 48;
/** Instance slots on a region platform as (u, v) on its top face, two rows of three. */
const SLOTS: [number, number][] = [[0.2, 0.3], [0.5, 0.3], [0.8, 0.3], [0.2, 0.72], [0.5, 0.72], [0.8, 0.72]];
const INSTANCES = SLOTS.length;

/** Timeline in seconds at speed 1. Every frame is a pure function of this clock, and the last frame equals the first. */
const T = {
  degrade: 3.7, recover: 11.4, stagger: 0.12,
  probe0: 3.9, probeEvery: 1.3, probeCount: 9, probeTrip: 0.6,
  shift: 7.8, shiftEnd: 9.5, ramp: 15.7, rampEnd: 18.5,
  cycle: 21,
};
/** Probes 0 to 5 find the region down; 6 to 8 find it back. Three results in a row flip its health. */
const FIRST_PASS = 6;
const THRESHOLD = 3;
const probeAt = (k: number) => T.probe0 + k * T.probeEvery;
const probeBack = (k: number) => probeAt(k) + T.probeTrip * 2;
const UNHEALTHY = probeBack(THRESHOLD - 1);
const HEALTHY = probeBack(FIRST_PASS + THRESHOLD - 1);
const ALL_UP = T.recover + T.stagger * (INSTANCES - 1);

/** A request leaves the users every INTERVAL seconds; the cycle holds a whole number of them, so the stream loops cleanly. */
const INTERVAL = 0.25;
const PER_CYCLE = Math.round(T.cycle / INTERVAL);
const TRUNK = 1;
const BRANCH = 1.1;
/** Divides PER_CYCLE, so every request keeps its element across the loop seam. */
const POOL = 12;

/** The six stages the scrubber jumps between. rep is a settled moment used for the still frame of each stage. */
const STAGES = [
  { start: 0, rep: 2.4, short: "Balanced", title: "Balanced" },
  { start: 3.6, rep: 7, short: "Degrade", title: "Region degrades" },
  { start: UNHEALTHY, rep: 8.6, short: "Fail over", title: "Fail over" },
  { start: T.shiftEnd + 0.1, rep: 10.8, short: "One region", title: "One region serves" },
  { start: T.recover - 0.1, rep: 14.5, short: "Recover", title: "Recovery" },
  { start: HEALTHY, rep: 17.2, short: "Rebalance", title: "Rebalance" },
];
const STILL = STAGES[2].rep;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const ease = (t: number) => 0.5 - Math.cos(Math.PI * clamp(t, 0, 1)) / 2;
/** Half linear, half eased: requests glide into the balancer, pause for a beat as it decides, then fan out. */
const glide = (t: number) => 0.45 * clamp(t, 0, 1) + 0.55 * ease(t);
const flash = (dt: number, len = 0.5) => (dt < 0 || dt > len ? 0 : (1 - dt / len) ** 2);
const wrap = (t: number) => ((t % T.cycle) + T.cycle) % T.cycle;
const frac = (v: number) => v - Math.floor(v);
const isUrl = (value: string) => /^(\/|\.|https?:|data:|blob:)/.test(value);
const f2 = (v: number) => v.toFixed(2);

/** Share of traffic sent to the primary region, out of 1. */
function weight(t: number) {
  if (t < T.shift) return 0.5;
  if (t < T.shiftEnd) return 0.5 * (1 - ease((t - T.shift) / (T.shiftEnd - T.shift)));
  if (t < T.ramp) return 0;
  if (t < T.rampEnd) return 0.5 * ease((t - T.ramp) / (T.rampEnd - T.ramp));
  return 0.5;
}
const instanceDown = (i: number, t: number) => t >= T.degrade + i * T.stagger && t < T.recover + i * T.stagger;
function downCount(t: number) {
  let n = 0;
  for (let i = 0; i < INSTANCES; i++) if (instanceDown(i, t)) n++;
  return n;
}
/** Failed checks returned so far in the outage, and passed checks returned so far in the recovery. */
function checks(t: number) {
  let failed = 0, passed = 0;
  for (let k = 0; k < THRESHOLD; k++) if (t >= probeBack(k)) failed++;
  for (let k = FIRST_PASS; k < FIRST_PASS + THRESHOLD; k++) if (t >= probeBack(k)) passed++;
  return { failed, passed };
}

const subscribe = () => () => {};
function useReducedFlag() {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

/** A slab on the 2:1 isometric grid: top face centered on (cx, cy), half width a, thickness h. */
function slab(cx: number, cy: number, a: number, h: number) {
  const b = a / 2;
  const p = (pts: number[][]) => pts.map(([x, y]) => `${f2(x)},${f2(y)}`).join(" ");
  return {
    top: p([[cx, cy - b], [cx + a, cy], [cx, cy + b], [cx - a, cy]]),
    left: p([[cx - a, cy], [cx, cy + b], [cx, cy + b + h], [cx - a, cy + h]]),
    right: p([[cx, cy + b], [cx + a, cy], [cx + a, cy + h], [cx, cy + b + h]]),
    outline: p([[cx, cy - b], [cx + a, cy], [cx + a, cy + h], [cx, cy + b + h], [cx - a, cy + h], [cx - a, cy]]),
  };
}

/** A point on a slab's top face: u runs toward the right corner, v toward the left corner. */
const onTop = (cx: number, cy: number, a: number, u: number, v: number): Pt => ({ x: cx + (u - v) * a, y: cy - a / 2 + (u + v) * (a / 2) });

/** An isometric circle on a top face, starting at the back and running clockwise, so a dash can show a share. */
function isoRing(cx: number, cy: number, r: number) {
  const ry = r / 2;
  return `M${f2(cx)} ${f2(cy - ry)} A${f2(r)} ${f2(ry)} 0 0 1 ${f2(cx)} ${f2(cy + ry)} A${f2(r)} ${f2(ry)} 0 0 1 ${f2(cx)} ${f2(cy - ry)}`;
}

/** A quadratic arc through the air from a to b, with its shadow line on the floor, sampled for an even pace. */
function makeArc(a: Pt, b: Pt, fa: Pt, fb: Pt, bend: Pt, drop = 0): Arc {
  const c = { x: (a.x + b.x) / 2 + bend.x, y: (a.y + b.y) / 2 + bend.y };
  const n = SAMPLES + 1;
  const xs = new Float32Array(n), ys = new Float32Array(n), fx = new Float32Array(n), fy = new Float32Array(n), acc = new Float32Array(n);
  let lift = 1;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLES, u = 1 - t;
    xs[i] = u * u * a.x + 2 * u * t * c.x + t * t * b.x;
    ys[i] = u * u * a.y + 2 * u * t * c.y + t * t * b.y;
    /** With a drop, the shadow runs just under the packet instead of along a straight floor line (the portrait stage). */
    fx[i] = drop ? xs[i] : fa.x + (fb.x - fa.x) * t;
    fy[i] = drop ? ys[i] + drop : fa.y + (fb.y - fa.y) * t;
    lift = Math.max(lift, fy[i] - ys[i]);
    acc[i] = i ? acc[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]) : 0;
  }
  return {
    d: `M${f2(a.x)} ${f2(a.y)} Q${f2(c.x)} ${f2(c.y)} ${f2(b.x)} ${f2(b.y)}`,
    floorD: `M${f2(fa.x)} ${f2(fa.y)} L${f2(fb.x)} ${f2(fb.y)}`,
    len: acc[n - 1] || 1, lift, xs, ys, fx, fy, acc,
  };
}

/** A lane follows a route, then peels off over its last stretch toward one instance, so requests never leave the drawn line early. */
function makeLane(route: Arc, dx: number, dy: number, dfy: number): Arc {
  const n = route.xs.length;
  const xs = new Float32Array(n), ys = new Float32Array(n), fx = new Float32Array(n), fy = new Float32Array(n), acc = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const k = ease((i / (n - 1) - 0.6) / 0.4);
    xs[i] = route.xs[i] + dx * k;
    ys[i] = route.ys[i] + dy * k;
    fx[i] = route.fx[i] + dx * k;
    fy[i] = route.fy[i] + dfy * k;
    acc[i] = i ? acc[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]) : 0;
  }
  return { ...route, xs, ys, fx, fy, acc, len: acc[n - 1] || 1 };
}

function sampleArc(arc: Arc, s: number) {
  const { acc } = arc;
  const target = clamp(s, 0, arc.len);
  let lo = 0, hi = acc.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (acc[mid] < target) lo = mid; else hi = mid;
  }
  const k = (target - acc[lo]) / (acc[hi] - acc[lo] || 1);
  const mix = (arr: Float32Array) => arr[lo] + (arr[hi] - arr[lo]) * k;
  return { x: mix(arc.xs), y: mix(arc.ys), fx: mix(arc.fx), fy: mix(arc.fy) };
}

function buildLayout(wide: boolean): Layout {
  const w = wide ? 1000 : 390;
  const h = wide ? 600 : 750;
  const spec: Record<MultiRegionFailoverNodeKey, [number, number, number, number]> = wide
    ? { users: [150, 300, 62, 14], balancer: [440, 300, 72, 16], primary: [790, 206, 118, 12], secondary: [790, 426, 118, 12] }
    : { users: [195, 150, 50, 12], balancer: [195, 330, 60, 14], primary: [100, 580, 80, 10], secondary: [290, 580, 80, 10] };
  const nodes = {} as Record<MultiRegionFailoverNodeKey, SlabGeo>;
  for (const key of NODE_KEYS) {
    const [cx, cy, a, th] = spec[key];
    nodes[key] = { cx, cy, a, h: th, port: { x: cx, y: cy - (key === "balancer" ? TIER : 0) }, floor: cy + th };
  }
  const cubes = {} as Record<RegionKey, Cube[]>;
  for (const key of REGIONS) {
    const n = nodes[key];
    const ca = n.a * 0.135, ch = ca * 0.95;
    cubes[key] = SLOTS.map(([u, v], i) => {
      const p = onTop(n.cx, n.cy, n.a, u, v);
      return { i, x: p.x, y: p.y - ch, a: ca, h: ch };
    });
  }
  const floorOf = (n: SlabGeo): Pt => ({ x: n.cx, y: n.floor + n.a / 2 * 0.2 });
  const b = nodes.balancer, u = nodes.users;
  const drop = wide ? 0 : 16;
  const trunk = makeArc(u.port, b.port, floorOf(u), floorOf(b), wide ? { x: 0, y: -96 } : { x: -92, y: 0 }, drop);
  const bends: Record<RegionKey, Pt> = wide ? { primary: { x: -20, y: -92 }, secondary: { x: -10, y: -64 } } : { primary: { x: -130, y: -10 }, secondary: { x: 130, y: -10 } };
  const route = {} as Record<RegionKey, Arc>;
  const lanes = {} as Record<RegionKey, Arc[]>;
  for (const key of REGIONS) {
    const n = nodes[key];
    route[key] = makeArc(b.port, n.port, floorOf(b), floorOf(n), bends[key], drop);
    lanes[key] = cubes[key].map(c => makeLane(route[key], c.x - n.port.x, c.y - n.port.y, c.y + c.h - n.port.y));
  }
  const below = (n: SlabGeo, extra = 0) => n.floor + n.a / 2 + 12 + extra;
  const above = (n: SlabGeo, extra = 0) => n.cy - n.a / 2 - 12 - extra;
  const labels: Layout["labels"] = wide
    ? {
      users: { x: u.cx, y: below(u), above: false },
      balancer: { x: b.cx, y: below(b), above: false },
      primary: { x: nodes.primary.cx, y: above(nodes.primary, 12), above: true },
      secondary: { x: nodes.secondary.cx, y: below(nodes.secondary), above: false },
    }
    : {
      users: { x: u.cx, y: above(u), above: true },
      balancer: { x: b.cx, y: below(b), above: false },
      primary: { x: nodes.primary.cx, y: below(nodes.primary), above: false },
      secondary: { x: nodes.secondary.cx, y: below(nodes.secondary), above: false },
    };
  return { w, h, wide, nodes, cubes, trunk, route, lanes, labels };
}

function Mark({ node, className }: { node: MultiRegionFailoverNode; className: string }) {
  const { icon, color } = node;
  if (icon == null) return null;
  if (typeof icon === "string") {
    // eslint-disable-next-line @next/next/no-img-element -- a small logo mark at its natural size; any URL is allowed.
    if (isUrl(icon)) return <img className={className} src={icon} alt="" draggable={false} />;
    return <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><path d={icon} fill={color ?? "currentColor"} /></svg>;
  }
  return <span className={className} aria-hidden="true">{icon}</span>;
}

const rate = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`);
/** Two halves of a region metric. Each half keeps its spaces unbreakable, so the portrait stage wraps only at the separator. */
const metricLine = (rateText: string, detail: string) => `${rateText.replace(/ /g, "\u00a0")} · ${detail.replace(/ /g, "\u00a0")}`;

export function MultiRegionFailover({
  hostname = "api.acme.dev",
  requestsPerSecond = 12000,
  latencyMs = 38,
  nodes: nodeOverrides,
  speed = 1,
  paused = false,
  accent,
  controls = true,
  caption = true,
  label,
  className,
  style,
}: MultiRegionFailoverProps) {
  const reduced = useReducedFlag();
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [focus, setFocus] = useState<MultiRegionFailoverNodeKey | null>(null);
  const [held, setHeld] = useState(false);

  const info = useMemo(() => {
    const o = nodeOverrides ?? {};
    const merged: Record<MultiRegionFailoverNodeKey, MultiRegionFailoverNode> = {
      users: { label: "Users", meta: "Worldwide", detail: "Every request goes to one hostname", ...o.users },
      balancer: { label: "Load balancer", meta: hostname, detail: "Checks each region and sets its share of traffic", ...o.balancer },
      primary: { label: "US East", meta: "us-east-1", detail: "Six instances in Virginia", ...o.primary },
      secondary: { label: "EU West", meta: "eu-west-1", detail: "Six instances in Ireland, ready to take it all", ...o.secondary },
    };
    return merged;
  }, [nodeOverrides, hostname]);
  const a = info.primary.label ?? "US East", b = info.secondary.label ?? "EU West";

  const text = useMemo(() => ({
    a, b,
    captions: [
      `The load balancer splits traffic evenly between ${a} and ${b}, and both regions pass their health checks.`,
      `Instances in ${a} start failing. Requests sent there return errors and its health checks fail one after another.`,
      `After ${THRESHOLD} failed checks ${a} is marked unhealthy and its share of traffic shifts smoothly to ${b}.`,
      `${b} serves every request and errors fall back to zero while ${a} is out of rotation.`,
      `${a} comes back, but it has to pass ${THRESHOLD} health checks in a row before it gets traffic again.`,
      `Traffic ramps back to ${a} gradually, so its warm up stays smooth, until the split is even again.`,
    ],
  }), [a, b]);

  const wide = width >= WIDE, measured = width > 0;
  const layout = useMemo(() => (measured ? buildLayout(wide) : null), [measured, wide]);

  const els = useRef({
    node: {} as Partial<Record<MultiRegionFailoverNodeKey, SVGGElement | null>>,
    cube: { primary: [], secondary: [] } as Record<RegionKey, (SVGGElement | null)[]>,
    device: [] as (SVGCircleElement | null)[],
    dialA: null as SVGPathElement | null,
    dialB: null as SVGPathElement | null,
    route: {} as Partial<Record<RegionKey, SVGPathElement | null>>,
    trunk: null as SVGPathElement | null,
    packet: [] as (SVGCircleElement | null)[],
    shadow: [] as (SVGEllipseElement | null)[],
    probe: null as SVGCircleElement | null,
    status: {} as Partial<Record<MultiRegionFailoverNodeKey, HTMLSpanElement | null>>,
    statusText: {} as Partial<Record<MultiRegionFailoverNodeKey, HTMLSpanElement | null>>,
    metric: {} as Partial<Record<RegionKey, HTMLSpanElement | null>>,
    barA: null as HTMLSpanElement | null,
    barB: null as HTMLSpanElement | null,
    pctA: null as HTMLSpanElement | null,
    pctB: null as HTMLSpanElement | null,
    fill: [] as (HTMLSpanElement | null)[],
    seg: [] as (HTMLButtonElement | null)[],
    caption: null as HTMLElement | null,
    capTitle: null as HTMLSpanElement | null,
    capText: null as HTMLSpanElement | null,
    msg: null as HTMLSpanElement | null,
    msgText: null as HTMLSpanElement | null,
  });

  const sim = useRef({ t: paused || speed === 0 ? STILL : 0, rate: NaN, rateV: 0, frame: 0, running: false, visible: true, cache: new Map<Element, Record<string, string>>() });
  const target = paused || held ? 0 : speed * (focus ? 0.7 : 1);
  const scale = layout ? width / layout.w : 1;
  const live = useRef({ layout, text, target, reduced, requestsPerSecond, latencyMs, scale });
  useLayoutEffect(() => { live.current = { layout, text, target, reduced, requestsPerSecond, latencyMs, scale }; });

  /**
   * Writes a value only when it changed, so resting elements cost nothing per frame. Keys starting with -- are custom
   * properties, s: sets a style property, text sets textContent, and anything else is an attribute.
   */
  const put = useCallback((node: Element | null | undefined, key: string, value: string) => {
    if (!node) return;
    const cache = sim.current.cache;
    let entry = cache.get(node);
    if (!entry) { entry = {}; cache.set(node, entry); }
    if (entry[key] === value) return;
    entry[key] = value;
    if (key === "text") {
      const first = node.firstChild;
      if (first && first.nodeType === 3 && !first.nextSibling) (first as Text).data = value;
      else node.textContent = value;
    }
    else if (key.startsWith("--")) (node as HTMLElement).style.setProperty(key, value);
    else if (key.startsWith("s:")) (node as HTMLElement).style.setProperty(key.slice(2), value);
    else node.setAttribute(key, value);
  }, []);

  const paint = useCallback((time: number) => {
    const { layout: g, text: tx, requestsPerSecond: rps, latencyMs: base, scale: k0, reduced: still } = live.current;
    const e = els.current;
    const t = wrap(time);
    const w = weight(t);
    const down = downCount(t);
    const { failed, passed } = checks(t);

    /** Scrubber and caption. */
    let stage = 0;
    STAGES.forEach((s, i) => { if (t >= s.start) stage = i; });
    /** At the seam the filled track fades out instead of snapping back to empty; the scene itself is the same state. */
    const seam = t > T.cycle - 0.4 ? 1 - ease((t - (T.cycle - 0.4)) / 0.4) : 1;
    STAGES.forEach((s, i) => {
      const end = STAGES[i + 1]?.start ?? T.cycle;
      const done = still ? (i <= stage ? 1 : 0) : clamp((t - s.start) / (end - s.start), 0, 1);
      put(e.fill[i], "s:transform", `scaleX(${done.toFixed(4)})`);
      put(e.fill[i], "s:opacity", seam.toFixed(3));
      put(e.seg[i], "data-current", i === stage ? "true" : "false");
      put(e.seg[i], "aria-current", i === stage ? "step" : "false");
    });
    put(e.capTitle, "text", STAGES[stage].title);
    put(e.capText, "text", tx.captions[stage]);
    const capStart = STAGES[stage].start, capEnd = STAGES[stage + 1]?.start ?? T.cycle;
    /** Only the very first moment skips the fade in; at the loop seam the caption fades like at every other stage. */
    const capOp = still ? 1 : Math.min(time < 0.3 ? 1 : ease((t - capStart) / 0.3), ease((capEnd - t) / 0.15));
    put(e.caption, "s:opacity", capOp.toFixed(3));

    /** Numbers that every panel shares, all derived from the same clock. */
    const total = rps * (1 + 0.02 * Math.sin((2 * Math.PI * t) / (T.cycle / 2)));
    const errRate = w * (down / INSTANCES) * 100;
    const share = { primary: w, secondary: 1 - w };

    /** Weight split: the bar under the balancer and the dial on its control tier. */
    put(e.barA, "s:transform", `scaleX(${share.primary.toFixed(4)})`);
    put(e.barB, "s:transform", `scaleX(${share.secondary.toFixed(4)})`);
    put(e.pctA, "text", `${Math.round(share.primary * 100)}%`);
    put(e.pctB, "text", `${Math.round(share.secondary * 100)}%`);
    put(e.dialA, "stroke-dasharray", `${(share.primary * 1000).toFixed(1)} 1000`);
    put(e.dialA, "opacity", share.primary < 0.002 ? "0" : "1");
    put(e.dialB, "stroke-dasharray", `${(share.secondary * 1000).toFixed(1)} 1000`);
    put(e.dialB, "stroke-dashoffset", `${(-share.primary * 1000).toFixed(1)}`);

    /** Routes: lit by their share of traffic, and tinted with danger while the requests on them fail. */
    put(e.route.primary, "--lit", Math.min(1, share.primary * 2).toFixed(3));
    put(e.route.primary, "--err", (share.primary * 2 * (down / INSTANCES)).toFixed(3));
    put(e.route.secondary, "--lit", Math.min(1, share.secondary * 2).toFixed(3));

    if (!g) return;

    /** Requests: packet k leaves the users at k * INTERVAL, crosses to the balancer, and is routed by the weight at that moment. */
    const hits: Record<RegionKey, number[]> = { primary: new Array(INSTANCES).fill(0), secondary: new Array(INSTANCES).fill(0) };
    const sent = new Array(4).fill(0);
    const used = new Array(POOL).fill(false);
    const life = TRUNK + BRANCH;
    const kFirst = Math.ceil((t - life - 0.6) / INTERVAL), kLast = Math.floor(t / INTERVAL);
    for (let k = kFirst; k <= kLast; k++) {
      const te = k * INTERVAL, age = t - te;
      const id = ((k % PER_CYCLE) + PER_CYCLE) % PER_CYCLE;
      const decide = wrap(te + TRUNK);
      const region: RegionKey = frac(id * 0.6180339887 + 0.31) < weight(decide) ? "primary" : "secondary";
      const inst = Math.floor(frac(id * 0.7548776662 + 0.4) * INSTANCES);
      const arrive = wrap(te + life);
      const fails = region === "primary" && instanceDown(inst, arrive);
      sent[((id % 4) + 4) % 4] = Math.max(sent[((id % 4) + 4) % 4], flash(age, 0.45));
      if (age > life) {
        if (!fails) hits[region][inst] = Math.max(hits[region][inst], flash(age - life, 0.55));
        continue;
      }
      if (age < 0) continue;
      const slot = ((k % POOL) + POOL) % POOL;
      used[slot] = true;
      const packet = e.packet[slot], shadow = e.shadow[slot];
      let p: { x: number; y: number; fx: number; fy: number }, lift: number, op = 1, size = 1, kind = "request";
      if (age < TRUNK) {
        const u = age / TRUNK;
        p = sampleArc(g.trunk, glide(u) * g.trunk.len);
        lift = g.trunk.lift;
        op = ease(u / 0.14);
      } else {
        const u = (age - TRUNK) / BRANCH;
        const lane = g.lanes[region][inst];
        if (fails) {
          /** A failing request stalls just short of its instance, turns to an error and fades out. */
          const stop = 0.86;
          p = sampleArc(lane, glide(Math.min(u, stop)) * lane.len);
          if (u > 0.62) kind = "error";
          op = 1 - ease((u - stop) / (1 - stop));
          size = 1 + 0.35 * ease((u - stop) / (1 - stop));
        } else {
          p = sampleArc(lane, glide(u) * lane.len);
          const sink = ease((u - 0.82) / 0.18);
          op = 1 - sink;
          size = 1 - 0.5 * sink;
        }
        lift = lane.lift;
      }
      const height = clamp((p.fy - p.y) / lift, 0, 1);
      put(packet, "transform", `translate(${f2(p.x)} ${f2(p.y)}) scale(${size.toFixed(3)})`);
      put(packet, "opacity", op.toFixed(3));
      put(packet, "data-kind", kind);
      put(shadow, "transform", `translate(${f2(p.fx)} ${f2(p.fy)}) scale(${(1 - 0.45 * height).toFixed(3)})`);
      put(shadow, "opacity", ((0.9 - 0.5 * height) * op).toFixed(3));
    }
    for (let i = 0; i < POOL; i++) if (!used[i]) { put(e.packet[i], "opacity", "0"); put(e.shadow[i], "opacity", "0"); }
    e.device.forEach((dot, i) => put(dot, "fill-opacity", sent[i].toFixed(3)));

    /** Instances: an accent flash where a request lands, a steady tint for load, and a danger state while down. */
    for (const key of REGIONS) {
      const load = key === "secondary" ? clamp((share.secondary - 0.5) * 2, 0, 1) : 0;
      g.cubes[key].forEach((c, i) => {
        const node = e.cube[key][i];
        put(node, "--hit", hits[key][i].toFixed(3));
        put(node, "--load", load.toFixed(3));
        put(node, "data-state", key === "primary" && instanceDown(i, t) ? "down" : "up");
      });
    }

    /** Health checks: a hollow probe runs to the primary and back, and the reply it carries rides beside it. */
    let probing = false;
    for (let k = 0; k < T.probeCount; k++) {
      const dt = t - probeAt(k);
      if (dt < 0 || dt > T.probeTrip * 2) continue;
      probing = true;
      const back = dt > T.probeTrip;
      const u = back ? (dt - T.probeTrip) / T.probeTrip : dt / T.probeTrip;
      const arc = g.route.primary;
      const s = glide(u) * arc.len;
      const q = sampleArc(arc, back ? arc.len - s : s);
      const ok = k >= FIRST_PASS;
      const edge = Math.min(ease(u / 0.2), ease((1 - u) / 0.2));
      const op = back ? ease((1 - u) / 0.2) : ease(u / 0.2);
      put(e.probe, "transform", `translate(${f2(q.x)} ${f2(q.y)})`);
      put(e.probe, "opacity", op.toFixed(3));
      put(e.probe, "data-result", back ? (ok ? "pass" : "fail") : "out");
      put(e.msg, "s:transform", `translate3d(${(q.x * k0).toFixed(1)}px, ${(q.y * k0 - 10).toFixed(1)}px, 0) translate(-50%, -100%)`);
      put(e.msg, "s:opacity", edge.toFixed(3));
      put(e.msg, "data-kind", back ? (ok ? "pass" : "fail") : "out");
      put(e.msgText, "text", back ? (ok ? "200 OK" : "503") : "GET /healthz");
    }
    if (!probing) { put(e.probe, "opacity", "0"); put(e.msg, "s:opacity", "0"); }

    /** Status chips and counters. */
    const status = (key: MultiRegionFailoverNodeKey, state: string, value: string) => {
      put(e.status[key], "data-state", state);
      put(e.statusText[key], "text", value);
    };
    status("users", "busy", `${rate(total)} req/s`);
    if (errRate < 0.05) status("balancer", "done", "No errors");
    else status("balancer", "error", `Errors ${errRate.toFixed(1)}%`);

    if (t < T.degrade) status("primary", "done", "Healthy");
    else if (t < UNHEALTHY) status("primary", "warn", failed === 0 ? "Degraded" : `Failed checks ${failed}/${THRESHOLD}`);
    else if (t < T.shiftEnd) status("primary", "error", "Unhealthy, draining");
    else if (t < ALL_UP) status("primary", "error", "Out of rotation");
    else if (t < HEALTHY) status("primary", "busy", passed === 0 ? "Recovering" : `Passed checks ${passed}/${THRESHOLD}`);
    else if (t < T.rampEnd) status("primary", "busy", `Warming up ${Math.round((w / 0.5) * 100)}%`);
    else status("primary", "done", "Healthy");
    status("secondary", "done", share.secondary > 0.505 ? `Serving ${Math.round(share.secondary * 100)}%` : "Healthy");

    const pReq = total * share.primary;
    const pServed = pReq * (1 - down / INSTANCES);
    put(e.metric.primary, "text", pReq < 5 ? "0 req/s, no traffic" : down > 0 ? metricLine(`${rate(pReq)} req/s`, `${Math.round((1 - pServed / pReq) * 100)}% errors`) : metricLine(`${rate(pReq)} req/s`, `p50 ${base} ms`));
    const sLat = Math.round(base + 4 + 11 * clamp((share.secondary - 0.5) * 2, 0, 1));
    put(e.metric.secondary, "text", metricLine(`${rate(total * share.secondary)} req/s`, `p50 ${sLat} ms`));
  }, [put]);

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
      /** Speed changes, pausing and the hover slowdown ease on a critically damped spring, so nothing jolts. */
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
    const node = root.current;
    if (!node) return;
    const measure = () => setWidth(Math.floor(node.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  /** With reduced motion the clock rests on a settled moment of a stage, showing that state without travel. */
  const [stillStage, setStillStage] = useState(2);
  useLayoutEffect(() => {
    sim.current.cache = new Map();
    if (reduced) paint(STAGES[stillStage].rep);
    else { paint(sim.current.t); loop(); }
  }, [layout, scale, text, reduced, target, stillStage, requestsPerSecond, latencyMs, paint, loop]);

  useEffect(() => {
    const node = root.current, s = sim.current;
    if (!node) return;
    let inView = true;
    const sync = () => {
      s.visible = inView && !document.hidden;
      if (s.visible) loop(); else { cancelAnimationFrame(s.frame); s.running = false; }
    };
    const observer = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; sync(); });
    observer.observe(node);
    document.addEventListener("visibilitychange", sync);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", sync); cancelAnimationFrame(s.frame); s.running = false; };
  }, [loop]);

  /** Jumps to the start of a stage in the current cycle and keeps playing from there. */
  const jump = useCallback((i: number) => {
    const s = sim.current;
    if (live.current.reduced) { setStillStage(i); return; }
    s.t = s.t - wrap(s.t) + STAGES[i].start + (i === 0 ? 0 : 0.001);
    paint(s.t);
    loop();
  }, [paint, loop]);

  const onSegKey = (event: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const next = event.key === "ArrowRight" ? i + 1 : event.key === "ArrowLeft" ? i - 1 : event.key === "Home" ? 0 : event.key === "End" ? STAGES.length - 1 : -1;
    if (next < 0 || next >= STAGES.length) return;
    event.preventDefault();
    els.current.seg[next]?.focus();
    jump(next);
  };

  const hover = (key: MultiRegionFailoverNodeKey) => ({
    onPointerEnter: (event: ReactPointerEvent) => { if (event.pointerType === "mouse") setFocus(key); },
    onPointerLeave: () => setFocus(current => (current === key ? null : current)),
  });
  const routeOn = (key: RegionKey) => focus === "balancer" || focus === key;
  const trunkOn = focus === "balancer" || focus === "users";
  const dimNode = (key: MultiRegionFailoverNodeKey) => focus !== null && focus !== key && key !== "balancer" && focus !== "balancer";

  const aria = label ?? `Multi-region failover for ${hostname}. A load balancer splits traffic between ${a} and ${b}. When ${a} starts failing, its health checks fail ${THRESHOLD} times in a row, it is marked unhealthy and traffic shifts smoothly to ${b}, so errors fall back to zero. Once ${a} recovers and passes ${THRESHOLD} checks, traffic ramps back until the split is even again.`;

  const g = layout;
  const rootStyle = { ...style, ...(accent ? { "--mrf-accent": accent } : null) } as CSSProperties;
  const showHeld = held || paused || speed === 0;
  const pct = (v: number, of: number) => `${((v / of) * 100).toFixed(3)}%`;

  const faces = (s: ReturnType<typeof slab>) => <>
    <polygon className={styles.faceLeft} points={s.left} />
    <polygon className={styles.faceRight} points={s.right} />
    <polygon className={styles.faceTop} points={s.top} />
  </>;

  const renderNode = (key: MultiRegionFailoverNodeKey) => {
    if (!g) return null;
    const n = g.nodes[key];
    const s = slab(n.cx, n.cy, n.a, n.h);
    let body: ReactNode = null;
    if (key === "users") {
      const spots: [number, number][] = [[0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]];
      body = spots.map(([u, v], i) => {
        const p = onTop(n.cx, n.cy, n.a, u, v);
        return <g key={i}>
          <ellipse className={styles.deviceBase} cx={p.x} cy={p.y} rx={n.a * 0.1} ry={n.a * 0.05} />
          <circle ref={el => { els.current.device[i] = el; }} className={styles.device} cx={p.x} cy={p.y} r={n.a * 0.05} fillOpacity={0} />
        </g>;
      });
    }
    if (key === "balancer") {
      const ta = n.a * TIER_A, tcy = n.cy - TIER;
      const r = ta * 0.62;
      body = <>
        {faces(slab(n.cx, tcy, ta, TIER))}
        <path className={styles.dialTrack} d={isoRing(n.cx, tcy, r)} />
        <path ref={el => { els.current.dialB = el; }} className={styles.dialB} d={isoRing(n.cx, tcy, r)} pathLength={1000} strokeDasharray="500 1000" strokeDashoffset={-500} />
        <path ref={el => { els.current.dialA = el; }} className={styles.dialA} d={isoRing(n.cx, tcy, r)} pathLength={1000} strokeDasharray="500 1000" />
      </>;
    }
    if (key === "primary" || key === "secondary") {
      const cubes = [...g.cubes[key]].sort((p, q) => p.y - q.y);
      body = cubes.map(c => <g key={c.i} ref={el => { els.current.cube[key][c.i] = el; }} className={styles.cube} data-state="up">
        {faces(slab(c.x, c.y, c.a, c.h))}
      </g>);
    }
    return <g
      key={key}
      ref={el => { els.current.node[key] = el; }}
      className={styles.node}
      data-on={focus === key || undefined}
      data-dim={dimNode(key) || undefined}
      {...hover(key)}
    >
      {faces(s)}
      {body}
      <polygon className={styles.hit} points={s.outline} />
    </g>;
  };

  return <figure
    className={[styles.root, className].filter(Boolean).join(" ")}
    style={rootStyle}
    data-ready={g ? true : undefined}
    data-layout={g ? (g.wide ? "wide" : "stack") : undefined}
  >
    <div ref={root} className={styles.stage} role="img" aria-label={aria} style={g ? { aspectRatio: `${g.w} / ${g.h}` } : undefined}>
      {g && <>
        <svg className={styles.svg} viewBox={`0 0 ${g.w} ${g.h}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
          {/* Floor: the shadow of every route, with each request's shadow sliding along it. */}
          <g>
            <path className={styles.floor} d={g.trunk.floorD} data-dim={(focus !== null && !trunkOn) || undefined} />
            {REGIONS.map(key => <path key={key} className={styles.floor} d={g.route[key].floorD} data-dim={(focus !== null && !routeOn(key)) || undefined} />)}
            {Array.from({ length: POOL }, (_, i) => <ellipse key={i} ref={el => { els.current.shadow[i] = el; }} className={styles.shadow} cx={0} cy={0} rx={4.5} ry={2.25} opacity={0} />)}
          </g>
          {/* Routes through the air sit under the nodes, so the slabs and instances they land on cover their ends. */}
          <g className={styles.route} data-on={trunkOn || undefined} data-dim={(focus !== null && !trunkOn) || undefined}>
            <path ref={el => { els.current.trunk = el; }} className={styles.edge} d={g.trunk.d} style={{ "--lit": 1 } as CSSProperties} />
          </g>
          {REGIONS.map(key => <g key={key} className={styles.route} data-on={routeOn(key) || undefined} data-dim={(focus !== null && !routeOn(key)) || undefined}>
            <path ref={el => { els.current.route[key] = el; }} className={styles.edge} d={g.route[key].d} />
          </g>)}
          {[...NODE_KEYS].sort((p, q) => g.nodes[p].cy - g.nodes[q].cy).map(renderNode)}
          <g className={styles.traffic} data-dim={focus === "primary" || focus === "secondary" || undefined}>
            {Array.from({ length: POOL }, (_, i) => <circle key={i} ref={el => { els.current.packet[i] = el; }} className={styles.packet} cx={0} cy={0} r={4} opacity={0} data-kind="request" />)}
          </g>
          <circle ref={el => { els.current.probe = el; }} className={styles.probe} cx={0} cy={0} r={4.5} opacity={0} data-result="out" />
        </svg>

        {NODE_KEYS.map(key => {
          const at = g.labels[key], node = info[key];
          const region = key === "primary" || key === "secondary";
          return <div
            key={key}
            className={styles.label}
            data-on={focus === key || undefined}
            data-above={at.above || undefined}
            data-kind={key}
            style={{ left: pct(at.x, g.w), top: pct(at.y, g.h) }}
            {...hover(key)}
          >
            <span className={styles.name}><Mark node={node} className={styles.mark} />{node.label}</span>
            {node.meta && <span className={styles.meta}>{node.meta}</span>}
            <span ref={el => { els.current.status[key] = el; }} className={styles.status} data-state="done">
              <span className={styles.dot} aria-hidden="true" />
              <span ref={el => { els.current.statusText[key] = el; }}>{key === "users" ? `${rate(requestsPerSecond)} req/s` : key === "balancer" ? "No errors" : "Healthy"}</span>
            </span>
            {region && <span ref={el => { els.current.metric[key] = el; }} className={styles.metric}>{metricLine(`${rate(requestsPerSecond / 2)} req/s`, `p50 ${key === "primary" ? latencyMs : latencyMs + 4} ms`)}</span>}
            {key === "balancer" && <span className={styles.weights}>
              <span className={styles.bar}>
                <span ref={el => { els.current.barA = el; }} className={styles.barA} />
                <span ref={el => { els.current.barB = el; }} className={styles.barB} />
              </span>
              <span className={styles.split}>
                <span className={styles.splitSide}><span className={styles.splitName}>{a}</span><span ref={el => { els.current.pctA = el; }} className={styles.splitPct}>50%</span></span>
                <span className={styles.splitSide} data-end><span className={styles.splitName}>{b}</span><span ref={el => { els.current.pctB = el; }} className={styles.splitPct}>50%</span></span>
              </span>
            </span>}
          </div>;
        })}

        {NODE_KEYS.map(key => {
          const n = g.nodes[key];
          const detail = info[key].detail;
          if (!detail) return null;
          const lift = key === "balancer" ? TIER + (n.a * TIER_A) / 2 : key === "primary" || key === "secondary" ? n.a / 2 + n.a * 0.14 : n.a / 2;
          const labelAbove = g.labels[key].above && g.labels[key].y < n.cy;
          const top = labelAbove ? n.floor + n.a / 2 + 16 : n.cy - lift - 10;
          const edge = n.cx / g.w;
          return <span
            key={`tag-${key}`}
            className={styles.tag}
            data-show={focus === key || undefined}
            data-below={labelAbove || undefined}
            data-align={edge > 0.7 ? "end" : edge < 0.3 ? "start" : "center"}
            style={{ left: pct(n.cx, g.w), top: pct(top, g.h) }}
            aria-hidden="true"
          >{detail}</span>;
        })}
        <span ref={el => { els.current.msg = el; }} className={styles.msg} style={{ opacity: 0 }} aria-hidden="true">
          <span ref={el => { els.current.msgText = el; }}>GET /healthz</span>
        </span>
      </>}
    </div>

    {controls && <div className={styles.controls}>
      {!reduced && <button type="button" className={styles.toggle} aria-label={showHeld ? "Play" : "Pause"} aria-pressed={held} disabled={paused || speed === 0} onClick={() => setHeld(v => !v)}>
        {showHeld ? <Play size={16} strokeWidth={1.75} aria-hidden="true" /> : <Pause size={16} strokeWidth={1.75} aria-hidden="true" />}
      </button>}
      <div className={styles.segments} role="group" aria-label="Failover steps">
        {STAGES.map((s, i) => <button
          key={s.short}
          ref={el => { els.current.seg[i] = el; }}
          type="button"
          className={styles.seg}
          aria-label={`Step ${i + 1} of ${STAGES.length}: ${s.title}`}
          onClick={() => jump(i)}
          onKeyDown={event => onSegKey(event, i)}
        >
          <span className={styles.track}><span ref={el => { els.current.fill[i] = el; }} className={styles.fill} /></span>
          <span className={styles.segLabel}>{s.short}</span>
        </button>)}
      </div>
    </div>}
    {caption && <figcaption ref={el => { els.current.caption = el; }} className={styles.caption} aria-hidden="true">
      <span ref={el => { els.current.capTitle = el; }} className={styles.capTitle}>{STAGES[0].title}</span>
      <span ref={el => { els.current.capText = el; }} className={styles.capText}>{text.captions[0]}</span>
    </figcaption>}
  </figure>;
}

export default MultiRegionFailover;
