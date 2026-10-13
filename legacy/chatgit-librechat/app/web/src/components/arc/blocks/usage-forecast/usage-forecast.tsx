"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, useSpring, useTransform, type MotionValue, type Transition } from "motion/react";
import { Check, GripHorizontal } from "lucide-react";
import { AnimatedCounter } from "../../animated-counter/animated-counter";
import SegmentedControl from "../../segmented-control/segmented-control";
import { TextMorph } from "../../text-morph/text-morph";
import { motionTokens } from "../../lib/motion-tokens";
import { DAYS, METRICS, METRIC_KEYS, RULES, TODAY, crossing, curveOf, dateLabel, fixed, full, short, summarize, ticksOf, valueAt, type Metric, type MetricKey } from "./usage-data";
import styles from "./usage-forecast.module.css";

const { spring, duration, ease, stagger } = motionTokens;
const enterEase = [...ease.enter] as [number, number, number, number];
const exitEase = [...ease.standard] as [number, number, number, number];

/** Plot insets. The left gutter holds y labels; the bottom holds dates and the crossing pill. */
const GUTTER = 52, PAD_TOP = 30, PAD_BOTTOM = 30, PAD_RIGHT = 10, DEFAULT_WIDTH = 760, PANEL_W = 176;
const X_TICKS = [1, 8, 15, 22, 29];
const heightFor = (width: number) => (width < 520 ? 232 : 264);
/** Between detents the budget line takes a short, critically damped hop so snapping reads as a click, not a jump. */
const detent: Transition = { type: "spring", visualDuration: .16, bounce: 0 };
/** The crossing marker trails the budget by a beat, so it visibly slides along the forecast to its new date. */
const glide = { visualDuration: .24, bounce: 0 };
const fadeSpring = { visualDuration: .2, bounce: 0 };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** Past the ends the line keeps following the pointer with rising resistance, then springs back on release. */
const RUBBER = .07;
const rubber = (over: number) => Math.sign(over) * (1 - 1 / (Math.abs(over) * .55 / RUBBER + 1)) * RUBBER;
const norm = (m: Metric, v: number) => (v - m.lo) / (m.hi - m.lo);
const snap = (m: Metric, v: number) => Number((Math.round(v / m.step) * m.step).toFixed(2));
const unitText = (m: Metric) => m.unit.replace(" ", "\u00a0");

/** Every metric is drawn in normalized space, so a metric switch is one interpolation of equal-length point lists. */
type Frame = { actual: number[]; median: number[]; upper: number[]; lower: number[]; zero: number };
const FRAMES = Object.fromEntries(METRIC_KEYS.map(key => {
  const m = METRICS[key], n = (v: number) => norm(m, v);
  return [key, { actual: m.actual.map(n), median: m.median.map(n), upper: m.upper.map(n), lower: m.lower.map(n), zero: n(0) }];
})) as Record<MetricKey, Frame>;
const lerp = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);
function mix(a: Frame, b: Frame, t: number): Frame {
  if (t >= 1 || a === b) return b;
  return { actual: lerp(a.actual, b.actual, t), median: lerp(a.median, b.median, t), upper: lerp(a.upper, b.upper, t), lower: lerp(a.lower, b.lower, t), zero: a.zero + (b.zero - a.zero) * t };
}

type Box = { x0: number; x1: number; y0: number; y1: number };
type Geo = Box & { actual: string; forecast: string; band: string; over: string; under: string; budgetY: number; curve: number[]; upper: number[]; lower: number[]; cross: number | null; ticks: { x: number; show: boolean }[] };
const xOf = (b: Box, i: number) => b.x0 + i / DAYS * (b.x1 - b.x0);
const yOf = (b: Box, u: number) => b.y0 + (1 - u) * (b.y1 - b.y0);

function geometry(f: Frame, budget: number, width: number, height: number): Geo {
  const box = { x0: GUTTER, x1: width - PAD_RIGHT, y0: PAD_TOP, y1: height - PAD_BOTTOM };
  const pts = (values: number[], from: number) => values.map((v, k) => `${xOf(box, from + k).toFixed(2)},${yOf(box, v).toFixed(2)}`);
  const curve = curveOf(f.actual, f.median);
  const by = yOf(box, budget);
  const ticks = RULES.map(r => {
    const level = f.zero + r * (budget - f.zero), x = crossing(curve, level);
    return { x: x ?? (level <= curve[0] ? 0 : DAYS), show: x !== null && x > 0 };
  });
  return {
    ...box, curve, upper: f.upper, lower: f.lower, budgetY: by, cross: crossing(curve, budget), ticks,
    actual: `M${pts(f.actual, 0).join("L")}`,
    forecast: `M${pts(f.median, TODAY).join("L")}`,
    band: `M${pts(f.upper, TODAY).join("L")}L${pts(f.lower, TODAY).reverse().join("L")}Z`,
    over: `M0,-60H${width}V${by.toFixed(2)}H0Z`,
    under: `M0,${by.toFixed(2)}H${width}V${height + 60}H0Z`,
  };
}

function go(value: MotionValue<number>, to: number, transition: Transition, reduce: boolean) {
  if (reduce) value.jump(to);
  else animate(value, to, transition);
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

/** A sentence that wraps. Only the words that changed rise in; the rest glide to make room. */
function Words({ text }: { text: string }) {
  const reduce = !!useReducedMotion();
  const [texts, setTexts] = useState({ current: text, previous: text });
  if (texts.current !== text) setTexts({ current: text, previous: texts.current });
  const kept = new Set(texts.previous.split(" ").map((word, i) => `${i}:${word}`));
  let order = 0;
  return <span className={styles.words} aria-hidden="true">
    <AnimatePresence mode="popLayout" initial={false}>
      {text.split(" ").map((word, i) => {
        const key = `${i}:${word}`, delay = kept.has(key) ? 0 : Math.min(order++, 6) * stagger.word;
        return <motion.span key={key} className={styles.word} layout={reduce ? false : "position"}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: "0.35em" }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: "-0.3em", transition: { duration: duration.fast, ease: exitEase } }}
          transition={reduce ? { duration: duration.instant } : { layout: spring.smooth, default: { duration: duration.standard, ease: enterEase, delay } }}>{word}</motion.span>;
      })}
    </AnimatePresence>
  </span>;
}

function Num({ value, decimals, prefix = "" }: { value: number; decimals: number; prefix?: string }) {
  return <span className={styles.num}><AnimatedCounter value={value} decimals={decimals} prefix={prefix} /></span>;
}

/** An alert threshold draws a short tick where the usage line reaches it, and slides along the line as the budget moves. */
function Tick({ geo, index, on, reduce }: { geo: MotionValue<Geo>; index: number; on: boolean; reduce: boolean }) {
  const x = useTransform(geo, g => xOf(g, g.ticks[index].x));
  const y = useTransform(geo, g => yOf(g, valueAt(g.curve, g.ticks[index].x)));
  const shownRaw = useTransform(geo, (g): number => (g.ticks[index].show ? 1 : 0));
  const shownSpring = useSpring(shownRaw, fadeSpring);
  const draw = reduce ? { duration: 0 } : spring.smooth;
  return <motion.g style={{ x, y, opacity: reduce ? shownRaw : shownSpring }}>
    <motion.path className={styles.tick} d="M0,7V-7" initial={false} animate={{ pathLength: on ? 1 : 0, opacity: on ? 1 : 0 }} transition={draw} />
    <motion.g initial={false} animate={{ opacity: on ? 1 : 0 }} transition={{ duration: reduce ? 0 : duration.fast, delay: on && !reduce ? .08 : 0 }}>
      <text className={styles.tickLabel} x={-6} y={-6} textAnchor="end">{Math.round(RULES[index] * 100)}%</text>
    </motion.g>
  </motion.g>;
}

/** Date labels step aside when the crossing pill passes over them. */
function XLabel({ day, x, y, right, markerX, markerOn }: { day: number; x: number; y: number; right: number; markerX: MotionValue<number>; markerOn: MotionValue<number> }) {
  const opacity = useTransform(() => 1 - markerOn.get() * clamp(1 - (Math.abs(markerX.get() - x) - 28) / 12, 0, 1));
  // A label that would run past the plot's right edge aligns to it instead of clipping.
  const flush = x + 20 > right;
  return <motion.g style={{ opacity }}><text className={styles.axis} x={flush ? right : x} y={y} textAnchor={flush ? "end" : "middle"}>Sep {day}</text></motion.g>;
}

function ruleStatus(x: number | null) {
  if (x === null) return "Not expected";
  if (x <= 0) return "Since Sep 1";
  return x <= TODAY ? `Reached ${dateLabel(x)}` : `Expected ${dateLabel(x)}`;
}

export function UsageForecast() {
  const reduce = !!useReducedMotion();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const titleId = `${uid}-title`, tableId = `${uid}-table`, overId = `${uid}-over`, underId = `${uid}-under`, noteId = `${uid}-note`;

  const [metric, setMetric] = useState<MetricKey>("calls");
  const [budgets, setBudgets] = useState<Record<MetricKey, number>>(() => ({ calls: METRICS.calls.budget, storage: METRICS.storage.budget, seats: METRICS.seats.budget }));
  const [rules, setRules] = useState([false, true, true]);
  const [hover, setHover] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [width, setWidth] = useState(DEFAULT_WIDTH);

  const m = METRICS[metric], budget = budgets[metric];
  const s = useMemo(() => summarize(m, budget), [m, budget]);
  // The crossing pill keeps its last date while it fades out, so it never collapses to an empty pill first.
  const [whenText, setWhenText] = useState(() => (s.at === null ? "" : dateLabel(s.at)));
  if (s.at !== null && dateLabel(s.at) !== whenText) setWhenText(dateLabel(s.at));
  const curve = useMemo(() => curveOf(m.actual, m.median), [m]);

  // Per-frame geometry lives in motion values; React state only changes when a value, day or metric changes.
  const pair = useMotionValue<{ from: Frame; to: Frame }>({ from: FRAMES.calls, to: FRAMES.calls });
  const progress = useMotionValue(1);
  const budgetN = useMotionValue(norm(METRICS.calls, METRICS.calls.budget));
  const widthMv = useMotionValue(DEFAULT_WIDTH), heightMv = useMotionValue(heightFor(DEFAULT_WIDTH)), hoverMv = useMotionValue(-1);
  const geo = useTransform(() => { const { from, to } = pair.get(); return geometry(mix(from, to, progress.get()), budgetN.get(), widthMv.get(), heightMv.get()); });

  const actualD = useTransform(geo, g => g.actual), forecastD = useTransform(geo, g => g.forecast), bandD = useTransform(geo, g => g.band);
  const overD = useTransform(geo, g => g.over), underD = useTransform(geo, g => g.under);
  const budgetY = useTransform(geo, g => Math.round(g.budgetY));
  const zoneY = useTransform(budgetY, y => y - 16);
  const todayY = useTransform(geo, g => yOf(g, g.curve[TODAY]));

  const crossRaw = useTransform(geo, g => g.cross ?? DAYS);
  const crossSpring = useSpring(crossRaw, glide);
  const crossDay = reduce ? crossRaw : crossSpring;
  const markerOnRaw = useTransform(geo, (g): number => (g.cross === null ? 0 : 1));
  const markerOnSpring = useSpring(markerOnRaw, fadeSpring);
  const markerOn = reduce ? markerOnRaw : markerOnSpring;
  const markerX = useTransform(() => xOf(geo.get(), crossDay.get()));
  const markerY = useTransform(() => { const g = geo.get(); return yOf(g, valueAt(g.curve, crossDay.get())); });
  const dropD = useTransform(() => { const g = geo.get(); return `M${markerX.get().toFixed(2)},${markerY.get().toFixed(2)}V${g.y1}`; });
  const pillX = useTransform(() => clamp(markerX.get(), GUTTER + 22, widthMv.get() - PAD_RIGHT - 22));

  // Computed values read every dependency up front so each one stays subscribed.
  const hoverX = useTransform(() => { const i = hoverMv.get(), g = geo.get(); return i < 0 ? 0 : Math.round(xOf(g, i)) + .5; });
  const hoverY = useTransform(() => { const i = hoverMv.get(), g = geo.get(); return i < 0 ? 0 : yOf(g, g.curve[i]); });
  const hoverRange = useTransform(() => {
    const i = hoverMv.get(), g = geo.get(), k = i - TODAY;
    return k > 0 ? `M0,${yOf(g, g.upper[k]).toFixed(2)}V${yOf(g, g.lower[k]).toFixed(2)}` : "M0,0";
  });
  const hoverOn = useTransform(hoverMv, (i): number => (i < 0 ? 0 : 1));
  const panelRaw = useTransform(() => {
    const i = hoverMv.get(), w = widthMv.get(), x = xOf(geo.get(), Math.max(0, i));
    return x + 14 + PANEL_W <= w ? x + 14 : Math.max(0, x - 14 - PANEL_W);
  });
  const panelSpring = useSpring(panelRaw, { visualDuration: .22, bounce: 0 });
  const panelX = reduce ? panelRaw : panelSpring;

  const chartRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; from: number; plot: number; value: number; stretched: boolean } | null>(null);

  useEffect(() => {
    const el = chartRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (!w) return;
      setWidth(w); widthMv.set(w); heightMv.set(heightFor(w));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [widthMv, heightMv]);

  function scrub(i: number | null) {
    const was = hoverMv.get();
    hoverMv.set(i ?? -1);
    setHover(i);
    // A panel that appears starts beside its day; only later moves glide.
    if (i !== null && was < 0) {
      const w = widthMv.get(), x = xOf(geo.get(), i);
      panelSpring.jump(x + 14 + PANEL_W <= w ? x + 14 : Math.max(0, x - 14 - PANEL_W));
    }
  }

  function choose(next: string) {
    const key = next as MetricKey;
    if (key === metric) return;
    const { from, to } = pair.get();
    // Retarget from wherever the lines are right now, even mid-morph.
    pair.set({ from: mix(from, to, progress.get()), to: FRAMES[key] });
    if (reduce) progress.jump(1);
    else { progress.jump(0); animate(progress, 1, spring.smooth); }
    go(budgetN, norm(METRICS[key], budgets[key]), spring.smooth, reduce);
    setMetric(key);
  }

  const setBudget = (value: number) => setBudgets(b => (b[metric] === value ? b : { ...b, [metric]: value }));

  const onZoneDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, from: budget, plot: heightMv.get() - PAD_TOP - PAD_BOTTOM, value: budget, stretched: false };
    setDragging(true);
    scrub(null);
  };
  const onZoneMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const raw = d.from + (d.y - e.clientY) / d.plot * (m.hi - m.lo);
    const held = clamp(raw, m.min, m.hi), value = clamp(snap(m, held), m.min, m.hi);
    if (raw !== held) { budgetN.stop(); budgetN.set(norm(m, held) + rubber(norm(m, raw) - norm(m, held))); }
    else if (value !== d.value || d.stretched) go(budgetN, norm(m, value), detent, reduce);
    d.value = value; d.stretched = raw !== held;
    setBudget(value);
  };
  const onZoneUp = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(false);
    go(budgetN, norm(m, d.value), spring.snappy, reduce);
  };
  const onZoneKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const big = m.step * 5;
    const steps: Record<string, number> = { ArrowUp: m.step, ArrowRight: m.step, ArrowDown: -m.step, ArrowLeft: -m.step, PageUp: big, PageDown: -big };
    const delta = steps[e.key];
    const next = e.key === "Home" ? m.min : e.key === "End" ? m.hi : delta === undefined ? null : clamp(snap(m, budget + delta), m.min, m.hi);
    if (next === null) return;
    e.preventDefault();
    setBudget(next);
    go(budgetN, norm(m, next), spring.snappy, reduce);
  };

  const dayAt = (clientX: number) => {
    const rect = chartRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return clamp(Math.round((clientX - rect.left - GUTTER) / Math.max(1, rect.width - GUTTER - PAD_RIGHT) * DAYS), 1, DAYS);
  };
  const onChartMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) return;
    const i = dayAt(e.clientX);
    if (i !== null && i !== hoverMv.get()) scrub(i);
  };
  const onPlotKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const current = hover ?? TODAY;
    const moves: Record<string, number> = { ArrowLeft: current - 1, ArrowDown: current - 1, ArrowRight: current + 1, ArrowUp: current + 1, PageDown: current - 7, PageUp: current + 7, Home: 1, End: DAYS, Escape: -1 };
    const next = moves[e.key];
    if (next === undefined) return;
    e.preventDefault();
    scrub(next < 0 ? null : clamp(next, 1, DAYS));
  };
  const toggleRule = (k: number) => setRules(r => r.map((on, i) => (i === k ? !on : on)));

  const height = heightFor(width);
  const box = { x0: GUTTER, x1: width - PAD_RIGHT, y0: PAD_TOP, y1: height - PAD_BOTTOM };
  const todayX = Math.round(xOf(box, TODAY)) + .5;
  const ticks = ticksOf(m);
  const unit = unitText(m);
  const describe = (i: number) => i > TODAY
    ? `Sep ${i} forecast: ${full(m, curve[i])}, likely ${fixed(m, m.lower[i - TODAY])} to ${full(m, m.upper[i - TODAY])}`
    : `Sep ${i}: ${full(m, curve[i])} used, ${Math.round(curve[i] / budget * 100)}% of budget`;
  const summary = `${m.label}: ${s.headline}. ${s.detail}`;

  return <section className={styles.root} aria-labelledby={titleId}>
    <div className={styles.inner}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <h2 id={titleId}>Usage forecast</h2>
          <p>Northwind Labs · Scale plan · Renews Oct 1</p>
        </div>
        <SegmentedControl label="Metric" value={metric} onValueChange={choose} options={METRIC_KEYS.map(key => ({ value: key, label: METRICS[key].label }))} />
      </header>

      <div className={styles.story}>
        <p className={styles.headline}><Words text={s.headline} /></p>
        <p className={styles.detail}><Words text={s.detail} /></p>
        <p className={styles.srOnly} aria-live="polite">{summary}</p>
      </div>

      <dl className={styles.kpis}>
        <div className={styles.kpi}>
          <dt>Used so far</dt>
          <dd className={styles.value}><Num value={Number(fixed(m, s.used))} decimals={m.decimals} /><Rise text={unit} className={styles.unit} /></dd>
          <dd className={styles.foot}><Rise text={`${s.usedPct}% of budget`} /></dd>
        </div>
        <div className={styles.kpi}>
          <dt>Projected by Sep 30</dt>
          <dd className={styles.value}><Num value={Number(fixed(m, s.end))} decimals={m.decimals} /><Rise text={unit} className={styles.unit} /></dd>
          <dd className={styles.foot}><Rise text={`Likely ${fixed(m, s.endLow)}–${full(m, s.endHigh)}`} /></dd>
        </div>
        <div className={styles.kpi}>
          <dt>Cost above budget</dt>
          <dd className={styles.value} data-tone={s.cost > 0 ? "over" : undefined}><Num value={Math.round(s.cost)} decimals={0} prefix="$" /></dd>
          <dd className={styles.foot}><Rise text={s.cost > 0 ? m.priceNote : "Within budget"} /></dd>
        </div>
      </dl>

      <div ref={chartRef} className={styles.chart} style={{ height }} data-dragging={dragging || undefined} onPointerMove={onChartMove} onPointerLeave={() => { if (!drag.current) scrub(null); }}>
        <svg className={styles.svg} viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-describedby={tableId}
          aria-label={`${m.label} this billing period: ${full(m, s.used)} used through Sep 22, forecast ${full(m, s.end)} by Sep 30 against a ${full(m, budget)} budget. ${s.headline}.`}>
          <defs>
            <clipPath id={overId}><motion.path d={overD} /></clipPath>
            <clipPath id={underId}><motion.path d={underD} /></clipPath>
          </defs>
          <g aria-hidden="true">
            <rect className={styles.future} x={todayX} y={box.y0} width={Math.max(0, box.x1 - todayX)} height={box.y1 - box.y0} />
            {ticks.map((_, i) => { const y = Math.round(yOf(box, i / 5)) + .5; return <line key={i} className={i === 0 ? styles.baseline : styles.grid} x1={GUTTER} x2={box.x1} y1={y} y2={y} />; })}
            {X_TICKS.map(day => <XLabel key={day} day={day} x={xOf(box, day)} y={height - 10} right={width - 1} markerX={pillX} markerOn={markerOn} />)}
            <line className={styles.todayLine} x1={todayX} x2={todayX} y1={box.y0 - 8} y2={box.y1} />
            <text className={styles.todayLabel} x={todayX} y={box.y0 - 14} textAnchor="middle">Today</text>

            <motion.path className={styles.band} d={bandD} clipPath={`url(#${underId})`} />
            <motion.path className={`${styles.band} ${styles.bandOver}`} d={bandD} clipPath={`url(#${overId})`} />
            <motion.path className={styles.forecast} d={forecastD} clipPath={`url(#${underId})`} />
            <motion.path className={`${styles.forecast} ${styles.over}`} d={forecastD} clipPath={`url(#${overId})`} />
            <motion.path className={styles.actual} d={actualD} clipPath={`url(#${underId})`} />
            <motion.path className={`${styles.actual} ${styles.over}`} d={actualD} clipPath={`url(#${overId})`} />

            <motion.g style={{ y: budgetY }}><line className={styles.budget} x1={GUTTER} x2={box.x1} y1={.5} y2={.5} /></motion.g>
            {RULES.map((_, k) => <Tick key={k} geo={geo} index={k} on={rules[k]} reduce={reduce} />)}

            <motion.g style={{ opacity: markerOn }}>
              <motion.path className={styles.drop} d={dropD} />
              <motion.circle className={styles.marker} r={5} cx={markerX} cy={markerY} />
            </motion.g>
            <motion.circle className={styles.todayDot} r={4} cx={todayX} cy={todayY} />

            <motion.g style={{ opacity: hoverOn }}>
              <motion.line className={styles.hoverLine} x1={hoverX} x2={hoverX} y1={box.y0} y2={box.y1} />
              <motion.g style={{ x: hoverX }}><motion.path className={styles.hoverRange} d={hoverRange} /></motion.g>
              <motion.circle className={styles.hoverDot} data-forecast={hover !== null && hover > TODAY ? "" : undefined} r={4} cx={hoverX} cy={hoverY} />
            </motion.g>
          </g>
        </svg>

        <div className={styles.yLabels} style={{ width: GUTTER - 10 }} aria-hidden="true">
          {ticks.map((v, i) => <span key={i} className={styles.yLabel} style={{ top: Math.round(yOf(box, i / 5)) }}><Rise text={short(m, v)} /></span>)}
        </div>

        <div className={styles.hit} style={{ left: GUTTER, right: PAD_RIGHT, bottom: PAD_BOTTOM }} tabIndex={0} role="slider" aria-label="Inspect a day" aria-orientation="horizontal"
          aria-valuemin={1} aria-valuemax={DAYS} aria-valuenow={hover ?? TODAY} aria-valuetext={describe(hover ?? TODAY)}
          onPointerDown={e => { const i = dayAt(e.clientX); if (i !== null) scrub(i); }}
          onFocus={() => { if (hoverMv.get() < 0) scrub(TODAY); }} onBlur={() => scrub(null)} onKeyDown={onPlotKey} />

        <motion.div className={styles.zone} style={{ left: GUTTER, right: PAD_RIGHT, y: zoneY }} data-dragging={dragging || undefined}
          tabIndex={0} role="slider" aria-label={`${m.label} budget`} aria-orientation="vertical" aria-describedby={noteId}
          aria-valuemin={m.min} aria-valuemax={m.hi} aria-valuenow={budget} aria-valuetext={full(m, budget)}
          onPointerDown={onZoneDown} onPointerMove={onZoneMove} onPointerUp={onZoneUp} onPointerCancel={onZoneUp} onKeyDown={onZoneKey}>
          <span className={styles.handle}>
            <GripHorizontal size={14} strokeWidth={1.75} aria-hidden="true" />
            <span className={styles.handleLabel}>Budget</span>
            <span className={styles.handleValue}><Num value={budget} decimals={m.step < 1 ? 1 : 0} /><Rise text={unit} /></span>
          </span>
        </motion.div>

        <motion.div className={styles.when} style={{ x: pillX, top: box.y1 + 6, opacity: markerOn }} aria-hidden="true">
          <span className={styles.whenInner}><Rise text={whenText} /></span>
        </motion.div>

        <AnimatePresence>
          {hover !== null && <motion.div key="panel" className={styles.panel} aria-hidden="true" style={{ x: panelX, top: PAD_TOP, width: PANEL_W }}
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: .97 }} animate={{ opacity: 1, scale: 1 }} exit={reduce ? { opacity: 0, transition: { duration: duration.instant } } : { opacity: 0, scale: .97, transition: { duration: duration.fast } }} transition={{ duration: reduce ? duration.instant : duration.fast, ease: enterEase }}>
            <p className={styles.panelHead}><span>Sep {hover}</span><span className={styles.panelTag}>{hover > TODAY ? "Forecast" : hover === TODAY ? "Today" : "Actual"}</span></p>
            <p className={styles.panelValue}>{full(m, curve[hover])}</p>
            <p className={styles.panelNote}>{hover > TODAY ? `Likely ${fixed(m, m.lower[hover - TODAY])}–${full(m, m.upper[hover - TODAY])}` : `${Math.round(curve[hover] / budget * 100)}% of budget`}</p>
          </motion.div>}
        </AnimatePresence>
      </div>

      <footer className={styles.footer}>
        <div className={styles.rules} role="group" aria-label="Budget alerts" aria-describedby={noteId}>
          <span className={styles.rulesLabel}>Alert at</span>
          {RULES.map((r, k) => { const status = ruleStatus(s.rules[k]); return <button key={r} type="button" className={styles.rule} aria-pressed={rules[k]} aria-label={`${Math.round(r * 100)}% of budget, ${status.toLowerCase()}`} onClick={() => toggleRule(k)}>
            <motion.span className={styles.check} initial={false} animate={{ width: rules[k] ? 20 : 0, opacity: rules[k] ? 1 : 0 }} transition={reduce ? { duration: 0 } : spring.snappy} aria-hidden="true"><Check size={14} strokeWidth={2} /></motion.span>
            <span className={styles.rulePct}>{Math.round(r * 100)}%</span>
            <TextMorph className={styles.ruleWhen}>{status}</TextMorph>
          </button>; })}
        </div>
        <ul className={styles.legend} aria-label="Legend">
          <li><svg width="16" height="8" aria-hidden="true"><line className={styles.actual} x1="1" x2="15" y1="4" y2="4" /></svg>Actual</li>
          <li><svg width="16" height="8" aria-hidden="true"><line className={styles.forecast} x1="0" x2="16" y1="4" y2="4" /></svg>Forecast</li>
          <li><svg width="12" height="10" aria-hidden="true"><rect className={styles.band} width="12" height="10" rx="2" /></svg>Likely range</li>
          <li><svg width="16" height="8" aria-hidden="true"><line className={`${styles.actual} ${styles.over}`} x1="1" x2="15" y1="4" y2="4" /></svg>Over budget</li>
        </ul>
        <p id={noteId} className={styles.srOnly}>Drag the budget line or use the arrow keys.</p>
      </footer>

      <table className={styles.srOnly} id={tableId}>
        <caption>{m.label}, Sep 1 to 30, 2026</caption>
        <thead><tr><th scope="col">Date</th><th scope="col">Reading</th><th scope="col">Likely range</th></tr></thead>
        <tbody>{Array.from({ length: DAYS }, (_, k) => k + 1).map(d => <tr key={d}>
          <th scope="row">Sep {d}{d > TODAY ? " (forecast)" : ""}</th>
          <td>{full(m, curve[d])}</td>
          <td>{d > TODAY ? `${fixed(m, m.lower[d - TODAY])} to ${full(m, m.upper[d - TODAY])}` : "Measured"}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}

export default UsageForecast;
