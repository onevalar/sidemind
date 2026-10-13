"use client";

import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, useTransform, type MotionValue } from "motion/react";
import { motionTokens } from "../../lib/motion-tokens";
import { INTERVALS, LAST, RANGES, domainOf, formatTick, formatValue, longDate, valueAt, xTicksOf, type Metric, type RangeId } from "./metric-data";
import { Swap } from "./rise";
import styles from "./metric-explorer.module.css";

const { spring, duration, stagger } = motionTokens;
/** Plot insets in px. The chart's height comes from CSS, so the panel has its final size on the first frame. */
const GUTTER = 52, RIGHT = 6, TOP = 8, BOTTOM = 28;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const scaleX = (d: number, span: number, w: number) => { const x0 = LAST - span + 1; return GUTTER + (d - x0) / Math.max(1e-6, LAST - x0) * (w - GUTTER - RIGHT); };

type Frame = { span: number; k: number; lo: number; hi: number; p: number; w: number; h: number; hover: number };
/** Both lines as heights from 0 (bottom gridline) to 1 (top gridline) for every day, frozen when a metric switch begins. */
type Snapshot = { cur: Float64Array; prev: Float64Array };

/** Where both lines sit at a day. During a metric switch they blend from the frozen snapshot, so the path reshapes instead of redrawing. */
function heightsAt(metric: Metric, from: Snapshot | null, f: Frame, d: number): [number, number] {
  const range = f.hi - f.lo || 1;
  const cur = (valueAt(metric, f.k, d) - f.lo) / range, prev = (valueAt(metric, f.k, d - f.span) - f.lo) / range;
  return from ? [from.cur[d] + (cur - from.cur[d]) * f.p, from.prev[d] + (prev - from.prev[d]) * f.p] : [cur, prev];
}

function snapshotOf(metric: Metric, from: Snapshot | null, f: Frame): Snapshot {
  const cur = new Float64Array(LAST + 1), prev = new Float64Array(LAST + 1);
  for (let d = 0; d <= LAST; d++) [cur[d], prev[d]] = heightsAt(metric, from, f, d);
  return { cur, prev };
}

/** One pass per frame: both paths, the latest point and the scrubbed point, all from the same springs. */
function geometry(metric: Metric, from: Snapshot | null, f: Frame) {
  const plotH = f.h - TOP - BOTTOM, sy = (n: number) => TOP + (1 - n) * plotH;
  const start = Math.max(0, Math.floor(LAST - f.span));
  let cur = "", prev = "";
  for (let d = start; d <= LAST; d++) {
    const [c, p] = heightsAt(metric, from, f, d), x = scaleX(d, f.span, f.w).toFixed(1), cmd = d === start ? "M" : "L";
    cur += `${cmd}${x} ${sy(c).toFixed(1)}`;
    prev += `${cmd}${x} ${sy(p).toFixed(1)}`;
  }
  const at = f.hover >= 0 ? f.hover : LAST, [hc, hp] = heightsAt(metric, from, f, at), [ec] = heightsAt(metric, from, f, LAST);
  const x = scaleX(at, f.span, f.w);
  return { cur, prev, endX: scaleX(LAST, f.span, f.w), endY: sy(ec), x, line: Math.round(x) + .5, cy: sy(hc), py: sy(hp) };
}

/** A date label rides the zoom and fades as it nears either edge of the plot. */
function XTick({ d, label, span, width, y }: { d: number; label: string; span: MotionValue<number>; width: MotionValue<number>; y: number }) {
  const x = useTransform([span, width], ([s, w]: number[]) => scaleX(d, s, w));
  const opacity = useTransform([x, width], ([v, w]: number[]) => clamp((Math.min(v - GUTTER, w - RIGHT - v) - 4) / 12, 0, 1));
  return <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: duration.fast } }} transition={{ duration: duration.standard, delay: .06 }}>
    <motion.text className={styles.axis} style={{ x, opacity }} y={y} textAnchor="middle">{label}</motion.text>
  </motion.g>;
}

export interface MetricChartProps { metric: Metric; range: RangeId; hover: number | null; onHover: (day: number | null) => void; label: string; tableId: string }

export function MetricChart({ metric, range, hover, onHover, label, tableId }: MetricChartProps) {
  const reduce = !!useReducedMotion();
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 720, h: 260 });
  const { w: width, h: height } = size, plotH = height - TOP - BOTTOM;
  const { days, weekly } = RANGES[range];
  const domain = useMemo(() => domainOf(metric, range), [metric, range]);
  const ticks = useMemo(() => xTicksOf(range, width - GUTTER - RIGHT), [range, width]);
  const first = weekly ? LAST - 7 * Math.floor((days - 1) / 7) : LAST - days + 1;

  // Everything that moves per frame is a motion value; React renders only when a label or the scrubbed day changes.
  const span = useMotionValue(days), k = useMotionValue(weekly ? 1 : 0), lo = useMotionValue(domain.lo), hi = useMotionValue(domain.hi), p = useMotionValue(1);
  const w = useMotionValue(width), h = useMotionValue(height), hv = useMotionValue(-1), version = useMotionValue(0);
  const shown = useRef({ metric, range });
  const from = useRef<Snapshot | null>(null);
  const geo = useTransform([span, k, lo, hi, p, w, h, hv, version], ([s, kv, l, u, pv, wv, hvv, hov]: number[]) =>
    geometry(shown.current.metric, from.current, { span: s, k: kv, lo: l, hi: u, p: pv, w: wv, h: hvv, hover: hov }));
  const cur = useTransform(geo, g => g.cur), prev = useTransform(geo, g => g.prev);
  const endX = useTransform(geo, g => g.endX), endY = useTransform(geo, g => g.endY);
  const line = useTransform(geo, g => g.line), dotX = useTransform(geo, g => g.x), cy = useTransform(geo, g => g.cy), py = useTransform(geo, g => g.py);
  const pillX = useTransform([dotX, w], ([x, wv]: number[]) => clamp(x, GUTTER + 48, wv - RIGHT - 48));

  // Measure before the first paint, then follow resizes. Only the drawing follows the box; the box never follows the drawing.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => {
      const next = { w: Math.round(el.clientWidth), h: Math.round(el.clientHeight) };
      if (!next.w || !next.h) return;
      w.set(next.w); h.set(next.h);
      setSize(current => (current.w === next.w && current.h === next.h ? current : next));
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [w, h]);

  // A new range zooms the same line: the window, the weekly blend and the y domain each spring from wherever they are.
  // A new metric freezes what is on screen, mid-flight included, and morphs every point toward the new series.
  useLayoutEffect(() => {
    const t = shown.current;
    if (t.metric === metric && t.range === range) return;
    const switched = t.metric !== metric, next = domainOf(metric, range), r = RANGES[range];
    const go = (value: MotionValue<number>, to: number) => { if (reduce) value.jump(to); else animate(value, to, spring.smooth); };
    hv.set(-1);
    if (switched) {
      from.current = reduce ? null : snapshotOf(t.metric, from.current, { span: span.get(), k: k.get(), lo: lo.get(), hi: hi.get(), p: p.get(), w: w.get(), h: h.get(), hover: -1 });
      lo.jump(next.lo); hi.jump(next.hi);
      if (reduce) p.jump(1);
      else { p.jump(0); animate(p, 1, { ...spring.smooth, onComplete: () => { from.current = null; } }); }
    } else { go(lo, next.lo); go(hi, next.hi); }
    shown.current = { metric, range };
    go(span, r.days); go(k, r.weekly ? 1 : 0);
    version.set(version.get() + 1);
  }, [metric, range, reduce, span, k, lo, hi, p, w, h, hv, version]);

  const snap = (t: number) => clamp(weekly ? LAST - 7 * Math.round((LAST - t) / 7) : Math.round(t), first, LAST);
  const scrub = (d: number | null) => { hv.set(d ?? -1); onHover(d); };
  const onPointer = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect(), x0 = LAST - span.get() + 1;
    scrub(snap(x0 + (e.clientX - rect.left) / Math.max(1, rect.width) * (LAST - x0)));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = (weekly ? 7 : 1) * (e.shiftKey ? (weekly ? 4 : 7) : 1), at = hover ?? LAST;
    const next = e.key === "ArrowLeft" || e.key === "ArrowDown" ? at - step : e.key === "ArrowRight" || e.key === "ArrowUp" ? at + step : e.key === "Home" ? first : e.key === "End" ? LAST : e.key === "Escape" && hover !== null ? -1 : null;
    if (next === null) return;
    e.preventDefault();
    scrub(next < 0 ? null : clamp(next, first, LAST));
  };

  const at = hover ?? LAST;
  const hoverText = `${longDate(at)}: ${formatValue(metric, metric.daily[at])}. ${longDate(at - days)}: ${formatValue(metric, metric.daily[at - days])}`;
  const clipId = `${tableId}-clip`;

  return <div ref={box} className={styles.chart}>
    <svg className={styles.svg} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} aria-describedby={tableId}>
      <defs><clipPath id={clipId}><rect x={GUTTER - 3} y={0} width={Math.max(0, width - GUTTER - RIGHT + 6)} height={height} /></clipPath></defs>
      <g aria-hidden="true">
        {Array.from({ length: INTERVALS + 1 }, (_, i) => { const y = Math.round(TOP + i * plotH / INTERVALS) + .5; return <line key={i} className={i === INTERVALS ? styles.baseline : styles.gridLine} x1={GUTTER} x2={width - RIGHT} y1={y} y2={y} />; })}
        <AnimatePresence initial={false}>{ticks.map(t => <XTick key={`${t.d}-${t.label}`} d={t.d} label={t.label} span={span} width={w} y={height - 8} />)}</AnimatePresence>
        <g clipPath={`url(#${clipId})`}>
          <motion.path className={styles.prevLine} d={prev} />
          <motion.path className={styles.curLine} d={cur} />
        </g>
        {hover === null ? <motion.circle className={styles.endDot} cx={endX} cy={endY} r={3.5} /> : <g>
          <motion.line className={styles.crossLine} x1={line} x2={line} y1={TOP} y2={height - BOTTOM} />
          <motion.circle className={styles.prevDot} cx={dotX} cy={py} r={3} />
          <motion.circle className={styles.curDot} cx={dotX} cy={cy} r={4} />
        </g>}
      </g>
    </svg>

    <div className={styles.yLabels} style={{ width: GUTTER - 12 }} aria-hidden="true">
      {Array.from({ length: INTERVALS + 1 }, (_, i) => {
        const text = formatTick(metric, domain.lo + i * domain.step, domain.step);
        return <span key={i} className={styles.yLabel} style={{ top: Math.round(TOP + (INTERVALS - i) * plotH / INTERVALS) + .5 }}><Swap id={text} delay={reduce ? 0 : i * stagger.item}>{text}</Swap></span>;
      })}
    </div>

    <div className={styles.hit} style={{ left: GUTTER, right: RIGHT, height: height - BOTTOM }} tabIndex={0} role="slider" aria-label={`Scrub ${metric.label}`} aria-orientation="horizontal"
      aria-valuemin={first} aria-valuemax={LAST} aria-valuenow={hover ?? LAST} aria-valuetext={hoverText}
      onPointerDown={onPointer} onPointerMove={onPointer} onPointerLeave={() => scrub(null)}
      onFocus={() => { if (hv.get() < 0) scrub(LAST); }} onBlur={() => scrub(null)} onKeyDown={onKey} />

    {hover !== null && <motion.div className={styles.pillAnchor} style={{ x: pillX, top: height - BOTTOM + 5 }} aria-hidden="true"><span className={styles.pill}>{longDate(hover)}</span></motion.div>}
  </div>;
}
