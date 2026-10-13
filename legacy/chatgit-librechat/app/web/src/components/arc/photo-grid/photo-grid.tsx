"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { flushSync } from "react-dom";
import { AnimatePresence, LayoutGroup, animate, motion, useMotionValue, useMotionValueEvent, useReducedMotion, useTransform } from "motion/react";
import type { MotionValue, TargetAndTransition, Transition, Variants } from "motion/react";
import { ArrowLeft, ChevronLeft, ChevronRight, Heart } from "lucide-react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./photo-grid.module.css";

export interface GridPhoto {
  id: string;
  /** Fallback source. Pass a srcSet so the grid and the viewer can each pick a fitting size. */
  src: string;
  srcSet?: string;
  alt: string;
  /** Intrinsic size. The viewer fits the whole photo and the filmstrip widens to its aspect ratio. */
  width: number;
  height: number;
  title: string;
  /** A short line under the title in the viewer, such as the date and time. */
  detail?: string;
}

export interface PhotoGridProps {
  photos: GridPhoto[];
  /** Names the library, such as a month or an album. */
  title: string;
  /** Column counts the zoom steps between. Pinching in moves toward fewer, larger photos. */
  zoomLevels?: number[];
  defaultColumns?: number;
  onColumnsChange?: (columns: number) => void;
  defaultFavorites?: string[];
  onFavoriteChange?: (id: string, favorite: boolean) => void;
  /** Called with the photo id when the viewer opens and with null as it starts to close. */
  onViewerChange?: (id: string | null) => void;
  className?: string;
}

type Phase = "closed" | "open" | "closing";
/** Where the open photo starts or lands: offset from its fitted centre, cover scale, and the crop that makes it a grid cell. */
type Flight = { dx: number; dy: number; k: number; t: number; r: number; b: number; l: number };
type Strip = { x: number[]; c: number[]; o: number[] };
type Sample = { t: number; x: number; y: number };

const DEFAULT_LEVELS = [5, 3, 2];
const GRID_SIZES = "(max-width: 760px) 50vw, 360px";
const VIEWER_SIZES = "(max-width: 760px) 100vw, 720px";
const GRID_GAP = 3;
/** Corner radius of a grid tile and of the open photo. The open photo's corners morph between the two as it travels. */
const TILE_RADIUS = 6, VIEW_RADIUS = 14;
const PAGE_GAP = 24;
const STAGE_PAD = 12;
const THUMB = { narrow: 22, gap: 2, margin: 4, height: 40 };
const THUMB_STEP = THUMB.narrow + THUMB.gap;
const REST: Flight = { dx: 0, dy: 0, k: 1, t: 0, r: 0, b: 0, l: 0 };
const { spring, duration, ease, blur } = motionTokens;
const closeSpring: Transition = { ...spring.smooth, visualDuration: .34 };
const fade = { duration: duration.fast };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const lerp = (from: number, to: number, t: number) => from + (to - from) * t;
/** Resistance that grows with distance, so a pull past the edge gives way less and less. */
const rubber = (distance: number, dimension: number) => (1 - 1 / (distance * .55 / dimension + 1)) * dimension;
const rubberIndex = (raw: number, last: number, unit: number) => raw < 0 ? -rubber(-raw * unit, unit) / unit : raw > last ? last + rubber((raw - last) * unit, unit) / unit : raw;
/** Pulling the photo down shrinks it toward the grid it came from. */
const shrinkOf = (dy: number, height: number) => 1 - .42 * clamp(dy / Math.max(height, 1), 0, 1);
const cx = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

function fit(photo: GridPhoto, width: number, height: number) {
  const aw = Math.max(width - STAGE_PAD * 2, 1), ah = Math.max(height - STAGE_PAD * 2, 1), ratio = photo.width / photo.height;
  let w = aw, h = aw / ratio;
  if (h > ah) { h = ah; w = ah * ratio; }
  return { x: (width - w) / 2, y: (height - h) / 2, w, h };
}

/** Velocity over the last 100ms of pointer moves, in px per second; a finger that rested before lifting throws nothing. */
function velocityOf(samples: Sample[], releasedAt: number) {
  const last = samples[samples.length - 1];
  const first = last && samples.find(sample => last.t - sample.t <= 100);
  if (!last || !first || last.t === first.t || releasedAt - last.t > 80) return { x: 0, y: 0 };
  const seconds = (last.t - first.t) / 1000;
  return { x: (last.x - first.x) / seconds, y: (last.y - first.y) / seconds };
}

/** Filmstrip geometry for a fractional position: the photo in view widens to its own aspect ratio and brightens, the rest stay dim slivers. */
function stripLayout(position: number, width: number, wides: number[]): Strip {
  const last = wides.length - 1;
  if (last < 0) return { x: [], c: [], o: [] };
  const settled = clamp(position, 0, last), lefts: number[] = [], widths: number[] = [];
  let run = 0;
  wides.forEach((wide, index) => {
    const t = Math.max(0, 1 - Math.abs(index - settled));
    const w = THUMB.narrow + (wide - THUMB.narrow) * t, margin = THUMB.margin * t;
    lefts.push(run + margin); widths.push(w); run += w + margin * 2 + THUMB.gap;
  });
  const lo = Math.floor(settled), hi = Math.min(last, lo + 1);
  const anchor = lerp(lefts[lo] + widths[lo] / 2, lefts[hi] + widths[hi] / 2, settled - lo) + (position - settled) * THUMB_STEP;
  const offset = width / 2 - anchor;
  return { x: lefts.map((left, index) => offset + left - (wides[index] - widths[index]) / 2), c: widths.map((w, index) => (wides[index] - w) / 2), o: wides.map((_, index) => 1 - .5 * Math.min(1, Math.abs(index - position))) };
}

const textHidden = (reduced: boolean): TargetAndTransition => reduced ? { opacity: 0 } : { opacity: 0, y: "0.3em", filter: `blur(${blur.soft}px)` };
const textShown: TargetAndTransition = { opacity: 1, y: "0em", filter: "blur(0px)" };
const textIn = (reduced: boolean): Transition => reduced ? fade : { duration: duration.standard, ease: [...ease.enter] };

/** Text that changes rises in from a soft blur while the old line leaves faster. */
function SwapText({ text, reduced }: { text: string; reduced: boolean }) {
  return <span className={styles.swap}><AnimatePresence mode="popLayout" initial={false}>
    <motion.span key={text} className={styles.swapText} initial={textHidden(reduced)} animate={textShown} exit={{ ...textHidden(reduced), transition: reduced ? fade : { duration: duration.instant } }} transition={textIn(reduced)}>{text}</motion.span>
  </AnimatePresence></span>;
}

/** Springs its width to fit new content, so the words beside it glide instead of jumping. */
function MorphWidth({ children, reduced }: { children: ReactNode; reduced: boolean }) {
  const inner = useRef<HTMLSpanElement>(null);
  const width = useMotionValue<number | "auto">("auto");
  useEffect(() => {
    const node = inner.current, outer = node?.parentElement;
    if (!node || !outer || typeof ResizeObserver === "undefined") return;
    let measured = false;
    const observer = new ResizeObserver(() => {
      const next = node.offsetWidth;
      if (!measured || reduced || !next) { measured = next > 0; width.jump(next || "auto"); return; }
      outer.dataset.morphing = "";
      animate(width, next, { ...spring.morph, onComplete: () => { delete outer.dataset.morphing; } });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [reduced, width]);
  return <motion.span className={styles.morph} style={{ width }}><span ref={inner} className={styles.morphInner}>{children}</span></motion.span>;
}

const rollVariants = (reduced: boolean): Variants => ({
  enter: (direction: number) => reduced ? { opacity: 0 } : { opacity: 0, y: `${direction * .62}em`, filter: `blur(${blur.subtle}px)` },
  center: { opacity: 1, y: "0em", filter: "blur(0px)", transition: reduced ? fade : { ...spring.snappy, opacity: { duration: duration.fast }, filter: { duration: duration.fast } } },
  exit: (direction: number) => reduced ? { opacity: 0, transition: fade } : { opacity: 0, y: `${direction * -.62}em`, filter: `blur(${blur.subtle}px)`, transition: { duration: duration.fast, ease: [...ease.standard] } },
});

/** Digits roll the way the number moved; unchanged places stay still. */
function Roll({ value, reduced }: { value: number; reduced: boolean }) {
  const [state, setState] = useState({ value, direction: 1 });
  if (state.value !== value) setState({ value, direction: value > state.value ? 1 : -1 });
  const chars = String(value).split(""), variants = rollVariants(reduced);
  return <span className={styles.roll}><AnimatePresence initial={false} custom={state.direction}>
    {chars.map((char, index) => <motion.span key={chars.length - index} className={styles.place} custom={state.direction} variants={variants} initial="enter" animate="center" exit="exit">
      <AnimatePresence mode="popLayout" initial={false} custom={state.direction}>
        <motion.span key={char} className={styles.digit} custom={state.direction} variants={variants} initial="enter" animate="center" exit="exit">{char}</motion.span>
      </AnimatePresence>
    </motion.span>)}
  </AnimatePresence></span>;
}

function ZoomGlyph({ columns }: { columns: number }) {
  const gap = columns > 2 ? 1 : 2, cell = (14 - gap * (columns - 1)) / columns;
  const cells = Array.from({ length: columns * columns }, (_, index) => ({ x: 1 + (index % columns) * (cell + gap), y: 1 + Math.floor(index / columns) * (cell + gap) }));
  return <svg width={16} height={16} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">{cells.map(({ x, y }) => <rect key={`${x}-${y}`} x={x} y={y} width={cell} height={cell} rx={columns > 3 ? .5 : 1.25} />)}</svg>;
}

/** The sharp copy loads on top of the grid thumbnail and fades in once it is ready. */
function SharpLayer({ photo }: { photo: GridPhoto }) {
  const [loaded, setLoaded] = useState(false);
  // eslint-disable-next-line @next/next/no-img-element -- registry components stay framework agnostic; pass optimized URLs as src and srcSet.
  return <img className={styles.sharp} data-loaded={loaded || undefined} src={photo.src} srcSet={photo.srcSet} sizes={VIEWER_SIZES} alt="" draggable={false} decoding="async" onLoad={() => setLoaded(true)} />;
}

function Thumb({ photo, index, wide, geometry }: { photo: GridPhoto; index: number; wide: number; geometry: MotionValue<Strip> }) {
  const x = useTransform(geometry, value => value.x[index] ?? 0);
  const clipPath = useTransform(geometry, value => `inset(0px ${value.c[index] ?? 0}px round 4px)`);
  const opacity = useTransform(geometry, value => value.o[index] ?? .5);
  return <motion.span className={styles.thumb} style={{ width: wide, x, clipPath, opacity }}>
    {/* eslint-disable-next-line @next/next/no-img-element -- registry components stay framework agnostic */}
    <img src={photo.src} srcSet={photo.srcSet} sizes={GRID_SIZES} alt="" draggable={false} decoding="async" />
  </motion.span>;
}

export function PhotoGrid({ photos, title, zoomLevels = DEFAULT_LEVELS, defaultColumns = 3, onColumnsChange, defaultFavorites, onFavoriteChange, onViewerChange, className }: PhotoGridProps) {
  const id = useId();
  const reduced = useReducedMotion() ?? false;
  const count = photos.length, last = count - 1;
  const levels = useMemo(() => [...new Set(zoomLevels)].filter(level => level > 0).sort((a, b) => b - a), [zoomLevels]);
  const [columns, setColumns] = useState(() => levels.includes(defaultColumns) ? defaultColumns : levels[Math.floor(levels.length / 2)] ?? 3);
  const [favorites, setFavorites] = useState(() => new Set(defaultFavorites));
  const [phase, setPhase] = useState<Phase>("closed");
  const [current, setCurrent] = useState(0);
  const [focusIndex, setFocusIndex] = useState(0);
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [scrolled, setScrolled] = useState(false);
  const [status, setStatus] = useState("");

  const frameRef = useRef<HTMLDivElement>(null), scrollerRef = useRef<HTMLDivElement>(null), listRef = useRef<HTMLUListElement>(null), headerRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null), stripRef = useRef<HTMLDivElement>(null), backRef = useRef<HTMLButtonElement>(null);
  const tileRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const phaseRef = useRef<Phase>("closed"), columnsRef = useRef(columns);
  const anchorRef = useRef<{ index: number; fraction: number; viewY: number } | null>(null);
  const restoreFocus = useRef(false);
  const pinch = useRef({ active: false, log: 0, x: 0, y: 0, timer: 0 as ReturnType<typeof setTimeout> | 0, gesture: false, wheelX: 0, wheelAt: 0, wheelLock: false });
  const drag = useRef<{ id: number; x0: number; y0: number; pos0: number; dx0: number; dy0: number; axis: "x" | "y" | null; samples: Sample[] } | null>(null);
  const scrub = useRef<{ id: number; x0: number; pos0: number; moved: boolean; samples: Sample[] } | null>(null);

  const progress = useMotionValue(0), veil = useMotionValue(1), chrome = useMotionValue(0);
  // `page` moves the photos; `position` moves the filmstrip. They travel together except while scrubbing, when the photos step one page at a time.
  const page = useMotionValue(0), position = useMotionValue(0), currentValue = useMotionValue(0);
  const dragX = useMotionValue(0), dragY = useMotionValue(0);
  const pageWidth = useMotionValue(1), stageHeight = useMotionValue(1), stripWidth = useMotionValue(0);
  const flight = useMotionValue<Flight>(REST), grab = useMotionValue({ x: 0, y: 0 });
  const livePinch = useMotionValue(1);

  // The open photo is one element: it travels, scales, and uncrops from its grid cell into the fitted frame, then follows the finger.
  const photoX = useTransform(() => {
    const p = progress.get(), f = flight.get(), g = grab.get(), dx = dragX.get(), dy = dragY.get();
    const residual = (currentValue.get() - page.get()) * pageWidth.get();
    return (1 - p) * (f.dx - residual) + dx + (1 - shrinkOf(dy, stageHeight.get())) * g.x;
  });
  const photoY = useTransform(() => {
    const p = progress.get(), f = flight.get(), g = grab.get(), dy = dragY.get();
    return (1 - p) * f.dy + dy + (1 - shrinkOf(dy, stageHeight.get())) * g.y;
  });
  const photoScale = useTransform(() => lerp(flight.get().k, 1, progress.get()) * shrinkOf(dragY.get(), stageHeight.get()));
  const photoClip = useTransform(() => {
    const f = flight.get(), p = progress.get(), q = Math.max(0, 1 - p), px = (value: number) => `${Math.max(0, value * q).toFixed(2)}px`;
    // The crop's corners are drawn before the photo scales, so the tile radius is divided by the scale to read true on screen.
    const radius = Math.max(0, lerp(TILE_RADIUS / Math.max(f.k, .01), VIEW_RADIUS, clamp(p, 0, 1)));
    return `inset(${px(f.t)} ${px(f.r)} ${px(f.b)} ${px(f.l)} round ${radius.toFixed(2)}px)`;
  });
  const backdrop = useTransform(() => clamp(progress.get(), 0, 1) * (1 - clamp(dragY.get() / Math.max(stageHeight.get() * .5, 1), 0, 1)));
  // The grid blurs first, then the surface settles over it; pulling the photo down brings the grid back into focus.
  const frost = useTransform(() => Math.min(1, backdrop.get() * 2));
  const chromeOpacity = useTransform(() => chrome.get() * (1 - clamp(Math.abs(dragY.get()) / 64, 0, 1)));
  const barY = useTransform(() => (1 - chrome.get()) * -8);
  const stripY = useTransform(() => (1 - chrome.get()) * 10);
  const trackX = useTransform(() => -page.get() * pageWidth.get());
  const wides = useMemo(() => photos.map(photo => clamp(THUMB.height * photo.width / photo.height, THUMB.narrow, THUMB.height * 1.8)), [photos]);
  const strip = useTransform(() => stripLayout(position.get(), stripWidth.get(), wides));

  const setPhaseNow = (next: Phase) => { phaseRef.current = next; setPhase(next); };
  const announce = (message: string) => setStatus(message);
  const tileSize = (cols: number) => ((scrollerRef.current?.clientWidth ?? 0) - (cols - 1) * GRID_GAP) / cols;
  const headerHeight = () => headerRef.current?.offsetHeight ?? 0;

  useLayoutEffect(() => { columnsRef.current = columns; });

  // The list scale for a live pinch is written straight to the DOM so a column commit can clear it in the same frame.
  useMotionValueEvent(livePinch, "change", value => {
    const list = listRef.current;
    if (list) list.style.transform = value === 1 ? "" : `scale(${value})`;
  });

  function updateRange(pos: number) {
    const cur = currentValue.get();
    const lo = Math.max(0, Math.min(Math.floor(pos), cur) - 1), hi = Math.min(last, Math.max(Math.ceil(pos), cur) + 1);
    setRange(prev => prev[0] === lo && prev[1] === hi ? prev : [lo, hi]);
  }
  useMotionValueEvent(page, "change", updateRange);

  // Stage and filmstrip sizes feed the geometry as motion values, so a resize never re-renders mid-gesture.
  useEffect(() => {
    const stageNode = stageRef.current, stripNode = stripRef.current;
    if (!stageNode || !stripNode || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const w = stageNode.clientWidth, h = stageNode.clientHeight;
      setStage(prev => prev.w === w && prev.h === h ? prev : { w, h });
      pageWidth.set(w + PAGE_GAP); stageHeight.set(h); stripWidth.set(stripNode.clientWidth);
    });
    observer.observe(stageNode); observer.observe(stripNode);
    return () => observer.disconnect();
  }, [pageWidth, stageHeight, stripWidth]);

  /** Keeps the photo under the pinch (or the middle of the view) in place while the columns change. */
  function captureAnchor(focal?: { x: number; y: number }) {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const box = scroller.getBoundingClientRect(), top = headerHeight();
    // Without a pinch point, the top row stays put at the start of the list and the bottom row at its end.
    const atStart = scroller.scrollTop < 1, atEnd = scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1;
    const fx = focal?.x ?? box.left + box.width / 2;
    const fy = focal?.y ?? (atStart ? box.top + top + 1 : atEnd ? box.bottom - 1 : box.top + top + (box.height - top) / 2);
    let best = -1, bestDistance = Infinity, bestRect: DOMRect | null = null;
    tileRefs.current.forEach((tile, index) => {
      if (!tile) return;
      const rect = tile.getBoundingClientRect();
      const dx = Math.max(rect.left - fx, 0, fx - rect.right), dy = Math.max(rect.top - fy, 0, fy - rect.bottom), distance = dx * dx + dy * dy;
      if (distance < bestDistance) { best = index; bestDistance = distance; bestRect = rect; }
    });
    const rect = bestRect as DOMRect | null;
    anchorRef.current = rect ? { index: best, fraction: clamp((fy - rect.top) / Math.max(rect.height, 1), 0, 1), viewY: fy - box.top } : null;
  }

  function zoomTo(next: number, focal?: { x: number; y: number }, sync = false) {
    if (next === columnsRef.current || !levels.includes(next)) return;
    captureAnchor(focal);
    columnsRef.current = next;
    if (sync) flushSync(() => setColumns(next)); else setColumns(next);
    onColumnsChange?.(next);
    announce(`${next} photos per row`);
  }

  function zoomStep(direction: 1 | -1, focal?: { x: number; y: number }) {
    const next = levels[levels.indexOf(columnsRef.current) + direction];
    if (next) zoomTo(next, focal);
  }

  // After the columns change, clear the live pinch and scroll so the anchor photo stays under the focal point.
  useLayoutEffect(() => {
    if (livePinch.get() !== 1) livePinch.jump(1);
    const anchor = anchorRef.current, scroller = scrollerRef.current, list = listRef.current;
    anchorRef.current = null;
    const tile = anchor && tileRefs.current[anchor.index];
    if (!anchor || !tile || !scroller || !list) return;
    const y = list.offsetTop + tile.offsetTop + anchor.fraction * tile.offsetHeight - anchor.viewY;
    scroller.scrollTop = clamp(y, 0, scroller.scrollHeight - scroller.clientHeight);
  }, [columns, livePinch]);

  function pinchLimits() {
    const cols = columnsRef.current, index = levels.indexOf(cols);
    const inward = levels[index + 1], outward = levels[index - 1], size = tileSize(cols) || 1;
    return { inward, outward, lnIn: inward ? Math.log(tileSize(inward) / size) : 0, lnOut: outward ? Math.log(tileSize(outward) / size) : 0 };
  }

  function pinchBegin(x: number, y: number) {
    const state = pinch.current, list = listRef.current;
    state.x = x; state.y = y;
    if (state.active || !list) return;
    const value = livePinch.get();
    livePinch.stop();
    if (value === 1) { const rect = list.getBoundingClientRect(); list.style.transformOrigin = `${x - rect.left}px ${y - rect.top}px`; }
    state.active = true; state.log = Math.log(value);
  }

  /** Follows the pinch with a live scale; crossing the next level commits it and the grid reflows from exactly where it is. */
  function pinchBy(delta: number) {
    const state = pinch.current;
    if (!state.active) return;
    state.log += delta;
    const { inward, outward, lnIn, lnOut } = pinchLimits();
    const commit = inward && state.log >= lnIn ? inward : outward && state.log <= lnOut ? outward : 0;
    if (commit) {
      state.log = 0;
      zoomTo(commit, { x: state.x, y: state.y }, true);
      const list = listRef.current, rect = list?.getBoundingClientRect();
      if (list && rect) list.style.transformOrigin = `${state.x - rect.left}px ${state.y - rect.top}px`;
      return;
    }
    let shown = state.log;
    if (shown > lnIn) shown = lnIn + rubber(shown - lnIn, .2);
    if (shown < lnOut) shown = lnOut - rubber(lnOut - shown, .2);
    livePinch.set(Math.exp(shown));
  }

  function pinchEnd() {
    const state = pinch.current;
    if (!state.active) return;
    state.active = false;
    const { inward, outward, lnIn, lnOut } = pinchLimits();
    const target = inward && state.log > lnIn * .35 ? inward : outward && state.log < lnOut * .35 ? outward : 0;
    state.log = 0;
    if (target) zoomTo(target, { x: state.x, y: state.y }, true);
    else if (reduced) livePinch.jump(1);
    else animate(livePinch, 1, spring.snappy);
  }

  function measureFlight(index: number): Flight | null {
    const tile = tileRefs.current[index], stageNode = stageRef.current, scroller = scrollerRef.current, photo = photos[index];
    if (!tile || !stageNode || !scroller || !photo) return null;
    const s = stageNode.getBoundingClientRect(), c = tile.getBoundingClientRect(), port = scroller.getBoundingClientRect();
    const box = fit(photo, s.width, s.height);
    const k = Math.max(c.width / box.w, c.height / box.h) || 1;
    const insetX = (box.w - c.width / k) / 2, insetY = (box.h - c.height / k) / 2;
    return {
      dx: c.left + c.width / 2 - (s.left + box.x + box.w / 2), dy: c.top + c.height / 2 - (s.top + box.y + box.h / 2), k,
      t: insetY + Math.max(0, port.top - c.top) / k, b: insetY + Math.max(0, c.bottom - port.bottom) / k,
      l: insetX + Math.max(0, port.left - c.left) / k, r: insetX + Math.max(0, c.right - port.right) / k,
    };
  }

  /** Scrolls the grid under the opaque viewer so the photo in view always has a visible cell to return to. */
  function revealTile(index: number) {
    const tile = tileRefs.current[index], scroller = scrollerRef.current, list = listRef.current;
    if (!tile || !scroller || !list) return;
    const top = list.offsetTop + tile.offsetTop, bottom = top + tile.offsetHeight, header = headerHeight();
    if (top < scroller.scrollTop + header) scroller.scrollTop = top - header;
    else if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight;
  }

  function openPhoto(index: number) {
    const now = phaseRef.current;
    if (now === "open" || !photos[index]) return;
    if (now === "closing" && index === currentValue.get()) {
      // Caught on its way back: the same photo turns around from wherever it is.
      setPhaseNow("open"); onViewerChange?.(photos[index].id);
      if (reduced) { animate(veil, 1, fade); return; }
      animate(progress, 1, spring.morph); animate(dragX, 0, spring.morph); animate(dragY, 0, spring.morph);
      animate(chrome, 1, { duration: duration.standard, ease: [...ease.enter] });
      return;
    }
    const geometry = measureFlight(index);
    if (!geometry) return;
    flight.set(geometry); grab.set({ x: 0, y: 0 });
    dragX.jump(0); dragY.jump(0); currentValue.jump(index); position.jump(index); page.jump(index);
    progress.jump(reduced ? 1 : 0); chrome.jump(reduced ? 1 : 0); veil.jump(reduced ? 0 : 1);
    updateRange(index);
    setCurrent(index); setPhaseNow("open");
    onViewerChange?.(photos[index].id);
    announce(`${photos[index].title}, ${index + 1} of ${count}`);
    if (reduced) { animate(veil, 1, fade); return; }
    animate(progress, 1, spring.morph);
    animate(chrome, 1, { duration: duration.standard, delay: .1, ease: [...ease.enter] });
  }

  function finishClose() {
    if (phaseRef.current !== "closing") return;
    setPhaseNow("closed");
    setFocusIndex(currentValue.get());
  }

  function closeViewer(velocity = { x: 0, y: 0 }) {
    if (phaseRef.current !== "open") return;
    const index = Math.round(currentValue.get());
    if (backdrop.get() > .95) revealTile(index);
    const geometry = measureFlight(index);
    if (geometry) flight.set(geometry);
    restoreFocus.current = Boolean(frameRef.current?.contains(document.activeElement));
    setPhaseNow("closing");
    onViewerChange?.(null);
    if (reduced) { animate(veil, 0, { ...fade, onComplete: finishClose }); return; }
    animate(chrome, 0, { duration: duration.instant, ease: [...ease.standard] });
    animate(dragX, 0, { ...closeSpring, velocity: velocity.x });
    animate(dragY, 0, { ...closeSpring, velocity: velocity.y });
    animate(position, index, closeSpring); animate(page, index, closeSpring);
    animate(progress, 0, { ...closeSpring, onComplete: finishClose });
  }

  function goTo(index: number, velocity?: number) {
    const target = clamp(index, 0, last);
    if (target !== currentValue.get()) {
      currentValue.set(target); setCurrent(target);
      announce(`${photos[target].title}, ${target + 1} of ${count}`);
    }
    if (reduced) { position.jump(target); page.jump(target); return; }
    animate(position, target, { ...spring.smooth, velocity: velocity ?? position.getVelocity() });
    animate(page, target, { ...spring.smooth, velocity: velocity ?? page.getVelocity() });
  }

  function toggleFavorite() {
    const photo = photos[current];
    if (!photo) return;
    const next = !favorites.has(photo.id);
    setFavorites(prev => { const set = new Set(prev); if (next) set.add(photo.id); else set.delete(photo.id); return set; });
    onFavoriteChange?.(photo.id, next);
    announce(next ? `Added ${photo.title} to favorites` : `Removed ${photo.title} from favorites`);
  }

  // Focus moves into the viewer when it opens and back to the photo's cell once it has landed.
  useEffect(() => {
    if (phase === "open") backRef.current?.focus({ preventScroll: true });
    if (phase === "closed" && restoreFocus.current) {
      restoreFocus.current = false;
      tileRefs.current[currentValue.get()]?.focus({ preventScroll: true });
    }
  }, [phase, currentValue]);

  useEffect(() => { if (phase === "open" && backdrop.get() > .95) revealTile(current); });

  // Native listeners: pinch needs non-passive wheel and touch events, and Safari reports trackpad pinches as gestures.
  const latest = useRef({ pinchBegin, pinchBy, pinchEnd, zoomStep, goTo });
  useLayoutEffect(() => { latest.current = { pinchBegin, pinchBy, pinchEnd, zoomStep, goTo }; });
  useEffect(() => {
    const frame = frameRef.current, scroller = scrollerRef.current;
    if (!frame || !scroller) return;
    const state = pinch.current;
    const settleLater = () => { clearTimeout(state.timer); state.timer = setTimeout(() => latest.current.pinchEnd(), 160); };
    const onWheel = (event: WheelEvent) => {
      if (phaseRef.current !== "closed") {
        if (event.ctrlKey) { event.preventDefault(); return; }
        if (phaseRef.current !== "open" || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
        event.preventDefault();
        // A two finger swipe pages once; its momentum tail is swallowed until the wheel goes quiet.
        const now = performance.now();
        if (now - state.wheelAt > 180) { state.wheelX = 0; state.wheelLock = false; }
        state.wheelAt = now; state.wheelX += event.deltaX;
        if (!state.wheelLock && Math.abs(state.wheelX) > 36) {
          state.wheelLock = true;
          latest.current.goTo(Math.round(currentValue.get()) + (state.wheelX > 0 ? 1 : -1));
        }
        return;
      }
      if (!event.ctrlKey || state.gesture) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? 400 : 1, delta = -event.deltaY * unit;
      // A mouse wheel notch steps one level; a trackpad pinch streams small deltas and is followed live.
      if (!state.active && Math.abs(delta) >= 40) { latest.current.zoomStep(delta > 0 ? 1 : -1, { x: event.clientX, y: event.clientY }); return; }
      latest.current.pinchBegin(event.clientX, event.clientY);
      latest.current.pinchBy(clamp(delta * .012, -.4, .4));
      settleLater();
    };
    let touchDistance = 0;
    const distance = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2 || phaseRef.current !== "closed") return;
      touchDistance = distance(event.touches);
      latest.current.pinchBegin((event.touches[0].clientX + event.touches[1].clientX) / 2, (event.touches[0].clientY + event.touches[1].clientY) / 2);
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!touchDistance || event.touches.length !== 2) return;
      event.preventDefault();
      const next = distance(event.touches);
      latest.current.pinchBy(Math.log(next / touchDistance));
      touchDistance = next;
    };
    const onTouchEnd = (event: TouchEvent) => { if (touchDistance && event.touches.length < 2) { touchDistance = 0; latest.current.pinchEnd(); } };
    type Gesture = Event & { scale: number; clientX: number; clientY: number };
    let lastScale = 1;
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      if (phaseRef.current !== "closed") return;
      const gesture = event as Gesture;
      state.gesture = true; lastScale = 1;
      latest.current.pinchBegin(gesture.clientX, gesture.clientY);
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      if (!state.gesture) return;
      const gesture = event as Gesture;
      latest.current.pinchBy(Math.log(gesture.scale / lastScale));
      lastScale = gesture.scale;
    };
    const onGestureEnd = (event: Event) => { event.preventDefault(); if (state.gesture) { state.gesture = false; latest.current.pinchEnd(); } };
    frame.addEventListener("wheel", onWheel, { passive: false });
    scroller.addEventListener("touchstart", onTouchStart, { passive: true });
    scroller.addEventListener("touchmove", onTouchMove, { passive: false });
    scroller.addEventListener("touchend", onTouchEnd);
    scroller.addEventListener("touchcancel", onTouchEnd);
    frame.addEventListener("gesturestart", onGestureStart);
    frame.addEventListener("gesturechange", onGestureChange);
    frame.addEventListener("gestureend", onGestureEnd);
    return () => {
      clearTimeout(state.timer);
      frame.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("touchstart", onTouchStart);
      scroller.removeEventListener("touchmove", onTouchMove);
      scroller.removeEventListener("touchend", onTouchEnd);
      scroller.removeEventListener("touchcancel", onTouchEnd);
      frame.removeEventListener("gesturestart", onGestureStart);
      frame.removeEventListener("gesturechange", onGestureChange);
      frame.removeEventListener("gestureend", onGestureEnd);
    };
  }, [currentValue]);

  function onGridKeyDown(event: ReactKeyboardEvent) {
    const tile = tileRefs.current[focusIndex], rect = tile?.getBoundingClientRect();
    const focal = rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : undefined;
    if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomStep(1, focal); return; }
    if (event.key === "-" || event.key === "_") { event.preventDefault(); zoomStep(-1, focal); return; }
    const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns, Home: -Infinity, End: Infinity, PageDown: columns * 3, PageUp: -columns * 3 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    const next = clamp(focusIndex + moves[event.key], 0, last);
    setFocusIndex(next);
    tileRefs.current[next]?.focus();
  }

  function onViewerKeyDown(event: ReactKeyboardEvent) {
    if (phaseRef.current !== "open") return;
    const cur = Math.round(currentValue.get());
    const targets: Record<string, number> = { ArrowRight: cur + 1, ArrowLeft: cur - 1, Home: 0, End: last };
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeViewer(); return; }
    if (!(event.key in targets)) return;
    event.preventDefault();
    goTo(targets[event.key]);
  }

  function onStagePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (phaseRef.current !== "open" || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    position.stop(); page.stop(); dragX.stop(); dragY.stop();
    drag.current = { id: event.pointerId, x0: event.clientX, y0: event.clientY, pos0: page.get(), dx0: dragX.get(), dy0: dragY.get(), axis: null, samples: [{ t: event.timeStamp, x: event.clientX, y: event.clientY }] };
  }

  function onStagePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state || state.id !== event.pointerId) return;
    state.samples.push({ t: event.timeStamp, x: event.clientX, y: event.clientY });
    if (state.samples.length > 24) state.samples.shift();
    const dx = event.clientX - state.x0, dy = event.clientY - state.y0;
    if (!state.axis) {
      if (Math.hypot(dx, dy) < 6) return;
      // A settled page with a sideways pull pages; anything else picks the photo up.
      state.axis = Math.abs(dx) > Math.abs(dy) && Math.abs(state.dy0) < 1 ? "x" : "y";
      if (state.axis === "y" && Math.abs(dragY.get()) < 1) {
        const node = stageRef.current, photo = photos[Math.round(currentValue.get())];
        if (node && photo) { const s = node.getBoundingClientRect(), box = fit(photo, s.width, s.height); grab.set({ x: state.x0 - (s.left + box.x + box.w / 2), y: state.y0 - (s.top + box.y + box.h / 2) }); }
      }
    }
    if (state.axis === "x") { const next = rubberIndex(state.pos0 - dx / pageWidth.get(), last, pageWidth.get()); page.set(next); position.set(next); }
    else {
      const y = state.dy0 + dy;
      dragX.set(state.dx0 + dx);
      dragY.set(y < 0 ? -rubber(-y, stageHeight.get()) : y);
    }
  }

  function onStagePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state || state.id !== event.pointerId) return;
    drag.current = null;
    const velocity = event.type === "pointercancel" ? { x: 0, y: 0 } : velocityOf(state.samples, event.timeStamp);
    if (state.axis === "x") {
      // A flick pages in its direction; a slow drag settles on whichever page is mostly in view.
      const from = Math.round(state.pos0), perSecond = -velocity.x / pageWidth.get(), now = page.get();
      const flick = Math.abs(velocity.x) > 240 && Math.sign(perSecond) === Math.sign(now - from);
      goTo(clamp(flick ? from + Math.sign(perSecond) : Math.round(now), from - 1, from + 1), perSecond);
      return;
    }
    if (!state.axis) {
      // A tap that caught a moving page or photo lets it finish settling.
      if (Math.abs(page.get() - currentValue.get()) > .001) goTo(currentValue.get());
      if (dragX.get() || dragY.get()) { animate(dragX, 0, reduced ? { duration: 0 } : spring.snappy); animate(dragY, 0, reduced ? { duration: 0 } : spring.snappy); }
      return;
    }
    const dy = dragY.get(), projected = dy + velocity.y * .18;
    if (projected > Math.min(140, stageHeight.get() * .22) && velocity.y > -240) { closeViewer(velocity); return; }
    const back = reduced ? { duration: 0 } : spring.snappy;
    animate(dragX, 0, { ...back, velocity: velocity.x });
    animate(dragY, 0, { ...back, velocity: velocity.y });
  }

  function onStripPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (phaseRef.current !== "open" || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    position.stop();
    scrub.current = { id: event.pointerId, x0: event.clientX, pos0: position.get(), moved: false, samples: [{ t: event.timeStamp, x: event.clientX, y: 0 }] };
  }

  function onStripPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = scrub.current;
    if (!state || state.id !== event.pointerId) return;
    state.samples.push({ t: event.timeStamp, x: event.clientX, y: 0 });
    if (state.samples.length > 24) state.samples.shift();
    const dx = event.clientX - state.x0;
    if (!state.moved && Math.abs(dx) < 4) return;
    state.moved = true;
    const raw = state.pos0 - dx / THUMB_STEP;
    position.set(rubberIndex(raw, last, THUMB_STEP));
    // Scrubbing names each photo as it passes under the thumb.
    const near = clamp(Math.round(raw), 0, last);
    if (near !== currentValue.get()) {
      currentValue.set(near); setCurrent(near);
      if (reduced) page.jump(near); else animate(page, near, spring.snappy);
    }
  }

  function onStripPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const state = scrub.current;
    if (!state || state.id !== event.pointerId) return;
    scrub.current = null;
    if (!state.moved) {
      // A tap lands on whichever sliver is under it.
      const rect = event.currentTarget.getBoundingClientRect(), layout = strip.get(), x = event.clientX - rect.left;
      const hit = wides.findIndex((wide, index) => x >= layout.x[index] + layout.c[index] - 1 && x <= layout.x[index] + wide - layout.c[index] + 1);
      goTo(hit >= 0 ? hit : Math.round(position.get()));
      return;
    }
    const perSecond = event.type === "pointercancel" ? 0 : -velocityOf(state.samples, event.timeStamp).x / THUMB_STEP;
    const target = clamp(Math.round(position.get() + perSecond * .12), 0, last);
    if (target !== currentValue.get()) { currentValue.set(target); setCurrent(target); }
    if (reduced) { position.jump(target); page.jump(target); }
    else { animate(position, target, { ...spring.smooth, velocity: perSecond }); animate(page, target, spring.smooth); }
    announce(`${photos[target].title}, ${target + 1} of ${count}`);
  }

  const photo = photos[current] ?? photos[0];
  const favorite = photo ? favorites.has(photo.id) : false;
  const open = phase === "open";
  const layoutTransition = reduced ? { duration: 0 } : spring.smooth;
  const iconHidden: TargetAndTransition = reduced ? { opacity: 0 } : { opacity: 0, scale: .6, filter: `blur(${blur.subtle}px)` };

  return <div ref={frameRef} className={cx(styles.root, className)} data-phase={phase}>
    <header ref={headerRef} className={styles.header} data-scrolled={scrolled || undefined} inert={open}>
      <div className={styles.heading}>
        <p className={styles.title}>{title}</p>
        <p className={styles.subtitle}>
          <span>{count} photos</span>
          <span className={styles.favoriteCount} aria-label={`${favorites.size} favorites`}><Heart size={12} strokeWidth={2} fill="currentColor" aria-hidden="true" /><MorphWidth reduced={reduced}><Roll value={favorites.size} reduced={reduced} /></MorphWidth></span>
        </p>
      </div>
      <LayoutGroup id={id}>
        <div className={styles.zoom} role="group" aria-label="Zoom">
          {levels.map(level => <button key={level} type="button" className={styles.zoomButton} aria-pressed={level === columns} aria-label={`${level} photos per row`} title={`${level} per row`} onClick={() => zoomTo(level)}>
            {level === columns && <motion.span className={styles.zoomSelection} layoutId="zoom-selection" layoutDependency={columns} transition={reduced ? { duration: 0 } : spring.morph} aria-hidden="true" />}
            <ZoomGlyph columns={level} />
          </button>)}
        </div>
      </LayoutGroup>
    </header>

    <div ref={scrollerRef} className={styles.scroller} inert={open} onScroll={event => { const next = event.currentTarget.scrollTop > 2; if (next !== scrolled) setScrolled(next); }}>
      <ul ref={listRef} className={styles.grid} style={{ "--columns": columns } as CSSProperties} aria-label={`${title}, ${count} photos`} onKeyDown={onGridKeyDown}>
        {photos.map((item, index) => <li key={item.id} className={styles.cell}>
          <motion.button ref={node => { tileRefs.current[index] = node; }} type="button" className={styles.tile} layout layoutDependency={columns} transition={{ layout: layoutTransition }} style={{ borderRadius: TILE_RADIUS }}
            data-hidden={phase !== "closed" && index === current ? "" : undefined} tabIndex={index === focusIndex ? 0 : -1}
            aria-label={favorites.has(item.id) ? `${item.alt}, favorite` : item.alt} onFocus={() => setFocusIndex(index)} onClick={() => openPhoto(index)}>
            {/* eslint-disable-next-line @next/next/no-img-element -- registry components stay framework agnostic */}
            <img src={item.src} srcSet={item.srcSet} sizes={GRID_SIZES} alt="" width={item.width} height={item.height} draggable={false} decoding="async" />
            <AnimatePresence initial={false}>{favorites.has(item.id) && <motion.span key="favorite" className={styles.badge} initial={iconHidden} animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }} exit={iconHidden} transition={reduced ? fade : spring.snappy}><Heart size={14} strokeWidth={2} fill="currentColor" aria-hidden="true" /></motion.span>}</AnimatePresence>
          </motion.button>
        </li>)}
      </ul>
    </div>

    <motion.div className={styles.viewer} data-state={phase} role="dialog" aria-label="Photo viewer" aria-hidden={phase === "closed" || undefined} tabIndex={-1} style={{ opacity: veil }} onKeyDown={onViewerKeyDown}>
      <motion.div className={styles.frost} style={{ opacity: frost }} />
      <motion.div className={styles.backdrop} style={{ opacity: backdrop }} />
      <div ref={stageRef} className={styles.stage} onPointerDown={onStagePointerDown} onPointerMove={onStagePointerMove} onPointerUp={onStagePointerUp} onPointerCancel={onStagePointerUp}>
        <motion.div className={styles.track} style={{ x: trackX }}>
          {phase !== "closed" && photos.slice(range[0], range[1] + 1).map((item, offset) => {
            const index = range[0] + offset, box = fit(item, stage.w, stage.h), isCurrent = index === current;
            return <div key={item.id} className={styles.slide} style={{ left: `calc(${index} * (100% + ${PAGE_GAP}px))` }} aria-hidden={!isCurrent || undefined}>
              <motion.div className={styles.photo} style={{ left: box.x, top: box.y, width: box.w, height: box.h, ...(isCurrent ? { x: photoX, y: photoY, scale: photoScale, clipPath: photoClip } : { x: 0, y: 0, scale: 1, clipPath: `inset(0px round ${VIEW_RADIUS}px)` }) }}>
                {/* eslint-disable-next-line @next/next/no-img-element -- registry components stay framework agnostic */}
                <img className={styles.base} src={item.src} srcSet={item.srcSet} sizes={GRID_SIZES} alt={isCurrent ? item.alt : ""} draggable={false} decoding="sync" />
                <SharpLayer photo={item} />
              </motion.div>
            </div>;
          })}
        </motion.div>
      </div>

      {/* Back is an arrow, so it never reads as the previous photo chevron beside the stage. */}
      <motion.div className={styles.bar} style={{ opacity: chromeOpacity, y: barY }}>
        <button ref={backRef} type="button" className={styles.glass} aria-label="Back to all photos" onClick={() => closeViewer()}><ArrowLeft size={20} strokeWidth={1.75} aria-hidden="true" /></button>
        {photo && <div className={styles.caption}>
          <span className={styles.captionTitle}><SwapText text={photo.title} reduced={reduced} /></span>
          <span className={styles.captionMeta}>
            {photo.detail && <MorphWidth reduced={reduced}><SwapText text={photo.detail} reduced={reduced} /></MorphWidth>}
            <span className={styles.counterPart}>{photo.detail && <span aria-hidden="true">·</span>}<span className={styles.counter}><MorphWidth reduced={reduced}><Roll value={current + 1} reduced={reduced} /></MorphWidth> of {count}</span></span>
          </span>
        </div>}
        <button type="button" className={cx(styles.glass, styles.favorite)} aria-pressed={favorite} aria-label="Favorite" onClick={toggleFavorite}>
          <AnimatePresence initial={false}>
            <motion.span key={favorite ? "on" : "off"} className={styles.icon} initial={iconHidden} animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }} exit={{ ...iconHidden, transition: reduced ? fade : { duration: duration.fast } }} transition={reduced ? fade : { ...spring.snappy, opacity: { duration: duration.fast }, filter: { duration: duration.fast } }}>
              <Heart size={20} strokeWidth={1.75} fill={favorite ? "currentColor" : "none"} aria-hidden="true" />
            </motion.span>
          </AnimatePresence>
        </button>
      </motion.div>

      <motion.div className={styles.navs} style={{ opacity: chromeOpacity }}>
        <button type="button" className={cx(styles.glass, styles.nav)} aria-label="Previous photo" disabled={current === 0} onClick={() => goTo(current - 1)}><ChevronLeft size={20} strokeWidth={1.75} aria-hidden="true" /></button>
        <button type="button" className={cx(styles.glass, styles.nav)} aria-label="Next photo" disabled={current === last} onClick={() => goTo(current + 1)}><ChevronRight size={20} strokeWidth={1.75} aria-hidden="true" /></button>
      </motion.div>

      <motion.div ref={stripRef} className={styles.strip} style={{ opacity: chromeOpacity, y: stripY }} role="slider" tabIndex={open ? 0 : -1} aria-label="Photos" aria-orientation="horizontal"
        aria-valuemin={1} aria-valuemax={count} aria-valuenow={current + 1} aria-valuetext={photo ? `${photo.title}, ${current + 1} of ${count}` : undefined}
        onPointerDown={onStripPointerDown} onPointerMove={onStripPointerMove} onPointerUp={onStripPointerUp} onPointerCancel={onStripPointerUp}>
        {phase !== "closed" && photos.map((item, index) => <Thumb key={item.id} photo={item} index={index} wide={wides[index]} geometry={strip} />)}
      </motion.div>
    </motion.div>

    <p className={styles.srOnly} role="status" aria-live="polite">{status}</p>
  </div>;
}

export default PhotoGrid;
