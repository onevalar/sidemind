"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, Ref } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, animate, motion, useMotionValue, useMotionValueEvent, useReducedMotion, useTransform } from "motion/react";
import type { MotionValue, Transition } from "motion/react";
import { ChevronLeft, ChevronRight, X, ZoomIn, ZoomOut } from "lucide-react";
import { ArcImage } from "../lib/arc-provider";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./lightbox-gallery.module.css";

export interface LightboxImage {
  src: string;
  /** Intrinsic size in px. The grid, the zoom, and the return flight all keep this aspect ratio. */
  width: number;
  height: number;
  alt: string;
  /** First caption line, such as a place or a title. */
  title?: string;
  /** Second caption line, such as a date or a credit. */
  caption?: string;
}

/**
 * A masonry grid of photos that open in a fullscreen viewer. The tapped photo zooms out of its own grid slot, and flies back to
 * that slot when the viewer closes, whichever photo is showing by then.
 * In the viewer: drag or flick down to dismiss, swipe (or two-finger swipe on a trackpad) and the arrow keys move between photos,
 * and pinch, Ctrl + scroll, double click, or + and − zoom around the pointer. A zoomed photo pans with momentum and rubber-bands at
 * its edges; pinching it smaller than the screen lets it go back to the grid.
 */
export interface LightboxGalleryProps {
  images: LightboxImage[];
  /** Columns are added while each stays at least this wide, in px. Defaults to 150; there are always at least two. */
  minColumnWidth?: number;
  /** Gap between photos in px. Defaults to 8. */
  gap?: number;
  /** Accessible name of the gallery and its viewer. Defaults to "Photo gallery". */
  label?: string;
  className?: string;
}

const { spring, duration, ease } = motionTokens;
const enterEase = [...ease.enter] as [number, number, number, number];
const standardEase = [...ease.standard] as [number, number, number, number];
/** Spring tokens restated as stiffness and damping, so a retarget keeps its velocity instead of restarting from rest. */
const physical = ({ visualDuration, bounce }: { visualDuration: number; bounce: number }): Transition => {
  const root = 2 * Math.PI / (visualDuration * 1.2);
  return { type: "spring", stiffness: root * root, damping: 2 * (1 - bounce) * root, mass: 1 };
};
/** Opening lifts with a hint of life; the return settles into the slot without overshooting its neighbors. */
const openSpring = physical({ visualDuration: .44, bounce: .12 });
const closeSpring = physical({ visualDuration: .4, bounce: .06 });
const slideSpring = physical(spring.smooth);
const settle = physical(spring.snappy);

/** Visual corner radius in px. It is held constant while the photo scales, so corners never balloon or vanish mid-flight. */
const RADIUS = 12;
const MAX_ZOOM = 4;
/** Pinching a resting photo below this scale lets go of it, and it flies back to its slot. */
const PINCH_CLOSE = .86;
/** Horizontal trackpad travel, in px, that turns the page when the photo is not zoomed. */
const WHEEL_PAGE = 70;
/** Grid thumbnails and the viewer's placeholder ask for the same file, so the flight starts from pixels already on screen. */
const THUMB_SIZES = "(min-width: 900px) 260px, (min-width: 600px) 34vw, 50vw";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
/** Where a flick would come to rest on the scroll deceleration curve. */
const project = (velocity: number, rate = .995) => velocity / 1000 * rate / (1 - rate);
/** Progressive resistance past an edge: the further you pull, the less it follows. */
const rubber = (overshoot: number, dimension: number, constant = .55) => overshoot * dimension * constant / (dimension + constant * Math.abs(overshoot));

/** Wheel deltas in px whatever unit the device reports (Firefox mouse wheels count lines). */
const wheelPx = (delta: number, mode: number, page: number) => mode === 1 ? delta * 16 : mode === 2 ? delta * page : delta;

type Viewport = { w: number; h: number };
type Rect = { left: number; top: number; width: number; height: number };

/** Chrome heights and side padding for a viewport. The stage is what is left between the top bar and the caption area. */
function chromeOf(vp: Viewport) {
  const compact = vp.w < 640;
  const top = compact ? 56 : 64, bottom = compact ? 128 : 140, pad = compact ? 12 : 72;
  return { top, bottom, pad, stage: Math.max(120, vp.h - top - bottom) };
}
/** Where a photo rests in the viewer: as large as fits the stage, centered, never cropped. */
function fit(image: LightboxImage, vp: Viewport): Rect {
  const c = chromeOf(vp);
  const k = Math.min((vp.w - c.pad * 2) / image.width, (c.stage - 16) / image.height);
  const width = image.width * k, height = image.height * k;
  return { width, height, left: (vp.w - width) / 2, top: c.top + (c.stage - height) / 2 };
}
/** Pan limits at a zoom level: an edge can travel to the viewport edge, never further. A photo smaller than the viewport stays centered. */
function panBounds(frame: Rect, zoom: number, vp: Viewport) {
  const hw = frame.width * zoom / 2, hh = frame.height * zoom / 2;
  const cx = frame.left + frame.width / 2, cy = frame.top + frame.height / 2;
  const x = [vp.w - cx - hw, hw - cx], y = [vp.h - cy - hh, hh - cy];
  return { minX: x[0] > x[1] ? 0 : x[0], maxX: x[0] > x[1] ? 0 : x[1], minY: y[0] > y[1] ? 0 : y[0], maxY: y[0] > y[1] ? 0 : y[1] };
}

type Sample = { x: number; y: number; t: number };
/** Release velocity in px/s from the last 80ms of movement. A pointer that paused before letting go has no velocity. */
function velocityOf(history: Sample[]) {
  const last = history[history.length - 1];
  if (!last || performance.now() - last.t > 60) return { x: 0, y: 0 };
  let first = last;
  for (let i = history.length - 1; i >= 0 && last.t - history[i].t <= 80; i--) first = history[i];
  const dt = (last.t - first.t) / 1000;
  return dt > 0 ? { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt } : { x: 0, y: 0 };
}

/** Places each photo in the currently shortest column, so columns end close to the same height while reading order stays row by row. */
function distribute(images: LightboxImage[], count: number) {
  const columns = Array.from({ length: count }, () => ({ height: 0, items: [] as number[] }));
  images.forEach((image, index) => {
    const column = columns.reduce((best, next) => next.height < best.height - .01 ? next : best, columns[0]);
    column.items.push(index);
    column.height += image.height / image.width;
  });
  return columns.map(column => column.items);
}

export function LightboxGallery({ images, minColumnWidth = 150, gap = 8, label = "Photo gallery", className }: LightboxGalleryProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const thumbs = useRef<(HTMLButtonElement | null)[]>([]);
  const [count, setCount] = useState(3);
  const [viewer, setViewer] = useState<{ start: number; from: Rect | null } | null>(null);
  const [shown, setShown] = useState(0);

  // Columns follow the gallery's own width, measured before paint so the grid never reflows in view.
  useLayoutEffect(() => {
    const node = rootRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      setCount(Math.max(2, Math.floor((width + gap) / (minColumnWidth + gap))));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [gap, minColumnWidth]);

  const columns = useMemo(() => distribute(images, count), [images, count]);

  const openAt = (index: number) => {
    const rect = thumbs.current[index]?.getBoundingClientRect();
    setShown(index);
    setViewer({ start: index, from: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null });
  };
  const getThumb = useCallback((index: number) => thumbs.current[index] ?? null, []);
  const onClosed = useCallback((index: number) => {
    setViewer(null);
    thumbs.current[index]?.focus({ preventScroll: true });
  }, []);

  return <div ref={rootRef} className={className ? `${styles.root} ${className}` : styles.root} role="region" aria-label={label}>
    <div className={styles.grid} style={{ gap }}>
      {columns.map((column, c) => <div key={c} className={styles.column} style={{ gap }}>
        {column.map(index => {
          const image = images[index];
          return <button key={image.src} ref={node => { thumbs.current[index] = node; }} type="button" className={styles.thumb}
            data-hidden={viewer && shown === index ? "" : undefined} style={{ aspectRatio: `${image.width} / ${image.height}` }}
            aria-label={`Open ${image.title ?? image.alt}, photo ${index + 1} of ${images.length}`} onClick={() => openAt(index)}>
            <ArcImage src={image.src} alt="" width={image.width} height={image.height} sizes={THUMB_SIZES} draggable={false} className={styles.thumbImage} />
          </button>;
        })}
      </div>)}
    </div>
    {viewer && <Viewer images={images} start={viewer.start} from={viewer.from} label={label} getThumb={getThumb} onIndexChange={setShown} onClosed={onClosed} />}
  </div>;
}

type Gesture =
  | { mode: "idle" }
  | { mode: "pending" | "swipe" | "dismiss" | "pan"; id: number; x: number; y: number; baseStrip: number; basePanX: number; basePanY: number; grabX: number; grabY: number; onImage: boolean; history: Sample[] }
  | { mode: "pinch"; distance: number; zoom: number; midX: number; midY: number; panX: number; panY: number };

type ViewerProps = {
  images: LightboxImage[];
  start: number;
  from: Rect | null;
  label: string;
  getThumb: (index: number) => HTMLElement | null;
  onIndexChange: (index: number) => void;
  onClosed: (index: number) => void;
};

function Viewer({ images, start, from, label, getThumb, onIndexChange, onClosed }: ViewerProps) {
  const reduced = !!useReducedMotion();
  const titleId = useId();
  const [vp, setVp] = useState<Viewport>(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const [index, setIndexState] = useState(start);
  const [zoomed, setZoomed] = useState(false);
  const [closing, setClosing] = useState(false);
  const indexRef = useRef(start), vpRef = useRef(vp), closingRef = useRef(false);
  const overlayRef = useRef<HTMLDivElement>(null), closeRef = useRef<HTMLButtonElement>(null), imageRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture>({ mode: "idle" });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const lastTap = useRef<Sample | null>(null);

  const stripX = useMotionValue(-start * vp.w);
  const heroX = useMotionValue(0), heroY = useMotionValue(0), heroS = useMotionValue(1), heroO = useMotionValue(1);
  const zoomS = useMotionValue(1), panX = useMotionValue(0), panY = useMotionValue(0);
  const veil = useMotionValue(0);
  const chrome = useTransform(veil, [.6, 1], [0, 1]);
  const radius = useTransform(() => `${RADIUS / Math.max(.05, heroS.get() * zoomS.get())}px`);
  useMotionValueEvent(zoomS, "change", z => setZoomed(z > 1.01));

  const frameOf = useCallback((i: number) => fit(images[i], vpRef.current), [images]);

  // Open: the photo starts exactly on its grid slot and springs to its place on the stage while the page fades behind it.
  useLayoutEffect(() => {
    const frame = fit(images[start], vpRef.current);
    if (reduced || !from) {
      heroO.jump(0);
      animate(heroO, 1, { duration: duration.standard, ease: enterEase });
    } else {
      heroX.jump(from.left - frame.left);
      heroY.jump(from.top - frame.top);
      heroS.jump(from.width / frame.width);
      animate(heroX, 0, openSpring);
      animate(heroY, 0, openSpring);
      animate(heroS, 1, openSpring);
    }
    animate(veil, 1, { duration: reduced ? duration.standard : .34, ease: enterEase });
    closeRef.current?.focus({ preventScroll: true });
    // Mount only: the open flight runs once from the rect the grid measured.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lock page scroll while the viewer is open. The scrollbar's width is kept as padding, so nothing in the grid shifts and the return flight lands true.
  useEffect(() => {
    const root = document.documentElement;
    const gutter = window.innerWidth - root.clientWidth;
    const previous = { overflow: root.style.overflow, paddingRight: root.style.paddingRight };
    root.style.overflow = "hidden";
    if (gutter > 0) root.style.paddingRight = `${gutter}px`;
    const onResize = () => {
      const next = { w: window.innerWidth, h: window.innerHeight };
      vpRef.current = next;
      stripX.jump(-indexRef.current * next.w);
      zoomS.jump(1); panX.jump(0); panY.jump(0);
      setVp(next);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      root.style.overflow = previous.overflow;
      root.style.paddingRight = previous.paddingRight;
    };
  }, [stripX, zoomS, panX, panY]);

  /** Halts any zoom or pan in flight so a new gesture continues from exactly what is on screen. */
  const stopZoom = useCallback(() => { zoomS.stop(); panX.stop(); panY.stop(); }, [zoomS, panX, panY]);

  /** Coasts a released pan with the finger's velocity, decelerating like a scroll view and rubber-banding off the edges. */
  const coast = useCallback((velocity: { x: number; y: number }) => {
    const bounds = panBounds(frameOf(indexRef.current), zoomS.get(), vpRef.current);
    if (reduced) {
      animate(panX, clamp(panX.get(), bounds.minX, bounds.maxX), { duration: duration.fast, ease: standardEase });
      animate(panY, clamp(panY.get(), bounds.minY, bounds.maxY), { duration: duration.fast, ease: standardEase });
      return;
    }
    const glide = { type: "inertia", power: .7, timeConstant: 300, bounceStiffness: 320, bounceDamping: 36, restDelta: .5 } as const;
    animate(panX, panX.get(), { ...glide, velocity: velocity.x, min: bounds.minX, max: bounds.maxX });
    animate(panY, panY.get(), { ...glide, velocity: velocity.y, min: bounds.minY, max: bounds.maxY });
  }, [frameOf, panX, panY, reduced, zoomS]);

  const resetZoom = useCallback((smooth: boolean) => {
    if (!smooth || reduced) { zoomS.jump(1); panX.jump(0); panY.jump(0); return; }
    animate(zoomS, 1, settle); animate(panX, 0, settle); animate(panY, 0, settle);
  }, [reduced, zoomS, panX, panY]);

  const goTo = useCallback((target: number, velocity = 0) => {
    if (closingRef.current) return;
    const w = vpRef.current.w;
    const previous = indexRef.current;
    const next = clamp(target, 0, images.length - 1);
    if (next !== previous) {
      resetZoom(false);
      // A long jump from the thumbnail strip starts one photo away, so the slide never passes through unrendered photos.
      if (Math.abs(next - previous) > 1) stripX.jump(-(next - Math.sign(next - previous)) * w + (stripX.get() + previous * w));
      indexRef.current = next;
      setIndexState(next);
      onIndexChange(next);
    }
    if (reduced) stripX.jump(-next * w);
    else animate(stripX, -next * w, { ...slideSpring, velocity });
  }, [images.length, onIndexChange, reduced, resetZoom, stripX]);

  const close = useCallback((release?: { x: number; y: number }) => {
    if (closingRef.current) return;
    // Closing mid-flight (Escape during the open, or a pinch that let go) keeps the photo's live momentum.
    const velocity = release ?? { x: heroX.getVelocity(), y: heroY.getVelocity() };
    closingRef.current = true;
    setClosing(true);
    const i = indexRef.current, current = vpRef.current;
    const frame = fit(images[i], current);
    const thumb = getThumb(i);
    // The slot may have scrolled away behind the viewer; bring it back so the photo has somewhere to land.
    thumb?.scrollIntoView({ block: "nearest", inline: "nearest" });
    const slot = thumb?.getBoundingClientRect();
    const visible = !!slot && slot.width > 0 && slot.bottom > 0 && slot.top < current.h && slot.right > 0 && slot.left < current.w;
    const finish = () => onClosed(i);
    animate(veil, 0, { duration: reduced ? duration.standard : .3, ease: standardEase });
    if (reduced || !visible || !slot) {
      resetZoom(false);
      stripX.jump(-i * current.w);
      animate(heroO, 0, { duration: duration.exit, ease: standardEase }).then(finish);
      return;
    }
    resetZoom(true);
    animate(stripX, -i * current.w, closeSpring);
    animate(heroX, slot.left - frame.left, { ...closeSpring, velocity: velocity.x });
    animate(heroY, slot.top - frame.top, { ...closeSpring, velocity: velocity.y });
    animate(heroS, slot.width / frame.width, { ...closeSpring, velocity: heroS.getVelocity() }).then(finish);
  }, [getThumb, heroO, heroS, heroX, heroY, images, onClosed, reduced, resetZoom, stripX, veil]);

  /** Zoom so the viewport point (px, py) stays under the pointer. `smooth` springs there; wheel and pinch track 1:1. */
  const zoomAround = useCallback((px: number, py: number, target: number, smooth: boolean) => {
    const frame = frameOf(indexRef.current), z0 = zoomS.get();
    const cx = frame.left + frame.width / 2, cy = frame.top + frame.height / 2;
    const z = clamp(target, 1, MAX_ZOOM);
    const bounds = panBounds(frame, z, vpRef.current);
    const nx = clamp(px - cx - (px - cx - panX.get()) * (z / z0), bounds.minX, bounds.maxX);
    const ny = clamp(py - cy - (py - cy - panY.get()) * (z / z0), bounds.minY, bounds.maxY);
    if (smooth && !reduced) { animate(zoomS, z, settle); animate(panX, nx, settle); animate(panY, ny, settle); }
    else { zoomS.jump(z); panX.jump(nx); panY.jump(ny); }
  }, [frameOf, panX, panY, reduced, zoomS]);

  const toggleZoom = useCallback((px?: number, py?: number) => {
    const frame = frameOf(indexRef.current);
    if (zoomS.get() > 1.01) { resetZoom(true); return; }
    // Zoom far enough that the photo fills the screen, and at least to 2x, so a second look always reveals detail.
    const vp = vpRef.current, fill = Math.max(vp.w / frame.width, vp.h / frame.height);
    zoomAround(px ?? frame.left + frame.width / 2, py ?? frame.top + frame.height / 2, clamp(fill, 2, MAX_ZOOM), true);
  }, [frameOf, resetZoom, zoomAround, zoomS]);

  // Trackpad pinch arrives as Ctrl + wheel; plain wheel pans a zoomed photo. Both need a non-passive listener to keep the page still.
  useEffect(() => {
    const node = overlayRef.current;
    if (!node) return;
    // A horizontal trackpad swipe turns one page per gesture: travel accumulates until it crosses the threshold, then the
    // wheel is locked until the fingers lift (no events for a moment), so momentum scrolling never skips a second photo.
    const paging = { travel: 0, locked: false, timer: 0 };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (closingRef.current) return;
      const current = vpRef.current;
      const dx = wheelPx(e.deltaX, e.deltaMode, current.w), dy = wheelPx(e.deltaY, e.deltaMode, current.h);
      if (e.ctrlKey) { stopZoom(); zoomAround(e.clientX, e.clientY, zoomS.get() * Math.exp(-clamp(dy, -50, 50) * .012), false); return; }
      if (zoomS.get() <= 1.01) {
        window.clearTimeout(paging.timer);
        paging.timer = window.setTimeout(() => { paging.travel = 0; paging.locked = false; }, 160);
        if (paging.locked || Math.abs(dx) <= Math.abs(dy)) return;
        paging.travel += dx;
        if (Math.abs(paging.travel) < WHEEL_PAGE) return;
        paging.locked = true;
        goTo(indexRef.current + Math.sign(paging.travel));
        return;
      }
      stopZoom();
      const bounds = panBounds(frameOf(indexRef.current), zoomS.get(), current);
      panX.jump(clamp(panX.get() - dx, bounds.minX, bounds.maxX));
      panY.jump(clamp(panY.get() - dy, bounds.minY, bounds.maxY));
    };
    // Safari reports a trackpad pinch as gesture events rather than Ctrl + wheel.
    type Gesture = Event & { scale: number; clientX: number; clientY: number };
    let base = 1;
    const onGestureStart = (e: Event) => { e.preventDefault(); stopZoom(); base = zoomS.get(); };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      if (closingRef.current) return;
      const g = e as Gesture;
      zoomAround(g.clientX, g.clientY, base * g.scale, false);
    };
    const onGestureEnd = (e: Event) => e.preventDefault();
    node.addEventListener("wheel", onWheel, { passive: false });
    node.addEventListener("gesturestart", onGestureStart);
    node.addEventListener("gesturechange", onGestureChange);
    node.addEventListener("gestureend", onGestureEnd);
    return () => {
      window.clearTimeout(paging.timer);
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("gesturestart", onGestureStart);
      node.removeEventListener("gesturechange", onGestureChange);
      node.removeEventListener("gestureend", onGestureEnd);
    };
  }, [frameOf, goTo, panX, panY, stopZoom, zoomAround, zoomS]);

  const isOnImage = (x: number, y: number) => {
    const r = imageRef.current?.getBoundingClientRect();
    return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (closingRef.current || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      // A second finger turns any gesture into a pinch; a half-finished swipe or dismiss settles back first.
      const [a, b] = [...pointers.current.values()];
      animate(stripX, -indexRef.current * vpRef.current.w, settle);
      animate(heroX, 0, settle); animate(heroY, 0, settle); animate(heroS, 1, settle); animate(veil, 1, { duration: duration.fast });
      stopZoom();
      gesture.current = { mode: "pinch", distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: zoomS.get(), midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2, panX: panX.get(), panY: panY.get() };
      return;
    }
    if (pointers.current.size > 2) return;
    // Grabbing mid-flight stops the photo where it is; the gesture carries on from its live position.
    stripX.stop(); panX.stop(); panY.stop();
    if (zoomS.get() > 1.01) zoomS.stop();
    const frame = frameOf(indexRef.current);
    gesture.current = {
      mode: "pending", id: e.pointerId, x: e.clientX, y: e.clientY, baseStrip: stripX.get(), basePanX: panX.get(), basePanY: panY.get(),
      grabX: clamp((e.clientX - frame.left) / frame.width, 0, 1), grabY: clamp((e.clientY - frame.top) / frame.height, 0, 1),
      onImage: isOnImage(e.clientX, e.clientY), history: [{ x: e.clientX, y: e.clientY, t: performance.now() }],
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current, current = vpRef.current;
    if (g.mode === "pinch") {
      if (pointers.current.size < 2) return;
      const [a, b] = [...pointers.current.values()];
      const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
      const raw = g.zoom * Math.hypot(a.x - b.x, a.y - b.y) / g.distance;
      // Past the limits the pinch keeps following, but with resistance, and springs back on release.
      const z = raw < 1 ? 1 - rubber(1 - raw, 1, .4) : raw > MAX_ZOOM ? MAX_ZOOM + rubber(raw - MAX_ZOOM, MAX_ZOOM, .4) : raw;
      const frame = frameOf(indexRef.current);
      const cx = frame.left + frame.width / 2, cy = frame.top + frame.height / 2;
      zoomS.set(z);
      // Pinching smaller than the stage previews the close: the page shows through as the photo shrinks.
      veil.set(z < 1 ? clamp(1 - (1 - z) * 4, .25, 1) : 1);
      panX.set(g.midX - cx - (g.midX - cx - g.panX) * (z / g.zoom) + (midX - g.midX));
      panY.set(g.midY - cy - (g.midY - cy - g.panY) * (z / g.zoom) + (midY - g.midY));
      return;
    }
    if (g.mode === "idle" || e.pointerId !== g.id) return;
    g.history.push({ x: e.clientX, y: e.clientY, t: performance.now() });
    if (g.history.length > 12) g.history.shift();
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (g.mode === "pending") {
      if (Math.hypot(dx, dy) < 6) return;
      g.mode = zoomS.get() > 1.01 ? "pan" : Math.abs(dx) > Math.abs(dy) ? "swipe" : "dismiss";
      if (g.mode === "pan") overlayRef.current?.setAttribute("data-panning", "");
    }
    if (g.mode === "swipe") {
      const min = -(images.length - 1) * current.w;
      const raw = g.baseStrip + dx;
      stripX.set(raw > 0 ? rubber(raw, current.w) : raw < min ? min + rubber(raw - min, current.w) : raw);
    } else if (g.mode === "dismiss") {
      // The photo stays glued to the finger at the point it was grabbed, shrinking around that point as it travels down.
      const down = Math.max(0, dy), progress = clamp(down / (current.h * .6), 0, 1);
      const s = 1 - progress * .4;
      const frame = frameOf(indexRef.current);
      heroS.set(s);
      heroX.set(dx + (1 - s) * frame.width * g.grabX);
      heroY.set((dy < 0 ? -rubber(-dy, current.h, .35) : dy) + (1 - s) * frame.height * g.grabY);
      veil.set(1 - progress * .85);
    } else if (g.mode === "pan") {
      const bounds = panBounds(frameOf(indexRef.current), zoomS.get(), current);
      const band = (value: number, lo: number, hi: number, size: number) => value < lo ? lo - rubber(lo - value, size) : value > hi ? hi + rubber(value - hi, size) : value;
      panX.set(band(g.basePanX + dx, bounds.minX, bounds.maxX, current.w));
      panY.set(band(g.basePanY + dy, bounds.minY, bounds.maxY, current.h));
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    if (!pointers.current.size) overlayRef.current?.removeAttribute("data-panning");
    const g = gesture.current, current = vpRef.current;
    if (g.mode === "pinch") {
      const z = zoomS.get();
      if (z < PINCH_CLOSE && e.type !== "pointercancel") { pointers.current.clear(); gesture.current = { mode: "idle" }; close(); return; }
      if (z < 1) animate(veil, 1, { duration: duration.fast, ease: enterEase });
      const frame = frameOf(indexRef.current);
      const remaining = [...pointers.current.entries()][0];
      // One finger left on a zoomed photo carries on panning from where it is, without a jump.
      if (remaining && z > 1.01) {
        const [id, point] = remaining;
        gesture.current = { mode: "pan", id, x: point.x, y: point.y, baseStrip: stripX.get(), basePanX: panX.get(), basePanY: panY.get(), grabX: .5, grabY: .5, onImage: true, history: [{ ...point, t: performance.now() }] };
      } else gesture.current = { mode: "idle" };
      if (remaining && z > 1.01 && z <= MAX_ZOOM) return;
      if (z <= 1.02) { resetZoom(true); return; }
      const target = clamp(z, 1, MAX_ZOOM), bounds = panBounds(frame, target, current);
      animate(zoomS, target, settle);
      animate(panX, clamp(panX.get(), bounds.minX, bounds.maxX), settle);
      animate(panY, clamp(panY.get(), bounds.minY, bounds.maxY), settle);
      return;
    }
    if (g.mode === "idle" || e.pointerId !== g.id) return;
    gesture.current = { mode: "idle" };
    const v = velocityOf(g.history);
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (g.mode === "pending") {
      if (e.type === "pointercancel") return;
      // A tap outside the photo closes. Two quick taps on the photo zoom to that spot; mouse users get the same on double click.
      if (!g.onImage) { close(); return; }
      if (e.pointerType === "mouse") return;
      const now = performance.now(), tap = lastTap.current;
      if (tap && now - tap.t < 300 && Math.hypot(tap.x - e.clientX, tap.y - e.clientY) < 30) { lastTap.current = null; toggleZoom(e.clientX, e.clientY); }
      else lastTap.current = { x: e.clientX, y: e.clientY, t: now };
      return;
    }
    if (g.mode === "swipe") {
      // Land where the flick was heading, but never more than one photo away.
      // A quick flick pages even over a short distance, as long as it moves the way the finger travelled.
      const travelled = dx + project(v.x);
      const flick = Math.abs(v.x) > 450 && Math.sign(v.x) === Math.sign(dx) ? -Math.sign(v.x) : 0;
      const step = travelled < -current.w * .3 ? 1 : travelled > current.w * .3 ? -1 : flick;
      goTo(indexRef.current + step, v.x);
      return;
    }
    if (g.mode === "dismiss") {
      // Direction decides, not position: a downward flick closes from anywhere, an upward one always brings the photo back.
      if (dy > 0 && (v.y > 500 || (dy > 110 && v.y > -150))) { close(v); return; }
      const back = reduced ? { duration: duration.fast, ease: standardEase } : null;
      animate(heroX, 0, back ?? { ...settle, velocity: v.x });
      animate(heroY, 0, back ?? { ...settle, velocity: v.y });
      animate(heroS, 1, back ?? settle);
      animate(veil, 1, { duration: duration.standard, ease: enterEase });
      return;
    }
    if (g.mode === "pan") coast(v);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "ArrowRight") { e.preventDefault(); goTo(indexRef.current + 1); return; }
    if (e.key === "ArrowLeft") { e.preventDefault(); goTo(indexRef.current - 1); return; }
    if (e.key === "+" || e.key === "=") { e.preventDefault(); const f = frameOf(indexRef.current); zoomAround(f.left + f.width / 2, f.top + f.height / 2, zoomS.get() * 1.5, true); return; }
    if (e.key === "-") { e.preventDefault(); const f = frameOf(indexRef.current); zoomAround(f.left + f.width / 2, f.top + f.height / 2, zoomS.get() / 1.5, true); return; }
    if (e.key === "0") { e.preventDefault(); resetZoom(true); return; }
    if (e.key === "Tab") {
      // Keep focus inside the viewer while it is open.
      const focusable = [...(overlayRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [])];
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };

  // Keep the active thumbnail centered in the strip.
  useEffect(() => {
    const strip = stripRef.current, node = strip?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (!strip || !node) return;
    const image = images[index];
    const width = clamp(48 * image.width / image.height, 36, 72);
    strip.scrollTo({ left: node.offsetLeft + width / 2 - strip.clientWidth / 2, behavior: reduced ? "auto" : "smooth" });
  }, [images, index, reduced]);

  const c = chromeOf(vp);
  const image = images[index];
  const range = [index - 1, index, index + 1].filter(i => i >= 0 && i < images.length);

  return createPortal(<div ref={overlayRef} className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown} data-closing={closing || undefined} data-zoomed={zoomed || undefined}>
    <motion.div className={styles.veil} style={{ opacity: veil }} aria-hidden="true" />
    <div className={styles.stage} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onDoubleClick={e => { if (!closingRef.current && isOnImage(e.clientX, e.clientY)) toggleZoom(e.clientX, e.clientY); }}>
      <motion.div className={styles.strip} style={{ x: stripX }}>
        {range.map(i => {
          const frame = fit(images[i], vp), active = i === index;
          return <div key={images[i].src} className={styles.slide} style={{ left: i * vp.w, width: vp.w, height: vp.h }} aria-hidden={active ? undefined : true}>
            <Frame image={images[i]} frame={frame} active={active} imageRef={active ? imageRef : undefined}
              hero={active ? { x: heroX, y: heroY, scale: heroS, opacity: heroO } : null}
              zoom={active ? { scale: zoomS, x: panX, y: panY, radius } : null} />
          </div>;
        })}
      </motion.div>
    </div>

    <motion.div className={styles.topBar} style={{ opacity: chrome, height: c.top }}>
      <p className={styles.counter} aria-live="polite"><span className={styles.num}>{index + 1}</span> of <span className={styles.num}>{images.length}</span></p>
      <h2 id={titleId} className={styles.srOnly}>{label}: {image.title ?? image.alt}</h2>
      <div className={styles.actions}>
        <button type="button" className={styles.iconButton} onClick={() => toggleZoom()} aria-label={zoomed ? "Zoom out" : "Zoom in"} aria-pressed={zoomed}>
          {zoomed ? <ZoomOut size={20} strokeWidth={1.75} aria-hidden="true" /> : <ZoomIn size={20} strokeWidth={1.75} aria-hidden="true" />}
        </button>
        <button ref={closeRef} type="button" className={styles.iconButton} onClick={() => close()} aria-label="Close viewer">
          <X size={20} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
    </motion.div>

    <motion.div className={styles.sideNav} style={{ opacity: chrome }}>
      <button type="button" className={styles.navButton} data-side="prev" onClick={() => goTo(index - 1)} disabled={index === 0} aria-label="Previous photo"><ChevronLeft size={20} strokeWidth={1.75} aria-hidden="true" /></button>
      <button type="button" className={styles.navButton} data-side="next" onClick={() => goTo(index + 1)} disabled={index === images.length - 1} aria-label="Next photo"><ChevronRight size={20} strokeWidth={1.75} aria-hidden="true" /></button>
    </motion.div>

    <motion.div className={styles.bottom} style={{ opacity: chrome, height: c.bottom }}>
      <div className={styles.captions}>
        <AnimatePresence initial={false}>
          <motion.div key={index} className={styles.caption}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: duration.fast } }}
            transition={reduced ? { duration: duration.fast } : { duration: duration.standard, ease: enterEase, delay: .04 }}>
            {image.title && <p className={styles.captionTitle}>{image.title}</p>}
            {image.caption && <p className={styles.captionText}>{image.caption}</p>}
          </motion.div>
        </AnimatePresence>
      </div>
      <div ref={stripRef} className={styles.thumbStrip} role="group" aria-label="All photos">
        {images.map((item, i) => {
          const width = clamp(48 * item.width / item.height, 36, 72);
          return <button key={item.src} type="button" data-index={i} className={styles.stripThumb} data-active={i === index || undefined}
            style={{ width: i === index ? width : 36 }} onClick={() => goTo(i)} aria-label={`Show ${item.title ?? item.alt}`} aria-current={i === index ? "true" : undefined}>
            <ArcImage src={item.src} alt="" width={item.width} height={item.height} sizes="80px" draggable={false} />
          </button>;
        })}
      </div>
    </motion.div>
  </div>, document.body);
}

type HeroValues = { x: MotionValue<number>; y: MotionValue<number>; scale: MotionValue<number>; opacity: MotionValue<number> };
type ZoomValues = { scale: MotionValue<number>; x: MotionValue<number>; y: MotionValue<number>; radius: MotionValue<string> };

/** One photo on the stage. The outer frame carries the open, dismiss, and return flight; the inner layer carries zoom and pan. */
function Frame({ image, frame, active, hero, zoom, imageRef }: { image: LightboxImage; frame: Rect; active: boolean; hero: HeroValues | null; zoom: ZoomValues | null; imageRef?: Ref<HTMLDivElement> }) {
  const [loaded, setLoaded] = useState(false);
  return <motion.div className={styles.frame} style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height, ...(hero ?? {}) }}>
    <motion.div ref={imageRef} className={styles.zoom} style={zoom ? { scale: zoom.scale, x: zoom.x, y: zoom.y, borderRadius: zoom.radius } : { borderRadius: RADIUS }}>
      {/* The grid's own file sits underneath, so the first frame of the flight already shows the photo while the sharp one loads. */}
      <ArcImage src={image.src} alt="" width={image.width} height={image.height} sizes={THUMB_SIZES} draggable={false} className={styles.layer} />
      <ArcImage src={image.src} alt={active ? image.alt : ""} width={image.width} height={image.height} sizes="100vw" draggable={false}
        className={styles.layer} data-loaded={loaded || undefined} onLoad={() => setLoaded(true)} loading={active ? "eager" : "lazy"} />
    </motion.div>
  </motion.div>;
}

export default LightboxGallery;
