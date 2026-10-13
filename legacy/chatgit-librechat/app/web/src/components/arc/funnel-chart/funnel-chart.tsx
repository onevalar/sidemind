"use client";

import { useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent, type Ref } from "react";
import { animate, motion, useInView, useMotionValue, useReducedMotion, useSpring, useTransform } from "motion/react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./funnel-chart.module.css";

export interface FunnelSegment {
  /** Stable identity, such as "mobile". A segment keeps its layer across views, so switching morphs it. */
  key: string;
  /** Name in the tooltip and the data table. */
  label: string;
}

export interface FunnelStage {
  /** Stable identity, such as "checkout". */
  key: string;
  /** Stage name above the band, such as "Started checkout". */
  label: string;
  /** Count for a funnel without segments. */
  value?: number;
  /** Count per segment key when segments are passed. Missing counts are zero. */
  values?: Record<string, number | undefined>;
}

/** Use a funnel chart for an ordered sequence of steps where each step keeps part of the one before. */
export interface FunnelChartProps {
  stages: FunnelStage[];
  /** Parts of every stage, such as devices or plans. Leave it out for one total per stage. */
  segments?: FunnelSegment[];
  /** What is counted, such as "Checkout funnel". Names the chart for assistive technology. */
  label: string;
  /** Noun after counts in the tooltip and table, such as "sessions". */
  unit?: string;
  /** "total" draws one band, "split" stacks every segment with a gap, and a segment key isolates that segment and rescales to it. */
  view?: string;
  /** Tiny dots that stream through the funnel; the share that leaves at each step falls out of the band. */
  flow?: boolean;
  /** "auto" turns the funnel vertical when the chart is narrower than 420 pixels. */
  orientation?: "auto" | "horizontal" | "vertical";
  /** Thickness of the band area in pixels when horizontal. */
  height?: number;
  formatValue?: (value: number) => string;
  /** Controlled stage in focus. */
  activeIndex?: number | null;
  onActiveChange?: (index: number | null) => void;
  emptyLabel?: string;
  ref?: Ref<HTMLElement>;
  className?: string;
}

type Dot = { s: number; u: number; drop: number; speed: number; fall: number; fallSpeed: number; age: number };
type Geometry = { length: number; cross: number; vertical: boolean };

const { spring } = motionTokens;
const physical = ({ visualDuration, bounce }: { visualDuration: number; bounce: number }, restDelta = .0005) => { const root = (2 * Math.PI) / (visualDuration * 1.2); return { type: "spring" as const, stiffness: root * root, damping: 2 * (1 - bounce) * root, restDelta, restSpeed: restDelta * 2 }; };
const settle = physical({ visualDuration: .55, bounce: .08 });
const follow = { stiffness: 480, damping: 42, restDelta: .01 };
const PAD = 8, GAP = 2, STEP = 3;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const smooth = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const full = new Intl.NumberFormat("en-US");
const percent = (value: number) => `${value >= 10 || value === 0 ? Math.round(value) : value.toFixed(1)}%`;

const subscribeNothing = () => () => {};
function useReducedMotionSafe() {
  const hydrated = useSyncExternalStore(subscribeNothing, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

/** Thickness at a point along the funnel: flat across each stage, an eased taper between neighbours. */
function thicknessAt(values: number[], s: number, length: number) {
  const n = values.length;
  if (!n) return 0;
  const col = length / n, at = s / col - .5;
  if (at <= 0) return values[0];
  if (at >= n - 1) return values[n - 1];
  const k = Math.floor(at), t = at - k;
  const flat = .26;
  const eased = t <= flat ? 0 : t >= 1 - flat ? 1 : smooth((t - flat) / (1 - flat * 2));
  return values[k] + (values[k + 1] - values[k]) * eased;
}

/** A count that rolls to its new value. */
function Rolling({ value, format, reduced }: { value: number; format: (value: number) => string; reduced: boolean }) {
  const shown = useMotionValue(value);
  const text = useTransform(shown, current => format(current));
  useEffect(() => {
    if (reduced) { shown.jump(value); return; }
    const controls = animate(shown, value, spring.smooth);
    return () => controls.stop();
  }, [reduced, shown, value]);
  return <motion.span>{text}</motion.span>;
}

export function FunnelChart({ stages, segments, label, unit = "", view = "total", flow = true, orientation = "auto", height = 200, formatValue, activeIndex, onActiveChange, emptyLabel = "No data", ref, className }: FunnelChartProps) {
  const reduced = useReducedMotionSafe();
  const clipId = `${useId().replace(/:/g, "")}-focus`;
  const figure = useRef<HTMLElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const layerPaths = useRef(new Map<string, SVGPathElement>());
  const glowPaths = useRef(new Map<string, SVGPathElement>());
  useImperativeHandle(ref, () => figure.current as HTMLElement);
  const inView = useInView(figure, { once: true, amount: .3 });
  const visibleNow = useInView(figure, { amount: 0 });

  const parts = useMemo<FunnelSegment[]>(() => segments?.length ? segments : [{ key: "value", label }], [segments, label]);
  const n = stages.length, last = n - 1;
  const countOf = useCallback((stage: FunnelStage, key: string) => Math.max(0, (segments?.length ? stage.values?.[key] : stage.value) ?? 0), [segments]);
  const isolated = parts.some(part => part.key === view) ? view : null;
  const split = view === "split" && parts.length > 1;
  const shownParts = isolated ? parts.filter(part => part.key === isolated) : parts;
  const totals = stages.map(stage => shownParts.reduce((sum, part) => sum + countOf(stage, part.key), 0));
  const empty = n === 0 || totals[0] <= 0;

  // Target thickness per segment per stage, as a share of the band area. An isolated segment rescales to fill it.
  const signature = `${view}|${parts.map(part => part.key).join(",")}|${stages.map(stage => parts.map(part => countOf(stage, part.key)).join(",")).join(";")}`;
  const targets = useMemo(() => {
    const peak = Math.max(1e-9, ...stages.map(stage => shownParts.reduce((sum, part) => sum + countOf(stage, part.key), 0)));
    return new Map(parts.map(part => [part.key, stages.map(stage => shownParts.includes(part) ? countOf(stage, part.key) / peak : 0)]));
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps

  const [box, setBox] = useState({ width: 0 });
  const vertical = orientation === "vertical" || (orientation === "auto" && box.width > 0 && box.width < 420);
  const rowSize = 84;
  const geometry = useRef<Geometry>({ length: 0, cross: 0, vertical: false });
  const shapes = useRef(new Map<string, number[]>());
  const splitAmount = useRef(split ? 1 : 0);
  const grow = useMotionValue(0);

  // One writer for every band: morphs, the first reveal, and resizes all repaint through here.
  const paint = useCallback(() => {
    const { length, cross, vertical: down } = geometry.current;
    if (!length) return;
    const available = cross - PAD * 2, mid = cross / 2, g = grow.get();
    const layers = parts.map(part => shapes.current.get(part.key) ?? new Array<number>(n).fill(0));
    const weight = layers.map(layer => Math.min(1, layer.reduce((sum, value) => sum + value, 0) * 40));
    const count = Math.ceil(length / STEP) + 1;
    const edges: { top: number[]; bottom: number[] }[] = parts.map(() => ({ top: new Array(count), bottom: new Array(count) }));
    for (let j = 0; j < count; j++) {
      const s = Math.min(length, j * STEP);
      const widths = layers.map(layer => thicknessAt(layer, s, length) * available * g);
      const gaps = widths.slice(1).map((_, i) => GAP * splitAmount.current * Math.min(weight[i], weight[i + 1]));
      const whole = widths.reduce((sum, value) => sum + value, 0) + gaps.reduce((sum, value) => sum + value, 0);
      let at = mid - whole / 2;
      widths.forEach((width, i) => { edges[i].top[j] = at; at += width; edges[i].bottom[j] = at; at += gaps[i] ?? 0; });
    }
    const point = (s: number, c: number) => down ? `${c.toFixed(1)},${s.toFixed(1)}` : `${s.toFixed(1)},${c.toFixed(1)}`;
    parts.forEach((part, i) => {
      let d = "";
      for (let j = 0; j < count; j++) d += `${j ? "L" : "M"}${point(Math.min(length, j * STEP), edges[i].top[j])}`;
      for (let j = count - 1; j >= 0; j--) d += `L${point(Math.min(length, j * STEP), edges[i].bottom[j])}`;
      d += "Z";
      layerPaths.current.get(part.key)?.setAttribute("d", d);
      glowPaths.current.get(part.key)?.setAttribute("d", d);
    });
  }, [grow, n, parts]);

  useLayoutEffect(() => {
    const node = area.current;
    if (!node) return;
    const read = () => setBox({ width: node.clientWidth });
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const plotLength = vertical ? n * rowSize : box.width;
  const plotCross = vertical ? Math.min(220, Math.max(120, box.width * .44)) : height;
  useLayoutEffect(() => {
    geometry.current = { length: plotLength, cross: plotCross, vertical };
    paint();
  }, [paint, plotCross, plotLength, vertical]);

  // New data or a new view blends every layer from the shape on screen.
  useEffect(() => {
    const moves: { key: string; from: number[]; to: number[] }[] = [];
    for (const [key, to] of targets) {
      const from = shapes.current.get(key);
      if (!from || from.length !== to.length || reduced) { shapes.current.set(key, to); continue; }
      moves.push({ key, from, to });
    }
    const fromSplit = splitAmount.current, toSplit = split ? 1 : 0;
    if (reduced) splitAmount.current = toSplit;
    if (!moves.length && (reduced || fromSplit === toSplit)) { paint(); return; }
    const controls = animate(0, 1, { ...settle, onUpdate: t => {
      for (const move of moves) shapes.current.set(move.key, move.from.map((value, k) => value + (move.to[k] - value) * t));
      splitAmount.current = fromSplit + (toSplit - fromSplit) * clamp(t, 0, 1);
      paint();
    } });
    return () => controls.stop();
  }, [paint, reduced, split, targets]);

  // The first time the chart is seen, the band grows out of its centre line.
  useEffect(() => {
    if (empty) return;
    if (reduced) { grow.jump(1); paint(); return; }
    if (!inView || grow.get() >= 1) return;
    const controls = animate(grow, 1, { ...physical({ visualDuration: .8, bounce: 0 }), onUpdate: paint });
    return () => controls.stop();
  }, [empty, grow, inView, paint, reduced]);

  // Focus: the stage under the pointer or keyboard. A highlight column glides between stages.
  const [ownActive, setOwnActive] = useState<number | null>(null);
  const active = activeIndex !== undefined ? activeIndex : ownActive;
  const current = active !== null && active >= 0 && active < n ? active : null;
  const setActive = (index: number | null) => { if (activeIndex === undefined) setOwnActive(index); if (index !== current) onActiveChange?.(index); };
  const slide = useMotionValue(0);
  const slideSpring = useSpring(slide, follow);
  const column = n ? plotLength / n : 0;
  const lastActive = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (current === null) { lastActive.current = null; return; }
    slide.set(current * column);
    if (lastActive.current === null || reduced) slideSpring.jump(current * column);
    lastActive.current = current;
  });

  const header = useRef<HTMLDivElement>(null);
  const plotTop = () => vertical ? 0 : header.current?.offsetHeight ?? 0;
  // The tooltip rides beside the band at the active stage and never leaves the chart.
  const tipX = useMotionValue(0), tipY = useMotionValue(0);
  const tipSpringX = useSpring(tipX, follow), tipSpringY = useSpring(tipY, follow);
  const wasShown = useRef(false);
  useLayoutEffect(() => {
    const bubble = tip.current, host = area.current;
    if (current === null || !bubble || !host || !column) { wasShown.current = false; return; }
    const hostWidth = host.clientWidth, hostHeight = host.clientHeight;
    const tw = bubble.offsetWidth, th = bubble.offsetHeight;
    const center = (current + .5) * column;
    const thick = thicknessAt(totals.map(total => total / Math.max(1e-9, ...totals)), center, plotLength) * (plotCross - PAD * 2);
    let left: number, top: number;
    if (vertical) {
      // Beside the band and just past the step's own row, so its heading stays readable.
      left = plotCross / 2 + thick / 2 + 12;
      if (left + tw > hostWidth) left = hostWidth - tw;
      top = current < last ? (current + 1) * column - 6 : current * column - th + 6;
    } else {
      left = center + column / 2 - 6;
      if (left + tw > hostWidth) left = center - column / 2 - tw + 6;
      top = plotTop() + plotCross / 2 - th / 2;
    }
    tipX.set(clamp(left, 0, Math.max(0, hostWidth - tw))); tipY.set(clamp(top, 0, Math.max(0, hostHeight - th)));
    if (!wasShown.current || reduced) { tipSpringX.jump(tipX.get()); tipSpringY.jump(tipY.get()); }
    wasShown.current = true;
  });

  // Dots stream through the band on a canvas; the share that leaves at each step falls out and fades.
  const flowing = flow && !reduced && !empty && visibleNow && inView;
  const live = useRef({ totals, parts, shapes });
  useLayoutEffect(() => { live.current = { totals, parts, shapes }; });
  useEffect(() => {
    const node = canvas.current;
    if (!flowing || !node) { const context = node?.getContext("2d"); if (context && node) context.clearRect(0, 0, node.width, node.height); return; }
    const context = node.getContext("2d");
    if (!context) return;
    const dots: Dot[] = [];
    let frame = 0, previous = performance.now(), spawn = 0, ink = "", tick = 0;
    const run = (now: number) => {
      frame = requestAnimationFrame(run);
      const dt = Math.min(.05, (now - previous) / 1000);
      previous = now;
      const { length, cross, vertical: down } = geometry.current;
      if (!length || document.hidden) return;
      const ratio = window.devicePixelRatio || 1;
      const w = Math.round((down ? cross : length) * ratio), h = Math.round((down ? length : cross) * ratio);
      if (node.width !== w || node.height !== h) { node.width = w; node.height = h; }
      if (tick++ % 30 === 0) ink = getComputedStyle(node).color;
      const available = cross - PAD * 2, mid = cross / 2;
      const { totals: counts, parts: layers, shapes: store } = live.current;
      const whole = (s: number) => layers.reduce((sum, part) => sum + thicknessAt(store.current.get(part.key) ?? [], s, length), 0) * available * grow.get();
      // Arrivals scale with the first stage; each dot decides up front at which step it leaves.
      spawn += dt * 26 * clamp(whole(0) / Math.max(1, available), .15, 1);
      while (spawn >= 1) {
        spawn -= 1;
        let drop = 0;
        while (drop < counts.length - 1 && Math.random() < counts[drop + 1] / Math.max(1e-9, counts[drop])) drop++;
        dots.push({ s: -4, u: .1 + Math.random() * .8, drop, speed: length / (5.2 + Math.random() * 1.6), fall: 0, fallSpeed: 0, age: 0 });
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, w, h);
      context.fillStyle = ink;
      const col = length / counts.length;
      for (let i = dots.length - 1; i >= 0; i--) {
        const dot = dots[i];
        dot.age += dt;
        const leaveAt = dot.drop < counts.length - 1 ? (dot.drop + 1) * col : Infinity;
        if (dot.s >= leaveAt) { dot.fallSpeed += 260 * dt; dot.fall += dot.fallSpeed * dt; dot.speed *= 1 - 1.8 * dt; }
        dot.s += dot.speed * dt;
        const thick = whole(clamp(dot.s, 0, length));
        const c = mid + (dot.u - .5) * thick + dot.fall;
        const fade = dot.fall > 0 ? 1 - clamp(dot.fall / 46, 0, 1) : dot.s > length - 16 ? clamp((length - dot.s) / 16, 0, 1) : clamp(dot.age * 4, 0, 1);
        if (fade <= 0 || dot.s > length + 4) { dots.splice(i, 1); continue; }
        context.globalAlpha = fade * (dot.fall > 0 ? .45 : .7);
        const x = down ? c : dot.s, y = down ? dot.s : c;
        context.beginPath();
        context.arc(x, y, 1.6, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;
    };
    frame = requestAnimationFrame(run);
    return () => cancelAnimationFrame(frame);
  }, [flowing, grow]);

  const stageAt = (clientX: number, clientY: number) => {
    const rect = area.current?.getBoundingClientRect();
    if (!rect || empty || !column) return null;
    const along = vertical ? clientY - rect.top : clientX - rect.left;
    return clamp(Math.floor(along / column), 0, last);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => { if (event.pointerType === "mouse" || event.buttons) setActive(stageAt(event.clientX, event.clientY)); };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => { if (event.pointerType !== "mouse") event.currentTarget.setPointerCapture?.(event.pointerId); setActive(stageAt(event.clientX, event.clientY)); };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (empty) return;
    if (event.key === "Escape" && current !== null) { event.preventDefault(); setActive(null); return; }
    const from = current ?? -1;
    const moves: Record<string, number> = { ArrowRight: from + 1, ArrowDown: from + 1, ArrowLeft: from < 0 ? 0 : from - 1, ArrowUp: from < 0 ? 0 : from - 1, Home: 0, End: last };
    if (!(event.key in moves)) return;
    event.preventDefault();
    setActive(clamp(moves[event.key], 0, last));
  };

  const format = (value: number) => formatValue ? formatValue(value) : compact.format(Math.round(value));
  const withUnit = (value: number) => `${formatValue ? formatValue(value) : full.format(Math.round(value))}${unit ? ` ${unit}` : ""}`;
  const rateFrom = (k: number) => k === 0 ? 100 : totals[k - 1] > 0 ? totals[k] / totals[k - 1] * 100 : 0;
  const overall = (k: number) => totals[0] > 0 ? totals[k] / totals[0] * 100 : 0;
  const stage = current !== null ? stages[current] : null;
  const announce = stage && current !== null ? `${stage.label}, ${withUnit(totals[current])}, ${percent(rateFrom(current))} of the previous step, ${percent(overall(current))} of the first` : "";
  const viewName = isolated ? parts.find(part => part.key === isolated)?.label : split ? "by segment" : "all";
  const summary = empty ? `${label}. ${emptyLabel}.` : `${label}, ${viewName}. ${stages.map((item, k) => `${item.label} ${withUnit(totals[k])}`).join(", ")}. ${percent(overall(last))} reach the last step.`;
  const colorIndex = (key: string) => parts.findIndex(part => part.key === key);
  const along = vertical ? { y: reduced ? slide : slideSpring } : { x: reduced ? slide : slideSpring };
  const svgWidth = vertical ? plotCross : plotLength, svgHeight = vertical ? plotLength : plotCross;
  const highlight = vertical ? { x: 0, y: 0, width: plotCross, height: column } : { x: 0, y: 0, width: column, height: plotCross };

  return <figure ref={figure} className={[styles.figure, className].filter(Boolean).join(" ")} aria-label={label} data-vertical={vertical || undefined}>
    <div ref={area} className={styles.area} data-active={current !== null || undefined} data-view={isolated ? "one" : split ? "split" : "total"}
      role="group" tabIndex={empty ? -1 : 0} aria-roledescription="funnel chart" aria-label={`${label}. Use arrow keys to move between steps.`}
      onPointerMove={onPointerMove} onPointerDown={onPointerDown} onPointerUp={event => { if (event.pointerType !== "mouse") setActive(null); }} onPointerCancel={() => setActive(null)} onPointerLeave={event => { if (event.pointerType === "mouse") setActive(null); }}
      onKeyDown={onKeyDown} onBlur={() => setActive(null)} onFocus={event => { if (event.currentTarget.matches(":focus-visible") && !empty && current === null) setActive(0); }}
      style={vertical ? { height: plotLength } : undefined}>
      <motion.div className={styles.column} style={{ ...along, ...(vertical ? { height: column } : { width: column }) }} aria-hidden="true" />
      {!vertical && <div ref={header} className={styles.header} style={{ gridTemplateColumns: `repeat(${Math.max(1, n)}, minmax(0, 1fr))` }} aria-hidden="true">
        {stages.map((item, k) => <div key={item.key} className={styles.stage} data-on={current === k || undefined}>
          <span className={styles.stageLabel}>{item.label}</span>
          <span className={styles.stageValue}><Rolling value={totals[k] ?? 0} format={format} reduced={reduced} /></span>
          <span className={styles.stageRate}>{k === 0 ? "Start" : <Rolling value={overall(k)} format={value => `${percent(value)} of start`} reduced={reduced} />}</span>
        </div>)}
      </div>}
      <div className={styles.plotRow}>
        <div className={styles.plot} style={{ width: svgWidth, height: svgHeight }}>
          <svg className={styles.svg} width={svgWidth} height={svgHeight} aria-hidden="true" focusable="false">
            <defs><clipPath id={clipId}><motion.rect {...highlight} style={along} /></clipPath></defs>
            {parts.map(part => <path key={part.key} ref={node => { if (node) layerPaths.current.set(part.key, node); else layerPaths.current.delete(part.key); }} className={styles.layer} data-index={colorIndex(part.key)} data-shown={!isolated || isolated === part.key || undefined} />)}
            <g className={styles.glow} clipPath={`url(#${clipId})`}>
              {parts.map(part => <path key={part.key} ref={node => { if (node) glowPaths.current.set(part.key, node); else glowPaths.current.delete(part.key); }} className={styles.glowLayer} data-index={colorIndex(part.key)} />)}
            </g>
          </svg>
          <canvas ref={canvas} className={styles.canvas} style={{ width: svgWidth, height: svgHeight }} aria-hidden="true" />
        </div>
        {vertical && <div className={styles.side} aria-hidden="true">
          {stages.map((item, k) => <div key={item.key} className={styles.row} data-on={current === k || undefined} style={{ top: k * rowSize, height: rowSize }}>
            <span className={styles.stageLabel}>{item.label}</span>
            <span className={styles.stageValue}><Rolling value={totals[k] ?? 0} format={format} reduced={reduced} /></span>
          </div>)}
        </div>}
      </div>
      <div className={styles.drops} aria-hidden="true" style={vertical ? { left: plotCross + 20 } : undefined}>
        {stages.slice(1).map((item, k) => {
          const share = (k + 1) / n * 100;
          return <span key={item.key} className={styles.drop} style={vertical ? { top: `${share}%` } : { left: `${share}%` }}>
            <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M4 1v6M1.5 4.5 4 7l2.5-2.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <Rolling value={100 - rateFrom(k + 1)} format={percent} reduced={reduced} />
          </span>;
        })}
      </div>
      <motion.div ref={tip} className={styles.tooltip} style={{ x: reduced ? tipX : tipSpringX, y: reduced ? tipY : tipSpringY }} aria-hidden="true">
        <p className={styles.tipTitle}>{stage?.label ?? ""}</p>
        {(split ? parts : [{ key: "__total", label: isolated ? parts.find(part => part.key === isolated)!.label : "Total" }]).map(part => <p key={part.key} className={styles.tipRow} data-index={split ? colorIndex(part.key) : undefined}>
          {split && <span className={styles.tipKey} />}
          <span className={styles.tipName}>{part.label}</span>
          <span className={styles.tipValue}>{stage && current !== null ? full.format(part.key === "__total" ? totals[current] : countOf(stage, part.key)) : ""}</span>
        </p>)}
        <p className={styles.tipMeta}>{current !== null && current > 0 ? `${percent(rateFrom(current))} kept from ${stages[current - 1].label.toLowerCase()}` : current === 0 ? `Entry step${unit ? `, ${unit}` : ""}` : ""}</p>
      </motion.div>
      {empty && <p className={styles.message}>{emptyLabel}</p>}
    </div>
    <p className={styles.srOnly} aria-live="polite" aria-atomic="true">{announce}</p>
    <p className={styles.srOnly}>{summary}</p>
    {!empty && <div className={styles.srOnly}><table>
      <caption>{label}</caption>
      <thead><tr><th scope="col">Step</th>{segments?.length ? parts.map(part => <th key={part.key} scope="col">{part.label}</th>) : null}<th scope="col">Shown total</th><th scope="col">Kept from previous</th><th scope="col">Of first step</th></tr></thead>
      <tbody>{stages.map((item, k) => <tr key={item.key}><th scope="row">{item.label}</th>{segments?.length ? parts.map(part => <td key={part.key}>{withUnit(countOf(item, part.key))}</td>) : null}<td>{withUnit(totals[k])}</td><td>{percent(rateFrom(k))}</td><td>{percent(overall(k))}</td></tr>)}</tbody>
    </table></div>}
  </figure>;
}

export default FunnelChart;
