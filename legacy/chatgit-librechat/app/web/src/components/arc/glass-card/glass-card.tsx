"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { AnimatePresence, LayoutGroup, motion, useMotionValue, useReducedMotion, useSpring } from "motion/react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./glass-card.module.css";

/**
 * A glass card over a photo. The glass edge catches a specular highlight that follows the pointer while the card tilts a
 * few degrees toward it. Tapping the card, or pressing its header, morphs the glass panel up into a detail sheet with one
 * shared-layout spring. Escape or the header folds it back.
 */
export interface GlassCardProps {
  /** Photo behind the glass. */
  image: string;
  /** Alt text for the photo. Pass an empty string when the photo is decorative. */
  imageAlt: string;
  /** Main line in the glass panel, such as a name or a product. */
  title: string;
  /** Second line under the title. */
  subtitle?: ReactNode;
  /** Small element at the end of the header, such as a price or a status. */
  aside?: ReactNode;
  /** Detail content revealed when the card expands. Buttons and links inside stay interactive. */
  children?: ReactNode;
  /** Controlled expanded state. */
  open?: boolean;
  /** Initial expanded state when uncontrolled. */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Maximum tilt in degrees. 0 turns tilt off. Defaults to 6. */
  tilt?: number;
  className?: string;
  style?: CSSProperties;
}

const morph = motionTokens.spring.morph;
const settle = { stiffness: 260, damping: 24, mass: .6 };

export function GlassCard({ image, imageAlt, title, subtitle, aside, children, open: openProp, defaultOpen = false, onOpenChange, tilt = 6, className, style }: GlassCardProps) {
  const reduced = !!useReducedMotion();
  const id = useId();
  const detailId = `${id}-detail`;
  const [innerOpen, setInnerOpen] = useState(defaultOpen);
  const open = openProp ?? innerOpen;
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  const setOpen = useCallback((next: boolean) => {
    if (openProp === undefined) setInnerOpen(next);
    onOpenChange?.(next);
  }, [openProp, onOpenChange]);

  const panelRef = useRef<HTMLDivElement>(null);
  // Pointer position over the glass panel, in px, places the specular highlight; the position over the card drives the tilt.
  const gx = useMotionValue(-400), gy = useMotionValue(-400);
  const rx = useSpring(0, settle), ry = useSpring(0, settle);
  const glare = useSpring(0, { stiffness: 200, damping: 30 });
  const tiltStyle = { rotateX: rx, rotateY: ry, transformPerspective: 900 };
  const glassStyle = { "--gx": gx, "--gy": gy, "--glare": glare } as unknown as CSSProperties;

  const rest = useCallback(() => { rx.set(0); ry.set(0); glare.set(0); }, [rx, ry, glare]);
  useEffect(() => { if (open) rest(); }, [open, rest]);

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const root = rootRef.current, panel = panelRef.current;
    if (!root || !panel || event.pointerType === "touch") return;
    const box = root.getBoundingClientRect(), glass = panel.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    const y = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
    gx.set(event.clientX - glass.left); gy.set(event.clientY - glass.top);
    glare.set(1);
    if (reduced || open || tilt <= 0) return;
    ry.set((x - .5) * 2 * tilt);
    rx.set((.5 - y) * 2 * tilt);
  };

  const onClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-glass-card-detail]") || target.closest("[data-glass-card-toggle]")) return;
    setOpen(!open);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
      toggleRef.current?.focus();
    }
  };

  const transition = reduced ? { duration: 0 } : morph;

  return <motion.div ref={rootRef} className={[styles.root, className].filter(Boolean).join(" ")} style={{ ...style, ...tiltStyle }} data-open={open || undefined}
    onPointerMove={onPointerMove} onPointerLeave={rest} onClick={onClick} onKeyDown={onKeyDown}>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src={image} alt={imageAlt} className={styles.image} draggable={false} />
    <div className={styles.scrim} aria-hidden />
    <LayoutGroup id={id}>
      <motion.div ref={panelRef} layout transition={transition} className={styles.panel} style={{ ...glassStyle, borderRadius: 22 }}>
        <span className={styles.edge} aria-hidden />
        <motion.button ref={toggleRef} layout="position" transition={transition} type="button" className={styles.header} data-glass-card-toggle
          aria-expanded={open} aria-controls={detailId} onClick={() => setOpen(!open)}>
          <span className={styles.titles}>
            <span className={styles.title}>{title}</span>
            {subtitle ? <span className={styles.subtitle}>{subtitle}</span> : null}
          </span>
          {aside ? <span className={styles.aside}>{aside}</span> : null}
        </motion.button>
        <AnimatePresence initial={false} mode="popLayout">
          {open ? <motion.div key="detail" id={detailId} layout="position" transition={transition} className={styles.detail} data-glass-card-detail
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: 10, filter: `blur(${motionTokens.blur.soft}px)` }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, filter: "blur(0px)", transition: { ...morph, delay: .06 } }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: 6, filter: `blur(${motionTokens.blur.subtle}px)`, transition: { duration: motionTokens.duration.instant, ease: motionTokens.ease.standard } }}>
            {children}
          </motion.div> : null}
        </AnimatePresence>
      </motion.div>
    </LayoutGroup>
  </motion.div>;
}

export default GlassCard;
