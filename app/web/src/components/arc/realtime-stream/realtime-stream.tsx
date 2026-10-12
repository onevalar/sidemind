"use client";

import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent, type Ref } from "react";
import { animate, motion, useInView, useMotionValue, useReducedMotion, useSpring, useTransform } from "motion/react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./realtime-stream.module.css";

export interface StreamPoint {
  /** Timestamp in milliseconds. Points must arrive in ascending order. */
  t: number;
  value: number;
  /** Marks the point as an anomaly. A string becomes the marker's label, such as "Spike". */
  anomaly?: boolean | string;
}

/** Use a realtime stream for one live measure where the last few seconds matter more than history. */
export interface RealtimeStreamProps {
  /** Append-only feed in ascending time. Only the visible window is drawn, so trim old points every few windows. */
  points: StreamPoint[];
  /** What is measured, such as "p95 latency". Names the chart and the current value. */
  label: string;
  /** Unit after values, such as "ms". */
  unit?: string;
  /** Visible span of time in milliseconds. */
  windowMs?: number;
  /** Typical time between points. The chart draws this far behind the newest point, so each one slides in instead of popping. */
  interval?: number;
  /** Plot height in pixels. */
  height?: number;
  formatValue?: (value: number) => string;
  /** Formats times on the axis and in the tooltip. */
  formatTime?: (t: number) => string;
  /** Controlled pause. While paused the view holds still and new points queue up; resuming glides back to live. */
  paused?: boolean;
  defaultPaused?: boolean;
  onPausedChange?: (paused: boolean) => void;
  /** Holds the view while the pointer is over the plot, so a moving point can be read. */
  pauseOnHover?: boolean;
  /** Fixed lower bound of the value axis. Leave it out to follow the data. */
  min?: number;
  max?: number;
  emptyLabel?: string;
  ref?: Ref<HTMLElement>;
  className?: string;
}

type Palette = { ink: string; accent: string; surface: string; border: string; muted: string; mark: string; font: string };
type Hover = { t: number; value: number; anomaly?: boolean | string; x: number; y: number } | null;

const { spring } = motionTokens;
const follow = { stiffness: 520, damping: 44, restDelta: .01 };
const PAD_TOP = 14, PAD_BOTTOM = 22, AXIS = 44;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const grouped = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const clock = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

const subscribeNothing = () => () => {};
function useReducedMotionSafe() {
  const hydrated = useSyncExternalStore(subscribeNothing, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

/** Tick step that lands on 1, 2, 2.5, or 5 times a power of ten. */
function niceStep(span: number, count: number) {
  const raw = span / Math.max(1, count), power = 10 ** Math.floor(Math.log10(raw || 1)), unit = raw / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10) * power;
}

/** First index with t >= target, searched from the end since only recent points are read. */
function lowerBound(points: StreamPoint[], target: number) {
  let lo = 0, hi = points.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (points[mid].t < target) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Overshoots once and settles, for markers that pop in. */
const pop = (age: number) => age >= .5 ? 1 : 1 - Math.exp(-age * 12) * Math.cos(age * 16);

export function RealtimeStream({ points, label, unit = "", windowMs = 30_000, interval = 1000, height = 200, formatValue, formatTime = t => clock.format(t), paused, defaultPaused = false, onPausedChange, pauseOnHover = true, min, max, emptyLabel = "Waiting for data", ref, className }: RealtimeStreamProps) {
  const reduced = useReducedMotionSafe();
  const figure = useRef<HTMLElement>(null);
  const plot = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => figure.current as HTMLElement);
  const visible = useInView(figure, { amount: 0 });
  const empty = points.length === 0;
  const latest = points[points.length - 1];

  const [ownPaused, setOwnPaused] = useState(defaultPaused);
  const held = paused ?? ownPaused;
  const setHeld = (next: boolean) => { if (paused === undefined) setOwnPaused(next); if (next !== held) onPausedChange?.(next); };
  const [hover, setHover] = useState<Hover>(null);
  const [pointerIn, setPointerIn] = useState(false);
  const frozen = held || (pauseOnHover && pointerIn) || hover !== null;

  // Points that arrive while the view is held are counted, so the reader knows how much there is to catch up on.
  const [queued, setQueued] = useState(0);
  const [seenLatest, setSeenLatest] = useState(latest?.t);
  if (latest?.t !== seenLatest) { setSeenLatest(latest?.t); if (frozen && seenLatest !== undefined) setQueued(count => count + 1); }
  const [wasFrozen, setWasFrozen] = useState(frozen);
  if (wasFrozen !== frozen) { setWasFrozen(frozen); if (!frozen) setQueued(0); }

  // Anomalies are announced once, as they arrive.
  const [announce, setAnnounce] = useState("");
  const [lastAnomaly, setLastAnomaly] = useState<number | null>(null);
  if (latest?.anomaly && latest.t !== lastAnomaly) {
    setLastAnomaly(latest.t);
    setAnnounce(`${typeof latest.anomaly === "string" ? latest.anomaly : "Anomaly"} at ${formatTime(latest.t)}, ${formatValue ? formatValue(latest.value) : grouped.format(latest.value)}${unit ? ` ${unit}` : ""}`);
  }

  // The live renderer reads everything through refs so the frame loop never re-subscribes.
  const state = useRef({ points, windowMs, interval, height, frozen, reduced, hover, min, max });
  useLayoutEffect(() => { state.current = { points, windowMs, interval, height, frozen, reduced, hover, min, max }; });
  const view = useRef({ t: 0, skew: 0, lo: 0, hi: 1, ready: false, arrivals: new Map<number, number>(), width: 0, lastLatest: -Infinity });
  const colors = useRef<Palette>({ ink: "#111", accent: "#333", surface: "#fff", border: "#eee", muted: "#888", mark: "#e26a2b", font: "system-ui, sans-serif" });

  // Canvas cannot read tokens, so hidden probes resolve them. Themes can change on any ancestor, so the loop also refreshes them twice a second.
  const readColors = useRef(() => {
    const node = probe.current;
    if (!node) return;
    const spans = node.children;
    const get = (i: number) => getComputedStyle(spans[i] as HTMLElement).color;
    colors.current = { ink: get(0), accent: get(1), surface: get(2), border: get(3), muted: get(4), mark: get(5), font: getComputedStyle(node).fontFamily || "system-ui, sans-serif" };
  });
  useEffect(() => {
    const read = () => readColors.current();
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-accent", "class", "style"] });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", read);
    return () => { observer.disconnect(); media.removeEventListener("change", read); };
  }, []);

  useEffect(() => {
    const node = canvas.current, host = plot.current;
    if (!node || !host) return;
    const context = node.getContext("2d");
    if (!context) return;
    let frame = 0, previous = performance.now(), tick = 0;

    const draw = (now: number) => {
      if (tick++ % 30 === 0) readColors.current();
      const dt = Math.min(.1, (now - previous) / 1000);
      previous = now;
      const s = state.current, v = view.current, c = colors.current;
      const w = host.clientWidth, h = s.height;
      const ratio = window.devicePixelRatio || 1;
      if (node.width !== Math.round(w * ratio) || node.height !== Math.round(h * ratio)) { node.width = Math.round(w * ratio); node.height = Math.round(h * ratio); }
      v.width = w;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, w, h);
      const list = s.points;
      if (!list.length || w <= AXIS) return;
      const newest = list[list.length - 1];
      if (newest.t !== v.lastLatest) {
        v.lastLatest = newest.t; v.arrivals.set(newest.t, now);
        for (const t of v.arrivals.keys()) if (t < newest.t - s.windowMs * 2) v.arrivals.delete(t); v.skew = v.ready ? v.skew + (newest.t - Date.now() - v.skew) * .25 : newest.t - Date.now();
      }

      // Live time trails the newest point by one interval, and never runs past it when the feed stalls.
      const liveT = s.reduced ? newest.t : Math.min(Date.now() + v.skew - s.interval, newest.t);
      if (!v.ready) { v.t = liveT; v.ready = true; }
      if (!s.frozen) v.t = s.reduced || Math.abs(liveT - v.t) < 4 ? liveT : v.t + (liveT - v.t) * (1 - Math.exp(-dt * 7));
      const right = v.t, left = right - s.windowMs;
      const plotW = w - AXIS, plotH = h - PAD_TOP - PAD_BOTTOM;
      const xOf = (t: number) => ((t - left) / s.windowMs) * plotW;

      const start = Math.max(0, lowerBound(list, left) - 1), end = Math.min(list.length, lowerBound(list, right) + 1);
      const shown = list.slice(start, end);
      // The head: the point being drawn right now, between the last point passed and the next one.
      const after = lowerBound(list, right), before = after - 1;
      let head: { t: number; value: number };
      if (before < 0) head = list[0];
      else if (after >= list.length) head = list[list.length - 1];
      else { const a = list[before], b = list[after], k = (right - a.t) / Math.max(1, b.t - a.t); head = { t: right, value: a.value + (b.value - a.value) * clamp(k, 0, 1) }; }
      const drawn = shown.filter(point => point.t <= right);
      drawn.push(head);

      // The value axis eases toward the range on screen, so gridlines slide instead of jumping.
      let lo = s.min ?? Infinity, hi = s.max ?? -Infinity;
      if (s.min === undefined || s.max === undefined) for (const point of drawn) { if (s.min === undefined) lo = Math.min(lo, point.value); if (s.max === undefined) hi = Math.max(hi, point.value); }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
      const spread = Math.max(hi - lo, Math.abs(hi) * .1, 1e-6);
      const targetLo = s.min ?? lo - spread * .18, targetHi = s.max ?? hi + spread * .18;
      if (s.reduced || v.hi - v.lo <= 0) { v.lo = targetLo; v.hi = targetHi; }
      else { const ease = 1 - Math.exp(-dt * 4); v.lo += (targetLo - v.lo) * ease; v.hi += (targetHi - v.hi) * ease; }
      const yOf = (value: number) => PAD_TOP + (1 - (value - v.lo) / (v.hi - v.lo)) * plotH;

      // Gridlines and value labels on the right, hairline and recessive.
      const step = niceStep(v.hi - v.lo, Math.max(2, Math.floor(plotH / 44)));
      context.font = `12px ${c.font}`;
      context.textBaseline = "middle";
      context.textAlign = "left";
      for (let tick = Math.ceil(v.lo / step) * step; tick <= v.hi; tick += step) {
        const y = Math.round(yOf(tick)) + .5;
        if (y < PAD_TOP - 2 || y > h - PAD_BOTTOM + 2) continue;
        context.strokeStyle = c.border; context.lineWidth = 1; context.globalAlpha = 1;
        context.beginPath(); context.moveTo(0, y); context.lineTo(plotW, y); context.stroke();
        context.fillStyle = c.muted;
        context.fillText(grouped.format(Math.round(tick * 100) / 100), plotW + 8, y);
      }
      // Time labels count back from now.
      context.textBaseline = "alphabetic";
      const every = niceStep(s.windowMs / 1000, Math.max(2, Math.floor(plotW / 90))) * 1000;
      for (let back = 0; back <= s.windowMs; back += every) {
        const x = plotW - (back / s.windowMs) * plotW;
        context.textAlign = back === 0 ? "right" : x < 20 ? "left" : "center";
        context.fillStyle = c.muted;
        context.fillText(back === 0 ? "now" : `−${Math.round(back / 1000)}s`, x, h - 6);
      }

      // Plot clip keeps the scrolling line out of the axis gutter.
      context.save();
      context.beginPath(); context.rect(0, 0, plotW, h); context.clip();
      const xy = drawn.map(point => [xOf(point.t), yOf(point.value)] as const);
      // A flat wash under the line, then the line itself: a monotone cubic that passes through every reading and never overshoots it.
      const tangents = xy.map((_, i) => {
        if (xy.length < 2) return 0;
        const prev = i > 0 ? (xy[i][1] - xy[i - 1][1]) / Math.max(1e-6, xy[i][0] - xy[i - 1][0]) : null;
        const next = i < xy.length - 1 ? (xy[i + 1][1] - xy[i][1]) / Math.max(1e-6, xy[i + 1][0] - xy[i][0]) : null;
        if (prev === null) return next ?? 0;
        if (next === null) return prev;
        return prev * next <= 0 ? 0 : (2 * prev * next) / (prev + next);
      });
      const trace = () => {
        context.moveTo(xy[0][0], xy[0][1]);
        for (let i = 0; i < xy.length - 1; i++) {
          const dx = (xy[i + 1][0] - xy[i][0]) / 3;
          context.bezierCurveTo(xy[i][0] + dx, xy[i][1] + tangents[i] * dx, xy[i + 1][0] - dx, xy[i + 1][1] - tangents[i + 1] * dx, xy[i + 1][0], xy[i + 1][1]);
        }
      };
      if (xy.length > 1) {
        context.beginPath(); trace();
        context.lineTo(xy[xy.length - 1][0], h - PAD_BOTTOM); context.lineTo(xy[0][0], h - PAD_BOTTOM); context.closePath();
        context.fillStyle = c.accent; context.globalAlpha = .08; context.fill();
        context.beginPath(); trace();
        context.globalAlpha = 1; context.strokeStyle = c.accent; context.lineWidth = 2; context.lineJoin = "round"; context.lineCap = "round"; context.stroke();
      }

      // Anomalies pop in as the head passes them: a hairline to the top, a marker, and a small tag. Neighbouring anomalies share one tag.
      let tagEnd = -Infinity;
      for (const point of shown) {
        if (!point.anomaly || point.t > right) continue;
        const x = xOf(point.t), y = yOf(point.value);
        const passed = v.arrivals.get(point.t);
        const age = s.reduced || passed === undefined ? 1 : (now - passed) / 1000 - s.interval / 1000;
        if (age < 0) continue;
        const scale = s.reduced ? 1 : pop(age);
        context.globalAlpha = .45 * clamp(age * 4, 0, 1);
        context.strokeStyle = c.mark; context.lineWidth = 1;
        context.beginPath(); context.moveTo(Math.round(x) + .5, PAD_TOP + 10); context.lineTo(Math.round(x) + .5, y - 6); context.stroke();
        context.globalAlpha = 1;
        context.beginPath(); context.arc(x, y, 6 * scale, 0, Math.PI * 2); context.fillStyle = c.surface; context.fill();
        context.beginPath(); context.arc(x, y, 4 * scale, 0, Math.PI * 2); context.fillStyle = c.mark; context.fill();
        const text = typeof point.anomaly === "string" ? point.anomaly : "Anomaly";
        context.font = `500 12px ${c.font}`;
        const tw = context.measureText(text).width + 14, th = 18;
        const tx = clamp(x - tw / 2, 0, plotW - tw), ty = PAD_TOP - 8;
        if (tx < tagEnd + 4) continue;
        tagEnd = tx + tw;
        context.save();
        context.translate(tx + tw / 2, ty + th / 2); context.scale(scale, scale); context.translate(-(tx + tw / 2), -(ty + th / 2));
        context.beginPath(); context.roundRect(tx, ty, tw, th, 9); context.fillStyle = c.surface; context.fill();
        context.strokeStyle = c.border; context.lineWidth = 1; context.stroke();
        context.fillStyle = c.ink; context.textAlign = "center"; context.textBaseline = "middle";
        context.fillText(text, tx + tw / 2, ty + th / 2 + .5);
        context.restore();
      }

      // Reading: a crosshair and a ringed dot on the point being read.
      const reading = s.hover;
      if (reading) {
        const x = Math.round(xOf(reading.t)) + .5, y = yOf(reading.value);
        context.globalAlpha = .5; context.strokeStyle = c.ink; context.lineWidth = 1;
        context.beginPath(); context.moveTo(x, PAD_TOP); context.lineTo(x, h - PAD_BOTTOM); context.stroke();
        context.globalAlpha = 1;
        context.beginPath(); context.arc(x, y, 6, 0, Math.PI * 2); context.fillStyle = c.surface; context.fill();
        context.beginPath(); context.arc(x, y, 4, 0, Math.PI * 2); context.fillStyle = c.accent; context.fill();
      }

      // The leading dot: solid, ringed in the surface colour, no glow.
      const [hx, hy] = xy[xy.length - 1];
      context.globalAlpha = 1;
      context.beginPath(); context.arc(hx, hy, 6, 0, Math.PI * 2); context.fillStyle = c.surface; context.fill();
      context.beginPath(); context.arc(hx, hy, 4, 0, Math.PI * 2); context.fillStyle = c.accent; context.fill();
      context.restore();
    };

    const loop = (now: number) => { frame = requestAnimationFrame(loop); if (!document.hidden) draw(now); };
    if (state.current.reduced) {
      // Reduced motion: no scrolling. The chart redraws only when data, size, or the reading changes.
      draw(performance.now());
      return;
    }
    if (!visible) return;
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [visible, reduced, points, hover, height, windowMs]);

  // The status label changes length ("Live", "Paused, 3 new"); its window springs to the new width instead of resizing in one frame.
  const statusLabel = frozen ? queued > 0 ? `Paused, ${queued} new` : "Paused" : "Live";
  const statusInner = useRef<HTMLSpanElement>(null);
  const statusWidth = useMotionValue<number | "auto">("auto");
  useLayoutEffect(() => {
    const node = statusInner.current;
    if (!node) return;
    const next = node.offsetWidth;
    if (reduced || statusWidth.get() === "auto") { statusWidth.jump(next); return; }
    const controls = animate(statusWidth, next, spring.morph);
    return () => controls.stop();
  }, [statusLabel, reduced, statusWidth]);

  // The tooltip keeps its last reading while it fades out, so the bubble never empties and shrinks mid-fade.
  const [shownHover, setShownHover] = useState<Hover>(hover);
  if (hover && hover !== shownHover) setShownHover(hover);
  const reading = hover ?? shownHover;

  // Rolling current value.
  const shownValue = useMotionValue(latest?.value ?? 0);
  const valueText = useTransform(shownValue, current => formatValue ? formatValue(current) : grouped.format(Math.round(current)));
  useEffect(() => {
    if (!latest) return;
    if (reduced) { shownValue.jump(latest.value); return; }
    const controls = animate(shownValue, latest.value, spring.smooth);
    return () => controls.stop();
  }, [latest, reduced, shownValue]);

  // Tooltip glides between readings and stays inside the plot.
  const tipX = useMotionValue(0), tipY = useMotionValue(0);
  const tipSpringX = useSpring(tipX, follow), tipSpringY = useSpring(tipY, follow);
  const wasShown = useRef(false);
  useLayoutEffect(() => {
    const bubble = tip.current, host = plot.current;
    if (!hover || !bubble || !host) { wasShown.current = false; return; }
    const tw = bubble.offsetWidth, th = bubble.offsetHeight, w = host.clientWidth - AXIS;
    let left = hover.x + 14;
    if (left + tw > w) left = hover.x - 14 - tw;
    const top = clamp(hover.y - th - 12 < 0 ? hover.y + 14 : hover.y - th - 12, 0, Math.max(0, height - th));
    tipX.set(clamp(left, 0, Math.max(0, w - tw))); tipY.set(top);
    if (!wasShown.current || reduced) { tipSpringX.jump(tipX.get()); tipSpringY.jump(top); }
    wasShown.current = true;
  });

  // Readings snap to the nearest point in the frame that is on screen.
  const geometry = () => {
    const v = view.current, s = state.current, plotW = v.width - AXIS, plotH = s.height - PAD_TOP - PAD_BOTTOM;
    const left = v.t - s.windowMs;
    return { xOf: (t: number) => ((t - left) / s.windowMs) * plotW, yOf: (value: number) => PAD_TOP + (1 - (value - v.lo) / (v.hi - v.lo)) * plotH, left, right: v.t, plotW };
  };
  const readingAt = (index: number): Hover => {
    const point = points[index];
    if (!point) return null;
    const g = geometry();
    return { t: point.t, value: point.value, anomaly: point.anomaly, x: g.xOf(point.t), y: g.yOf(point.value) };
  };
  const nearest = (clientX: number) => {
    const rect = plot.current?.getBoundingClientRect();
    if (!rect || empty) return null;
    const g = geometry();
    const t = g.left + clamp((clientX - rect.left) / Math.max(1, g.plotW), 0, 1) * (g.right - g.left);
    const at = lowerBound(points, t);
    const candidates = [at - 1, at].filter(i => i >= 0 && i < points.length && points[i].t <= g.right);
    if (!candidates.length) return null;
    return candidates.reduce((best, i) => Math.abs(points[i].t - t) < Math.abs(points[best].t - t) ? i : best);
  };
  const hoverIndex = hover ? lowerBound(points, hover.t) : null;
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse" && !event.buttons) return;
    const index = nearest(event.clientX);
    setHover(index === null ? null : readingAt(index));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (empty) return;
    if (event.key === " " || event.key === "Enter") { event.preventDefault(); setHeld(!held); return; }
    if (event.key === "Escape") { event.preventDefault(); setHover(null); if (held) setHeld(false); return; }
    const g = geometry();
    const firstVisible = lowerBound(points, g.left), lastVisible = lowerBound(points, g.right + .001) - 1;
    const from = hoverIndex ?? lastVisible + 1;
    const moves: Record<string, number> = { ArrowLeft: from - 1, ArrowRight: from + 1, Home: firstVisible, End: lastVisible, PageUp: from - 10, PageDown: from + 10 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    setHover(readingAt(clamp(moves[event.key], firstVisible, lastVisible)));
  };

  const format = (value: number) => `${formatValue ? formatValue(value) : grouped.format(value)}${unit ? ` ${unit}` : ""}`;
  const table = points.slice(-20);

  return <figure ref={figure} className={[styles.figure, className].filter(Boolean).join(" ")} aria-label={label}>
    <div className={styles.head}>
      <p className={styles.now} aria-label={latest ? `${label}, ${format(latest.value)}` : `${label}, ${emptyLabel}`}>
        <motion.span className={styles.value} aria-hidden="true">{latest ? valueText : "0"}</motion.span>
        {unit && <span className={styles.unit} aria-hidden="true">{unit}</span>}
      </p>
      <button type="button" className={styles.status} data-held={frozen || undefined} aria-pressed={held} onClick={() => setHeld(!held)}>
        <span className={styles.statusDot} aria-hidden="true" />
        <motion.span className={styles.statusText} style={{ width: statusWidth }}><span ref={statusInner} className={styles.statusLabel}>{statusLabel}</span></motion.span>
        <span className={styles.srOnly}>{held ? ", resume" : ", pause"}</span>
      </button>
    </div>
    <div ref={plot} className={styles.plot} style={{ height }} data-active={hover ? true : undefined}
      role="group" tabIndex={empty ? -1 : 0} aria-roledescription="live chart" aria-label={`${label}, last ${Math.round(windowMs / 1000)} seconds. Focus holds the view. Use left and right arrows to read points, Space to pause or resume.`}
      onPointerEnter={event => { if (event.pointerType === "mouse") setPointerIn(true); }}
      onPointerLeave={event => { if (event.pointerType === "mouse") { setPointerIn(false); setHover(null); } }}
      onPointerMove={onPointerMove}
      onPointerDown={event => { if (event.pointerType !== "mouse") { event.currentTarget.setPointerCapture?.(event.pointerId); const index = nearest(event.clientX); setHover(index === null ? null : readingAt(index)); } }}
      onPointerUp={event => { if (event.pointerType !== "mouse") setHover(null); }} onPointerCancel={() => setHover(null)}
      onKeyDown={onKeyDown} onBlur={() => setHover(null)} onFocus={event => { if (event.currentTarget.matches(":focus-visible") && !empty) { const g = geometry(); const index = lowerBound(points, g.right + .001) - 1; setHover(readingAt(Math.max(0, index))); } }}>
      <canvas ref={canvas} className={styles.canvas} style={{ height }} aria-hidden="true" />
      <span ref={probe} className={styles.probe} aria-hidden="true"><span /><span /><span /><span /><span /><span /></span>
      <motion.div ref={tip} className={styles.tooltip} style={{ x: reduced ? tipX : tipSpringX, y: reduced ? tipY : tipSpringY }} aria-hidden="true">
        <p className={styles.tipValue}>{reading ? format(reading.value) : ""}</p>
        <p className={styles.tipMeta}>{reading ? `${formatTime(reading.t)}${reading.anomaly ? `, ${typeof reading.anomaly === "string" ? reading.anomaly.toLowerCase() : "anomaly"}` : ""}` : ""}</p>
      </motion.div>
      {empty && <p className={styles.message}>{emptyLabel}</p>}
    </div>
    <p className={styles.srOnly} aria-live="polite" aria-atomic="true">{announce}</p>
    <p className={styles.srOnly} aria-live="polite" aria-atomic="true">{hover ? `${formatTime(hover.t)}, ${format(hover.value)}${hover.anomaly ? `, ${typeof hover.anomaly === "string" ? hover.anomaly : "anomaly"}` : ""}` : ""}</p>
    {!empty && <div className={styles.srOnly}><table>
      <caption>{label}, latest {table.length} readings</caption>
      <thead><tr><th scope="col">Time</th><th scope="col">Value</th><th scope="col">Note</th></tr></thead>
      <tbody>{table.map(point => <tr key={point.t}><th scope="row">{formatTime(point.t)}</th><td>{format(point.value)}</td><td>{point.anomaly ? typeof point.anomaly === "string" ? point.anomaly : "Anomaly" : ""}</td></tr>)}</tbody>
    </table></div>}
  </figure>;
}

export default RealtimeStream;
