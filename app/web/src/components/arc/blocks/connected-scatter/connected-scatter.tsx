"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { AnimatePresence, animate, motion, motionValue, useReducedMotion, type AnimationPlaybackControls, type MotionValue } from "motion/react";
import { Pause, Play, RotateCcw } from "lucide-react";
import { motionTokens } from "../../lib/motion-tokens";
import { Button } from "../../button/button";
import SegmentedControl from "../../segmented-control/segmented-control";
import { SERIES, TARGET_RATIO, X_AXIS, Y_AXIS, type LabelSide, type ScatterAxis, type ScatterSeries } from "./connected-scatter-data";
import styles from "./connected-scatter.module.css";

export type { LabelSide, ScatterAxis, ScatterNote, ScatterPoint, ScatterSeries } from "./connected-scatter-data";
export { MONTHS, SERIES, TARGET_RATIO, X_AXIS, Y_AXIS } from "./connected-scatter-data";

export interface ConnectedScatterProps {
  /** Series to switch between. Every series needs the same number of points, in time order. */
  series?: ScatterSeries[];
  /** Id of the series shown first. Defaults to the first series. */
  defaultSeries?: string;
  /** Horizontal axis: the cost side of the ratio. */
  xAxis?: ScatterAxis;
  /** Vertical axis: the value side of the ratio. */
  yAxis?: ScatterAxis;
  /** The reference line is y = targetRatio times x; the region above it is shaded as healthy. */
  targetRatio?: number;
  /** Formats axis values in the readout, tooltip and table. Defaults to whole US dollars. */
  formatValue?: (value: number) => string;
  /** Block heading. */
  title?: string;
  /** One line under the heading. */
  description?: string;
  /** Called with the month index whenever the scrubber settles on a month. */
  onMonthChange?: (index: number) => void;
  className?: string;
}

type Size = { w: number; h: number };
type Pt = { x: number; y: number };
type Geo = Size & { sx: (v: number) => number; sy: (v: number) => number; bottom: number; right: number };
type Track = { d: string; xs: Float64Array; ys: Float64Array; cum: Float64Array; mids: { x: number; y: number; r: number; len: number }[] };

/** Everything that moves per frame lives in motion values, so scrubbing, playing and morphing never re-render React. */
type Live = {
  d: MotionValue<string>; trail: MotionValue<number>; ghost: MotionValue<number>;
  hx: MotionValue<number>; hy: MotionValue<number>; vLen: MotionValue<number>; hLen: MotionValue<number>;
  dots: { x: MotionValue<number>; y: MotionValue<number>; on: MotionValue<number> }[];
  arrows: { x: MotionValue<number>; y: MotionValue<number>; r: MotionValue<number>; on: MotionValue<number> }[];
  xv: MotionValue<string>; yv: MotionValue<string>; ratio: MotionValue<string>;
  thumb: MotionValue<string>; fill: MotionValue<number>;
};

/** Mutable model behind the frame loop: the series blend and the traced path at the current size. */
type Engine = { from: Pt[]; to: Pt[]; k: number; data: Pt[]; track: Track | null };

const { spring, duration, ease, stagger } = motionTokens;
const PAD = { l: 44, r: 16, t: 14, b: 30 };
const DEFAULT_SIZE: Size = { w: 760, h: 380 };
const SAMPLES = 24;
const TENSION = 1 / 6;
/** Seconds per month while playing, and per month for the draw in. */
const PLAY_STEP = duration.standard;
const INTRO_STEP = stagger.line;
const HIT_RADIUS = 30;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** Screen coordinates round to 1/100 px so the server and the browser print identical attributes. */
const px2 = (v: number) => Math.round(v * 100) / 100;
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const defaultFormat = (v: number) => dollars.format(Math.round(v));
const ratioText = (r: number) => `${r.toFixed(1)}x`;
const compact = (v: number, format: (v: number) => string) => (v >= 1000 && v % 1000 === 0 ? `${format(v / 1000)}k` : format(v));

function geometry(size: Size, xAxis: ScatterAxis, yAxis: ScatterAxis): Geo {
  const iw = Math.max(size.w - PAD.l - PAD.r, 1);
  const ih = Math.max(size.h - PAD.t - PAD.b, 1);
  return {
    ...size,
    sx: v => px2(PAD.l + ((v - xAxis.min) / (xAxis.max - xAxis.min)) * iw),
    sy: v => px2(PAD.t + (1 - (v - yAxis.min) / (yAxis.max - yAxis.min)) * ih),
    bottom: PAD.t + ih,
    right: PAD.l + iw,
  };
}

/** A Catmull-Rom curve through every month, written as cubic Béziers, then sampled so a time maps to a point and a share of the length. */
function buildTrack(p: Pt[]): Track {
  const n = p.length;
  const segs = Math.max(n - 1, 1);
  const count = segs * SAMPLES + 1;
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const cum = new Float64Array(count);
  const mids: Track["mids"] = [];
  let d = n ? `M${p[0].x.toFixed(2)} ${p[0].y.toFixed(2)}` : "";
  if (n) { xs[0] = p[0].x; ys[0] = p[0].y; }
  for (let i = 0; i < n - 1; i++) {
    const p0 = p[i - 1] ?? p[i];
    const p1 = p[i];
    const p2 = p[i + 1];
    const p3 = p[i + 2] ?? p[i + 1];
    const c1 = { x: p1.x + (p2.x - p0.x) * TENSION, y: p1.y + (p2.y - p0.y) * TENSION };
    const c2 = { x: p2.x - (p3.x - p1.x) * TENSION, y: p2.y - (p3.y - p1.y) * TENSION };
    d += `C${c1.x.toFixed(2)} ${c1.y.toFixed(2)} ${c2.x.toFixed(2)} ${c2.y.toFixed(2)} ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
    const at = (u: number) => {
      const a = 1 - u;
      return {
        x: a * a * a * p1.x + 3 * a * a * u * c1.x + 3 * a * u * u * c2.x + u * u * u * p2.x,
        y: a * a * a * p1.y + 3 * a * a * u * c1.y + 3 * a * u * u * c2.y + u * u * u * p2.y,
      };
    };
    const segStart = i * SAMPLES;
    for (let s = 1; s <= SAMPLES; s++) {
      const q = at(s / SAMPLES);
      const j = segStart + s;
      xs[j] = q.x;
      ys[j] = q.y;
      cum[j] = cum[j - 1] + Math.hypot(q.x - xs[j - 1], q.y - ys[j - 1]);
    }
    const m = at(0.5);
    const a = at(0.45);
    const b = at(0.55);
    mids.push({ x: px2(m.x), y: px2(m.y), r: px2((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI), len: cum[segStart + SAMPLES] - cum[segStart] });
  }
  return { d, xs, ys, cum, mids };
}

function headAt(track: Track, t: number, n: number) {
  const i = Math.min(Math.floor(t), Math.max(n - 2, 0));
  const f = clamp((t - i) * SAMPLES, 0, SAMPLES);
  const j = Math.min(Math.floor(f), SAMPLES - 1);
  const a = i * SAMPLES + j;
  const b = Math.min(a + 1, track.xs.length - 1);
  const w = f - j;
  const total = track.cum[track.cum.length - 1] || 1;
  return {
    x: track.xs[a] + (track.xs[b] - track.xs[a]) * w,
    y: track.ys[a] + (track.ys[b] - track.ys[a]) * w,
    frac: (track.cum[a] + (track.cum[b] - track.cum[a]) * w) / total,
  };
}

function createLive(n: number): Live {
  const mv = <T,>(v: T) => motionValue(v);
  return {
    d: mv(""), trail: mv(0), ghost: mv(0), hx: mv(0), hy: mv(0), vLen: mv(0), hLen: mv(0),
    dots: Array.from({ length: n }, () => ({ x: mv(0), y: mv(0), on: mv(0) })),
    arrows: Array.from({ length: Math.max(n - 1, 0) }, () => ({ x: mv(0), y: mv(0), r: mv(0), on: mv(0) })),
    xv: mv(""), yv: mv(""), ratio: mv(""), thumb: mv("0%"), fill: mv(0),
  };
}

/** Writes one frame. `rebuild` retraces the path, needed only while the series morphs or the plot resizes. */
function paint(live: Live, eng: Engine, geo: Geo, t: number, rebuild: boolean, format: (v: number) => string) {
  const n = eng.to.length;
  if (!n) return;
  if (rebuild || !eng.track) {
    eng.data = eng.to.map((p, i) => {
      const f = eng.from[i] ?? p;
      return { x: f.x + (p.x - f.x) * eng.k, y: f.y + (p.y - f.y) * eng.k };
    });
    const screen = eng.data.map(p => ({ x: geo.sx(p.x), y: geo.sy(p.y) }));
    eng.track = buildTrack(screen);
    live.d.set(eng.track.d);
    screen.forEach((p, i) => { live.dots[i]?.x.set(p.x); live.dots[i]?.y.set(p.y); });
    eng.track.mids.forEach((m, i) => { live.arrows[i]?.x.set(m.x); live.arrows[i]?.y.set(m.y); live.arrows[i]?.r.set(m.r); });
  }
  const tc = clamp(t, 0, n - 1);
  const head = headAt(eng.track, tc, n);
  live.hx.set(px2(head.x));
  live.hy.set(px2(head.y));
  live.trail.set(head.frac);
  live.vLen.set(Math.max(px2(geo.bottom - head.y), 0));
  live.hLen.set(Math.max(px2(head.x - PAD.l), 0));
  live.dots.forEach((dot, i) => dot.on.set(tc >= i - 1e-3 ? 1 : 0));
  live.arrows.forEach((arrow, i) => arrow.on.set(tc >= i + 0.5 ? 1 : 0));
  const i = Math.min(Math.floor(tc), Math.max(n - 2, 0));
  const u = n > 1 ? tc - i : 0;
  const a = eng.data[i];
  const b = eng.data[Math.min(i + 1, n - 1)];
  const x = a.x + (b.x - a.x) * u;
  const y = a.y + (b.y - a.y) * u;
  live.xv.set(format(x));
  live.yv.set(format(y));
  live.ratio.set(ratioText(x > 0 ? y / x : 0));
  const share = n > 1 ? tc / (n - 1) : 1;
  live.thumb.set(`${share * 100}%`);
  live.fill.set(share);
}

/** Starts a morph: the path blends from where it is now to the new series. */
function retarget(eng: Engine, to: Pt[], k: number) {
  eng.from = eng.data.map(p => ({ ...p }));
  eng.to = to;
  eng.k = k;
}
function setBlend(eng: Engine, k: number) { eng.k = k; }

const LABEL_OFFSET: Record<LabelSide, { dx: number; dy: number; anchor: "start" | "middle" | "end" }> = {
  left: { dx: -10, dy: 4, anchor: "end" },
  right: { dx: 10, dy: 4, anchor: "start" },
  above: { dx: 0, dy: -11, anchor: "middle" },
  below: { dx: 0, dy: 19, anchor: "middle" },
};

/** The first and last month label on the side away from their neighbour, so the path never runs through the text. */
function awaySide(p: Pt, neighbour: Pt | undefined): LabelSide {
  if (!neighbour) return "right";
  const vx = neighbour.x - p.x;
  const vy = neighbour.y - p.y;
  if (Math.abs(vx) >= Math.abs(vy) * 0.8) return vx > 0 ? "left" : "right";
  return vy > 0 ? "above" : "below";
}

export function ConnectedScatter({
  series = SERIES,
  defaultSeries,
  xAxis = X_AXIS,
  yAxis = Y_AXIS,
  targetRatio = TARGET_RATIO,
  formatValue = defaultFormat,
  title = "CAC and LTV by channel",
  description = "Monthly acquisition cost against 12 month lifetime value, January 2025 to June 2026.",
  onMonthChange,
  className,
}: ConnectedScatterProps) {
  const reduced = useReducedMotion();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const initialId = series.some(s => s.id === defaultSeries) ? (defaultSeries as string) : series[0]?.id ?? "";
  const [seriesId, setSeriesId] = useState(initialId);
  const active = series.find(s => s.id === seriesId) ?? series[0];
  const points = useMemo(() => active?.points ?? [], [active]);
  const n = points.length;

  const [size, setSize] = useState<Size>(DEFAULT_SIZE);
  const geo = useMemo(() => geometry(size, xAxis, yAxis), [size, xAxis, yAxis]);

  const [month, setMonth] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  const [t] = useState(() => motionValue(0));
  const [live] = useState(() => createLive(n));
  const [eng] = useState<Engine>(() => {
    const pts = points.map(p => ({ x: p.x, y: p.y }));
    const e: Engine = { from: pts, to: pts, k: 1, data: pts, track: null };
    paint(live, e, geometry(DEFAULT_SIZE, xAxis, yAxis), 0, true, formatValue);
    return e;
  });

  const rootRef = useRef<HTMLElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const tAnim = useRef<AnimationPlaybackControls | null>(null);
  const kAnim = useRef<AnimationPlaybackControls | null>(null);
  const ghostAnim = useRef<AnimationPlaybackControls | null>(null);
  const stepTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const introDone = useRef(false);
  const monthRef = useRef(0);
  /** The month the head is heading to, so quick key presses step from the target rather than the gliding head. */
  const targetRef = useRef(0);
  const drag = useRef<{ pointer: number; target: number; start: number; blend: number } | null>(null);
  const ctx = useRef({ geo, formatValue, n, onMonthChange });

  const draw = useCallback((rebuild: boolean) => {
    const c = ctx.current;
    paint(live, eng, c.geo, t.get(), rebuild, c.formatValue);
    const m = clamp(Math.round(t.get()), 0, Math.max(c.n - 1, 0));
    if (m !== monthRef.current) { monthRef.current = m; setMonth(m); }
  }, [eng, live, t]);

  useLayoutEffect(() => {
    ctx.current = { geo, formatValue, n, onMonthChange };
    draw(true);
  }, [geo, formatValue, n, onMonthChange, draw]);

  useEffect(() => t.on("change", () => draw(false)), [t, draw]);

  // The chart draws in real pixels, so text and strokes never stretch. The server renders the default size.
  useLayoutEffect(() => {
    const node = plotRef.current;
    if (!node) return;
    const measure = () => {
      const w = Math.round(node.clientWidth);
      const h = Math.round(node.clientHeight);
      if (w > 0 && h > 0) setSize(prev => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, []);

  const stopTime = useCallback(() => {
    tAnim.current?.stop();
    tAnim.current = null;
    if (stepTimer.current) { clearInterval(stepTimer.current); stepTimer.current = null; }
    setPlaying(false);
  }, []);

  const showGhost = useCallback(() => {
    introDone.current = true;
    ghostAnim.current?.stop();
    if (reduced) live.ghost.set(1);
    else ghostAnim.current = animate(live.ghost, 1, { duration: duration.standard, ease: [...ease.standard] });
  }, [live, reduced]);

  const describe = useCallback((index: number) => {
    const p = points[index];
    if (!p) return "";
    const r = p.x > 0 ? p.y / p.x : 0;
    return `${p.label}: ${xAxis.name} ${formatValue(p.x)}, ${yAxis.name} ${formatValue(p.y)}, ${ratioText(r)}, ${r >= targetRatio ? "above" : "below"} the ${targetRatio}x target.`;
  }, [points, xAxis.name, yAxis.name, formatValue, targetRatio]);

  const settle = useCallback((index: number, speak = true) => {
    ctx.current.onMonthChange?.(index);
    if (speak) setAnnouncement(describe(index));
  }, [describe]);

  /** Springs the head to a month from wherever it is, so a change of mind mid glide never jumps. */
  const goTo = useCallback((index: number) => {
    stopTime();
    if (!introDone.current) showGhost();
    const target = clamp(index, 0, n - 1);
    targetRef.current = target;
    if (reduced) t.set(target);
    else tAnim.current = animate(t, target, spring.smooth);
    settle(target);
  }, [n, reduced, settle, showGhost, stopTime, t]);

  // The path draws itself in once, the first time the block comes into view: the head travels the months and the trail follows it.
  useEffect(() => {
    const node = rootRef.current;
    if (!node || introDone.current) return;
    targetRef.current = n - 1;
    if (reduced) {
      t.set(n - 1);
      showGhost();
      return;
    }
    const start = () => {
      if (introDone.current) return;
      tAnim.current?.stop();
      t.set(0);
      tAnim.current = animate(t, n - 1, { duration: (n - 1) * INTRO_STEP, ease: [...ease.inOut], onComplete: showGhost });
    };
    if (typeof IntersectionObserver === "undefined") { start(); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { observer.disconnect(); start(); }
    }, { threshold: 0.35 });
    observer.observe(node);
    return () => observer.disconnect();
  }, [n, reduced, showGhost, t]);

  useEffect(() => () => {
    tAnim.current?.stop();
    kAnim.current?.stop();
    ghostAnim.current?.stop();
    if (stepTimer.current) clearInterval(stepTimer.current);
  }, []);

  /* ---------- Series switch: the path morphs point by point ---------- */

  const switchSeries = (id: string) => {
    const next = series.find(s => s.id === id);
    if (!next || id === seriesId) return;
    setSeriesId(id);
    setHover(null);
    if (!introDone.current) { tAnim.current?.stop(); t.set(n - 1); showGhost(); }
    kAnim.current?.stop();
    retarget(eng, next.points.map(p => ({ x: p.x, y: p.y })), reduced ? 1 : 0);
    const m = monthRef.current;
    const p = next.points[m];
    if (p) {
      const r = p.x > 0 ? p.y / p.x : 0;
      setAnnouncement(`${next.name}. ${p.label}: ${xAxis.name} ${formatValue(p.x)}, ${yAxis.name} ${formatValue(p.y)}, ${ratioText(r)}.`);
    }
    if (reduced) { draw(true); return; }
    const blend = motionValue(0);
    blend.on("change", k => { setBlend(eng, k); draw(true); });
    kAnim.current = animate(blend, 1, { ...spring.smooth, onComplete: () => { setBlend(eng, 1); draw(true); } });
  };

  /* ---------- Playback ---------- */

  const atEnd = month >= n - 1;
  const togglePlay = () => {
    if (playing) { stopTime(); targetRef.current = monthRef.current; settle(monthRef.current); return; }
    stopTime();
    if (!introDone.current) showGhost();
    const from = t.get() >= n - 1 - 0.01 ? 0 : t.get();
    t.set(from);
    targetRef.current = n - 1;
    setPlaying(true);
    if (reduced) {
      let i = Math.ceil(from);
      stepTimer.current = setInterval(() => {
        i = Math.min(i + 1, n - 1);
        t.set(i);
        if (i >= n - 1) { stopTime(); settle(n - 1); }
        else targetRef.current = n - 1;
      }, duration.considered * 2000);
      return;
    }
    tAnim.current = animate(t, n - 1, {
      duration: (n - 1 - from) * PLAY_STEP,
      ease: "linear",
      onComplete: () => { tAnim.current = null; setPlaying(false); settle(n - 1); },
    });
  };

  /* ---------- Scrubber ---------- */

  const timeFromPointer = (clientX: number) => {
    const rail = railRef.current;
    if (!rail) return 0;
    const rect = rail.getBoundingClientRect();
    return clamp(((clientX - rect.left) / Math.max(rect.width, 1)) * (n - 1), 0, n - 1);
  };

  const renderDrag = () => {
    const d = drag.current;
    if (!d) return;
    t.set(d.start + (d.target - d.start) * d.blend);
  };

  const onScrubDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    stopTime();
    if (!introDone.current) showGhost();
    const d = { pointer: event.pointerId, target: timeFromPointer(event.clientX), start: t.get(), blend: reduced ? 1 : 0 };
    drag.current = d;
    setScrubbing(true);
    setHover(null);
    // The press glides the head to the pointer once; after that it follows one to one.
    if (reduced) renderDrag();
    else tAnim.current = animate(0, 1, { ...spring.smooth, onUpdate: b => { d.blend = b; renderDrag(); } });
  };

  const onScrubMove = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== event.pointerId) return;
    d.target = timeFromPointer(event.clientX);
    if (d.blend >= 1) renderDrag();
  };

  const onScrubEnd = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== event.pointerId) return;
    drag.current = null;
    setScrubbing(false);
    goTo(Math.round(d.target));
  };

  const onScrubKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const base = targetRef.current;
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") next = base + 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = base - 1;
    else if (event.key === "PageUp") next = base + 3;
    else if (event.key === "PageDown") next = base - 3;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = n - 1;
    if (next === null) return;
    event.preventDefault();
    setHover(null);
    goTo(next);
  };

  /* ---------- Hover and tap on the chart ---------- */

  const screenPts = useMemo(() => points.map(p => ({ x: geo.sx(p.x), y: geo.sy(p.y) })), [points, geo]);

  const nearest = (event: PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * geo.w;
    const y = ((event.clientY - rect.top) / Math.max(rect.height, 1)) * geo.h;
    let best: number | null = null;
    let bestD = event.pointerType === "touch" ? HIT_RADIUS * 1.5 : HIT_RADIUS;
    screenPts.forEach((p, i) => {
      const dist = Math.hypot(p.x - x, p.y - y);
      if (dist < bestD) { bestD = dist; best = i; }
    });
    return best;
  };

  const onChartMove = (event: PointerEvent<SVGSVGElement>) => {
    if (event.pointerType === "touch") return;
    const i = nearest(event);
    setHover(prev => (prev === i ? prev : i));
  };

  const onChartDown = (event: PointerEvent<SVGSVGElement>) => {
    const i = nearest(event);
    setHover(i);
    if (i !== null) goTo(i);
  };

  /* ---------- Static chart geometry, rebuilt when the size or series changes ---------- */

  const chart = useMemo(() => {
    const narrow = geo.w < 440;
    const xTicks: number[] = [];
    // Narrow plots label every other gridline, starting from a round multiple so no label sits on the plot edge.
    const xStep = xAxis.step * (narrow ? 2 : 1);
    const xStart = narrow ? Math.ceil((xAxis.min + 1e-9) / xStep) * xStep : xAxis.min;
    for (let v = xStart; v <= xAxis.max + 1e-9; v += xStep) if (!narrow || v < xAxis.max) xTicks.push(v);
    const yTicks: number[] = [];
    const yStep = geo.h - PAD.t - PAD.b < 240 ? yAxis.step * 2 : yAxis.step;
    for (let v = yAxis.min; v <= yAxis.max + 1e-9; v += yStep) yTicks.push(v);
    // The healthy region is the plot rectangle clipped to the half plane above the target line (y >= ratio * x).
    const corners: Pt[] = [
      { x: xAxis.min, y: yAxis.min }, { x: xAxis.max, y: yAxis.min }, { x: xAxis.max, y: yAxis.max }, { x: xAxis.min, y: yAxis.max },
    ];
    const side = (p: Pt) => p.y - targetRatio * p.x;
    const clipped: Pt[] = [];
    corners.forEach((p, i) => {
      const q = corners[(i + 1) % corners.length];
      const sp = side(p);
      const sq = side(q);
      if (sp >= 0) clipped.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const k = sp / (sp - sq);
        clipped.push({ x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k });
      }
    });
    const region = clipped.length ? `M${clipped.map(p => `${geo.sx(p.x)} ${geo.sy(p.y)}`).join(" L")} Z` : "";
    // The target line runs between where it enters and leaves the plot.
    const onLine = clipped.filter(p => Math.abs(side(p)) < 1e-6).sort((a, b) => a.x - b.x);
    const a = onLine[0] ?? { x: xAxis.min, y: targetRatio * xAxis.min };
    const b = onLine[onLine.length - 1] ?? { x: xAxis.max, y: targetRatio * xAxis.max };
    const origin = { x: geo.sx(a.x), y: geo.sy(a.y) };
    const end = { x: geo.sx(b.x), y: geo.sy(b.y) };
    const top = geo.sy(yAxis.max);
    const angle = (Math.atan2(end.y - origin.y, end.x - origin.x) * 180) / Math.PI;
    const labelAt = { x: origin.x + (end.x - origin.x) * 0.94, y: origin.y + (end.y - origin.y) * 0.94 };
    return { xTicks, yTicks, origin, end, region, angle, labelAt, top };
  }, [geo, xAxis, yAxis, targetRatio]);

  const labels = useMemo(() => {
    if (!n) return [];
    const list: { index: number; text: string; side: LabelSide; strong: boolean }[] = [
      { index: 0, text: points[0].label, side: awaySide(screenPts[0], screenPts[1]), strong: false },
      { index: n - 1, text: points[n - 1].label, side: awaySide(screenPts[n - 1], screenPts[n - 2]), strong: true },
    ];
    // Narrow plots keep only the first and last month, so notes never pile onto the path.
    if (geo.w < 480) return list;
    (active?.notes ?? []).forEach(note => {
      if (note.index > 0 && note.index < n - 1) list.push({ index: note.index, text: note.text, side: note.side, strong: false });
    });
    return list;
  }, [active, points, screenPts, n, geo.w]);

  const arrowShown = useMemo(() => screenPts.slice(0, -1).map((p, i) => Math.hypot(screenPts[i + 1].x - p.x, screenPts[i + 1].y - p.y) >= 22), [screenPts]);

  const current = points[month];
  const first = points[0];
  const currentRatio = current && current.x > 0 ? current.y / current.x : 0;
  const healthy = currentRatio >= targetRatio;
  const delta = (v: number, base: number) => {
    const diff = Math.round(v - base);
    if (diff === 0) return `Same as ${first?.label ?? "the start"}`;
    return `${diff > 0 ? "+" : "−"}${formatValue(Math.abs(diff))} since ${first?.label ?? "the start"}`;
  };

  // The tooltip keeps its last place and content while it fades out, and only glides between points once it is already open,
  // so it never slides in from the plot's corner.
  const [tipState, setTipState] = useState<{ hover: number | null; last: number | null; glide: boolean }>({ hover: null, last: null, glide: false });
  if (tipState.hover !== hover) setTipState({ hover, last: hover ?? tipState.last, glide: hover !== null && tipState.hover !== null });
  const tipIndex = hover ?? tipState.last;
  const tipGlides = hover !== null && tipState.glide;

  const shownTip = tipIndex !== null && screenPts[tipIndex] ? (() => {
    const p = screenPts[tipIndex];
    const TIP_W = 176;
    const left = clamp(p.x - TIP_W / 2, 0, Math.max(geo.w - TIP_W, 0));
    const below = p.y < 118;
    const d = points[tipIndex];
    return { left, top: p.y, below, d, ratio: d.x > 0 ? d.y / d.x : 0, x: p.x, y: p.y };
  })() : null;

  const monthTicks = points.map((p, i) => {
    const [mon, year] = p.label.split(" ");
    const edge = i === 0 || i === n - 1;
    const yearStart = mon === "Jan";
    const quarter = ["Jan", "Apr", "Jul", "Oct"].includes(mon);
    if (!edge && !quarter) return null;
    // Near the end the last month's label wins over a quarter label that would collide with it.
    if (!edge && i >= n - 3) return null;
    return { i, text: edge || yearStart ? `${mon} ${year}` : mon, minor: !edge && !yearStart, edge: i === 0 ? "start" : i === n - 1 ? "end" : undefined };
  }).filter(Boolean) as { i: number; text: string; minor: boolean; edge?: "start" | "end" }[];

  const playLabel = playing ? "Pause" : atEnd ? "Replay" : "Play";
  const PlayIcon = playing ? Pause : atEnd ? RotateCcw : Play;

  return (
    <section ref={rootRef} className={[styles.root, className].filter(Boolean).join(" ")} aria-labelledby={`${uid}-title`}>
      <header className={styles.head}>
        <div className={styles.headText}>
          <h2 id={`${uid}-title`} className={styles.title}>{title}</h2>
          {description ? <p className={styles.description}>{description}</p> : null}
        </div>
        {series.length > 1 ? (
          <SegmentedControl label="Channel" value={seriesId} onValueChange={switchSeries} options={series.map(s => ({ value: s.id, label: s.name }))} />
        ) : null}
      </header>

      <dl className={styles.stats}>
        <div className={styles.stat}>
          <dt>Month</dt>
          <dd><span className={styles.statValue}>{current?.label}</span><span className={styles.statNote}>{month + 1} of {n}</span></dd>
        </div>
        <div className={styles.stat}>
          <dt>{xAxis.name}</dt>
          <dd><motion.span className={styles.statValue}>{live.xv}</motion.span><span className={styles.statNote}>{current && first ? delta(current.x, first.x) : ""}</span></dd>
        </div>
        <div className={styles.stat}>
          <dt>{yAxis.name}</dt>
          <dd><motion.span className={styles.statValue}>{live.yv}</motion.span><span className={styles.statNote}>{current && first ? delta(current.y, first.y) : ""}</span></dd>
        </div>
        <div className={styles.stat} data-status={healthy ? "good" : "low"}>
          <dt>{yAxis.name} to {xAxis.name}</dt>
          <dd><motion.span className={styles.statValue}>{live.ratio}</motion.span><span className={styles.statNote}><span className={styles.statusDot} aria-hidden="true" />{healthy ? "Above" : "Below"} {targetRatio}x target</span></dd>
        </div>
      </dl>

      <div className={styles.chartBlock}>
        <div className={styles.chartHead}>
          <span className={styles.axisTitle}>{yAxis.title}</span>
          <ul className={styles.key} aria-label="Chart key">
            <li><span className={styles.keyLine} data-line="path" aria-hidden="true" />{active?.name}, in time order</li>
            <li><span className={styles.keyLine} data-line="target" aria-hidden="true" />{yAxis.name} = {targetRatio}x {xAxis.name}</li>
            <li><span className={styles.keyZone} aria-hidden="true" />Healthy zone</li>
          </ul>
        </div>

        <div ref={plotRef} className={styles.plot} onPointerLeave={() => setHover(null)}>
          <svg
            ref={svgRef}
            className={styles.svg}
            viewBox={`0 0 ${geo.w} ${geo.h}`}
            aria-hidden="true"
            onPointerMove={onChartMove}
            onPointerDown={onChartDown}
          >
            <defs>
              <clipPath id={`${uid}-clip`}><rect x={PAD.l} y={PAD.t} width={Math.max(geo.right - PAD.l, 0)} height={Math.max(geo.bottom - PAD.t, 0)} /></clipPath>
            </defs>

            <path className={styles.zone} d={chart.region} />

            <g>
              {chart.yTicks.map(v => (
                <g key={`y${v}`}>
                  <line className={styles.grid} x1={PAD.l} x2={geo.right} y1={geo.sy(v)} y2={geo.sy(v)} />
                  <text className={styles.tick} x={PAD.l - 8} y={geo.sy(v)} dy="0.32em" textAnchor="end">{compact(v, formatValue)}</text>
                </g>
              ))}
              {chart.xTicks.map(v => (
                <text key={`x${v}`} className={styles.tick} x={geo.sx(v)} y={geo.bottom + 19} textAnchor={v <= xAxis.min ? "start" : v >= xAxis.max ? "end" : "middle"}>{formatValue(v)}</text>
              ))}
            </g>

            <line className={styles.target} x1={chart.origin.x} y1={chart.origin.y} x2={chart.end.x} y2={chart.end.y} />
            {geo.w >= 480 ? <text className={styles.targetLabel} transform={`translate(${px2(chart.labelAt.x)} ${px2(chart.labelAt.y)}) rotate(${px2(chart.angle)})`} y={-7} textAnchor="end">
              {targetRatio}x {xAxis.name}
            </text> : null}
            {/* On narrow plots the key names the line and the zone, so the chart keeps its room for the path. */}
            {geo.w >= 480 ? <text className={styles.zoneLabel} x={PAD.l + 12} y={PAD.t + 18}>Healthy, above {targetRatio}x</text> : null}

            <g clipPath={`url(#${uid}-clip)`}>
              <motion.rect className={styles.guide} x={-0.5} y={0} width={1} height={1} style={{ x: live.hx, y: live.hy, scaleY: live.vLen, originY: 0 }} />
              <motion.rect className={styles.guide} x={PAD.l} y={-0.5} width={1} height={1} style={{ y: live.hy, scaleX: live.hLen, originX: 0 }} />
            </g>

            <motion.path className={styles.ghost} d={live.d} style={{ opacity: live.ghost }} />
            <motion.path className={styles.trail} d={live.d} style={{ pathLength: live.trail }} />

            <g>
              {live.arrows.map((arrow, i) => (arrowShown[i] ? (
                <motion.g key={i} style={{ x: arrow.x, y: arrow.y, rotate: arrow.r }}>
                  <motion.path className={styles.arrowGhost} d="M-3.5 -3.5 L3.5 0 L-3.5 3.5 Z" style={{ opacity: live.ghost }} />
                  <motion.path className={styles.arrow} d="M-3.5 -3.5 L3.5 0 L-3.5 3.5 Z" style={{ opacity: arrow.on }} />
                </motion.g>
              ) : null))}
            </g>

            <g>
              {live.dots.map((dot, i) => (
                <motion.g key={i} className={styles.dot} data-hover={hover === i ? "" : undefined} style={{ x: dot.x, y: dot.y }}>
                  <circle className={styles.dotHalo} r={11} />
                  <motion.circle className={styles.dotGhost} r={3} style={{ opacity: live.ghost }} />
                  <motion.circle className={styles.dotPast} r={3.25} style={{ opacity: dot.on }} />
                </motion.g>
              ))}
            </g>

            <motion.g style={{ opacity: live.ghost }}>
              <AnimatePresence initial={false}>
                <motion.g
                  key={seriesId}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1, transition: reduced ? { duration: 0 } : { duration: duration.standard, ease: [...ease.standard], delay: duration.standard } }}
                  exit={{ opacity: 0, transition: { duration: reduced ? 0 : duration.exit, ease: [...ease.exit] } }}
                >
                  {labels.map(label => {
                    const p = screenPts[label.index];
                    // A side label that would leave the plot flips to the other side of its point.
                    const width = label.text.length * 6.6;
                    const side = label.side === "right" && p.x + 10 + width > geo.right ? "left"
                      : label.side === "left" && p.x - 10 - width < PAD.l ? "right" : label.side;
                    const o = LABEL_OFFSET[side];
                    return (
                      <text key={`${label.index}-${label.text}`} className={styles.pointLabel} data-strong={label.strong ? "" : undefined} x={px2(p.x + o.dx)} y={px2(p.y + o.dy)} textAnchor={o.anchor}>
                        {label.text}
                      </text>
                    );
                  })}
                </motion.g>
              </AnimatePresence>
            </motion.g>

            <motion.g className={styles.headMark} data-active={scrubbing || playing ? "" : undefined} style={{ x: live.hx, y: live.hy }}>
              <circle className={styles.headHalo} r={13} />
              <circle className={styles.headDot} r={6} />
            </motion.g>
          </svg>

          <div
            className={styles.tip}
            data-open={hover !== null && shownTip ? "" : undefined}
            data-glide={tipGlides ? "" : undefined}
            data-below={shownTip?.below ? "" : undefined}
            style={shownTip ? { transform: `translate(${px2(shownTip.left)}px, ${px2(shownTip.top)}px)` } : undefined}
            aria-hidden="true"
          >
            {shownTip ? (
              <div className={styles.tipCard}>
                <span className={styles.tipDate}>{shownTip.d.label}</span>
                <dl className={styles.tipRows}>
                  <div><dt>{xAxis.name}</dt><dd>{formatValue(shownTip.d.x)}</dd></div>
                  <div><dt>{yAxis.name}</dt><dd>{formatValue(shownTip.d.y)}</dd></div>
                  <div><dt>Ratio</dt><dd data-status={shownTip.ratio >= targetRatio ? "good" : "low"}>{ratioText(shownTip.ratio)}</dd></div>
                </dl>
              </div>
            ) : null}
          </div>
        </div>
        <span className={styles.axisTitle} data-axis="x">{xAxis.title}</span>
      </div>

      <div className={styles.scrub}>
        <Button variant="secondary" className={styles.play} onClick={togglePlay} aria-label={playing ? "Pause" : atEnd ? "Replay from the first month" : "Play through the months"}>
          <PlayIcon size={16} strokeWidth={1.75} aria-hidden="true" />
          {playLabel}
        </Button>
        <div className={styles.timeline}>
          <div
            ref={railRef}
            className={styles.scrubber}
            data-active={scrubbing ? "" : undefined}
            role="slider"
            tabIndex={0}
            aria-label="Month"
            aria-orientation="horizontal"
            aria-valuemin={1}
            aria-valuemax={n}
            aria-valuenow={month + 1}
            aria-valuetext={describe(month)}
            onPointerDown={onScrubDown}
            onPointerMove={onScrubMove}
            onPointerUp={onScrubEnd}
            onPointerCancel={onScrubEnd}
            onKeyDown={onScrubKey}
          >
            <div className={styles.bar} aria-hidden="true">
              <motion.span className={styles.barFill} style={{ scaleX: live.fill, originX: 0 }} />
            </div>
            <div className={styles.notches} aria-hidden="true">
              {points.map((p, i) => <span key={p.label} className={styles.notch} style={{ left: `${n > 1 ? (i / (n - 1)) * 100 : 0}%` }} />)}
            </div>
            <div className={styles.thumbTrack} aria-hidden="true">
              <motion.div className={styles.thumbRail} style={{ x: live.thumb }}>
                <span className={styles.thumb} />
              </motion.div>
            </div>
          </div>
          <div className={styles.monthLabels} aria-hidden="true">
            {monthTicks.map(tick => (
              <span key={tick.i} className={styles.monthLabel} data-minor={tick.minor ? "" : undefined} data-edge={tick.edge} style={{ left: `${n > 1 ? (tick.i / (n - 1)) * 100 : 0}%` }}>
                {tick.text}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className={styles.srOnly}>
      <table>
        <caption>{active?.name}: {xAxis.title} and {yAxis.title} by month</caption>
        <thead><tr><th scope="col">Month</th><th scope="col">{xAxis.name}</th><th scope="col">{yAxis.name}</th><th scope="col">Ratio</th></tr></thead>
        <tbody>
          {points.map(p => (
            <tr key={p.label}><th scope="row">{p.label}</th><td>{formatValue(p.x)}</td><td>{formatValue(p.y)}</td><td>{ratioText(p.x > 0 ? p.y / p.x : 0)}</td></tr>
          ))}
        </tbody>
      </table>
      </div>
      <p className={styles.srOnly} aria-live="polite">{announcement}</p>
    </section>
  );
}

export default ConnectedScatter;
