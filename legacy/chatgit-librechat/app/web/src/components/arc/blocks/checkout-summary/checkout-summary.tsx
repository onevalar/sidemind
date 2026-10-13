"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { AnimatePresence, motion, useAnimationControls, useReducedMotion } from "motion/react";
import { ArrowRight, Check, LoaderCircle, LockKeyhole, TicketPercent, X } from "lucide-react";
import { AnimatedCounter } from "../../animated-counter/animated-counter";
import { motionTokens } from "../../lib/motion-tokens";
import styles from "./checkout-summary.module.css";

export interface CheckoutSummaryItem {
  name: string;
  description?: string;
  /** Price before adjustments. */
  price: number;
  /** e.g. "one payment" or "per year". */
  period?: string;
  /** Optional thumbnail or mark. */
  media?: ReactNode;
}

export interface CheckoutSummaryLine {
  id: string;
  label: string;
  /** Negative for a discount. */
  amount: number;
  /** Short note under the label, e.g. "38 of 50 left". */
  note?: string;
}

export type CheckoutCouponResult =
  | { ok: true; code: string; label?: string; /** Discount as a positive amount. */ amount: number }
  | { ok: false; message: string };

export interface CheckoutSummaryProps {
  /** The product being bought. Omit it to render the built-in sample order with a simulated code and payment. */
  item?: CheckoutSummaryItem;
  /** Automatic lines such as a launch discount. */
  adjustments?: CheckoutSummaryLine[];
  /** Enables the promo code field. Validate codes on your server. */
  coupon?: { onApply: (code: string) => Promise<CheckoutCouponResult>; placeholder?: string };
  /** Tax line. With `rate` the amount is computed; without it `note` is shown instead of an amount. */
  tax?: { label: string; rate?: number; note?: string };
  currency?: string;
  title?: string;
  /** Pay button label. Receives the formatted total. */
  payLabel?: (total: string) => string;
  /** Simulated or client-side payment. Resolve to show success, reject to show an error. */
  onPay?: () => Promise<void>;
  /** Native form submission, e.g. to a server route that creates a hosted checkout session. */
  form?: { action: string; fields?: Record<string, string> };
  /** Line beside the lock under the button. */
  secureNote?: ReactNode;
  /** Label once `onPay` resolves. */
  successLabel?: string;
  /** Show the button but block payment, e.g. while checkout is not open yet. */
  disabled?: boolean;
  /** Small print under the total. */
  footnote?: ReactNode;
  className?: string;
}

type PayState = "idle" | "processing" | "done" | "error";
type CouponState = { status: "idle" | "applying" } | { status: "error"; message: string } | { status: "applied"; code: string; label: string; amount: number };

const { spring, duration, ease } = motionTokens;
const enter = [...ease.enter] as [number, number, number, number];

/** Sample order used when no item is passed, so the block previews on its own. Codes and payment are simulated. */
const SAMPLE_ITEM: CheckoutSummaryItem = { name: "Field notes, yearly", description: "Unlimited notebooks and sync for one person", price: 96, period: "per year" };
const SAMPLE_ADJUSTMENTS: CheckoutSummaryLine[] = [{ id: "annual", label: "Yearly billing", amount: -24, note: "Two months free" }];
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const SAMPLE_COUPON = {
  placeholder: "Try WELCOME10",
  onApply: async (code: string): Promise<CheckoutCouponResult> => {
    await wait(700);
    return code === "WELCOME10" ? { ok: true, code, label: "Welcome, 10% off", amount: 7.2 } : { ok: false, message: "That code is not valid. Try WELCOME10." };
  },
};
const samplePay = () => wait(1400);

function money(value: number, currency: string, decimals: number) {
  const sign = value < 0 ? "−" : "";
  return `${sign}${currency}${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

/**
 * An order summary for the last step before payment. Discounts slide in as their own lines, a
 * promo code collapses into an applied chip, the total counts to its new amount, and the pay
 * button carries its state from idle to processing to paid in place.
 */
export function CheckoutSummary(props: CheckoutSummaryProps) {
  if (props.item) return <CheckoutSummaryView {...props} item={props.item} />;
  return (
    <CheckoutSummaryView
      adjustments={SAMPLE_ADJUSTMENTS}
      coupon={SAMPLE_COUPON}
      tax={{ label: "Sales tax (8.5%)", rate: 0.085 }}
      onPay={samplePay}
      {...props}
      item={SAMPLE_ITEM}
    />
  );
}

function CheckoutSummaryView({
  item,
  adjustments = [],
  coupon,
  tax,
  currency = "$",
  title = "Order summary",
  payLabel = total => `Pay ${total}`,
  onPay,
  form,
  secureNote = "Encrypted payment",
  successLabel = "Paid",
  disabled = false,
  footnote,
  className,
}: CheckoutSummaryProps & { item: CheckoutSummaryItem }) {
  const reduced = !!useReducedMotion();
  const inputId = useId();
  const errorId = useId();
  const shake = useAnimationControls();
  const input = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState("");
  const [couponState, setCouponState] = useState<CouponState>({ status: "idle" });
  const [pay, setPay] = useState<PayState>("idle");

  // A hosted checkout redirect can come back through the back button; reset the button then.
  useEffect(() => {
    const reset = (event: PageTransitionEvent) => { if (event.persisted) setPay("idle"); };
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  const applied = couponState.status === "applied" ? couponState : null;
  const lines: CheckoutSummaryLine[] = [...adjustments, ...(applied ? [{ id: "coupon", label: applied.label, amount: -applied.amount }] : [])];
  const subtotal = Math.max(0, item.price + lines.reduce((sum, line) => sum + line.amount, 0));
  const taxAmount = tax?.rate ? Math.round(subtotal * tax.rate * 100) / 100 : 0;
  const total = subtotal + taxAmount;
  const decimals = [item.price, ...lines.map(line => line.amount), total].some(value => !Number.isInteger(value)) ? 2 : 0;
  const totalText = money(total, currency, decimals);

  const fail = (message: string) => {
    setCouponState({ status: "error", message });
    if (!reduced) void shake.start({ x: [0, -6, 6, -4, 3, 0], transition: { duration: 0.36, ease: [...ease.standard] as [number, number, number, number] } });
  };

  const applyCoupon = async (event: FormEvent) => {
    event.preventDefault();
    if (!coupon || couponState.status === "applying") return;
    const value = code.trim();
    if (!value) { input.current?.focus(); return; }
    setCouponState({ status: "applying" });
    try {
      const result = await coupon.onApply(value);
      if (result.ok) setCouponState({ status: "applied", code: result.code, label: result.label ?? `Code ${result.code}`, amount: result.amount });
      else fail(result.message);
    } catch {
      fail("Could not check the code. Try again.");
    }
  };

  const removeCoupon = () => {
    setCouponState({ status: "idle" });
    setCode("");
    requestAnimationFrame(() => input.current?.focus());
  };

  const startPay = async () => {
    if (!onPay || pay === "processing" || pay === "done") return;
    setPay("processing");
    try {
      await onPay();
      setPay("done");
    } catch {
      setPay("error");
    }
  };

  const label = pay === "processing" ? "Processing" : pay === "done" ? successLabel : pay === "error" ? "Try again" : payLabel(totalText);
  const icon = pay === "processing" ? <LoaderCircle className={styles.spin} size={18} strokeWidth={1.75} aria-hidden="true" /> : pay === "done" ? <Check size={18} strokeWidth={2} aria-hidden="true" /> : form ? <ArrowRight size={18} strokeWidth={1.75} aria-hidden="true" /> : <LockKeyhole size={16} strokeWidth={1.75} aria-hidden="true" />;
  const payContent = (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={pay === "idle" ? `idle-${totalText}` : pay}
        className={styles.payInner}
        initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduced ? { opacity: 0 } : { opacity: 0, y: -8, transition: { duration: duration.fast } }}
        transition={{ duration: duration.standard, ease: enter }}
      >
        {icon}<span>{label}</span>
      </motion.span>
    </AnimatePresence>
  );

  const payButtonProps = {
    className: styles.pay,
    "data-state": pay,
    disabled: disabled || pay === "processing" || pay === "done",
    "aria-live": "polite" as const,
  };

  return (
    <section className={[styles.root, className].filter(Boolean).join(" ")} aria-label={title}>
      <h3 className={styles.title}>{title}</h3>

      <div className={styles.item}>
        {item.media ? <div className={styles.media}>{item.media}</div> : null}
        <div className={styles.itemText}>
          <span className={styles.itemName}>{item.name}</span>
          {item.description ? <span className={styles.itemDescription}>{item.description}</span> : null}
        </div>
        <span className={styles.itemPrice}>{money(item.price, currency, decimals)}{item.period ? <span className={styles.itemPeriod}>{item.period}</span> : null}</span>
      </div>

      {coupon ? (
        <motion.div className={styles.coupon} animate={shake}>
          <AnimatePresence mode="popLayout" initial={false}>
            {applied ? (
              <motion.div
                key="chip"
                className={styles.chip}
                initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, transition: { duration: duration.fast } }}
                transition={reduced ? { duration: 0 } : spring.smooth}
              >
                <TicketPercent size={16} strokeWidth={1.75} aria-hidden="true" />
                <span className={styles.chipCode}>{applied.code}</span>
                <span className={styles.chipNote}>applied</span>
                <button type="button" className={styles.chipRemove} onClick={removeCoupon} aria-label={`Remove code ${applied.code}`}><X size={14} strokeWidth={1.75} aria-hidden="true" /></button>
              </motion.div>
            ) : (
              <motion.form
                key="form"
                className={styles.couponForm}
                onSubmit={applyCoupon}
                initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, transition: { duration: duration.fast } }}
                transition={{ duration: duration.standard, ease: enter }}
                data-error={couponState.status === "error" || undefined}
              >
                <label htmlFor={inputId} className={styles.srOnly}>Promo code</label>
                <input
                  ref={input}
                  id={inputId}
                  className={styles.couponInput}
                  value={code}
                  onChange={event => { setCode(event.target.value.toUpperCase()); if (couponState.status === "error") setCouponState({ status: "idle" }); }}
                  placeholder={coupon.placeholder ?? "Promo code"}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={couponState.status === "error" || undefined}
                  aria-describedby={couponState.status === "error" ? errorId : undefined}
                />
                <button type="submit" className={styles.couponApply} disabled={couponState.status === "applying"}>
                  {couponState.status === "applying" ? <LoaderCircle className={styles.spin} size={16} strokeWidth={1.75} aria-label="Checking code" /> : "Apply"}
                </button>
              </motion.form>
            )}
          </AnimatePresence>
          <AnimatePresence initial={false}>
            {couponState.status === "error" ? (
              <motion.p key="error" id={errorId} className={styles.couponError} role="alert" initial={{ opacity: 0, height: 0, paddingTop: 0 }} animate={{ opacity: 1, height: "auto", paddingTop: 8 }} exit={{ opacity: 0, height: 0, paddingTop: 0 }} transition={reduced ? { duration: 0 } : spring.smooth}>
                {couponState.message}
              </motion.p>
            ) : null}
          </AnimatePresence>
        </motion.div>
      ) : null}

      <dl className={styles.lines}>
        <div className={styles.line}><dt>Subtotal</dt><dd>{money(item.price, currency, decimals)}</dd></div>
        <AnimatePresence initial={false}>
          {lines.map(line => (
            <motion.div
              key={line.id}
              className={`${styles.line} ${styles.lineAnimated}`}
              data-discount={line.amount < 0 || undefined}
              initial={{ height: 0, opacity: 0, paddingTop: 0, paddingBottom: 0 }}
              animate={{ height: "auto", opacity: 1, paddingTop: 5, paddingBottom: 5 }}
              exit={{ height: 0, opacity: 0, paddingTop: 0, paddingBottom: 0 }}
              transition={reduced ? { duration: 0 } : { default: spring.smooth, opacity: { duration: duration.standard } }}
            >
              <dt>{line.label}{line.note ? <span className={styles.lineNote}>{line.note}</span> : null}</dt>
              <dd>{money(line.amount, currency, decimals)}</dd>
            </motion.div>
          ))}
        </AnimatePresence>
        {tax ? (
          <div className={styles.line}>
            <dt>{tax.label}</dt>
            <dd className={tax.rate ? undefined : styles.muted}>{tax.rate ? money(taxAmount, currency, decimals) : tax.note ?? "Calculated at checkout"}</dd>
          </div>
        ) : null}
        <div className={`${styles.line} ${styles.total}`}>
          <dt>Total</dt>
          <dd>
            <span className={styles.srOnly}>{totalText}</span>
            <span className={styles.totalValue} aria-hidden="true">{currency}<span className={styles.inline}><AnimatedCounter value={total} decimals={decimals} /></span></span>
          </dd>
        </div>
      </dl>

      {form ? (
        <form action={form.action} method="post" onSubmit={() => setPay("processing")}>
          {Object.entries(form.fields ?? {}).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
          <button type="submit" {...payButtonProps}>{payContent}</button>
        </form>
      ) : (
        <button type="button" onClick={startPay} {...payButtonProps}>{payContent}</button>
      )}

      {secureNote ? <p className={styles.secure}><LockKeyhole size={14} strokeWidth={1.75} aria-hidden="true" />{secureNote}</p> : null}
      {pay === "error" ? <p className={styles.payError} role="alert">The payment did not go through. Try again, or use another method.</p> : null}
      {footnote ? <p className={styles.footnote}>{footnote}</p> : null}
    </section>
  );
}

export default CheckoutSummary;
