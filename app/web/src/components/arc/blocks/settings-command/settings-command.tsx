"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import { AnimatePresence, LayoutGroup, animate, motion, useMotionValue, useReducedMotion } from "motion/react";
import type { MotionValue } from "motion/react";
import { Bell, CornerDownLeft, CreditCard, Palette as PaletteIcon, Search, ShieldCheck, SlidersHorizontal, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AnimatedCounter } from "../../animated-counter/animated-counter";
import { Button } from "../../button/button";
import SegmentedControl from "../../segmented-control/segmented-control";
import { Select } from "../../select/select";
import { Switch } from "../../switch/switch";
import { TextMorph } from "../../text-morph/text-morph";
import { motionTokens } from "../../lib/motion-tokens";
import { savedSettings, settingDefinitions, settingsSections, suggestedSettingIds } from "./settings-command-data";
import type { SettingDefinition, SettingValue, SettingValues, SettingsSection, SettingsSectionId } from "./settings-command-data";
import styles from "./settings-command.module.css";

export type { SettingDefinition, SettingValue, SettingValues, SettingsSection, SettingsSectionId } from "./settings-command-data";

export interface SettingsCommandProps {
  /** Sections in page order. Each setting names its section by id. */
  sections?: SettingsSection[];
  /** Every setting that can be edited and found through search. */
  settings?: SettingDefinition[];
  /** Saved values, keyed by setting id. Edits are compared against these to count unsaved changes. */
  defaultValues?: SettingValues;
  /** Setting ids listed in the search before anything is typed. */
  suggested?: string[];
  /** Persists the draft. Resolve to confirm, reject to keep the bar open with an error. Without it the save is simulated. */
  onSave?: (values: SettingValues, changedIds: string[]) => Promise<void> | void;
  /** Called on every edit with the full draft. */
  onValuesChange?: (values: SettingValues) => void;
  /** Heading shown above the section nav. */
  title?: string;
  className?: string;
}

type Rect = { x: number; y: number; width: number; height: number };
type Result = { def: SettingDefinition; score: number; match: [number, number] | null };
type Closing = { to: Rect; mode: "trigger" | "row" } | null;

const icons: Record<SettingsSectionId, LucideIcon> = { general: SlidersHorizontal, appearance: PaletteIcon, notifications: Bell, security: ShieldCheck, members: Users, billing: CreditCard };
const enterEase = [...motionTokens.ease.enter] as [number, number, number, number];
const calm = { type: "spring", visualDuration: .46, bounce: .1 } as const;
const blur = (px: number) => `blur(${px}px)`;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validate(def: SettingDefinition, value: SettingValue): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (def.id === "workspace-name" && !text) return "Enter a workspace name";
  if (def.id === "workspace-url" && !/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/.test(text)) return "Use 3 to 32 lowercase letters, numbers, or dashes";
  if (def.id === "billing-email" && !emailPattern.test(text)) return "Enter a valid email address";
  if (def.id === "domains" && text && !text.split(/[\s,]+/).filter(Boolean).every(part => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(part))) return "Separate domains with commas, like northwind.studio";
  return undefined;
}

/** Every typed word has to land somewhere; label hits outrank description and keyword hits. */
function search(defs: SettingDefinition[], sections: SettingsSection[], query: string): Result[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/);
  const sectionName = new Map(sections.map(item => [item.id, item.label.toLowerCase()]));
  return defs.flatMap(def => {
    const label = def.label.toLowerCase();
    const haystack = [label, def.description.toLowerCase(), sectionName.get(def.section) ?? "", ...(def.keywords ?? [])].join(" ");
    if (!words.every(word => haystack.includes(word))) return [];
    let score = 0;
    if (label.startsWith(q)) score += 8;
    else if (label.includes(q)) score += 5;
    for (const word of words) {
      if (label.split(/\s+/).some(part => part.startsWith(word))) score += 3;
      else if (def.keywords?.some(keyword => keyword.startsWith(word))) score += 2;
      else score += .5;
    }
    const at = label.indexOf(q), first = label.indexOf(words[0]);
    const match: [number, number] | null = at >= 0 ? [at, at + q.length] : first >= 0 ? [first, first + words[0].length] : null;
    return [{ def, score, match }];
  }).sort((a, b) => b.score - a.score).slice(0, 8);
}

function Highlight({ text, match }: { text: string; match: [number, number] | null }) {
  if (!match) return <>{text}</>;
  return <>{text.slice(0, match[0])}<mark className={styles.mark}>{text.slice(match[0], match[1])}</mark>{text.slice(match[1])}</>;
}

function relativeRect(node: Element, frame: Element): Rect {
  const a = node.getBoundingClientRect(), b = frame.getBoundingClientRect();
  return { x: a.left - b.left, y: a.top - b.top, width: a.width, height: a.height };
}

/** The search field itself grows into the palette: position, size, and corners ride one spring, and the results are revealed by the growing edge rather than reflowing. */
function CommandPalette({ uid, origin, frameWidth, closing, onClosed, query, onQuery, results, suggestions, active, onActive, onPick, onClose, reduce }: {
  uid: string; origin: Rect; frameWidth: number; closing: Closing; onClosed: () => void;
  query: string; onQuery: (value: string) => void; results: Result[]; suggestions: Result[]; active: number; onActive: (index: number) => void;
  onPick: (result: Result) => void; onClose: () => void; reduce: boolean;
}) {
  const width = Math.min(560, frameWidth - 24);
  const target = { x: (frameWidth - width) / 2, y: 12, width };
  const x = useMotionValue(reduce ? target.x : origin.x), y = useMotionValue(reduce ? target.y : origin.y);
  const w = useMotionValue(reduce ? target.width : origin.width), h = useMotionValue(origin.height);
  const radius = useMotionValue(reduce ? 14 : 10);
  const shell = useMotionValue(reduce ? 0 : 1), body = useMotionValue(0);
  const content = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const shown = query.trim() ? results : suggestions;

  useLayoutEffect(() => {
    if (closing) return;
    const node = content.current;
    if (!node) return;
    const fit = (first: boolean) => {
      const height = node.offsetHeight;
      if (reduce) { x.jump(target.x); y.jump(target.y); w.jump(target.width); h.jump(height); radius.jump(14); return; }
      animate(x, target.x, calm); animate(y, target.y, calm); animate(w, target.width, calm);
      animate(h, height, first ? calm : motionTokens.spring.smooth); animate(radius, 14, calm);
    };
    fit(true);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fit(false));
    observer.observe(node);
    return () => observer.disconnect();
    // Retarget when the frame resizes or the palette reopens mid-close; the motion values carry the current velocity.
  }, [closing, reduce, target.x, target.y, target.width, x, y, w, h, radius]);

  useEffect(() => {
    if (closing) return;
    animate(shell, 1, { duration: reduce ? motionTokens.duration.fast : 0 });
    animate(body, 1, { duration: reduce ? motionTokens.duration.fast : motionTokens.duration.standard, delay: reduce ? 0 : .06, ease: enterEase });
  }, [body, closing, reduce, shell]);

  useEffect(() => {
    if (!closing) return;
    if (reduce) { const run = animate(shell, 0, { duration: motionTokens.duration.fast }); run.then(onClosed); return () => run.stop(); }
    const { to, mode } = closing;
    animate(body, 0, { duration: motionTokens.duration.instant });
    const spring = mode === "row" ? calm : motionTokens.spring.smooth;
    animate(x, to.x, spring); animate(y, to.y, spring); animate(w, to.width, spring); animate(h, to.height, spring);
    animate(radius, 10, spring);
    const fade = animate(shell, 0, mode === "row" ? { duration: .22, delay: .2 } : { duration: .1, delay: .24 });
    fade.then(onClosed);
    return () => fade.stop();
  }, [body, closing, h, onClosed, reduce, shell, w, x, y, radius]);

  useEffect(() => { input.current?.focus({ preventScroll: true }); }, []);
  // Scroll only the list; scrollIntoView would also scroll the clipped shell and hide the field.
  useEffect(() => {
    const node = list.current, item = node?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!node || !item) return;
    if (item.offsetTop < node.scrollTop) node.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > node.scrollTop + node.clientHeight) node.scrollTop = item.offsetTop + item.offsetHeight - node.clientHeight;
  }, [active]);

  function onKey(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!shown.length) return;
      onActive((active + (event.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (shown[active]) onPick(shown[active]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "Tab") {
      event.preventDefault();
    }
  }

  const listId = `${uid}-results`;
  return <motion.div className={styles.palette} role="dialog" aria-modal="true" aria-label="Search settings" style={{ x, y, width: w, height: h, borderRadius: radius, opacity: shell }}>
    <div ref={content} className={styles.paletteContent} style={{ width: target.width }}>
      <div className={styles.paletteField}>
        <Search size={16} aria-hidden="true" />
        <input ref={input} value={query} onChange={event => { onQuery(event.target.value); onActive(0); }} onKeyDown={onKey}
          placeholder="Search settings" role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={shown[active] ? `${uid}-option-${shown[active].def.id}` : undefined} spellCheck={false} autoComplete="off" />
        <kbd className={styles.kbd}>Esc</kbd>
      </div>
      <motion.div className={styles.paletteBody} style={{ opacity: body }}>
        {!query.trim() && <p className={styles.paletteHint}>Suggested</p>}
        {shown.length
          ? <LayoutGroup id={`${uid}-palette`}><ul ref={list} id={listId} role="listbox" aria-label="Matching settings" className={styles.results}>
            {shown.map((result, index) => {
              const Icon = icons[result.def.section];
              const selected = index === active;
              return <li key={result.def.id} id={`${uid}-option-${result.def.id}`} data-index={index} role="option" aria-selected={selected}
                className={styles.result} onPointerMove={() => { if (!selected) onActive(index); }} onPointerDown={event => event.preventDefault()} onClick={() => onPick(result)}>
                {selected && <motion.span className={styles.resultHighlight} layoutId="active" transition={reduce ? { duration: 0 } : motionTokens.spring.snappy} aria-hidden="true" />}
                <Icon size={15} aria-hidden="true" />
                <span className={styles.resultText}>
                  <span className={styles.resultLabel}><Highlight text={result.def.label} match={result.match} /></span>
                  <span className={styles.resultDescription}>{result.def.description}</span>
                </span>
                <span className={styles.resultEnd} aria-hidden="true">{selected ? <CornerDownLeft size={14} /> : null}</span>
              </li>;
            })}
          </ul></LayoutGroup>
          : <p className={styles.empty} role="status">No settings match “{query.trim()}”</p>}
        <div className={styles.paletteFoot} aria-hidden="true">
          <span><kbd className={styles.kbd}>↑</kbd><kbd className={styles.kbd}>↓</kbd> Move</span>
          <span><kbd className={styles.kbd}>↵</kbd> Jump to setting</span>
        </div>
      </motion.div>
    </div>
  </motion.div>;
}

function Control({ def, id, value, error, onChange, labelId }: { def: SettingDefinition; id: string; value: SettingValue; error?: string; onChange: (value: SettingValue) => void; labelId: string }) {
  const described = `${id}-hint${error ? ` ${id}-error` : ""}`;
  if (def.kind === "switch") return <Switch id={id} checked={value === true} onCheckedChange={onChange} aria-labelledby={labelId} aria-describedby={described} />;
  if (def.kind === "segmented") return <div className={styles.segmented}><SegmentedControl options={def.options ?? []} value={String(value)} onValueChange={onChange} label={def.label} /></div>;
  // The row label is the visible one; the select's own label names the trigger for assistive tech.
  if (def.kind === "select") return <div className={styles.select}><Select id={id} label={def.label} className={styles.selectTrigger} value={String(value)} options={def.options ?? []} onValueChange={onChange} /></div>;
  return <span className={styles.text} data-invalid={error ? "" : undefined}>
    {def.prefix && <span className={styles.prefix} aria-hidden="true">{def.prefix}</span>}
    <input id={id} value={String(value)} placeholder={def.placeholder} onChange={event => onChange(event.target.value)} aria-labelledby={labelId} aria-describedby={described} aria-invalid={error ? true : undefined} spellCheck={false} autoComplete="off" />
  </span>;
}

function Row({ def, uid, value, dirty, error, pulse, onChange, rowRef }: { def: SettingDefinition; uid: string; value: SettingValue; dirty: boolean; error?: string; pulse: number; onChange: (value: SettingValue) => void; rowRef: (node: HTMLDivElement | null) => void }) {
  const reduce = useReducedMotion();
  const id = `${uid}-${def.id}`, labelId = `${id}-label`;
  const pulseClass = pulse ? (pulse % 2 ? styles.pulseA : styles.pulseB) : "";
  return <div ref={rowRef} className={`${styles.row} ${def.kind === "text" ? styles.rowWide : ""} ${pulseClass}`} data-setting={def.id} data-kind={def.kind}>
    <div className={styles.rowText}>
      <span className={styles.rowLabel}>
        <label id={labelId} htmlFor={def.kind === "segmented" || def.kind === "select" ? undefined : id}>{def.label}</label>
        <AnimatePresence initial={false}>{dirty && <motion.span className={styles.dirty} initial={{ opacity: 0, scale: .4 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .4 }} transition={reduce ? { duration: 0 } : motionTokens.spring.snappy}><span className={styles.srOnly}>Edited</span></motion.span>}</AnimatePresence>
      </span>
      <p id={`${id}-hint`}>{def.description}</p>
      <AnimatePresence initial={false}>{error && <motion.p id={`${id}-error`} className={styles.error} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={reduce ? { duration: 0 } : motionTokens.spring.smooth}>{error}</motion.p>}</AnimatePresence>
    </div>
    <div className={styles.rowControl}><Control def={def} id={id} value={value} error={error} onChange={onChange} labelId={labelId} /></div>
  </div>;
}

/** Grows out of a small puck, then follows whatever it holds, so saving shrinks it into a confirmation. */
function ChangesBar({ state, count, invalid, onDiscard, onSave, shake, barRef }: { state: "edit" | "saving" | "saved" | "failed"; count: number; invalid: boolean; onDiscard: () => void; onSave: () => void; shake: MotionValue<number>; barRef: RefObject<HTMLDivElement | null> }) {
  const reduce = useReducedMotion();
  const content = useRef<HTMLDivElement>(null);
  const width = useMotionValue(44), height = useMotionValue(44);
  const current = state === "saved" ? "saved" : "edit";
  // Both phases share one grid cell, so the outgoing one fades where it stands instead of being popped out and shifted.
  // The bar follows only the incoming phase, which clips the outgoing one from both sides as it shrinks.
  useLayoutEffect(() => {
    const node = content.current?.querySelector<HTMLElement>(`[data-phase="${current}"]`);
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
  }, [current, height, reduce, width]);
  const phase = reduce ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } } : { initial: { opacity: 0, filter: blur(motionTokens.blur.soft) }, animate: { opacity: 1, filter: blur(0) }, exit: { opacity: 0, filter: blur(motionTokens.blur.soft) } };
  const phaseTransition = { duration: reduce ? motionTokens.duration.instant : motionTokens.duration.standard, ease: enterEase };
  return <motion.div ref={barRef} className={styles.bar} role="group" aria-label={state === "saved" ? "Save status" : "Unsaved changes"} style={{ width, height, x: shake }}
    initial={reduce ? { opacity: 0 } : { opacity: 0, y: 24, filter: blur(motionTokens.blur.soft) }} animate={{ opacity: 1, y: 0, filter: blur(0) }}
    exit={reduce ? { opacity: 0, transition: { duration: motionTokens.duration.instant } } : { opacity: 0, y: 16, width: 44, height: 44, filter: blur(motionTokens.blur.soft), transition: { width: motionTokens.spring.smooth, height: motionTokens.spring.smooth, y: { ...motionTokens.spring.smooth, delay: .06 }, opacity: { duration: motionTokens.duration.exit, delay: .1 }, filter: { duration: motionTokens.duration.exit, delay: .1 } } }}
    transition={reduce ? { duration: motionTokens.duration.instant } : { y: motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.fast }, filter: { duration: motionTokens.duration.standard } }}>
    <div ref={content} className={styles.barContent}>
      <AnimatePresence initial={false}>
        {state === "saved"
          ? <motion.div key="saved" data-phase="saved" className={styles.barSaved} {...phase} transition={phaseTransition}>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><motion.path d="M5 12.5 9.5 17 19 7.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" initial={{ pathLength: reduce ? 1 : 0 }} animate={{ pathLength: 1 }} transition={{ duration: reduce ? 0 : .32, delay: reduce ? 0 : .08, ease: enterEase }} /></svg>
            <span>Settings saved</span>
          </motion.div>
          : <motion.div key="edit" data-phase="edit" className={styles.barEdit} {...phase} transition={phaseTransition}>
            <span className={styles.barCount}>
              {state === "failed" ? <span className={styles.barFailed}>Could not save</span> : invalid ? <span className={styles.barFailed}>Fix the highlighted field</span> : <><span className={styles.inherit}><AnimatedCounter value={count} /></span>&nbsp;<span className={styles.long}>unsaved&nbsp;</span><TextMorph>{count === 1 ? "change" : "changes"}</TextMorph></>}
            </span>
            <Button type="button" variant="ghost" size="sm" disabled={state === "saving"} onClick={onDiscard}>Discard</Button>
            <Button type="button" size="sm" loading={state === "saving"} onClick={onSave}>{state === "saving" ? "Saving" : state === "failed" ? "Retry" : "Save"}</Button>
          </motion.div>}
      </AnimatePresence>
    </div>
  </motion.div>;
}

export function SettingsCommand({ sections = settingsSections, settings = settingDefinitions, defaultValues = savedSettings, suggested = suggestedSettingIds, onSave, onValuesChange, title = "Settings", className }: SettingsCommandProps) {
  const uid = useId().replace(/:/g, "");
  const reduce = !!useReducedMotion();
  const [baseline, setBaseline] = useState<SettingValues>(defaultValues);
  const [draft, setDraft] = useState<SettingValues>(defaultValues);
  const [current, setCurrent] = useState<SettingsSectionId>(sections[0]?.id ?? "general");
  const [palette, setPalette] = useState<{ origin: Rect } | null>(null);
  const [closing, setClosing] = useState<Closing>(null);
  const [frameWidth, setFrameWidth] = useState(0);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [pulse, setPulse] = useState<{ id: string; tick: number }>({ id: "", tick: 0 });
  const [phase, setPhase] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [showErrors, setShowErrors] = useState(false);
  const [status, setStatus] = useState("");
  const frame = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const sectionNodes = useRef(new Map<string, HTMLElement>());
  const timers = useRef(new Set<number>());
  const spyFrame = useRef(0);
  const shake = useMotionValue(0);

  const changed = settings.filter(def => draft[def.id] !== baseline[def.id]).map(def => def.id);
  const errors = useMemo(() => Object.fromEntries(settings.flatMap(def => { const message = validate(def, draft[def.id]); return message ? [[def.id, message]] : []; })) as Record<string, string>, [draft, settings]);
  const firstError = settings.find(def => errors[def.id]);
  const results = useMemo(() => search(settings, sections, query), [query, sections, settings]);
  const suggestions = useMemo(() => suggested.flatMap(id => { const def = settings.find(item => item.id === id); return def ? [{ def, score: 0, match: null }] : []; }), [settings, suggested]);
  const barState = phase === "saving" ? "saving" : phase === "failed" && changed.length ? "failed" : changed.length ? "edit" : phase === "saved" ? "saved" : null;

  useEffect(() => {
    const pending = timers.current, spy = spyFrame;
    return () => { pending.forEach(timer => window.clearTimeout(timer)); cancelAnimationFrame(spy.current); };
  }, []);

  useEffect(() => {
    const node = frame.current;
    if (!node) return;
    const measure = () => setFrameWidth(node.offsetWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // When the bar's buttons leave, keep focus inside the block rather than dropping it on the document.
  useEffect(() => {
    if (barState === "edit" || barState === "saving" || barState === "failed") return;
    if (bar.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true });
  }, [barState]);

  const later = useCallback((run: () => void, ms: number) => {
    const timer = window.setTimeout(() => { timers.current.delete(timer); run(); }, ms);
    timers.current.add(timer);
  }, []);

  function update(id: string, value: SettingValue) {
    setDraft(values => { const next = { ...values, [id]: value }; onValuesChange?.(next); return next; });
    if (phase === "saved" || phase === "failed") setPhase("idle");
  }

  function spy() {
    if (spyFrame.current) return;
    spyFrame.current = requestAnimationFrame(() => {
      spyFrame.current = 0;
      const node = scroller.current;
      if (!node) return;
      let next = sections[0]?.id;
      for (const section of sections) { const el = sectionNodes.current.get(section.id); if (el && el.offsetTop <= node.scrollTop + node.clientHeight * .3) next = section.id; }
      if (node.scrollTop + node.clientHeight >= node.scrollHeight - 2) next = sections[sections.length - 1]?.id;
      if (next) setCurrent(value => value === next ? value : next);
    });
  }

  function goToSection(id: SettingsSectionId) {
    const node = scroller.current, el = sectionNodes.current.get(id);
    if (!node || !el) return;
    setCurrent(id);
    node.scrollTo({ top: Math.max(0, el.offsetTop - 16), behavior: reduce ? "auto" : "smooth" });
  }

  function openPalette() {
    if (!frame.current || !trigger.current) return;
    setQuery(""); setActive(0);
    setClosing(null);
    setPalette(value => value ?? { origin: relativeRect(trigger.current!, frame.current!) });
  }

  function closeToTrigger() {
    if (!frame.current || !trigger.current) return;
    setClosing({ to: relativeRect(trigger.current, frame.current), mode: "trigger" });
    later(() => trigger.current?.focus({ preventScroll: true }), reduce ? 0 : 200);
  }

  /** Scrolls the row to a calm reading height and returns where it will rest, so the palette can land on it. */
  function jumpTo(id: string, focus: boolean) {
    const node = scroller.current, row = rows.current.get(id), root = frame.current;
    if (!node || !row || !root) return null;
    const top = Math.max(0, Math.min(row.offsetTop - node.clientHeight * .28, node.scrollHeight - node.clientHeight));
    node.scrollTo({ top, behavior: reduce ? "auto" : "smooth" });
    const view = relativeRect(node, root);
    const bleed = 12;
    later(() => setPulse(value => ({ id, tick: value.tick + 1 })), reduce ? 0 : 280);
    if (focus) later(() => (row.querySelector("input, button") as HTMLElement | null)?.focus({ preventScroll: true }), reduce ? 0 : 480);
    return { x: view.x + row.offsetLeft - bleed, y: view.y + row.offsetTop - top, width: row.offsetWidth + bleed * 2, height: row.offsetHeight };
  }

  function pick(result: Result) {
    const to = jumpTo(result.def.id, true);
    setStatus(`${result.def.label}, in ${sections.find(item => item.id === result.def.section)?.label ?? "settings"}`);
    if (to) setClosing({ to, mode: "row" });
    else closeToTrigger();
  }

  const onClosed = useCallback(() => { setPalette(null); setClosing(null); }, []);

  function onRootKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (palette && !closing) return;
    const typing = (event.target as HTMLElement).closest("input, textarea");
    if (((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") || (event.key === "/" && !typing)) {
      event.preventDefault();
      openPalette();
    }
  }

  function save() {
    if (!changed.length || phase === "saving") return;
    if (firstError) {
      setShowErrors(true);
      setStatus(`${errors[firstError.id]} before saving`);
      if (!reduce) animate(shake, [0, -6, 5, -3, 2, 0], { duration: .4, ease: "easeOut" });
      jumpTo(firstError.id, true);
      return;
    }
    const snapshot = draft, ids = changed;
    setPhase("saving");
    setStatus("Saving settings");
    const finish = () => {
      setBaseline(snapshot);
      setShowErrors(false);
      setPhase("saved");
      setStatus(`${ids.length} ${ids.length === 1 ? "change" : "changes"} saved`);
      later(() => setPhase(value => value === "saved" ? "idle" : value), 1800);
    };
    if (!onSave) { later(finish, 900); return; }
    Promise.resolve().then(() => onSave(snapshot, ids)).then(finish, () => { setPhase("failed"); setStatus("Could not save. Try again."); });
  }

  function discard() {
    if (phase === "saving") return;
    setDraft(baseline);
    onValuesChange?.(baseline);
    setShowErrors(false);
    setPhase("idle");
    setStatus("Changes discarded");
  }

  const bySection = useMemo(() => sections.map(section => ({ section, defs: settings.filter(def => def.section === section.id) })), [sections, settings]);

  return <div className={`${styles.root} ${className ?? ""}`} onKeyDown={onRootKey}>
    <div ref={frame} className={styles.frame}>
      <header className={styles.header}>
        <h2>{title}</h2>
        <div className={styles.triggerSlot}>
          <button ref={trigger} type="button" className={styles.trigger} data-hidden={palette ? "" : undefined} onClick={openPalette} aria-haspopup="dialog" aria-keyshortcuts="Meta+K Control+K /">
            <Search size={15} aria-hidden="true" />
            <span>Search settings</span>
            <kbd className={styles.kbd} aria-hidden="true">⌘K</kbd>
          </button>
        </div>
      </header>

      <nav className={styles.nav} aria-label="Settings sections">
        <LayoutGroup id={`${uid}-nav`}>
          <ul>
            {bySection.map(({ section, defs }) => {
              const Icon = icons[section.id];
              const selected = current === section.id;
              const edits = defs.filter(def => changed.includes(def.id)).length;
              return <li key={section.id}>
                <button type="button" className={styles.navItem} aria-current={selected ? "true" : undefined} onClick={() => goToSection(section.id)}>
                  {selected && <motion.span className={styles.navHighlight} layoutId="highlight" transition={reduce ? { duration: 0 } : motionTokens.spring.morph} aria-hidden="true" />}
                  <Icon size={15} aria-hidden="true" />
                  <span className={styles.navLabel}>{section.label}</span>
                  <AnimatePresence initial={false}>{edits > 0 && <motion.span className={styles.navDot} initial={{ opacity: 0, scale: .4 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .4 }} transition={reduce ? { duration: 0 } : motionTokens.spring.snappy}><span className={styles.srOnly}>{edits} edited</span></motion.span>}</AnimatePresence>
                </button>
              </li>;
            })}
          </ul>
        </LayoutGroup>
      </nav>

      <div className={styles.main}>
        <div ref={scroller} className={styles.scroller} onScroll={spy}>
          {bySection.map(({ section, defs }) => <section key={section.id} ref={node => { if (node) sectionNodes.current.set(section.id, node); else sectionNodes.current.delete(section.id); }} className={styles.section} aria-labelledby={`${uid}-section-${section.id}`}>
            <div className={styles.sectionHead}>
              <h3 id={`${uid}-section-${section.id}`}>{section.label}</h3>
              <p>{section.description}</p>
            </div>
            <div className={styles.rows}>
              {defs.map(def => <Row key={def.id} def={def} uid={uid} value={draft[def.id] ?? ""} dirty={changed.includes(def.id)} error={showErrors || changed.includes(def.id) ? errors[def.id] : undefined}
                pulse={pulse.id === def.id ? pulse.tick : 0} onChange={value => update(def.id, value)}
                rowRef={node => { if (node) rows.current.set(def.id, node); else rows.current.delete(def.id); }} />)}
            </div>
          </section>)}
        </div>
        <div className={styles.dock}>
          <AnimatePresence>{barState && <ChangesBar key="bar" state={barState} count={changed.length} invalid={showErrors && !!firstError} onDiscard={discard} onSave={save} shake={shake} barRef={bar} />}</AnimatePresence>
        </div>
      </div>

      <AnimatePresence>{palette && !closing && <motion.div key="scrim" className={styles.scrim} onPointerDown={closeToTrigger} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduce ? motionTokens.duration.instant : motionTokens.duration.standard }} aria-hidden="true" />}</AnimatePresence>
      {palette && frameWidth > 0 && <CommandPalette uid={uid} origin={palette.origin} frameWidth={frameWidth} closing={closing} onClosed={onClosed}
        query={query} onQuery={setQuery} results={results} suggestions={suggestions} active={active} onActive={setActive}
        onPick={pick} onClose={closeToTrigger} reduce={reduce} />}
    </div>
    <p className={styles.srOnly} role="status" aria-live="polite">{status}</p>
  </div>;
}

export default SettingsCommand;
