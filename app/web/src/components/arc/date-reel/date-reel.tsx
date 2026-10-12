"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useReducedMotion } from "motion/react";
import { Check, LoaderCircle } from "lucide-react";
import styles from "./date-reel.module.css";

export type DateReelMode = "datetime" | "date" | "time";

export interface DateReelPreset {
  /** Chip text, such as "Tomorrow morning". */
  label: string;
  /** The moment the reels spin to. A function receives the start of today. */
  value: Date | ((today: Date) => Date);
}

export interface DateReelLabels {
  day?: string;
  month?: string;
  date?: string;
  year?: string;
  hour?: string;
  minute?: string;
  period?: string;
  /** Joins the day and the time in the summary, as in "Tomorrow at 9:30 AM". */
  at?: string;
  presets?: string;
  confirm?: string;
  pending?: string;
  done?: string;
  failed?: string;
}

/**
 * A 3D reel date and time picker. Each column is a curved drum you can flick, drag, scroll or step with the keyboard. It keeps
 * the momentum you give it, glides to rest and snaps into a glass lens, while a summary above reads the moment back in words.
 */
export interface DateReelProps {
  /** Which reels to show: day plus time, month, day and year, or time only. */
  mode?: DateReelMode;
  /** Controlled value. The reels spin to it when it changes. */
  value?: Date;
  /** Starting value when uncontrolled. */
  defaultValue?: Date;
  /** Called when the reels come to rest on a new moment. */
  onChange?: (value: Date) => void;
  /** Start of today, used for "Today" and relative words. Defaults to the day of the first value. Pass `new Date()` after mount in an app. */
  today?: Date;
  /** Earliest selectable day. Defaults to 30 days before today (100 years before in date mode). */
  minDate?: Date;
  /** Latest selectable day. Defaults to a year after today (10 years after in date mode). */
  maxDate?: Date;
  /** Minutes between entries on the minute reel. */
  minuteStep?: 1 | 5 | 10 | 15 | 30;
  /** 12 or 24 hour clock. */
  hourCycle?: 12 | 24;
  /** BCP 47 locale for names, numbers and relative words. */
  locale?: string;
  /** Quick picks under the reels. Choosing one spins every reel to it. Pass false to hide them. */
  presets?: readonly DateReelPreset[] | false;
  /** Optional heading above the summary. */
  title?: string;
  /** Adds a primary button that confirms the moment in place. Return a promise to show pending, success and failure. */
  onConfirm?: (value: Date) => void | Promise<void>;
  /** Visible and accessible words, for localization. */
  labels?: DateReelLabels;
  /** Spins the reels into place the first time they scroll into view. */
  intro?: boolean;
  /** Multiplies the speed of glides, snaps and the intro. */
  speed?: number;
  /** Stops automatic motion. Reels still follow a drag and snap straight to rest. */
  paused?: boolean;
  /** Any CSS color for the active reel and the chosen preset. Defaults to the accent token. */
  accent?: string;
  /** Accessible name of the picker. */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

type ColumnKey = "day" | "month" | "date" | "year" | "hour" | "minute" | "period";

interface ColumnSpec {
  key: ColumnKey;
  name: string;
  count: number;
  loop: boolean;
  align: "start" | "center" | "end";
  page: number;
  /** Every differently shaped entry, stacked invisibly so the reel is as wide as its widest glyphs, not its longest string. */
  sizer: string[];
  label: (index: number) => string;
}

const Mode = { Idle: 0, Drag: 1, Decay: 2, Spring: 3, Wheel: 4 } as const;
type Mode = (typeof Mode)[keyof typeof Mode];

interface Reel {
  p: number;
  v: number;
  mode: Mode;
  target: number;
  k: number;
  stiff: number;
  damp: number;
  delay: number;
  wheelAt: number;
  samples: { t: number; p: number }[];
}

const DAY_MS = 86_400_000;
const SLOTS = 11;
const HALF = (SLOTS - 1) / 2;
const STEP_DEG = 20;
const STEP = (STEP_DEG * Math.PI) / 180;
const RADIUS = 1 / (2 * Math.sin(STEP / 2));
const FALLBACK_VALUE = new Date(2026, 8, 24, 9, 30);

const mod = (value: number, size: number) => ((value % size) + size) % size;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes());
const dayDiff = (a: Date, b: Date) => Math.round((startOfDay(a).getTime() - startOfDay(b).getTime()) / DAY_MS);
const daysIn = (year: number, month: number) => new Date(year, month + 1, 0).getDate();
const capital = (text: string) => text.charAt(0).toLocaleUpperCase() + text.slice(1);
const pad = (value: number) => String(value).padStart(2, "0");
const freshReel = (p: number): Reel => ({ p, v: 0, mode: Mode.Idle, target: p, k: 0, stiff: 0, damp: 0, delay: 0, wheelAt: 0, samples: [] });
const rubber = (over: number) => (over * 0.55 * 2.4) / (2.4 + 0.55 * over);

const defaultPresets: DateReelPreset[] = [
  { label: "This evening", value: today => new Date(today.getFullYear(), today.getMonth(), today.getDate(), 18, 0) },
  { label: "Tomorrow", value: today => new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, 9, 0) },
  { label: "Monday", value: today => new Date(today.getFullYear(), today.getMonth(), today.getDate() + (((8 - today.getDay()) % 7) || 7), 9, 0) },
];

const defaultLabels: Required<DateReelLabels> = {
  day: "Day", month: "Month", date: "Day of month", year: "Year", hour: "Hour", minute: "Minute", period: "AM or PM",
  at: "at", presets: "Quick picks", confirm: "Schedule", pending: "Scheduling", done: "Scheduled", failed: "Try again",
};

function makeFormatters(locale: string, hourCycle: 12 | 24) {
  const safe = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, options);
  const period = safe({ hour: "numeric", hour12: true });
  const periodOf = (hour: number) => period.formatToParts(new Date(2026, 0, 1, hour)).find(part => part.type === "dayPeriod")?.value ?? (hour < 12 ? "AM" : "PM");
  return {
    dayLabel: safe({ weekday: "short", month: "short", day: "numeric" }),
    month: safe({ month: "long" }),
    time: safe({ hour: "numeric", minute: "2-digit", hour12: hourCycle === 12 }),
    full: safe({ weekday: "long", month: "long", day: "numeric", year: "numeric" }),
    shortDay: safe({ weekday: "long" }),
    monthDay: safe({ weekday: "short", month: "short", day: "numeric" }),
    relative: new Intl.RelativeTimeFormat(locale, { numeric: "auto" }),
    periods: [periodOf(9), periodOf(21)] as const,
  };
}

type Formatters = ReturnType<typeof makeFormatters>;

function relativeDay(date: Date, today: Date, f: Formatters) {
  const diff = dayDiff(date, today);
  if (Math.abs(diff) <= 1) return capital(f.relative.format(diff, "day"));
  if (diff > 1 && diff < 7) return f.shortDay.format(date);
  return f.monthDay.format(date);
}

function relativeSpan(date: Date, today: Date, f: Formatters) {
  const diff = dayDiff(date, today);
  if (Math.abs(diff) < 45) return capital(f.relative.format(diff, "day"));
  const months = (date.getFullYear() - today.getFullYear()) * 12 + date.getMonth() - today.getMonth();
  if (Math.abs(months) < 18) return capital(f.relative.format(months, "month"));
  return capital(f.relative.format(Math.trunc(months / 12), "year"));
}

/** Screen summary of a moment: a short headline and a quieter line. */
function describe(date: Date, mode: DateReelMode, today: Date, f: Formatters, at: string) {
  if (mode === "date") return { headline: f.full.format(date).replace(/,? \d{4}$/, ""), detail: `${relativeSpan(date, today, f)}, ${date.getFullYear()}` };
  const time = f.time.format(date);
  if (mode === "time") return { headline: time, detail: f.full.format(date) };
  return { headline: `${relativeDay(date, today, f)} ${at} ${time}`, detail: f.full.format(date) };
}

function buildColumns(mode: DateReelMode, f: Formatters, min: Date, dayCount: number, today: Date, minYear: number, yearCount: number, step: number, cycle: 12 | 24, L: Required<DateReelLabels>): ColumnSpec[] {
  const minuteCount = 60 / step;
  const hour: ColumnSpec = cycle === 12
    ? { key: "hour", name: L.hour, count: 12, loop: true, align: "end", page: 3, sizer: ["12"], label: i => String(i === 0 ? 12 : i) }
    : { key: "hour", name: L.hour, count: 24, loop: true, align: "end", page: 6, sizer: ["00"], label: pad };
  const minute: ColumnSpec = { key: "minute", name: L.minute, count: minuteCount, loop: true, align: "start", page: Math.max(1, Math.round(15 / step)), sizer: ["00"], label: i => pad(i * step) };
  const period: ColumnSpec = { key: "period", name: L.period, count: 2, loop: false, align: "start", page: 1, sizer: [...f.periods], label: i => f.periods[i] ?? "" };
  const time = cycle === 12 ? [hour, minute, period] : [hour, minute];
  if (mode === "time") return time;
  if (mode === "date") {
    const months = Array.from({ length: 12 }, (_, m) => f.month.format(new Date(2026, m, 1)));
    return [
      { key: "month", name: L.month, count: 12, loop: true, align: "start", page: 3, sizer: months, label: i => months[i] },
      { key: "date", name: L.date, count: 31, loop: true, align: "end", page: 7, sizer: ["00"], label: i => String(i + 1) },
      { key: "year", name: L.year, count: yearCount, loop: false, align: "start", page: 10, sizer: ["0000"], label: i => String(minYear + i) },
    ];
  }
  const todayIndex = dayDiff(today, min);
  const todayWord = capital(f.relative.format(0, "day"));
  const dayLabel = (i: number) => (i === todayIndex ? todayWord : f.dayLabel.format(addDays(min, i)));
  // Digits are tabular, so one entry per weekday and month pair covers every width the reel can show.
  const shapes = new Map<string, string>([[todayWord, todayWord]]);
  for (let i = 0; i < Math.min(dayCount, 400); i++) { const text = dayLabel(i).replace(/\d/g, "0"); if (!shapes.has(text)) shapes.set(text, text); }
  const sizer = [...shapes.values()];
  return [{ key: "day", name: L.day, count: dayCount, loop: false, align: "end", page: 7, sizer, label: dayLabel }, ...time];
}

function indexesOf(date: Date, mode: DateReelMode, min: Date, minYear: number, yearCount: number, dayCount: number, step: number, cycle: 12 | 24) {
  const minuteCount = 60 / step;
  const minute = Math.min(minuteCount - 1, Math.round(date.getMinutes() / step));
  const h = date.getHours();
  const time = cycle === 12 ? [h % 12, minute, h >= 12 ? 1 : 0] : [h, minute];
  if (mode === "time") return time;
  if (mode === "date") return [date.getMonth(), date.getDate() - 1, clamp(date.getFullYear() - minYear, 0, yearCount - 1)];
  return [clamp(dayDiff(date, min), 0, dayCount - 1), ...time];
}

export function DateReel({
  mode = "datetime",
  value,
  defaultValue,
  onChange,
  today: todayProp,
  minDate,
  maxDate,
  minuteStep = 5,
  hourCycle = 12,
  locale = "en-US",
  presets = defaultPresets,
  title,
  onConfirm,
  labels,
  intro = true,
  speed = 1,
  paused = false,
  accent,
  label,
  className,
  style,
}: DateReelProps) {
  const L = useMemo(() => ({ ...defaultLabels, ...labels }), [labels]);
  const reduced = useReducedMotion() ?? false;
  const id = useId();
  const [initial] = useState(() => value ?? defaultValue ?? FALLBACK_VALUE);
  const [committed, setCommitted] = useState(initial);
  const [announce, setAnnounce] = useState("");
  const [confirm, setConfirm] = useState<"idle" | "pending" | "done" | "failed">("idle");
  const [focusCol, setFocusCol] = useState(-1);

  const todayTime = startOfDay(todayProp ?? initial).getTime();
  const today = useMemo(() => new Date(todayTime), [todayTime]);
  const minTime = startOfDay(minDate ?? (mode === "date" ? new Date(today.getFullYear() - 100, 0, 1) : addDays(today, -30))).getTime();
  const maxTime = startOfDay(maxDate ?? (mode === "date" ? new Date(today.getFullYear() + 10, 11, 31) : addDays(today, 365))).getTime();
  const min = useMemo(() => new Date(minTime), [minTime]);
  const max = useMemo(() => new Date(Math.max(minTime, maxTime)), [minTime, maxTime]);
  const dayCount = dayDiff(max, min) + 1;
  const minYear = min.getFullYear();
  const yearCount = max.getFullYear() - minYear + 1;

  const f = useMemo(() => makeFormatters(locale, hourCycle), [locale, hourCycle]);
  const columns = useMemo(() => buildColumns(mode, f, min, dayCount, today, minYear, yearCount, minuteStep, hourCycle, L), [mode, f, min, dayCount, today, minYear, yearCount, minuteStep, hourCycle, L]);
  const toIndexes = useCallback((date: Date) => indexesOf(date, mode, min, minYear, yearCount, dayCount, minuteStep, hourCycle), [mode, min, minYear, yearCount, dayCount, minuteStep, hourCycle]);

  /** The moment the given reel indexes point at. Days past the end of a month clamp to its last day. */
  const fromIndexes = useCallback((idx: number[], base: Date) => {
    const time = (hi: number, mi: number, pi?: number) => ({ h: hourCycle === 12 ? mod(hi, 12) + (pi === 1 ? 12 : 0) : mod(hi, 24), m: mod(mi, 60 / minuteStep) * minuteStep });
    if (mode === "date") {
      const year = minYear + clamp(idx[2], 0, yearCount - 1), month = mod(idx[0], 12);
      return new Date(year, month, Math.min(mod(idx[1], 31) + 1, daysIn(year, month)), base.getHours(), base.getMinutes());
    }
    if (mode === "time") { const t = time(idx[0], idx[1], idx[2]); return new Date(base.getFullYear(), base.getMonth(), base.getDate(), t.h, t.m); }
    const day = addDays(min, clamp(idx[0], 0, dayCount - 1)), t = time(idx[1], idx[2], idx[3]);
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), t.h, t.m);
  }, [mode, hourCycle, minuteStep, minYear, yearCount, min, dayCount]);

  const rootRef = useRef<HTMLDivElement>(null);
  const colRefs = useRef<(HTMLDivElement | null)[]>([]);
  const baseRefs = useRef<(HTMLSpanElement | null)[][]>([]);
  const lensRefs = useRef<(HTMLSpanElement | null)[][]>([]);
  const slotText = useRef<string[][]>([]);
  const slotOff = useRef<boolean[][]>([]);
  const headlineRef = useRef<HTMLSpanElement>(null);
  const detailRef = useRef<HTMLSpanElement>(null);
  const rowPx = useRef(36);
  const [reels] = useState(() => {
    const idx = indexesOf(initial, mode, min, minYear, yearCount, dayCount, minuteStep, hourCycle);
    return { current: idx.map(freshReel) };
  });
  const frame = useRef(0);
  const last = useRef(0);
  const inView = useRef(false);
  const introPending = useRef(intro);
  const dirty = useRef(false);
  const userMoved = useRef(false);
  const shownKey = useRef("");
  /** While the reels spin on their own (intro, quick pick, outside value), the summary shows where they will land instead of every entry they pass. */
  const pinned = useRef<Date | null>(null);
  const committedRef = useRef(committed);
  const drag = useRef<{ col: number; pointer: number; y: number; p: number; moved: boolean } | null>(null);
  const typed = useRef({ text: "", at: 0 });
  const wheelTimers = useRef<number[]>([]);

  const instant = reduced || paused;
  const live = useRef({ columns, fromIndexes, toIndexes, f, today, mode, L, instant, speed, onChange });
  useLayoutEffect(() => { live.current = { columns, fromIndexes, toIndexes, f, today, mode, L, instant, speed, onChange }; });

  const shape = columns.map(c => `${c.key}:${c.count}`).join("|");

  const liveIndexes = () => reels.current.map((reel, i) => {
    const c = live.current.columns[i];
    const n = Math.round(reel.p);
    return c.loop ? mod(n, c.count) : clamp(n, 0, c.count - 1);
  });

  const paint = useCallback(() => {
    const { columns: cols, fromIndexes: build, f: fmt, today: now, mode: m, L: words } = live.current;
    const row = rowPx.current, radius = RADIUS * row;
    let dayLimit = 31;
    if (m === "date") {
      const mi = cols.findIndex(c => c.key === "month"), yi = cols.findIndex(c => c.key === "year");
      const month = mod(Math.round(reels.current[mi]?.p ?? 0), 12);
      const year = Number(cols[yi]?.label(clamp(Math.round(reels.current[yi]?.p ?? 0), 0, cols[yi].count - 1)) ?? 2026);
      dayLimit = daysIn(year, month);
    }
    cols.forEach((col, c) => {
      const reel = reels.current[c];
      if (!reel) return;
      const base = Math.round(reel.p);
      const texts = (slotText.current[c] ??= []);
      const offs = (slotOff.current[c] ??= []);
      for (let s = 0; s < SLOTS; s++) {
        const item = base + s - HALF;
        const d = item - reel.p;
        const angle = d * STEP;
        const b = baseRefs.current[c]?.[s], l = lensRefs.current[c]?.[s];
        if (!b || !l) continue;
        const outside = !col.loop && (item < 0 || item >= col.count);
        const idx = col.loop ? mod(item, col.count) : item;
        const text = outside ? "" : col.label(idx);
        if (texts[s] !== text) { texts[s] = text; b.textContent = text; l.textContent = text; }
        const off = col.key === "date" && idx + 1 > dayLimit;
        if (offs[s] !== off) { offs[s] = off; b.toggleAttribute("data-off", off); l.toggleAttribute("data-off", off); }
        if (Math.abs(angle) >= Math.PI / 2) { b.style.opacity = "0"; l.style.opacity = "0"; continue; }
        const cos = Math.cos(angle);
        // Rows turning away also recede a little, as they would through a lens, so the far rows narrow instead of looking stretched.
        const depth = 4 / (5 - cos);
        const transform = `translate3d(0, ${(radius * Math.sin(angle)).toFixed(2)}px, 0) scale(${depth.toFixed(4)}, ${(cos * depth).toFixed(4)})`;
        b.style.transform = transform;
        l.style.transform = transform;
        b.style.opacity = (cos ** 1.5).toFixed(3);
        l.style.opacity = "1";
      }
    });
    const idx = liveIndexes();
    const key = pinned.current ? `pin:${pinned.current.getTime()}` : idx.join(",");
    if (key !== shownKey.current) {
      shownKey.current = key;
      const summary = describe(pinned.current ?? build(idx, committedRef.current), m, now, fmt, words.at);
      if (headlineRef.current) headlineRef.current.textContent = summary.headline;
      if (detailRef.current) detailRef.current.textContent = summary.detail;
    }
    // Reads only refs and the live snapshot, so it never needs to change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Called whenever every reel is at rest after a change. Fixes impossible dates, then commits once. */
  const settle = useCallback(() => {
    const { columns: cols, fromIndexes: build, mode: m, f: fmt, today: now, L: words, instant: still } = live.current;
    dirty.current = false;
    const idx = liveIndexes();
    if (m === "date") {
      const di = cols.findIndex(c => c.key === "date");
      const want = build(idx, committedRef.current).getDate() - 1;
      if (idx[di] !== want) {
        const reel = reels.current[di];
        const target = Math.round(reel.p) - (idx[di] - want);
        if (still) { reel.p = target; reel.target = target; paint(); }
        else { reel.target = target; reel.mode = Mode.Spring; reel.stiff = 300; reel.damp = 2 * Math.sqrt(300); dirty.current = true; start(); return; }
      }
    }
    const next = build(liveIndexes(), committedRef.current);
    if (next.getTime() === committedRef.current.getTime()) return;
    committedRef.current = next;
    setCommitted(next);
    if (userMoved.current) {
      const summary = describe(next, m, now, fmt, words.at);
      setAnnounce(`${summary.headline}. ${summary.detail}`);
      setConfirm(state => (state === "idle" ? state : "idle"));
      live.current.onChange?.(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paint]);

  const tick = useCallback((now: number) => {
    const dtRaw = Math.min(0.05, (now - (last.current || now)) / 1000);
    last.current = now;
    const dt = dtRaw * live.current.speed;
    let active = false;
    for (const reel of reels.current) {
      if (reel.mode === Mode.Idle) continue;
      active = true;
      if (reel.mode === Mode.Drag) continue;
      if (reel.delay > 0) { reel.delay -= dt; continue; }
      if (reel.mode === Mode.Wheel) {
        // Wheel notches and trackpad deltas move a target; the reel eases after it so a notch never jumps a whole row in one frame.
        const prev = reel.p;
        reel.p += (reel.target - reel.p) * (1 - Math.exp(-22 * dt));
        reel.v = dt > 0 ? (reel.p - prev) / dt : 0;
        if (now - reel.wheelAt > 100) { reel.mode = Mode.Spring; reel.target = snapTarget(reels.current.indexOf(reel), reel.target); reel.stiff = 260; reel.damp = 2 * Math.sqrt(260); }
        continue;
      }
      if (reel.mode === Mode.Decay) {
        const gap = (reel.target - reel.p) * Math.exp(-reel.k * dt);
        reel.p = reel.target - gap;
        reel.v = reel.k * gap;
        // The last half row hands over to a critically damped spring, so the glide lands promptly instead of creeping. Keeping the
        // spring under twice the glide rate means it never speeds the reel up at the handover.
        if (Math.abs(gap) < 0.45) { const w = Math.min(Math.max(reel.k, 8), 1.75 * reel.k); reel.mode = Mode.Spring; reel.stiff = w * w; reel.damp = 2 * w; }
        continue;
      }
      const h = 1 / 240;
      for (let t = 0; t < dt; t += h) {
        const step = Math.min(h, dt - t);
        reel.v += (-reel.stiff * (reel.p - reel.target) - reel.damp * reel.v) * step;
        reel.p += reel.v * step;
      }
      if (Math.abs(reel.p - reel.target) < 0.0015 && Math.abs(reel.v) < 0.02) { reel.p = reel.target; reel.v = 0; reel.mode = Mode.Idle; }
    }
    paint();
    if (active) frame.current = requestAnimationFrame(tick);
    else { frame.current = 0; last.current = 0; if (pinned.current) { pinned.current = null; paint(); } if (dirty.current) settle(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paint, settle]);

  function start() {
    if (frame.current || !inView.current || document.hidden) return;
    frame.current = requestAnimationFrame(tick);
  }

  function snapTarget(c: number, p: number) {
    const col = live.current.columns[c];
    const n = Math.round(p);
    return col.loop ? n : clamp(n, 0, col.count - 1);
  }

  /** Spins one reel to an absolute position, or jumps there with reduced motion. */
  function spinTo(c: number, target: number, stiffness = 260, delay = 0) {
    const reel = reels.current[c];
    if (!reel) return;
    dirty.current = true;
    if (live.current.instant) {
      reel.p = target; reel.target = target; reel.v = 0; reel.mode = Mode.Idle;
      paint();
      if (!frame.current) settle();
      return;
    }
    reel.target = target; reel.mode = Mode.Spring; reel.stiff = stiffness; reel.damp = 2 * Math.sqrt(stiffness); reel.delay = delay;
    start();
  }

  /** Spins every reel to a moment, taking the short way around looping reels. */
  const goTo = (date: Date, stagger = 0) => {
    const idx = live.current.toIndexes(date);
    if (!live.current.instant) { pinned.current = live.current.fromIndexes(idx, committedRef.current); shownKey.current = ""; }
    live.current.columns.forEach((col, c) => {
      const reel = reels.current[c];
      const target = col.loop ? Math.round(reel.target) + ((mod(idx[c] - Math.round(reel.target), col.count) + col.count / 2) % col.count) - col.count / 2 : idx[c];
      spinTo(c, Math.round(target), 150, stagger * c);
    });
  };

  // Keep the committed value in step with a controlled value; spin the reels when it changes from outside.
  const valueTime = value?.getTime();
  useEffect(() => {
    if (valueTime === undefined || valueTime === committedRef.current.getTime()) return;
    const next = new Date(valueTime);
    userMoved.current = false;
    goTo(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueTime]);

  // Rebuild positions when the columns change shape (mode, step, cycle, range).
  const shapeRef = useRef(shape);
  useLayoutEffect(() => {
    if (shapeRef.current === shape) return;
    shapeRef.current = shape;
    const idx = toIndexes(committedRef.current);
    reels.current = idx.map(freshReel);
    slotText.current = [];
    slotOff.current = [];
    shownKey.current = "";
    paint();
  }, [shape, columns, toIndexes, paint, reels]);

  // Measure the row height (it follows container queries), watch visibility, and play the intro once.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (!introPending.current || live.current.instant) root.removeAttribute("data-intro");
    const measure = () => {
      const probe = root.querySelector<HTMLElement>("[data-row]");
      const next = probe?.getBoundingClientRect().height || 36;
      if (Math.abs(next - rowPx.current) > 0.1) { rowPx.current = next; paint(); }
    };
    measure();
    paint();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    const io = new IntersectionObserver(([entry]) => {
      inView.current = entry.isIntersecting;
      if (!entry.isIntersecting) { cancelAnimationFrame(frame.current); frame.current = 0; last.current = 0; return; }
      if (introPending.current) {
        introPending.current = false;
        if (!live.current.instant) {
          // The rows start hidden (data-intro) and fade in as each reel is flicked into place, so nothing jumps after hydration.
          live.current.columns.forEach((col, c) => {
            const reel = reels.current[c];
            const from = col.loop ? reel.p - (5 + c * 2) : reel.p >= 1 ? Math.max(0, reel.p - 6) : Math.min(col.count - 1, reel.p + 6);
            if (from === reel.p) return;
            const target = reel.p;
            reel.p = from;
            reel.target = target; reel.mode = Mode.Decay; reel.k = 3; reel.delay = 0.07 * c;
          });
          pinned.current = committedRef.current;
          shownKey.current = "";
          paint();
        }
        root.removeAttribute("data-intro");
      }
      if (reels.current.some(reel => reel.mode !== Mode.Idle)) start();
    }, { threshold: 0.25 });
    io.observe(root);
    const onVisibility = () => {
      if (document.hidden) { cancelAnimationFrame(frame.current); frame.current = 0; last.current = 0; }
      else if (reels.current.some(reel => reel.mode !== Mode.Idle)) start();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { ro.disconnect(); io.disconnect(); document.removeEventListener("visibilitychange", onVisibility); cancelAnimationFrame(frame.current); frame.current = 0; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paint]);

  // Pausing or reducing motion lands every moving reel on its target at once.
  useEffect(() => {
    if (!instant) { if (reels.current.some(reel => reel.mode !== Mode.Idle && reel.mode !== Mode.Drag)) start(); return; }
    let moved = false;
    reels.current.forEach((reel, c) => { if (reel.mode === Mode.Decay || reel.mode === Mode.Spring || reel.mode === Mode.Wheel) { reel.p = reel.mode === Mode.Wheel ? snapTarget(c, reel.target) : reel.target; reel.v = 0; reel.mode = Mode.Idle; moved = true; } });
    if (moved) { cancelAnimationFrame(frame.current); frame.current = 0; paint(); settle(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instant]);

  // Wheel and trackpad scrolling, attached natively so the page does not scroll under the reel.
  useEffect(() => {
    const cleanups = colRefs.current.map((el, c) => {
      if (!el) return () => {};
      const onWheel = (event: WheelEvent) => {
        if (Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
        event.preventDefault();
        const reel = reels.current[c], col = live.current.columns[c];
        if (!reel || !col || reel.mode === Mode.Drag) return;
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 240 : 1;
        const delta = (event.deltaY * unit) / (rowPx.current * 1.4);
        userMoved.current = true;
        dirty.current = true;
        pinned.current = null;
        if (!live.current.instant) {
          if (reel.mode !== Mode.Wheel) reel.target = reel.p;
          reel.target += delta;
          if (!col.loop) reel.target = clamp(reel.target, -0.35, col.count - 0.65);
          reel.mode = Mode.Wheel;
          reel.wheelAt = performance.now();
          start();
          return;
        }
        reel.p += delta;
        if (!col.loop) reel.p = clamp(reel.p, -0.35, col.count - 0.65);
        reel.v = 0;
        reel.target = reel.p;
        reel.mode = Mode.Wheel;
        reel.wheelAt = performance.now();
        paint();
        window.clearTimeout(wheelTimers.current[c]);
        wheelTimers.current[c] = window.setTimeout(() => { reel.p = snapTarget(c, reel.p); reel.target = reel.p; reel.mode = Mode.Idle; paint(); settle(); }, 140);
      };
      el.addEventListener("wheel", onWheel, { passive: false });
      return () => el.removeEventListener("wheel", onWheel);
    });
    return () => cleanups.forEach(clean => clean());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);

  const onPointerDown = (c: number) => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || drag.current) return;
    const reel = reels.current[c];
    if (!reel) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    reel.mode = Mode.Drag;
    reel.v = 0;
    reel.samples = [{ t: performance.now(), p: reel.p }];
    drag.current = { col: c, pointer: event.pointerId, y: event.clientY, p: reel.p, moved: false };
    pinned.current = null;
    userMoved.current = true;
    dirty.current = true;
    rootRef.current?.setAttribute("data-dragging", "");
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== event.pointerId) return;
    const reel = reels.current[d.col], col = live.current.columns[d.col];
    const dy = event.clientY - d.y;
    if (Math.abs(dy) > 3) d.moved = true;
    let p = d.p - dy / rowPx.current;
    if (!col.loop) {
      if (p < 0) p = -rubber(-p);
      else if (p > col.count - 1) p = col.count - 1 + rubber(p - (col.count - 1));
    }
    reel.p = p;
    const now = performance.now();
    reel.samples.push({ t: now, p });
    while (reel.samples.length > 2 && now - reel.samples[0].t > 100) reel.samples.shift();
    if (inView.current) { if (!frame.current) frame.current = requestAnimationFrame(tick); }
    else paint();
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== event.pointerId) return;
    drag.current = null;
    rootRef.current?.removeAttribute("data-dragging");
    const c = d.col, reel = reels.current[c], col = live.current.columns[c];
    if (!d.moved) {
      // A tap lands the item under the pointer in the lens.
      const rect = event.currentTarget.getBoundingClientRect();
      const offset = clamp((event.clientY - (rect.top + rect.height / 2)) / (RADIUS * rowPx.current), -0.98, 0.98);
      const steps = Math.round(Math.asin(offset) / STEP);
      reel.mode = Mode.Idle;
      spinTo(c, snapTarget(c, Math.round(reel.p) + steps));
      return;
    }
    const now = performance.now();
    const first = reel.samples[0], lastSample = reel.samples[reel.samples.length - 1];
    let v = first && lastSample && lastSample.t - first.t > 8 && now - lastSample.t < 90 ? (lastSample.p - first.p) / ((lastSample.t - first.t) / 1000) : 0;
    v = clamp(v, -60, 60);
    if (live.current.instant) { reel.mode = Mode.Idle; reel.p = snapTarget(c, reel.p + v * 0.3); reel.target = reel.p; paint(); settle(); return; }
    const outOfRange = !col.loop && (reel.p < 0 || reel.p > col.count - 1);
    const projected = snapTarget(c, reel.p + v * 0.32);
    reel.v = v;
    if (outOfRange || Math.abs(v) < 0.5) { reel.mode = Mode.Spring; reel.target = snapTarget(c, reel.p); reel.stiff = 260; reel.damp = 2 * Math.sqrt(260); }
    else {
      const k = v / (projected - reel.p);
      const clamped = !col.loop && Math.round(reel.p + v * 0.32) !== projected;
      if (!clamped && k > 2.2 && k < 14) { reel.mode = Mode.Decay; reel.target = projected; reel.k = k; }
      else { reel.mode = Mode.Spring; reel.target = projected; reel.stiff = 170; reel.damp = 2 * Math.sqrt(170) * (clamped ? 0.62 : 1); }
    }
    start();
  };

  const onKeyDown = (c: number) => (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const col = live.current.columns[c], reel = reels.current[c];
    if (!col || !reel) return;
    const from = reel.mode === Mode.Idle || reel.mode === Mode.Spring ? Math.round(reel.target) : Math.round(reel.p);
    let target: number | null = null;
    switch (event.key) {
      case "ArrowUp": target = from - 1; break;
      case "ArrowDown": target = from + 1; break;
      case "PageUp": target = from - col.page; break;
      case "PageDown": target = from + col.page; break;
      case "Home": target = col.loop ? from - mod(from, col.count) : 0; break;
      case "End": target = col.loop ? from - mod(from, col.count) + col.count - 1 : col.count - 1; break;
      case "ArrowLeft": case "ArrowRight": {
        const next = c + (event.key === "ArrowLeft" ? -1 : 1);
        if (colRefs.current[next]) { event.preventDefault(); colRefs.current[next]?.focus(); }
        return;
      }
      default: {
        if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
        const now = performance.now();
        const text = (now - typed.current.at < 900 ? typed.current.text : "") + event.key.toLocaleLowerCase();
        typed.current = { text, at: now };
        const matchAt = (query: string) => {
          for (let i = 0; i < col.count; i++) {
            const index = mod(from + 1 + i - (query.length > 1 ? 1 : 0), col.count);
            const name = col.label(index).toLocaleLowerCase();
            if (name.startsWith(query) || name.replace(/^0/, "").startsWith(query)) return index;
          }
          return -1;
        };
        let hit = matchAt(text);
        if (hit < 0 && text.length > 1) { typed.current.text = event.key.toLocaleLowerCase(); hit = matchAt(typed.current.text); }
        if (hit < 0) return;
        target = col.loop ? from + ((mod(hit - from, col.count) + col.count / 2) % col.count) - col.count / 2 : hit;
      }
    }
    event.preventDefault();
    userMoved.current = true;
    pinned.current = null;
    spinTo(c, snapTarget(c, Math.round(target)), 300);
  };

  const choosePreset = (preset: DateReelPreset) => {
    const target = typeof preset.value === "function" ? preset.value(today) : preset.value;
    userMoved.current = true;
    goTo(new Date(clamp(target.getTime(), min.getTime(), max.getTime() + DAY_MS - 60_000)), 0.06);
  };

  const runConfirm = async () => {
    if (!onConfirm || confirm === "pending") return;
    setConfirm("pending");
    try { await onConfirm(committedRef.current); setConfirm("done"); setAnnounce(`${L.done}. ${describe(committedRef.current, mode, today, f, L.at).headline}`); }
    catch { setConfirm("failed"); setAnnounce(L.failed); }
  };

  const idxNow = toIndexes(committed);
  const summary = describe(committed, mode, today, f, L.at);
  const presetList = presets === false ? [] : presets;
  const accentStyle = accent ? ({ ["--dr-accent" as string]: accent } as CSSProperties) : undefined;

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={label ?? (mode === "time" ? "Time" : mode === "date" ? "Date" : "Date and time")}
      className={[styles.root, className].filter(Boolean).join(" ")}
      style={{ ...accentStyle, ...style }}
      data-mode={mode}
      data-intro={intro ? "" : undefined}
    >
      <div className={styles.body}>
      <div className={styles.header}>
        {title && <h3 className={styles.title}>{title}</h3>}
        <p className={styles.summary} aria-hidden="true">
          <span ref={headlineRef} className={styles.headline}>{summary.headline}</span>
          <span ref={detailRef} className={styles.detail}>{summary.detail}</span>
        </p>
      </div>

      <div className={styles.stage}>
        <div className={styles.lens} aria-hidden="true" />
        <div className={styles.reels}>
          {columns.map((col, c) => {
            const reelIndex = idxNow[c];
            const ssrBase = reelIndex;
            return (
              <div
                key={col.key}
                ref={el => { colRefs.current[c] = el; }}
                className={styles.reel}
                data-align={col.align}
                style={{ ["--dr-i" as string]: c } as CSSProperties}
                data-active={focusCol === c ? "" : undefined}
                role="spinbutton"
                tabIndex={0}
                aria-label={col.name}
                aria-valuemin={0}
                aria-valuemax={col.count - 1}
                aria-valuenow={reelIndex}
                aria-valuetext={col.label(reelIndex)}
                onPointerDown={onPointerDown(c)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onKeyDown={onKeyDown(c)}
                onFocus={() => setFocusCol(c)}
                onBlur={() => setFocusCol(current => (current === c ? -1 : current))}
              >
                <span className={styles.sizer} aria-hidden="true" data-row>{col.sizer.map(text => <span key={text}>{text}</span>)}</span>
                <span className={styles.drum} aria-hidden="true">
                  {Array.from({ length: SLOTS }, (_, s) => {
                    const item = ssrBase + s - HALF;
                    const text = !col.loop && (item < 0 || item >= col.count) ? "" : col.label(col.loop ? mod(item, col.count) : item);
                    return <span key={s} ref={el => { (baseRefs.current[c] ??= [])[s] = el; }} className={styles.item}>{text}</span>;
                  })}
                </span>
                <span className={styles.window} aria-hidden="true">
                  {Array.from({ length: SLOTS }, (_, s) => {
                    const item = ssrBase + s - HALF;
                    const text = !col.loop && (item < 0 || item >= col.count) ? "" : col.label(col.loop ? mod(item, col.count) : item);
                    return <span key={s} ref={el => { (lensRefs.current[c] ??= [])[s] = el; }} className={styles.lensItem}>{text}</span>;
                  })}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {(presetList.length > 0 || onConfirm) && (
        <div className={styles.footer}>
          {presetList.length > 0 && (
            <div className={styles.presets} role="group" aria-label={L.presets}>
              {presetList.map(preset => {
                const at = typeof preset.value === "function" ? preset.value(today) : preset.value;
                const chosen = Math.abs(at.getTime() - committed.getTime()) < 60_000;
                return <button key={preset.label} type="button" className={styles.preset} aria-pressed={chosen} onClick={() => choosePreset(preset)}>{preset.label}</button>;
              })}
            </div>
          )}
          {onConfirm && (
            <button type="button" className={styles.confirm} data-state={confirm} onClick={runConfirm} aria-disabled={confirm === "pending"}>
              <span className={styles.confirmStack}>
                <span data-show={confirm === "idle" || undefined}>{L.confirm}</span>
                <span data-show={confirm === "pending" || undefined}><LoaderCircle className={styles.spin} size={16} strokeWidth={1.75} aria-hidden="true" />{L.pending}</span>
                <span data-show={confirm === "done" || undefined}><Check size={16} strokeWidth={1.75} aria-hidden="true" />{L.done}</span>
                <span data-show={confirm === "failed" || undefined}>{L.failed}</span>
              </span>
            </button>
          )}
        </div>
      )}

      </div>
      <span id={`${id}-status`} className={styles.srOnly} role="status" aria-live="polite">{announce}</span>
    </div>
  );
}

export default DateReel;
