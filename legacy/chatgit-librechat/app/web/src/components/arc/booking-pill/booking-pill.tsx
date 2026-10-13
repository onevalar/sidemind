"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, WheelEvent as ReactWheelEvent } from "react";
import { AnimatePresence, animate, motion, useIsPresent, useMotionValue, useMotionValueEvent, useReducedMotion, useTransform, useVelocity } from "motion/react";
import type { MotionValue, PanInfo, Transition, Variants } from "motion/react";
import { ArrowLeft, ArrowRight, CalendarDays, Minus, Plus, RotateCcw } from "lucide-react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./booking-pill.module.css";

const ORDER = ["start", "party", "date", "time", "review", "booked"] as const;
/** Where the pill is in the flow: the closed pill, party size, date, time, the ticket to confirm, and booked. */
export type BookingStep = (typeof ORDER)[number];

export interface Booking {
  /** ISO date, such as "2026-09-22". */
  date: string;
  /** Seating time as "HH:MM". */
  time: string;
  partySize: number;
}

/**
 * One floating pill that reshapes itself through a short booking flow: party size, a draggable date strip, a grid of times, a ticket to confirm, and a booked state.
 * Use it for reservations or appointment slots on a venue or service page, where a full form would bury the one action people came for.
 * Anchor it to the bottom of its container; it grows upward and outward from there.
 */
export interface BookingPillProps {
  /** Venue name printed on the ticket. */
  venue: string;
  /** Second line on the ticket, such as the address. */
  venueDetail?: string;
  /** First day on the strip as an ISO date, such as "2026-09-21". Pass it from data so server and client render the same days. */
  startDate: string;
  /** Days on the strip. Defaults to 21. */
  days?: number;
  /** Seating times as "HH:MM", in order. Shown four to a row. */
  times?: string[];
  /** Whether a time is free for a party on a date. Everything is free by default. */
  isAvailable?: (date: string, time: string, partySize: number) => boolean;
  /** Preselected when free, otherwise the nearest free time, as "HH:MM". Defaults to "19:30". */
  preferredTime?: string;
  minPartySize?: number;
  maxPartySize?: number;
  defaultPartySize?: number;
  /** Books the table. Resolve to show the booked state, reject to keep the ticket open with an error. Defaults to a short simulated wait. */
  onConfirm?: (booking: Booking) => Promise<void> | void;
  /** Called on every step, such as to let the page recede while the pill is open. */
  onStepChange?: (step: BookingStep) => void;
  /** Clock used for the times shown. Defaults to 12, such as "7:30 PM". Times are always passed as "HH:MM". */
  hourCycle?: 12 | 24;
  /** Label of the closed pill. Defaults to "Book a table". */
  label?: string;
  className?: string;
}

const { spring, duration, ease, blur, stagger } = motionTokens;
const enter = [...ease.enter] as [number, number, number, number];
const standard = [...ease.standard] as [number, number, number, number];
/** The shared spring tokens restated as stiffness and damping, so a retarget keeps its velocity instead of restarting from rest. */
const physical = ({ visualDuration, bounce }: { visualDuration: number; bounce: number }): Transition => {
  const root = 2 * Math.PI / (visualDuration * 1.2);
  return { type: "spring", stiffness: root * root, damping: 2 * (1 - bounce) * root, mass: 1 };
};
/** Growing keeps the morph token's bounce, shrinking settles faster, and the booked pill lands with a little extra life. */
const grow = physical(spring.morph), shrink = physical({ visualDuration: .34, bounce: .08 }), land = physical({ visualDuration: .52, bounce: .28 });
const glide = physical({ visualDuration: .45, bounce: .1 }), slide = physical(spring.morph);
/** Content arrives a beat after the shape starts to move. */
const BEAT = .07;
/** Width of one day on the strip in px. Keep in step with --cell in the stylesheet. */
const CELL = 52;
const COLUMNS = 4;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DEFAULT_TIMES = ["17:00", "17:30", "18:00", "18:30", "19:00", "19:30", "20:00", "20:30", "21:00", "21:30", "22:00", "22:30"];
const BACK: Partial<Record<BookingStep, BookingStep>> = { party: "start", date: "party", time: "date", review: "time" };

const everyTime = () => true;
const simulate = () => new Promise<void>(resolve => setTimeout(resolve, 900));
const clampTo = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const minutes = (time: string) => { const [h, m] = time.split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
/** Where a flick would come to rest on the scroll deceleration curve. */
const project = (velocity: number, rate = .99) => velocity / 1000 * rate / (1 - rate);
const subscribe = () => () => {};

interface Day { iso: string; weekday: number; day: number; month: number }
const leap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
const monthLength = (year: number, month: number) => [31, leap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month];
/** Day of the week without Date, so server and client agree in any time zone. 0 is Sunday. */
const weekdayOf = (year: number, month: number, day: number) => {
  const y = month < 2 ? year - 1 : year;
  return (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4][month] + day) % 7;
};
function makeDays(start: string, count: number): Day[] {
  const [y, m, d] = start.split("-").map(Number);
  let year = y || 2026, month = clampTo((m || 1) - 1, 0, 11), day = clampTo(d || 1, 1, 31);
  return Array.from({ length: count }, () => {
    const entry = { iso: `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`, weekday: weekdayOf(year, month, day), day, month };
    if (++day > monthLength(year, month)) { day = 1; if (++month > 11) { month = 0; year++; } }
    return entry;
  });
}
const longDate = (day: Day) => `${WEEKDAYS[day.weekday]}, ${MONTHS[day.month]} ${day.day}`;
const shortDate = (day: Day) => `${WEEKDAYS[day.weekday].slice(0, 3)}, ${MONTHS[day.month].slice(0, 3)} ${day.day}`;
/** "19:30" as "7:30 PM" on a 12 hour clock, or unchanged on a 24 hour one. */
const clock = (time: string, cycle: 12 | 24) => {
  if (cycle === 24) return time;
  const [h, m] = time.split(":").map(Number);
  return `${(h % 12) || 12}:${String(m || 0).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
function nearest(free: string[], wanted: string) {
  let best: string | null = null, gap = Infinity;
  for (const time of free) { const distance = Math.abs(minutes(time) - minutes(wanted)); if (distance < gap) { gap = distance; best = time; } }
  return best;
}

/** Reduced motion only after hydration, so server and client render the same first frame. */
function useReducedFlag() {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

const faceVariants: Variants = {
  hidden: (direction: number) => ({ opacity: 0, x: direction * 16, scale: .95, filter: `blur(${blur.soft}px)` }),
  shown: { opacity: 1, x: 0, scale: 1, filter: "blur(0px)", transition: { opacity: { duration: .22, ease: enter, delay: BEAT }, filter: { duration: .26, ease: enter, delay: BEAT }, x: { ...spring.snappy, delay: BEAT }, scale: { ...spring.snappy, delay: BEAT } } },
  gone: (direction: number) => ({ opacity: 0, x: direction * -10, scale: .97, filter: `blur(${blur.soft}px)`, transition: { duration: .12, ease: standard } }),
};
const fadeVariants: Variants = { hidden: { opacity: 0 }, shown: { opacity: 1, transition: { duration: .15 } }, gone: { opacity: 0, transition: { duration: .1 } } };
/** Secondary rows trail the face by a line each. */
const riseVariants: Variants = {
  hidden: { opacity: 0, y: 8, filter: `blur(${blur.subtle}px)` },
  shown: (order: number) => {
    const delay = BEAT + .06 + order * stagger.line;
    return { opacity: 1, y: 0, filter: "blur(0px)", transition: { ...spring.snappy, delay, opacity: { duration: .22, ease: enter, delay }, filter: { duration: .22, ease: enter, delay } } };
  },
};
const slotVariants: Variants = {
  hidden: { opacity: 0, y: 8, scale: .92 },
  shown: (order: number) => {
    const delay = BEAT + .05 + order * .016;
    return { opacity: 1, y: 0, scale: 1, transition: { ...spring.snappy, delay, opacity: { duration: .2, ease: enter, delay } } };
  },
};
const lensVariants: Variants = { hidden: { opacity: 0, scale: .82 }, shown: { opacity: 1, scale: 1, transition: { ...spring.snappy, delay: BEAT + .1, opacity: { duration: .16, delay: BEAT + .1 } } } };
const tearVariants: Variants = { hidden: { scaleX: 0, opacity: 0 }, shown: { scaleX: 1, opacity: 1, transition: { scaleX: { ...spring.smooth, delay: .2 }, opacity: { duration: .12, delay: .2 } } } };

/** A face reports its natural size while it is the current one, so the shared shape can spring to fit it. A leaving face turns inert. */
function Face({ name, className, direction, reduced, onSize, children }: { name: BookingStep; className?: string; direction: number; reduced: boolean; onSize: (name: BookingStep, width: number, height: number) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const present = useIsPresent();
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !present) return;
    const report = () => onSize(name, node.offsetWidth, node.offsetHeight);
    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(node);
    return () => observer.disconnect();
  }, [name, onSize, present]);
  return <motion.div ref={ref} className={[styles.face, className].filter(Boolean).join(" ")} data-face={name} custom={direction} variants={reduced ? fadeVariants : faceVariants} initial="hidden" animate="shown" exit="gone" inert={!present || undefined}>{children}</motion.div>;
}

function Round({ label, onClick, tone, size, disabled, focus, reduced, children }: { label: string; onClick: () => void; tone?: "primary"; size?: "sm"; disabled?: boolean; focus?: boolean; reduced: boolean; children: ReactNode }) {
  return <motion.button type="button" className={styles.round} data-tone={tone} data-size={size} data-autofocus={focus || undefined} aria-label={label} aria-disabled={disabled || undefined}
    onClick={disabled ? undefined : onClick} whileTap={disabled ? undefined : { scale: .88 }} transition={reduced ? { duration: 0 } : spring.snappy}>{children}</motion.button>;
}

function Wide({ onClick, disabled, busy, focus, reduced, children }: { onClick: () => void; disabled?: boolean; busy?: boolean; focus?: boolean; reduced: boolean; children: ReactNode }) {
  const off = disabled || busy;
  return <motion.button type="button" className={styles.primary} data-autofocus={focus || undefined} aria-disabled={off || undefined} aria-busy={busy || undefined}
    onClick={off ? undefined : onClick} whileTap={off ? undefined : { scale: .97 }} transition={reduced ? { duration: 0 } : spring.snappy}>{children}</motion.button>;
}

/** Changed words rise in from a soft blur; the old words leave faster. */
function Swap({ text, reduced, className }: { text: string; reduced: boolean; className?: string }) {
  const hidden = reduced ? { opacity: 0 } : { opacity: 0, y: "0.35em", filter: `blur(${blur.soft}px)` };
  return <span className={[styles.swap, className].filter(Boolean).join(" ")}>
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span key={text} className={styles.swapItem} initial={hidden} animate={{ opacity: 1, y: "0em", filter: "blur(0px)" }}
        exit={reduced ? { opacity: 0, transition: { duration: .1 } } : { opacity: 0, y: "-0.3em", filter: `blur(${blur.subtle}px)`, transition: { duration: .14, ease: standard } }}
        transition={{ duration: reduced ? .15 : .24, ease: enter }}>{text}</motion.span>
    </AnimatePresence>
  </span>;
}

const rollVariants: Variants = {
  enter: (direction: number) => ({ y: direction > 0 ? "0.7em" : "-0.7em", opacity: 0, filter: `blur(${blur.subtle}px)` }),
  rest: { y: "0em", opacity: 1, filter: "blur(0px)", transition: { y: spring.snappy, opacity: { duration: duration.fast, ease: enter }, filter: { duration: duration.fast, ease: enter } } },
  leave: (direction: number) => ({ y: direction > 0 ? "-0.7em" : "0.7em", opacity: 0, filter: `blur(${blur.subtle}px)`, transition: { y: spring.snappy, opacity: { duration: duration.instant, ease: standard }, filter: { duration: duration.instant } } }),
};
const rollFade: Variants = { enter: { opacity: 0 }, rest: { opacity: 1, transition: { duration: duration.instant } }, leave: { opacity: 0, transition: { duration: .08 } } };

/** Each changed digit rolls the way the count moved; a new place value opens like a slot. */
function Roll({ value, reduced }: { value: number; reduced: boolean }) {
  const [seen, setSeen] = useState({ value, direction: 1 });
  if (seen.value !== value) setSeen({ value, direction: value >= seen.value ? 1 : -1 });
  const chars = [...String(value)];
  return <span className={styles.roll}>
    <AnimatePresence initial={false}>
      {chars.map((digit, index) => <motion.span key={chars.length - 1 - index} className={styles.column} initial={{ width: 0, opacity: 0 }} animate={{ width: "auto", opacity: 1 }} exit={{ width: 0, opacity: 0 }} transition={reduced ? { duration: 0 } : { width: spring.morph, opacity: { duration: duration.fast } }}>
        <span className={styles.sizer}>0</span>
        <AnimatePresence initial={false} custom={seen.direction}>
          <motion.span key={digit} className={styles.digit} custom={seen.direction} variants={reduced ? rollFade : rollVariants} initial="enter" animate="rest" exit="leave">{digit}</motion.span>
        </AnimatePresence>
      </motion.span>)}
    </AnimatePresence>
  </span>;
}

/** A disc pops in, then the check draws itself across it. */
function DrawnCheck({ reduced }: { reduced: boolean }) {
  return <span className={styles.mark} aria-hidden="true">
    <motion.span className={styles.markDisc} initial={{ scale: .5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={reduced ? { duration: 0 } : { ...land, delay: BEAT }} />
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <motion.path d="M4 9.4l3.2 3.1L14 5.8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: 1 }}
        transition={reduced ? { duration: 0 } : { pathLength: { duration: .36, ease: enter, delay: .26 }, opacity: { duration: .01, delay: .26 } }} />
    </svg>
  </span>;
}

/** Days slide under a fixed lens. Drags follow 1:1, stretch past either end, and a flick glides on to the day it would have coasted to. */
function DateStrip({ days, open, index, x, reduced, valueText, onSubmit }: { days: Day[]; open: boolean[]; index: number; x: MotionValue<number>; reduced: boolean; valueText: string; onSubmit: () => void }) {
  const max = days.length - 1;
  const aim = useRef(index);
  const dragged = useRef(false);
  const wheel = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const constraints = useMemo(() => ({ left: -max * CELL, right: 0 }), [max]);
  useEffect(() => () => clearTimeout(wheel.current), []);
  const settle = (next: number, velocity = 0) => {
    const target = clampTo(Math.round(next), 0, max);
    aim.current = target;
    if (reduced) x.jump(-target * CELL);
    else animate(x, -target * CELL, { ...glide, velocity });
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter") { event.preventDefault(); onSubmit(); return; }
    const moves: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, PageDown: 7, PageUp: -7 };
    const next = event.key === "Home" ? 0 : event.key === "End" ? max : event.key in moves ? aim.current + moves[event.key] : null;
    if (next === null) return;
    event.preventDefault();
    settle(next);
  };
  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    x.stop();
    x.set(clampTo(x.get() - event.deltaX, -max * CELL - CELL / 2, CELL / 2));
    clearTimeout(wheel.current);
    wheel.current = setTimeout(() => settle(-x.get() / CELL), 110);
  };
  const onDragEnd = (_: unknown, info: PanInfo) => settle(-(x.get() + (reduced ? 0 : project(info.velocity.x))) / CELL, info.velocity.x);
  const cells = (ink: boolean) => days.map((day, i) => <span key={day.iso} className={styles.cell} data-index={ink ? undefined : i} data-closed={!open[i] || undefined}>
    <span className={styles.cellTop}>{day.day === 1 ? MONTHS[day.month].slice(0, 3) : WEEKDAYS[day.weekday].slice(0, 3)}</span>
    <span className={styles.cellDay}>{day.day}</span>
  </span>);
  return <div className={styles.slider} role="slider" tabIndex={0} aria-label="Date" aria-valuemin={0} aria-valuemax={max} aria-valuenow={index} aria-valuetext={valueText} data-autofocus onKeyDown={onKeyDown} onWheel={onWheel}>
    <div className={styles.track}>
      <motion.div className={styles.strip} style={{ x }} drag="x" dragConstraints={constraints} dragElastic={.16} dragMomentum={false}
        onPointerDown={() => { dragged.current = false; }} onDragStart={() => { dragged.current = true; }} onDragEnd={onDragEnd}
        onClick={event => { if (dragged.current) return; const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-index]"); if (cell) settle(Number(cell.dataset.index)); }}>
        {cells(false)}
      </motion.div>
      <motion.div className={styles.lens} aria-hidden="true" variants={reduced ? undefined : lensVariants}>
        <motion.div className={styles.strip} style={{ x }}>{cells(true)}</motion.div>
      </motion.div>
    </div>
  </div>;
}

/** Times as radios. One highlight glides between them on a spring; the chosen time's ink turns over just after it arrives. */
function TimeGrid({ times, free, value, onChange, reduced, cycle }: { times: string[]; free: string[]; value: string | null; onChange: (time: string) => void; reduced: boolean; cycle: 12 | 24 }) {
  const gridRef = useRef<HTMLDivElement>(null);
  const hx = useMotionValue(0), hy = useMotionValue(0), hw = useMotionValue(0), hh = useMotionValue(0);
  const placed = useRef(false);
  const index = value ? times.indexOf(value) : -1;
  const firstFree = times.findIndex(time => free.includes(time));
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid || index < 0) return;
    const place = (instant: boolean) => {
      const cell = grid.querySelector<HTMLElement>(`[data-slot="${index}"]`);
      if (!cell) return;
      const next = [cell.offsetLeft, cell.offsetTop, cell.offsetWidth, cell.offsetHeight];
      [hx, hy, hw, hh].forEach((motionValue, i) => { if (instant) motionValue.jump(next[i]); else animate(motionValue, next[i], slide); });
    };
    place(!placed.current || reduced);
    placed.current = true;
    let width = grid.offsetWidth;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (grid.offsetWidth !== width) { width = grid.offsetWidth; place(true); } });
    observer.observe(grid);
    return () => observer.disconnect();
  }, [hh, hw, hx, hy, index, reduced]);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, from: number) => {
    const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS };
    let next = -1;
    if (event.key in moves) { const step = moves[event.key]; for (let i = from + step; i >= 0 && i < times.length; i += step) if (free.includes(times[i])) { next = i; break; } }
    else if (event.key === "Home") next = firstFree;
    else if (event.key === "End") { for (let i = times.length - 1; i >= 0; i--) if (free.includes(times[i])) { next = i; break; } }
    else return;
    event.preventDefault();
    if (next < 0) return;
    onChange(times[next]);
    gridRef.current?.querySelector<HTMLElement>(`[data-slot="${next}"]`)?.focus();
  };
  return <div ref={gridRef} className={styles.slots} role="radiogroup" aria-label="Time">
    <motion.span className={styles.highlight} aria-hidden="true" data-hidden={index < 0 || undefined} style={{ x: hx, y: hy, width: hw, height: hh }} variants={reduced ? undefined : lensVariants} />
    {times.map((time, i) => {
      const ok = free.includes(time), checked = i === index;
      return <motion.button key={time} type="button" role="radio" className={styles.slot} data-slot={i} data-autofocus={checked || undefined} aria-checked={checked} aria-disabled={!ok || undefined}
        tabIndex={checked || (index < 0 && i === firstFree) ? 0 : -1} custom={i} variants={reduced ? undefined : slotVariants}
        whileTap={ok ? { scale: .94 } : undefined} transition={reduced ? { duration: 0 } : spring.snappy}
        onClick={() => { if (ok) onChange(time); }} onKeyDown={event => onKeyDown(event, i)}>{clock(time, cycle)}</motion.button>;
    })}
  </div>;
}

export function BookingPill({ venue, venueDetail, startDate, days: dayCount = 21, times = DEFAULT_TIMES, isAvailable = everyTime, preferredTime = "19:30", minPartySize = 1, maxPartySize = 12, defaultPartySize = 2, onConfirm = simulate, onStepChange, hourCycle = 12, label = "Book a table", className }: BookingPillProps) {
  const reduced = useReducedFlag();
  const rootRef = useRef<HTMLDivElement>(null);
  const focusPending = useRef(false);
  const [step, setStep] = useState<BookingStep>("start");
  const [direction, setDirection] = useState(1);
  const [party, setParty] = useState(() => clampTo(defaultPartySize, minPartySize, maxPartySize));
  const [picked, setPicked] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "sending" | "error">("idle");
  const [announcement, setAnnouncement] = useState("");
  const days = useMemo(() => makeDays(startDate, Math.max(1, dayCount)), [startDate, dayCount]);
  const openDays = useMemo(() => days.map(day => times.some(time => isAvailable(day.iso, time, party))), [days, times, isAvailable, party]);
  const [dateIndex, setDateIndex] = useState(() => Math.max(0, openDays.indexOf(true)));
  const stripX = useMotionValue(-dateIndex * CELL);
  useMotionValueEvent(stripX, "change", value => setDateIndex(clampTo(Math.round(-value / CELL), 0, days.length - 1)));
  const day = days[Math.min(dateIndex, days.length - 1)];
  const free = times.filter(time => isAvailable(day.iso, time, party));
  const time = picked && free.includes(picked) ? picked : nearest(free, picked ?? preferredTime);

  // The shape: one surface whose size springs to whichever face is current. It squashes a touch against its own speed, like something with mass.
  const width = useMotionValue(0), height = useMotionValue(0);
  const [sized, setSized] = useState(false);
  const target = useRef({ width: 0, height: 0 });
  const reducedRef = useRef(reduced);
  const live = useMotionValue(0);
  useEffect(() => { reducedRef.current = reduced; live.set(reduced ? 0 : 1); }, [live, reduced]);
  const widthSpeed = useVelocity(width), heightSpeed = useVelocity(height);
  const scaleX = useTransform([heightSpeed, live], ([speed, on]: number[]) => 1 - on * Math.min(.035, Math.abs(speed) / 45000));
  const scaleY = useTransform([widthSpeed, live], ([speed, on]: number[]) => 1 - on * Math.min(.035, Math.abs(speed) / 45000));
  const onSize = useCallback((name: BookingStep, w: number, h: number) => {
    const last = target.current;
    if (last.width === w && last.height === h) return;
    target.current = { width: w, height: h };
    if (!last.width || reducedRef.current) { width.jump(w); height.jump(h); setSized(true); return; }
    const transition = name === "booked" ? land : w * h >= last.width * last.height ? grow : shrink;
    animate(width, w, transition);
    animate(height, h, transition);
  }, [height, width]);

  // The ticket's perforation notches are cut out of the shape itself, so they open as it becomes a ticket and close as it leaves.
  const notch = useMotionValue(0);
  useEffect(() => {
    const opening = step === "review";
    const controls = animate(notch, opening ? 10 : 0, reduced ? { duration: 0 } : opening ? { ...spring.snappy, delay: .16 } : { duration: duration.instant, ease: standard });
    return () => controls.stop();
  }, [notch, reduced, step]);
  const mask = useTransform(notch, radius => radius < .5 ? "none" : ["left", "right"].map(side => `radial-gradient(circle ${radius.toFixed(2)}px at ${side === "left" ? 0 : 100}% calc(100% - var(--stub)), #0000 ${(radius - .5).toFixed(2)}px, #000 ${radius.toFixed(2)}px) ${side} / 51% 100% no-repeat`).join(", "));

  useEffect(() => {
    if (!focusPending.current) return;
    focusPending.current = false;
    rootRef.current?.querySelector<HTMLElement>(`[data-face="${step}"] [data-autofocus]`)?.focus({ preventScroll: true });
  }, [step]);

  const go = (next: BookingStep, towards?: number) => {
    focusPending.current = !!rootRef.current?.contains(document.activeElement);
    setDirection(towards ?? (Math.sign(ORDER.indexOf(next) - ORDER.indexOf(step)) || 1));
    setStep(next);
    onStepChange?.(next);
    if (next === "time") setAnnouncement(free.length ? `${plural(free.length, "time")} free on ${longDate(day)}` : `No tables free on ${longDate(day)}`);
  };
  const back = status === "sending" ? undefined : BACK[step];
  const confirm = async () => {
    if (status === "sending" || !time) return;
    setStatus("sending");
    setAnnouncement("Booking");
    try {
      await onConfirm({ date: day.iso, time, partySize: party });
      setStatus("idle");
      setAnnouncement(`Booked a table for ${party} at ${venue} on ${longDate(day)} at ${clock(time, hourCycle)}`);
      go("booked");
    } catch {
      setStatus("error");
      setAnnouncement("");
    }
  };
  const reset = () => { setAnnouncement(""); go("start", -1); };
  const face = { direction, reduced, onSize };

  return <div ref={rootRef} className={[styles.root, className].filter(Boolean).join(" ")} onKeyDown={event => { if (event.key === "Escape" && back) { event.preventDefault(); go(back); } }}>
    <motion.div className={styles.frame} style={sized ? { width, height, scaleX, scaleY } : { scaleX, scaleY }} whileTap={step === "start" ? { scale: .96 } : undefined} transition={reduced ? { duration: 0 } : spring.snappy}>
      <span className={styles.shadow} aria-hidden="true" />
      <motion.div className={styles.shape} role="group" aria-label={`${label} at ${venue}`} style={{ mask, WebkitMask: mask }}>
        <AnimatePresence initial={false} custom={direction}>
          {step === "start" && <Face key="start" name="start" {...face}>
            <button type="button" className={styles.start} data-autofocus onClick={() => go("party")}><CalendarDays size={18} aria-hidden="true" />{label}</button>
          </Face>}

          {step === "party" && <Face key="party" name="party" className={styles.row} {...face}>
            <Round label="Back" onClick={() => go("start")} reduced={reduced}><ArrowLeft size={18} aria-hidden="true" /></Round>
            <div className={styles.stepper} role="group" aria-label="Party size">
              <Round label="Fewer guests" size="sm" disabled={party <= minPartySize} onClick={() => setParty(count => clampTo(count - 1, minPartySize, maxPartySize))} reduced={reduced}><Minus size={16} aria-hidden="true" /></Round>
              <output className={styles.count} aria-live="polite">
                <span className={styles.srOnly}>{plural(party, "guest")}</span>
                <span className={styles.countInk} aria-hidden="true">
                  <Roll value={party} reduced={reduced} />
                  <span className={styles.countWord}>guest<AnimatePresence initial={false}>{party !== 1 && <motion.span key="s" className={styles.plural} initial={{ width: 0, opacity: 0 }} animate={{ width: "auto", opacity: 1 }} exit={{ width: 0, opacity: 0 }} transition={reduced ? { duration: 0 } : { width: spring.snappy, opacity: { duration: duration.fast } }}>s</motion.span>}</AnimatePresence></span>
                </span>
              </output>
              <Round label="More guests" size="sm" focus disabled={party >= maxPartySize} onClick={() => setParty(count => clampTo(count + 1, minPartySize, maxPartySize))} reduced={reduced}><Plus size={16} aria-hidden="true" /></Round>
            </div>
            <Round label="Next, choose a date" tone="primary" onClick={() => go("date")} reduced={reduced}><ArrowRight size={18} aria-hidden="true" /></Round>
          </Face>}

          {step === "date" && <Face key="date" name="date" className={styles.dateFace} {...face}>
            <div className={styles.bar}>
              <Round label="Back to party size" onClick={() => go("party")} reduced={reduced}><ArrowLeft size={18} aria-hidden="true" /></Round>
              <Swap className={styles.title} text={longDate(day)} reduced={reduced} />
              <Round label="Next, choose a time" tone="primary" onClick={() => go("time")} reduced={reduced}><ArrowRight size={18} aria-hidden="true" /></Round>
            </div>
            <DateStrip days={days} open={openDays} index={dateIndex} x={stripX} reduced={reduced} valueText={`${longDate(day)}${openDays[dateIndex] ? "" : ", no tables free"}`} onSubmit={() => go("time")} />
          </Face>}

          {step === "time" && <Face key="time" name="time" className={styles.panel} {...face}>
            <div className={styles.bar}>
              <Round label="Back to dates" focus={!time} onClick={() => go("date")} reduced={reduced}><ArrowLeft size={18} aria-hidden="true" /></Round>
              <span className={styles.heading}>
                <span className={styles.headingTitle}><span className={styles.headingLong}>{longDate(day)}</span><span className={styles.headingShort}>{shortDate(day)}</span></span>
                <span className={styles.headingSub}>{plural(party, "guest")} · {free.length ? `${free.length} free` : "No tables free"}</span>
              </span>
              <span aria-hidden="true" />
            </div>
            <TimeGrid times={times} free={free} value={time} onChange={setPicked} reduced={reduced} cycle={hourCycle} />
            <Wide disabled={!time} onClick={() => go("review")} reduced={reduced}>{time ? "Review booking" : "Pick another day"}</Wide>
          </Face>}

          {step === "review" && time && <Face key="review" name="review" className={styles.ticket} {...face}>
            <div className={styles.ticketMain}>
              <motion.span className={styles.venue} custom={0} variants={reduced ? undefined : riseVariants}>
                <span className={styles.venueName}>{venue}</span>
                {venueDetail && <span className={styles.venueDetail}>{venueDetail}</span>}
              </motion.span>
              <motion.dl className={styles.facts} custom={1} variants={reduced ? undefined : riseVariants}>
                <div className={styles.fact}><dt>Date</dt><dd>{shortDate(day)}</dd></div>
                <div className={styles.fact}><dt>Time</dt><dd>{clock(time, hourCycle)}</dd></div>
                <div className={styles.fact}><dt>Guests</dt><dd>{party}</dd></div>
              </motion.dl>
              {status === "error" && <p className={styles.error} role="alert">This table couldn’t be booked. Try again.</p>}
            </div>
            <div className={styles.stub}>
              <motion.span className={styles.perforation} aria-hidden="true" variants={reduced ? undefined : tearVariants} />
              <Round label="Change time" disabled={status === "sending"} onClick={() => go("time")} reduced={reduced}><ArrowLeft size={18} aria-hidden="true" /></Round>
              <Wide focus busy={status === "sending"} onClick={confirm} reduced={reduced}><Swap text={status === "sending" ? "Booking…" : status === "error" ? "Try again" : "Confirm booking"} reduced={reduced} /></Wide>
            </div>
          </Face>}

          {step === "booked" && time && <Face key="booked" name="booked" className={styles.booked} {...face}>
            <DrawnCheck reduced={reduced} />
            <motion.span className={styles.bookedText} custom={1} variants={reduced ? undefined : riseVariants}>
              <span className={styles.bookedTitle}>Table for {party} booked</span>
              <span className={styles.bookedDetail}>{shortDate(day)} at {clock(time, hourCycle)}</span>
            </motion.span>
            <Round label="Book another table" size="sm" focus onClick={reset} reduced={reduced}><RotateCcw size={16} aria-hidden="true" /></Round>
          </Face>}
        </AnimatePresence>
      </motion.div>
    </motion.div>
    <p className={styles.srOnly} aria-live="polite">{announcement}</p>
  </div>;
}

export default BookingPill;
