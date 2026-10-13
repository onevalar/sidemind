"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, RefObject } from "react";
import Image from "next/image";
import { AnimatePresence, LayoutGroup, animate, motion, useInView, useMotionTemplate, useMotionValue, useReducedMotion, useSpring, useTransform } from "motion/react";
import type { MotionStyle, MotionValue, Transition } from "motion/react";
import { Check, LoaderCircle, Rocket, X } from "lucide-react";
import { AnimatedCounter } from "../../animated-counter/animated-counter";
import { avatar, person } from "../../lib/media";
import type { PersonId } from "../../lib/media";
import { motionTokens } from "../../lib/motion-tokens";
import styles from "./spotlight-grid.module.css";

type CardId = "latency" | "deploys" | "flags" | "review";
type Range = "24h" | "7d" | "30d";
type Deploy = { id: number; message: string; who: PersonId; when: string };
type Bezier = [number, number, number, number];

const { spring, duration, blur } = motionTokens;
const enter = [...motionTokens.ease.enter] as Bezier;
const inOut = [...motionTokens.ease.inOut] as Bezier;
const standard = [...motionTokens.ease.standard] as Bezier;

/** Duration based springs restated as stiffness and damping, so a morph interrupted mid flight keeps its velocity. */
const physical = (visualDuration: number, bounce: number): Transition => {
  const root = 2 * Math.PI / (visualDuration * 1.2);
  return { type: "spring", stiffness: root * root, damping: 2 * (1 - bounce) * root, mass: 1 };
};
/** Opening carries a little life; closing settles without overshoot. */
const GROW = physical(.5, .12), SHRINK = physical(.4, 0);
const CARD_RADIUS = 28, DETAIL_RADIUS = 32, ONE_COLUMN = 520;

const CARDS: { id: CardId; title: string; blurb: string; wide?: boolean }[] = [
  { id: "latency", title: "Latency, as it happens", blurb: "Every route traced from the edge, with p95 updated each minute.", wide: true },
  { id: "deploys", title: "Deploys on autopilot", blurb: "Merges to main ship on their own once checks pass." },
  { id: "flags", title: "Flags without redeploys", blurb: "Release to a slice of traffic and widen it when it holds." },
  { id: "review", title: "Review in the preview", blurb: "Comments pin to the page your team is actually looking at.", wide: true },
];

/* ---------- Data ---------- */

/** Deterministic wave, so the server and the browser draw the same line. */
function wave(seed: number, count: number, base: number, spread: number) {
  return Array.from({ length: count }, (_, i) => {
    const t = i + seed * 7.3;
    return Math.round(base + spread * (.45 * Math.sin(t * .55) + .3 * Math.sin(t * 1.37 + seed) + .25 * Math.sin(t * 2.9 + seed * 2)));
  });
}
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(p * values.length) - 1)];
const f = (n: number) => n.toFixed(1);
const yOf = (value: number, h: number, min: number, max: number, pad = 8) => pad + (1 - (value - min) / (max - min)) * (h - pad * 2);
/** A smooth line with the same command count for every series of the same length, so one path can morph into another. */
function linePath(values: number[], w: number, h: number, min: number, max: number) {
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, yOf(v, h, min, max)]);
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? p2;
    d += ` C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}

const LIVE = wave(4, 72, 124, 56);
const RANGES: Record<Range, { values: number[]; axis: [string, string, string]; errors: string }> = {
  "24h": { values: wave(1, 32, 128, 64), axis: ["12 AM", "12 PM", "Now"], errors: "0.02%" },
  "7d": { values: wave(2, 32, 150, 84), axis: ["Sep 16", "Sep 20", "Now"], errors: "0.04%" },
  "30d": { values: wave(3, 32, 138, 52), axis: ["Aug 24", "Sep 8", "Now"], errors: "0.03%" },
};
const RANGE_OPTIONS = (Object.keys(RANGES) as Range[]).map(value => ({ value, label: value }));

const START_COUNT = 1284;
const SHIPS: { message: string; who: PersonId }[] = [
  { message: "Cache product images at the edge", who: "marcus-johnson" },
  { message: "Fix double submit on checkout", who: "olivia-bennett" },
  { message: "Retry failed webhook deliveries", who: "daniel-kim" },
  { message: "Tighten hero spacing on pricing", who: "emma-collins" },
];
const FIRST_DEPLOYS: Deploy[] = [
  { id: 3, message: "Move session store to the new region", who: "olivia-bennett", when: "4 min ago" },
  { id: 2, message: "Add empty state to invoices", who: "emma-collins", when: "18 min ago" },
  { id: 1, message: "Bump image optimizer to 2.4", who: "daniel-kim", when: "1 hr ago" },
];
const sha = (id: number) => ((id * 2654435761) >>> 0).toString(16).padStart(8, "0").slice(0, 7);
const tickHeight = (id: number) => 10 + ((id * 7) % 13) * 1.6;

const DAILY_VISITORS = 48200;
const ROLLOUTS = [{ value: "5", label: "5%" }, { value: "25", label: "25%" }, { value: "100", label: "100%" }];

const REVIEWERS: PersonId[] = ["jasmine-brooks", "marcus-johnson", "chloe-nguyen", "daniel-kim"];
const COMMENTS: { who: PersonId; text: string; when: string }[] = [
  { who: "jasmine-brooks", text: "Tighten the hero spacing on mobile, it crowds the fold.", when: "9 min ago" },
  { who: "marcus-johnson", text: "Checkout button matches the new radius now. Looks right.", when: "6 min ago" },
  { who: "chloe-nguyen", text: "Conversion event fires once per order. Verified here.", when: "2 min ago" },
];

/* ---------- Shared pieces ---------- */

const subscribe = () => () => {};
function useReducedFlag() {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

/** Copy keyed by its text crossfades in place when it changes. */
function Swap({ text, reduced, className }: { text: string; reduced: boolean; className?: string }) {
  return <span className={styles.swap}>
    <AnimatePresence initial={false} mode="popLayout">
      <motion.span key={text} className={className}
        initial={reduced ? { opacity: 0 } : { opacity: 0, y: "0.35em", filter: `blur(${blur.subtle}px)` }}
        animate={{ opacity: 1, y: "0em", filter: "blur(0px)", transitionEnd: { filter: "none" } }}
        exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: "-0.35em", filter: `blur(${blur.subtle}px)`, transition: { duration: duration.fast } }}
        transition={reduced ? { duration: duration.instant } : { duration: duration.standard, ease: enter }}>{text}</motion.span>
    </AnimatePresence>
  </span>;
}

function Num({ value }: { value: number }) {
  return <span className={styles.num}><AnimatedCounter value={value} /></span>;
}

function Avatar({ id, size = 24, className }: { id: PersonId; size?: number; className?: string }) {
  return <Image className={[styles.avatar, className].filter(Boolean).join(" ")} src={avatar(id)} alt="" width={size} height={size} sizes={`${size}px`} />;
}

/** A radio group drawn as a segmented control. The highlight glides to the chosen option; arrow keys move and select. */
function Segmented({ label, options, value, onChange, disabled, reduced, pillId }: { label: string; options: { value: string; label: string }[]; value: string; onChange: (value: string) => void; disabled?: boolean; reduced: boolean; pillId: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return <div className={styles.segmented} role="radiogroup" aria-label={label} aria-disabled={disabled || undefined}>
    {options.map((option, index) => {
      const checked = option.value === value;
      return <button key={option.value} ref={node => { refs.current[index] = node; }} type="button" role="radio" aria-checked={checked} tabIndex={checked ? 0 : -1}
        disabled={disabled} className={styles.segment} onClick={() => onChange(option.value)} onKeyDown={event => onKey(event, index)}>
        {checked && <motion.span layoutId={pillId} className={styles.segmentPill} transition={reduced ? { duration: 0 } : spring.morph} />}
        <span className={styles.segmentLabel}>{option.label}</span>
      </button>;
    })}
  </div>;
}

/* ---------- Mini demos, shown inside the grid ---------- */

const MINI_W = 320, MINI_H = 84, MINI_MIN = 50, MINI_MAX = 210;

function LatencyMini({ active, seen, reduced }: { active: boolean; seen: boolean; reduced: boolean }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active || reduced) return;
    const timer = window.setInterval(() => setTick(value => value + 1), 1100);
    return () => window.clearInterval(timer);
  }, [active, reduced]);
  const values = Array.from({ length: 24 }, (_, i) => LIVE[(tick + i) % LIVE.length]);
  const d = linePath(values, MINI_W, MINI_H, MINI_MIN, MINI_MAX);
  const top = yOf(values[values.length - 1], MINI_H, MINI_MIN, MINI_MAX) / MINI_H * 100;
  const move = reduced ? { duration: 0 } : { duration: .7, ease: inOut };
  return <div className={styles.latencyMini}>
    <div className={styles.miniHead}>
      <span className={styles.miniLabel}>p95</span>
      <span className={styles.miniValue}><Num value={percentile(values, .95)} /> ms</span>
      <span className={styles.live} data-on={active || undefined}>Live</span>
    </div>
    <div className={styles.spark}>
      <svg viewBox={`0 0 ${MINI_W} ${MINI_H}`} preserveAspectRatio="none" className={styles.sparkSvg}>
        <motion.path d={d} className={styles.sparkLine} vectorEffect="non-scaling-stroke"
          initial={reduced ? false : { d, pathLength: 0 }}
          animate={{ d, pathLength: reduced || seen ? 1 : 0 }}
          transition={{ d: move, pathLength: reduced ? { duration: 0 } : { duration: 1.3, ease: enter, delay: .15 } }} />
      </svg>
      <motion.span className={styles.sparkDot} initial={false} animate={{ top: `${top}%`, opacity: reduced || seen ? 1 : 0, scale: reduced || seen ? 1 : .6 }}
        transition={{ top: move, opacity: { duration: .2, delay: reduced ? 0 : 1.2 }, scale: reduced ? { duration: 0 } : { ...spring.snappy, delay: 1.2 } }} />
    </div>
  </div>;
}

function DeploysMini({ count, seen, reduced }: { count: number; seen: boolean; reduced: boolean }) {
  const ids = Array.from({ length: 18 }, (_, i) => count - 17 + i);
  const first = count === START_COUNT;
  return <div className={styles.deploysMini}>
    <div className={styles.bigStat}>
      <span className={styles.bigNum}><Num value={count} /></span>
      <span className={styles.caption}>deploys this week</span>
    </div>
    <div className={styles.ticks}>
      <AnimatePresence initial={false} mode="popLayout">
        {ids.map((id, i) => <motion.span key={id} layout={!reduced} className={styles.tick} data-new={id === count || undefined} style={{ height: tickHeight(id) }}
          initial={{ opacity: 0, scaleY: .2 }} animate={{ opacity: reduced || seen ? 1 : 0, scaleY: reduced || seen ? 1 : .2 }} exit={{ opacity: 0, scaleY: .2, transition: { duration: duration.fast } }}
          transition={reduced ? { duration: 0 } : { ...spring.snappy, delay: first ? .1 + i * .025 : 0 }} />)}
      </AnimatePresence>
    </div>
  </div>;
}

function FlagsMini({ active, reduced }: { active: boolean; reduced: boolean }) {
  const on = active || reduced;
  return <div className={styles.flagsMini}>
    <div className={styles.flagRow}>
      <code className={styles.flagKey}>new-checkout</code>
      <span className={styles.switchTrack} data-on={on || undefined} data-size="sm">
        <motion.span className={styles.switchThumb} initial={false} animate={{ x: on ? 14 : 0 }} transition={reduced ? { duration: 0 } : spring.snappy} />
      </span>
    </div>
    <div className={styles.meter}>
      <motion.span className={styles.meterFill} initial={false} animate={{ scaleX: on ? .25 : 0 }} transition={reduced ? { duration: 0 } : { ...spring.morph, delay: on ? .08 : 0 }} />
    </div>
    <span className={styles.caption}><Swap text={on ? "25% of traffic" : "Off for everyone"} reduced={reduced} /></span>
  </div>;
}

function ReviewMini({ active, reduced }: { active: boolean; reduced: boolean }) {
  const shown = active || reduced;
  return <div className={styles.reviewMini}>
    <div className={styles.page}>
      <span className={styles.pageBar} />
      <span className={styles.pageHero} />
      <span className={styles.pageLine} />
      <span className={styles.pageLine} data-short="" />
      <AnimatePresence initial={false}>
        {shown && <motion.span className={styles.pin}
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: -8, scale: .92 }} animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, scale: .96, transition: { duration: duration.fast, ease: standard } }}
          transition={reduced ? { duration: 0 } : spring.snappy}>
          <Avatar id="jasmine-brooks" size={20} />
          <span>Tighten the hero spacing?</span>
        </motion.span>}
      </AnimatePresence>
    </div>
    <div className={styles.stack}>
      {REVIEWERS.map(id => <Avatar key={id} id={id} size={26} />)}
    </div>
  </div>;
}

/* ---------- Details, shown when a card opens ---------- */

const CH_W = 640, CH_H = 200, CH_MIN = 40, CH_MAX = 250;

function LatencyDetail({ reduced, pillId }: { reduced: boolean; pillId: string }) {
  const [range, setRange] = useState<Range>("24h");
  const { values, axis, errors } = RANGES[range];
  const line = linePath(values, CH_W, CH_H, CH_MIN, CH_MAX);
  const area = `${line} L${CH_W} ${CH_H} L0 ${CH_H} Z`;
  const p95 = percentile(values, .95), p50 = percentile(values, .5);
  const p95y = yOf(p95, CH_H, CH_MIN, CH_MAX);
  const move = reduced ? { duration: 0 } : { duration: .6, ease: inOut };
  return <div className={styles.detailStack}>
    <div className={styles.detailRow}>
      <dl className={styles.stats}>
        <div><dt>p95</dt><dd><Num value={p95} /> ms</dd></div>
        <div><dt>p50</dt><dd><Num value={p50} /> ms</dd></div>
        <div><dt>Errors</dt><dd><Swap text={errors} reduced={reduced} /></dd></div>
      </dl>
      <Segmented label="Time range" options={RANGE_OPTIONS} value={range} onChange={value => setRange(value as Range)} reduced={reduced} pillId={pillId} />
    </div>
    <div className={styles.chart}>
      <svg viewBox={`0 0 ${CH_W} ${CH_H}`} preserveAspectRatio="none" className={styles.chartSvg} role="img" aria-label={`Latency over ${range}, p95 ${p95} milliseconds`}>
        {[.25, .5, .75].map(at => <line key={at} x1="0" x2={CH_W} y1={CH_H * at} y2={CH_H * at} className={styles.gridLine} vectorEffect="non-scaling-stroke" />)}
        <motion.path d={area} className={styles.chartArea} initial={false} animate={{ d: area }} transition={move} />
        <motion.line x1="0" x2={CH_W} y1={p95y} y2={p95y} className={styles.p95Line} vectorEffect="non-scaling-stroke" initial={false} animate={{ y1: p95y, y2: p95y }} transition={move} />
        <motion.path d={line} className={styles.chartLine} vectorEffect="non-scaling-stroke" initial={false} animate={{ d: line }} transition={move} />
      </svg>
      <div className={styles.axis} aria-hidden="true">{axis.map((label, i) => <Swap key={i} text={label} reduced={reduced} />)}</div>
    </div>
  </div>;
}

function DeploysDetail({ count, recent, onShip, reduced }: { count: number; recent: Deploy[]; onShip: () => void; reduced: boolean }) {
  const [phase, setPhase] = useState<"idle" | "shipping" | "shipped">("idle");
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(timer => window.clearTimeout(timer)), []);
  const ship = () => {
    if (phase !== "idle") return;
    setPhase("shipping");
    timers.current.push(window.setTimeout(() => {
      onShip();
      setPhase("shipped");
      timers.current.push(window.setTimeout(() => setPhase("idle"), 1400));
    }, reduced ? 400 : 1100));
  };
  return <div className={styles.detailStack}>
    <div className={styles.detailRow}>
      <div className={styles.bigStat}>
        <span className={styles.bigNum}><Num value={count} /></span>
        <span className={styles.caption}>deploys this week, all checks passing</span>
      </div>
      <button type="button" className={styles.primary} onClick={ship} aria-disabled={phase !== "idle" || undefined} data-state={phase}>
        <span className={styles.labels}>
          <span data-on={phase === "idle" || undefined} aria-hidden={phase !== "idle" || undefined}><Rocket size={16} strokeWidth={1.75} aria-hidden="true" />Ship a deploy</span>
          <span data-on={phase === "shipping" || undefined} aria-hidden={phase !== "shipping" || undefined}><LoaderCircle className={styles.spin} size={16} strokeWidth={1.75} aria-hidden="true" />Deploying</span>
          <span data-on={phase === "shipped" || undefined} aria-hidden={phase !== "shipped" || undefined}><Check size={16} strokeWidth={1.75} aria-hidden="true" />Shipped</span>
        </span>
      </button>
    </div>
    <ol className={styles.deployList} aria-label="Recent deploys">
      <AnimatePresence initial={false} mode="popLayout">
        {recent.map(deploy => <motion.li key={deploy.id} layout={!reduced} className={styles.deployRow}
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: -10, filter: `blur(${blur.subtle}px)` }} animate={{ opacity: 1, y: 0, filter: "blur(0px)", transitionEnd: { filter: "none" } }}
          exit={{ opacity: 0, transition: { duration: duration.fast } }} transition={reduced ? { duration: 0 } : spring.smooth}>
          <Avatar id={deploy.who} />
          <span className={styles.deployText}>
            <span className={styles.deployMessage}>{deploy.message}</span>
            <span className={styles.deployMeta}>{person(deploy.who).name} · <code>{sha(deploy.id)}</code></span>
          </span>
          <span className={styles.deployWhen} data-new={deploy.when === "Just now" || undefined}>{deploy.when}</span>
        </motion.li>)}
      </AnimatePresence>
    </ol>
    <p className={styles.srOnly} aria-live="polite">{phase === "shipped" ? "Deploy shipped" : ""}</p>
  </div>;
}

function FlagsDetail({ on, rollout, setOn, setRollout, reduced, pillId }: { on: boolean; rollout: number; setOn: (on: boolean) => void; setRollout: (value: number) => void; reduced: boolean; pillId: string }) {
  const share = on ? rollout : 0;
  return <div className={styles.detailStack}>
    <div className={styles.detailRow}>
      <div className={styles.flagInfo}>
        <span className={styles.flagTitle} id={`${pillId}-name`}>New checkout</span>
        <span className={styles.caption}><code className={styles.flagKey}>new-checkout</code> in production</span>
      </div>
      <button type="button" role="switch" aria-checked={on} aria-labelledby={`${pillId}-name`} className={styles.switchTrack} data-on={on || undefined} onClick={() => setOn(!on)}>
        <motion.span className={styles.switchThumb} initial={false} animate={{ x: on ? 20 : 0 }} transition={reduced ? { duration: 0 } : spring.snappy} />
      </button>
    </div>
    <div className={styles.detailRow}>
      <span className={styles.caption}>Rollout</span>
      <Segmented label="Rollout" options={ROLLOUTS} value={String(rollout)} onChange={value => setRollout(Number(value))} disabled={!on} reduced={reduced} pillId={pillId} />
    </div>
    <div className={styles.meter} data-size="lg">
      <motion.span className={styles.meterFill} initial={false} animate={{ scaleX: share / 100 }} transition={reduced ? { duration: 0 } : spring.morph} />
    </div>
    <p className={styles.flagSummary}><Num value={Math.round(DAILY_VISITORS * share / 100)} /> <span>visitors a day see it</span></p>
    <p className={styles.footnote}>Changes apply without a redeploy.</p>
  </div>;
}

function ReviewDetail({ approved, setApproved, reduced }: { approved: boolean; setApproved: (value: boolean) => void; reduced: boolean }) {
  return <div className={styles.detailStack}>
    <div className={styles.detailRow}>
      <div className={styles.reviewStatus} data-approved={approved || undefined}>
        <span className={styles.statusDot} aria-hidden="true" />
        <Swap text={approved ? "Ready to merge" : "Waiting on your review"} reduced={reduced} />
        <span className={styles.caption}><Num value={approved ? 3 : 2} /> of 3 approvals</span>
      </div>
      <button type="button" className={styles.approve} aria-pressed={approved} data-on={approved || undefined} onClick={() => setApproved(!approved)}>
        <span className={styles.labels}>
          <span data-on={!approved || undefined} aria-hidden={approved || undefined}>Approve</span>
          <span data-on={approved || undefined} aria-hidden={!approved || undefined}><Check size={16} strokeWidth={1.75} aria-hidden="true" />Approved</span>
        </span>
      </button>
    </div>
    <ul className={styles.comments}>
      {COMMENTS.map(comment => <li key={comment.who} className={styles.comment}>
        <Avatar id={comment.who} size={28} />
        <span className={styles.commentBody}>
          <span className={styles.commentHead}><span className={styles.commentName}>{person(comment.who).name}</span><span className={styles.caption}>{comment.when}</span></span>
          <span className={styles.commentText}>{comment.text}</span>
        </span>
      </li>)}
    </ul>
    <p className={styles.srOnly} aria-live="polite">{approved ? "Approved. Ready to merge." : ""}</p>
  </div>;
}

/* ---------- Grid card ---------- */

interface CardProps {
  card: (typeof CARDS)[number];
  gridRef: RefObject<HTMLDivElement | null>;
  sx: MotionValue<number>;
  sy: MotionValue<number>;
  lit: MotionValue<number>;
  isOpen: boolean;
  anyOpen: boolean;
  front: boolean;
  reduced: boolean;
  detailId: string;
  onOpen: () => void;
  mini: (active: boolean) => ReactNode;
}

function Card({ card, gridRef, sx, sy, lit, isOpen, anyOpen, front, reduced, detailId, onOpen, mini }: CardProps) {
  const ref = useRef<HTMLElement>(null);
  const blurbId = useId();
  const ox = useMotionValue(0), oy = useMotionValue(0);
  const x = useTransform(() => sx.get() - ox.get()), y = useTransform(() => sy.get() - oy.get());
  const style = { "--x": useMotionTemplate`${x}px`, "--y": useMotionTemplate`${y}px`, "--lit": lit } as unknown as MotionStyle;
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);

  useLayoutEffect(() => {
    const node = ref.current, grid = gridRef.current;
    if (!node || !grid) return;
    const read = () => { ox.set(node.offsetLeft); oy.set(node.offsetTop); };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(grid);
    observer.observe(node);
    return () => observer.disconnect();
  }, [gridRef, ox, oy]);

  const active = (hover || focus) && !anyOpen;
  const hovered = hover && !anyOpen;
  return <motion.article ref={ref} className={styles.card} data-card={card.id} data-wide={card.wide || undefined} data-front={front || undefined} data-open={isOpen || undefined} data-hovered={hovered || undefined}
    style={style}
    onPointerEnter={event => { if (event.pointerType === "mouse") setHover(true); }} onPointerLeave={() => setHover(false)}>
    {isOpen
      ? <div className={styles.surface} data-ghost="" />
      : <motion.div layoutId={reduced ? undefined : `surface-${card.id}`} className={styles.surface} style={{ borderRadius: CARD_RADIUS }} transition={SHRINK} />}
    <span className={styles.wash} aria-hidden="true" />
    <span className={styles.light} aria-hidden="true" />
    <motion.div className={styles.stage} aria-hidden="true" initial={false} animate={{ opacity: isOpen ? 0 : 1 }}
      transition={{ duration: isOpen ? duration.instant : duration.standard, delay: isOpen || reduced ? 0 : duration.fast }}>{mini(active)}</motion.div>
    <div className={styles.copy}>
      <h3 className={styles.cardTitle}>
        <button type="button" className={styles.cardButton} aria-expanded={isOpen} aria-controls={isOpen ? detailId : undefined} aria-describedby={blurbId}
          onClick={() => { setHover(false); onOpen(); }} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}>
          {isOpen
            ? <span className={styles.titleText} data-hidden="">{card.title}</span>
            : <motion.span layoutId={reduced ? undefined : `title-${card.id}`} layout="position" className={styles.titleText} transition={SHRINK}>{card.title}</motion.span>}
        </button>
      </h3>
      <motion.p id={blurbId} className={styles.blurb} initial={false} animate={{ opacity: isOpen ? 0 : 1 }}
        transition={{ duration: isOpen ? duration.instant : duration.standard, delay: isOpen || reduced ? 0 : duration.fast }}>{card.blurb}</motion.p>
    </div>
  </motion.article>;
}

/* ---------- Block ---------- */

/**
 * A marketing feature grid. A soft light follows the pointer along the card borders, each card previews its feature with a
 * small live demo on hover, and opening a card morphs it into a working detail view in place.
 */
export function SpotlightGrid() {
  const reduced = useReducedFlag();
  const uid = useId();
  const headingId = `${uid}-heading`, detailId = `${uid}-detail`, detailTitleId = `${uid}-detail-title`;
  const arenaRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const seen = useInView(gridRef, { once: true, amount: .3 });

  const [open, setOpen] = useState<CardId | null>(null);
  const [front, setFront] = useState<CardId | null>(null);
  const [anchor, setAnchor] = useState({ top: 0, minHeight: 0 });
  const [detailHeight, setDetailHeight] = useState(0);

  const [count, setCount] = useState(START_COUNT);
  const [recent, setRecent] = useState<Deploy[]>(FIRST_DEPLOYS);
  const [flagOn, setFlagOn] = useState(false);
  const [rollout, setRollout] = useState(25);
  const [approved, setApproved] = useState(false);

  /* Spotlight: the pointer inside the grid, smoothed, shared by every card. */
  const mx = useMotionValue(-9999), my = useMotionValue(-9999);
  const sx = useSpring(mx, { stiffness: 380, damping: 40 }), sy = useSpring(my, { stiffness: 380, damping: 40 });
  const lit = useMotionValue(0);
  const track = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse" || reduced || open) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left, py = event.clientY - rect.top;
    if (lit.get() < .05) { mx.jump(px); my.jump(py); sx.jump(px); sy.jump(py); }
    else { mx.set(px); my.set(py); }
    if (lit.get() < 1) animate(lit, 1, { duration: duration.standard, ease: enter });
  };
  const release = () => animate(lit, 0, { duration: duration.considered, ease: standard });

  const tickDeploys = useCallback(() => setCount(value => value + 1), []);
  const ship = useCallback(() => {
    setCount(value => value + 1);
    setRecent(list => {
      const id = (list[0]?.id ?? 0) + 1, pick = SHIPS[id % SHIPS.length];
      return [{ id, message: pick.message, who: pick.who, when: "Just now" }, ...list.map(item => item.when === "Just now" ? { ...item, when: "1 min ago" } : item)].slice(0, 4);
    });
  }, []);

  const pendingFocus = useRef<CardId | null>(null);
  const openCard = (id: CardId) => {
    const arena = arenaRef.current, grid = gridRef.current;
    const node = grid?.querySelector<HTMLElement>(`[data-card="${id}"]`);
    if (!arena || !grid || !node) return;
    const top = arena.offsetWidth < ONE_COLUMN ? node.offsetTop : 0;
    setAnchor({ top, minHeight: grid.offsetHeight - top });
    release();
    setFront(id);
    setOpen(id);
  };
  const close = useCallback(() => {
    pendingFocus.current = open;
    setOpen(null);
  }, [open]);

  useLayoutEffect(() => {
    if (open) { closeRef.current?.focus({ preventScroll: true }); return; }
    const id = pendingFocus.current;
    pendingFocus.current = null;
    if (id) gridRef.current?.querySelector<HTMLElement>(`[data-card="${id}"] button`)?.focus({ preventScroll: true });
  }, [open]);

  const measureDetail = useCallback((node: HTMLDivElement | null) => {
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setDetailHeight(node.offsetHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close, open]);

  const minis: Record<CardId, (active: boolean) => ReactNode> = {
    latency: active => <LatencyMini active={active} seen={seen} reduced={reduced} />,
    deploys: active => <DeployTicker active={active} reduced={reduced} onTick={tickDeploys}><DeploysMini count={count} seen={seen} reduced={reduced} /></DeployTicker>,
    flags: active => <FlagsMini active={active} reduced={reduced} />,
    review: active => <ReviewMini active={active} reduced={reduced} />,
  };

  const openMeta = CARDS.find(card => card.id === open);
  const details: Record<CardId, ReactNode> = {
    latency: <LatencyDetail reduced={reduced} pillId={`${uid}-range`} />,
    deploys: <DeploysDetail count={count} recent={recent} onShip={ship} reduced={reduced} />,
    flags: <FlagsDetail on={flagOn} rollout={rollout} setOn={setFlagOn} setRollout={setRollout} reduced={reduced} pillId={`${uid}-rollout`} />,
    review: <ReviewDetail approved={approved} setApproved={setApproved} reduced={reduced} />,
  };

  return <section className={styles.root} aria-labelledby={headingId}>
    <header className={styles.header}>
      <h2 id={headingId} className={styles.heading}>From merge to production, in view</h2>
      <p className={styles.lede}>Four tools that stay quiet until you need them. Hover to preview one, open it to try it.</p>
    </header>

    <LayoutGroup id={uid}>
      <motion.div ref={arenaRef} className={styles.arena} initial={false}
        animate={{ minHeight: open ? anchor.top + detailHeight : 0 }} transition={reduced ? { duration: 0 } : spring.smooth}>
        <div ref={gridRef} className={styles.grid} inert={!!open || undefined} onPointerEnter={track} onPointerMove={track} onPointerLeave={release}>
          {CARDS.map(card => <Card key={card.id} card={card} gridRef={gridRef} sx={sx} sy={sy} lit={lit} isOpen={open === card.id} anyOpen={!!open}
            front={front === card.id} reduced={reduced} detailId={detailId} onOpen={() => openCard(card.id)} mini={minis[card.id]} />)}
        </div>

        <AnimatePresence onExitComplete={() => setDetailHeight(0)}>
          {openMeta && <motion.div key={openMeta.id} ref={measureDetail} id={detailId} className={styles.detail} role="region" aria-labelledby={detailTitleId}
            style={{ top: anchor.top, minHeight: anchor.minHeight }}
            initial={reduced ? { opacity: 0 } : false} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: reduced ? duration.instant : duration.exit, ease: standard } }}
            transition={{ duration: duration.fast }}>
            <motion.div layoutId={reduced ? undefined : `surface-${openMeta.id}`} className={styles.detailSurface} style={{ borderRadius: DETAIL_RADIUS }} transition={GROW} />
            <div className={styles.detailBody}>
              <div className={styles.detailHeader}>
                <h3 id={detailTitleId} className={styles.detailTitle}>
                  <motion.span layoutId={reduced ? undefined : `title-${openMeta.id}`} layout="position" className={styles.titleText} transition={GROW}>{openMeta.title}</motion.span>
                </h3>
                <motion.button ref={closeRef} type="button" className={styles.close} aria-label="Close" onClick={close}
                  initial={reduced ? false : { opacity: 0, scale: .9 }} animate={{ opacity: 1, scale: 1 }} transition={reduced ? { duration: 0 } : { ...spring.snappy, delay: .12 }}>
                  <X size={18} strokeWidth={1.75} aria-hidden="true" />
                </motion.button>
              </div>
              <motion.p className={styles.detailBlurb} initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: duration.standard, delay: .08 }}>{openMeta.blurb}</motion.p>
              <motion.div className={styles.detailContent}
                initial={reduced ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
                transition={{ opacity: { duration: duration.standard, delay: .12, ease: enter }, y: { ...spring.smooth, delay: .08 } }}>
                {details[openMeta.id]}
              </motion.div>
            </div>
          </motion.div>}
        </AnimatePresence>
      </motion.div>
    </LayoutGroup>
  </section>;
}

/** Adds one deploy every so often while the card is previewed, so the counter and the bars move together. */
function DeployTicker({ active, reduced, onTick, children }: { active: boolean; reduced: boolean; onTick: () => void; children: ReactNode }) {
  useEffect(() => {
    if (!active || reduced) return;
    const timer = window.setInterval(onTick, 900);
    return () => window.clearInterval(timer);
  }, [active, onTick, reduced]);
  return children;
}

export default SpotlightGrid;
