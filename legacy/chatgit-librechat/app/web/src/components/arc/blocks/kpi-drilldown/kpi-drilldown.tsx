"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, RefObject } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion } from "motion/react";
import { ArrowDownRight, ArrowRight, ArrowUpRight, GitCompareArrows, X } from "lucide-react";
import { AnimatedCounter } from "../../animated-counter/animated-counter";
import { motionTokens } from "../../lib/motion-tokens";
import { breakdownDimensions, kpis as sampleKpis, seriesEnd } from "./kpi-drilldown-data";
import type { BreakdownRow, Kpi, KpiFormat } from "./kpi-drilldown-data";
import styles from "./kpi-drilldown.module.css";

export type { BreakdownRow, Kpi, KpiFormat } from "./kpi-drilldown-data";

export type KpiRange = "7" | "30" | "90";

export interface KpiDrilldownProps {
  /** Metrics in grid order. Each needs at least twice the longest range of daily values. */
  kpis?: Kpi[];
  /** Breakdown dimensions offered in the detail view; keys match each metric's breakdowns. */
  dimensions?: { value: string; label: string }[];
  /** ISO date of the last value in every series. */
  end?: string;
  /** Initial range in days. */
  defaultRange?: KpiRange;
  /** Controlled open metric id, or null for the grid. */
  selected?: string | null;
  /** Called when a metric opens or closes. */
  onSelectedChange?: (id: string | null) => void;
  title?: string;
  className?: string;
}

type Rect = { x: number; y: number; width: number; height: number };
type Option = { value: string; label: string };

const ranges: Option[] = [{ value: "7", label: "7 days" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** One critically damped spring for everything that travels: the panel, the container height, the tab indicator, and the chart. */
const glide = motionTokens.spring.smooth;
const expand = { type: "spring", visualDuration: .5, bounce: 0 } as const;
const still = { duration: 0 } as const;
/** The outgoing text leaves quickly so old and new barely overlap. */
const swapIn = { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.standard] as [number, number, number, number] };
const swapOut = { duration: .08, ease: [...motionTokens.ease.standard] as [number, number, number, number] };
const SPARK = 40, CHART = 72, INSET = 8;

function resample(values: number[], count: number) {
  if (values.length === 1) return Array(count).fill(values[0]);
  return Array.from({ length: count }, (_, index) => {
    const t = (index / (count - 1)) * (values.length - 1);
    const low = Math.floor(t), high = Math.min(values.length - 1, low + 1);
    return values[low] + (values[high] - values[low]) * (t - low);
  });
}
function format(value: number, spec: KpiFormat) {
  const decimals = spec.decimals ?? 0;
  const scaled = value / (spec.divisor ?? 1);
  return `${spec.prefix ?? ""}${scaled.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${spec.suffix ?? ""}`;
}
function change(kpi: Kpi, now: number, before: number) {
  const raw = kpi.kind === "rate" ? now - before : (now - before) / before * 100;
  const flat = Math.abs(raw) < .05;
  const good = kpi.lowerIsBetter ? raw < 0 : raw > 0;
  const sign = flat ? "" : raw > 0 ? "+" : "−";
  const amount = Number(Math.abs(flat ? 0 : raw).toFixed(1));
  const unit = kpi.kind === "rate" ? "\u00a0pts" : "%";
  return { raw, good, flat, sign, amount, unit, text: `${sign}${amount.toFixed(1)}${unit}` };
}
function dayLabel(end: string, back: number) {
  const date = new Date(`${end}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - back);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}
function relativeRect(node: Element, frame: Element): Rect {
  const a = node.getBoundingClientRect(), b = frame.getBoundingClientRect();
  return { x: a.left - b.left, y: a.top - b.top, width: a.width, height: a.height };
}
function linePath(values: number[], width: number, height: number, min: number, max: number, top = 0) {
  const span = max - min || 1;
  return values.map((value, index) => `${index ? "L" : "M"}${((index / (values.length - 1)) * width).toFixed(2)},${(top + (1 - (value - min) / span) * height).toFixed(2)}`).join("");
}
function useWidth(ref: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    setWidth(node.offsetWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(node.offsetWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** Text that changes in place: old and new share one grid cell and crossfade, so nothing around them jumps. */
function Swap({ id, children, reduce, className }: { id: string; children: ReactNode; reduce: boolean; className?: string }) {
  return <span className={`${styles.swap} ${className ?? ""}`}>
    <AnimatePresence initial={false}>
      <motion.span key={id} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: reduce ? still : swapIn }} exit={{ opacity: 0, transition: reduce ? still : swapOut }}>{children}</motion.span>
    </AnimatePresence>
  </span>;
}

/** Segmented tabs whose indicator glides between options on a critically damped spring. It is measured, not remounted, so it never overshoots or flickers. */
function Tabs({ options, value, onChange, label, reduce }: { options: Option[]; value: string; onChange: (value: string) => void; label: string; reduce: boolean }) {
  const track = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0), width = useMotionValue(0), shown = useMotionValue(0);
  const placed = useRef(false);

  useLayoutEffect(() => {
    const button = track.current?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!button) return;
    if (!placed.current || reduce) { x.jump(button.offsetLeft); width.jump(button.offsetWidth); shown.jump(1); track.current?.setAttribute("data-ready", ""); placed.current = true; return; }
    const a = animate(x, button.offsetLeft, glide), b = animate(width, button.offsetWidth, glide);
    return () => { a.stop(); b.stop(); };
  }, [reduce, shown, value, width, x]);

  // Fonts and container resizes move the buttons; follow them without animating.
  useEffect(() => {
    const node = track.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const button = node.querySelector<HTMLElement>('[aria-pressed="true"]');
      if (!button || x.isAnimating() || width.isAnimating()) return;
      x.jump(button.offsetLeft); width.jump(button.offsetWidth);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [width, x]);

  return <div className={styles.tabs} role="group" aria-label={label}>
    <div ref={track} className={styles.tabTrack}>
      <motion.span className={styles.indicator} style={{ x, width, opacity: shown }} aria-hidden="true" />
      {options.map(option => <button key={option.value} type="button" className={styles.tab} aria-pressed={option.value === value} onClick={() => onChange(option.value)}>{option.label}</button>)}
    </div>
  </div>;
}

function Counter({ kpi, value }: { kpi: Kpi; value: number }) {
  const { prefix = "", suffix = "", divisor = 1, decimals = 0 } = kpi.format;
  return <AnimatedCounter value={Number((value / divisor).toFixed(decimals))} prefix={prefix} suffix={suffix} decimals={decimals} />;
}

/** The change rolls digit by digit; the arrow crossfades in a fixed box. */
function Delta({ delta, label, reduce }: { delta: ReturnType<typeof change>; label?: string; reduce: boolean }) {
  const Icon = delta.flat ? ArrowRight : delta.raw > 0 ? ArrowUpRight : ArrowDownRight;
  const icon = delta.flat ? "flat" : delta.raw > 0 ? "up" : "down";
  return <span className={styles.delta} data-good={delta.good && !delta.flat ? "" : undefined} data-flat={delta.flat ? "" : undefined}>
    <Swap id={icon} reduce={reduce} className={styles.deltaIcon}><Icon size={13} aria-hidden="true" /></Swap>
    <AnimatedCounter value={delta.amount} decimals={1} prefix={delta.sign} suffix={delta.unit} />
    {label && <span className={styles.srOnly}> {label}</span>}
  </span>;
}

/** Morphs between ranges: every range is resampled to the same number of points, so the path interpolates instead of redrawing. */
function Sparkline({ values, reduce }: { values: number[]; reduce: boolean }) {
  const points = resample(values, SPARK);
  const min = Math.min(...points), max = Math.max(...points);
  const d = linePath(points, 100, 28, min, max, 2);
  return <svg className={styles.spark} viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">
    <motion.path d={`${d}L100,32L0,32Z`} className={styles.sparkArea} initial={false} animate={{ d: `${d}L100,32L0,32Z` }} transition={reduce ? still : glide} />
    <motion.path d={d} className={styles.sparkLine} initial={false} animate={{ d }} transition={reduce ? still : glide} />
  </svg>;
}

/** A chart state: both series on a shared scale. Switching ranges, metrics, or comparison blends one state into the next. */
type Frame = { a: number[]; b: number[]; min: number; max: number; pad: number };

function frameFor(current: number[], previous: number[], compare: boolean): Frame {
  const a = resample(current, CHART), b = resample(previous, CHART);
  const all = compare ? [...a, ...b] : a;
  const low = Math.min(...all), high = Math.max(...all);
  const pad = (high - low) * .12 || 1;
  return { a, b, min: low - pad, max: high + pad, pad };
}
function blend(from: Frame, to: Frame, t: number): Frame {
  const mix = (p: number, q: number) => p + (q - p) * t;
  return { a: to.a.map((value, i) => mix(from.a[i] ?? value, value)), b: to.b.map((value, i) => mix(from.b[i] ?? value, value)), min: mix(from.min, to.min), max: mix(from.max, to.max), pad: mix(from.pad, to.pad) };
}

const HEIGHT = 220, TOP = 10, BOTTOM = 24, RIGHT = 56, PLOT = HEIGHT - TOP - BOTTOM;

function DetailChart({ kpi, current, previous, compare, days, end, reduce }: { kpi: Kpi; current: number[]; previous: number[]; compare: boolean; days: number; end: string; reduce: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const clip = useId();
  const width = useWidth(wrap);
  const [hover, setHover] = useState<number | null>(null);
  const inner = Math.max(0, width - RIGHT);
  const target = useMemo(() => frameFor(current, previous, compare), [compare, current, previous]);

  // Every drawn value comes from one progress value, so the line, area, comparison, and axis labels always agree mid-flight.
  const progress = useMotionValue(1);
  const morph = useRef({ from: target, to: target, inner: 0, format: kpi.format });
  const line = useMotionValue(""), area = useMotionValue(""), before = useMotionValue("");
  const tickHigh = useMotionValue(""), tickMid = useMotionValue(""), tickLow = useMotionValue("");
  const paint = useCallback(() => {
    const { from, to, inner: w, format: spec } = morph.current;
    const f = blend(from, to, progress.get());
    const now = linePath(f.a, w, PLOT, f.min, f.max, TOP);
    line.set(now);
    area.set(`${now}L${w},${TOP + PLOT}L0,${TOP + PLOT}Z`);
    before.set(linePath(f.b, w, PLOT, f.min, f.max, TOP));
    tickHigh.set(format(f.max - f.pad, spec)); tickMid.set(format((f.max + f.min) / 2, spec)); tickLow.set(format(f.min + f.pad, spec));
  }, [area, before, line, progress, tickHigh, tickLow, tickMid]);

  useLayoutEffect(() => { morph.current.inner = inner; morph.current.format = kpi.format; paint(); }, [inner, kpi.format, paint]);
  useEffect(() => progress.on("change", paint), [paint, progress]);
  useLayoutEffect(() => {
    const state = morph.current;
    state.from = blend(state.from, state.to, progress.get());
    state.to = target;
    if (reduce) { progress.jump(1); paint(); return; }
    progress.jump(0);
    const run = animate(progress, 1, glide);
    return () => run.stop();
  }, [paint, progress, reduce, target]);

  // Gridlines sit at fixed fractions of the padded scale, so they never move; only their labels count to new values.
  const y = (value: number) => TOP + (1 - (value - target.min) / (target.max - target.min)) * PLOT;
  const gridY = [target.pad, (target.max - target.min) / 2, target.max - target.min - target.pad].map(offset => TOP + (1 - offset / (target.max - target.min)) * PLOT);
  const index = hover === null ? null : Math.round((hover / (CHART - 1)) * (days - 1));

  function pick(event: ReactPointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, inner)));
    setHover(Math.round(t * (CHART - 1)));
  }
  function onKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (event.key === "Escape" && hover !== null) { event.stopPropagation(); setHover(null); return; }
    if (!step) return;
    event.preventDefault();
    const stride = (CHART - 1) / Math.max(1, days - 1);
    setHover(value => Math.max(0, Math.min(CHART - 1, Math.round((value ?? CHART - 1) + step * stride))));
  }
  const hx = hover === null ? 0 : (hover / (CHART - 1)) * inner;
  const summary = `${kpi.label} over the last ${days} days, from ${format(current[0], kpi.format)} to ${format(current[current.length - 1], kpi.format)}.`;
  const dates = [0, Math.floor((days - 1) / 2), days - 1];
  return <div ref={wrap} className={styles.chart} role="img" aria-label={summary} tabIndex={0} onPointerMove={pick} onPointerDown={pick} onPointerLeave={() => setHover(null)} onKeyDown={onKey} onBlur={() => setHover(null)}>
    {width > 0 && <svg width={width} height={HEIGHT} aria-hidden="true">
      <defs><clipPath id={clip}><rect x={-2} y={0} width={inner + 4} height={TOP + PLOT} /></clipPath></defs>
      {[tickHigh, tickMid, tickLow].map((tick, i) => <g key={i}>
        <line x1={0} x2={inner} y1={gridY[2 - i]} y2={gridY[2 - i]} className={styles.gridLine} />
        <motion.text x={inner + 10} y={gridY[2 - i] + 4} className={styles.axisText}>{tick}</motion.text>
      </g>)}
      <g clipPath={`url(#${clip})`}>
        <motion.path d={area} className={styles.chartArea} />
        <motion.path d={before} className={styles.chartBefore} initial={false} animate={{ opacity: compare ? 1 : 0 }} transition={reduce ? still : { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.standard] }} />
        <motion.path d={line} className={styles.chartLine} />
      </g>
      {dates.map((day, i) => <DateLabel key={i} text={dayLabel(end, days - 1 - day)} x={(day / Math.max(1, days - 1)) * inner} anchor={i === 0 ? "start" : i === 2 ? "end" : "middle"} reduce={reduce} />)}
      {hover !== null && <g className={styles.cursor}>
        <line x1={hx} x2={hx} y1={TOP} y2={TOP + PLOT} />
        {compare && <circle cx={hx} cy={y(target.b[hover])} r={3} className={styles.cursorBefore} />}
        <circle cx={hx} cy={y(target.a[hover])} r={3.5} />
      </g>}
    </svg>}
    <AnimatePresence>{hover !== null && index !== null && <motion.div className={styles.tip} style={{ left: Math.max(70, Math.min(inner - 70, hx)) }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduce ? 0 : motionTokens.duration.instant }}>
      <span>{dayLabel(end, days - 1 - index)}</span>
      <strong>{format(current[index], kpi.format)}</strong>
      {compare && <small>{format(previous[index], kpi.format)} a period earlier</small>}
    </motion.div>}</AnimatePresence>
  </div>;
}

function DateLabel({ text, x, anchor, reduce }: { text: string; x: number; anchor: "start" | "middle" | "end"; reduce: boolean }) {
  return <AnimatePresence initial={false}>
    <motion.text key={text} x={x} y={HEIGHT - 6} className={styles.axisText} textAnchor={anchor} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={reduce ? still : { duration: motionTokens.duration.fast }}>{text}</motion.text>
  </AnimatePresence>;
}

/** Rows keep their place when the dimension changes: names crossfade, bars and numbers travel to their new values. */
function Breakdown({ kpi, value, dimension, dimensions, onDimension, reduce }: { kpi: Kpi; value: number; dimension: string; dimensions: Option[]; onDimension: (value: string) => void; reduce: boolean }) {
  const rows: BreakdownRow[] = kpi.breakdowns[dimension] ?? [];
  const label = dimensions.find(item => item.value === dimension)?.label ?? "Segment";
  const unit = kpi.kind === "rate" ? "\u00a0pts" : "%";
  const { prefix = "", suffix = "", divisor = 1, decimals = 0 } = kpi.format;
  return <section className={styles.breakdown} aria-label={`${kpi.label} by ${label.toLowerCase()}`}>
    <div className={styles.breakdownHead}>
      <h4>Breakdown</h4>
      <Tabs options={dimensions} value={dimension} onChange={onDimension} label="Break down by" reduce={reduce} />
    </div>
    <table className={styles.table}>
      <thead><tr>
        <th scope="col" className={styles.nameHead}><Swap id={label} reduce={reduce}>{label}</Swap></th>
        <th scope="col" className={styles.shareHead}>{kpi.kind === "rate" ? "Accounts" : "Share"}</th>
        <th scope="col" className={`${styles.num} ${styles.valueHead}`}>Value</th>
        <th scope="col" className={`${styles.num} ${styles.changeHead}`}>Change</th>
      </tr></thead>
      <tbody>
        {rows.map((row, index) => {
          const rowValue = kpi.kind === "rate" ? value * (1 + row.delta * 4) : value * row.share;
          const rowDelta = Number((row.delta * 100).toFixed(1));
          const good = kpi.lowerIsBetter ? rowDelta < 0 : rowDelta > 0;
          return <tr key={index}>
            <th scope="row"><Swap id={row.name} reduce={reduce}>{row.name}</Swap></th>
            <td className={styles.share}>
              <span className={styles.bar}><motion.span initial={false} animate={{ scaleX: row.share }} transition={reduce ? still : glide} /></span>
              <span className={styles.percent}><AnimatedCounter value={Math.round(row.share * 100)} suffix="%" /></span>
            </td>
            <td className={styles.num}><AnimatedCounter value={Number((rowValue / divisor).toFixed(decimals))} prefix={prefix} suffix={suffix} decimals={decimals} /></td>
            <td className={styles.num}><span className={styles.rowDelta} data-good={good ? "" : undefined}><AnimatedCounter value={Math.abs(rowDelta)} decimals={1} prefix={rowDelta >= 0 ? "+" : "−"} suffix={unit} /></span></td>
          </tr>;
        })}
      </tbody>
    </table>
  </section>;
}

/** The card grows into the detail: position, size, and corners on one spring; label and value keep their exact spot while the rest is revealed around them. */
function DetailPanel({ kpi, origin, bounds, closing, onClosed, onClose, onMeasure, days, compare, end, dimension, dimensions, onDimension, reduce }: {
  kpi: Kpi; origin: Rect; bounds: { width: number; height: number }; closing: Rect | null; onClosed: () => void; onClose: () => void; onMeasure: (height: number) => void;
  days: number; compare: boolean; end: string; dimension: string; dimensions: Option[]; onDimension: (value: string) => void; reduce: boolean;
}) {
  const x = useMotionValue(reduce ? INSET : origin.x), y = useMotionValue(reduce ? INSET : origin.y);
  const w = useMotionValue(reduce ? bounds.width : origin.width), h = useMotionValue(reduce ? bounds.height : origin.height);
  const shell = useMotionValue(reduce ? 0 : 1), extra = useMotionValue(0);
  const close = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const current = useMemo(() => kpi.series.slice(-days), [days, kpi.series]);
  const previous = useMemo(() => kpi.series.slice(-days * 2, -days), [days, kpi.series]);
  const value = current[current.length - 1], before = previous[previous.length - 1];
  const delta = change(kpi, value, before);

  // The content keeps its natural height; the container grows to fit it instead of scrolling inside a fixed box.
  useLayoutEffect(() => {
    const node = content.current;
    if (!node) return;
    onMeasure(node.offsetHeight + 2);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => onMeasure(node.offsetHeight + 2));
    observer.observe(node);
    return () => observer.disconnect();
  }, [onMeasure]);
  useLayoutEffect(() => {
    if (closing) return;
    if (reduce) { x.jump(INSET); y.jump(INSET); w.jump(bounds.width); h.jump(bounds.height); return; }
    animate(x, INSET, expand); animate(y, INSET, expand); animate(w, bounds.width, expand); animate(h, bounds.height, expand);
  }, [bounds.height, bounds.width, closing, h, reduce, w, x, y]);
  useEffect(() => {
    if (closing) return;
    animate(shell, 1, { duration: reduce ? motionTokens.duration.fast : 0 });
    animate(extra, 1, { duration: reduce ? motionTokens.duration.fast : motionTokens.duration.considered, delay: reduce ? 0 : .12, ease: [...motionTokens.ease.enter] });
    close.current?.focus({ preventScroll: true });
  }, [closing, extra, reduce, shell]);
  useEffect(() => {
    if (!closing) return;
    if (reduce) { const run = animate(shell, 0, { duration: motionTokens.duration.fast }); run.then(onClosed); return () => run.stop(); }
    // The panel lands exactly on the card's box and only then hands over, so it never fades out short of the card and pops.
    const runs = [animate(extra, 0, { duration: motionTokens.duration.instant }), animate(x, closing.x, expand), animate(y, closing.y, expand), animate(w, closing.width, expand), animate(h, closing.height, expand)];
    let live = true;
    Promise.all(runs).then(() => { if (live) onClosed(); });
    return () => { live = false; runs.forEach(run => run.stop()); };
  }, [closing, extra, h, onClosed, reduce, shell, w, x, y]);

  return <motion.div className={styles.panel} role="region" aria-labelledby={titleId} data-closing={closing ? "" : undefined} style={{ x, y, width: w, height: h, opacity: shell }}
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }}>
    <div ref={content} className={styles.panelContent} style={{ width: bounds.width - 2 }}>
      <div className={styles.panelHead}>
        <div className={styles.cardTop}>
          <h3 id={titleId} className={styles.label}>{kpi.label}</h3>
          <button ref={close} type="button" className={styles.close} onClick={onClose} aria-label="Back to overview"><X size={16} aria-hidden="true" /></button>
        </div>
        <div className={styles.valueRow}>
          <span className={styles.value}><Counter kpi={kpi} value={value} /></span>
          <Delta delta={delta} label={`versus the previous ${days} days`} reduce={reduce} />
          <motion.span className={styles.versus} style={{ opacity: extra }}><Swap id={`${days}`} reduce={reduce}>vs {format(before, kpi.format)} the {days} days before</Swap></motion.span>
        </div>
      </div>
      <motion.div className={styles.panelBody} style={{ opacity: extra }}>
        <p className={styles.description}>{kpi.description}</p>
        <DetailChart kpi={kpi} current={current} previous={previous} compare={compare} days={days} end={end} reduce={reduce} />
        <div className={styles.legend} aria-hidden="true">
          <span className={styles.legendNow}><Swap id={`${days}`} reduce={reduce}>Last {days} days</Swap></span>
          <motion.span className={styles.legendBefore} initial={false} animate={{ opacity: compare ? 1 : 0 }} transition={reduce ? still : { duration: motionTokens.duration.standard }}><Swap id={`${days}`} reduce={reduce}>Previous {days} days</Swap></motion.span>
        </div>
        <Breakdown kpi={kpi} value={value} dimension={dimension} dimensions={dimensions} onDimension={onDimension} reduce={reduce} />
      </motion.div>
    </div>
  </motion.div>;
}

export function KpiDrilldown({ kpis = sampleKpis, dimensions = breakdownDimensions, end = seriesEnd, defaultRange = "30", selected: selectedProp, onSelectedChange, title = "Overview", className }: KpiDrilldownProps) {
  const reduce = !!useReducedMotion();
  const [range, setRange] = useState<KpiRange>(defaultRange);
  const [compare, setCompare] = useState(true);
  const [dimension, setDimension] = useState(dimensions[0]?.value ?? "plan");
  const [inner, setInner] = useState<string | null>(null);
  const [open, setOpen] = useState<{ id: string; origin: Rect } | null>(null);
  const [closing, setClosing] = useState<Rect | null>(null);
  const [gridHeight, setGridHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLUListElement>(null);
  const cards = useRef(new Map<string, HTMLButtonElement>());
  const bodyWidth = useWidth(body);
  const floor = useMotionValue(0);
  const days = Number(range);
  const selected = selectedProp !== undefined ? selectedProp : inner;

  // The grid's own height, measured apart from the body so a taller detail never stretches the cards underneath.
  useLayoutEffect(() => {
    const node = grid.current;
    if (!node) return;
    const measure = () => setGridHeight(node.offsetHeight + node.offsetTop * 2);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Written straight to the element: the body is a plain block, and min-height lets it follow the grid whenever the grid is taller.
  useLayoutEffect(() => floor.on("change", value => { if (body.current) body.current.style.minHeight = `${value}px`; }), [floor]);
  const openHeight = open ? Math.max(gridHeight, contentHeight + INSET * 2) : gridHeight;
  // The body's height follows the panel on the same spring; it returns to the grid's height as the panel folds back.
  useLayoutEffect(() => {
    if (!gridHeight) return;
    const goal = open && !closing ? openHeight : gridHeight;
    if (reduce || floor.get() === 0) { floor.jump(open && !closing ? goal : gridHeight); return; }
    const run = animate(floor, goal, expand);
    return () => run.stop();
  }, [closing, floor, gridHeight, open, openHeight, reduce]);

  // Follow the selection, whether it changed here or through the controlled prop.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const root = body.current;
      if (selected && open?.id === selected) { if (closing) setClosing(null); return; }
      if (selected) {
        const card = cards.current.get(selected);
        if (card && root) { setClosing(null); setOpen({ id: selected, origin: relativeRect(card, root) }); }
      } else if (open && !closing) {
        const card = cards.current.get(open.id);
        if (card && root) setClosing(relativeRect(card, root));
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [closing, open, selected]);

  function choose(id: string | null) {
    if (selectedProp === undefined) setInner(id);
    onSelectedChange?.(id);
  }
  const onClosed = useCallback(() => {
    const id = open?.id;
    setOpen(null); setClosing(null);
    if (id) requestAnimationFrame(() => cards.current.get(id)?.focus({ preventScroll: true }));
  }, [open?.id]);
  const onMeasure = useCallback((height: number) => setContentHeight(height), []);

  const openKpi = kpis.find(item => item.id === open?.id) ?? null;
  const summary = useMemo(() => kpis.map(kpi => {
    const current = kpi.series.slice(-days), previous = kpi.series.slice(-days * 2, -days);
    const value = current[current.length - 1];
    return { kpi, current, value, delta: change(kpi, value, previous[previous.length - 1]) };
  }), [days, kpis]);

  return <div className={`${styles.root} ${className ?? ""}`} onKeyDown={event => { if (event.key === "Escape" && open && !closing) { event.preventDefault(); choose(null); } }}>
    <header className={styles.header}>
      <h2>{title}</h2>
      <div className={styles.controls}>
        <button type="button" className={styles.compare} aria-pressed={compare} onClick={() => setCompare(value => !value)}><GitCompareArrows size={14} aria-hidden="true" /><span>Compare</span></button>
        <Tabs options={ranges} value={range} onChange={value => setRange(value as KpiRange)} label="Date range" reduce={reduce} />
      </div>
    </header>
    <div ref={body} className={styles.body}>
      <ul ref={grid} className={styles.grid} aria-hidden={open ? true : undefined}>
        {summary.map(({ kpi, current, value, delta }) => <li key={kpi.id}>
          <button type="button" ref={node => { if (node) cards.current.set(kpi.id, node); else cards.current.delete(kpi.id); }} className={styles.card} data-hidden={open?.id === kpi.id ? "" : undefined}
            onClick={() => choose(kpi.id)} tabIndex={open ? -1 : undefined} aria-label={`${kpi.label}, ${format(value, kpi.format)}, ${delta.text} versus the previous ${days} days. Open details`}>
            <span className={styles.cardTop}><span className={styles.label}>{kpi.label}</span></span>
            <span className={styles.valueRow}><span className={styles.value}><Counter kpi={kpi} value={value} /></span><Delta delta={delta} reduce={reduce} /></span>
            <Sparkline values={current} reduce={reduce} />
          </button>
        </li>)}
      </ul>
      <AnimatePresence>{open && !closing && <motion.div key="veil" className={styles.veil} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduce ? motionTokens.duration.instant : motionTokens.duration.standard }} aria-hidden="true" />}</AnimatePresence>
      {open && openKpi && bodyWidth > 0 && <DetailPanel kpi={openKpi} origin={open.origin} bounds={{ width: bodyWidth - INSET * 2, height: contentHeight || openHeight - INSET * 2 }} closing={closing} onClosed={onClosed} onClose={() => choose(null)} onMeasure={onMeasure}
        days={days} compare={compare} end={end} dimension={dimension} dimensions={dimensions} onDimension={setDimension} reduce={reduce} />}
    </div>
  </div>;
}

export default KpiDrilldown;
