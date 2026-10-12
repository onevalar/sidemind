"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { AnimatePresence, animate, cancelFrame, frame, motion, motionValue, useMotionValue, useReducedMotion } from "motion/react";
import { ChevronDown, X } from "lucide-react";
import { motionTokens } from "../../lib/motion-tokens";
import { BOTTOM, COLUMNS, LINKS, NODES, NODE_W, SEGMENTS, STAGES, TOP, computeLayout, fmt, nodeTotals, pct, ribbon, traceFractions, type TraceTarget } from "./journey-flow-geometry";
import styles from "./journey-flow.module.css";

const TIP_W = 212, TIP_H = 112, LAST = COLUMNS - 1;
const VISITED = 0, SIGNED_UP = 1, BOUNCED = 2, ONBOARDED = 3, DROPPED = 4, PAID = 7, FREE = 8;
/** Flows morph a little slower than a control so the eye can follow each band growing or shrinking. */
const flowSpring = { ...motionTokens.spring.morph, visualDuration: .62 };
/** Counts follow the shapes a beat later and never overshoot their final value. */
const countSpring = { ...motionTokens.spring.smooth, visualDuration: .62, delay: .06 };
const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

const chartHeight = (width: number) => width < 480 ? 340 : width < 720 ? 372 : 404;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const sameTarget = (a: TraceTarget | null, b: TraceTarget | null) => !!a && !!b && a.kind === b.kind && a.i === b.i;
const labelCount = (i: number, totals: number[], width: number) => width >= 600 && i > 0 ? `${fmt(totals[i])} · ${Math.round(totals[i] / totals[0] * 100)}%` : fmt(totals[i]);
/** On narrow charts the second-to-last column's exit label runs into the last column's lower label, so that one sits under its bar instead. */
/* Under 440px the top row shows counts only; the stage axis below names each column, so labels never collide. */
const labelBelow = (i: number, width: number) => width < 600 && NODES[i].id === "free";
const labelTransform = (i: number, node: { x0: number; x1: number; y0: number; y1: number }, width: number) =>
  `translate(${NODES[i].col === LAST ? node.x1 : node.x0} ${(labelBelow(i, width) ? node.y1 + 34 : node.y0).toFixed(2)})`;
const lower = (i: number) => NODES[i].name.toLowerCase();

function tipModel(target: TraceTarget, values: readonly number[]) {
  const { totals } = nodeTotals(values);
  if (target.kind === "link") {
    const { s, t } = LINKS[target.i], value = values[target.i];
    return { title: `${NODES[s].name} → ${NODES[t].name}`, count: value, rows: [[`Share of ${lower(s)}`, pct(value / totals[s])], ["Share of visitors", pct(value / totals[VISITED])]] };
  }
  const i = target.i, value = totals[i];
  if (i === VISITED) return { title: NODES[i].name, count: value, rows: LINKS.flatMap((link, j) => link.s === i ? [[NODES[link.t].name, pct(values[j] / value)]] : []) };
  const parents = LINKS.filter(link => link.t === i).map(link => link.s);
  const base = parents.reduce((sum, parent) => sum + totals[parent], 0);
  return { title: NODES[i].name, count: value, rows: [[`Share of ${parents.length === 1 ? lower(parents[0]) : lower(ONBOARDED)}`, pct(value / base)], ["Share of visitors", pct(value / totals[VISITED])]] };
}

type PanelRow = { label: string; count: number; share: number } | null;
type PanelGroup = { heading: string; empty: string; rows: PanelRow[] };

function panelModel(values: readonly number[], segmentLabel: string, selected: number | null) {
  const { totals } = nodeTotals(values);
  const visits = totals[VISITED];
  if (selected === null) return {
    key: "overview", title: segmentLabel, note: "Select a step to see where its users came from and went next",
    count: totals[PAID], share: totals[PAID] / visits, caption: "of visitors started a paid plan",
    groups: [
      { heading: "Largest drop-offs", empty: "", rows: [
        { label: "Bounced after visiting", count: totals[BOUNCED], share: totals[BOUNCED] / visits },
        { label: "Dropped during setup", count: totals[DROPPED], share: totals[DROPPED] / totals[SIGNED_UP] },
      ] },
      { heading: "Plan after setup", empty: "", rows: [
        { label: "Paid", count: totals[PAID], share: totals[PAID] / totals[ONBOARDED] },
        { label: "Free", count: totals[FREE], share: totals[FREE] / totals[ONBOARDED] },
      ] },
    ] as PanelGroup[],
  };
  const total = totals[selected];
  const rows = (side: "s" | "t") => {
    const list = LINKS.map((link, i) => ({ link, i })).filter(({ link }) => (side === "s" ? link.t : link.s) === selected);
    return [0, 1].map(slot => list[slot] ? { label: NODES[list[slot].link[side]].name, count: values[list[slot].i], share: values[list[slot].i] / total } : null);
  };
  return {
    key: NODES[selected].id, title: NODES[selected].name, note: NODES[selected].note,
    count: total, share: total / visits, caption: "of visitors",
    groups: [
      { heading: "Came from", empty: "Journey starts here", rows: rows("s") },
      { heading: "Went to", empty: "Journey ends here", rows: rows("t") },
    ] as PanelGroup[],
  };
}

/** Text that changes settles in with a short rise while the old text fades out; no blur, so it reads as one calm swap. */
function Swap({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  return <AnimatePresence mode="popLayout" initial={false}>
    <motion.span key={id} className={className ?? styles.swap}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, transition: { duration: motionTokens.duration.instant, ease: motionTokens.ease.standard } }}
      transition={reduce ? { duration: motionTokens.duration.fast } : { duration: motionTokens.duration.standard, ease: motionTokens.ease.enter }}>
      {children}
    </motion.span>
  </AnimatePresence>;
}

/** Each digit is a strip of 0 to 9 that rolls to its new value; digits keep their place counted from the right. */
/** The glyph row springs to the width of its new value, so text beside a number glides instead of jumping when a digit appears or leaves. */
function Rolling({ value, className }: { value: string; className?: string }) {
  const reduce = useReducedMotion();
  const chars = Array.from(value);
  const sizer = useRef<HTMLSpanElement>(null);
  const [glyphWidth, setGlyphWidth] = useState<number | "auto">("auto");
  useLayoutEffect(() => {
    const node = sizer.current;
    if (!node) return;
    const measure = () => setGlyphWidth(node.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <span className={[styles.rolling, className].filter(Boolean).join(" ")}>
    <span className={styles.srOnly}>{value}</span>
    <span ref={sizer} className={styles.sizer} aria-hidden="true">{value}</span>
    <motion.span className={styles.glyphs} aria-hidden="true" initial={false} animate={{ width: glyphWidth }} transition={reduce ? { duration: 0 } : motionTokens.spring.smooth}>
      <AnimatePresence mode="popLayout" initial={false}>
        {chars.map((char, index) => {
          const slot = chars.length - index;
          if (!/\d/.test(char)) return <motion.span key={`s${slot}${char}`} className={styles.glyph} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: motionTokens.duration.instant } }} transition={{ duration: motionTokens.duration.fast, ease: motionTokens.ease.standard }}>{char}</motion.span>;
          return <motion.span key={`d${slot}`} className={styles.digit} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: motionTokens.duration.instant } }} transition={{ duration: motionTokens.duration.fast, ease: motionTokens.ease.standard }}>
            <motion.span className={styles.strip} initial={false} animate={{ y: `${Number(char) * -10}%` }} transition={reduce ? { duration: 0 } : { ...motionTokens.spring.smooth, delay: (slot - 1) * .02 }}>
              {DIGITS.map(digit => <span key={digit}>{digit}</span>)}
            </motion.span>
          </motion.span>;
        })}
      </AnimatePresence>
    </motion.span>
  </span>;
}

function BreakdownRow({ row, empty }: { row: PanelRow; empty: string }) {
  const reduce = useReducedMotion();
  const label = row ? row.label : empty;
  return <li className={styles.row} data-empty={!row || undefined} aria-hidden={!row && !empty ? true : undefined}>
    <span className={styles.rowLabel}><Swap id={label || "blank"}>{label || " "}</Swap></span>
    <span className={styles.rowCount}><Rolling value={row ? fmt(row.count) : ""} /></span>
    <span className={styles.rowShare}><Rolling value={row ? pct(row.share) : ""} /></span>
    <span className={styles.track}>
      <motion.span className={styles.bar} initial={false} animate={{ scaleX: row ? row.share : 0 }} transition={reduce ? { duration: 0 } : motionTokens.spring.morph} />
    </span>
  </li>;
}

export interface JourneyFlowProps { className?: string }

/** A Sankey diagram of trial journeys. Segments morph every band, hovering traces a cohort through the whole journey, and selecting a step pins its breakdown. */
export function JourneyFlow({ className }: JourneyFlowProps) {
  const uid = useId();
  const reduce = useReducedMotion();
  const [segment, setSegment] = useState(0);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<TraceTarget | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [tableOpen, setTableOpen] = useState(false);
  const height = chartHeight(width);
  const { label: segmentLabel, values } = SEGMENTS[segment];

  // Geometry, label counts, and the traced share of every link each live in motion values; a frame callback redraws from them.
  const [mv] = useState(() => ({
    vals: SEGMENTS[0].values.map(value => motionValue(value)),
    shown: SEGMENTS[0].values.map(value => motionValue(value)),
    trace: LINKS.map(() => motionValue(0)),
  }));
  const tipX = useMotionValue(0), tipY = useMotionValue(0), fade = useMotionValue(1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const segmentRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const el = useRef({
    base: [] as (SVGPathElement | null)[], trace: [] as (SVGPathElement | null)[],
    src: [] as (SVGRectElement | null)[], dst: [] as (SVGRectElement | null)[], node: [] as (SVGRectElement | null)[],
    label: [] as (SVGGElement | null)[], count: [] as (SVGTextElement | null)[],
    button: [] as (HTMLButtonElement | null)[], hit: [] as (HTMLSpanElement | null)[],
  });
  const size = useRef({ width: 720, height: chartHeight(720) });
  /** The node a keyboard user is on; the tooltip pins to it instead of the pointer. */
  const anchor = useRef<number | null>(null);

  const draw = useCallback(() => {
    const { width: w, height: h } = size.current;
    const e = el.current;
    const layout = computeLayout(mv.vals.map(value => Math.max(0, value.get())), w, h);
    const place = (rect: SVGRectElement | null, x: number, y: number, rh: number) => {
      if (!rect) return;
      rect.setAttribute("x", String(x)); rect.setAttribute("y", y.toFixed(2)); rect.setAttribute("height", Math.max(0, rh).toFixed(2));
    };
    layout.links.forEach((link, i) => {
      const { s, t } = LINKS[i];
      e.base[i]?.setAttribute("d", ribbon(link.x0, link.x1, link.sy, link.ty, Math.max(link.w, .75)));
      const tw = link.w * clamp(mv.trace[i].get(), 0, 1);
      e.trace[i]?.setAttribute("d", tw > .02 ? ribbon(link.x0, link.x1, link.sy, link.ty, tw) : "M0 0");
      place(e.src[i], layout.nodes[s].x0, link.sy, tw);
      place(e.dst[i], layout.nodes[t].x0, link.ty, tw);
    });
    const shown = nodeTotals(mv.shown.map(value => value.get())).totals;
    layout.nodes.forEach((node, i) => {
      const nh = node.y1 - node.y0, hit = Math.max(14, nh + 6);
      place(e.node[i], node.x0, node.y0, nh);
      e.label[i]?.setAttribute("transform", labelTransform(i, node, w));
      const text = labelCount(i, shown, w), count = e.count[i];
      if (count && count.textContent !== text) count.textContent = text;
      const button = e.button[i], hitArea = e.hit[i];
      if (button) button.style.transform = `translate(${node.x0}px, ${node.y0.toFixed(2)}px)`;
      if (hitArea) { hitArea.style.height = `${hit.toFixed(2)}px`; hitArea.style.top = `${((nh - hit) / 2).toFixed(2)}px`; }
    });
    const pinned = anchor.current;
    if (pinned !== null) {
      const node = layout.nodes[pinned];
      const x = node.x1 + 14 + TIP_W > w ? node.x0 - 14 - TIP_W : node.x1 + 14;
      tipX.set(clamp(x, 0, Math.max(0, w - TIP_W)));
      tipY.set(clamp(node.y0 - 8, 0, Math.max(0, h - TIP_H)));
    }
  }, [mv, tipX, tipY]);

  useEffect(() => {
    const schedule = () => frame.render(draw);
    const stops = [...mv.vals, ...mv.shown, ...mv.trace].map(value => value.on("change", schedule));
    return () => { stops.forEach(stop => stop()); cancelFrame(draw); };
  }, [draw, mv]);

  // React writes the resting geometry for a new segment or width; draw replaces it with the in-flight frame before paint.
  useLayoutEffect(() => { size.current = { width, height }; draw(); }, [draw, width, height, segment]);

  useEffect(() => {
    const node = wrapRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => { const next = Math.round(entry.contentRect.width); if (next > 0) setWidth(next); });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const target = SEGMENTS[segment].values;
    if (reduce) { mv.vals.forEach((value, i) => value.jump(target[i])); mv.shown.forEach((value, i) => value.jump(target[i])); return; }
    const controls = [...mv.vals.map((value, i) => animate(value, target[i], flowSpring)), ...mv.shown.map((value, i) => animate(value, target[i], countSpring))];
    return () => controls.forEach(control => control.stop());
  }, [mv, segment, reduce]);

  const fractions = useMemo(() => traceFractions(values, hover ?? (selected === null ? null : { kind: "node", i: selected })), [values, hover, selected]);
  useEffect(() => {
    if (reduce) { mv.trace.forEach((value, i) => value.jump(fractions[i])); return; }
    const controls = mv.trace.map((value, i) => animate(value, fractions[i], motionTokens.spring.snappy));
    return () => controls.forEach(control => control.stop());
  }, [mv, fractions, reduce]);

  const resting = useMemo(() => computeLayout(values, width, height), [values, width, height]);
  const { totals } = nodeTotals(values);
  const tracing = hover !== null || selected !== null;
  const onPath = NODES.map((_, j) => sameTarget(hover ?? (selected === null ? null : { kind: "node", i: selected }), { kind: "node", i: j }) || LINKS.some((link, i) => fractions[i] > 1e-4 && (link.s === j || link.t === j)));
  const tip = hover ? tipModel(hover, values) : null;
  const panel = panelModel(values, segmentLabel, selected);
  const step = Math.max(0, width - NODE_W) / LAST;
  const baseline = Math.round(height - BOTTOM + 10) + .5;
  const summary = `Journey flow for ${segmentLabel.toLowerCase()}: ${fmt(totals[VISITED])} visited. ${fmt(totals[SIGNED_UP])} signed up and ${fmt(totals[BOUNCED])} bounced. ${fmt(totals[ONBOARDED])} onboarded and ${fmt(totals[DROPPED])} dropped during setup. ${fmt(totals[5])} activated and ${fmt(totals[6])} stalled. ${fmt(totals[PAID])} started a paid plan and ${fmt(totals[FREE])} stayed free.`;

  const chooseSegment = (i: number) => {
    if (i === segment) return;
    setSegment(i);
    if (reduce) { fade.jump(.35); animate(fade, 1, { duration: motionTokens.duration.standard, ease: motionTokens.ease.standard }); }
  };
  const onSegmentKey = (event: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = (i + delta + SEGMENTS.length) % SEGMENTS.length;
    chooseSegment(next);
    segmentRefs.current[next]?.focus();
  };

  const placeTip = (clientX: number, clientY: number) => {
    const box = wrapRef.current?.getBoundingClientRect();
    if (!box) return;
    const { width: w, height: h } = size.current, px = clientX - box.left, py = clientY - box.top;
    tipX.set(clamp(px + 14 + TIP_W > w ? px - 14 - TIP_W : px + 14, 0, Math.max(0, w - TIP_W)));
    tipY.set(clamp(py + 16 + TIP_H > h ? py - 16 - TIP_H : py + 16, 0, Math.max(0, h - TIP_H)));
  };
  const pointTo = (event: ReactPointerEvent, target: TraceTarget) => {
    if (event.pointerType === "touch") return;
    anchor.current = null;
    placeTip(event.clientX, event.clientY);
    setHover(target);
  };
  const release = (event: ReactPointerEvent, target: TraceTarget) => {
    if (event.pointerType !== "touch") setHover(current => sameTarget(current, target) ? null : current);
  };
  const tap = (event: ReactPointerEvent, target: TraceTarget) => {
    if (event.pointerType !== "touch") return;
    anchor.current = null;
    placeTip(event.clientX, event.clientY);
    setHover(current => sameTarget(current, target) ? null : target);
  };
  const clearAll = () => { anchor.current = null; setHover(null); setSelected(null); };

  const onNodeKey = (event: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const column = (col: number) => NODES.map((node, j) => node.col === col ? j : -1).filter(j => j >= 0);
    let next = -1;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const list = column(NODES[i].col);
      next = list[list.indexOf(i) + (event.key === "ArrowDown" ? 1 : -1)] ?? -1;
    } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      // Across columns, land on the step whose top edge sits closest, so the happy path stays a straight line of keys.
      const top = (j: number) => resting.nodes[j].y0;
      next = column(NODES[i].col + (event.key === "ArrowRight" ? 1 : -1)).reduce((best, j) => best < 0 || Math.abs(top(j) - top(i)) < Math.abs(top(best) - top(i)) ? j : best, -1);
    } else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = NODES.length - 1;
    else if (event.key === "Escape" && selected !== null) { event.preventDefault(); setSelected(null); return; }
    else return;
    event.preventDefault();
    if (next >= 0) el.current.button[next]?.focus();
  };

  return <section className={[styles.flow, className].filter(Boolean).join(" ")} aria-labelledby={`${uid}-title`}>
    <header className={styles.header}>
      <div className={styles.heading}>
        <h2 id={`${uid}-title`} className={styles.title}>Journeys to a paid plan</h2>
        <p className={styles.subtitle}><Rolling className={styles.subtitleCount} value={fmt(totals[VISITED])} /> visits in August, followed from first session to plan</p>
      </div>
      <div role="radiogroup" aria-label="Acquisition channel" className={styles.segments}>
        {SEGMENTS.map((item, i) => <button key={item.id} ref={node => { segmentRefs.current[i] = node; }} type="button" role="radio" aria-checked={i === segment} tabIndex={i === segment ? 0 : -1} className={styles.segment} onClick={() => chooseSegment(i)} onKeyDown={event => onSegmentKey(event, i)}>
          {i === segment && <motion.span layoutId={`${uid}-segment`} className={styles.segmentThumb} transition={reduce ? { duration: 0 } : motionTokens.spring.snappy} />}
          <span className={styles.segmentLabel}>{item.label}</span>
        </button>)}
      </div>
    </header>
    <p className={styles.srOnly} aria-live="polite">{`${segmentLabel}: ${fmt(totals[VISITED])} visits and ${fmt(totals[PAID])} paid plans.`}</p>

    <div className={styles.body}>
      <div className={styles.chartArea}>
        <div ref={wrapRef} className={styles.chartWrap} style={{ height, "--hit-w": `${clamp(step - 10, 44, 92)}px` } as CSSProperties}
          onPointerMove={event => { if (event.pointerType !== "touch" && anchor.current === null) placeTip(event.clientX, event.clientY); }}>
          <motion.svg className={styles.chart} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary} data-tracing={tracing || undefined} style={{ opacity: fade }}>
            <rect className={styles.backdrop} width={width} height={height} onClick={clearAll} />
            <g aria-hidden="true">
              {STAGES.map((stage, col) => {
                const x = Math.round(col * step + NODE_W / 2) + .5;
                return <line key={stage} className={styles.guide} x1={x} x2={x} y1={TOP} y2={baseline} />;
              })}
              <line className={styles.guide} x1={0} x2={width} y1={baseline} y2={baseline} />
              {STAGES.map((stage, col) => <text key={stage} className={styles.stage} data-end={col === LAST || undefined} x={col === LAST ? Math.round(col * step) + NODE_W : Math.round(col * step)} y={height - 6}>{width < 440 && stage === "First week" ? "Week 1" : stage}</text>)}
            </g>
            <g>
              {resting.links.map((link, i) => <path key={i} ref={node => { el.current.base[i] = node; }} className={styles.ribbon}
                data-exit={NODES[LINKS[i].t].kind === "exit" || undefined} data-goal={NODES[LINKS[i].t].kind === "goal" || undefined}
                d={ribbon(link.x0, link.x1, link.sy, link.ty, Math.max(link.w, .75))}
                onPointerEnter={event => pointTo(event, { kind: "link", i })} onPointerLeave={event => release(event, { kind: "link", i })} onPointerUp={event => tap(event, { kind: "link", i })} />)}
            </g>
            <g aria-hidden="true">
              {LINKS.map((_, i) => <path key={i} ref={node => { el.current.trace[i] = node; }} className={styles.trace} />)}
            </g>
            <g aria-hidden="true">
              {resting.nodes.map((node, i) => <rect key={i} ref={rect => { el.current.node[i] = rect; }} className={styles.node} data-kind={NODES[i].kind} x={node.x0} y={node.y0} width={NODE_W} height={node.y1 - node.y0} rx={1} />)}
              {LINKS.map((_, i) => <g key={i}>
                <rect ref={rect => { el.current.src[i] = rect; }} className={styles.overlay} x={0} y={0} width={NODE_W} height={0} rx={1} />
                <rect ref={rect => { el.current.dst[i] = rect; }} className={styles.overlay} x={0} y={0} width={NODE_W} height={0} rx={1} />
              </g>)}
            </g>
            <g aria-hidden="true">
              {resting.nodes.map((node, i) => <g key={i} ref={group => { el.current.label[i] = group; }} className={styles.label} data-on={!tracing || onPath[i] || undefined} data-end={NODES[i].col === LAST || undefined} transform={labelTransform(i, node, width)}>
                {(width >= 440 || NODES[i].kind === "exit") && <text className={styles.labelName} y={-20}>{NODES[i].name}</text>}
                <text ref={text => { el.current.count[i] = text; }} className={styles.labelCount} y={-7}>{labelCount(i, totals, width)}</text>
              </g>)}
            </g>
          </motion.svg>

          <div role="toolbar" aria-label="Journey steps" className={styles.nodeLayer}>
            {resting.nodes.map((node, i) => {
              const nh = node.y1 - node.y0, hit = Math.max(14, nh + 6);
              return <button key={NODES[i].id} ref={button => { el.current.button[i] = button; }} type="button" className={styles.nodeButton} data-end={NODES[i].col === LAST || undefined}
                tabIndex={active === i ? 0 : -1} aria-pressed={selected === i}
                aria-label={`${NODES[i].name}: ${fmt(totals[i])} users, ${pct(totals[i] / totals[VISITED])} of visitors. ${NODES[i].note}.`}
                style={{ transform: `translate(${node.x0}px, ${node.y0.toFixed(2)}px)` }}
                onPointerEnter={event => pointTo(event, { kind: "node", i })} onPointerLeave={event => release(event, { kind: "node", i })}
                onFocus={event => { setActive(i); if (event.currentTarget.matches(":focus-visible")) { anchor.current = i; setHover({ kind: "node", i }); draw(); } }}
                onBlur={() => { if (anchor.current === i) { anchor.current = null; setHover(current => sameTarget(current, { kind: "node", i }) ? null : current); } }}
                onClick={() => setSelected(current => current === i ? null : i)} onKeyDown={event => onNodeKey(event, i)}>
                <span className={styles.hitLabel} />
                <span ref={span => { el.current.hit[i] = span; }} className={styles.hitNode} style={{ height: `${hit.toFixed(2)}px`, top: `${((nh - hit) / 2).toFixed(2)}px` }} />
              </button>;
            })}
          </div>

          <AnimatePresence>
            {tip && hover && <motion.div key="tip" className={styles.tooltip} aria-hidden="true" style={{ x: tipX, y: tipY }}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: motionTokens.duration.instant }}>
              <Swap id={`${hover.kind}${hover.i}-${segment}`} className={styles.tipBody}>
                <span className={styles.tipTitle}>{tip.title}</span>
                <span className={styles.tipCount}>{fmt(tip.count)} users</span>
                {tip.rows.map(([label, value]) => <span key={label} className={styles.tipRow}><span>{label}</span><b>{value}</b></span>)}
              </Swap>
            </motion.div>}
          </AnimatePresence>
        </div>
      </div>

      <aside className={styles.panel} aria-label="Step breakdown">
        <div className={styles.panelHead}>
          <h3 className={styles.panelTitle}><Swap id={panel.key + panel.title}>{panel.title}</Swap></h3>
          <AnimatePresence initial={false}>
            {selected !== null && <motion.button key="clear" type="button" className={styles.clear} aria-label="Clear selected step"
              onClick={() => { const was = selected; setSelected(null); el.current.button[was]?.focus(); }}
              initial={{ opacity: 0, scale: .96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .96 }} transition={{ duration: motionTokens.duration.fast, ease: motionTokens.ease.standard }}>
              <X size={14} strokeWidth={1.75} aria-hidden="true" />Clear
            </motion.button>}
          </AnimatePresence>
        </div>
        <p className={styles.panelNote}><Swap id={panel.note}>{panel.note}</Swap></p>
        <p className={styles.bigNumber}><Rolling value={fmt(panel.count)} /></p>
        <p className={styles.caption}><Rolling value={pct(panel.share)} /><Swap id={panel.caption} className={styles.inlineSwap}>{panel.caption}</Swap></p>
        <div className={styles.groups}>
          {panel.groups.map((group, g) => <div key={g} className={styles.group}>
            <h4 className={styles.groupHeading}><Swap id={group.heading}>{group.heading}</Swap></h4>
            <ul className={styles.rows}>{group.rows.map((row, r) => <BreakdownRow key={r} row={row} empty={r === 0 ? group.empty : ""} />)}</ul>
          </div>)}
        </div>
      </aside>
    </div>

    <div className={styles.footer}>
      <button type="button" className={styles.tableToggle} aria-expanded={tableOpen} aria-controls={`${uid}-table`} onClick={() => setTableOpen(open => !open)}>
        Flow table
        <motion.span className={styles.chevron} animate={{ rotate: tableOpen ? 180 : 0 }} transition={reduce ? { duration: 0 } : motionTokens.spring.snappy}><ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" /></motion.span>
      </button>
    </div>
    <AnimatePresence initial={false}>
      {tableOpen && <motion.div key="table" id={`${uid}-table`} className={styles.tableWrap}
        initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={reduce ? { duration: 0 } : motionTokens.spring.smooth}>
        <table className={styles.table}>
          <caption>Flows for {segmentLabel.toLowerCase()}, August</caption>
          <thead><tr><th scope="col">From</th><th scope="col">To</th><th scope="col">Users</th><th scope="col">Share of step</th></tr></thead>
          <tbody>{LINKS.map((link, i) => <tr key={i}><td>{NODES[link.s].name}</td><td>{NODES[link.t].name}</td><td>{fmt(values[i])}</td><td>{pct(values[i] / totals[link.s])}</td></tr>)}</tbody>
        </table>
      </motion.div>}
    </AnimatePresence>
  </section>;
}

export default JourneyFlow;
