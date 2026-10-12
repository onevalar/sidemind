"use client";

import { memo, useEffect, useId, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from "react";
import { animate, motion, useMotionValue, useReducedMotion, useTransform, type MotionValue, type Transition } from "motion/react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import SegmentedControl from "../../segmented-control/segmented-control";
import { Switch } from "../../switch/switch";
import { motionTokens } from "../../lib/motion-tokens";
import {
  smallMultiplesDescription, smallMultiplesPeriods, smallMultiplesSeries, smallMultiplesTitle,
  type SmallMultiplesScale, type SmallMultiplesSeries, type SmallMultiplesSort,
} from "./small-multiples-data";
import styles from "./small-multiples.module.css";

export type { SmallMultiplesScale, SmallMultiplesSeries, SmallMultiplesSort } from "./small-multiples-data";

export interface SmallMultiplesPeriod {
  /** Short label for compact places, such as "Sep 2025". */
  short: string;
  /** Full label for the readout and screen readers, such as "September 2025". */
  long: string;
}

export interface SmallMultiplesProps {
  /** One panel per series. Every series has one value per period. */
  series?: SmallMultiplesSeries[];
  /** Periods on the shared x axis, oldest first. */
  periods?: SmallMultiplesPeriod[];
  title?: string;
  /** Line under the title. Pass an empty string to hide it. */
  description?: string;
  /** Opening panel order. */
  defaultSort?: SmallMultiplesSort;
  /** Opening y scale: shared compares size, independent compares shape. */
  defaultScale?: SmallMultiplesScale;
  /** Whether panels with a flat trend start dimmed. */
  defaultDimFlat?: boolean;
  /** Growth below this absolute share (0.05 is 5%) counts as flat. */
  flatThreshold?: number;
  /** Periods between the latest value and the one growth is measured against. 12 compares with the same month last year. */
  growthLag?: number;
  /** Formats a value for panel headings, the readout and screen readers. */
  formatValue?: (value: number) => string;
  /** Formats a compact axis tick. */
  formatTick?: (value: number) => string;
  onSortChange?: (sort: SmallMultiplesSort) => void;
  onScaleChange?: (scale: SmallMultiplesScale) => void;
  /** Called when the synced crosshair moves to a period, or with null when it leaves. */
  onIndexChange?: (index: number | null) => void;
  className?: string;
}

const { spring, duration, ease } = motionTokens;
/** Axes and lines rescale together on one critically damped spring, so a scale switch reads as one move. */
const rescale: Transition = { ...spring.smooth, visualDuration: .55 };
/** Panels travel to their new slot on the same no-overshoot character, a little longer because they cross the grid. */
const reorder: Transition = { ...spring.smooth, visualDuration: .6 };
/** The crosshair trails the pointer by a short beat and lands exactly on the period it reports. */
const follow: Transition = { type: "spring", visualDuration: .16, bounce: 0 };
const instant: Transition = { duration: 0 };
const tickFade: Transition = { duration: duration.standard, ease: [...ease.standard] as [number, number, number, number] };

const W = 1000, H = 100;
/** Ticks whose label would touch the top or bottom edge stay hidden. */
const TICK_WINDOW: [number, number] = [.14, .9];
const SORTS = [{ value: "latest", label: "Latest" }, { value: "growth", label: "Growth" }, { value: "name", label: "Name" }];
const SCALES = [{ value: "independent", label: "Independent" }, { value: "shared", label: "Shared" }];
const SORT_WORDS: Record<SmallMultiplesSort, string> = { latest: "latest value", growth: "growth", name: "name" };

const minus = "−";
const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

/** Values are in thousands of US dollars. */
function defaultFormatValue(value: number) {
  if (Math.abs(value) >= 1000) return `$${(value / 1000).toFixed(2)}M`;
  return `$${Math.round(value)}k`;
}
function defaultFormatTick(value: number) {
  if (Math.abs(value) >= 1000) return `$${Number((value / 1000).toFixed(1))}M`;
  return `$${Math.round(value)}k`;
}
function percent(value: number) {
  const size = Math.abs(value) * 100;
  return `${value < 0 && size >= .05 ? minus : "+"}${size.toFixed(1)}%`;
}

function niceStep(range: number, count: number) {
  const raw = range / Math.max(1, count);
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const norm = raw / magnitude;
  return (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * magnitude;
}
function ticksFor(lo: number, hi: number, count: number) {
  const step = niceStep(hi - lo, count);
  const out: number[] = [];
  for (let value = Math.ceil(lo / step) * step; value <= hi + 1e-9; value += step) out.push(Math.round(value * 1e6) / 1e6);
  return out;
}

interface Domain { lo: number; hi: number }

/** Value at a fractional index, so a dot riding the crosshair stays on the line between periods. */
function valueAt(values: number[], position: number) {
  const index = clamp(position, 0, values.length - 1);
  const low = Math.floor(index), high = Math.min(values.length - 1, low + 1);
  return values[low] + (values[high] - values[low]) * (index - low);
}
function linePath(values: number[], lo: number, hi: number) {
  const span = hi - lo || 1, last = Math.max(1, values.length - 1);
  return values.map((value, index) => `${index ? "L" : "M"}${((index / last) * W).toFixed(2)},${((1 - (value - lo) / span) * H).toFixed(2)}`).join("");
}

/** Springs a panel's y domain; every path, tick and dot derives from these two values on the same frame. */
function useDomain(target: Domain, reduce: boolean) {
  const lo = useMotionValue(target.lo), hi = useMotionValue(target.hi);
  useEffect(() => {
    const a = animate(lo, target.lo, reduce ? instant : rescale);
    const b = animate(hi, target.hi, reduce ? instant : rescale);
    return () => { a.stop(); b.stop(); };
  }, [target.lo, target.hi, lo, hi, reduce]);
  return { lo, hi };
}

function Tick({ value, visible, lo, hi, label }: { value: number; visible: boolean; lo: MotionValue<number>; hi: MotionValue<number>; label: string }) {
  const y = useTransform(() => `${(1 - (value - lo.get()) / (hi.get() - lo.get() || 1)) * 100}%`);
  return <motion.div className={styles.tickLayer} style={{ y }} initial={false} animate={{ opacity: visible ? 1 : 0 }} transition={tickFade} aria-hidden="true">
    <span className={styles.tickLine} />
    <span className={styles.tickLabel}>{label}</span>
  </motion.div>;
}

interface PanelProps {
  item: SmallMultiplesSeries;
  latest: number;
  growth: number;
  flat: boolean;
  dim: boolean;
  target: Domain;
  ticks: { value: number; visible: boolean }[];
  ghost: string;
  cx: MotionValue<number>;
  cursor: number | null;
  compareLabel: string;
  layoutKey: string;
  reduce: boolean;
  formatValue: (value: number) => string;
  formatTick: (value: number) => string;
}

const Panel = memo(function Panel({ item, latest, growth, flat, dim, target, ticks, ghost, cx, cursor, compareLabel, layoutKey, reduce, formatValue, formatTick }: PanelProps) {
  const { lo, hi } = useDomain(target, reduce);
  const values = item.values;
  const last = Math.max(1, values.length - 1);
  const line = useTransform(() => linePath(values, lo.get(), hi.get()));
  const area = useTransform(() => `${linePath(values, lo.get(), hi.get())}L${W},${H}L0,${H}Z`);
  const fracY = (value: number) => `${(1 - (value - lo.get()) / (hi.get() - lo.get() || 1)) * 100}%`;
  const endY = useTransform(() => fracY(values[values.length - 1]));
  const crossX = useTransform(() => `${cx.get() * 100}%`);
  const crossY = useTransform(() => fracY(valueAt(values, cx.get() * last)));
  const shown = cursor === null ? latest : values[clamp(cursor, 0, values.length - 1)];
  const Icon = flat ? Minus : growth > 0 ? ArrowUpRight : ArrowDownRight;
  const trendText = flat ? "Flat" : percent(growth);
  const trendWords = `${flat ? "Flat trend, " : growth > 0 ? "Up " : "Down "}${flat ? percent(growth) : `${Math.abs(growth * 100).toFixed(1)}%`} ${compareLabel}`;

  return <motion.li className={styles.panel} layout="position" layoutDependency={layoutKey} transition={reduce ? instant : reorder} data-dim={dim || undefined}>
    <div className={styles.panelInner}>
      <div className={styles.panelHead}>
        <h3 className={styles.name}>{item.name}</h3>
        <span className={styles.value} data-scrub={cursor !== null || undefined}>{formatValue(shown)}</span>
      </div>
      <p className={styles.trend} data-flat={flat || undefined}>
        <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
        <span className={styles.trendValue} aria-hidden="true">{trendText}</span>
        <span className={styles.compare} aria-hidden="true">{flat ? percent(growth) : compareLabel}</span>
        <span className={styles.srOnly}>{trendWords}</span>
      </p>
      <div className={styles.plot} aria-hidden="true">
        <div className={styles.ticks}>
          {ticks.map(tick => <Tick key={tick.value} value={tick.value} visible={tick.visible} lo={lo} hi={hi} label={formatTick(tick.value)} />)}
        </div>
        <div className={styles.chart} data-plot="">
          <svg className={styles.svg} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" focusable="false">
            <path className={styles.ghostLine} d={ghost} vectorEffect="non-scaling-stroke" />
            <motion.path className={styles.area} d={area} />
            <motion.path className={styles.line} d={line} vectorEffect="non-scaling-stroke" />
          </svg>
          <div className={styles.xLayer} style={{ transform: "translateX(100%)" }}>
            <motion.div className={styles.yLayer} style={{ y: endY }}><span className={styles.endDot} /></motion.div>
          </div>
          <motion.div className={styles.xLayer} data-cross="" data-on={cursor !== null || undefined} style={{ x: crossX }}>
            <span className={styles.crossLine} />
            <motion.div className={styles.yLayer} style={{ y: crossY }}><span className={styles.crossDot} /></motion.div>
          </motion.div>
        </div>
      </div>
    </div>
  </motion.li>;
});

export function SmallMultiples({
  series = smallMultiplesSeries,
  periods = smallMultiplesPeriods,
  title = smallMultiplesTitle,
  description = smallMultiplesDescription,
  defaultSort = "latest",
  defaultScale = "independent",
  defaultDimFlat = true,
  flatThreshold = .05,
  growthLag = 12,
  formatValue = defaultFormatValue,
  formatTick = defaultFormatTick,
  onSortChange,
  onScaleChange,
  onIndexChange,
  className,
}: SmallMultiplesProps) {
  const uid = useId();
  const reduce = useReducedMotion() ?? false;
  const [sort, setSort] = useState<SmallMultiplesSort>(defaultSort);
  const [scale, setScale] = useState<SmallMultiplesScale>(defaultScale);
  const [dimFlat, setDimFlat] = useState(defaultDimFlat);
  const [cursor, setCursor] = useState<number | null>(null);
  const [live, setLive] = useState("");

  const n = Math.max(0, ...series.map(item => item.values.length), periods.length ? 1 : 0);
  const last = Math.max(0, n - 1);
  const lag = clamp(growthLag, 1, Math.max(1, last));
  const compareLabel = `vs ${periods[last - lag]?.short ?? "start"}`;

  const stats = useMemo(() => series.map(item => {
    const values = item.values;
    const latest = values[values.length - 1] ?? 0;
    const base = values[Math.max(0, values.length - 1 - lag)] ?? latest;
    const growth = base ? latest / base - 1 : 0;
    return { item, latest, growth, flat: Math.abs(growth) < flatThreshold, min: Math.min(...values), max: Math.max(...values) };
  }), [series, lag, flatThreshold]);

  const totals = useMemo(() => Array.from({ length: n }, (_, index) => series.reduce((sum, item) => sum + (item.values[index] ?? 0), 0)), [series, n]);

  // The total is drawn in its own scale, so every panel shows the overall shape behind its own line.
  const ghost = useMemo(() => {
    if (!totals.length) return "";
    const min = Math.min(...totals), max = Math.max(...totals), pad = (max - min || 1) * .45;
    return linePath(totals, min - pad * .4, max + pad * .2);
  }, [totals]);

  const order = useMemo(() => {
    const list = [...stats];
    if (sort === "latest") list.sort((a, b) => b.latest - a.latest);
    else if (sort === "growth") list.sort((a, b) => b.growth - a.growth);
    else list.sort((a, b) => a.item.name.localeCompare(b.item.name, "en"));
    return list;
  }, [stats, sort]);
  const layoutKey = order.map(entry => entry.item.id).join(",");

  // Shared starts at zero and fits the largest series, so height compares size. Independent pads each series, so height compares shape.
  const sharedHi = useMemo(() => {
    const max = Math.max(1, ...stats.map(entry => entry.max));
    const step = niceStep(max, 3);
    return Math.ceil((max * 1.08) / step) * step;
  }, [stats]);
  const domains = useMemo(() => new Map(stats.map(entry => {
    const pad = (entry.max - entry.min || entry.max || 1) * .22;
    const independent = { lo: entry.min - pad, hi: entry.max + pad * .9 };
    const shared = { lo: 0, hi: sharedHi };
    const inWindow = (value: number, domain: Domain) => {
      const frac = 1 - (value - domain.lo) / (domain.hi - domain.lo);
      return frac >= TICK_WINDOW[0] && frac <= TICK_WINDOW[1];
    };
    const own = ticksFor(independent.lo, independent.hi, 3).filter(value => inWindow(value, independent));
    const common = ticksFor(0, sharedHi, 4).filter(value => inWindow(value, shared));
    const all = [...new Set([...own, ...common])].sort((a, b) => a - b);
    return [entry.item.id, {
      independent, shared,
      ticks: { independent: all.map(value => ({ value, visible: own.includes(value) })), shared: all.map(value => ({ value, visible: common.includes(value) })) },
    }] as const;
  })), [stats, sharedHi]);

  // The crosshair position, as a share of the plot width. It jumps in when it appears and glides between periods after that.
  const cx = useMotionValue(1);
  const shownCursor = useRef<number | null>(null);
  useEffect(() => {
    const previous = shownCursor.current;
    shownCursor.current = cursor;
    if (cursor === null) return;
    const target = last ? cursor / last : 1;
    if (previous === null || reduce) { cx.set(target); return; }
    const controls = animate(cx, target, follow);
    return () => controls.stop();
  }, [cursor, last, reduce, cx]);

  const onIndexChangeRef = useRef(onIndexChange);
  useEffect(() => { onIndexChangeRef.current = onIndexChange; });
  const cursorRef = useRef<number | null>(null);
  const moveTo = (next: number | null) => {
    if (cursorRef.current === next) return;
    cursorRef.current = next;
    setCursor(next);
    onIndexChangeRef.current?.(next);
  };

  const indexFromPointer = (event: PointerEvent<HTMLElement>) => {
    const plot = (event.target as Element | null)?.closest?.("[data-plot]");
    if (!plot) return null;
    const rect = plot.getBoundingClientRect();
    return Math.round(clamp((event.clientX - rect.left) / (rect.width || 1), 0, 1) * last);
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "touch" && !event.buttons) return;
    const index = indexFromPointer(event);
    if (index !== null) moveTo(index);
  };
  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    const index = indexFromPointer(event);
    if (index !== null) moveTo(index);
  };
  const onPointerLeave = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse" && !event.currentTarget.matches(":focus-visible")) moveTo(null);
  };

  const describe = (index: number) => {
    const top = [...series].sort((a, b) => (b.values[index] ?? 0) - (a.values[index] ?? 0))[0];
    return `${periods[index]?.long ?? ""}. Total ${formatValue(totals[index] ?? 0)}.${top ? ` Highest ${top.name} at ${formatValue(top.values[index] ?? 0)}.` : ""}`;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = cursor ?? last;
    const next = event.key === "ArrowLeft" || event.key === "ArrowDown" ? from - 1
      : event.key === "ArrowRight" || event.key === "ArrowUp" ? from + 1
        : event.key === "PageUp" ? from - 12 : event.key === "PageDown" ? from + 12
          : event.key === "Home" ? 0 : event.key === "End" ? last : null;
    if (event.key === "Escape") {
      if (cursor === null) return;
      event.preventDefault();
      moveTo(null);
      setLive("Crosshair cleared. Showing the latest month.");
      return;
    }
    if (next === null) return;
    event.preventDefault();
    const index = clamp(next, 0, last);
    moveTo(index);
    setLive(describe(index));
  };
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || cursor !== null) return;
    if (event.currentTarget.matches(":focus-visible")) moveTo(last);
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) moveTo(null);
  };

  const changeSort = (value: string) => {
    const next = value as SmallMultiplesSort;
    setSort(next);
    onSortChange?.(next);
    const first = [...stats].sort((a, b) => next === "latest" ? b.latest - a.latest : next === "growth" ? b.growth - a.growth : a.item.name.localeCompare(b.item.name, "en"))[0];
    setLive(`Sorted by ${SORT_WORDS[next]}.${first ? ` ${first.item.name} is first.` : ""}`);
  };
  const changeScale = (value: string) => {
    const next = value as SmallMultiplesScale;
    setScale(next);
    onScaleChange?.(next);
    setLive(next === "shared" ? "Shared scale. Panel heights now compare size." : "Independent scale. Panel heights now compare shape.");
  };
  const flatNames = stats.filter(entry => entry.flat).map(entry => entry.item.name);
  const changeDim = (next: boolean) => {
    setDimFlat(next);
    setLive(next ? (flatNames.length ? `Flat trends dimmed: ${listWords(flatNames)}.` : "No flat trends to dim.") : "All panels at full strength.");
  };

  const index = cursor ?? last;
  const period = periods[index];
  const hintId = `${uid}-hint`;
  const rootClass = [styles.root, className].filter(Boolean).join(" ");

  if (!series.length || !n) {
    return <section className={rootClass} aria-label={title}>
      <div className={styles.header}><div className={styles.heading}><h2 className={styles.title}>{title}</h2></div></div>
      <p className={styles.empty}>No series to compare yet. Pass at least one series with values.</p>
    </section>;
  }

  return <section className={rootClass} aria-labelledby={`${uid}-title`}>
    <div className={styles.header}>
      <div className={styles.heading}>
        <h2 className={styles.title} id={`${uid}-title`}>{title}</h2>
        {description ? <p className={styles.description}>{description}</p> : null}
      </div>
      <div className={styles.controls}>
        <SegmentedControl className={styles.segment} label="Sort panels by" options={SORTS} value={sort} onValueChange={changeSort} />
        <SegmentedControl className={styles.segment} label="Y scale" options={SCALES} value={scale} onValueChange={changeScale} />
        <Switch className={styles.switch} label="Dim flat trends" checked={dimFlat} onCheckedChange={changeDim} />
      </div>
    </div>

    <div className={styles.readout}>
      <p className={styles.when}>
        <span className={styles.date}>{period?.long}</span>
        <span className={styles.state}>{cursor === null ? "Latest" : `${index + 1} of ${n}`}</span>
      </p>
      <p className={styles.total}><span className={styles.totalLabel}>Total</span> <span className={styles.totalValue}>{formatValue(totals[index] ?? 0)}</span></p>
      <p className={styles.legend} aria-hidden="true">
        <span className={styles.key}><span className={styles.keyLine} />Region</span>
        <span className={styles.key}><span className={styles.keyGhost} />All regions, scaled to fit</span>
      </p>
    </div>

    <div
      className={styles.grid}
      role="group"
      tabIndex={0}
      aria-label={`${title}, ${series.length} panels`}
      aria-describedby={hintId}
      onPointerMove={onPointerMove}
      onPointerDown={onPointerDown}
      onPointerLeave={onPointerLeave}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
      data-scale={scale}
    >
      <p id={hintId} className={styles.srOnly}>Use the left and right arrow keys to move the crosshair across months in every panel at once. Home and End jump to the first and latest month, Escape clears it.</p>
      <ul className={styles.list}>
        {order.map(entry => {
          const domain = domains.get(entry.item.id)!;
          return <Panel
            key={entry.item.id}
            item={entry.item}
            latest={entry.latest}
            growth={entry.growth}
            flat={entry.flat}
            dim={dimFlat && entry.flat}
            target={domain[scale]}
            ticks={domain.ticks[scale]}
            ghost={ghost}
            cx={cx}
            cursor={cursor}
            compareLabel={compareLabel}
            layoutKey={layoutKey}
            reduce={reduce}
            formatValue={formatValue}
            formatTick={formatTick}
          />;
        })}
      </ul>
    </div>

    <div className={styles.srOnly}><table>
      <caption>{`${title}, ${period?.long ?? ""}, sorted by ${SORT_WORDS[sort]}`}</caption>
      <thead><tr><th scope="col">Series</th><th scope="col">Value</th><th scope="col">{`Growth ${compareLabel}`}</th><th scope="col">Trend</th></tr></thead>
      <tbody>
        {order.map(entry => <tr key={entry.item.id}>
          <th scope="row">{entry.item.name}</th>
          <td>{formatValue(entry.item.values[index] ?? 0)}</td>
          <td>{percent(entry.growth)}</td>
          <td>{entry.flat ? "Flat" : entry.growth > 0 ? "Rising" : "Falling"}</td>
        </tr>)}
      </tbody>
    </table></div>
    <p className={styles.srOnly} role="status" aria-live="polite">{live}</p>
  </section>;
}

function listWords(items: string[]) {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export default SmallMultiples;
