"use client";

import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { motionTokens } from "../../lib/motion-tokens";
import styles from "./metric-explorer.module.css";

const { duration, ease, blur } = motionTokens;
const enterEase = [...ease.enter] as [number, number, number, number];
const standardEase = [...ease.standard] as [number, number, number, number];

export type Layer<K extends string> = { key: K; node: ReactNode };

/**
 * Every variant stays mounted in one grid cell and only the active one shows. The slot keeps the size of its widest
 * variant, so a switch never reflows the line, and the CSS transitions retarget mid-flight when switches come quickly.
 * `previous` leaves upward while the active copy rises out of a small blur.
 */
export function Layers<K extends string>({ active, previous, items, className }: { active: K; previous?: K | null; items: Layer<K>[]; className?: string }) {
  return <span className={className ? `${styles.layers} ${className}` : styles.layers}>
    {items.map(({ key, node }) => {
      const state = key === active ? "on" : key === previous ? "out" : "idle";
      return <span key={key} className={styles.layer} data-state={state} aria-hidden={state === "on" ? undefined : true}>{node}</span>;
    })}
  </span>;
}

/**
 * Copy keyed by `id` crossfades in place. Old and new copies share one grid cell while they overlap, so nothing
 * around them moves; the old copy unmounts once it has faded.
 */
export function Swap({ id, children, delay = 0 }: { id: string; children: ReactNode; delay?: number }) {
  const reduce = !!useReducedMotion();
  return <span className={styles.swap}>
    <AnimatePresence initial={false}>
      <motion.span key={id} className={styles.swapItem}
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: "0.3em", filter: `blur(${blur.soft}px)` }}
        animate={{ opacity: 1, y: "0em", filter: "blur(0px)", transitionEnd: { filter: "none" } }}
        exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, filter: `blur(${blur.subtle}px)`, transition: { duration: duration.fast, ease: standardEase } }}
        transition={reduce ? { duration: duration.instant } : { duration: duration.standard, ease: enterEase, delay }}>{children}</motion.span>
    </AnimatePresence>
  </span>;
}
