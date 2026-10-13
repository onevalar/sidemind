"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, type AnimationPlaybackControls } from "motion/react";
import { Mail, Newspaper, Pause, Play, Rocket, RotateCcw, TriangleAlert, Trophy, type LucideIcon } from "lucide-react";
import { motionTokens } from "../../lib/motion-tokens";
import { Button } from "../../button/button";
import SegmentedControl from "../../segmented-control/segmented-control";
import {
  MOMENTS, POINTS, formatClock, formatCount, formatHour, niceMax,
  type MomentKind, type ReplayMoment, type ReplayPoint,
} from "./line-replay-data";
import styles from "./line-replay.module.css";

export type { MomentKind, ReplayMoment, ReplayPoint } from "./line-replay-data";

export type ReplaySpeed = 0.5 | 1 | 2 | 4;

export interface LineReplayProps {
  /** Heading of the block. */
  title?: string;
  /** One line under the heading that names what is measured and when. */
  description?: string;
  /** Points in time order. `time` is minutes from the start; `baseline` draws a quiet comparison line. */
  data?: ReplayPoint[];
  /** Key moments, annotated on the chart as the playhead passes them and listed beside it. */
  moments?: ReplayMoment[];
  /** Name of the replayed series, used in the legend. */
  seriesLabel?: string;
  /** Name of the comparison series, used in the legend. */
  baselineLabel?: string;
  /** Label of the value under the playhead. */
  valueLabel?: string;
  /** Formats a time on the replay clock (minutes from the start). */
  formatTime?: (minutes: number) => string;
  /** Formats a time for the axis. */
  formatTick?: (minutes: number) => string;
  /** Formats a value. */
  formatValue?: (value: number) => string;
  /** Seconds a full replay takes at 1×. */
  duration?: number;
  /** Starting speed. */
  defaultSpeed?: ReplaySpeed;
  /** Where the playhead rests before the first play: the full line, or an empty chart. */
  defaultPosition?: "start" | "end";
  /** Starts playing from the beginning the first time the block scrolls into view. Ignored with reduced motion. */
  autoPlay?: boolean;
  /** Called when playback passes a moment. */
  onMomentReached?: (moment: ReplayMoment) => void;
  className?: string;
}

const SPEEDS = [
  { value: "0.5", label: "0.5×" },
  { value: "1", label: "1×" },
  { value: "2", label: "2×" },
  { value: "4", label: "4×" },
];

const KIND_ICON: Record<MomentKind, LucideIcon> = { launch: Rocket, press: Newspaper, email: Mail, incident: TriangleAlert, milestone: Trophy };

/** Room around the plot: a lane on top for the moment callout, value labels on the left, time labels below. */
const PAD = { top: 64, right: 16, bottom: 32 };
/** Where the callout's lower edge sits inside the top lane. */
const LANE_BOTTOM = PAD.top - 12;

interface Geometry {
  width: number;
  height: number;
  left: number;
  plotBottom: number;
  xs: number[];
  ys: number[];
  segments: string[];
  baseline: string | null;
  yTicks: { value: number; y: number }[];
  xTicks: { time: number; x: number }[];
  yOf: (value: number) => number;
}

const compactTick = (value: number) => (value === 0 ? "0" : value >= 1000 ? `${value / 1000}k` : String(value));

/** Fractional index of a time on the points' clock. */
function indexOfTime(times: number[], time: number) {
  if (time <= times[0]) return 0;
  const last = times.length - 1;
  if (time >= times[last]) return last;
  let lo = 0, hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= time) lo = mid; else hi = mid;
  }
  return lo + (time - times[lo]) / (times[hi] - times[lo] || 1);
}

const lerpAt = (values: number[], t: number) => {
  const i = Math.floor(t);
  const f = t - i;
  return i >= values.length - 1 ? values[values.length - 1] : values[i] + (values[i + 1] - values[i]) * f;
};

export function LineReplay({
  title = "Launch day",
  description = "People on site every five minutes on Tuesday 8 September 2026, Pacific time.",
  data = POINTS,
  moments = MOMENTS,
  seriesLabel = "Launch day",
  baselineLabel = "Typical Tuesday",
  valueLabel = "On site",
  formatTime = formatClock,
  formatTick = formatHour,
  formatValue = formatCount,
  duration = 16,
  defaultSpeed = 1,
  defaultPosition = "end",
  autoPlay = false,
  onMomentReached,
  className,
}: LineReplayProps) {
  const uid = useId();
  const titleId = `${uid}-title`;
  const momentsId = `${uid}-moments`;
  const reduce = useReducedMotion() ?? false;

  /* ---------- Data derived once per data set ---------- */

  const model = useMemo(() => {
    const times = data.map(p => p.time);
    const values = data.map(p => p.value);
    const hasBaseline = data.length > 0 && data.every(p => typeof p.baseline === "number");
    const baselines = hasBaseline ? data.map(p => p.baseline as number) : null;
    // Running peak index, so the peak so far is one lookup per frame.
    const peakIdx: number[] = [];
    values.forEach((v, i) => { peakIdx.push(i === 0 || v > values[peakIdx[i - 1]] ? i : peakIdx[i - 1]); });
    const max = Math.max(1, ...values, ...(baselines ?? []));
    const sorted = [...moments].sort((a, b) => a.time - b.time);
    const marks = sorted.map(m => {
      const index = indexOfTime(times, m.time);
      const at = lerpAt(values, index);
      // Effect: the change over the next hour (or the dip within 20 minutes for an incident).
      const incident = m.kind === "incident";
      const span = incident ? 20 : 60;
      const endIdx = indexOfTime(times, m.time + span);
      let extreme = at;
      for (let i = Math.ceil(index); i <= Math.floor(endIdx); i++) extreme = incident ? Math.min(extreme, values[i]) : Math.max(extreme, values[i]);
      const effect = incident
        ? `−${Math.round(((at - extreme) / (at || 1)) * 100)}% in ${span} minutes`
        : `+${formatValue(extreme - at)} in the next hour`;
      return { ...m, index, endIndex: endIdx, value: at, effect };
    });
    return { times, values, baselines, peakIdx, max, marks, last: Math.max(0, values.length - 1) };
  }, [data, moments, formatValue]);

  const { times, values, baselines, peakIdx, marks, last } = model;
  const yMax = useMemo(() => niceMax(model.max), [model.max]);

  const startIndex = defaultPosition === "end" ? last : 0;
  const passedAt = useCallback((t: number) => marks.reduce((n, m) => n + (m.index <= t + 0.01 ? 1 : 0), 0), [marks]);

  /* ---------- State: React renders only when these change ---------- */

  const t = useMotionValue(startIndex);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<ReplaySpeed>(defaultSpeed);
  const [passed, setPassed] = useState(() => passedAt(startIndex));
  /** One flag per moment: "1" once the replay has played through the window its effect describes. */
  const settledAt = useCallback((t: number) => marks.map(m => (m.endIndex <= t + 0.01 ? "1" : "0")).join(""), [marks]);
  const [settled, setSettled] = useState(() => settledAt(startIndex));
  const [atEnd, setAtEnd] = useState(startIndex >= last);
  const [hovered, setHovered] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  const playingRef = useRef(false);
  const passedRef = useRef(passed);
  const settledRef = useRef(settled);
  const atEndRef = useRef(atEnd);
  const rateRef = useRef(1);
  const dragging = useRef(false);
  const seekAnim = useRef<AnimationPlaybackControls | null>(null);
  const momentCb = useRef(onMomentReached);
  useEffect(() => { momentCb.current = onMomentReached; }, [onMomentReached]);
  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { rateRef.current = (last / Math.max(1, duration)) * speed; }, [last, duration, speed]);

  // The first server and client render share these strings; per-frame updates write the DOM directly afterwards.
  const [initialText] = useState(() => {
    const i = startIndex;
    const peak = peakIdx[Math.floor(i)] ?? 0;
    const base = baselines ? lerpAt(baselines, i) : 0;
    return {
      time: formatTime(lerpAt(times, i)),
      value: formatValue(lerpAt(values, i)),
      ratio: baselines ? `${(lerpAt(values, i) / (base || 1)).toFixed(1)}×` : "",
      peak: `${formatValue(values[peak] ?? 0)} at ${formatTime(times[peak] ?? 0)}`,
      fraction: last ? i / last : 0,
    };
  });

  /* ---------- Measure ---------- */

  const stageRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const measure = () => {
      const width = Math.round(node.clientWidth);
      const height = Math.round(node.clientHeight);
      setSize(prev => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const geo = useMemo<Geometry | null>(() => {
    if (!size || size.width < 40) return null;
    const { width, height } = size;
    const narrow = width < 520;
    const left = narrow ? 30 : 40;
    const plotBottom = height - PAD.bottom;
    const plotW = width - left - PAD.right;
    const plotH = plotBottom - PAD.top;
    const yOf = (v: number) => PAD.top + plotH * (1 - v / yMax);
    const xOfIndex = (i: number) => left + (last ? (i / last) * plotW : 0);
    const xs = values.map((_, i) => xOfIndex(i));
    const ys = values.map(v => yOf(v));
    const segments = xs.map((x, i) => `L${x.toFixed(1)} ${ys[i].toFixed(1)}`);
    const baseline = baselines ? baselines.map((b, i) => `${i ? "L" : "M"}${xs[i].toFixed(1)} ${yOf(b).toFixed(1)}`).join("") : null;
    const yTicks = [0, 1, 2, 3, 4].map(k => ({ value: (yMax / 4) * k, y: yOf((yMax / 4) * k) }));
    const hourStep = narrow ? 360 : 180;
    const first = times[0] ?? 0;
    const lastTime = times[last] ?? 0;
    const xTicks: { time: number; x: number }[] = [];
    for (let m = Math.ceil(first / hourStep) * hourStep; m <= lastTime; m += hourStep) {
      const x = xOfIndex(indexOfTime(times, m));
      if (x > left + 14 && x < width - PAD.right - 14) xTicks.push({ time: m, x });
    }
    return { width, height, left, plotBottom, xs, ys, segments, baseline, yTicks, xTicks, yOf };
  }, [size, values, baselines, times, last, yMax]);

  /* ---------- Per-frame drawing ---------- */

  const lineRef = useRef<SVGPathElement>(null);
  const areaRef = useRef<SVGPathElement>(null);
  const headRef = useRef<SVGGElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const tipText = useRef<HTMLSpanElement>(null);
  const clockRef = useRef<HTMLDivElement>(null);
  const clockText = useRef<HTMLSpanElement>(null);
  const xLabelRefs = useRef<(SVGTextElement | null)[]>([]);
  const readTime = useRef<HTMLSpanElement>(null);
  const readValue = useRef<HTMLSpanElement>(null);
  const readRatio = useRef<HTMLSpanElement>(null);
  const readPeak = useRef<HTMLSpanElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const scrubRef = useRef<HTMLDivElement>(null);
  const lastText = useRef<Record<string, string>>({});

  const setText = useCallback((key: string, node: HTMLElement | null, text: string) => {
    if (!node || lastText.current[key] === text) return;
    lastText.current[key] = text;
    node.textContent = text;
  }, []);

  const updateAria = useCallback((i: number) => {
    const node = scrubRef.current;
    if (!node) return;
    const time = lerpAt(times, i);
    node.setAttribute("aria-valuenow", String(Math.round(time)));
    node.setAttribute("aria-valuetext", `${formatTime(time)}, ${formatValue(lerpAt(values, i))} ${valueLabel.toLowerCase()}`);
  }, [times, values, formatTime, formatValue, valueLabel]);

  const draw = useCallback((raw: number) => {
    const i = Math.min(last, Math.max(0, raw));
    const n = Math.floor(i);
    const value = lerpAt(values, i);
    const time = lerpAt(times, i);

    // Readout and scrubber work with or without a measured chart.
    setText("time", readTime.current, formatTime(time));
    setText("value", readValue.current, formatValue(value));
    if (baselines) setText("ratio", readRatio.current, `${(value / (lerpAt(baselines, i) || 1)).toFixed(1)}×`);
    // The peak so far includes the value under the playhead, which can sit between two points.
    const peak = peakIdx[n] ?? 0;
    const livePeak = value > values[peak];
    setText("peak", readPeak.current, `${formatValue(livePeak ? value : values[peak])} at ${formatTime(livePeak ? time : times[peak])}`);
    const fraction = last ? i / last : 0;
    if (fillRef.current) fillRef.current.style.transform = `scaleX(${fraction})`;
    const trackW = trackRef.current?.clientWidth ?? 0;
    if (thumbRef.current) thumbRef.current.style.transform = `translateX(${(fraction * trackW).toFixed(2)}px)`;
    if (!playingRef.current) updateAria(i);

    const count = passedAt(i);
    if (count !== passedRef.current) {
      const grew = count > passedRef.current;
      passedRef.current = count;
      setPassed(count);
      if (grew && playingRef.current) {
        const moment = marks[count - 1];
        setAnnouncement(`${formatTime(moment.time)}. ${moment.title}.`);
        momentCb.current?.(moment);
      }
    }
    const settledCount = settledAt(i);
    if (settledCount !== settledRef.current) { settledRef.current = settledCount; setSettled(settledCount); }
    const ended = i >= last - 1e-6;
    if (ended !== atEndRef.current) { atEndRef.current = ended; setAtEnd(ended); }

    if (!geo) return;
    const { xs, ys, segments, left, plotBottom, width } = geo;
    const x = xs[n] + (n < last ? (xs[n + 1] - xs[n]) * (i - n) : 0);
    const y = geo.yOf(value);
    const head = `M${xs[0].toFixed(1)} ${ys[0].toFixed(1)}${segments.slice(1, n + 1).join("")}${i > n ? `L${x.toFixed(1)} ${y.toFixed(1)}` : ""}`;
    lineRef.current?.setAttribute("d", head);
    areaRef.current?.setAttribute("d", `${head}L${x.toFixed(1)} ${plotBottom}L${left} ${plotBottom}Z`);
    headRef.current?.setAttribute("transform", `translate(${x.toFixed(2)} 0)`);
    const dot = headRef.current?.lastElementChild;
    dot?.setAttribute("cy", y.toFixed(2));
    if (tipRef.current) {
      tipRef.current.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
      tipRef.current.toggleAttribute("data-flip", x > width - 96);
    }
    setText("tip", tipText.current, formatValue(value));
    const clockX = Math.min(width - 36, Math.max(left + 20, x));
    if (clockRef.current) clockRef.current.style.transform = `translate(${clockX.toFixed(2)}px, ${plotBottom + PAD.bottom / 2}px)`;
    setText("clock", clockText.current, formatTime(time));
    geo.xTicks.forEach((tick, k) => {
      const label = xLabelRefs.current[k];
      // Half the widest clock pill plus half a tick label, so a label never peeks out beside the pill.
      if (label) label.dataset.hidden = String(Math.abs(tick.x - clockX) < 58);
    });
  }, [geo, last, values, times, baselines, peakIdx, marks, passedAt, settledAt, formatTime, formatValue, updateAria, setText]);

  useLayoutEffect(() => {
    lastText.current = {};
    draw(t.get());
    return t.on("change", draw);
  }, [t, draw]);

  // The track width changes with the layout; keep the thumb on the playhead.
  useEffect(() => {
    const node = trackRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => draw(t.get()));
    observer.observe(node);
    return () => observer.disconnect();
  }, [draw, t]);

  /* ---------- Playback ---------- */

  const stopSeek = () => {
    seekAnim.current?.stop();
    seekAnim.current = null;
  };

  const seekTo = useCallback((target: number, smooth: boolean) => {
    seekAnim.current?.stop();
    seekAnim.current = null;
    const clamped = Math.min(last, Math.max(0, target));
    if (!smooth || reduce) { t.set(clamped); return; }
    const anim = animate(t, clamped, { ...motionTokens.spring.smooth, restDelta: 0.001 });
    seekAnim.current = anim;
    anim.then(() => { if (seekAnim.current === anim) seekAnim.current = null; });
  }, [last, reduce, t]);

  useEffect(() => {
    if (!playing) {
      updateAria(t.get());
      return;
    }
    let frame = 0;
    let previous = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.1, (now - previous) / 1000);
      previous = now;
      if (!dragging.current && !seekAnim.current) {
        const next = t.get() + dt * rateRef.current;
        if (next >= last) {
          t.set(last);
          setPlaying(false);
          const peak = peakIdx[last] ?? 0;
          setAnnouncement(`Replay finished. Peak ${formatValue(values[peak])} at ${formatTime(times[peak])}.`);
          return;
        }
        t.set(next);
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing, last, t, peakIdx, values, times, formatTime, formatValue, updateAria]);

  const play = useCallback(() => {
    if (atEndRef.current || t.get() >= last - 1e-6) seekTo(0, true);
    setAnnouncement("Playing");
    setPlaying(true);
  }, [last, seekTo, t]);

  const toggle = () => {
    if (playing) {
      setPlaying(false);
      setAnnouncement(`Paused at ${formatTime(lerpAt(times, t.get()))}`);
    } else play();
  };

  // Optional autoplay, once, when the block first scrolls into view.
  const rootRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const node = rootRef.current;
    if (!autoPlay || reduce || !node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      seekTo(0, false);
      setPlaying(true);
    }, { threshold: 0.4 });
    observer.observe(node);
    return () => observer.disconnect();
  }, [autoPlay, reduce, seekTo]);

  /* ---------- Pointer scrubbing (chart and scrubber) ---------- */

  const indexFromPointer = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.currentTarget.dataset.area === "track") {
      const rect = (trackRef.current ?? event.currentTarget).getBoundingClientRect();
      return ((event.clientX - rect.left) / (rect.width || 1)) * last;
    }
    if (!geo) return t.get();
    const rect = event.currentTarget.getBoundingClientRect();
    const plotW = geo.width - geo.left - PAD.right;
    return ((event.clientX - rect.left - geo.left) / (plotW || 1)) * last;
  };

  const scrubStart = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    stopSeek();
    dragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    t.set(Math.min(last, Math.max(0, indexFromPointer(event))));
    if (event.currentTarget.dataset.area === "track") scrubRef.current?.focus({ preventScroll: true });
  };
  const scrubMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!dragging.current) return;
    t.set(Math.min(last, Math.max(0, indexFromPointer(event))));
  };
  const scrubEnd = (event: ReactPointerEvent<HTMLElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    updateAria(t.get());
  };

  const pointsPerHour = useMemo(() => {
    const span = (times[last] ?? 0) - (times[0] ?? 0);
    return span > 0 ? (last / span) * 60 : 12;
  }, [times, last]);

  const onScrubKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = t.get();
    const hour = pointsPerHour;
    let next: number | null = null;
    switch (event.key) {
      case "ArrowRight": case "ArrowUp": next = Math.floor(current + 1e-6) + (event.shiftKey ? hour : 1); break;
      case "ArrowLeft": case "ArrowDown": next = Math.ceil(current - 1e-6) - (event.shiftKey ? hour : 1); break;
      case "PageUp": next = current + hour; break;
      case "PageDown": next = current - hour; break;
      case "Home": next = 0; break;
      case "End": next = last; break;
      case " ": case "Enter": case "k": case "K":
        event.preventDefault();
        toggle();
        return;
      default: return;
    }
    event.preventDefault();
    seekTo(next, false);
    updateAria(Math.min(last, Math.max(0, next)));
  };

  const jumpTo = (moment: (typeof marks)[number]) => {
    seekTo(moment.index, true);
    setAnnouncement(`Moved to ${formatTime(moment.time)}, ${moment.title}`);
  };

  /* ---------- Render ---------- */

  const latest = passed > 0 ? marks[passed - 1] : null;
  const hoveredMark = hovered ? marks.find((m, k) => m.id === hovered && k < passed) ?? null : null;
  const shown = hoveredMark ?? latest;
  const firstTime = times[0] ?? 0;
  const lastTime = times[last] ?? 0;
  const buttonLabel = playing ? "Pause" : atEnd ? "Replay" : "Play";
  const ButtonIcon = playing ? Pause : atEnd ? RotateCcw : Play;

  let callout: { x: number; y: number; align: "start" | "center" | "end" } | null = null;
  if (shown && geo) {
    const n = Math.floor(shown.index);
    const x = geo.xs[n] + (n < last ? (geo.xs[n + 1] - geo.xs[n]) * (shown.index - n) : 0);
    callout = { x, y: geo.yOf(shown.value), align: x < geo.left + 110 ? "start" : x > geo.width - 120 ? "end" : "center" };
  }

  return (
    <section ref={rootRef} className={[styles.root, className].filter(Boolean).join(" ")} aria-labelledby={titleId}>
      <div className={styles.surface}>
        <div className={styles.main}>
          <header className={styles.header}>
            <div className={styles.heading}>
              <h2 id={titleId}>{title}</h2>
              {description ? <p>{description}</p> : null}
            </div>
            <ul className={styles.legend} aria-label="Legend">
              <li><svg className={styles.swatch} viewBox="0 0 20 8" aria-hidden="true"><line className={styles.swLine} x1="1" y1="4" x2="19" y2="4" /></svg>{seriesLabel}</li>
              {baselines ? <li><svg className={styles.swatch} viewBox="0 0 20 8" aria-hidden="true"><line className={styles.swBase} x1="1" y1="4" x2="19" y2="4" /></svg>{baselineLabel}</li> : null}
            </ul>
          </header>

          <dl className={styles.readout}>
            <div className={styles.readTime}><dt>Time</dt><dd><span ref={readTime}>{initialText.time}</span></dd></div>
            <div><dt>{valueLabel}</dt><dd><span ref={readValue} className={styles.readStrong}>{initialText.value}</span></dd></div>
            {baselines ? <div><dt>Versus {baselineLabel.charAt(0).toLowerCase() + baselineLabel.slice(1)}</dt><dd><span ref={readRatio}>{initialText.ratio}</span></dd></div> : null}
            <div className={styles.readPeak}><dt>Peak so far</dt><dd><span ref={readPeak}>{initialText.peak}</span></dd></div>
          </dl>

          <div
            ref={stageRef}
            className={styles.stage}
            data-ready={geo ? "" : undefined}
            data-area="chart"
            onPointerDown={scrubStart}
            onPointerMove={scrubMove}
            onPointerUp={scrubEnd}
            onPointerCancel={scrubEnd}
            aria-hidden="true"
          >
            {geo ? (
              <svg className={styles.plot} width={geo.width} height={geo.height} viewBox={`0 0 ${geo.width} ${geo.height}`}>
                {geo.yTicks.map(tick => (
                  <g key={tick.value}>
                    <line className={tick.value === 0 ? styles.axis : styles.grid} x1={geo.left} x2={geo.width - PAD.right} y1={Math.round(tick.y) + 0.5} y2={Math.round(tick.y) + 0.5} />
                    <text className={styles.yLabel} x={geo.left - 8} y={tick.y} dy="0.32em">{compactTick(tick.value)}</text>
                  </g>
                ))}
                {geo.xTicks.map((tick, k) => (
                  <text key={tick.time} ref={node => { xLabelRefs.current[k] = node; }} className={styles.xLabel} x={tick.x} y={geo.plotBottom + PAD.bottom / 2} dy="0.32em">{formatTick(tick.time)}</text>
                ))}
                {geo.baseline ? <path className={styles.baseline} d={geo.baseline} /> : null}
                <path ref={areaRef} className={styles.area} />
                {marks.map((m, k) => {
                  const n = Math.floor(m.index);
                  const x = geo.xs[n] + (n < last ? (geo.xs[n + 1] - geo.xs[n]) * (m.index - n) : 0);
                  const y = geo.yOf(m.value);
                  return (
                    <line key={`${m.id}-stem`} className={styles.stem} x1={x} x2={x} y1={y + 6} y2={geo.plotBottom} data-passed={k < passed ? "" : undefined} />
                  );
                })}
                <AnimatePresence initial={false}>
                  {shown && callout ? (
                    <motion.line
                      key={shown.id}
                      className={styles.connector}
                      x1={callout.x}
                      x2={callout.x}
                      y1={LANE_BOTTOM}
                      y2={Math.max(LANE_BOTTOM, callout.y - 7)}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0, transition: { duration: motionTokens.duration.exit } }}
                      transition={{ duration: reduce ? motionTokens.duration.instant : motionTokens.duration.standard }}
                    />
                  ) : null}
                </AnimatePresence>
                <path ref={lineRef} className={styles.line} />
                {marks.map((m, k) => {
                  const n = Math.floor(m.index);
                  const x = geo.xs[n] + (n < last ? (geo.xs[n + 1] - geo.xs[n]) * (m.index - n) : 0);
                  const y = geo.yOf(m.value);
                  return (
                    <circle
                      key={m.id}
                      className={styles.mark}
                      cx={x}
                      cy={y}
                      r={4}
                      data-passed={k < passed ? "" : undefined}
                      data-shown={shown?.id === m.id ? "" : undefined}
                      data-incident={m.kind === "incident" ? "" : undefined}
                    />
                  );
                })}
                <g ref={headRef} className={styles.head}>
                  <line className={styles.playhead} x1={0} x2={0} y1={PAD.top} y2={geo.plotBottom} />
                  <circle className={styles.tipDot} cx={0} cy={0} r={4.5} />
                </g>
              </svg>
            ) : null}

            <div ref={tipRef} className={styles.anchor}>
              <span className={styles.tip}><span ref={tipText} className={styles.num}>{initialText.value}</span></span>
            </div>
            <div ref={clockRef} className={styles.anchor}>
              <span className={styles.clock}><span ref={clockText} className={styles.num}>{initialText.time}</span></span>
            </div>

            <AnimatePresence initial={false}>
              {shown && callout ? (
                <div
                  key={shown.id}
                  className={styles.calloutAnchor}
                  style={{ left: callout.x, top: LANE_BOTTOM }}
                  data-align={callout.align}
                >
                  <motion.div
                    className={styles.callout}
                    data-incident={shown.kind === "incident" ? "" : undefined}
                    initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, transition: { duration: motionTokens.duration.exit, ease: [...motionTokens.ease.exit] } }}
                    transition={reduce ? { duration: motionTokens.duration.instant } : motionTokens.spring.smooth}
                  >
                    <span className={styles.calloutTitle}>{shown.title}</span>
                    <span className={styles.calloutTime}>{formatTime(shown.time)}</span>
                  </motion.div>
                </div>
              ) : null}
            </AnimatePresence>
          </div>

          <div className={styles.transport}>
            <Button variant="primary" className={styles.playButton} onClick={toggle} aria-label={playing ? "Pause replay" : atEnd ? "Replay from the start" : "Play replay"}>
              <ButtonIcon size={16} strokeWidth={1.75} aria-hidden="true" />
              <span className={styles.playLabel}>{buttonLabel}</span>
            </Button>
            <div
              className={styles.scrub}
              data-area="track"
              onPointerDown={scrubStart}
              onPointerMove={scrubMove}
              onPointerUp={scrubEnd}
              onPointerCancel={scrubEnd}
            >
              <div
                ref={scrubRef}
                className={styles.scrubFocus}
                role="slider"
                tabIndex={0}
                aria-label="Replay position"
                aria-valuemin={Math.round(firstTime)}
                aria-valuemax={Math.round(lastTime)}
                aria-valuenow={Math.round(lerpAt(times, startIndex))}
                aria-valuetext={`${initialText.time}, ${initialText.value} ${valueLabel.toLowerCase()}`}
                aria-describedby={momentsId}
                onKeyDown={onScrubKey}
              >
                <div ref={trackRef} className={styles.track}>
                  <div ref={fillRef} className={styles.fill} style={{ transform: `scaleX(${initialText.fraction})` }} />
                  {marks.map((m, k) => (
                    <span key={m.id} className={styles.tick} style={{ left: `${(last ? m.index / last : 0) * 100}%` }} data-passed={k < passed ? "" : undefined} data-incident={m.kind === "incident" ? "" : undefined} />
                  ))}
                  <div ref={thumbRef} className={styles.thumbRail}><span className={styles.thumb} /></div>
                </div>
              </div>
            </div>
            <SegmentedControl
              className={styles.speed}
              label="Playback speed"
              options={SPEEDS}
              value={String(speed)}
              onValueChange={value => setSpeed(Number(value) as ReplaySpeed)}
            />
          </div>
        </div>

        <aside className={styles.aside} aria-labelledby={momentsId}>
          <h3 id={momentsId} className={styles.asideTitle}>Key moments</h3>
          <ol className={styles.moments}>
            {marks.map((m, k) => {
              const Icon = KIND_ICON[m.kind ?? "launch"];
              const state = k < passed ? (k === passed - 1 ? "current" : "passed") : "upcoming";
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    className={styles.moment}
                    data-state={state}
                    data-incident={m.kind === "incident" ? "" : undefined}
                    aria-current={state === "current" ? "true" : undefined}
                    onClick={() => jumpTo(m)}
                    onPointerEnter={() => setHovered(m.id)}
                    onPointerLeave={() => setHovered(h => (h === m.id ? null : h))}
                    onFocus={() => setHovered(m.id)}
                    onBlur={() => setHovered(h => (h === m.id ? null : h))}
                  >
                    <Icon className={styles.momentIcon} size={16} strokeWidth={1.75} aria-hidden="true" />
                    <span className={styles.momentBody}>
                      <span className={styles.momentTop}>
                        <span className={styles.momentTitle}>{m.title}</span>
                        <span className={styles.momentTime}>{formatTime(m.time)}</span>
                      </span>
                      {m.detail ? <span className={styles.momentDetail}>{m.detail}</span> : null}
                      <span className={styles.momentEffect} data-settled={settled[k] === "1" ? "" : undefined} aria-hidden={settled[k] === "1" ? undefined : true}>{m.effect}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </aside>
      </div>
      <p className={styles.srOnly} aria-live="polite">{announcement}</p>
    </section>
  );
}

export default LineReplay;
