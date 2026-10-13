"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, type Variants } from "motion/react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./multi-step-form.module.css";

export type FormStep = { id: string; title: string; description?: string; content: ReactNode };
export type MultiStepFormProps = { steps: FormStep[]; onComplete?: () => void; nextLabel?: string; completeLabel?: string; initialStep?: number };
const exitFade = { duration: motionTokens.duration.instant, ease: [...motionTokens.ease.standard] } as const;
const stepVariants: Variants = {
  enter: (direction: number) => ({ opacity: 0, x: 20 * direction }),
  center: { opacity: 1, x: 0 },
  exit: (direction: number) => ({ opacity: 0, x: -20 * direction, transition: { x: motionTokens.spring.smooth, opacity: exitFade } }),
};
/** Short text that changes with state rises in with a soft blur; the old text leaves the opposite way, faster. */
const textVariants: Variants = {
  enter: (direction = 1) => ({ opacity: 0, y: `${.3 * direction}em`, filter: `blur(${motionTokens.blur.soft}px)` }),
  center: { opacity: 1, y: 0, filter: "blur(0px)" },
  exit: (direction = 1) => ({ opacity: 0, y: `${-.3 * direction}em`, filter: `blur(${motionTokens.blur.subtle}px)`, transition: exitFade }),
};
const textEnter = { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] } as const;

function SwapText({ value, direction = 1, reduced, className }: { value: ReactNode; direction?: number; reduced: boolean; className?: string }) {
  return <span className={`${styles.swap} ${className ?? ""}`} aria-hidden="true"><AnimatePresence initial={false} custom={direction}>
    <motion.span key={String(value)} custom={direction} variants={textVariants} initial={reduced ? false : "enter"} animate="center" exit={reduced ? undefined : "exit"} transition={reduced ? { duration: 0 } : textEnter}>{value}</motion.span>
  </AnimatePresence></span>;
}

/** The submit label changes on the last step; the button follows the new text width on a spring instead of snapping.
 * At rest the width is auto, so a late web font or a new locale can never clip the label. */
function MorphLabel({ label, reduced }: { label: string; reduced: boolean }) {
  const sizer = useRef<HTMLSpanElement>(null);
  const rest = useRef(0);
  const width = useMotionValue<number | "auto">("auto");
  useEffect(() => {
    const node = sizer.current;
    if (!node) return;
    const observer = new ResizeObserver(() => { rest.current = node.offsetWidth; });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const moving = width.get(), to = sizer.current?.offsetWidth ?? 0;
    const from = typeof moving === "number" ? moving : rest.current;
    rest.current = to;
    if (reduced || !from || !to || Math.abs(from - to) < 1) { width.jump("auto"); return; }
    width.jump(from);
    const controls = animate(width, to, { ...motionTokens.spring.morph, onComplete: () => width.jump("auto") });
    return () => controls.stop();
  }, [label, reduced, width]);
  return <span className={styles.morph}>
    <span ref={sizer} className={styles.sizer} aria-hidden="true">{label}</span>
    <motion.span className={styles.morphBox} style={{ width }}><SwapText value={label} reduced={reduced} /></motion.span>
    <span className={styles.srOnly}>{label}</span>
  </span>;
}

export function MultiStepForm({ steps, onComplete, nextLabel = "Continue", completeLabel = "Finish", initialStep = 0 }: MultiStepFormProps) {
  const [step, setStep] = useState(Math.min(Math.max(initialStep, 0), Math.max(steps.length - 1, 0)));
  const [direction, setDirection] = useState(1);
  const [complete, setComplete] = useState(false);
  const [height, setHeight] = useState<number | "auto">("auto");
  const stepTitleRef = useRef<HTMLLegendElement | null>(null);
  const successTitleRef = useRef<HTMLHeadingElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef(false);
  const successId = useId();
  const reduced = useReducedMotion() ?? false;

  useEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    (complete ? successTitleRef.current : stepTitleRef.current)?.focus();
  }, [complete, step]);

  // The shell follows the height of the step that is arriving, so a taller or shorter step never jumps the actions.
  const measure = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setHeight(entry.borderBoxSize?.[0]?.blockSize ?? node.offsetHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  if (!steps.length) return null;
  const current = steps[step];
  const last = step === steps.length - 1;
  const slide = reduced ? { duration: 0 } : { x: motionTokens.spring.smooth, opacity: textEnter };
  const clip = (value: boolean) => { if (viewportRef.current) viewportRef.current.dataset.resizing = String(value); };

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    pendingFocus.current = true;
    if (last) { setComplete(true); onComplete?.(); }
    else { setDirection(1); setStep(value => value + 1); }
  }
  return <form className={styles.form} onSubmit={submit} aria-label="Multi-step form">
    <nav className={styles.progress} aria-label={`Progress: step ${step + 1} of ${steps.length}`}>
      <ol className={styles.progressList}>
        {steps.map((item, index) => <li className={`${styles.progressItem} ${index < step || (complete && index === step) ? styles.complete : ""} ${index === step && !complete ? styles.current : ""}`} key={item.id} aria-current={index === step ? "step" : undefined}>
          <span className={styles.progressMarker} aria-hidden="true"><AnimatePresence initial={false}>
            {index < step || (complete && index === step)
              ? <motion.svg key="done" className={styles.markerGlyph} viewBox="0 0 24 24" width={11} height={11} fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" initial={reduced ? false : { opacity: 0, scale: .6 }} animate={{ opacity: 1, scale: 1 }} exit={reduced ? undefined : { opacity: 0, scale: .6, transition: exitFade }} transition={reduced ? { duration: 0 } : motionTokens.spring.snappy}>
                <motion.path d="M4 12.5 9 17.5 20 6.5" initial={reduced ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={reduced ? { duration: 0 } : { duration: .32, ease: [...motionTokens.ease.enter], delay: .04 }} />
              </motion.svg>
              : <motion.span key="number" className={styles.markerGlyph} initial={reduced ? false : { opacity: 0, scale: .6, filter: `blur(${motionTokens.blur.subtle}px)` }} animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }} exit={reduced ? undefined : { opacity: 0, scale: .6, transition: exitFade }} transition={reduced ? { duration: 0 } : motionTokens.spring.snappy}>{index + 1}</motion.span>}
          </AnimatePresence></span>
          <span className={styles.progressLabel} data-label={item.title}>{item.title}</span>
        </li>)}
      </ol>
      <span className={styles.progressCount} aria-hidden="true">Step <SwapText value={step + 1} direction={direction} reduced={reduced} className={styles.countValue} /> of {steps.length}</span>
      <span className={styles.srOnly} aria-live="polite">Step {step + 1} of {steps.length}</span>
    </nav>
    <motion.div ref={viewportRef} className={styles.viewport} initial={false} animate={{ height }} transition={reduced ? { duration: 0 } : motionTokens.spring.smooth} onAnimationStart={() => clip(true)} onAnimationComplete={() => clip(false)}>
      <AnimatePresence initial={false} custom={direction}>
        {complete
          ? <motion.section ref={measure} key="complete" className={styles.success} initial={reduced ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={reduced ? { duration: 0 } : { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] }} aria-labelledby={successId} role="status">
            <span className={styles.successIcon} aria-hidden="true"><svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><motion.path d="M4 12.5 9 17.5 20 6.5" initial={reduced ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={reduced ? { duration: 0 } : { duration: .4, ease: [...motionTokens.ease.enter], delay: .08 }} /></svg></span>
            <motion.h2 id={successId} ref={successTitleRef} tabIndex={-1} initial={reduced ? false : { opacity: 0, y: "0.3em", filter: `blur(${motionTokens.blur.soft}px)` }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} transition={reduced ? { duration: 0 } : { ...textEnter, delay: .1 }}>All set</motion.h2>
            <motion.p className={styles.successNote} initial={reduced ? false : { opacity: 0, y: "0.3em" }} animate={{ opacity: 1, y: 0 }} transition={reduced ? { duration: 0 } : { ...textEnter, delay: .1 + motionTokens.stagger.word }}>Your response has been saved.</motion.p>
          </motion.section>
          : <motion.fieldset ref={measure} key={current.id} className={styles.step} custom={direction} variants={stepVariants} initial={reduced ? false : "enter"} animate="center" exit={reduced ? undefined : "exit"} transition={slide}>
            <legend ref={(node: HTMLLegendElement | null) => { if (node) stepTitleRef.current = node; }} tabIndex={-1}>{current.title}</legend>
            {current.description && <p className={styles.description}>{current.description}</p>}<div className={styles.content}>{current.content}</div>
          </motion.fieldset>}
      </AnimatePresence>
    </motion.div>
    <AnimatePresence initial={false}>
      {!complete && <motion.div key="actions" className={styles.actionsShell} exit={reduced ? undefined : { opacity: 0, height: 0, overflow: "hidden", transition: { height: motionTokens.spring.smooth, opacity: exitFade } }}>
        <div className={styles.actions}><button className={styles.back} type="button" onClick={() => { pendingFocus.current = true; setDirection(-1); setStep(value => Math.max(0, value - 1)); }} disabled={step === 0}><ArrowLeft aria-hidden="true" width={16} height={16} /> Back</button><button className={styles.next} type="submit"><MorphLabel label={last ? completeLabel : nextLabel} reduced={reduced} /><ArrowRight aria-hidden="true" width={16} height={16} /></button></div>
      </motion.div>}
    </AnimatePresence>
  </form>;
}

export default MultiStepForm;
