"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { AnimatePresence, LayoutGroup, animate, motion, useIsPresent, useMotionValue, useReducedMotion, type AnimationPlaybackControls, type Variants } from "motion/react";
import { ArrowLeft, CalendarCheck, Check, Download, Lock, Minus, Plus, RotateCcw, Trash2 } from "lucide-react";
import { AnimatedCounter } from "../../animated-counter/animated-counter";
import { Avatar } from "../../avatar/avatar";
import { Badge, type BadgeTone } from "../../badge/badge";
import { Button } from "../../button/button";
import { HoldToConfirm } from "../../hold-to-confirm/hold-to-confirm";
import { Textarea } from "../../textarea/textarea";
import { motionTokens } from "../../lib/motion-tokens";
import styles from "./cancel-flow.module.css";

type ReasonId = "price" | "usage" | "feature" | "switching";
type View = "reason" | "offer" | "confirm" | "cancelled" | "kept";
type Row = [term: string, value: string];
type Offer = {
  title: string; lead: string; facts: string[]; accept: string;
  figure: { prefix?: string; value: number; decimals?: number; unit: string; was?: string };
  done: { title: string; lead: string; rows: Row[]; badge: string; tone: BadgeTone; announce: string };
};

const { spring, duration, ease, blur, stagger } = motionTokens;
const enterEase = [...ease.enter] as [number, number, number, number];
const standardEase = [...ease.standard] as [number, number, number, number];

/** The preview's today is fixed at Tue, Sep 22, 2026 and the Team plan renews on Oct 14, so server and client render the same dates. */
const PRICE = 96;
const EMAIL = "sofia@halcyon.studio";
const RESUME = ["Nov 14, 2026", "Dec 14, 2026", "Jan 14, 2027"];
const STEPS = ["Reason", "Offer", "Confirm"];
const STEP_OF: Record<View, number> = { reason: 0, offer: 1, confirm: 2, cancelled: 3, kept: 3 };
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const icon = { size: 16, strokeWidth: 1.75, "aria-hidden": true } as const;

const REASONS: { id: ReasonId; label: string; detail: string; prompt: string; placeholder: string }[] = [
  { id: "price", label: "Too expensive", detail: "The cost is hard to justify right now", prompt: "What would feel like a fair price for your team?", placeholder: "For example, $60 a month would work for us" },
  { id: "usage", label: "Not using it enough", detail: "Our work is seasonal or has slowed down", prompt: "When do you expect to need it again?", placeholder: "For example, after our January launch" },
  { id: "feature", label: "Missing a feature", detail: "Something we need isn't there yet", prompt: "Which feature would keep you here? Emma from product reads these.", placeholder: "For example, client approvals on shared boards" },
  { id: "switching", label: "Moving to another tool", detail: "We're consolidating on one product", prompt: "Which tool are you moving to?", placeholder: "For example, the suite our agency partner uses" },
];

/** Each reason gets the one offer that answers it. The pause length feeds its dates, savings and button label. */
function offerFor(reason: ReasonId, months: number, note: string): Offer {
  if (reason === "usage") {
    const unit = months === 1 ? "month" : "months";
    return {
      title: "Pause instead of cancelling", lead: "Stop billing while things are quiet. Projects, members and integrations stay exactly where they are.",
      figure: { value: months, unit },
      facts: [`Skips ${months === 1 ? "the Oct 14 invoice" : `${months} invoices`}, saving ${usd.format(PRICE * months)}`, `Billing resumes on ${RESUME[months - 1]}`, "Resume early any time from Billing"],
      accept: `Pause for ${months} ${unit}`,
      done: { title: `Paused until ${RESUME[months - 1].replace(/, \d+$/, "")}`, lead: `No charges until ${RESUME[months - 1]}. We'll remind ${EMAIL} a week before billing resumes.`, rows: [["Paused from", "Oct 14, 2026"], ["Billing resumes", RESUME[months - 1]], ["Saved while paused", usd.format(PRICE * months)]], badge: `Paused until ${RESUME[months - 1].replace(/, \d+$/, "")}`, tone: "info", announce: `Plan paused for ${months} ${unit}. Billing resumes on ${RESUME[months - 1]}.` },
    };
  }
  if (reason === "feature") return {
    title: "Tell our product lead what's missing", lead: "Emma reads every note and replies within one business day. October is on us while you wait.",
    figure: { prefix: "$", value: 0, unit: "for October", was: "$96" },
    facts: ["Your Oct 14 invoice is waived", "Emma replies by Wednesday, Sep 23", "Early access if it's already on the roadmap"],
    accept: "Claim free month",
    done: { title: "October is on us", lead: note ? "Emma has your note and will reply by Wednesday. Your Oct 14 invoice is waived." : "Emma will email you by Wednesday to hear what's missing. Your Oct 14 invoice is waived.", rows: [["Oct 14 invoice", "$0.00"], ["Note sent to", "Emma Collins"], ["Reply by", "Sep 23"]], badge: "October waived", tone: "success", announce: "October invoice waived and your note sent to Emma Collins." },
  };
  if (reason === "switching") return {
    title: "Keep your history on Starter", lead: "Moving tools takes a while. Starter keeps every project searchable for less than a third of the price.",
    figure: { prefix: "$", value: 29, unit: "a month", was: "$96" },
    facts: ["All 42 projects and their history stay", "3 editor seats, everyone else becomes a viewer", "Saves $67 a month from Oct 14"],
    accept: "Switch to Starter",
    done: { title: "Starter starts on Oct 14", lead: "Your team keeps working on Team until then. From Oct 14 the invoice is $29.", rows: [["Plan from Oct 14", "Starter"], ["New price", "$29 a month"], ["Projects kept", "42"]], badge: "Starter from Oct 14", tone: "info", announce: "Moving to Starter on Oct 14 at $29 a month." },
  };
  return {
    title: "Stay for 30% less", lead: "Keep every project, seat and integration for $67.20 a month through the end of the year.",
    figure: { prefix: "$", value: 67.2, decimals: 2, unit: "a month", was: "$96" },
    facts: ["Applies to your Oct, Nov and Dec invoices", "Saves $86.40 across the three months", "Returns to $96 a month on Jan 14, 2027"],
    accept: "Apply 30% off",
    done: { title: "30% off is applied", lead: "Your next three invoices drop to $67.20. Nothing else about your workspace changes.", rows: [["Next invoice, Oct 14", "$67.20"], ["Discount ends", "Jan 13, 2027"], ["Saved in total", "$86.40"]], badge: "30% off until Jan 14", tone: "success", announce: "30% off applied to the next three invoices." },
  };
}

const IMPACTS = [
  { Icon: CalendarCheck, title: "Full access until Oct 14, 2026", detail: "The $96 renewal won't be charged.", danger: false },
  { Icon: Lock, title: "Read-only from Oct 14", detail: "All 8 members can still open and export the 42 projects.", danger: false },
  { Icon: Trash2, title: "Deleted on Nov 13, 2026", detail: "Projects, files and history are removed 30 days after the plan ends.", danger: true },
];
const NEXT = [
  { date: "Today", title: "Cancellation confirmed", detail: "No more charges. Your team keeps full access for now.", done: true },
  { date: "Oct 14", title: "Workspace turns read-only", detail: "Everyone can still open and export projects.", done: false },
  { date: "Nov 13", title: "Data is deleted", detail: "Reactivate before then to keep all 42 projects.", done: false },
];

/** Outgoing copies are hidden from assistive tech while they leave. The ref lets popLayout measure the leaving copy. */
function Phase({ children, className, reduce, ref }: { children: ReactNode; className?: string; reduce: boolean; ref?: Ref<HTMLSpanElement> }) {
  const present = useIsPresent();
  return <motion.span ref={ref} className={className} aria-hidden={present ? undefined : true}
    initial={reduce ? { opacity: 0 } : { opacity: 0, y: "0.35em", filter: `blur(${blur.soft}px)` }} animate={{ opacity: 1, y: "0em", filter: "blur(0px)" }}
    exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: "-0.3em", filter: `blur(${blur.subtle}px)`, transition: { duration: duration.fast, ease: standardEase } }}
    transition={reduce ? { duration: 0 } : { duration: duration.standard, ease: enterEase }}>{children}</motion.span>;
}

/** Changing copy rises out of a soft blur while the old line lifts away out of flow. */
function Swap({ children, className }: { children: string; className?: string }) {
  const reduce = !!useReducedMotion();
  return <span className={[styles.swap, className].filter(Boolean).join(" ")}>
    <AnimatePresence mode="popLayout" initial={false}><Phase key={children} className={styles.swapText} reduce={reduce}>{children}</Phase></AnimatePresence>
  </span>;
}

/** Height follows the content on a spring, so a panel that swaps what it holds reshapes instead of jumping. */
function Morph({ children, className }: { children: ReactNode; className?: string }) {
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
  return <motion.div className={[styles.morph, className].filter(Boolean).join(" ")} initial={false} animate={{ height }} transition={reduce ? { duration: 0 } : spring.smooth}>
    <div ref={inner} className={styles.morphInner}>{children}</div>
  </motion.div>;
}

/** The step region springs to the next step's height. Changes inside a step follow exactly, since their own panels already morph. */
function StepRegion({ step, children }: { step: string; children: ReactNode }) {
  const reduce = useReducedMotion();
  const inner = useRef<HTMLDivElement>(null);
  const armedUntil = useRef(0);
  const height = useMotionValue<number | "auto">("auto");
  useLayoutEffect(() => { armedUntil.current = performance.now() + 700; }, [step]);
  useEffect(() => {
    const node = inner.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    let measured = false;
    let sizing: AnimationPlaybackControls | undefined;
    const observer = new ResizeObserver(() => {
      const next = node.offsetHeight;
      sizing?.stop();
      if (!measured || reduce || performance.now() > armedUntil.current) { measured = true; height.jump(next); return; }
      sizing = animate(height, next, spring.smooth);
    });
    observer.observe(node);
    return () => { observer.disconnect(); sizing?.stop(); };
  }, [height, reduce]);
  return <motion.div className={styles.region} style={{ height }}><div ref={inner} className={styles.regionInner}>{children}</div></motion.div>;
}

/** Slim segments fill one after another in the direction of travel, so a jump across steps reads as progress, not a swap. */
function Progress({ at, reduce }: { at: number; reduce: boolean }) {
  const [travel, setTravel] = useState({ to: at, from: at });
  if (travel.to !== at) setTravel({ to: at, from: travel.to });
  const { from } = travel;
  const delayAt = (index: number) => reduce ? 0 : at > from ? Math.max(0, index - from - 1) * stagger.line : Math.max(0, from - index - 1) * stagger.line;
  return <ol className={styles.progress} aria-label="Cancellation steps">
    {STEPS.map((label, index) => {
      const status = index < at ? "complete" : index === at ? "current" : "upcoming";
      return <li key={label} className={styles.step} data-status={status} aria-current={index === at ? "step" : undefined}>
        <span className={styles.bar} aria-hidden="true">
          <motion.span className={styles.barFill} initial={false} animate={{ scaleX: index <= at ? 1 : 0 }} transition={reduce ? { duration: 0 } : { ...spring.smooth, delay: delayAt(index) }} />
        </span>
        <span className={styles.stepLabel}>{label}{status === "complete" && <span className={styles.srOnly}>, done</span>}</span>
      </li>;
    })}
  </ol>;
}

/** The tick draws itself from its short stroke. */
function DrawnCheck() {
  const reduce = useReducedMotion();
  return <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <motion.path d="M4.5 12.5l5 5L19.5 7" initial={{ pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: 1 }} transition={reduce ? { duration: 0 } : { pathLength: { duration: .34, ease: enterEase, delay: .14 }, opacity: { duration: .05, delay: .14 } }} />
  </svg>;
}

function Receipt({ rows, note }: { rows: Row[]; note?: string }) {
  const reduce = useReducedMotion();
  return <div className={styles.receipt}>
    <motion.span className={styles.mark} aria-hidden="true" initial={{ scale: .6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={reduce ? { duration: 0 } : { scale: spring.snappy, opacity: { duration: duration.fast } }}><DrawnCheck /></motion.span>
    <dl className={styles.rows}>
      {rows.map(([term, value], index) => <motion.div key={term} className={styles.row} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={reduce ? { duration: 0 } : { duration: duration.standard, ease: enterEase, delay: .12 + index * stagger.item }}>
        <dt>{term}</dt><dd>{value}</dd>
      </motion.div>)}
    </dl>
    {note ? <p className={styles.footnote}>{note}</p> : null}
  </div>;
}

export function CancelFlow() {
  const id = useId();
  const groupId = useId();
  const reduce = !!useReducedMotion();
  const [view, setView] = useState<View>("reason");
  const [dir, setDir] = useState(1);
  const [reason, setReason] = useState<ReasonId | null>(null);
  const [note, setNote] = useState("");
  const [months, setMonths] = useState(2);
  const [offerState, setOfferState] = useState<"idle" | "applying" | "applied">("idle");
  const [holding, setHolding] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [kept, setKept] = useState<"stayed" | "reactivated">("stayed");
  const [exportState, setExportState] = useState<"idle" | "working" | "done">("idle");
  const [announcement, setAnnouncement] = useState("");
  // Each visit to the reason step gets its own highlight id, so a returning highlight never resumes from a stale card box.
  const [visit, setVisit] = useState(0);
  const cards = useRef(new Map<ReasonId, HTMLButtonElement>());
  const focusNext = useRef<string | null>(null);
  const timers = useRef(new Set<number>());

  // Focus lands on the new step's heading, or on the control that replaced the one just pressed.
  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    document.getElementById(target)?.focus({ preventScroll: true });
  });
  useEffect(() => { const pending = timers.current; return () => pending.forEach(timer => window.clearTimeout(timer)); }, []);
  const later = (run: () => void, ms: number) => { const timer = window.setTimeout(() => { timers.current.delete(timer); run(); }, ms); timers.current.add(timer); };

  const trimmed = note.trim();
  const offer = reason ? offerFor(reason, months, trimmed) : null;
  const applied = view === "offer" && offerState === "applied";
  const busy = offerState === "applying" || (cancelled && view === "confirm");
  const at = applied ? 3 : STEP_OF[view];
  const status: { text: string; tone: BadgeTone } = cancelled ? { text: "Ends Oct 14", tone: "warning" } : applied && offer ? { text: offer.done.badge, tone: offer.done.tone } : { text: "Renews Oct 14", tone: "neutral" };
  const chosen = REASONS.find(item => item.id === reason);

  function go(next: View, direction: 1 | -1, message: string) {
    setDir(direction);
    if (next === "reason") setVisit(count => count + 1);
    setView(next);
    setAnnouncement(message);
    focusNext.current = `${id}-${next}`;
  }

  function onReasonKey(event: KeyboardEvent<HTMLDivElement>) {
    const order = REASONS.map(item => item.id);
    const from = order.indexOf((event.target as HTMLElement).dataset.reason as ReasonId);
    const step = ({ ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 } as Record<string, number>)[event.key];
    const next = event.key === "Home" ? order[0] : event.key === "End" ? order[order.length - 1] : step ? order[(Math.max(from, 0) + step + order.length) % order.length] : undefined;
    if (!next) return;
    event.preventDefault();
    setReason(next);
    cards.current.get(next)?.focus();
  }

  function changeMonths(delta: number) {
    const next = Math.min(3, Math.max(1, months + delta));
    if (next === months || offerState !== "idle") return;
    setMonths(next);
    setAnnouncement(`Pause for ${next} ${next === 1 ? "month" : "months"}. Billing resumes on ${RESUME[next - 1]}.`);
  }

  function onMonthsKey(event: KeyboardEvent<HTMLDivElement>) {
    const delta = ({ ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, Home: -2, End: 2 } as Record<string, number>)[event.key];
    if (!delta) return;
    event.preventDefault();
    changeMonths(delta);
  }

  function accept() {
    if (!offer || offerState !== "idle") return;
    const message = offer.done.announce;
    setOfferState("applying");
    later(() => { setOfferState("applied"); setAnnouncement(message); focusNext.current = `${id}-undo`; }, 900);
  }

  function undo() {
    setOfferState("idle");
    setAnnouncement("Offer removed. Your plan is back to $96 a month.");
    focusNext.current = `${id}-accept`;
  }

  function confirmCancel() {
    setCancelled(true);
    setHolding(false);
    setAnnouncement("Team plan cancelled.");
    later(() => go("cancelled", 1, "Your plan ends on Oct 14. Here is what happens next."), 900);
  }

  function exportData() {
    if (exportState !== "idle") return;
    setExportState("working");
    later(() => { setExportState("done"); setAnnouncement(`Export requested. A download link is on its way to ${EMAIL}.`); }, 1100);
  }

  function reactivate() {
    setKept("reactivated");
    setCancelled(false);
    setExportState("idle");
    go("kept", 1, "Plan reactivated. It renews on Oct 14.");
  }

  function startOver() {
    setReason(null);
    setNote("");
    setMonths(2);
    setOfferState("idle");
    setCancelled(false);
    setExportState("idle");
    go("reason", -1, "Step 1 of 3: why are you cancelling?");
  }

  const heading = (text: ReactNode) => <h2 id={`${id}-${view}`} tabIndex={-1} className={styles.title}>{text}</h2>;
  const stagger6 = (index: number) => ({ initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 }, transition: reduce ? { duration: 0 } : { duration: duration.standard, ease: enterEase, delay: .1 + index * stagger.line } });
  const panelSwap = {
    initial: reduce ? { opacity: 0 } : { opacity: 0, y: 8, filter: `blur(${blur.soft}px)` },
    animate: { opacity: 1, y: 0, filter: "blur(0px)" },
    exit: reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -4, filter: `blur(${blur.subtle}px)`, transition: { duration: duration.exit, ease: standardEase } },
    transition: reduce ? { duration: 0 } : { duration: duration.standard, ease: enterEase, delay: .06 },
  };
  const fade = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0, transition: { duration: reduce ? 0 : duration.instant } }, transition: { duration: reduce ? 0 : duration.fast } };

  function renderView() {
    if (view === "reason") return <>
      <header className={styles.head}>
        {heading("Why are you cancelling?")}
        <p className={styles.lead}>Your answer shapes what we suggest next. Nothing changes until you confirm on the last step.</p>
      </header>
      <LayoutGroup id={groupId}>
        <div className={styles.reasons} role="radiogroup" aria-labelledby={`${id}-reason`} onKeyDown={onReasonKey}>
          {REASONS.map((item, index) => {
            const checked = reason === item.id;
            return <button key={item.id} ref={node => { if (node) cards.current.set(item.id, node); else cards.current.delete(item.id); }} type="button" role="radio" aria-checked={checked}
              tabIndex={checked || (!reason && index === 0) ? 0 : -1} data-reason={item.id} className={styles.reason} onClick={() => setReason(item.id)}>
              {checked && <motion.span layoutId={`reason-highlight-${visit}`} className={styles.highlight} style={{ borderRadius: 13 }} transition={reduce ? { duration: 0 } : spring.morph} />}
              <span className={styles.reasonHead}><span className={styles.reasonLabel}>{item.label}</span><span className={styles.radio} aria-hidden="true" /></span>
              <span className={styles.reasonDetail}>{item.detail}</span>
            </button>;
          })}
        </div>
      </LayoutGroup>
      <AnimatePresence initial={false}>
        {chosen && <motion.div key="note" className={styles.noteSlot} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
          transition={reduce ? { duration: 0 } : { height: spring.smooth, opacity: { duration: duration.standard, ease: enterEase } }}>
          <div className={styles.note}>
            <Textarea id={`${id}-note`} label="Add a note (optional)" description={chosen.prompt} placeholder={chosen.placeholder} rows={3} maxLength={280} value={note} onChange={event => setNote(event.target.value)} />
          </div>
        </motion.div>}
      </AnimatePresence>
      <div className={styles.actions}>
        <div className={styles.actionsEnd}>
          <Button disabled={!reason} onClick={() => { if (!reason) return; setOfferState("idle"); go("offer", 1, "Step 2 of 3: an offer based on your reason."); }}>Continue</Button>
        </div>
      </div>
    </>;

    if (view === "offer" && offer && reason) {
      const usage = reason === "usage";
      return <>
        <header className={styles.head}>
          <Morph>{heading(<Swap>{applied ? offer.done.title : offer.title}</Swap>)}</Morph>
          <Morph><p className={styles.lead}><Swap>{applied ? offer.done.lead : offer.lead}</Swap></p></Morph>
        </header>
        <Morph className={styles.panel}>
          <AnimatePresence mode="popLayout" initial={false}>
            {applied ? <motion.div key="done" {...panelSwap}><Receipt rows={offer.done.rows} /></motion.div>
              : <motion.div key="offer" className={styles.offerBody} {...panelSwap}>
                <div className={styles.figureRow}>
                  <div className={styles.figure} role={usage ? "spinbutton" : undefined} tabIndex={usage ? 0 : undefined} aria-label={usage ? "Pause length" : undefined}
                    aria-valuemin={usage ? 1 : undefined} aria-valuemax={usage ? 3 : undefined} aria-valuenow={usage ? months : undefined} aria-valuetext={usage ? `${months} ${offer.figure.unit}, resumes ${RESUME[months - 1]}` : undefined} onKeyDown={usage ? onMonthsKey : undefined}>
                    <span className={styles.figureNum}><AnimatedCounter value={offer.figure.value} prefix={offer.figure.prefix} decimals={offer.figure.decimals} animateOnView /></span>
                    <Swap className={styles.figureUnit}>{offer.figure.unit}</Swap>
                  </div>
                  {usage ? <div className={styles.monthControls}>
                    <Button variant="secondary" size="sm" className={styles.iconButton} aria-label="Pause one month less" aria-disabled={months === 1 || busy || undefined} onClick={() => changeMonths(-1)}><Minus {...icon} /></Button>
                    <Button variant="secondary" size="sm" className={styles.iconButton} aria-label="Pause one month more" aria-disabled={months === 3 || busy || undefined} onClick={() => changeMonths(1)}><Plus {...icon} /></Button>
                  </div> : offer.figure.was ? <p className={styles.was}><span className={styles.srOnly}>Instead of </span><s>{offer.figure.was}</s></p> : null}
                </div>
                {reason === "feature" && <div className={styles.person}>
                  <Avatar name="Emma Collins" src="/media/people/emma-collins.jpg" />
                  <div>
                    <p className={styles.personName}>Emma Collins <span>Product lead</span></p>
                    <p className={styles.quote}>{trimmed ? `Your note: “${trimmed}”` : "No note yet. Go back to add one, or Emma will ask when she replies."}</p>
                  </div>
                </div>}
                <ul className={styles.facts}>
                  {offer.facts.map((fact, index) => <li key={index}><Check size={16} strokeWidth={2} aria-hidden="true" /><Swap>{fact}</Swap></li>)}
                </ul>
              </motion.div>}
          </AnimatePresence>
        </Morph>
        <div className={styles.actions}>
          <AnimatePresence mode="popLayout" initial={false}>
            {!applied && <motion.div key="back" {...fade}><Button variant="ghost" className={styles.inert} aria-disabled={busy || undefined} onClick={() => { if (!busy) go("reason", -1, "Step 1 of 3: why are you cancelling?"); }}><ArrowLeft {...icon} />Back</Button></motion.div>}
          </AnimatePresence>
          <AnimatePresence mode="popLayout" initial={false}>
            {applied
              ? <motion.div key="undo" className={styles.actionsEnd} {...fade}><Button id={`${id}-undo`} variant="secondary" onClick={undo}><RotateCcw {...icon} />Undo</Button></motion.div>
              : <motion.div key="choose" className={styles.actionsEnd} {...fade}>
                <Button variant="ghost" className={styles.inert} aria-disabled={busy || undefined} onClick={() => { if (!busy) go("confirm", 1, "Step 3 of 3: confirm cancellation."); }}>Continue to cancel</Button>
                <Button id={`${id}-accept`} loading={offerState === "applying"} onClick={accept}>{offer.accept}</Button>
              </motion.div>}
          </AnimatePresence>
        </div>
      </>;
    }

    if (view === "confirm") return <>
      <header className={styles.head}>
        {heading("Before you cancel")}
        <p className={styles.lead}>Your team keeps full access until the end of this billing period. Here is what changes after that.</p>
      </header>
      <ul className={styles.impacts}>
        {IMPACTS.map(({ Icon, title, detail, danger }, index) => <motion.li key={title} className={styles.impact} data-danger={danger || undefined} {...stagger6(index)}>
          <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
          <div><p className={styles.impactTitle}>{title}</p><p className={styles.impactDetail}>{detail}</p></div>
        </motion.li>)}
      </ul>
      <div className={styles.actions}>
        <Button variant="ghost" className={styles.inert} aria-disabled={busy || undefined} onClick={() => { if (!busy) go("offer", -1, "Step 2 of 3: an offer based on your reason."); }}><ArrowLeft {...icon} />Back</Button>
        <div className={styles.actionsEnd}>
          <Button variant="secondary" className={styles.inert} aria-disabled={busy || undefined} onClick={() => { if (busy) return; setKept("stayed"); go("kept", 1, "Nothing changed. Your Team plan stays active."); }}>Keep my plan</Button>
          <HoldToConfirm label="Hold to cancel plan" confirmedLabel="Plan cancelled" confirmed={cancelled} onConfirm={confirmCancel} onHoldChange={setHolding} />
        </div>
      </div>
      <p className={styles.hint} aria-hidden="true"><Swap>{cancelled ? "Cancelled. Wrapping up" : holding ? "Keep holding" : "Hold for 1.2 seconds"}</Swap></p>
    </>;

    if (view === "cancelled") return <>
      <header className={styles.head}>
        {heading("Your plan ends on Oct 14")}
        <p className={styles.lead}>Thanks for building with us. A confirmation is on its way to {EMAIL}.</p>
      </header>
      <h3 className={styles.subhead}>What happens next</h3>
      <ol className={styles.timeline}>
        {NEXT.map((item, index) => <motion.li key={item.title} className={styles.event} data-done={item.done || undefined} {...stagger6(index)}>
          <span className={styles.eventDate}>{item.date}</span>
          <span className={styles.eventDot} aria-hidden="true">{item.done && <Check size={10} strokeWidth={3} />}</span>
          <div><p className={styles.eventTitle}>{item.title}{item.done && <span className={styles.srOnly}>, done</span>}</p><p className={styles.eventDetail}>{item.detail}</p></div>
        </motion.li>)}
      </ol>
      <div className={styles.actions}>
        <Button variant="secondary" loading={exportState === "working"} onClick={exportData}>{exportState === "done" ? <><Check {...icon} />Export requested</> : <><Download {...icon} />Export data</>}</Button>
        <div className={styles.actionsEnd}><Button variant="secondary" onClick={reactivate}><RotateCcw {...icon} />Reactivate plan</Button></div>
      </div>
    </>;

    return <>
      <header className={styles.head}>
        {heading(kept === "stayed" ? "Your Team plan stays active" : "Your plan is active again")}
        <p className={styles.lead}>{kept === "stayed" ? "Nothing changed. Your projects, members and integrations carry on as before." : "The cancellation is undone and nothing will be deleted."}</p>
      </header>
      <div className={styles.panel}><Receipt rows={[["Plan", "Team, 8 seats"], ["Next invoice", "Oct 14, 2026"], ["Amount", "$96.00"]]} note={kept === "stayed" ? "No changes were made." : undefined} /></div>
      <div className={styles.actions}>
        <div className={styles.actionsEnd}><Button variant="ghost" onClick={startOver}><RotateCcw {...icon} />Start over</Button></div>
      </div>
    </>;
  }

  const custom = { dir, reduce };
  return <section className={styles.root} aria-label="Cancel subscription">
    <div className={styles.card}>
      <div className={styles.top}>
        <div className={styles.plan}><p className={styles.planName}>Team plan</p><p className={styles.planMeta}>Halcyon Studio · 8 seats · $96 a month</p></div>
        <Badge size="sm" tone={status.tone}>{status.text}</Badge>
      </div>
      <Progress at={at} reduce={reduce} />
      <StepRegion step={view}>
        <AnimatePresence mode="popLayout" initial={false} custom={custom}>
          <motion.div key={view} className={styles.view} custom={custom} variants={viewVariants} initial="enter" animate="center" exit="exit">{renderView()}</motion.div>
        </AnimatePresence>
      </StepRegion>
      <p className={styles.srOnly} role="status" aria-live="polite">{announcement}</p>
    </div>
  </section>;
}

type ViewCustom = { dir: number; reduce: boolean };
/** Steps travel in the direction of progress: forward slides in from the right, back from the left. */
const viewVariants: Variants = {
  enter: ({ dir, reduce }: ViewCustom) => reduce ? { opacity: 0 } : { opacity: 0, x: 28 * dir, filter: `blur(${blur.soft}px)` },
  center: ({ reduce }: ViewCustom) => ({ opacity: 1, x: 0, filter: "blur(0px)", transition: reduce ? { duration: 0 } : { x: spring.smooth, opacity: { duration: duration.standard, ease: enterEase }, filter: { duration: duration.standard, ease: enterEase } } }),
  exit: ({ dir, reduce }: ViewCustom) => reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, x: -20 * dir, filter: `blur(${blur.subtle}px)`, transition: { duration: duration.exit, ease: standardEase } },
};

export default CancelFlow;
