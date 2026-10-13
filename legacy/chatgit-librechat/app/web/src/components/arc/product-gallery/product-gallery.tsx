"use client";

import { forwardRef, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, animate, motion, useIsPresent, useMotionValue, useReducedMotion, useSpring, useTransform } from "motion/react";
import type { HTMLMotionProps, MotionValue, Transition } from "motion/react";
import { ChevronLeft, ChevronRight, Maximize2, X } from "lucide-react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./product-gallery.module.css";

export interface ProductGalleryImage {
  src: string;
  alt: string;
  srcSet?: string;
}

/** One color of the product. Each color carries its own photos; switching colors crossfades the whole gallery. */
export interface ProductGalleryColor {
  value: string;
  label: string;
  /** Any CSS color for the swatch. */
  swatch: string;
  images: ProductGalleryImage[];
  /** Marks the whole color as sold out. It stays selectable so people can still look at it. */
  soldOut?: boolean;
}

export interface ProductGallerySize {
  value: string;
  label: string;
  /** `true` sells the size out in every color; a list sells it out only in those color values. */
  soldOut?: boolean | string[];
}

/**
 * A product media gallery with its variant picker. The main photo shows a magnifier lens that follows the pointer, a thumbnail rail
 * with a gliding indicator, swipe on touch, and a fullscreen viewer that grows out of the photo and pans on hover when zoomed.
 * Choosing a color crossfades every photo; sizes that are sold out in that color are struck through and skipped.
 * Put the product name and price in `header` and the purchase actions in `footer`.
 */
export interface ProductGalleryProps {
  colors: ProductGalleryColor[];
  sizes?: ProductGallerySize[];
  /** Selected color value. Leave it out to let the gallery manage it. */
  color?: string;
  defaultColor?: string;
  onColorChange?: (color: string) => void;
  /** Selected size value, or `null` for none. Leave it out to let the gallery manage it. */
  size?: string | null;
  defaultSize?: string | null;
  onSizeChange?: (size: string | null) => void;
  /** Index of the photo on show. Leave it out to let the gallery manage it. */
  index?: number;
  defaultIndex?: number;
  onIndexChange?: (index: number) => void;
  /** Magnification of the hover lens and the fullscreen zoom. Defaults to 2.4. */
  zoom?: number;
  /** Turns the hover lens off, for photos that do not hold detail. */
  magnifier?: boolean;
  /** Aspect ratio of the main photo as width / height. Defaults to 4 / 5. */
  aspectRatio?: number;
  /** Product name, used to name the gallery and its viewer. */
  label?: string;
  /** Content above the variant picker, such as the name and price. */
  header?: ReactNode;
  /** Content under the variant picker, such as add to bag. */
  footer?: ReactNode;
  className?: string;
}

type Bezier = [number, number, number, number];
type Rect = { left: number; top: number; width: number; height: number };
type Origin = { rect: Rect; radius: number; ratio: number };

const enter = [...motionTokens.ease.enter] as Bezier;
const standard = [...motionTokens.ease.standard] as Bezier;
/** Duration springs restated as stiffness and damping, so a retarget keeps the velocity already in flight. */
const physical = (visualDuration: number, bounce: number): Transition => {
  const root = 2 * Math.PI / (visualDuration * 1.2);
  return { type: "spring", stiffness: root * root, damping: 2 * (1 - bounce) * root, mass: 1 };
};
const SLIDE = physical(.42, .06), GLIDE = physical(.34, .12), OPEN = physical(.46, .1), CLOSE = physical(.4, .02), ZOOM = physical(.42, 0);
const LENS = 88, STAGE_RADIUS = 22, VIEWER_RADIUS = 18;
const { duration } = motionTokens;
/* Picker values swap in place: up and in, up and out. */
const valueIn = { opacity: 0, y: 8, filter: `blur(${motionTokens.blur.soft}px)` };
const valueShown = { opacity: 1, y: 0, filter: "blur(0px)" };
const valueOut = { opacity: 0, y: -8, filter: `blur(${motionTokens.blur.soft}px)` };
const valueSwap: Transition = { duration: duration.standard, ease: enter };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const project = (velocity: number, rate = .995) => velocity / 1000 * rate / (1 - rate);
const rubber = (overshoot: number, dimension: number, constant = .55) => overshoot * dimension * constant / (dimension + constant * Math.abs(overshoot));
const cx = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

const subscribe = () => () => {};
function useHydrated() { return useSyncExternalStore(subscribe, () => true, () => false); }

function useControllable<T>(value: T | undefined, fallback: T, onChange?: (next: T) => void) {
  const [inner, setInner] = useState(fallback);
  const controlled = value !== undefined;
  const set = useCallback((next: T) => { if (!controlled) setInner(next); onChange?.(next); }, [controlled, onChange]);
  return [controlled ? value : inner, set] as const;
}

export const isSoldOut = (size: ProductGallerySize, color: string) => size.soldOut === true || (Array.isArray(size.soldOut) && size.soldOut.includes(color));

function Photo({ image, className, eager }: { image: ProductGalleryImage; className?: string; eager?: boolean }) {
  // eslint-disable-next-line @next/next/no-img-element -- registry components stay framework agnostic; pass optimized URLs as src and srcSet.
  return <img className={className} src={image.src} srcSet={image.srcSet} alt={image.alt} draggable={false} decoding="async" loading={eager ? "eager" : "lazy"} />;
}

/**
 * One color's row of photos. It follows the shared position while it is the current color and holds still once it starts to leave,
 * so the outgoing photo fades where it was instead of moving with the incoming color.
 */
function Track({ x, ...props }: Omit<HTMLMotionProps<"span">, "style"> & { x: MotionValue<number> }) {
  const present = useIsPresent();
  const own = useMotionValue(x.get());
  useLayoutEffect(() => {
    if (!present) return;
    own.jump(x.get());
    return x.on("change", value => own.jump(value));
  }, [own, present, x]);
  return <motion.span {...props} style={{ x: own }} />;
}

/** Measures an element's box and keeps it current. */
function useBox<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const read = () => setBox(prev => prev.w === node.clientWidth && prev.h === node.clientHeight ? prev : { w: node.clientWidth, h: node.clientHeight });
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, box] as const;
}

/** A highlight that glides to whichever child is marked active inside `container`. */
function useGlide(container: RefObject<HTMLElement | null>, selector: string, key: unknown, reduced: boolean) {
  const x = useMotionValue(0), y = useMotionValue(0), w = useMotionValue(0), h = useMotionValue(0), o = useMotionValue(0);
  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const place = (spring: boolean) => {
      const node = root.querySelector<HTMLElement>(selector);
      if (!node) { animate(o, 0, { duration: reduced ? 0 : duration.instant, ease: standard }); return; }
      const next = [node.offsetLeft, node.offsetTop, node.offsetWidth, node.offsetHeight];
      const values = [x, y, w, h];
      if (!spring || reduced || o.get() < .05) values.forEach((value, i) => value.jump(next[i]));
      else values.forEach((value, i) => animate(value, next[i], GLIDE));
      animate(o, 1, { duration: reduced ? 0 : duration.fast, ease: standard });
    };
    place(true);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => place(false));
    observer.observe(root);
    return () => observer.disconnect();
  }, [container, h, key, o, reduced, selector, w, x, y]);
  return { x, y, width: w, height: h, opacity: o };
}

/** Roving focus for a row of radios or tabs: arrows move and select, Home and End jump. */
function roving(event: ReactKeyboardEvent<HTMLElement>, count: number, at: number, select: (index: number) => void, skip?: (index: number) => boolean) {
  const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[event.key];
  let next = event.key === "Home" ? 0 : event.key === "End" ? count - 1 : step ? at + step : null;
  if (next === null) return;
  event.preventDefault();
  const dir = step ?? (event.key === "Home" ? 1 : -1);
  for (let guard = 0; guard < count; guard++) {
    next = (next + count) % count;
    if (!skip?.(next)) break;
    next += dir;
  }
  select(next);
  const buttons = event.currentTarget.querySelectorAll<HTMLElement>("[data-option]");
  buttons[next]?.focus();
}

export const ProductGallery = forwardRef<HTMLDivElement, ProductGalleryProps>(function ProductGallery({
  colors, sizes, color: colorProp, defaultColor, onColorChange, size: sizeProp, defaultSize = null, onSizeChange,
  index: indexProp, defaultIndex = 0, onIndexChange, zoom = 2.4, magnifier = true, aspectRatio = 4 / 5, label = "Product photos",
  header, footer, className,
}, ref) {
  const hydrated = useHydrated();
  const reduced = !!useReducedMotion() && hydrated;
  const uid = useId();
  const [colorValue, setColor] = useControllable(colorProp, defaultColor ?? colors[0]?.value ?? "", onColorChange);
  const [sizeValue, setSize] = useControllable<string | null>(sizeProp, defaultSize, onSizeChange);
  const [rawIndex, setIndex] = useControllable(indexProp, defaultIndex, onIndexChange);
  const colorAt = Math.max(0, colors.findIndex(entry => entry.value === colorValue));
  const current = colors[colorAt];
  const images = current?.images ?? [];
  const index = clamp(rawIndex, 0, Math.max(0, images.length - 1));
  const activeSize = sizes?.find(entry => entry.value === sizeValue && !isSoldOut(entry, current?.value ?? ""));

  const go = useCallback((next: number) => { if (next !== index && next >= 0 && next < images.length) setIndex(next); }, [images.length, index, setIndex]);

  const chooseColor = (at: number) => {
    const next = colors[at];
    if (!next || next.value === current?.value) return;
    setColor(next.value);
    const chosen = sizes?.find(entry => entry.value === sizeValue);
    if (chosen && isSoldOut(chosen, next.value)) setSize(null);
    if (index > next.images.length - 1) setIndex(Math.max(0, next.images.length - 1));
  };

  /* The track. Every photo of the color sits in one row; the row springs to the photo on show and follows a finger 1:1. */
  const [stageRef, stage] = useBox<HTMLButtonElement>();
  const x = useMotionValue(0);
  const lastWidth = useRef(0);
  const lastColor = useRef(current?.value);
  useLayoutEffect(() => {
    if (!stage.w) return;
    const target = -index * stage.w;
    // A new color crossfades in place at its own photo, so the row lands there without sliding.
    if (reduced || lastWidth.current !== stage.w || lastColor.current !== current?.value) x.jump(target);
    else animate(x, target, SLIDE);
    lastWidth.current = stage.w;
    lastColor.current = current?.value;
  }, [current?.value, index, reduced, stage.w, x]);

  const drag = useRef<{ id: number; x0: number; y0: number; from: number; axis: "x" | "y" | null; samples: { x: number; t: number }[] } | null>(null);
  const suppressClick = useRef(false);

  const onStageDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse" || drag.current) return;
    x.stop();
    drag.current = { id: event.pointerId, x0: event.clientX, y0: event.clientY, from: x.get(), axis: null, samples: [{ x: event.clientX, t: event.timeStamp }] };
  };
  const onStageMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse") { trackLens(event); return; }
    const state = drag.current;
    if (!state || state.id !== event.pointerId) return;
    const dx = event.clientX - state.x0, dy = event.clientY - state.y0;
    if (!state.axis) {
      if (Math.hypot(dx, dy) < 8) return;
      state.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (state.axis === "x") event.currentTarget.setPointerCapture(event.pointerId);
    }
    if (state.axis !== "x") return;
    const min = -(images.length - 1) * stage.w, raw = state.from + dx;
    x.set(raw > 0 ? rubber(raw, stage.w) : raw < min ? min + rubber(raw - min, stage.w) : raw);
    state.samples = [...state.samples.slice(-4), { x: event.clientX, t: event.timeStamp }];
  };
  const onStageUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    if (!state || state.id !== event.pointerId) return;
    drag.current = null;
    if (state.axis !== "x") return;
    suppressClick.current = true;
    const first = state.samples[0], last = state.samples[state.samples.length - 1];
    const velocity = last.t > first.t ? (last.x - first.x) / (last.t - first.t) * 1000 : 0;
    const landing = x.get() + project(velocity);
    // One flick moves one photo, in the direction it was thrown.
    const next = clamp(Math.round(-landing / Math.max(1, stage.w)), index - 1, index + 1);
    const target = clamp(next, 0, images.length - 1);
    if (target !== index) setIndex(target);
    else animate(x, -index * stage.w, { ...SLIDE, velocity });
  };

  /* The lens. It rides a spring behind the pointer and shows the same photo at `zoom` times, aligned under the pointer. */
  const [lens, setLens] = useState(false);
  const px = useMotionValue(0), py = useMotionValue(0);
  const sx = useSpring(px, { stiffness: 620, damping: 44, mass: .6 }), sy = useSpring(py, { stiffness: 620, damping: 44, mass: .6 });
  const lx = reduced ? px : sx, ly = reduced ? py : sy;
  const lensX = useTransform(lx, value => value - LENS), lensY = useTransform(ly, value => value - LENS);
  const innerX = useTransform(lx, value => LENS - value * zoom), innerY = useTransform(ly, value => LENS - value * zoom);
  const lensOn = magnifier && lens && images.length > 0;
  function trackLens(event: ReactPointerEvent<HTMLElement>) {
    if (!magnifier) return;
    const rect = event.currentTarget.getBoundingClientRect();
    px.set(event.clientX - rect.left);
    py.set(event.clientY - rect.top);
    if (!lens) { sx.jump(px.get()); sy.jump(py.get()); setLens(true); }
  }

  /* Fullscreen. The viewer grows out of the stage's own rectangle and returns to it. */
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [open, setOpen] = useState(false);
  const measureOrigin = (): Origin | null => {
    const node = stageRef.current;
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, radius: parseFloat(getComputedStyle(node).borderTopLeftRadius) || STAGE_RADIUS, ratio: rect.width / Math.max(1, rect.height) };
  };
  const openViewer = () => {
    const next = measureOrigin();
    if (!next || !images.length) return;
    setLens(false);
    setOrigin(next);
    setOpen(true);
  };
  const closeViewer = () => {
    const next = measureOrigin();
    if (next) setOrigin(next);
    setOpen(false);
    stageRef.current?.focus({ preventScroll: true });
  };

  const onStageKey = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowRight") { event.preventDefault(); go(index + 1); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); go(index - 1); }
  };

  /* Rails and pickers each glide one highlight to their active option. */
  const railRef = useRef<HTMLDivElement>(null);
  const swatchRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef<HTMLDivElement>(null);
  const railGlide = useGlide(railRef, "[data-active]", `${index}-${images.length}`, reduced);
  const swatchGlide = useGlide(swatchRef, "[data-active]", colorAt, reduced);
  const sizeGlide = useGlide(sizeRef, "[data-active]", `${activeSize?.value}-${current?.value}`, reduced);

  if (!current) return null;
  const panelId = `${uid}-stage`;

  return <div ref={ref} className={cx(styles.root, className)} style={{ ["--ratio" as string]: aspectRatio }}>
    <div className={styles.layout}>
    <div className={styles.media} role="group" aria-label={label} aria-roledescription="gallery">
      <button ref={stageRef} type="button" id={panelId} className={styles.stage} data-lens={lensOn || undefined}
        aria-label={`${images[index]?.alt ?? label}. Photo ${index + 1} of ${images.length}. Open fullscreen`}
        onPointerDown={onStageDown} onPointerMove={onStageMove} onPointerUp={onStageUp} onPointerCancel={onStageUp}
        onPointerLeave={event => { if (event.pointerType === "mouse") setLens(false); }}
        onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } openViewer(); }}
        onKeyDown={onStageKey}>
        <AnimatePresence initial={false}>
          <Track key={current.value} x={x} className={styles.track}
            initial={reduced ? { opacity: 0 } : { opacity: 0, filter: `blur(${motionTokens.blur.text}px)` }}
            animate={{ opacity: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, transition: { duration: duration.exit, delay: reduced ? 0 : duration.fast, ease: standard } }}
            transition={{ duration: reduced ? duration.fast : .36, ease: enter }}>
            {current.images.map((image, at) => <span key={image.src} className={styles.slide} aria-hidden={at !== index || undefined}>
              <Photo image={image} className={styles.photo} eager={at === index} />
            </span>)}
          </Track>
        </AnimatePresence>

        <AnimatePresence>
          {lensOn && stage.w > 0 && <motion.span key="lens" className={styles.lens} aria-hidden="true" style={{ x: lensX, y: lensY }}
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: .6 }} animate={{ opacity: 1, scale: 1 }} exit={reduced ? { opacity: 0 } : { opacity: 0, scale: .6 }}
            transition={reduced ? { duration: duration.instant } : { opacity: { duration: duration.fast, ease: standard }, scale: GLIDE }}>
            <motion.img className={styles.lensPhoto} src={images[index].src} alt="" draggable={false}
              style={{ x: innerX, y: innerY, width: stage.w * zoom, height: stage.h * zoom }} />
          </motion.span>}
        </AnimatePresence>

        <span className={styles.expand} aria-hidden="true"><Maximize2 size={16} strokeWidth={1.75} /></span>
        {images.length > 1 && <span className={styles.dots} aria-hidden="true">
          {images.map((image, at) => <span key={at} className={styles.dot} data-active={at === index || undefined} />)}
        </span>}
      </button>

      {images.length > 1 && <div ref={railRef} className={styles.rail} role="tablist" aria-label="Photos" onKeyDown={event => roving(event, images.length, index, go)}>
        <motion.span className={styles.railIndicator} style={railGlide} aria-hidden="true" />
        {images.map((image, at) => <button key={at} type="button" role="tab" data-option="" data-active={at === index || undefined}
          className={styles.thumb} aria-selected={at === index} aria-controls={panelId} tabIndex={at === index ? 0 : -1}
          aria-label={`Photo ${at + 1}: ${image.alt}`} onClick={() => go(at)}>
          <AnimatePresence initial={false}>
            <motion.img key={image.src} className={styles.thumbPhoto} src={image.src} alt="" draggable={false} loading="lazy"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: duration.exit, delay: reduced ? 0 : duration.instant, ease: standard } }} transition={{ duration: reduced ? duration.instant : .3, ease: enter }} />
          </AnimatePresence>
        </button>)}
      </div>}
    </div>

    <div className={styles.details}>
      {header}
      <div className={styles.picker}>
        <p className={styles.pickerLabel} id={`${uid}-color`}>
          <span>Color</span>
          <span className={styles.pickerValue}>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span key={current.value} initial={reduced ? { opacity: 0 } : valueIn} animate={valueShown}
                exit={reduced ? { opacity: 0 } : valueOut} transition={valueSwap}>
                {current.label}{current.soldOut ? " · sold out" : ""}
              </motion.span>
            </AnimatePresence>
          </span>
        </p>
        <div ref={swatchRef} className={styles.swatches} role="radiogroup" aria-labelledby={`${uid}-color`} onKeyDown={event => roving(event, colors.length, colorAt, chooseColor)}>
          <motion.span className={styles.swatchRing} style={swatchGlide} aria-hidden="true" />
          {colors.map((entry, at) => <button key={entry.value} type="button" role="radio" data-option="" data-active={at === colorAt || undefined}
            aria-checked={at === colorAt} tabIndex={at === colorAt ? 0 : -1} className={styles.swatch} data-sold-out={entry.soldOut || undefined}
            aria-label={`${entry.label}${entry.soldOut ? ", sold out" : ""}`} onClick={() => chooseColor(at)}>
            <span className={styles.swatchFill} style={{ background: entry.swatch }} />
          </button>)}
        </div>
      </div>

      {!!sizes?.length && <div className={styles.picker}>
        <p className={styles.pickerLabel} id={`${uid}-size`}>
          <span>Size</span>
          <span className={styles.pickerValue}>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span key={activeSize?.value ?? "none"} initial={reduced ? { opacity: 0 } : valueIn} animate={valueShown}
                exit={reduced ? { opacity: 0 } : valueOut} transition={valueSwap}>
                {activeSize ? activeSize.label : "Select a size"}
              </motion.span>
            </AnimatePresence>
          </span>
        </p>
        <div ref={sizeRef} className={styles.sizes} role="radiogroup" aria-labelledby={`${uid}-size`}
          onKeyDown={event => {
            const at = Math.max(0, sizes.findIndex(entry => entry.value === activeSize?.value));
            roving(event, sizes.length, at, next => setSize(sizes[next].value), next => isSoldOut(sizes[next], current.value));
          }}>
          <motion.span className={styles.sizeFill} style={sizeGlide} aria-hidden="true" />
          {sizes.map((entry, at) => {
            const out = isSoldOut(entry, current.value), on = entry.value === activeSize?.value;
            const firstFocusable = !activeSize && sizes.findIndex(item => !isSoldOut(item, current.value)) === at;
            return <button key={entry.value} type="button" role="radio" data-option="" data-active={on || undefined} aria-checked={on}
              aria-disabled={out || undefined} tabIndex={on || firstFocusable ? 0 : -1} className={styles.size} data-sold-out={out || undefined}
              aria-label={out ? `${entry.label}, sold out` : undefined} onClick={() => { if (!out) setSize(on ? null : entry.value); }}>
              {entry.label}
            </button>;
          })}
        </div>
      </div>}
      {footer}
    </div>
    </div>

    {hydrated && createPortal(<AnimatePresence custom={origin}>
      {open && origin && <Viewer key="viewer" images={images} index={index} origin={origin} zoom={zoom} reduced={reduced} label={label} onIndex={go} onClose={closeViewer} />}
    </AnimatePresence>, document.body)}
  </div>;
});

/** Where the fullscreen frame rests: as large as fits, centered above the controls, at the stage's aspect ratio. */
function frameFor(ratio: number): Rect {
  const vw = window.innerWidth, vh = window.innerHeight;
  const pad = vw < 640 ? 12 : 48, controls = 72, top = vw < 640 ? 56 : 64;
  const maxW = vw - pad * 2, maxH = vh - top - controls - 8;
  const width = Math.min(maxW, maxH * ratio), height = width / ratio;
  return { left: (vw - width) / 2, top: top + (maxH - height) / 2, width, height };
}
/** The transform that makes the frame sit exactly on the stage. Corners are counter scaled so they read the same all the way. */
function flight(origin: Origin) {
  const frame = frameFor(origin.ratio);
  const scale = origin.rect.width / frame.width;
  return {
    x: origin.rect.left + origin.rect.width / 2 - (frame.left + frame.width / 2),
    y: origin.rect.top + origin.rect.height / 2 - (frame.top + frame.height / 2),
    scale,
    borderRadius: origin.radius / scale,
  };
}

const frameVariants = {
  from: (origin: Origin) => flight(origin),
  rest: { x: 0, y: 0, scale: 1, borderRadius: VIEWER_RADIUS, transition: OPEN },
  back: (origin: Origin) => ({ ...flight(origin), transition: CLOSE }),
};
const fadeVariants = { from: { opacity: 0 }, rest: { opacity: 1, transition: { duration: duration.fast, ease: standard } }, back: { opacity: 0, transition: { duration: duration.fast, ease: standard } } };

interface ViewerProps {
  images: ProductGalleryImage[];
  index: number;
  origin: Origin;
  zoom: number;
  reduced: boolean;
  label: string;
  onIndex: (index: number) => void;
  onClose: () => void;
}

function Viewer({ images, index, origin, zoom, reduced, label, onIndex, onClose }: ViewerProps) {
  const [frame, setFrame] = useState(() => frameFor(origin.ratio));
  const [direction, setDirection] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onResize = () => setFrame(frameFor(origin.ratio));
    window.addEventListener("resize", onResize);
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus({ preventScroll: true });
    return () => { window.removeEventListener("resize", onResize); document.body.style.overflow = overflow; };
  }, [origin.ratio]);

  /* Zoom scales about the center; pan targets follow the pointer on a spring so the photo drifts rather than snaps. */
  const scale = useMotionValue(1);
  const tx = useMotionValue(0), ty = useMotionValue(0);
  const panX = useSpring(tx, { stiffness: 260, damping: 34 }), panY = useSpring(ty, { stiffness: 260, damping: 34 });
  const limit = (value: number, size: number) => clamp(value, -(zoom - 1) * size / 2, (zoom - 1) * size / 2);
  const aim = (clientX: number, clientY: number) => {
    const px = clientX - (frame.left + frame.width / 2), py = clientY - (frame.top + frame.height / 2);
    tx.set(limit(-px * (zoom - 1), frame.width));
    ty.set(limit(-py * (zoom - 1), frame.height));
  };
  const setZoom = (next: boolean, clientX?: number, clientY?: number) => {
    setZoomed(next);
    if (next && clientX !== undefined && clientY !== undefined) aim(clientX, clientY);
    if (!next) { tx.set(0); ty.set(0); }
    if (reduced) { scale.jump(next ? zoom : 1); panX.jump(tx.get()); panY.jump(ty.get()); }
    else animate(scale, next ? zoom : 1, ZOOM);
  };

  const step = (delta: number) => {
    const next = index + delta;
    if (next < 0 || next >= images.length) return;
    if (zoomed) setZoom(false);
    setDirection(delta);
    onIndex(next);
  };

  const press = useRef<{ id: number; x: number; y: number; t: number; pan: { x: number; y: number } } | null>(null);
  const onDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (press.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    press.current = { id: event.pointerId, x: event.clientX, y: event.clientY, t: event.timeStamp, pan: { x: tx.get(), y: ty.get() } };
  };
  const onMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = press.current;
    if (event.pointerType === "mouse" && !state) { if (zoomed) aim(event.clientX, event.clientY); return; }
    if (!state || state.id !== event.pointerId || !zoomed || event.pointerType === "mouse") return;
    // Touch pans the zoomed photo directly under the finger.
    tx.set(limit(state.pan.x + event.clientX - state.x, frame.width));
    ty.set(limit(state.pan.y + event.clientY - state.y, frame.height));
    panX.jump(tx.get()); panY.jump(ty.get());
  };
  const onUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = press.current;
    if (!state || state.id !== event.pointerId) return;
    press.current = null;
    const dx = event.clientX - state.x, dy = event.clientY - state.y;
    const elapsed = Math.max(1, event.timeStamp - state.t);
    if (Math.hypot(dx, dy) < 6) { setZoom(!zoomed, event.clientX, event.clientY); return; }
    if (!zoomed && event.pointerType !== "mouse" && Math.abs(dx) > Math.abs(dy) && (Math.abs(dx) > 60 || Math.abs(dx) / elapsed > .4)) step(dx < 0 ? 1 : -1);
  };

  /* Closing while zoomed settles the zoom during the flight back, so the frame lands on the stage showing the whole photo. */
  const close = () => { if (zoomed) setZoom(false); onClose(); };

  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); if (zoomed) setZoom(false); else onClose(); }
    else if (event.key === "ArrowRight") { event.preventDefault(); step(1); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); step(-1); }
    else if (event.key === "Tab") {
      const focusables = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []);
      if (!focusables.length) return;
      const at = focusables.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey ? (at <= 0 ? focusables.length - 1 : at - 1) : (at + 1) % focusables.length;
      event.preventDefault();
      focusables[next].focus();
    }
  };

  const image = images[index];
  const slide = reduced ? 0 : 48;

  return <motion.div ref={dialogRef} className={styles.viewer} role="dialog" aria-modal="true" aria-label={`${label}, photo ${index + 1} of ${images.length}`} onKeyDown={onKey}
    initial="from" animate="rest" exit="back">
    <motion.div className={styles.backdrop} variants={fadeVariants} onClick={close} aria-hidden="true" />
    <motion.div className={styles.frame} data-zoomed={zoomed || undefined}
      style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
      variants={reduced ? fadeVariants : frameVariants} custom={origin}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => { press.current = null; }}>
      <motion.div className={styles.zoomLayer} style={{ scale, x: panX, y: panY }}>
        <AnimatePresence initial={false} custom={direction}>
          <motion.div key={image.src} className={styles.frameSlide} custom={direction}
            variants={{
              enter: (dir: number) => ({ opacity: 0, x: dir * slide }),
              center: { opacity: 1, x: 0 },
              leave: (dir: number) => ({ opacity: 0, x: dir * -slide }),
            }}
            initial="enter" animate="center" exit="leave" transition={{ x: SLIDE, opacity: { duration: duration.standard, ease: standard } }}>
            <Photo image={image} className={styles.photo} eager />
          </motion.div>
        </AnimatePresence>
      </motion.div>
    </motion.div>

    <motion.div className={styles.viewerTop} variants={{ from: { opacity: 0 }, rest: { opacity: 1, transition: { duration: duration.standard, delay: .12, ease: standard } }, back: { opacity: 0, transition: { duration: duration.instant, ease: standard } } }}>
      <span className={styles.counter} aria-live="polite">{index + 1} / {images.length}</span>
      <span className={styles.hint}>{zoomed ? "Move to pan, click to zoom out" : "Click the photo to zoom"}</span>
      <button ref={closeRef} type="button" className={styles.viewerButton} aria-label="Close" onClick={close}><X size={18} strokeWidth={1.75} /></button>
    </motion.div>
    {images.length > 1 && <motion.div className={styles.viewerNav} variants={{ from: { opacity: 0, y: 8 }, rest: { opacity: 1, y: 0, transition: { duration: duration.standard, delay: .14, ease: enter } }, back: { opacity: 0, transition: { duration: duration.instant, ease: standard } } }}>
      <button type="button" className={styles.viewerButton} aria-label="Previous photo" disabled={index === 0} onClick={() => step(-1)}><ChevronLeft size={18} strokeWidth={1.75} /></button>
      <span className={styles.viewerDots} aria-hidden="true">{images.map((entry, at) => <span key={entry.src} className={styles.dot} data-active={at === index || undefined} />)}</span>
      <button type="button" className={styles.viewerButton} aria-label="Next photo" disabled={index === images.length - 1} onClick={() => step(1)}><ChevronRight size={18} strokeWidth={1.75} /></button>
    </motion.div>}
  </motion.div>;
}

export default ProductGallery;
