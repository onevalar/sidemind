"use client";

import { useId, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, Plus, Trash2 } from "lucide-react";
import { Button } from "../../button/button";
import { motionTokens } from "../../lib/motion-tokens";
import styles from "./invoice-studio.module.css";

type DraftLine = { id: string; description: string; quantity: string; rate: string };
export type InvoiceLine = { description: string; quantity: number; rate: number };

export interface InvoiceStudioProps {
  onSave?: (lines: InvoiceLine[]) => void | Promise<void>;
}

const startingLines: DraftLine[] = [
  { id: "discovery", description: "Discovery and direction", quantity: "1", rate: "900.00" },
  { id: "interface", description: "Interface design", quantity: "2", rate: "650.00" },
  { id: "handoff", description: "Design handoff", quantity: "1", rate: "250.00" },
];

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const money = (amount: number) => currency.format(amount);
const lineAmount = (line: DraftLine) => {
  const quantity = Number(line.quantity);
  const rate = Number(line.rate);
  return Number.isFinite(quantity) && Number.isFinite(rate) ? Math.max(0, quantity) * Math.max(0, rate) : 0;
};

function AnimatedMoney({ amount, reduce }: { amount: number; reduce: boolean | null }) {
  return <AnimatePresence initial={false}><motion.span key={amount.toFixed(2)} initial={reduce ? false : { opacity: 0, y: 5, filter: "blur(3px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={reduce ? { opacity: 0 } : { opacity: 0, y: -5, filter: "blur(3px)" }} transition={{ duration: reduce ? 0 : motionTokens.duration.fast, ease: [...motionTokens.ease.enter] }}>{money(amount)}</motion.span></AnimatePresence>;
}

export function InvoiceStudio({ onSave }: InvoiceStudioProps) {
  const reduce = useReducedMotion();
  const id = useId();
  const [lines, setLines] = useState(startingLines);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error" | "invalid">("idle");
  const sequence = useRef(0);
  const descriptions = useRef(new Map<string, HTMLInputElement>());
  const addButton = useRef<HTMLButtonElement>(null);
  const subtotal = lines.reduce((sum, line) => sum + lineAmount(line), 0);
  const tax = Math.round(subtotal * 0.08 * 100) / 100;
  const total = subtotal + tax;

  function update(id: string, field: "description" | "quantity" | "rate", value: string) {
    setLines((current) => current.map((line) => line.id === id ? { ...line, [field]: value } : line));
    setStatus("idle");
  }

  function normalize(id: string, field: "quantity" | "rate") {
    setLines((current) => current.map((line) => {
      if (line.id !== id) return line;
      const value = Number(line[field]);
      if (field === "quantity") return { ...line, quantity: String(Math.min(999, Math.max(1, Math.floor(value) || 1))) };
      return { ...line, rate: (Number.isFinite(value) ? Math.min(1_000_000, Math.max(0, value)) : 0).toFixed(2) };
    }));
  }

  function addLine() {
    const nextId = `new-${++sequence.current}`;
    setLines((current) => [...current, { id: nextId, description: "", quantity: "1", rate: "0.00" }]);
    setStatus("idle");
    requestAnimationFrame(() => descriptions.current.get(nextId)?.focus());
  }

  function removeLine(id: string) {
    if (lines.length <= 1) return;
    setLines((current) => current.filter((line) => line.id !== id));
    setStatus("idle");
    addButton.current?.focus();
  }

  async function save() {
    const unnamed = lines.find((line) => !line.description.trim());
    if (unnamed) {
      setStatus("invalid");
      descriptions.current.get(unnamed.id)?.focus();
      return;
    }
    setStatus("saving");
    if (!onSave) {
      await new Promise((resolve) => window.setTimeout(resolve, reduce ? 150 : 700));
      setStatus("saved");
      return;
    }
    try {
      await onSave?.(lines.map((line) => ({
        description: line.description.trim(),
        quantity: Math.min(999, Math.max(1, Math.floor(Number(line.quantity)) || 1)),
        rate: Math.min(1_000_000, Math.max(0, Number(line.rate) || 0)),
      })));
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  }

  return (
    <section className={styles.invoice} aria-labelledby={`${id}-title`}>
      <header className={styles.documentHeader}>
        <div className={styles.identity}><span className={styles.wordmark}>Northstar Studio</span><span>Invoice 2026-041</span></div>
        <div className={styles.documentMeta}><span>Issued 19 Sep 2026</span><span>Due 19 Oct 2026</span></div>
      </header>

      <div className={styles.heading}>
        <h2 id={`${id}-title`}>Invoice</h2>
        <div className={styles.parties}>
          <div><span>From</span><strong>Northstar Studio</strong><p>44 Hudson Street<br />New York, NY 10013</p></div>
          <div><span>Bill to</span><strong>Acme Product</strong><p>125 Spring Street<br />New York, NY 10012</p></div>
        </div>
      </div>

      <div className={styles.linesHeader} aria-hidden="true"><span>Work</span><span>Qty</span><span>Rate</span><span>Amount</span><span /></div>
      <div className={styles.lines} aria-label="Invoice line items">
        <AnimatePresence initial={false}>
          {lines.map((line, index) => (
            <motion.div
              className={styles.lineSlot}
              key={line.id}
              initial={reduce ? false : { height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { height: 0, opacity: 0, transition: { height: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.fast } } }}
              transition={reduce ? { duration: 0 } : { height: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] } }}
            >
              <div className={styles.line}>
              <label className={styles.descriptionCell}><span className={styles.mobileLabel}>Work</span><input ref={(node) => { if (node) descriptions.current.set(line.id, node); else descriptions.current.delete(line.id); }} value={line.description} onChange={(event) => update(line.id, "description", event.target.value)} aria-label={`Line ${index + 1} description`} placeholder="Describe the work" /></label>
              <label className={styles.numberCell}><span className={styles.mobileLabel}>Qty</span><input type="number" inputMode="numeric" min="1" max="999" step="1" value={line.quantity} onChange={(event) => update(line.id, "quantity", event.target.value)} onBlur={() => normalize(line.id, "quantity")} aria-label={`Line ${index + 1} quantity`} /></label>
              <label className={styles.numberCell}><span className={styles.mobileLabel}>Rate</span><span className={styles.currencyPrefix}>$</span><input type="number" inputMode="decimal" min="0" max="1000000" step="0.01" value={line.rate} onChange={(event) => update(line.id, "rate", event.target.value)} onBlur={() => normalize(line.id, "rate")} aria-label={`Line ${index + 1} rate in dollars`} /></label>
              <output className={styles.amountCell} aria-label={`Line ${index + 1} amount`}><AnimatedMoney amount={lineAmount(line)} reduce={reduce} /></output>
              <button className={styles.removeButton} type="button" aria-label={`Remove line ${index + 1}`} disabled={lines.length === 1} onClick={() => removeLine(line.id)}><Trash2 size={16} strokeWidth={1.75} aria-hidden="true" /></button>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <div className={styles.addRow}><button type="button" ref={addButton} onClick={addLine}><Plus size={16} strokeWidth={1.75} aria-hidden="true" /> Add line item</button></div>

      <div className={styles.bottom}>
        <p className={styles.note}>Thank you for the work together. Payment is due within 30 days.</p>
        <div className={styles.totals}>
          <div><span>Subtotal</span><span className={styles.moneySlot}><AnimatedMoney amount={subtotal} reduce={reduce} /></span></div>
          <div><span>Tax · 8%</span><span className={styles.moneySlot}><AnimatedMoney amount={tax} reduce={reduce} /></span></div>
          <div className={styles.totalLine}><strong>Total due</strong><output aria-live="polite" aria-atomic="true"><AnimatePresence initial={false}><motion.span key={total.toFixed(2)} initial={reduce ? false : { opacity: 0, y: 7, filter: "blur(5px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={reduce ? { opacity: 0 } : { opacity: 0, y: -7, filter: "blur(4px)" }} transition={{ duration: reduce ? 0 : motionTokens.duration.standard, ease: [...motionTokens.ease.enter] }}>{money(total)}</motion.span></AnimatePresence></output></div>
        </div>
      </div>

      <footer className={styles.footer}><p className={styles.srOnly} role="status" aria-live="polite">{status === "saving" ? "Saving draft…" : status === "saved" ? "Draft saved." : status === "error" ? "Could not save the draft. Try again." : status === "invalid" ? "Describe each line before saving." : "\u00a0"}</p><Button type="button" variant={status === "saved" ? "secondary" : undefined} className={styles.saveButton} loading={status === "saving"} onClick={() => void save()}><AnimatePresence mode="popLayout" initial={false}><motion.span key={status === "saved" ? "saved" : "save"} className={styles.saveLabel} initial={reduce ? false : { opacity: 0, y: 6, filter: "blur(2px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6, filter: "blur(2px)" }} transition={{ duration: reduce ? 0 : motionTokens.duration.fast, ease: [...motionTokens.ease.enter] }}>{status === "saved" ? <><Check size={16} strokeWidth={1.75} aria-hidden="true" />Saved</> : "Save draft"}</motion.span></AnimatePresence></Button></footer>
    </section>
  );
}

export default InvoiceStudio;
