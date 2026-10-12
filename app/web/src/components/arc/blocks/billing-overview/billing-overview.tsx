"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { AnimatePresence, LayoutGroup, motion, useInView, useIsPresent, useReducedMotion } from "motion/react";
import { Check, CircleAlert, Clock3, Download, TriangleAlert } from "lucide-react";
import { AnimatedCounter } from "../../animated-counter/animated-counter";
import { Avatar } from "../../avatar/avatar";
import { Badge, type BadgeTone } from "../../badge/badge";
import { Button } from "../../button/button";
import { Input } from "../../input/input";
import SegmentedControl from "../../segmented-control/segmented-control";
import { TextMorph } from "../../text-morph/text-morph";
import { motionTokens } from "../../lib/motion-tokens";
import styles from "./billing-overview.module.css";

type PlanId = "starter" | "growth" | "scale";
type Billing = "monthly" | "yearly";
type InvoiceStatus = "paid" | "due" | "failed";
type Invoice = { id: string; date: string; title: string; detail: string; amount: number; status: InvoiceStatus };
type Subscription = { plan: PlanId; billing: Billing; renews: string; periodEnd: string; daysLeft: number; periodDays: number };
type Draft = { number: string; expiry: string; cvc: string };

const { spring, duration, ease } = motionTokens;
const enterEase = [...ease.enter] as [number, number, number, number];
const standardEase = [...ease.standard] as [number, number, number, number];

const PLANS: Record<PlanId, { name: string; rank: number; monthly: number; yearly: number; seats: number; calls: number; storage: number }> = {
  starter: { name: "Starter", rank: 0, monthly: 49, yearly: 39, seats: 5, calls: 250_000, storage: 25 },
  growth: { name: "Growth", rank: 1, monthly: 199, yearly: 159, seats: 15, calls: 1_000_000, storage: 100 },
  scale: { name: "Scale", rank: 2, monthly: 499, yearly: 399, seats: 50, calls: 5_000_000, storage: 500 },
};
const ORDER: PlanId[] = ["starter", "growth", "scale"];
/** Usage in the Sep 14 – Oct 13 period. The preview's today is fixed at Sep 22, 2026, so server and client render the same numbers. */
const USED = { seats: 12, calls: 912_480, storage: 38.4 };
const WARN_AT = .85;
const TODAY = "Sep 22, 2026";
const START: Subscription = { plan: "growth", billing: "monthly", renews: "Oct 14, 2026", periodEnd: "Oct 13", daysLeft: 22, periodDays: 30 };
const NEXT_TERM: Record<Billing, { renews: string; periodEnd: string; days: number }> = { monthly: { renews: "Oct 22, 2026", periodEnd: "Oct 21", days: 30 }, yearly: { renews: "Sep 22, 2027", periodEnd: "Sep 21, 2027", days: 365 } };
const INVOICES: Invoice[] = [
  { id: "sep-renewal", date: "Sep 14, 2026", title: "Growth plan", detail: "Sep 14 – Oct 13", amount: 199, status: "paid" },
  { id: "sep-retention", date: "Sep 3, 2026", title: "Log retention add-on", detail: "Card declined by the bank", amount: 36, status: "failed" },
  { id: "aug-workshop", date: "Aug 28, 2026", title: "Onboarding workshop", detail: "Bank transfer, due Sep 27", amount: 600, status: "due" },
  { id: "aug-renewal", date: "Aug 14, 2026", title: "Growth plan", detail: "Aug 14 – Sep 13", amount: 199, status: "paid" },
];
const STATUS: Record<InvoiceStatus, { label: string; tone: BadgeTone; icon: ReactNode }> = {
  paid: { label: "Paid", tone: "success", icon: <Check size={12} strokeWidth={2} aria-hidden="true" /> },
  due: { label: "Due", tone: "warning", icon: <Clock3 size={12} strokeWidth={2} aria-hidden="true" /> },
  failed: { label: "Failed", tone: "danger", icon: <CircleAlert size={12} strokeWidth={2} aria-hidden="true" /> },
};
const EMPTY_DRAFT: Draft = { number: "", expiry: "", cvc: "" };

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const wholeCurrency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const count = new Intl.NumberFormat("en-US");
const money = (value: number) => currency.format(value);
const charge = (plan: PlanId, billing: Billing) => billing === "monthly" ? PLANS[plan].monthly : PLANS[plan].yearly * 12;
const compact = (value: number) => value >= 1e6 ? `${value / 1e6}M` : `${value / 1e3}k`;
const limitsOf = (plan: PlanId) => `${PLANS[plan].seats} seats · ${compact(PLANS[plan].calls)} API calls · ${PLANS[plan].storage} GB`;
const round = (value: number) => Math.round(value * 100) / 100;

/** A change inside the term is prorated for the days left; a new billing period starts today and credits the unused time. */
function quote(sub: Subscription, plan: PlanId, billing: Billing) {
  const credit = charge(sub.plan, sub.billing) * sub.daysLeft / sub.periodDays;
  const sameTerm = billing === sub.billing;
  const cost = sameTerm ? charge(plan, billing) * sub.daysLeft / sub.periodDays : charge(plan, billing);
  return { amount: round(cost - credit), credit: round(credit), sameTerm, renews: sameTerm ? sub.renews : NEXT_TERM[billing].renews, unchanged: plan === sub.plan && sameTerm };
}

const formatExpiry = (value: string) => { const digits = value.replace(/\D/g, "").slice(0, 4); return digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits; };
function validate(draft: Draft) {
  const found: Partial<Record<keyof Draft, string>> = {};
  if (draft.number.replace(/\D/g, "").length !== 16) found.number = "Enter all 16 digits";
  const [month, year] = draft.expiry.split("/").map(Number);
  if (!/^\d{2}\/\d{2}$/.test(draft.expiry) || month < 1 || month > 12) found.expiry = "Use MM/YY, like 08/29";
  else if (year < 26 || (year === 26 && month < 9)) found.expiry = "This card has expired";
  if (!/^\d{3,4}$/.test(draft.cvc)) found.cvc = "Enter 3 or 4 digits";
  return found;
}

/** Outgoing copies are hidden from assistive tech while they leave, so only the current text is read. The ref lets popLayout measure the leaving copy. */
function Phase({ children, className, reduce, ref }: { children: ReactNode; className?: string; reduce: boolean; ref?: Ref<HTMLSpanElement> }) {
  const present = useIsPresent();
  return <motion.span ref={ref} className={className} aria-hidden={present ? undefined : true}
    initial={reduce ? { opacity: 0 } : { opacity: 0, y: "0.35em" }} animate={{ opacity: 1, y: "0em" }}
    exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: "-0.3em", transition: { duration: duration.fast, ease: standardEase } }}
    transition={reduce ? { duration: 0 } : { duration: duration.standard, ease: enterEase }}>{children}</motion.span>;
}

/** Changing copy rises into place while the old line lifts away out of flow, so the line never holds two widths. */
function Swap({ children, className, anchor = "left" }: { children: string; className?: string; anchor?: "left" | "right" }) {
  const reduce = !!useReducedMotion();
  return <span className={[styles.swap, className].filter(Boolean).join(" ")}>
    <AnimatePresence mode="popLayout" initial={false} anchorX={anchor}><Phase key={children} className={styles.swapText} reduce={reduce}>{children}</Phase></AnimatePresence>
  </span>;
}

/** Card digits turn one column at a time, like a counter, when a new card replaces the old one. */
function Digits({ value }: { value: string }) {
  const reduce = !!useReducedMotion();
  return <span className={styles.digits}>{value.split("").map((character, index) => <span key={index} className={styles.digit}>
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span key={character} initial={reduce ? { opacity: 0 } : { opacity: 0, y: "0.7em" }} animate={{ opacity: 1, y: "0em" }}
        exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: "-0.7em", transition: { duration: duration.fast, ease: standardEase, delay: index * .04 } }}
        transition={reduce ? { duration: 0 } : { default: { duration: duration.standard, ease: enterEase, delay: index * .04 }, y: { ...spring.snappy, delay: index * .04 } }}>{character}</motion.span>
    </AnimatePresence>
  </span>)}</span>;
}

/** The region's height follows its content on a spring, so a view swapped inside grows or settles instead of jumping. Padding with a matching negative margin keeps focus rings unclipped. */
function AutoHeight({ children }: { children: ReactNode }) {
  const reduce = useReducedMotion();
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | "auto">("auto");
  useLayoutEffect(() => {
    const node = inner.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(node.offsetHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <motion.div className={styles.region} initial={false} animate={{ height }} transition={reduce ? { duration: 0 } : spring.smooth}><div ref={inner} className={styles.regionInner}>{children}</div></motion.div>;
}

type MeterProps = { label: string; used: number; limit: number; decimals?: number; unit?: string; limitValue: number; limitSuffix: string; left: string; valueText: string; index: number; revealed: boolean };

function Meter({ label, used, limit, decimals = 0, unit, limitValue, limitSuffix, left, valueText, index, revealed }: MeterProps) {
  const id = useId();
  const reduce = useReducedMotion();
  const share = used / limit;
  const near = share >= WARN_AT;
  return <div className={styles.meter} data-near={near || undefined}>
    <div className={styles.meterHead}>
      <span id={`${id}-label`}>{label}</span>
      <AnimatePresence initial={false}>
        {near && <motion.span key="near" className={styles.nearBadge} initial={reduce ? { opacity: 0 } : { opacity: 0, scale: .9 }} animate={{ opacity: 1, scale: 1 }}
          exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, scale: .9, transition: { duration: duration.exit, ease: standardEase } }}
          transition={reduce ? { duration: 0 } : { duration: duration.standard, ease: enterEase }}>
          <Badge tone="warning" size="sm" icon={<TriangleAlert size={12} strokeWidth={2} aria-hidden="true" />}>Near limit</Badge>
        </motion.span>}
      </AnimatePresence>
    </div>
    <p className={styles.meterValue}>
      <span className={styles.num}><AnimatedCounter value={used} decimals={decimals} animateOnView /></span>
      {unit && <span className={styles.meterUnit}>{unit}</span>}
      <span className={styles.meterOf}>of <span className={styles.num}><AnimatedCounter value={limitValue} suffix={limitSuffix} /></span></span>
    </p>
    <div className={styles.track} role="meter" aria-labelledby={`${id}-label`} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used} aria-valuetext={valueText}>
      <motion.span className={styles.fill} initial={{ width: "0%" }} animate={{ width: revealed ? `${Math.min(100, share * 100)}%` : "0%" }} transition={reduce ? { duration: 0 } : { ...spring.smooth, delay: index * .06 }} />
    </div>
    <Swap className={styles.meterCaption}>{`${Math.round(share * 100)}% used · ${left} left`}</Swap>
  </div>;
}

export interface BillingOverviewProps {
  /** Set when the page around the block already titles it (for example an app's Billing page): the block drops its own header row. */
  embedded?: boolean;
}

export function BillingOverview({ embedded = false }: BillingOverviewProps = {}) {
  const id = useId();
  const groupId = useId();
  const reduce = !!useReducedMotion();
  const [sub, setSub] = useState<Subscription>(START);
  const [planView, setPlanView] = useState<"summary" | "picker">("summary");
  const [pick, setPick] = useState<{ plan: PlanId; billing: Billing }>({ plan: "scale", billing: "monthly" });
  const [confirming, setConfirming] = useState(false);
  const [planNotice, setPlanNotice] = useState("");
  const [card, setCard] = useState({ last4: "7719", expiry: "04/28" });
  const [cardView, setCardView] = useState<"summary" | "edit">("summary");
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({});
  const [saving, setSaving] = useState(false);
  const [cardNotice, setCardNotice] = useState("");
  const [invoices, setInvoices] = useState(INVOICES);
  const [downloads, setDownloads] = useState<Record<string, "preparing" | "done">>({});
  const [paying, setPaying] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const usageRef = useRef<HTMLElement>(null);
  const usageSeen = useInView(usageRef, { once: true, amount: .3 });
  const planAction = useRef<HTMLButtonElement>(null);
  const cardAction = useRef<HTMLButtonElement>(null);
  const numberField = useRef<HTMLInputElement>(null);
  const expiryField = useRef<HTMLInputElement>(null);
  const cvcField = useRef<HTMLInputElement>(null);
  const options = useRef(new Map<PlanId, HTMLButtonElement>());
  const downloadButtons = useRef(new Map<string, HTMLButtonElement>());
  const focusNext = useRef<(() => HTMLElement | null | undefined) | null>(null);
  const timers = useRef(new Set<number>());
  const changes = useRef(0);

  // Focus moves once the next view has mounted: into the picker, back to its trigger, or onto the control that replaced a removed one.
  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    target()?.focus();
  });
  useEffect(() => { const pending = timers.current; return () => pending.forEach(timer => window.clearTimeout(timer)); }, []);
  const later = (run: () => void, ms: number) => { const timer = window.setTimeout(() => { timers.current.delete(timer); run(); }, ms); timers.current.add(timer); };

  const plan = PLANS[sub.plan];
  const target = PLANS[pick.plan];
  const topPlan = plan.rank === ORDER.length - 1;
  const q = quote(sub, pick.plan, pick.billing);
  const move = pick.plan === sub.plan ? "billing" : target.rank > plan.rank ? "up" : "down";
  const confirmLabel = q.unchanged ? "Current plan" : move === "up" ? `Upgrade to ${target.name}` : move === "down" ? `Move to ${target.name}` : `Switch to ${pick.billing}`;
  const quoteDetail = q.unchanged ? "This is your current plan" : q.sameTerm ? `Prorated for ${sub.daysLeft} days` : `Renews ${q.renews} · ${money(q.credit)} credited`;

  function openPicker() {
    const next = ORDER.find(planId => PLANS[planId].rank > plan.rank) ?? sub.plan;
    setPick({ plan: next, billing: sub.billing });
    setPlanNotice("");
    setPlanView("picker");
    focusNext.current = () => options.current.get(next);
  }

  function closePicker() {
    if (confirming) return;
    setPlanView("summary");
    focusNext.current = () => planAction.current;
  }

  function choose(planId: PlanId) {
    if (!confirming && PLANS[planId].seats >= USED.seats) setPick(current => ({ ...current, plan: planId }));
  }

  function onOptionKey(event: KeyboardEvent<HTMLDivElement>) {
    const enabled = ORDER.filter(planId => PLANS[planId].seats >= USED.seats);
    const step = ({ ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 } as Record<string, number>)[event.key];
    const next = event.key === "Home" ? enabled[0] : event.key === "End" ? enabled[enabled.length - 1] : step ? enabled[(enabled.indexOf(pick.plan) + step + enabled.length) % enabled.length] : undefined;
    if (!next) return;
    event.preventDefault();
    choose(next);
    options.current.get(next)?.focus();
  }

  function confirmPlan() {
    if (q.unchanged || confirming) return;
    const chosen = PLANS[pick.plan];
    const term = NEXT_TERM[pick.billing];
    const next: Subscription = q.sameTerm ? { ...sub, plan: pick.plan } : { plan: pick.plan, billing: pick.billing, renews: term.renews, periodEnd: term.periodEnd, daysLeft: term.days, periodDays: term.days };
    const verb = move === "billing" ? `Switched to ${pick.billing} billing` : move === "up" ? `Upgraded to ${chosen.name}` : `Moved to ${chosen.name}`;
    const message = q.amount > 0 ? `${verb}. ${money(q.amount)} charged to card ending ${card.last4}.` : q.amount < 0 ? `${verb}. ${money(-q.amount)} credited to your next invoice.` : `${verb}.`;
    const invoice: Invoice | null = q.amount > 0 ? { id: `change-${++changes.current}`, date: TODAY, title: `${chosen.name} plan`, detail: q.sameTerm ? `Prorated, Sep 22 – ${sub.periodEnd}` : `${pick.billing === "yearly" ? "Yearly" : "Monthly"}, Sep 22 – ${term.periodEnd}`, amount: q.amount, status: "paid" } : null;
    setConfirming(true);
    later(() => {
      setConfirming(false);
      setSub(next);
      setPlanView("summary");
      setPlanNotice(message);
      setAnnouncement(message);
      if (invoice) setInvoices(list => [invoice, ...list]);
      focusNext.current = () => planAction.current;
    }, 900);
  }

  function startEdit() {
    setDraft(EMPTY_DRAFT);
    setErrors({});
    setCardNotice("");
    setCardView("edit");
    focusNext.current = () => numberField.current;
  }

  function cancelEdit() {
    if (saving) return;
    setCardView("summary");
    focusNext.current = () => cardAction.current;
  }

  function edit(key: keyof Draft, value: string) {
    const next = key === "number" ? value.replace(/\D/g, "").slice(0, 16).replace(/(\d{4})(?=\d)/g, "$1 ") : key === "expiry" ? formatExpiry(value) : value.replace(/\D/g, "").slice(0, 4);
    setDraft(current => ({ ...current, [key]: next }));
    if (errors[key]) setErrors(current => ({ ...current, [key]: undefined }));
  }

  function saveCard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const found = validate(draft);
    setErrors(found);
    const first = found.number ? numberField : found.expiry ? expiryField : found.cvc ? cvcField : null;
    if (first) { first.current?.focus(); return; }
    const next = { last4: draft.number.replace(/\D/g, "").slice(-4), expiry: draft.expiry };
    setSaving(true);
    later(() => {
      const message = `Card ending ${next.last4} saved. Renewals and retries now use it.`;
      setSaving(false);
      setCard(next);
      setCardView("summary");
      setCardNotice(message);
      setAnnouncement(message);
      focusNext.current = () => cardAction.current;
    }, 900);
  }

  function download(invoice: Invoice) {
    if (downloads[invoice.id]) return;
    setDownloads(current => ({ ...current, [invoice.id]: "preparing" }));
    later(() => {
      setDownloads(current => ({ ...current, [invoice.id]: "done" }));
      setAnnouncement(`Invoice from ${invoice.date} downloaded.`);
      later(() => setDownloads(current => { const next = { ...current }; delete next[invoice.id]; return next; }), 2200);
    }, 700);
  }

  function pay(invoice: Invoice) {
    if (paying) return;
    const last4 = card.last4;
    setPaying(invoice.id);
    later(() => {
      setPaying(null);
      setInvoices(list => list.map(item => item.id === invoice.id ? { ...item, status: "paid", detail: `Paid Sep 22 with card ending ${last4}` } : item));
      setAnnouncement(`${money(invoice.amount)} invoice from ${invoice.date} paid with card ending ${last4}.`);
      focusNext.current = () => downloadButtons.current.get(invoice.id);
    }, 1000);
  }

  const view = {
    initial: reduce ? { opacity: 0 } : { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    exit: reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -4, transition: { duration: duration.instant, ease: standardEase } },
    transition: reduce ? { duration: 0 } : { duration: duration.standard, ease: enterEase, delay: .05 },
  };

  const meters = [
    { key: "seats", label: "Seats", used: USED.seats, limit: plan.seats, limitValue: plan.seats, limitSuffix: "", left: `${plan.seats - USED.seats} seats`, valueText: `${USED.seats} of ${plan.seats} seats used` },
    { key: "calls", label: "API calls", used: USED.calls, limit: plan.calls, limitValue: plan.calls >= 1e6 ? plan.calls / 1e6 : plan.calls / 1e3, limitSuffix: plan.calls >= 1e6 ? "M" : "k", left: `${count.format(plan.calls - USED.calls)} calls`, valueText: `${count.format(USED.calls)} of ${count.format(plan.calls)} API calls used` },
    { key: "storage", label: "Storage", used: USED.storage, limit: plan.storage, decimals: 1, unit: "GB", limitValue: plan.storage, limitSuffix: " GB", left: `${(plan.storage - USED.storage).toFixed(1)} GB`, valueText: `${USED.storage} of ${plan.storage} GB used` },
  ];

  return (
    <section className={styles.billing} aria-labelledby={`${id}-title`}>
      {embedded ? <h2 id={`${id}-title`} className={styles.srOnly}>Billing</h2> : <header className={styles.header}><h2 id={`${id}-title`}>Billing</h2><p>Fieldnote Labs workspace</p></header>}

      <div className={styles.top}>
        <section className={styles.panel} aria-labelledby={`${id}-plan`}>
          <div className={styles.panelHead}><h3 id={`${id}-plan`}>Current plan</h3><Swap className={styles.panelNote} anchor="right">{sub.billing === "monthly" ? "Billed monthly" : `${wholeCurrency.format(plan.yearly * 12)} billed yearly`}</Swap></div>
          <div className={styles.planLine}>
            <TextMorph className={styles.planName}>{plan.name}</TextMorph>
            <span className={styles.planPrice}><span className={styles.num}><AnimatedCounter value={sub.billing === "monthly" ? plan.monthly : plan.yearly} prefix="$" /></span><span className={styles.per}>/ month</span></span>
          </div>
          <AutoHeight>
            <AnimatePresence mode="popLayout" initial={false}>
              {planView === "summary" ? <motion.div key="summary" className={styles.planSummary} {...view}>
                <div className={styles.planFacts}><p>Renews {sub.renews}</p><span>{limitsOf(sub.plan)}</span></div>
                <Button ref={planAction} type="button" variant={topPlan ? "secondary" : "primary"} size="sm" onClick={openPicker}>{topPlan ? "Change plan" : "Upgrade"}</Button>
                {planNotice && <p className={styles.notice}><Check size={14} strokeWidth={2} aria-hidden="true" />{planNotice}</p>}
              </motion.div> : <motion.div key="picker" className={styles.picker} {...view} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); closePicker(); } }}>
                <div className={styles.pickerHead}>
                  <div><h4 id={`${id}-picker`}>Change plan</h4><p>Yearly billing saves 20%</p></div>
                  <SegmentedControl label="Billing period" value={pick.billing} onValueChange={value => { if (!confirming) setPick(current => ({ ...current, billing: value as Billing })); }} options={[{ value: "monthly", label: "Monthly" }, { value: "yearly", label: "Yearly" }]} />
                </div>
                <LayoutGroup id={groupId}>
                  <div className={styles.options} role="radiogroup" aria-labelledby={`${id}-picker`} onKeyDown={onOptionKey}>
                    {ORDER.map(planId => {
                      const option = PLANS[planId];
                      const checked = pick.plan === planId;
                      const blocked = option.seats < USED.seats;
                      return <button key={planId} ref={node => { if (node) options.current.set(planId, node); else options.current.delete(planId); }} type="button" role="radio" aria-checked={checked} disabled={blocked} tabIndex={checked ? 0 : -1} className={styles.option} onClick={() => choose(planId)}>
                        {checked && <motion.span layoutId="plan-highlight" className={styles.optionHighlight} transition={reduce ? { duration: 0 } : spring.morph} aria-hidden="true" />}
                        <span className={styles.radio} aria-hidden="true" />
                        <span className={styles.optionName}>{option.name}{planId === sub.plan && <span className={styles.optionCurrent}>Current</span>}</span>
                        <span className={styles.optionMeta}>{blocked ? `${USED.seats} seats in use, ${option.name} allows ${option.seats}` : limitsOf(planId)}</span>
                        <span className={styles.optionAmount}><span className={styles.num}><AnimatedCounter value={pick.billing === "monthly" ? option.monthly : option.yearly} prefix="$" /></span><span className={styles.per}>/mo</span></span>
                        <Swap className={styles.optionBilled} anchor="right">{pick.billing === "yearly" ? `${wholeCurrency.format(option.yearly * 12)} a year` : "Billed monthly"}</Swap>
                      </button>;
                    })}
                  </div>
                </LayoutGroup>
                <div className={styles.quote}>
                  <div className={styles.quoteText} aria-live="polite">
                    <Swap className={styles.quoteLabel}>{q.amount < 0 ? "Credit to next invoice" : "Due today"}</Swap>
                    <span className={styles.quoteAmount}><span className={styles.num}><AnimatedCounter value={Math.abs(q.amount)} prefix="$" decimals={2} /></span></span>
                    <Swap className={styles.quoteDetail}>{quoteDetail}</Swap>
                  </div>
                  <div className={styles.quoteActions}>
                    <Button type="button" variant="ghost" size="sm" onClick={closePicker} disabled={confirming}>Cancel</Button>
                    <Button type="button" size="sm" onClick={confirmPlan} disabled={q.unchanged} loading={confirming}>{confirmLabel}</Button>
                  </div>
                </div>
              </motion.div>}
            </AnimatePresence>
          </AutoHeight>
        </section>

        <section className={styles.panel} aria-labelledby={`${id}-payment`}>
          <div className={styles.panelHead}><h3 id={`${id}-payment`}>Payment method</h3></div>
          <div className={styles.cardRow}>
            <div className={styles.cardFace} aria-hidden="true">
              <span className={styles.cardTop}><span className={styles.chip} /><span>Business</span></span>
              <span className={styles.cardBottom}>
                <span className={styles.cardHolder}>Fieldnote Labs</span>
                <span className={styles.cardNumber}><span>••••</span><Digits value={card.last4} /></span>
                <span className={styles.cardExpiry}><Digits value={card.expiry} /></span>
              </span>
            </div>
            <div className={styles.cardDetails}>
              <Swap className={styles.cardTitle}>{`Card ending ${card.last4}`}</Swap>
              <Swap className={styles.cardMeta}>{`Expires ${card.expiry}`}</Swap>
              <Button ref={cardAction} type="button" variant="secondary" size="sm" onClick={startEdit} disabled={cardView === "edit"}>Update</Button>
            </div>
          </div>
          <AutoHeight>
            <AnimatePresence mode="popLayout" initial={false}>
              {cardView === "edit" ? <motion.form key="edit" className={styles.cardForm} noValidate onSubmit={saveCard} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); cancelEdit(); } }} aria-label="New card" {...view}>
                <Input ref={numberField} label="Card number" inputMode="numeric" autoComplete="cc-number" placeholder="1234 1234 1234 1234" value={draft.number} error={errors.number} onChange={event => edit("number", event.target.value)} />
                <div className={styles.formRow}>
                  <Input ref={expiryField} label="Expiry" inputMode="numeric" autoComplete="cc-exp" placeholder="MM/YY" value={draft.expiry} error={errors.expiry} onChange={event => edit("expiry", event.target.value)} />
                  <Input ref={cvcField} label="Security code" inputMode="numeric" autoComplete="cc-csc" placeholder="123" value={draft.cvc} error={errors.cvc} onChange={event => edit("cvc", event.target.value)} />
                </div>
                <div className={styles.formFoot}>
                  <span />
                  <div className={styles.formActions}><Button type="button" variant="ghost" size="sm" onClick={cancelEdit} disabled={saving}>Cancel</Button><Button type="submit" size="sm" loading={saving}>Save card</Button></div>
                </div>
              </motion.form> : cardNotice ? <motion.p key={cardNotice} className={`${styles.notice} ${styles.cardNotice}`} {...view}><Check size={14} strokeWidth={2} aria-hidden="true" />{cardNotice}</motion.p> : null}
            </AnimatePresence>
          </AutoHeight>
        </section>
      </div>

      <section ref={usageRef} className={styles.panel} aria-labelledby={`${id}-usage`}>
        <div className={styles.panelHead}><h3 id={`${id}-usage`}>Usage this period</h3><span className={styles.panelNote}>Sep 14 – Oct 13</span></div>
        <div className={styles.meters}>{meters.map(({ key, ...meter }, index) => <Meter key={key} {...meter} index={index} revealed={usageSeen} />)}</div>
      </section>

      <section className={styles.panel} aria-labelledby={`${id}-invoices`}>
        <div className={styles.panelHead}><h3 id={`${id}-invoices`}>Invoices</h3><span className={styles.recipient}><Avatar name="Emma Collins" src="/media/people/emma-collins.jpg" size="sm" />Sent to Emma Collins</span></div>
        <ul className={styles.invoices}>
          <AnimatePresence initial={false}>
            {invoices.map(invoice => {
              const status = STATUS[invoice.status];
              const state = downloads[invoice.id];
              return <motion.li key={invoice.id} className={styles.invoice} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={reduce ? { duration: 0 } : { height: spring.smooth, opacity: { duration: duration.standard, ease: enterEase } }}>
                <div className={styles.invoiceRow}>
                  <span className={styles.invoiceText}><span className={styles.invoiceTitle}>{invoice.title}</span><Swap className={styles.invoiceDetail}>{invoice.detail}</Swap></span>
                  <span className={styles.invoiceAmount}>{money(invoice.amount)}</span>
                  <span className={styles.invoiceMeta}>
                    <span className={styles.invoiceDate}>{invoice.date}</span>
                    <span className={styles.invoiceStatus}><Badge tone={status.tone} size="sm" icon={status.icon}>{status.label}</Badge></span>
                  </span>
                  <span className={styles.invoiceActions}>
                    <AnimatePresence mode="popLayout" initial={false}>
                      {invoice.status === "failed" && <motion.span key="pay" className={styles.payNow} exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, scale: .9, transition: { duration: duration.exit, ease: standardEase } }}>
                        <Button type="button" variant="secondary" size="sm" loading={paying === invoice.id} aria-label={`Pay ${money(invoice.amount)} for ${invoice.title}`} onClick={() => pay(invoice)}>Pay now</Button>
                      </motion.span>}
                    </AnimatePresence>
                    <Button ref={node => { if (node) downloadButtons.current.set(invoice.id, node); else downloadButtons.current.delete(invoice.id); }} type="button" variant="ghost" size="sm" className={styles.iconButton} loading={state === "preparing"} aria-label={state === "done" ? `Invoice from ${invoice.date} downloaded` : `Download invoice from ${invoice.date}`} onClick={() => download(invoice)}>
                      {state === "done" ? <Check className={styles.done} size={16} strokeWidth={2} aria-hidden="true" /> : <Download size={16} strokeWidth={1.75} aria-hidden="true" />}
                    </Button>
                  </span>
                </div>
              </motion.li>;
            })}
          </AnimatePresence>
        </ul>
      </section>

      <p className={styles.srOnly} role="status" aria-live="polite">{announcement}</p>
    </section>
  );
}

export default BillingOverview;
