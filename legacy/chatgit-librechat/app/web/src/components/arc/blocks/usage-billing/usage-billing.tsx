"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, RefObject } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion } from "motion/react";
import { AlertTriangle, ArrowRight, Check, CreditCard, Download, Mail, Plus, RotateCcw, X } from "lucide-react";
import { AnimatedCounter } from "../../animated-counter/animated-counter";
import { Button } from "../../button/button";
import { TextMorph } from "../../text-morph/text-morph";
import { motionTokens } from "../../lib/motion-tokens";
import { billingPeriod, currentPlan, dailySpend, invoices as sampleInvoices, meters as sampleMeters, monthlyBudget, paymentMethod, spendAlerts, upgradePlan } from "./usage-billing-data";
import type { Invoice, Meter, MeterUnit, Plan, SpendAlert } from "./usage-billing-data";
import styles from "./usage-billing.module.css";

export type { Invoice, Meter, MeterUnit, Plan, SpendAlert } from "./usage-billing-data";

export interface UsageBillingProps {
  /** Current period: a label, its length in days, and which day it is today (1 based). */
  period?: { label: string; start: string; days: number; today: number };
  /** Usage charges per day so far this period. Its length should equal period.today. */
  daily?: number[];
  /** Monthly budget drawn on the chart. */
  budget?: number;
  meters?: Meter[];
  plan?: Plan;
  /** The plan offered in the upgrade card. Pass null to hide the offer. */
  upgrade?: Plan | null;
  /** Initial spend alerts in uncontrolled mode. */
  defaultAlerts?: SpendAlert[];
  /** Called whenever alerts are added, edited, or removed. */
  onAlertsChange?: (alerts: SpendAlert[]) => void;
  invoices?: Invoice[];
  payment?: { brand: string; last4: string; expires: string };
  /** Runs the upgrade. Resolve to switch plans, reject to show an error. Without it the upgrade is simulated. */
  onUpgrade?: (plan: Plan) => Promise<void> | void;
  /** Fetches an invoice PDF. Without it the download is simulated. */
  onDownloadInvoice?: (invoice: Invoice) => Promise<void> | void;
  /** ISO currency code for every amount. */
  currency?: string;
  className?: string;
}

type Rect = { x: number; y: number; width: number; height: number };

const enterEase = [...motionTokens.ease.enter] as [number, number, number, number];
/** The card-to-sheet morph and the meter fills use the shared critically damped panel spring. */
const calm = motionTokens.spring.smooth;
const settle = motionTokens.spring.smooth;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const trim = (value: number, digits = 2) => value.toFixed(digits).replace(/\.?0+$/, "");
function formatUnit(value: number, unit: MeterUnit) {
  if (unit === "requests" || unit === "invocations") return value >= 1e6 ? `${trim(value / 1e6)}M` : value >= 1e3 ? `${trim(value / 1e3, 1)}K` : `${Math.round(value)}`;
  if (unit === "gigabytes") return value >= 1000 ? `${trim(value / 1000)} TB` : `${Math.round(value)} GB`;
  if (unit === "minutes") return `${Math.round(value).toLocaleString("en-US")} min`;
  return `${Math.round(value)} ${Math.round(value) === 1 ? "seat" : "seats"}`;
}
/** "25M API requests", "12,000 build minutes": keeps acronyms, drops the unit when the name already says it. */
function perkText(meter: Meter, value: number) {
  const name = meter.name.split(" ").map(word => word === word.toUpperCase() ? word : word.toLowerCase()).join(" ");
  if (meter.unit === "minutes" || meter.unit === "seats") return `${Math.round(value).toLocaleString("en-US")} ${name}`;
  return `${formatUnit(value, meter.unit)} ${name}`;
}
function dayLabel(start: string, offset: number) {
  const date = new Date(`${start}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}
function relativeRect(node: Element, frame: Element): Rect {
  const a = node.getBoundingClientRect(), b = frame.getBoundingClientRect();
  return { x: a.left - b.left, y: a.top - b.top, width: a.width, height: a.height };
}
function niceCeil(value: number) {
  const step = 10 ** Math.floor(Math.log10(value)) / 2;
  return Math.ceil(value / step) * step;
}

function useWidth(ref: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    setWidth(node.offsetWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(node.offsetWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** Cumulative spend as a solid line, the rest of the month as a dashed projection, and every alert as a rule that moves while you edit it. */
function SpendChart({ cumulative, projection, days, start, budget, alerts, money, reduce }: { cumulative: number[]; projection: number[]; days: number; start: string; budget: number; alerts: SpendAlert[]; money: (value: number) => string; reduce: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const width = useWidth(wrap);
  const [hover, setHover] = useState<number | null>(null);
  const height = 188, top = 12, bottom = 22, right = 56;
  const inner = Math.max(0, width - right);
  const today = cumulative.length;
  const max = niceCeil(Math.max(budget, projection[projection.length - 1] ?? 0, ...alerts.map(alert => alert.amount)) * 1.06);
  const x = (day: number) => ((day - 1) / (days - 1)) * inner;
  const y = (value: number) => top + (1 - value / max) * (height - top - bottom);
  const actual = cumulative.map((value, index) => `${index ? "L" : "M"}${x(index + 1).toFixed(1)},${y(value).toFixed(1)}`).join("");
  const area = `${actual}L${x(today).toFixed(1)},${y(0)}L0,${y(0)}Z`;
  const ahead = projection.map((value, index) => `${index ? "L" : "M"}${x(today + index).toFixed(1)},${y(value).toFixed(1)}`).join("");
  // Narrow plots keep three dates so the labels never collide.
  const ticks = inner < 360 ? [1, Math.ceil(days / 2), days] : [1, 8, 15, 22, days];
  const valueAt = (day: number) => day <= today ? cumulative[day - 1] : projection[day - today];

  function pick(event: ReactPointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const day = Math.round(((event.clientX - bounds.left) / Math.max(1, inner)) * (days - 1)) + 1;
    setHover(Math.max(1, Math.min(days, day)));
  }
  function onKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (event.key === "Escape") { setHover(null); return; }
    if (!step) return;
    event.preventDefault();
    setHover(value => Math.max(1, Math.min(days, (value ?? today) + step)));
  }

  const summary = `Spend so far ${money(cumulative[today - 1] ?? 0)}, projected ${money(projection[projection.length - 1] ?? 0)} by ${dayLabel(start, days - 1)}, budget ${money(budget)}.`;
  const tipX = hover ? Math.max(64, Math.min(inner - 64, x(hover))) : 0;
  return <div ref={wrap} className={styles.chart} tabIndex={0} role="img" aria-label={summary} onKeyDown={onKey} onBlur={() => setHover(null)}
    onPointerMove={pick} onPointerLeave={() => setHover(null)} onPointerDown={pick}>
    {width > 0 && <svg width={width} height={height} aria-hidden="true">
      {[.25, .5, .75].map(step => <line key={step} x1={0} x2={inner} y1={y(max * step)} y2={y(max * step)} className={styles.gridLine} />)}
      <line x1={0} x2={inner} y1={y(0)} y2={y(0)} className={styles.axis} />
      <g className={styles.budget}>
        <line x1={0} x2={inner} y1={y(budget)} y2={y(budget)} />
        <text x={inner + 8} y={y(budget) + 4}>{money(budget).replace(/\.00$/, "")}</text>
      </g>
      {alerts.map(alert => <motion.g key={alert.id} className={styles.alertRule} initial={false} animate={{ y: y(alert.amount) }} transition={reduce ? { duration: 0 } : motionTokens.spring.smooth}>
        <line x1={0} x2={inner} y1={0} y2={0} />
        <circle cx={inner} cy={0} r={2.5} />
        <text x={inner + 8} y={4}>{money(alert.amount).replace(/\.00$/, "")}</text>
      </motion.g>)}
      <motion.path d={area} className={styles.area} initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: .6, delay: .5 }} />
      <motion.path d={actual} className={styles.line} initial={reduce ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: .9, ease: enterEase }} />
      <motion.path d={ahead} className={styles.projection} initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: .4, delay: .8 }} />
      <motion.circle cx={x(today)} cy={y(cumulative[today - 1] ?? 0)} r={3.5} className={styles.today} initial={reduce ? false : { scale: 0 }} animate={{ scale: 1 }} transition={reduce ? { duration: 0 } : { ...motionTokens.spring.snappy, delay: .8 }} />
      {ticks.map(day => <text key={day} x={x(day)} y={height - 6} className={styles.tick} textAnchor={day === 1 ? "start" : day === days ? "end" : "middle"}>{dayLabel(start, day - 1)}</text>)}
      {hover && <g className={styles.cursor}>
        <line x1={x(hover)} x2={x(hover)} y1={top} y2={y(0)} />
        <circle cx={x(hover)} cy={y(valueAt(hover))} r={3.5} />
      </g>}
    </svg>}
    <AnimatePresence>{hover && <motion.div className={styles.tip} style={{ left: tipX }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: motionTokens.duration.instant }}>
      <span>{dayLabel(start, hover - 1)}{hover > today ? ", projected" : ""}</span>
      <strong>{money(valueAt(hover))}</strong>
      {hover <= today && <small>{money(cumulative[hover - 1] - (cumulative[hover - 2] ?? 0))} that day</small>}
    </motion.div>}</AnimatePresence>
  </div>;
}

/** Slack's own mark in its brand colors; it greys out while the channel is off. */
function SlackMark({ size = 14, className }: { size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 122.8 122.8" aria-hidden="true">
    <path fill="#e01e5a" d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zm6.5 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z" />
    <path fill="#36c5f0" d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zm0 6.5c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z" />
    <path fill="#2eb67d" d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zm-6.5 0c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z" />
    <path fill="#ecb22e" d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zm0-6.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z" />
  </svg>;
}

function MeterRow({ meter, limit, days, today, index, reduce }: { meter: Meter; limit: number; days: number; today: number; index: number; reduce: boolean }) {
  const projected = meter.unit === "seats" ? meter.used : meter.used * days / today;
  const ratio = meter.used / limit;
  const ahead = Math.min(1, projected / limit);
  const tone = ratio >= .9 ? "critical" : ratio >= .75 || projected > limit ? "warning" : "ok";
  const over = projected > limit ? Math.round((projected / limit - 1) * 100) : 0;
  const note = meter.unit === "seats"
    ? `${limit - meter.used} ${limit - meter.used === 1 ? "seat" : "seats"} left`
    : over ? `Projected ${formatUnit(projected, meter.unit)}, ${over}% over` : `Projected ${formatUnit(projected, meter.unit)}`;
  const delay = reduce ? 0 : .15 + index * motionTokens.stagger.item * 2;
  const spring = reduce ? { duration: 0 } : { ...settle, delay };
  return <li className={styles.meter} data-tone={tone}>
    <div className={styles.meterHead}>
      <span className={styles.meterName}>{tone !== "ok" && <AlertTriangle size={14} aria-hidden="true" />}{meter.name}</span>
      <span className={styles.meterValue}><strong>{formatUnit(meter.used, meter.unit)}</strong> of <TextMorph>{formatUnit(limit, meter.unit)}</TextMorph></span>
    </div>
    <div className={styles.track} role="meter" aria-label={meter.name} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={meter.used} aria-valuetext={`${formatUnit(meter.used, meter.unit)} of ${formatUnit(limit, meter.unit)}${tone === "ok" ? "" : tone === "critical" ? ", near the limit" : ", projected over"}`}>
      <motion.span className={styles.ahead} initial={reduce ? false : { scaleX: 0 }} animate={{ scaleX: ahead }} transition={spring} />
      <motion.span className={styles.used} initial={reduce ? false : { scaleX: 0 }} animate={{ scaleX: Math.min(1, ratio) }} transition={spring} />
    </div>
    <div className={styles.meterFoot}>
      <span className={styles.meterNote}><TextMorph>{tone === "critical" && !over ? `Near limit. ${note}` : note}</TextMorph></span>
      <span>{meter.overage}</span>
    </div>
  </li>;
}

function AlertRow({ alert, budget, sentOn, money, onChange, onSettle, onRemove, autoFocus, reduce }: { alert: SpendAlert; budget: number; sentOn: string | null; money: (value: number) => string; onChange: (alert: SpendAlert) => void; onSettle: () => void; onRemove: () => void; autoFocus: boolean; reduce: boolean }) {
  const [text, setText] = useState(String(alert.amount));
  const [focused, setFocused] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const shown = focused ? text : String(alert.amount);
  useEffect(() => { if (autoFocus) { input.current?.focus(); input.current?.select(); } }, [autoFocus]);
  function edit(value: string) {
    setText(value);
    const amount = Number(value.replace(/[^\d.]/g, ""));
    if (value.trim() && Number.isFinite(amount) && amount > 0 && amount < 1e6) onChange({ ...alert, amount: Math.round(amount) });
  }
  const pct = Math.round(alert.amount / budget * 100);
  return <motion.li layout={!reduce} className={styles.alert} initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
    transition={reduce ? { duration: 0 } : { layout: motionTokens.spring.smooth, height: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.standard } }}>
    <div className={styles.alertInner}>
      <label className={styles.amount}>
        <span className={styles.srOnly}>Alert amount in euros</span>
        <span aria-hidden="true">€</span>
        <input ref={input} value={shown} inputMode="numeric" onFocus={() => { setText(String(alert.amount)); setFocused(true); }} onBlur={() => { setFocused(false); onSettle(); }}
          onChange={event => edit(event.target.value)} onKeyDown={event => { if (event.key === "Enter") input.current?.blur(); }} />
      </label>
      <span className={styles.alertMeta} title={sentOn ? `Sent ${sentOn}` : `${pct}% of budget`}>{sentOn ? <><Check size={12} aria-hidden="true" /><span className={styles.srOnly}>Sent </span>{sentOn}</> : <>{pct}%<span className={styles.srOnly}> of budget</span></>}</span>
      <span className={styles.channels}>
        <button type="button" className={styles.channel} aria-pressed={alert.email} onClick={() => onChange({ ...alert, email: !alert.email })} aria-label={`Email at ${money(alert.amount)}`}><Mail size={14} aria-hidden="true" /></button>
        <button type="button" className={styles.channel} data-brand="" aria-pressed={alert.slack} onClick={() => onChange({ ...alert, slack: !alert.slack })} aria-label={`Slack at ${money(alert.amount)}`}><SlackMark className={styles.slack} /></button>
        <button type="button" className={styles.remove} onClick={onRemove} aria-label={`Remove the ${money(alert.amount)} alert`}><X size={14} aria-hidden="true" /></button>
      </span>
    </div>
  </motion.li>;
}

function InvoiceButton({ invoice, onDownload }: { invoice: Invoice; onDownload?: (invoice: Invoice) => Promise<void> | void }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const reduce = useReducedMotion();
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  function run() {
    if (state === "loading") return;
    setState("loading");
    const work = onDownload ? Promise.resolve().then(() => onDownload(invoice)) : new Promise(resolve => { timer.current = window.setTimeout(resolve, 700); });
    work.then(() => setState("done"), () => setState("error")).finally(() => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setState("idle"), 1600); });
  }
  const icon = state === "done" ? <Check size={15} /> : state === "error" ? <RotateCcw size={15} /> : state === "loading" ? <span className={styles.spinner} /> : <Download size={15} />;
  return <button type="button" className={styles.download} data-state={state} onClick={run} aria-label={state === "done" ? `${invoice.number} downloaded` : state === "error" ? `Download of ${invoice.number} failed, try again` : `Download ${invoice.number} as PDF`}>
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span key={state} className={styles.downloadIcon} aria-hidden="true" initial={reduce ? { opacity: 0 } : { opacity: 0, scale: .6, filter: "blur(2px)" }} animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }} exit={reduce ? { opacity: 0 } : { opacity: 0, scale: .6, filter: "blur(2px)" }} transition={reduce ? { duration: 0 } : motionTokens.spring.snappy}>{icon}</motion.span>
    </AnimatePresence>
  </button>;
}

/** The plan card becomes the sheet: one spring carries position, size, and corners from the card to the sheet and back. */
function UpgradeSheet({ origin, minY, rootWidth, closing, onClosed, onCancel, onConfirm, state, from, to, meters, days, today, money, payment, reduce }: {
  origin: Rect; minY: number; rootWidth: number; closing: Rect | null; onClosed: () => void; onCancel: () => void; onConfirm: () => void; state: "review" | "working" | "done" | "error";
  from: Plan; to: Plan; meters: Meter[]; days: number; today: number; money: (value: number) => string; payment: { brand: string; last4: string; expires: string }; reduce: boolean;
}) {
  const width = Math.min(440, rootWidth - 24);
  const target = { x: (rootWidth - width) / 2, y: Math.max(minY, origin.y - 24), width };
  const x = useMotionValue(reduce ? target.x : origin.x), y = useMotionValue(reduce ? target.y : origin.y);
  const w = useMotionValue(reduce ? target.width : origin.width), h = useMotionValue(origin.height);
  const shell = useMotionValue(reduce ? 0 : 1), body = useMotionValue(0);
  const content = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const remaining = days - today + 1;
  const charge = to.price * remaining / days, credit = from.price * remaining / days;

  useLayoutEffect(() => {
    if (closing) return;
    const node = content.current;
    if (!node) return;
    const fit = (first: boolean) => {
      if (reduce) { x.jump(target.x); y.jump(target.y); w.jump(target.width); h.jump(node.offsetHeight); return; }
      animate(x, target.x, calm); animate(y, target.y, calm); animate(w, target.width, calm);
      animate(h, node.offsetHeight, first ? calm : motionTokens.spring.smooth);
    };
    fit(true);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fit(false));
    observer.observe(node);
    return () => observer.disconnect();
  }, [closing, h, reduce, target.width, target.x, target.y, w, x, y]);

  useEffect(() => {
    if (closing) return;
    animate(shell, 1, { duration: reduce ? motionTokens.duration.fast : 0 });
    animate(body, 1, { duration: reduce ? motionTokens.duration.fast : motionTokens.duration.standard, delay: reduce ? 0 : .1, ease: enterEase });
    heading.current?.focus({ preventScroll: true });
  }, [body, closing, reduce, shell]);

  useEffect(() => {
    if (!closing) return;
    if (reduce) { const run = animate(shell, 0, { duration: motionTokens.duration.fast }); run.then(onClosed); return () => run.stop(); }
    animate(body, 0, { duration: motionTokens.duration.instant });
    animate(x, closing.x, motionTokens.spring.smooth); animate(y, closing.y, motionTokens.spring.smooth);
    animate(w, closing.width, motionTokens.spring.smooth); animate(h, closing.height, motionTokens.spring.smooth);
    const fade = animate(shell, 0, { duration: motionTokens.duration.instant, delay: .3 });
    fade.then(onClosed);
    return () => fade.stop();
  }, [body, closing, h, onClosed, reduce, shell, w, x, y]);

  function onKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && state !== "working") { event.preventDefault(); onCancel(); return; }
    if (event.key !== "Tab") return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled])")];
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  return <motion.div className={styles.sheet} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKey} style={{ x, y, width: w, height: h, opacity: shell }}>
    <motion.div ref={content} className={styles.sheetContent} style={{ width: target.width, opacity: body }}>
      <AnimatePresence mode="popLayout" initial={false}>
        {state === "done"
          ? <motion.div key="done" className={styles.sheetDone} initial={reduce ? { opacity: 0 } : { opacity: 0, filter: "blur(4px)" }} animate={{ opacity: 1, filter: "blur(0px)" }} transition={{ duration: motionTokens.duration.standard, ease: enterEase }}>
            <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><motion.path d="M5 12.5 9.5 17 19 7.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: reduce ? 1 : 0 }} animate={{ pathLength: 1 }} transition={{ duration: reduce ? 0 : .36, delay: reduce ? 0 : .08, ease: enterEase }} /></svg>
            <h3 ref={heading} id={titleId} tabIndex={-1}>You are on {to.name}</h3>
            <p>New limits apply right away.</p>
          </motion.div>
          : <motion.div key="review" exit={reduce ? { opacity: 0 } : { opacity: 0, filter: "blur(4px)" }} transition={{ duration: motionTokens.duration.fast }}>
            <div className={styles.sheetHead}>
              <h3 ref={heading} id={titleId} tabIndex={-1}>Upgrade to {to.name}</h3>
              <button type="button" className={styles.iconButton} onClick={onCancel} disabled={state === "working"} aria-label="Close"><X size={16} aria-hidden="true" /></button>
            </div>
            <table className={styles.limits}>
              <caption className={styles.srOnly}>Limits before and after the upgrade</caption>
              <tbody>
                {meters.map(meter => <tr key={meter.id}>
                  <th scope="row">{meter.name}</th>
                  <td>{formatUnit(from.limits[meter.id] ?? meter.limit, meter.unit)}</td>
                  <td aria-hidden="true"><ArrowRight size={13} /></td>
                  <td><strong>{formatUnit(to.limits[meter.id] ?? meter.limit, meter.unit)}</strong></td>
                </tr>)}
              </tbody>
            </table>
            <dl className={styles.charges}>
              <div><dt>{to.name}, {remaining} days</dt><dd>{money(charge)}</dd></div>
              <div><dt>Unused {from.name} time</dt><dd>−{money(credit)}</dd></div>
              <div className={styles.due}><dt>Due today</dt><dd>{money(charge - credit)}</dd></div>
            </dl>
            <p className={styles.sheetNote}>Then {money(to.price)} a month. Charged to {payment.brand} ending {payment.last4}.</p>
            {state === "error" && <p className={styles.sheetError} role="alert">The card was declined. Nothing was charged.</p>}
            <div className={styles.sheetActions}>
              <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={state === "working"}>Cancel</Button>
              <Button type="button" size="sm" loading={state === "working"} onClick={onConfirm}>{state === "working" ? "Upgrading" : `Pay ${money(charge - credit)}`}</Button>
            </div>
            <p className={styles.simulated}>Preview only. No payment is taken.</p>
          </motion.div>}
      </AnimatePresence>
    </motion.div>
  </motion.div>;
}

export function UsageBilling({
  period = billingPeriod, daily = dailySpend, budget = monthlyBudget, meters = sampleMeters, plan = currentPlan, upgrade = upgradePlan,
  defaultAlerts = spendAlerts, onAlertsChange, invoices = sampleInvoices, payment = paymentMethod, onUpgrade, onDownloadInvoice, currency = "EUR", className,
}: UsageBillingProps) {
  const reduce = !!useReducedMotion();
  const [active, setActive] = useState<Plan>(plan);
  const [alerts, setAlerts] = useState<SpendAlert[]>(() => [...defaultAlerts].sort((a, b) => a.amount - b.amount));
  const [fresh, setFresh] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ origin: Rect; minY: number; from: Plan; to: Plan } | null>(null);
  const [closing, setClosing] = useState<Rect | null>(null);
  const [sheetState, setSheetState] = useState<"review" | "working" | "done" | "error">("review");
  const [status, setStatus] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLElement>(null);
  const review = useRef<HTMLButtonElement>(null);
  const timers = useRef(new Set<number>());
  const counter = useRef(0);
  const rootWidth = useWidth(root);

  const money = useMemo(() => {
    const format = new Intl.NumberFormat("en-IE", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (value: number) => format.format(value);
  }, [currency]);
  const symbol = useMemo(() => new Intl.NumberFormat("en-IE", { style: "currency", currency }).formatToParts(0).find(part => part.type === "currency")?.value ?? "", [currency]);
  const cumulative = useMemo(() => daily.reduce<number[]>((list, value) => [...list, (list[list.length - 1] ?? 0) + value], []), [daily]);
  const today = cumulative.length;
  const spent = cumulative[today - 1] ?? 0;
  const rate = daily.slice(-7).reduce((sum, value) => sum + value, 0) / Math.max(1, Math.min(7, daily.length));
  const projection = useMemo(() => Array.from({ length: period.days - today + 1 }, (_, index) => spent + rate * index), [period.days, rate, spent, today]);
  const projected = projection[projection.length - 1] ?? spent;
  const upcoming = alerts.find(alert => alert.amount > spent && alert.amount <= projected);
  const crossDay = (amount: number) => { const index = cumulative.findIndex(value => value >= amount); return index >= 0 ? index + 1 : null; };
  const pace = projected > budget
    ? { tone: "critical", text: `On pace to pass your budget around ${dayLabel(period.start, Math.min(period.days, today + Math.ceil((budget - spent) / rate)) - 1)}` }
    : upcoming ? { tone: "warning", text: `On pace to reach your ${money(upcoming.amount).replace(/\.00$/, "")} alert around ${dayLabel(period.start, Math.min(period.days, today + Math.ceil((upcoming.amount - spent) / rate)) - 1)}` }
      : { tone: "ok", text: "On pace to stay under every alert" };
  const offer = upgrade && active.id !== upgrade.id ? upgrade : null;
  const strained = meters.filter(meter => meter.used / (active.limits[meter.id] ?? meter.limit) >= .75).map(meter => meter.name.toLowerCase());

  useEffect(() => { const pending = timers.current; return () => pending.forEach(timer => window.clearTimeout(timer)); }, []);
  const later = useCallback((run: () => void, ms: number) => {
    const timer = window.setTimeout(() => { timers.current.delete(timer); run(); }, ms);
    timers.current.add(timer);
  }, []);

  function commitAlerts(next: SpendAlert[]) { setAlerts(next); onAlertsChange?.(next); }
  function addAlert() {
    if (alerts.length >= 5) return;
    const top = alerts[alerts.length - 1]?.amount ?? budget * .5;
    const id = `alert-${Date.now().toString(36)}-${counter.current++}`;
    commitAlerts([...alerts, { id, amount: Math.min(budget, Math.round((top + 250) / 50) * 50), email: true, slack: false }]);
    setFresh(id);
    setStatus("Alert added");
  }

  function openSheet() {
    if (!root.current || !card.current || !offer) return;
    setSheetState("review");
    setClosing(null);
    // Keep the sheet clear of sticky page chrome when the dashboard is scrolled.
    const minY = Math.max(12, 88 - root.current.getBoundingClientRect().top);
    setSheet({ origin: relativeRect(card.current, root.current), minY, from: active, to: offer });
  }
  function closeSheet(applied = false) {
    if (!root.current || !card.current) return;
    setClosing(relativeRect(card.current, root.current));
    later(() => (applied ? card.current : review.current)?.focus({ preventScroll: true }), reduce ? 0 : 360);
  }
  const onClosed = useCallback(() => { setSheet(null); setClosing(null); }, []);
  function confirm() {
    const offer = sheet?.to;
    if (!offer || sheetState === "working") return;
    setSheetState("working");
    setStatus(`Upgrading to ${offer.name}`);
    const done = () => {
      setSheetState("done");
      setStatus(`You are on ${offer.name}. New limits apply right away.`);
      later(() => { closeSheet(true); later(() => setActive(offer), reduce ? 0 : 280); }, 1100);
    };
    if (!onUpgrade) { later(done, 1100); return; }
    Promise.resolve().then(() => onUpgrade(offer)).then(done, () => { setSheetState("error"); setStatus("The upgrade failed. Nothing was charged."); });
  }

  return <div ref={root} className={`${styles.root} ${className ?? ""}`}>
    <header className={styles.header}>
      <div><h2>Usage and billing</h2><p>{period.label} · day {today} of {period.days}</p></div>
    </header>

    <div className={styles.grid}>
      <section className={`${styles.panel} ${styles.spend}`} aria-labelledby="usage-billing-spend">
        <div className={styles.spendHead}>
          <div className={styles.stat}>
            <h3 id="usage-billing-spend">Spend so far</h3>
            <span className={styles.big}><AnimatedCounter value={spent} prefix={symbol} decimals={2} animateOnView /></span>
          </div>
          <dl className={styles.substats}>
            <div><dt>Projected</dt><dd>{money(projected)}</dd></div>
            <div><dt>Budget</dt><dd>{money(budget)}</dd></div>
          </dl>
        </div>
        <SpendChart cumulative={cumulative} projection={projection} days={period.days} start={period.start} budget={budget} alerts={alerts} money={money} reduce={reduce} />
        <p className={styles.pace} data-tone={pace.tone}>{pace.tone !== "ok" && <AlertTriangle size={14} aria-hidden="true" />}{rootWidth >= 520
          ? <TextMorph>{pace.text}</TextMorph>
          // Narrow panels let the sentence wrap; a new sentence crossfades in place instead of morphing on one line.
          : <span className={styles.paceText}><AnimatePresence mode="popLayout" initial={false}><motion.span key={pace.text} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduce ? motionTokens.duration.instant : motionTokens.duration.fast }}>{pace.text}</motion.span></AnimatePresence></span>}</p>
      </section>

      <section ref={card} tabIndex={-1} className={`${styles.panel} ${styles.plan}`} data-hidden={sheet ? "" : undefined} aria-labelledby="usage-billing-plan">
        <div className={styles.planNow}>
          <h3 id="usage-billing-plan">Plan</h3>
          <p className={styles.planName}><TextMorph>{active.name}</TextMorph><span className={styles.planPrice}><TextMorph>{`${money(active.price).replace(/\.00$/, "")} a month`}</TextMorph></span></p>
          <p className={styles.muted}>Renews Oct 1 · {payment.brand} ending {payment.last4}</p>
        </div>
        <AnimatePresence initial={false} mode="popLayout">
          {offer
            ? <motion.div key="offer" className={styles.offer} exit={{ opacity: 0 }} transition={{ duration: motionTokens.duration.fast }}>
              <p className={styles.offerLead}>{strained.length ? `${offer.name} gives you room on ${strained.slice(0, 2).join(" and ")}.` : `${offer.name} raises every limit.`}</p>
              <ul className={styles.perks}>
                {meters.filter(meter => (offer.limits[meter.id] ?? 0) > (active.limits[meter.id] ?? 0)).slice(0, 3).map(meter => <li key={meter.id}><Check size={14} aria-hidden="true" />{perkText(meter, offer.limits[meter.id])}</li>)}
                {offer.perks.slice(0, 1).map(perk => <li key={perk}><Check size={14} aria-hidden="true" />{perk}</li>)}
              </ul>
              <Button ref={review} type="button" size="sm" className={styles.offerButton} onClick={openSheet}>Upgrade to {offer.name}</Button>
            </motion.div>
            : <motion.div key="top" className={styles.offer} initial={reduce ? { opacity: 0 } : { opacity: 0, filter: "blur(4px)" }} animate={{ opacity: 1, filter: "blur(0px)" }} transition={{ duration: motionTokens.duration.standard, ease: enterEase }}>
              <p className={styles.offerLead}>Every limit is raised for the rest of {dayLabel(period.start, 0).split(" ")[0]}.</p>
              <ul className={styles.perks}>{active.perks.map(perk => <li key={perk}><Check size={14} aria-hidden="true" />{perk}</li>)}</ul>
            </motion.div>}
        </AnimatePresence>
      </section>

      <section className={`${styles.panel} ${styles.meters}`} aria-labelledby="usage-billing-meters">
        <div className={styles.panelHead}><h3 id="usage-billing-meters">Usage</h3><span className={styles.muted}>Resets {dayLabel(period.start, period.days)}</span></div>
        <ul className={styles.meterList}>
          {meters.map((meter, index) => <MeterRow key={meter.id} meter={meter} limit={active.limits[meter.id] ?? meter.limit} days={period.days} today={today} index={index} reduce={reduce} />)}
        </ul>
      </section>

      <section className={`${styles.panel} ${styles.alerts}`} aria-labelledby="usage-billing-alerts">
        <div className={styles.panelHead}><h3 id="usage-billing-alerts">Spend alerts</h3><span className={styles.legend} aria-hidden="true"><Mail size={12} /> Email <SlackMark size={11} /> Slack</span></div>
        <ul className={styles.alertList}>
          <AnimatePresence initial={false}>
            {alerts.map(alert => <AlertRow key={alert.id} alert={alert} budget={budget} money={money} autoFocus={fresh === alert.id} reduce={reduce}
              sentOn={crossDay(alert.amount) ? dayLabel(period.start, (crossDay(alert.amount) ?? 1) - 1) : null}
              onChange={next => commitAlerts(alerts.map(item => item.id === next.id ? next : item))}
              onSettle={() => { setFresh(null); setAlerts(list => list.every((item, index) => !index || list[index - 1].amount <= item.amount) ? list : [...list].sort((a, b) => a.amount - b.amount)); }}
              onRemove={() => { commitAlerts(alerts.filter(item => item.id !== alert.id)); setStatus(`Removed the ${money(alert.amount)} alert`); }} />)}
          </AnimatePresence>
        </ul>
        {!alerts.length && <p className={styles.muted}>No alerts. You will only hear about spend on your invoice.</p>}
        <div className={styles.alertFoot}>
          <button type="button" className={styles.add} onClick={addAlert} disabled={alerts.length >= 5}><Plus size={14} aria-hidden="true" />Add alert</button>
        </div>
      </section>

      <section className={`${styles.panel} ${styles.invoices}`} aria-labelledby="usage-billing-invoices">
        <div className={styles.panelHead}><h3 id="usage-billing-invoices">Invoices</h3><span className={styles.muted}><CreditCard size={13} aria-hidden="true" /> {payment.brand} ending {payment.last4}</span></div>
        <table className={styles.table}>
          <thead><tr><th scope="col">Invoice</th><th scope="col" className={styles.issued}>Issued</th><th scope="col" className={styles.num}>Amount</th><th scope="col" className={styles.statusCol}>Status</th><th scope="col"><span className={styles.srOnly}>Download</span></th></tr></thead>
          <tbody>
            {invoices.map(invoice => <tr key={invoice.id}>
              <td><span className={styles.invoiceName}>{invoice.period}</span><span className={styles.invoiceNumber}>{invoice.number}</span></td>
              <td className={styles.issued}>{invoice.issued}</td>
              <td className={styles.num}>{money(invoice.amount)}<span className={`${styles.status} ${styles.statusInline}`} data-status={invoice.status} aria-hidden="true">{invoice.status === "paid" ? "Paid" : invoice.status === "refunded" ? "Refunded" : "Failed"}</span></td>
              <td className={styles.statusCol}><span className={styles.status} data-status={invoice.status}>{invoice.status === "paid" ? "Paid" : invoice.status === "refunded" ? "Refunded" : "Failed"}</span></td>
              <td className={styles.action}><InvoiceButton invoice={invoice} onDownload={onDownloadInvoice} /></td>
            </tr>)}
          </tbody>
        </table>
      </section>
    </div>

    <AnimatePresence>{sheet && !closing && <motion.div key="scrim" className={styles.scrim} onPointerDown={() => sheetState !== "working" && closeSheet()} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduce ? motionTokens.duration.instant : motionTokens.duration.standard }} aria-hidden="true" />}</AnimatePresence>
    {sheet && rootWidth > 0 && <UpgradeSheet origin={sheet.origin} minY={sheet.minY} rootWidth={rootWidth} closing={closing} onClosed={onClosed} onCancel={() => closeSheet()} onConfirm={confirm} state={sheetState}
      from={sheet.from} to={sheet.to} meters={meters} days={period.days} today={today} money={money} payment={payment} reduce={reduce} />}
    <p className={styles.srOnly} role="status" aria-live="polite">{status}</p>
  </div>;
}

export default UsageBilling;
