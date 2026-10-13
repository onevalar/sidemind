"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import { AnimatePresence, LayoutGroup, animate, motion, useMotionValue, useReducedMotion } from "motion/react";
import type { MotionValue, Variants } from "motion/react";
import { Bell, CreditCard, ImageUp, Laptop, Monitor, ShieldCheck, Smartphone, Tablet, TriangleAlert, UserRound } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AnimatedCounter } from "../../animated-counter/animated-counter";
import { Avatar } from "../../avatar/avatar";
import { Button } from "../../button/button";
import { Input } from "../../input/input";
import SegmentedControl from "../../segmented-control/segmented-control";
import { Select } from "../../select/select";
import { Switch } from "../../switch/switch";
import { TextMorph } from "../../text-morph/text-morph";
import { motionTokens } from "../../lib/motion-tokens";
import styles from "./settings-page.module.css";

type SectionId = "profile" | "notifications" | "security" | "billing";
type Settings = {
  photo: string | null; name: string; title: string; email: string; timezone: string;
  mentions: boolean; summary: boolean; news: boolean; messages: boolean; reminders: boolean; quiet: boolean; quietHours: string;
  twoStep: boolean; alerts: boolean; timeout: string; signedOut: string[];
  cycle: string; billingEmail: string; company: string; country: string; vat: string;
};
type Key = keyof Settings;
type Shift = { direction: number; axis: "x" | "y"; reduce: boolean };

const sections: { id: SectionId; label: string; description: string; icon: LucideIcon }[] = [
  { id: "profile", label: "Profile", description: "How you appear to teammates across Northwind.", icon: UserRound },
  { id: "notifications", label: "Notifications", description: "Choose what reaches you, and when.", icon: Bell },
  { id: "security", label: "Security", description: "Protect your account and review where you are signed in.", icon: ShieldCheck },
  { id: "billing", label: "Billing", description: "Your plan, payment method, and invoice details.", icon: CreditCard },
];

const saved: Settings = {
  photo: "/media/people/emma-collins.jpg", name: "Emma Collins", title: "Product designer", email: "emma@northwind.studio", timezone: "lisbon",
  mentions: true, summary: true, news: false, messages: true, reminders: false, quiet: false, quietHours: "22-7",
  twoStep: true, alerts: true, timeout: "8h", signedOut: [],
  cycle: "monthly", billingEmail: "billing@northwind.studio", company: "Northwind Studio Lda.", country: "pt", vat: "PT 516 283 947",
};

const sectionOf: Record<Key, SectionId> = {
  photo: "profile", name: "profile", title: "profile", email: "profile", timezone: "profile",
  mentions: "notifications", summary: "notifications", news: "notifications", messages: "notifications", reminders: "notifications", quiet: "notifications", quietHours: "notifications",
  twoStep: "security", alerts: "security", timeout: "security", signedOut: "security",
  cycle: "billing", billingEmail: "billing", company: "billing", country: "billing", vat: "billing",
};

const timezones = [{ value: "lisbon", label: "Lisbon (GMT+1)" }, { value: "london", label: "London (GMT+1)" }, { value: "berlin", label: "Berlin (GMT+2)" }, { value: "new-york", label: "New York (GMT−4)" }, { value: "san-francisco", label: "San Francisco (GMT−7)" }, { value: "tokyo", label: "Tokyo (GMT+9)" }];
const quietOptions = [{ value: "21-8", label: "9 PM to 8 AM" }, { value: "22-7", label: "10 PM to 7 AM" }, { value: "23-6", label: "11 PM to 6 AM" }, { value: "0-8", label: "Midnight to 8 AM" }];
const timeouts = [{ value: "1h", label: "After 1 hour" }, { value: "8h", label: "After 8 hours" }, { value: "24h", label: "After 24 hours" }, { value: "7d", label: "After 7 days" }];
const countries = [{ value: "pt", label: "Portugal" }, { value: "de", label: "Germany" }, { value: "nl", label: "Netherlands" }, { value: "gb", label: "United Kingdom" }, { value: "us", label: "United States" }];
const cycles = [{ value: "monthly", label: "Monthly" }, { value: "yearly", label: "Yearly" }];
const sessions: { id: string; device: string; app: string; place: string; seen: string; icon: LucideIcon; current?: boolean }[] = [
  { id: "mac", device: "MacBook Pro", app: "Safari", place: "Lisbon, Portugal", seen: "Active now", icon: Laptop, current: true },
  { id: "iphone", device: "iPhone 16", app: "Northwind for iOS", place: "Lisbon, Portugal", seen: "2 hours ago", icon: Smartphone },
  { id: "ipad", device: "iPad Air", app: "Safari", place: "Porto, Portugal", seen: "Yesterday", icon: Tablet },
  { id: "windows", device: "Windows PC", app: "Chrome", place: "Berlin, Germany", seen: "12 days ago", icon: Monitor },
];

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function validate(values: Settings) {
  const errors: Partial<Record<Key, string>> = {};
  if (!values.name.trim()) errors.name = "Enter your full name";
  if (!emailPattern.test(values.email.trim())) errors.email = "Enter a valid email address";
  if (!emailPattern.test(values.billingEmail.trim())) errors.billingEmail = "Enter a valid billing email";
  return errors;
}

const blur = (px: number) => `blur(${px}px)`;
const enterEase = [...motionTokens.ease.enter] as [number, number, number, number];
const standardEase = [...motionTokens.ease.standard] as [number, number, number, number];

/** Sections cross over along the nav's own axis: a later section arrives from below (or the right on phones), an earlier one from above. */
const pane: Variants = {
  enter: ({ direction, axis, reduce }: Shift) => reduce ? { opacity: 0 } : { opacity: 0, ...(axis === "x" ? { x: direction * 16 } : { y: direction * 14 }), filter: blur(motionTokens.blur.subtle) },
  center: ({ reduce }: Shift) => ({ opacity: 1, x: 0, y: 0, filter: blur(0), transition: reduce ? { duration: motionTokens.duration.instant } : { x: motionTokens.spring.smooth, y: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.standard, ease: enterEase }, filter: { duration: motionTokens.duration.standard, ease: enterEase } } }),
  exit: ({ direction, axis, reduce }: Shift) => reduce ? { opacity: 0, transition: { duration: motionTokens.duration.instant } } : { opacity: 0, ...(axis === "x" ? { x: direction * -10 } : { y: direction * -8 }), filter: blur(motionTokens.blur.subtle), transition: { duration: motionTokens.duration.fast, ease: standardEase } },
};
const rise = { initial: { opacity: 0, y: 6, filter: blur(motionTokens.blur.soft) }, animate: { opacity: 1, y: 0, filter: blur(0) }, exit: { opacity: 0, y: -4, filter: blur(motionTokens.blur.subtle) } };

/** Opens its height on a spring so rows below glide down instead of jumping. */
function Reveal({ show, className, children }: { show: boolean; className?: string; children: ReactNode }) {
  const reduce = useReducedMotion();
  return <AnimatePresence initial={false}>{show && <motion.div className={styles.reveal} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={reduce ? { duration: 0 } : { height: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.standard } }}><div className={className}>{children}</div></motion.div>}</AnimatePresence>;
}

function Group({ id, title, children, footer }: { id: string; title: string; children: ReactNode; footer?: ReactNode }) {
  return <section className={styles.group} aria-labelledby={id}><h4 id={id}>{title}</h4><div className={styles.rows}>{children}</div>{footer}</section>;
}

function ToggleRow({ id, label, description, checked, onChange, children }: { id: string; label: string; description: string; checked: boolean; onChange: (value: boolean) => void; children?: ReactNode }) {
  return <div className={styles.row}>
    <div className={styles.rowText}><label htmlFor={id}>{label}</label><p id={`${id}-hint`}>{description}</p>{children}</div>
    <Switch id={id} checked={checked} onCheckedChange={onChange} aria-describedby={`${id}-hint`} />
  </div>;
}

/** The bar grows out of a small puck, then its width and height follow whatever it holds, so saving shrinks it into a confirmation. */
function SaveBar({ state, count, onDiscard, onSave, shake, barRef }: { state: "edit" | "saving" | "saved"; count: number; onDiscard: () => void; onSave: () => void; shake: MotionValue<number>; barRef: RefObject<HTMLDivElement | null> }) {
  const reduce = useReducedMotion();
  const content = useRef<HTMLDivElement>(null);
  const width = useMotionValue(52);
  const height = useMotionValue(52);
  useLayoutEffect(() => {
    const node = content.current;
    if (!node) return;
    const measure = () => {
      const next = { width: node.offsetWidth + 2, height: node.offsetHeight + 2 };
      if (reduce) { width.jump(next.width); height.jump(next.height); return; }
      animate(width, next.width, motionTokens.spring.morph);
      animate(height, next.height, motionTokens.spring.morph);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [height, reduce, width]);
  const phase = reduce ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } } : { initial: { opacity: 0, scale: .96, filter: blur(motionTokens.blur.soft) }, animate: { opacity: 1, scale: 1, filter: blur(0) }, exit: { opacity: 0, scale: .96, filter: blur(motionTokens.blur.soft) } };
  const phaseTransition = { duration: reduce ? motionTokens.duration.instant : motionTokens.duration.standard, ease: enterEase };
  return <motion.div ref={barRef} className={styles.bar} role="group" aria-label={state === "saved" ? "Save status" : "Unsaved changes"} style={{ width, height, x: shake }}
    initial={reduce ? { opacity: 0 } : { opacity: 0, y: 28, filter: blur(motionTokens.blur.soft) }} animate={{ opacity: 1, y: 0, filter: blur(0) }}
    exit={reduce ? { opacity: 0, transition: { duration: motionTokens.duration.instant } } : { opacity: 0, y: 20, width: 52, height: 52, filter: blur(motionTokens.blur.soft), transition: { width: motionTokens.spring.smooth, height: motionTokens.spring.smooth, y: { ...motionTokens.spring.smooth, delay: .06 }, opacity: { duration: motionTokens.duration.exit, delay: .1 }, filter: { duration: motionTokens.duration.exit, delay: .1 } } }}
    transition={reduce ? { duration: motionTokens.duration.instant } : { y: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.fast }, filter: { duration: motionTokens.duration.standard } }}>
    <div ref={content} className={styles.barContent}>
      <AnimatePresence mode="popLayout" initial={false}>
        {state === "saved"
          ? <motion.div key="saved" className={styles.barSaved} {...phase} transition={phaseTransition}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><motion.path d="M5 12.5 9.5 17 19 7.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: reduce ? 1 : 0 }} animate={{ pathLength: 1 }} transition={{ duration: reduce ? 0 : .34, delay: reduce ? 0 : .08, ease: enterEase }} /></svg>
            <span>Changes saved</span>
          </motion.div>
          : <motion.div key="edit" className={styles.barEdit} {...phase} transition={phaseTransition}>
            <span className={styles.barCount}><span className={styles.inherit}><AnimatedCounter value={count} /></span><span className={styles.unsaved}>&nbsp;unsaved</span>&nbsp;<TextMorph>{count === 1 ? "change" : "changes"}</TextMorph></span>
            <Button type="button" variant="ghost" size="sm" disabled={state === "saving"} onClick={onDiscard}>Discard</Button>
            <Button type="button" size="sm" loading={state === "saving"} onClick={onSave}>{state === "saving" ? "Saving" : <span>Save<span className={styles.long}>&nbsp;changes</span></span>}</Button>
          </motion.div>}
      </AnimatePresence>
    </div>
  </motion.div>;
}

export function SettingsPage() {
  const id = useId();
  const navGroup = useId();
  const reduce = useReducedMotion();
  const [section, setSection] = useState<SectionId>("profile");
  const [shift, setShift] = useState<Omit<Shift, "reduce">>({ direction: 1, axis: "y" });
  const [baseline, setBaseline] = useState(saved);
  const [draft, setDraft] = useState(saved);
  const [phase, setPhase] = useState<"idle" | "saving" | "saved">("idle");
  const [touched, setTouched] = useState<Key[]>([]);
  const [revert, setRevert] = useState<{ tick: number; keys: Key[] }>({ tick: 0, keys: [] });
  const [photoError, setPhotoError] = useState("");
  const [status, setStatus] = useState("");
  const navList = useRef<HTMLUListElement>(null);
  const navButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const timers = useRef(new Set<number>());
  const photoUrls = useRef(new Set<string>());
  const shake = useMotionValue(0);

  const changed = (Object.keys(baseline) as Key[]).filter(key => key !== "signedOut" && baseline[key] !== draft[key]);
  const sessionChanges = draft.signedOut.filter(item => !baseline.signedOut.includes(item)).length + baseline.signedOut.filter(item => !draft.signedOut.includes(item)).length;
  const count = changed.length + sessionChanges;
  const changesIn = (target: SectionId) => changed.filter(key => sectionOf[key] === target).length + (target === "security" ? sessionChanges : 0);
  const errors = validate(draft);
  const barState = phase === "saving" ? "saving" : count ? "edit" : phase === "saved" ? "saved" : null;
  const current = sections.find(item => item.id === section) ?? sections[0];
  const visibleSessions = sessions.filter(item => !draft.signedOut.includes(item.id));
  const total = draft.cycle === "yearly" ? 1440 : 144;
  const custom: Shift = { ...shift, reduce: !!reduce };

  useEffect(() => {
    const pending = timers.current, urls = photoUrls.current;
    return () => { pending.forEach(timer => window.clearTimeout(timer)); urls.forEach(url => URL.revokeObjectURL(url)); };
  }, []);

  // When the bar's buttons leave (saved or discarded), keep keyboard focus in the page instead of dropping it to the document.
  useEffect(() => {
    if (barState === "edit" || barState === "saving") return;
    if (bar.current?.contains(document.activeElement)) heading.current?.focus({ preventScroll: true });
  }, [barState]);

  function later(run: () => void, ms: number) {
    const timer = window.setTimeout(() => { timers.current.delete(timer); run(); }, ms);
    timers.current.add(timer);
  }
  function update<K extends Key>(key: K, value: Settings[K]) { setDraft(values => ({ ...values, [key]: value })); }
  const touch = (key: Key) => setTouched(keys => keys.includes(key) ? keys : [...keys, key]);
  const errorFor = (key: Key) => touched.includes(key) ? errors[key] : undefined;
  const revertClass = (key: Key) => revert.keys.includes(key) ? (revert.tick % 2 ? styles.revertA : styles.revertB) : undefined;
  const focusById = (target: string) => requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById(target)?.focus()));

  function go(next: SectionId, focusTarget?: string) {
    if (next === section) { if (focusTarget) focusById(focusTarget); return; }
    const from = sections.findIndex(item => item.id === section), to = sections.findIndex(item => item.id === next);
    const list = navList.current;
    const horizontal = !!list && getComputedStyle(list).flexDirection === "row";
    setShift({ direction: to > from ? 1 : -1, axis: horizontal ? "x" : "y" });
    setSection(next);
    setRevert(value => value.keys.length ? { ...value, keys: [] } : value);
    pendingFocus.current = focusTarget ?? null;
    if (horizontal) navButtons.current[to]?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduce ? "auto" : "smooth" });
  }

  function settle() {
    scroller.current?.scrollTo({ top: 0 });
    if (pendingFocus.current) { focusById(pendingFocus.current); pendingFocus.current = null; }
  }

  function onNavKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const steps: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
    const next = event.key in steps ? (index + steps[event.key] + sections.length) % sections.length : event.key === "Home" ? 0 : event.key === "End" ? sections.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    navButtons.current[next]?.focus();
    go(sections[next].id);
  }

  function save() {
    if (!count || phase === "saving") return;
    const invalid = Object.keys(errors) as Key[];
    if (invalid.length) {
      setTouched(keys => [...new Set([...keys, ...invalid])]);
      setStatus(`${errors[invalid[0]]} before saving`);
      if (!reduce) animate(shake, [0, -7, 6, -4, 2, 0], { duration: .42, ease: "easeOut" });
      go(sectionOf[invalid[0]], `${id}-${invalid[0]}`);
      return;
    }
    const snapshot = draft, saving = count;
    setPhase("saving");
    setStatus("Saving changes");
    later(() => {
      setBaseline(snapshot);
      setPhase("saved");
      setTouched([]);
      setStatus(`${saving} ${saving === 1 ? "change" : "changes"} saved.`);
      later(() => setPhase(value => value === "saved" ? "idle" : value), 1800);
    }, 900);
  }

  function discard() {
    if (phase === "saving") return;
    setRevert(value => ({ tick: value.tick + 1, keys: changed }));
    setDraft(baseline);
    setTouched([]);
    setPhotoError("");
    setStatus(`${count} ${count === 1 ? "change" : "changes"} discarded`);
  }

  function choosePhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { setPhotoError("Choose a JPG, PNG, or WebP image"); return; }
    if (file.size > 5 * 1024 * 1024) { setPhotoError("Choose an image under 5 MB"); return; }
    const url = URL.createObjectURL(file);
    photoUrls.current.add(url);
    setPhotoError("");
    update("photo", url);
    setStatus("New photo ready to save");
  }

  function removePhoto() {
    update("photo", null);
    setPhotoError("");
    setStatus("Photo removed. Your initials will show instead.");
    focusById(`${id}-change-photo`);
  }

  function signOut(session: (typeof sessions)[number]) {
    const others = visibleSessions.filter(item => !item.current);
    const index = others.findIndex(item => item.id === session.id);
    const next = others[index + 1] ?? others[index - 1];
    update("signedOut", [...draft.signedOut, session.id]);
    setStatus(`${session.device} will be signed out when you save`);
    focusById(next ? `${id}-signout-${next.id}` : `${id}-devices`);
  }

  return (
    <section className={styles.root} aria-labelledby={`${id}-title`} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); save(); } }}>
      <div className={styles.settings}>
        <aside className={styles.sidebar}>
          <div className={styles.sidebarHead}>
            <h2 id={`${id}-title`}>Settings</h2>
            <span className={styles.headAvatar}><Avatar name={baseline.name} src={baseline.photo ?? undefined} size="sm" /></span>
          </div>
          <LayoutGroup id={navGroup}>
            <nav aria-label="Settings sections">
              <motion.ul ref={navList} className={styles.navList} layoutScroll>
                {sections.map((item, index) => {
                  const Icon = item.icon, pending = changesIn(item.id);
                  return <li key={item.id}>
                    <button ref={node => { navButtons.current[index] = node; }} type="button" className={styles.navItem} aria-current={section === item.id ? "page" : undefined} onClick={() => go(item.id)} onKeyDown={event => onNavKey(event, index)}>
                      {section === item.id && <motion.span layoutId="settings-section" layoutDependency={section} className={styles.highlight} transition={reduce ? { duration: 0 } : motionTokens.spring.morph} aria-hidden="true" />}
                      <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
                      <span className={styles.navLabel}>{item.label}</span>
                      <AnimatePresence initial={false}>{pending > 0 && <motion.span key="dot" className={styles.navDot} aria-hidden="true" initial={{ opacity: 0, scale: .2 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .2 }} transition={reduce ? { duration: 0 } : motionTokens.spring.snappy} />}</AnimatePresence>
                      {pending > 0 && <span className={styles.srOnly}>, {pending} unsaved</span>}
                    </button>
                  </li>;
                })}
              </motion.ul>
            </nav>
          </LayoutGroup>
          <div className={styles.account}>
            <Avatar name={baseline.name} src={baseline.photo ?? undefined} size="md" />
            <span><strong>{baseline.name}</strong><small>Team plan · Admin</small></span>
          </div>
        </aside>

        <div className={styles.main}>
          <div ref={scroller} className={styles.scroller} role="region" aria-labelledby={`${id}-heading`}>
            <AnimatePresence mode="wait" initial={false} custom={custom} onExitComplete={settle}>
              <motion.div key={section} className={styles.pane} custom={custom} variants={pane} initial="enter" animate="center" exit="exit">
                <header className={styles.paneHead}>
                  <h3 id={`${id}-heading`} ref={heading} tabIndex={-1}>{current.label}</h3>
                  <p>{current.description}</p>
                </header>

                {section === "profile" && <>
                  <div className={styles.identity}>
                    <div className={styles.photo}>
                      <AnimatePresence initial={false} mode="popLayout">
                        <motion.span key={draft.photo ?? "initials"} className={styles.photoFrame} initial={{ opacity: 0, scale: .9, filter: blur(motionTokens.blur.soft) }} animate={{ opacity: 1, scale: 1, filter: blur(0) }} exit={{ opacity: 0, scale: 1.04, filter: blur(motionTokens.blur.soft) }} transition={reduce ? { duration: 0 } : { scale: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.standard }, filter: { duration: motionTokens.duration.standard } }}>
                          <Avatar name={draft.name.trim() || baseline.name} src={draft.photo ?? undefined} size="xl" />
                        </motion.span>
                      </AnimatePresence>
                    </div>
                    <div className={styles.identityText}>
                      <strong>{draft.name.trim() || "Your name"}</strong>
                      <span>{draft.title.trim() || "No job title"} · Northwind Studio</span>
                      <div className={styles.photoActions}>
                        <Button id={`${id}-change-photo`} type="button" variant="secondary" size="sm" onClick={() => fileInput.current?.click()}><ImageUp size={15} strokeWidth={1.8} aria-hidden="true" />Change photo</Button>
                        {draft.photo && <Button type="button" variant="ghost" size="sm" onClick={removePhoto}>Remove</Button>}
                      </div>
                      <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={choosePhoto} />
                      <Reveal show={!!photoError} className={styles.photoError}><span role="alert">{photoError}</span></Reveal>
                    </div>
                  </div>
                  <div className={styles.fields}>
                    <Input id={`${id}-name`} label="Full name" value={draft.name} autoComplete="name" className={revertClass("name")} error={errorFor("name")} onBlur={() => touch("name")} onChange={event => update("name", event.target.value)} />
                    <Input id={`${id}-title-field`} label="Job title" value={draft.title} autoComplete="organization-title" className={revertClass("title")} onChange={event => update("title", event.target.value)} />
                    <Input id={`${id}-email`} label="Email" type="email" value={draft.email} autoComplete="email" spellCheck={false} description="Used for sign-in and notifications." className={revertClass("email")} error={errorFor("email")} onBlur={() => touch("email")} onChange={event => update("email", event.target.value)} />
                    <Select label="Time zone" value={draft.timezone} options={timezones} onValueChange={value => update("timezone", value)} />
                  </div>
                </>}

                {section === "notifications" && <>
                  <Group id={`${id}-email-group`} title="Email">
                    <ToggleRow id={`${id}-mentions`} label="Comments and mentions" description="Replies to your comments and anyone who mentions you." checked={draft.mentions} onChange={value => update("mentions", value)} />
                    <ToggleRow id={`${id}-summary`} label="Weekly summary" description="A Monday recap of what moved in your projects." checked={draft.summary} onChange={value => update("summary", value)} />
                    <ToggleRow id={`${id}-news`} label="Product news" description="New features and changes, about once a month." checked={draft.news} onChange={value => update("news", value)} />
                  </Group>
                  <Group id={`${id}-device-group`} title="On your devices">
                    <ToggleRow id={`${id}-messages`} label="Direct messages" description="Messages sent to you or to a group you are in." checked={draft.messages} onChange={value => update("messages", value)} />
                    <ToggleRow id={`${id}-reminders`} label="Reminders" description="Due dates and meetings, 15 minutes ahead." checked={draft.reminders} onChange={value => update("reminders", value)} />
                  </Group>
                  <Group id={`${id}-quiet-group`} title="Quiet hours" footer={<Reveal show={draft.quiet} className={styles.revealField}><Select label="Pause between" value={draft.quietHours} options={quietOptions} onValueChange={value => update("quietHours", value)} /></Reveal>}>
                    <ToggleRow id={`${id}-quiet`} label="Pause overnight" description="Hold notifications and deliver them together in the morning." checked={draft.quiet} onChange={value => update("quiet", value)} />
                  </Group>
                </>}

                {section === "security" && <>
                  <Group id={`${id}-signin-group`} title="Sign-in">
                    <ToggleRow id={`${id}-two-step`} label="Two-step verification" description="Ask for a code from your authenticator app on new devices." checked={draft.twoStep} onChange={value => update("twoStep", value)}>
                      <Reveal show={!draft.twoStep} className={styles.warning}><TriangleAlert size={14} strokeWidth={1.9} aria-hidden="true" />Anyone with your password could sign in.</Reveal>
                    </ToggleRow>
                    <ToggleRow id={`${id}-alerts`} label="Sign-in alerts" description="Email you when a new device signs in." checked={draft.alerts} onChange={value => update("alerts", value)} />
                  </Group>
                  <div className={styles.inlineField}><Select label="Sign out idle sessions" value={draft.timeout} options={timeouts} description="Applies to every device except this one." onValueChange={value => update("timeout", value)} /></div>
                  <section className={styles.group} aria-labelledby={`${id}-devices`}>
                    <h4 id={`${id}-devices`} tabIndex={-1}>Where you are signed in</h4>
                    <ul className={styles.sessions}>
                      <AnimatePresence initial={false}>
                        {visibleSessions.map(item => {
                          const Icon = item.icon;
                          return <motion.li key={item.id} className={styles.session} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={reduce ? { duration: 0 } : { height: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.fast } }}>
                            <div className={styles.sessionInner}>
                              <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
                              <span className={styles.sessionText}><strong>{item.device} · {item.app}</strong><span>{item.place} · {item.seen}</span></span>
                              {item.current ? <span className={styles.thisDevice}>This device</span> : <Button id={`${id}-signout-${item.id}`} type="button" variant="ghost" size="sm" aria-label={`Sign out ${item.device}`} onClick={() => signOut(item)}>Sign out</Button>}
                            </div>
                          </motion.li>;
                        })}
                      </AnimatePresence>
                    </ul>
                  </section>
                </>}

                {section === "billing" && <>
                  <div className={styles.plan}>
                    <div className={styles.planText}>
                      <strong>Team plan</strong>
                      <span>8 seats at&nbsp;<span className={styles.inherit}><AnimatedCounter value={draft.cycle === "yearly" ? 15 : 18} prefix="$" /></span>&nbsp;each</span>
                    </div>
                    <div className={styles.price}>
                      <span className={styles.priceValue}><AnimatedCounter value={total} prefix="$" /></span>
                      <TextMorph className={styles.priceUnit}>{draft.cycle === "yearly" ? "per year" : "per month"}</TextMorph>
                    </div>
                  </div>
                  <div className={styles.cycle}>
                    <SegmentedControl label="Billing cycle" value={draft.cycle} options={cycles} onValueChange={value => update("cycle", value)} />
                    <span className={styles.cycleNote}>
                      <AnimatePresence mode="popLayout" initial={false}>
                        <motion.span key={draft.cycle} {...rise} transition={{ duration: reduce ? 0 : motionTokens.duration.standard, ease: enterEase }}>{draft.cycle === "yearly" ? "You save $288 a year" : "Save $288 a year with yearly billing"}</motion.span>
                      </AnimatePresence>
                    </span>
                  </div>
                  <div className={styles.payment}>
                    <CreditCard size={16} strokeWidth={1.75} aria-hidden="true" />
                    <span><strong>Visa ending in 4242</strong><span>Expires 08/2028 · next invoice on October 1</span></span>
                  </div>
                  <div className={styles.fields}>
                    <Input id={`${id}-billingEmail`} label="Billing email" type="email" value={draft.billingEmail} autoComplete="email" spellCheck={false} description="Invoices and receipts are sent here." className={revertClass("billingEmail")} error={errorFor("billingEmail")} onBlur={() => touch("billingEmail")} onChange={event => update("billingEmail", event.target.value)} />
                    <Input id={`${id}-company`} label="Company name" value={draft.company} autoComplete="organization" className={revertClass("company")} onChange={event => update("company", event.target.value)} />
                    <Select label="Country" value={draft.country} options={countries} onValueChange={value => update("country", value)} />
                    <Input id={`${id}-vat`} label="VAT number" value={draft.vat} spellCheck={false} className={revertClass("vat")} onChange={event => update("vat", event.target.value)} />
                  </div>
                </>}
              </motion.div>
            </AnimatePresence>
          </div>

          <div className={styles.dock}>
            <AnimatePresence>
              {barState && <SaveBar key="bar" barRef={bar} state={barState} count={count} shake={shake} onDiscard={discard} onSave={save} />}
            </AnimatePresence>
          </div>
          <p className={styles.srOnly} role="status" aria-live="polite">{status}</p>
        </div>
      </div>
    </section>
  );
}

export default SettingsPage;
