"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { AnimatePresence, LayoutGroup, MotionConfig, animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import type { MotionValue } from "motion/react";
import { Check } from "lucide-react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./activity-rings.module.css";

export interface ActivityMetric {
  id: string;
  label: string;
  /** Short unit after the number, such as "min". */
  unit: string;
  goal: number;
  /** Ring color. Falls back to the built in indigo, amber, and sage. */
  color?: string;
}
export interface ActivityRingsDay {
  id: string;
  /** Full label for assistive technology, such as "Monday, September 14". */
  label: string;
  /** Short label under the day, such as "Mon". */
  short: string;
  values: Record<string, number>;
}

/** Daily goals drawn as concentric tick rings, like a precise instrument. Arcs sweep to each day's value, a second lap traces the inside edge past 100%, and numbers count to their new amounts. Hover or select a goal to isolate it; pick a day from the week below. */
export interface ActivityRingsProps {
  metrics: ActivityMetric[];
  days: ActivityRingsDay[];
  day?: string;
  defaultDay?: string;
  onDayChange?: (day: string) => void;
  focused?: string | null;
  defaultFocused?: string | null;
  onFocusedChange?: (metric: string | null) => void;
  /** Called when a value crosses its goal. */
  onRingClose?: (metric: string, day: string) => void;
  label?: string;
  className?: string;
}

const PALETTE = ["oklch(60% .17 275)", "oklch(75% .15 68)", "oklch(66% .09 160)"];
const SIZE = 220;
const C = SIZE / 2;
const BAND = 13;
const BAND_GAP = 7;
const OUTER = 106;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const number = new Intl.NumberFormat("en-US");

function bandFor(index: number) {
  const outer = OUTER - index * (BAND + BAND_GAP);
  return { outer, inner: outer - BAND, mid: outer - BAND / 2 };
}

interface RingProps { metric: ActivityMetric; color: string; index: number; values: MotionValue<number[]>; dimmed: boolean; uid: string }

/* One ring: evenly spaced ticks, a mask that sweeps to the value, a hairline second lap past 100%, and a marker at the leading edge. */
function Ring({ metric, color, index, values, dimmed, uid }: RingProps) {
  const { outer, inner, mid } = bandFor(index);
  const ticks = Math.round((2 * Math.PI * mid) / 11 / 4) * 4;
  const ratio = useTransform(values, v => Math.max(0, (v[index] ?? 0) / metric.goal));
  const firstLap = useTransform(ratio, r => clamp(r, 0, 1));
  const secondLap = useTransform(ratio, r => clamp(r - 1, 0, 1));
  const lapOpacity = useTransform(ratio, r => r > 1.005 ? 1 : 0);
  const maskId = `${uid}-mask-${index}`;
  const lines = Array.from({ length: ticks }, (_, i) => {
    const a = (i / ticks) * Math.PI * 2;
    // Rounded so server and client trig agree to the last digit and hydration matches.
    const at = (r: number, f: (n: number) => number) => Math.round((C + f(a) * r) * 1000) / 1000;
    return <line key={i} x1={at(inner + 1, Math.cos)} y1={at(inner + 1, Math.sin)} x2={at(outer - 1, Math.cos)} y2={at(outer - 1, Math.sin)} />;
  });

  return <g className={styles.ring} data-dimmed={dimmed || undefined} style={{ "--ring": color } as CSSProperties}>
    <mask id={maskId}>
      <g transform={`rotate(-90 ${C} ${C})`}><motion.circle cx={C} cy={C} r={mid} fill="none" stroke="white" strokeWidth={BAND + 4} style={{ pathLength: firstLap }} /></g>
    </mask>
    <g className={styles.ticksBase}>{lines}</g>
    <g className={styles.ticksFill} mask={`url(#${maskId})`}>{lines}</g>
    <g transform={`rotate(-90 ${C} ${C})`}><motion.circle className={styles.lap} cx={C} cy={C} r={inner - 4} style={{ pathLength: secondLap, opacity: lapOpacity }} /></g>
  </g>;
}

/* The leading edge marker lives in HTML over the SVG so it can rotate around the dial's center on the compositor. */
function RingMarker({ metric, index, values, dimmed }: { metric: ActivityMetric; index: number; values: MotionValue<number[]>; dimmed: boolean }) {
  const { outer } = bandFor(index);
  const turn = useTransform(values, v => Math.max(0, (v[index] ?? 0) / metric.goal) * 360);
  const opacity = useTransform(values, v => (v[index] ?? 0) > metric.goal * .005 ? 1 : 0);
  const toPercent = (value: number) => `${(value / SIZE) * 100}%`;
  return <motion.div className={styles.markerArm} data-dimmed={dimmed || undefined} style={{ rotate: turn, opacity }} aria-hidden="true">
    <span className={styles.marker} style={{ top: toPercent(C - outer - 2), height: toPercent(BAND + 4) }} />
  </motion.div>;
}

function Count({ value, format }: { value: MotionValue<number>; format: (value: number) => string }) {
  const text = useTransform(value, format);
  return <motion.span>{text}</motion.span>;
}

interface LegendRowProps { metric: ActivityMetric; color: string; index: number; values: MotionValue<number[]>; target: number; pressed: boolean; dimmed: boolean; onToggle: () => void; onHover: (on: boolean) => void }

function LegendRow({ metric, color, index, values, target, pressed, dimmed, onToggle, onHover }: LegendRowProps) {
  const value = useTransform(values, v => v[index] ?? 0);
  const met = target >= metric.goal;
  return <button type="button" className={styles.legendRow} aria-pressed={pressed} data-dimmed={dimmed || undefined} style={{ "--ring": color } as CSSProperties}
    aria-label={`${metric.label}, ${number.format(target)} of ${number.format(metric.goal)} ${metric.unit}, ${Math.round((target / metric.goal) * 100)} percent${met ? ", goal met" : ""}`}
    onClick={onToggle} onPointerEnter={event => event.pointerType === "mouse" && onHover(true)} onPointerLeave={() => onHover(false)} onFocus={() => onHover(true)} onBlur={() => onHover(false)}>
    <span className={styles.swatch} aria-hidden="true" />
    <span className={styles.legendText} aria-hidden="true">
      <span className={styles.legendLabel}>{metric.label}</span>
      <span className={styles.legendValue}><Count value={value} format={v => number.format(Math.round(v))} /> / {number.format(metric.goal)} {metric.unit}</span>
    </span>
    <span className={styles.legendPercent} aria-hidden="true">
      <AnimatePresence initial={false}>
        {met && <motion.span key="met" className={styles.met} initial={{ opacity: 0, scale: .6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .6 }} transition={motionTokens.spring.snappy}><Check size={12} strokeWidth={2.25} /></motion.span>}
      </AnimatePresence>
      <Count value={value} format={v => `${Math.round((v / metric.goal) * 100)}%`} />
    </span>
  </button>;
}

function MiniRings({ metrics, day }: { metrics: ActivityMetric[]; day: ActivityRingsDay }) {
  return <svg className={styles.mini} viewBox="0 0 32 32" aria-hidden="true">
    {metrics.map((metric, i) => {
      const r = 14 - i * 4.5;
      const p = clamp((day.values[metric.id] ?? 0) / metric.goal, 0, 1);
      return <g key={metric.id} style={{ "--ring": metric.color ?? PALETTE[i % PALETTE.length] } as CSSProperties}>
        <circle className={styles.miniTrack} cx="16" cy="16" r={r} />
        <circle className={styles.miniArc} cx="16" cy="16" r={r} pathLength={1} strokeDasharray={`${p} 1`} />
      </g>;
    })}
  </svg>;
}

export function ActivityRings({ metrics, days, day, defaultDay, onDayChange, focused, defaultFocused = null, onFocusedChange, onRingClose, label = "Activity", className }: ActivityRingsProps) {
  const reduced = useReducedMotion() ?? false;
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [ownDay, setOwnDay] = useState(defaultDay ?? days[days.length - 1]?.id);
  const [ownFocused, setOwnFocused] = useState<string | null>(defaultFocused);
  const [hovered, setHovered] = useState<string | null>(null);
  const dayId = day ?? ownDay;
  const current = days.find(item => item.id === dayId) ?? days[days.length - 1];
  const pinned = focused === undefined ? ownFocused : focused;
  const spotlight = hovered ?? pinned;
  const targets = metrics.map(metric => current?.values[metric.id] ?? 0);
  const key = targets.join(",");
  const values = useMotionValue<number[]>(metrics.map(() => 0));
  const previous = useRef<{ day: string; targets: number[] } | null>(null);
  const dayRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Every change sweeps from what is on screen now to the new values, so a quick second change redirects mid flight.
  useEffect(() => {
    const to = key.split(",").map(Number);
    if (reduced) { values.set(to); return; }
    const from = values.get();
    const controls = animate(0, 1, { type: "spring", visualDuration: .9, bounce: 0, onUpdate: p => values.set(from.map((f, i) => lerp(f, to[i] ?? 0, p))) });
    return () => controls.stop();
  }, [key, values, reduced]);

  useEffect(() => {
    const before = previous.current;
    const to = key.split(",").map(Number);
    if (before && before.day === dayId) metrics.forEach((metric, i) => { if ((before.targets[i] ?? 0) < metric.goal && (to[i] ?? 0) >= metric.goal) onRingClose?.(metric.id, dayId); });
    previous.current = { day: dayId, targets: to };
  }, [key, dayId, metrics, onRingClose]);

  function pickDay(id: string) { setOwnDay(id); onDayChange?.(id); }
  function toggleFocus(id: string) {
    const next = pinned === id ? null : id;
    setOwnFocused(next);
    onFocusedChange?.(next);
  }
  function onDayKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    const i = days.findIndex(item => item.id === current?.id);
    const map: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: -Infinity, End: Infinity };
    if (!(event.key in map)) return;
    event.preventDefault();
    const next = map[event.key] === Infinity ? days.length - 1 : map[event.key] === -Infinity ? 0 : clamp(i + map[event.key], 0, days.length - 1);
    pickDay(days[next].id);
    dayRefs.current[next]?.focus();
  }

  const colorOf = (metric: ActivityMetric, i: number) => metric.color ?? PALETTE[i % PALETTE.length];
  const spotIndex = metrics.findIndex(metric => metric.id === spotlight);
  const spotMetric = spotIndex >= 0 ? metrics[spotIndex] : null;
  const overall = useTransform(values, v => metrics.reduce((sum, metric, i) => sum + clamp((v[i] ?? 0) / metric.goal, 0, 1), 0) / Math.max(1, metrics.length) * 100);
  const spotValue = useTransform(values, v => spotIndex >= 0 ? v[spotIndex] ?? 0 : 0);
  const swap = { initial: { opacity: 0, y: 6, filter: `blur(${motionTokens.blur.subtle}px)` }, animate: { opacity: 1, y: 0, filter: "blur(0px)" }, exit: { opacity: 0, y: -6, filter: `blur(${motionTokens.blur.subtle}px)`, transition: { duration: motionTokens.duration.instant } }, transition: { duration: motionTokens.duration.standard, ease: motionTokens.ease.enter as unknown as [number, number, number, number] } };

  return <MotionConfig reducedMotion="user">
    <section className={[styles.root, className].filter(Boolean).join(" ")} aria-label={label}>
      <div className={styles.main}>
        <div className={styles.dial}>
          <svg className={styles.rings} viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={`${current?.label}: ${metrics.map((metric, i) => `${metric.label} ${Math.round((targets[i] / metric.goal) * 100)}%`).join(", ")}`}>
            {metrics.map((metric, i) => <Ring key={metric.id} metric={metric} color={colorOf(metric, i)} index={i} values={values} dimmed={!!spotlight && spotlight !== metric.id} uid={uid} />)}
          </svg>
          {metrics.map((metric, i) => <RingMarker key={metric.id} metric={metric} index={i} values={values} dimmed={!!spotlight && spotlight !== metric.id} />)}
          <div className={styles.center} aria-hidden="true">
            <AnimatePresence initial={false} mode="popLayout">
              <motion.div key={spotMetric?.id ?? "overall"} className={styles.centerInner} {...swap}>
                <span className={styles.centerValue}>
                  {spotMetric ? <Count value={spotValue} format={v => number.format(Math.round(v))} /> : <><Count value={overall} format={v => String(Math.round(v))} /><span className={styles.centerUnit}>%</span></>}
                </span>
                <span className={styles.centerLabel}>{spotMetric ? `${spotMetric.unit} ${spotMetric.label.toLowerCase()}` : "of goals"}</span>
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
        <div className={styles.legend}>
          {metrics.map((metric, i) => <LegendRow key={metric.id} metric={metric} color={colorOf(metric, i)} index={i} values={values} target={targets[i]}
            pressed={pinned === metric.id} dimmed={!!spotlight && spotlight !== metric.id} onToggle={() => toggleFocus(metric.id)} onHover={on => setHovered(on ? metric.id : null)} />)}
        </div>
      </div>

      <LayoutGroup id={uid}>
        <div className={styles.week} role="radiogroup" aria-label="Day" onKeyDown={onDayKey}>
          {days.map((item, i) => {
            const selected = item.id === current?.id;
            return <button key={item.id} ref={node => { dayRefs.current[i] = node; }} type="button" role="radio" aria-checked={selected} aria-label={item.label} tabIndex={selected ? 0 : -1}
              className={styles.day} onClick={() => pickDay(item.id)}>
              {selected && <motion.span layoutId="day-highlight" className={styles.dayHighlight} transition={motionTokens.spring.morph} />}
              <MiniRings metrics={metrics} day={item} />
              <span className={styles.dayLabel}>{item.short}</span>
            </button>;
          })}
        </div>
      </LayoutGroup>
    </section>
  </MotionConfig>;
}

export default ActivityRings;
