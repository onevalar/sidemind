"use client";

import Image from "next/image";
import { useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { person, portrait } from "../../lib/media";
import type { PersonId } from "../../lib/media";
import { motionTokens } from "../../lib/motion-tokens";
import styles from "./testimonial-stage.module.css";

type Perspective = { id: PersonId; company: string; quote: string };

/** Sample quotes about a fictional product. Portraits come from lib/media. */
const perspectives: Perspective[] = [
  { id: "emma-collins", company: "Northwind", quote: "Feature requests used to live in three inboxes. Now they land in one place, already grouped by theme, and our Monday triage takes ten minutes." },
  { id: "marcus-johnson", company: "Halcyon", quote: "I link a trend in the pull request and the conversation is over. Nobody argues with a line that has been climbing for six weeks." },
  { id: "sofia-ramirez", company: "Juniper Health", quote: "Support and product finally read the same numbers. When a customer asks for something twice, we see it the same day." },
];

const { spring, duration, ease, blur } = motionTokens;
const enter = [...ease.enter] as [number, number, number, number];

export interface TestimonialStageProps {
  className?: string;
  onPerspectiveChange?: (perspective: { id: string; name: string }) => void;
}

/**
 * A testimonial section with a large portrait and one quote at a time. Arrows and the index step through quotes;
 * the portrait and quote travel in the direction you moved.
 */
export function TestimonialStage({ className, onPerspectiveChange }: TestimonialStageProps) {
  const reduce = !!useReducedMotion();
  const uid = useId();
  const [[activeIndex, direction], setState] = useState<[number, number]>([0, 1]);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const active = perspectives[activeIndex];
  const who = person(active.id);

  function select(index: number, dir?: number) {
    const next = (index + perspectives.length) % perspectives.length;
    if (next === activeIndex) return;
    setState([next, dir ?? (index > activeIndex ? 1 : -1)]);
    onPerspectiveChange?.({ id: perspectives[next].id, name: person(perspectives[next].id).name });
  }

  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (activeIndex + step + perspectives.length) % perspectives.length;
    select(next, step);
    tabs.current[next]?.focus();
  }

  const shift = reduce ? 0 : 12 * direction;

  return (
    <section className={[styles.stage, className].filter(Boolean).join(" ")} aria-labelledby={`${uid}-title`}>
      <div className={styles.layout}>
      <div className={styles.imageColumn}>
        <AnimatePresence initial={false}>
          <motion.div key={active.id} className={styles.imageWrap}
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 1.03 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
            transition={reduce ? { duration: duration.instant } : { opacity: { duration: duration.considered, ease: enter }, scale: { duration: duration.considered, ease: enter } }}>
            <Image src={portrait(active.id)} alt={`Portrait of ${who.name}`} fill sizes="(max-width: 680px) 100vw, 480px" priority={activeIndex === 0} />
          </motion.div>
        </AnimatePresence>
      </div>

      <div className={styles.contentColumn}>
        <h2 id={`${uid}-title`} className={styles.title}>What teams say about Beacon</h2>

        <figure className={styles.quoteArea} id={`${uid}-panel`} role="tabpanel" aria-labelledby={`${uid}-${active.id}`}>
          <div className={styles.quoteSlot}>
            <AnimatePresence initial={false}>
              <motion.blockquote key={active.id} className={styles.quote}
                initial={reduce ? { opacity: 0 } : { opacity: 0, x: shift, filter: `blur(${blur.subtle}px)` }}
                animate={{ opacity: 1, x: 0, filter: "blur(0px)", transitionEnd: { filter: "none" } }}
                exit={{ opacity: 0, transition: { duration: reduce ? 0 : duration.fast } }}
                transition={reduce ? { duration: duration.instant } : { opacity: { duration: duration.standard, ease: enter }, filter: { duration: duration.standard }, x: spring.smooth }}>
                <p>“{active.quote}”</p>
              </motion.blockquote>
            </AnimatePresence>
          </div>
          <figcaption className={styles.author}>
            <AnimatePresence initial={false}>
              <motion.span key={active.id} className={styles.authorInner} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: duration.instant } }}
                transition={reduce ? { duration: duration.instant } : { duration: duration.standard, ease: enter, delay: .06 }}>
                <span className={styles.authorName}>{who.name}</span>
                <span className={styles.authorRole}>{who.role}, {active.company}</span>
              </motion.span>
            </AnimatePresence>
          </figcaption>
        </figure>

        <div className={styles.footer}>
          <div className={styles.tabs} role="tablist" aria-label="Quotes" onKeyDown={onKey}>
            {perspectives.map((perspective, index) => {
              const selected = index === activeIndex;
              return <button key={perspective.id} ref={node => { tabs.current[index] = node; }} id={`${uid}-${perspective.id}`} type="button" role="tab"
                aria-selected={selected} aria-controls={`${uid}-panel`} aria-label={person(perspective.id).name} tabIndex={selected ? 0 : -1}
                className={styles.tab} onClick={() => select(index)}>
                <span className={styles.tabBar}>{selected && <motion.span layoutId={`${uid}-bar`} className={styles.tabFill} transition={reduce ? { duration: 0 } : spring.morph} />}</span>
              </button>;
            })}
          </div>
          <div className={styles.arrows}>
            <button type="button" className={styles.arrow} onClick={() => select(activeIndex - 1, -1)} aria-label="Previous quote"><ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" /></button>
            <button type="button" className={styles.arrow} onClick={() => select(activeIndex + 1, 1)} aria-label="Next quote"><ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" /></button>
          </div>
        </div>
      </div>
      </div>
    </section>
  );
}

export default TestimonialStage;
