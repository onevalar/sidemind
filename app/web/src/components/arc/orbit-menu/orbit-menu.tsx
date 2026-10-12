"use client";

import { useEffect, useEffectEvent, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import type { MotionValue, Transition } from "motion/react";
import { Check } from "lucide-react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./orbit-menu.module.css";

export interface OrbitAction {
  id: string;
  label: string;
  icon: ReactNode;
  /** Short confirmation shown once the action fires, such as "Pinned". Defaults to the label. */
  done?: string;
  /** Danger actions take a quiet red tint and glyph while targeted. The label still has to say what happens. */
  tone?: "neutral" | "danger";
}

/**
 * A round button that bursts into an arc of actions. Press and drag onto an action and let go to fire it in one motion,
 * or click to keep the arc open and pick at leisure. The arrow keys walk the arc.
 * Use it for three to six quick actions on one object, such as a note or a photo, where a menu is too heavy and a toolbar too loud.
 */
export interface OrbitMenuProps {
  actions: OrbitAction[];
  onAction: (id: string) => void;
  /** Accessible name of the button and the menu. It also shows while the arc is open and nothing is targeted. */
  label?: string;
  /** Distance from the button's center to each action, in px. */
  radius?: number;
  /** Degrees the arc spans. */
  spread?: number;
  /** Degrees the arc opens toward: -90 up, 0 right, 90 down, 180 left. */
  direction?: number;
  disabled?: boolean;
  /** Announces confirmations in a polite live region. Turn it off when the page reports results itself. */
  announce?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

const { spring, duration, ease, blur, stagger } = motionTokens;
const enter = [...ease.enter] as [number, number, number, number];
const standard = [...ease.standard] as [number, number, number, number];
/** Shared spring tokens restated as stiffness and damping, so interrupted motion keeps its velocity instead of restarting from rest. */
const physical = ({ visualDuration, bounce }: { visualDuration: number; bounce: number }): Transition => {
  const root = 2 * Math.PI / (visualDuration * 1.2);
  return { type: "spring", stiffness: root * root, damping: 2 * (1 - bounce) * root, mass: 1 };
};
const snappy = physical(spring.snappy), morph = physical(spring.morph);
/** Actions leave the button with a little overshoot, and fold back faster without any. */
const burst = physical({ visualDuration: .5, bounce: .22 });
const fold = physical({ visualDuration: .32, bounce: 0 });
/** The button and the magnet let go with a small wobble. */
const settle = physical({ visualDuration: .34, bounce: .22 });
const instant: Transition = { duration: 0 };

/** Pointer dead zone around the button center, in px. */
const INNER = 34;
/** How far the magnet reaches from an action, how much it grows, how far it leans toward the pointer, and the lift of a focused action. */
const REACH = 92, GROW = .32, PULL = 14, LIFT = .1;
/** Radians an action sweeps through on its way out. */
const SWIRL = .75;

const rad = (degrees: number) => degrees * Math.PI / 180;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
/** Resistance past an edge: the further the pull, the less it follows, and it never stops dead. */
const rubber = (distance: number, dimension: number, constant = .55) => (distance * dimension * constant) / (dimension + constant * distance);
const blurOf = (amount: number, radius: number) => amount < .01 ? "none" : `blur(${(amount * radius).toFixed(2)}px)`;
const polar = (radius: number, angle: number) => [Math.cos(angle) * radius, Math.sin(angle) * radius];
const arcPath = (radius: number, from: number, to: number) => {
  if (radius < .5) return "M0 0";
  const [x1, y1] = polar(radius, from), [x2, y2] = polar(radius, to);
  return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${radius.toFixed(2)} ${radius.toFixed(2)} 0 ${Math.abs(to - from) > Math.PI ? 1 : 0} ${to > from ? 1 : 0} ${x2.toFixed(2)} ${y2.toFixed(2)}`;
};
/** Closeness of the pointer to a resting spot, eased so the pull builds gently and firms up near the center. */
function magnet(x: number, y: number, bx: number, by: number) {
  const dx = x - bx, dy = y - by, distance = Math.hypot(dx, dy), raw = clamp01(1 - distance / REACH);
  return { strength: raw * raw * (3 - 2 * raw), dx, dy, distance };
}
function lean({ strength, dx, dy, distance }: ReturnType<typeof magnet>, amount: number) {
  if (distance < .01) return [0, 0];
  const pull = Math.min(distance * .2, PULL) * strength * amount;
  return [dx / distance * pull, dy / distance * pull];
}
const subscribe = () => () => {};

/** Reduced motion only after hydration, so server and client render the same first frame. */
function useReducedFlag() {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

type Glyph = "more" | "close" | "done";
/** Three lines that morph between an ellipsis, a close cross, and a check. Dots are lines with no length, and the middle one hides in the joint. */
const glyphs: Record<Glyph, { a: number[]; b: number[]; c: number[]; width: number; rotate: number }> = {
  more: { a: [6, 12, 6.01, 12], b: [18, 12, 18.01, 12], c: [12, 12, 12.01, 12], width: 3.2, rotate: 0 },
  close: { a: [7, 7, 17, 17], b: [17, 7, 7, 17], c: [12, 12, 12.01, 12], width: 2, rotate: 90 },
  done: { a: [5.5, 12.5, 10, 17], b: [18.5, 7, 10, 17], c: [10, 17, 10.01, 17], width: 2.2, rotate: 0 },
};

function MorphGlyph({ glyph, reduced }: { glyph: Glyph; reduced: boolean }) {
  const shape = glyphs[glyph], transition = reduced ? instant : morph;
  const line = ([x1, y1, x2, y2]: number[]) => ({ x1, y1, x2, y2, strokeWidth: shape.width });
  return <motion.svg className={styles.glyph} viewBox="0 0 24 24" aria-hidden="true" initial={false} animate={{ rotate: shape.rotate }} transition={transition}>
    <motion.line initial={false} animate={line(shape.a)} transition={transition} />
    <motion.line initial={false} animate={line(shape.b)} transition={transition} />
    <motion.line initial={false} animate={line(shape.c)} transition={transition} />
  </motion.svg>;
}

interface Pointer { x: MotionValue<number>; y: MotionValue<number>; engaged: MotionValue<number>; allow: MotionValue<number> }

interface ItemProps {
  action: OrbitAction;
  index: number;
  count: number;
  angle: number;
  radius: number;
  open: boolean;
  active: boolean;
  fired: boolean;
  focusable: boolean;
  reduced: boolean;
  pointer: Pointer;
  setRef: (index: number, node: HTMLButtonElement | null) => void;
  onFire: (index: number) => void;
  onFocus: (index: number) => void;
  onKey: (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => void;
}

/** One action on the orbit. Its shape travels out first and its glyph arrives a beat later; near the pointer it grows and leans in. */
function OrbitItem({ action, index, count, angle, radius, open, active, fired, focusable, reduced, pointer, setRef, onFire, onFocus, onKey }: ItemProps) {
  const t = useMotionValue(0), shown = useMotionValue(0), lift = useMotionValue(0), pop = useMotionValue(1);
  const [bx, by] = polar(radius, angle);

  useEffect(() => {
    if (reduced) {
      if (open) { t.jump(1); const controls = animate(shown, 1, { duration: duration.fast, ease: enter }); return () => controls.stop(); }
      const controls = animate(shown, 0, { duration: duration.instant, ease: standard, delay: fired ? .08 : 0, onComplete: () => t.jump(0) });
      return () => controls.stop();
    }
    // Out in reading order, back in reverse and quicker. A fired action pops, then folds a beat after the rest: long
    // enough to read the pop, short enough that the menu never looks stuck open.
    const delay = open ? index * stagger.item : fired ? .1 : (count - 1 - index) * .018;
    const move = animate(t, open ? 1 : 0, { ...(open ? burst : fold), delay });
    const fade = animate(shown, open ? 1 : 0, open ? { duration: .2, ease: enter, delay } : { duration: duration.fast, ease: standard, delay: delay + .06 });
    return () => { move.stop(); fade.stop(); };
  }, [count, fired, index, open, reduced, shown, t]);

  useEffect(() => {
    const controls = animate(lift, active ? 1 : 0, reduced ? instant : snappy);
    return () => controls.stop();
  }, [active, lift, reduced]);

  useEffect(() => {
    if (!fired || reduced) return;
    // A kick of velocity at rest reads as a physical pop rather than a scripted keyframe.
    const controls = animate(pop, 1, { type: "spring", stiffness: 700, damping: 17, velocity: 7 });
    return () => controls.stop();
  }, [fired, pop, reduced]);

  const x = useTransform([t, pointer.x, pointer.y, pointer.engaged, pointer.allow], ([p, px, py, engaged, allow]: number[]) => {
    const k = Math.max(0, p), turn = angle - (1 - k) * SWIRL * allow;
    return Math.cos(turn) * radius * k + lean(magnet(px, py, bx, by), engaged * allow * clamp01(k))[0];
  });
  const y = useTransform([t, pointer.x, pointer.y, pointer.engaged, pointer.allow], ([p, px, py, engaged, allow]: number[]) => {
    const k = Math.max(0, p), turn = angle - (1 - k) * SWIRL * allow;
    return Math.sin(turn) * radius * k + lean(magnet(px, py, bx, by), engaged * allow * clamp01(k))[1];
  });
  const scale = useTransform([t, pointer.x, pointer.y, pointer.engaged, lift, pop], ([p, px, py, engaged, lifted, popped]: number[]) =>
    (.4 + .6 * Math.max(0, p)) * (1 + GROW * magnet(px, py, bx, by).strength * engaged + LIFT * lifted) * popped);
  const filter = useTransform([t, pointer.allow], ([p, allow]: number[]) => blurOf((1 - clamp01(p / .6)) * allow, blur.soft));
  const glyphOpacity = useTransform(t, [.35, .85], [0, 1]);
  const glyphScale = useTransform(t, [.3, 1], [.5, 1]);

  return <motion.button ref={node => setRef(index, node)} type="button" role="menuitem" aria-label={action.label} tabIndex={focusable ? 0 : -1} className={styles.item}
    data-active={active || undefined} data-fired={fired || undefined} data-danger={action.tone === "danger" || undefined}
    style={{ x, y, scale, opacity: shown, filter }} onClick={() => onFire(index)} onFocus={() => onFocus(index)} onKeyDown={event => onKey(event, index)}>
    <motion.span className={styles.icon} style={{ opacity: glyphOpacity, scale: glyphScale }}>{action.icon}</motion.span>
  </motion.button>;
}

interface LensProps { angle: number; visible: boolean; danger: boolean; radius: number; track: MotionValue<number>; pointer: Pointer; reduced: boolean }

/** The filled disc behind the targeted action. It glides along the orbit from one action to the next instead of blinking between them. */
function Lens({ angle, visible, danger, radius, track, pointer, reduced }: LensProps) {
  const turn = useMotionValue(angle), on = useMotionValue(0);
  useEffect(() => {
    if (!visible) {
      const controls = animate(on, 0, reduced ? { duration: .1 } : physical({ visualDuration: .2, bounce: 0 }));
      return () => controls.stop();
    }
    // Appearing from nothing it starts in place; already showing, it travels.
    const fresh = reduced || on.get() < .08;
    if (fresh) turn.jump(angle);
    const travel = fresh ? null : animate(turn, angle, snappy);
    const grow = animate(on, 1, reduced ? { duration: duration.instant, ease: enter } : snappy);
    return () => { travel?.stop(); grow.stop(); };
  }, [angle, on, reduced, turn, visible]);

  const x = useTransform([turn, track, pointer.x, pointer.y, pointer.engaged, pointer.allow], ([a, k, px, py, engaged, allow]: number[]) => {
    const [bx, by] = polar(radius, a);
    return Math.cos(a) * radius * (.55 + .45 * k) + lean(magnet(px, py, bx, by), engaged * allow)[0];
  });
  const y = useTransform([turn, track, pointer.x, pointer.y, pointer.engaged, pointer.allow], ([a, k, px, py, engaged, allow]: number[]) => {
    const [bx, by] = polar(radius, a);
    return Math.sin(a) * radius * (.55 + .45 * k) + lean(magnet(px, py, bx, by), engaged * allow)[1];
  });
  const scale = useTransform([on, turn, pointer.x, pointer.y, pointer.engaged, pointer.allow], ([o, a, px, py, engaged, allow]: number[]) => {
    const [bx, by] = polar(radius, a);
    return (1 - allow * (1 - o)) * (1 + GROW * magnet(px, py, bx, by).strength * engaged + LIFT);
  });
  const opacity = useTransform([on, pointer.allow], ([o, allow]: number[]) => clamp01(o * (1 + 3 * allow)));
  return <motion.span className={styles.lens} data-danger={danger || undefined} style={{ x, y, scale, opacity }} aria-hidden="true" />;
}

interface Press { id: number; cx: number; cy: number; sx: number; sy: number; at: number; wasOpen: boolean; moved: boolean }
interface Pill { key: string; text: string; check?: boolean }

const pillShown = { opacity: 1, scale: 1, y: 0, filter: "blur(0px)" };
const pillHidden = { opacity: 0, scale: .82, y: 12, filter: `blur(${blur.soft}px)` };

export function OrbitMenu({ actions, onAction, label = "Actions", radius = 104, spread = 150, direction = -90, disabled = false, announce = true, onOpenChange, className }: OrbitMenuProps) {
  const reduced = useReducedFlag();
  const menuId = `orbit-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const press = useRef<Press | null>(null);
  const targetRef = useRef<number | null>(null);
  const hovering = useRef(false);
  const focusRequest = useRef<number | null>(null);
  const firedCount = useRef(0);
  const pillWasVisible = useRef(false);

  const [openState, setOpenState] = useState(false);
  if (disabled && openState) setOpenState(false);
  const open = openState && !disabled;
  const [target, setTarget] = useState<number | null>(null);
  const [lensIndex, setLensIndex] = useState(0);
  if (target !== null && target !== lensIndex) setLensIndex(target);
  const [dragging, setDragging] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [done, setDone] = useState<{ index: number; key: number; text: string } | null>(null);
  const [focusTick, setFocusTick] = useState(0);

  const px = useMotionValue(0), py = useMotionValue(0), engaged = useMotionValue(0), allow = useMotionValue(1);
  const hold = useMotionValue(0), pressed = useMotionValue(0), track = useMotionValue(0), width = useMotionValue(0);
  const pointer = useMemo(() => ({ x: px, y: py, engaged, allow }), [allow, engaged, px, py]);

  const count = actions.length;
  const angles = useMemo(() => Array.from({ length: count }, (_, index) => rad(count < 2 ? direction : direction - spread / 2 + spread * index / (count - 1))), [count, direction, spread]);
  const step = count < 2 ? Math.PI : rad(spread) / (count - 1);
  const mid = rad(direction);

  useEffect(() => { allow.set(reduced ? 0 : 1); }, [allow, reduced]);

  useEffect(() => {
    const controls = animate(track, open ? 1 : 0, reduced ? instant : open ? morph : fold);
    return () => controls.stop();
  }, [open, reduced, track]);

  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setDone(null), 1400);
    return () => window.clearTimeout(timer);
  }, [done]);

  useEffect(() => {
    const index = focusRequest.current;
    if (!open || index === null) return;
    focusRequest.current = null;
    itemRefs.current[index]?.focus({ preventScroll: true });
  }, [focusTick, open]);

  function changeOpen(next: boolean) {
    if (next === openState) return;
    setOpenState(next);
    onOpenChange?.(next);
  }

  function retarget(next: number | null) {
    if (targetRef.current === next) return;
    targetRef.current = next;
    setTarget(next);
  }

  function engage(on: boolean) {
    animate(engaged, on ? 1 : 0, reduced ? instant : on ? snappy : settle);
  }

  function close(restoreFocus = true) {
    const active = document.activeElement;
    if (restoreFocus && active !== triggerRef.current && rootRef.current?.contains(active)) triggerRef.current?.focus({ preventScroll: true });
    hovering.current = false;
    engage(false);
    retarget(null);
    setCancelling(false);
    changeOpen(false);
  }

  function fire(index: number) {
    const action = actions[index];
    if (!action) return;
    firedCount.current += 1;
    setDone({ index, key: firedCount.current, text: action.done ?? action.label });
    close();
    onAction(action.id);
  }

  function openWithKeyboard(index: number) {
    setDone(null);
    changeOpen(true);
    retarget(index);
    focusRequest.current = index;
    setFocusTick(tick => tick + 1);
  }

  /** Pie menu targeting: the angle picks the action, so the pointer only has to head the right way. */
  function pick(dx: number, dy: number) {
    const distance = Math.hypot(dx, dy);
    if (distance < INNER || distance > radius + 76) return null;
    const angle = Math.atan2(dy, dx);
    let best = 0, gap = Infinity;
    for (let index = 0; index < angles.length; index++) {
      const difference = Math.abs(Math.atan2(Math.sin(angle - angles[index]), Math.cos(angle - angles[index])));
      if (difference < gap) { gap = difference; best = index; }
    }
    return gap <= step / 2 + .2 ? best : null;
  }

  function center() {
    const box = rootRef.current!.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }

  const dismiss = useEffectEvent((event: Event) => {
    if (event instanceof KeyboardEvent) { if (event.key === "Escape") close(); return; }
    if (!press.current && !rootRef.current?.contains(event.target as Node)) close(false);
  });
  useEffect(() => {
    if (!open) return;
    const listener = (event: Event) => dismiss(event);
    document.addEventListener("pointerdown", listener, true);
    document.addEventListener("keydown", listener);
    return () => { document.removeEventListener("pointerdown", listener, true); document.removeEventListener("keydown", listener); };
  }, [open]);

  function onPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (disabled || event.button !== 0 || press.current) return;
    const { x, y } = center();
    event.currentTarget.setPointerCapture(event.pointerId);
    press.current = { id: event.pointerId, cx: x, cy: y, sx: event.clientX, sy: event.clientY, at: event.timeStamp, wasOpen: open, moved: false };
    px.set(event.clientX - x); py.set(event.clientY - y);
    animate(pressed, 1, reduced ? instant : snappy);
    animate(hold, 1, reduced ? instant : snappy);
    engage(true);
    hovering.current = false;
    setDragging(true);
    retarget(null);
    if (!open) { setDone(null); changeOpen(true); }
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const current = press.current;
    if (current && current.id === event.pointerId) {
      const dx = event.clientX - current.cx, dy = event.clientY - current.cy;
      px.set(dx); py.set(dy);
      if (!current.moved && Math.hypot(event.clientX - current.sx, event.clientY - current.sy) > 8) current.moved = true;
      const next = pick(dx, dy);
      retarget(next);
      const away = current.moved && next === null;
      if (away !== cancelling) setCancelling(away);
      return;
    }
    // With the arc held open, a mouse gets the same magnet as a drag.
    if (!open || current || event.pointerType === "touch") return;
    const { x, y } = center();
    px.set(event.clientX - x); py.set(event.clientY - y);
    if (!hovering.current) { hovering.current = true; engage(true); }
    retarget(pick(event.clientX - x, event.clientY - y));
  }

  function onPointerLeave() {
    if (press.current || !hovering.current) return;
    hovering.current = false;
    engage(false);
    const focused = itemRefs.current.findIndex(node => node && node === document.activeElement);
    retarget(focused >= 0 ? focused : null);
  }

  function finish(event: ReactPointerEvent<HTMLButtonElement>, cancelled: boolean) {
    const current = press.current;
    if (!current || current.id !== event.pointerId) return;
    press.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
    setCancelling(false);
    animate(pressed, 0, reduced ? instant : snappy);
    animate(hold, 0, reduced ? instant : settle);
    engage(false);
    if (cancelled) { close(false); return; }
    const chosen = current.moved ? pick(event.clientX - current.cx, event.clientY - current.cy) : null;
    if (chosen !== null) { fire(chosen); return; }
    const tapped = !current.moved && event.timeStamp - current.at < 350;
    // A tap keeps the arc open to choose at leisure, and a second tap closes it. A hold or a drag that ends off the arc folds it away.
    if (tapped && !current.wasOpen) { retarget(null); return; }
    close(false);
  }

  function onTriggerKey(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!event.key.startsWith("Arrow") || count === 0) return;
    event.preventDefault();
    openWithKeyboard(event.key === "ArrowUp" ? count - 1 : 0);
  }

  function onItemKey(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    const moves: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    let next: number;
    if (event.key in moves) next = (index + moves[event.key] + count) % count;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    else { if (event.key === "Tab") close(false); return; }
    event.preventDefault();
    retarget(next);
    itemRefs.current[next]?.focus({ preventScroll: true });
  }

  const pill: Pill | null = done ? { key: `done-${done.key}`, text: done.text, check: true }
    : !open ? null
    : target !== null && actions[target] ? { key: `target-${target}-${actions[target].label}`, text: actions[target].label }
    : dragging && cancelling ? { key: "cancel", text: "Release to cancel" }
    : { key: "label", text: label };
  const [shownPill, setShownPill] = useState<Pill>({ key: "label", text: label });
  if (pill && (pill.key !== shownPill.key || pill.text !== shownPill.text)) setShownPill(pill);
  const pillVisible = pill !== null;

  // The pill springs to the width of its new words; it only jumps while hidden.
  useLayoutEffect(() => {
    const node = measureRef.current;
    if (!node) return;
    const next = node.offsetWidth + 2, wasVisible = pillWasVisible.current;
    pillWasVisible.current = pillVisible;
    if (!wasVisible || !pillVisible || reduced) { width.jump(next); return; }
    const controls = animate(width, next, morph);
    return () => controls.stop();
  }, [pillVisible, reduced, shownPill.key, shownPill.text, width]);

  const tx = useTransform([px, py, hold, allow], ([x, y, held, motionOn]: number[]) => { const d = Math.hypot(x, y); return d < .01 ? 0 : x / d * rubber(d, 26) * held * motionOn; });
  const ty = useTransform([px, py, hold, allow], ([x, y, held, motionOn]: number[]) => { const d = Math.hypot(x, y); return d < .01 ? 0 : y / d * rubber(d, 26) * held * motionOn; });
  const triggerScale = useTransform([pressed, track], ([p, k]: number[]) => (1 - .08 * p) * (1 - .06 * clamp01(k)));
  const drawn = useTransform(track, value => clamp01(value));
  const trackOpacity = useTransform(track, value => clamp01(value * 1.6));
  const trackStart = useTransform(track, value => arcPath(radius * (.5 + .5 * Math.max(0, value)), mid, angles[0] ?? mid));
  const trackEnd = useTransform(track, value => arcPath(radius * (.5 + .5 * Math.max(0, value)), mid, angles[count - 1] ?? mid));

  const [pillX, pillY] = polar(radius * .5, mid);
  const lensAction = actions[lensIndex];
  const content = (item: Pill) => <>{item.check && <Check size={15} strokeWidth={2.25} aria-hidden="true" />}<span>{item.text}</span></>;
  const rowHidden = reduced ? { opacity: 0 } : { opacity: 0, y: "0.4em", filter: `blur(${blur.soft}px)` };

  return <div ref={rootRef} className={[styles.root, className].filter(Boolean).join(" ")} data-open={open || undefined}
    style={{ "--orbit-reach": `${radius + 60}px` } as CSSProperties} onPointerMove={onPointerMove} onPointerLeave={onPointerLeave}>
    <div className={styles.field} aria-hidden="true" onPointerDown={() => close(false)} />
    {count > 1 && <svg className={styles.track} width="1" height="1" aria-hidden="true">
      <motion.path d={trackStart} style={{ pathLength: drawn, opacity: trackOpacity }} />
      <motion.path d={trackEnd} style={{ pathLength: drawn, opacity: trackOpacity }} />
    </svg>}
    <Lens angle={angles[lensIndex] ?? mid} visible={open && target !== null} danger={lensAction?.tone === "danger"} radius={radius} track={track} pointer={pointer} reduced={reduced} />
    <motion.button ref={triggerRef} type="button" className={styles.trigger} aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={menuId}
      data-open={open || undefined} disabled={disabled} style={{ x: tx, y: ty, scale: triggerScale }}
      onPointerDown={onPointerDown} onPointerUp={event => finish(event, false)} onPointerCancel={event => finish(event, true)}
      onKeyDown={onTriggerKey} onContextMenu={event => event.preventDefault()}
      onClick={event => { if (event.detail !== 0) return; if (open) close(); else if (count) openWithKeyboard(0); }}>
      <MorphGlyph glyph={done ? "done" : open ? "close" : "more"} reduced={reduced} />
    </motion.button>
    <div id={menuId} role="menu" aria-label={label} aria-orientation="horizontal" className={styles.menu} inert={!open}>
      {actions.map((action, index) => <OrbitItem key={action.id} action={action} index={index} count={count} angle={angles[index]} radius={radius}
        open={open} active={open && target === index} fired={done?.index === index} focusable={index === (target ?? 0)} reduced={reduced} pointer={pointer}
        setRef={(at, node) => { itemRefs.current[at] = node; }} onFire={fire} onFocus={retarget} onKey={onItemKey} />)}
    </div>
    <div className={styles.pillAnchor} style={{ left: `calc(50% + ${pillX.toFixed(2)}px)`, top: `calc(50% + ${pillY.toFixed(2)}px)` }} aria-hidden="true">
      <span ref={measureRef} className={`${styles.pillRow} ${styles.measure}`}>{content(shownPill)}</span>
      <motion.div className={styles.pill} style={{ width }} initial={false} animate={pillVisible ? pillShown : pillHidden}
        transition={pillVisible
          ? { default: reduced ? instant : snappy, opacity: { duration: reduced ? .15 : .2, ease: enter }, filter: reduced ? instant : { duration: .22, ease: enter } }
          : { default: reduced ? instant : { duration: duration.exit, ease: standard }, opacity: { duration: reduced ? .12 : duration.exit, ease: standard } }}>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={shownPill.key} className={styles.pillRow} initial={rowHidden} animate={{ opacity: 1, y: "0em", filter: "blur(0px)" }}
            exit={reduced ? { opacity: 0, transition: { duration: .1 } } : { opacity: 0, y: "-0.4em", filter: `blur(${blur.subtle}px)`, transition: { duration: .14, ease: standard } }}
            transition={{ duration: reduced ? .15 : .22, ease: enter }}>{content(shownPill)}</motion.span>
        </AnimatePresence>
      </motion.div>
    </div>
    {announce && <span role="status" className={styles.srOnly}>{done?.text ?? ""}</span>}
  </div>;
}

export default OrbitMenu;
