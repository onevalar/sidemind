"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { AnimatePresence, animate, motion, motionValue, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import type { MotionValue, Transition } from "motion/react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./liquid-tab-bar.module.css";

export interface LiquidTab {
  value: string;
  label: string;
  /** A 20px outline icon, such as a lucide icon with a 1.75 stroke. */
  icon: ReactNode;
  /** Drawn inside the selection. Defaults to `icon` filled in; pass your own when filling the outline would hide its detail. */
  activeIcon?: ReactNode;
  /** A count beside the icon, such as unread messages. Its digits roll when it changes and it leaves at 0. */
  badge?: number;
  /** Spoken with the tab, such as "3 unread". Defaults to the number. */
  badgeLabel?: string;
}

/**
 * Horizontal navigation for a handful of peer sections. The selection is a lens that slides to the new tab on the morph spring,
 * taking the new tab's width as it goes. The label it leaves fades out at once and the new label fades in as the lens arrives,
 * so two labels never show together. Whatever passes under the lens is redrawn inverted, so outline icons fill in as it arrives.
 * Grab the lens and throw it, or use the arrow keys. Tabs get the id `liquidTabId(id, value)` and control `liquidPanelId(id, value)`.
 */
export interface LiquidTabBarProps {
  tabs: LiquidTab[];
  value: string;
  onValueChange: (value: string) => void;
  /** Which tabs show their label: the selected one, which opens as it is chosen (the default), every tab, or none. */
  labels?: "active" | "always" | "none";
  /** Accessible name of the tab list. */
  label?: string;
  id?: string;
  className?: string;
}

export const liquidTabId = (id: string, value: string) => `${id}-tab-${value}`;
export const liquidPanelId = (id: string, value: string) => `${id}-panel-${value}`;

/** Geometry in px. Keep in step with the stylesheet. */
const PAD = 4, GAP = 2, HEIGHT = 40, SLOT = 44, LABEL_ROOM = 10;
/** How far the lens leans toward a hovered tab, in tabs. */
const LEAN = .14;
/** A label shows only once its tab is this far open: by then the lens already covers the whole word, so it never shows outside
 * the lens and never meets the outgoing label. */
const LABEL_FROM = .9, LABEL_SPAN = .1;

const { spring } = motionTokens;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round = (value: number) => Math.round(value * 100) / 100;
/** Shared spring characters restated as stiffness and damping, so a new target keeps the current velocity. */
const physical = (visualDuration: number, bounce: number): Transition => {
  const root = 2 * Math.PI / (visualDuration * 1.2);
  return { type: "spring", stiffness: root * root, damping: 2 * (1 - bounce) * root, mass: 1, restDelta: .0005, restSpeed: .02 };
};
/** Both edges and every label width share the morph spring, so the lens moves and resizes as one shape. */
const glide = physical(spring.morph.visualDuration, spring.morph.bounce);
/** The label being left fades out quickly, before the lens has travelled far. */
const leave: Transition = { duration: motionTokens.duration.instant * .8, ease: "easeOut" };
/** While held, the edges chase the pointer: the one in front almost rigidly, the one behind with a short drag. */
const heldLead = physical(.07, 0), heldTrail = physical(.2, 0);
const leanSpring = physical(spring.snappy.visualDuration, 0), press = physical(.2, 0);
const instant: Transition = { duration: 0 };
/** Resistance past the first or last tab, in tabs. */
const rubber = (overshoot: number, limit = .45, constant = .55) => overshoot * limit * constant / (limit + constant * Math.abs(overshoot));

interface Layout { lefts: number[]; widths: number[]; total: number }
function measure(widths: number[]): Layout {
  const lefts: number[] = [];
  let x = PAD;
  for (const width of widths) { lefts.push(x); x += width + GAP; }
  return { lefts, widths, total: x - GAP + PAD };
}
/** Left edge and width at a fractional tab position, extrapolated past either end. */
function at({ lefts, widths }: Layout, p: number) {
  const last = lefts.length - 1;
  if (last < 0) return { left: PAD, width: SLOT };
  if (p <= 0) return { left: lefts[0] + p * (widths[0] + GAP), width: widths[0] };
  if (p >= last) return { left: lefts[last] + (p - last) * (widths[last] + GAP), width: widths[last] };
  const i = Math.floor(p), f = p - i;
  return { left: lefts[i] + f * (lefts[i + 1] - lefts[i]), width: widths[i] + f * (widths[i + 1] - widths[i]) };
}
/** The fractional tab position whose center sits at x. */
function positionAt(layout: Layout, x: number) {
  const centers = layout.lefts.map((left, i) => left + layout.widths[i] / 2), last = centers.length - 1;
  if (last <= 0) return 0;
  if (x <= centers[0]) return (x - centers[0]) / (centers[1] - centers[0]);
  if (x >= centers[last]) return last + (x - centers[last]) / (centers[last] - centers[last - 1]);
  for (let i = 0; i < last; i++) if (x <= centers[i + 1]) return i + (x - centers[i]) / (centers[i + 1] - centers[i]);
  return last;
}

const subscribe = () => () => {};
function useReducedFlag() {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

/** One digit as a column of ten that rolls to its value. */
function Digit({ digit, reduced }: { digit: number; reduced: boolean }) {
  return <span className={styles.digit}>
    <motion.span className={styles.column} initial={false} animate={{ y: `${-digit * 10}%` }} transition={reduced ? instant : spring.snappy}>
      {"0123456789".split("").map(n => <span key={n}>{n}</span>)}
    </motion.span>
  </span>;
}

function Badge({ count, reduced, inverted }: { count: number; reduced: boolean; inverted?: boolean }) {
  const text = count > 99 ? "99" : String(count);
  return <AnimatePresence initial={false}>
    {count > 0 && <motion.span key="badge" className={styles.badge} data-inverted={inverted || undefined} aria-hidden="true"
      initial={reduced ? { opacity: 0 } : { opacity: 0, scale: .6 }} animate={{ opacity: 1, scale: 1, width: 10 + text.length * 7 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, scale: .6, transition: { duration: motionTokens.duration.fast } }}
      transition={reduced ? { duration: motionTokens.duration.instant } : { ...spring.snappy, opacity: { duration: motionTokens.duration.fast } }}>
      {text.split("").map((n, i) => <Digit key={text.length - i} digit={Number(n)} reduced={reduced} />)}
    </motion.span>}
  </AnimatePresence>;
}

interface Gesture { pointer: number; x: number; grab: number; last: number; dragging: boolean; direction: number; history: { t: number; p: number }[] }

export function LiquidTabBar({ tabs, value, onValueChange, labels = "active", label = "Sections", id, className }: LiquidTabBarProps) {
  const autoId = useId();
  const baseId = id ?? autoId;
  const reduced = useReducedFlag();
  const count = tabs.length;
  const activeIndex = Math.max(0, tabs.findIndex(tab => tab.value === value));

  const rowRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const measureRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const gesture = useRef<Gesture | null>(null);
  const heading = useRef(activeIndex);
  const suppressClick = useRef(false);
  const [labelWidths, setLabelWidths] = useState<number[]>([]);
  const [held, setHeld] = useState(false);

  // One open amount per tab, kept by value so a tab keeps its state when the list changes around it.
  const [opens] = useState(() => new Map<string, MotionValue<number>>());
  const openOf = (tab: LiquidTab, index: number) => {
    let mv = opens.get(tab.value);
    if (!mv) { mv = motionValue(labels === "always" || (labels === "active" && index === activeIndex) ? 1 : 0); opens.set(tab.value, mv); }
    return mv;
  };
  const openValues = tabs.map(openOf);
  // Whether a tab may show its label at all: it drops at once when the tab is left, so the old label never trails the lens.
  const [shows] = useState(() => new Map<string, MotionValue<number>>());
  const showOf = (tab: LiquidTab, index: number) => {
    let mv = shows.get(tab.value);
    if (!mv) { mv = motionValue(labels === "always" || (labels === "active" && index === activeIndex) ? 1 : 0); shows.set(tab.value, mv); }
    return mv;
  };
  const showValues = tabs.map(showOf);

  const left = useMotionValue(activeIndex), right = useMotionValue(activeIndex);
  const lean = useMotionValue(0), pressed = useMotionValue(0);

  const widthOf = (i: number, amount: number) => labels === "none" ? SLOT : SLOT + (LABEL_ROOM + (labelWidths[i] ?? 0)) * clamp(amount, 0, 1);
  const layoutNow = () => measure(openValues.map((mv, i) => widthOf(i, mv.get())));

  const clipPath = useTransform(() => {
    const layout = measure(openValues.map((mv, i) => widthOf(i, mv.get())));
    const l = left.get(), r = right.get(), leaning = lean.get(), press = pressed.get();
    const start = at(layout, Math.min(l, r) + Math.min(leaning, 0)), end = at(layout, Math.max(l, r) + Math.max(leaning, 0));
    const x1 = start.left, x2 = end.left + end.width;
    const inset = press * 2, sideInset = press * 2;
    const radius = HEIGHT / 2 - inset;
    return `inset(${round(PAD + inset)}px ${round(layout.total - x2 + sideInset)}px ${round(PAD + inset)}px ${round(x1 + sideInset)}px round ${round(radius)}px)`;
  });
  const total = useTransform(() => measure(openValues.map((mv, i) => widthOf(i, mv.get()))).total);

  // Labels are measured once they render, so a tab opens to exactly the width of its words.
  useLayoutEffect(() => {
    const next = measureRefs.current.slice(0, count).map(node => Math.ceil(node?.offsetWidth ?? 0));
    setLabelWidths(current => current.length === next.length && current.every((w, i) => w === next[i]) ? current : next);
  }, [count, tabs]);

  // A new value opens its label and sends the lens there; the edge facing the move leads.
  useEffect(() => {
    tabs.forEach((tab, i) => {
      const mv = opens.get(tab.value);
      if (!mv) return;
      const to = labels === "always" || (labels === "active" && i === activeIndex) ? 1 : 0;
      if (reduced) mv.jump(to); else animate(mv, to, glide);
      const shown = shows.get(tab.value);
      if (!shown) return;
      if (reduced || to === 1) shown.jump(to); else animate(shown, 0, leave);
    });
    heading.current = activeIndex;
    // The chosen tab is now under the lens, so any lean toward it lets go.
    if (reduced) lean.jump(0); else animate(lean, 0, leanSpring);
    if (gesture.current?.dragging) return;
    if (reduced) { left.jump(activeIndex); right.jump(activeIndex); return; }
    animate(left, activeIndex, glide);
    animate(right, activeIndex, glide);
  }, [activeIndex, labels, lean, left, opens, reduced, right, shows, tabs]);

  function select(index: number, focus = false) {
    const tab = tabs[index];
    if (!tab) return;
    if (focus) tabRefs.current[index]?.focus({ preventScroll: true });
    if (tab.value !== value) onValueChange(tab.value);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };
    let next: number;
    if (event.key in moves) next = (activeIndex + moves[event.key] + count) % count;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    else return;
    event.preventDefault();
    select(next, true);
  }

  function leanToward(index: number | null) {
    if (reduced || gesture.current?.dragging) return;
    const to = index === null ? 0 : clamp(index - activeIndex, -1, 1) * LEAN;
    animate(lean, to, leanSpring);
  }

  function rowX(clientX: number) { return clientX - (rowRef.current?.getBoundingClientRect().left ?? 0); }

  function onPointerDown(event: ReactPointerEvent<HTMLElement>, index: number) {
    if (event.button !== 0 || !event.isPrimary) return;
    suppressClick.current = false;
    // A press on another tab answers at once: the lens leans toward it before the click lands, for touch as well as mouse.
    if (index !== activeIndex) { leanToward(index); return; }
    if (reduced) return;
    // Grabbing the lens: it squeezes a little under the pointer and follows it once it moves.
    const layout = layoutNow();
    const p = positionAt(layout, rowX(event.clientX));
    gesture.current = { pointer: event.pointerId, x: event.clientX, grab: p - (left.get() + right.get()) / 2, last: p, dragging: false, direction: 0, history: [{ t: event.timeStamp, p }] };
    animate(pressed, 1, press);
    animate(lean, 0, leanSpring);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g || g.pointer !== event.pointerId) return;
    if (!g.dragging) {
      if (Math.abs(event.clientX - g.x) < 5) return;
      g.dragging = true;
      setHeld(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const raw = positionAt(layoutNow(), rowX(event.clientX)) - g.grab;
    const p = raw < 0 ? rubber(raw) : raw > count - 1 ? count - 1 + rubber(raw - count + 1) : raw;
    const delta = p - g.last;
    if (Math.abs(delta) > .002) g.direction = Math.sign(delta);
    g.last = p;
    g.history.push({ t: event.timeStamp, p });
    if (g.history.length > 8) g.history.shift();
    animate(left, p, g.direction < 0 ? heldLead : heldTrail);
    animate(right, p, g.direction > 0 ? heldLead : heldTrail);
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g || g.pointer !== event.pointerId) return;
    gesture.current = null;
    animate(pressed, 0, physical(.4, .35));
    if (!g.dragging) return;
    setHeld(false);
    suppressClick.current = true;
    // Project the throw with its release speed, land on the nearest tab to that point, and hand the speed to the lens.
    const recent = g.history.filter(sample => event.timeStamp - sample.t < 90);
    const first = recent[0], last = recent[recent.length - 1];
    const velocity = first && last && last.t > first.t && event.timeStamp - last.t < 60 ? (last.p - first.p) / (last.t - first.t) * 1000 : 0;
    // Momentum is projected with a deceleration curve; a clear flick always moves on at least one tab, however short the drag.
    let target = clamp(Math.round(g.last + velocity / 1000 * .993 / (1 - .993)), 0, count - 1);
    if (target === activeIndex && Math.abs(velocity) > 4) target = clamp(activeIndex + Math.sign(velocity), 0, count - 1);
    heading.current = target;
    // Both edges settle on the morph spring from wherever the throw left them, keeping their speed.
    animate(left, target, { ...glide, velocity: left.getVelocity() });
    animate(right, target, { ...glide, velocity: right.getVelocity() });
    select(target);
  }

  const style = { "--liquid-pad": `${PAD}px`, "--liquid-gap": `${GAP}px`, "--liquid-height": `${HEIGHT}px`, "--liquid-slot": `${SLOT}px` } as CSSProperties;

  const row = (inverted: boolean) => tabs.map((tab, i) => <Tab key={tab.value} tab={tab} index={i} open={openValues[i]} show={showValues[i]} labelWidth={labelWidths[i] ?? 0} labels={labels} inverted={inverted} reduced={reduced}
    selected={i === activeIndex} baseId={baseId} setRef={node => { if (!inverted) tabRefs.current[i] = node; }}
    onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } select(i); }}
    onPointerDown={event => onPointerDown(event, i)} onHover={() => leanToward(i)} />);

  return <motion.div ref={rowRef} role="tablist" aria-label={label} aria-orientation="horizontal" className={[styles.bar, className].filter(Boolean).join(" ")} style={{ ...style, width: total }}
    data-held={held || undefined} data-reduced={reduced || undefined} onKeyDown={onKeyDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
    onPointerLeave={() => leanToward(null)}>
    <div className={styles.row}>{row(false)}</div>
    <motion.div className={styles.lens} style={{ clipPath }} aria-hidden="true"><div className={styles.row}>{row(true)}</div></motion.div>
    <div className={styles.measure} aria-hidden="true">{tabs.map((tab, i) => <span key={tab.value} ref={node => { measureRefs.current[i] = node; }} className={styles.label} data-badged={tab.badge !== undefined || undefined}>{tab.label}</span>)}</div>
  </motion.div>;
}

interface TabProps {
  tab: LiquidTab; index: number; open: MotionValue<number>; show: MotionValue<number>; labelWidth: number; labels: "active" | "always" | "none"; inverted: boolean; reduced: boolean; selected: boolean; baseId: string;
  setRef: (node: HTMLButtonElement | null) => void; onClick: () => void; onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void; onHover: () => void;
}

/** A tab, drawn twice: once in outline on the track, and once inverted and filled inside the lens, which is clipped to the selection. */
function Tab({ tab, open, show, labelWidth, labels, inverted, reduced, selected, baseId, setRef, onClick, onPointerDown, onHover }: TabProps) {
  const width = useTransform(open, amount => labels === "none" ? SLOT : SLOT + (LABEL_ROOM + labelWidth) * amount);
  // The label waits until its tab is mostly open, and is gone the moment its tab is left.
  const labelOpacity = useTransform(() => clamp((open.get() - LABEL_FROM) / LABEL_SPAN, 0, 1) * show.get());
  const labelX = useTransform(open, amount => reduced ? 0 : (1 - clamp(amount, 0, 1)) * -4);
  const content = <>
    <span className={styles.icon}>{inverted ? tab.activeIcon ?? <span className={styles.filled}>{tab.icon}</span> : tab.icon}</span>
    {tab.badge !== undefined && <span className={styles.badgeAnchor}><Badge count={tab.badge} reduced={reduced} inverted={inverted} /></span>}
    {/* With only the selected label shown, it is drawn inside the lens alone, so the lens edge clips it and it never shows on the track. */}
    {(labels === "always" || (labels === "active" && inverted)) && <motion.span className={styles.label} style={{ opacity: labelOpacity, x: labelX }}>{tab.label}</motion.span>}
  </>;
  const badged = tab.badge !== undefined || undefined;
  if (inverted) return <motion.span className={styles.tab} data-badged={badged} style={{ width }}>{content}</motion.span>;
  const spoken = tab.badge ? `, ${tab.badgeLabel ?? tab.badge}` : "";
  return <motion.button ref={setRef} type="button" role="tab" id={liquidTabId(baseId, tab.value)} aria-controls={liquidPanelId(baseId, tab.value)} aria-selected={selected}
    aria-label={`${tab.label}${spoken}`} tabIndex={selected ? 0 : -1} className={styles.tab} data-selected={selected || undefined} data-badged={badged} style={{ width }}
    onClick={onClick} onPointerDown={onPointerDown} onPointerEnter={event => { if (event.pointerType === "mouse") onHover(); }}>
    {content}
  </motion.button>;
}

export default LiquidTabBar;
