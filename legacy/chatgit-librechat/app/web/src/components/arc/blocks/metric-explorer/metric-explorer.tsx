"use client";

import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { LayoutGroup, animate, motion, useMotionValue, useReducedMotion } from "motion/react";
import { ArrowUpRight, X } from "lucide-react";
import { AnimatedCounter } from "../../animated-counter/animated-counter";
import SegmentedControl from "../../segmented-control/segmented-control";
import { motionTokens } from "../../lib/motion-tokens";
import {
  LAST, METRICS, METRIC_BY_ID, RANGES, RANGE_IDS,
  changeOf, changeText, changeWords, formatValue, longDate, shortDate, signOf, sparkOf, summary, windowLabel,
  type Metric, type MetricId, type RangeId,
} from "./metric-data";
import { MetricChart } from "./metric-chart";
import { Layers } from "./rise";
import styles from "./metric-explorer.module.css";

const { spring, duration, ease, blur } = motionTokens;
const enterEase = [...ease.enter] as [number, number, number, number];
const ORDER: MetricId[] = METRICS.map(m => m.id);
/** Corner radii in px (a compact card and the open panel share one dashboard radius), set inline so the morph blends and scale-corrects them. */
const RADIUS = { card: 16, panel: 16 };
/** The surface edge is an inset shadow, not a border: motion scale-corrects shadows during the morph, so the edge stays one pixel wide. */
const EDGE = "inset 0 0 0 1px var(--metric-edge)";

/**
 * One shared surface morphs between a card and the open panel; nothing else carries a layout id.
 * Each id is used by at most one card and the panel, so a morph can never resume from a stale element.
 * Opening hands the panel the card's id. Closing gives the id to the card of the metric on screen and fresh ids to the rest.
 */
type Surfaces = { cards: Record<MetricId, string>; panel: string; serial: number };
const START: Surfaces = { cards: { mrr: "s0", accounts: "s1", activation: "s2", nrr: "s3" }, panel: "s0", serial: 4 };

function useMotionPlan() {
  const reduce = !!useReducedMotion();
  return {
    reduce,
    morph: reduce ? { duration: 0 } : spring.smooth,
    /** Content arrives a beat after the surface starts to move, out of a small blur. */
    reveal: (delay: number) => (reduce
      ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: duration.instant } }
      : { initial: { opacity: 0, y: 6, filter: `blur(${blur.soft}px)` }, animate: { opacity: 1, y: 0, filter: "blur(0px)", transitionEnd: { filter: "none" } }, transition: { duration: duration.standard, ease: enterEase, delay } }),
  };
}

/** Direction reads from the sign and the arrow; color only repeats it. With `roll`, the figure turns on the odometer when the range changes. */
function Change({ metric, value, roll = false }: { metric: Metric; value: number; roll?: boolean }) {
  const tone = signOf(value) === "" ? "flat" : value > 0 ? "good" : "bad";
  return <span className={styles.change} data-tone={tone}>
    <span className={styles.arrow} aria-hidden="true"><ArrowUpRight size={14} strokeWidth={1.75} /></span>
    <span className={styles.num}>{roll
      ? <AnimatedCounter value={Math.round(Math.abs(value) * 10) / 10} decimals={1} prefix={signOf(value)} suffix={metric.change === "percent" ? "%" : "\u00a0pts"} />
      : changeText(metric, value)}</span>
  </span>;
}

type CardProps = { metric: Metric; range: RangeId; surfaceId: string; lead: boolean; returning: boolean; onOpen: () => void; setRef: (node: HTMLButtonElement | null) => void };

/** A KPI tile. Only its surface takes part in the morph; its copy fades in once the surface has landed. */
function Card({ metric, range, surfaceId, lead, returning, onOpen, setRef }: CardProps) {
  const { morph, reveal } = useMotionPlan();
  const s = summary(metric, range), spark = sparkOf(metric, range), words = RANGES[range].words;
  const content = returning ? reveal(lead ? .16 : .08) : {};
  return <li className={styles.cell} data-lead={lead || undefined}>
    <button ref={setRef} type="button" className={styles.card} onClick={onOpen}
      aria-label={`${metric.label}: ${formatValue(metric, s.now)}, ${changeWords(metric, s.change)} over ${words}. Open chart`}>
      <motion.span layoutId={surfaceId} layoutDependency="card" className={styles.surface} style={{ borderRadius: RADIUS.card, boxShadow: EDGE }} transition={morph}
        initial={returning && !lead ? { opacity: 0 } : false} animate={{ opacity: 1 }} aria-hidden="true" />
      <motion.span className={styles.cardBody} {...content}>
        <span className={styles.cardLabel}>{metric.label}</span>
        <span className={styles.cardValue}>{formatValue(metric, s.now)}</span>
        <span className={styles.cardChange}><Change metric={metric} value={s.change} /><span className={styles.muted}>{words}</span></span>
        <span className={styles.spark} aria-hidden="true">
          <svg viewBox="0 0 100 32" preserveAspectRatio="none"><path d={spark.d} /></svg>
          <span className={styles.sparkEnd} style={{ top: `${spark.end}%` }} />
        </span>
      </motion.span>
    </button>
  </li>;
}

/** Metric tabs. One highlight glides between them on a spring and retargets from wherever it is when clicks come quickly. */
function Tabs({ active, idOf, panelId, onPick }: { active: MetricId; idOf: (id: MetricId) => string; panelId: string; onPick: (id: MetricId) => void }) {
  const { reduce } = useMotionPlan();
  const tabs = useRef<Partial<Record<MetricId, HTMLButtonElement | null>>>({});
  const current = useRef(active);
  const x = useMotionValue(0), width = useMotionValue(0);

  useLayoutEffect(() => {
    const first = current.current === active && width.get() === 0;
    current.current = active;
    const el = tabs.current[active];
    if (!el) return;
    if (first || reduce) { x.jump(el.offsetLeft); width.jump(el.offsetWidth); return; }
    const a = animate(x, el.offsetLeft, spring.morph), b = animate(width, el.offsetWidth, spring.morph);
    return () => { a.stop(); b.stop(); };
  }, [active, reduce, x, width]);

  // A resize or a late font swap moves the tabs; the highlight follows at once instead of gliding.
  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const el = tabs.current[current.current];
      if (el) { x.jump(el.offsetLeft); width.jump(el.offsetWidth); }
    });
    Object.values(tabs.current).forEach(el => el && observer.observe(el));
    return () => observer.disconnect();
  }, [x, width]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = ORDER.indexOf(active);
    const next = e.key === "ArrowRight" ? ORDER[(i + 1) % ORDER.length] : e.key === "ArrowLeft" ? ORDER[(i + ORDER.length - 1) % ORDER.length] : e.key === "Home" ? ORDER[0] : e.key === "End" ? ORDER[ORDER.length - 1] : null;
    if (!next) return;
    e.preventDefault();
    onPick(next);
    tabs.current[next]?.focus();
  };

  return <div className={styles.tabs} role="tablist" aria-label="Metric" onKeyDown={onKeyDown}>
    <motion.span className={styles.tabHighlight} style={{ x, width }} aria-hidden="true" />
    {METRICS.map(m => <button key={m.id} ref={node => { tabs.current[m.id] = node; }} id={idOf(m.id)} type="button" role="tab" className={styles.tab}
      aria-selected={m.id === active} aria-controls={panelId} tabIndex={m.id === active ? 0 : -1} onClick={() => onPick(m.id)}>
      <span>{m.short}</span><span className={styles.tabValue}>{formatValue(m, m.daily[LAST])}</span>
    </button>)}
  </div>;
}

/** The chart's data for assistive technology. Memoized, so scrubbing the chart never re-renders up to 90 rows. */
const DataTable = memo(function DataTable({ metric, range, id }: { metric: Metric; range: RangeId; id: string }) {
  const r = RANGES[range];
  const points = r.weekly ? Array.from({ length: r.days / 7 }, (_, j) => LAST - r.days + 7 * (j + 1)) : Array.from({ length: r.days }, (_, j) => LAST - r.days + 1 + j);
  return <table className={styles.srOnly} id={id}>
    <caption>{metric.label}, {windowLabel(range)}, with the same day in the previous period</caption>
    <thead><tr><th scope="col">Date</th><th scope="col">{metric.label}</th><th scope="col">Previous period</th></tr></thead>
    <tbody>{points.map(d => <tr key={d}><th scope="row">{longDate(d)}</th><td>{formatValue(metric, metric.daily[d])}</td><td>{formatValue(metric, metric.daily[d - r.days])}</td></tr>)}</tbody>
  </table>;
});

type PanelProps = { surfaceId: string; active: MetricId; previous: MetricId | null; range: RangeId; prevRange: RangeId | null; ids: string; onPick: (id: MetricId) => void; onRange: (range: RangeId) => void; onClose: () => void };

/** The open metric. The panel stays mounted while metrics switch: the figures crossfade in place and the line morphs from where it is. */
function Panel({ surfaceId, active, previous, range, prevRange, ids, onPick, onRange, onClose }: PanelProps) {
  const { morph, reveal } = useMotionPlan();
  const [hover, setHover] = useState<number | null>(null);
  const [seen, setSeen] = useState({ active, range });
  if (seen.active !== active || seen.range !== range) { setSeen({ active, range }); setHover(null); }
  const tabId = (id: MetricId) => `${ids}-tab-${id}`, panelId = `${ids}-panel`, tableId = `${ids}-table`;
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { body.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true }); }, []);

  const metric = METRIC_BY_ID[active], r = RANGES[range], s = summary(metric, range);
  const at = hover ?? LAST, then = at - r.days;
  const firstPoint = r.weekly ? LAST - r.days + 7 : LAST - r.days + 1;
  const chartLabel = `Line chart of ${metric.label} over the last ${r.words}, from ${formatValue(metric, metric.daily[firstPoint])} on ${longDate(firstPoint)} to ${formatValue(metric, s.now)} today, ${changeWords(metric, s.change)} from ${r.words} ago. A dashed line shows the previous ${r.words}.`;

  // Every metric keeps a layer in each slot, so the slots hold their size and a switch is only a crossfade.
  const layers = (render: (m: Metric, on: boolean) => ReactNode) => METRICS.map(m => ({ key: m.id, node: render(m, m.id === active) }));
  const figure = (m: Metric, on: boolean) => formatValue(m, on && hover !== null ? m.daily[at] : m.daily[LAST]);
  const delta = (m: Metric, on: boolean) => {
    const scrubbing = on && hover !== null;
    const value = scrubbing ? changeOf(m, m.daily[at], m.daily[then]) : summary(m, range).change;
    return <><Change metric={m} value={value} roll={on && !scrubbing} /><span className={styles.muted}>{scrubbing ? `${shortDate(at)} vs ${shortDate(then)}` : `vs ${r.words} ago`}</span></>;
  };

  return <div className={styles.panel}>
    <motion.div layoutId={surfaceId} layoutDependency="panel" className={styles.surface} style={{ borderRadius: RADIUS.panel, boxShadow: EDGE }} transition={morph} aria-hidden="true" />
    <motion.div ref={body} className={styles.panelBody} {...reveal(.12)}>
      <Tabs active={active} idOf={tabId} panelId={panelId} onPick={onPick} />
      <button type="button" className={styles.close} onClick={onClose} aria-label="Close chart" aria-keyshortcuts="Escape"><X size={16} strokeWidth={1.75} aria-hidden="true" /></button>

      <div className={styles.view} id={panelId} role="tabpanel" aria-labelledby={tabId(active)}>
        <div className={styles.readout}>
          <div className={styles.figures}>
            <h3 className={styles.panelLabel}><Layers active={active} previous={previous} items={layers(m => m.label)} /></h3>
            <p className={styles.panelValue}><Layers active={active} previous={previous} items={layers((m, on) => figure(m, on))} /></p>
            <p className={styles.panelChange}><Layers active={active} previous={previous} items={layers((m, on) => delta(m, on))} /></p>
          </div>
          <div className={styles.presets}>
            <SegmentedControl label="Chart range" value={range} onValueChange={value => onRange(value as RangeId)} options={RANGE_IDS.map(id => ({ value: id, label: RANGES[id].label }))} />
          </div>
        </div>

        <p className={styles.legend} aria-hidden="true">
          <span className={styles.key}><span className={styles.keyLine} />This period</span>
          <span className={styles.key}><span className={styles.keyDash} />Previous period</span>
          <span className={styles.window}><Layers active={range} previous={prevRange} items={RANGE_IDS.map(id => ({ key: id, node: windowLabel(id) }))} /></span>
        </p>
        <MetricChart metric={metric} range={range} hover={hover} onHover={setHover} label={chartLabel} tableId={tableId} />
        <p className={styles.definition}><Layers active={active} previous={previous} items={layers(m => m.definition)} /></p>

        <DataTable metric={metric} range={range} id={tableId} />
      </div>
    </motion.div>
  </div>;
}

export function MetricExplorer() {
  const { morph } = useMotionPlan();
  const group = useId();
  const ids = group.replace(/[^a-zA-Z0-9_-]/g, "");
  const titleId = `${ids}-title`;
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<{ active: MetricId; previous: MetricId | null }>({ active: "mrr", previous: null });
  const [range, setRange] = useState<{ now: RangeId; previous: RangeId | null }>({ now: "30d", previous: null });
  const [surfaces, setSurfaces] = useState(START);
  const [returning, setReturning] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const cards = useRef<Partial<Record<MetricId, HTMLButtonElement | null>>>({});
  const restore = useRef(false);
  const { active, previous } = view;

  useEffect(() => {
    if (open || !restore.current) return;
    restore.current = false;
    cards.current[active]?.focus({ preventScroll: true });
  }, [open, active]);

  const describe = (id: MetricId, r: RangeId) => {
    const m = METRIC_BY_ID[id], s = summary(m, r);
    return `${m.label}, last ${RANGES[r].words}: ${formatValue(m, s.now)}, ${changeWords(m, s.change)} from ${RANGES[r].words} ago`;
  };
  const expand = (id: MetricId) => {
    setSurfaces(current => ({ ...current, panel: current.cards[id] }));
    setView({ active: id, previous: null });
    setOpen(true);
    setReturning(true);
    setAnnouncement(describe(id, range.now));
  };
  const pick = (id: MetricId) => {
    if (id === active) return;
    setView({ active: id, previous: active });
    setAnnouncement(describe(id, range.now));
  };
  const collapse = () => {
    restore.current = true;
    setSurfaces(current => {
      let serial = current.serial;
      const next = Object.fromEntries(ORDER.map(id => [id, id === active ? current.panel : `s${serial++}`])) as Record<MetricId, string>;
      return { cards: next, panel: current.panel, serial };
    });
    setOpen(false);
    setAnnouncement(`Chart closed. ${METRICS.length} metrics shown.`);
  };
  const changeRange = (next: RangeId) => {
    if (next === range.now) return;
    setRange({ now: next, previous: range.now });
    setAnnouncement(describe(active, next));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!open || e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    collapse();
  };

  return <section className={styles.root} aria-labelledby={titleId} onKeyDown={onKeyDown}>
    <LayoutGroup id={ids}>
      {/* The header re-measures when the view changes, so it glides if the block's height moves it. */}
      <motion.header layout="position" layoutDependency={open} transition={morph} className={styles.header}>
        <h2 id={titleId}>Growth metrics</h2>
        <p>Parcelwise · updated {longDate(LAST)} at 09:00 UTC</p>
      </motion.header>

      {open
        ? <Panel surfaceId={surfaces.panel} active={active} previous={previous} range={range.now} prevRange={range.previous} ids={ids} onPick={pick} onRange={changeRange} onClose={collapse} />
        : <ul className={styles.grid}>
          {ORDER.map(id => <Card key={id} metric={METRIC_BY_ID[id]} range={range.now} surfaceId={surfaces.cards[id]} lead={returning && id === active} returning={returning}
            onOpen={() => expand(id)} setRef={node => { cards.current[id] = node; }} />)}
        </ul>}
    </LayoutGroup>

    <p className={styles.srOnly} aria-live="polite">{announcement}</p>
  </section>;
}

export default MetricExplorer;
