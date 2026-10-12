"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { AnimatePresence, LayoutGroup, animate, motion, useMotionValue, useReducedMotion, useSpring, useTransform, type MotionValue, type Transition } from "motion/react";
import { ArrowUpRight } from "lucide-react";
import { AnimatedCounter } from "../../animated-counter/animated-counter";
import { motionTokens } from "../../lib/motion-tokens";
import {
  GUTTER, LAST, MIN_SPAN, OVERVIEW_H, PAD_BOTTOM, PAD_TOP, SERIES,
  axisLabel, chartHeight, geometry, money, monthAt, monthLabel, monthStep, netOf, overview, panelWidth, rangeLabel, summarize, xStep, yDomain, yTicks,
  type Geometry,
} from "./revenue-data";
import styles from "./revenue-explorer.module.css";

type Part = "move" | "lo" | "hi";
type Target = { lo: number; hi: number; active: boolean[]; compare: boolean };

const { spring, duration, ease } = motionTokens;
const enterEase = [...ease.enter] as [number, number, number, number];
/** Direct manipulation: the chart trails the brush by a short, critically damped beat and retargets on every move. */
const follow = { ...spring.smooth, visualDuration: .26 };
/** The comparison line peels away from the current edge a little slower, so the eye can follow it. */
const peel = { ...spring.smooth, visualDuration: duration.considered };
const PRESETS = [{ label: "3M", months: 3 }, { label: "6M", months: 6 }, { label: "12M", months: 12 }, { label: "All", months: 24 }];
const DEFAULT_WIDTH = 720;
const START = { lo: LAST - 11, hi: LAST };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** Past an end the brush keeps following the pointer with rising resistance, like a stretched band. */
const rubber = (over: number, limit = 1.2) => Math.sign(over) * (1 - 1 / (Math.abs(over) * .55 / limit + 1)) * limit;
const signed = (v: number, digits: number, unit: string) => `${v < 0 ? "−" : "+"}${Math.abs(v).toFixed(digits)}${unit}`;
const plotX = (i: number, x0: number, x1: number, width: number) => GUTTER + (i - x0) / Math.max(1e-6, x1 - x0) * (width - GUTTER);

function go(value: MotionValue<number>, to: number, transition: Transition, reduce: boolean) {
  if (reduce) value.jump(to);
  else if (value.get() !== to || value.isAnimating()) animate(value, to, transition);
}

function useField<K extends keyof Geometry>(geo: MotionValue<Geometry>, key: K) {
  return useTransform(geo, g => g[key]);
}

/** Changing text rises into place; reduced motion crossfades. */
function Rise({ text, className }: { text: string; className?: string }) {
  const reduce = useReducedMotion();
  const hidden = reduce ? { opacity: 0 } : { opacity: 0, y: "0.45em" };
  return <span className={[styles.rise, className].filter(Boolean).join(" ")}>
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span key={text} initial={hidden} animate={{ opacity: 1, y: 0 }} exit={reduce ? { opacity: 0 } : { opacity: 0, y: "-0.45em" }} transition={{ duration: reduce ? duration.instant : duration.standard, ease: enterEase }}>{text}</motion.span>
    </AnimatePresence>
  </span>;
}

function Num({ value, decimals = 1, prefix = "$", suffix = "" }: { value: number; decimals?: number; prefix?: string; suffix?: string }) {
  return <span className={styles.num}><AnimatedCounter value={value} decimals={decimals} prefix={prefix} suffix={suffix} /></span>;
}

/** One arrow turns between up and down instead of swapping icons. Tone carries whether the move is good. */
function Delta({ text, change, good, context }: { text: string; change: number; good: boolean; context: string }) {
  const reduce = useReducedMotion();
  return <span className={styles.delta} data-tone={good ? "good" : "bad"}>
    <motion.span className={styles.deltaIcon} initial={false} animate={{ rotate: change >= 0 ? 0 : 90 }} transition={reduce ? { duration: 0 } : spring.snappy}><ArrowUpRight size={14} strokeWidth={1.75} aria-hidden="true" /></motion.span>
    <Rise text={text} className={styles.deltaValue} />
    <Rise text={context} className={styles.deltaContext} />
  </span>;
}

const fade = (reduce: boolean) => ({ duration: reduce ? duration.instant : duration.standard, ease: enterEase, delay: reduce ? 0 : .05 });

/** A gridline and its label glide with the animated y domain; ticks entering or leaving the set crossfade in place. */
function YTick({ value, yLo, yHi, height, width, reduce }: { value: number; yLo: MotionValue<number>; yHi: MotionValue<number>; height: MotionValue<number>; width: number; reduce: boolean }) {
  const y = useTransform([yLo, yHi, height], ([lo, hi, h]: number[]) => Math.round(PAD_TOP + (hi - value) / Math.max(1, hi - lo) * (h - PAD_BOTTOM - PAD_TOP)));
  const inside = useTransform([y, height], ([v, h]: number[]) => clamp(1 - Math.max(PAD_TOP - 8 - v, v - (h - PAD_BOTTOM) - 2, 0) / 10, 0, 1));
  return <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: duration.fast } }} transition={fade(reduce)}>
    <motion.g style={{ y, opacity: inside }}>
      <line className={value === 0 ? styles.zero : styles.gridLine} x1={GUTTER} x2={width} y1={.5} y2={.5} />
      <text className={styles.axisLabel} x={GUTTER - 10} y={.5} dy=".32em" textAnchor="end">{money(value)}</text>
    </motion.g>
  </motion.g>;
}

/** A month label rides the animated x domain, leans in at the plot edges and fades as its month leaves. */
function XTick({ index, x0, x1, width, y, reduce }: { index: number; x0: MotionValue<number>; x1: MotionValue<number>; width: MotionValue<number>; y: number; reduce: boolean }) {
  const px = useTransform([x0, x1, width], ([a, b, w]: number[]) => plotX(index, a, b, w));
  const x = useTransform([px, width], ([p, w]: number[]) => clamp(p, GUTTER + 14, w - 16));
  const opacity = useTransform([px, width], ([p, w]: number[]) => clamp(1 - Math.max(GUTTER - p, p - w, 0) / 18, 0, 1));
  return <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: duration.fast } }} transition={fade(reduce)}>
    <motion.text className={styles.axisLabel} style={{ x, opacity }} y={y} textAnchor="middle">{axisLabel(index)}</motion.text>
  </motion.g>;
}

export function RevenueExplorer() {
  const reduce = !!useReducedMotion();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const clipId = `${uid}-clip`, tableId = `${uid}-table`, titleId = `${uid}-title`;

  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [range, setRange] = useState({ a: START.lo, b: START.hi });
  const [domain, setDomain] = useState(() => yDomain(START.lo, START.hi, [true, true, true], false, 12));
  const [active, setActive] = useState([true, true, true]);
  const [compare, setCompare] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [dragging, setDragging] = useState<Part | null>(null);
  const [shownPreset, setShownPreset] = useState(12);

  // Everything that moves per frame lives in motion values; React state only changes when a whole month or tick changes.
  const x0 = useMotionValue(START.lo), x1 = useMotionValue(START.hi);
  const brushLo = useMotionValue(START.lo), brushHi = useMotionValue(START.hi);
  const yLo = useMotionValue(domain[0]), yHi = useMotionValue(domain[1]);
  const wNew = useMotionValue(1), wExp = useMotionValue(1), wChurn = useMotionValue(1);
  const comparing = useMotionValue(0), offset = useMotionValue(12);
  const widthMv = useMotionValue(DEFAULT_WIDTH), heightMv = useMotionValue(chartHeight(DEFAULT_WIDTH)), hoverMv = useMotionValue(-1);

  const geo = useTransform([x0, x1, yLo, yHi, wNew, wExp, wChurn, comparing, offset, widthMv, heightMv, hoverMv], ([a, b, lo, hi, n, e, c, k, o, w, h, i]: number[]) =>
    geometry({ x0: a, x1: b, yLo: lo, yHi: hi, w: [n, e, c], compare: k, offset: o, width: w, height: h, hover: i }));
  const areaNew = useField(geo, "areaNew"), areaExp = useField(geo, "areaExp"), areaChurn = useField(geo, "areaChurn");
  const lineNew = useField(geo, "lineNew"), lineExp = useField(geo, "lineExp"), lineChurn = useField(geo, "lineChurn");
  const prevTop = useField(geo, "prevTop"), prevLow = useField(geo, "prevLow");
  const prevTopOpacity = useField(geo, "prevTopOpacity"), prevLowOpacity = useField(geo, "prevLowOpacity");
  const cross = useField(geo, "cross"), crossOpacity = useField(geo, "crossOpacity");
  const dotNew = useField(geo, "dotNew"), dotExp = useField(geo, "dotExp"), dotChurn = useField(geo, "dotChurn");
  const panelRaw = useField(geo, "panelX");
  const panelSpring = useSpring(panelRaw, { visualDuration: .22, bounce: 0 });
  const panelX = reduce ? panelRaw : panelSpring;

  const brushLeft = useTransform([brushLo, widthMv], ([v, w]: number[]) => plotX(v, 0, LAST, w));
  const brushRight = useTransform([brushHi, widthMv], ([v, w]: number[]) => plotX(v, 0, LAST, w));
  const brushWidth = useTransform([brushLeft, brushRight], ([l, r]: number[]) => Math.max(0, r - l));
  const dimLeft = useTransform(brushLeft, l => Math.max(0, l - GUTTER));
  const dimRight = useTransform([brushRight, widthMv], ([r, w]: number[]) => Math.max(0, w - r));
  const loHandle = useTransform(brushLeft, l => l - 12), hiHandle = useTransform(brushRight, r => r - 4);

  const target = useRef<Target & { y: [number, number]; offset: number }>({ ...START, active: [true, true, true], compare: false, y: domain, offset: 12 });
  const drag = useRef<{ part: Part; x: number; lo: number; hi: number; perMonth: number; moved: boolean } | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = chartRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (!w) return;
      setWidth(w); widthMv.set(w); heightMv.set(chartHeight(w));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [widthMv, heightMv]);

  function scrub(i: number | null) {
    const was = hoverMv.get();
    hoverMv.set(i ?? -1);
    setHover(i);
    // A panel that appears starts beside its month; only later moves glide.
    if (i !== null && was < 0) {
      const cx = Math.round(plotX(i, x0.get(), x1.get(), widthMv.get())) + .5, pw = panelWidth(widthMv.get());
      panelSpring.jump(cx + 14 + pw <= widthMv.get() ? cx + 14 : Math.max(0, cx - 14 - pw));
    }
  }

  /** Point the chart at a new target. The camera, y domain and comparison offset each spring from wherever they are. */
  function apply(next: Partial<Target>, direct = false) {
    const t = Object.assign(target.current, next);
    go(x0, t.lo, direct ? follow : spring.smooth, reduce);
    go(x1, t.hi, direct ? follow : spring.smooth, reduce);
    const a = Math.round(t.lo), b = Math.round(t.hi), months = b - a + 1;
    const y = yDomain(t.lo, t.hi, t.active, t.compare, months);
    if (y[0] !== t.y[0] || y[1] !== t.y[1]) {
      t.y = y;
      go(yLo, y[0], spring.smooth, reduce); go(yHi, y[1], spring.smooth, reduce);
      setDomain(y);
    }
    if (months !== t.offset) { t.offset = months; go(offset, months, spring.smooth, reduce); }
    setRange(r => (r.a === a && r.b === b ? r : { a, b }));
    const h = hoverMv.get();
    if (h >= 0 && (h < a || h > b)) scrub(clamp(h, a, b));
  }

  /** Land on whole months. From a rubber-band stretch the brush springs back with a little life. */
  function settle(lo: number, hi: number, transition: Transition) {
    const a = Math.round(lo), b = Math.max(a + MIN_SPAN, Math.round(hi));
    go(brushLo, a, transition, reduce); go(brushHi, b, transition, reduce);
    apply({ lo: a, hi: b });
  }

  const toggle = (k: number) => {
    const next = active.map((on, i) => (i === k ? !on : on));
    setActive(next);
    go([wNew, wExp, wChurn][k], next[k] ? 1 : 0, spring.smooth, reduce);
    apply({ active: next });
  };

  const toggleCompare = () => {
    const next = !compare;
    setCompare(next);
    go(comparing, next ? 1 : 0, peel, reduce);
    apply({ compare: next });
  };

  const indexAt = (clientX: number, el: HTMLElement) => {
    const rect = el.getBoundingClientRect(), a = x0.get(), b = x1.get();
    const i = Math.round(a + (clientX - rect.left) / Math.max(1, rect.width) * (b - a));
    return clamp(i, Math.max(0, Math.ceil(a - .001)), Math.min(LAST, Math.floor(b + .001)));
  };
  const onPlotPointer = (e: PointerEvent<HTMLDivElement>) => {
    const i = indexAt(e.clientX, e.currentTarget);
    if (i !== hoverMv.get()) scrub(i);
  };
  const onPlotKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const current = hover ?? range.b;
    const next = e.key === "ArrowLeft" || e.key === "ArrowDown" ? current - 1 : e.key === "ArrowRight" || e.key === "ArrowUp" ? current + 1 : e.key === "Home" ? range.a : e.key === "End" ? range.b : e.key === "Escape" ? -1 : null;
    if (next === null) return;
    e.preventDefault();
    scrub(next < 0 ? null : clamp(next, range.a, range.b));
  };

  const onBrushDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const part = (e.target as HTMLElement).closest<HTMLElement>("[data-part]")?.dataset.part as Part | undefined;
    const rect = e.currentTarget.getBoundingClientRect();
    const perMonth = (rect.width - GUTTER) / LAST;
    let lo = clamp(brushLo.get(), 0, LAST - MIN_SPAN), hi = clamp(brushHi.get(), lo + MIN_SPAN, LAST);
    if (!part) {
      // A press on the track brings the window there, then keeps dragging it.
      const span = target.current.hi - target.current.lo;
      lo = clamp(Math.round((e.clientX - rect.left - GUTTER) / perMonth - span / 2), 0, LAST - span); hi = lo + span;
      go(brushLo, lo, spring.smooth, reduce); go(brushHi, hi, spring.smooth, reduce);
      apply({ lo, hi });
    }
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { part: part ?? "move", x: e.clientX, lo, hi, perMonth, moved: false };
    setDragging(part ?? "move");
  };
  const onBrushMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved) {
      if (Math.abs(e.clientX - d.x) < 2) return;
      d.moved = true; brushLo.stop(); brushHi.stop();
    }
    const dm = (e.clientX - d.x) / d.perMonth;
    let lo = d.lo, hi = d.hi, shownLo = lo, shownHi = hi;
    if (d.part === "move") {
      const span = d.hi - d.lo, raw = d.lo + dm;
      lo = clamp(raw, 0, LAST - span); hi = lo + span;
      const band = rubber(raw - lo);
      shownLo = lo + band; shownHi = hi + band;
    } else if (d.part === "lo") {
      const raw = d.lo + dm;
      lo = clamp(raw, 0, d.hi - MIN_SPAN); shownLo = lo + rubber(raw - lo);
    } else {
      const raw = d.hi + dm;
      hi = clamp(raw, d.lo + MIN_SPAN, LAST); shownHi = hi + rubber(raw - hi);
    }
    brushLo.set(shownLo); brushHi.set(shownHi);
    apply({ lo, hi }, true);
  };
  const onBrushUp = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(null);
    settle(target.current.lo, target.current.hi, d.moved ? spring.snappy : spring.smooth);
  };
  const onBrushKey = (part: Part, e: KeyboardEvent<HTMLDivElement>) => {
    const { key } = e, step = e.shiftKey ? 3 : 1;
    const dir = key === "ArrowLeft" || key === "ArrowDown" ? -step : key === "ArrowRight" || key === "ArrowUp" ? step : 0;
    if (!dir && key !== "Home" && key !== "End") return;
    e.preventDefault();
    const { lo, hi } = target.current, span = hi - lo;
    let a = lo, b = hi;
    if (part === "move") { a = key === "Home" ? 0 : key === "End" ? LAST - span : clamp(lo + dir, 0, LAST - span); b = a + span; }
    else if (part === "lo") a = key === "Home" ? 0 : key === "End" ? hi - MIN_SPAN : clamp(lo + dir, 0, hi - MIN_SPAN);
    else b = key === "Home" ? lo + MIN_SPAN : key === "End" ? LAST : clamp(hi + dir, lo + MIN_SPAN, LAST);
    settle(a, b, spring.snappy);
  };

  const activePreset = PRESETS.find(p => range.a === LAST - p.months + 1 && range.b === LAST)?.months ?? null;
  if (activePreset !== null && activePreset !== shownPreset) setShownPreset(activePreset);

  const height = chartHeight(width);
  const ticks = yTicks(domain, Math.max(3, (height - PAD_TOP - PAD_BOTTOM) / 40));
  const step = xStep((width - GUTTER) / Math.max(MIN_SPAN, range.b - range.a));
  const xTicks = useMemo(() => Array.from({ length: LAST + 1 }, (_, i) => i).filter(i => monthStep(i) % step === 0), [step]);
  const s = useMemo(() => summarize(range.a, range.b), [range.a, range.b]);
  const ov = useMemo(() => overview(width), [width]);
  const months = Array.from({ length: range.b - range.a + 1 }, (_, i) => range.a + i);
  const span = rangeLabel(range.a, range.b);
  const period = `vs previous ${s.months} months`;
  const h = hover === null ? null : monthAt(hover);
  const hoverText = hover === null || !h ? undefined : `${monthLabel(hover)}: new ${money(h.newMrr)}, expansion ${money(h.expansion)}, churn ${money(-h.churn)}, net new ${money(netOf(h))}`;

  return <section className={styles.root} aria-labelledby={titleId}>
    <div className={styles.inner}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <h2 id={titleId}>Recurring revenue</h2>
          <p><Rise text={span} /></p>
        </div>
        <LayoutGroup id={`${uid}-presets`}>
          <div className={styles.presets} role="group" aria-label="Range">
            {PRESETS.map(p => <button key={p.label} type="button" className={styles.preset} aria-pressed={activePreset === p.months} aria-label={p.months === 24 ? "All 24 months" : `Last ${p.months} months`} onClick={() => settle(LAST - p.months + 1, LAST, spring.smooth)}>
              {shownPreset === p.months && <motion.span layoutId="preset" className={styles.presetPill} initial={false} animate={{ opacity: activePreset === null ? 0 : 1 }} transition={reduce ? { duration: 0 } : spring.snappy} />}
              <span className={styles.presetLabel}>{p.label}</span>
            </button>)}
          </div>
        </LayoutGroup>
      </header>

      <dl className={styles.kpis}>
        <div className={styles.kpi}>
          <dt>MRR</dt>
          <dd className={styles.value}><Num value={s.mrr / 1e6} decimals={2} suffix="M" /></dd>
          <dd><Delta text={signed(s.mrrChange, 1, "%")} change={s.mrrChange} good={s.mrrChange >= 0} context={`since ${s.since}`} /></dd>
        </div>
        <div className={styles.kpi}>
          <dt>Net new per month</dt>
          <dd className={styles.value}><Num value={s.net / 1000} suffix="k" /></dd>
          <dd><Delta text={signed(s.netChange, 1, "%")} change={s.netChange} good={s.netChange >= 0} context={period} /></dd>
        </div>
        <div className={styles.kpi}>
          <dt>Churn rate</dt>
          <dd className={styles.value}><Num value={s.churn} decimals={2} prefix="" suffix="%" /></dd>
          <dd><Delta text={signed(s.churnChange, 2, " pts")} change={s.churnChange} good={s.churnChange <= 0} context={period} /></dd>
        </div>
      </dl>

      <div className={styles.toolbar}>
        <div className={styles.legend} role="group" aria-label="Series">
          {SERIES.map((series, k) => <button key={series.key} type="button" className={styles.toggle} data-series={series.key} aria-pressed={active[k]} onClick={() => toggle(k)}>
            <span className={styles.swatch} aria-hidden="true" />{series.label}
          </button>)}
        </div>
        <button type="button" role="switch" aria-checked={compare} className={styles.switch} onClick={toggleCompare}>
          <span className={styles.track} aria-hidden="true"><motion.span className={styles.thumb} initial={false} animate={{ x: compare ? 12 : 0 }} transition={reduce ? { duration: 0 } : spring.snappy} /></span>
          Compare to previous period
        </button>
      </div>

      <div ref={chartRef} className={styles.chart}>
        <svg className={styles.svg} viewBox={`0 0 ${width} ${height}`} height={height} role="img" aria-label={`Stacked area chart of new, expansion and churned MRR, ${span}. MRR reached ${money(s.mrr)} and net new MRR averaged ${money(s.net)} a month.`} aria-describedby={tableId}>
          <defs><clipPath id={clipId}><rect x={GUTTER} y={0} width={Math.max(0, width - GUTTER)} height={height - PAD_BOTTOM + 1} /></clipPath></defs>
          <g aria-hidden="true">
            <AnimatePresence initial={false}>{ticks.map(v => <YTick key={v} value={v} yLo={yLo} yHi={yHi} height={heightMv} width={width} reduce={reduce} />)}</AnimatePresence>
            <g clipPath={`url(#${clipId})`}>
              <motion.path className={styles.areaExp} d={areaExp} />
              <motion.path className={styles.areaNew} d={areaNew} />
              <motion.path className={styles.areaChurn} d={areaChurn} />
              <motion.path className={styles.prev} d={prevTop} style={{ opacity: prevTopOpacity }} />
              <motion.path className={styles.prev} d={prevLow} style={{ opacity: prevLowOpacity }} />
              <motion.path className={styles.lineExp} d={lineExp} style={{ opacity: wExp }} />
              <motion.path className={styles.lineChurn} d={lineChurn} style={{ opacity: wChurn }} />
              <motion.path className={styles.lineNew} d={lineNew} style={{ opacity: wNew }} />
            </g>
            <AnimatePresence initial={false}>{xTicks.map(i => <XTick key={i} index={i} x0={x0} x1={x1} width={widthMv} y={height - 8} reduce={reduce} />)}</AnimatePresence>
            <motion.g className={styles.cross} style={{ x: cross, opacity: crossOpacity }}>
              <line x1={0} x2={0} y1={PAD_TOP - 6} y2={height - PAD_BOTTOM} />
              <motion.circle className={styles.dotExp} r={4} cx={0} cy={dotExp} style={{ opacity: wExp }} />
              <motion.circle className={styles.dotNew} r={4} cx={0} cy={dotNew} style={{ opacity: wNew }} />
              <motion.circle className={styles.dotChurn} r={4} cx={0} cy={dotChurn} style={{ opacity: wChurn }} />
            </motion.g>
          </g>
        </svg>

        <div className={styles.hit} style={{ left: GUTTER, bottom: PAD_BOTTOM }} tabIndex={0} role="slider" aria-label="Inspect a month" aria-orientation="horizontal"
          aria-valuemin={range.a} aria-valuemax={range.b} aria-valuenow={hover ?? range.b} aria-valuetext={hoverText ?? monthLabel(range.b)}
          onPointerDown={onPlotPointer} onPointerMove={onPlotPointer} onPointerLeave={() => scrub(null)}
          onFocus={() => { if (hover === null) scrub(range.b); }} onBlur={() => scrub(null)} onKeyDown={onPlotKey} />

        <AnimatePresence>
          {hover !== null && h && <motion.div key="panel" className={styles.panel} aria-hidden="true" style={{ x: panelX, top: PAD_TOP, width: panelWidth(width) }}
            initial={{ opacity: 0, scale: .97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .97, transition: { duration: duration.fast } }} transition={{ duration: reduce ? duration.instant : duration.fast, ease: enterEase }}>
            <p className={styles.panelMonth}><Rise text={monthLabel(hover)} /></p>
            <dl className={styles.rows}>
              {SERIES.map((series, k) => <div key={series.key} className={styles.row} data-series={series.key} data-off={active[k] ? undefined : ""}>
                <dt><span className={styles.swatch} />{series.label}</dt>
                <dd><Num value={h[series.key] / 1000} prefix={k === 2 ? "−$" : "$"} suffix="k" /></dd>
              </div>)}
              <div className={`${styles.row} ${styles.total}`}><dt>Net new</dt><dd><Num value={netOf(h) / 1000} suffix="k" /></dd></div>
              <AnimatePresence initial={false}>
                {compare && <motion.div key="previous" className={`${styles.row} ${styles.previous}`} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={reduce ? { duration: 0 } : spring.smooth}>
                  <dt><span className={styles.dash} /><Rise text={monthLabel(hover - s.months)} /></dt><dd><Num value={netOf(monthAt(hover - s.months)) / 1000} suffix="k" /></dd>
                </motion.div>}
              </AnimatePresence>
            </dl>
          </motion.div>}
        </AnimatePresence>

        <AnimatePresence>
          {!active.some(Boolean) && <motion.p className={styles.empty} style={{ left: GUTTER, bottom: PAD_BOTTOM }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduce ? duration.instant : duration.standard, ease: enterEase, delay: reduce ? 0 : .12 }}>Turn on a series to see revenue</motion.p>}
        </AnimatePresence>
      </div>

      <div className={styles.overview} data-dragging={dragging ?? undefined} onPointerDown={onBrushDown} onPointerMove={onBrushMove} onPointerUp={onBrushUp} onPointerCancel={onBrushUp}>
        <svg className={styles.overviewSvg} viewBox={`0 0 ${width} ${OVERVIEW_H + 18}`} height={OVERVIEW_H + 18} aria-hidden="true">
          {ov.years.map(y => <g key={y.i}><line className={styles.yearTick} x1={y.x} x2={y.x} y1={0} y2={OVERVIEW_H + 4} /><text className={styles.axisLabel} x={y.x + 5} y={OVERVIEW_H + 14}>{y.label}</text></g>)}
          <path className={styles.overviewArea} d={ov.areaTop} />
          <path className={styles.overviewAreaLow} d={ov.areaLow} />
          <path className={styles.overviewLine} d={ov.top} />
          <path className={styles.overviewLine} d={ov.low} />
        </svg>
        <motion.div className={styles.dim} style={{ x: GUTTER, width: dimLeft }} />
        <motion.div className={styles.dim} style={{ x: brushRight, width: dimRight }} />
        <motion.div className={styles.window} data-part="move" style={{ x: brushLeft, width: brushWidth }} tabIndex={0} role="slider" aria-label="Selected range"
          aria-valuemin={0} aria-valuemax={LAST - (range.b - range.a)} aria-valuenow={range.a} aria-valuetext={span} onKeyDown={e => onBrushKey("move", e)} />
        <motion.div className={styles.handle} data-part="lo" style={{ x: loHandle }} tabIndex={0} role="slider" aria-label="Range start"
          aria-valuemin={0} aria-valuemax={range.b - MIN_SPAN} aria-valuenow={range.a} aria-valuetext={monthLabel(range.a)} onKeyDown={e => onBrushKey("lo", e)}><span /></motion.div>
        <motion.div className={styles.handle} data-part="hi" style={{ x: hiHandle }} tabIndex={0} role="slider" aria-label="Range end"
          aria-valuemin={range.a + MIN_SPAN} aria-valuemax={LAST} aria-valuenow={range.b} aria-valuetext={monthLabel(range.b)} onKeyDown={e => onBrushKey("hi", e)}><span /></motion.div>
      </div>

      {/* A table ignores the 1px box, so it sits in a clipped wrapper; otherwise its columns widen the page at narrow widths. */}
      <div className={styles.srOnly}><table id={tableId}>
        <caption>Monthly MRR movements, {span}</caption>
        <thead><tr><th scope="col">Month</th><th scope="col">New</th><th scope="col">Expansion</th><th scope="col">Churn</th><th scope="col">Net new</th><th scope="col">MRR</th></tr></thead>
        <tbody>{months.map(i => { const m = monthAt(i); return <tr key={i}><th scope="row">{monthLabel(i)}</th><td>{money(m.newMrr)}</td><td>{money(m.expansion)}</td><td>{money(-m.churn)}</td><td>{money(netOf(m))}</td><td>{money(m.mrr)}</td></tr>; })}</tbody>
      </table></div>
    </div>
  </section>;
}

export default RevenueExplorer;
