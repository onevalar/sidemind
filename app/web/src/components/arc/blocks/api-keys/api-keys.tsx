"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { AnimatePresence, animate, motion, useIsPresent, useMotionValue, useReducedMotion } from "motion/react";
import type { AnimationPlaybackControls, MotionValue, TargetAndTransition } from "motion/react";
import { ChevronDown, Plus, TriangleAlert } from "lucide-react";
import { Avatar } from "../../avatar/avatar";
import { Badge } from "../../badge/badge";
import { Button } from "../../button/button";
import { Checkbox } from "../../checkbox/checkbox";
import { CopyButton } from "../../copy-button/copy-button";
import { HoldToConfirm } from "../../hold-to-confirm/hold-to-confirm";
import { Input } from "../../input/input";
import SegmentedControl from "../../segmented-control/segmented-control";
import { motionTokens } from "../../lib/motion-tokens";
import styles from "./api-keys.module.css";

/**
 * API key management. "Create key" unfolds into its own form: the button grows into the panel, its plus turns into the close control, and the label
 * becomes the panel title. A generated secret is shown once, sharpening out of a blur, while its masked row settles into the list with a highlight that
 * fades when the panel closes. Revoking is a press and hold: the row strikes through, dims, and collapses. Everything is simulated and deterministic.
 */

type Env = "live" | "test";
type Scope = "payments:write" | "customers:read" | "invoices:write" | "reports:read";
type Person = { name: string; photo: string };
type ApiKey = { id: string; name: string; env: Env; last4: string; scopes: Scope[]; created: string; used: string; source?: string; idle?: string; requests: number; owner: Person };

const emma = { name: "Emma Collins", photo: "/media/people/emma-collins.jpg" };
const marcus = { name: "Marcus Johnson", photo: "/media/people/marcus-johnson.jpg" };
const ava = { name: "Ava Mitchell", photo: "/media/people/ava-mitchell.jpg" };
const jasmine = { name: "Jasmine Brooks", photo: "/media/people/jasmine-brooks.jpg" };
const sofia = { name: "Sofia Ramirez", photo: "/media/people/sofia-ramirez.jpg" };

const scopeOptions: { id: Scope; description: string }[] = [
  { id: "payments:write", description: "Create, capture, and refund payments" },
  { id: "customers:read", description: "Read customers and saved payment methods" },
  { id: "invoices:write", description: "Draft, finalize, and send invoices" },
  { id: "reports:read", description: "Download balance and payout reports" },
];

const sampleKeys: ApiKey[] = [
  { id: "production", name: "Production server", env: "live", last4: "4f2a", scopes: ["payments:write", "customers:read", "invoices:write"], created: "Mar 4, 2026", used: "2 min ago", source: "34.201.18.7, Ashburn", requests: 1284902, owner: emma },
  { id: "billing", name: "Billing worker", env: "live", last4: "9c01", scopes: ["invoices:write", "reports:read"], created: "Jan 18, 2026", used: "3 hours ago", source: "18.184.72.40, Frankfurt", requests: 48211, owner: marcus },
  { id: "staging", name: "Staging", env: "test", last4: "d7e3", scopes: ["payments:write", "customers:read"], created: "Aug 30, 2026", used: "yesterday", source: "CI runner 10.0.12.8", requests: 9870, owner: ava },
  { id: "export", name: "Analytics export", env: "live", last4: "2b8a", scopes: ["reports:read"], created: "Nov 2, 2025", used: "41 days ago", source: "52.17.230.9, Dublin", idle: "No requests in 41 days. Revoke it if nothing depends on it.", requests: 0, owner: jasmine },
  { id: "local", name: "Local development", env: "test", last4: "6a55", scopes: ["payments:write", "customers:read", "invoices:write", "reports:read"], created: "Sep 9, 2026", used: "never", requests: 0, owner: sofia },
];

const envOptions = [{ value: "test", label: "Test" }, { value: "live", label: "Live" }];
const defaultScopes: Scope[] = ["customers:read"];
const count = new Intl.NumberFormat("en-US");
const easeEnter = [...motionTokens.ease.enter] as [number, number, number, number];
const easeStandard = [...motionTokens.ease.standard] as [number, number, number, number];
const instant = { duration: 0 };
const rest: TargetAndTransition = { opacity: 1, y: "0em", filter: "blur(0px)" };
const rise: TargetAndTransition = { opacity: 0, y: "0.35em", filter: `blur(${motionTokens.blur.soft}px)` };
const lift: TargetAndTransition = { opacity: 0, y: "-0.3em", filter: `blur(${motionTokens.blur.subtle}px)`, transition: { duration: motionTokens.duration.fast, ease: easeStandard } };
const roll = {
  enter: (direction: number) => ({ opacity: 0, y: `${direction * .6}em`, filter: `blur(${motionTokens.blur.subtle}px)` }),
  center: { opacity: 1, y: "0em", filter: "blur(0px)" },
  exit: (direction: number) => ({ opacity: 0, y: `${direction * -.6}em`, filter: `blur(${motionTokens.blur.subtle}px)` }),
};

/** A stable, fake secret: the same name, environment, and order always produce the same characters. */
function secretFor(seed: string, env: Env) {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  let body = "";
  for (let index = 0; index < 40; index++) {
    hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
    hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
    hash ^= hash >>> 16;
    body += alphabet[(hash >>> 0) % alphabet.length];
    hash = (hash + 0x9e3779b9) | 0;
  }
  return `sk_${env}_${body}`;
}

const masked = (key: ApiKey) => `sk_${key.env}_••••${key.last4}`;
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Changing words rise out of a soft blur; the leaving copy is hidden from assistive tech while it fades. */
function SwapText({ text, reduced }: { text: string; reduced: boolean }) {
  return <span className={styles.swap}><AnimatePresence mode="popLayout" initial={false}><SwapWord key={text} text={text} reduced={reduced} /></AnimatePresence></span>;
}
function SwapWord({ text, reduced }: { text: string; reduced: boolean }) {
  const present = useIsPresent();
  return <motion.span className={styles.swapText} aria-hidden={present ? undefined : true} initial={reduced ? { opacity: 0 } : rise} animate={rest} exit={reduced ? { opacity: 0, transition: instant } : lift} transition={reduced ? instant : { duration: motionTokens.duration.standard, ease: easeEnter }}>{text}</motion.span>;
}

/** The count rolls up when a key arrives and down when one is revoked. */
function RollingCount({ value, reduced }: { value: number; reduced: boolean }) {
  const [shown, setShown] = useState({ value, direction: 1 });
  if (shown.value !== value) setShown({ value, direction: value > shown.value ? 1 : -1 });
  return <span className={styles.roll} aria-hidden="true"><AnimatePresence mode="popLayout" initial={false} custom={shown.direction}>
    <motion.span key={value} custom={shown.direction} variants={roll} initial={reduced ? false : "enter"} animate="center" exit={reduced ? undefined : "exit"} transition={reduced ? instant : { y: motionTokens.spring.snappy, opacity: { duration: motionTokens.duration.fast }, filter: { duration: motionTokens.duration.fast } }}>{value}</motion.span>
  </AnimatePresence></span>;
}

/** A line drawn across revoked text, from its first letter to its last. */
function Strike({ on, delay, reduced }: { on: boolean; delay: number; reduced: boolean }) {
  return <motion.span className={styles.strike} aria-hidden="true" initial={false} animate={{ scaleX: on ? 1 : 0 }} transition={reduced ? instant : { duration: motionTokens.duration.considered, ease: easeEnter, delay }} />;
}

/**
 * Sizes the create shell with real width and height, so nothing inside is ever stretched. The button's width and the toolbar's width are measured;
 * opening springs from one to the other while the height follows the panel's content. Changes the person caused animate; later reflows follow at once.
 */
function useShellSize(open: boolean, reduced: boolean) {
  const width = useMotionValue<number | "auto">("auto");
  const height = useMotionValue<number | "auto">("auto");
  const [size, setSize] = useState({ track: 0, face: 0, row: 0, inner: 0 });
  const trackRef = useRef<HTMLDivElement>(null);
  const faceRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(open);
  const armedUntil = useRef(0);
  const running = useRef<{ width?: AnimationPlaybackControls; height?: AnimationPlaybackControls }>({});

  useLayoutEffect(() => { openRef.current = open; }, [open]);
  useEffect(() => {
    const track = trackRef.current, face = faceRef.current, inner = innerRef.current;
    if (!track || !face || !inner || typeof ResizeObserver === "undefined") return;
    // The button's width is only read while it is closed; the open title may be a different length.
    const observer = new ResizeObserver(() => setSize(current => {
      const next = { track: track.getBoundingClientRect().width, face: openRef.current && current.face ? current.face : face.getBoundingClientRect().width, row: face.offsetHeight, inner: inner.getBoundingClientRect().height };
      return next.track === current.track && next.face === current.face && next.row === current.row && next.inner === current.inner ? current : next;
    }));
    [track, face, inner].forEach(node => observer.observe(node));
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!size.track || !size.face || !size.row) return;
    const moving = !reduced && performance.now() < armedUntil.current;
    const to = (value: MotionValue<number | "auto">, target: number, key: "width" | "height") => {
      const from = value.get();
      running.current[key]?.stop();
      if (!moving || typeof from !== "number") value.jump(target);
      else if (Math.abs(from - target) > .5) running.current[key] = animate(value, target, motionTokens.spring.smooth);
    };
    to(width, open ? size.track : size.face, "width");
    to(height, open ? Math.max(size.inner, size.row) : size.row, "height");
  }, [open, size, reduced, width, height]);
  useEffect(() => () => { running.current.width?.stop(); running.current.height?.stop(); }, []);

  const arm = () => { armedUntil.current = performance.now() + 900; };
  return { width, height, trackRef, faceRef, innerRef, arm };
}

type RowProps = { item: ApiKey; rowId: string; open: boolean; fresh: boolean; revoked: boolean; reduced: boolean; onToggle: () => void; onRevoke: () => void; triggerRef: (node: HTMLButtonElement | null) => void };

function KeyRow({ item, rowId, open, fresh, revoked, reduced, onToggle, onRevoke, triggerRef }: RowProps) {
  const detailId = `${rowId}-detail`;
  return <motion.div id={rowId} role="listitem" className={styles.row} data-open={open} data-fresh={fresh} data-revoked={revoked}
    initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
    exit={reduced ? { opacity: 0, transition: instant } : { opacity: 0, height: 0, transition: { height: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.standard, ease: easeStandard } } }}
    transition={reduced ? instant : { height: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.standard, ease: easeEnter, delay: .08 } }}>
    <div className={styles.rowInner}>
      <span className={styles.flash} aria-hidden="true" />
      <button ref={triggerRef} className={styles.trigger} type="button" aria-expanded={open} aria-controls={open ? detailId : undefined} disabled={revoked} onClick={onToggle}>
        <span className={styles.identity}>
          <span className={styles.nameLine}>
            <span className={styles.strikeable}><span className={styles.name}>{item.name}</span><Strike on={revoked} delay={0} reduced={reduced} /></span>
            <Badge size="sm" tone={item.env === "live" ? "success" : "neutral"} className={styles.env}>{item.env === "live" ? "Live" : "Test"}</Badge>
          </span>
          <span className={styles.strikeable}><span className={styles.masked} aria-hidden="true">{masked(item)}</span><Strike on={revoked} delay={.08} reduced={reduced} /></span>
          <span className={styles.srOnly}>{`Key ending in ${item.last4}${revoked ? ", revoked" : ""}`}</span>
        </span>
        <span className={styles.scopes}><span className={styles.srOnly}>Scopes: </span>{item.scopes.map(scope => <span key={scope} className={styles.chip}>{scope}</span>)}</span>
        <span className={styles.dates}>
          <span className={styles.used}>{item.idle ? <><TriangleAlert className={styles.idleIcon} size={13} strokeWidth={1.75} aria-hidden="true" /><span className={styles.srOnly}>Idle, </span></> : null}{item.used === "never" ? "Never used" : `Used ${item.used}`}</span>
          <span className={styles.created}>Created {item.created}</span>
        </span>
        <ChevronDown className={styles.chevron} size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <AnimatePresence initial={false}>
        {open && <motion.div key="detail" id={detailId} className={styles.detail} role="region" aria-label={`${item.name} details`}
          initial={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
          exit={reduced ? { opacity: 0, transition: instant } : { height: 0, opacity: 0, transition: { height: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.fast } } }}
          transition={reduced ? instant : { height: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.standard, ease: easeEnter, delay: .05 } }}>
          <div className={styles.detailInner}>
            <dl className={styles.facts}>
              <div><dt>Created by</dt><dd><Avatar name={item.owner.name} src={item.owner.photo} size="sm" aria-hidden="true" />{item.owner.name}</dd></div>
              <div><dt>Last request</dt><dd>{item.used === "never" ? "No requests yet" : `${capitalize(item.used)} from ${item.source}`}</dd></div>
              <div><dt>Requests in 30 days</dt><dd className={styles.number}>{count.format(item.requests)}</dd></div>
              <div className={styles.narrowFact}><dt>Created</dt><dd>{item.created}</dd></div>
              <div className={`${styles.narrowFact} ${styles.scopeFact}`}><dt>Scopes</dt><dd className={styles.factChips}>{item.scopes.map(scope => <span key={scope} className={styles.chip}>{scope}</span>)}</dd></div>
            </dl>
            <div className={styles.revokeRow}>
              <p className={styles.revokeNote}>{item.idle ? <><TriangleAlert className={styles.idleIcon} size={16} strokeWidth={1.75} aria-hidden="true" /><span>{item.idle}</span></> : <span>Requests signed with this key fail as soon as it is revoked.</span>}</p>
              <HoldToConfirm label="Hold to revoke" confirmedLabel="Revoked" onConfirm={onRevoke} />
            </div>
          </div>
        </motion.div>}
      </AnimatePresence>
    </div>
  </motion.div>;
}

export function ApiKeys() {
  const id = useId();
  const reduced = useReducedMotion() ?? false;
  const [keys, setKeys] = useState<ApiKey[]>(sampleKeys);
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<"form" | "reveal">("form");
  const [name, setName] = useState("");
  const [env, setEnv] = useState<Env>("test");
  const [picked, setPicked] = useState<Scope[]>(defaultScopes);
  const [errors, setErrors] = useState<{ name?: string; scopes?: string }>({});
  const [generating, setGenerating] = useState(false);
  const [secret, setSecret] = useState("");
  const [freshId, setFreshId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string[]>([]);
  const [status, setStatus] = useState("Open a key to see who created it and where it was last used");
  const { width: shellWidth, height: shellHeight, trackRef, faceRef, innerRef, arm } = useShellSize(open, reduced);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const scopesRef = useRef<HTMLFieldSetElement>(null);
  const revealRef = useRef<HTMLDivElement>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const keysRef = useRef(keys);
  const timers = useRef<number[]>([]);
  const attempt = useRef(0);
  const created = useRef(0);
  const createdName = useRef("");
  const title = open && phase === "reveal" ? "Key created" : "Create key";

  useEffect(() => { keysRef.current = keys; }, [keys]);
  useEffect(() => { const pending = timers.current; return () => pending.forEach(timer => window.clearTimeout(timer)); }, []);
  const later = (run: () => void, ms: number) => { timers.current.push(window.setTimeout(run, ms)); };

  function openPanel() {
    arm();
    setPhase("form"); setName(""); setEnv("test"); setPicked(defaultScopes); setErrors({}); setGenerating(false);
    setOpen(true);
    setStatus("Name the key, pick an environment, and choose its scopes");
    requestAnimationFrame(() => nameRef.current?.focus({ preventScroll: true }));
  }

  function closePanel() {
    if (!open) return;
    attempt.current++;
    arm();
    setOpen(false);
    setGenerating(false);
    if (phase === "reveal") { setFreshId(null); setStatus(`${createdName.current} added. Only its last four characters stay visible.`); }
    else setStatus("New key discarded");
    toggleRef.current?.focus({ preventScroll: true });
  }

  function onShellKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" || !open) return;
    event.stopPropagation();
    closePanel();
  }

  function toggleScope(scope: Scope, on: boolean) {
    setPicked(current => on ? [...current.filter(item => item !== scope), scope] : current.filter(item => item !== scope));
    if (on && errors.scopes) setErrors(current => ({ ...current, scopes: undefined }));
  }

  function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (generating) return;
    const trimmed = name.trim();
    const next = { name: trimmed ? undefined : "Name the key so your team can tell it apart", scopes: picked.length ? undefined : "Choose at least one scope" };
    setErrors(next);
    if (next.name || next.scopes) {
      setStatus(next.name ?? next.scopes ?? "");
      if (next.name) nameRef.current?.focus(); else scopesRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      return;
    }
    const token = ++attempt.current;
    setGenerating(true);
    setStatus(`Generating ${trimmed}.`);
    later(() => {
      if (token !== attempt.current) return;
      created.current += 1;
      const value = secretFor(`${trimmed}:${env}:${created.current}`, env);
      const key: ApiKey = { id: `created-${created.current}`, name: trimmed, env, last4: value.slice(-4), scopes: scopeOptions.map(scope => scope.id).filter(scope => picked.includes(scope)), created: "Sep 22, 2026", used: "never", requests: 0, owner: sofia };
      createdName.current = trimmed;
      arm();
      setSecret(value);
      setKeys(current => [key, ...current]);
      setFreshId(key.id);
      setGenerating(false);
      setPhase("reveal");
      setStatus(`${trimmed} created. Copy the secret now, it will not be shown again.`);
      requestAnimationFrame(() => revealRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }));
    }, 720);
  }

  function toggleRow(item: ApiKey) {
    const next = expanded === item.id ? null : item.id;
    setExpanded(next);
    setStatus(next ? `${item.name} details opened` : `${item.name} details closed`);
  }

  function revoke(item: ApiKey) {
    setRevoking(current => [...current, item.id]);
    setStatus(`${item.name} revoked.`);
    later(() => {
      const list = keysRef.current, index = list.findIndex(key => key.id === item.id);
      const neighbour = list[index + 1] ?? list[index - 1];
      const heldFocus = document.getElementById(`${id}-${item.id}`)?.contains(document.activeElement) ?? false;
      setKeys(current => current.filter(key => key.id !== item.id));
      setRevoking(current => current.filter(key => key !== item.id));
      setExpanded(current => current === item.id ? null : current);
      if (heldFocus) requestAnimationFrame(() => (neighbour ? triggers.current.get(neighbour.id) : toggleRef.current)?.focus({ preventScroll: true }));
    }, 900);
  }

  function restore() {
    setKeys(sampleKeys);
    setStatus("Sample keys restored");
  }

  return (
    <section className={styles.keys} aria-labelledby={`${id}-heading`}>
      <div className={styles.top}>
        <header className={styles.header}>
          <h2 id={`${id}-heading`}>API keys</h2>
          <p>Secret keys sign requests from your servers to the Halden API. Keep them out of browsers and source control.</p>
        </header>

        <div ref={trackRef} className={styles.toolbar} onKeyDown={onShellKey}>
          <p className={styles.count} data-hidden={open} inert={open}>
            <RollingCount value={keys.length} reduced={reduced} /><span className={styles.srOnly}>{keys.length}</span> active {keys.length === 1 ? "key" : "keys"}
          </p>
          <motion.div className={styles.shell} data-open={open} style={{ width: shellWidth, height: shellHeight }}>
            <div ref={innerRef} className={styles.shellInner}>
              <div ref={faceRef} className={styles.face}>
                <button ref={toggleRef} className={styles.toggle} type="button" aria-label={open ? "Close" : "Create key"} aria-expanded={open} aria-controls={open ? `${id}-panel` : undefined} onClick={open ? closePanel : openPanel}>
                  <motion.span className={styles.toggleIcon} initial={false} animate={{ rotate: open ? 45 : 0 }} transition={reduced ? instant : motionTokens.spring.snappy}><Plus size={16} strokeWidth={1.75} aria-hidden="true" /></motion.span>
                </button>
                <span id={`${id}-title`} className={styles.title} role={open ? "heading" : undefined} aria-level={open ? 3 : undefined} aria-hidden={open ? undefined : true}><SwapText text={title} reduced={reduced} /></span>
              </div>

              <AnimatePresence initial={false}>
                {open && <motion.div key="body" id={`${id}-panel`} className={styles.body} role="group" aria-labelledby={`${id}-title`}
                  initial={{ opacity: 0 }} animate={{ opacity: 1, transition: reduced ? instant : { duration: motionTokens.duration.standard + .04, ease: easeEnter, delay: .14 } }} exit={{ opacity: 0, transition: reduced ? instant : { duration: .1, ease: easeStandard } }}>
                  <AnimatePresence mode="popLayout" initial={false}>
                    {phase === "form" ? <motion.form key="form" className={styles.form} noValidate onSubmit={generate} exit={{ opacity: 0, transition: reduced ? instant : { duration: motionTokens.duration.instant } }}>
                      <div className={styles.fields}>
                        <Input ref={nameRef} label="Name" placeholder="Billing sync" autoComplete="off" maxLength={40} value={name} error={errors.name}
                          onChange={event => { setName(event.target.value); if (errors.name) setErrors(current => ({ ...current, name: undefined })); }} />
                        <div className={styles.envField}>
                          <span className={styles.fieldLabel} aria-hidden="true">Environment</span>
                          <SegmentedControl label="Environment" value={env} options={envOptions} onValueChange={value => setEnv(value as Env)} />
                        </div>
                      </div>
                      <fieldset ref={scopesRef} className={styles.scopeSet} aria-describedby={errors.scopes ? `${id}-scope-error` : undefined}>
                        <legend>Scopes</legend>
                        <div className={styles.scopeGrid}>
                          {scopeOptions.map(scope => <Checkbox key={scope.id} label={scope.id} description={scope.description} checked={picked.includes(scope.id)} onCheckedChange={checked => toggleScope(scope.id, checked === true)} />)}
                        </div>
                        <AnimatePresence initial={false}>
                          {errors.scopes && <motion.p key="error" id={`${id}-scope-error`} className={styles.scopeError} role="alert" initial={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={reduced ? { opacity: 0, transition: instant } : { height: 0, opacity: 0 }} transition={reduced ? instant : motionTokens.spring.smooth}><span>{errors.scopes}</span></motion.p>}
                        </AnimatePresence>
                      </fieldset>
                      <div className={styles.actions}>
                        <span className={styles.hint}><SwapText text={env === "live" ? "Live keys act on real payments and customers" : "Test keys only reach test data"} reduced={reduced} /></span>
                        <Button type="button" variant="ghost" onClick={closePanel}>Cancel</Button>
                        <Button type="submit" loading={generating}>Generate key</Button>
                      </div>
                    </motion.form> : <motion.div key="reveal" ref={revealRef} className={styles.reveal} initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={reduced ? instant : { duration: motionTokens.duration.standard + .08, ease: easeEnter, delay: .06 }}>
                      <div className={styles.secretBlock}>
                        <span id={`${id}-secret-label`} className={styles.fieldLabel}>Secret key</span>
                        <div className={styles.secretField} role="group" aria-labelledby={`${id}-secret-label`}>
                          <motion.code className={styles.secret} initial={reduced ? false : { opacity: 0, filter: `blur(${motionTokens.blur.text}px)` }} animate={{ opacity: 1, filter: "blur(0px)" }} transition={{ duration: motionTokens.duration.considered, ease: easeEnter, delay: .14 }}>{secret}</motion.code>
                          <CopyButton value={secret} label="Copy" onCopied={() => setStatus("Secret copied. Paste it into your secrets manager.")} />
                        </div>
                      </div>
                      <p className={styles.once}><TriangleAlert size={16} strokeWidth={1.75} aria-hidden="true" /><span>Copy it now and keep it in your secrets manager. You will not see this key again after you close this panel.</span></p>
                      <div className={styles.actions}>
                        <Button type="button" onClick={closePanel}>Done</Button>
                      </div>
                    </motion.div>}
                  </AnimatePresence>
                </motion.div>}
              </AnimatePresence>
            </div>
          </motion.div>
        </div>
      </div>

      <div className={styles.list} role="list" aria-label="Active keys">
        <AnimatePresence initial={false}>
          {keys.map(item => <KeyRow key={item.id} item={item} rowId={`${id}-${item.id}`} open={expanded === item.id} fresh={freshId === item.id} revoked={revoking.includes(item.id)} reduced={reduced}
            onToggle={() => toggleRow(item)} onRevoke={() => revoke(item)}
            triggerRef={node => { if (node) triggers.current.set(item.id, node); else triggers.current.delete(item.id); }} />)}
        </AnimatePresence>
      </div>
      <AnimatePresence initial={false}>
        {keys.length === 0 && <motion.div key="empty" className={styles.empty} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: reduced ? instant : { duration: motionTokens.duration.standard, delay: .3 } }} exit={{ opacity: 0, transition: instant }}>
          <p>No active keys</p>
          <span>Requests to the Halden API fail until you create one.</span>
          <Button type="button" variant="secondary" size="sm" onClick={restore}>Restore sample keys</Button>
        </motion.div>}
      </AnimatePresence>

      <footer className={styles.srOnly}>
        <p role="status" aria-live="polite">{status}</p>
      </footer>
    </section>
  );
}

export default ApiKeys;
