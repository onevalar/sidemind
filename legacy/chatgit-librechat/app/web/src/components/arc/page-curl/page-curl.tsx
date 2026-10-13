"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { animate, motion, useMotionValue, useReducedMotion, useSpring, useTransform } from "motion/react";
import type { AnimationPlaybackControls, MotionValue } from "motion/react";
import { ChevronLeft, ChevronRight, MoveUpRight } from "lucide-react";
import styles from "./page-curl.module.css";

/**
 * A small book or magazine you read by turning pages. It opens on its cover, and the first time it comes into view the
 * cover's corner lifts and curls a little, then settles, next to a "Drag the corner" hint, so it is clear it can be turned.
 * Tap the right page to go forward and the left page to go back, or grab a page and drag: it folds along a line that
 * follows your finger, showing its back with a lit curl. Let go past the middle, or flick, and it turns the rest of the way;
 * let go early and it lays back down. Arrow keys and the page controls below turn pages too.
 */
export interface PageCurlProps {
  /** Page contents in reading order. Page one is the front cover and sits alone on the right. */
  pages: ReactNode[];
  /** Controlled spread. Spread 0 shows the cover; spread n shows pages 2n and 2n + 1 (one-based). */
  spread?: number;
  /** Initial spread when uncontrolled. */
  defaultSpread?: number;
  onSpreadChange?: (spread: number) => void;
  /** Page width divided by height. Defaults to 0.72. */
  pageAspect?: number;
  /** Accessible name of the book. Defaults to "Book". */
  label?: string;
  /** Lifts the cover corner once when the book first comes into view, and a little on hover until the first turn. Defaults to true. */
  tease?: boolean;
  /** Hint shown under the corner until the first interaction. Pass null to hide it. */
  hint?: ReactNode;
  /** Shows the page count with previous and next controls under the book. Defaults to true. */
  controls?: boolean;
  className?: string;
  style?: CSSProperties;
}

type Point = [number, number];
type Turn = { dir: 1 | -1; cy: number; mode: "peek" | "tease" | "drag" | "auto" };
type Geo = { front: string; flap: string; matrix: string; fold: string; amount: number };

const HOT = 44;
/** Taps and drags start anywhere on a page: the right page turns forward, the left page back. */
const EDGE = 1;
const EMPTY = "polygon(0px 0px, 0px 0px, 0px 0px)";

const subscribe = () => () => {};
function useReducedFlag() {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

/** Keeps the part of a polygon where side(point) is zero or more. */
function clip(polygon: Point[], side: (point: Point) => number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const sa = side(a), sb = side(b);
    if (sa >= 0) out.push(a);
    if ((sa >= 0) !== (sb >= 0)) {
      const t = sa / (sa - sb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}
const css = (polygon: Point[]) => polygon.length < 3 ? EMPTY : `polygon(${polygon.map(([x, y]) => `${x.toFixed(2)}px ${y.toFixed(2)}px`).join(", ")})`;

/**
 * Folds a page of size w by h whose corner (w, cy) has been pulled to (x, y). The spine is the line x = 0, so the corner
 * can never travel farther than the page width from the spine, like real paper bound on one side.
 */
function fold(x: number, y: number, w: number, h: number, cy: number): Geo {
  let px = x, py = y;
  const s1: Point = [0, cy], s2: Point = [0, h - cy];
  let d = Math.hypot(px - s1[0], py - s1[1]);
  if (d > w) { px = s1[0] + (px - s1[0]) * w / d; py = s1[1] + (py - s1[1]) * w / d; }
  const diag = Math.hypot(w, h);
  d = Math.hypot(px - s2[0], py - s2[1]);
  if (d > diag) { px = s2[0] + (px - s2[0]) * diag / d; py = s2[1] + (py - s2[1]) * diag / d; }
  const vx = w - px, vy = cy - py, len = Math.hypot(vx, vy);
  const rect: Point[] = [[0, 0], [w, 0], [w, h], [0, h]];
  if (len < .5) return { front: css(rect), flap: EMPTY, matrix: "none", fold: "none", amount: 0 };
  const nx = vx / len, ny = vy / len, mx = (w + px) / 2, my = (cy + py) / 2;
  const side = ([X, Y]: Point) => (X - mx) * nx + (Y - my) * ny;
  const dot = mx * nx + my * ny;
  const angle = Math.atan2(ny, nx) * 180 / Math.PI;
  return {
    front: css(clip(rect, point => -side(point))),
    flap: css(clip(rect, side)),
    // Reflection across the fold line: the flap is the same sheet, flipped over.
    matrix: `matrix(${1 - 2 * nx * nx}, ${-2 * nx * ny}, ${-2 * nx * ny}, ${1 - 2 * ny * ny}, ${2 * dot * nx}, ${2 * dot * ny})`,
    fold: `translate(${mx.toFixed(2)}px, ${my.toFixed(2)}px) rotate(${angle.toFixed(3)}deg)`,
    amount: Math.min(1, len / w),
  };
}

function Page({ children, blank }: { children?: ReactNode; blank?: boolean }) {
  return <div className={styles.page} data-blank={blank || undefined}>{children}</div>;
}

export function PageCurl({ pages, spread: spreadProp, defaultSpread = 0, onSpreadChange, pageAspect = .72, label = "Book", tease = true, hint = "Drag the corner", controls = true, className, style }: PageCurlProps) {
  const reduced = useReducedFlag();
  const last = Math.ceil(pages.length / 2);
  const [inner, setInner] = useState(defaultSpread);
  const controlled = spreadProp !== undefined;
  const spread = Math.max(0, Math.min(last, controlled ? spreadProp : inner));
  const [turn, setTurn] = useState<Turn | null>(null);
  /** Which page half the mouse is over, for the turn cue: 1 next, -1 previous, 0 none. */
  const [half, setHalf] = useState<0 | 1 | -1>(0);
  const [width, setWidth] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<HTMLDivElement>(null);
  const turnRef = useRef(turn);
  const spreadRef = useRef(spread);
  useLayoutEffect(() => { turnRef.current = turn; spreadRef.current = spread; }, [turn, spread]);
  /** Updates the turn in state and in the ref at once, so pointer events that land before the next render see it. */
  const applyTurn = useCallback((next: Turn | null) => { turnRef.current = next; setTurn(next); }, []);
  const running = useRef<AnimationPlaybackControls[]>([]);
  /** The hint and hover teases stay until the reader first turns, drags, or uses a key. */
  const [interacted, setInteracted] = useState(false);
  const lastTease = useRef(0);
  const teaseTimer = useRef(0);
  const drag = useRef<{ id: number; bx: number; by: number; px: number; py: number; samples: { x: number; t: number }[]; moved: boolean; start: number } | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const update = () => setWidth(root.offsetWidth);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const W = Math.max(1, Math.floor(width / 2));
  const H = Math.round(W / pageAspect);
  const dims = useMotionValue({ w: W, h: H });
  useLayoutEffect(() => { dims.set({ w: W, h: H }); }, [W, H, dims]);
  const px = useMotionValue(W), py = useMotionValue(H), cy = useMotionValue(H);

  const geo = useTransform(() => { const { w, h } = dims.get(); return fold(px.get(), py.get(), w, h, cy.get()); });
  const frontClip = useTransform(() => geo.get().front);
  const flapClip = useTransform(() => geo.get().flap);
  const flapMatrix = useTransform(() => geo.get().matrix);
  const foldAt = useTransform(() => geo.get().fold);
  const shadowOpacity = useTransform(() => Math.sin(Math.min(1, geo.get().amount) * Math.PI * .5 + .15) * .9);

  /** The spread a committed turn is heading to, so the book recenters while the page turns instead of after it lands. */
  const [aim, setAim] = useState<0 | 1 | -1>(0);
  // The closed book sits centered: the cover alone on the right, the back cover alone on the left.
  const target = Math.max(0, Math.min(last, spread + aim));
  const shiftTarget = target === 0 ? -W / 2 : !pages[target * 2] ? W / 2 : 0;
  const shift = useSpring(shiftTarget, { stiffness: 170, damping: 26 });
  useEffect(() => { if (reduced) shift.jump(shiftTarget); else shift.set(shiftTarget); }, [shift, shiftTarget, reduced]);
  const firstWidth = useRef(true);
  useEffect(() => { if (W > 1 && firstWidth.current) { firstWidth.current = false; shift.jump(shiftTarget); } }, [W, shift, shiftTarget]);

  const stop = () => { window.clearTimeout(teaseTimer.current); running.current.forEach(control => control.stop()); running.current = []; };
  useEffect(() => () => stop(), []);

  const canTurn = useCallback((dir: 1 | -1) => dir === 1 ? !!pages[spreadRef.current * 2] : !!pages[spreadRef.current * 2 - 1], [pages]);

  const commit = useCallback((dir: 1 | -1) => {
    const next = spreadRef.current + dir;
    spreadRef.current = next;
    setAim(0);
    applyTurn(null);
    setInteracted(true);
    if (!controlled) setInner(next);
    onSpreadChange?.(next);
  }, [applyTurn, controlled, onSpreadChange]);

  const settle = useCallback((complete: boolean, velocity = 0) => {
    const t = turnRef.current;
    if (!t) return;
    stop();
    if (reduced) { if (complete) commit(t.dir); else applyTurn(null); return; }
    setAim(complete ? t.dir : 0);
    const target = complete ? -W : W;
    const spring = { type: "spring" as const, stiffness: 190, damping: 28, restDelta: .5 };
    running.current = [
      animate(py, t.cy, spring),
      animate(px, target, { ...spring, velocity, onComplete: () => { if (complete) commit(t.dir); else applyTurn(null); } }),
    ];
  }, [W, applyTurn, commit, px, py, reduced]);

  /** Turns a page on its own along a lifted arc, for taps and keys. */
  const autoTurn = useCallback((dir: 1 | -1) => {
    if (!canTurn(dir) || drag.current) return;
    if (turnRef.current?.mode === "auto") return;
    stop();
    if (reduced) { commit(dir); return; }
    const same = turnRef.current?.dir === dir;
    const bottom = same ? turnRef.current!.cy : H;
    if (!same) { cy.set(bottom); px.set(W); py.set(bottom); }
    const from = { x: px.get(), y: py.get() };
    applyTurn({ dir, cy: bottom, mode: "auto" });
    setAim(dir);
    running.current = [animate(0, 1, {
      duration: .72, ease: [.45, .05, .25, 1],
      onUpdate: v => {
        px.set(from.x + (-W - from.x) * v);
        py.set(from.y + (bottom - from.y) * v + (bottom === H ? -1 : 1) * Math.sin(Math.PI * v) * H * .16);
      },
      onComplete: () => commit(dir),
    })];
  }, [H, W, applyTurn, canTurn, commit, cy, px, py, reduced]);

  /** Lifts the lower outer corner of the right page by a share of the page, holds, then lays it back down. */
  const teaseCorner = useCallback((amount: number) => {
    if (reduced || turnRef.current || drag.current || !canTurn(1) || W < 2) return;
    stop();
    lastTease.current = performance.now();
    cy.set(H); px.set(W); py.set(H);
    applyTurn({ dir: 1, cy: H, mode: "tease" });
    const lift = { type: "spring" as const, visualDuration: .55, bounce: .18 };
    running.current = [animate(px, W * (1 - amount), lift), animate(py, H * (1 - amount * .5), lift)];
    teaseTimer.current = window.setTimeout(() => { if (turnRef.current?.mode === "tease" && !drag.current) settle(false); }, 820);
  }, [H, W, applyTurn, canTurn, cy, px, py, reduced, settle]);
  const teaseRef = useRef(teaseCorner);
  useLayoutEffect(() => { teaseRef.current = teaseCorner; }, [teaseCorner]);

  /** The first time the book is mostly in view, the cover corner curls once to show it can be turned. */
  const ready = W > 1;
  useEffect(() => {
    const node = rootRef.current;
    if (!tease || !ready || !node || typeof IntersectionObserver === "undefined") return;
    let timer = 0;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      timer = window.setTimeout(() => teaseRef.current(.26), 650);
    }, { threshold: .6 });
    observer.observe(node);
    return () => { observer.disconnect(); window.clearTimeout(timer); };
  }, [tease, ready]);

  const local = (clientX: number, clientY: number) => {
    const rect = bookRef.current!.getBoundingClientRect();
    return { bx: clientX - rect.left, by: clientY - rect.top };
  };
  const toTurn = (dir: 1 | -1, bx: number) => dir === 1 ? bx - W : W - bx;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current || (event.pointerType === "mouse" && event.button !== 0)) return;
    const { bx, by } = local(event.clientX, event.clientY);
    const current = turnRef.current;
    let dir: 1 | -1;
    if (current && current.mode !== "auto") dir = current.dir;
    else if (!current && bx > W * (2 - EDGE) && canTurn(1)) dir = 1;
    else if (!current && bx < W * EDGE && canTurn(-1)) dir = -1;
    else return;
    stop();
    setInteracted(true);
    setAim(0);
    event.currentTarget.setPointerCapture(event.pointerId);
    const corner = current ? current.cy : by < H / 2 ? 0 : H;
    if (!current) { cy.set(corner); px.set(W); py.set(corner); }
    applyTurn({ dir, cy: corner, mode: "drag" });
    drag.current = { id: event.pointerId, bx, by, px: px.get(), py: py.get(), samples: [{ x: toTurn(dir, bx), t: performance.now() }], moved: false, start: performance.now() };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const { bx, by } = local(event.clientX, event.clientY);
    const d = drag.current;
    if (d && d.id === event.pointerId) {
      const t = turnRef.current;
      if (!t) return;
      const dx = (bx - d.bx) * t.dir, dy = by - d.by;
      if (Math.hypot(dx, dy) > 4) d.moved = true;
      px.set(d.px + dx);
      py.set(d.py + dy);
      d.samples.push({ x: toTurn(t.dir, bx), t: performance.now() });
      if (d.samples.length > 6) d.samples.shift();
      return;
    }
    // Hovering a corner lifts it, so the page shows it can be turned.
    if (event.pointerType !== "mouse") return;
    setHalf(bx > W && canTurn(1) ? 1 : bx < W && canTurn(-1) ? -1 : 0);
    if (reduced || (turnRef.current && turnRef.current.mode !== "peek")) return;
    const near = (x: number, y: number) => Math.hypot(bx - x, by - y) < HOT;
    let hit: Turn | null = null;
    if (canTurn(1) && near(W * 2, H)) hit = { dir: 1, cy: H, mode: "peek" };
    else if (canTurn(1) && near(W * 2, 0)) hit = { dir: 1, cy: 0, mode: "peek" };
    else if (canTurn(-1) && near(0, H)) hit = { dir: -1, cy: H, mode: "peek" };
    else if (canTurn(-1) && near(0, 0)) hit = { dir: -1, cy: 0, mode: "peek" };
    const current = turnRef.current;
    if (hit && (!current || current.dir !== hit.dir || current.cy !== hit.cy)) {
      stop();
      cy.set(hit.cy); px.set(W); py.set(hit.cy);
      applyTurn(hit);
      const lift = { type: "spring" as const, visualDuration: .35, bounce: .25 };
      running.current = [animate(px, W - 34, lift), animate(py, hit.cy + (hit.cy ? -26 : 26), lift)];
    } else if (!hit && current?.mode === "peek") {
      settle(false);
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    drag.current = null;
    const t = turnRef.current;
    if (!t) return;
    const first = d.samples[0], end = d.samples[d.samples.length - 1];
    const velocity = end.t - first.t > 0 ? (end.x - first.x) / ((end.t - first.t) / 1000) : 0;
    if (!d.moved && performance.now() - d.start < 400) { applyTurn({ ...t, mode: "peek" }); autoTurn(t.dir); return; }
    // Project the release with its momentum, then decide.
    const projected = px.get() + velocity * .14;
    settle(projected < W * .5 || velocity < -700, velocity);
  };

  const onPointerLeave = (event: ReactPointerEvent<HTMLDivElement>) => {
    setHalf(0);
    if (event.pointerType === "mouse" && !drag.current && turnRef.current?.mode === "peek") settle(false);
  };
  /** Until the first turn, entering the book with a mouse lifts the corner again, smaller, at most every few seconds. */
  const onPointerEnter = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse" || !tease || interacted || performance.now() - lastTease.current < 2500) return;
    teaseCorner(.13);
  };

  /** Keys and the page controls turn on their own; a lifted corner on the same side simply carries on from where it is. */
  const go = (dir: 1 | -1) => { setInteracted(true); autoTurn(dir); };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight" || event.key === "PageDown") { event.preventDefault(); go(1); }
    if (event.key === "ArrowLeft" || event.key === "PageUp") { event.preventDefault(); go(-1); }
  };

  const at = (index: number) => pages[index];
  const page = (index: number) => at(index) === undefined ? null : <Page>{at(index)}</Page>;
  const dir = turn?.dir ?? 0;
  const leftIndex = dir === -1 ? spread * 2 - 3 : spread * 2 - 1;
  const rightIndex = dir === 1 ? spread * 2 + 2 : spread * 2;
  const turningIndex = dir === 1 ? spread * 2 : spread * 2 - 1;
  const backIndex = dir === 1 ? spread * 2 + 1 : spread * 2 - 2;
  const hasBack = dir !== 0 && at(backIndex) !== undefined;
  const shownLeft = spread * 2 - 1 >= 0 && at(spread * 2 - 1) !== undefined ? spread * 2 : null;
  const shownRight = at(spread * 2) !== undefined ? spread * 2 + 1 : null;
  const status = [shownLeft, shownRight].filter(Boolean).join(" and ");
  const count = spread === 0 ? "Cover" : shownRight === null ? "Back cover" : shownLeft === null ? `Page ${shownRight}` : `Pages ${shownLeft}\u2013${shownRight}`;
  const hasNext = at(spread * 2) !== undefined, hasPrev = at(spread * 2 - 1) !== undefined;

  return <div ref={rootRef} className={[styles.root, className].filter(Boolean).join(" ")} style={{ ...style, ["--page-w" as string]: `${W}px`, ["--page-h" as string]: `${H}px`, ["--diag" as string]: `${Math.ceil(Math.hypot(W, H))}px` }}
    role="group" aria-roledescription="book" aria-label={label} tabIndex={0} onKeyDown={onKeyDown} data-ready={width ? "" : undefined}>
    <motion.div ref={bookRef} className={styles.book} style={{ x: shift }} data-half={half || undefined}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onPointerLeave={onPointerLeave} onPointerEnter={onPointerEnter}>
      <div className={`${styles.slot} ${styles.left}`}>{page(leftIndex)}</div>
      <div className={`${styles.slot} ${styles.right}`}>{page(rightIndex)}</div>
      {at(spread * 2 - 1) !== undefined && at(spread * 2) !== undefined && !turn && <div className={styles.gutter} aria-hidden="true" />}
      <div className={`${styles.edge} ${styles.edgeLeft}`} aria-hidden="true" data-on={hasPrev || undefined}><span className={styles.cue}><ChevronLeft size={16} strokeWidth={1.75} /></span></div>
      <div className={`${styles.edge} ${styles.edgeRight}`} aria-hidden="true" data-on={hasNext || undefined}><span className={styles.cue}><ChevronRight size={16} strokeWidth={1.75} /></span></div>
      {hint !== null && hasNext && <p className={styles.hint} data-hidden={interacted || undefined} aria-hidden="true">{hint}<MoveUpRight size={14} strokeWidth={1.75} /></p>}

      {turn && <div className={styles.turn} data-dir={dir} aria-hidden="true">
        <motion.div className={styles.front} style={{ clipPath: frontClip }}>
          <div className={dir === -1 ? styles.mirror : undefined}>{page(turningIndex)}</div>
          <Shade at={foldAt} className={styles.frontCurl} opacity={shadowOpacity} />
        </motion.div>
        <motion.div className={styles.under} style={{ clipPath: flapClip }}>
          <Shade at={foldAt} className={styles.underShadow} opacity={shadowOpacity} />
        </motion.div>
        <div className={styles.flapWrap}>
          <motion.div className={styles.flap} style={{ clipPath: flapClip, transform: flapMatrix }}>
            <div className={dir === 1 ? styles.mirror : undefined}>{hasBack ? page(backIndex) : <Page blank />}</div>
            <Shade at={foldAt} className={styles.flapCurl} />
          </motion.div>
        </div>
      </div>}
    </motion.div>
    {controls && <div className={styles.controls}>
      <button type="button" className={styles.control} onClick={() => go(-1)} disabled={!hasPrev} aria-label="Previous page"><ChevronLeft size={18} strokeWidth={1.75} /></button>
      <p className={styles.count} aria-hidden="true"><span>{count}</span><span className={styles.total}>{spread === 0 || shownRight === null ? `${pages.length} pages` : `of ${pages.length}`}</span></p>
      <button type="button" className={styles.control} onClick={() => go(1)} disabled={!hasNext} aria-label="Next page"><ChevronRight size={18} strokeWidth={1.75} /></button>
    </div>}
    <span className={styles.status} role="status">{status ? `Page ${status} of ${pages.length}` : ""}</span>
  </div>;
}

/** A lighting band laid along the fold line; its gradient runs away from the fold on the turning side. */
function Shade({ at, className, opacity }: { at: MotionValue<string>; className: string; opacity?: MotionValue<number> }) {
  return <motion.div className={`${styles.shade} ${className}`} style={{ transform: at, opacity }} />;
}
