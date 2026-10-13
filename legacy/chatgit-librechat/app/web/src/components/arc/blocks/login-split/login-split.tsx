"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import Image from "next/image";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, type Transition, type Variants } from "motion/react";
import { Check, ChevronDown } from "lucide-react";
import { Avatar } from "../../avatar/avatar";
import { Button } from "../../button/button";
import { Input } from "../../input/input";
import { PasswordField } from "../../password-field/password-field";
import { avatar, photo } from "../../lib/media";
import { motionTokens } from "../../lib/motion-tokens";
import styles from "./login-split.module.css";

type Step = "email" | "password" | "done";
type Provider = "Google" | "Apple" | "GitHub";
type LinkName = "signUp" | "terms" | "privacy";
export type LoginSplitMethod = "Password" | Provider;
export interface LoginSplitAccount { name: string; email: string; photo?: string }
export interface LoginSplitProps {
  /** Fill the viewport (100dvh, no frame) when the screen is used as a page. */
  fullScreen?: boolean;
  /** The password the simulated account accepts. */
  demoPassword?: string;
  /** Real destinations for the small links. Without them each link announces a simulated action. */
  links?: Partial<Record<LinkName, string>>;
  /** Called once the simulated sign in finishes. */
  onSignIn?: (account: LoginSplitAccount, method: LoginSplitMethod) => void;
}
type StepCustom = { direction: number; reduce: boolean };

const RESEND_SECONDS = 30;
const sidePhoto = photo("concert-hall");
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
const linkLabels: Record<LinkName, string> = { signUp: "Sign up", terms: "Terms", privacy: "Privacy" };
/** Monochrome provider marks in currentColor (Simple Icons paths), so they stay neutral in both themes. */
const providerMarks: Record<Provider, string> = {
  Google: "M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z",
  Apple: "M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701",
  GitHub: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
};
const people: LoginSplitAccount[] = [
  { name: "Emma Collins", email: "emma@northwind.studio", photo: avatar("emma-collins") },
  { name: "Marcus Johnson", email: "marcus@northwind.studio", photo: avatar("marcus-johnson") },
  { name: "Ava Mitchell", email: "ava@northwind.studio", photo: avatar("ava-mitchell") },
  { name: "Jasmine Brooks", email: "jasmine@northwind.studio", photo: avatar("jasmine-brooks") },
];

const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
/** Known teammates keep their photo; anyone else gets a name from their address and an initials avatar. */
function accountFor(value: string): LoginSplitAccount {
  const email = value.trim().toLowerCase();
  const parts = email.split("@")[0].split(/[._+-]+/).filter(Boolean);
  const known = people.find(person => person.name.toLowerCase().split(" ")[0] === parts[0]);
  if (known) return { ...known, email };
  return { name: parts.slice(0, 2).map(part => part[0].toUpperCase() + part.slice(1)).join(" ") || "Arc member", email };
}

/** Steps cross over with a small rise out of a soft blur, forward from below and back from above. */
const stepMotion: Variants = {
  enter: ({ direction, reduce }: StepCustom) => reduce ? { opacity: 0 } : { opacity: 0, y: direction * 14, filter: `blur(${motionTokens.blur.soft}px)` },
  center: ({ reduce }: StepCustom) => ({ opacity: 1, y: 0, filter: "blur(0px)", transition: reduce ? { duration: motionTokens.duration.instant } : { y: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.standard, ease: motionTokens.ease.enter, delay: .06 }, filter: { duration: motionTokens.duration.standard, ease: motionTokens.ease.enter, delay: .06 } } }),
  exit: ({ direction, reduce }: StepCustom) => reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: direction * -8, filter: `blur(${motionTokens.blur.subtle}px)`, transition: { y: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.exit, ease: motionTokens.ease.standard }, filter: { duration: motionTokens.duration.exit } } },
};
/** In-place copy changes: the new words rise in, the old ones lift away. */
const swap = (reduce: boolean) => ({
  initial: reduce ? { opacity: 0 } : { opacity: 0, y: 6, filter: `blur(${motionTokens.blur.soft}px)` },
  animate: { opacity: 1, y: 0, filter: "blur(0px)" },
  exit: reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -4, filter: `blur(${motionTokens.blur.subtle}px)`, transition: { duration: motionTokens.duration.fast } },
  transition: (reduce ? { duration: motionTokens.duration.instant } : { duration: motionTokens.duration.standard, ease: motionTokens.ease.enter }) as Transition,
});
/** Rows that open and close their height on a spring, so nothing below them jumps. */
const expand = (reduce: boolean) => ({
  initial: { height: 0, opacity: 0 },
  animate: { height: "auto", opacity: 1 },
  exit: { height: 0, opacity: 0 },
  transition: (reduce ? { duration: 0 } : { height: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.fast } }) as Transition,
});
const roll: Variants = {
  enter: (direction: number) => ({ opacity: 0, y: `${-0.7 * direction}em`, filter: `blur(${motionTokens.blur.subtle}px)` }),
  center: { opacity: 1, y: 0, filter: "blur(0px)" },
  exit: (direction: number) => ({ opacity: 0, y: `${0.7 * direction}em`, filter: `blur(${motionTokens.blur.subtle}px)` }),
};

/** Each digit rolls down as the countdown runs and back up when a new link restarts it. */
function Countdown({ seconds, reduce }: { seconds: number; reduce: boolean }) {
  const [shown, setShown] = useState({ seconds, direction: 1 });
  if (shown.seconds !== seconds) setShown({ seconds, direction: seconds < shown.seconds ? 1 : -1 });
  const text = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const transition: Transition = reduce ? { duration: 0 } : { y: motionTokens.spring.snappy, opacity: { duration: motionTokens.duration.fast }, filter: { duration: motionTokens.duration.fast } };
  return <span className={styles.time}>{text.split("").map((character, index) => <span key={index} className={styles.timeColumn}>
    <AnimatePresence initial={false} mode="popLayout" custom={shown.direction}><motion.span key={character} custom={shown.direction} variants={roll} initial="enter" animate="center" exit="exit" transition={transition}>{character}</motion.span></AnimatePresence>
  </span>)}</span>;
}

function CheckMark({ reduce }: { reduce: boolean }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <motion.path d="M5 12.5l4.5 4.5L19 7.5" initial={reduce ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: motionTokens.duration.considered * .7, ease: motionTokens.ease.enter, delay: .14 }} />
  </svg>;
}

/** The form follows its content on a spring only while the step changes; otherwise it stays auto, so messages open without lag. */
function useStepHeight(step: Step, reduce: boolean) {
  const track = useRef<HTMLDivElement>(null);
  const height = useMotionValue<number | "auto">("auto");
  const measured = useRef(0);
  const gliding = useRef(false);
  const lastStep = useRef(step);
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
    if (lastStep.current === step) return;
    lastStep.current = step;
    const current = height.get();
    const from = typeof current === "number" ? current : measured.current;
    const to = track.current?.offsetHeight ?? 0;
    if (reduce || !from || !to) { gliding.current = false; height.jump("auto"); return; }
    if (current === "auto") height.jump(from);
    glide(to);
  }, [step, reduce, height, glide]);
  return { track, height };
}

export function LoginSplit({ fullScreen = false, demoPassword = "arc-demo", links, onSignIn }: LoginSplitProps) {
  const errorId = useId();
  const reduce = !!useReducedMotion();
  const [step, setStep] = useState<Step>("email");
  const [direction, setDirection] = useState(1);
  const [email, setEmail] = useState("");
  const [touched, setTouched] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [busy, setBusy] = useState<null | "email" | Provider>(null);
  const [submit, setSubmit] = useState<"idle" | "checking" | "success">("idle");
  const [reset, setReset] = useState<"idle" | "sending" | "sent">("idle");
  const [resendIn, setResendIn] = useState(0);
  const [account, setAccount] = useState<LoginSplitAccount>(people[0]);
  const [method, setMethod] = useState<LoginSplitMethod>("Password");
  const [finished, setFinished] = useState(false);
  const [status, setStatus] = useState("");
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLHeadingElement>(null);
  const focusNext = useRef<"email" | "password" | "done" | null>(null);
  const timers = useRef<number[]>([]);
  const { track, height } = useStepHeight(step, reduce);

  const Heading = fullScreen ? "h1" : "h2";
  const emailError = (touched || attempted) && !isEmail(email) ? (email.trim() ? "Enter a full address, like name@example.com." : "Enter your email address.") : "";
  const custom: StepCustom = { direction, reduce };
  const firstName = account.name.split(" ")[0];

  useEffect(() => { const pending = timers.current; return () => pending.forEach(window.clearTimeout); }, []);
  useEffect(() => {
    if (step !== "password" || reset !== "sent" || resendIn <= 0) return;
    const timer = window.setTimeout(() => setResendIn(seconds => Math.max(0, seconds - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [step, reset, resendIn]);
  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (target === "email") { emailRef.current?.focus({ preventScroll: true }); emailRef.current?.select(); }
    if (target === "password") passwordRef.current?.focus({ preventScroll: true });
    if (target === "done") doneRef.current?.focus({ preventScroll: true });
  }, [step]);

  function later(run: () => void, ms: number) { timers.current.push(window.setTimeout(run, ms)); }
  function cancelPending() { timers.current.splice(0).forEach(window.clearTimeout); }
  function go(next: Step, towards: number, focus: "email" | "password" | "done" | null = null) { focusNext.current = focus; setDirection(towards); setStep(next); }
  function shake() {
    if (reduce || !fieldRef.current) return;
    animate(fieldRef.current, { x: [0, -7, 6, -4, 2, 0] }, { duration: .42, ease: motionTokens.ease.standard });
  }

  function submitEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setAttempted(true);
    if (!isEmail(email)) { emailRef.current?.focus(); return; }
    setBusy("email");
    setStatus("Looking up your account");
    later(() => {
      const next = accountFor(email);
      setBusy(null);
      setAccount(next);
      setPassword("");
      setPasswordError("");
      setSubmit("idle");
      setReset("idle");
      go("password", 1, "password");
      setStatus(`Enter the password for ${next.email}`);
    }, 650);
  }

  function finish(next: LoginSplitAccount, how: LoginSplitMethod) {
    setBusy(null);
    setAccount(next);
    setMethod(how);
    setFinished(false);
    go("done", 1, "done");
    setStatus(`Signing you in as ${next.email}`);
    // The bar below runs for the same time, so the copy turns over as it fills.
    later(() => {
      setFinished(true);
      setStatus(`Signed in with ${how === "Password" ? "a password" : how}`);
      onSignIn?.(next, how);
    }, reduce ? 400 : 1700);
  }

  function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submit !== "idle") return;
    if (!password) { setPasswordError("Enter your password."); shake(); passwordRef.current?.focus(); return; }
    setSubmit("checking");
    setPasswordError("");
    setStatus("Checking your password");
    later(() => {
      if (password === demoPassword) {
        setSubmit("success");
        setStatus("Password accepted");
        later(() => finish(account, "Password"), 760);
        return;
      }
      setSubmit("idle");
      setPasswordError("That password is incorrect. Try again or reset it.");
      setStatus("Incorrect password");
      shake();
      passwordRef.current?.focus();
      passwordRef.current?.select();
    }, 800);
  }

  function forgot() {
    if (reset !== "idle" || submit !== "idle") return;
    setReset("sending");
    setStatus("Sending a reset link");
    later(() => { setReset("sent"); setResendIn(RESEND_SECONDS); setStatus(`Reset link sent to ${account.email}`); }, 900);
  }

  function resend() {
    if (resendIn > 0) return;
    setResendIn(RESEND_SECONDS);
    setStatus("New reset link sent");
  }

  function changeEmail() {
    cancelPending();
    setSubmit("idle");
    setReset("idle");
    setAttempted(false);
    setEmail(account.email);
    go("email", -1, "email");
    setStatus("Edit your email");
  }

  function signInWith(provider: Provider) {
    if (busy) return;
    setBusy(provider);
    setStatus(`Opening ${provider}`);
    later(() => finish(isEmail(email) ? accountFor(email) : people[0], provider), 1000);
  }

  function signOut() {
    cancelPending();
    setPassword("");
    setSubmit("idle");
    setReset("idle");
    setFinished(false);
    setTouched(false);
    setAttempted(false);
    setEmail(account.email);
    go("email", -1, "email");
    setStatus("Signed out");
  }

  const link = (name: LinkName) => links?.[name]
    ? <a className={styles.textLink} href={links[name]}>{linkLabels[name]}</a>
    : <button type="button" className={styles.textLink} onClick={() => setStatus(`${linkLabels[name]} opens in your app`)}>{linkLabels[name]}</button>;

  return (
    <section className={styles.root} data-full-screen={fullScreen || undefined} aria-label="Sign in to Arc">
      <div className={styles.layout}>
        <div className={styles.formSide}>
          <header className={styles.topBar}>
            <span className={styles.brand}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 17a8 8 0 0 1 16 0" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" /><circle cx="12" cy="17" r="2.25" fill="currentColor" /></svg>
              Arc
            </span>
            <p className={styles.signUp}>No account? {link("signUp")}</p>
          </header>

          <div className={styles.main}>
            <motion.div className={styles.viewport} style={{ height }}>
              <div ref={track} className={styles.track}>
                <AnimatePresence mode="popLayout" initial={false} custom={custom}>
                  {step === "email" && <motion.div key="email" className={styles.step} custom={custom} variants={stepMotion} initial="enter" animate="center" exit="exit">
                    <div className={styles.heading}><Heading>Welcome back</Heading><p>Sign in to Arc with your work email.</p></div>
                    <form className={styles.form} onSubmit={submitEmail} noValidate>
                      <Input ref={emailRef} label="Email" type="email" name="email" inputMode="email" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="name@example.com" value={email} readOnly={busy === "email"} error={emailError} onChange={event => setEmail(event.target.value)} onBlur={() => { if (email.trim()) setTouched(true); }} />
                      <Button type="submit" className={styles.wide} loading={busy === "email"}>Continue</Button>
                    </form>
                    <div className={styles.divider}>or</div>
                    <div className={styles.providers} role="group" aria-label="Single sign-on">
                      {providers.map(provider => <Button key={provider} type="button" variant="secondary" className={styles.providerButton} aria-label={`Continue with ${provider}`} loading={busy === provider} aria-disabled={(!!busy && busy !== provider) || undefined} onClick={() => signInWith(provider)}>
                        {provider === "Google" ? <GoogleLogo className={styles.providerMark} /> : <svg className={styles.providerMark} width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={providerMarks[provider]} /></svg>}{provider}
                      </Button>)}
                    </div>
                  </motion.div>}

                  {step === "password" && <motion.div key="password" className={styles.step} custom={custom} variants={stepMotion} initial="enter" animate="center" exit="exit">
                    <div className={styles.heading}>
                      <Heading>Enter your password</Heading>
                      <button type="button" className={styles.chip} aria-label={`${account.email}, change email`} onClick={changeEmail}>
                        <Avatar name={account.name} src={account.photo} size="sm" />
                        <span className={styles.chipEmail}>{account.email}</span>
                        <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" />
                      </button>
                    </div>
                    <form className={styles.form} onSubmit={submitPassword} noValidate>
                      <input hidden readOnly type="email" name="username" autoComplete="username" value={account.email} />
                      <div className={styles.fieldGroup}>
                        <div ref={fieldRef} className={styles.passwordField}>
                          <PasswordField ref={passwordRef} label="Password" name="password" autoComplete="current-password" description={`For this demo, the password is ${demoPassword}.`} value={password} readOnly={submit !== "idle"} aria-invalid={passwordError ? true : undefined} aria-describedby={passwordError ? errorId : undefined} onChange={event => { setPassword(event.target.value); if (passwordError) setPasswordError(""); }} />
                          <button type="button" className={styles.forgot} aria-disabled={reset !== "idle" || undefined} onClick={forgot}>
                            <AnimatePresence mode="popLayout" initial={false}>
                              <motion.span key={reset} className={styles.forgotLabel} {...swap(reduce)}>
                                {reset === "idle" ? "Forgot password?" : reset === "sending" ? "Sending link" : <><Check size={14} strokeWidth={2} aria-hidden="true" />Link sent</>}
                              </motion.span>
                            </AnimatePresence>
                          </button>
                        </div>
                        <AnimatePresence initial={false}>
                          {passwordError && <motion.div key="error" className={styles.row} {...expand(reduce)}><p id={errorId} className={styles.error} role="alert">{passwordError}</p></motion.div>}
                          {reset === "sent" && <motion.div key="reset" className={styles.row} {...expand(reduce)}>
                            <p className={styles.notice}>
                              <span>Reset link sent to <span className={styles.strong}>{account.email}</span>.</span>
                              <button type="button" className={styles.textLink} aria-disabled={resendIn > 0 || undefined} aria-label={resendIn > 0 ? `Resend link, available in ${resendIn} seconds` : "Resend link"} onClick={resend}>
                                <AnimatePresence mode="popLayout" initial={false}>
                                  <motion.span key={resendIn > 0 ? "wait" : "ready"} className={styles.resendLabel} {...swap(reduce)}>{resendIn > 0 ? <>Resend in <Countdown seconds={resendIn} reduce={reduce} /></> : "Resend link"}</motion.span>
                                </AnimatePresence>
                              </button>
                            </p>
                          </motion.div>}
                        </AnimatePresence>
                      </div>
                      <div className={styles.submitRow}>
                        <motion.div className={styles.submitSlot} data-success={submit === "success" || undefined} initial={false} animate={{ width: submit === "success" ? 44 : "100%" }} transition={reduce ? { duration: 0 } : motionTokens.spring.morph}>
                          <Button type="submit" className={styles.submit} loading={submit === "checking"} aria-label={submit === "success" ? "Password accepted" : undefined}>
                            {submit === "success" ? <CheckMark reduce={reduce} /> : "Sign in"}
                          </Button>
                        </motion.div>
                      </div>
                    </form>
                  </motion.div>}

                  {step === "done" && <motion.div key="done" className={styles.step} custom={custom} variants={stepMotion} initial="enter" animate="center" exit="exit">
                    <div className={styles.account}>
                      <Avatar name={account.name} src={account.photo} />
                      <span className={styles.accountText}><span className={styles.strong}>{account.name}</span><span className={styles.accountEmail}>{account.email}</span></span>
                    </div>
                    <div className={styles.heading}>
                      <Heading ref={doneRef} tabIndex={-1} className={styles.swapLine}>
                        <AnimatePresence mode="popLayout" initial={false}><motion.span key={finished ? "in" : "going"} className={styles.swapText} {...swap(reduce)}>{finished ? `You're in, ${firstName}` : "Signing you in"}</motion.span></AnimatePresence>
                      </Heading>
                      <p className={styles.swapLine}>
                        <AnimatePresence mode="popLayout" initial={false}><motion.span key={finished ? "in" : "going"} className={styles.swapText} {...swap(reduce)}>{finished ? `Signed in with ${method === "Password" ? "your password" : method}. Your app takes over from here.` : "Opening your workspace and recent files."}</motion.span></AnimatePresence>
                      </p>
                    </div>
                    {/* The bar stays mounted and folds away, so its fill never inherits a skipped entrance from a presence list. */}
                    <motion.div className={styles.row} initial={false} animate={finished ? { height: 0, opacity: 0 } : { height: "auto", opacity: 1 }} transition={reduce ? { duration: 0 } : { height: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.fast } }}>
                      <div className={styles.progress} aria-hidden="true"><motion.span className={styles.progressFill} initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={reduce ? { duration: 0 } : { duration: 1.4, ease: motionTokens.ease.inOut, delay: .25 }} /></div>
                    </motion.div>
                    <AnimatePresence initial={false}>
                      {finished && <motion.div key="out" className={styles.row} {...expand(reduce)}><div className={styles.doneActions}><Button type="button" variant="secondary" className={styles.wide} onClick={signOut}>Sign out</Button></div></motion.div>}
                    </AnimatePresence>
                  </motion.div>}
                </AnimatePresence>
              </div>
            </motion.div>
          </div>

          <footer className={styles.footer}>
            <p className={styles.srOnly} role="status" aria-live="polite">{status}</p>
            <span className={styles.status} aria-hidden="true">
              <AnimatePresence mode="popLayout" initial={false}><motion.span key={status} {...swap(reduce)}>{status}</motion.span></AnimatePresence>
            </span>
            <nav className={styles.footerLinks} aria-label="Legal">{link("terms")}{link("privacy")}</nav>
          </footer>
        </div>

        <div className={styles.photoSide} aria-hidden="true">
          <Image src={sidePhoto.src} alt="" fill sizes="(max-width: 760px) 100vw, 50vw" className={styles.photo} />
        </div>
      </div>
    </section>
  );
}

export default LoginSplit;
