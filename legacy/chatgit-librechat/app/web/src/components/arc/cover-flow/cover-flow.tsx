"use client";

import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { animate, motion, useMotionValue, useMotionValueEvent, useReducedMotion, useTransform } from "motion/react";
import type { AnimationPlaybackControls, MotionValue, Transition } from "motion/react";
import styles from "./cover-flow.module.css";

export interface CoverFlowItem {
  id: string;
  title: string;
  /** A second line under the title, such as a place or an artist. */
  subtitle?: string;
  /** A short fact, such as a year or a distance. */
  meta?: string;
  /** Image URL, cropped to the card. */
  image: string;
  /** CSS object-position for the image. */
  imagePosition?: string;
  /** Describes the image for screen readers. Defaults to the title. */
  alt?: string;
}

/**
 * A depth rail for browsing a short collection of images one at a time. The chosen card stands in front; the rest turn
 * toward it on a shared floor, a little darker, each grounded by its own contact shadow. Drag or throw the rail and it lands
 * on the card its momentum reaches, scroll it sideways on a trackpad, click a card beside the front one, or use the arrow keys.
 * Use it for six to twelve visual items where one at a time is the point.
 */
export interface CoverFlowProps<T extends CoverFlowItem = CoverFlowItem> {
  items: T[];
  /** Accessible name of the carousel, such as "Hikes for this fall". */
  label: string;
  /** Controlled front card. Pair with `onIndexChange`. */
  index?: number;
  defaultIndex?: number;
  /** Called when a different card settles in front, and while a drag passes over one. */
  onIndexChange?: (index: number) => void;
  /** Replaces the caption under the rail. Captions cross over with the rail as it moves. */
  renderCaption?: (item: T, index: number) => ReactNode;
  className?: string;
}

type Sample = { t: number; p: number };
interface Gesture { pointer: number; x: number; y: number; start: number; dragging: boolean; caught: boolean; samples: Sample[] }
/** Where the cards sit: how many stay visible to each side, and the px offset of the first step and of each step after it. */
interface Layout { reach: number; near: number; far: number }

/** Degrees a side card turns toward the center, reached one step out. */
const TURN = 45;
/** How far a side card steps back, as a share of the card width: one step out, then per further step. */
const RECESS = .38, DEEPER = .14;
/** The stage perspective as a multiple of the card width. Keep in step with `perspective` in the CSS. */
const PERSPECTIVE = 3.4;
/** Spacing of the second and later side cards relative to the first. */
const TAIL = .46;
/** Darkening one step out and per further step. */
const DIM_NEAR = .42, DIM_FAR = .16;
/** Deceleration rate for momentum projection, in Apple's scroll form: a throw carries about a third of a second of travel. */
const DECELERATION = .997;
const project = (velocity: number) => velocity / 1000 * DECELERATION / (1 - DECELERATION);

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round = (value: number, places = 3) => Math.round(value * 10 ** places) / 10 ** places;
const rubber = (overshoot: number, limit = .6, constant = .55) => overshoot * limit * constant / (limit + constant * Math.abs(overshoot));

/**
 * Fits the rail to the stage: two cards a side when there is room, otherwise one, spaced so the outermost card's projected
 * near edge (side cards turn their outer edge toward the viewer) stays inside the stage with room for its shadow.
 */
function fit(stage: number, card: number): Layout {
  const reach = stage >= card * 2.85 ? 2 : 1;
  const depth = card * PERSPECTIVE, half = card / 2, turn = TURN * Math.PI / 180;
  const outerZ = -card * (RECESS + DEEPER * (reach - 1)) + half * Math.sin(turn);
  const margin = Math.max(10, card * .05);
  const room = (stage / 2 - margin) * (depth - outerZ) / depth - half * Math.cos(turn);
  const near = clamp(room / (1 + (reach - 1) * TAIL), card * .4, card * .8);
  return { reach, near, far: near * TAIL };
}

/**
 * Every landing is critically damped, so the rail never swings past the card it settles on. A spring cannot overshoot
 * while its speed toward the target stays under omega times the distance, so a faster incoming speed is capped there.
 */
function landing(distance: number, velocity: number, omega: number): Transition {
  const toward = Math.abs(distance) > .001 && Math.sign(distance) === Math.sign(velocity);
  const speed = toward ? Math.sign(velocity) * Math.min(Math.abs(velocity), omega * Math.abs(distance)) : velocity;
  return { type: "spring", stiffness: omega * omega, damping: 2 * omega, mass: 1, velocity: speed, restDelta: .0005, restSpeed: .01 };
}
/** One card per key, dot, or click. */
const STEP_OMEGA = 17;
/** A throw lands on a spring tuned to the release speed, so it decays like momentum instead of pulling ahead of the hand. */
const throwOmega = (distance: number, velocity: number) =>
  Math.abs(distance) > .05 && Math.sign(distance) === Math.sign(velocity) ? clamp(Math.abs(velocity / distance), 8, 18) : 13;

/** Release speed in cards per second from the last 100ms; a pointer that rested before lifting throws nothing. */
function releaseVelocity(samples: Sample[], now: number) {
  const recent = samples.filter(sample => now - sample.t < 100);
  if (recent.length < 2 || now - recent[recent.length - 1].t > 60) return 0;
  const first = recent[0], last = recent[recent.length - 1];
  return last.t > first.t ? (last.p - first.p) / (last.t - first.t) * 1000 : 0;
}

const subscribe = () => () => {};
function useReducedFlag() {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

interface CardProps<T extends CoverFlowItem> { item: T; index: number; count: number; active: boolean; position: MotionValue<number>; layout: Layout; width: number; onPick: (index: number) => void }

/**
 * A card placed by its distance from the rail position. Only transform and opacity change per frame. The shadows are
 * pre-blurred gradients and the reflection a static mirrored copy, painted once inside the card's own layer so they move
 * with it. Nothing inside the card sits under an overflow clip: a clipped composited child inside a 3D transform makes
 * browsers re-raster the card on every frame, which is what shows as shadow and edge flicker on phones.
 */
function Card<T extends CoverFlowItem>({ item, index, count, active, position, layout, width, onPick }: CardProps<T>) {
  const { reach, near, far } = layout;
  const distance = useTransform(position, p => index - p);
  const transform = useTransform(distance, d => {
    const a = Math.abs(d), s = Math.sign(d), first = Math.min(a, 1);
    const beyond = Math.max(0, a - 1), tail = Math.min(beyond, reach - 1) + Math.max(0, a - reach) * .35;
    const x = s * (near * first + far * tail);
    const z = -width * (RECESS * first + DEEPER * Math.min(beyond, reach));
    const turn = -s * first * TURN;
    return `translate3d(${round(x, 2)}px, 0, ${round(z, 2)}px) rotateY(${round(turn, 2)}deg)`;
  });
  // Cards past the visible reach fade out while they are still tucked behind their neighbor, so nothing meets a hard crop.
  const opacity = useTransform(distance, d => round(clamp((reach + .7 - Math.abs(d)) / .7, 0, 1)));
  const zIndex = useTransform(distance, d => Math.round(100 - Math.abs(d) * 10));
  const visibility = useTransform(distance, d => Math.abs(d) > reach + .75 ? "hidden" : "visible");
  const veil = useTransform(distance, d => { const a = Math.abs(d); return round(Math.min(a, 1) * DIM_NEAR + clamp(a - 1, 0, reach) * DIM_FAR); });
  // Light falls from the front: a turned card's far edge darkens a little more than its near edge.
  const edge = useTransform(distance, d => round(clamp(Math.abs(d), 0, 1) * .45));
  const edgeSide = useTransform(distance, d => `linear-gradient(${d < 0 ? 90 : 270}deg, transparent 40%, oklch(0% 0 0 / .5))`);
  const reflection = useTransform(distance, d => round(1 - Math.min(Math.abs(d), 1) * .45));
  return <motion.div className={styles.card} role="group" aria-roledescription="slide" aria-label={`${index + 1} of ${count}: ${item.title}`} aria-hidden={!active}
    data-active={active || undefined} style={{ transform, opacity, zIndex, visibility }} onClick={() => onPick(index)}>
    <span className={styles.ambient} aria-hidden="true" />
    <motion.span className={styles.reflection} style={{ opacity: reflection }} aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element -- plain img keeps the registry item framework neutral */}
      <img className={styles.image} src={item.image} alt="" draggable={false} decoding="async" style={{ objectPosition: item.imagePosition }} />
    </motion.span>
    <span className={styles.contact} aria-hidden="true" />
    <span className={styles.face}>
      {/* eslint-disable-next-line @next/next/no-img-element -- plain img keeps the registry item framework neutral */}
      <img className={styles.image} src={item.image} alt={active ? item.alt ?? item.title : ""} draggable={false} decoding="async" style={{ objectPosition: item.imagePosition }} />
      <motion.span className={styles.veil} style={{ opacity: veil }} aria-hidden="true" />
      <motion.span className={styles.edge} style={{ opacity: edge, backgroundImage: edgeSide }} aria-hidden="true" />
    </span>
  </motion.div>;
}

/** A caption tied to the rail position: it hands over to the next one exactly as its card leaves the front. */
function Caption({ index, position, active, children }: { index: number; position: MotionValue<number>; active: boolean; children: ReactNode }) {
  const opacity = useTransform(position, p => round(clamp((.55 - Math.abs(index - p)) / .45, 0, 1)));
  const transform = useTransform(position, p => `translate3d(${round(clamp(index - p, -1, 1) * 18, 2)}px, 0, 0)`);
  const visibility = useTransform(position, p => Math.abs(index - p) < .56 ? "visible" : "hidden");
  return <motion.div className={styles.captionItem} aria-hidden={!active} style={{ opacity, transform, visibility }}>{children}</motion.div>;
}

export function CoverFlow<T extends CoverFlowItem>({ items, label, index, defaultIndex = 0, onIndexChange, renderCaption, className }: CoverFlowProps<T>) {
  const reduced = useReducedFlag();
  const count = items.length;
  const last = Math.max(0, count - 1);
  const [initial] = useState(() => clamp(Math.round(index ?? defaultIndex), 0, last));
  const [active, setActive] = useState(initial);
  const [size, setSize] = useState({ stage: 720, card: 232 });
  const [announcement, setAnnouncement] = useState("");
  const layout = fit(size.stage, size.card);

  const position = useMotionValue(initial);
  const stageRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const target = useRef(initial);
  const activeRef = useRef(initial);
  const gesture = useRef<Gesture | null>(null);
  const suppress = useRef(false);
  const controls = useRef<AnimationPlaybackControls | null>(null);
  const wheel = useRef({ timer: 0, samples: [] as Sample[] });
  const gestureStart = useRef(initial);

  // Cards are sized in CSS; the rail reads the card and stage widths so spacing and drag distance follow the container.
  useLayoutEffect(() => {
    const stage = stageRef.current, card = cardRef.current;
    if (!stage || !card) return;
    const update = () => {
      const next = { stage: stage.clientWidth || 720, card: card.offsetWidth || 232 };
      setSize(current => current.stage === next.stage && current.card === next.card ? current : next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    observer.observe(card);
    return () => observer.disconnect();
  }, []);

  function commit(next: number, announce: boolean) {
    if (next !== activeRef.current) {
      activeRef.current = next;
      setActive(next);
      onIndexChange?.(next);
    }
    if (announce && items[next]) setAnnouncement(`${items[next].title}, ${next + 1} of ${count}`);
  }

  // While the rail travels, the card nearest the center is the one in front.
  useMotionValueEvent(position, "change", p => {
    if (gesture.current?.dragging || wheel.current.timer) commit(clamp(Math.round(p), 0, last), false);
  });

  function go(to: number, transition: Transition, announce = true) {
    const next = clamp(to, 0, last);
    target.current = next;
    commit(next, announce);
    controls.current?.stop();
    if (reduced) { position.jump(next); return; }
    controls.current = animate(position, next, transition);
  }
  const jump = (to: number, announce = true) => {
    const next = clamp(to, 0, last);
    go(next, landing(next - position.get(), position.getVelocity(), STEP_OMEGA), announce);
  };
  const step = (delta: number) => jump(target.current + delta);

  /** Lands a release on the card its momentum reaches, handing the release speed to the spring. */
  function settle(velocity: number) {
    const from = position.get();
    let to = clamp(Math.round(from + project(velocity)), 0, last);
    // A quick flick always moves on at least one card, however short the drag.
    const origin = Math.round(gestureStart.current);
    if (Math.abs(velocity) > 1.6 && to === origin) to = clamp(origin + Math.sign(velocity), 0, last);
    go(to, landing(to - from, velocity, throwOmega(to - from, velocity)));
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary || gesture.current) return;
    suppress.current = false;
    const caught = !reduced && position.isAnimating();
    if (caught) { controls.current?.stop(); position.stop(); }
    gesture.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, start: position.get(), dragging: false, caught, samples: [{ t: event.timeStamp, p: position.get() }] };
    gestureStart.current = position.get();
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g || g.pointer !== event.pointerId) return;
    const dx = event.clientX - g.x, dy = event.clientY - g.y;
    if (!g.dragging) {
      if (Math.abs(dx) < 6 || Math.abs(dx) < Math.abs(dy)) {
        if (Math.abs(dy) > 10) gesture.current = null;
        return;
      }
      g.dragging = true;
      g.x = event.clientX;
      event.currentTarget.setPointerCapture(event.pointerId);
      stageRef.current?.setAttribute("data-dragging", "");
      return;
    }
    if (reduced) return;
    // The card under the finger travels with it: one card per first-step spacing. Past either end the rail resists.
    const raw = g.start - (event.clientX - g.x) / layout.near;
    const p = raw < 0 ? rubber(raw) : raw > last ? last + rubber(raw - last) : raw;
    position.set(p);
    g.samples.push({ t: event.timeStamp, p });
    if (g.samples.length > 12) g.samples.shift();
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g || g.pointer !== event.pointerId) return;
    gesture.current = null;
    stageRef.current?.removeAttribute("data-dragging");
    if (!g.dragging) { if (g.caught) settle(0); return; }
    suppress.current = true;
    if (reduced) {
      const dx = event.clientX - g.x;
      if (Math.abs(dx) > 40 && event.type !== "pointercancel") step(dx < 0 ? 1 : -1);
      return;
    }
    settle(event.type === "pointercancel" ? 0 : releaseVelocity(g.samples, event.timeStamp));
  }

  function pick(next: number) {
    if (suppress.current) { suppress.current = false; return; }
    if (next !== target.current) jump(next);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowRight") step(1);
    else if (event.key === "ArrowLeft") step(-1);
    else if (event.key === "Home") jump(0);
    else if (event.key === "End") jump(last);
    else return;
    event.preventDefault();
  }

  // A sideways trackpad swipe scrolls the rail directly, then settles with the speed it had when the fingers lifted.
  const onWheel = useEffectEvent((event: WheelEvent) => {
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY) || gesture.current) return;
    event.preventDefault();
    const state = wheel.current;
    controls.current?.stop();
    position.stop();
    if (reduced) {
      if (!state.timer) step(event.deltaX > 0 ? 1 : -1);
      window.clearTimeout(state.timer);
      state.timer = window.setTimeout(() => { state.timer = 0; }, 260);
      return;
    }
    const current = position.get(), raw = current + event.deltaX / (layout.near * 1.4);
    const p = raw < 0 ? Math.max(raw, rubber(raw)) : raw > last ? Math.min(raw, last + rubber(raw - last)) : raw;
    position.set(p);
    state.samples.push({ t: event.timeStamp, p });
    if (state.samples.length > 10) state.samples.shift();
    window.clearTimeout(state.timer);
    state.timer = window.setTimeout(() => {
      const samples = state.samples;
      const end = samples[samples.length - 1], first = samples.find(sample => end.t - sample.t < 120) ?? end;
      const velocity = end.t > first.t ? (end.p - first.p) / (end.t - first.t) * 1000 : 0;
      state.samples = [];
      state.timer = 0;
      gestureStart.current = position.get();
      settle(clamp(velocity * .6, -12, 12));
    }, 90);
  });
  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const listener = (event: WheelEvent) => onWheel(event);
    node.addEventListener("wheel", listener, { passive: false });
    return () => node.removeEventListener("wheel", listener);
  }, []);
  useEffect(() => () => window.clearTimeout(wheel.current.timer), []);

  const syncIndex = useEffectEvent((next: number) => { if (next !== activeRef.current) jump(next, false); });
  useEffect(() => { if (index !== undefined) syncIndex(clamp(Math.round(index), 0, last)); }, [index, last]);

  // The rail's progress: a thumb that glides with the position, over one dot per card, including mid throw.
  const thumb = useTransform(position, p => `translate3d(${round(clamp(p, -.4, last + .4) * 16, 2)}px, 0, 0)`);

  return <section className={[styles.root, className].filter(Boolean).join(" ")} aria-roledescription="carousel" aria-label={label} data-reduced={reduced || undefined}>
    <div ref={stageRef} className={styles.stage} tabIndex={0} onKeyDown={onKeyDown} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onDragStart={event => event.preventDefault()}>
      <div ref={cardRef} className={styles.sizer} aria-hidden="true" />
      {items.map((entry, i) => <Card key={entry.id} item={entry} index={i} count={count} active={i === active} position={position} layout={layout} width={size.card} onPick={pick} />)}
    </div>
    <div className={styles.footer}>
      <div className={styles.caption}>
        {items.map((entry, i) => <Caption key={entry.id} index={i} position={position} active={i === active}>
          {renderCaption ? renderCaption(entry, i) : <>
            <p className={styles.title}>{entry.title}</p>
            {(entry.subtitle || entry.meta) && <p className={styles.subtitle}>{[entry.subtitle, entry.meta].filter(Boolean).join(", ")}</p>}
          </>}
        </Caption>)}
      </div>
      <div className={styles.ticks} role="group" aria-label={`${label} position`}>
        {items.map((entry, i) => <button key={entry.id} type="button" className={styles.tick} aria-label={`Show ${entry.title}`} aria-current={i === active || undefined} tabIndex={-1} onClick={() => jump(i)} />)}
        <motion.span className={styles.thumb} style={{ transform: thumb }} aria-hidden="true" />
      </div>
    </div>
    <p className={styles.srOnly} aria-live="polite" aria-atomic="true">{announcement}</p>
  </section>;
}

export default CoverFlow;
