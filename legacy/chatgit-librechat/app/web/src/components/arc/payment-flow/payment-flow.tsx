"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import { Landmark, Nfc, Store } from "lucide-react";
import styles from "./payment-flow.module.css";

export interface PaymentFlowNode {
  /** Short name, such as Stripe or Issuing bank. */
  label: string;
  /** Second line while the node rests, such as its role. The live status replaces it during a payment. */
  meta?: string;
  /** One line shown in a small tag while the node is hovered. */
  detail?: string;
  /**
   * The mark. A string is either SVG path data on a 24 by 24 viewBox (the Simple Icons format), painted in color, or an
   * image URL for a full color logo. Any ReactNode works too and inherits the muted text color.
   */
  icon?: string | ReactNode;
  /** Brand color for a path mark. */
  color?: string;
}

export interface PaymentFlowNodes {
  /** Where the card is tapped. */
  terminal?: PaymentFlowNode;
  /** The processor or acquirer that checks risk and forwards the request. */
  processor?: PaymentFlowNode;
  /** The card network that routes the request to the issuer. */
  network?: PaymentFlowNode;
  /** The cardholder's bank, which approves and holds the funds. */
  issuer?: PaymentFlowNode;
  /** The merchant balance that receives the payout. Its second line always shows the balance. */
  merchant?: PaymentFlowNode;
}

export interface PaymentFlowLabels {
  /** First phase in the step row. */
  authorization?: string;
  /** Second phase in the step row. */
  settlement?: string;
  /** When settlement happens, shown beside the second phase. */
  settlementTime?: string;
  /** Text on the approval chip that travels back. */
  approved?: string;
}

/**
 * An animated card payment. A tap at checkout sends the amount as a small chip through the processor and the card network
 * to the issuing bank; the bank approves, and the approval travels back and paints the path. Then settlement runs on a
 * second rail: the funds clear through the network, the processor takes its fee (the chip changes to the net amount), and
 * the payout lands in the merchant balance, which counts up.
 */
export interface PaymentFlowProps {
  /** The five stops. Each one you pass replaces the default for that stop. */
  nodes?: PaymentFlowNodes;
  /** The charge. */
  amount?: number;
  /** What the processor keeps at settlement. The payout is amount minus fee. */
  fee?: number;
  /** Balance before the first payout. It grows by the payout on every loop. */
  balance?: number;
  /** ISO currency code. */
  currency?: string;
  /** Locale for money formatting. Keep it fixed so the server and the browser agree. */
  locale?: string;
  /** Authorization time the step row counts to, in milliseconds. */
  authorizationMs?: number;
  /** Phase names and the approval text. */
  labels?: PaymentFlowLabels;
  /** Hides the step row under the diagram. */
  hideSteps?: boolean;
  /** Multiplies the pace. At 1 one payment takes about 15 seconds. 0 holds still. */
  speed?: number;
  /** Holds the diagram still where it is. */
  paused?: boolean;
  /** Color of the moving amount, the active path, and hovered wires. Defaults to the accent. */
  accent?: string;
  /** Accessible description. Built from the nodes and amounts when left out. */
  label?: string;
  /** Optional visible caption under the diagram. */
  caption?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

type Pt = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };
type Curve = { d: string; xs: Float32Array; ys: Float32Array; acc: Float32Array; len: number };
type State = "idle" | "active" | "done" | "ok";
type Phase = { at: number; state: State; text: string | null };
type HopKind = "fwd" | "back" | "rail";
type Hop = { pill: number; t0: number; dur: number; kind: HopKind; k: number };

const STRIPE = "M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z";

/** The Mastercard mark in its three brand colors, which read in both themes. */
/** Cropped to the two rings, so the mark fills the same 16px slot as the other icons instead of reading smaller. */
const MastercardMark = <svg viewBox="2 2 20 20" aria-hidden="true">
  <circle cx="9" cy="12" r="6.5" fill="#EB001B" />
  <circle cx="15" cy="12" r="6.5" fill="#F79E1B" />
  <path d="M12 6.234A6.5 6.5 0 0 1 12 17.766A6.5 6.5 0 0 1 12 6.234Z" fill="#FF5F00" />
</svg>;

const DEFAULT_NODES: Required<PaymentFlowNodes> = {
  terminal: { label: "Checkout", meta: "Tap to pay", detail: "A card or phone is tapped on the reader", icon: <Nfc /> },
  processor: { label: "Stripe", meta: "Processor", detail: "Checks risk and forwards the request", icon: STRIPE, color: "#635BFF" },
  network: { label: "Mastercard", meta: "Card network", detail: "Routes it to the bank that issued the card", icon: MastercardMark },
  issuer: { label: "Bank", meta: "Card issuer", detail: "Checks the balance and holds the funds", icon: <Landmark /> },
  merchant: { label: "Your balance", detail: "Receives the payout, minus fees", icon: <Store /> },
};

/** Seconds, at speed 1. */
const TAP = 0.35;
const A0 = 0.95;
const HOP = 0.72;
const DWELL = 0.5;
const BANK = 0.9;
const RHOP = 0.64;
const RDWELL = 0.16;
const HOLD_AUTH = 1.1;
const GAP = 1.55;
const SHOP = 0.9;
const SDWELL = 0.45;
const FEE_DWELL = 0.7;
const SWAP = 0.3;
const COUNT = 0.9;
const HOLD = 1.9;
const RESET = 0.6;
const FADE = 0.6;
/** Below this width the diagram turns vertical: the chain on the left, the balance top right. */
const NARROW = 700;
const TOP = 10;
/** Below this width the balance card drops its mark and tightens its padding, so the label and the amount never truncate. */
const COMPACT = 140;

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const mod = (a: number, b: number) => ((a % b) + b) % b;
const ease = (t: number) => 0.5 - Math.cos(Math.PI * clamp(t)) / 2;
const easeOut = (t: number) => 1 - (1 - clamp(t)) ** 3;
/** A quick settle with a small overshoot, for the approval mark popping in. */
const snap = (t: number) => { const x = clamp(t) - 1, c1 = 1.1, c3 = c1 + 1; return 1 + c3 * x ** 3 + c1 * x ** 2; };
const isUrl = (value: string) => /^(\/|\.|https?:|data:|blob:)/.test(value);
const f2 = (v: number) => v.toFixed(2);

const subscribe = () => () => {};
function useReducedFlag() {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

/** The whole payment as a pure function of time, so the loop repeats exactly. */
function buildTimeline() {
  const hops: Hop[] = [];
  let t = A0;
  const arrive: number[] = [];
  for (let k = 0; k < 3; k++) {
    hops.push({ pill: 0, t0: t, dur: HOP, kind: "fwd", k });
    t += HOP;
    arrive.push(t);
    if (k < 2) t += DWELL;
  }
  const bankIn = t;
  const approve = t + BANK;
  t = approve;
  const back: number[] = [];
  for (let k = 2; k >= 0; k--) {
    hops.push({ pill: 1, t0: t, dur: RHOP, kind: "back", k });
    t += RHOP;
    back.push(t);
    if (k > 0) t += RDWELL;
  }
  const approved = t;
  const fadeAuth = approved + HOLD_AUTH;
  const s0 = approved + GAP;
  t = s0;
  /** The first rail hop is the longest run (down and around the corner), so it gets more time to keep the pace even. */
  hops.push({ pill: 2, t0: t, dur: SHOP * 1.3, kind: "rail", k: 0 });
  t += SHOP * 1.3;
  const atNet = t;
  t += SDWELL;
  hops.push({ pill: 2, t0: t, dur: SHOP * 0.85, kind: "rail", k: 1 });
  t += SHOP * 0.85;
  const atProc = t;
  const swap = atProc + 0.08;
  t += FEE_DWELL;
  hops.push({ pill: 3, t0: t, dur: SHOP, kind: "rail", k: 2 });
  t += SHOP;
  const settled = t;
  const T = settled + HOLD + RESET;
  const end = T - RESET;
  const life = [
    { from: A0, to: bankIn },
    { from: approve, to: approved },
    { from: s0, to: swap + SWAP },
    { from: swap, to: settled },
  ];
  const idle = (text: string | null = null): Phase => ({ at: 0, state: "idle", text });
  const phases: Phase[][] = [
    [idle(), { at: TAP, state: "active", text: "Card tapped" }, { at: A0 + 0.25, state: "active", text: "Authorizing" }, { at: approved - 0.1, state: "ok", text: "Approved" }],
    [idle(), { at: arrive[0] - 0.12, state: "active", text: "Checking risk" }, { at: arrive[0] + DWELL, state: "done", text: "Risk checked" }, { at: atProc - 0.1, state: "active", text: "fee" }, { at: atProc + FEE_DWELL, state: "done", text: "fee" }],
    [idle(), { at: arrive[1] - 0.12, state: "active", text: "Routing" }, { at: arrive[1] + DWELL, state: "done", text: "Routed to bank" }, { at: atNet - 0.1, state: "active", text: "Clearing" }, { at: atNet + SDWELL, state: "done", text: "Cleared" }],
    [idle(), { at: arrive[2] - 0.12, state: "active", text: "Checking funds" }, { at: approve, state: "ok", text: "Approved" }, { at: approve + 0.9, state: "done", text: "Funds held" }, { at: s0 - 0.05, state: "active", text: "Settling" }, { at: s0 + SHOP * 0.5, state: "ok", text: "Settled" }],
    [idle(), { at: swap + SWAP, state: "active", text: null }, { at: settled - 0.08, state: "ok", text: null }],
  ];
  phases.forEach(list => list.push({ at: end, state: "idle", text: null }));
  /** Reduced motion rests just after the fee: approved, cleared, and the net amount on its way to the balance. */
  const still = swap + SWAP + 0.15;
  /** Moments where a node's status line changes its words, so the line can dip out and back in around each swap. */
  const changes = phases.map(list => {
    const out: number[] = [];
    let prev = list[list.length - 1].text;
    for (const ph of list) { if (ph.text !== prev) out.push(ph.at); prev = ph.text; }
    return out;
  });
  return { hops, life, phases, changes, T, end, approve, approved, fadeAuth, s0, atNet, atProc, swap, settled, still };
}


type Part = { kind: "line"; a: Pt; b: Pt } | { kind: "quad"; a: Pt; c: Pt; b: Pt };

/** Samples lines and rounded corners into one path with a length table, so points along it cost a binary search. */
function build(parts: Part[]) {
  const xs: number[] = [], ys: number[] = [], acc: number[] = [];
  const marks: number[] = [];
  let d = "";
  const push = (x: number, y: number) => {
    const i = xs.length;
    acc.push(i ? acc[i - 1] + Math.hypot(x - xs[i - 1], y - ys[i - 1]) : 0);
    xs.push(x); ys.push(y);
  };
  parts.forEach((p, i) => {
    if (i === 0) { d = `M${f2(p.a.x)} ${f2(p.a.y)}`; push(p.a.x, p.a.y); }
    if (p.kind === "line") {
      d += ` L${f2(p.b.x)} ${f2(p.b.y)}`;
      push(p.b.x, p.b.y);
    } else {
      d += ` Q${f2(p.c.x)} ${f2(p.c.y)} ${f2(p.b.x)} ${f2(p.b.y)}`;
      for (let j = 1; j <= 12; j++) {
        const t = j / 12, u = 1 - t;
        push(u * u * p.a.x + 2 * u * t * p.c.x + t * t * p.b.x, u * u * p.a.y + 2 * u * t * p.c.y + t * t * p.b.y);
      }
    }
    marks.push(acc[acc.length - 1]);
  });
  const curve: Curve = { d, xs: Float32Array.from(xs), ys: Float32Array.from(ys), acc: Float32Array.from(acc), len: acc[acc.length - 1] || 1 };
  return { curve, marks };
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

const lineD = (a: Pt, b: Pt) => `M${f2(a.x)} ${f2(a.y)} L${f2(b.x)} ${f2(b.y)}`;

function buildGeometry(w: number) {
  const narrow = w < NARROW;
  const chips: Rect[] = [];
  let merchant: Rect, h: number;
  let railParts: Part[];
  const stubs: { a: Pt; b: Pt }[] = [];
  const waypoints: Pt[] = [];
  const corner = 18;
  if (!narrow) {
    /** Even widths on whole pixels, so every border and every wire through a chip center lands crisp. */
    const cw = 2 * Math.round(clamp(w * 0.18, 150, 196) / 2), ch = 60;
    const gap = (w - 2 - 4 * cw) / 3;
    for (let k = 0; k < 4; k++) chips.push({ x: Math.round(1 + k * (cw + gap)), y: TOP, w: cw, h: ch });
    merchant = { x: 1, y: TOP + ch + 56, w: cw, h: ch };
    const cx = (r: Rect) => r.x + r.w / 2;
    const cy = TOP + ch / 2, my = merchant.y + ch / 2;
    const bx = cx(chips[3]);
    const net = { x: cx(chips[2]), y: my }, proc = { x: cx(chips[1]), y: my };
    waypoints.push(net, proc);
    stubs.push({ a: { x: net.x, y: TOP + ch }, b: { x: net.x, y: my - 4 } }, { a: { x: proc.x, y: TOP + ch }, b: { x: proc.x, y: my - 4 } });
    railParts = [
      { kind: "line", a: { x: bx, y: cy }, b: { x: bx, y: my - corner } },
      { kind: "quad", a: { x: bx, y: my - corner }, c: { x: bx, y: my }, b: { x: bx - corner, y: my } },
      { kind: "line", a: { x: bx - corner, y: my }, b: net },
      { kind: "line", a: net, b: proc },
      { kind: "line", a: proc, b: { x: cx(merchant), y: my } },
    ];
    h = merchant.y + ch + 1;
  } else {
    /** Half the width leaves the balance card room for its label on a phone; the smallest screens favor the chain. */
    const cw = 2 * Math.round(Math.min(w * (w < 300 ? 0.56 : 0.5), 240) / 2), ch = 56, gap = 52;
    for (let k = 0; k < 4; k++) chips.push({ x: 1, y: TOP + k * (ch + gap), w: cw, h: ch });
    const mx0 = 1 + cw + 14;
    merchant = { x: mx0, y: TOP, w: w - 1 - mx0, h: ch };
    const cx = 1 + cw / 2, mx = Math.round(merchant.x + merchant.w / 2);
    const cyOf = (k: number) => chips[k].y + ch / 2;
    const net = { x: mx, y: cyOf(2) }, proc = { x: mx, y: cyOf(1) };
    waypoints.push(net, proc);
    stubs.push({ a: { x: 1 + cw, y: net.y }, b: { x: mx - 4, y: net.y } }, { a: { x: 1 + cw, y: proc.y }, b: { x: mx - 4, y: proc.y } });
    const by = cyOf(3);
    railParts = [
      { kind: "line", a: { x: cx, y: by }, b: { x: mx - corner, y: by } },
      { kind: "quad", a: { x: mx - corner, y: by }, c: { x: mx, y: by }, b: { x: mx, y: by - corner } },
      { kind: "line", a: { x: mx, y: by - corner }, b: net },
      { kind: "line", a: net, b: proc },
      { kind: "line", a: proc, b: { x: mx, y: TOP + ch / 2 } },
    ];
    h = chips[3].y + ch + 1;
  }
  const centers = chips.map(r => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 }));
  const authParts: Part[] = [0, 1, 2].map(k => ({ kind: "line", a: centers[k], b: centers[k + 1] }));
  const auth = build(authParts);
  const rail = build(railParts);
  /** Distances along the auth line where each chip is centered, and along the rail where the two waypoints sit. */
  const stops = [0, ...auth.marks];
  const railStops = [rail.marks[2], rail.marks[3]];
  const segs = [0, 1, 2].map(k => lineD(centers[k], centers[k + 1]));
  const railSegs = [
    build(railParts.slice(0, 3)).curve.d,
    lineD(railParts[3].a, (railParts[3] as { b: Pt }).b),
    lineD(railParts[4].a, (railParts[4] as { b: Pt }).b),
  ];
  /** Where the auth wire and the rail cross a chip edge, drawn as small ports. */
  const ports: Pt[] = [];
  for (let k = 0; k < 3; k++) {
    const a = chips[k], b = chips[k + 1];
    if (!narrow) ports.push({ x: a.x + a.w, y: centers[k].y }, { x: b.x, y: centers[k + 1].y });
    else ports.push({ x: centers[k].x, y: a.y + a.h }, { x: centers[k + 1].x, y: b.y });
  }
  if (!narrow) ports.push({ x: centers[3].x, y: chips[3].y + chips[3].h }, { x: merchant.x + merchant.w, y: merchant.y + merchant.h / 2 });
  else ports.push({ x: chips[3].x + chips[3].w, y: centers[3].y }, { x: merchant.x + merchant.w / 2, y: merchant.y + merchant.h });
  stubs.forEach(s => ports.push(s.a));
  return { w, h, narrow, compact: merchant.w < COMPACT, chips, merchant, centers, auth: auth.curve, rail: rail.curve, stops, railStops, segs, railSegs, stubs, waypoints, ports };
}

type Geometry = ReturnType<typeof buildGeometry>;

function Mark({ node }: { node: PaymentFlowNode }) {
  const { icon, color } = node;
  if (icon == null) return null;
  if (typeof icon === "string") {
    // eslint-disable-next-line @next/next/no-img-element
    if (isUrl(icon)) return <img className={styles.mark} src={icon} alt="" draggable={false} />;
    return <svg className={styles.mark} viewBox="0 0 24 24" aria-hidden="true"><path d={icon} fill={color ?? "currentColor"} /></svg>;
  }
  return <span className={styles.mark} aria-hidden="true">{icon}</span>;
}

/** Wires each node lights while hovered: auth segments, rail segments, and settlement stubs. */
const LINKS: { seg: number[]; rail: number[]; stub: number[] }[] = [
  { seg: [0], rail: [], stub: [] },
  { seg: [0, 1], rail: [], stub: [1] },
  { seg: [1, 2], rail: [], stub: [0] },
  { seg: [2], rail: [0], stub: [] },
  { seg: [], rail: [2], stub: [] },
];

export function PaymentFlow({
  nodes: nodesProp,
  amount = 42.5,
  fee = 1.53,
  balance = 1284.1,
  currency = "USD",
  locale = "en-US",
  authorizationMs = 1340,
  labels,
  hideSteps = false,
  speed = 1,
  paused = false,
  accent,
  label,
  caption,
  className,
  style,
}: PaymentFlowProps) {
  const reduced = useReducedFlag();
  const stageRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [focus, setFocus] = useState<number | null>(null);

  const nodes = useMemo(() => [
    { ...DEFAULT_NODES.terminal, ...nodesProp?.terminal },
    { ...DEFAULT_NODES.processor, ...nodesProp?.processor },
    { ...DEFAULT_NODES.network, ...nodesProp?.network },
    { ...DEFAULT_NODES.issuer, ...nodesProp?.issuer },
    { ...DEFAULT_NODES.merchant, ...nodesProp?.merchant },
  ], [nodesProp]);

  const money = useMemo(() => new Intl.NumberFormat(locale, { style: "currency", currency }), [locale, currency]);
  const gross = Math.max(0, amount);
  const cut = clamp(fee, 0, gross);
  const net = gross - cut;
  const approvedText = labels?.approved ?? "Approved";
  const authLabel = labels?.authorization ?? "Authorization";
  const settleLabel = labels?.settlement ?? "Settlement";
  const settleTime = labels?.settlementTime ?? "Next business day";

  const timeline = useMemo(() => buildTimeline(), []);
  const geometry = useMemo(() => (width > 0 ? buildGeometry(width) : null), [width]);

  const els = useRef({
    pill: [] as (HTMLSpanElement | null)[],
    authLit: null as SVGPathElement | null,
    okLit: null as SVGPathElement | null,
    railLit: null as SVGPathElement | null,
    tap: [] as (SVGRectElement | null)[],
    waypoint: [] as (SVGCircleElement | null)[],
    stub: [] as (SVGPathElement | null)[],
    check: null as SVGGElement | null,
    chip: [] as (HTMLDivElement | null)[],
    status: [] as (HTMLSpanElement | null)[],
    step: [] as (HTMLDivElement | null)[],
    stepMeta: null as HTMLSpanElement | null,
    fill: [] as (HTMLSpanElement | null)[],
  });

  const sim = useRef({
    t: 0, rate: NaN, rateV: 0, frame: 0, running: false, visible: true,
    dims: [{ w: 64, h: 24 }, { w: 96, h: 24 }, { w: 64, h: 24 }, { w: 64, h: 24 }],
    cache: new Map<Element, Record<string, string>>(), text: new Map<Element, string>(),
  });
  const target = paused ? 0 : Math.max(0, speed) * (focus !== null ? 0.6 : 1);
  const live = useRef({ geometry, timeline, target, reduced, nodes, money, gross, cut, net, balance, authorizationMs });
  useLayoutEffect(() => { live.current = { geometry, timeline, target, reduced, nodes, money, gross, cut, net, balance, authorizationMs }; });

  /** Writes an attribute or style value only when it changed, so resting elements cost nothing per frame. */
  const put = useCallback((node: Element | null | undefined, key: string, value: string) => {
    if (!node) return;
    const cache = sim.current.cache;
    let entry = cache.get(node);
    if (!entry) { entry = {}; cache.set(node, entry); }
    if (entry[key] === value) return;
    entry[key] = value;
    if (key.startsWith("style:")) (node as HTMLElement).style.setProperty(key.slice(6), value);
    else node.setAttribute(key, value);
  }, []);

  const text = useCallback((node: Element | null | undefined, value: string) => {
    if (!node || sim.current.text.get(node) === value) return;
    sim.current.text.set(node, value);
    node.textContent = value;
  }, []);

  const paint = useCallback((time: number, still = false) => {
    const { geometry: g, timeline: tl, nodes: ns, money: fmt, cut: feeValue, net: payout, balance: start, authorizationMs: ms } = live.current;
    if (!g) return;
    const e = els.current, dims = sim.current.dims;
    const { T } = tl;
    const u = mod(time, T);
    const loops = Math.floor(time / T);

    /** Half the chip along the direction of travel, and the pill's half extent the same way, so pills hide inside chips. */
    const along = (pill: number, vertical: boolean) => (vertical ? dims[pill].h : dims[pill].w) / 2 + 1;
    const chipHalf = (vertical: boolean, r: Rect) => (vertical ? r.h : r.w) / 2;
    const hopRange = (hop: Hop): [number, number] => {
      if (hop.kind !== "rail") {
        const inset = chipHalf(g.narrow, g.chips[0]) - along(hop.pill, g.narrow);
        const a = g.stops[hop.k] + inset, b = g.stops[hop.k + 1] - inset;
        return hop.kind === "fwd" ? [a, b] : [b, a];
      }
      if (hop.k === 0) return [chipHalf(!g.narrow, g.chips[3]) - along(hop.pill, !g.narrow), g.railStops[0]];
      if (hop.k === 1) return [g.railStops[0], g.railStops[1]];
      return [g.railStops[1], g.rail.len - (chipHalf(g.narrow, g.merchant) - along(hop.pill, g.narrow))];
    };
    /** Where a pill is on its path at this moment: in a hop, or resting at the end of its last one. */
    const pillAt = (pill: number) => {
      let current: Hop | null = null, first: Hop | null = null;
      for (const hop of tl.hops) {
        if (hop.pill !== pill) continue;
        if (!first) first = hop;
        if (hop.t0 <= u) current = hop;
      }
      const hop = current ?? first!;
      const [a, b] = hopRange(hop);
      const p = current ? ease((u - hop.t0) / hop.dur) : 0;
      return { s: a + (b - a) * p, rail: hop.kind === "rail" };
    };

    /** Two soft rings leave the checkout chip when the card is tapped. */
    const c0 = g.chips[0];
    e.tap.forEach((rect, i) => {
      const q = (u - TAP - i * 0.2) / 0.95;
      if (q < 0 || q >= 1 || still) { put(rect, "opacity", "0"); return; }
      const o = 2 + 14 * easeOut(q);
      put(rect, "x", f2(c0.x - o)); put(rect, "y", f2(c0.y - o));
      put(rect, "width", f2(c0.w + 2 * o)); put(rect, "height", f2(c0.h + 2 * o));
      put(rect, "rx", f2(16 + o));
      put(rect, "opacity", (0.5 * clamp(q / 0.08) * (1 - q) ** 2).toFixed(3));
    });

    /** Pills: the amount, the approval, then the settlement amount before and after the fee. */
    const pos: { s: number; rail: boolean }[] = [];
    for (let p = 0; p < 4; p++) {
      const node = e.pill[p];
      const life = tl.life[p];
      const at = pillAt(p);
      pos[p] = at;
      const inLife = u >= life.from && u <= life.to;
      if (!inLife) { put(node, "style:opacity", "0"); continue; }
      const pt = pointAt(at.rail ? g.rail : g.auth, at.s);
      let alpha = 1, scale = 1;
      if (p === 2) { const q = ease((u - tl.swap) / SWAP); alpha = 1 - q; scale = 1 - 0.12 * q; }
      if (p === 3) { const q = ease((u - tl.swap) / SWAP); alpha = q; scale = 0.88 + 0.12 * q; }
      put(node, "style:transform", `translate(${f2(pt.x)}px, ${f2(pt.y)}px) translate(-50%, -50%) scale(${scale.toFixed(3)})`);
      put(node, "style:opacity", alpha.toFixed(3));
    }

    /** The active path: lit in the accent behind the amount, then painted in success as the approval travels back. */
    const authFade = still ? 0 : clamp((u - tl.fadeAuth) / FADE);
    const L = g.auth.len;
    const authS = u < A0 ? 0 : u >= tl.life[0].to ? L : pos[0].s;
    put(e.authLit, "stroke-dasharray", `${f2((authS / L) * 1000)} 2000`);
    put(e.authLit, "opacity", u < A0 ? "0" : (1 - authFade).toFixed(3));
    const okS = u < tl.approve ? L : u >= tl.approved ? 0 : pos[1].s;
    put(e.okLit, "stroke-dasharray", `0 ${f2((okS / L) * 1000)} 1000 2000`);
    put(e.okLit, "opacity", u < tl.approve ? "0" : (1 - authFade).toFixed(3));

    /** The settlement rail lights behind the funds and fades after the payout lands. */
    const R = g.rail.len;
    const railS = u < tl.s0 ? 0 : u >= tl.settled ? R : (u >= tl.swap ? pos[3].s : pos[2].s);
    const railFade = clamp((u - tl.settled - 1.1) / FADE);
    put(e.railLit, "stroke-dasharray", `${f2((railS / R) * 1000)} 2000`);
    put(e.railLit, "opacity", u < tl.s0 ? "0" : (1 - railFade).toFixed(3));
    const settling = u >= tl.s0 && u < tl.settled + 1.1;
    [tl.atNet, tl.atProc].forEach((at, i) => {
      const on = settling && u >= at - 0.08 ? "true" : "false";
      put(e.waypoint[i], "data-lit", on);
      put(e.stub[i], "data-lit", on);
    });

    /** A success mark pops on the checkout chip when the approval arrives. */
    const m = (u - tl.approved) / 1.5;
    if (m >= 0 && m < 1 && !still) {
      const r = g.chips[0];
      const s = 0.55 + 0.45 * snap(m * 3.2);
      put(e.check, "transform", `translate(${f2(r.x + r.w - 8)} ${f2(r.y + 1 - 4 * easeOut(m))}) scale(${s.toFixed(3)})`);
      put(e.check, "opacity", Math.min(clamp(m / 0.08), clamp((1 - m) / 0.3)).toFixed(3));
    } else put(e.check, "opacity", "0");

    /** Node status lines. Each swap of words dips the line out and back in over a few frames instead of cutting. */
    const dip = (k: number) => {
      if (still) return 1;
      let o = 1;
      for (const c of tl.changes[k]) {
        const d = Math.abs(u - c), near = Math.min(d, T - d);
        o = Math.min(o, clamp(near / 0.13));
      }
      return o * o * (3 - 2 * o);
    };
    const credited = u >= tl.settled ? ease((u - tl.settled) / COUNT) : 0;
    ns.forEach((node, k) => {
      const list = tl.phases[k];
      let ph = list[0];
      for (const x of list) if (x.at <= u) ph = x;
      put(e.chip[k], "data-state", ph.state);
      if (k === 4) { text(e.status[k], fmt.format(start + payout * (loops + credited))); return; }
      text(e.status[k], ph.text === "fee" ? `Fee ${fmt.format(feeValue)}` : ph.text ?? node.meta ?? "");
      put(e.status[k], "style:opacity", dip(k).toFixed(3));
    });

    /** The step row: authorization counts its time, settlement fills as the funds move. */
    const authP = clamp((u - A0) / (tl.approved - A0));
    const setP = clamp((u - tl.s0) / (tl.settled - tl.s0));
    const rest = 1 - clamp((u - tl.end) / 0.4);
    put(e.fill[0], "style:transform", `scaleX(${(authP * rest).toFixed(4)})`);
    put(e.fill[1], "style:transform", `scaleX(${(setP * rest).toFixed(4)})`);
    put(e.step[0], "data-state", u >= tl.end ? "idle" : u >= tl.approved ? "done" : u >= A0 ? "active" : "idle");
    put(e.step[1], "data-state", u >= tl.end ? "idle" : u >= tl.settled ? "done" : u >= tl.s0 ? "active" : "idle");
    text(e.stepMeta, `${((u >= tl.end ? 0 : authP) * ms / 1000).toFixed(2)} s`);
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

  /** Repaint whenever layout changes, then run or rest the loop. Caches clear because new elements mounted. */
  useLayoutEffect(() => {
    const s = sim.current;
    s.cache = new Map();
    s.text = new Map();
    els.current.pill.forEach((pill, i) => { if (pill && pill.offsetWidth) s.dims[i] = { w: pill.offsetWidth, h: pill.offsetHeight }; });
    paint(reduced ? timeline.still : s.t, reduced);
    if (!reduced) loop();
  }, [geometry, timeline, reduced, target, hideSteps, nodes, money, gross, cut, balance, approvedText, paint, loop]);

  useEffect(() => {
    const node = stageRef.current, s = sim.current;
    if (!node) return;
    /** Runs only while the diagram is on screen and the tab is shown; both conditions are tracked on their own. */
    let onScreen = true, alive = true;
    const sync = () => {
      s.visible = onScreen && !document.hidden;
      if (s.visible) loop(); else { cancelAnimationFrame(s.frame); s.running = false; }
    };
    const observer = new IntersectionObserver(([entry]) => { onScreen = entry.isIntersecting; sync(); });
    observer.observe(node);
    document.addEventListener("visibilitychange", sync);
    /** Webfonts can widen the moving chips after the first measure; measure again once they are in. */
    document.fonts?.ready.then(() => {
      if (!alive) return;
      els.current.pill.forEach((pill, i) => { if (pill && pill.offsetWidth) s.dims[i] = { w: pill.offsetWidth, h: pill.offsetHeight }; });
    });
    return () => { alive = false; observer.disconnect(); document.removeEventListener("visibilitychange", sync); cancelAnimationFrame(s.frame); s.running = false; };
  }, [loop]);

  const [terminal, processor, network, , merchant] = nodes;
  const aria = label ?? `Card payment flow. A ${money.format(gross)} card tap at ${terminal.label} goes to ${processor.label}, then the ${network.label} network, then the issuing bank, which approves it and holds the funds. The approval travels back to ${terminal.label} in about ${(authorizationMs / 1000).toFixed(1)} seconds. At settlement the funds clear through ${network.label} and ${processor.label}, which keeps a ${money.format(cut)} fee, and ${money.format(net)} reaches ${merchant.label.toLowerCase()}.`;

  const hover = (id: number) => ({
    onPointerEnter: (ev: ReactPointerEvent) => { if (ev.pointerType === "mouse") setFocus(id); },
    onPointerLeave: () => setFocus(current => (current === id ? null : current)),
  });

  const g: Geometry | null = geometry;
  const rootStyle = { ...style, ...(accent ? { "--pf-accent": accent } : null) } as CSSProperties;
  const link = focus === null ? null : LINKS[focus];
  const rects = g ? [...g.chips, g.merchant] : [];
  const tagPlace = (k: number) => (!g ? "below" : g.narrow ? (k === 3 ? "above" : "below") : k === 4 ? "above" : "below");
  const tagEdge = (k: number) => (!g ? undefined : g.narrow ? (k === 4 ? "end" : "start") : k === 0 || k === 4 ? "start" : k === 3 ? "end" : undefined);

  return <figure
    className={[styles.root, className].filter(Boolean).join(" ")}
    style={rootStyle}
    data-ready={g ? true : undefined}
    data-layout={g?.narrow ? "narrow" : "wide"}
  >
    <div className={styles.diagram} role="img" aria-label={aria}>
      <div ref={stageRef} className={styles.stage} style={g ? { height: g.h } : undefined}>
        {g && <>
          <svg className={styles.layer} viewBox={`0 0 ${g.w} ${g.h}`} width={g.w} height={g.h} aria-hidden="true">
            {g.segs.map((d, k) => <path key={`seg-${k}`} className={styles.wire} data-on={link?.seg.includes(k) || undefined} d={d} />)}
            {g.railSegs.map((d, k) => <path key={`rail-${k}`} className={styles.wire} data-on={link?.rail.includes(k) || undefined} d={d} />)}
            {g.stubs.map((s, k) => <path key={`stub-${k}`} ref={el => { els.current.stub[k] = el; }} className={styles.stub} data-on={link?.stub.includes(k) || undefined} data-lit="false" d={lineD(s.a, s.b)} />)}
            <path ref={el => { els.current.authLit = el; }} className={styles.lit} d={g.auth.d} pathLength={1000} opacity={0} />
            <path ref={el => { els.current.okLit = el; }} className={styles.okLit} d={g.auth.d} pathLength={1000} opacity={0} />
            <path ref={el => { els.current.railLit = el; }} className={styles.lit} d={g.rail.d} pathLength={1000} opacity={0} />
            {g.ports.map((p, k) => <circle key={`port-${k}`} className={styles.port} cx={p.x} cy={p.y} r={2.75} />)}
            {g.waypoints.map((p, k) => <circle key={`way-${k}`} ref={el => { els.current.waypoint[k] = el; }} className={styles.waypoint} data-lit="false" cx={p.x} cy={p.y} r={4} />)}
            {[0, 1].map(i => <rect key={`tap-${i}`} ref={el => { els.current.tap[i] = el; }} className={styles.tap} opacity={0} />)}
          </svg>

          <span ref={el => { els.current.pill[0] = el; }} className={styles.pill} style={{ opacity: 0 }}>{money.format(gross)}</span>
          <span ref={el => { els.current.pill[1] = el; }} className={styles.pill} data-tone="ok" style={{ opacity: 0 }}>
            <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.6 6.3 L5 8.6 L9.4 3.6" /></svg>
            {approvedText}
          </span>
          <span ref={el => { els.current.pill[2] = el; }} className={styles.pill} style={{ opacity: 0 }}>{money.format(gross)}</span>
          <span ref={el => { els.current.pill[3] = el; }} className={styles.pill} style={{ opacity: 0 }}>{money.format(net)}</span>

          {rects.map((r, k) => {
            const node = nodes[k];
            return <div
              key={`chip-${k}`}
              ref={el => { els.current.chip[k] = el; }}
              className={styles.chip}
              data-state="idle"
              data-on={focus === k || undefined}
              data-edge={tagEdge(k)}
              data-compact={(k === 4 && g.compact) || undefined}
              style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
              {...hover(k)}
            >
              <Mark node={node} />
              <span className={styles.text}>
                <span className={styles.label}>{node.label}</span>
                <span className={styles.meta}><span className={styles.health} /><span ref={el => { els.current.status[k] = el; }}>{k === 4 ? money.format(balance) : node.meta}</span></span>
              </span>
              {node.detail && <span className={styles.tag} data-place={tagPlace(k)} aria-hidden="true">{node.detail}</span>}
            </div>;
          })}

          <svg className={styles.layer} viewBox={`0 0 ${g.w} ${g.h}`} width={g.w} height={g.h} aria-hidden="true">
            <g ref={el => { els.current.check = el; }} opacity={0}>
              <circle className={styles.checkDisc} r={8} />
              <path className={styles.checkGlyph} d="M-3.3 0.2 L-1 2.5 L3.4 -2" />
            </g>
          </svg>
        </>}
      </div>

      {!hideSteps && <div className={styles.steps} aria-hidden="true">
        <div ref={el => { els.current.step[0] = el; }} className={styles.step} data-state="idle">
          <span className={styles.stepHead}>
            <span className={styles.stepLabel}>{authLabel}</span>
            <span ref={el => { els.current.stepMeta = el; }} className={styles.stepMeta}>0.00 s</span>
          </span>
          <span className={styles.track}><span ref={el => { els.current.fill[0] = el; }} className={styles.fill} /></span>
        </div>
        <div ref={el => { els.current.step[1] = el; }} className={styles.step} data-state="idle">
          <span className={styles.stepHead}>
            <span className={styles.stepLabel}>{settleLabel}</span>
            <span className={styles.stepMeta}>{settleTime}</span>
          </span>
          <span className={styles.track}><span ref={el => { els.current.fill[1] = el; }} className={styles.fill} /></span>
        </div>
      </div>}
    </div>
    {caption && <figcaption className={styles.figcaption}>{caption}</figcaption>}
  </figure>;
}

export default PaymentFlow;
