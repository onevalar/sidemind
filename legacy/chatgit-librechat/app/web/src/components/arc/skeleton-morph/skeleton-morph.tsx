"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, ElementType, ReactNode } from "react";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./skeleton-morph.module.css";

/**
 * Loading skeletons that become the real content instead of swapping for it. Each MorphBlock is a size-matched skeleton while
 * loading. When data arrives, blocks resolve one after another in reading order: the placeholder stretches to the exact box of
 * the content it stood in for and fades, while the content sharpens in underneath, and the region eases to its final height.
 * Nothing flies across the layout; every block changes in place. Wrap each visible piece of the loaded layout in a block.
 */
export interface SkeletonMorphProps {
  /** While true, blocks show their skeletons and the region is marked busy. */
  loading: boolean;
  children: ReactNode;
  /** Seconds between blocks as they resolve in reading order. Defaults to 0.04. */
  stagger?: number;
  /** Text read by screen readers while loading. Defaults to "Loading". */
  loadingLabel?: string;
  /** The root element. Defaults to div. Style it as the card, so its border follows the eased height. */
  as?: ElementType;
  className?: string;
  style?: CSSProperties;
}

export interface MorphBlockProps {
  /** The loaded content. It is not rendered while loading. */
  children?: ReactNode;
  /** Skeleton width, any CSS length. Match the content for the calmest morph. Defaults to 100%. */
  width?: number | string;
  /** Skeleton height, any CSS length. Defaults to 12px, or lines × lineHeight. */
  height?: number | string;
  /** Skeleton corner radius. Use "circle" for avatars. Defaults to 6. */
  radius?: number | string | "circle";
  /** Renders a paragraph skeleton with this many lines; the last one is shorter. */
  lines?: number;
  /** Line height of the paragraph in px, so the skeleton is exactly as tall as the text. Defaults to 20. */
  lineHeight?: number;
  /** The block element. Defaults to div. */
  as?: BlockTag;
  className?: string;
  style?: CSSProperties;
}

type BlockTag = "div" | "span" | "p" | "li" | "section" | "article" | "header" | "footer" | "h2" | "h3" | "h4";

interface MorphContext {
  loading: boolean;
  reduced: boolean;
  stagger: number;
  register: (node: HTMLElement) => () => void;
  order: (node: HTMLElement | null) => number;
}
const Context = createContext<MorphContext | null>(null);

const subscribe = () => () => {};
function useReducedFlag() {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

/** Critically damped: the placeholder settles onto the content without overshooting it. */
const MORPH = motionTokens.spring.smooth;
const HEIGHT = motionTokens.spring.smooth;
const EASE = [...motionTokens.ease.standard] as [number, number, number, number];
const length = (value: number | string | undefined) => typeof value === "number" ? `${value}px` : value;

export function SkeletonMorph({ loading, children, stagger = .04, loadingLabel = "Loading", as: Tag = "div", className, style }: SkeletonMorphProps) {
  const reduced = useReducedFlag();
  const blocks = useRef(new Set<HTMLElement>());
  const register = useCallback((node: HTMLElement) => {
    blocks.current.add(node);
    return () => { blocks.current.delete(node); };
  }, []);
  // Reading order is DOM order, so the reveal cascades down the layout whatever the component tree looks like.
  const order = useCallback((node: HTMLElement | null) => {
    if (!node) return 0;
    let index = 0;
    for (const other of blocks.current) if (other !== node && other.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) index += 1;
    return index;
  }, []);
  const value = useMemo(() => ({ loading, reduced, stagger, register, order }), [loading, order, reduced, register, stagger]);

  // The shell eases between heights and clips while it does, so a card border never jumps and content never pokes out.
  // A negative value means auto height.
  const innerRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const shellHeight = useMotionValue(-1);
  const height = useTransform(shellHeight, next => next < 0 ? "auto" : `${next}px`);
  useLayoutEffect(() => {
    const inner = innerRef.current, shell = shellRef.current;
    if (!inner || !shell) return;
    let last = inner.offsetHeight;
    let controls: { stop: () => void } | null = null;
    const settle = () => { shellHeight.jump(-1); delete shell.dataset.easing; };
    const observer = new ResizeObserver(() => {
      const next = inner.offsetHeight;
      if (next === last) return;
      const from = shellHeight.get() < 0 ? last : shellHeight.get();
      last = next;
      controls?.stop();
      if (reduced || Math.abs(next - from) < 1) { settle(); return; }
      shellHeight.jump(from);
      shell.dataset.easing = "";
      controls = animate(shellHeight, next, { ...HEIGHT, onComplete: settle });
    });
    observer.observe(inner);
    return () => { observer.disconnect(); controls?.stop(); };
  }, [reduced, shellHeight]);

  return <Tag className={[styles.root, className].filter(Boolean).join(" ")} style={style} aria-busy={loading || undefined}>
    <span className={styles.srOnly} role="status">{loading ? loadingLabel : ""}</span>
    <motion.div ref={shellRef} className={styles.shell} style={{ height }}>
      <div ref={innerRef} className={styles.inner}>
        <Context.Provider value={value}>{children}</Context.Provider>
      </div>
    </motion.div>
  </Tag>;
}

export function MorphBlock({ children, width = "100%", height, radius = 6, lines, lineHeight = 20, as = "div", className, style }: MorphBlockProps) {
  const context = useContext(Context);
  if (!context) throw new Error("MorphBlock must be used inside SkeletonMorph");
  const { loading, reduced, stagger, register, order } = context;
  const ref = useRef<HTMLElement>(null);
  const placeholderRef = useRef<HTMLSpanElement>(null);
  useEffect(() => ref.current ? register(ref.current) : undefined, [register]);

  // Each block waits for its turn in reading order. Going back to loading is immediate, so a quick reload never sticks.
  const [resolvedState, setResolved] = useState(!loading);
  if (loading && resolvedState) setResolved(false);
  const resolved = resolvedState && !loading;
  useEffect(() => {
    if (loading) return;
    const delay = reduced ? 0 : order(ref.current) * stagger * 1000;
    const id = window.setTimeout(() => setResolved(true), delay);
    return () => window.clearTimeout(id);
  }, [loading, order, reduced, stagger]);

  const circle = radius === "circle";
  const lineCount = lines ?? 0;
  const skeletonWidth = length(width) ?? "100%";
  const skeletonHeight = length(height) ?? (lineCount ? `${lineCount * lineHeight}px` : "12px");

  const skeletonBox = useRef({ width: skeletonWidth, height: skeletonHeight });
  useLayoutEffect(() => { skeletonBox.current = { width: skeletonWidth, height: skeletonHeight }; });

  // The placeholder starts at the skeleton box, then stretches to the content's measured box as it fades.
  useLayoutEffect(() => {
    const block = ref.current, placeholder = placeholderRef.current;
    if (!block || !placeholder) return;
    // Motion remembers the last animated values, so every change goes through it with explicit keyframes.
    if (!resolved) {
      const controls = animate(placeholder, { width: "100%", height: "100%", x: 0, y: 0, opacity: 1 }, { duration: 0 });
      return () => controls.stop();
    }
    if (reduced) {
      const controls = animate(placeholder, { opacity: [1, 0] }, { duration: motionTokens.duration.instant });
      return () => controls.stop();
    }
    // By now the block already has its content size, so measure the skeleton box it just left by putting the skeleton sizing
    // back for one synchronous read. Nothing paints in between. The offset keeps right-aligned or centered blocks anchored.
    const to = block.getBoundingClientRect();
    const { width: inlineWidth, height: inlineHeight } = block.style;
    block.dataset.state = "skeleton";
    block.style.width = skeletonBox.current.width;
    block.style.height = skeletonBox.current.height;
    const from = block.getBoundingClientRect();
    block.dataset.state = "content";
    block.style.width = inlineWidth;
    block.style.height = inlineHeight;
    const controls = animate(placeholder, {
      width: [from.width, to.width], height: [from.height, to.height], x: [from.left - to.left, 0], y: [from.top - to.top, 0], opacity: [1, 0],
    }, { width: MORPH, height: MORPH, x: MORPH, y: MORPH, opacity: { duration: .38, ease: EASE, delay: .06 } });
    return () => controls.stop();
  }, [reduced, resolved]);

  const Tag = as as ElementType;
  const sizing: CSSProperties = resolved ? {} : { width: skeletonWidth, height: skeletonHeight };
  const placeholderStyle = { borderRadius: circle ? 9999 : lineCount ? 0 : length(radius), "--line": `${lineHeight}px` } as CSSProperties;

  return <Tag ref={ref} className={[styles.block, className].filter(Boolean).join(" ")} data-state={resolved ? "content" : "skeleton"} style={{ ...style, ...sizing }}>
    {resolved && <motion.div className={styles.content}
      initial={reduced ? { opacity: 0 } : { opacity: 0, filter: `blur(${motionTokens.blur.soft}px)` }} animate={{ opacity: 1, filter: "blur(0px)" }}
      transition={{ duration: reduced ? motionTokens.duration.instant : .34, ease: EASE }}>
      {children}
    </motion.div>}
    <span ref={placeholderRef} className={styles.placeholder} aria-hidden="true" data-lines={lineCount || undefined} style={placeholderStyle}>
      {lineCount > 0 && Array.from({ length: lineCount }, (_, i) => <span key={i} className={styles.line} data-last={i === lineCount - 1 && lineCount > 1 || undefined} />)}
    </span>
  </Tag>;
}
