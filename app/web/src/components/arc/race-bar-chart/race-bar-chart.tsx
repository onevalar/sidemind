"use client";

import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type PointerEvent, type Ref } from "react";
import { AnimatePresence, motion, useInView, useMotionValue, useReducedMotion, useSpring, type Variants } from "motion/react";
import { Pause, Play, RotateCcw } from "lucide-react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./race-bar-chart.module.css";

export interface RaceBarItem {
  /** Stable identity. A bar keeps its place in the race across frames. */
  id: string;
  label: string;
  /** Group id, such as a product category. Bars in a group share a hue and the legend names it. */
  group?: string;
}

export interface RaceBarGroup {
  id: string;
  label: string;
}

export interface RaceBarFrame {
  /** Name of the period, such as "March 2026". Printed large in the chart. */
  period: string;
  /** Value per item id. Missing ids count as zero. */
  values: Record<string, number>;
}

/** Use a race bar chart to show how a ranking changes over time, such as top products by revenue month by month. */
export interface RaceBarChartProps {
  items: RaceBarItem[];
  /** Names and order of the groups. The first four take the series hues; without groups every bar takes the first. */
  groups?: RaceBarGroup[];
  /** One frame per period, in order. */
  frames: RaceBarFrame[];
  /** What is ranked, such as "Revenue by product". Names the chart for assistive technology. */
  label: string;
  formatValue?: (value: number) => string;
  /** Formats the value axis. Defaults to a compact number, such as 1.2M. */
  formatTick?: (value: number) => string;
  /** Bars shown at once. Items below the cut slide out of view. */
  bars?: number;
  /** Controlled frame index. A new value glides the race there. */
  frame?: number;
  defaultFrame?: number;
  onFrameChange?: (index: number) => void;
  /** Controlled playback. */
  playing?: boolean;
  defaultPlaying?: boolean;
  onPlayingChange?: (playing: boolean) => void;
  /** Starts playing the first time the chart scrolls into view. Ignored with reduced motion. */
  autoPlay?: boolean;
  /** Milliseconds per frame while playing. */
  frameDuration?: number;
  /** Rewinds to the first frame after the last and keeps playing. */
  loop?: boolean;
  /** Item id whose name and value are emphasized, such as your own product. */
  highlight?: string;
  ref?: Ref<HTMLElement>;
  className?: string;
}

const { spring, ease, blur, duration } = motionTokens;
const physical = ({ visualDuration, bounce }: { visualDuration: number; bounce: number }) => { const root = (2 * Math.PI) / (visualDuration * 1.2); return { k: root * root, c: 2 * (1 - bounce) * root }; };
/** Rank changes swap places with a little life; the clock itself never overshoots. */
const RANK = physical({ visualDuration: .5, bounce: .14 });
const CLOCK = physical({ visualDuration: .42, bounce: 0 });
const glide = physical(spring.snappy);
const follow = { stiffness: glide.k, damping: glide.c, restDelta: .01 };
/** Groups take the four series hues in order; a fifth group and beyond stay neutral rather than reuse a hue. */
const hueOf = (index: number) => index < 0 ? "var(--series-1)" : index < 4 ? `var(--series-${index + 1})` : "color-mix(in oklab, var(--foreground) 45%, var(--surface))";
const ROW = 36, BAR = 24, AXIS = 26, GAP = 12, VALUE_ROOM = 64, TIP = 12;
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1, signDisplay: "exceptZero" });
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
function niceStep(span: number, count = 4) {
  const raw = span / count || 1, power = Math.pow(10, Math.floor(Math.log10(raw))), unit = raw / power;
  return (unit >= 5 ? 5 : unit >= 2 ? 2 : 1) * power;
}

const rise: Variants = {
  hidden: (direction: number) => ({ opacity: 0, y: `${.4 * direction}em`, filter: `blur(${blur.soft}px)` }),
  shown: { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: duration.standard, ease: [...ease.enter] } },
  gone: (direction: number) => ({ opacity: 0, y: `${-.4 * direction}em`, filter: `blur(${blur.subtle}px)`, transition: { duration: duration.exit, ease: [...ease.standard] } }),
};
const fade: Variants = { hidden: { opacity: 0 }, shown: { opacity: 1, transition: { duration: duration.fast } }, gone: { opacity: 0, transition: { duration: duration.instant } } };

const subscribeNothing = () => () => {};
function useReducedMotionSafe() {
  const hydrated = useSyncExternalStore(subscribeNothing, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

type Bar = { y: number; vy: number; o: number; rank: number; value: number };

export function RaceBarChart({ items, groups, frames, label, formatValue = value => compact.format(value), formatTick = value => compact.format(value), bars = 8, frame, defaultFrame = 0, onFrameChange, playing, defaultPlaying = false, onPlayingChange, autoPlay = true, frameDuration = 1400, loop = false, highlight, ref, className }: RaceBarChartProps) {
  const reduced = useReducedMotionSafe();
  const figure = useRef<HTMLElement>(null);
  const plot = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const totalRef = useRef<HTMLSpanElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  const fill = useRef<HTMLSpanElement>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const labels = useRef(new Map<string, HTMLSpanElement>());
  useImperativeHandle(ref, () => figure.current as HTMLElement);
  const inView = useInView(figure, { amount: .35 });

  const count = frames.length, last = Math.max(0, count - 1);
  const shown = Math.max(1, Math.min(bars, items.length));
  const matrix = useMemo(() => frames.map(entry => items.map(item => Math.max(0, entry.values[item.id] ?? 0))), [frames, items]);
  const start = clamp(Math.round(frame ?? defaultFrame), 0, last);
  const [index, setIndex] = useState(start);
  const [ownPlaying, setOwnPlaying] = useState(defaultPlaying);
  const isPlaying = (playing ?? ownPlaying) && count > 1;
  const [active, setActive] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const [announce, setAnnounce] = useState("");
  const [atEnd, setAtEnd] = useState(start >= last);
  /** Narrow charts print the name inside the bar, so the bars keep their length. */
  const inside = width > 0 && width < 400;
  const labelWidth = inside ? 0 : width < 520 ? 104 : 128;
  const groupIndex = new Map((groups ?? []).map((group, index) => [group.id, index]));

  const state = useRef({ time: start, shown: start, v: 0, hold: 0, step: 0, raf: 0, last: 0, index: start, bars: [] as Bar[], ticks: new Map<number, HTMLDivElement>(), scrubbing: false, tipOn: false, atEnd: start >= last });
  const tipX = useMotionValue(0), tipY = useMotionValue(0);
  const tipSpringX = useSpring(tipX, follow), tipSpringY = useSpring(tipY, follow);

  const setPlay = (next: boolean) => { if (playing === undefined) setOwnPlaying(next); onPlayingChange?.(next); };
  const running = isPlaying && inView;
  const live = useRef({ matrix, items, shown, isPlaying: running, reduced, frameDuration, loop, width, labelWidth, formatValue, formatTick, active, count, setPlay, onFrameChange });
  useLayoutEffect(() => { live.current = { matrix, items, shown, isPlaying: running, reduced, frameDuration, loop, width, labelWidth, formatValue, formatTick, active, count, setPlay, onFrameChange }; });

  const wake = useRef<() => void>(() => {});
  useEffect(() => {
    const s = state.current;
    const paint = (dt: number) => {
      const L = live.current, n = L.count, lastIndex = Math.max(0, n - 1);
      if (!n) return false;
      if (L.isPlaying && !s.scrubbing) {
        if (s.time >= lastIndex - 1e-6) {
          s.hold += dt * 1000;
          if (s.hold >= L.frameDuration * .9) { s.hold = 0; if (L.loop) s.time = 0; else L.setPlay(false); }
        } else if (L.reduced) {
          s.step += dt * 1000;
          if (s.step >= L.frameDuration) { s.step = 0; s.time = Math.min(lastIndex, Math.floor(s.time + 1e-6) + 1); }
        } else s.time = Math.min(lastIndex, s.time + (dt * 1000) / L.frameDuration);
      }
      // The clock the chart draws follows the requested time on a spring: steps glide, a rewind sweeps back through every month.
      if (L.reduced) { s.shown = s.time; s.v = 0; }
      else { const a = -CLOCK.k * (s.shown - s.time) - CLOCK.c * s.v; s.v += a * dt; s.shown += s.v * dt; if (Math.abs(s.shown - s.time) < 1e-4 && Math.abs(s.v) < 1e-3) { s.shown = s.time; s.v = 0; } }
      const t = clamp(s.shown, 0, lastIndex), i0 = Math.floor(t), i1 = Math.min(lastIndex, i0 + 1), f = t - i0;
      const values = L.items.map((_, k) => { const a = L.matrix[i0]?.[k] ?? 0, b = L.matrix[i1]?.[k] ?? 0; return a + (b - a) * f; });
      const order = values.map((_, k) => k).sort((a, b) => values[b] - values[a] || a - b);
      const top = values[order[0]] || 1;
      const x0 = L.labelWidth ? L.labelWidth + GAP : 0, barRoom = Math.max(40, L.width - x0 - VALUE_ROOM);
      let moving = L.isPlaying || s.shown !== s.time;
      let total = 0;
      order.forEach((k, rank) => {
        const item = L.items[k];
        let bar = s.bars[k];
        if (!bar) { bar = s.bars[k] = { y: Math.min(rank, L.shown) * ROW, vy: 0, o: rank < L.shown ? 1 : 0, rank, value: 0 }; }
        const targetY = Math.min(rank, L.shown) * ROW, targetO = rank < L.shown ? 1 : 0;
        if (L.reduced) { bar.y = targetY; bar.vy = 0; bar.o = targetO; }
        else {
          const steps = Math.max(1, Math.ceil(dt / (1 / 120))), h = dt / steps;
          for (let step = 0; step < steps; step++) { const a = -RANK.k * (bar.y - targetY) - RANK.c * bar.vy; bar.vy += a * h; bar.y += bar.vy * h; }
          if (Math.abs(bar.y - targetY) < .05 && Math.abs(bar.vy) < .05) { bar.y = targetY; bar.vy = 0; } else moving = true;
          bar.o += (targetO - bar.o) * Math.min(1, dt * 9);
          if (Math.abs(bar.o - targetO) < .01) bar.o = targetO; else moving = true;
        }
        bar.rank = rank; bar.value = values[k]; total += values[k];
        const row = rows.current.get(item.id);
        if (!row) return;
        const w = Math.max(2, (values[k] / top) * barRoom);
        row.style.transform = `translate3d(0, ${bar.y.toFixed(2)}px, 0)`;
        row.style.opacity = bar.o.toFixed(3);
        row.style.visibility = bar.o < .01 ? "hidden" : "visible";
        row.style.zIndex = String(L.items.length - rank);
        const barEl = row.children[1] as HTMLElement, valueEl = row.children[2] as HTMLElement;
        barEl.style.width = `${w.toFixed(2)}px`;
        // Inside labels push the value past the name when the bar is shorter than it.
        const room = L.labelWidth ? w : Math.max(w, (labels.current.get(item.id)?.offsetWidth ?? 0) + 16);
        valueEl.style.transform = `translate3d(${(x0 + room + 8).toFixed(2)}px, 0, 0)`;
        const text = L.formatValue(values[k]);
        if (valueEl.textContent !== text) valueEl.textContent = text;
      });
      if (totalRef.current) { const text = `Total ${L.formatValue(total)}`; if (totalRef.current.textContent !== text) totalRef.current.textContent = text; }
      // Axis ticks glide with the scale; new ones fade in, retired ones fade out.
      const box = grid.current;
      if (box) {
        const step = niceStep(top, Math.max(1, Math.floor(barRoom / 80))), keep = new Set<number>();
        for (let value = step; value <= top * 1.001; value += step) keep.add(Math.round(value * 1e6) / 1e6);
        for (const value of keep) {
          let tick = s.ticks.get(value);
          if (!tick) { tick = document.createElement("div"); tick.className = styles.tick; const text = document.createElement("span"); text.className = styles.tickLabel; text.textContent = L.formatTick(value); tick.appendChild(text); box.appendChild(tick); s.ticks.set(value, tick); requestAnimationFrame(() => tick?.setAttribute("data-on", "")); }
          tick.style.transform = `translate3d(${(x0 + (value / top) * barRoom).toFixed(2)}px, 0, 0)`;
        }
        for (const [value, tick] of s.ticks) if (!keep.has(value)) { s.ticks.delete(value); tick.removeAttribute("data-on"); tick.setAttribute("data-leaving", ""); window.setTimeout(() => tick.remove(), 320); }
      }
      const progress = lastIndex ? t / lastIndex : 0;
      if (thumb.current) thumb.current.style.left = `${(progress * 100).toFixed(3)}%`;
      if (fill.current) fill.current.style.transform = `scaleX(${progress.toFixed(4)})`;
      // The tooltip rides on the end of the bar it reads, and stays inside the chart.
      const activeIndex = L.active ? L.items.findIndex(item => item.id === L.active) : -1;
      const bubble = tip.current;
      if (bubble && activeIndex >= 0 && s.bars[activeIndex]) {
        const bar = s.bars[activeIndex], w = Math.max(2, (bar.value / top) * barRoom);
        const tw = bubble.offsetWidth, th = bubble.offsetHeight, ax = x0 + w, ay = AXIS + bar.y + ROW / 2;
        let left = ax + TIP;
        if (left + tw > L.width) left = ax - tw - TIP;
        let top2 = ay - th - TIP;
        if (top2 < 0) top2 = ay + ROW / 2 + 4;
        tipX.set(clamp(left, 0, Math.max(0, L.width - tw))); tipY.set(Math.max(0, top2));
        if (!s.tipOn || L.reduced) { tipSpringX.jump(tipX.get()); tipSpringY.jump(tipY.get()); }
        s.tipOn = true;
      } else s.tipOn = false;
      const rounded = clamp(Math.round(t), 0, lastIndex);
      if (rounded !== s.index) { s.index = rounded; setIndex(rounded); L.onFrameChange?.(rounded); }
      const end = s.time >= lastIndex - 1e-6;
      if (end !== s.atEnd) { s.atEnd = end; setAtEnd(end); }
      return moving;
    };
    const loopFrame = (now: number) => {
      const dt = s.last ? Math.min(.05, (now - s.last) / 1000) : 1 / 60;
      s.last = now;
      if (paint(dt) || live.current.isPlaying || s.scrubbing) s.raf = requestAnimationFrame(loopFrame);
      else { s.raf = 0; s.last = 0; }
    };
    wake.current = () => { if (!s.raf) { s.last = 0; s.raf = requestAnimationFrame(loopFrame); } };
    const ticks = s.ticks;
    wake.current();
    return () => { cancelAnimationFrame(s.raf); s.raf = 0; for (const tick of ticks.values()) tick.remove(); ticks.clear(); };
  }, [tipSpringX, tipSpringY, tipX, tipY]);

  // Any change the loop needs to draw wakes it: playback, size, data, or a new reading.
  useEffect(() => { wake.current(); }, [running, width, matrix, active, labelWidth, shown, reduced]);

  // A controlled frame glides the race there.
  useEffect(() => {
    if (frame === undefined) return;
    const s = state.current, target = clamp(Math.round(frame), 0, last);
    if (Math.round(s.time) !== target || s.time % 1) { s.time = target; wake.current(); }
  }, [frame, last]);

  useLayoutEffect(() => {
    const node = plot.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node);
    setWidth(node.clientWidth);
    return () => observer.disconnect();
  }, []);

  const started = useRef(false);
  useEffect(() => {
    if (!inView || started.current || reduced || !autoPlay || playing !== undefined || count < 2) return;
    started.current = true;
    const s = state.current;
    if (s.time >= last) s.time = 0;
    setPlay(true);
  });

  const goTo = (target: number, speak = true) => {
    const s = state.current, next = clamp(target, 0, last);
    s.time = next; s.hold = 0;
    if (isPlaying) setPlay(false);
    wake.current();
    if (speak) {
      const values = matrix[next] ?? [];
      const leader = values.map((_, k) => k).sort((a, b) => values[b] - values[a])[0];
      setAnnounce(leader === undefined ? frames[next]?.period ?? "" : `${frames[next].period}. ${items[leader].label} leads with ${formatValue(values[leader])}.`);
    }
  };
  const toggle = () => {
    const s = state.current;
    if (isPlaying) { setPlay(false); return; }
    if (s.time >= last - 1e-6) { s.time = 0; s.hold = 0; }
    setPlay(true);
    wake.current();
  };

  const onPlotKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const s = state.current;
    const ranked = s.bars.length ? items.map((item, k) => ({ id: item.id, rank: s.bars[k]?.rank ?? k })).sort((a, b) => a.rank - b.rank).slice(0, shown) : items.slice(0, shown).map((item, rank) => ({ id: item.id, rank }));
    const at = active ? ranked.findIndex(entry => entry.id === active) : -1;
    const pick = (next: number) => { event.preventDefault(); const entry = ranked[clamp(next, 0, ranked.length - 1)]; if (entry) setActive(entry.id); };
    if (event.key === "ArrowDown") pick(at + 1);
    else if (event.key === "ArrowUp") pick(at < 0 ? 0 : at - 1);
    else if (event.key === "ArrowRight") { event.preventDefault(); goTo(Math.round(s.time) + 1); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); goTo(Math.round(s.time) - 1); }
    else if (event.key === "Home") { event.preventDefault(); goTo(0); }
    else if (event.key === "End") { event.preventDefault(); goTo(last); }
    else if (event.key === " " || event.key === "Enter") { event.preventDefault(); toggle(); }
    else if (event.key === "Escape" && active) { event.preventDefault(); setActive(null); }
  };
  const onPlotMove = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse") return;
    const rect = event.currentTarget.getBoundingClientRect(), y = event.clientY - rect.top - AXIS;
    const s = state.current;
    let best: string | null = null;
    s.bars.forEach((bar, k) => { if (bar.o > .5 && y >= bar.y && y < bar.y + ROW && items[k]) best = items[k].id; });
    setActive(best);
  };
  const onPlotTap = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse") return;
    const rect = event.currentTarget.getBoundingClientRect(), y = event.clientY - rect.top - AXIS;
    const s = state.current;
    let best: string | null = null;
    s.bars.forEach((bar, k) => { if (bar.o > .5 && y >= bar.y && y < bar.y + ROW && items[k]) best = items[k].id; });
    setActive(current => current === best ? null : best);
  };

  // Scrubbing the timeline moves through time continuously; letting go settles on the nearest period.
  const scrubAt = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    state.current.time = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1) * last;
    wake.current();
  };
  const onScrubDown = (event: PointerEvent<HTMLDivElement>) => {
    if (count < 2) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    state.current.scrubbing = true; state.current.hold = 0;
    if (isPlaying) setPlay(false);
    scrubAt(event);
  };
  const onScrubMove = (event: PointerEvent<HTMLDivElement>) => { if (state.current.scrubbing) scrubAt(event); };
  const onScrubUp = () => {
    const s = state.current;
    if (!s.scrubbing) return;
    s.scrubbing = false;
    goTo(Math.round(s.time));
  };
  const onScrubKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = Math.round(state.current.time);
    const map: Record<string, number> = { ArrowRight: at + 1, ArrowUp: at + 1, ArrowLeft: at - 1, ArrowDown: at - 1, Home: 0, End: last, PageUp: at + 3, PageDown: at - 3 };
    if (event.key in map) { event.preventDefault(); goTo(map[event.key]); }
    else if (event.key === " ") { event.preventDefault(); toggle(); }
  };

  // The tooltip keeps the last bar it read while it fades out instead of collapsing to an empty box.
  const [held, setHeld] = useState(active);
  if (active !== null && active !== held) setHeld(active);
  const activeIndex = held ? items.findIndex(item => item.id === held) : -1;
  const reading = activeIndex >= 0 ? (() => {
    const values = matrix[index] ?? [], value = values[activeIndex] ?? 0;
    const rank = values.filter((other, k) => other > value || (other === value && k < activeIndex)).length + 1;
    const before = index > 0 ? matrix[index - 1]?.[activeIndex] ?? 0 : null;
    const total = values.reduce((sum, other) => sum + other, 0);
    return { item: items[activeIndex], value, rank, change: before ? (value - before) / before : null, share: total ? value / total : 0 };
  })() : null;
  const empty = !count || !items.length;
  const period = frames[index]?.period ?? "";

  return <figure ref={figure} className={[styles.figure, className].filter(Boolean).join(" ")} aria-label={label} data-empty={empty || undefined}>
    <div className={styles.head} aria-hidden="true">
      <span className={styles.periodText}><AnimatePresence mode="popLayout" initial={false} custom={1}>
        <motion.span key={period} className={styles.periodWord} custom={1} variants={reduced ? fade : rise} initial="hidden" animate="shown" exit="gone">{period}</motion.span>
      </AnimatePresence></span>
      <span ref={totalRef} className={styles.total} />
    </div>
    <div ref={plot} className={styles.plot} style={{ height: AXIS + shown * ROW + 4 }} data-active={active !== null && activeIndex >= 0 ? true : undefined} role="group" tabIndex={empty ? -1 : 0}
      aria-roledescription="bar chart race" aria-label={`${label}, ${period}. Space plays or pauses, left and right arrows change the period, up and down arrows read the bars.`}
      onKeyDown={onPlotKey} onPointerMove={onPlotMove} onPointerDown={onPlotTap} onPointerLeave={event => { if (event.pointerType === "mouse") setActive(null); }} onBlur={() => setActive(null)}>
      <div ref={grid} className={styles.grid} aria-hidden="true" style={{ height: AXIS + shown * ROW }} />
      <div className={styles.baseline} style={{ left: inside ? 0 : labelWidth + GAP, height: shown * ROW, top: AXIS }} aria-hidden="true" />
      <div className={styles.rows} style={{ top: AXIS }} aria-hidden="true">
        {items.map(item => <div key={item.id} ref={element => { if (element) rows.current.set(item.id, element); else rows.current.delete(item.id); }} className={styles.row} style={{ height: ROW, "--bar": hueOf(groupIndex.get(item.group ?? "") ?? -1) } as CSSProperties}
          data-highlight={item.id === highlight || undefined} data-active={item.id === active || undefined} data-dim={active !== null && item.id !== active || undefined}>
          <span ref={element => { if (element) labels.current.set(item.id, element); else labels.current.delete(item.id); }} className={styles.rowLabel} style={inside ? { left: 8, maxWidth: "calc(100% - 96px)" } : { width: labelWidth }} data-inside={inside || undefined}>{item.label}</span>
          <span className={styles.bar} style={{ left: inside ? 0 : labelWidth + GAP, height: BAR, top: (ROW - BAR) / 2 }} />
          <span className={styles.rowValue} />
        </div>)}
      </div>
      {empty && <p className={styles.message}>No data yet</p>}
      <motion.div ref={tip} className={styles.tooltip} style={{ x: reduced ? tipX : tipSpringX, y: reduced ? tipY : tipSpringY }} aria-hidden="true">
        {reading && <>
          <p className={styles.tipTitle}>{reading.item.label}</p>
          <p className={styles.tipValue}>{formatValue(reading.value)}</p>
          <p className={styles.tipNote}>Rank {reading.rank} of {items.length}, {percent.format(reading.share).replace("+", "")} of total</p>
          {reading.change !== null && <p className={styles.tipNote}>{percent.format(reading.change)} vs {frames[index - 1]?.period}</p>}
        </>}
      </motion.div>
    </div>
    {groups && groups.length > 1 && <ul className={styles.legend} aria-label="Groups">
      {groups.map((group, index) => <li key={group.id} className={styles.legendItem} style={{ "--bar": hueOf(index) } as CSSProperties}><span className={styles.swatch} aria-hidden="true" />{group.label}</li>)}
    </ul>}
    <div className={styles.controls}>
      <button type="button" className={styles.play} onClick={toggle} disabled={count < 2} aria-label={isPlaying ? "Pause" : atEnd ? "Replay from the start" : "Play"}>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={isPlaying ? "pause" : atEnd ? "replay" : "play"} className={styles.playIcon} initial={{ opacity: 0, scale: reduced ? 1 : .6, filter: reduced ? "none" : `blur(${blur.subtle}px)` }} animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }} exit={{ opacity: 0, scale: reduced ? 1 : .6 }} transition={spring.snappy}>
            {isPlaying ? <Pause size={16} strokeWidth={1.75} fill="currentColor" /> : atEnd ? <RotateCcw size={16} strokeWidth={1.75} /> : <Play size={16} strokeWidth={1.75} fill="currentColor" />}
          </motion.span>
        </AnimatePresence>
      </button>
      <div className={styles.timeline}>
        <div className={styles.track} role="slider" tabIndex={empty ? -1 : 0} aria-label={`${label}, period`} aria-valuemin={0} aria-valuemax={last} aria-valuenow={index} aria-valuetext={period}
          onPointerDown={onScrubDown} onPointerMove={onScrubMove} onPointerUp={onScrubUp} onPointerCancel={onScrubUp} onKeyDown={onScrubKey}>
          <span className={styles.rail} aria-hidden="true"><span ref={fill} className={styles.fill} /></span>
          {frames.map((entry, k) => k > 0 && k < last && <span key={entry.period} className={styles.stop} style={{ left: `${last ? (k / last) * 100 : 0}%` }} data-past={k <= index || undefined} aria-hidden="true" />)}
          <span ref={thumb} className={styles.thumb} aria-hidden="true" />
        </div>
        <div className={styles.ends} aria-hidden="true"><span>{frames[0]?.period}</span><span>{frames[last]?.period}</span></div>
      </div>
    </div>
    <p className={styles.srOnly} aria-live="polite" aria-atomic="true">{reading && active !== null ? `${reading.item.label}, rank ${reading.rank}, ${formatValue(reading.value)}` : announce}</p>
    {!empty && <div className={styles.srOnly}><table>
      <caption>{label}</caption>
      <thead><tr><th scope="col">Item</th>{frames.map(entry => <th key={entry.period} scope="col">{entry.period}</th>)}</tr></thead>
      <tbody>{items.map((item, k) => <tr key={item.id}><th scope="row">{item.label}</th>{matrix.map((values, f) => <td key={f}>{formatValue(values[k])}</td>)}</tr>)}</tbody>
    </table></div>}
  </figure>;
}

export default RaceBarChart;
