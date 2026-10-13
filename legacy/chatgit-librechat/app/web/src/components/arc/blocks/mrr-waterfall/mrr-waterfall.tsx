"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { AnimatePresence, animate, motion, motionValue, useInView, useIsPresent, useReducedMotion, useTransform, type MotionValue } from "motion/react";
import { ArrowUpRight } from "lucide-react";
import { AnimatedCounter } from "../../animated-counter/animated-counter";
import SegmentedControl from "../../segmented-control/segmented-control";
import { motionTokens } from "../../lib/motion-tokens";
import { PERIODS, PERIOD_OPTIONS, domainOf, type Column, type ColumnId, type Entry, type Period, type PeriodId, type Tone, type Unit } from "./mrr-data";
import styles from "./mrr-waterfall.module.css";

type Fig = { value: number; decimals?: number; prefix?: string; suffix?: string; key: string };
type Geo = { bars: string[]; breaks: string[]; links: string[]; labelY: number[]; labelOpacity: number[]; labelValue: number[]; base: number };

const { spring, duration, ease, stagger } = motionTokens;
const enterEase = [...ease.enter] as [number, number, number, number];
const standardEase = [...ease.standard] as [number, number, number, number];

const GUTTER = 48, PAD_TOP = 30, PAD_BOTTOM = 34, COLS = 7, DEFAULT_WIDTH = 700;
const START: PeriodId = "q3";
const UNITS = [{ value: "usd", label: "USD" }, { value: "pct", label: "% of start" }];
const META: Record<ColumnId, string> = { start: "paying accounts on", new: "new accounts", expansion: "accounts expanded", reactivation: "accounts came back", contraction: "accounts downgraded", churn: "accounts cancelled", end: "paying accounts on" };
const EMPTY = "M0 0";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const whole = new Intl.NumberFormat("en-US");
const cx = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");
const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));
const signOf = (tone: Tone) => tone === "gain" ? "+" : tone === "loss" ? "−" : "";
const heightFor = (width: number) => Math.round(clamp(width * .44, 232, 300));
const metaOf = (column: Column, period: Period) => column.id === "start" ? `${META.start} ${period.from}` : column.id === "end" ? `${META.end} ${period.to}` : META[column.id];

/** Every bar shares one band grid; the plot starts after the axis gutter. */
function bandsFor(width: number) {
  const band = (width - GUTTER) / COLS;
  const bar = Math.round(clamp(band * .56, 12, 56));
  return { band, bar, left: (index: number) => Math.round(GUTTER + band * index + (band - bar) / 2) };
}

function rectPath(x: number, y: number, w: number, h: number, top: number, bottom: number) {
  if (h < .5) return EMPTY;
  const rt = Math.min(top, h / 2, w / 2), rb = Math.min(bottom, h / 2, w / 2);
  return `M${x} ${y + rt}a${rt} ${rt} 0 0 1 ${rt} ${-rt}h${w - rt * 2}a${rt} ${rt} 0 0 1 ${rt} ${rt}v${h - rt - rb}a${rb} ${rb} 0 0 1 ${-rb} ${rb}h${-(w - rb * 2)}a${rb} ${rb} 0 0 1 ${-rb} ${-rb}z`;
}

/**
 * All geometry comes from one list of motion values: six running levels, seven reveal and six draw progresses, the dollar domain, the size and the starting MRR.
 * Floating bars span two neighbouring levels, so a connector can never detach from the bars it joins, even mid-flight.
 * Each label reads the amount its bar spans in the same frame, so the figure counts and travels in lockstep with the bar it names.
 */
function geometry(values: number[]): Geo {
  const levels = values.slice(0, 6), grow = values.slice(6, 13), draw = values.slice(13, 19);
  const [lo, hi, width, height, base] = values.slice(19);
  const { bar, left } = bandsFor(width);
  const floor = height - PAD_BOTTOM;
  const y = (value: number) => PAD_TOP + (hi - value) / Math.max(1e-6, hi - lo) * (floor - PAD_TOP);
  const geo: Geo = { bars: [], breaks: [], links: [], labelY: [], labelOpacity: [], labelValue: [], base };
  for (let index = 0; index < COLS; index++) {
    const total = index === 0 || index === COLS - 1;
    const from = total ? lo : levels[index - 1];
    const to = index === COLS - 1 ? levels[5] : levels[index];
    const reached = from + grow[index] * (to - from);
    const top = Math.round(y(Math.max(from, reached))), bottom = total ? floor : Math.round(y(Math.min(from, reached)));
    const x = left(index);
    geo.bars.push(rectPath(x, top, bar, bottom - top, total ? 3 : 2, total ? 0 : 2));
    // The axis does not start at zero, so the two total bars carry a slanted break just above the baseline.
    geo.breaks.push(total && bottom - top > 26 ? `M${x} ${floor - 9}L${x + bar} ${floor - 14}V${floor - 11}L${x} ${floor - 6}z` : EMPTY);
    geo.labelY.push(to < from ? bottom + 6 : top - 6);
    geo.labelOpacity.push(clamp(grow[index] * 1.6 - .1, 0, 1));
    // Totals read the level their top has reached; movements read the span drawn so far.
    geo.labelValue.push(total ? reached : Math.abs(reached - from));
  }
  for (let index = 0; index < COLS - 1; index++) {
    const x1 = left(index) + bar, x2 = left(index + 1);
    const level = Math.round(y(levels[index])) - .5;
    geo.links.push(draw[index] > .001 ? `M${x1} ${level}H${x1 + (x2 - x1) * clamp(draw[index], 0, 1)}` : EMPTY);
  }
  return geo;
}

/** A bar label's format; a new key crossfades the figure, while the digits within one format count with the bar. */
function barFormat(tone: Tone, unit: Unit, compact: boolean) {
  const sign = signOf(tone);
  // Narrow bands drop the unit mark, as the dollar labels drop "$"; the axis still names the unit.
  if (unit === "pct") return { key: `pct${sign}${compact}`, text: (amount: number, base: number) => `${sign}${(amount / Math.max(1e-6, base) * 100).toFixed(1)}${compact ? "" : "%"}` };
  return { key: `k${sign}${compact}`, text: (amount: number) => `${sign}${compact ? "" : "$"}${(amount / 1000).toFixed(1)}k` };
}
type BarFormat = ReturnType<typeof barFormat>;

function amountFig(amount: number, tone: Tone, unit: Unit, start: number): Fig {
  const sign = signOf(tone);
  return unit === "pct" ? { value: amount / start * 100, decimals: 2, prefix: sign, suffix: "%", key: `pct${sign}` } : { value: amount, prefix: `${sign}$`, key: `usd${sign}` };
}

function amountText(amount: number, tone: Tone, unit: Unit, start: number) {
  return unit === "pct" ? `${signOf(tone)}${(amount / start * 100).toFixed(2)}% of starting MRR` : `${signOf(tone)}${usd.format(amount)}`;
}

/** Outgoing copies are hidden from assistive tech while they leave; the ref lets popLayout lift the leaving copy out of flow. */
function Phase({ children, reduce, ref }: { children: ReactNode; reduce: boolean; ref?: Ref<HTMLSpanElement> }) {
  const present = useIsPresent();
  return <motion.span ref={ref} className={styles.phase} aria-hidden={present ? undefined : true}
    initial={reduce ? { opacity: 0 } : { opacity: 0, y: "0.4em" }} animate={{ opacity: 1, y: "0em" }}
    exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: "-0.35em", transition: { duration: duration.fast, ease: standardEase } }}
    transition={reduce ? { duration: 0 } : { duration: duration.standard, ease: enterEase }}>{children}</motion.span>;
}

/** Changing copy rises while the old line lifts away. */
function Rise({ text, className }: { text: string; className?: string }) {
  const reduce = !!useReducedMotion();
  return <span className={cx(styles.swap, className)}><AnimatePresence mode="popLayout" initial={false}><Phase key={text} reduce={reduce}>{text}</Phase></AnimatePresence></span>;
}

/** Digits roll when the value moves; a change of unit or sign swaps the whole figure with a rise instead. */
function Figure({ fig, className }: { fig: Fig; className?: string }) {
  const reduce = !!useReducedMotion();
  return <span className={cx(styles.swap, className)}>
    <AnimatePresence mode="popLayout" initial={false}>
      <Phase key={fig.key} reduce={reduce}><span className={styles.num}><AnimatedCounter value={fig.value} decimals={fig.decimals} prefix={fig.prefix} suffix={fig.suffix} /></span></Phase>
    </AnimatePresence>
  </span>;
}

/** A gridline and its label ride the animated domain; ticks joining or leaving the set crossfade while they glide. */
function Tick({ value, unit, lo, hi, base, height, width }: { value: number; unit: Unit; lo: MotionValue<number>; hi: MotionValue<number>; base: MotionValue<number>; height: MotionValue<number>; width: number }) {
  const reduce = !!useReducedMotion();
  const y = useTransform([lo, hi, base, height], ([l, h, b, size]: number[]) => {
    const dollars = unit === "pct" ? value * b / 100 : value;
    return Math.round(PAD_TOP + (h - dollars) / Math.max(1e-6, h - l) * (size - PAD_BOTTOM - PAD_TOP)) - .5;
  });
  const inside = useTransform([y, height], ([at, size]: number[]) => clamp(1 - Math.max(PAD_TOP - 14 - at, at - (size - PAD_BOTTOM) - 1, 0) / 10, 0, 1));
  return <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: reduce ? 0 : duration.fast } }} transition={{ duration: reduce ? 0 : duration.standard, ease: enterEase, delay: reduce ? 0 : .06 }}>
    <motion.g style={{ y, opacity: inside }}>
      <line className={styles.grid} x1={GUTTER} x2={width} y1={0} y2={0} />
      <text className={styles.tick} x={GUTTER - 10} y={0} dy=".32em" textAnchor="end">{unit === "pct" ? `${value}%` : `$${+(value / 1000).toFixed(1)}k`}</text>
    </motion.g>
  </motion.g>;
}

function Bar({ index, geo, tone, dim }: { index: number; geo: MotionValue<Geo>; tone: Tone; dim: boolean }) {
  const d = useTransform(geo, g => g.bars[index]);
  return <motion.path className={styles.bar} data-tone={tone} data-dim={dim || undefined} d={d} />;
}

function Break({ index, geo, active }: { index: number; geo: MotionValue<Geo>; active: boolean }) {
  const d = useTransform(geo, g => g.breaks[index]);
  return <motion.path className={styles.break} data-active={active || undefined} d={d} />;
}

function Link({ index, geo }: { index: number; geo: MotionValue<Geo> }) {
  const d = useTransform(geo, g => g.links[index]);
  return <motion.path className={styles.link} d={d} />;
}

/** One copy of a bar figure. Its text streams from the geometry, so it never runs ahead of or behind the bar. */
function LabelText({ index, geo, format, reduce }: { index: number; geo: MotionValue<Geo>; format: BarFormat; reduce: boolean }) {
  const present = useIsPresent();
  const text = useTransform(geo, g => format.text(g.labelValue[index], g.base));
  return <motion.span className={styles.labelText} aria-hidden={present ? undefined : true}
    initial={reduce ? { opacity: 0 } : { opacity: 0, y: "0.4em" }} animate={{ opacity: 1, y: "0em" }}
    exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: "-0.35em", transition: { duration: duration.fast, ease: standardEase } }}
    transition={reduce ? { duration: 0 } : { duration: duration.standard, ease: enterEase }}>{text}</motion.span>;
}

/** Both copies of a changing format share one grid cell centred on the bar, so neither shifts sideways while they swap. */
function Label({ index, geo, x, format, below, dim }: { index: number; geo: MotionValue<Geo>; x: number; format: BarFormat; below: boolean; dim: boolean }) {
  const reduce = !!useReducedMotion();
  const y = useTransform(geo, g => g.labelY[index]);
  const opacity = useTransform(geo, g => g.labelOpacity[index]);
  return <motion.div className={styles.label} style={{ x, y, opacity }}>
    <div className={styles.labelInner} data-below={below || undefined} data-dim={dim || undefined}>
      <AnimatePresence initial={false}><LabelText key={format.key} index={index} geo={geo} format={format} reduce={reduce} /></AnimatePresence>
    </div>
  </motion.div>;
}

/** One account behind the bar. Rows that stay between periods glide to their new rank while their amount rolls and share bar morphs. */
function Row({ entry, column, unit, start, index, ref }: { entry: Entry; column: Column; unit: Unit; start: number; index: number; ref?: Ref<HTMLLIElement> }) {
  const reduce = !!useReducedMotion();
  const present = useIsPresent();
  const share = column.amount ? entry.amount / column.amount * 100 : 0;
  return <motion.li ref={ref} layout="position" className={styles.row} aria-hidden={present ? undefined : true}
    initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, transition: { duration: reduce ? 0 : duration.instant } }}
    transition={reduce ? { duration: 0 } : { layout: spring.smooth, default: { duration: duration.standard, ease: enterEase, delay: index * stagger.item } }}>
    <span className={styles.rowName} data-rest={entry.key === "rest" || undefined}>{entry.name}</span>
    <Figure className={styles.rowAmount} fig={amountFig(entry.amount, column.tone, unit, start)} />
    <Rise className={styles.rowDetail} text={entry.detail} />
    <span className={styles.share} aria-hidden="true">
      <motion.span className={styles.shareFill} data-tone={column.tone} initial={{ width: "0%" }} animate={{ width: `${share}%` }} transition={reduce ? { duration: 0 } : { ...spring.morph, delay: index * stagger.item }} />
    </span>
  </motion.li>;
}

export function MrrWaterfall() {
  const reduce = !!useReducedMotion();
  const uid = useId();
  const titleId = `${uid}-title`, panelId = `${uid}-panel`;
  const [periodId, setPeriodId] = useState<PeriodId>(START);
  const [unit, setUnit] = useState<Unit>("usd");
  const [selected, setSelected] = useState(1);
  const [hover, setHover] = useState<number | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [announcement, setAnnouncement] = useState("");
  const chartRef = useRef<HTMLDivElement>(null);
  const hitRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const inView = useInView(chartRef, { once: true, amount: .35 });

  const period = PERIODS[periodId];
  const domain = useMemo(() => domainOf(period, unit), [period, unit]);
  const height = heightFor(width);

  // Everything that moves per frame lives in motion values created once; React only re-renders when a period, unit, hover or size changes.
  const [mv] = useState(() => {
    const first = PERIODS[START], firstDomain = domainOf(first, "usd");
    return {
      levels: first.levels.map(level => motionValue(level)),
      grow: Array.from({ length: COLS }, () => motionValue(0)),
      draw: Array.from({ length: COLS - 1 }, () => motionValue(0)),
      lo: motionValue(firstDomain.lo), hi: motionValue(firstDomain.hi), base: motionValue(first.start),
      width: motionValue(DEFAULT_WIDTH), height: motionValue(heightFor(DEFAULT_WIDTH)),
    };
  });
  const geo = useTransform([...mv.levels, ...mv.grow, ...mv.draw, mv.lo, mv.hi, mv.width, mv.height, mv.base], (values: number[]) => geometry(values));

  useLayoutEffect(() => {
    const node = chartRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(260, Math.round(entry.contentRect.width))));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => { mv.width.set(width); mv.height.set(height); }, [mv, width, height]);

  // Bars cascade up from the level they start at, then each connector draws across to the next bar.
  useEffect(() => {
    if (!inView) return;
    if (reduce) { mv.grow.forEach(value => value.jump(1)); mv.draw.forEach(value => value.jump(1)); return; }
    const runs = [
      ...mv.grow.map((value, index) => animate(value, 1, { ...spring.smooth, delay: index * .06 })),
      ...mv.draw.map((value, index) => animate(value, 1, { ...spring.smooth, visualDuration: .3, delay: index * .06 + .2 })),
    ];
    return () => runs.forEach(run => run.stop());
  }, [inView, reduce, mv]);

  // A new period or unit retargets every level and the domain on one spring, so bars, connectors and gridlines stay in step mid-flight.
  useEffect(() => {
    const to = (value: MotionValue<number>, target: number) => {
      if (reduce) value.jump(target);
      else if (value.get() !== target || value.isAnimating()) animate(value, target, spring.morph);
    };
    period.levels.forEach((level, index) => to(mv.levels[index], level));
    to(mv.lo, domain.lo); to(mv.hi, domain.hi); to(mv.base, period.start);
  }, [period, domain, reduce, mv]);

  const { band, bar, left } = bandsFor(width);
  const compact = band < 64;
  // Below this the short labels still need a smaller size to keep a gap between neighbours.
  const tight = band < 48;
  const floor = height - PAD_BOTTOM;
  const active = hover ?? (keyboard ? selected : null);
  const shown = period.columns[hover ?? selected];
  const startCol = period.columns[0], churnCol = period.columns[5];
  const logoChurn = churnCol.count / startCol.count * 100;
  const summary = `MRR waterfall for ${period.long}. ${period.columns.map(column => `${column.name} ${amountText(column.amount, column.tone, "usd", period.start)}`).join(", ")}.`;

  const choose = (index: number) => {
    setSelected(index);
    const column = period.columns[index];
    setAnnouncement(`${column.name}, ${amountText(column.amount, column.tone, unit, period.start)}, ${whole.format(column.count)} ${metaOf(column, period)}`);
  };
  const onKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const moves: Record<string, number> = { ArrowRight: selected + 1, ArrowDown: selected + 1, ArrowLeft: selected - 1, ArrowUp: selected - 1, Home: 0, End: COLS - 1 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    const next = (moves[event.key] + COLS) % COLS;
    choose(next);
    hitRefs.current[next]?.focus();
  };
  const onFocus = (event: FocusEvent<HTMLDivElement>) => setKeyboard(event.target.matches(":focus-visible"));
  const changePeriod = (value: string) => {
    const next = PERIODS[value as PeriodId];
    setPeriodId(next.id);
    setAnnouncement(`${next.long}: MRR moved from ${usd.format(next.start)} to ${usd.format(next.end)}, ${next.stats.growth >= 0 ? "up" : "down"} ${Math.abs(next.stats.growth).toFixed(1)}%`);
  };
  const changeUnit = (value: string) => {
    setUnit(value as Unit);
    setAnnouncement(value === "pct" ? "Showing values as a percent of starting MRR" : "Showing values in US dollars");
  };

  return <section className={styles.root} aria-labelledby={titleId}>
    <header className={styles.header}>
      <div className={styles.heading}>
        <h2 id={titleId}>MRR movement</h2>
        <p><Rise text={`All plans · ${period.range}`} /></p>
      </div>
      <div className={styles.controls}>
        <SegmentedControl label="Period" options={PERIOD_OPTIONS} value={periodId} onValueChange={changePeriod} />
        <SegmentedControl label="Show values as" options={UNITS} value={unit} onValueChange={changeUnit} />
      </div>
    </header>

    <div className={styles.summary}>
      <div className={styles.headline}>
        <p className={styles.kpiLabel}><Rise text={`Ending MRR on ${period.to}`} /></p>
        <p className={styles.kpiValue}><span className={styles.num}><AnimatedCounter value={period.end} prefix="$" animateOnView /></span></p>
        <p className={styles.delta}>
          <ArrowUpRight size={16} strokeWidth={1.75} aria-hidden="true" className={styles.deltaIcon} />
          <Figure className={styles.deltaValue} fig={{ value: period.stats.netNew, prefix: "+$", key: "net" }} />
          <Figure className={styles.deltaValue} fig={{ value: period.stats.growth, decimals: 1, prefix: "+", suffix: "%", key: "growth" }} />
          <Rise text={`since ${period.from}`} />
        </p>
      </div>
      <dl className={styles.stats}>
        <div><dt>Net revenue retention</dt><dd><Figure fig={{ value: period.stats.nrr, decimals: 1, suffix: "%", key: "nrr" }} /></dd></div>
        <div><dt>Quick ratio</dt><dd><Figure fig={{ value: period.stats.quick, decimals: 2, key: "quick" }} /></dd></div>
        <div><dt>Logo churn</dt><dd><Figure fig={{ value: logoChurn, decimals: 1, suffix: "%", key: "logo" }} /></dd></div>
      </dl>
    </div>

    <div className={styles.body}>
      <div ref={chartRef} className={styles.chart} style={{ height }}>
        <svg className={styles.svg} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary}>
          {active !== null && <rect className={styles.band} x={GUTTER + band * active + 3} y={2} width={Math.max(0, band - 6)} height={height - 4} rx={12} />}
          <g>
            <AnimatePresence initial={false}>
              {domain.ticks.map(value => <Tick key={`${unit}:${value}`} value={value} unit={unit} lo={mv.lo} hi={mv.hi} base={mv.base} height={mv.height} width={width} />)}
            </AnimatePresence>
          </g>
          <line className={styles.baseline} x1={GUTTER} x2={width} y1={floor - .5} y2={floor - .5} />
          {period.columns.slice(0, -1).map((column, index) => <Link key={column.id} index={index} geo={geo} />)}
          {period.columns.map((column, index) => <Bar key={column.id} index={index} geo={geo} tone={column.tone} dim={active !== null && active !== index} />)}
          <Break index={0} geo={geo} active={active === 0} />
          <Break index={COLS - 1} geo={geo} active={active === COLS - 1} />
          <motion.rect className={styles.marker} x={0} y={floor + 2} width={bar} height={2} rx={1} initial={false} animate={{ x: left(selected) }} transition={reduce ? { duration: 0 } : spring.snappy} />
          {period.columns.map((column, index) => <text key={column.id} className={styles.axis} data-tight={tight || undefined} data-current={index === (hover ?? selected) || undefined} x={left(index) + bar / 2} y={height - 10} textAnchor="middle">{compact ? column.short : column.axis}</text>)}
        </svg>

        <div className={styles.labels} data-tight={tight || undefined} aria-hidden="true">
          {period.columns.map((column, index) => <Label key={column.id} index={index} geo={geo} x={left(index) + bar / 2} format={barFormat(column.tone, unit, compact)} below={column.tone === "loss"} dim={active !== null && active !== index} />)}
        </div>

        <div className={styles.hits} role="radiogroup" aria-label="Movements" aria-controls={panelId} onPointerLeave={() => setHover(null)} onFocus={onFocus} onBlur={() => setKeyboard(false)}>
          {period.columns.map((column, index) => <button key={column.id} ref={node => { hitRefs.current[index] = node; }} type="button" role="radio" aria-checked={selected === index} tabIndex={selected === index ? 0 : -1}
            aria-label={`${column.name}, ${amountText(column.amount, column.tone, unit, period.start)}, ${whole.format(column.count)} ${metaOf(column, period)}`}
            className={styles.hit} style={{ left: GUTTER + band * index, width: band, height }}
            onPointerEnter={event => { if (event.pointerType === "mouse") setHover(index); }} onClick={() => choose(index)} onKeyDown={onKey} />)}
        </div>
      </div>

      <section id={panelId} className={styles.panel} aria-label={`Accounts behind ${shown.name.toLowerCase()}`}>
        <div className={styles.panelHead}>
          <h3><span className={styles.swatch} data-tone={shown.tone} aria-hidden="true" /><Rise text={shown.name} /></h3>
          <Figure className={styles.panelTotal} fig={amountFig(shown.amount, shown.tone, unit, period.start)} />
        </div>
        <p className={styles.panelMeta}><span className={styles.num}><AnimatedCounter value={shown.count} /></span> <Rise text={metaOf(shown, period)} /></p>
        <ul className={styles.rows}>
          <AnimatePresence mode="popLayout" initial={false}>
            {shown.entries.map((entry, index) => <Row key={`${shown.id}:${entry.key}`} entry={entry} column={shown} unit={unit} start={period.start} index={index} />)}
          </AnimatePresence>
        </ul>
        <p className={styles.hint}><Rise text={hover === null || hover === selected ? "Select a bar or use the arrow keys to see its accounts" : "Click the bar to keep this list"} /></p>
      </section>
    </div>

    <div className={styles.srOnly}><table>
      <caption>MRR movement, {period.long}</caption>
      <thead><tr><th scope="col">Movement</th><th scope="col">Amount</th><th scope="col">Share of starting MRR</th><th scope="col">Accounts</th></tr></thead>
      <tbody>{period.columns.map(column => <tr key={column.id}><th scope="row">{column.name}</th><td>{amountText(column.amount, column.tone, "usd", period.start)}</td><td>{(column.amount / period.start * 100).toFixed(1)}%</td><td>{whole.format(column.count)}</td></tr>)}</tbody>
    </table></div>
    <p className={styles.srOnly} aria-live="polite">{announcement}</p>
  </section>;
}

export default MrrWaterfall;
