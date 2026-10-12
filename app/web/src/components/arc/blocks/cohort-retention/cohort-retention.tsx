"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { AnimatePresence, animate, motion, motionValue, useMotionValue, useMotionValueEvent, useReducedMotion, useSpring, useTransform, type MotionValue } from "motion/react";
import { ArrowUpRight } from "lucide-react";
import SegmentedControl from "../../segmented-control/segmented-control";
import { AnimatedCounter } from "../../animated-counter/animated-counter";
import { motionTokens } from "../../lib/motion-tokens";
import { AVG, CELLS, COHORTS, DATA, MONTHS, SEGMENTS, STEPS, cellAt, cohortName, count, lastMonth, pct, pts, stepOf, type CellDef, type SegmentKey } from "./cohort-data";
import { DEFAULT_WIDTH, colMid, curveY, geometry, hitTest, layoutFor, panelSpot, rowTop, type Geo } from "./cohort-geometry";
import styles from "./cohort-retention.module.css";

type View = "heatmap" | "curves";
type Hover = { r: number; k: number };

const { spring, duration, ease } = motionTokens;
const enterEase = [...ease.enter] as [number, number, number, number];
/** The whole triangle pours into curves on one critically damped spring; the diagonal stagger lives in the geometry. */
const pour = { ...spring.smooth, visualDuration: .64 };
/** Values settle without overshoot so the numbers in each cell never count past their target. */
const settle = spring.smooth;
/** The largest delay of the segment wave, for the bottom right corner. */
const WAVE = .24;
/** The value panel trails the pointer by a short, critically damped beat. */
const follow = { visualDuration: .2, bounce: 0 };
const VIEWS = [{ value: "heatmap", label: "Heatmap" }, { value: "curves", label: "Curves" }];
const ROWS = Array.from({ length: AVG + 1 }, (_, r) => r);
const COLUMNS = Array.from({ length: MONTHS }, (_, i) => i + 1);
const TICKS = [1, .75, .5, .25, 0];
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function describe(segment: SegmentKey, { r, k }: Hover) {
  const d = DATA[segment], j = cellAt(r, k);
  const who = r === AVG ? `Average of ${COHORTS - k + 1} cohorts` : `${cohortName(r)} cohort`;
  return `${who}, month ${k}: ${pct(d.rate[j])} retained, ${count(d.retained[j])} of ${count(d.base[j])} workspaces.`;
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

/** One arrow turns between up and down instead of swapping icons; the signed text carries the direction too. */
function Delta({ change }: { change: number }) {
  const reduce = useReducedMotion();
  return <span className={styles.delta} data-tone={change >= 0 ? "good" : "bad"}>
    <motion.span className={styles.deltaIcon} initial={false} animate={{ rotate: change >= 0 ? 0 : 90 }} transition={reduce ? { duration: 0 } : spring.snappy}><ArrowUpRight size={14} strokeWidth={1.75} aria-hidden="true" /></motion.span>
    <Rise text={pts(change)} className={styles.deltaValue} />
    <span className={styles.deltaContext}>latest 3 vs first 3 cohorts</span>
  </span>;
}

/**
 * A heatmap cell that can become a point on its cohort's curve. Geometry streams from one motion value; state is CSS.
 * The colour step follows the value as it counts, so the fill and the ink of the number change together with the digits
 * instead of fading toward the final step while the number is still on its way.
 */
function Cell({ geo, value, cell, state }: { geo: MotionValue<Geo>; value: MotionValue<number>; cell: CellDef; state?: "on" | "dim" }) {
  const [step, setStep] = useState(() => stepOf(value.get()));
  useMotionValueEvent(value, "change", v => setStep(stepOf(v)));
  const x = useTransform(geo, g => g.cells[cell.j].x), y = useTransform(geo, g => g.cells[cell.j].y);
  const width = useTransform(geo, g => g.cells[cell.j].w), height = useTransform(geo, g => g.cells[cell.j].h);
  const rx = useTransform(geo, g => g.cells[cell.j].rx), cx = useTransform(geo, g => g.cells[cell.j].cx), cy = useTransform(geo, g => g.cells[cell.j].cy);
  const ink = useTransform(geo, g => g.cells[cell.j].ink), label = useTransform(geo, g => g.cells[cell.j].label);
  return <g className={styles.cell} data-step={step} data-state={state} data-avg={cell.r === AVG || undefined}>
    <motion.rect x={x} y={y} width={width} height={height} rx={rx} />
    <motion.text x={cx} y={cy} dy=".35em" textAnchor="middle" style={{ opacity: ink }}>{label}</motion.text>
  </g>;
}

function Line({ geo, r, state }: { geo: MotionValue<Geo>; r: number; state?: "on" | "dim" }) {
  const d = useTransform(geo, g => g.paths[r]);
  return <motion.path className={styles.line} d={d} data-state={state} data-avg={r === AVG || undefined} />;
}

/** Cohort sizes roll with the same spring as the cells beside them. */
function Size({ value, x, y }: { value: MotionValue<number>; x: number; y: number }) {
  const text = useTransform(value, v => count(Math.round(v)));
  return <motion.text className={styles.size} x={x} y={y} dy=".35em" textAnchor="end">{text}</motion.text>;
}

function Readout({ segment, hover }: { segment: SegmentKey; hover: Hover }) {
  const d = DATA[segment], j = cellAt(hover.r, hover.k), avg = d.rate[cellAt(AVG, hover.k)], gap = d.rate[j] - avg;
  return <>
    <p className={styles.panelHead}><span>{hover.r === AVG ? "Average" : `${cohortName(hover.r)} cohort`}</span><span>Month {hover.k}</span></p>
    <p className={styles.panelValue}>{pct(d.rate[j])}</p>
    <dl className={styles.panelRows}>
      <div><dt>Still active</dt><dd>{count(d.retained[j])} of {count(d.base[j])}</dd></div>
      {hover.r === AVG
        ? <div><dt>Weighted across</dt><dd>{COHORTS - hover.k + 1} cohorts</dd></div>
        : <div><dt>Vs average</dt><dd data-tone={Math.abs(gap) < .0005 ? undefined : gap > 0 ? "good" : "bad"}>{pts(gap)}</dd></div>}
    </dl>
  </>;
}

function Legend({ view }: { view: View }) {
  const reduce = useReducedMotion();
  const hidden = reduce ? { opacity: 0 } : { opacity: 0, y: 6 };
  return <div className={styles.legendSlot}>
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.div key={view} className={styles.legend} initial={hidden} animate={{ opacity: 1, y: 0 }} exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }} transition={{ duration: reduce ? duration.instant : duration.standard, ease: enterEase }}>
        {view === "heatmap"
          ? <div className={styles.scale} role="img" aria-label="Darker cells retain more. Steps start at 20, 35, 50, 65 and 80 percent retained.">
            <span className={styles.scaleLabel}>% retained</span>
            <span className={styles.ramp} aria-hidden="true">{STEPS.map((floor, i) => <span key={floor} className={styles.rampStep} data-step={i} />)}</span>
            <span className={styles.rampTicks} aria-hidden="true">{STEPS.slice(1).map((floor, i) => <span key={floor} style={{ left: (i + 1) * 30 - 1 }}>{Math.round(floor * 100)}</span>)}</span>
          </div>
          : <div className={styles.keys}>
            <span className={styles.key}><span className={styles.keyAvg} aria-hidden="true" />Average, size-weighted</span>
            <span className={styles.key}><span className={styles.keyLine} aria-hidden="true" />One line per cohort</span>
          </div>}
      </motion.div>
    </AnimatePresence>
  </div>;
}

export function CohortRetention() {
  const reduce = !!useReducedMotion();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const titleId = `${uid}-title`, hintId = `${uid}-hint`, tableId = `${uid}-table`;
  const [segment, setSegment] = useState<SegmentKey>("all");
  const [view, setView] = useState<View>("heatmap");
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [hover, setHover] = useState<Hover | null>(null);
  // The panel keeps its last reading while it fades out.
  const [shown, setShown] = useState<Hover | null>(null);
  const [live, setLive] = useState("");

  // Every cell value and cohort size is its own motion value, so a new segment retargets each one mid-flight.
  const [values] = useState(() => CELLS.map(cell => motionValue(DATA.all.rate[cell.j])));
  const [sizes] = useState(() => ROWS.map(r => motionValue(r === AVG ? DATA.all.total : DATA.all.sizes[r])));
  const viewMv = useMotionValue(0), widthMv = useMotionValue(DEFAULT_WIDTH), hoverMv = useMotionValue(0);
  const inputs = useMemo(() => [viewMv, widthMv, hoverMv, ...values], [viewMv, widthMv, hoverMv, values]);
  const geo = useTransform(inputs, (v: number[]) => geometry(v[0], v[1], v[2], v.slice(3)));

  const lines = useTransform(geo, g => g.lines), labels = useTransform(geo, g => g.labels), grid = useTransform(geo, g => g.grid);
  const mx = useTransform(geo, g => g.marker.x), my = useTransform(geo, g => g.marker.y), mw = useTransform(geo, g => g.marker.w), mh = useTransform(geo, g => g.marker.h), mr = useTransform(geo, g => g.marker.rx);
  const hoverPath = useTransform(geo, g => g.hoverPath), crossX = useTransform(geo, g => g.crossX), crossY = useTransform(geo, g => g.crossY);
  const tagY = useTransform(geo, g => g.crossY - 10);
  // The tag reads the same animated value the crosshair rides, not the final one.
  const tagText = useTransform(inputs, (v: number[]) => pct(v[3 + Math.max(0, v[2])]));
  const rawX = useTransform(geo, g => g.panel.x), rawY = useTransform(geo, g => g.panel.y);
  const springX = useSpring(rawX, follow), springY = useSpring(rawY, follow);
  const panelX = reduce ? rawX : springX, panelY = reduce ? rawY : springY;

  const chartRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = chartRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (w) { setWidth(w); widthMv.set(w); }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [widthMv]);

  const L = layoutFor(width), data = DATA[segment], curves = view === "curves";
  const noun = SEGMENTS.find(s => s.value === segment)!.noun;

  function point(next: Hover | null) {
    if (next?.r === hover?.r && next?.k === hover?.k) return;
    if (next) {
      const j = cellAt(next.r, next.k);
      // A panel that appears starts beside its cell; only later moves glide.
      if (!hover) {
        const spot = panelSpot(layoutFor(widthMv.get()), geometry(viewMv.get(), widthMv.get(), j, values.map(v => v.get())).cells[j]);
        springX.jump(spot.x); springY.jump(spot.y);
      }
      hoverMv.set(j);
      setShown(next);
    }
    setHover(next);
  }

  function changeSegment(value: string) {
    const next = value as SegmentKey;
    if (next === segment) return;
    setSegment(next);
    const d = DATA[next];
    values.forEach((mv, j) => {
      if (reduce) mv.jump(d.rate[j]);
      // A cell already in flight turns toward the new value at once instead of waiting for its place in the wave.
      else animate(mv, d.rate[j], { ...settle, delay: mv.isAnimating() ? 0 : CELLS[j].wave * WAVE });
    });
    sizes.forEach((mv, r) => {
      const to = r === AVG ? d.total : d.sizes[r];
      if (reduce) mv.jump(to);
      else animate(mv, to, { ...settle, delay: mv.isAnimating() ? 0 : (r / (AVG + MONTHS - 1)) * WAVE });
    });
    setLive(`Showing ${SEGMENTS.find(s => s.value === next)!.noun}. Month 1 retention ${pct(d.m1)}, month 6 retention ${pct(d.m6)}.`);
  }

  function changeView(value: string) {
    const next = value as View;
    if (next === view) return;
    setView(next);
    if (reduce) viewMv.jump(next === "curves" ? 1 : 0);
    else animate(viewMv, next === "curves" ? 1 : 0, pour);
    setLive(next === "curves" ? "Showing one retention curve per cohort with the weighted average." : "Showing the retention heatmap.");
  }

  const locate = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return hitTest(L, curves, data.rate, e.clientX - rect.left, e.clientY - rect.top);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") { if (hover) { e.preventDefault(); point(null); setLive(""); } return; }
    const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (!(e.key in moves) && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    let next: Hover = { r: 0, k: 1 };
    if (hover) {
      const [dr, dk] = moves[e.key] ?? [0, 0];
      const r = clamp(hover.r + dr, 0, AVG);
      const k = e.key === "Home" ? 1 : e.key === "End" ? lastMonth(r) : hover.k + dk;
      next = { r, k: clamp(k, 1, lastMonth(r)) };
    }
    point(next);
    setLive(describe(segment, next));
  };

  const cellState = (cell: CellDef): "on" | "dim" | undefined => {
    if (!hover) return undefined;
    if (curves) return cell.r === hover.r ? "on" : cell.r === AVG ? undefined : "dim";
    return cell.r === hover.r || cell.k === hover.k ? "on" : "dim";
  };
  const lineState = (r: number): "on" | "dim" | undefined => (!hover || r === AVG ? undefined : r === hover.r ? "on" : "dim");
  const summary = `${curves ? "Retention curves" : "Retention heatmap"} for ${noun}, August 2025 to July 2026 signup cohorts. Month 1 retention averages ${pct(data.m1)} and month 6 retention ${pct(data.m6)}. Newer cohorts retain ${pts(data.m1Delta)} more in month 1 than the first three. Every value is listed in the table that follows.`;

  return <section className={styles.root} aria-labelledby={titleId}>
    <div className={styles.inner}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <h2 id={titleId}>Cohort retention</h2>
          <p>Workspaces still active each month after signup. Data through Aug 31, 2026.</p>
        </div>
        <SegmentedControl label="Segment" options={SEGMENTS} value={segment} onValueChange={changeSegment} />
      </header>

      <dl className={styles.kpis}>
        <div className={styles.kpi}>
          <dt>Month 1 retention</dt>
          <dd><span className={styles.value}><span className={styles.num}><AnimatedCounter value={Math.round(data.m1 * 1000) / 10} decimals={1} suffix="%" /></span></span><Delta change={data.m1Delta} /></dd>
        </div>
        <div className={styles.kpi}>
          <dt>Month 6 retention</dt>
          <dd><span className={styles.value}><span className={styles.num}><AnimatedCounter value={Math.round(data.m6 * 1000) / 10} decimals={1} suffix="%" /></span></span><Delta change={data.m6Delta} /></dd>
        </div>
        <div className={styles.kpi}>
          <dt>New workspaces</dt>
          <dd><span className={styles.value}><span className={styles.num}><AnimatedCounter value={data.total} /></span></span><span className={styles.delta}>Signed up Aug 2025 to Jul 2026</span></dd>
        </div>
      </dl>

      <div className={styles.toolbar}>
        <Legend view={view} />
        <SegmentedControl label="Chart view" options={VIEWS} value={view} onValueChange={changeView} />
      </div>

      <div ref={chartRef} className={styles.chart}>
        <div
          className={styles.plot}
          style={{ height: L.height }}
          tabIndex={0}
          role="group"
          aria-label="Retention by cohort and month"
          aria-describedby={hintId}
          data-view={view}
          data-active={hover ? "" : undefined}
          onPointerDown={e => point(locate(e))}
          onPointerMove={e => point(locate(e))}
          onPointerLeave={e => { if (e.pointerType === "mouse") point(null); }}
          onKeyDown={onKeyDown}
          onFocus={e => { if (!hover && e.currentTarget.matches(":focus-visible")) { point({ r: 0, k: 1 }); setLive(describe(segment, { r: 0, k: 1 })); } }}
          onBlur={() => point(null)}
        >
          <svg className={styles.svg} width={width} height={L.height} viewBox={`0 0 ${width} ${L.height}`} role="img" aria-label={summary}>
            <motion.g style={{ opacity: grid }}>
              {TICKS.map(t => {
                const y = Math.round(curveY(L, t)) + .5;
                return <g key={t}>
                  <line className={t === 0 ? styles.baseline : styles.gridLine} x1={L.gutter} x2={width} y1={y} y2={y} />
                  <text className={styles.axis} x={L.gutter - 12} y={y} dy=".32em" textAnchor="end">{Math.round(t * 100)}%</text>
                </g>;
              })}
            </motion.g>

            <motion.g style={{ opacity: labels }}>
              {ROWS.map(r => {
                const y = rowTop(L, r) + L.rowH / 2;
                return <g key={r} className={styles.rowLabel} data-on={hover?.r === r || undefined} data-avg={r === AVG || undefined}>
                  <text x={0} y={y} dy=".35em">{cohortName(r, !L.wide)}</text>
                  {L.wide && <Size value={sizes[r]} x={L.gutter - 14} y={y} />}
                </g>;
              })}
            </motion.g>

            <g>
              <text className={styles.axis} x={0} y={L.plotH + 21}>{L.wide ? "Months since signup" : "Month"}</text>
              {COLUMNS.map(k => <text key={k} className={styles.axis} data-on={hover?.k === k || undefined} x={colMid(L, k)} y={L.plotH + 21} textAnchor="middle">{k}</text>)}
            </g>

            {hover && <motion.g className={styles.cross} style={{ opacity: lines }}>
              <motion.line x1={crossX} x2={crossX} y1={curveY(L, 1) - 6} y2={curveY(L, 0)} />
              <motion.line x1={L.gutter} x2={crossX} y1={crossY} y2={crossY} strokeDasharray="2 3" />
            </motion.g>}

            <motion.g style={{ opacity: lines }}>
              {ROWS.map(r => <Line key={r} geo={geo} r={r} state={lineState(r)} />)}
              {hover && hover.r !== AVG && <motion.path className={styles.line} data-state="on" d={hoverPath} />}
            </motion.g>

            {CELLS.map(cell => <Cell key={cell.j} geo={geo} value={values[cell.j]} cell={cell} state={cellState(cell)} />)}

            {hover && <motion.rect className={styles.marker} x={mx} y={my} width={mw} height={mh} rx={mr} />}

            {hover && <motion.g className={styles.tag} style={{ y: tagY, opacity: lines }}>
              <rect x={Math.max(2, L.gutter - 58)} y={0} width={52} height={20} rx={6} />
              <motion.text x={L.gutter - 12} y={10} dy=".35em" textAnchor="end">{tagText}</motion.text>
            </motion.g>}
          </svg>

          <motion.div className={styles.panel} style={{ x: panelX, y: panelY }} initial={false} animate={{ opacity: hover ? 1 : 0 }} transition={{ duration: hover ? duration.instant : duration.fast }} aria-hidden="true">
            {shown && <Readout segment={segment} hover={shown} />}
          </motion.div>
        </div>
      </div>

      <p id={hintId} className={styles.srOnly}>Use the arrow keys to move between cohorts and months, Home and End to jump within a cohort, and Escape to clear.</p>
      <p className={styles.srOnly} aria-live="polite">{live}</p>

      <div className={styles.srOnly}><table id={tableId}>
        <caption>Share of {noun} still active by months since signup</caption>
        <thead><tr><th scope="col">Cohort</th><th scope="col">Workspaces</th>{COLUMNS.map(k => <th key={k} scope="col">Month {k}</th>)}</tr></thead>
        <tbody>
          {ROWS.map(r => <tr key={r}>
            <th scope="row">{cohortName(r)}</th>
            <td>{count(r === AVG ? data.total : data.sizes[r])}</td>
            {COLUMNS.map(k => <td key={k}>{k <= lastMonth(r) ? pct(data.rate[cellAt(r, k)]) : "Not yet measured"}</td>)}
          </tr>)}
        </tbody>
      </table></div>
    </div>
  </section>;
}

export default CohortRetention;
