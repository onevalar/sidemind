"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useMotionValueEvent, useReducedMotion, useTransform } from "motion/react";
import type { AnimationPlaybackControls, MotionValue, Transition, Variants } from "motion/react";
import { Moon, Sun } from "lucide-react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./time-dial.module.css";

export interface TimeDialCity {
  /** Stable id. */
  id: string;
  /** Name in the list, such as "New York". */
  name: string;
  /** Two or three letters beside the city's mark on the dial, such as "NYC". */
  code: string;
  /** Fixed offset from UTC in minutes, in steps of 15, such as -240 for UTC−4. */
  offset: number;
}

/**
 * A 24 hour rotary dial for choosing a time across time zones. Noon sits at the top and midnight at the bottom, so every city rides the
 * dial at its own local time, and a shaded band marks working hours: a city inside the band is at work. The home city reads out in the center.
 * Use it to plan a call, a release, or an on-call handover between offices. Turn it anywhere, flick it to coast, or step it with the keys;
 * it always comes to rest on a quarter hour.
 */
export interface TimeDialProps {
  /** Two to five cities. The home city rides the outer track; the others follow on inner tracks. */
  cities: TimeDialCity[];
  /** Controlled time in UTC minutes from midnight UTC on the reference day. It may leave 0 to 1439 to reach the days either side. */
  value?: number;
  defaultValue?: number;
  /** Fires with the destination as soon as the dial is released or stepped, before it comes to rest. */
  onValueChange?: (value: number) => void;
  /** Controlled id of the city the dial reads in. Defaults to the first city. */
  homeId?: string;
  defaultHomeId?: string;
  onHomeChange?: (id: string) => void;
  /** Earliest and latest times in UTC minutes. The dial stretches past them and springs back. */
  min?: number;
  max?: number;
  /** Weekday of the reference day in UTC, 0 for Sunday. */
  weekday?: number;
  /** 12 reads 9:30 AM, 24 reads 09:30. Defaults to 12. */
  hourCycle?: 12 | 24;
  /** Local working hours in minutes from midnight, drawn as a band on the dial. Defaults to 9:00 to 18:00. */
  workingHours?: [start: number, end: number];
  /** Accessible name of the dial. */
  label?: string;
  className?: string;
}

const { spring, duration, ease, blur } = motionTokens;
const enter = [...ease.enter] as [number, number, number, number];
const standard = [...ease.standard] as [number, number, number, number];

/** One full turn is a day, and the dial rests every quarter hour. */
const DAY = 1440, STEP = 15, PER_DEGREE = DAY / 360;
/** Geometry in viewBox units. The dial spans 300 units, so a unit is a third of a cqi. */
const VIEW = 300, CENTER = VIEW / 2, RIM = 146, NUMERALS = 127, HOME_TRACK = 106, CORE = 56;
/** Height of one digit cell in em. */
const CELL = 1.3;
/** Content follows a shape change a beat later. */
const BEAT = .07;
/** How far past a bound the dial may be pulled, in minutes, before resistance takes nearly all of it. */
const STRETCH = 90;
const MAX_SPEED = 6000;
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const mod = (value: number, base: number) => ((value % base) + base) % base;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const pad = (value: number) => String(value).padStart(2, "0");
const snap = (value: number) => Math.round(value / STEP) * STEP;
const HOURS_24 = Array.from({ length: 24 }, (_, hour) => pad(hour));
/** Twenty-four faces with twelve hour labels, so the wheel still turns once a day and 11 → 12 → 1 rolls forward. */
const HOURS_12 = Array.from({ length: 24 }, (_, hour) => String(hour % 12 || 12));
const WORK: [number, number] = [540, 1080];
const QUARTERS = ["00", "15", "30", "45"];

/** The shared spring tokens restated as stiffness and damping, so a flick's velocity carries into them and interruptions blend. */
const physical = ({ visualDuration, bounce }: { visualDuration: number; bounce: number }): Transition => {
  const root = 2 * Math.PI / (visualDuration * 1.2);
  return { type: "spring", stiffness: root * root, damping: 2 * (1 - bounce) * root, mass: 1 };
};
/** Settling into a detent: a hint of catch, never enough to read as the wrong time. */
const detent = physical({ visualDuration: .3, bounce: .12 });
const jump = physical({ visualDuration: .56, bounce: .14 });
const settle = physical({ visualDuration: .4, bounce: .06 });
const morph = physical(spring.morph);
const roll = physical({ visualDuration: .62, bounce: .08 });
/** A flick coasts on a spring whose target lies COAST seconds of travel ahead and whose damping cancels the release velocity exactly,
 *  so the hand-off from finger to spring has no bump, only a steady slowdown into the nearest quarter hour. */
const COAST = .24, COAST_RATIO = .82;
const coastRoot = 2 * COAST_RATIO / COAST;
const coast: Transition = { type: "spring", stiffness: coastRoot * coastRoot, damping: 2 * COAST_RATIO * coastRoot, mass: 1 };

/** Soft detents: under a drag the dial lingers at each quarter hour and hurries between them, never more than two minutes from the finger. */
const PULL = .72;
const detentShape = (raw: number) => raw - PULL * STEP / (2 * Math.PI) * Math.sin(2 * Math.PI * raw / STEP);
const detentSlope = (raw: number) => 1 - PULL * Math.cos(2 * Math.PI * raw / STEP);
const detentInverse = (value: number) => {
  let raw = value;
  for (let pass = 0; pass < 4; pass++) raw -= (detentShape(raw) - value) / detentSlope(raw);
  return raw;
};
/** Resistance past an edge: the further the pull, the less the dial follows, and it never stops dead. */
const rubber = (overshoot: number) => (overshoot * STRETCH * .55) / (STRETCH + .55 * overshoot);

/** Degrees clockwise from the top for a local time, with noon at the top. */
const angleOf = (local: number) => (local - DAY / 2) / PER_DEGREE;
const point = (degrees: number, radius: number) => {
  const radians = degrees * Math.PI / 180;
  return [CENTER + radius * Math.sin(radians), CENTER - radius * Math.cos(radians)] as const;
};
const trackOf = (slot: number, count: number) => 88 - slot * (count > 1 ? Math.min(11, 24 / (count - 1)) : 0);

const isDaytime = (local: number) => { const minutes = mod(local, DAY); return minutes >= 360 && minutes < 1080; };
const isWorking = (local: number, [from, to]: [number, number]) => { const minutes = mod(local, DAY); return minutes >= from && minutes < to; };
const dayOf = (local: number) => Math.floor(local / DAY);
const clockText = (local: number, cycle: 12 | 24 = 24) => {
  const minutes = mod(Math.round(local), DAY), hour = Math.floor(minutes / 60);
  return cycle === 12 ? `${hour % 12 || 12}:${pad(minutes % 60)} ${hour < 12 ? "AM" : "PM"}` : `${pad(hour)}:${pad(minutes % 60)}`;
};
const spanText = (minutes: number) => [Math.floor(minutes / 60) && `${Math.floor(minutes / 60)} h`, minutes % 60 && `${minutes % 60} min`].filter(Boolean).join(" ");
const utcText = (offset: number) => `UTC${offset < 0 ? "−" : "+"}${Math.floor(Math.abs(offset) / 60)}${Math.abs(offset) % 60 ? `:${pad(Math.abs(offset) % 60)}` : ""}`;
const relativeText = (difference: number) => difference === 0 ? "Same time" : `${spanText(Math.abs(difference))} ${difference > 0 ? "ahead" : "behind"}`;
const shiftText = (days: number) => `${days > 0 ? "+" : "−"}${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"}`;
const spokenShift = (days: number) => Math.abs(days) === 1 ? (days > 0 ? "next day" : "previous day") : `${Math.abs(days)} days ${days > 0 ? "later" : "earlier"}`;
const deltaText = (minutes: number) => minutes === 0 ? "No change" : `${minutes > 0 ? "+" : "−"}${spanText(Math.abs(minutes))}`;
/** Everything the dial draws in discrete steps: each city's half of the day and its date. It changes a few times per turn, not per frame. */
const phaseOf = (value: number, cities: TimeDialCity[], work: [number, number]) => cities.map(city => { const local = snap(value + city.offset); return `${isDaytime(local) ? "d" : "n"}${isWorking(local, work) ? "w" : ""}${dayOf(local)}`; }).join(" ");

const subscribe = () => () => {};
/** Reduced motion only after hydration, so server and client render the same first frame. */
function useReducedFlag() {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

const rise: Variants = {
  hidden: { opacity: 0, y: "0.4em", filter: `blur(${blur.soft}px)` },
  shown: { opacity: 1, y: "0em", filter: "blur(0px)", transition: { y: spring.snappy, opacity: { duration: duration.standard, ease: enter }, filter: { duration: duration.standard, ease: enter } } },
  gone: { opacity: 0, y: "-0.4em", filter: `blur(${blur.subtle}px)`, transition: { duration: duration.instant, ease: standard } },
};
const fade: Variants = { hidden: { opacity: 0 }, shown: { opacity: 1, transition: { duration: duration.fast } }, gone: { opacity: 0, transition: { duration: duration.instant } } };
/** The sun and moon turn over as they trade places. */
const turnOver: Variants = {
  hidden: { opacity: 0, rotate: -90, scale: .4, filter: `blur(${blur.soft}px)` },
  shown: { opacity: 1, rotate: 0, scale: 1, filter: "blur(0px)", transition: { rotate: spring.morph, scale: spring.snappy, opacity: { duration: duration.standard, ease: enter }, filter: { duration: duration.standard, ease: enter } } },
  gone: { opacity: 0, rotate: 90, scale: .4, filter: `blur(${blur.subtle}px)`, transition: { duration: duration.exit, ease: standard } },
};
const chipIn: Variants = {
  hidden: { opacity: 0, scale: .5, x: 10, filter: `blur(${blur.soft}px)` },
  shown: { opacity: 1, scale: 1, x: 0, filter: "blur(0px)", transition: { scale: spring.morph, x: spring.snappy, opacity: { duration: duration.fast, ease: enter }, filter: { duration: duration.standard, ease: enter } } },
  gone: { opacity: 0, scale: .6, filter: `blur(${blur.subtle}px)`, transition: { duration: duration.instant, ease: standard } },
};

function TextSwap({ text, reduced, className }: { text: string; reduced: boolean; className?: string }) {
  return <span className={[styles.swap, className].filter(Boolean).join(" ")}>
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span key={text} className={styles.swapItem} variants={reduced ? fade : rise} initial="hidden" animate="shown" exit="gone">{text}</motion.span>
    </AnimatePresence>
  </span>;
}

function DayIcon({ daytime, reduced }: { daytime: boolean; reduced: boolean }) {
  return <span className={styles.iconSwap}>
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span key={daytime ? "day" : "night"} className={styles.iconItem} variants={reduced ? fade : turnOver} initial="hidden" animate="shown" exit="gone">
        {daytime ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
      </motion.span>
    </AnimatePresence>
  </span>;
}

/** A clipped strip of faces that slides with a motion value, so digits roll every frame without a React render. */
function Wheel({ position, faces }: { position: MotionValue<number>; faces: readonly string[] }) {
  const y = useTransform(position, value => `${-mod(value, faces.length) * CELL}em`);
  return <span className={styles.wheel}>
    <span className={styles.sizer}>{faces.reduce((widest, face) => face.length > widest.length ? face : widest, faces[0])}</span>
    <motion.span className={styles.strip} style={{ y }}>
      {[...faces, faces[0]].map((face, index) => <span key={index} className={styles.face}>{face}</span>)}
    </motion.span>
  </span>;
}

/** Hours turn like an odometer, only while the minutes pass from :45 to :00, so the wheels never disagree. lag holds minutes still to roll through after the home city changes. */
function Clock({ turn, offset, lag, cycle, reduced, className }: { turn: MotionValue<number>; offset: number; lag?: MotionValue<number>; cycle: 12 | 24; reduced: boolean; className?: string }) {
  const still = useMotionValue(0);
  const hour = useTransform([turn, lag ?? still], ([value, behind]: number[]) => {
    const local = mod(value + offset, DAY), whole = Math.floor(local / 60);
    return whole + clamp01((local - whole * 60 - 45) / STEP) + behind / 60;
  });
  const quarter = useTransform(turn, value => mod(value + offset, DAY) / STEP);
  const [meridiem, setMeridiem] = useState(() => mod(turn.get() + offset, DAY) < DAY / 2 ? "AM" : "PM");
  useMotionValueEvent(turn, "change", value => {
    const next = mod(snap(value) + offset, DAY) < DAY / 2 ? "AM" : "PM";
    if (next !== meridiem) setMeridiem(next);
  });
  return <span className={[styles.clock, className].filter(Boolean).join(" ")} data-cycle={cycle} aria-hidden="true">
    <Wheel position={hour} faces={cycle === 12 ? HOURS_12 : HOURS_24} />
    <span className={styles.colon}>:</span>
    <Wheel position={quarter} faces={QUARTERS} />
    {cycle === 12 && <TextSwap className={styles.meridiem} text={meridiem} reduced={reduced} />}
  </span>;
}

const TICKS = Array.from({ length: 24 }, (_, hour) => ({ hour, major: hour % 6 === 0 }));
/** Side numerals hang inward from just inside their tick, so wide labels like "6 AM" never touch it. */
const NUMBERS = [0, 6, 12, 18].map(hour => {
  const side = hour % 12 === 6;
  const [x, y] = point(angleOf(hour * 60), side ? RIM - 16 : NUMERALS);
  return { hour, x: x.toFixed(2), y: y.toFixed(2), anchor: side ? (hour === 6 ? "start" : "end") : "middle" } as const;
});
const numeral = (hour: number, cycle: 12 | 24) => cycle === 24 ? pad(hour) : hour === 12 ? "Noon" : `${hour % 12 || 12} ${hour < 12 ? "AM" : "PM"}`;

/** An annulus sector between two local times, clockwise. */
function band(from: number, to: number, inner: number, outer: number) {
  const a = angleOf(from), b = angleOf(to), large = mod(to - from, DAY) > DAY / 2 ? 1 : 0;
  const [x0, y0] = point(a, outer), [x1, y1] = point(b, outer), [x2, y2] = point(b, inner), [x3, y3] = point(a, inner);
  const f = (value: number) => value.toFixed(2);
  return `M${f(x0)} ${f(y0)}A${outer} ${outer} 0 ${large} 1 ${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}A${inner} ${inner} 0 ${large} 0 ${f(x3)} ${f(y3)}Z`;
}

/** The static face: the working hours band, hour ticks, four numerals, and one track per city. */
function DialFace({ tracks, cycle, work }: { tracks: number[]; cycle: 12 | 24; work: [number, number] }) {
  return <svg className={styles.svg} viewBox={`0 0 ${VIEW} ${VIEW}`} aria-hidden="true" focusable="false">
    <circle className={styles.plate} cx={CENTER} cy={CENTER} r={RIM} />
    <path className={styles.work} d={band(work[0], work[1], CORE + 4, RIM - 16)} />
    <circle className={styles.rim} cx={CENTER} cy={CENTER} r={RIM} />
    <circle className={styles.homeTrack} cx={CENTER} cy={CENTER} r={HOME_TRACK} />
    {tracks.map(radius => <circle key={radius} className={styles.track} cx={CENTER} cy={CENTER} r={radius} />)}
    <circle className={styles.core} cx={CENTER} cy={CENTER} r={CORE} />
    {TICKS.map(tick => <line key={tick.hour} className={tick.major ? styles.major : styles.hour} x1={CENTER} y1={CENTER - RIM + 5} x2={CENTER} y2={CENTER - RIM + (tick.major ? 12 : 9)} transform={`rotate(${tick.hour * 15} ${CENTER} ${CENTER})`} />)}
    {NUMBERS.map(number => <text key={number.hour} className={styles.numeral} x={number.x} y={number.y} textAnchor={number.anchor} dominantBaseline="central">{numeral(number.hour, cycle)}</text>)}
  </svg>;
}

/** The arc swept since the finger went down, drawn on the home track. */
function sweepPath(from: number, to: number) {
  const span = Math.max(-DAY + 4, Math.min(DAY - 4, to - from)) / PER_DEGREE;
  if (Math.abs(span) < .5) return "M0 0";
  const start = angleOf(from), [x0, y0] = point(start, HOME_TRACK), [x1, y1] = point(start + span, HOME_TRACK);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${HOME_TRACK} ${HOME_TRACK} 0 ${Math.abs(span) > 180 ? 1 : 0} ${span > 0 ? 1 : 0} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** One city riding the dial at its local time. The arm turns with the dial; the mark counter-turns so it stays upright.
 *  Home and satellite are one shape: the knob shrinks to a dot and the dot grows to a knob as the home city changes. */
function Orbiter({ city, turn, home, track, daytime, working, lifted, reduced }: { city: TimeDialCity; turn: MotionValue<number>; home: boolean; track: number; daytime: boolean; working: boolean; lifted: boolean; reduced: boolean }) {
  const rotate = useTransform(turn, value => angleOf(value + city.offset));
  const upright = useTransform(rotate, degrees => -degrees);
  const radius = useMotionValue(track);
  const lift = useTransform(radius, units => `${-units / 3}cqi`);
  /** The code sits on the side facing the center, wherever the mark is on the dial. */
  const codeX = useTransform(rotate, degrees => `${-Math.sin(degrees * Math.PI / 180) * 5.4}cqi`);
  const codeY = useTransform(rotate, degrees => `${Math.cos(degrees * Math.PI / 180) * 3.4}cqi`);
  useEffect(() => {
    const controls = animate(radius, track, reduced ? { duration: 0 } : morph);
    return () => controls.stop();
  }, [radius, reduced, track]);
  return <motion.div className={styles.arm} style={{ rotate }} data-home={home || undefined}>
    <motion.div className={styles.anchor} style={{ y: lift, rotate: upright }}>
      <motion.span className={styles.bead} data-working={working || undefined} initial={false} animate={{ scale: home ? (lifted ? 1.12 : 1) : .3 }} transition={reduced ? { duration: 0 } : morph}>
        <motion.span className={styles.glyph} initial={false} animate={{ opacity: home ? 1 : 0 }} transition={home ? { duration: duration.standard, ease: enter, delay: reduced ? 0 : BEAT } : { duration: duration.instant, ease: standard }}>
          <DayIcon daytime={daytime} reduced={reduced} />
        </motion.span>
      </motion.span>
      <motion.span className={styles.code} style={{ x: codeX, y: codeY }} initial={false} animate={{ opacity: home ? 0 : 1 }} transition={home ? { duration: duration.instant, ease: standard } : { duration: duration.standard, ease: enter, delay: reduced ? 0 : BEAT * 2 }}>{city.code}</motion.span>
    </motion.div>
  </motion.div>;
}

function CityRow({ city, homeCity, turn, at, committed, cycle, work, reduced, highlightId, onSelect }: { city: TimeDialCity; homeCity: TimeDialCity; turn: MotionValue<number>; at: number; committed: number; cycle: 12 | 24; work: [number, number]; reduced: boolean; highlightId: string; onSelect: () => void }) {
  const home = city.id === homeCity.id;
  const daytime = isDaytime(at + city.offset);
  const working = isWorking(at + city.offset, work);
  const shift = dayOf(at + city.offset) - dayOf(at + homeCity.offset);
  const meta = home ? `Home · ${utcText(city.offset)}` : `${utcText(city.offset)} · ${relativeText(city.offset - homeCity.offset)}`;
  const settledShift = dayOf(committed + city.offset) - dayOf(committed + homeCity.offset);
  const name = `${city.name}, ${clockText(committed + city.offset, cycle)}${settledShift ? `, ${spokenShift(settledShift)}` : ""}${isWorking(committed + city.offset, work) ? ", working hours" : ""}, ${home ? "home city" : relativeText(city.offset - homeCity.offset)}`;
  return <li className={styles.item}>
    <button type="button" className={styles.row} aria-pressed={home} aria-label={name} onClick={onSelect}>
      {home && <motion.span layoutId={highlightId} className={styles.highlight} transition={reduced ? { duration: 0 } : morph} />}
      <span className={styles.rowIcon} data-day={daytime || undefined} data-working={working || undefined}><DayIcon daytime={daytime} reduced={reduced} /></span>
      <span className={styles.rowText}>
        <span className={styles.rowCity}>{city.name}</span>
        <TextSwap className={styles.rowMeta} text={meta} reduced={reduced} />
      </span>
      <span className={styles.chipSlot}>
        <AnimatePresence mode="popLayout" initial={false}>
          {shift !== 0 && <motion.span key={shift} className={styles.chip} variants={reduced ? fade : chipIn} initial="hidden" animate="shown" exit="gone">{shiftText(shift)}</motion.span>}
        </AnimatePresence>
      </span>
      <Clock className={styles.rowTime} turn={turn} offset={city.offset} cycle={cycle} reduced={reduced} />
    </button>
  </li>;
}

type Drag = { id: number; cx: number; cy: number; radius: number; x: number; y: number; angle: number; raw: number; from: number; moved: boolean; samples: { t: number; v: number }[] };

export function TimeDial({ cities, value, defaultValue = 0, onValueChange, homeId, defaultHomeId, onHomeChange, min = -Infinity, max = Infinity, weekday = 1, hourCycle = 12, workingHours = WORK, label = "Time", className }: TimeDialProps) {
  const cycle = hourCycle;
  const [workFrom, workTo] = workingHours;
  const work = useMemo<[number, number]>(() => [workFrom, workTo], [workFrom, workTo]);
  const uid = useId().replace(/[^a-zA-Z0-9-]/g, "");
  const reduced = useReducedFlag();
  const lo = Number.isFinite(min) ? Math.ceil(min / STEP) * STEP : -Infinity;
  const hi = Number.isFinite(max) ? Math.floor(max / STEP) * STEP : Infinity;
  const bound = (next: number) => Math.min(hi, Math.max(lo, next));
  const shape = (raw: number) => raw > hi ? hi + rubber(raw - hi) : raw < lo ? lo - rubber(lo - raw) : detentShape(raw);

  const controlled = value !== undefined;
  const [inner, setInner] = useState(() => snap(defaultValue));
  const current = controlled ? value : inner;
  const [innerHome, setInnerHome] = useState(defaultHomeId ?? cities[0]?.id);
  const home = cities.find(city => city.id === (homeId ?? innerHome)) ?? cities[0];

  const turn = useMotionValue(current);
  const sweepFrom = useMotionValue(current);
  const sweepOpacity = useMotionValue(0);
  const lag = useMotionValue(0);
  const target = useRef(current);
  const controls = useRef<AnimationPlaybackControls | null>(null);
  const rolling = useRef<AnimationPlaybackControls | null>(null);
  const drag = useRef<Drag | null>(null);
  const shownOffset = useRef(home.offset);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState(() => ({ key: phaseOf(current, cities, work), at: snap(current) }));
  // The hand follows the home city; a new home swings it across to that city's mark instead of cutting.
  const handOffset = useMotionValue(home.offset);
  const handRotate = useTransform([turn, handOffset], ([now, offset]: number[]) => angleOf(now + offset));

  useMotionValueEvent(turn, "change", latest => {
    const key = phaseOf(latest, cities, work);
    if (key !== phase.key) setPhase(previous => previous.key === key ? previous : { key, at: snap(latest) });
  });

  const sweep = useTransform([turn, sweepFrom], ([now, from]: number[]) => sweepPath(from + home.offset, now + home.offset));
  const delta = useTransform([turn, sweepFrom], ([now, from]: number[]) => deltaText(snap(now) - snap(from)));

  /** A new value from outside spins the dial there. Values this dial committed itself are already on their way. */
  useEffect(() => {
    if (current === target.current) return;
    target.current = current;
    controls.current?.stop();
    if (reduced) turn.set(current);
    else controls.current = animate(turn, current, jump);
  }, [current, reduced, turn]);

  /** A new home city rolls the readout's hours through the difference instead of cutting to it. */
  useLayoutEffect(() => {
    const from = shownOffset.current;
    shownOffset.current = home.offset;
    if (from === home.offset) return;
    rolling.current?.stop();
    if (reduced) { lag.set(0); handOffset.set(home.offset); return; }
    lag.set(lag.get() + from - home.offset);
    rolling.current = animate(lag, 0, roll);
    // The short way round, so a twelve hour jump never spins more than half the dial.
    const shown = handOffset.get(), delta = mod(home.offset - shown + DAY / 2, DAY) - DAY / 2;
    animate(handOffset, shown + delta, { ...morph, onComplete: () => handOffset.jump(home.offset) });
  }, [home.offset, lag, reduced, handOffset]);

  const run = (to: number, transition: Transition, velocity?: number) => {
    controls.current?.stop();
    controls.current = null;
    if (reduced) { turn.set(to); return; }
    controls.current = animate(turn, to, velocity === undefined ? transition : { ...transition, velocity });
  };
  const commit = (next: number) => {
    target.current = next;
    if (!controlled) setInner(next);
    if (next !== current) onValueChange?.(next);
  };
  const selectHome = (id: string) => {
    if (id === home.id) return;
    if (homeId === undefined) setInnerHome(id);
    onHomeChange?.(id);
  };

  const pointerAngle = (x: number, y: number, origin: { cx: number; cy: number }) => Math.atan2(x - origin.cx, origin.cy - y) * 180 / Math.PI;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const origin = { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 };
    controls.current?.stop();
    const at = turn.get();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, ...origin, radius: rect.width / 2, x: event.clientX, y: event.clientY, angle: pointerAngle(event.clientX, event.clientY, origin), raw: at >= lo && at <= hi ? detentInverse(at) : at, from: at, moved: false, samples: [{ t: event.timeStamp, v: at }] };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || event.pointerId !== state.id) return;
    if (!state.moved) {
      if (Math.hypot(event.clientX - state.x, event.clientY - state.y) < 4) return;
      state.moved = true;
      sweepFrom.set(state.from);
      animate(sweepOpacity, 1, { duration: duration.fast, ease: enter });
      setDragging(true);
    }
    const angle = pointerAngle(event.clientX, event.clientY, state);
    /** Near the center a small move is a large angle, so the dial holds still there. */
    if (Math.hypot(event.clientX - state.cx, event.clientY - state.cy) > state.radius * .14) state.raw += (mod(angle - state.angle + 180, 360) - 180) * PER_DEGREE;
    state.angle = angle;
    turn.set(shape(state.raw));
    state.samples = [...state.samples.filter(sample => event.timeStamp - sample.t < 100), { t: event.timeStamp, v: state.raw }];
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || event.pointerId !== state.id) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const now = turn.get();
    if (!state.moved) {
      /** A tap on the ring sends the home city there the short way round. A tap in the middle only settles a stopped dial. */
      if (event.type === "pointerup" && Math.hypot(event.clientX - state.cx, event.clientY - state.cy) > state.radius * .55) {
        const pointed = pointerAngle(event.clientX, event.clientY, state) * PER_DEGREE + DAY / 2;
        const destination = bound(snap(now + mod(pointed - (now + home.offset) + DAY / 2, DAY) - DAY / 2));
        commit(destination);
        run(destination, jump);
      } else if (snap(now) !== now) {
        commit(bound(snap(now)));
        run(bound(snap(now)), detent);
      }
      return;
    }
    setDragging(false);
    animate(sweepOpacity, 0, { duration: reduced ? .1 : .32, ease: standard, delay: reduced ? 0 : .3 });
    const first = state.samples[0], last = state.samples[state.samples.length - 1];
    const elapsed = last.t - first.t;
    const velocity = event.type === "pointerup" && elapsed > 8 && event.timeStamp - last.t < 80 ? Math.max(-MAX_SPEED, Math.min(MAX_SPEED, (last.v - first.v) / elapsed * 1000)) : 0;
    const outside = now > hi || now < lo;
    const flick = !outside && !reduced && Math.abs(velocity) > 120;
    const destination = bound(snap(now + (flick ? velocity * COAST : 0)));
    commit(destination);
    run(destination, outside ? settle : flick ? coast : detent, velocity);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const steps: Record<string, number> = { ArrowRight: STEP, ArrowUp: STEP, ArrowLeft: -STEP, ArrowDown: -STEP, PageUp: 60, PageDown: -60 };
    const dayStart = dayOf(target.current + home.offset) * DAY - home.offset;
    const step = Object.hasOwn(steps, event.key) ? steps[event.key] : undefined;
    let destination: number;
    if (step !== undefined) destination = target.current + step;
    else if (event.key === "Home") destination = dayStart;
    else if (event.key === "End") destination = dayStart + DAY - STEP;
    else return;
    event.preventDefault();
    destination = bound(snap(destination));
    if (destination === target.current) return;
    commit(destination);
    run(destination, event.key === "Home" || event.key === "End" ? jump : detent);
  };

  const satellites = cities.filter(city => city.id !== home.id);
  const tracks = satellites.map((_, slot) => trackOf(slot, satellites.length));
  const homeLocal = current + home.offset;
  const liveWeekday = DAYS[mod(weekday + dayOf(phase.at + home.offset), 7)];
  const valueText = `${clockText(homeLocal, cycle)}, ${DAYS[mod(weekday + dayOf(homeLocal), 7)]}, ${home.name}`;
  const announcement = satellites.map(city => {
    const shift = dayOf(current + city.offset) - dayOf(homeLocal);
    return `${city.name} ${clockText(current + city.offset, cycle)}${shift ? `, ${spokenShift(shift)}` : ""}`;
  }).join(". ");

  return <div className={[styles.root, className].filter(Boolean).join(" ")}>
    <div className={styles.layout}>
      <div className={styles.stage} role="slider" tabIndex={0} aria-label={label} aria-valuemin={0} aria-valuemax={DAY - STEP} aria-valuenow={mod(homeLocal, DAY)} aria-valuetext={valueText} aria-describedby={`${uid}-hint`} data-dragging={dragging || undefined} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onKeyDown={onKeyDown}>
        <DialFace tracks={tracks} cycle={cycle} work={work} />
        <svg className={styles.svg} viewBox={`0 0 ${VIEW} ${VIEW}`} aria-hidden="true" focusable="false">
          <motion.path className={styles.sweep} d={sweep} style={{ opacity: sweepOpacity }} />
        </svg>
        <div className={styles.orbits} aria-hidden="true">
          <motion.div className={styles.arm} style={{ rotate: handRotate }}><span className={styles.hand} /></motion.div>
          {cities.map(city => <Orbiter key={city.id} city={city} turn={turn} home={city.id === home.id} track={city.id === home.id ? HOME_TRACK : tracks[satellites.indexOf(city)]} daytime={isDaytime(phase.at + city.offset)} working={isWorking(phase.at + city.offset, work)} lifted={dragging} reduced={reduced} />)}
        </div>
        <div className={styles.readout} aria-hidden="true">
          <TextSwap className={styles.readoutCity} text={home.name} reduced={reduced} />
          <Clock className={styles.readoutTime} turn={turn} offset={home.offset} lag={lag} cycle={cycle} reduced={reduced} />
          <span className={[styles.swap, styles.readoutNote].join(" ")}>
            <AnimatePresence mode="popLayout" initial={false}>
              {dragging
                ? <motion.span key="delta" className={styles.swapItem} variants={reduced ? fade : rise} initial="hidden" animate="shown" exit="gone">{delta}</motion.span>
                : <motion.span key={liveWeekday} className={styles.swapItem} variants={reduced ? fade : rise} initial="hidden" animate="shown" exit="gone">{liveWeekday}</motion.span>}
            </AnimatePresence>
          </span>
        </div>
      </div>
      <ul className={styles.list} aria-label="Cities. Choose one to read the dial in its time.">
        {cities.map(city => <CityRow key={city.id} city={city} homeCity={home} turn={turn} at={phase.at} committed={current} cycle={cycle} work={work} reduced={reduced} highlightId={`${uid}-home`} onSelect={() => selectHome(city.id)} />)}
      </ul>
    </div>
    <span id={`${uid}-hint`} className={styles.srOnly}>Drag around the dial or use the arrow keys to move in 15 minute steps. Page Up and Page Down move by an hour.</span>
    <p className={styles.srOnly} aria-live="polite">{announcement}</p>
  </div>;
}

export default TimeDial;
