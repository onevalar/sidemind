"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, RefObject } from "react";
import { animate, motion, useMotionValue, useReducedMotion, useSpring, useTransform, useVelocity } from "motion/react";
import type { AnimationPlaybackControls, MotionStyle, MotionValue } from "motion/react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./glass-tabbar.module.css";

export interface GlassTabBarItem {
  value: string;
  label: string;
  icon: ReactNode;
  /** Count or short text shown as an accent badge on the icon. */
  badge?: number | string;
}

/**
 * A floating Liquid Glass tab bar for mobile layouts. The bar is one translucent glass capsule, and the selected tab sits
 * under a glass lens that glides between tabs on one interruptible spring, stretching a little along its travel and
 * settling as it lands. The lens can also be dragged across the bar. Scrolling down morphs the bar into a compact capsule
 * of icons; scrolling up, or tapping it, grows it back.
 */
export interface GlassTabBarProps {
  items: GlassTabBarItem[];
  /** Controlled active tab. */
  value?: string;
  /** Initial active tab when uncontrolled. Defaults to the first item. */
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** A separate round glass tab beside the bar, such as search. Selecting it moves the selection out of the bar. */
  action?: GlassTabBarItem;
  /** Controlled compact state. */
  compact?: boolean;
  /** Initial compact state when uncontrolled. */
  defaultCompact?: boolean;
  onCompactChange?: (compact: boolean) => void;
  /** Scroll container to watch. Leave it out to watch the window. */
  scrollRef?: RefObject<HTMLElement | null>;
  /** Shrink on scroll down and grow on scroll up. Defaults to true. */
  collapseOnScroll?: boolean;
  /** Accessible name of the tab list. Defaults to "Tabs". */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

const SLOT_MAX = 78, SLOT_MIN = 56, SLOT_COMPACT = 48, HEIGHT = 62, HEIGHT_COMPACT = 48, PAD = 4, GAP = 10;
/** The lens glides on the shared morph spring: a whisper of overshoot, so it lands like a drop of glass. */
const glide = motionTokens.spring.morph;
/** The bar's shrink never overshoots, so nothing reflows past its resting size. */
const size = motionTokens.spring.smooth;
const follow = { type: "spring" as const, stiffness: 900, damping: 64 };
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

interface TabProps {
  item: GlassTabBarItem;
  index: number;
  selected: boolean;
  focusable: boolean;
  slot: MotionValue<number>;
  height: MotionValue<number>;
  pos: MotionValue<number>;
  lift: MotionValue<number>;
  presence: MotionValue<number>;
  compact: MotionValue<number>;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onSelect: () => void;
}

/** One tab. Its tint and magnification follow the lens position, so the colour crossfades with the glide instead of switching. */
function Tab({ item, index, selected, focusable, slot, height, pos, lift, presence, compact, buttonRef, onSelect }: TabProps) {
  const near = useTransform(() => presence.get() * Math.max(0, 1 - Math.abs(pos.get() - index)));
  const tint = useTransform(near, v => `color-mix(in oklab, var(--glass-active) ${Math.round(v * 100)}%, var(--glass-ink))`);
  const scale = useTransform(() => 1 + near.get() * lift.get() * .1);
  const iconY = useTransform(compact, v => -8 * (1 - v));
  const labelOpacity = useTransform(compact, v => Math.max(0, 1 - v * 2.5));
  const labelY = useTransform(compact, v => 5 * v);
  const labelScale = useTransform(compact, v => 1 - v * .12);
  const badge = item.badge !== undefined && item.badge !== "" && item.badge !== 0;

  return <motion.button ref={buttonRef} type="button" role="tab" aria-selected={selected} tabIndex={focusable ? 0 : -1}
    className={styles.item} style={{ width: slot, height, color: tint }} data-active={selected || undefined} onClick={onSelect}>
    <motion.span className={styles.icon} style={{ y: iconY, scale }}>
      {item.icon}
      {badge ? <span className={styles.badge} aria-hidden>{item.badge}</span> : null}
    </motion.span>
    <motion.span className={styles.label} style={{ opacity: labelOpacity, y: labelY, scale: labelScale }}>{item.label}</motion.span>
    {badge ? <span className={styles.hidden}>, {item.badge} new</span> : null}
  </motion.button>;
}

export function GlassTabBar({ items, value: valueProp, defaultValue, onValueChange, action, compact: compactProp, defaultCompact = false, onCompactChange, scrollRef, collapseOnScroll = true, label = "Tabs", className, style }: GlassTabBarProps) {
  const reduced = !!useReducedMotion();
  const [innerValue, setInnerValue] = useState(defaultValue ?? items[0]?.value ?? "");
  const [innerCompact, setInnerCompact] = useState(defaultCompact);
  const value = valueProp ?? innerValue;
  const compact = compactProp ?? innerCompact;
  const n = items.length;
  const index = items.findIndex(item => item.value === value);
  const actionSelected = !!action && action.value === value;
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const root = useRef<HTMLElement>(null);
  const bar = useRef<HTMLDivElement>(null);

  const setValue = useCallback((next: string) => { if (valueProp === undefined) setInnerValue(next); onValueChange?.(next); }, [valueProp, onValueChange]);
  const setCompact = useCallback((next: boolean) => { if (compactProp === undefined) setInnerCompact(next); onCompactChange?.(next); }, [compactProp, onCompactChange]);

  // Tabs share the room they have: up to 78px each, down to 56px so five tabs and an action still fit a 390px screen.
  const fit = useMotionValue(SLOT_MAX);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const room = entry.contentRect.width - (action ? HEIGHT + GAP : 0) - PAD * 2;
      fit.set(Math.floor(clamp(room / Math.max(1, n), SLOT_MIN, SLOT_MAX)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [action, n, fit]);

  // One progress value drives the whole morph: 0 is the full bar, 1 is the compact capsule. Slot width, bar height,
  // lens size, the action circle, and the labels all derive from it, so they move as one shape and never jump.
  const p = useMotionValue(compact ? 1 : 0);
  const slot = useTransform(() => fit.get() + (SLOT_COMPACT - fit.get()) * p.get());
  const height = useTransform(p, v => HEIGHT + (HEIGHT_COMPACT - HEIGHT) * v);
  const lensH = useTransform(height, h => h - PAD * 2);
  useEffect(() => {
    const controls = reduced ? (p.set(compact ? 1 : 0), null) : animate(p, compact ? 1 : 0, size);
    return () => controls?.stop();
  }, [compact, reduced, p]);

  // The lens lives in slot units on one spring. Its speed lifts it into a clear glass drop and stretches it along the travel.
  const pos = useMotionValue(Math.max(0, index));
  const presence = useMotionValue(index >= 0 ? 1 : 0);
  const hold = useMotionValue(0);
  const speed = useVelocity(pos);
  // Computed values read reduced motion through a motion value, so a change in the preference reaches them.
  const motionOn = useMotionValue(reduced ? 0 : 1);
  useEffect(() => { motionOn.set(reduced ? 0 : 1); }, [reduced, motionOn]);
  const liftTarget = useTransform(() => motionOn.get() * Math.max(hold.get(), Math.min(1, Math.abs(speed.get()) / 4)));
  // The lift eases in and out on its own soft spring, so the lens settles into the fill instead of popping back.
  const lift = useSpring(liftTarget, { stiffness: 420, damping: 38 });
  const stretch = useTransform(() => motionOn.get() * Math.min(.16, Math.abs(speed.get()) * .022));
  const lensX = useTransform(() => PAD + pos.get() * slot.get());
  const lensScaleX = useTransform(() => (1 + lift.get() * .1 + stretch.get()) * (.7 + .3 * presence.get()));
  const lensScaleY = useTransform(() => (1 + lift.get() * .1 - stretch.get() * .4) * (.7 + .3 * presence.get()));
  const lensStyle = { x: lensX, width: slot, height: lensH, scaleX: lensScaleX, scaleY: lensScaleY, opacity: presence, "--lift": lift } as MotionStyle;

  const run = useRef<AnimationPlaybackControls | null>(null);
  const fade = useRef<AnimationPlaybackControls | null>(null);
  const drag = useRef<{ id: number; x0: number; left: number; active: boolean; target: number } | null>(null);
  const suppressClick = useRef(false);

  const moveTo = useCallback((target: number, transition: typeof glide | typeof follow) => {
    run.current?.stop();
    if (reduced) { pos.set(target); run.current = null; return; }
    run.current = animate(pos, target, transition);
  }, [pos, reduced]);
  const show = useCallback((on: boolean) => {
    fade.current?.stop();
    if (reduced) { presence.set(on ? 1 : 0); return; }
    fade.current = animate(presence, on ? 1 : 0, on ? motionTokens.spring.snappy : { duration: motionTokens.duration.fast, ease: "easeOut" });
  }, [presence, reduced]);

  useEffect(() => {
    if (index < 0) { show(false); return; }
    if (drag.current?.active) return;
    // Coming back from the action, the lens materializes on its tab rather than sliding in from where it faded out.
    if (presence.get() < .05) { run.current?.stop(); pos.set(index); }
    else moveTo(index, glide);
    show(true);
  }, [index, pos, presence, moveTo, show]);

  // Shrink on scroll down, grow on scroll up or near the top.
  const live = useRef({ compact, setCompact });
  useEffect(() => { live.current = { compact, setCompact }; });
  useEffect(() => {
    if (!collapseOnScroll) return;
    const target: HTMLElement | Window = scrollRef?.current ?? window;
    const read = () => target instanceof Window ? target.scrollY : target.scrollTop;
    let last = read(), travel = 0;
    const onScroll = () => {
      const y = read(), dy = y - last;
      last = y;
      if (dy === 0) return;
      travel = Math.sign(dy) === Math.sign(travel) ? travel + dy : dy;
      const { compact: now, setCompact: set } = live.current;
      if (y < 40) { if (now) set(false); return; }
      if (travel > 24 && !now) set(true);
      else if (travel < -24 && now) set(false);
    };
    target.addEventListener("scroll", onScroll, { passive: true });
    return () => target.removeEventListener("scroll", onScroll);
  }, [collapseOnScroll, scrollRef]);

  const select = (next: string) => {
    if (compact) setCompact(false);
    if (next !== value) setValue(next);
  };

  // Drag the lens: past a few pixels it follows the pointer, and letting go lands it on the nearest tab.
  const toPos = (clientX: number, left: number) => clamp((clientX - left - PAD) / slot.get() - .5, 0, n - 1);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    suppressClick.current = false;
    if (event.button !== 0 || n < 2 || compact || !bar.current) return;
    const left = bar.current.getBoundingClientRect().left;
    drag.current = { id: event.pointerId, x0: event.clientX, left, active: false, target: pos.get() };
    // Pressing the selected tab lifts its lens straight away, ready to be dragged.
    if (!reduced && index >= 0 && Math.abs(toPos(event.clientX, left) - pos.get()) < .5) animate(hold, .6, motionTokens.spring.snappy);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    if (!d.active) {
      if (Math.abs(event.clientX - d.x0) < 8) return;
      d.active = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      if (!reduced) animate(hold, 1, motionTokens.spring.snappy);
      if (index < 0) { run.current?.stop(); pos.set(toPos(event.clientX, d.left)); show(true); }
    }
    d.target = toPos(event.clientX, d.left);
    moveTo(d.target, follow);
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    drag.current = null;
    if (!reduced) animate(hold, 0, size);
    if (!d.active) return;
    suppressClick.current = true;
    const nearest = clamp(Math.round(d.target), 0, n - 1);
    if (event.type === "pointercancel") { if (index >= 0) moveTo(index, glide); else show(false); return; }
    moveTo(nearest, glide);
    select(items[nearest].value);
  };

  const tabs = action ? [...items, action] : items;
  const selectedAt = actionSelected ? n : index;
  const focusAt = selectedAt >= 0 ? selectedAt : 0;
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const from = Math.max(0, buttons.current.findIndex(el => el === document.activeElement));
    const next = event.key === "ArrowRight" ? from + 1 : event.key === "ArrowLeft" ? from - 1 : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const to = (next + tabs.length) % tabs.length;
    select(tabs[to].value);
    buttons.current[to]?.focus();
  };

  return <nav ref={root} aria-label={label} className={[styles.root, className].filter(Boolean).join(" ")} style={style}
    data-compact={compact || undefined}>
    <div role="tablist" aria-label={label} aria-orientation="horizontal" className={styles.group} onKeyDown={onKeyDown}>
      <motion.div ref={bar} className={styles.bar} style={{ height }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}>
        <span className={styles.material} aria-hidden />
        <motion.span className={styles.lens} aria-hidden style={lensStyle} />
        {items.map((item, i) => <Tab key={item.value} item={item} index={i} selected={i === index} focusable={i === focusAt}
          slot={slot} height={height} pos={pos} lift={lift} presence={presence} compact={p}
          buttonRef={el => { buttons.current[i] = el; }}
          onSelect={() => { if (suppressClick.current) { suppressClick.current = false; return; } select(item.value); }} />)}
      </motion.div>
      {action ? <motion.div className={styles.bubble} style={{ width: height, height }} data-active={actionSelected || undefined}>
        <span className={styles.material} aria-hidden />
        <span className={styles.bubbleLens} aria-hidden />
        <button ref={el => { buttons.current[n] = el; }} type="button" role="tab" aria-selected={actionSelected} aria-label={action.label}
          tabIndex={focusAt === n ? 0 : -1} className={styles.bubbleButton} onClick={() => select(action.value)}>
          <span className={styles.bubbleIcon}>{action.icon}</span>
        </button>
      </motion.div> : null}
    </div>
  </nav>;
}

export default GlassTabBar;
