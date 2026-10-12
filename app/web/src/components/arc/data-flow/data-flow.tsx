"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import { AppWindow, BellRing, Database, LayoutDashboard, Warehouse, Webhook } from "lucide-react";
import styles from "./data-flow.module.css";

export interface DataFlowNode {
  /** Stable key. Defaults to the label. */
  id?: string;
  /** Short name of the source or destination, such as Database. */
  label: string;
  /** Secondary line under the label, such as the product behind it. Hidden on narrow layouts. */
  meta?: string;
  /** One line shown in a small tag while the node is hovered. */
  detail?: string;
  /**
   * The mark. A string is either SVG path data on a 24 by 24 viewBox (the Simple Icons format), painted in color, or an
   * image URL for a full color logo. Any ReactNode works too and inherits the muted text color.
   */
  icon?: string | ReactNode;
  /** Brand color for a path mark. Leave it out for black and white brands. */
  color?: string;
  /** Destinations only: the share of records this destination receives, from 0 to 1. Defaults to 1. */
  share?: number;
}

export interface DataFlowCore {
  /** Name of the processing step. */
  label?: string;
  /** One line shown in a small tag while the core is hovered. */
  detail?: string;
  /** Word after the live count, such as processed or synced. */
  countLabel?: string;
  /** The count the core starts from. */
  countStart?: number;
}

/**
 * An animated data flow: sources on one side, a processing core in the middle, destinations on the other. Raw records leave
 * the sources as hollow dots, travel curved paths into the core, turn into solid accent squares as they are processed, and
 * fan out to every destination that takes them.
 */
export interface DataFlowProps {
  /** Where records come from. Three read best. */
  sources?: readonly DataFlowNode[];
  /** Where processed records go. Three read best; share thins out a destination such as alerts. */
  destinations?: readonly DataFlowNode[];
  /** The processing step in the middle. */
  core?: DataFlowCore;
  /** Multiplies the flow speed. At 1 a record takes about four seconds end to end. 0 holds still. */
  speed?: number;
  /** Holds the flow still where it is. */
  paused?: boolean;
  /** Color of the processed records and active paths. Defaults to the accent. */
  accent?: string;
  /** Accessible description of the diagram. Built from the labels when left out. */
  label?: string;
  /** Optional visible caption under the diagram. */
  caption?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

type Pt = { x: number; y: number };
type Box = { x: number; y: number; w: number; h: number };
/** A sampled path. edge is the distance along it where it meets the core, so trails can stop at the core outline. */
type Curve = { d: string; xs: Float32Array; ys: Float32Array; acc: Float32Array; len: number; edge: number };

const DEFAULT_SOURCES: DataFlowNode[] = [
  { id: "app", label: "App", meta: "Web and iOS", detail: "Clicks and sessions as they happen", icon: <AppWindow /> },
  { id: "database", label: "Database", meta: "Postgres", detail: "Row changes through change data capture", icon: <Database /> },
  { id: "events", label: "Events", meta: "Webhooks", detail: "Billing and auth events from partners", icon: <Webhook /> },
];

const DEFAULT_DESTINATIONS: DataFlowNode[] = [
  { id: "warehouse", label: "Warehouse", meta: "Every record", detail: "Stored in full for analysis", icon: <Warehouse /> },
  { id: "dashboard", label: "Dashboard", meta: "Live metrics", detail: "Rolled up into metrics each minute", icon: <LayoutDashboard /> },
  { id: "alerts", label: "Alerts", meta: "Anomalies only", detail: "Only unusual records page the on-call", icon: <BellRing />, share: 0.34 },
];

/** Timeline in flow seconds: six records per cycle, spread across the sources, each one in, processed, then out. */
const ORDER = [0, 2, 1, 0, 1, 2];
const CYCLE = 6.6;
const IN = 1.75;
const DWELL = 0.55;
const OUT = 1.85;
const TRAIL = 42;
/** Samples per curve for the length table that keeps records moving at an even pace. */
const SAMPLES = 72;
/** Below this width the diagram stacks top to bottom. */
const STACK = 600;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const ease = (t: number) => 0.5 - Math.cos(Math.PI * clamp(t, 0, 1)) / 2;
const isUrl = (value: string) => /^(\/|\.|https?:|data:|blob:)/.test(value);
const keyOf = (node: DataFlowNode) => node.id ?? node.label;
const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

const subscribe = () => () => {};
function useReducedFlag() {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

/** A cubic from a to b with tangents along the flow axis, then an optional straight run to a last point, sampled by length. */
function makeCurve(a: Pt, b: Pt, axis: "x" | "y", tail?: Pt, head?: Pt): Curve {
  const pts: Pt[] = [];
  if (head) pts.push(head);
  const k = axis === "x" ? (b.x - a.x) * 0.5 : (b.y - a.y) * 0.5;
  const c1 = axis === "x" ? { x: a.x + k, y: a.y } : { x: a.x, y: a.y + k };
  const c2 = axis === "x" ? { x: b.x - k, y: b.y } : { x: b.x, y: b.y - k };
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES, u = 1 - t;
    pts.push({
      x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
      y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
    });
  }
  if (tail) pts.push(tail);
  const n = pts.length, xs = new Float32Array(n), ys = new Float32Array(n), acc = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = pts[i].x; ys[i] = pts[i].y;
    acc[i] = i ? acc[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]) : 0;
  }
  const f = (v: number) => v.toFixed(2);
  const d = `${head ? `M${f(head.x)} ${f(head.y)} L` : "M"}${f(a.x)} ${f(a.y)} C${f(c1.x)} ${f(c1.y)} ${f(c2.x)} ${f(c2.y)} ${f(b.x)} ${f(b.y)}${tail ? ` L${f(tail.x)} ${f(tail.y)}` : ""}`;
  const len = acc[n - 1] || 1;
  return { d, xs, ys, acc, len, edge: tail ? acc[n - 2] : head ? acc[1] : 0 };
}

function pointAt(c: Curve, s: number): Pt {
  const { acc, xs, ys } = c;
  const target = clamp(s, 0, c.len);
  let lo = 0, hi = acc.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (acc[mid] < target) lo = mid; else hi = mid;
  }
  const span = acc[hi] - acc[lo] || 1, f = (target - acc[lo]) / span;
  return { x: xs[lo] + (xs[hi] - xs[lo]) * f, y: ys[lo] + (ys[hi] - ys[lo]) * f };
}

function buildGeometry(w: number, nSrc: number, nDst: number) {
  const stacked = w < STACK;
  if (!stacked) {
    const h = Math.round(clamp(w * 0.4, 300, 400));
    const chipW = Math.round(clamp(w * 0.18, 132, 184)), chipH = 52;
    const core = Math.round(clamp(w * 0.1, 84, 104));
    const c = { x: Math.round(w / 2), y: Math.round(h / 2 - 10) };
    const rows = (n: number) => {
      const spread = Math.min(h * 0.29, 112);
      /** Rows land on whole pixels so chip borders and ports stay crisp. */
      return Array.from({ length: n }, (_, i) => Math.round(c.y + (n === 1 ? 0 : (i / (n - 1) - 0.5) * 2 * spread)));
    };
    const port = (i: number, n: number) => (n === 1 ? 0 : (i / (n - 1) - 0.5) * 2 * Math.min(14, core * 0.16));
    const sources: Box[] = rows(nSrc).map(y => ({ x: 1, y: y - chipH / 2, w: chipW, h: chipH }));
    const dests: Box[] = rows(nDst).map(y => ({ x: w - 1 - chipW, y: y - chipH / 2, w: chipW, h: chipH }));
    const inCurves = sources.map((b, i) => makeCurve({ x: b.x + b.w, y: b.y + b.h / 2 }, { x: c.x - core / 2, y: c.y + port(i, nSrc) }, "x", c));
    const outCurves = dests.map((b, i) => makeCurve({ x: c.x + core / 2, y: c.y + port(i, nDst) }, { x: b.x, y: b.y + b.h / 2 }, "x", undefined, c));
    return { w, h, stacked, core, c, sources, dests, inCurves, outCurves };
  }
  const h = Math.round(clamp(w * 1.24, 440, 560));
  const gap = 8, chipH = 64;
  const core = 84;
  const c = { x: Math.round(w / 2), y: Math.round(h / 2) };
  const cols = (n: number) => {
    const chipW = (w - 2 - gap * (n - 1)) / n;
    return Array.from({ length: n }, (_, i) => {
      const x = Math.round(1 + i * (chipW + gap));
      return { x, w: Math.round(1 + i * (chipW + gap) + chipW) - x };
    });
  };
  const port = (i: number, n: number) => (n === 1 ? 0 : (i / (n - 1) - 0.5) * 2 * 14);
  const sources: Box[] = cols(nSrc).map(col => ({ x: col.x, y: 1, w: col.w, h: chipH }));
  const dests: Box[] = cols(nDst).map(col => ({ x: col.x, y: h - 1 - chipH, w: col.w, h: chipH }));
  const inCurves = sources.map((b, i) => makeCurve({ x: b.x + b.w / 2, y: b.y + b.h }, { x: c.x + port(i, nSrc), y: c.y - core / 2 }, "y", c));
  const outCurves = dests.map((b, i) => makeCurve({ x: c.x + port(i, nDst), y: c.y + core / 2 }, { x: b.x + b.w / 2, y: b.y }, "y", undefined, c));
  return { w, h, stacked, core, c, sources, dests, inCurves, outCurves };
}

type Geometry = ReturnType<typeof buildGeometry>;

function Mark({ node }: { node: DataFlowNode }) {
  const { icon, color } = node;
  if (icon == null) return null;
  if (typeof icon === "string") {
    // eslint-disable-next-line @next/next/no-img-element
    if (isUrl(icon)) return <img className={styles.mark} src={icon} alt="" draggable={false} />;
    return <svg className={styles.mark} viewBox="0 0 24 24" aria-hidden="true"><path d={icon} fill={color ?? "currentColor"} /></svg>;
  }
  return <span className={styles.mark} aria-hidden="true">{icon}</span>;
}

/** Whether record j reaches a destination that takes this share, spread evenly: a third means every third record. */
const routed = (j: number, share: number) => share >= 1 || Math.floor((j + 1) * share) > Math.floor(j * share);

export function DataFlow({
  sources = DEFAULT_SOURCES,
  destinations = DEFAULT_DESTINATIONS,
  core: coreProp,
  speed = 1,
  paused = false,
  accent,
  label,
  caption,
  className,
  style,
}: DataFlowProps) {
  const reduced = useReducedFlag();
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [focus, setFocus] = useState<string | null>(null);

  const coreLabel = coreProp?.label ?? "Transform";
  const coreDetail = coreProp?.detail ?? "Validates, dedupes and enriches each record";
  const countLabel = coreProp?.countLabel ?? "processed";
  const countStart = coreProp?.countStart ?? 12480;

  const nSrc = Math.max(1, sources.length), nDst = Math.max(1, destinations.length);
  const geometry = useMemo(() => (width > 0 ? buildGeometry(width, nSrc, nDst) : null), [width, nSrc, nDst]);

  /** One record slot per timeline entry; the source for each entry is fixed so hover can dim by source in CSS. */
  const slots = useMemo(() => {
    const order = nSrc === 3 ? ORDER : Array.from({ length: Math.max(6, nSrc * 2) }, (_, e) => e % nSrc);
    return order.map((src, e) => ({
    src,
    at: (e * CYCLE) / order.length,
    /** A small, fixed variation in pace so the flow feels organic but repeats exactly. */
    pace: 1 + (((e * 5) % 7) - 3) * 0.025,
    }));
  }, [nSrc]);
  const shares = useMemo(() => destinations.map(d => clamp(d.share ?? 1, 0, 1)), [destinations]);

  const els = useRef({
    raw: [] as (SVGGElement | null)[],
    rawDot: [] as (SVGRectElement | null)[],
    rawDone: [] as (SVGRectElement | null)[],
    rawTrail: [] as (SVGPathElement | null)[],
    out: [] as (SVGGElement | null)[][],
    outTrail: [] as (SVGPathElement | null)[][],
    srcPort: [] as (SVGCircleElement | null)[],
    dstPort: [] as (SVGCircleElement | null)[],
    srcChip: [] as (HTMLDivElement | null)[],
    dstChip: [] as (HTMLDivElement | null)[],
    ring: null as SVGGElement | null,
    pulse: null as SVGRectElement | null,
    core: null as HTMLDivElement | null,
    count: null as HTMLSpanElement | null,
  });

  const sim = useRef({ t: CYCLE * 2, rate: NaN, rateV: 0, spin: 0, coreHit: 0, frame: 0, running: false, visible: true, lastCount: -1, cache: new Map<Element, Record<string, string>>() });
  const live = useRef({ geometry, slots, shares, target: 1, reduced, countStart });
  const target = paused ? 0 : speed * (focus ? 0.7 : 1);
  useLayoutEffect(() => { live.current = { geometry, slots, shares, target, reduced, countStart }; });

  /** Writes an attribute or style value only when it changed, so resting elements cost nothing per frame. */
  const put = useCallback((node: Element | null | undefined, key: string, value: string) => {
    if (!node) return;
    const cache = sim.current.cache;
    let entry = cache.get(node);
    if (!entry) { entry = {}; cache.set(node, entry); }
    if (entry[key] === value) return;
    entry[key] = value;
    if (key.startsWith("--")) (node as HTMLElement).style.setProperty(key, value);
    else node.setAttribute(key, value);
  }, []);

  const paint = useCallback((t: number, still: boolean) => {
    const { geometry: g, slots: list, shares: sh, countStart: base } = live.current;
    if (!g) return;
    const e = els.current;
    const srcHit = new Array<number>(g.inCurves.length).fill(0);
    const dstHit = new Array<number>(g.outCurves.length).fill(0);
    /** Seconds since the latest record reached the core, or -1. */
    let arrival = -1;
    let processed = 0;
    const done = (at: number, pace: number, time: number) => Math.max(0, Math.floor((time - at - IN * pace - DWELL) / CYCLE) + 1);

    list.forEach((slot, i) => {
      const inDur = IN * slot.pace, outDur = OUT * slot.pace, life = inDur + DWELL + outDur;
      const inC = g.inCurves[slot.src], raw = e.raw[i], trail = e.rawTrail[i];
      processed += done(slot.at, slot.pace, t) - done(slot.at, slot.pace, CYCLE * 2);

      if (still) {
        /** Reduced motion: one raw record on each in path and one processed record on each out path, all at rest. */
        const first = list.findIndex(other => other.src === slot.src) === i;
        if (first && inC) {
          const p = pointAt(inC, inC.edge * 0.56);
          put(raw, "transform", `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`);
          put(e.rawDot[i], "opacity", "1");
          put(e.rawDone[i], "opacity", "0");
        }
        put(raw, "opacity", first ? "1" : "0");
        put(trail, "opacity", "0");
        g.outCurves.forEach((c, d) => {
          const show = i === d % list.length, node = e.out[i]?.[d];
          if (show) {
            const p = pointAt(c, c.edge + (c.len - c.edge) * 0.5);
            put(node, "transform", `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`);
          }
          put(node, "opacity", show ? "1" : "0");
          put(e.outTrail[i]?.[d], "opacity", "0");
        });
        return;
      }

      const since = t - slot.at;
      const k = Math.floor(since / CYCLE);
      const u = since - k * CYCLE;
      const j = k * list.length + i;

      /** Ports light up as a record leaves its source and as it lands in a destination. */
      srcHit[slot.src] = Math.max(srcHit[slot.src], u < 0.12 ? ease(u / 0.12) : (1 - clamp((u - 0.12) / 0.6, 0, 1)) ** 2);
      const land = inDur + DWELL + outDur * 0.93;
      g.outCurves.forEach((_, d) => {
        if (!routed(j, sh[d] ?? 1)) return;
        const x = u - land;
        const hit = x < -0.12 ? 0 : x < 0 ? 1 + x / 0.12 : (1 - clamp(x / 0.6, 0, 1)) ** 2;
        dstHit[d] = Math.max(dstHit[d], hit);
      });
      if (u >= inDur) arrival = arrival < 0 ? u - inDur : Math.min(arrival, u - inDur);

      const hideOuts = () => g.outCurves.forEach((_, d) => { put(e.out[i]?.[d], "opacity", "0"); put(e.outTrail[i]?.[d], "opacity", "0"); });
      if (!inC || u >= life) { put(raw, "opacity", "0"); put(trail, "opacity", "0"); hideOuts(); return; }

      if (u < inDur + DWELL) {
        hideOuts();
        let x: number, y: number, scale: number, morph: number, opacity: number;
        if (u < inDur) {
          const p = u / inDur, s = ease(p) * inC.len;
          ({ x, y } = pointAt(inC, s));
          opacity = clamp(u / 0.18, 0, 1);
          scale = 0.55 + 0.45 * ease(u / 0.3);
          morph = 0;
          /** A short trail follows the record so the direction reads at a glance; it stops at the core outline. */
          const head = Math.min(s, inC.edge), len = Math.min(TRAIL, head);
          put(trail, "stroke-dasharray", `${((len / inC.len) * 1000).toFixed(2)} 2000`);
          put(trail, "stroke-dashoffset", `${(-((head - len) / inC.len) * 1000).toFixed(2)}`);
          put(trail, "opacity", clamp(Math.min(u / 0.3, (inC.edge - (s - TRAIL)) / TRAIL), 0, 1).toFixed(3));
        } else {
          /** Inside the core the hollow record turns into a solid accent square, with a small swell as it changes. */
          const m = ease((u - inDur) / DWELL);
          x = g.c.x; y = g.c.y;
          opacity = 1;
          scale = 1 + 0.3 * Math.sin(Math.PI * m);
          morph = m;
          put(trail, "opacity", "0");
        }
        put(raw, "transform", `translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${scale.toFixed(3)})`);
        put(raw, "opacity", opacity.toFixed(3));
        put(e.rawDot[i], "opacity", (1 - morph).toFixed(3));
        put(e.rawDone[i], "opacity", morph.toFixed(3));
        return;
      }

      put(raw, "opacity", "0");
      put(trail, "opacity", "0");
      const v = (u - inDur - DWELL) / outDur;
      /** One copy carries the processed record out; the others fade in as they split off, so the fan out never reads as a clump. */
      const mid = Math.floor(g.outCurves.length / 2);
      const lead = routed(j, sh[mid] ?? 1) ? mid : g.outCurves.findIndex((_, d) => routed(j, sh[d] ?? 1));
      g.outCurves.forEach((c, d) => {
        const node = e.out[i]?.[d], tr = e.outTrail[i]?.[d];
        if (!routed(j, sh[d] ?? 1)) { put(node, "opacity", "0"); put(tr, "opacity", "0"); return; }
        const s = ease(v) * c.len;
        const { x, y } = pointAt(c, s);
        /** The record lands in the destination: it shrinks into the port as the port lights up. */
        const sink = clamp((v - 0.9) / 0.1, 0, 1);
        put(node, "transform", `translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${(1 - 0.6 * sink).toFixed(3)})`);
        const split = d === lead ? 1 : ease(clamp(s / (c.edge * 1.15), 0, 1));
        put(node, "opacity", ((1 - sink) * split).toFixed(3));
        const len = Math.min(TRAIL, Math.max(0, s - c.edge));
        put(tr, "stroke-dasharray", `${((len / c.len) * 1000).toFixed(2)} 2000`);
        put(tr, "stroke-dashoffset", `${(-((s - len) / c.len) * 1000).toFixed(2)}`);
        put(tr, "opacity", clamp((1 - v) / 0.18, 0, 1).toFixed(3));
      });
    });

    /** An arrival gives the core a soft outline that widens and fades, and warms its border for a moment. */
    const PULSE = 0.8;
    const q = arrival >= 0 && arrival < PULSE ? arrival / PULSE : -1;
    if (q >= 0) {
      put(e.pulse, "transform", `translate(${g.c.x} ${g.c.y}) scale(${(1 + 0.16 * ease(Math.min(1, q * 1.3))).toFixed(4)})`);
      put(e.pulse, "opacity", (0.5 * (1 - q) ** 2).toFixed(3));
    } else put(e.pulse, "opacity", "0");
    sim.current.coreHit = q >= 0 ? (1 - q) ** 2 : 0;
    put(e.core, "--hit", sim.current.coreHit.toFixed(3));
    e.srcChip.forEach((node, i) => put(node, "--hit", (srcHit[i] ?? 0).toFixed(3)));
    e.dstChip.forEach((node, i) => put(node, "--hit", (dstHit[i] ?? 0).toFixed(3)));
    e.srcPort.forEach((node, i) => put(node, "fill-opacity", (srcHit[i] ?? 0).toFixed(3)));
    e.dstPort.forEach((node, i) => put(node, "fill-opacity", (dstHit[i] ?? 0).toFixed(3)));
    put(e.ring, "transform", `translate(${g.c.x} ${g.c.y}) rotate(${(still ? 0 : sim.current.spin % 360).toFixed(2)})`);

    const count = base + (still ? 0 : processed);
    if (e.count && count !== sim.current.lastCount) {
      sim.current.lastCount = count;
      e.count.textContent = fmt(count);
    }
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
      const { target: goal } = live.current;
      if (Number.isNaN(s.rate)) s.rate = goal;
      /** Speed changes and pausing ease on a critically damped spring, so the flow never jolts. */
      s.rateV += (40 * (goal - s.rate) - 2 * Math.sqrt(40) * s.rateV) * dt;
      s.rate += s.rateV * dt;
      if (Math.abs(goal - s.rate) < 1e-4 && Math.abs(s.rateV) < 1e-4) { s.rate = goal; s.rateV = 0; }
      s.t += dt * s.rate;
      /** The dashed ring in the core turns slowly and quickens for a moment while a record is processed. */
      s.spin += dt * s.rate * (14 + 60 * s.coreHit);
      paint(s.t, false);
      const resting = s.rate === 0 && goal === 0;
      if (resting || !s.visible || live.current.reduced) { s.running = false; return; }
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

  /** Repaint whenever layout changes, then run or rest the loop. The cache is cleared because new elements mounted. */
  useLayoutEffect(() => {
    sim.current.cache = new Map();
    sim.current.lastCount = -1;
    paint(sim.current.t, reduced);
    if (!reduced) loop();
  }, [geometry, slots, shares, reduced, target, paint, loop]);

  useEffect(() => {
    const node = root.current, s = sim.current;
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

  const srcKeys = sources.map(keyOf), dstKeys = destinations.map(keyOf);
  const focusSrc = focus?.startsWith("s:") ? srcKeys.indexOf(focus.slice(2)) : -1;
  const focusDst = focus?.startsWith("d:") ? dstKeys.indexOf(focus.slice(2)) : -1;
  const focusCore = focus === "core";

  const list = (items: readonly DataFlowNode[]) => {
    const names = items.map(n => n.label.toLowerCase());
    return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] ?? "";
  };
  const aria = label ?? `Data flow. Records from ${list(sources)} stream into ${coreLabel.toLowerCase()}, which turns each raw record into a clean one and fans it out to ${list(destinations)}.`;

  const hover = (id: string) => ({
    onPointerEnter: (event: ReactPointerEvent) => { if (event.pointerType === "mouse") setFocus(id); },
    onPointerLeave: () => setFocus(current => (current === id ? null : current)),
  });

  const g: Geometry | null = geometry;
  const chip = (node: DataFlowNode, box: Box, side: "src" | "dst", i: number) => {
    const id = `${side === "src" ? "s" : "d"}:${keyOf(node)}`;
    const on = focus === id;
    const dim = (side === "src" && focusSrc >= 0 && !on) || (side === "dst" && focusDst >= 0 && !on);
    return <div
      key={id}
      ref={el => { (side === "src" ? els.current.srcChip : els.current.dstChip)[i] = el; }}
      className={styles.chip}
      data-side={side}
      data-on={on || undefined}
      data-dim={dim || undefined}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      {...hover(id)}
    >
      <Mark node={node} />
      <span className={styles.text}>
        <span className={styles.label}>{node.label}</span>
        {node.meta && <span className={styles.meta}>{node.meta}</span>}
      </span>
      {node.detail && <span className={styles.tag} aria-hidden="true">{node.detail}</span>}
    </div>;
  };

  const rootStyle = { ...style, ...(accent ? { "--flow-accent": accent } : null) } as CSSProperties;

  return <figure
    className={[styles.root, className].filter(Boolean).join(" ")}
    style={rootStyle}
    data-ready={g ? true : undefined}
    data-layout={g?.stacked ? "stack" : "row"}
  >
    <div
      ref={root}
      className={styles.stage}
      role="img"
      aria-label={aria}
      data-focus={focus ? true : undefined}
      style={g ? { height: g.h } : undefined}
    >
      {g && <>
        <svg className={styles.layer} viewBox={`0 0 ${g.w} ${g.h}`} width={g.w} height={g.h} aria-hidden="true">
          {g.inCurves.map((c, i) => <path key={`in-${i}`} className={styles.path} d={c.d} data-on={i === focusSrc || focusCore || undefined} />)}
          {g.outCurves.map((c, d) => <path key={`out-${d}`} className={styles.path} d={c.d} data-on={d === focusDst || focusCore || undefined} />)}
        </svg>

        {sources.map((node, i) => g.sources[i] && chip(node, g.sources[i], "src", i))}
        {destinations.map((node, i) => g.dests[i] && chip(node, g.dests[i], "dst", i))}

        <div
          ref={el => { els.current.core = el; }}
          className={styles.core}
          data-on={focusCore || undefined}
          style={{ left: g.c.x - g.core / 2, top: g.c.y - g.core / 2, width: g.core, height: g.core }}
          {...hover("core")}
        >
          <span className={styles.tag} data-place="above" aria-hidden="true">{coreDetail}</span>
        </div>
        <div className={styles.caption} data-place={g.stacked ? "side" : "below"} style={g.stacked
          ? { left: g.c.x + g.core / 2 + 14, top: g.c.y, maxWidth: g.w - (g.c.x + g.core / 2 + 14) - 4 }
          : { left: g.c.x, top: g.c.y + g.core / 2 + 12 }}>
          <span className={styles.label}>{coreLabel}</span>
          <span className={styles.meta}><span ref={el => { els.current.count = el; }} className={styles.num}>{fmt(countStart)}</span> {countLabel}</span>
        </div>

        <svg className={styles.layer} viewBox={`0 0 ${g.w} ${g.h}`} width={g.w} height={g.h} aria-hidden="true">
          <g ref={el => { els.current.ring = el; }} transform={`translate(${g.c.x} ${g.c.y})`}>
            <circle className={styles.ring} r={g.core * 0.24} />
          </g>
          <rect
            ref={el => { els.current.pulse = el; }}
            className={styles.pulse}
            x={-g.core / 2} y={-g.core / 2} width={g.core} height={g.core}
            rx={g.core * 0.28}
            transform={`translate(${g.c.x} ${g.c.y})`}
            opacity={0}
          />
          {g.sources.map((b, i) => {
            const p = g.stacked ? { x: b.x + b.w / 2, y: b.y + b.h } : { x: b.x + b.w, y: b.y + b.h / 2 };
            return <g key={`sp-${i}`} className={styles.slot} data-dim={(focusSrc >= 0 && focusSrc !== i) || undefined}>
              <circle className={styles.port} cx={p.x} cy={p.y} r={3.5} />
              <circle ref={el => { els.current.srcPort[i] = el; }} className={styles.portHit} cx={p.x} cy={p.y} r={2.25} fillOpacity={0} />
            </g>;
          })}
          {g.dests.map((b, i) => {
            const p = g.stacked ? { x: b.x + b.w / 2, y: b.y } : { x: b.x, y: b.y + b.h / 2 };
            return <g key={`dp-${i}`} className={styles.slot} data-dim={(focusDst >= 0 && focusDst !== i) || undefined}>
              <circle className={styles.port} cx={p.x} cy={p.y} r={3.5} />
              <circle ref={el => { els.current.dstPort[i] = el; }} className={styles.portHit} cx={p.x} cy={p.y} r={2.25} fillOpacity={0} />
            </g>;
          })}
          {slots.map((slot, i) => <g key={`slot-${i}`} className={styles.slot} data-dim={(focusSrc >= 0 && slot.src !== focusSrc) || undefined}>
            {g.inCurves[slot.src] && <path ref={el => { els.current.rawTrail[i] = el; }} className={styles.trailRaw} d={g.inCurves[slot.src].d} pathLength={1000} opacity={0} />}
            {g.outCurves.map((c, d) => <g key={`o-${d}`} data-dim={(focusDst >= 0 && d !== focusDst) || undefined} className={styles.slot}>
              <path ref={el => { (els.current.outTrail[i] ??= [])[d] = el; }} className={styles.trailDone} d={c.d} pathLength={1000} opacity={0} />
              <g ref={el => { (els.current.out[i] ??= [])[d] = el; }} opacity={0}>
                <rect className={styles.done} x={-4.5} y={-4.5} width={9} height={9} rx={2.5} />
              </g>
            </g>)}
            <g ref={el => { els.current.raw[i] = el; }} opacity={0}>
              <rect ref={el => { els.current.rawDot[i] = el; }} className={styles.raw} x={-4} y={-4} width={8} height={8} rx={4} />
              <rect ref={el => { els.current.rawDone[i] = el; }} className={styles.done} x={-4.5} y={-4.5} width={9} height={9} rx={2.5} opacity={0} />
            </g>
          </g>)}
        </svg>
      </>}
    </div>
    {caption && <figcaption className={styles.figcaption}>{caption}</figcaption>}
  </figure>;
}

export default DataFlow;
