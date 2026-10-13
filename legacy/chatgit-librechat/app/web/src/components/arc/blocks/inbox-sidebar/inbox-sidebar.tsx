"use client";

import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, PointerEvent, ReactElement, RefObject } from "react";
import { AnimatePresence, LayoutGroup, animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import type { Variants } from "motion/react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Archive, Check, ChevronRight, Clock3, Ellipsis, FileText, FolderInput, Inbox, Mail, Send, ShieldAlert, SquarePen, Star, Tag, Trash2, Undo2, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AnimatedCounter } from "../../animated-counter/animated-counter";
import { Avatar } from "../../avatar/avatar";
import { Button } from "../../button/button";
import { Tooltip } from "../../tooltip/tooltip";
import { motionTokens } from "../../lib/motion-tokens";
import styles from "./inbox-sidebar.module.css";

type Box = "inbox" | "snoozed" | "sent" | "drafts" | "archive" | "spam" | "trash";
type LabelId = "design" | "launch" | "research" | "hiring";
type View = Box | "starred" | "all" | `label-${LabelId}`;
type Message = { id: string; name: string; photo?: string; subject: string; preview: string; time: string; box: Box; unread: boolean; starred: boolean; labels: LabelId[] };
type Item = { id: View; label: string; icon?: LucideIcon; tone?: LabelId };
type Ghost = { key: number; name: string; photo?: string; subject: string };
type Point = { x: number; y: number };
type Press = { id: string; x: number; y: number; dragging: boolean; cancelled: boolean; over: string | null };

/** Height of the drag preview pill, used to center it on the pointer and on a folder row. */
const GHOST = 40;
const emma = { name: "Emma Collins", photo: "/media/people/emma-collins.jpg" };
const marcus = { name: "Marcus Johnson", photo: "/media/people/marcus-johnson.jpg" };
const ava = { name: "Ava Mitchell", photo: "/media/people/ava-mitchell.jpg" };
const jasmine = { name: "Jasmine Brooks", photo: "/media/people/jasmine-brooks.jpg" };
const people = [emma, marcus, ava, jasmine];

const mail = (id: string, from: { name: string; photo?: string }, subject: string, preview: string, time: string, box: Box, extra: Partial<Message> = {}): Message => ({ id, ...from, subject, preview, time, box, unread: false, starred: false, labels: [], ...extra });

const seed: Message[] = [
  mail("m1", emma, "Onboarding prototype, round two", "I tightened the handoff between steps two and three and left notes on the empty states.", "9:42 AM", "inbox", { unread: true, labels: ["design"] }),
  mail("m2", ava, "Launch checklist: four items left", "Pricing copy and the status page are the last blockers before Tuesday.", "9:10 AM", "inbox", { unread: true, starred: true, labels: ["launch"] }),
  mail("m3", marcus, "Menu and table states for Thursday", "Two interaction questions before the review, plus what already feels right.", "8:18 AM", "inbox", { unread: true, labels: ["design"] }),
  mail("m4", jasmine, "Preview build 412 is live", "Keyboard fixes and the reduced motion pass are in. The link is in the thread.", "Yesterday", "inbox", { labels: ["launch"] }),
  mail("m5", emma, "Interview notes from the Lisbon sessions", "Six sessions, three strong patterns. The export flow came up in every one.", "Yesterday", "inbox", { labels: ["research"] }),
  mail("m6", marcus, "Portfolio review for the senior role", "Two candidates stood out. Could you take the second review on Friday?", "Sun", "inbox", { unread: true, labels: ["hiring"] }),
  mail("m7", ava, "Status page copy, final pass", "I shortened the incident states and matched the tone of the docs.", "Sat", "inbox", { labels: ["launch"] }),
  mail("m8", jasmine, "Quarterly research readout", "Back on Thursday, once the survey numbers are in.", "Until Thu", "snoozed", { labels: ["research"] }),
  mail("m9", emma, "Icon set licensing", "The vendor replied. We can pick this up when legal has the terms.", "Until Fri", "snoozed"),
  mail("m10", marcus, "Re: Menu and table states", "Thursday at two works. I will bring the focus order notes.", "8:31 AM", "sent", { labels: ["design"] }),
  mail("m11", ava, "Pricing page review", "Left comments on the plan table and the order of the questions.", "Yesterday", "sent", { labels: ["launch"] }),
  mail("m12", jasmine, "Re: Preview build 412", "Two small things on the settings page before we share it wider.", "Yesterday", "drafts"),
  mail("m13", jasmine, "Radius scale merged", "The new radius tokens are live on main. Nothing to migrate.", "Sep 15", "archive", { starred: true, labels: ["design"] }),
  mail("m14", ava, "Offsite agenda", "The room is booked for the 30th. The draft agenda is attached.", "Sep 14", "archive"),
  mail("m15", { name: "Design Awards Guild" }, "Your studio has been shortlisted", "Confirm your entry fee today to secure a jury review.", "Sun", "spam", { unread: true }),
];

const folders: Item[] = [
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "starred", label: "Starred", icon: Star },
  { id: "snoozed", label: "Snoozed", icon: Clock3 },
  { id: "sent", label: "Sent", icon: Send },
  { id: "drafts", label: "Drafts", icon: FileText },
  { id: "archive", label: "Archive", icon: Archive },
];
const labelItems: Item[] = [
  { id: "label-design", label: "Design review", tone: "design" },
  { id: "label-launch", label: "Launch", tone: "launch" },
  { id: "label-research", label: "Research", tone: "research" },
  { id: "label-hiring", label: "Hiring", tone: "hiring" },
];
const moreItems: Item[] = [
  { id: "all", label: "All mail", icon: Mail },
  { id: "spam", label: "Spam", icon: ShieldAlert },
  { id: "trash", label: "Trash", icon: Trash2 },
];
const allItems = [...folders, ...labelItems, ...moreItems];
const order = allItems.map(item => item.id);
const moveTargets: View[] = ["inbox", "starred", "snoozed", "archive", "spam", "trash"];
const empty: Record<string, [string, string]> = {
  inbox: ["Inbox zero", "Everything is filed. New mail will land here."],
  starred: ["No starred messages", "Star a message or drag it here to keep it close."],
  snoozed: ["Nothing snoozed", "Snoozed messages return to your inbox on time."],
  sent: ["Nothing sent yet", "Messages you send will appear here."],
  drafts: ["No drafts", "Close a message while writing and it waits here."],
  archive: ["Archive is empty", "Archived messages stay out of the way here."],
  all: ["No mail", "Messages from every folder appear here."],
  spam: ["No spam", "Messages marked as spam are kept for 30 days."],
  trash: ["Trash is empty", "Deleted messages are kept here for 30 days."],
  label: ["Nothing with this label", "Drag a message onto the label to add it."],
};
const blank = { to: "", subject: "", body: "" };

const nameOf = (view: View) => allItems.find(item => item.id === view)?.label ?? "";
const labelOf = (view: View) => view.startsWith("label-") ? view.slice(6) as LabelId : null;
const isView = (key: string | null): key is View => key !== null && (order as string[]).includes(key);
const strongCount = (view: View) => view === "inbox" || view === "spam";

function inView(message: Message, view: View) {
  const label = labelOf(view);
  const filed = message.box !== "spam" && message.box !== "trash";
  if (label) return filed && message.labels.includes(label);
  if (view === "starred") return filed && message.starred;
  if (view === "all") return filed && message.box !== "drafts";
  return message.box === view;
}

/** Inbox and Spam count unread mail; Starred, Snoozed, Drafts, and labels count everything they hold. */
function countOf(messages: Message[], view: View) {
  if (strongCount(view)) return messages.filter(message => message.box === view && message.unread).length;
  if (view === "sent" || view === "archive" || view === "all" || view === "trash") return 0;
  return messages.filter(message => inView(message, view)).length;
}

function canMove(message: Message, to: View) {
  const label = labelOf(to);
  if (label) return message.box !== "drafts" && !message.labels.includes(label);
  if (to === "starred") return message.box !== "drafts" && !message.starred;
  if (to === "sent" || to === "drafts" || to === "all") return false;
  return message.box === "drafts" ? to === "trash" : message.box !== to;
}

function moveTo(message: Message, to: View): Message {
  const label = labelOf(to);
  if (label) return { ...message, labels: [...message.labels, label] };
  if (to === "starred") return { ...message, starred: true };
  return { ...message, box: to as Box, unread: strongCount(to) ? message.unread : false };
}

function describe(message: Message, to: View) {
  const subject = `“${message.subject}”`;
  if (labelOf(to)) return `Labeled ${subject} ${nameOf(to)}`;
  if (to === "starred") return `Starred ${subject}`;
  if (to === "archive") return `Archived ${subject}`;
  return `Moved ${subject} to ${nameOf(to)}`;
}

function quickAction(message: Message): { to: View; label: string; icon: LucideIcon } {
  if (message.box === "drafts") return { to: "trash", label: "Delete draft", icon: Trash2 };
  if (message.box === "archive" || message.box === "spam" || message.box === "trash") return { to: "inbox", label: "Move to Inbox", icon: Inbox };
  return { to: "archive", label: "Archive", icon: Archive };
}

function personFor(value: string) {
  const query = value.trim().toLowerCase();
  if (query.length < 3) return undefined;
  return people.find(person => person.name.toLowerCase().startsWith(query) || query.startsWith(person.name.split(" ")[0].toLowerCase()));
}

/** Where the drag preview sits so its avatar covers the row's avatar, in the shell's own coordinates. */
function homeOf(shell: HTMLElement | null, row: HTMLElement | undefined): Point | null {
  const avatar = row?.querySelector("[data-avatar]");
  if (!shell || !avatar) return null;
  const outer = shell.getBoundingClientRect(), rect = avatar.getBoundingClientRect();
  return { x: rect.left - outer.left - shell.clientLeft - 6, y: rect.top - outer.top - shell.clientTop + rect.height / 2 - GHOST / 2 };
}

const pageSlide: Variants = {
  enter: (direction: number) => ({ opacity: 0, y: direction * 14, filter: `blur(${motionTokens.blur.soft}px)` }),
  center: { opacity: 1, y: 0, filter: "blur(0px)", transition: { y: motionTokens.spring.smooth, default: { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] } } },
  exit: (direction: number) => ({ opacity: 0, y: direction * -10, filter: `blur(${motionTokens.blur.subtle}px)`, transition: { duration: motionTokens.duration.exit, ease: [...motionTokens.ease.standard] } }),
};
const pageFade: Variants = { enter: { opacity: 0 }, center: { opacity: 1, transition: { duration: motionTokens.duration.instant } }, exit: { opacity: 0, transition: { duration: motionTokens.duration.instant } } };
const rise = {
  initial: { opacity: 0, y: "0.3em", filter: `blur(${motionTokens.blur.soft}px)` },
  animate: { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] } },
  exit: { opacity: 0, y: "-0.3em", filter: `blur(${motionTokens.blur.subtle}px)`, transition: { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.standard] } },
};
const fade = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } };

/** Rail width in px. The open width is the --full custom property. */
const RAIL = 64;
/** At or below this width the sidebar starts as the rail, and the toggle can still open it. */
const NARROW = 720;
/** Below this width the sidebar becomes an off-canvas drawer over the list. Matches the container queries in the CSS. */
const COMPACT = 600;
const still = { duration: 0 };

export interface InboxSidebarProps {
  /** Start with the sidebar collapsed to its icon rail. The sidebar is expanded by default. */
  defaultCollapsed?: boolean;
  /** Called when the sidebar collapses to its icon rail or expands again, from the toggle or the [ shortcut. */
  onCollapsedChange?: (collapsed: boolean) => void;
}

/** The width follows one value from 0 (rail) to 1 (open) on the smooth spring, so the message list reflows every frame instead of jumping. */
function useRailWidth(rail: boolean, reduce: boolean, settled: RefObject<boolean>) {
  const open = useMotionValue(rail ? 0 : 1);
  const width = useTransform(open, value => `calc(${RAIL}px + (var(--full) - ${RAIL}px) * ${value})`);
  useEffect(() => {
    const target = rail ? 0 : 1;
    // The first measurement lands before paint, so the sidebar starts at its size instead of springing on load.
    if (reduce || !settled.current) { open.jump(target); return; }
    const controls = animate(open, target, motionTokens.spring.smooth);
    return () => controls.stop();
  }, [rail, reduce, open, settled]);
  return width;
}

/** [ toggles the rail while the block is on screen. It stays out of text fields, menus, and dialogs. */
function useRailShortcut(frame: RefObject<HTMLElement | null>, onToggle: () => void) {
  const handle = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (event.key !== "[" || event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
    const node = frame.current;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (!node || (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.closest('[role="menu"], [role="dialog"]')))) return;
    const box = node.getBoundingClientRect();
    if (!box.width || box.bottom < 0 || box.top > window.innerHeight) return;
    event.preventDefault();
    onToggle();
  });
  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => handle(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
}

/** In the rail every item names itself on hover and focus. Opening the rail disarms any open tip. */
function RailTip({ enabled = true, label, note, shortcut, side = "right", children }: { enabled?: boolean; label: string; note?: string; shortcut?: string; side?: "right" | "bottom"; children: ReactElement }) {
  const [open, setOpen] = useState(false);
  if (!enabled && open) setOpen(false);
  return <TooltipPrimitive.Root open={enabled && open} onOpenChange={next => setOpen(next && enabled)}>
    <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content className={styles.tip} side={side} sideOffset={side === "right" ? 14 : 8} collisionPadding={8}>{label}{note && <span className={styles.tipNote}>{note}</span>}{shortcut && <kbd>{shortcut}</kbd>}</TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  </TooltipPrimitive.Root>;
}

/** The divider in the panel icon slides with the sidebar, so the control shows what it is about to do. */
function PanelGlyph({ collapsed, reduce }: { collapsed: boolean; reduce: boolean }) {
  return <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
    <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="3.5" />
    <motion.path d="M8.25 4.25v11.5" initial={false} animate={{ x: collapsed ? -2.5 : 0 }} transition={reduce ? still : motionTokens.spring.smooth} />
  </svg>;
}

export function InboxSidebar({ defaultCollapsed = false, onCollapsedChange }: InboxSidebarProps) {
  const id = useId();
  const reduce = useReducedMotion();
  // null follows the width: a narrow shell starts as the rail, a wide one open. The toggle sets it for good.
  const [userRail, setUserRail] = useState<boolean | null>(defaultCollapsed ? true : null);
  const [size, setSize] = useState<{ compact: boolean; narrow: boolean; ready: boolean }>({ compact: false, narrow: false, ready: false });
  const { compact, narrow } = size;
  const collapsed = userRail ?? narrow;
  // On phones the sidebar is a drawer: always full width, off canvas until opened.
  const rail = !compact && collapsed;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerShown = compact && drawerOpen;
  const settled = useRef(false);
  const width = useRailWidth(rail, !!reduce, settled);
  const drawer = useMotionValue(0);
  const [messages, setMessages] = useState(seed);
  const [view, setView] = useState<View>("inbox");
  const [direction, setDirection] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [labelsOpen, setLabelsOpen] = useState(true);
  const [moreOpen, setMoreOpen] = useState(false);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState(blank);
  const [toError, setToError] = useState(false);
  const [status, setStatus] = useState({ key: 0, text: "Drag a message onto a folder, or use Move to" });
  const [undo, setUndo] = useState<Message | null>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [landing, setLanding] = useState<{ id: string; to: View } | null>(null);
  const [pulse, setPulse] = useState<{ view: View; key: number } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const composeRef = useRef<HTMLButtonElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const targets = useRef(new Map<string, HTMLElement>());
  const rows = useRef(new Map<string, HTMLElement>());
  const press = useRef<Press | null>(null);
  const suppressClick = useRef(false);
  const pendingFocus = useRef<HTMLElement | null>(null);
  const returnFocus = useRef(false);
  const springTimer = useRef(0);
  const keys = useRef(0);
  const pulses = useRef(0);
  const created = useRef(0);
  // The label's fade follows composing, not mounting: AnimatePresence can bring back the same exiting button, which would keep a faded label.
  const composedOnce = useRef(false);
  const gx = useMotionValue(0), gy = useMotionValue(0), gs = useMotionValue(1), go = useMotionValue(0);

  const visible = messages.filter(message => inView(message, view));
  const unread = visible.filter(message => message.unread).length;
  const dragging = dragId ? messages.find(message => message.id === dragId) : undefined;
  const recipient = personFor(draft.to);
  const instant = { duration: 0 };
  const snappy = reduce ? instant : motionTokens.spring.snappy;
  const smooth = reduce ? instant : motionTokens.spring.smooth;
  const morph = reduce ? instant : motionTokens.spring.morph;
  const emptyCopy = empty[labelOf(view) ? "label" : view];
  // A message in flight is left out of its destination's count until it lands there.
  const count = (target: View) => countOf(landing?.to === target ? messages.filter(message => message.id !== landing.id) : messages, target);
  const register = (store: RefObject<Map<string, HTMLElement>>, key: string) => (node: HTMLElement | null) => { if (node) store.current.set(key, node); else store.current.delete(key); };

  useLayoutEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const measure = (width: number) => setSize(current => {
      const next = { compact: width < COMPACT, narrow: width >= COMPACT && width <= NARROW, ready: true };
      return current.compact === next.compact && current.narrow === next.narrow && current.ready ? current : next;
    });
    measure(node.getBoundingClientRect().width);
    const frame = requestAnimationFrame(() => { settled.current = true; });
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect.width));
    observer.observe(node);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);

  // The drawer only exists on phones; growing past the breakpoint puts it away.
  if (!compact && drawerOpen) setDrawerOpen(false);

  // One value from 0 (off canvas) to 1 (open) drives the drawer slide and the backdrop together, so a tap mid-slide reverses it smoothly.
  useEffect(() => {
    const target = drawerShown ? 1 : 0;
    if (reduce || !settled.current) { drawer.jump(target); return; }
    const controls = animate(drawer, target, motionTokens.spring.smooth);
    return () => controls.stop();
  }, [drawerShown, reduce, drawer]);

  const drawerFocus = useRef(false);
  useEffect(() => {
    if (drawerShown) {
      drawerFocus.current = true;
      const current = sidebarRef.current?.querySelector<HTMLElement>('[aria-current="page"]') ?? sidebarRef.current?.querySelector<HTMLElement>("button");
      current?.focus({ preventScroll: true });
    } else if (drawerFocus.current) {
      drawerFocus.current = false;
      toggleRef.current?.focus({ preventScroll: true });
    }
  }, [drawerShown]);

  function setRail(next: boolean) {
    if (next === collapsed) return;
    setUserRail(next);
    say(next ? "Sidebar collapsed" : "Sidebar expanded");
    onCollapsedChange?.(next);
  }
  function setDrawer(next: boolean) { setDrawerOpen(next); }
  useRailShortcut(rootRef, () => {
    if (composing || dragId) return;
    if (compact) setDrawer(!drawerOpen); else setRail(!collapsed);
  });

  useEffect(() => {
    if (composing) toRef.current?.focus({ preventScroll: true });
    else if (returnFocus.current) { returnFocus.current = false; composeRef.current?.focus({ preventScroll: true }); }
  }, [composing]);

  const onEscape = useEffectEvent((event: globalThis.KeyboardEvent) => {
    const current = press.current;
    if (event.key !== "Escape" || !current?.dragging || current.cancelled) return;
    current.cancelled = true;
    endDrag();
    returnHome(current.id);
    say("Move cancelled");
  });
  useEffect(() => {
    if (!dragId) return;
    const listener = (event: globalThis.KeyboardEvent) => onEscape(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [dragId]);

  function rootKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!drawerShown || event.defaultPrevented) return;
    if (event.key === "Escape") { event.preventDefault(); setDrawer(false); return; }
    // The open drawer is modal: Tab cycles through its own controls.
    if (event.key !== "Tab") return;
    const items = [...(sidebarRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [])];
    const first = items[0], last = items[items.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    else if (!sidebarRef.current?.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
  }

  /** A swipe toward the edge pulls the drawer with the finger; letting go past halfway, or with a flick, puts it away, otherwise it springs back. */
  const swipe = useRef<{ id: number; x: number; y: number; width: number; active: boolean; last: number; time: number; velocity: number } | null>(null);
  const [swiping, setSwiping] = useState(false);
  function swipeDown(event: PointerEvent<HTMLDivElement>) {
    if (!drawerShown || event.pointerType === "mouse" || !event.isPrimary) return;
    swipe.current = { id: event.pointerId, x: event.clientX, y: event.clientY, width: event.currentTarget.offsetWidth + 64, active: false, last: event.clientX, time: event.timeStamp, velocity: 0 };
  }
  function swipeMove(event: PointerEvent<HTMLDivElement>) {
    const current = swipe.current;
    if (!current || current.id !== event.pointerId) return;
    const dx = event.clientX - current.x, dy = event.clientY - current.y;
    if (!current.active) {
      if (Math.hypot(dx, dy) < 8) return;
      // Vertical moves scroll the folders, and a swipe away from the edge does nothing.
      if (dx > 0 || Math.abs(dy) > Math.abs(dx)) { swipe.current = null; return; }
      current.active = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      drawer.stop();
      setSwiping(true);
    }
    const elapsed = event.timeStamp - current.time;
    if (elapsed > 0) current.velocity = (event.clientX - current.last) / elapsed;
    current.last = event.clientX; current.time = event.timeStamp;
    drawer.set(Math.min(1, Math.max(0, 1 + dx / current.width)));
  }
  function swipeUp(event: PointerEvent<HTMLDivElement>) {
    const current = swipe.current;
    if (!current || current.id !== event.pointerId) return;
    swipe.current = null;
    if (!current.active) return;
    setSwiping(false);
    if (event.type !== "pointercancel" && (drawer.get() < .55 || current.velocity < -.4)) { setDrawer(false); return; }
    if (reduce) drawer.jump(1); else animate(drawer, 1, motionTokens.spring.smooth);
  }

  function say(text: string) { setStatus(current => ({ key: current.key + 1, text })); }

  function local(element: Element) {
    const shell = shellRef.current;
    const outer = shell?.getBoundingClientRect(), rect = element.getBoundingClientRect();
    return { x: rect.left - (outer?.left ?? 0) - (shell?.clientLeft ?? 0), y: rect.top - (outer?.top ?? 0) - (shell?.clientTop ?? 0), height: rect.height };
  }

  /** The folder row, or the collapsed section that holds it. */
  function targetFor(to: View) {
    const section = labelOf(to) ? "toggle-labels" : to === "spam" || to === "trash" || to === "all" ? "toggle-more" : "";
    // A closed drawer is off canvas, so mail flies into the button that opens it.
    if (compact && !drawerOpen) return toggleRef.current ?? undefined;
    return targets.current.get(to) ?? targets.current.get(section);
  }

  function land(to: View, key: number) {
    if (keys.current !== key) return;
    setGhost(null);
    setLanding(null);
    setPulse({ view: to, key: ++pulses.current });
  }

  /** The preview arcs into the folder: x eases in and out while y leads, then it shrinks and fades as it arrives. */
  function fly(to: View, key: number) {
    const target = targetFor(to);
    if (!target || reduce) { land(to, key); return; }
    const end = local(target);
    const duration = motionTokens.duration.considered + .06;
    animate(gx, end.x + 6, { duration, ease: [...motionTokens.ease.inOut] });
    animate(gy, end.y + end.height / 2 - GHOST / 2, { duration, ease: [...motionTokens.ease.standard] });
    animate(gs, .34, { duration, ease: [...motionTokens.ease.inOut] });
    animate(go, [1, 1, 0], { duration, times: [0, .7, 1] }).then(() => land(to, key));
  }

  function launch(from: Point | null, to: View, messageId: string, content: Omit<Ghost, "key">) {
    const key = ++keys.current;
    setLanding({ id: messageId, to });
    if (!from || reduce || !targetFor(to)) { land(to, key); return; }
    setGhost({ key, name: content.name, photo: content.photo, subject: content.subject });
    gx.jump(from.x); gy.jump(from.y); gs.jump(1); go.jump(1);
    fly(to, key);
  }

  function change(message: Message, next: Message, text: string, to: View | null, source: "row" | "menu" | "drag") {
    if (inView(message, view) && !inView(next, view)) {
      const ids = visible.map(item => item.id), index = ids.indexOf(message.id);
      const nextId = ids[index + 1] ?? ids[index - 1];
      const focusTarget = (nextId ? rows.current.get(nextId) : undefined) ?? headingRef.current;
      if (source === "menu") pendingFocus.current = focusTarget;
      else if (rows.current.get(message.id)?.parentElement?.contains(document.activeElement)) requestAnimationFrame(() => focusTarget?.focus({ preventScroll: true }));
      if (selected === message.id) setSelected(null);
    }
    const from = to && source !== "drag" ? homeOf(shellRef.current, rows.current.get(message.id)) : null;
    setMessages(list => list.map(item => item.id === message.id ? next : item));
    say(text);
    if (!to) return;
    setUndo(message);
    if (source === "drag") { setLanding({ id: message.id, to }); fly(to, keys.current); }
    else launch(from, to, message.id, message);
  }

  function move(message: Message, to: View, source: "row" | "menu" | "drag") {
    if (canMove(message, to)) change(message, moveTo(message, to), describe(message, to), to, source);
  }

  function toggleStar(message: Message) {
    change(message, { ...message, starred: !message.starred }, message.starred ? `Removed the star from “${message.subject}”` : `Starred “${message.subject}”`, null, "row");
    if (!message.starred) setPulse({ view: "starred", key: ++pulses.current });
  }

  function undoLast() {
    if (!undo) return;
    setMessages(list => list.map(item => item.id === undo.id ? undo : item));
    setUndo(null);
    say(`Restored “${undo.subject}”`);
    requestAnimationFrame(() => (rows.current.get(undo.id) ?? headingRef.current)?.focus({ preventScroll: true }));
  }

  function openMessage(message: Message) {
    if (suppressClick.current) return;
    setSelected(message.id);
    if (!message.unread) return;
    setMessages(list => list.map(item => item.id === message.id ? { ...item, unread: false } : item));
    say(`Marked “${message.subject}” as read`);
  }

  function choose(next: View) {
    if (next === view) return;
    setDirection(order.indexOf(next) > order.indexOf(view) ? 1 : -1);
    setView(next);
    setSelected(null);
    viewportRef.current?.scrollTo({ top: 0 });
  }

  function pick(next: View) {
    choose(next);
    if (drawerShown) setDrawerOpen(false);
  }

  function rowKey(event: KeyboardEvent<HTMLButtonElement>, message: Message) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "e") { event.preventDefault(); move(message, quickAction(message).to, "row"); }
    if (key === "s") { event.preventDefault(); toggleStar(message); }
  }

  function pointerDown(event: PointerEvent<HTMLButtonElement>, message: Message) {
    if (event.pointerType === "touch" || event.button !== 0 || composing) return;
    press.current = { id: message.id, x: event.clientX, y: event.clientY, dragging: false, cancelled: false, over: null };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function pointerMove(event: PointerEvent<HTMLButtonElement>, message: Message) {
    const current = press.current, shell = shellRef.current;
    if (!current || current.id !== message.id || current.cancelled || !shell) return;
    if (!current.dragging) {
      if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6) return;
      const home = homeOf(shell, rows.current.get(message.id));
      if (!home) return;
      current.dragging = true;
      setGhost({ key: ++keys.current, name: message.name, photo: message.photo, subject: message.subject });
      setDragId(message.id);
      gx.jump(home.x); gy.jump(home.y); gs.jump(1); go.jump(0);
      animate(go, 1, { duration: motionTokens.duration.instant });
    }
    const outer = shell.getBoundingClientRect();
    const x = event.clientX - outer.left - shell.clientLeft - 20, y = event.clientY - outer.top - shell.clientTop - GHOST / 2;
    // The preview glides from the row's avatar to the pointer, then follows it on a tight spring.
    if (reduce) { gx.jump(x); gy.jump(y); } else { animate(gx, x, motionTokens.spring.responsive); animate(gy, y, motionTokens.spring.responsive); }
    let found: string | null = null;
    for (const [key, element] of targets.current) {
      const rect = element.getBoundingClientRect();
      if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) { found = key; break; }
    }
    if (found === current.over) return;
    current.over = found;
    setOver(found);
    window.clearTimeout(springTimer.current);
    // Resting on a collapsed section opens it, so its folders can take the drop.
    if (found === "toggle-labels" || found === "toggle-more") springTimer.current = window.setTimeout(() => (found === "toggle-labels" ? setLabelsOpen : setMoreOpen)(true), 600);
  }

  function endDrag() {
    window.clearTimeout(springTimer.current);
    setDragId(null);
    setOver(null);
  }

  function returnHome(messageId: string) {
    const home = homeOf(shellRef.current, rows.current.get(messageId)), key = keys.current;
    if (reduce || !home) { setGhost(null); return; }
    animate(gx, home.x, motionTokens.spring.smooth);
    animate(gy, home.y, motionTokens.spring.smooth);
    animate(go, 0, { duration: motionTokens.duration.exit, delay: .14 }).then(() => { if (keys.current === key) setGhost(null); });
  }

  function pointerUp(message: Message) {
    const current = press.current;
    press.current = null;
    if (!current?.dragging) return;
    // The click that follows a drag must not open the message.
    suppressClick.current = true;
    window.setTimeout(() => { suppressClick.current = false; }, 0);
    if (current.cancelled) return;
    endDrag();
    if (isView(current.over) && canMove(message, current.over)) move(message, current.over, "drag");
    else returnHome(message.id);
  }

  function pointerCancel() {
    const current = press.current;
    press.current = null;
    if (!current?.dragging || current.cancelled) return;
    endDrag();
    returnHome(current.id);
  }

  function composed(box: "sent" | "drafts"): Message {
    return { id: `new-${++created.current}`, name: recipient?.name ?? (draft.to.trim() || "No recipient"), photo: recipient?.photo, subject: draft.subject.trim() || "No subject", preview: draft.body.trim() || "No message", time: "Now", box, unread: false, starred: false, labels: [] };
  }

  function composerOrigin() {
    const panel = composerRef.current;
    if (!panel) return null;
    const rect = local(panel);
    return { x: rect.x + 12, y: rect.y + 8 };
  }

  function closeComposer(mode: "save" | "discard") {
    const hasContent = Boolean(draft.to.trim() || draft.subject.trim() || draft.body.trim());
    const from = composerOrigin();
    returnFocus.current = true;
    setComposing(false);
    setToError(false);
    setDraft(blank);
    if (!hasContent) return;
    if (mode === "discard") { say("Draft discarded"); return; }
    const message = composed("drafts");
    setMessages(list => [message, ...list]);
    say(`Saved “${message.subject}” to Drafts.`);
    launch(from, "drafts", message.id, message);
  }

  function send(event?: FormEvent) {
    event?.preventDefault();
    if (!draft.to.trim()) { setToError(true); toRef.current?.focus(); return; }
    const from = composerOrigin();
    const message = composed("sent");
    returnFocus.current = true;
    setComposing(false);
    setDraft(blank);
    setMessages(list => [message, ...list]);
    say(`Sent “${message.subject}” to ${message.name}.`);
    launch(from, "sent", message.id, message);
  }

  function composerKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); closeComposer("save"); }
    else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); send(); }
  }

  function navItem(item: Item) {
    const Icon = item.icon;
    const value = count(item.id);
    const strong = strongCount(item.id);
    const pulseKey = pulse && pulse.view === item.id ? pulse.key : 0;
    const drop = dragging ? canMove(dragging, item.id) ? over === item.id ? "over" : "ready" : "off" : undefined;
    const amount = `${value} ${strong ? "unread" : value === 1 ? "message" : "messages"}`;
    return <li key={item.id}>
      <RailTip enabled={rail && !dragging} label={item.label} note={value > 0 ? amount : undefined}>
        <button ref={register(targets, item.id)} type="button" className={styles.navItem} aria-current={view === item.id ? "page" : undefined} data-drop={drop} onClick={() => pick(item.id)}>
          {view === item.id && <motion.span layoutId="nav-active" className={styles.navActive} transition={morph} />}
          <motion.span key={pulseKey} className={styles.navIcon} initial={pulseKey && !reduce ? { scale: 1.35 } : false} animate={{ scale: 1 }} transition={motionTokens.spring.snappy} aria-hidden="true">
            {Icon ? <Icon size={16} strokeWidth={1.75} /> : <i className={styles.swatch} data-tone={item.tone} />}
          </motion.span>
          <span className={styles.navLabel}>{item.label}</span>
          <span className={styles.navTrail}>
            <AnimatePresence initial={false}>
              {value > 0 && <motion.span key="count" className={styles.navCount} data-strong={strong || undefined} aria-hidden="true" initial={{ opacity: 0, scale: .6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .6 }} transition={snappy}><AnimatedCounter value={value} /></motion.span>}
            </AnimatePresence>
          </span>
          {/* In the rail, unread mail becomes a dot on the icon's corner and plain totals step aside. */}
          {strong && <span className={styles.navDot} aria-hidden="true">
            <AnimatePresence initial={false}>
              {value > 0 && <motion.span key="dot" className={styles.navDotFace} initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={snappy} />}
            </AnimatePresence>
          </span>}
          {value > 0 && <span className={styles.srOnly}>, {amount}</span>}
        </button>
      </RailTip>
    </li>;
  }

  function section(key: "labels" | "more", title: string, Icon: LucideIcon, open: boolean, setOpen: (open: boolean) => void, items: Item[]) {
    const bodyId = `${id}-${key}`, toggle = `toggle-${key}`;
    return <div className={styles.section}>
      {/* In the rail the heading becomes a hairline, and its icon keeps the section within reach. */}
      <span className={styles.sectionRule} aria-hidden="true" />
      <RailTip enabled={rail && !dragging} label={title}>
        <button ref={register(targets, toggle)} type="button" className={styles.sectionToggle} aria-expanded={open} aria-controls={open ? bodyId : undefined} data-active={!open && items.some(item => item.id === view) || undefined} data-drop={dragging && !open && over === toggle ? "over" : undefined} onClick={() => setOpen(!open)}>
          <Icon className={styles.sectionIcon} size={16} strokeWidth={1.75} aria-hidden="true" />
          <span className={styles.sectionTitle}>{title}</span>
          <ChevronRight className={styles.chevron} size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </RailTip>
      <AnimatePresence initial={false}>
        {open && <motion.div key="body" id={bodyId} className={styles.sectionBody} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={smooth}>
          <ul className={styles.navList}>{items.map(navItem)}</ul>
        </motion.div>}
      </AnimatePresence>
    </div>;
  }

  function row(message: Message) {
    const quick = quickAction(message);
    const Quick = quick.icon;
    const prefix = message.box === "sent" ? "To " : message.box === "drafts" ? "Draft to " : "";
    const traits = [message.unread && "unread", message.starred && "starred", ...message.labels.map(label => `labeled ${nameOf(`label-${label}`)}`)].filter(Boolean).join(", ");
    return <motion.li key={message.id} className={styles.row} data-unread={message.unread || undefined} data-selected={selected === message.id || undefined} data-dragging={dragId === message.id || undefined} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={smooth}>
      <button ref={register(rows, message.id)} type="button" className={styles.rowMain} aria-keyshortcuts="E S" onClick={() => openMessage(message)} onKeyDown={event => rowKey(event, message)} onPointerDown={event => pointerDown(event, message)} onPointerMove={event => pointerMove(event, message)} onPointerUp={() => pointerUp(message)} onPointerCancel={pointerCancel} onDragStart={event => event.preventDefault()}>
        <AnimatePresence initial={false}>{message.unread && <motion.span key="dot" className={styles.dot} initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={snappy} />}</AnimatePresence>
        <Avatar name={message.name} src={message.photo} size="md" data-avatar="" />
        <span className={styles.rowText}>
          <span className={styles.rowTop}>
            <span className={styles.sender}>{prefix}{message.name}</span>
            <span className={styles.rowLabels} aria-hidden="true"><AnimatePresence initial={false}>{message.labels.map(label => <motion.i key={label} className={styles.swatch} data-tone={label} initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={snappy} />)}</AnimatePresence></span>
            <span className={styles.meta}>
              <AnimatePresence initial={false}>{message.starred && <motion.span key="star" className={styles.starMark} aria-hidden="true" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={snappy}><Star size={12} strokeWidth={1.75} /></motion.span>}</AnimatePresence>
              <time>{message.time}</time>
            </span>
          </span>
          <span className={styles.line}><span className={styles.subject}>{message.subject}</span><span className={styles.preview}>{message.preview}</span></span>
        </span>
        {traits && <span className={styles.srOnly}>, {traits}</span>}
      </button>
      <div className={styles.actions}>
        <Tooltip content={message.starred ? "Unstar" : "Star"}><button type="button" className={styles.action} aria-label={`Star “${message.subject}”`} aria-pressed={message.starred} onClick={() => toggleStar(message)}><Star size={16} strokeWidth={1.75} aria-hidden="true" /></button></Tooltip>
        <Tooltip content={quick.label}><button type="button" className={styles.action} aria-label={`${quick.label}: “${message.subject}”`} onClick={() => move(message, quick.to, "row")}><Quick size={16} strokeWidth={1.75} aria-hidden="true" /></button></Tooltip>
        <Menu.Root>
          <Tooltip content="Move to"><Menu.Trigger asChild><button type="button" className={styles.action} aria-label={`Move “${message.subject}”`}><FolderInput size={16} strokeWidth={1.75} aria-hidden="true" /></button></Menu.Trigger></Tooltip>
          <Menu.Portal>
            <Menu.Content className={`${styles.menu} ${styles.tones}`} align="end" sideOffset={6} collisionPadding={12} loop onCloseAutoFocus={event => { const next = pendingFocus.current; if (!next) return; event.preventDefault(); pendingFocus.current = null; next.focus({ preventScroll: true }); }}>
              <Menu.Label className={styles.menuLabel}>Move to</Menu.Label>
              {moveTargets.filter(to => to !== message.box).map(to => {
                const Icon = allItems.find(item => item.id === to)?.icon ?? Mail;
                return <Menu.Item key={to} className={styles.menuItem} disabled={!canMove(message, to)} onSelect={() => move(message, to, "menu")}><Icon size={16} strokeWidth={1.75} aria-hidden="true" /><span>{nameOf(to)}</span>{to === "starred" && message.starred && <Check className={styles.menuCheck} size={15} strokeWidth={1.75} aria-hidden="true" />}</Menu.Item>;
              })}
              <Menu.Separator className={styles.menuSeparator} />
              <Menu.Label className={styles.menuLabel}>Label as</Menu.Label>
              {labelItems.map(item => <Menu.Item key={item.id} className={styles.menuItem} disabled={!canMove(message, item.id)} onSelect={() => move(message, item.id, "menu")}><i className={styles.swatch} data-tone={item.tone} aria-hidden="true" /><span>{item.label}</span>{item.tone && message.labels.includes(item.tone) && <Check className={styles.menuCheck} size={15} strokeWidth={1.75} aria-hidden="true" />}</Menu.Item>)}
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
      </div>
    </motion.li>;
  }

  const EmptyIcon = allItems.find(item => item.id === view)?.icon ?? Tag;

  /** One Compose button grows into the composer: in the sidebar on wider shells, beside the title on phones. */
  const composeButton = <AnimatePresence initial={false}>
    {!composing && <RailTip key="compose" enabled={rail || compact} label="Compose">
      <motion.button ref={composeRef} layoutId="compose" type="button" className={styles.compose} style={{ borderRadius: 10 }} transition={morph} aria-haspopup="dialog" aria-label={compact ? "Compose" : undefined} onClick={() => { composedOnce.current = true; setComposing(true); setToError(false); }}>
        <motion.span layout="position" className={styles.composeInner} initial={composedOnce.current ? { opacity: 0 } : false} animate={composing ? { opacity: 0, transition: { duration: .06 } } : { opacity: 1, transition: { duration: motionTokens.duration.fast, delay: reduce ? 0 : .14 } }}>
          <SquarePen size={16} strokeWidth={1.75} aria-hidden="true" /><span className={styles.composeText}>Compose</span>
        </motion.span>
      </motion.button>
    </RailTip>}
  </AnimatePresence>;
  const toggleLabel = compact ? drawerShown ? "Close mailboxes" : "Open mailboxes" : collapsed ? "Expand sidebar" : "Collapse sidebar";

  return (
    <div ref={rootRef} className={`${styles.root} ${styles.tones}`} onKeyDown={rootKey}>
      <TooltipPrimitive.Provider delayDuration={250} skipDelayDuration={300}>
        <LayoutGroup id={id}>
          <motion.section ref={shellRef} className={styles.shell} aria-label="Mail" style={{ "--drawer": drawer } as Record<string, unknown>} data-dragging={dragId ? "" : undefined} data-ready={size.ready || undefined} data-drawer={drawerShown || undefined}>
            <motion.div ref={sidebarRef} id={`${id}-sidebar`} className={styles.sidebar} style={{ width }} data-rail={rail || undefined} data-swiping={swiping || undefined} inert={compact && !drawerOpen} onPointerDown={swipeDown} onPointerMove={swipeMove} onPointerUp={swipeUp} onPointerCancel={swipeUp} aria-label={compact ? "Mailboxes" : undefined} role={compact ? "dialog" : undefined} aria-modal={drawerShown || undefined}>
              {!compact && <div className={styles.composeSlot}>{composeButton}</div>}
              <motion.nav layoutScroll className={styles.nav} aria-label="Mailboxes">
                <ul className={styles.navList}>{folders.map(navItem)}</ul>
                {section("labels", "Labels", Tag, labelsOpen, setLabelsOpen, labelItems)}
                {section("more", "More", Ellipsis, moreOpen, setMoreOpen, moreItems)}
              </motion.nav>
              <RailTip enabled={rail} label="Sofia Ramirez" note="sofia@fieldnote.studio">
                <div className={styles.account}>
                  <Avatar name="Sofia Ramirez" src="/media/people/sofia-ramirez.jpg" size="sm" status="online" />
                  <span className={styles.accountText}><span>Sofia Ramirez</span><span>sofia@fieldnote.studio</span></span>
                </div>
              </RailTip>
            </motion.div>
            {/* Dims the list behind the open drawer; a tap anywhere on it puts the drawer away. */}
            <div className={styles.backdrop} aria-hidden="true" onClick={() => setDrawer(false)} />

            <div className={styles.pane} inert={drawerShown}>
              <header className={styles.paneHeader}>
                <div className={styles.paneTitle}>
                  <RailTip label={toggleLabel} shortcut="[" side="bottom">
                    <button ref={toggleRef} type="button" className={styles.paneToggle} aria-label={toggleLabel} aria-expanded={compact ? drawerShown : !collapsed} aria-controls={`${id}-sidebar`} aria-keyshortcuts="[" onClick={() => compact ? setDrawer(!drawerOpen) : setRail(!collapsed)}><PanelGlyph collapsed={compact ? !drawerShown : collapsed} reduce={!!reduce} /></button>
                  </RailTip>
                  <h2 ref={headingRef} id={`${id}-title`} className={styles.title} tabIndex={-1}>
                    <AnimatePresence mode="popLayout" initial={false}>
                      <motion.span key={view} className={styles.titleText} {...(reduce ? fade : rise)}>{nameOf(view)}</motion.span>
                    </AnimatePresence>
                  </h2>
                </div>
                <p className={styles.summary}>
                  <span className={styles.num}><AnimatedCounter value={visible.length} /></span>{visible.length === 1 ? " message" : " messages"}
                  {/* The unread clause opens and closes its own width, so the message count beside it glides instead of jumping. */}
                  <AnimatePresence initial={false}>{unread > 0 && <motion.span key="unread" className={styles.unreadClause} initial={{ opacity: 0, width: 0 }} animate={{ opacity: 1, width: "auto" }} exit={{ opacity: 0, width: 0 }} transition={morph}><span>, <span className={styles.num}><AnimatedCounter value={unread} /></span> unread</span></motion.span>}</AnimatePresence>
                </p>
                {compact && <div className={styles.headerCompose}>{composeButton}</div>}
              </header>

              <div ref={viewportRef} className={styles.viewport}>
                <AnimatePresence mode="popLayout" initial={false} custom={direction}>
                  <motion.div key={view} className={styles.page} custom={direction} variants={reduce ? pageFade : pageSlide} initial="enter" animate="center" exit="exit">
                    <ul className={styles.list} aria-labelledby={`${id}-title`}>
                      <AnimatePresence initial={false}>{visible.map(message => row(message))}</AnimatePresence>
                    </ul>
                    <AnimatePresence initial={false}>
                      {visible.length === 0 && <motion.div key="empty" className={styles.empty} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={reduce ? instant : { ...motionTokens.spring.smooth, delay: .12 }}>
                        <EmptyIcon size={24} strokeWidth={1.5} aria-hidden="true" />
                        <p>{emptyCopy[0]}</p>
                        <span>{emptyCopy[1]}</span>
                      </motion.div>}
                    </AnimatePresence>
                  </motion.div>
                </AnimatePresence>
              </div>

              <div className={styles.statusBar}>
                <p className={styles.srOnly} role="status" aria-live="polite">{status.text}</p>
                <p className={styles.statusText} aria-hidden="true">
                  <AnimatePresence mode="popLayout" initial={false}><motion.span key={status.key} {...(reduce ? fade : rise)}>{status.text}</motion.span></AnimatePresence>
                </p>
                <AnimatePresence initial={false}>
                  {undo && <motion.div key="undo" {...fade} transition={{ duration: motionTokens.duration.fast }}><Button type="button" variant="ghost" size="sm" onClick={undoLast}><Undo2 size={15} strokeWidth={1.75} aria-hidden="true" />Undo</Button></motion.div>}
                </AnimatePresence>
              </div>
            </div>

            <AnimatePresence>
              {composing && <motion.div ref={composerRef} key="composer" layoutId="compose" className={styles.composer} style={{ borderRadius: 16 }} transition={morph} role="dialog" aria-labelledby={`${id}-compose-title`} onKeyDown={composerKey}>
                <motion.form layout="position" className={styles.composerForm} noValidate onSubmit={send} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: .2, delay: reduce ? 0 : .1 } }} exit={{ opacity: 0, transition: { duration: .08 } }}>
                  <header className={styles.composerHeader}>
                    <h3 id={`${id}-compose-title`}>New message</h3>
                    <Tooltip content="Save draft and close"><button type="button" className={styles.action} aria-label="Save draft and close" onClick={() => closeComposer("save")}><X size={16} strokeWidth={1.75} aria-hidden="true" /></button></Tooltip>
                  </header>
                  <div className={styles.field} data-invalid={toError || undefined}>
                    <label htmlFor={`${id}-to`}>To</label>
                    <input ref={toRef} id={`${id}-to`} value={draft.to} autoComplete="off" placeholder="Name or email" aria-invalid={toError || undefined} aria-describedby={toError ? `${id}-to-error` : undefined} onChange={event => { const to = event.target.value; setDraft(current => ({ ...current, to })); setToError(false); }} />
                    <AnimatePresence initial={false}>{recipient && <motion.span key={recipient.name} className={styles.recipient} initial={{ opacity: 0, scale: .6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .6 }} transition={snappy}><Avatar name={recipient.name} src={recipient.photo} size="sm" /></motion.span>}</AnimatePresence>
                  </div>
                  <AnimatePresence initial={false}>
                    {toError && <motion.p key="error" id={`${id}-to-error`} className={styles.error} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={smooth}>Add a recipient before sending</motion.p>}
                  </AnimatePresence>
                  <div className={styles.field}>
                    <label htmlFor={`${id}-subject`}>Subject</label>
                    <input id={`${id}-subject`} value={draft.subject} autoComplete="off" onChange={event => { const subject = event.target.value; setDraft(current => ({ ...current, subject })); }} />
                  </div>
                  <textarea className={styles.body} aria-label="Message" placeholder="Write a message" rows={6} value={draft.body} onChange={event => { const body = event.target.value; setDraft(current => ({ ...current, body })); }} />
                  <footer className={styles.composerFooter}>
                    <Button type="submit" size="sm"><Send size={15} strokeWidth={1.75} aria-hidden="true" />Send</Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => closeComposer("discard")}>Discard</Button>
                  </footer>
                </motion.form>
              </motion.div>}
            </AnimatePresence>

            {ghost && <motion.div key={ghost.key} className={styles.ghost} style={{ x: gx, y: gy, scale: gs, opacity: go, originX: 0, originY: .5 }} aria-hidden="true">
              <Avatar name={ghost.name} src={ghost.photo} size="sm" /><span>{ghost.subject}</span>
            </motion.div>}
          </motion.section>
        </LayoutGroup>
      </TooltipPrimitive.Provider>
    </div>
  );
}

export default InboxSidebar;
