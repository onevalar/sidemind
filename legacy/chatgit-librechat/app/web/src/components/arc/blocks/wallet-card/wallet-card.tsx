"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useMotionValueEvent, useReducedMotion } from "motion/react";
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Bell, Check, Cloud, CreditCard, Eye, EyeOff, Landmark, PanelsTopLeft, Plus, ReceiptText, Search, Send, Type, X, Wallet, ChevronRight } from "lucide-react";
import { Button } from "../../button/button";
import { DropdownMenu } from "../../dropdown-menu/dropdown-menu";
import { Popover, PopoverTrigger, PopoverContent } from "../../popover/popover";
import SegmentedControl from "../../segmented-control/segmented-control";
import { motionTokens } from "../../lib/motion-tokens";
import styles from "./wallet-card.module.css";

type WalletId = "main" | "reserve";
type Action = "deposit" | "send" | "swap" | "buy" | null;
type EntryKind = "payment" | "tools" | "license" | "hosting" | "investment" | "transfer" | "deposit" | "send";
type Entry = { id: string; wallet: WalletId; title: string; detail: string; cents: number; kind: EntryKind };
const initialEntries: Entry[] = [
  { id: "client", wallet: "main", title: "Client payment", detail: "18 Sep · Studio North", cents: 85000, kind: "payment" },
  { id: "tools", wallet: "main", title: "Workspace tools", detail: "16 Sep · Subscription", cents: -4800, kind: "tools" },
  { id: "type", wallet: "main", title: "Type license", detail: "14 Sep · Purchase", cents: -1200, kind: "license" },
  { id: "hosting", wallet: "main", title: "Website hosting", detail: "10 Sep · Cloud plan", cents: -2400, kind: "hosting" },
  { id: "invoice", wallet: "main", title: "Design retainer", detail: "8 Sep · Forma Studio", cents: 125000, kind: "payment" },
  { id: "reserve", wallet: "reserve", title: "Monthly allocation", detail: "12 Sep · From main wallet", cents: 50000, kind: "transfer" },
];
const entryIcons = { payment: ReceiptText, tools: PanelsTopLeft, license: Type, hosting: Cloud, investment: Landmark, transfer: ArrowLeftRight, deposit: Plus, send: Send } satisfies Record<EntryKind, typeof ReceiptText>;
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const format = (cents: number) => money.format(cents / 100);
const actionLabels: Record<Exclude<Action, null>, string> = { deposit: "Deposit", send: "Send", swap: "Swap", buy: "Buy" };

function parseAmount(value: string) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const cents = Math.round(Number(value) * 100);
  return Number.isSafeInteger(cents) && cents > 0 && cents <= 100_000_000 ? cents : null;
}

function AnimatedAmount({ cents }: { cents: number }) {
  const reduce = useReducedMotion();
  const value = useMotionValue(cents);
  const [display, setDisplay] = useState(cents);
  useMotionValueEvent(value, "change", latest => setDisplay(Math.round(latest)));
  useEffect(() => {
    if (reduce) {
      value.set(cents);
      return;
    }
    const animation = animate(value, cents, { duration: .75, ease: motionTokens.ease.standard });
    return () => animation.stop();
  }, [cents, reduce, value]);
  return <>{format(reduce ? cents : display)}</>;
}

export interface WalletCardProps { initialBalanceCents?: number }

/** A local wallet preview. All actions update sample state only. */
export function WalletCard({ initialBalanceCents = 1_248_032 }: WalletCardProps) {
  const reduce = useReducedMotion();
  const [wallet, setWallet] = useState<WalletId>("main");
  const [balances, setBalances] = useState<Record<WalletId, number>>({ main: initialBalanceCents, reserve: 285_000 });
  const [entries, setEntries] = useState(initialEntries);
  const [range, setRange] = useState("month");
  const [point, setPoint] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [hidden, setHidden] = useState(false);
  const [action, setAction] = useState<Action>(null);
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  // The detail area animates its real height to whichever panel it holds, so the footer glides instead of jumping between panels.
  const detailContent = useRef<HTMLDivElement>(null);
  const [detailHeight, setDetailHeight] = useState<number | null>(null);
  useEffect(() => {
    const node = detailContent.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setDetailHeight(node.offsetHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const panelTransition = reduce ? { duration: 0 } : { duration: motionTokens.duration.exit, ease: motionTokens.ease.standard };
  const actionRefs = useRef<Partial<Record<Exclude<Action, null>, HTMLButtonElement | null>>>({});
  const panelId = useId();
  const errorId = useId();
  const walletName = wallet === "main" ? "Main wallet" : "Reserve wallet";
  const otherName = wallet === "main" ? "Reserve wallet" : "Main wallet";
  const otherWallet: WalletId = wallet === "main" ? "reserve" : "main";
  const visibleEntries = entries.filter(entry => entry.wallet === wallet && `${entry.title} ${entry.detail}`.toLowerCase().includes(search.trim().toLowerCase())).slice(0, showAll ? undefined : 3);
  const history = (range === "week" ? [0.87, .89, .88, .94, .92, .96, 1] : range === "year" ? [.58, .64, .61, .7, .68, .76, .74, .83, .8, .9, .93, 1] : [.84, .85, .83, .88, .87, .9, .88, .94, .92, .96, .95, 1]).map(value => Math.round(balances[wallet] * value));
  const chartY = (value: number) => 104 - (value - Math.min(...history)) / Math.max(1, Math.max(...history) - Math.min(...history)) * 88;
  const chartPoints = history.map((value, index) => `${index / (history.length - 1) * 560},${chartY(value)}`).join(" ");
  const monthChange = entries.filter(entry => entry.wallet === wallet).reduce((sum, entry) => sum + entry.cents, 0);

  function openAction(next: Exclude<Action, null>) {
    setAction(next); setAmount(""); setRecipient(""); setError(""); setFeedback(""); setNoticeOpen(false);
  }
  function record(entry: Entry, balanceDelta: Partial<Record<WalletId, number>>) {
    setEntries(current => [entry, ...current]);
    setBalances(current => ({ main: current.main + (balanceDelta.main ?? 0), reserve: current.reserve + (balanceDelta.reserve ?? 0) }));
    if (action) actionRefs.current[action]?.focus();
    setAction(null); setAmount(""); setRecipient(""); setError("");
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action) return;
    const cents = parseAmount(amount);
    if (cents === null) { setError("Enter an amount between $0.01 and $1,000,000.00."); return; }
    if (action !== "deposit" && cents > balances[wallet]) { setError("The amount is above the available balance."); return; }
    if (action === "send" && !recipient.trim()) { setError("Enter a recipient name."); return; }
    const id = `demo-${Date.now()}`;
    if (action === "swap") {
      record({ id, wallet, title: `Moved to ${otherName}`, detail: "Just now · Transfer", cents: -cents, kind: "transfer" }, { [wallet]: -cents, [otherWallet]: cents });
      setEntries(current => [{ id: `${id}-in`, wallet: otherWallet, title: `From ${walletName}`, detail: "Just now · Transfer", cents, kind: "transfer" }, ...current]);
      setFeedback(`${format(cents)} moved to ${otherName}.`);
      return;
    }
    const delta = action === "deposit" ? cents : -cents;
    const title = action === "deposit" ? "Deposit" : action === "send" ? `To ${recipient.trim()}` : "Index fund purchase";
    record({ id, wallet, title, detail: "Just now · Activity", cents: delta, kind: action === "deposit" ? "deposit" : action === "send" ? "send" : "investment" }, { [wallet]: delta });
    setFeedback(`${format(cents)} ${action === "deposit" ? "added" : action === "send" ? "sent" : "used to buy shares"}.`);
  }
  function simulate() {
    record({ id: `sample-${Date.now()}`, wallet, title: "Added funds", detail: "Just now · Activity", cents: 12450, kind: "deposit" }, { [wallet]: 12450 });
    setFeedback(`${format(12450)} added to ${walletName}.`);
  }

  return <section className={styles.wallet} aria-label="Wallet preview">
    <div className={styles.topRow}>
      <DropdownMenu label={walletName} icon={<Wallet size={16} strokeWidth={1.75} />} items={(["main", "reserve"] as const).map(id => ({ label: `${id === "main" ? "Main wallet" : "Reserve wallet"} · ${hidden ? "••••" : format(balances[id])}`, icon: wallet === id ? <Check size={16} strokeWidth={1.75} /> : <Wallet size={16} strokeWidth={1.75} />, onSelect: () => { setWallet(id); setAction(null); setFeedback(""); setPoint(null); } }))} />
      <div className={styles.topActions}>
        <button type="button" className={styles.iconButton} aria-label={searchOpen ? "Close activity search" : "Search activity"} aria-expanded={searchOpen} onClick={() => { setSearchOpen(value => !value); setAction(null); setSearch(""); setNoticeOpen(false); }}>{searchOpen ? <X size={20} strokeWidth={1.75} /> : <Search size={20} strokeWidth={1.75} />}</button>
        <Popover open={noticeOpen} onOpenChange={setNoticeOpen}><PopoverTrigger asChild><button type="button" className={styles.iconButton} aria-label="Notifications"><Bell size={20} strokeWidth={1.75} /><span className={styles.noticeDot} /></button></PopoverTrigger><PopoverContent align="end" className={styles.notice}><strong>Wallet updates</strong><span>{feedback || "Your $850.00 payment from Studio North arrived on 18 September."}</span><small>Demo notification · No live account connected</small></PopoverContent></Popover>
      </div>
    </div>

    <div className={styles.balanceArea}>
      <div className={styles.balanceLabel}>{point === null ? "Available balance" : `${range === "week" ? "Day" : range === "year" ? "Month" : "September"} ${point + 1}`} <button type="button" aria-label={hidden ? "Show balance" : "Hide balance"} onClick={() => setHidden(value => !value)}>{hidden ? <EyeOff size={16} strokeWidth={1.75} /> : <Eye size={16} strokeWidth={1.75} />}</button></div>
      <div className={styles.balance} aria-live="polite">{hidden ? <span className={styles.hiddenBalance} aria-label="Balance hidden"><span aria-hidden="true">$ ••••••</span></span> : <AnimatedAmount cents={point === null ? balances[wallet] : history[point]} />}</div>
      <div className={styles.balanceMeta}><span className={styles.changePill} data-negative={monthChange < 0}>{monthChange >= 0 ? <ArrowUpRight size={16} strokeWidth={1.75} /> : <ArrowDownLeft size={16} strokeWidth={1.75} />}{hidden ? "••••" : <>{monthChange >= 0 ? "+" : "−"}<AnimatedAmount cents={Math.abs(monthChange)} /></>}<span> this month</span></span><span className={styles.currency}>USD</span></div>
      <div className={styles.chart} onPointerLeave={() => setPoint(null)}>
        <svg viewBox="0 0 560 120" preserveAspectRatio="none" aria-hidden="true"><path className={styles.chartGuide} d="M0 30H560 M0 70H560 M0 110H560" /><motion.polyline points={chartPoints} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" initial={false} animate={{ points: chartPoints }} transition={reduce ? { duration: 0 } : motionTokens.spring.gentle} />{point !== null && <><line x1={point / (history.length - 1) * 560} x2={point / (history.length - 1) * 560} y1="0" y2="120" stroke="var(--border-strong)" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" /></>}</svg>
        {point !== null && <span className={styles.chartDot} style={{ left: `${point / (history.length - 1) * 100}%`, top: `${chartY(history[point]) / 120 * 100}%` }} aria-hidden="true" />}
        <input className={styles.chartScrubber} type="range" min="0" max={history.length - 1} value={point ?? history.length - 1} aria-label="Explore sample balance history" aria-valuetext={hidden ? "Balance hidden" : format(history[point ?? history.length - 1])} onChange={event => setPoint(Number(event.target.value))} onBlur={() => setPoint(null)} onPointerMove={event => { if (event.pointerType === "mouse") { const bounds = event.currentTarget.getBoundingClientRect(); setPoint(Math.max(0, Math.min(history.length - 1, Math.round((event.clientX - bounds.left) / bounds.width * (history.length - 1))))); } }} />
      </div>
      <div className={styles.chartFoot}><span>{range === "week" ? "Last 7 days" : range === "year" ? "Last 12 months" : "Last 30 days"}</span><SegmentedControl label="Balance history period" value={range} onValueChange={value => { setRange(value); setPoint(null); }} options={[{ value: "week", label: "1W" }, { value: "month", label: "1M" }, { value: "year", label: "1Y" }]} /></div>
    </div>

    <div className={styles.actions}>
      {(["send", "deposit", "swap", "buy"] as const).map(kind => {
        const Icon = kind === "send" ? ArrowUpRight : kind === "deposit" ? Plus : kind === "swap" ? ArrowLeftRight : CreditCard;
        return <button type="button" key={kind} ref={node => { actionRefs.current[kind] = node; }} aria-pressed={action === kind} aria-controls={panelId} className={styles.actionButton} onClick={() => action === kind ? setAction(null) : openAction(kind)}><Icon size={20} strokeWidth={1.75} /><span>{actionLabels[kind]}</span><ChevronRight className={styles.actionArrow} size={16} strokeWidth={1.75} /></button>;
      })}
    </div>

    <motion.div className={styles.detail} id={panelId} initial={false} animate={{ height: detailHeight ?? "auto" }} transition={reduce ? { duration: 0 } : motionTokens.spring.smooth}>
      <div ref={detailContent} className={styles.detailContent}>
      <AnimatePresence mode="wait" initial={false}>
        {action ? <motion.div key={action} className={styles.actionPanel} initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }} transition={panelTransition}>
          <div className={styles.detailHeading}><div><h2>{actionLabels[action]}</h2><p>{action === "swap" ? `Move funds to ${otherName}.` : action === "buy" ? "Buy shares in an index fund." : action === "send" ? "Send a payment." : "Add funds to this wallet."}</p></div><button type="button" className={styles.iconButton} aria-label="Close action" onClick={() => { actionRefs.current[action]?.focus(); setAction(null); setError(""); }}><X size={20} strokeWidth={1.75} /></button></div>
          <form className={styles.form} onSubmit={submit} noValidate>{action === "send" && <label>Recipient<input value={recipient} onChange={event => { setRecipient(event.target.value); setError(""); }} placeholder="e.g. Studio North" maxLength={48} /></label>}<label>Amount in USD<input autoFocus value={amount} onChange={event => { setAmount(event.target.value); setError(""); }} inputMode="decimal" placeholder="0.00" aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} /></label>{error && <p id={errorId} className={styles.error} role="alert">{error}</p>}<Button type="submit">{action === "swap" ? "Move funds" : action === "send" ? "Record payment" : action === "buy" ? "Buy shares" : "Add funds"} <ArrowUpRight size={16} strokeWidth={1.75} /></Button></form>
        </motion.div> : <motion.div key="activity" className={styles.activityPanel} initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={reduce ? { opacity: 0 } : { opacity: 0, y: -5 }} transition={panelTransition}>
          <div className={styles.detailHeading}><h2>{showAll ? "All activity" : "Recent activity"}</h2><button type="button" className={styles.textButton} onClick={() => setShowAll(value => !value)}>{showAll ? "Show less" : "View all"}<ChevronRight size={16} strokeWidth={1.75} /></button></div>
          <AnimatePresence initial={false}>{searchOpen && <motion.div key="search" className={styles.searchReveal} initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }} transition={reduce ? { duration: 0 } : motionTokens.spring.smooth}><label className={styles.searchField}><Search size={16} strokeWidth={1.75} /><input value={search} onChange={event => setSearch(event.target.value)} autoFocus placeholder="Search activity" aria-label="Search activity" /></label></motion.div>}</AnimatePresence>
          <ul className={styles.entries}><AnimatePresence initial={false}>{visibleEntries.map(entry => { const Icon = entryIcons[entry.kind]; return <motion.li key={entry.id} layout={reduce ? false : "position"} initial={reduce ? false : { opacity: 0, height: 0 }} animate={{ opacity: 1, height: 60 }} exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }} transition={reduce ? { duration: 0 } : motionTokens.spring.gentle}><span className={styles.entryIcon} data-flow={entry.kind === "transfer" ? "transfer" : entry.cents >= 0 ? "incoming" : "outgoing"} aria-hidden="true"><Icon size={20} strokeWidth={1.75} /></span><span className={styles.entryText}><strong>{entry.title}</strong><small>{entry.detail}</small></span><span className={styles.entryAmount}>{entry.cents >= 0 ? "+" : "−"}{format(Math.abs(entry.cents))}</span></motion.li>; })}</AnimatePresence></ul>
          {visibleEntries.length === 0 && <p className={styles.empty}>No activity matches your search.</p>}
        </motion.div>}
      </AnimatePresence>
      </div>
    </motion.div>
    <div className={styles.foot}><span role="status" aria-live="polite">{feedback ? <><Check size={16} strokeWidth={1.75} /> {feedback}</> : ""}</span><button type="button" onClick={simulate}><Plus size={16} strokeWidth={1.75} /> Add $124.50</button></div>
  </section>;
}

export default WalletCard;
