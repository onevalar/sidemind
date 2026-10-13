"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { AnimatePresence, LayoutGroup, animate, motion, useMotionValue, useReducedMotion } from "motion/react";
import type { Transition } from "motion/react";
import { Check, Minus, Plus } from "lucide-react";
import { AnimatedCounter } from "../../animated-counter/animated-counter";
import Button from "../../button/button";
import { motionTokens } from "../../lib/motion-tokens";
import styles from "./pricing-calculator.module.css";

type Billing = "monthly" | "yearly";
type PlanId = "starter" | "team" | "business";
type Feature = { id: string; text: string };
type Plan = { id: PlanId; name: string; pitch: string; monthly: number; yearly: number; maxSeats?: number; volume: boolean; features: (seats: number, billing: Billing) => Feature[] };

/** Seat stops for the slider: every seat up to ten, then the sizes teams actually buy. */
const STOPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30, 40, 50, 60, 75, 100, 150, 200, 250];
const DEFAULT_SEATS = 20;

const PLANS: Plan[] = [
  {
    id: "starter", name: "Starter", pitch: "For small crews getting organized", monthly: 10, yearly: 8, maxSeats: 10, volume: false,
    features: seats => [
      { id: "projects", text: "Unlimited projects and docs" },
      { id: "storage", text: `${seats * 5} GB shared storage` },
      { id: "history", text: "30 days of version history" },
      { id: "support", text: "Email support" },
    ],
  },
  {
    id: "team", name: "Team", pitch: "For teams shipping together every week", monthly: 20, yearly: 16, volume: true,
    features: (seats, billing) => [
      { id: "everything", text: "Everything in Starter" },
      { id: "storage", text: `${seats * 20} GB shared storage` },
      { id: "sso", text: "Google and Microsoft sign-in" },
      ...(seats >= 25 ? [{ id: "volume", text: seats >= 100 ? "Volume pricing, $4 off each seat" : "Volume pricing, $2 off each seat" }] : []),
      ...(billing === "yearly" ? [{ id: "onboarding", text: "Guided onboarding session" }] : []),
    ],
  },
  {
    id: "business", name: "Business", pitch: "For companies with security reviews", monthly: 35, yearly: 28, volume: true,
    features: (seats, billing) => [
      { id: "everything", text: "Everything in Team" },
      { id: "saml", text: "SAML SSO and SCIM provisioning" },
      { id: "audit", text: "Audit log with 1 year retention" },
      ...(seats >= 25 ? [{ id: "volume", text: seats >= 100 ? "Volume pricing, $4 off each seat" : "Volume pricing, $2 off each seat" }] : []),
      ...(seats >= 50 ? [{ id: "manager", text: "Named success manager" }] : []),
      ...(billing === "yearly" ? [{ id: "uptime", text: "99.95% uptime commitment" }] : []),
    ],
  },
];

const recommend = (seats: number): PlanId => seats <= 5 ? "starter" : seats < 50 ? "team" : "business";
const fits = (plan: Plan, seats: number) => !plan.maxSeats || seats <= plan.maxSeats;
/** Price of one seat for a month, after volume pricing. */
function seatPrice(plan: Plan, seats: number, billing: Billing) {
  const base = billing === "yearly" ? plan.yearly : plan.monthly;
  return base - (plan.volume ? seats >= 100 ? 4 : seats >= 25 ? 2 : 0 : 0);
}
const money = (value: number) => `$${value.toLocaleString("en-US")}`;
const seatsLabel = (seats: number) => `${seats} ${seats === 1 ? "seat" : "seats"}`;

const { spring, duration, ease } = motionTokens;
type Bezier = [number, number, number, number];
const enter = [...ease.enter] as Bezier, standard = [...ease.standard] as Bezier;
/** Duration based springs restated as stiffness and damping, so a retarget keeps its velocity. */
const physical = (visualDuration: number, bounce: number): Transition => {
  const root = 2 * Math.PI / (visualDuration * 1.2);
  return { type: "spring", stiffness: root * root, damping: 2 * (1 - bounce) * root, mass: 1 };
};
const TRAVEL = physical(.5, .16), GLIDE = physical(.32, .1);

const subscribe = () => () => {};
function useReducedFlag() {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

/** A number that rolls to its new value in the surrounding type. */
function Num({ value, prefix = "" }: { value: number; prefix?: string }) {
  return <span className={styles.num}><AnimatedCounter value={value} prefix={prefix} /></span>;
}

/** Copy keyed by its text crossfades in place without changing the line box. */
function Swap({ text, reduced, className }: { text: string; reduced: boolean; className?: string }) {
  return <span className={[styles.swap, className].filter(Boolean).join(" ")}>
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span key={text} initial={reduced ? { opacity: 0 } : { opacity: 0, y: "0.35em" }} animate={{ opacity: 1, y: "0em" }}
        exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: "-0.3em", transition: { duration: duration.fast, ease: standard } }}
        transition={reduced ? { duration: duration.instant } : { duration: duration.standard, ease: enter }}>{text}</motion.span>
    </AnimatePresence>
  </span>;
}

export function PricingCalculator() {
  const reduced = useReducedFlag();
  const uid = useId().replace(/[^a-zA-Z0-9-]/g, "");
  const [index, setIndex] = useState(STOPS.indexOf(DEFAULT_SEATS));
  const [billing, setBilling] = useState<Billing>("yearly");
  const [picked, setPicked] = useState<PlanId | null>(null);
  const [trial, setTrial] = useState<"idle" | "starting" | "ready">("idle");
  const [live, setLive] = useState("");
  const timers = useRef<number[]>([]);
  const billingRefs = useRef(new Map<Billing, HTMLButtonElement>());
  useEffect(() => () => { timers.current.forEach(window.clearTimeout); }, []);

  const seats = STOPS[index];
  const recommended = recommend(seats);
  const pickedPlan = PLANS.find(plan => plan.id === picked);
  const selected = pickedPlan && fits(pickedPlan, seats) ? pickedPlan : PLANS.find(plan => plan.id === recommended)!;
  const perSeat = seatPrice(selected, seats, billing);
  const monthlyTotal = seatPrice(selected, seats, "monthly") * seats;
  const yearlyTotal = seatPrice(selected, seats, "yearly") * seats * 12;
  const savings = monthlyTotal * 12 - yearlyTotal;
  const due = billing === "yearly" ? yearlyTotal : monthlyTotal;
  const layout = reduced ? { duration: 0 } : TRAVEL;

  /* The selection frame is measured against the card it marks, so it lands on that card's live box even while the
     stacked cards fold their pitch and features in or out. A shared layout id would measure the card mid resize. */
  const plansRef = useRef<HTMLDivElement>(null);
  const frameX = useMotionValue(0), frameY = useMotionValue(0), frameW = useMotionValue(0), frameH = useMotionValue(0);
  /* Travel mixes from where the frame was toward the card's live box, so the frame never overshoots a moving target. */
  const frameProgress = useMotionValue(1);
  const frameBox = useRef({ id: "", from: [0, 0, 0, 0], live: [0, 0, 0, 0] });
  const [framed, setFramed] = useState(false);
  useLayoutEffect(() => {
    const wrap = plansRef.current;
    if (!wrap) return;
    const box = frameBox.current;
    const values = [frameX, frameY, frameW, frameH];
    const paint = () => {
      const p = frameProgress.get();
      values.forEach((value, i) => value.set(box.from[i] + (box.live[i] - box.from[i]) * p));
    };
    const measure = () => {
      const card = wrap.querySelector<HTMLElement>(`[data-plan="${selected.id}"]`);
      if (!card) return;
      box.live = [card.offsetLeft - 1, card.offsetTop - 1, card.offsetWidth + 2, card.offsetHeight + 2];
      paint();
    };
    let travel: ReturnType<typeof animate> | undefined;
    const moved = box.id !== "" && box.id !== selected.id;
    box.id = selected.id;
    if (moved && !reduced) {
      box.from = values.map(value => value.get());
      frameProgress.jump(0);
      travel = animate(frameProgress, 1, TRAVEL);
    } else frameProgress.jump(1);
    measure();
    setFramed(true);
    const stop = frameProgress.on("change", paint);
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    wrap.querySelectorAll("li[data-plan]").forEach(card => observer.observe(card));
    return () => { stop(); observer.disconnect(); travel?.stop(); };
  }, [selected.id, reduced, frameX, frameY, frameW, frameH, frameProgress]);

  const setSeats = (next: number) => {
    const clamped = Math.max(0, Math.min(STOPS.length - 1, next));
    setIndex(clamped);
    if (trial === "ready") setTrial("idle");
  };

  const switchBilling = (next: Billing) => {
    if (next === billing) return;
    setBilling(next);
    if (trial === "ready") setTrial("idle");
    setLive(next === "yearly" ? "Yearly billing. Prices shown per seat per month, billed once a year." : "Monthly billing");
  };

  const onBillingKey = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const next: Billing = billing === "monthly" ? "yearly" : "monthly";
    switchBilling(next);
    billingRefs.current.get(next)?.focus();
  };

  const choose = (plan: Plan) => {
    setPicked(plan.id);
    setTrial("idle");
    setLive(`${plan.name} selected`);
  };

  const startTrial = () => {
    if (trial !== "idle") return;
    setTrial("starting");
    timers.current.push(window.setTimeout(() => {
      setTrial("ready");
      setLive(`Trial of ${selected.name} started for ${seatsLabel(seats)}.`);
      timers.current.push(window.setTimeout(() => setTrial(current => current === "ready" ? "idle" : current), 2800));
    }, 1100));
  };

  const fill = index / (STOPS.length - 1);
  const marks: { plan: PlanId; at: number }[] = [
    { plan: "starter", at: 0 },
    { plan: "team", at: STOPS.indexOf(6) / (STOPS.length - 1) },
    { plan: "business", at: STOPS.indexOf(50) / (STOPS.length - 1) },
  ];

  return <section className={styles.root} aria-labelledby={`${uid}-title`}>
    <header className={styles.header}>
      <h2 id={`${uid}-title`} className={styles.title}>Pay for the seats you use</h2>
      <p className={styles.lede}>Move the slider to your team size. Every plan includes a 14 day trial.</p>
    </header>

    <div className={styles.controls}>
      <div className={styles.seatsBlock}>
        <div className={styles.seatsHead}>
          <label htmlFor={`${uid}-seats`} className={styles.seatsLabel}>Team size</label>
          <div className={styles.seatCount}>
            <button type="button" className={styles.stepButton} aria-label="One fewer seat step" onClick={() => setSeats(index - 1)} disabled={index === 0}><Minus size={16} strokeWidth={1.75} aria-hidden="true" /></button>
            <span className={styles.seatValue} aria-hidden="true"><Num value={seats} /><Swap reduced={reduced} text={seats === 1 ? "seat" : "seats"} className={styles.seatUnit} /></span>
            <button type="button" className={styles.stepButton} aria-label="One more seat step" onClick={() => setSeats(index + 1)} disabled={index === STOPS.length - 1}><Plus size={16} strokeWidth={1.75} aria-hidden="true" /></button>
          </div>
        </div>
        <div className={styles.sliderWrap} style={{ "--fill": fill } as CSSProperties}>
          <input id={`${uid}-seats`} className={styles.slider} type="range" min={0} max={STOPS.length - 1} step={1} value={index}
            aria-valuetext={seatsLabel(seats)} onChange={event => setSeats(Number(event.target.value))} />
          <div className={styles.marks} aria-hidden="true">
            {marks.map(mark => <span key={mark.plan} className={styles.mark} data-on={recommended === mark.plan || undefined} style={{ left: `${mark.at * 100}%` }}>
              {PLANS.find(plan => plan.id === mark.plan)!.name}
            </span>)}
          </div>
        </div>
      </div>

      <div className={styles.billing} role="radiogroup" aria-label="Billing period">
        {(["monthly", "yearly"] as const).map(option => <button key={option} ref={node => { if (node) billingRefs.current.set(option, node); else billingRefs.current.delete(option); }}
          type="button" role="radio" aria-checked={billing === option} tabIndex={billing === option ? 0 : -1} className={styles.billingOption}
          onClick={() => switchBilling(option)} onKeyDown={onBillingKey}>
          {billing === option && <motion.span layoutId={`${uid}-billing`} className={styles.billingThumb} transition={reduced ? { duration: 0 } : GLIDE} aria-hidden="true" />}
          <span className={styles.billingText}>{option === "monthly" ? "Monthly" : "Yearly"}</span>
          {option === "yearly" && <span className={styles.saveTag}>Save 20%</span>}
        </button>)}
      </div>
    </div>

    <LayoutGroup id={uid}>
      <div ref={plansRef} className={styles.plansWrap}>
      <ul className={styles.plans}>
        {PLANS.map(plan => {
          const available = fits(plan, seats);
          const price = seatPrice(plan, seats, billing);
          const isSelected = selected.id === plan.id, isRecommended = recommended === plan.id;
          const features = plan.features(seats, billing);
          const planTotal = billing === "yearly" ? price * seats * 12 : price * seats;
          return <li key={plan.id} className={styles.plan} data-plan={plan.id} data-selected={isSelected || undefined} data-available={available || undefined} aria-labelledby={`${uid}-${plan.id}`}>
            {isSelected && !framed && <span className={styles.frame} aria-hidden="true" />}
            <div className={styles.planHead}>
              <h3 id={`${uid}-${plan.id}`} className={styles.planName}>{plan.name}</h3>
              {isRecommended && <motion.span layoutId="badge" className={styles.badge} transition={layout}>
                <motion.span layout="position" transition={layout}>Recommended</motion.span>
              </motion.span>}
            </div>
            <div className={styles.collapse}><div><p className={styles.pitch}>{plan.pitch}</p></div></div>

            <div className={styles.priceArea}>
              <AnimatePresence mode="popLayout" initial={false}>
                {available ? <motion.div key="price" className={styles.priceBlock} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: duration.fast }}>
                  <p className={styles.price}>
                    <span className={styles.priceValue}><AnimatedCounter value={price} prefix="$" /></span>
                    <span className={styles.priceUnit}>per seat<br />per month</span>
                  </p>
                  <p className={styles.planTotal}>
                    <Num value={planTotal} prefix="$" />
                    <Swap reduced={reduced} text={billing === "yearly" ? `billed yearly for ${seatsLabel(seats)}` : `a month for ${seatsLabel(seats)}`} />
                  </p>
                </motion.div> : <motion.div key="limit" className={styles.limit} initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: duration.standard, ease: enter }}>
                  <p className={styles.limitTitle}>Starter fits up to {plan.maxSeats} seats</p>
                  <p className={styles.limitBody}>You picked {seatsLabel(seats)}.</p>
                </motion.div>}
              </AnimatePresence>
            </div>

            {available
              ? <Button variant={isSelected ? "primary" : "secondary"} size="md" className={styles.planButton} onClick={() => choose(plan)} aria-pressed={isSelected}>
                {isSelected ? <><Check size={16} strokeWidth={1.75} aria-hidden="true" />Selected</> : `Choose ${plan.name}`}
              </Button>
              : <Button variant="secondary" size="md" className={styles.planButton} onClick={() => { setSeats(STOPS.indexOf(plan.maxSeats ?? 10)); choose(plan); }}>
                Use {plan.maxSeats} seats
              </Button>}

            <div className={styles.collapse}><div>
            <ul className={styles.features} aria-label={`${plan.name} features`}>
              <AnimatePresence initial={false}>
                {features.map(feature => <motion.li key={feature.id} className={styles.feature}
                  initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
                  exit={reduced ? { opacity: 0, transition: { duration: .1 } } : { opacity: 0, height: 0, transition: { height: spring.smooth, opacity: { duration: duration.fast } } }}
                  transition={reduced ? { duration: .12 } : { height: spring.smooth, opacity: { duration: duration.standard, ease: enter, delay: .05 } }}>
                  <span className={styles.featureInner}>
                    <Check className={styles.featureIcon} size={16} strokeWidth={1.75} aria-hidden="true" />
                    <Swap reduced={reduced} text={feature.text} className={styles.featureText} />
                  </span>
                </motion.li>)}
              </AnimatePresence>
            </ul>
            </div></div>
          </li>;
        })}
      </ul>
      {framed && <motion.span className={`${styles.frame} ${styles.frameFloat}`} style={{ x: frameX, y: frameY, width: frameW, height: frameH }} aria-hidden="true" />}
      </div>
    </LayoutGroup>

    <div className={styles.totals}>
      <div className={styles.totalsMain}>
        <p className={styles.totalsPlan}><Swap reduced={reduced} text={`${selected.name}, ${seatsLabel(seats)}`} /></p>
        <p className={styles.totalsDue}>
          <Num value={due} prefix="$" />
          <Swap reduced={reduced} text={billing === "yearly" ? "per year" : "per month"} className={styles.totalsUnit} />
        </p>
        <p className={styles.totalsNote}><Swap reduced={reduced} text={`${money(perSeat)} per seat per month${billing === "yearly" ? ", billed once a year" : ""}`} /></p>
      </div>
      <div className={styles.savings}>
        <AnimatePresence mode="popLayout" initial={false}>
          {billing === "yearly"
            ? <motion.p key="saving" className={styles.saving} initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduced ? 0 : -6, transition: { duration: duration.fast } }} transition={{ duration: duration.standard, ease: enter }}>
              <Check size={16} strokeWidth={1.75} aria-hidden="true" />
              <span>You save <Num value={savings} prefix="$" /> a year</span>
            </motion.p>
            : <motion.button key="switch" type="button" className={styles.switch} onClick={() => switchBilling("yearly")} initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduced ? 0 : -6, transition: { duration: duration.fast } }} transition={{ duration: duration.standard, ease: enter }}>
              Save <Num value={savings} prefix="$" /> with yearly billing
            </motion.button>}
        </AnimatePresence>
      </div>
      <Button variant="primary" size="lg" className={styles.cta} onClick={startTrial} loading={trial === "starting"}>
        {trial === "ready" ? <><Check size={16} strokeWidth={1.75} aria-hidden="true" />Trial started</> : `Start ${selected.name} trial`}
      </Button>
    </div>
    <p className={styles.srOnly} aria-live="polite">{live}</p>
  </section>;
}

export default PricingCalculator;
