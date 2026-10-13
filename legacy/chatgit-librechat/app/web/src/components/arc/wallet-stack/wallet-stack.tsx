"use client";

import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { AnimatePresence, MotionConfig, animate, motion, motionValue, useMotionValue, useReducedMotion, useSpring, useTransform } from "motion/react";
import type { MotionValue } from "motion/react";
import { ChevronLeft } from "lucide-react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./wallet-stack.module.css";

/** @deprecated Use `variant`. Kept so older card data still renders: paper maps to metal, graphite to black, clay and photo to color. */
export type WalletCardFinish = "paper" | "photo" | "clay" | "graphite";
/** The card material: brushed metal, a tinted black card with a guilloche pattern, frosted glass, or a deep color with a light sweep. */
export type WalletCardVariant = "metal" | "black" | "glass" | "color";
export interface WalletTransaction {
  id: string;
  merchant: string;
  /** Category and date, such as "Groceries · Yesterday". */
  detail: string;
  /** Negative for spending, positive for money in. */
  amount: number;
  icon?: ReactNode;
  /** A portrait for transfers between people. Shown instead of the icon. */
  avatar?: string;
}
export interface WalletStackCard {
  id: string;
  issuer: string;
  /** Product name, such as "Everyday debit". */
  product: string;
  lastFour: string;
  holder: string;
  /** Card material. Defaults from `finish`, or metal. */
  variant?: WalletCardVariant;
  /** Base color for the color variant, any CSS color. Defaults to a deep cobalt. */
  tint?: string;
  /** Expiry as shown on the card, such as "09/29". */
  expires?: string;
  /** Replaces the built-in network mark. Pass null to leave the corner empty. */
  network?: ReactNode;
  /** @deprecated Use `variant`. */
  finish?: WalletCardFinish;
  /** Optional artwork laid under the card finish, toned down on the black variant. */
  image?: string;
  balance: number;
  balanceLabel: string;
  transactions: WalletTransaction[];
}

/** A stack of payment cards with real materials and depth. Hover to fan the stack, drag or use the arrow keys to cycle cards, and choose a card to lift it into its balance and recent activity. */
export interface WalletStackProps {
  cards: WalletStackCard[];
  label?: string;
  currency?: string;
  locale?: string;
  /** Called with the opened card, or null when it goes back into the stack. */
  onSelectedChange?: (card: WalletStackCard | null) => void;
  className?: string;
}

/** ISO/IEC 7810 ID-1: 85.60 × 53.98 mm. */
const RATIO = 53.98 / 85.6;
/** Height of the pocket at the bottom of the stage where cycled and tucked cards rest. */
const POCKET = 30;
const SLIVER = 7;
const OPEN_SCALE = .88;
const POCKET_SCALE = .9;
const MAX_TILT = 5;
/** Fastest release speed a throw hands to the spring, in px/s. */
const MAX_THROW = 2400;
/**
 * The physics twin of motionTokens.spring.smooth (visualDuration .4, no bounce). Motion drops inherited and explicit velocity on
 * time-defined springs, so every interruption would restart from rest; a stiffness and damping spring keeps the current velocity.
 */
const SETTLE_OMEGA = (2 * Math.PI) / (.4 * 1.2);
const SETTLE = { type: "spring" as const, stiffness: SETTLE_OMEGA ** 2, damping: 2 * SETTLE_OMEGA, mass: 1 };
/**
 * Spring a value to its target from its current value and velocity, critically damped. Speed toward the target is capped at
 * omega times the distance left, the most a critically damped spring can carry without crossing it, so nothing ever overshoots.
 */
function settle(value: MotionValue<number>, target: number, reduced: boolean, velocity = value.getVelocity()) {
  if (reduced) return animate(value, target, { duration: 0 });
  const distance = target - value.get();
  const toward = Math.sign(velocity) === Math.sign(distance);
  const carried = toward ? Math.sign(velocity) * Math.min(Math.abs(velocity), SETTLE_OMEGA * Math.abs(distance)) : velocity;
  return animate(value, target, { ...SETTLE, velocity: carried });
}
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function rubberband(overshoot: number, dimension: number, constant = .55) {
  const distance = Math.abs(overshoot);
  return Math.sign(overshoot) * (distance * dimension * constant) / (dimension + constant * distance);
}
/** Where a flick would come to rest, the way scrolling decelerates. */
const project = (velocity: number, rate = .995) => (velocity / 1000) * rate / (1 - rate);
const variantOf = (card: WalletStackCard): WalletCardVariant => card.variant ?? (card.finish === "graphite" ? "black" : card.finish === "clay" || card.finish === "photo" ? "color" : "metal");
const tintOf = (card: WalletStackCard) => card.tint ?? (card.finish === "clay" ? "oklch(50% .1 45)" : card.finish === "photo" ? "oklch(34% .06 230)" : undefined);

/** Deck geometry shared by the layout and the drag gesture. Everything is placed from the stage size, the card count, and the fan amount. */
function deck(width: number, height: number, count: number, spread: number) {
  const cardHeight = width * RATIO;
  const region = height - POCKET - 12;
  const depth = Math.min(count - 1, 3);
  const maxPeek = Math.max(4, (region - cardHeight - 12) / Math.max(1, depth));
  const peek = Math.min(lerp(cardHeight * .06, cardHeight * .22, spread), maxPeek);
  const front = (region - cardHeight + depth * peek) / 2;
  return { cardHeight, peek, front, travel: Math.max(80, height - POCKET - front) };
}

interface Placement { y: number; scale: number; lift: number }
/**
 * One card's resting transform as a pure function of the continuous stack position, so every gesture and spring moves the same shape and z order never changes.
 * Cards behind the front card peek above it; cards cycled past slide down into the pocket; while a card is open it rises to the top and the rest tuck into the pocket.
 */
function place(index: number, count: number, position: number, open: number, selected: number, pocketAbove: number, spread: number, width: number, height: number): Placement {
  const { peek, front } = deck(width, height, count, spread);
  const pocket = height - POCKET;
  const d = index - position;
  let y: number, scale: number;
  if (d >= 0) {
    const k = Math.min(d, 3.5);
    y = front - k * peek;
    scale = 1 - .05 * k;
  } else {
    const e = -d;
    if (e < 1) { y = lerp(front, pocket, e); scale = lerp(1, POCKET_SCALE, e); }
    else { y = pocket + Math.min(e - 1, 2) * SLIVER; scale = POCKET_SCALE + .02 * Math.min(e - 1, 3); }
  }
  const openY = lerp(pocket + Math.min(pocketAbove, 2) * (SLIVER - 1), 0, selected);
  const openScale = lerp(POCKET_SCALE + .02 * Math.min(pocketAbove, 3), OPEN_SCALE, selected);
  const frontness = clamp(1 - Math.abs(d), 0, 1);
  return {
    y: lerp(y, openY, open),
    scale: lerp(scale, openScale, open),
    lift: lerp(frontness * .45 + (d > 0 ? .15 : 0), selected, open),
  };
}

function Money({ value, currency, locale, reduced }: { value: number; currency: string; locale: string; reduced: boolean }) {
  const amount = useMotionValue(value);
  const format = new Intl.NumberFormat(locale, { style: "currency", currency });
  const text = useTransform(amount, v => format.format(v));
  useEffect(() => {
    if (reduced) { amount.set(value); return; }
    const controls = animate(amount, value, { duration: motionTokens.duration.considered * 1.4, ease: [...motionTokens.ease.enter] });
    return () => controls.stop();
  }, [amount, value, reduced]);
  return <motion.span className={styles.money}>{text}</motion.span>;
}

/* ---------------------------------------------------------------------------------------------- */
/* Card artwork. Everything is vector or CSS, sized in container units so it scales with the card. */

/** Guilloche rosette for the black card: offset rings with a slow wave, like the security print on a banknote. */
const GUILLOCHE = Array.from({ length: 16 }, (_, ring) => {
  const base = 70 + ring * 19;
  const points: string[] = [];
  for (let step = 0; step <= 240; step++) {
    const angle = (step / 240) * Math.PI * 2;
    const radius = base + 9 * Math.sin(angle * 11 + ring * .42) + 4 * Math.sin(angle * 3 - ring * .2);
    points.push(`${(640 + radius * Math.cos(angle)).toFixed(1)} ${(250 + radius * Math.sin(angle) * .82).toFixed(1)}`);
  }
  return `M${points.join("L")}Z`;
});

function Chip({ id, tone }: { id: string; tone: "gold" | "silver" }) {
  const stops = tone === "gold"
    ? ["oklch(90% .08 90)", "oklch(76% .11 78)", "oklch(93% .06 95)", "oklch(70% .1 70)", "oklch(84% .09 85)"]
    : ["oklch(95% .004 260)", "oklch(74% .006 260)", "oklch(97% .003 260)", "oklch(68% .006 260)", "oklch(86% .005 260)"];
  return <svg className={styles.chip} viewBox="0 0 50 38" aria-hidden="true">
    <defs>
      <linearGradient id={`${id}-a`} x1="0" y1="0" x2="1" y2="1">
        {stops.map((color, i) => <stop key={i} offset={i / (stops.length - 1)} stopColor={color} />)}
      </linearGradient>
      <linearGradient id={`${id}-b`} x1="1" y1="0" x2="0" y2="1">
        {stops.map((color, i) => <stop key={i} offset={i / (stops.length - 1)} stopColor={color} />)}
      </linearGradient>
      <linearGradient id={`${id}-c`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="oklch(100% 0 0)" stopOpacity=".55" />
        <stop offset=".45" stopColor="oklch(100% 0 0)" stopOpacity="0" />
      </linearGradient>
    </defs>
    <rect x=".5" y=".5" width="49" height="37" rx="7" fill={`url(#${id}-a)`} />
    <rect x="16" y="8" width="18" height="22" rx="3.5" fill={`url(#${id}-b)`} />
    <path d="M0 12.5h16M0 25.5h16M34 12.5h16M34 25.5h16M16 8v22M34 8v22M25 0v8M25 30v8M16 19h-3M34 19h3" fill="none" stroke="oklch(0% 0 0 / .32)" strokeWidth=".7" />
    <rect x="16" y="8" width="18" height="22" rx="3.5" fill="none" stroke="oklch(0% 0 0 / .32)" strokeWidth=".7" />
    <rect x=".5" y=".5" width="49" height="37" rx="7" fill={`url(#${id}-c)`} stroke="oklch(0% 0 0 / .28)" strokeWidth=".7" />
  </svg>;
}

function Contactless() {
  return <svg className={styles.contactless} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
    <path d="M5.5 9a4.5 4.5 0 0 1 0 6" /><path d="M9 6.5a8 8 0 0 1 0 11" /><path d="M12.5 4a11.5 11.5 0 0 1 0 16" /><path d="M16 1.5a15 15 0 0 1 0 21" />
  </svg>;
}

/** Halo, a fictional card network: an open ring with a dot resting in its gap. */
function HaloMark() {
  return <span className={styles.network} aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none">
      <path d="M17.6 7.4A7.5 7.5 0 1 1 12 4.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="17.4" cy="4.9" r="2.1" fill="currentColor" />
    </svg>
    <span>halo</span>
  </span>;
}

/** The printed face never changes with motion, so it skips re-rendering when the stack changes state. */
const CardFace = memo(function CardFace({ card, chipId }: { card: WalletStackCard; chipId: string }) {
  const variant = variantOf(card);
  return <>
    <span className={styles.material} aria-hidden="true" />
    {card.image && <>
      {/* eslint-disable-next-line @next/next/no-img-element -- registry components stay framework agnostic; pass an optimized URL. */}
      <img className={styles.art} src={card.image} alt="" draggable={false} decoding="async" />
    </>}
    <span className={styles.texture} aria-hidden="true">
      {variant === "black" && <svg viewBox="0 0 856 540" preserveAspectRatio="xMidYMid slice">{GUILLOCHE.map((d, i) => <path key={i} d={d} />)}</svg>}
    </span>
    <span className={styles.sweep} aria-hidden="true" />
    <span className={styles.issuer}>{card.issuer}</span>
    <span className={styles.product}>{card.product}</span>
    <Chip id={chipId} tone={variant === "black" || variant === "glass" ? "silver" : "gold"} />
    <Contactless />
    <span className={styles.number}><span className={styles.mask} aria-hidden="true">•••• •••• ••••</span> {card.lastFour}</span>
    <span className={styles.holder}>{card.holder}</span>
    {card.expires && <span className={styles.expiry}><span className={styles.expiryLabel}>Valid thru</span>{card.expires}</span>}
    {card.network === undefined ? <HaloMark /> : card.network !== null && <span className={styles.network}>{card.network}</span>}
  </>;
});

/* ---------------------------------------------------------------------------------------------- */

interface Motion { position: MotionValue<number>; open: MotionValue<number>; spread: MotionValue<number>; width: MotionValue<number>; height: MotionValue<number>; tick: MotionValue<number>; gyro: { x: MotionValue<number>; y: MotionValue<number>; on: MotionValue<number> } }

interface CardProps {
  card: WalletStackCard;
  index: number;
  count: number;
  motionValues: Motion;
  selected: MotionValue<number>;
  selectedAbove: MotionValue<number>[];
  front: boolean;
  tabbable: boolean;
  expanded: boolean;
  tilt: boolean;
  label: string;
  onSelect: () => void;
  slotRef: (node: HTMLDivElement | null) => void;
  buttonRef: (node: HTMLButtonElement | null) => void;
}

function Card({ card, index, count, motionValues, selected, selectedAbove, front, tabbable, expanded, tilt, label, onSelect, slotRef, buttonRef }: CardProps) {
  const { position, open, spread, width, height, tick, gyro } = motionValues;
  const chipId = useId().replace(/:/g, "");
  const raise = useMotionValue(0);
  const layout = () => {
    const values = [position.get(), open.get(), selected.get(), spread.get(), width.get(), height.get(), raise.get(), tick.get()];
    const pocketAbove = selectedAbove.reduce((sum, value) => sum + 1 - value.get(), 0);
    const placed = place(index, count, values[0], values[1], values[2], pocketAbove, values[3], values[4], values[5]);
    // Hovering a card behind the front one raises it out of the fan; the front card answers with a deeper shadow instead.
    const behind = clamp(index - values[0], 0, 1);
    return { ...placed, y: placed.y - values[6] * (1 - values[1]) * behind * 8, lift: placed.lift + values[6] * .35 };
  };
  const y = useTransform(() => layout().y);
  const scale = useTransform(() => layout().scale);
  const shadow = useTransform(() => clamp(layout().lift, 0, 1));

  // Light play: the pointer, or device tilt on the front card, moves a specular highlight and tilts the card a few degrees on critically damped springs.
  const px = useMotionValue(.5);
  const py = useMotionValue(.5);
  const hover = useMotionValue(0);
  const sourceX = useTransform(() => { const h = hover.get(), g = gyro.on.get(), gx = gyro.x.get(), x = px.get(); return h ? x : front && g ? gx : .5; });
  const sourceY = useTransform(() => { const h = hover.get(), g = gyro.on.get(), gy = gyro.y.get(), y = py.get(); return h ? y : front && g ? gy : .5; });
  const damped = { stiffness: 180, damping: 27 };
  const rotateY = useSpring(useTransform(sourceX, v => (v - .5) * 2 * MAX_TILT), damped);
  const rotateX = useSpring(useTransform(sourceY, v => (.5 - v) * 2 * MAX_TILT), damped);
  const sheenX = useSpring(useTransform(sourceX, v => (v - .5) * 50), damped);
  const sheenY = useSpring(useTransform(sourceY, v => (v - .5) * 50), damped);
  const sheenOn = useSpring(useTransform(() => Math.max(hover.get(), front ? gyro.on.get() : 0)), damped);
  const sheenOpacity = useTransform(sheenOn, v => .25 + v * .75);
  const sheenLeft = useTransform(sheenX, v => `${v}%`);
  const sheenTop = useTransform(sheenY, v => `${v}%`);

  function onPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!tilt || event.pointerType !== "mouse") return;
    const rect = event.currentTarget.getBoundingClientRect();
    px.set(clamp((event.clientX - rect.left) / rect.width, 0, 1));
    py.set(clamp((event.clientY - rect.top) / rect.height, 0, 1));
    hover.set(1);
  }
  function onPointerEnter(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.pointerType !== "mouse") return;
    settle(raise, 1, !tilt);
  }
  function onPointerLeave() {
    hover.set(0); px.set(.5); py.set(.5);
    settle(raise, 0, !tilt);
  }

  return <motion.div ref={slotRef} className={styles.cardSlot} style={{ y, scale, zIndex: count - index + 1 }}>
    <motion.span className={styles.shadow} style={{ opacity: shadow }} aria-hidden="true" />
    <motion.button ref={buttonRef} type="button" className={styles.card} data-variant={variantOf(card)} data-front={front || undefined}
      style={{ rotateX: tilt ? rotateX : 0, rotateY: tilt ? rotateY : 0, transformPerspective: 900, ["--card-tint" as string]: tintOf(card) }}
      aria-label={label} aria-expanded={expanded} tabIndex={tabbable ? 0 : -1}
      onClick={onSelect} onPointerMove={onPointerMove} onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
      <CardFace card={card} chipId={chipId} />
      {tilt && <motion.span className={styles.sheen} style={{ x: sheenLeft, y: sheenTop, opacity: sheenOpacity }} aria-hidden="true" />}
      <span className={styles.edge} aria-hidden="true" />
    </motion.button>
  </motion.div>;
}

export function WalletStack({ cards, label = "Wallet", currency = "USD", locale = "en-US", onSelectedChange, className }: WalletStackProps) {
  const reduced = useReducedMotion() ?? false;
  const headingId = useId();
  const hintId = useId();
  const count = cards.length;
  const stageRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const activeRef = useRef(0);
  const openRef = useRef(false);
  const position = useMotionValue(0);
  const open = useMotionValue(0);
  const spread = useMotionValue(0);
  const width = useMotionValue(296);
  const height = useMotionValue(383);
  const tick = useMotionValue(0);
  const gyro = { x: useMotionValue(.5), y: useMotionValue(.5), on: useMotionValue(0) };
  const motionValues: Motion = { position, open, spread, width, height, tick, gyro };
  // One selection weight per card, so switching the open card moves only the two cards involved.
  const [weights] = useState(() => new Map<string, MotionValue<number>>());
  const weight = (card: WalletStackCard, index: number) => {
    let value = weights.get(card.id);
    if (!value) { value = motionValue(index === active ? 1 : 0); weights.set(card.id, value); }
    return value;
  };
  const slotRefs = useRef<(HTMLDivElement | null)[]>([]);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const gesture = useRef<{ pointer: number; y: number; x: number; start: number; dragging: boolean; dismiss: boolean; samples: { t: number; y: number }[] } | null>(null);
  const suppressClick = useRef(false);
  const hovering = useRef(false);
  // The activity under an open card fades with the lift itself, so pulling the card down visibly lets go of it.
  const detailOpacity = useTransform(open, value => clamp((value - .4) / .6, 0, 1));
  const detailY = useTransform(open, value => (1 - value) * 16);

  // Every state spring continues from the value's current position and velocity; gestures hand over their release velocity.

  // The stage height follows its width in CSS; measure both once before paint and on resize, straight into motion values.
  useLayoutEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    // The stage reaches 12px past the wallet on three sides so tilt and shadows stay inside its mask; place cards in the inner box.
    // A re-render right after mount can cancel the update a measurement scheduled, so every measurement is followed by a tick one frame later that the cards read.
    let raf = 0;
    const measure = () => {
      width.set(node.clientWidth - 24);
      height.set(node.clientHeight - 12);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => tick.set(tick.get() + 1));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => { observer.disconnect(); cancelAnimationFrame(raf); };
  }, [width, height, tick]);

  // Device tilt drives the light on the front card where the browser reports it without a permission prompt.
  useEffect(() => {
    if (reduced || !window.matchMedia("(hover: none) and (pointer: coarse)").matches) return;
    const onOrientation = (event: DeviceOrientationEvent) => {
      if (event.beta === null || event.gamma === null) return;
      gyro.x.set(clamp(.5 + event.gamma / 40, 0, 1));
      gyro.y.set(clamp(.5 + (event.beta - 50) / 40, 0, 1));
      gyro.on.set(1);
    };
    window.addEventListener("deviceorientation", onOrientation);
    return () => window.removeEventListener("deviceorientation", onOrientation);
  }, [reduced, gyro.x, gyro.y, gyro.on]);

  // Keep the position valid when cards are removed.
  useEffect(() => {
    if (activeRef.current <= count - 1) return;
    const last = Math.max(0, count - 1);
    activeRef.current = last;
    position.set(last);
    queueMicrotask(() => setActive(last));
  }, [count, position]);

  function go(index: number, nextOpen: boolean, velocity?: number, openVelocity?: number) {
    const target = clamp(index, 0, Math.max(0, count - 1));
    const wasOpen = openRef.current, previous = activeRef.current;
    activeRef.current = target;
    openRef.current = nextOpen;
    setActive(target);
    setIsOpen(nextOpen);
    settle(position, target, reduced, velocity);
    if (nextOpen !== wasOpen || openVelocity !== undefined) settle(open, nextOpen ? 1 : 0, reduced, openVelocity);
    cards.forEach((card, i) => { const value = weight(card, i), want = i === target ? 1 : 0; if (value.get() !== want) settle(value, want, reduced); });
    // The fan belongs to the closed stack: fold it while a card is open and restore it on close if the pointer is still over the stage.
    if (nextOpen !== wasOpen) settle(spread, !nextOpen && hovering.current ? 1 : 0, reduced);
    if (nextOpen && (!wasOpen || previous !== target)) onSelectedChange?.(cards[target]);
    else if (!nextOpen && wasOpen) onSelectedChange?.(null);
  }
  const focusCard = (index: number) => requestAnimationFrame(() => buttonRefs.current[index]?.focus({ preventScroll: true }));

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || count === 0) return;
    // One gesture at a time: a drag in progress keeps the pointer, but a press that never passed the deadzone (released elsewhere) is replaced.
    if (gesture.current?.dragging) return;
    if (openRef.current) {
      // An open card can be pulled back down into the stack; only the card itself is a handle, so the activity list still scrolls.
      if (reduced || !slotRefs.current[activeRef.current]?.contains(event.target as Node)) return;
      gesture.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, start: 0, dragging: false, dismiss: true, samples: [] };
      return;
    }
    gesture.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, start: 0, dragging: false, dismiss: false, samples: [] };
  }
  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = gesture.current;
    if (!state || state.pointer !== event.pointerId) return;
    if (!state.dragging) {
      const dx = event.clientX - state.x, dy = event.clientY - state.y;
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) { gesture.current = null; return; }
      if (Math.abs(dy) < 8) return;
      // Only now take the pointer and catch the moving stack, so a plain tap still reaches the card underneath.
      state.dragging = true;
      state.y = event.clientY;
      const value = state.dismiss ? open : position;
      value.stop();
      state.start = value.get();
      state.samples = [{ t: event.timeStamp, y: event.clientY }];
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* the pointer is already gone */ }
      return;
    }
    state.samples.push({ t: event.timeStamp, y: event.clientY });
    if (state.samples.length > 12) state.samples.shift();
    const dy = event.clientY - state.y;
    if (state.dismiss) {
      // Down follows the finger; up resists, since the card is already as high as it goes.
      const reach = dismissReach();
      const raw = state.start - dy / reach;
      open.set(raw > 1 ? 1 + rubberband((raw - 1) * reach, reach, .3) / reach : Math.max(0, raw));
      return;
    }
    // Dragging down pushes the front card into the pocket and brings the next one forward, one to one under the pointer, with rubber banding past either end.
    const { travel } = deck(width.get(), height.get(), count, spread.get());
    const raw = state.start + dy / travel, last = count - 1;
    position.set(raw < 0 ? rubberband(raw * travel, travel) / travel : raw > last ? last + rubberband((raw - last) * travel, travel) / travel : raw);
  }
  function onPointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    const state = gesture.current;
    if (!state || state.pointer !== event.pointerId) return;
    gesture.current = null;
    if (!state.dragging) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    suppressClick.current = true;
    requestAnimationFrame(() => { suppressClick.current = false; });
    // A cancelled pointer (the browser took over, or capture was lost) settles where it is instead of throwing.
    const velocity = event.type === "pointerup" ? releaseVelocity(state.samples, event.timeStamp) : 0;
    if (state.dismiss) {
      // Land where the pull is heading: a flick down lets the card go even from a short pull, and the spring keeps its speed.
      const reach = dismissReach();
      if (open.get() - project(velocity) / reach < .5) { go(activeRef.current, false, undefined, -velocity / reach); focusCard(activeRef.current); }
      else settle(open, 1, reduced, -velocity / reach);
      return;
    }
    const { travel } = deck(width.get(), height.get(), count, spread.get());
    const projected = position.get() + project(velocity) / travel;
    const start = Math.round(state.start);
    go(clamp(Math.round(projected), start - 1, start + 1), false, velocity / travel);
  }
  const dismissReach = () => Math.max(120, height.get() * .55);
  /** Release speed in px/s over the last 100ms of movement, capped so a flick measured over a few milliseconds cannot fling the spring past its target. */
  function releaseVelocity(samples: { t: number; y: number }[], now: number) {
    const last = samples[samples.length - 1];
    if (!last || now - last.t > 80) return 0;
    const first = samples.find(sample => last.t - sample.t <= 100) ?? last;
    const span = Math.max(16, last.t - first.t);
    return clamp(((last.y - first.y) / span) * 1000, -MAX_THROW, MAX_THROW);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const current = activeRef.current;
    const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    let next = step ? current + step : event.key === "Home" ? 0 : event.key === "End" ? count - 1 : null;
    if (next !== null) {
      event.preventDefault();
      next = clamp(next, 0, count - 1);
      if (next !== current) { go(next, openRef.current); focusCard(next); }
      else if (!reduced) animate(position, [position.get(), current + (step || (next === 0 ? -1 : 1)) * .06, current], { duration: .32, ease: [...motionTokens.ease.standard] });
      return;
    }
    if (event.key === "Escape" && openRef.current) { event.preventDefault(); go(current, false); focusCard(current); }
  }

  function onStageEnter(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "mouse") return;
    hovering.current = true;
    if (!openRef.current) settle(spread, 1, reduced);
  }
  function onStageLeave(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "mouse") return;
    hovering.current = false;
    settle(spread, 0, reduced);
  }

  const format = new Intl.NumberFormat(locale, { style: "currency", currency });
  const card = cards[Math.min(active, count - 1)] ?? null;
  const labelFor = (item: WalletStackCard, index: number) => `${item.issuer} ${item.product} ending in ${item.lastFour}, ${index + 1} of ${count}, ${item.balanceLabel.toLowerCase()} ${format.format(item.balance)}`;

  return <MotionConfig reducedMotion="user">
    <div className={[styles.wallet, className].filter(Boolean).join(" ")}>
      <div className={styles.header}>
        <h3 id={headingId} className={styles.title}>{label}</h3>
        <AnimatePresence mode="popLayout" initial={false}>
          {isOpen
            ? <motion.button key="back" type="button" className={styles.headerButton} onClick={() => { go(activeRef.current, false); focusCard(activeRef.current); }}
                initial={{ opacity: 0, scale: .96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .96, transition: { duration: motionTokens.duration.instant * .6 } }} transition={{ duration: motionTokens.duration.fast, delay: .04 }}>
                <ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" />All cards
              </motion.button>
            : count > 1 && <motion.span key="count" className={styles.count} aria-hidden="true"
                initial={{ opacity: 0, scale: .96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .96, transition: { duration: motionTokens.duration.instant * .6 } }} transition={{ duration: motionTokens.duration.fast, delay: .04 }}>
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span key={active} className={styles.countValue} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={motionTokens.spring.smooth}>{active + 1}</motion.span>
                </AnimatePresence>
                <span> of {count}</span>
              </motion.span>}
        </AnimatePresence>
      </div>

      <div ref={stageRef} className={styles.stage} role="group" aria-labelledby={headingId} aria-describedby={hintId} data-open={isOpen || undefined}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd} onLostPointerCapture={event => { if (event.target === event.currentTarget) onPointerEnd(event); }}
        onPointerEnter={onStageEnter} onPointerLeave={onStageLeave} onKeyDown={onKeyDown}>
        {cards.map((item, index) => <Card key={item.id} card={item} index={index} count={count} motionValues={motionValues}
          selected={weight(item, index)} selectedAbove={cards.slice(index + 1).map((other, j) => weight(other, index + 1 + j))}
          front={index === active} tabbable={index === active} expanded={isOpen && index === active} tilt={!reduced} label={labelFor(item, index)}
          slotRef={node => { slotRefs.current[index] = node; }} buttonRef={node => { buttonRefs.current[index] = node; }}
          onSelect={() => {
            if (suppressClick.current) return;
            if (openRef.current && index === activeRef.current) { go(index, false); focusCard(index); }
            else go(index, true);
          }} />)}

        <motion.section className={styles.detail} style={{ opacity: detailOpacity, y: detailY }} aria-label={card ? `${card.issuer} activity` : undefined} inert={!isOpen || undefined}>
          <AnimatePresence mode="popLayout" initial={false}>
            {card && isOpen && <motion.div key={card.id} className={styles.detailBody}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: motionTokens.duration.exit } }}>
              <div className={styles.balance}>
                <span className={styles.balanceLabel}>{card.balanceLabel}</span>
                <Money value={card.balance} currency={currency} locale={locale} reduced={reduced} />
              </div>
              <ul className={styles.activity} aria-label={`Recent activity on ${card.issuer}`}>
                {card.transactions.map((transaction, i) => <motion.li key={transaction.id} className={styles.transaction}
                  initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ ...motionTokens.spring.smooth, delay: .08 + i * motionTokens.stagger.item * 1.6 }}>
                  <span className={styles.txIcon} aria-hidden="true">
                    {/* eslint-disable-next-line @next/next/no-img-element -- registry components stay framework agnostic. */}
                    {transaction.avatar ? <img src={transaction.avatar} alt="" width={32} height={32} draggable={false} /> : transaction.icon}
                  </span>
                  <span className={styles.txText}>
                    <span className={styles.txMerchant}>{transaction.merchant}</span>
                    <span className={styles.txDetail}>{transaction.detail}</span>
                  </span>
                  <span className={styles.txAmount} data-positive={transaction.amount > 0 || undefined}>{transaction.amount > 0 ? "+" : "−"}{format.format(Math.abs(transaction.amount))}</span>
                </motion.li>)}
              </ul>
            </motion.div>}
          </AnimatePresence>
        </motion.section>
      </div>
      <p id={hintId} className={styles.srOnly}>Arrow keys switch cards. Enter opens a card and Escape puts it back.</p>
      <p className={styles.srOnly} aria-live="polite">{card ? isOpen ? `${card.issuer} ${card.product} open` : `${card.issuer} ${card.product} in front, ${active + 1} of ${count}` : ""}</p>
    </div>
  </MotionConfig>;
}

export default WalletStack;
