"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, Ref } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, animate, motion, useDragControls, useIsPresent, useMotionValue, useReducedMotion } from "motion/react";
import type { PanInfo, Transition, Variants } from "motion/react";
import { Check, ChevronDown, CircleAlert, Copy, Link2, LoaderCircle, Share, X } from "lucide-react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./share-sheet.module.css";

export interface SharePerson {
  id: string;
  name: string;
  /** Portrait URL, shown round. */
  avatar: string;
}

export interface ShareChannel {
  id: string;
  label: string;
  icon: ReactNode;
  /** Short label the button settles on once `onChannel` resolves, such as “Posted”. Keep it about as long as `label`. */
  doneLabel: string;
}

export interface ShareSheetAccess {
  value: string;
  label: string;
  /** One line under the label, such as “Can view and comment”. */
  description: string;
  icon: ReactNode;
}
/** @deprecated Renamed to `ShareSheetAccess` so it never clashes with the `share-access` component in a shared index.ts. */
export type ShareAccess = ShareSheetAccess;

export interface ShareSubmission {
  people: SharePerson[];
  access: string;
}

/**
 * A Share button that is one continuous shape. It springs open into a share panel: copy the link, set who can open it, post it to a
 * channel, or pick recent people, whose avatars fly up into a “Send to” row. Sending folds the panel into a confirmation, and done folds
 * it back into the button. Use it on documents, boards, and files where sharing is frequent and should not leave the page.
 */
export interface ShareSheetProps {
  /** Name of the thing being shared, shown in the panel title. */
  title: string;
  link: string;
  people: SharePerson[];
  channels?: ShareChannel[];
  access: ShareSheetAccess[];
  defaultAccess?: string;
  /** Return a promise to hold the sending state; a rejection keeps the panel open with an error. */
  onSend?: (submission: ShareSubmission) => void | Promise<unknown>;
  /** Return a promise to hold the channel's pending state; a rejection shows a short error on that button. */
  onChannel?: (channel: string) => void | Promise<unknown>;
  /** Called after the link is copied, with the access level it was copied under. */
  onCopy?: (access: string) => void;
  label?: string;
  /** Which edge of the button stays put while the panel grows. `center` grows it evenly around the button, for a button that stands alone. */
  align?: "start" | "end" | "center";
  /** On screens up to 520px wide the panel opens as a bottom sheet that slides up and can be dragged down to close. Set false to keep the inline panel. */
  sheetOnPhones?: boolean;
  className?: string;
}

type View = "button" | "panel" | "sent";
type Size = { w: number; h: number };
/** Where a picked avatar started, and when; only a fresh pick flies, so a remounted chip never replays an old flight. */
type Rect = { x: number; y: number; w: number; h: number; t: number };
type Flight = { id: string; key: number; src: string; from: Rect; to: Rect };
type Status = "idle" | "busy" | "done" | "error";

const { blur } = motionTokens;
type Bezier = [number, number, number, number];
const enter = [...motionTokens.ease.enter] as Bezier;
const standard = [...motionTokens.ease.standard] as Bezier;
const physical = (visualDuration: number, bounce: number): Transition => {
  const root = 2 * Math.PI / (visualDuration * 1.2);
  return { type: "spring", stiffness: root * root, damping: 2 * (1 - bounce) * root, mass: 1 };
};
const GROW = physical(.48, .14), SHRINK = physical(.38, .02), SLIDE = physical(.42, .06), FLY = physical(.5, .14), SNAP = physical(.26, .12), SMOOTH = physical(.36, 0);
const SHEET_IN = physical(.44, .04), SHEET_OUT = physical(.32, 0);
const TRAVEL = 32;
const order: Record<View, number> = { button: 0, panel: 1, sent: 2 };

const subscribe = () => () => {};
function useReducedFlag() {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

const PHONE = "(max-width: 520px)";
const subscribePhone = (change: () => void) => {
  const query = window.matchMedia(PHONE);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
};
function usePhone(enabled: boolean) {
  const phone = useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE).matches, () => false);
  return enabled && phone;
}

/** The dim behind the phone sheet stops taking presses the moment it starts to leave, so a tap can reopen the sheet at once. */
function Scrim({ reduced }: { reduced: boolean }) {
  const present = useIsPresent();
  return <motion.div className={styles.scrim} aria-hidden="true" style={{ pointerEvents: present ? "auto" : "none" }}
    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? .12 : motionTokens.duration.standard, ease: standard }} />;
}

/** Faces grow from the button's corner; the confirmation slides in from the side the story moves toward. */
const faceVariants: Variants = {
  hidden: (direction: number) => direction ? { opacity: 0, x: direction * TRAVEL, scale: 1, filter: `blur(${blur.soft}px)` } : { opacity: 0, x: 0, scale: .94, filter: `blur(${blur.soft}px)` },
  shown: { opacity: 1, x: 0, scale: 1, filter: "blur(0px)", transition: { x: SLIDE, scale: GROW, opacity: { duration: .22, ease: enter, delay: .05 }, filter: { duration: .24, ease: enter, delay: .05 }, delayChildren: .05, staggerChildren: motionTokens.stagger.item } },
  gone: (direction: number) => direction
    ? { opacity: 0, x: direction * -TRAVEL * .6, filter: `blur(${blur.soft}px)`, transition: { x: SLIDE, opacity: { duration: .12, ease: standard }, filter: { duration: .12, ease: standard } } }
    : { opacity: 0, scale: .96, filter: `blur(${blur.soft}px)`, transition: { duration: .12, ease: standard } },
};
const fadeVariants: Variants = { hidden: { opacity: 0 }, shown: { opacity: 1, transition: { duration: .16 } }, gone: { opacity: 0, transition: { duration: .1 } } };
const rowVariants: Variants = { hidden: { opacity: 0, y: -6 }, shown: { opacity: 1, y: 0, transition: { y: SMOOTH, opacity: { duration: .22, ease: enter } } } };
const stillRow: Variants = { hidden: { opacity: 1 }, shown: { opacity: 1 } };
const swap = (reduced: boolean) => ({
  initial: reduced ? { opacity: 0 } : { opacity: 0, y: "0.6em", filter: `blur(${blur.subtle}px)` },
  animate: { opacity: 1, y: 0, filter: "blur(0px)" },
  exit: reduced ? { opacity: 0, transition: { duration: .08 } } : { opacity: 0, y: "-0.6em", filter: `blur(${blur.subtle}px)`, transition: { duration: .12, ease: standard } },
  transition: reduced ? { duration: .12 } : { y: SNAP, opacity: { duration: .18, ease: enter }, filter: { duration: .18, ease: enter } },
});

function Face({ id, direction, reduced, onSize, className, children }: { id: View; direction: number; reduced: boolean; onSize: (id: View, size: Size) => void; className?: string; children: ReactNode }) {
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
  return <motion.div ref={ref} className={[styles.face, className].filter(Boolean).join(" ")} data-face={id} custom={direction}
    variants={reduced ? fadeVariants : faceVariants} initial="hidden" animate="shown" exit="gone" inert={!present || undefined}>{children}</motion.div>;
}

/**
 * A chosen person. The chips row scrolls sideways and would clip anything outside it, so the chip only says where its avatar lands;
 * the panel flies a copy up from the recent row on its own layer and the chip's avatar appears the moment the copy arrives.
 */
function Chip({ person, source, reduced, hidden, onLand, onRemove, ref }: { person: SharePerson; source?: Rect; reduced: boolean; hidden: boolean; onLand: (rect: DOMRect) => void; onRemove: () => void; ref?: Ref<HTMLLIElement> }) {
  const avatarRef = useRef<HTMLSpanElement>(null);
  const flown = useRef(false);
  const fresh = !!source && !reduced;
  useLayoutEffect(() => {
    const node = avatarRef.current;
    if (flown.current || !node || !source || reduced) return;
    flown.current = true;
    if (performance.now() - source.t > 400) return;
    const row = node.closest<HTMLElement>("[data-chips]");
    if (row) row.scrollLeft = row.scrollWidth;
    onLand(node.getBoundingClientRect());
  }, [onLand, reduced, source]);
  const first = person.name.split(" ")[0];
  return <motion.li ref={ref} layout={reduced ? false : "position"} className={styles.chip} transition={SMOOTH}
    exit={{ opacity: 0, scale: reduced ? 1 : .8, transition: { duration: .12, ease: standard } }}>
    <motion.span className={styles.chipFill} aria-hidden="true" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: .2, delay: fresh ? .18 : 0 }} />
    <span ref={avatarRef} className={styles.chipAvatar} data-hidden={hidden || undefined} aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element -- avatars come from consumer URLs */}
      <img src={person.avatar} alt="" width={40} height={40} />
    </span>
    <motion.span className={styles.chipName} initial={reduced ? { opacity: 0 } : { opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ x: SMOOTH, opacity: { duration: .2, ease: enter }, delay: fresh ? .2 : 0 }}>{first}</motion.span>
    <button type="button" className={styles.chipRemove} aria-label={`Remove ${person.name}`} onClick={onRemove}><X size={12} strokeWidth={2} aria-hidden="true" /></button>
  </motion.li>;
}

function listNames(people: SharePerson[]) {
  const first = people.map(person => person.name.split(" ")[0]);
  if (first.length === 1) return people[0].name;
  if (first.length === 2) return `${first[0]} and ${first[1]}`;
  const rest = first.length - 2;
  return `${first[0]}, ${first[1]}, and ${rest} ${rest === 1 ? "other" : "others"}`;
}

export function ShareSheet({ title, link, people, channels = [], access, defaultAccess, onSend, onChannel, onCopy, label = "Share", align = "end", sheetOnPhones = true, className }: ShareSheetProps) {
  const reduced = useReducedFlag();
  const sheet = usePhone(sheetOnPhones);
  const sheetRef = useRef<HTMLDivElement>(null);
  const drag = useDragControls();
  const uid = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);
  const accessRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);

  const [view, setView] = useState<View>("button");
  const [direction, setDirection] = useState(0);
  const [picked, setPicked] = useState<string[]>([]);
  const [sources, setSources] = useState<Record<string, Rect>>({});
  const [flights, setFlights] = useState<Flight[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [level, setLevel] = useState(defaultAccess ?? access[0]?.value ?? "");
  const [accessOpen, setAccessOpen] = useState(false);
  const [copy, setCopy] = useState<Status>("idle");
  const [channelState, setChannelState] = useState<Record<string, Status>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState(false);
  const [announcement, setAnnouncement] = useState({ id: 0, text: "" });
  const announce = (text: string) => setAnnouncement(current => ({ id: current.id + 1, text }));

  const chosen = picked.map(id => people.find(person => person.id === id)).filter((person): person is SharePerson => !!person);
  const currentAccess = access.find(item => item.value === level) ?? access[0];

  /* The shape springs between faces while a morph is in flight; at rest it follows its face exactly, so rows that animate their own height carry the edge. */
  const width = useMotionValue<number | string>("100%"), height = useMotionValue<number | string>("100%"), radius = useMotionValue<number | string>(9999);
  /* On phones the shape stays the button and the faces live in a bottom sheet whose height springs between them. */
  const sheetHeight = useMotionValue<number | string>("auto");
  const sizes = useRef(new Map<View, Size>());
  const live = useRef({ view: "button" as View, reduced: false, measured: false, settled: true, last: { w: 0, h: 0 }, run: {} as object, sheet: false, sheetShown: false });

  const place = useCallback((morph: boolean) => {
    const state = live.current;
    if (state.sheet) {
      const button = sizes.current.get("button");
      if (button?.w) { width.jump(button.w); height.jump(button.h); radius.jump(button.h / 2); }
      if (state.view === "button") { state.sheetShown = false; return; }
      const size = sizes.current.get(state.view);
      if (!size?.h) return;
      // The sheet arrives already at its face's height; afterwards it springs between faces and follows rows that grow on their own.
      if (!state.sheetShown || state.reduced || (!morph && state.settled)) { sheetHeight.jump(size.h); state.sheetShown = true; return; }
      const run = {};
      state.run = run;
      state.settled = false;
      animate(sheetHeight, size.h, SMOOTH).then(() => { if (state.run === run) state.settled = true; });
      return;
    }
    const size = sizes.current.get(state.view);
    if (!size || !size.w) return;
    const r = state.view === "button" ? size.h / 2 : state.view === "sent" ? 26 : 28;
    const last = state.last;
    if (!morph && Math.abs(last.w - size.w) < .5 && Math.abs(last.h - size.h) < .5) return;
    state.last = size;
    if (!state.measured || state.reduced || (!morph && state.settled)) { width.jump(size.w); height.jump(size.h); radius.jump(r); state.measured = true; return; }
    const transition = size.w * size.h >= last.w * last.h ? GROW : SHRINK;
    // Only the latest flight may declare the shape settled; an interrupted one resolves early and must not.
    const run = {};
    state.run = run;
    state.settled = false;
    Promise.all([animate(width, size.w, transition), animate(height, size.h, transition), animate(radius, r, transition)]).then(() => { if (state.run === run) state.settled = true; });
  }, [height, radius, sheetHeight, width]);

  const onSize = useCallback((id: View, size: Size) => {
    sizes.current.set(id, size);
    if (id === live.current.view) place(false);
  }, [place]);

  useLayoutEffect(() => { live.current.reduced = reduced; }, [reduced]);
  useLayoutEffect(() => {
    const state = live.current;
    if (state.sheet === sheet) return;
    Object.assign(state, { sheet, measured: false, settled: true, sheetShown: false, last: { w: 0, h: 0 } });
    place(false);
  }, [place, sheet]);
  useLayoutEffect(() => {
    if (live.current.view === view) return;
    live.current.view = view;
    place(true);
  }, [place, view]);

  const pendingFocus = useRef<"button" | "copy" | "done" | "access" | "option" | null>(null);
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    if (target === "option") { (sheetRef.current ?? rootRef.current)?.querySelector<HTMLElement>("[role='option'][aria-selected='true']")?.focus({ preventScroll: true }); return; }
    ({ button: buttonRef, copy: copyRef, done: doneRef, access: accessRef })[target].current?.focus({ preventScroll: true });
  }, [view, accessOpen]);

  const go = (next: View) => {
    setDirection(order[view] >= 1 && order[next] >= 1 ? Math.sign(order[next] - order[view]) : 0);
    setView(next);
  };

  const openPanel = () => { pendingFocus.current = "copy"; setError(null); go("panel"); };
  const within = (node: Node | null) => !!node && (!!rootRef.current?.contains(node) || !!sheetRef.current?.contains(node));
  const close = useCallback((restore = true) => {
    const focus = document.activeElement;
    if (restore && (rootRef.current?.contains(focus) || sheetRef.current?.contains(focus))) pendingFocus.current = "button";
    // Once the send is confirmed the picks are spent; closing a draft keeps them for next time.
    if (view === "sent") { setPicked([]); setSources({}); }
    setDirection(0);
    setAccessOpen(false);
    setHint(false);
    setView("button");
  }, [view]);

  // A press outside folds the panel back into the button.
  const opened = view !== "button";
  useEffect(() => {
    if (!opened) return;
    const down = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !sheetRef.current?.contains(target)) close(false);
    };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }, [close, opened]);

  // The page under the phone sheet holds still while it is up.
  const sheetUp = sheet && opened;
  useEffect(() => {
    if (!sheetUp) return;
    const root = document.documentElement, previous = root.style.overflow;
    root.style.overflow = "hidden";
    return () => { root.style.overflow = previous; };
  }, [sheetUp]);

  /** A fling or a pull past a third of the way down closes the sheet; anything less springs back. */
  const onSheetDragEnd = (_: unknown, info: PanInfo) => {
    const tall = sheetRef.current?.offsetHeight ?? 400;
    if (info.offset.y > Math.min(120, tall / 3) || info.velocity.y > 600) close();
  };

  const onKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented || view === "button") return;
    event.preventDefault();
    if (accessOpen) { pendingFocus.current = "access"; setAccessOpen(false); return; }
    close();
  };

  /* Copy settles on its result in place; the button keeps one width for every label. */
  const copyTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);
  const copyLink = async () => {
    window.clearTimeout(copyTimer.current);
    try {
      await navigator.clipboard.writeText(link);
      setCopy("done");
      announce("Link copied");
      onCopy?.(level);
    } catch {
      setCopy("error");
      announce("Couldn’t copy the link");
    }
    copyTimer.current = window.setTimeout(() => setCopy("idle"), 1800);
  };

  const runChannel = async (channel: ShareChannel) => {
    if (channelState[channel.id] === "busy") return;
    setChannelState(all => ({ ...all, [channel.id]: "busy" }));
    let result: Status = "done";
    try { await onChannel?.(channel.id); } catch { result = "error"; }
    setChannelState(all => ({ ...all, [channel.id]: result }));
    announce(result === "done" ? `${channel.label}: ${channel.doneLabel}` : `${channel.label} failed`);
    window.setTimeout(() => setChannelState(all => all[channel.id] === result ? { ...all, [channel.id]: "idle" } : all), 2000);
  };

  const toggle = (person: SharePerson, node: HTMLElement | null) => {
    setError(null);
    setHint(false);
    if (picked.includes(person.id)) {
      setPicked(list => list.filter(id => id !== person.id));
      announce(`${person.name} removed`);
      return;
    }
    const rect = node?.getBoundingClientRect();
    if (rect) setSources(all => ({ ...all, [person.id]: { x: rect.left, y: rect.top, w: rect.width, h: rect.height, t: performance.now() } }));
    setPicked(list => [...list, person.id]);
    announce(`${person.name} added`);
  };

  /** A new chip reports where its avatar sits; the copy starts on the recent avatar and springs there on the panel's own layer. */
  const land = (person: SharePerson, own: DOMRect) => {
    const source = sources[person.id], body = bodyRef.current?.getBoundingClientRect();
    if (!source || !body) return;
    const flight: Flight = {
      id: person.id, key: source.t, src: person.avatar,
      from: { x: source.x - body.left, y: source.y - body.top, w: source.w, h: source.h, t: source.t },
      to: { x: own.left - body.left, y: own.top - body.top, w: own.width, h: own.height, t: source.t },
    };
    setFlights(list => [...list.filter(item => item.id !== person.id), flight]);
  };

  const shake = useMotionValue(0);
  const token = useRef(0);
  const send = async () => {
    if (sending) return;
    if (!chosen.length) {
      setHint(true);
      announce("Pick someone to send to");
      if (!reduced) animate(shake, 0, { type: "spring", stiffness: 900, damping: 12, velocity: -260 });
      return;
    }
    const run = ++token.current;
    setSending(true);
    setError(null);
    try {
      await onSend?.({ people: chosen, access: level });
    } catch {
      if (run !== token.current) return;
      setSending(false);
      setError("Couldn’t send. Try again.");
      return;
    }
    if (run !== token.current) return;
    setSending(false);
    setAccessOpen(false);
    if (within(document.activeElement)) pendingFocus.current = "done";
    announce(`Sent to ${listNames(chosen)}`);
    go("sent");
  };

  const undo = () => { pendingFocus.current = "copy"; announce("Back to sharing. Nothing was sent."); go("panel"); };

  const onAccessKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const steps: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
    if (!(event.key in steps)) return;
    event.preventDefault();
    const radios = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[role='option']"));
    const at = radios.indexOf(document.activeElement as HTMLElement);
    radios[(at + steps[event.key] + radios.length) % radios.length]?.focus();
  };
  const pickAccess = (value: string) => { setLevel(value); pendingFocus.current = "access"; setAccessOpen(false); };

  const row = reduced ? stillRow : rowVariants;
  const text = swap(reduced);
  const copyLabel = copy === "done" ? "Copied" : copy === "error" ? "Retry" : "Copy";

  const panelFace = <Face key="panel" id="panel" direction={direction} reduced={reduced} onSize={onSize} className={styles.panel}>
          <div ref={bodyRef} role="dialog" aria-labelledby={`${uid}-title`} className={styles.panelBody}>
            <div className={styles.flyers} aria-hidden="true">
              {flights.map(flight => <motion.img key={`${flight.id}-${flight.key}`} src={flight.src} alt="" className={styles.flyer}
                style={{ left: flight.to.x, top: flight.to.y, width: flight.to.w, height: flight.to.h }}
                initial={{ x: flight.from.x + flight.from.w / 2 - (flight.to.x + flight.to.w / 2), y: flight.from.y + flight.from.h / 2 - (flight.to.y + flight.to.h / 2), scale: flight.from.w / flight.to.w }}
                animate={{ x: 0, y: 0, scale: 1 }} transition={FLY}
                onAnimationComplete={() => setFlights(list => list.filter(item => item !== flight))} />)}
            </div>
            <motion.div className={styles.header} variants={row}>
              <p id={`${uid}-title`} className={styles.title}>Share “{title}”</p>
              <button type="button" className={styles.iconButton} aria-label="Close" onClick={() => close()}><X size={16} strokeWidth={1.75} aria-hidden="true" /></button>
            </motion.div>

            <motion.div className={styles.linkGroup} variants={row}>
              <div className={styles.linkRow}>
                <Link2 className={styles.muted} size={16} strokeWidth={1.75} aria-hidden="true" />
                <span className={styles.link} title={link}>{link}</span>
                <button ref={copyRef} type="button" className={styles.copy} data-state={copy} onClick={() => void copyLink()} aria-label={copy === "idle" ? "Copy link" : undefined}>
                  <span className={styles.sizer} aria-hidden="true"><span>Copied</span><span>Retry</span><span>Copy</span></span>
                  <span className={styles.copyFace}>
                    <AnimatePresence initial={false} mode="popLayout">
                      <motion.span key={copy} className={styles.copyLabel} {...text}>
                        {copy === "done" ? <Check size={14} strokeWidth={2} aria-hidden="true" /> : copy === "error" ? <CircleAlert size={14} strokeWidth={1.75} aria-hidden="true" /> : <Copy size={14} strokeWidth={1.75} aria-hidden="true" />}
                        {copyLabel}
                      </motion.span>
                    </AnimatePresence>
                  </span>
                </button>
              </div>
              <button ref={accessRef} type="button" className={styles.accessTrigger} aria-expanded={accessOpen} aria-controls={`${uid}-access`} onClick={() => { if (!accessOpen) pendingFocus.current = "option"; setAccessOpen(!accessOpen); }}>
                <span className={styles.accessIcon} aria-hidden="true">{currentAccess?.icon}</span>
                <span className={styles.accessText}>
                  <AnimatePresence initial={false} mode="popLayout">
                    <motion.span key={currentAccess?.value} className={styles.accessLines} {...text}>
                      <span className={styles.accessLabel}>{currentAccess?.label}</span>
                      <span className={styles.accessDescription}>{currentAccess?.description}</span>
                    </motion.span>
                  </AnimatePresence>
                </span>
                <motion.span className={styles.muted} aria-hidden="true" initial={false} animate={{ rotate: accessOpen ? 180 : 0 }} transition={reduced ? { duration: 0 } : SNAP}><ChevronDown size={16} strokeWidth={1.75} /></motion.span>
              </button>
              <AnimatePresence initial={false}>
                {accessOpen && <motion.div key="access" id={`${uid}-access`} className={styles.accessList} role="listbox" aria-label="Who can open the link" onKeyDown={onAccessKey}
                  initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                  transition={reduced ? { duration: 0, opacity: { duration: .12 } } : { height: SMOOTH, opacity: { duration: .18, ease: enter } }}>
                  <div className={styles.accessOptions}>
                    {access.map(item => <button key={item.value} type="button" role="option" aria-selected={item.value === level} tabIndex={item.value === level ? 0 : -1} className={styles.accessOption} onClick={() => pickAccess(item.value)}>
                      <span className={styles.accessIcon} aria-hidden="true">{item.icon}</span>
                      <span className={styles.accessLines}><span className={styles.accessLabel}>{item.label}</span><span className={styles.accessDescription}>{item.description}</span></span>
                      <Check className={styles.accessCheck} size={16} strokeWidth={1.75} aria-hidden="true" />
                    </button>)}
                  </div>
                </motion.div>}
              </AnimatePresence>
            </motion.div>

            {channels.length > 0 && <motion.div className={styles.channels} variants={row} role="group" aria-label="Share to">
              {channels.map(channel => {
                const state = channelState[channel.id] ?? "idle";
                return <button key={channel.id} type="button" className={styles.channel} data-state={state} aria-busy={state === "busy" || undefined} onClick={() => void runChannel(channel)}>
                  <span className={styles.channelIcon} aria-hidden="true">
                    <AnimatePresence initial={false} mode="popLayout">
                      <motion.span key={state === "done" ? "done" : state === "busy" ? "busy" : "icon"} className={styles.channelGlyph} {...text}>
                        {state === "done" ? <Check size={16} strokeWidth={2} /> : state === "busy" ? <LoaderCircle className={styles.spinner} size={16} strokeWidth={1.75} /> : channel.icon}
                      </motion.span>
                    </AnimatePresence>
                  </span>
                  <span className={styles.channelLabel}>
                    <AnimatePresence initial={false} mode="popLayout">
                      <motion.span key={state === "done" ? "done" : state === "error" ? "error" : "idle"} {...text}>{state === "done" ? channel.doneLabel : state === "error" ? "Failed" : channel.label}</motion.span>
                    </AnimatePresence>
                  </span>
                </button>;
              })}
            </motion.div>}

            <motion.div className={styles.divider} variants={row} aria-hidden="true" />

            <motion.div className={styles.toBlock} variants={row} style={{ x: shake }}>
              <span id={`${uid}-to`} className={styles.sectionLabel}>Send to</span>
              <div className={styles.toRow} data-empty={!chosen.length || undefined}>
                <AnimatePresence>
                  {!chosen.length && <motion.span key="empty" className={styles.toEmpty} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: .08 } }} data-hint={hint || undefined}>
                    {hint ? "Pick someone to send to" : "Pick people below"}
                  </motion.span>}
                </AnimatePresence>
                <ul className={styles.chips} data-chips="" aria-labelledby={`${uid}-to`}>
                  <AnimatePresence initial={false} mode="popLayout">
                    {chosen.map(person => <Chip key={person.id} person={person} source={sources[person.id]} reduced={reduced} hidden={flights.some(flight => flight.id === person.id)} onLand={rect => land(person, rect)} onRemove={() => toggle(person, null)} />)}
                  </AnimatePresence>
                </ul>
              </div>
            </motion.div>

            <motion.div className={styles.recents} variants={row} role="group" aria-label="Recent people">
              {people.map(person => {
                const on = picked.includes(person.id);
                return <button key={person.id} type="button" className={styles.person} aria-pressed={on} aria-label={person.name} data-on={on || undefined}
                  onClick={event => toggle(person, event.currentTarget.querySelector("img"))}>
                  <span className={styles.personAvatar}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- avatars come from consumer URLs */}
                    <img src={person.avatar} alt="" width={80} height={80} />
                    <span className={styles.badge} aria-hidden="true"><Check size={10} strokeWidth={3} /></span>
                  </span>
                  <span className={styles.personName} aria-hidden="true">{person.name.split(" ")[0]}</span>
                </button>;
              })}
            </motion.div>

            <motion.div className={styles.footer} variants={row}>
              <AnimatePresence initial={false}>
                {error && <motion.p key="error" className={styles.error} role="alert" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={reduced ? { duration: .1 } : SMOOTH}>
                  <CircleAlert size={14} strokeWidth={1.75} aria-hidden="true" />{error}
                </motion.p>}
              </AnimatePresence>
              <button type="button" className={styles.send} data-empty={!chosen.length || undefined} aria-disabled={sending || undefined} onClick={() => void send()}>
                <AnimatePresence initial={false} mode="popLayout">
                  <motion.span key={sending ? "sending" : chosen.length ? "ready" : "empty"} className={styles.sendLabel} {...text}>
                    {sending
                      ? <><LoaderCircle className={styles.spinner} size={16} strokeWidth={1.75} aria-hidden="true" />Sending</>
                      : chosen.length ? <>Send to{"\u00a0"}<Count value={chosen.length} reduced={reduced} />{"\u00a0"}{chosen.length === 1 ? "person" : "people"}</> : "Send"}
                  </motion.span>
                </AnimatePresence>
              </button>
            </motion.div>
          </div>
        </Face>;

  const sentFace = <Face key="sent" id="sent" direction={direction} reduced={reduced} onSize={onSize} className={styles.sent}>
          <div role="status" className={styles.sentBody}>
            <motion.div className={styles.stack} variants={row} aria-hidden="true">
              {chosen.slice(0, 3).map((person, index) => <motion.span key={person.id} className={styles.stackAvatar} style={{ zIndex: 3 - index }}
                initial={reduced ? false : { x: -10 * index, opacity: 0 }} animate={{ x: 0, opacity: 1 }} transition={{ x: SNAP, opacity: { duration: .2 }, delay: .1 + index * .05 }}>
                {/* eslint-disable-next-line @next/next/no-img-element -- avatars come from consumer URLs */}
                <img src={person.avatar} alt="" width={64} height={64} />
              </motion.span>)}
              {chosen.length > 3 && <span className={`${styles.stackAvatar} ${styles.more}`}>+{chosen.length - 3}</span>}
              <motion.span className={styles.sentCheck} initial={reduced ? false : { scale: .4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ ...SNAP, delay: .22 }}>
                <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                  <motion.path d="M5.5 12.5l4.2 4.2 8.8-9.2" initial={reduced ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: .3, ease: enter, delay: .3 }} />
                </svg>
              </motion.span>
            </motion.div>
            <motion.p className={styles.sentTitle} variants={row}>Sent to {chosen.length ? listNames(chosen) : "your team"}</motion.p>
            <motion.p className={styles.sentMeta} variants={row}>{currentAccess?.label} · {currentAccess?.description.toLowerCase()}</motion.p>
            <motion.div className={styles.sentActions} variants={row}>
              <button type="button" className={styles.ghostButton} onClick={undo}>Undo</button>
              <button ref={doneRef} type="button" className={styles.doneButton} onClick={() => close()}>Done</button>
            </motion.div>
          </div>
        </Face>;

  return <div ref={rootRef} className={[styles.root, className].filter(Boolean).join(" ")} data-align={align} data-view={sheet ? "button" : view} onKeyDown={onKey}>
    <span className={`${styles.pill} ${styles.ghost}`} aria-hidden="true"><Share size={16} strokeWidth={1.75} />{label}</span>

    <motion.div className={styles.shape} style={{ width, height, borderRadius: radius }}>
      <AnimatePresence initial={false} custom={direction}>
        {(view === "button" || sheet) && <Face key="button" id="button" direction={direction} reduced={reduced} onSize={onSize}>
          <button ref={buttonRef} type="button" className={`${styles.pill} ${styles.trigger}`} aria-haspopup="dialog" aria-expanded={sheet && opened} onClick={() => { if (view === "button") openPanel(); else close(); }}>
            <Share size={16} strokeWidth={1.75} aria-hidden="true" />{label}
          </button>
        </Face>}

        {!sheet && view === "panel" && panelFace}
        {!sheet && view === "sent" && sentFace}
      </AnimatePresence>
    </motion.div>

    {/* Phones: the same faces in a sheet that slides up from the bottom edge. Events still bubble to the root through the portal. */}
    {sheet && createPortal(<AnimatePresence>
      {opened && <Scrim key="scrim" reduced={reduced} />}
      {opened && <motion.div key="sheet" ref={sheetRef} className={styles.sheet}
        initial={reduced ? { opacity: 0 } : { y: "110%" }} animate={reduced ? { opacity: 1 } : { y: 0 }}
        exit={reduced ? { opacity: 0, transition: { duration: .12 } } : { y: "110%", transition: SHEET_OUT }}
        transition={reduced ? { duration: .16 } : SHEET_IN}
        drag="y" dragListener={false} dragControls={drag} dragConstraints={{ top: 0, bottom: 0 }} dragElastic={{ top: .04, bottom: 1 }} dragMomentum={false} onDragEnd={onSheetDragEnd}>
        <div className={styles.grabber} aria-hidden="true" onPointerDown={event => drag.start(event)} />
        <motion.div className={styles.sheetFaces} style={{ height: sheetHeight }}>
          <AnimatePresence initial={false} custom={direction}>
            {view === "panel" && panelFace}
            {view === "sent" && sentFace}
          </AnimatePresence>
        </motion.div>
      </motion.div>}
    </AnimatePresence>, document.body)}

    <span className={styles.srOnly} role="status" aria-live="polite"><span key={announcement.id}>{announcement.text}</span></span>
  </div>;
}

/** The count in the send button rolls up or down one digit at a time. */
function Count({ value, reduced }: { value: number; reduced: boolean }) {
  const [previous, setPrevious] = useState(value);
  const [dir, setDir] = useState(1);
  if (value !== previous) { setPrevious(value); setDir(value > previous ? 1 : -1); }
  return <span className={styles.count}>
    <AnimatePresence initial={false} mode="popLayout" custom={dir}>
      <motion.span key={value} className={styles.countDigit} custom={dir}
        variants={{ enter: (d: number) => ({ y: reduced ? 0 : `${d * 70}%`, opacity: 0 }), rest: { y: 0, opacity: 1 }, exit: (d: number) => ({ y: reduced ? 0 : `${d * -70}%`, opacity: 0 }) }}
        initial="enter" animate="rest" exit="exit" transition={reduced ? { duration: .1 } : { y: SNAP, opacity: { duration: .14 } }}>{value}</motion.span>
    </AnimatePresence>
  </span>;
}

export default ShareSheet;
