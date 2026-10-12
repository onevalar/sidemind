"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { AnimatePresence, animate, motion, useIsPresent, useMotionValue, useReducedMotion } from "motion/react";
import type { Transition, Variants } from "motion/react";
import { ArrowLeft, CircleAlert, CornerDownLeft, LoaderCircle, Plus, X } from "lucide-react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./action-morph.module.css";

/** The inline form an action opens. */
export interface ActionMorphComposer {
  title: string;
  placeholder: string;
  /** A three line note instead of a one line title. Submit with Command or Control and Enter. */
  multiline?: boolean;
  /** One short set of choices under the field, such as a due date. */
  choices?: { label: string; options: string[]; defaultIndex?: number };
  submitLabel: string;
  /** Announced, and spoken for the check, once the submit resolves. */
  successLabel: string;
  /** Shown when the field is empty on submit. */
  emptyHint?: string;
}

export interface ActionMorphAction {
  id: string;
  label: string;
  description?: string;
  icon: ReactNode;
  /** One letter that runs the action while the menu is open. */
  shortcut?: string;
  composer: ActionMorphComposer;
}

export interface ActionMorphSubmission {
  action: string;
  text: string;
  choice?: string;
}

/**
 * A floating action button that is one continuous shape. It springs open into a quick action menu, each action slides the same surface
 * into its own inline composer, and a successful submit folds everything back into the button with a check.
 * Use it for the two or three things people create most often on a page. Prefer a toolbar or a full form for longer or rarer tasks.
 */
export interface ActionMorphProps {
  actions: ActionMorphAction[];
  /** Accessible name of the button and the title of the menu. */
  label?: string;
  /** Return a promise to hold the sending state; a rejection keeps the composer open with the draft and an error. */
  onSubmit?: (submission: ActionMorphSubmission) => void | Promise<unknown>;
  /** Which bottom corner the button sits in. The surface grows away from it. */
  corner?: "end" | "start";
  /** Milliseconds the check stays before the button returns to its plus. */
  resetAfter?: number;
  className?: string;
}

type View = "fab" | "menu" | string;
type Size = { w: number; h: number };

const { blur } = motionTokens;
type Bezier = [number, number, number, number];
const enter = [...motionTokens.ease.enter] as Bezier;
const standard = [...motionTokens.ease.standard] as Bezier;
const physical = (visualDuration: number, bounce: number): Transition => {
  const root = 2 * Math.PI / (visualDuration * 1.2);
  return { type: "spring", stiffness: root * root, damping: 2 * (1 - bounce) * root, mass: 1 };
};
/** Growing carries a little life; folding settles faster and never overshoots. */
const GROW = physical(.46, .16), SHRINK = physical(.38, .04), GLIDE = physical(.28, .08), SLIDE = physical(.4, .06), PRESS = physical(.2, .1);
const TRAVEL = 28;
const FAB = "fab", MENU = "menu";
const depth = (view: View) => view === FAB ? 0 : view === MENU ? 1 : 2;

const subscribe = () => () => {};
function useReducedFlag() {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

/** Deeper surfaces arrive from the right and push the old one left; going back reverses it. The button and the menu grow from the corner instead. */
const faceVariants: Variants = {
  hidden: (direction: number) => direction ? { opacity: 0, x: direction * TRAVEL, scale: 1, filter: `blur(${blur.soft}px)` } : { opacity: 0, x: 0, scale: .9, filter: `blur(${blur.soft}px)` },
  shown: {
    opacity: 1, x: 0, scale: 1, filter: "blur(0px)",
    transition: { x: SLIDE, scale: GROW, opacity: { duration: .22, ease: enter, delay: .05 }, filter: { duration: .24, ease: enter, delay: .05 }, delayChildren: .06, staggerChildren: motionTokens.stagger.item },
  },
  gone: (direction: number) => direction
    ? { opacity: 0, x: direction * -TRAVEL * .7, filter: `blur(${blur.soft}px)`, transition: { x: SLIDE, opacity: { duration: .12, ease: standard }, filter: { duration: .12, ease: standard } } }
    : { opacity: 0, scale: .92, filter: `blur(${blur.soft}px)`, transition: { duration: .12, ease: standard } },
};
const fadeVariants: Variants = { hidden: { opacity: 0 }, shown: { opacity: 1, transition: { duration: .16 } }, gone: { opacity: 0, transition: { duration: .1 } } };
const rowVariants: Variants = {
  hidden: { opacity: 0, y: 8 },
  shown: { opacity: 1, y: 0, transition: { y: physical(.36, 0), opacity: { duration: .2, ease: enter } } },
};
const stillRow: Variants = { hidden: { opacity: 1 }, shown: { opacity: 1 } };

/** A face reports its natural size while it is the current one; a leaving face turns inert and stops reporting. */
function Face({ id, direction, reduced, onSize, className, children, label, role }: { id: string; direction: number; reduced: boolean; onSize: (id: string, size: Size) => void; className?: string; children: ReactNode; label?: string; role?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const present = useIsPresent();
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !present) return;
    const report = () => onSize(id, { w: node.offsetWidth, h: node.offsetHeight });
    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(node);
    return () => observer.disconnect();
  }, [id, onSize, present]);
  return <motion.div ref={ref} className={[styles.face, className].filter(Boolean).join(" ")} data-face={id} custom={direction} role={role} aria-label={label}
    variants={reduced ? fadeVariants : faceVariants} initial="hidden" animate="shown" exit="gone" inert={!present || undefined}>{children}</motion.div>;
}

/** The check draws itself once, then the button hands the plus back. */
function Glyph({ done, reduced }: { done: boolean; reduced: boolean }) {
  // The button face remounts as the composer folds into it, so a check that arrives on mount still draws; a plus on mount just sits there.
  const [drawOnMount] = useState(done);
  return <span className={styles.glyph} aria-hidden="true">
    <AnimatePresence initial={drawOnMount} mode="popLayout">
      {done
        ? <motion.svg key="check" viewBox="0 0 24 24" width={22} height={22} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
          initial={{ opacity: 0, scale: reduced ? 1 : .6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: reduced ? 1 : .6, transition: { duration: .12 } }} transition={reduced ? { duration: .12 } : PRESS}>
          <motion.path d="M5.5 12.5l4.2 4.2 8.8-9.2" initial={{ pathLength: reduced ? 1 : 0 }} animate={{ pathLength: 1 }} transition={{ duration: reduced ? 0 : .32, ease: enter, delay: reduced ? 0 : .12 }} />
        </motion.svg>
        : <motion.span key="plus" className={styles.plus} initial={{ opacity: 0, rotate: reduced ? 0 : -90, scale: reduced ? 1 : .6 }} animate={{ opacity: 1, rotate: 0, scale: 1 }}
          exit={{ opacity: 0, rotate: reduced ? 0 : 45, scale: reduced ? 1 : .6, transition: { duration: .12 } }} transition={reduced ? { duration: .12 } : physical(.36, .2)}>
          <Plus size={22} strokeWidth={1.75} />
        </motion.span>}
    </AnimatePresence>
  </span>;
}

export function ActionMorph({ actions, label = "Create", onSubmit, corner = "end", resetAfter = 1600, className }: ActionMorphProps) {
  const reduced = useReducedFlag();
  const uid = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const fabRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const [view, setView] = useState<View>(FAB);
  const [direction, setDirection] = useState(0);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [choices, setChoices] = useState<Record<string, number>>({});
  const [hovered, setHovered] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState({ id: 0, text: "" });

  const action = actions.find(item => item.id === view);
  const composer = action?.composer;
  const draft = action ? drafts[action.id] ?? "" : "";
  const choice = action && composer?.choices ? choices[action.id] ?? composer.choices.defaultIndex ?? 0 : 0;

  /* The shape: width, height, and corners spring to whichever face is current. */
  const width = useMotionValue<number | string>("100%"), height = useMotionValue<number | string>("100%"), radius = useMotionValue<number | string>("50%");
  const press = useMotionValue(1);
  const sizes = useRef(new Map<string, Size>());
  const live = useRef({ view: FAB as View, reduced: false, measured: false });
  const last = useRef<Size>({ w: 0, h: 0 });

  const place = useCallback(() => {
    const state = live.current;
    const size = sizes.current.get(state.view);
    if (!size || !size.w) return;
    const r = state.view === FAB ? size.h / 2 : 24;
    const previous = last.current;
    if (Math.abs(previous.w - size.w) < .5 && Math.abs(previous.h - size.h) < .5 && state.measured) return;
    last.current = size;
    if (!state.measured || state.reduced) { width.jump(size.w); height.jump(size.h); radius.jump(r); state.measured = true; return; }
    const transition = size.w * size.h >= previous.w * previous.h ? GROW : SHRINK;
    animate(width, size.w, transition);
    animate(height, size.h, transition);
    animate(radius, r, transition);
  }, [height, radius, width]);

  const onSize = useCallback((id: string, size: Size) => {
    sizes.current.set(id, size);
    if (id === live.current.view) place();
  }, [place]);

  useLayoutEffect(() => {
    live.current.view = view;
    live.current.reduced = reduced;
    place();
  }, [place, reduced, view]);

  const go = (next: View) => {
    if (next === view) return;
    const from = depth(view), to = depth(next);
    setDirection(from >= 1 && to >= 1 ? Math.sign(to - from) || 1 : 0);
    setError(null);
    setHovered(null);
    setView(next);
  };

  /* Focus follows the surface: the first action, the field, or back to the button or the action that opened the composer. */
  const pendingFocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    if (target === FAB) fabRef.current?.focus({ preventScroll: true });
    else if (target === "field") fieldRef.current?.focus({ preventScroll: true });
    else menuRef.current?.querySelector<HTMLElement>(`[data-action="${target}"]`)?.focus({ preventScroll: true });
  }, [view]);

  const focusInside = () => !!rootRef.current?.contains(document.activeElement);
  const openMenu = () => { pendingFocus.current = actions[0]?.id ?? null; setDone(false); go(MENU); };
  const openComposer = (id: string) => { pendingFocus.current = "field"; go(id); };
  const back = () => { pendingFocus.current = view; go(MENU); };
  const closeAll = useCallback((restore = true) => {
    if (restore && rootRef.current?.contains(document.activeElement)) pendingFocus.current = FAB;
    setDirection(0);
    setError(null);
    setHovered(null);
    setView(FAB);
  }, []);

  // The check hands the plus back after a moment.
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setDone(false), resetAfter);
    return () => window.clearTimeout(timer);
  }, [done, resetAfter]);

  // A press outside folds the surface back into the button; drafts stay.
  const opened = view !== FAB;
  useEffect(() => {
    if (!opened) return;
    const down = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) closeAll(false); };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }, [closeAll, opened]);

  const shake = useMotionValue(0);
  const nudge = () => { if (!reduced) animate(shake, 0, { type: "spring", stiffness: 900, damping: 12, velocity: -260 }); };

  const token = useRef(0);
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!action || !composer || busy) return;
    const text = draft.trim();
    if (!text) { setError(composer.emptyHint ?? "Write something first"); nudge(); fieldRef.current?.focus(); return; }
    const run = ++token.current;
    setBusy(true);
    setError(null);
    try {
      await onSubmit?.({ action: action.id, text, choice: composer.choices?.options[choice] });
    } catch {
      if (run !== token.current) return;
      setBusy(false);
      setError("Couldn’t save. Try again.");
      nudge();
      return;
    }
    if (run !== token.current) return;
    setBusy(false);
    setDrafts(all => ({ ...all, [action.id]: "" }));
    if (focusInside()) pendingFocus.current = FAB;
    setDone(true);
    setDirection(0);
    setView(FAB);
    setAnnouncement(current => ({ id: current.id + 1, text: composer.successLabel }));
  };

  const onRootKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (view === FAB) return;
    event.preventDefault();
    if (view === MENU) closeAll();
    else if (!busy) back();
  };

  /* The menu highlight glides between actions and follows keyboard focus as well as the pointer. */
  const hy = useMotionValue(0), hh = useMotionValue(0), ho = useMotionValue(0);
  useLayoutEffect(() => {
    const node = hovered === null ? null : menuRef.current?.querySelector<HTMLElement>(`[data-index="${hovered}"]`);
    if (!node) { animate(ho, 0, { duration: reduced ? 0 : .14, ease: standard }); return; }
    if (ho.get() < .05 || reduced) { hy.jump(node.offsetTop); hh.jump(node.offsetHeight); }
    else { animate(hy, node.offsetTop, GLIDE); animate(hh, node.offsetHeight, GLIDE); }
    animate(ho, 1, { duration: reduced ? 0 : .12, ease: enter });
  }, [ho, hh, hovered, hy, reduced, view]);

  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[role='menuitem']"));
    const at = items.indexOf(document.activeElement as HTMLElement);
    const steps: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 };
    let next: number | null = null;
    if (event.key in steps) next = at < 0 ? 0 : (at + steps[event.key] + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const hit = actions.find(item => item.shortcut?.toLowerCase() === event.key.toLowerCase());
      if (hit) { event.preventDefault(); openComposer(hit.id); }
      return;
    }
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus();
  };

  const onFieldKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (composer?.multiline && event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); }
  };

  const onChoiceKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!action || !composer?.choices) return;
    const count = composer.choices.options.length;
    const steps: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(event.key in steps)) return;
    event.preventDefault();
    const next = (choice + steps[event.key] + count) % count;
    setChoices(all => ({ ...all, [action.id]: next }));
    event.currentTarget.querySelectorAll<HTMLElement>("[role='radio']")[next]?.focus();
  };

  const pressIn = () => { if (!reduced) animate(press, .94, PRESS); };
  const pressOut = () => animate(press, 1, PRESS);
  const row = reduced ? stillRow : rowVariants;
  const menuTitleId = `${uid}-menu-title`, composerTitleId = `${uid}-${view}-title`;

  return <div ref={rootRef} className={[styles.root, className].filter(Boolean).join(" ")} data-corner={corner} data-view={view === FAB ? "fab" : view === MENU ? "menu" : "composer"} data-done={done || undefined} onKeyDown={onRootKey}>
    <motion.div className={styles.shape} style={{ width, height, borderRadius: radius, scale: press }}>
      <AnimatePresence initial={false} custom={direction}>
        {view === FAB && <Face key={FAB} id={FAB} direction={direction} reduced={reduced} onSize={onSize} className={styles.fabFace}>
          <button ref={fabRef} type="button" className={styles.fab} aria-label={done ? `${label}. ${announcement.text}` : label} aria-haspopup="menu" aria-expanded={false}
            onClick={openMenu} onPointerDown={event => { if (event.button === 0) pressIn(); }} onPointerUp={pressOut} onPointerLeave={pressOut} onPointerCancel={pressOut}>
            <Glyph done={done} reduced={reduced} />
          </button>
        </Face>}

        {view === MENU && <Face key={MENU} id={MENU} direction={direction} reduced={reduced} onSize={onSize} className={styles.menuFace}>
          <motion.div className={styles.header} variants={row}>
            <p id={menuTitleId} className={styles.title}>{label}</p>
            <button type="button" className={styles.iconButton} aria-label="Close" onClick={() => closeAll()}><X size={16} strokeWidth={1.75} aria-hidden="true" /></button>
          </motion.div>
          <div ref={menuRef} className={styles.menu} role="menu" aria-labelledby={menuTitleId} onKeyDown={onMenuKey} onPointerLeave={() => setHovered(null)}>
            <motion.span className={styles.highlight} style={{ y: hy, height: hh, opacity: ho }} aria-hidden="true" />
            {actions.map((item, index) => <motion.button key={item.id} type="button" role="menuitem" className={styles.item} data-index={index} data-action={item.id} variants={row}
              aria-keyshortcuts={item.shortcut} onClick={() => openComposer(item.id)}
              onPointerMove={event => { if (event.pointerType === "mouse" && hovered !== index) setHovered(index); }}
              onFocus={() => setHovered(index)}>
              <span className={styles.itemIcon} aria-hidden="true">{item.icon}</span>
              <span className={styles.itemText}>
                <span className={styles.itemLabel}>{item.label}</span>
                {item.description && <span className={styles.itemDescription}>{item.description}</span>}
              </span>
              {item.shortcut && <kbd className={styles.kbd} aria-hidden="true">{item.shortcut.toUpperCase()}</kbd>}
            </motion.button>)}
          </div>
        </Face>}

        {action && composer && <Face key={action.id} id={action.id} direction={direction} reduced={reduced} onSize={onSize} className={styles.composerFace}>
          <form className={styles.form} aria-labelledby={composerTitleId} onSubmit={submit} aria-busy={busy || undefined}>
            <motion.div className={styles.header} variants={row}>
              <button type="button" className={styles.iconButton} aria-label="Back to actions" onClick={back} disabled={busy}><ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" /></button>
              <p id={composerTitleId} className={styles.title}>{composer.title}</p>
              <button type="button" className={styles.iconButton} aria-label="Close" onClick={() => closeAll()}><X size={16} strokeWidth={1.75} aria-hidden="true" /></button>
            </motion.div>

            <motion.div variants={row} style={{ x: shake }}>
              {composer.multiline
                ? <textarea ref={fieldRef} className={`${styles.field} ${styles.textarea}`} rows={3} placeholder={composer.placeholder} aria-label={composer.title} value={draft} readOnly={busy}
                  aria-invalid={!!error || undefined} aria-describedby={error ? `${uid}-error` : undefined} aria-keyshortcuts="Meta+Enter Control+Enter"
                  onChange={event => { setDrafts(all => ({ ...all, [action.id]: event.target.value })); setError(null); }} onKeyDown={onFieldKey} />
                : <input ref={fieldRef} className={styles.field} type="text" placeholder={composer.placeholder} aria-label={composer.title} value={draft} readOnly={busy} autoComplete="off"
                  aria-invalid={!!error || undefined} aria-describedby={error ? `${uid}-error` : undefined}
                  onChange={event => { setDrafts(all => ({ ...all, [action.id]: event.target.value })); setError(null); }} />}
            </motion.div>

            {composer.choices && <motion.div variants={row} className={styles.choiceBlock}>
              <span id={`${uid}-choices`} className={styles.choiceLabel}>{composer.choices.label}</span>
              <div className={styles.choices} role="radiogroup" aria-labelledby={`${uid}-choices`} onKeyDown={onChoiceKey} style={{ "--count": composer.choices.options.length } as CSSProperties}>
                {composer.choices.options.map((option, index) => <button key={option} type="button" role="radio" aria-checked={index === choice} tabIndex={index === choice ? 0 : -1}
                  className={styles.choice} disabled={busy} onClick={() => setChoices(all => ({ ...all, [action.id]: index }))}>
                  {index === choice && <motion.span layoutId={`${uid}-choice-${action.id}`} className={styles.choicePill} transition={reduced ? { duration: 0 } : GLIDE} aria-hidden="true" />}
                  <span className={styles.choiceText}>{option}</span>
                </button>)}
              </div>
            </motion.div>}

            <motion.div variants={row} className={styles.footer}>
              <span id={`${uid}-error`} className={styles.status} aria-live="polite">
                <AnimatePresence initial={false} mode="popLayout">
                  {error && <motion.span key={error} className={styles.error} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: .1 } }} transition={reduced ? { duration: .1 } : GLIDE}>
                    <CircleAlert size={14} strokeWidth={1.75} aria-hidden="true" />{error}
                  </motion.span>}
                </AnimatePresence>
              </span>
              <button type="submit" className={styles.submit} aria-disabled={busy || undefined}>
                {/* Both labels share one cell, so the button never changes width while it works. */}
                <span className={styles.submitFace} data-on={!busy || undefined}>{composer.submitLabel}<CornerDownLeft size={14} strokeWidth={1.75} aria-hidden="true" /></span>
                <span className={styles.submitFace} data-on={busy || undefined} aria-hidden={!busy}><LoaderCircle className={styles.spinner} size={16} strokeWidth={1.75} aria-hidden="true" />Saving</span>
              </button>
            </motion.div>
          </form>
        </Face>}
      </AnimatePresence>
    </motion.div>
    <span className={styles.srOnly} role="status" aria-live="polite"><span key={announcement.id}>{announcement.text}</span></span>
  </div>;
}

export default ActionMorph;
