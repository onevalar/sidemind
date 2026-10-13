"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent, ReactNode } from "react";
import { AnimatePresence, MotionConfig, motion, useAnimate, useReducedMotion } from "motion/react";
import { Check } from "lucide-react";
import { motionTokens } from "../../lib/motion-tokens";
import { domainFixes, heroSignupCopy, type HeroSignupPerson, type HeroSignupState } from "./hero-signup-data";
import { GradientMesh } from "../../gradient-mesh/gradient-mesh";
import { readHeroMesh, type HeroMeshPalette } from "./hero-signup-palette";
import styles from "./hero-signup.module.css";

export type { HeroSignupPerson, HeroSignupState, HeroSignupStep } from "./hero-signup-data";

const { spring, duration, ease, stagger } = motionTokens;
const enter = [...ease.enter] as [number, number, number, number];

const noSubscribe = () => () => {};
/** Reduced motion that matches the server on the first render, so hydration never disagrees; it applies from the next frame. */
function useSafeReducedMotion() {
  const prefers = useReducedMotion();
  const hydrated = useSyncExternalStore(noSubscribe, () => true, () => false);
  return hydrated && Boolean(prefers);
}

export interface HeroSignupProps {
  /** Headline. A string rises in word by word on load. */
  title?: ReactNode;
  /** One supporting line under the headline. */
  description?: ReactNode;
  /** Email field placeholder. */
  placeholder?: string;
  /** Submit label. Narrow layouts use shortButtonLabel. */
  buttonLabel?: string;
  shortButtonLabel?: string;
  /** Quiet line under the field, usually a privacy promise. Errors and the confirmation replace it in place. */
  footnote?: ReactNode;
  /** People already on the list. The social proof counts up by one when the visitor joins. */
  count?: number;
  /** Portraits in the social proof stack. Three to five read best. */
  people?: readonly HeroSignupPerson[];
  /** Social proof line for a given count. */
  proof?: (count: ReactNode) => ReactNode;
  /** Hue of the mesh in degrees. Defaults to the hue of the page accent, or a calm blue violet for the neutral accent. */
  hue?: number;
  /** Adds the email to the list. Resolve with the visitor's place in line, or nothing to use count + 1. Reject with an Error to show its message with a retry. Without it the preview simulates the request. */
  onSubscribe?: (email: string) => void | number | Promise<void | number>;
  /** Called on every state change, for analytics. */
  onStateChange?: (state: HeroSignupState) => void;
  className?: string;
}

type Verdict = { ok: true; fix?: string } | { ok: false; message: string };

/** Live validation with a specific message for each way an address can be unfinished, plus a fix for common domain typos. */
function checkEmail(raw: string): Verdict {
  const value = raw.trim();
  if (!value) return { ok: false, message: "Enter your email to join the list" };
  if (/\s/.test(value)) return { ok: false, message: "Emails can't contain spaces" };
  const at = value.indexOf("@");
  if (at < 0) return { ok: false, message: "Add an @ and your domain, like you@company.com" };
  if (at === 0) return { ok: false, message: "Add your name before the @" };
  const domain = value.slice(at + 1);
  if (!domain) return { ok: false, message: "Add your domain after the @" };
  if (domain.includes("@")) return { ok: false, message: "Use a single @" };
  if (!/^[^\s.@]+(\.[^\s.@]+)*\.[a-z]{2,}$/i.test(domain)) return { ok: false, message: "Finish the domain, like company.com" };
  const fix = domainFixes[domain.toLowerCase()];
  return fix ? { ok: true, fix: `${value.slice(0, at)}@${fix}` } : { ok: true };
}

const format = (value: number) => new Intl.NumberFormat("en-US").format(value);
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A landing hero built around one email field, on a living mesh gradient tinted from the page accent. The field validates
 * as you type, the button holds a spinner while the request runs, and on success the button grows across the whole field
 * into the confirmation, where your place in line rolls in. The social proof count moves up by one at the same moment.
 */
export function HeroSignup({
  title = heroSignupCopy.title,
  description = heroSignupCopy.description,
  placeholder = heroSignupCopy.placeholder,
  buttonLabel = heroSignupCopy.buttonLabel,
  shortButtonLabel = heroSignupCopy.shortButtonLabel,
  footnote = heroSignupCopy.footnote,
  count = heroSignupCopy.count,
  people = heroSignupCopy.people,
  proof = total => <><span className={styles.proofStrong}>{total}</span> finance teams are on the list</>,
  hue,
  onSubscribe,
  onStateChange,
  className,
}: HeroSignupProps) {
  const reduced = useSafeReducedMotion();
  const id = useId();
  const [email, setEmail] = useState("");
  const [touched, setTouched] = useState(false);
  const [state, setState] = useState<HeroSignupState>("idle");
  const [failure, setFailure] = useState<string | null>(null);
  const [position, setPosition] = useState(count + 1);
  const [joined, setJoined] = useState(false);
  const [status, setStatus] = useState("");
  const [origin, setOrigin] = useState<{ top: number; right: number; bottom: number; left: number; radius: number } | null>(null);
  const [pillRef, animatePill] = useAnimate<HTMLFormElement>();
  const inputRef = useRef<HTMLInputElement>(null);
  const goRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef<HTMLDivElement>(null);
  const failedOnce = useRef(new Set<string>());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const onStateChangeRef = useRef(onStateChange);
  useEffect(() => { onStateChangeRef.current = onStateChange; });
  const firstState = useRef(true);
  useEffect(() => {
    if (firstState.current) { firstState.current = false; return; }
    onStateChangeRef.current?.(state);
  }, [state]);

  const verdict = checkEmail(email);
  const busy = state === "submitting";
  const done = state === "success";
  const invalid = touched && !verdict.ok && !done;
  const noteId = `${id}-note`;

  /** Where the confirmation grows from: the button's own box inside the pill. */
  const measureOrigin = () => {
    const pill = pillRef.current, go = goRef.current;
    if (!pill || !go) return null;
    const top = go.offsetTop, left = go.offsetLeft;
    return { top, left, right: pill.clientWidth - left - go.offsetWidth, bottom: pill.clientHeight - top - go.offsetHeight, radius: go.offsetHeight / 2 };
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || done) return;
    const value = email.trim();
    const check = checkEmail(value);
    if (!check.ok) {
      setTouched(true);
      setStatus(check.message);
      inputRef.current?.focus({ preventScroll: true });
      if (!reduced && pillRef.current) animatePill(pillRef.current, { x: [0, -8, 7, -4, 2, 0] }, { duration: .4, ease: "easeOut" });
      return;
    }
    setFailure(null);
    setState("submitting");
    setStatus("Joining the waitlist");
    try {
      let result: void | number = undefined;
      if (onSubscribe) result = await onSubscribe(value);
      else {
        await wait(1400);
        /* Simulated failure path: an address containing "fail" fails on its first try, so retry can be tested. */
        if (/fail/i.test(value) && !failedOnce.current.has(value.toLowerCase())) {
          failedOnce.current.add(value.toLowerCase());
          throw new Error("We couldn't save your spot");
        }
      }
      if (!alive.current) return;
      const place = typeof result === "number" ? result : count + 1;
      setOrigin(measureOrigin());
      setPosition(place);
      setJoined(true);
      setState("success");
      setStatus(`You're number ${format(place)} on the list. ${onSubscribe ? `We'll email ${value} when your invite is ready.` : "This preview is simulated, nothing was sent."}`);
      requestAnimationFrame(() => doneRef.current?.focus({ preventScroll: true }));
    } catch (reason) {
      if (!alive.current) return;
      const message = reason instanceof Error && reason.message ? reason.message : "We couldn't save your spot. Try again";
      setState("error");
      setFailure(message);
      setStatus(message);
    }
  };

  const change = () => {
    setOrigin(measureOrigin());
    setState("idle");
    setJoined(false);
    setStatus("");
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  };

  const applyFix = (fixed: string) => {
    setEmail(fixed);
    inputRef.current?.focus({ preventScroll: true });
  };

  /* The note under the field: privacy line, a live validation message, a typo fix, a failure with retry, or the confirmation. */
  let noteKey = "footnote";
  let note: ReactNode = footnote;
  if (done) {
    noteKey = "done";
    note = <>{onSubscribe ? <>We&apos;ll email {email.trim()} when your invite is ready.</> : <>Preview only, no email was sent.</>} <button type="button" className={styles.link} onClick={change}>Change email</button></>;
  } else if (invalid && !verdict.ok) {
    noteKey = `invalid-${verdict.message}`;
    note = <span className={styles.error}>{verdict.message}</span>;
  } else if (state === "error" && failure) {
    noteKey = "failure";
    note = <><span className={styles.error}>{failure}.</span> <button type="button" className={styles.link} onClick={() => void submit()}>Try again</button></>;
  } else if (verdict.ok && verdict.fix) {
    const fix = verdict.fix;
    noteKey = `fix-${fix}`;
    note = <>Did you mean <button type="button" className={styles.link} onClick={() => applyFix(fix)}>{fix}</button>?</>;
  }

  const words = typeof title === "string" ? title.split(" ") : null;
  const rise = (delay: number) => ({
    initial: reduced ? false as const : { opacity: 0, y: 14 },
    animate: { opacity: 1, y: 0 },
    transition: reduced ? { duration: 0 } : { duration: .7, ease: enter, delay },
  });
  const clipFrom = origin ? `inset(${origin.top}px ${origin.right}px ${origin.bottom}px ${origin.left}px round ${origin.radius}px)` : "inset(6px 6px 6px calc(100% - 50px) round 22px)";
  const clipTo = `inset(0px 0px 0px 0px round ${origin ? origin.top + origin.radius : 28}px)`;

  return <MotionConfig reducedMotion="user">
    <section className={[styles.root, className].filter(Boolean).join(" ")} aria-labelledby={`${id}-title`}>
      <HeroMesh hue={hue} />
      <div className={styles.inner}>
        <h1 id={`${id}-title`} className={styles.title}>
          {words
            ? words.map((word, i) => <span key={i}>
                <motion.span
                  className={styles.word}
                  initial={reduced ? false : { opacity: 0, y: "0.4em", filter: "blur(6px)" }}
                  animate={{ opacity: 1, y: "0em", filter: "blur(0px)" }}
                  transition={{ duration: .8, ease: enter, delay: .06 + i * stagger.word * 1.5 }}
                >{word}</motion.span>{i < words.length - 1 ? " " : null}
              </span>)
            : title}
        </h1>
        {description ? <motion.p className={styles.description} {...rise(.3)}>{description}</motion.p> : null}

        <motion.div className={styles.formWrap} {...rise(.42)}>
          <form ref={pillRef} className={styles.pill} onSubmit={submit} noValidate data-state={state} data-invalid={invalid || undefined} aria-busy={busy}>
            <label className={styles.srOnly} htmlFor={`${id}-email`}>Email address</label>
            <div className={styles.field} inert={done} data-valid={(verdict.ok && !busy) || undefined}>
              <input
                ref={inputRef}
                id={`${id}-email`}
                name="email"
                className={styles.input}
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="send"
                placeholder={placeholder}
                value={email}
                readOnly={busy}
                aria-invalid={invalid || undefined}
                aria-describedby={noteId}
                onChange={event => { setEmail(event.target.value); if (state === "error") { setState("idle"); setFailure(null); } }}
                onBlur={() => { if (email.trim()) setTouched(true); }}
              />
              <AnimatePresence initial={false}>
                {verdict.ok && !busy && <motion.span
                  key="valid"
                  className={styles.valid}
                  initial={{ opacity: 0, scale: .6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: .6, transition: { duration: duration.fast } }}
                  transition={spring.snappy}
                  aria-hidden="true"
                ><Check size={16} strokeWidth={2} /></motion.span>}
              </AnimatePresence>
              <button ref={goRef} type="submit" className={styles.go} aria-disabled={busy || undefined} data-busy={busy || undefined}>
                <span className={styles.goLabel} data-hidden={busy || undefined}>
                  <span className={styles.labelLong}>{buttonLabel}</span>
                  <span className={styles.labelShort} aria-hidden="true">{shortButtonLabel}</span>
                </span>
                <span className={styles.spinner} data-shown={busy || undefined} aria-hidden="true" />
                {busy && <span className={styles.srOnly}>Joining</span>}
              </button>
            </div>

            <motion.div
              ref={doneRef}
              className={styles.done}
              tabIndex={-1}
              aria-hidden={!done}
              initial={false}
              animate={done
                ? { clipPath: clipTo, opacity: 1 }
                : { clipPath: clipFrom, transitionEnd: { opacity: 0 } }}
              transition={reduced ? { duration: 0 } : { clipPath: spring.smooth, opacity: { duration: 0 } }}
            >
              <motion.span
                className={styles.doneBody}
                initial={false}
                animate={done ? { opacity: 1, y: 0, filter: "blur(0px)" } : { opacity: 0, y: reduced ? 0 : 6, filter: reduced ? "blur(0px)" : "blur(4px)" }}
                transition={done ? { duration: duration.considered, ease: enter, delay: reduced ? 0 : .12 } : { duration: duration.instant }}
              >
                <span className={styles.doneMark} aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="14" height="14">
                    <motion.path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" initial={false} animate={{ pathLength: done || reduced ? 1 : 0 }} transition={{ duration: done ? .45 : 0, ease: enter, delay: done ? .22 : 0 }} />
                  </svg>
                </span>
                <span>You&apos;re #{done ? <Roll value={position} from={0} reduced={reduced} delay={.2} /> : format(position)} on the list</span>
              </motion.span>
            </motion.div>
          </form>

          <div id={noteId} className={styles.note}>
            <AnimatePresence initial={false}>
              <motion.p
                key={noteKey}
                className={styles.noteText}
                initial={{ opacity: 0, y: reduced ? 0 : -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: { duration: duration.instant } }}
                transition={{ duration: duration.standard, ease: enter }}
              >{note}</motion.p>
            </AnimatePresence>
          </div>
        </motion.div>

        <motion.div className={styles.proof} {...rise(.54)}>
          {people.length > 0 && <span className={styles.faces}>
            {people.slice(0, 5).map(person => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={person.src} className={styles.face} src={person.src} alt="" width={28} height={28} loading="lazy" decoding="async" />
            ))}
          </span>}
          <p className={styles.proofText}>
            <span aria-hidden="true">{proof(<Roll value={count + (joined ? 1 : 0)} reduced={reduced} />)}</span>
            <span className={styles.srOnly}>{`${format(count + (joined ? 1 : 0))} people are on the list`}</span>
          </p>
        </motion.div>
        <p className={styles.srOnly} role="status" aria-live="polite">{status}</p>
      </div>
    </section>
  </MotionConfig>;
}

/**
 * The background: Arc's Gradient mesh in background mode, with a soft palette read from the page accent and theme. It mounts
 * once the palette is known, so the first frame is never a wrong color, then follows theme and accent changes, blending into
 * the new colors.
 */
function HeroMesh({ hue }: { hue?: number }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [palette, setPalette] = useState<HeroMeshPalette | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const read = () => setPalette(prev => {
      const next = readHeroMesh(host, hue);
      return prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
    });
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-accent", "class", "style"] });
    return () => observer.disconnect();
  }, [hue]);
  return <div ref={hostRef} className={styles.mesh} data-ready={palette ? "" : undefined} aria-hidden="true">
    {palette && <GradientMesh mode="background" base={palette.base} points={palette.points} grain={.06} speed={.55} maxPoints={8} />}
  </div>;
}

/** A number whose digits roll on reels to their value, like an odometer. Tabular digits keep the width stable. */
function Roll({ value, from, reduced, delay = 0 }: { value: number; from?: number; reduced: boolean; delay?: number }) {
  const chars = format(value).split("");
  const start = from === undefined ? null : format(from).padStart(chars.length, "0");
  return <span className={styles.roll} aria-hidden="true">
    {chars.map((char, i) => {
      const fromRight = chars.length - 1 - i;
      if (!/\d/.test(char)) return <span key={`sep-${fromRight}`}>{char}</span>;
      const digit = Number(char);
      const origin = start ? Number(/\d/.test(start[i]) ? start[i] : 0) : null;
      return <span key={`digit-${fromRight}`} className={styles.digit}>
        <motion.span
          className={styles.reel}
          initial={reduced || origin === null ? false : { y: `${-origin * 10}%` }}
          animate={{ y: `${-digit * 10}%` }}
          transition={reduced ? { duration: 0 } : { type: "spring", visualDuration: .9, bounce: 0, delay: delay + i * .06 }}
        >
          {Array.from({ length: 10 }, (_, n) => <span key={n}>{n}</span>)}
        </motion.span>
      </span>;
    })}
  </span>;
}

export default HeroSignup;
