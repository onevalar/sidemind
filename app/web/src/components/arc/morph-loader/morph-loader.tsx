"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import { animate, motion, motionValue, useAnimationFrame, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import type { AnimationPlaybackControls, MotionValue, Transition } from "motion/react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./morph-loader.module.css";

export type MorphLoaderVariant = "dots" | "bars" | "ring" | "square";
export type MorphLoaderStatus = "loading" | "success" | "error";

/**
 * A tiny loader drawn from four strokes. Every variant, and the check and cross it ends on, is the same four strokes in a new pose,
 * so changing the variant or the status morphs one shape into the next instead of swapping icons.
 */
export interface MorphLoaderProps {
  /** Loading shape. Changing it while loading morphs the strokes into the new shape. */
  variant?: MorphLoaderVariant;
  /** "success" folds the strokes into a check, "error" into a cross, and "loading" pulls them back into the variant. */
  status?: MorphLoaderStatus;
  /** Rendered size in px. The drawing is a 24 unit grid, so 16, 20, 24, and 32 stay crisp. */
  size?: number;
  /** Stroke thickness in grid units. */
  strokeWidth?: number;
  /** Colors the check with --success and the cross with --danger. Turn it off to keep currentColor throughout. */
  tone?: boolean;
  /** Announced while loading. */
  label?: string;
  /** Announced on success. */
  successLabel?: string;
  /** Announced on error. */
  errorLabel?: string;
  /** Hides the status text from assistive tech, for loaders inside a control that already announces its state. */
  decorative?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** One stroke: a center, a chord length, a direction in degrees, a bend (1 / radius), a width, and an opacity. */
interface Pose { cx: number; cy: number; len: number; ang: number; bend: number; w: number; o: number }
type Key = keyof Pose;
const KEYS: Key[] = ["cx", "cy", "len", "ang", "bend", "w", "o"];
const COUNT = 4;

const deg = (radians: number) => radians * 180 / Math.PI;
const rad = (degrees: number) => degrees * Math.PI / 180;
/** A straight stroke between two points. */
const line = (x1: number, y1: number, x2: number, y2: number, w: number): Pose =>
  ({ cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, len: Math.hypot(x2 - x1, y2 - y1), ang: deg(Math.atan2(y2 - y1, x2 - x1)), bend: 0, w, o: 1 });
/** An arc of a circle around the center, from one angle through a span. */
const arc = (radius: number, center: number, span: number, w: number): Pose => {
  const half = rad(span / 2), mid = rad(center);
  return { cx: 12 + radius * Math.cos(half) * Math.cos(mid), cy: 12 + radius * Math.cos(half) * Math.sin(mid), len: 2 * radius * Math.sin(half), ang: center + 90, bend: 1 / radius, w, o: 1 };
};
const dot = (x: number, y: number, size: number): Pose => ({ cx: x, cy: y, len: .01, ang: 0, bend: 0, w: size, o: 1 });

function poses(shape: MorphLoaderVariant | "success" | "error", stroke: number): Pose[] {
  switch (shape) {
    case "dots": return [dot(5, 12, 4), dot(12, 12, 4), dot(19, 12, 4), { ...dot(12, 12, 0), o: 0 }];
    case "bars": return [4.5, 9.5, 14.5, 19.5].map(x => line(x, 6, x, 18, 3));
    case "ring": return [0, 90, 180, 270].map(center => arc(8.5, center - 90, 64, stroke));
    case "square": return [line(5, 5, 19, 5, stroke), line(19, 5, 19, 19, stroke), line(19, 19, 5, 19, stroke), line(5, 19, 5, 5, stroke)];
    case "success": return [line(5, 12.5, 7.6, 15.1, stroke), line(7.6, 15.1, 10.2, 17.7, stroke), line(10.2, 17.7, 14.6, 12.6, stroke), line(14.6, 12.6, 19, 7.5, stroke)];
    case "error": return [line(6.5, 6.5, 12, 12, stroke), line(12, 12, 17.5, 17.5, stroke), line(17.5, 6.5, 12, 12, stroke), line(12, 12, 6.5, 17.5, stroke)];
  }
}

/** Draws one stroke. A bend near zero is a straight line; anything more is an arc through the same end points. */
function draw(p: Pose) {
  const half = Math.max(p.len, .01) / 2, a = rad(p.ang), dx = Math.cos(a) * half, dy = Math.sin(a) * half;
  const x1 = (p.cx - dx).toFixed(3), y1 = (p.cy - dy).toFixed(3), x2 = (p.cx + dx).toFixed(3), y2 = (p.cy + dy).toFixed(3);
  if (Math.abs(p.bend) < .004) return `M${x1} ${y1}L${x2} ${y2}`;
  const r = (1 / Math.abs(p.bend)).toFixed(3);
  return `M${x1} ${y1}A${r} ${r} 0 0 ${p.bend > 0 ? 1 : 0} ${x2} ${y2}`;
}

/** The shortest turn to a new direction. Straight strokes look the same reversed, so they may also flip by 180 degrees. */
function nearestAngle(from: number, to: number, symmetric: boolean) {
  const period = symmetric ? 180 : 360;
  return to + Math.round((from - to) / period) * period;
}

const subscribe = () => () => {};
function useReducedFlag() {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

/** Stroke characters restated as stiffness and damping so a retarget keeps its velocity mid flight. */
const physical = (visualDuration: number, bounce: number): Transition => {
  const root = 2 * Math.PI / (visualDuration * 1.2);
  return { type: "spring", stiffness: root * root, damping: 2 * (1 - bounce) * root, mass: 1, restDelta: .001, restSpeed: .01 };
};
const MORPH = physical(.46, .12), SETTLE = physical(.52, .28), TURN = physical(.6, .1);
const smooth01 = (t: number) => t * t * (3 - 2 * t);

function Stroke({ values, wave }: { values: Record<Key, MotionValue<number>>; wave: MotionValue<Partial<Pose>> }) {
  const d = useTransform(() => {
    const extra = wave.get();
    const pose = {} as Pose;
    for (const key of KEYS) pose[key] = values[key].get() + (extra[key] ?? 0);
    return draw(pose);
  });
  const width = useTransform(() => Math.max(0, values.w.get() + (wave.get().w ?? 0)));
  const opacity = useTransform(() => Math.min(1, Math.max(0, values.o.get())));
  return <motion.path d={d} strokeWidth={width} opacity={opacity} />;
}

export function MorphLoader({
  variant = "dots", status = "loading", size = 24, strokeWidth = 2.5, tone = true,
  label = "Loading", successLabel = "Done", errorLabel = "Failed", decorative = false, className, style,
}: MorphLoaderProps) {
  const reduced = useReducedFlag();
  const shape = status === "loading" ? variant : status;

  // Four strokes, seven values each. They spring independently, so an interruption keeps every value's velocity.
  const [strokes] = useState(() => poses(shape, strokeWidth).map(pose =>
    Object.fromEntries(KEYS.map(key => [key, motionValue(pose[key])])) as Record<Key, MotionValue<number>>));
  // The idle loop: per stroke offsets, the drawing's turn, and how much of the loop is showing (1 while loading, 0 once settled).
  const [waves] = useState(() => Array.from({ length: COUNT }, () => motionValue<Partial<Pose>>({})));
  const rotate = useMotionValue(0);
  const amount = useMotionValue(status === "loading" ? 1 : 0);
  const pop = useMotionValue(1);
  const clock = useRef(0);
  const turning = useRef<AnimationPlaybackControls | null>(null);
  const shapeRef = useRef(shape);
  useLayoutEffect(() => { shapeRef.current = shape; }, [shape]);

  useEffect(() => {
    const target = poses(shape, strokeWidth);
    const controls: AnimationPlaybackControls[] = [];
    const settling = shape === "success" || shape === "error";
    target.forEach((pose, index) => {
      const values = strokes[index];
      KEYS.forEach(key => {
        const value = values[key];
        let to = pose[key];
        if (key === "ang") to = nearestAngle(value.get(), to, pose.bend === 0 && values.bend.get() < .004);
        if (reduced) { value.set(to); return; }
        // The check draws itself in stroke order; loading shapes gather all at once.
        const delay = settling ? index * .035 : 0;
        controls.push(animate(value, to, { ...(settling ? SETTLE : MORPH), delay }));
      });
    });
    if (reduced) { amount.set(shape === "success" || shape === "error" ? 0 : 1); rotate.set(0); return; }
    controls.push(animate(amount, settling ? 0 : 1, settling ? { duration: motionTokens.duration.exit, ease: motionTokens.ease.standard } : { duration: motionTokens.duration.standard, ease: motionTokens.ease.standard }));
    if (settling) {
      // The finished mark lands upright: the turn carries on forward to the next full revolution, and the mark pops once.
      turning.current?.stop();
      const current = rotate.get();
      turning.current = animate(rotate, Math.ceil((current - 1) / 360) * 360, TURN);
      controls.push(animate(pop, [1, 1.14, 1], { duration: .42, times: [0, .35, 1], ease: ["easeOut", "easeInOut"] }));
    }
    return () => controls.forEach(control => control.stop());
  }, [shape, strokeWidth, reduced, amount, pop, rotate, strokes]);

  useAnimationFrame((_, delta) => {
    if (reduced) return;
    const loading = shapeRef.current !== "success" && shapeRef.current !== "error";
    const k = amount.get();
    if (!loading && k < .001) return;
    const dt = Math.min(delta, 64) / 1000;
    clock.current += dt * (loading ? 1 : k);
    const t = clock.current;
    const current = shapeRef.current;
    const offsets: Partial<Pose>[] = [{}, {}, {}, {}];
    if (current === "dots") {
      for (let i = 0; i < 3; i += 1) {
        const phase = Math.sin((t / .9) * Math.PI * 2 - i * .8);
        offsets[i] = { cy: -3.2 * Math.max(0, phase) * k, w: .6 * Math.max(0, phase) * k };
      }
    } else if (current === "bars") {
      for (let i = 0; i < COUNT; i += 1) {
        const phase = .5 + .5 * Math.sin((t / .95) * Math.PI * 2 - i * .7);
        offsets[i] = { len: -7.5 * (1 - phase) * k };
      }
    } else if (current === "ring") {
      const breathe = Math.sin(t * Math.PI * 2 / 1.4);
      for (let i = 0; i < COUNT; i += 1) offsets[i] = { len: -3.2 * (.5 + .5 * breathe) * k };
    } else if (current === "square") {
      // Each quarter turn tucks the sides in so the corners open, then closes them as the square lands.
      const step = (t / .9) % 1;
      const open = Math.sin(smooth01(Math.min(1, step / .8)) * Math.PI);
      for (let i = 0; i < COUNT; i += 1) offsets[i] = { len: -8 * open * k };
    }
    waves.forEach((wave, index) => wave.set(offsets[index]));

    if (loading && (current === "ring" || current === "square")) {
      turning.current?.stop();
      turning.current = null;
      if (current === "ring") rotate.set(rotate.get() + dt * 330 * k);
      else {
        // The square tumbles a quarter turn at a time with an ease in and out.
        const prev = (t - dt) / .9, next = t / .9;
        const angleAt = (x: number) => (Math.floor(x) + smooth01(Math.min(1, (x % 1) / .8))) * 90;
        rotate.set(rotate.get() + (angleAt(next) - angleAt(prev)) * k);
      }
    } else if (loading && !turning.current && Math.abs(rotate.get() % 360) > .01) {
      const current2 = rotate.get();
      turning.current = animate(rotate, Math.ceil((current2 - 1) / 360) * 360, TURN);
    }
  });

  const transform = useTransform(() => `rotate(${rotate.get().toFixed(3)}deg) scale(${pop.get().toFixed(4)})`);
  const announcement = status === "success" ? successLabel : status === "error" ? errorLabel : label;

  return <span className={[styles.root, className].filter(Boolean).join(" ")} data-status={status} data-tone={tone ? "" : undefined}
    style={{ ...style, width: size, height: size }} role={decorative ? undefined : "status"}>
    <svg className={styles.svg} viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeLinecap="round" aria-hidden="true" focusable="false">
      <motion.g style={{ transform, transformOrigin: "12px 12px", transformBox: "view-box" }}>
        {strokes.map((values, index) => <Stroke key={index} values={values} wave={waves[index]} />)}
      </motion.g>
    </svg>
    {!decorative && <span className={styles.srOnly}>{announcement}</span>}
  </span>;
}
