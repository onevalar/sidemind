"use client";

import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ButtonHTMLAttributes, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, Ref } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, animate, motion, useMotionValue, usePresence, useReducedMotion, useTransform } from "motion/react";
import type { MotionValue, Transition } from "motion/react";
import { ChevronLeft, X } from "lucide-react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./sheet-stack.module.css";

export type SheetStackMode = "auto" | "sheet" | "dialog";

/**
 * Nested sheets that stack with depth. Opening a sheet from inside another pushes the one below back: it scales down, dims, and peeks
 * above the new sheet, and closing restores it. The top sheet can be dragged down and flung away, Escape and the scrim pop one level,
 * and focus stays in the top sheet and returns to whatever opened it. Below `breakpoint` the sheets rise from the bottom edge; above it
 * they are centered dialogs stacked the same way. Declare every `Sheet` inside one `SheetStack`, and open them with `SheetTrigger`
 * or `useSheetStack().push`. Use it for short drill-down flows such as settings, where each step should keep its parent in view.
 */
export interface SheetStackProps {
  children: ReactNode;
  /** Ids of the open sheets, bottom first. Leave undefined for uncontrolled use. */
  stack?: string[];
  defaultStack?: string[];
  onStackChange?: (stack: string[]) => void;
  /** `auto` picks bottom sheets below `breakpoint` and centered dialogs above it. */
  mode?: SheetStackMode;
  /** Width in px of the viewport, or of the container when `contained`, where `auto` switches to dialogs. Defaults to 640. */
  breakpoint?: number;
  /** Fill the nearest positioned ancestor instead of the viewport. */
  contained?: boolean;
}

export interface SheetProps {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
  /** A row pinned under the scrolling body, such as the primary action. */
  footer?: ReactNode;
  /** Label for the back button of a sheet opened from this one. Defaults to `title`. */
  backLabel?: string;
  /** Allow drag and fling to dismiss. Defaults to true. */
  dismissible?: boolean;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

export interface SheetStackControls {
  /** Open sheets, bottom first. */
  stack: string[];
  /** Opens a sheet on top. Pushing a sheet that is already open pops back to it. */
  push: (id: string) => void;
  /** Closes the top sheet. */
  pop: () => void;
  /** Closes every sheet above `id`. */
  popTo: (id: string) => void;
  /** Closes every sheet. */
  close: () => void;
}

/* ------------------------------------------------------------------------------------------------ */

/** Duration based springs restated as stiffness and damping, so a retarget or a fling keeps its velocity. */
const physical = (visualDuration: number, bounce: number): Transition => {
  const root = 2 * Math.PI / (visualDuration * 1.2);
  return { type: "spring", stiffness: root * root, damping: 2 * (1 - bounce) * root, mass: 1, restDelta: .01, restSpeed: .5 };
};
const RISE = physical(.44, .06), SINK = physical(.34, 0), DEPTH = physical(.42, 0), SIZE = physical(.4, 0), FLING = physical(.36, .08);
const fade = { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.standard] as [number, number, number, number] };

/** Peek per level in px, scale lost per level, and room kept above the top sheet. */
const PEEK = { sheet: 10, dialog: 14 }, SCALE = .05, MARGIN = { sheet: 20, dialog: 40 };
const SLOP = 6;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const rubber = (overshoot: number, size: number, c = .55) => overshoot * size * c / (size + c * Math.abs(overshoot));

const subscribe = () => () => {};
function useHydrated() { return useSyncExternalStore(subscribe, () => true, () => false); }
function useReducedFlag() { const hydrated = useHydrated(); return !!useReducedMotion() && hydrated; }

const FOCUSABLE = "a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";

interface StackContext extends SheetStackControls {
  mode: "sheet" | "dialog";
  layer: HTMLElement | null;
  size: { w: number; h: number };
  heights: Record<string, number>;
  titles: Record<string, string>;
  reportHeight: (id: string, height: number) => void;
  reportTitle: (id: string, title: string) => void;
  /** Top edge of the top sheet, on a spring. */
  frontTop: MotionValue<number>;
  /** How far the top sheet has been dragged toward closing, 0 to 1. The sheets below ease back up with it. */
  release: MotionValue<number>;
  reduced: boolean;
}

const Context = createContext<StackContext | null>(null);

/** Stack controls for triggers and buttons inside or beside the sheets. */
export function useSheetStack(): SheetStackControls {
  const context = useContext(Context);
  if (!context) throw new Error("useSheetStack must be used inside SheetStack");
  const { stack, push, pop, popTo, close } = context;
  return { stack, push, pop, popTo, close };
}

/* ------------------------------------------------------------------------------------------------ */

export function SheetStack({ children, stack: stackProp, defaultStack = [], onStackChange, mode = "auto", breakpoint = 640, contained = false }: SheetStackProps) {
  const hydrated = useHydrated();
  const reduced = useReducedFlag();
  const [inner, setInner] = useState<string[]>(defaultStack);
  const stack = stackProp ?? inner;
  const live = useRef(stack);
  useLayoutEffect(() => { live.current = stack; }, [stack]);

  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    if (!layer) return;
    const read = () => setSize(current => current.w === layer.clientWidth && current.h === layer.clientHeight ? current : { w: layer.clientWidth, h: layer.clientHeight });
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(layer);
    return () => observer.disconnect();
  }, [layer]);
  const resolved: "sheet" | "dialog" = mode === "auto" ? (size.w >= breakpoint ? "dialog" : "sheet") : mode;

  const [heights, setHeights] = useState<Record<string, number>>({});
  const reportHeight = useCallback((id: string, height: number) => setHeights(current => Math.abs((current[id] ?? -1) - height) < .5 ? current : { ...current, [id]: height }), []);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const reportTitle = useCallback((id: string, title: string) => setTitles(current => current[id] === title ? current : { ...current, [id]: title }), []);

  /* Focus returns to whatever opened each sheet. */
  const opener = useRef(new Map<string, HTMLElement>());
  const pendingFocus = useRef<HTMLElement | null>(null);
  const commit = useCallback((next: string[]) => {
    const current = live.current;
    next.forEach(id => { if (!current.includes(id) && document.activeElement instanceof HTMLElement) opener.current.set(id, document.activeElement); });
    const removed = current.filter(id => !next.includes(id));
    if (removed.length) pendingFocus.current = opener.current.get(removed[0]) ?? null;
    removed.forEach(id => opener.current.delete(id));
    live.current = next;
    if (stackProp === undefined) setInner(next);
    onStackChange?.(next);
  }, [onStackChange, stackProp]);

  const push = useCallback((id: string) => {
    const current = live.current;
    const at = current.indexOf(id);
    commit(at >= 0 ? current.slice(0, at + 1) : [...current, id]);
  }, [commit]);
  const pop = useCallback(() => { if (live.current.length) commit(live.current.slice(0, -1)); }, [commit]);
  const popTo = useCallback((id: string) => { const at = live.current.indexOf(id); if (at >= 0) commit(live.current.slice(0, at + 1)); }, [commit]);
  const close = useCallback(() => { if (live.current.length) commit([]); }, [commit]);

  /* Shared springs: the top sheet's edge, the drag release, and the scrim. */
  const frontTop = useMotionValue(0), release = useMotionValue(0), scrimBase = useMotionValue(0);
  const scrim = useTransform(() => scrimBase.get() * (1 - (live.current.length === 1 ? release.get() : 0)));
  const top = stack[stack.length - 1];
  const topHeight = top ? heights[top] : undefined;
  const frontTarget = topHeight === undefined ? null : resolved === "sheet" ? size.h - topHeight : (size.h - topHeight) / 2;
  const hadFront = useRef(false);
  useLayoutEffect(() => {
    if (frontTarget === null) return;
    if (!hadFront.current || reduced) { frontTop.jump(frontTarget); hadFront.current = true; return; }
    const controls = animate(frontTop, frontTarget, DEPTH);
    return () => controls.stop();
  }, [frontTarget, frontTop, reduced]);

  const count = stack.length;
  const lastCount = useRef(count);
  useLayoutEffect(() => {
    const before = lastCount.current;
    lastCount.current = count;
    // Sheets read the release while re-basing their depth (children run first), so it resets here.
    if (count === 0 && before > 0) scrimBase.jump(scrimBase.get() * (1 - release.get()));
    release.jump(0);
    if (count === 0) { hadFront.current = false; }
    const controls = animate(scrimBase, count ? 1 : 0, reduced ? { duration: .16 } : count ? { duration: .3, ease: [...motionTokens.ease.enter] } : { duration: .24, ease: [...motionTokens.ease.standard] });
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target?.isConnected && !target.closest("[inert]")) target.focus({ preventScroll: true });
    return () => controls.stop();
  }, [count, release, reduced, scrimBase]);

  // Escape pops one level, wherever focus is.
  useEffect(() => {
    if (!count) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); pop(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [count, pop]);

  useEffect(() => {
    if (contained || !count) return;
    const html = document.documentElement, previous = html.style.overflow;
    html.style.overflow = "hidden";
    return () => { html.style.overflow = previous; };
  }, [contained, count]);

  const value = useMemo<StackContext>(() => ({ stack, push, pop, popTo, close, mode: resolved, layer, size, heights, titles, reportHeight, reportTitle, frontTop, release, reduced }),
    [close, frontTop, heights, layer, pop, popTo, push, reduced, release, reportHeight, reportTitle, resolved, size, stack, titles]);

  const layerNode = <div ref={setLayer} className={styles.layer} data-contained={contained || undefined} data-open={count ? "" : undefined} data-mode={resolved}>
    <motion.div className={styles.scrim} style={{ opacity: scrim }} aria-hidden="true" onClick={pop} />
  </div>;

  return <Context.Provider value={value}>
    {children}
    {contained ? layerNode : hydrated ? createPortal(layerNode, document.body) : null}
  </Context.Provider>;
}

/* ------------------------------------------------------------------------------------------------ */

/** A button that opens a sheet on top of the stack. */
export function SheetTrigger({ sheet, onClick, type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { sheet: string; ref?: Ref<HTMLButtonElement> }) {
  const context = useContext(Context);
  return <button {...props} type={type} aria-haspopup="dialog" aria-expanded={context?.stack.includes(sheet) ?? false}
    onClick={event => { onClick?.(event); if (!event.defaultPrevented) context?.push(sheet); }} />;
}

/** One level of the stack. Renders nothing until its id is pushed. */
export function Sheet(props: SheetProps) {
  const context = useContext(Context);
  if (!context) throw new Error("Sheet must be used inside SheetStack");
  const { id, title, backLabel } = props;
  const { reportTitle } = context;
  useLayoutEffect(() => { reportTitle(id, backLabel ?? title); }, [backLabel, id, reportTitle, title]);
  const index = context.stack.indexOf(id);
  if (!context.layer) return null;
  return createPortal(<AnimatePresence>
    {index >= 0 && <Panel key={id} {...props} index={index} depth={context.stack.length - 1 - index} context={context} />}
  </AnimatePresence>, context.layer);
}

/* ------------------------------------------------------------------------------------------------ */

type PanelProps = SheetProps & { index: number; depth: number; context: StackContext };

function Panel({ id, title, description, children, footer, dismissible = true, className, ref, index, depth, context }: PanelProps) {
  const { mode, size, heights, titles, reportHeight, frontTop, release, reduced, stack, pop } = context;
  const uid = useId();
  const [isPresent, safeToRemove] = usePresence();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const sizerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const isTop = depth === 0 && isPresent;
  const height = heights[id];
  const peek = PEEK[mode];
  const naturalTop = height === undefined ? 0 : mode === "sheet" ? size.h - height : (size.h - height) / 2;
  const maxHeight = Math.max(160, size.h - MARGIN[mode] - peek * index - (mode === "dialog" ? MARGIN.dialog : 0));
  const previous = index > 0 ? stack[index - 1] : undefined;

  /* Motion values: depth on a spring, the sheet's own offset (enter, drag, exit), its animated height, and the dialog's entrance. */
  const depthMV = useMotionValue(depth), offset = useMotionValue(0), boxHeight = useMotionValue<number | "auto">("auto"), appear = useMotionValue(reduced ? 0 : 1);
  const natural = useMotionValue(naturalTop);
  useLayoutEffect(() => { natural.set(naturalTop); }, [natural, naturalTop]);

  const transform = useTransform(() => {
    const eff = Math.max(0, depthMV.get() - release.get());
    // A sheet one level down sits `peek` above the top sheet's edge, each further level another `peek`; in between it eases linearly.
    const lift = reduced || eff <= 0 ? 0 : eff >= 1 ? frontTop.get() - peek * eff - natural.get() : eff * (frontTop.get() - peek - natural.get());
    const y = lift + offset.get();
    const scale = reduced ? 1 : (1 - SCALE * eff) * (mode === "dialog" ? 1 - .03 * (1 - appear.get()) : 1);
    return `translate3d(0, ${y.toFixed(2)}px, 0) scale(${scale.toFixed(4)})`;
  });
  const dim = useTransform(() => clamp(depthMV.get() - release.get(), 0, 2) / 2);
  const opacity = useTransform(() => mode === "dialog" || reduced ? appear.get() : 1);

  /* Height follows the content on a spring, so a sheet never resizes in one frame. */
  const measured = useRef(false);
  useLayoutEffect(() => {
    const node = sizerRef.current;
    if (!node) return;
    const read = () => {
      const next = node.offsetHeight, body = bodyRef.current;
      // A body that scrolls keeps native vertical panning; one that fits lets a drag anywhere move the sheet.
      if (body) body.toggleAttribute("data-scrolls", body.scrollHeight > body.clientHeight + 1);
      reportHeight(id, next);
      if (!measured.current || reduced) { boxHeight.jump(next); measured.current = true; return; }
      animate(boxHeight, next, SIZE);
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, [boxHeight, id, reduced, reportHeight]);

  /* Enter: sheets rise from below their own height, dialogs settle in from just under their spot. */
  useLayoutEffect(() => {
    const node = sizerRef.current;
    if (!node) return;
    panelRef.current?.focus({ preventScroll: true });
    if (reduced) { appear.jump(0); animate(appear, 1, { duration: .16 }); return; }
    if (mode === "sheet") { offset.jump(node.offsetHeight + 24); animate(offset, 0, RISE); }
    else { offset.jump(18); appear.jump(0); animate(offset, 0, RISE); animate(appear, 1, { duration: .2, ease: [...motionTokens.ease.enter] }); }
    // Runs once on mount; later mode changes restyle in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Depth re-bases on the live drag release so a pop after a drag continues from where the sheets are. */
  const lastDepth = useRef(depth);
  useLayoutEffect(() => {
    if (!isPresent || lastDepth.current === depth) return;
    lastDepth.current = depth;
    depthMV.jump(Math.max(0, depthMV.get() - release.get()));
    if (reduced) { depthMV.jump(depth); return; }
    const controls = animate(depthMV, depth, DEPTH);
    return () => controls.stop();
  }, [depth, depthMV, isPresent, reduced, release]);

  /* Exit: continue any fling, otherwise sink back the way it came. */
  const flingVelocity = useRef(0);
  useEffect(() => {
    if (isPresent) return;
    const velocity = flingVelocity.current;
    const node = sizerRef.current, h = node?.offsetHeight ?? 400;
    const runs = reduced
      ? [animate(appear, 0, { duration: .14 })]
      : mode === "sheet"
        ? [animate(offset, (depth === 0 ? h : size.h) + 24, velocity ? { ...FLING, velocity } : SINK)]
        : [animate(offset, velocity ? offset.get() + Math.max(120, velocity * .2) : 18, velocity ? { ...FLING, velocity } : SINK), animate(appear, 0, fade)];
    Promise.all(runs).then(() => safeToRemove?.());
    return () => runs.forEach(run => run.stop());
    // Presence ending is the only trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPresent]);

  /* Drag to dismiss: 1:1 downward, rubber-banded upward, with the sheets below easing back as it goes. */
  const gesture = useRef<{ id: number; x: number; y: number; axis: "y" | "none" | null; samples: { t: number; y: number }[] } | null>(null);
  const tracking = useRef(false);
  const heightNow = () => sizerRef.current?.offsetHeight ?? 1;
  const follow = (value: number) => { if (tracking.current) release.set(clamp(value / heightNow(), 0, 1)); };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dismissible || !isTop || event.button !== 0 || gesture.current) return;
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, button, a, label, [role='slider'], [data-sheet-no-drag]")) return;
    const body = bodyRef.current;
    if (body && body.contains(target) && body.scrollTop > 0) return;
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, axis: null, samples: [{ t: event.timeStamp, y: event.clientY }] };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId || g.axis === "none") return;
    const dx = event.clientX - g.x, dy = event.clientY - g.y;
    if (!g.axis) {
      if (Math.hypot(dx, dy) < SLOP) return;
      if (Math.abs(dx) > Math.abs(dy) || (dy < 0 && bodyRef.current && bodyRef.current.scrollHeight > bodyRef.current.clientHeight)) { g.axis = "none"; return; }
      g.axis = "y";
      g.y = event.clientY - offset.get();
      event.currentTarget.setPointerCapture(event.pointerId);
      offset.stop();
      tracking.current = true;
    }
    g.samples.push({ t: event.timeStamp, y: event.clientY });
    if (g.samples.length > 6) g.samples.shift();
    const raw = event.clientY - g.y;
    const next = raw >= 0 ? raw : rubber(raw, heightNow(), .3);
    offset.set(next);
    follow(next);
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    gesture.current = null;
    if (g.axis !== "y") return;
    const first = g.samples[0], last = g.samples[g.samples.length - 1];
    const velocity = (last.y - first.y) / Math.max(.001, (last.t - first.t) / 1000);
    const at = offset.get(), h = heightNow();
    if (at > 0 && (at > h * .35 || (velocity > 450 && at > 16))) {
      flingVelocity.current = Math.max(velocity, 0);
      tracking.current = false;
      pop();
      return;
    }
    const unsubscribe = offset.on("change", follow);
    animate(offset, 0, { ...RISE, velocity }).then(() => { unsubscribe(); tracking.current = false; });
  };

  /* Focus stays in the top sheet. */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !isTop) return;
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(node => !node.closest("[inert]"));
    if (!items.length) { event.preventDefault(); return; }
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (event.shiftKey && (at <= 0)) { event.preventDefault(); items[items.length - 1].focus(); }
    else if (!event.shiftKey && at === items.length - 1) { event.preventDefault(); items[0].focus(); }
  };

  const setRefs = (node: HTMLDivElement | null) => {
    panelRef.current = node;
    if (typeof ref === "function") ref(node); else if (ref) ref.current = node;
  };

  return <motion.div ref={setRefs} className={[styles.panel, className].filter(Boolean).join(" ")} data-mode={mode} data-top={isTop || undefined}
    role="dialog" aria-modal={isTop || undefined} aria-labelledby={`${uid}-title`} aria-describedby={description ? `${uid}-description` : undefined}
    tabIndex={-1} inert={!isTop || undefined} onKeyDown={onKeyDown}
    style={{ transform, opacity, height: boxHeight, zIndex: index + 2 }}
    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}>
    <div ref={sizerRef} className={styles.sizer} style={{ maxHeight }}>
      {mode === "sheet" && <span className={styles.grabber} aria-hidden="true" />}
      <header className={styles.header}>
        <span className={styles.lead}>
          {previous && <button type="button" className={styles.back} onClick={pop}>
            <ChevronLeft size={18} strokeWidth={1.75} aria-hidden="true" />
            <span className={styles.backLabel}>{titles[previous] ?? "Back"}</span>
          </button>}
        </span>
        <h2 id={`${uid}-title`} className={styles.title}>{title}</h2>
        <span className={styles.trail}>
          <button type="button" className={styles.close} aria-label={stack.length > 1 ? "Close all" : "Close"} onClick={context.close}>
            <X size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </span>
      </header>
      {description && <p id={`${uid}-description`} className={styles.description}>{description}</p>}
      <div ref={bodyRef} className={styles.body}>{children}</div>
      {footer && <div className={styles.footer}>{footer}</div>}
    </div>
    <motion.div className={styles.dim} style={{ opacity: dim }} aria-hidden="true" />
  </motion.div>;
}

export default SheetStack;
