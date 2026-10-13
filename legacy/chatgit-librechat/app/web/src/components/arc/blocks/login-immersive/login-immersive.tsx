"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import Image from "next/image";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, useTransform, type Transition, type Variants } from "motion/react";
import { Check, Mail } from "lucide-react";
import { Button } from "../../button/button";
import { Input } from "../../input/input";
import { photo } from "../../lib/media";
import { motionTokens } from "../../lib/motion-tokens";
import styles from "./login-immersive.module.css";

type Step = "email" | "sent" | "done";
type Mode = "sign-in" | "sign-up";
type Provider = "Google" | "Apple" | "GitHub";
type Busy = null | "email" | "mail" | Provider;
export type LoginImmersiveMethod = "Magic link" | Provider;
export interface LoginImmersiveProps {
  /** Fill the viewport (100dvh, square corners) when the block is the whole page. */
  fullScreen?: boolean;
  /** Seconds before another link can be sent. */
  resendSeconds?: number;
  /** Footer links. Without them the preview explains where each one would go. */
  termsHref?: string;
  privacyHref?: string;
  /** Called once the simulated sign in succeeds. */
  onSignIn?: (email: string, method: LoginImmersiveMethod) => void;
}

const DEMO_EMAIL = "maya@northwind.studio";
const backdrop = photo("mountain-ridges");
/** The official four-colour Google "G"; Apple and GitHub ship monochrome marks, drawn in currentColor. */
function GoogleLogo({ className }: { className?: string }) {
  return <svg className={className} width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
  </svg>;
}

const providers: Provider[] = ["Google", "Apple", "GitHub"];
/** Monochrome provider marks (Simple Icons) in currentColor, so they stay neutral in both themes. */
const providerMarks: Record<Provider, string> = {
  Google: "M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z",
  Apple: "M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701",
  GitHub: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
};
const copy: Record<Mode, { title: string; lede: string; sent: string; done: string; switchAsk: string; switchTo: string }> = {
  "sign-in": { title: "Sign in to Arc", lede: "We will email you a link that signs you in. No password needed.", sent: "The link signs you in on this browser. It expires in 15 minutes.", done: "You're signed in", switchAsk: "No account?", switchTo: "Sign up" },
  "sign-up": { title: "Create your account", lede: "Start with your work email. We will send a link to confirm it.", sent: "The link confirms your address and opens your new workspace. It expires in 15 minutes.", done: "Your account is ready", switchAsk: "Have an account?", switchTo: "Sign in" },
};
const domainFixes: Record<string, string> = { "gmial.com": "gmail.com", "gamil.com": "gmail.com", "gmai.com": "gmail.com", "gmail.co": "gmail.com", "hotmial.com": "hotmail.com", "outlok.com": "outlook.com", "iclod.com": "icloud.com", "yaho.com": "yahoo.com" };

const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
function suggestionFor(value: string) {
  const [local, domain, extra] = value.trim().toLowerCase().split("@");
  return local && domain && extra === undefined && domainFixes[domain] ? `${local}@${domainFixes[domain]}` : "";
}

/** Steps and headings trade places with a small blur rise; the card height follows on a spring. */
const swap: Variants = {
  enter: (reduce: boolean) => reduce ? { opacity: 0 } : { opacity: 0, y: 12, filter: `blur(${motionTokens.blur.soft}px)` },
  center: (reduce: boolean) => ({ opacity: 1, y: 0, filter: "blur(0px)", transition: reduce ? { duration: motionTokens.duration.instant } : { y: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.standard, ease: motionTokens.ease.enter, delay: .06 }, filter: { duration: motionTokens.duration.standard, ease: motionTokens.ease.enter, delay: .06 } } }),
  exit: (reduce: boolean) => reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -8, filter: `blur(${motionTokens.blur.soft}px)`, transition: { duration: motionTokens.duration.exit, ease: motionTokens.ease.standard } },
};
/** Seconds roll down while the timer runs and back up when a resend restarts it. */
const roll: Variants = {
  enter: (direction: number) => ({ opacity: 0, y: `${-0.7 * direction}em`, filter: `blur(${motionTokens.blur.subtle}px)` }),
  center: { opacity: 1, y: 0, filter: "blur(0px)" },
  exit: (direction: number) => ({ opacity: 0, y: `${0.7 * direction}em`, filter: `blur(${motionTokens.blur.subtle}px)` }),
};

function RollingTime({ seconds, reduce }: { seconds: number; reduce: boolean }) {
  const [shown, setShown] = useState({ seconds, direction: 1 });
  if (shown.seconds !== seconds) setShown({ seconds, direction: seconds < shown.seconds ? 1 : -1 });
  const text = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const transition: Transition = reduce ? { duration: 0 } : { y: motionTokens.spring.snappy, opacity: { duration: motionTokens.duration.fast }, filter: { duration: motionTokens.duration.fast } };
  return <span className={styles.time}>{text.split("").map((character, index) => <span key={index} className={styles.timeColumn}>
    <AnimatePresence initial={false} mode="popLayout" custom={shown.direction}><motion.span key={character} custom={shown.direction} variants={roll} initial="enter" animate="center" exit="exit" transition={transition}>{character}</motion.span></AnimatePresence>
  </span>)}</span>;
}

/** The letter drops into the open envelope, then the flap folds shut. One value drives the fold: below zero the flap stands open
 *  behind the letter, above zero it lies closed in front, so the flap changes layer exactly when it is edge on. */
function Envelope({ reduce }: { reduce: boolean }) {
  const fold = useMotionValue(reduce ? 1 : -1);
  const letterY = useMotionValue(reduce ? 0 : -30);
  const letterOpacity = useMotionValue(reduce ? 1 : 0);
  const backFlap = useTransform(fold, value => Math.min(0, value));
  const frontFlap = useTransform(fold, value => Math.max(0, value));
  useEffect(() => {
    if (reduce) { fold.jump(1); letterY.jump(0); letterOpacity.jump(1); return; }
    const running = [
      animate(letterOpacity, 1, { duration: motionTokens.duration.fast, delay: .16 }),
      animate(letterY, 0, { ...motionTokens.spring.smooth, delay: .16 }),
      animate(fold, 1, { ...motionTokens.spring.morph, delay: .56 }),
    ];
    return () => running.forEach(control => control.stop());
  }, [reduce, fold, letterY, letterOpacity]);
  const flap = "M9 33 L48 57 L87 33 Z";
  return <svg className={styles.envelope} viewBox="0 0 96 80" width="96" height="80" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
    <motion.path d={flap} className={styles.paper} vectorEffect="non-scaling-stroke" style={{ scaleY: backFlap, originY: 0 }} />
    <motion.g style={{ y: letterY, opacity: letterOpacity }}>
      <rect x="20" y="38" width="56" height="34" rx="3" className={styles.paper} />
      <path d="M28 47h26M28 54h40M28 61h18" className={styles.ink} />
    </motion.g>
    <rect x="8" y="32" width="80" height="44" rx="4" className={styles.paper} />
    <path d="M9 75 L40 52M87 75 L56 52" className={styles.ink} />
    <motion.path d={flap} className={styles.paper} vectorEffect="non-scaling-stroke" style={{ scaleY: frontFlap, originY: 0 }} />
  </svg>;
}

/** The card follows its content on a spring only while the view changes; otherwise it stays auto, so field messages open without lag. */
function useViewHeight(view: string, reduce: boolean) {
  const track = useRef<HTMLDivElement>(null);
  const height = useMotionValue<number | "auto">("auto");
  const measured = useRef(0);
  const gliding = useRef(false);
  const lastView = useRef(view);
  const glide = useCallback((to: number) => {
    gliding.current = true;
    animate(height, to, { ...motionTokens.spring.smooth, onComplete: () => { gliding.current = false; height.jump("auto"); } });
  }, [height]);
  useEffect(() => {
    const node = track.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      measured.current = entry.borderBoxSize?.[0]?.blockSize ?? node.offsetHeight;
      if (gliding.current) glide(measured.current);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [glide]);
  useLayoutEffect(() => {
    if (lastView.current === view) return;
    lastView.current = view;
    const current = height.get();
    const from = typeof current === "number" ? current : measured.current;
    const to = track.current?.offsetHeight ?? 0;
    if (reduce || !from || !to) { gliding.current = false; height.jump("auto"); return; }
    if (current === "auto") height.jump(from);
    glide(to);
  }, [view, reduce, height, glide]);
  return { track, height };
}

export function LoginImmersive({ fullScreen = false, resendSeconds = 30, termsHref, privacyHref, onSignIn }: LoginImmersiveProps) {
  const reduce = !!useReducedMotion();
  const [mode, setMode] = useState<Mode>("sign-in");
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [account, setAccount] = useState(DEMO_EMAIL);
  const [touched, setTouched] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [sentFlash, setSentFlash] = useState(false);
  const [sends, setSends] = useState(0);
  const [resendIn, setResendIn] = useState(resendSeconds);
  const [method, setMethod] = useState<LoginImmersiveMethod>("Magic link");
  const [status, setStatus] = useState("");
  const [legalNote, setLegalNote] = useState("");
  const emailRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusNext = useRef<"email" | "heading" | null>(null);
  const timers = useRef<number[]>([]);
  const noteSeq = useRef(0);
  const { track, height } = useViewHeight(`${step}:${mode}`, reduce);
  const text = copy[mode];

  const emailError = (touched || attempted) && !isEmail(email) ? (email.trim() ? "Enter a full address, like name@example.com." : "Enter your email address.") : "";
  const suggestion = touched || attempted ? suggestionFor(email) : "";
  const note = legalNote || (step === "sent" ? "Demo: Open mail app follows the link for you." : "");
  const fade: Transition = reduce ? { duration: motionTokens.duration.instant } : { duration: motionTokens.duration.standard, ease: motionTokens.ease.enter };
  const noteMotion = {
    initial: reduce ? { opacity: 0 } : { opacity: 0, y: 6, filter: `blur(${motionTokens.blur.soft}px)` },
    animate: { opacity: 1, y: 0, filter: "blur(0px)" },
    exit: reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -4, filter: `blur(${motionTokens.blur.subtle}px)`, transition: { duration: motionTokens.duration.fast } },
    transition: fade,
  };

  useEffect(() => { const pending = timers.current; return () => pending.forEach(window.clearTimeout); }, []);
  useEffect(() => {
    if (step !== "sent" || resendIn <= 0) return;
    const timer = window.setTimeout(() => setResendIn(seconds => Math.max(0, seconds - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [step, resendIn]);
  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (target === "email") { emailRef.current?.focus(); emailRef.current?.select(); }
    if (target === "heading") headingRef.current?.focus();
  }, [step]);

  function later(run: () => void, ms: number) { timers.current.push(window.setTimeout(run, ms)); }
  function go(next: Step, focus: "email" | "heading" | null) { focusNext.current = focus; setStep(next); }

  function complete(how: LoginImmersiveMethod, address: string) {
    setBusy(null);
    setMethod(how);
    setAccount(address);
    go("done", "heading");
    setStatus(`${mode === "sign-up" ? "Account created" : "Signed in"} with ${how === "Magic link" ? "a magic link" : how}`);
    onSignIn?.(address, how);
  }

  function submitEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || sentFlash) return;
    setAttempted(true);
    if (!isEmail(email)) { emailRef.current?.focus(); return; }
    setBusy("email");
    setStatus("Sending your link");
    later(() => {
      setBusy(null);
      setSentFlash(true);
      setAccount(email.trim().toLowerCase());
      setStatus("Link sent");
      later(() => {
        setSentFlash(false);
        setResendIn(resendSeconds);
        setSends(count => count + 1);
        go("sent", "heading");
      }, 620);
    }, 900);
  }

  function applySuggestion() {
    setEmail(suggestion);
    setStatus(`Email changed to ${suggestion}`);
    emailRef.current?.focus();
  }

  function editEmail() {
    if (busy) return;
    setAttempted(false);
    go("email", "email");
    setStatus("Edit your email");
  }

  function resend() {
    if (busy || resendIn > 0) return;
    setResendIn(resendSeconds);
    setSends(count => count + 1);
    setStatus("New link sent");
  }

  function openMail() {
    if (busy) return;
    setBusy("mail");
    setStatus("Opening your mail app");
    later(() => complete("Magic link", account), 1000);
  }

  function continueWith(provider: Provider) {
    if (busy || sentFlash) return;
    setBusy(provider);
    setStatus(`Opening ${provider}`);
    later(() => complete(provider, isEmail(email) ? email.trim().toLowerCase() : DEMO_EMAIL), 900);
  }

  function switchMode() {
    if (busy || sentFlash) return;
    const next: Mode = mode === "sign-in" ? "sign-up" : "sign-in";
    setMode(next);
    setAttempted(false);
    if (step !== "email") go("email", null);
    setStatus(next === "sign-up" ? "Create an account" : "Sign in");
  }

  function signOut() {
    setEmail(account);
    setTouched(false);
    setAttempted(false);
    go("email", "email");
    setStatus("Signed out");
  }

  function showLegal(label: string) {
    setLegalNote(`${label} would open here.`);
    const shown = ++noteSeq.current;
    later(() => { if (noteSeq.current === shown) setLegalNote(""); }, 3600);
  }

  const legal = [{ label: "Terms", name: "Terms of service", href: termsHref }, { label: "Privacy", name: "Privacy policy", href: privacyHref }];

  return (
    <section className={[styles.screen, fullScreen ? styles.fullScreen : ""].filter(Boolean).join(" ")} aria-label={text.title}>
      <motion.div className={styles.photo} initial={{ scale: 1.06 }} animate={{ scale: 1 }} transition={reduce ? { duration: 0 } : { duration: 1.6, ease: motionTokens.ease.enter }}>
        <Image src={backdrop.src} alt="" fill sizes="100vw" loading="eager" />
      </motion.div>
      <div className={styles.scrim} aria-hidden="true" />

      <header className={styles.topBar}>
        <span className={styles.brand}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 15a7 7 0 0 1 14 0" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" /></svg>
          Arc
        </span>
        <button type="button" className={styles.switch} aria-label={`${text.switchAsk} ${text.switchTo}`} onClick={switchMode}>
          {(["sign-in", "sign-up"] as const).map(option => <motion.span key={option} className={styles.switchLabel} aria-hidden="true" initial={false}
            animate={option === mode ? { opacity: 1, y: 0, filter: "blur(0px)" } : { opacity: 0, y: reduce ? 0 : -6, filter: `blur(${reduce ? 0 : motionTokens.blur.subtle}px)` }} transition={fade}>
            {copy[option].switchAsk} <span className={styles.switchAction}>{copy[option].switchTo}</span>
          </motion.span>)}
        </button>
      </header>

      <div className={styles.stage}>
        <motion.div className={styles.card} initial={{ opacity: 0, y: 18, scale: .985 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={reduce ? { duration: 0 } : { y: { ...motionTokens.spring.smooth, delay: .18 }, scale: { ...motionTokens.spring.smooth, delay: .18 }, opacity: { duration: motionTokens.duration.considered, ease: motionTokens.ease.enter, delay: .18 } }}>
          <motion.div className={styles.viewport} style={{ height }}>
            <div ref={track} className={styles.track}>
              <AnimatePresence mode="popLayout" initial={false} custom={reduce}>
                {step === "email" && <motion.div key="email" className={styles.step} custom={reduce} variants={swap} initial="enter" animate="center" exit="exit">
                  <div className={styles.headingSlot}>
                    <AnimatePresence mode="popLayout" initial={false} custom={reduce}>
                      <motion.div key={mode} className={styles.heading} custom={reduce} variants={swap} initial="enter" animate="center" exit="exit"><h2>{text.title}</h2><p>{text.lede}</p></motion.div>
                    </AnimatePresence>
                  </div>
                  <form className={styles.form} onSubmit={submitEmail} noValidate>
                    <div className={styles.fieldGroup}>
                      <Input ref={emailRef} label="Email" type="email" name="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} placeholder="name@example.com" value={email} readOnly={busy === "email" || sentFlash} error={emailError} onChange={event => setEmail(event.target.value)} onBlur={() => { if (email.trim()) setTouched(true); }} />
                      <AnimatePresence initial={false}>
                        {suggestion && <motion.div key="suggestion" className={styles.suggestion} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={reduce ? { duration: 0 } : { height: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.fast } }}>
                          <p>Did you mean <button type="button" className={styles.textButton} aria-label={`Use ${suggestion}`} onClick={applySuggestion}>{suggestion}</button>?</p>
                        </motion.div>}
                      </AnimatePresence>
                    </div>
                    <Button type="submit" className={styles.wide} loading={busy === "email"}>{sentFlash ? <><Check size={16} strokeWidth={2} aria-hidden="true" />Link sent</> : "Email me a link"}</Button>
                  </form>
                  <div className={styles.divider}>or</div>
                  <div className={styles.sso} role="group" aria-label="Continue with another account">
                    {providers.map(provider => <Button key={provider} type="button" variant="secondary" className={styles.ssoButton} aria-label={`Continue with ${provider}`} loading={busy === provider} onClick={() => continueWith(provider)}>
                      {provider === "Google" ? <GoogleLogo className={styles.providerMark} /> : <svg className={styles.providerMark} width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={providerMarks[provider]} /></svg>}{provider}
                    </Button>)}
                  </div>
                </motion.div>}

                {step === "sent" && <motion.div key="sent" className={styles.step} custom={reduce} variants={swap} initial="enter" animate="center" exit="exit">
                  <Envelope key={sends} reduce={reduce} />
                  <div className={styles.heading}><h2 ref={headingRef} tabIndex={-1}>Check your inbox</h2><p>{text.sent}</p></div>
                  <div className={styles.address}>
                    <Mail size={16} strokeWidth={1.75} aria-hidden="true" />
                    <span className={styles.addressText}>{account}</span>
                    <button type="button" className={styles.textButton} aria-label={`Edit email, ${account}`} onClick={editEmail}>Edit</button>
                  </div>
                  <Button type="button" className={styles.wide} loading={busy === "mail"} onClick={openMail}>Open mail app</Button>
                  <p className={styles.resendRow}>
                    <span>Didn&apos;t get it?</span>
                    <button type="button" className={styles.resend} aria-disabled={resendIn > 0 || undefined} aria-label={resendIn > 0 ? `Resend link, available in ${resendIn} seconds` : "Resend link"} onClick={resend}>
                      <AnimatePresence mode="popLayout" initial={false}>
                        <motion.span key={resendIn > 0 ? "wait" : "ready"} className={styles.resendLabel} {...noteMotion}>
                          {resendIn > 0 ? <>Resend in <RollingTime seconds={resendIn} reduce={reduce} /></> : "Resend link"}
                        </motion.span>
                      </AnimatePresence>
                    </button>
                  </p>
                </motion.div>}

                {step === "done" && <motion.div key="done" className={styles.step} custom={reduce} variants={swap} initial="enter" animate="center" exit="exit">
                  <svg className={styles.doneMark} viewBox="0 0 56 56" width="56" height="56" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <motion.circle cx="28" cy="28" r="26" strokeWidth="1.5" initial={reduce ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: motionTokens.duration.considered * 1.2, ease: motionTokens.ease.inOut, delay: .12 }} />
                    <motion.path d="M18 28.5 25 35.5 38.5 21.5" strokeWidth="1.75" initial={reduce ? false : { pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: 1 }} transition={{ pathLength: { ...motionTokens.spring.snappy, delay: .56 }, opacity: { duration: motionTokens.duration.instant, delay: .56 } }} />
                  </svg>
                  <div className={styles.heading}><h2 ref={headingRef} tabIndex={-1}>{text.done}</h2><p>{method === "Magic link" ? "Your link worked" : `${method} confirmed it's you`}. This browser stays signed in for 30 days.</p></div>
                  <dl className={styles.details}>
                    <div><dt>Account</dt><dd>{account}</dd></div>
                    <div><dt>Signed in with</dt><dd>{method}</dd></div>
                  </dl>
                  <Button type="button" variant="secondary" className={styles.wide} onClick={signOut}>Sign out</Button>
                </motion.div>}
              </AnimatePresence>
            </div>
          </motion.div>
          <p className={styles.srOnly} role="status" aria-live="polite">{status}</p>
        </motion.div>
      </div>

      <footer className={styles.footer}>
        <p className={styles.note}>
          <span className={styles.srOnly} aria-live="polite">{legalNote}</span>
          <span className={styles.noteSlot} aria-hidden={legalNote ? true : undefined}>
            <AnimatePresence mode="popLayout" initial={false}><motion.span key={note} {...noteMotion}>{note}</motion.span></AnimatePresence>
          </span>
        </p>
        <nav className={styles.legal} aria-label="Legal">
          {legal.map(link => link.href
            ? <a key={link.label} href={link.href} className={styles.legalLink}>{link.label}</a>
            : <button key={link.label} type="button" className={styles.legalLink} onClick={() => showLegal(link.name)}>{link.label}</button>)}
        </nav>
      </footer>
    </section>
  );
}

export default LoginImmersive;
