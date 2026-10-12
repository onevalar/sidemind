"use client";

import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import type { CSSProperties, ReactNode, Ref, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import type { MotionStyle, TargetAndTransition } from "motion/react";
import { Check, RotateCw, TriangleAlert } from "lucide-react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./stretch-refresh.module.css";

/**
 * A feed that refreshes when it is pulled down past its top edge, or scrolled up again once it is already at the top. The sheet rubber-bands with growing
 * resistance while its rows spread apart, a line in the gap stretches toward full length and tells you when to let go, runs while the work happens, and
 * gives way to a short result as new rows settle in from the top. Use it for timelines, inboxes, and activity where new entries arrive at the top; the refresh button gives keyboard and switch users the same path.
 */
export interface StretchRefreshProps<T> {
  /** Heading above the feed. */
  title: string;
  /** Short status under the heading, such as “Updated 14 min ago”. A change rises in. */
  subtitle?: string;
  items: readonly T[];
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  /**
   * Runs after a pull past the threshold or a press of the refresh button. The sheet stays open until it settles. Update the items before it resolves, and
   * resolve with a short result such as “3 new updates”. Keep it at least half a second so the spinner reads as work, not a flicker.
   */
  onRefresh: () => Promise<string | void>;
  /** Pull distance in pixels, after resistance, that arms a refresh. */
  threshold?: number;
  /** Result shown when onRefresh resolves without one. */
  doneLabel?: string;
  /** Result shown when onRefresh rejects. */
  errorLabel?: string;
  /** Accessible name of the refresh button. */
  refreshLabel?: string;
  className?: string;
}

type Phase = "idle" | "pulling" | "armed" | "refreshing" | "done";
type Outcome = { label: string; ok: boolean };

const { spring, duration, ease, blur, stagger } = motionTokens;
const enter = [...ease.enter] as [number, number, number, number];
const standard = [...ease.standard] as [number, number, number, number];
const instant = { duration: 0 } as const;
/** How far the sheet stays open while it refreshes. */
const HOLD = 60;
/** The pull approaches this distance but never reaches it. */
const LIMIT = 280;
/** Height of the line and its label, centred in the gap the pull opens. */
const INDICATOR = 34;
const GIVE = .7;
/** Early pixels follow the pointer at about 0.7 to 1; each further pixel moves the sheet less, like a rubber band. */
const resist = (raw: number) => (LIMIT * GIVE * raw) / (GIVE * raw + LIMIT);
/** The finger distance that produces a given pull, so a new gesture can catch a sheet that is still settling. */
const unresist = (pull: number) => (pull >= LIMIT - 1 ? LIMIT * 40 : (pull * LIMIT) / (GIVE * (LIMIT - pull)));
const rest: TargetAndTransition = { opacity: 1, y: 0, scale: 1, filter: "blur(0px)" };
const textIn: TargetAndTransition = { opacity: 0, y: "0.35em", filter: `blur(${blur.soft}px)` };
const iconIn: TargetAndTransition = { opacity: 0, scale: .5, filter: `blur(${blur.subtle}px)` };

/** Scale and position ride a spring; opacity and blur tween. Reduced motion keeps the same targets and only fades. */
const pop = (reduced: boolean, delay = 0) => reduced
  ? { duration: duration.fast, scale: instant, y: instant, rotate: instant, filter: instant }
  : { ...spring.snappy, delay, opacity: { duration: duration.fast, ease: enter, delay }, filter: { duration: duration.fast, ease: enter, delay } };

function DrawnCheck({ reduced }: { reduced: boolean }) {
  return <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <motion.path d="M4.5 12.5l4.8 4.8L19.5 7" initial={{ pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: 1 }} transition={reduced ? { duration: 0 } : { pathLength: { duration: .32, ease: enter, delay: .16 }, opacity: { duration: .05, delay: .16 } }} />
  </svg>;
}

/** Changed words rise in from a soft blur; the old words leave faster. */
function RisingText({ text, reduced, className }: { text: string; reduced: boolean; className?: string }) {
  return <span className={[styles.rise, className].filter(Boolean).join(" ")}><AnimatePresence mode="popLayout" initial={false}>
    <motion.span key={text} className={styles.riseItem} initial={textIn} animate={rest} exit={{ opacity: 0, y: "-0.3em", filter: `blur(${blur.subtle}px)`, transition: { duration: duration.instant, ease: standard } }} transition={reduced ? { duration: duration.fast, y: instant, filter: instant } : { duration: duration.standard, ease: enter }}>{text}</motion.span>
  </AnimatePresence></span>;
}

/** New rows arrive from above in order, a beat after the sheet makes room; rows already on screen glide to their new place. The ref lets popLayout lift a leaving row out of the flow. */
function Row({ ref, index, reduced, children }: { ref?: Ref<HTMLLIElement>; index: number; reduced: boolean; children: ReactNode }) {
  const delay = .1 + Math.min(index, 5) * stagger.line * .75;
  return <motion.li ref={ref} layout="position" className={styles.item}
    initial={{ opacity: 0, y: -16, scale: .97, filter: `blur(${blur.soft}px)` }}
    animate={rest}
    exit={{ opacity: 0, scale: .97, filter: `blur(${blur.subtle}px)`, transition: { duration: reduced ? duration.instant : duration.exit, ease: standard } }}
    transition={reduced
      ? { duration: duration.fast, y: instant, scale: instant, filter: instant, layout: instant }
      : { y: { ...spring.morph, delay }, scale: { ...spring.morph, delay }, opacity: { duration: duration.standard, ease: enter, delay }, filter: { duration: duration.standard, ease: enter, delay }, layout: spring.smooth }}>
    <div className={styles.row} style={{ "--i": Math.min(index, 6) } as CSSProperties}>{children}</div>
  </motion.li>;
}

export function StretchRefresh<T>({ title, subtitle, items, getKey, renderItem, onRefresh, threshold = 72, doneLabel = "Up to date", errorLabel = "Couldn’t refresh", refreshLabel = "Refresh", className }: StretchRefreshProps<T>) {
  const reduced = useReducedMotion() ?? false;
  const titleId = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  /** Gesture bookkeeping lives outside React so a drag never renders per frame. */
  const live = useRef({ phase: "idle" as Phase, source: null as "pointer" | "touch" | "wheel" | null, pulling: false, startY: 0, raw: 0, pointer: -1, lastWheel: -1e9, wheelTimer: 0, closeTimer: 0, suppressClick: false, alive: true });

  /** The sheet offset. Everything spatial derives from it. */
  const pull = useMotionValue(0);
  /** Spreads the rows apart while dragging, then snaps them back together on release. */
  const tension = useMotionValue(0);
  /** Runs a short segment back and forth along the line while the refresh works. */
  const turn = useMotionValue(0);
  /** The line stretches from its centre with the pull and reaches full length exactly at the threshold. */
  const fill = useTransform(pull, (value) => Math.min(1, value / threshold));
  const runX = useTransform(turn, (value) => `${value * 150}%`);
  const anchorY = useTransform(pull, (value) => (value - INDICATOR) / 2);
  const anchorOpacity = useTransform(pull, [4, 28], [0, 1]);
  const peel = useTransform(pull, [0, 40], [0, 1]);

  const go = (next: Phase) => { live.current.phase = next; setPhase(next); };
  const atTop = () => (viewport.current?.scrollTop ?? 0) <= 0;

  function settle(target: number) {
    animate(pull, target, reduced ? instant : { ...(target ? spring.morph : spring.smooth), velocity: pull.getVelocity() });
    animate(tension, 0, reduced ? instant : { ...spring.morph, velocity: tension.getVelocity() });
  }

  function close() {
    animate(pull, 0, reduced ? instant : spring.smooth).then(() => {
      if (!live.current.alive || live.current.phase !== "done") return;
      turn.set(0);
      go("idle");
    });
  }

  async function refresh() {
    const state = live.current;
    if (state.phase === "refreshing" || state.phase === "done") return;
    window.clearTimeout(state.wheelTimer);
    state.source = null; state.pulling = false; state.pointer = -1;
    go("refreshing");
    settle(HOLD);
    turn.set(0);
    if (!reduced) animate(turn, 1, { duration: .7, ease: [...ease.inOut] as [number, number, number, number], repeat: Infinity, repeatType: "mirror" });
    const node = viewport.current;
    if (node && node.scrollTop > 0) node.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
    let next: Outcome;
    try { next = { ok: true, label: (await onRefresh()) || doneLabel }; } catch { next = { ok: false, label: errorLabel }; }
    if (!state.alive) return;
    turn.stop();
    setOutcome(next);
    go("done");
    window.clearTimeout(state.closeTimer);
    state.closeTimer = window.setTimeout(close, next.ok ? 1200 : 1800);
  }

  function drag(raw: number) {
    const state = live.current;
    state.raw = Math.max(0, raw);
    const value = resist(state.raw);
    pull.set(value);
    tension.set(value);
    const next = value >= threshold ? "armed" : "pulling";
    if (state.phase !== next) go(next);
  }

  function begin(source: "pointer" | "touch" | "wheel", y: number) {
    const state = live.current;
    if (state.source || state.phase !== "idle" || !atTop()) return false;
    pull.stop(); tension.stop();
    const carried = unresist(pull.get());
    state.source = source;
    state.pulling = carried > 0;
    state.raw = carried;
    state.startY = y - carried;
    return true;
  }

  /** Returns true while the gesture owns the movement. A first move upward hands it back to native scrolling. */
  function move(y: number, slop: number) {
    const state = live.current;
    const raw = y - state.startY;
    if (!state.pulling) {
      if (raw < 0) { state.source = null; state.pointer = -1; return false; }
      if (raw <= slop) return false;
      state.pulling = true;
    }
    drag(raw);
    return true;
  }

  function release() {
    const state = live.current;
    if (!state.source) return;
    const pulled = state.pulling;
    window.clearTimeout(state.wheelTimer);
    state.source = null; state.pulling = false; state.pointer = -1; state.raw = 0;
    if (!pulled) return;
    if (state.phase === "armed") { void refresh(); return; }
    go("idle");
    settle(0);
  }

  function wheel(event: WheelEvent) {
    const state = live.current;
    const dy = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
    const gap = event.timeStamp - state.lastWheel;
    state.lastWheel = event.timeStamp;
    if (state.source !== "wheel") {
      // Only a fresh upward scroll at the top pulls. Momentum that carries a scroll into the top edge never refreshes by accident.
      if (dy >= 0 || gap < 180 || Math.abs(event.deltaX) > Math.abs(dy) || !begin("wheel", 0)) return;
      state.pulling = true;
    }
    event.preventDefault();
    drag(state.raw - dy);
    window.clearTimeout(state.wheelTimer);
    if (state.raw <= 0) release();
    else state.wheelTimer = window.setTimeout(release, 160);
  }

  const onWheel = useEffectEvent((event: WheelEvent) => wheel(event));
  const onTouchStart = useEffectEvent((event: TouchEvent) => { if (event.touches.length === 1) begin("touch", event.touches[0].clientY); });
  const onTouchMove = useEffectEvent((event: TouchEvent) => {
    if (live.current.source !== "touch" || event.touches.length !== 1) return;
    if (move(event.touches[0].clientY, 0) && event.cancelable) event.preventDefault();
  });
  const onTouchEnd = useEffectEvent(() => { if (live.current.source === "touch") release(); });

  useEffect(() => {
    const node = viewport.current;
    const state = live.current;
    state.alive = true;
    if (!node) return;
    const wheelListener = (event: WheelEvent) => onWheel(event);
    const startListener = (event: TouchEvent) => onTouchStart(event);
    const moveListener = (event: TouchEvent) => onTouchMove(event);
    const endListener = () => onTouchEnd();
    node.addEventListener("wheel", wheelListener, { passive: false });
    node.addEventListener("touchstart", startListener, { passive: true });
    node.addEventListener("touchmove", moveListener, { passive: false });
    node.addEventListener("touchend", endListener);
    node.addEventListener("touchcancel", endListener);
    return () => {
      state.alive = false;
      turn.stop();
      window.clearTimeout(state.wheelTimer);
      window.clearTimeout(state.closeTimer);
      node.removeEventListener("wheel", wheelListener);
      node.removeEventListener("touchstart", startListener);
      node.removeEventListener("touchmove", moveListener);
      node.removeEventListener("touchend", endListener);
      node.removeEventListener("touchcancel", endListener);
    };
  }, [turn]);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === "touch" || event.button !== 0) return;
    const node = event.currentTarget;
    // Leave the scrollbar to the browser.
    if (event.clientX - node.getBoundingClientRect().left > node.clientWidth) return;
    if (begin("pointer", event.clientY)) live.current.pointer = event.pointerId;
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = live.current;
    if (state.source !== "pointer" || event.pointerId !== state.pointer) return;
    const started = !state.pulling;
    if (move(event.clientY, 4) && started) {
      event.currentTarget.setPointerCapture(event.pointerId);
      window.getSelection()?.removeAllRanges();
    }
  }

  function onPointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    const state = live.current;
    if (state.source !== "pointer" || event.pointerId !== state.pointer) return;
    if (state.pulling) {
      state.suppressClick = true;
      window.setTimeout(() => { state.suppressClick = false; }, 0);
    }
    release();
  }

  /** A drag that ends over a row must not also press it. */
  function onClickCapture(event: ReactMouseEvent<HTMLDivElement>) {
    if (!live.current.suppressClick) return;
    event.preventDefault();
    event.stopPropagation();
  }

  const armed = phase === "armed";
  const spinning = phase === "refreshing";
  const done = phase === "done";
  const ok = outcome?.ok ?? true;
  const busy = spinning || done;
  const buttonIcon = done ? (ok ? "done" : "error") : "refresh";

  return <section className={[styles.root, className].filter(Boolean).join(" ")} aria-labelledby={titleId} data-state={phase} data-pulling={phase === "pulling" || armed || undefined}>
    <header className={styles.header}>
      <div className={styles.heading}>
        <h3 id={titleId} className={styles.title}>{title}</h3>
        {subtitle && <p className={styles.subtitle}><RisingText text={subtitle} reduced={reduced} /></p>}
      </div>
      <button type="button" className={styles.refresh} onClick={() => void refresh()} aria-label={refreshLabel} aria-disabled={busy || undefined} data-busy={spinning || undefined}>
        <span className={styles.refreshGlyph}>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span key={buttonIcon} className={styles.refreshIcon} data-tone={buttonIcon} initial={iconIn} animate={rest} exit={{ ...iconIn, transition: { duration: duration.instant } }} transition={pop(reduced)}>
              {buttonIcon === "done" ? <Check size={16} strokeWidth={2.2} aria-hidden="true" /> : buttonIcon === "error" ? <TriangleAlert size={16} strokeWidth={2} aria-hidden="true" /> : <RotateCw size={16} strokeWidth={2} aria-hidden="true" className={styles.refreshTurn} />}
            </motion.span>
          </AnimatePresence>
        </span>
      </button>
    </header>

    <div className={styles.stage}>
      <div className={styles.tray} aria-hidden="true">
        <motion.div className={styles.anchor} style={{ y: anchorY, opacity: anchorOpacity }}>
          <div className={styles.indicator} data-tone={done && !ok ? "warning" : undefined}>
            <motion.span className={styles.meter} initial={false} animate={done ? { opacity: 0, scaleX: .4 } : { opacity: 1, scaleX: armed && !reduced ? 1.12 : 1 }} transition={reduced ? { duration: duration.fast } : done ? { duration: duration.exit, ease: standard } : spring.snappy}>
              <motion.span className={styles.meterFill} style={{ scaleX: fill }} initial={false} animate={{ opacity: spinning || done ? 0 : 1 }} transition={{ duration: duration.fast }} />
              <motion.span className={styles.meterRun} style={{ x: runX }} initial={false} animate={{ opacity: spinning ? 1 : 0 }} transition={{ duration: duration.fast }} />
            </motion.span>
            <span className={styles.status}>
              <AnimatePresence initial={false}>
                {done && <motion.span key={ok ? "ok" : "error"} className={styles.mark} initial={iconIn} animate={rest} exit={{ opacity: 0, transition: { duration: duration.instant } }} transition={pop(reduced, .06)}>
                  {ok ? <DrawnCheck reduced={reduced} /> : <TriangleAlert size={14} strokeWidth={2} />}
                </motion.span>}
              </AnimatePresence>
              <RisingText text={done && outcome ? outcome.label : spinning ? "Refreshing" : armed ? "Release to refresh" : "Pull to refresh"} reduced={reduced} />
            </span>
          </div>
        </motion.div>
      </div>

      <motion.div ref={viewport} layoutScroll className={styles.viewport} style={{ y: pull, "--peel": peel } as MotionStyle} role="region" aria-labelledby={titleId} tabIndex={0}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd} onClickCapture={onClickCapture}>
        <motion.ul className={styles.list} aria-busy={spinning || undefined} style={{ "--tension": tension } as MotionStyle}>
          <AnimatePresence mode="popLayout" initial={false}>
            {items.map((item, index) => <Row key={getKey(item)} index={index} reduced={reduced}>{renderItem(item)}</Row>)}
          </AnimatePresence>
        </motion.ul>
      </motion.div>
    </div>

    <p className={styles.srOnly} role="status" aria-live="polite">{spinning ? "Refreshing" : done && outcome ? outcome.label : ""}</p>
  </section>;
}

export default StretchRefresh;
