"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { AnimatePresence, LayoutGroup, MotionConfig, motion, useReducedMotion } from "motion/react";
import type { Transition, Variants } from "motion/react";
import { Check, Download, Laptop, LogOut, Monitor, ShieldOff, Smartphone, Tablet } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Badge } from "../../badge/badge";
import { Button } from "../../button/button";
import { Checkbox } from "../../checkbox/checkbox";
import { CopyButton } from "../../copy-button/copy-button";
import { HoldToConfirm } from "../../hold-to-confirm/hold-to-confirm";
import { OtpInput } from "../../otp-input/otp-input";
import { PasswordField } from "../../password-field/password-field";
import { PasswordStrength, estimateStrength } from "../../password-strength/password-strength";
import { motionTokens } from "../../lib/motion-tokens";
import styles from "./security-settings.module.css";

type Step = "off" | "scan" | "verify" | "codes" | "on";
type Kind = "laptop" | "phone" | "desktop" | "tablet";
type Session = { id: string; device: string; client: string; city: string; seen: string; kind: Kind; current?: boolean; flag?: string };
type Wave = Record<string, number>;

const ACCOUNT = "maya@fieldnote.example";
const SETUP_KEY = "N4XG K3LQ 7RPM 2VWD Y6HT A5CJ";
const DEMO_CODE = "246810";
const BACKUP_CODES = ["7kq2-m9xp", "c4tn-8wzr", "p3hd-6yvb", "x9fm-2rkt", "b5wl-4qne", "r8jc-7tgs", "m2vx-9dph", "t6nz-3kwf", "h4gy-5bmq", "w7rs-8cjd"];
const ORDER: Record<Step, number> = { off: 0, scan: 1, verify: 2, codes: 3, on: 4 };
const RAIL: { step: Step; label: string }[] = [{ step: "scan", label: "Scan" }, { step: "verify", label: "Verify" }, { step: "codes", label: "Save codes" }];
const ICONS: Record<Kind, LucideIcon> = { laptop: Laptop, phone: Smartphone, desktop: Monitor, tablet: Tablet };
const initialSessions: Session[] = [
  { id: "mbp", device: "MacBook Pro", client: "Chrome 129", city: "San Francisco, US", seen: "Active now", kind: "laptop", current: true },
  { id: "iphone", device: "iPhone 15 Pro", client: "Fieldnote for iOS", city: "San Francisco, US", seen: "2 hours ago", kind: "phone" },
  { id: "windows", device: "Windows desktop", client: "Edge 128", city: "Austin, US", seen: "Yesterday at 4:12 PM", kind: "desktop" },
  { id: "ipad", device: "iPad Air", client: "Safari 18", city: "Lisbon, PT", seen: "Sep 14", kind: "tablet" },
  { id: "thinkpad", device: "ThinkPad X1", client: "Firefox 130", city: "Berlin, DE", seen: "Sep 9", kind: "laptop", flag: "New location" },
];

/** A deterministic QR-like pattern: three finder squares, timing rows, one alignment mark and seeded data modules, identical on server and client. */
const QR_SIZE = 25;
const FINDERS = ["1 / 1 / 8 / 8", "1 / 19 / 8 / 26", "19 / 1 / 26 / 8"];
const QR_CELLS = (() => {
  let seed = 0x5eed1e55;
  const random = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const cells: { row: number; col: number }[] = [];
  const last = QR_SIZE - 1;
  for (let row = 0; row < QR_SIZE; row++) for (let col = 0; col < QR_SIZE; col++) {
    if ((row < 8 && col < 8) || (row < 8 && col > last - 8) || (row > last - 8 && col < 8)) continue;
    const ring = Math.max(Math.abs(row - 18), Math.abs(col - 18));
    const dark = ring <= 2 ? ring !== 1 : row === 6 || col === 6 ? (row + col) % 2 === 0 : random() < .46;
    if (dark) cells.push({ row, col });
  }
  return cells;
})();

const { spring, duration, blur, stagger } = motionTokens;
type Bezier = [number, number, number, number];
const easeEnter = [...motionTokens.ease.enter] as Bezier;
const easeStandard = [...motionTokens.ease.standard] as Bezier;
const instant: Transition = { duration: 0 };

/** Steps slide in the direction of travel, so going back reads as going back. */
const stageVariants: Variants = {
  enter: (direction: number) => ({ opacity: 0, x: 24 * direction, filter: `blur(${blur.soft}px)` }),
  center: { opacity: 1, x: 0, filter: "blur(0px)" },
  exit: (direction: number) => ({ opacity: 0, x: -24 * direction, filter: `blur(${blur.soft}px)`, transition: { duration: duration.exit, ease: easeStandard } }),
};
const rollVariants: Variants = {
  enter: (direction: number) => ({ opacity: 0, y: `${.5 * direction}em`, filter: `blur(${blur.subtle}px)` }),
  center: { opacity: 1, y: "0em", filter: "blur(0px)" },
  exit: (direction: number) => ({ opacity: 0, y: `${-.5 * direction}em`, filter: `blur(${blur.subtle}px)`, transition: { duration: duration.instant, ease: easeStandard } }),
};

function useHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState<number | "auto">("auto");
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(node.offsetHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, height] as const;
}

/** Opens and closes its own height and keeps following its content, so neighbours glide instead of jumping. */
function Collapse({ children, className }: { children: ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  const [inner, height] = useHeight<HTMLDivElement>();
  return <motion.div className={[styles.collapse, className].filter(Boolean).join(" ")} initial={{ height: 0, opacity: 0 }} animate={{ height, opacity: 1 }}
    exit={{ height: 0, opacity: 0, transition: reduce ? instant : { height: spring.smooth, opacity: { duration: duration.fast, ease: easeStandard } } }}
    transition={reduce ? instant : { height: spring.smooth, opacity: { duration: duration.standard, ease: easeEnter } }}>
    <div ref={inner}>{children}</div>
  </motion.div>;
}

/** Changing copy rises in out of a small blur while the old line lifts away. Assistive tech reads the plain text. */
function Swap({ text }: { text: string }) {
  const reduce = useReducedMotion();
  return <span className={styles.swap}>
    <span className={styles.srOnly}>{text}</span>
    <span className={styles.swapTrack} aria-hidden="true"><AnimatePresence mode="popLayout" initial={false}>
      <motion.span key={text} className={styles.swapText} initial={{ opacity: 0, y: "0.45em", filter: `blur(${blur.soft}px)` }} animate={{ opacity: 1, y: "0em", filter: "blur(0px)" }}
        exit={{ opacity: 0, y: "-0.35em", filter: `blur(${blur.subtle}px)`, transition: reduce ? instant : { duration: duration.fast, ease: easeStandard } }}
        transition={reduce ? instant : { duration: duration.standard, ease: easeEnter }}>{text}</motion.span>
    </AnimatePresence></span>
  </span>;
}

/** A count that rolls up or down with tabular digits, so the direction of the change reads at a glance. */
function Roll({ value }: { value: number }) {
  const reduce = useReducedMotion();
  const [track, setTrack] = useState({ value, direction: 1 });
  if (track.value !== value) setTrack({ value, direction: value > track.value ? 1 : -1 });
  return <span className={styles.roll}>
    <span className={styles.srOnly}>{value}</span>
    <span className={styles.swapTrack} aria-hidden="true"><AnimatePresence mode="popLayout" initial={false} custom={track.direction}>
      <motion.span key={value} className={styles.swapText} custom={track.direction} variants={rollVariants} initial="enter" animate="center" exit="exit" transition={reduce ? instant : { y: spring.snappy, opacity: { duration: duration.fast }, filter: { duration: duration.fast } }}>{value}</motion.span>
    </AnimatePresence></span>
  </span>;
}

function QrCode() {
  return <div className={styles.qr} role="img" aria-label={`QR code that adds Fieldnote for ${ACCOUNT} to an authenticator app`}>
    {FINDERS.map((area, index) => <span key={area} className={styles.finder} style={{ gridArea: area, animationDelay: `${index * 50}ms` }}><span className={styles.finderDot} /></span>)}
    {QR_CELLS.map(({ row, col }) => <span key={`${row}-${col}`} className={styles.qrCell} style={{ gridArea: `${row + 1} / ${col + 1}`, animationDelay: `${60 + (row + col) * 7}ms` }} />)}
  </div>;
}

/** The ring draws itself, then the tick follows through it. */
function DrawnCheck() {
  const reduce = useReducedMotion();
  return <svg className={styles.drawn} width={40} height={40} viewBox="0 0 40 40" fill="none" aria-hidden="true">
    <motion.circle cx={20} cy={20} r={18.5} stroke="currentColor" strokeWidth={1.5} transform="rotate(-90 20 20)" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={reduce ? instant : { duration: duration.considered, ease: easeEnter }} />
    <motion.path d="M13 20.5 18 25.5 27.5 15" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={reduce ? instant : { duration: duration.standard, ease: easeEnter, delay: .34 }} />
  </svg>;
}

function RailMark({ index, done }: { index: number; done: boolean }) {
  const reduce = useReducedMotion();
  return <span className={styles.railMark} aria-hidden="true"><AnimatePresence mode="popLayout" initial={false}>
    {done ? <motion.svg key="done" width={12} height={12} viewBox="0 0 12 12" fill="none" initial={{ opacity: 0, scale: .6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .6 }} transition={reduce ? instant : spring.snappy}>
      <motion.path d="M2.5 6.25 5 8.75 9.5 3.5" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={reduce ? instant : { duration: duration.standard, ease: easeEnter, delay: .06 }} />
    </motion.svg> : <motion.span key="number" initial={{ opacity: 0, scale: .6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .6 }} transition={reduce ? instant : spring.snappy}>{index + 1}</motion.span>}
  </AnimatePresence></span>;
}

/** A session row closes its height on removal. Signing out of everything staggers the rows into a top to bottom wave. */
function SessionRow({ id, children }: { id: string; children: ReactNode }) {
  const reduce = useReducedMotion();
  const [inner, height] = useHeight<HTMLDivElement>();
  const variants: Variants = {
    exit: (wave?: Wave) => {
      const delay = (wave?.[id] ?? 0) * stagger.line;
      return reduce ? { height: 0, opacity: 0, transition: instant } : { height: 0, opacity: 0, x: -12, transition: { height: { ...spring.smooth, delay }, x: { ...spring.smooth, delay }, opacity: { duration: duration.standard, ease: easeStandard, delay } } };
    },
  };
  return <motion.li className={styles.session} variants={variants} initial={false} animate={{ height, opacity: 1, x: 0 }} exit="exit" transition={reduce ? instant : { height: spring.smooth }}>
    <div ref={inner}>{children}</div>
  </motion.li>;
}

export function SecuritySettings() {
  const id = useId();
  const reduce = useReducedMotion();

  const [step, setStep] = useState<Step>("off");
  const [direction, setDirection] = useState(1);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [saved, setSaved] = useState(false);
  const [download, setDownload] = useState<"idle" | "saving" | "done">("idle");

  const [pwOpen, setPwOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [signOutOthers, setSignOutOthers] = useState(false);
  const [pwState, setPwState] = useState<"idle" | "saving" | "saved">("idle");
  const [pwError, setPwError] = useState<{ field: "current" | "new"; text: string } | null>(null);
  const [changed, setChanged] = useState("Last changed March 4, 2026");

  const [sessions, setSessions] = useState(initialSessions);
  const [wave, setWave] = useState<Wave>({});
  const [holding, setHolding] = useState(false);
  const [note, setNote] = useState("");

  const timers = useRef<number[]>([]);
  const verifyTimer = useRef<number | null>(null);
  const sessionsRef = useRef(sessions);
  const tfaActionRef = useRef<HTMLButtonElement>(null);
  const continueRef = useRef<HTMLButtonElement>(null);
  const codesHeadingRef = useRef<HTMLHeadingElement>(null);
  const enabledRef = useRef<HTMLParagraphElement>(null);
  const pwToggleRef = useRef<HTMLButtonElement>(null);
  const currentRef = useRef<HTMLInputElement>(null);
  const newRef = useRef<HTMLInputElement>(null);
  const sessionsHeadingRef = useRef<HTMLHeadingElement>(null);
  const revokeRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => { const pending = timers.current; return () => pending.forEach(window.clearTimeout); }, []);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);

  const others = sessions.filter(session => !session.current);
  const inSetup = step === "scan" || step === "verify" || step === "codes";
  const setupIndex = ORDER[step] - 1;

  function later(run: () => void, ms: number) { const timer = window.setTimeout(run, ms); timers.current.push(timer); return timer; }
  function focusLater(read: () => HTMLElement | null | undefined) { requestAnimationFrame(() => requestAnimationFrame(() => { const node = read(); if (node?.isConnected) node.focus({ preventScroll: true }); })); }
  function stopVerify() { if (verifyTimer.current !== null) window.clearTimeout(verifyTimer.current); verifyTimer.current = null; setVerifying(false); }

  function go(next: Step) {
    setDirection(ORDER[next] >= ORDER[step] ? 1 : -1);
    setStep(next);
  }

  function startSetup() {
    setCode(""); setCodeError(""); setSaved(false); setDownload("idle");
    go("scan");
    setNote("Scan the code with your authenticator app to continue");
  }

  function cancelSetup() {
    stopVerify();
    go("off");
    setNote("Two-factor setup canceled");
  }

  function back() {
    stopVerify();
    setCodeError("");
    go("scan");
    focusLater(() => continueRef.current);
  }

  function verify(value = code) {
    if (verifyTimer.current !== null) return;
    if (value.length < 6) { setCodeError("Enter all 6 digits from your app"); return; }
    setVerifying(true);
    // Simulated check. Replace this timer with a call that verifies the TOTP code on your server.
    verifyTimer.current = later(() => {
      verifyTimer.current = null;
      setVerifying(false);
      if (value !== DEMO_CODE) { setCodeError("That code didn’t match. Try the newest code in your app"); return; }
      go("codes");
      setNote("Code accepted. Save your backup codes to finish");
      focusLater(() => codesHeadingRef.current);
    }, 700);
  }

  function onCode(value: string) {
    stopVerify();
    setCode(value);
    setCodeError("");
    if (value.length === 6) verify(value);
  }

  function markSaved(message: string) { setSaved(true); setNote(message); }

  function saveCodes() {
    if (download !== "idle") return;
    setDownload("saving");
    later(() => { setDownload("done"); markSaved("Saved fieldnote-backup-codes.txt"); }, 600);
  }

  function finish() {
    go("on");
    setNote("Two-factor authentication is on");
    focusLater(() => enabledRef.current);
  }

  function turnOff() {
    later(() => {
      go("off");
      setNote("Two-factor authentication turned off");
      focusLater(() => tfaActionRef.current);
    }, 520);
  }

  function togglePassword() {
    if (pwState !== "idle") return;
    if (pwOpen) { setPwOpen(false); setPwError(null); setNote("Password change canceled"); return; }
    setPwOpen(true);
    focusLater(() => currentRef.current);
  }

  function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pwState !== "idle") return;
    const fail = (field: "current" | "new", text: string) => { setPwError({ field, text }); (field === "current" ? currentRef : newRef).current?.focus(); };
    if (!current) return fail("current", "Enter your current password");
    if (!nextPassword) return fail("new", "Choose a new password");
    if (nextPassword === current) return fail("new", "Use a password that differs from your current one");
    if (estimateStrength(nextPassword).level < 3) return fail("new", "Meet at least three of the requirements below");
    setPwError(null);
    setPwState("saving");
    // Simulated update. Swap this timer for your password endpoint.
    later(() => {
      setPwState("saved");
      setNote("Password updated");
      if (signOutOthers) signOutAll(true);
      later(() => {
        setPwOpen(false); setPwState("idle"); setCurrent(""); setNextPassword(""); setSignOutOthers(false);
        setChanged("Last changed just now");
        focusLater(() => pwToggleRef.current);
      }, 1400);
    }, 900);
  }

  function revoke(session: Session) {
    const list = others;
    const index = list.findIndex(item => item.id === session.id);
    const neighbour = list[index + 1] ?? list[index - 1];
    setWave({});
    setSessions(currentSessions => currentSessions.filter(item => item.id !== session.id));
    setNote(`Signed out of ${session.device} in ${session.city}`);
    focusLater(() => (neighbour ? revokeRefs.current.get(neighbour.id) : null) ?? sessionsHeadingRef.current);
  }

  function signOutAll(fromPassword = false) {
    const leaving = sessionsRef.current.filter(session => !session.current);
    if (!leaving.length) return;
    setWave(Object.fromEntries(leaving.map((session, index) => [session.id, index])));
    setSessions(currentSessions => currentSessions.filter(session => session.current));
    setHolding(false);
    const count = `${leaving.length} other ${leaving.length === 1 ? "session" : "sessions"}`;
    setNote(fromPassword ? `Password updated and signed out of ${count}` : `Signed out of ${count}`);
    if (!fromPassword) focusLater(() => sessionsHeadingRef.current);
  }

  const stageTransition: Transition = reduce ? instant : { x: spring.smooth, opacity: { duration: duration.standard, ease: easeEnter }, filter: { duration: duration.standard, ease: easeEnter } };
  const fadeSwap = { initial: { opacity: 0, filter: `blur(${blur.subtle}px)` }, animate: { opacity: 1, filter: "blur(0px)" }, exit: { opacity: 0, filter: `blur(${blur.subtle}px)`, transition: reduce ? instant : { duration: duration.fast, ease: easeStandard } }, transition: reduce ? instant : { duration: duration.standard, ease: easeEnter } };

  let stage: ReactNode = null;
  if (step === "scan") stage = <div className={styles.scan}>
    <QrCode />
    <div className={styles.scanCopy}>
      <div className={styles.copyBlock}>
        <p className={styles.lead}>Scan with your authenticator app</p>
        <p className={styles.muted}>1Password, Authy, and Google Authenticator all work. It adds Fieldnote for {ACCOUNT}.</p>
      </div>
      <div className={styles.copyBlock}>
        <p className={styles.keyLabel}>Can’t scan it? Enter this setup key</p>
        <div className={styles.keyRow}>
          <code className={styles.key}>{SETUP_KEY}</code>
          <CopyButton value={SETUP_KEY.replace(/\s/g, "")} label="Copy key" onCopied={() => setNote("Setup key copied")} />
        </div>
      </div>
      <div className={styles.stepActions}><Button ref={continueRef} type="button" size="sm" onClick={() => go("verify")}>Continue</Button></div>
    </div>
  </div>;
  if (step === "verify") stage = <form className={styles.verify} noValidate onSubmit={event => { event.preventDefault(); verify(); }}>
    <OtpInput label="Enter the 6-digit code from your app" value={code} onChange={onCode} autoFocus error={codeError || undefined}
      description={verifying ? "Checking the code" : `Demo code: ${DEMO_CODE}. Codes refresh every 30 seconds.`} />
    <div className={styles.stepActions}>
      <Button type="button" variant="ghost" size="sm" onClick={back}>Back</Button>
      <Button type="submit" size="sm" loading={verifying}>Verify</Button>
    </div>
  </form>;
  if (step === "codes") stage = <div className={styles.codesStep}>
    <div className={styles.codesHead}>
      <div className={styles.copyBlock}>
        <h4 ref={codesHeadingRef} tabIndex={-1} className={styles.lead}>Save your backup codes</h4>
        <p className={styles.muted}>Each code signs you in once if you lose your phone. This is the only time they are shown.</p>
      </div>
      <div className={styles.codeActions}>
        <CopyButton value={[`Fieldnote backup codes for ${ACCOUNT}`, "", ...BACKUP_CODES].join("\n")} label="Copy codes" onCopied={() => markSaved("Backup codes copied")} />
        <Button type="button" variant="secondary" size="sm" loading={download === "saving"} onClick={saveCodes}>{download === "done" ? <><Check size={16} strokeWidth={2} aria-hidden="true" />Downloaded</> : <><Download size={16} strokeWidth={1.75} aria-hidden="true" />Download</>}</Button>
      </div>
    </div>
    <ol className={styles.codes} aria-label="Backup codes">
      {BACKUP_CODES.map((item, index) => <motion.li key={item} className={styles.code} initial={{ opacity: 0, y: 6, filter: `blur(${blur.soft}px)` }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        transition={reduce ? instant : { duration: duration.standard, ease: easeEnter, delay: .14 + index * stagger.item }}>{item}</motion.li>)}
    </ol>
    <div className={styles.codesFoot}>
      <p className={styles.muted}><Swap text={saved ? "Codes saved. Finish to turn on two-factor" : "Copy or download the codes to finish"} /></p>
      <Button type="button" size="sm" disabled={!saved} onClick={finish}>Finish setup</Button>
    </div>
  </div>;
  if (step === "on") stage = <div className={styles.enabled}>
    <span className={styles.enabledMark}><DrawnCheck /></span>
    <div className={styles.enabledText}>
      <p ref={enabledRef} tabIndex={-1} className={styles.lead}>Two-factor authentication is on</p>
      <p className={styles.muted}>Authenticator app added Sep 22, 2026 · <span className={styles.num}>10</span> of <span className={styles.num}>10</span> backup codes unused</p>
    </div>
    <HoldToConfirm className={styles.hold} label="Hold to turn off" confirmedLabel="Turned off" icon={<ShieldOff size={16} strokeWidth={1.75} aria-hidden="true" />} onConfirm={turnOff} />
  </div>;

  return (
    <MotionConfig reducedMotion="user">
      <LayoutGroup id={id}>
        <section className={styles.block} aria-labelledby={`${id}-title`}>
          <header className={styles.header}>
            <h2 id={`${id}-title`}>Security</h2>
            <p>Control how you sign in to Fieldnote as {ACCOUNT}.</p>
          </header>

          <section className={styles.section} aria-labelledby={`${id}-tfa`}>
            <div className={styles.sectionHead}>
              <div className={styles.sectionText}>
                <h3 id={`${id}-tfa`}>Two-factor authentication</h3>
                <p>Ask for a code from your authenticator app when you sign in on a new device.</p>
              </div>
              <div className={styles.aside}>
                <Badge size="sm" tone={step === "on" ? "success" : "neutral"}>{step === "on" ? "On" : inSetup ? "Setting up" : "Off"}</Badge>
                <AnimatePresence mode="popLayout" initial={false}>
                  {(step === "off" || step === "scan" || step === "verify") && <motion.span key="tfa-action" className={styles.actionSlot} {...fadeSwap}>
                    <Button ref={tfaActionRef} type="button" size="sm" variant={step === "off" ? "primary" : "ghost"} aria-expanded={step !== "off"} onClick={step === "off" ? startSetup : cancelSetup}>{step === "off" ? "Enable" : "Cancel"}</Button>
                  </motion.span>}
                </AnimatePresence>
              </div>
            </div>
            <AnimatePresence initial={false}>
              {step !== "off" && <Collapse key="tfa-body">
                <div className={styles.tfaBody}>
                  <AnimatePresence initial={false}>
                    {inSetup && <Collapse key="rail">
                      <ol className={styles.rail} aria-label="Setup progress">
                        {RAIL.map((item, index) => {
                          const state = index < setupIndex ? "done" : index === setupIndex ? "current" : "next";
                          return <li key={item.step} className={styles.railItem} data-state={state} aria-current={state === "current" ? "step" : undefined}>
                            {state === "current" && <motion.span layoutId="security-rail" className={styles.railHighlight} transition={reduce ? instant : spring.morph} />}
                            <RailMark index={index} done={state === "done"} />
                            <span className={styles.railLabel}>{item.label}{state === "done" && <span className={styles.srOnly}>, done</span>}</span>
                          </li>;
                        })}
                      </ol>
                    </Collapse>}
                  </AnimatePresence>
                  <div className={styles.stage}>
                    <AnimatePresence mode="popLayout" initial={false} custom={direction}>
                      <motion.div key={step} className={styles.stagePane} custom={direction} variants={stageVariants} initial="enter" animate="center" exit="exit" transition={stageTransition}>{stage}</motion.div>
                    </AnimatePresence>
                  </div>
                </div>
              </Collapse>}
            </AnimatePresence>
          </section>

          <section className={styles.section} aria-labelledby={`${id}-password`}>
            <div className={styles.sectionHead}>
              <div className={styles.sectionText}>
                <h3 id={`${id}-password`}>Password</h3>
                <p><Swap text={changed} /></p>
              </div>
              <div className={styles.aside}>
                <Button ref={pwToggleRef} type="button" size="sm" variant={pwOpen ? "ghost" : "secondary"} disabled={pwState !== "idle"} aria-expanded={pwOpen} onClick={togglePassword}>{pwOpen ? "Cancel" : "Change password"}</Button>
              </div>
            </div>
            <AnimatePresence initial={false}>
              {pwOpen && <Collapse key="password-form">
                <form className={styles.pwForm} noValidate onSubmit={submitPassword}>
                  <div>
                    <PasswordField ref={currentRef} label="Current password" autoComplete="current-password" value={current} readOnly={pwState !== "idle"}
                      aria-invalid={pwError?.field === "current" || undefined} aria-describedby={pwError?.field === "current" ? `${id}-current-error` : undefined}
                      onChange={event => { setCurrent(event.target.value); if (pwError?.field === "current") setPwError(null); }} />
                    <AnimatePresence initial={false}>
                      {pwError?.field === "current" && <Collapse key="current-error"><p id={`${id}-current-error`} className={styles.fieldError} role="alert">{pwError.text}</p></Collapse>}
                    </AnimatePresence>
                  </div>
                  <PasswordStrength ref={newRef} label="New password" value={nextPassword} readOnly={pwState !== "idle"} error={pwError?.field === "new" ? pwError.text : undefined}
                    onValueChange={value => { setNextPassword(value); if (pwError?.field === "new") setPwError(null); }} />
                  <div className={styles.pwFoot}>
                    <span className={styles.checkWrap}><Checkbox label="Sign out of other sessions" checked={signOutOthers} disabled={!others.length || pwState !== "idle"} onCheckedChange={value => setSignOutOthers(value === true)} /></span>
                    <Button type="submit" size="sm" loading={pwState === "saving"}>{pwState === "saved" ? <><Check size={16} strokeWidth={2} aria-hidden="true" />Password updated</> : "Update password"}</Button>
                  </div>
                </form>
              </Collapse>}
            </AnimatePresence>
          </section>

          <section className={styles.section} aria-labelledby={`${id}-sessions`}>
            <div className={styles.sectionHead}>
              <div className={styles.sectionText}>
                <h3 id={`${id}-sessions`} ref={sessionsHeadingRef} tabIndex={-1}>Active sessions <span className={styles.count}><Roll value={sessions.length} /></span></h3>
                <p>Devices signed in to your account in the last 30 days.</p>
              </div>
            </div>
            <ul className={styles.sessions} aria-labelledby={`${id}-sessions`}>
              <AnimatePresence initial={false} custom={wave}>
                {sessions.map(session => {
                  const Icon = ICONS[session.kind];
                  return <SessionRow key={session.id} id={session.id}>
                    <div className={styles.sessionInner}>
                      <Icon className={styles.deviceIcon} size={16} strokeWidth={1.5} aria-hidden="true" />
                      <div className={styles.sessionText}>
                        <span className={styles.sessionName}>{session.device}{session.current && <Badge size="sm">This device</Badge>}{session.flag && <Badge size="sm" tone="warning">{session.flag}</Badge>}</span>
                        <span className={styles.sessionMeta}>{session.client} · {session.city} · {session.seen}</span>
                      </div>
                      {!session.current && <Button ref={node => { if (node) revokeRefs.current.set(session.id, node); else revokeRefs.current.delete(session.id); }} type="button" variant="ghost" size="sm"
                        aria-label={`Revoke ${session.device} session in ${session.city}`} onClick={() => revoke(session)}>Revoke</Button>}
                    </div>
                  </SessionRow>;
                })}
              </AnimatePresence>
            </ul>
            <AnimatePresence initial={false}>
              {others.length ? <Collapse key="sign-out-all">
                <div className={styles.sessionsFoot}>
                  <p className={styles.muted}><Swap text={holding ? `Keep holding to sign out ${others.length} ${others.length === 1 ? "device" : "devices"}` : "You stay signed in on this device"} /></p>
                  <HoldToConfirm className={styles.hold} label="Sign out of other sessions" confirmedLabel="Signed out" icon={<LogOut size={16} strokeWidth={1.75} aria-hidden="true" />} onHoldChange={setHolding} onConfirm={() => signOutAll()} />
                </div>
              </Collapse> : <Collapse key="alone"><p className={styles.alone}>Only this device is signed in.</p></Collapse>}
            </AnimatePresence>
          </section>

          <p className={styles.srOnly} aria-live="polite">{note}</p>
        </section>
      </LayoutGroup>
    </MotionConfig>
  );
}

export default SecuritySettings;
