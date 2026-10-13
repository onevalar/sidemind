"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check } from "lucide-react";
import { AnimatedCounter } from "../../animated-counter/animated-counter";
import { Button } from "../../button/button";
import SegmentedControl from "../../segmented-control/segmented-control";
import { Slider } from "../../slider/slider";
import { TextMorph } from "../../text-morph/text-morph";
import { motionTokens } from "../../lib/motion-tokens";
import styles from "./usage-pricing.module.css";

type Billing = "monthly" | "yearly";
type Tier = 0 | 1 | 2;

const { spring, duration, ease } = motionTokens;
const enterEase = [...ease.enter] as [number, number, number, number];
const standardEase = [...ease.standard] as [number, number, number, number];

/** Slider stops. Denser at the low end, where a single seat or a few hundred thousand requests matter. */
const SEATS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 18, 20, 25, 30, 35, 40, 45, 50, 60, 75, 100, 150, 200];
/** Monthly API requests, in millions. */
const REQUESTS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 10, 12.5, 15, 20, 25, 30, 40, 50, 60, 75, 100, 150, 200];

const PLANS = [
  { name: "Starter", seat: { monthly: 12, yearly: 10 }, seatLimit: 5, included: 1, requestLimit: 2, perMillion: 8 },
  { name: "Growth", seat: { monthly: 24, yearly: 20 }, seatLimit: 40, included: 10, requestLimit: 25, perMillion: 4 },
  { name: "Scale", seat: { monthly: 38, yearly: 32 }, seatLimit: Infinity, included: 50, requestLimit: Infinity, perMillion: 2 },
] as const;

/** Each feature unlocks at a tier; values that improve with the plan morph in place. */
const FEATURES: { label: string; tier: Tier; values: [string, string, string] }[] = [
  { label: "Request logs", tier: 0, values: ["7 days", "30 days", "13 months"] },
  { label: "Rate limit", tier: 0, values: ["100 req/s", "1,000 req/s", "10,000 req/s"] },
  { label: "Support", tier: 0, values: ["Email", "Priority", "Named engineer"] },
  { label: "Custom domains", tier: 1, values: ["", "Up to 10", "Unlimited"] },
  { label: "Audit log", tier: 1, values: ["", "90 days", "2 years"] },
  { label: "SAML SSO and SCIM", tier: 2, values: ["", "", ""] },
  { label: "Uptime SLA", tier: 2, values: ["", "", "99.99%"] },
];

const seatMarks = [{ value: SEATS.indexOf(6), label: "Growth" }, { value: SEATS.indexOf(45), label: "Scale" }];
const requestMarks = [{ value: REQUESTS.indexOf(2.5), label: "Growth" }, { value: REQUESTS.indexOf(30), label: "Scale" }];

const at = <T,>(list: readonly T[], index: number) => list[Math.min(list.length - 1, Math.max(0, Math.round(index)))];
const formatRequests = (millions: number) => millions < 1 ? `${Math.round(millions * 1000)}k` : `${millions}M`;
const tierFor = (value: number, low: number, high: number): Tier => value > high ? 2 : value > low ? 1 : 0;

function reasonFor(tier: Tier, seatTier: Tier, requestTier: Tier) {
  if (tier === 0) return "Covers up to 5 seats and 2M requests a month";
  const below = PLANS[tier - 1];
  const seats = `${below.seatLimit} seats`, requests = `${below.requestLimit}M requests`;
  if (seatTier === tier && requestTier === tier) return `Recommended above ${seats} and ${requests}`;
  return seatTier === tier ? `Recommended above ${seats}` : `Recommended above ${requests} a month`;
}

/** A dollar amount on the shared odometer, sized by its parent. */
function Money({ value, prefix = "$", className }: { value: number; prefix?: string; className?: string }) {
  return <span className={[styles.money, className].filter(Boolean).join(" ")}><AnimatedCounter value={value} prefix={prefix} /></span>;
}

/** Replaces a short phrase in place: the new one rises into place, the old one lifts away faster.
 *  Both phrases share one grid cell, so the outgoing one keeps its own width and anchor instead of being popped out of flow. */
function Swap({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <span className={[styles.swap, className].filter(Boolean).join(" ")}>
      <AnimatePresence initial={false}>
        <motion.span
          key={id}
          className={styles.swapItem}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0, transition: { duration: duration.instant } } : { opacity: 0, y: -4, transition: { duration: duration.fast, ease: standardEase } }}
          transition={reduce ? { duration: duration.instant } : { duration: duration.standard, ease: enterEase }}
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/** A check that draws itself when it first appears. Items already on screen keep their stroke. */
function DrawnCheck({ className, delay = .16 }: { className?: string; delay?: number }) {
  const reduce = useReducedMotion();
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <motion.path d="M20 6 9 17l-5-5" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={reduce ? { duration: 0 } : { duration: .34, ease: enterEase, delay }} />
    </svg>
  );
}

/** Measures content so its frame can spring to the new height instead of jumping. */
function useContentHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState<number | "auto">("auto");
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setHeight(entry.borderBoxSize?.[0]?.blockSize ?? node.offsetHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, height] as const;
}

export function UsagePricing() {
  const id = useId();
  const reduce = useReducedMotion();
  const [seatIndex, setSeatIndex] = useState(SEATS.indexOf(18));
  const [requestIndex, setRequestIndex] = useState(REQUESTS.indexOf(15));
  const [billing, setBilling] = useState<Billing>("monthly");
  const [started, setStarted] = useState(false);
  const [listRef, listHeight] = useContentHeight<HTMLUListElement>();

  const seats = at(SEATS, seatIndex);
  const requests = at(REQUESTS, requestIndex);
  const seatTier = tierFor(seats, PLANS[0].seatLimit, PLANS[1].seatLimit);
  const requestTier = tierFor(requests, PLANS[0].requestLimit, PLANS[1].requestLimit);
  const tier = Math.max(seatTier, requestTier) as Tier;
  const plan = PLANS[tier];
  const yearly = billing === "yearly";

  // Remember which way the plan moved so the meter fills forward and empties backward. A new plan also clears a started trial.
  const [shown, setShown] = useState({ tier, direction: 1 });
  if (shown.tier !== tier) {
    setShown({ tier, direction: tier > shown.tier ? 1 : -1 });
    setStarted(false);
  }

  const seatCost = seats * plan.seat.monthly;
  const discount = yearly ? seats * (plan.seat.monthly - plan.seat.yearly) : 0;
  const overMillions = Math.max(0, requests - plan.included);
  const extra = Math.round(overMillions * plan.perMillion);
  const total = seatCost - discount + extra;
  const yearlySavings = seats * (plan.seat.monthly - plan.seat.yearly) * 12;
  const reason = reasonFor(tier, seatTier, requestTier);
  const features = FEATURES.filter(feature => feature.tier <= tier).sort((a, b) => b.tier - a.tier);

  const itemTransition = reduce
    ? { duration: duration.instant }
    : { layout: spring.smooth, default: { duration: duration.standard, ease: enterEase, delay: .08 } };

  return (
    <section className={styles.root} aria-labelledby={`${id}-title`}>
      <div className={styles.layout}>
        <header className={styles.head}>
          <h2 id={`${id}-title`}>Estimate your bill</h2>
          <p>You pay per seat. Each plan includes API traffic up to its limit, then a flat rate per extra million.</p>
        </header>

        <div className={styles.controls}>
          <Slider label="Seats" value={seatIndex} onValueChange={setSeatIndex} min={0} max={SEATS.length - 1} step={1} largeStep={3} marks={seatMarks} format={index => String(at(SEATS, index))} />
          <Slider label="API requests per month" value={requestIndex} onValueChange={setRequestIndex} min={0} max={REQUESTS.length - 1} step={1} largeStep={3} marks={requestMarks} format={index => formatRequests(at(REQUESTS, index))} />
          <div className={styles.billing}>
            <SegmentedControl label="Billing period" value={billing} onValueChange={value => setBilling(value as Billing)} options={[{ value: "monthly", label: "Monthly" }, { value: "yearly", label: "Yearly" }]} />
            <p className={styles.saving} data-applied={yearly || undefined}>
              <AnimatePresence initial={false}>
                {yearly && (
                  <motion.span key="applied" className={styles.savingMark} initial={{ width: 0, opacity: 0 }} animate={{ width: "auto", opacity: 1 }} exit={{ width: 0, opacity: 0, transition: reduce ? { duration: 0 } : { duration: duration.fast, ease: standardEase } }} transition={reduce ? { duration: 0 } : spring.morph}>
                    <DrawnCheck className={styles.savingCheck} delay={.06} />
                  </motion.span>
                )}
              </AnimatePresence>
              <span>Save <Money value={yearlySavings} /> a year</span>
            </p>
          </div>
        </div>

        <aside className={styles.card} aria-labelledby={`${id}-plan`}>
          <div className={styles.meter} aria-hidden="true">
            {PLANS.map((item, index) => (
              <span key={item.name} className={styles.step} data-current={index === tier || undefined}>
                <span className={styles.bar}>
                  <motion.span className={styles.fill} initial={false} animate={{ scaleX: index <= tier ? 1 : 0 }} transition={reduce ? { duration: 0 } : { ...spring.smooth, delay: Math.max(0, shown.direction > 0 ? index - 1 : 2 - index) * .07 }} />
                </span>
                <span className={styles.stepName}>{item.name}</span>
              </span>
            ))}
          </div>

          <div className={styles.planHead}>
            <TextMorph as="h3" id={`${id}-plan`} className={styles.planName}>{plan.name}</TextMorph>
            <p className={styles.reason}><Swap id={reason}>{reason}</Swap></p>
          </div>

          <div className={styles.price}>
            <Money value={total} className={styles.priceValue} />
            <span className={styles.per}>per month</span>
          </div>
          <p className={styles.billed}>
            <Swap id={billing}>{yearly ? <><Money value={seats * plan.seat.yearly * 12} /> a year for seats, usage monthly</> : "Billed monthly, usage included"}</Swap>
          </p>

          <motion.div className={styles.featuresFrame} initial={false} animate={{ height: listHeight }} transition={reduce ? { duration: 0 } : spring.smooth}>
            <ul ref={listRef} className={styles.features} aria-label={`Included in ${plan.name}`}>
              <AnimatePresence mode="popLayout" initial={false}>
                {features.map(feature => (
                  <motion.li
                    key={feature.label}
                    layout="position"
                    layoutDependency={tier}
                    className={styles.feature}
                    data-new={feature.tier === tier || undefined}
                    initial={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduce ? { opacity: 0, transition: { duration: duration.instant } } : { opacity: 0, transition: { duration: duration.fast, ease: standardEase } }}
                    transition={itemTransition}
                  >
                    <DrawnCheck className={styles.check} />
                    <span className={styles.featureLabel}>{feature.label}</span>
                    {feature.values[tier] && <TextMorph className={styles.featureValue}>{feature.values[tier]}</TextMorph>}
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          </motion.div>

          <div className={styles.action}>
            <Button className={styles.cta} variant={started ? "secondary" : "primary"} onClick={() => setStarted(true)} aria-describedby={`${id}-note`}>
              {started ? <><Check size={16} strokeWidth={1.75} aria-hidden="true" />Trial started</> : `Start with ${plan.name}`}
            </Button>
            <p className={styles.note} id={`${id}-note`}>
              <Swap id={started ? "started" : "idle"}>
                {started ? <>Trial started. <button type="button" className={styles.undo} onClick={() => setStarted(false)}>Undo</button></> : "14 days free, then billed as estimated"}
              </Swap>
            </p>
          </div>
          <p className={styles.srOnly} aria-live="polite">{`${plan.name}. ${reason}.`}</p>
        </aside>

        <section className={styles.breakdown} aria-labelledby={`${id}-breakdown`}>
          <h3 id={`${id}-breakdown`}>Breakdown</h3>
          <dl className={styles.rows}>
            <div className={styles.row}>
              <dt><span className={styles.rowLabel}><TextMorph>{plan.name}</TextMorph> seats</span><small>{seats} × ${plan.seat.monthly}</small></dt>
              <dd><Money value={seatCost} /></dd>
            </div>
            <div className={styles.row}>
              <dt>
                <span className={styles.rowLabel}>API requests</span>
                <small>{overMillions > 0 ? `${formatRequests(requests)} used, ${formatRequests(overMillions)} over at $${plan.perMillion} per million` : `${formatRequests(requests)} of ${formatRequests(plan.included)} included`}</small>
              </dt>
              <dd><Swap id={overMillions > 0 ? "over" : "included"} className={styles.alignEnd}>{overMillions > 0 ? <Money value={extra} /> : <span className={styles.included}>Included</span>}</Swap></dd>
            </div>
            <AnimatePresence initial={false}>
              {yearly && (
                <motion.div
                  key="yearly"
                  className={styles.row}
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0, transition: reduce ? { duration: 0 } : { height: spring.smooth, opacity: { duration: duration.instant } } }}
                  transition={reduce ? { duration: 0 } : { height: spring.smooth, opacity: { duration: duration.standard, ease: enterEase, delay: .06 } }}
                >
                  <dt><span className={styles.rowLabel}>Yearly billing</span><small>{seats} × ${plan.seat.monthly - plan.seat.yearly} off each seat</small></dt>
                  <dd className={styles.discount}><Money value={discount} prefix="−$" /></dd>
                </motion.div>
              )}
            </AnimatePresence>
            <div className={`${styles.row} ${styles.total}`}>
              <dt><span className={styles.rowLabel}>Estimated total</span><small>Per month, before tax</small></dt>
              <dd><Money value={total} /></dd>
            </div>
          </dl>
        </section>
      </div>
    </section>
  );
}

export default UsagePricing;
