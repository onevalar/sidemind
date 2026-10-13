"use client";

import { memo, useEffect, useEffectEvent, useId, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowUpRight, RotateCcw } from "lucide-react";
import SegmentedControl from "../../segmented-control/segmented-control";
import { AnimatedCounter } from "../../animated-counter/animated-counter";
import { motionTokens } from "../../lib/motion-tokens";
import { COLS, DAYS, DAY_NAMES, METRICS, METRIC_OPTIONS, ROWS, WEEK, count, hourLabel, hourRange, indexOf, signedPct, type Cell, type Metric, type MetricKey } from "./terrain-data";
import { createTerrain, type Terrain } from "./terrain-engine";
import styles from "./activity-terrain.module.css";

type View = "perspective" | "top";

const { spring, duration, ease } = motionTokens;
const enterEase = [...ease.enter] as [number, number, number, number];
const VIEWS = [{ value: "perspective", label: "Perspective" }, { value: "top", label: "Top view" }];
const HOURS = Array.from({ length: COLS }, (_, h) => h);
const DAY_INDEX = Array.from({ length: ROWS }, (_, d) => d);
const DEG = Math.PI / 180;
const same = (a: Cell | null, b: Cell | null) => !!a && !!b && a.d === b.d && a.h === b.h;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function describe(m: Metric, c: Cell) {
  const i = indexOf(c), value = m.values[i], last = m.last[i];
  const change = last ? `, ${signedPct(value / last - 1)} on last week` : "";
  return `${DAY_NAMES[c.d]} ${hourRange(c.h)}: ${count(value)} ${value === 1 ? m.one : m.unit}${change}.`;
}

/** Changing text settles into place with a short rise; reduced motion crossfades. */
function Rise({ text, className }: { text: string; className?: string }) {
  const reduce = useReducedMotion();
  const hidden = reduce ? { opacity: 0 } : { opacity: 0, y: "0.3em" };
  return <span className={[styles.rise, className].filter(Boolean).join(" ")}>
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span key={text} initial={hidden} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: duration.instant } }} transition={{ duration: reduce ? duration.instant : duration.standard, ease: enterEase }}>{text}</motion.span>
    </AnimatePresence>
  </span>;
}

/** One arrow turns between up and down; the signed text carries the direction too. */
function Delta({ change, upIsGood }: { change: number; upIsGood: boolean }) {
  const reduce = useReducedMotion();
  const good = change >= 0 === upIsGood;
  return <span className={styles.delta} data-tone={good ? "good" : "bad"}>
    <motion.span className={styles.deltaIcon} initial={false} animate={{ rotate: change >= 0 ? 0 : 90 }} transition={reduce ? { duration: 0 } : spring.snappy}><ArrowUpRight size={14} strokeWidth={1.75} aria-hidden="true" /></motion.span>
    <Rise text={signedPct(change)} className={styles.deltaValue} />
    <span className={styles.deltaContext}>vs last week</span>
  </span>;
}

function Readout({ metric, cell }: { metric: Metric; cell: Cell }) {
  const i = indexOf(cell), value = metric.values[i], last = metric.last[i];
  const day = metric.values.slice(cell.d * COLS, cell.d * COLS + COLS), peak = Math.max(1, ...day);
  const change = last ? value / last - 1 : 0;
  const good = change >= 0 === metric.upIsGood;
  return <>
    <p className={styles.panelHead}><span>{DAY_NAMES[cell.d]}</span><span>{hourRange(cell.h)}</span></p>
    <p className={styles.panelValue}>{count(value)} <span>{value === 1 ? metric.one : metric.unit}</span></p>
    <dl className={styles.panelRows}>
      <div><dt>Last week</dt><dd>{count(last)}</dd></div>
      <div><dt>Change</dt><dd data-tone={!last || Math.abs(change) < .0005 ? undefined : good ? "good" : "bad"}>{last ? signedPct(change) : "New"}</dd></div>
      <div><dt>Share of {DAYS[cell.d]}</dt><dd>{(metric.days[cell.d] ? (value / metric.days[cell.d]) * 100 : 0).toFixed(1)}%</dd></div>
    </dl>
    <span className={styles.spark} aria-hidden="true">
      {day.map((v, h) => <span key={h} data-on={h === cell.h || undefined} style={{ "--v": Math.max(.06, v / peak) } as CSSProperties} />)}
    </span>
  </>;
}

/** Every value, for screen readers. Memoized so hovering never re-renders 168 cells. */
const DataTable = memo(function DataTable({ metric }: { metric: Metric }) {
  return <div className={styles.srOnly}><table>
    <caption>{metric.label} per hour, {WEEK}, workspace time</caption>
    <thead><tr><th scope="col">Day</th>{HOURS.map(h => <th key={h} scope="col">{hourLabel(h)}</th>)}</tr></thead>
    <tbody>{DAY_INDEX.map(d => <tr key={d}><th scope="row">{DAY_NAMES[d]}</th>{HOURS.map(h => <td key={h}>{count(metric.values[d * COLS + h])}</td>)}</tr>)}</tbody>
  </table></div>;
});

export function ActivityTerrain() {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const titleId = `${uid}-title`, hintId = `${uid}-hint`;
  const [metricKey, setMetricKey] = useState<MetricKey>("sessions");
  const [view, setView] = useState<View>("perspective");
  const [active, setActive] = useState<Cell | null>(null);
  const [focus, setFocus] = useState<Cell | null>(null);
  // The panel keeps its last reading while it fades out.
  const [shown, setShown] = useState<Cell | null>(null);
  const [moved, setMoved] = useState(false);
  const [live, setLive] = useState("");
  const metric = METRICS[metricKey];

  const rootRef = useRef<HTMLElement>(null), plotRef = useRef<HTMLDivElement>(null), canvasRef = useRef<HTMLCanvasElement>(null), panelRef = useRef<HTMLDivElement>(null);
  const engine = useRef<Terrain | null>(null);

  function pick(cell: Cell | null) {
    const next = cell && same(cell, focus) ? null : cell;
    setFocus(next);
    engine.current?.setFocus(next);
    if (next) { setShown(next); setLive(`Focused on ${describe(metric, next)}`); }
    else if (focus) setLive("Returned to the whole week.");
  }

  const onPick = useEffectEvent((cell: Cell | null) => pick(cell));

  useEffect(() => {
    const root = rootRef.current, plot = plotRef.current, canvas = canvasRef.current, panel = panelRef.current;
    if (!root || !plot || !canvas || !panel) return;
    const m = METRICS.sessions;
    const terrain = createTerrain({ root, plot, canvas, panel }, {
      onHover(cell) { setActive(cell); if (cell) setShown(cell); },
      onPick: cell => onPick(cell),
      onMoved: setMoved,
    }, { norm: m.norm, tone: m.tone });
    engine.current = terrain;
    return () => { terrain.destroy(); engine.current = null; };
  }, []);

  function changeMetric(value: string) {
    const next = value as MetricKey;
    if (next === metricKey) return;
    const m = METRICS[next];
    setMetricKey(next);
    engine.current?.setValues(m.norm, m.tone, active ?? focus);
    const peak = m.top[0];
    setLive(`Showing ${m.unit}. ${count(m.total)} this week, ${signedPct(m.change)} on last week. Peak ${DAY_NAMES[peak.d]} at ${hourLabel(peak.h)} with ${count(peak.value)}.`);
  }

  function changeView(value: string) {
    const next = value as View;
    if (next === view) return;
    setView(next);
    engine.current?.setView(next === "top");
    setLive(next === "top" ? "Top view: a flat heatmap of the week." : "Perspective: bar heights show activity.");
  }

  function resetView() {
    engine.current?.reset();
    pick(null);
    setMoved(false);
  }

  function point(cell: Cell | null) {
    setActive(cell);
    if (cell) setShown(cell);
    engine.current?.setActive(cell);
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const eng = engine.current;
    if (!eng) return;
    const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (e.key === "Escape") {
      if (focus) pick(null); else if (active) { point(null); setLive(""); } else return;
      e.preventDefault();
      return;
    }
    if (e.key === "+" || e.key === "=" || e.key === "-" || e.key === "_") { e.preventDefault(); eng.zoom(e.key === "+" || e.key === "=" ? 1.25 : .8); return; }
    if (e.key === "Enter" || e.key === " ") {
      const cell = active ?? focus;
      if (!cell) return;
      e.preventDefault();
      pick(cell);
      return;
    }
    if (e.shiftKey && e.key in moves) {
      e.preventDefault();
      const [dd, dh] = moves[e.key];
      eng.orbit(-dh * 15 * DEG, -dd * 8 * DEG);
      return;
    }
    if (!(e.key in moves) && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const base = active ?? focus;
    let next: Cell = metric.top[0];
    if (base) {
      const [dd, dh] = moves[e.key] ?? [0, 0];
      next = { d: clamp(base.d + dd, 0, ROWS - 1), h: e.key === "Home" ? 0 : e.key === "End" ? COLS - 1 : clamp(base.h + dh, 0, COLS - 1) };
    } else next = { d: next.d, h: next.h };
    point(next);
    setLive(describe(metric, next));
  };

  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    if (active || focus || !e.currentTarget.matches(":focus-visible")) return;
    const start = { d: metric.top[0].d, h: metric.top[0].h };
    point(start);
    setLive(describe(metric, start));
  };

  const display = active ?? focus;
  const peak = metric.top[0];
  const summary = `3D bar chart of ${metric.unit} by day and hour for ${WEEK}. ${count(metric.total)} ${metric.unit} in total, ${signedPct(metric.change)} on last week. Peak on ${DAY_NAMES[peak.d]} at ${hourLabel(peak.h)} with ${count(peak.value)}. ${DAY_NAMES[metric.busiest]} is the busiest day. Every value is listed in the table that follows.`;

  return <section ref={rootRef} className={styles.root} aria-labelledby={titleId} data-metric={metricKey}>
    <div className={styles.inner}>
      <header className={styles.header}>
        <h2 id={titleId}>The shape of your week</h2>
        <p>Hourly sessions, deploys and errors for {WEEK}, in workspace time.</p>
      </header>

      <div className={styles.toolbar}>
        <SegmentedControl label="Metric" options={METRIC_OPTIONS} value={metricKey} onValueChange={changeMetric} />
        <SegmentedControl label="Camera" options={VIEWS} value={view} onValueChange={changeView} />
      </div>

      <div className={styles.body}>
        <div className={styles.stage}>
          <div className={styles.viewport}>
          <div
            ref={plotRef}
            className={styles.plot}
            tabIndex={0}
            role="group"
            aria-label={`${metric.label} terrain`}
            aria-describedby={hintId}
            onKeyDown={onKeyDown}
            onFocus={onFocus}
            onBlur={() => { if (active) point(null); }}
          >
            <canvas ref={canvasRef} className={styles.canvas} role="img" aria-label={summary} />
            <div ref={panelRef} className={styles.panel} data-show={display ? "" : undefined} aria-hidden="true">
              {shown && <Readout metric={metric} cell={shown} />}
            </div>
          </div>
          <button type="button" className={styles.reset} onClick={resetView} data-hidden={moved || focus ? undefined : ""} aria-hidden={moved || focus ? undefined : true} tabIndex={moved || focus ? undefined : -1}>
            <RotateCcw size={16} strokeWidth={1.75} aria-hidden="true" />Reset view
          </button>
          </div>
          <div className={styles.legend}>
            <span className={styles.scale} aria-hidden="true">Fewer<span className={styles.ramp}>{[0, 1, 2, 3, 4, 5].map(k => <span key={k} style={{ "--k": k / 5 } as CSSProperties} />)}</span>More</span>
            <p id={hintId} className={styles.hint}>
              <span className={styles.hintFine}>Drag to orbit, pinch to zoom, click a bar to fly in.</span>
              <span className={styles.hintTouch}>Swipe sideways to orbit, tap a bar to fly in.</span>
              <span className={styles.srOnly}> Arrow keys move between hours and days, Enter focuses a bar, Shift with arrow keys orbits, plus and minus zoom, Escape clears.</span>
            </p>
          </div>
        </div>

        <aside className={styles.stats} aria-label="Week summary">
          <div className={styles.stat}>
            <p className={styles.label}><Rise text={`${metric.label} this week`} /></p>
            <p className={styles.big}><span className={styles.num}><AnimatedCounter value={metric.total} animateOnView /></span></p>
            <Delta change={metric.change} upIsGood={metric.upIsGood} />
          </div>
          <div className={styles.stat}>
            <p className={styles.label}>Peak hours</p>
            <ul className={styles.peaks}>
              {metric.top.map((p, rank) => {
                const on = same(p, focus);
                return <li key={rank}>
                  <button type="button" className={styles.peak} aria-pressed={on} onClick={() => pick({ d: p.d, h: p.h })} aria-label={`${DAY_NAMES[p.d]} ${hourLabel(p.h)}, ${count(p.value)} ${metric.unit}. ${on ? "Return to the whole week" : "Fly to this hour"}`}>
                    <Rise text={`${DAYS[p.d]} ${hourLabel(p.h)}`} className={styles.peakWhen} />
                    <span className={`${styles.peakValue} ${styles.num}`}><AnimatedCounter value={p.value} /></span>
                  </button>
                </li>;
              })}
            </ul>
          </div>
          <div className={styles.stat}>
            <p className={styles.label}>Busiest day</p>
            <p className={styles.mid}><Rise text={DAY_NAMES[metric.busiest]} /></p>
            <p className={styles.sub}><span className={styles.num}><AnimatedCounter value={metric.days[metric.busiest]} /></span> {metric.unit}, <span className={styles.num}><AnimatedCounter value={Math.round(metric.working * 1000) / 10} decimals={1} suffix="%" /></span> in working hours</p>
          </div>
        </aside>
      </div>

      <p className={styles.srOnly} aria-live="polite">{live}</p>
      <DataTable metric={metric} />
    </div>
  </section>;
}

export default ActivityTerrain;
