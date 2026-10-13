"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { AnimatePresence, LayoutGroup, motion, useMotionValue, useReducedMotion, useTransform, type Transition, type Variants } from "motion/react";
import { ChevronRight, FileText, FlaskConical, Folder, House, Inbox, MessageSquareText, Route, Settings, X, type LucideIcon } from "lucide-react";
import { AnimatedCounter } from "../../animated-counter/animated-counter";
import { Avatar } from "../../avatar/avatar";
import { AvatarGroup } from "../../avatar-group/avatar-group";
import { Badge, type BadgeTone } from "../../badge/badge";
import { Tooltip } from "../../tooltip/tooltip";
import { motionTokens } from "../../lib/motion-tokens";
import styles from "./sidebar-rail.module.css";

const FULL = 240;
const RAIL = 64;
/** Below this shell width the sidebar leaves the layout and opens as a sheet. Matches the container query in the CSS. */
const COMPACT = 480;
/** Below this shell width the opened sidebar floats over the page from the rail instead of squeezing it, the way a tablet drawer does. */
const FLOAT = 640;
/** Below this shell width the sidebar starts as the icon rail, so the page keeps room to read. It can still be opened. */
const ROOMY = 760;
/** How long a picked row's highlight gets to land before a floating panel or sheet slides away. */
const SETTLE_MS = 200;

const people = {
  emma: { name: "Emma Collins", src: "/media/people/emma-collins.jpg" },
  marcus: { name: "Marcus Johnson", src: "/media/people/marcus-johnson.jpg" },
  ava: { name: "Ava Mitchell", src: "/media/people/ava-mitchell.jpg" },
  jasmine: { name: "Jasmine Brooks", src: "/media/people/jasmine-brooks.jpg" },
  sofia: { name: "Sofia Ramirez", src: "/media/people/sofia-ramirez.jpg" },
};
type Person = keyof typeof people;
type Row = { title: string; detail: string; person: Person; status: string; tone: BadgeTone; when: string };
type Page = { title: string; parent?: string; summary: string; team: Person[]; stats: { label: string; value: number; suffix?: string }[]; list: string; rows: Row[] };
type Entry = { id: string; label: string; icon?: LucideIcon; count?: number; children?: Entry[] };

const sections: { id: string; heading?: string; items: Entry[] }[] = [
  { id: "main", items: [{ id: "home", label: "Home", icon: House }, { id: "inbox", label: "Inbox", icon: Inbox, count: 4 }] },
  { id: "workspace", heading: "Workspace", items: [
    { id: "projects", label: "Projects", icon: Folder, children: [{ id: "checkout", label: "Checkout redesign" }, { id: "onboarding", label: "Mobile onboarding" }, { id: "system", label: "Design system 2.0" }] },
    { id: "roadmap", label: "Roadmap", icon: Route },
    { id: "research", label: "Research", icon: FlaskConical },
  ] },
  { id: "pinned", heading: "Pinned", items: [{ id: "launch", label: "Q4 launch plan", icon: FileText }, { id: "critique", label: "Critique notes", icon: MessageSquareText }] },
];
const settingsEntry: Entry = { id: "settings", label: "Settings", icon: Settings };

const pages: Record<string, Page> = {
  home: { title: "Home", summary: "Three reviews need you before Thursday's critique.", team: ["marcus", "sofia", "ava"], stats: [{ label: "Assigned to you", value: 12 }, { label: "In review", value: 3 }, { label: "Shipped this week", value: 5 }], list: "Needs you", rows: [
    { title: "Address step spacing", detail: "Checkout redesign", person: "marcus", status: "In review", tone: "info", when: "Today" },
    { title: "Onboarding empty states", detail: "Mobile onboarding", person: "sofia", status: "In progress", tone: "neutral", when: "Wed" },
    { title: "Dark mode token audit", detail: "Design system 2.0", person: "ava", status: "Blocked", tone: "warning", when: "Fri" },
  ] },
  inbox: { title: "Inbox", summary: "Four unread, most of them about the checkout flow.", team: ["marcus", "jasmine", "ava"], stats: [{ label: "Unread", value: 4 }, { label: "Mentions", value: 2 }, { label: "Review requests", value: 1 }], list: "Unread", rows: [
    { title: "Marcus commented on Address step", detail: "Can the postcode field move above the city?", person: "marcus", status: "Comment", tone: "neutral", when: "9:42 AM" },
    { title: "Jasmine asked for your review", detail: "Payment sheet, second pass", person: "jasmine", status: "Review", tone: "info", when: "8:15 AM" },
    { title: "Ava mentioned you", detail: "Surface levels in the token audit", person: "ava", status: "Mention", tone: "neutral", when: "Yesterday" },
  ] },
  checkout: { title: "Checkout redesign", parent: "Projects", summary: "Fewer steps from bag to confirmation. Beta opens October 14.", team: ["marcus", "jasmine", "emma", "ava"], stats: [{ label: "Screens", value: 38 }, { label: "Open issues", value: 7 }, { label: "Days to beta", value: 22 }], list: "Screens in flight", rows: [
    { title: "Address step", detail: "Autocomplete and postcode order", person: "marcus", status: "In review", tone: "info", when: "Today" },
    { title: "Payment sheet", detail: "Apple Pay and saved cards", person: "jasmine", status: "In progress", tone: "neutral", when: "Thu" },
    { title: "Confirmation", detail: "Receipt, tracking, and next steps", person: "emma", status: "Done", tone: "success", when: "Mon" },
  ] },
  onboarding: { title: "Mobile onboarding", parent: "Projects", summary: "A shorter first run that ends in a real first project.", team: ["sofia", "emma"], stats: [{ label: "Screens", value: 24 }, { label: "Open issues", value: 4 }, { label: "Test sessions", value: 9 }], list: "Screens in flight", rows: [
    { title: "Welcome and sign in", detail: "Passkeys first, email as fallback", person: "sofia", status: "Done", tone: "success", when: "Sep 12" },
    { title: "Workspace setup", detail: "Invite step moved after first project", person: "sofia", status: "In progress", tone: "neutral", when: "Wed" },
    { title: "Empty states", detail: "Starter templates for each role", person: "emma", status: "Not started", tone: "neutral", when: "Oct 2" },
  ] },
  system: { title: "Design system 2.0", parent: "Projects", summary: "New tokens, fewer components, and a dark mode that holds up.", team: ["ava", "jasmine", "emma"], stats: [{ label: "Components", value: 64 }, { label: "Tokens", value: 212 }, { label: "Adoption", value: 71, suffix: "%" }], list: "Workstreams", rows: [
    { title: "Surface levels", detail: "Waiting on the contrast review", person: "ava", status: "Blocked", tone: "warning", when: "Fri" },
    { title: "Button variants", detail: "Four sizes down to three", person: "jasmine", status: "In review", tone: "info", when: "Thu" },
    { title: "Motion tokens", detail: "Springs for panels and highlights", person: "emma", status: "Done", tone: "success", when: "Sep 18" },
  ] },
  roadmap: { title: "Roadmap", summary: "Four bets this quarter. One needs a decision this week.", team: ["marcus", "sofia", "jasmine"], stats: [{ label: "Bets", value: 4 }, { label: "On track", value: 2 }, { label: "At risk", value: 1 }], list: "Q4 bets", rows: [
    { title: "Checkout redesign", detail: "Beta with 5% of traffic", person: "marcus", status: "On track", tone: "success", when: "Oct 14" },
    { title: "Mobile onboarding", detail: "Second usability round", person: "sofia", status: "On track", tone: "success", when: "Nov 3" },
    { title: "Team workspaces", detail: "Needs a pricing decision", person: "jasmine", status: "At risk", tone: "warning", when: "Dec 1" },
  ] },
  research: { title: "Research", summary: "Twelve interviews so far. Checkout friction came up in nine.", team: ["ava", "sofia", "emma"], stats: [{ label: "Interviews", value: 12 }, { label: "Insights", value: 31 }, { label: "Open questions", value: 6 }], list: "Studies", rows: [
    { title: "Returning shoppers", detail: "Six sessions, synthesis ready", person: "ava", status: "Ready", tone: "success", when: "Sep 19" },
    { title: "First run on mobile", detail: "Four sessions booked", person: "sofia", status: "Scheduled", tone: "info", when: "Sep 29" },
    { title: "Checkout drop off", detail: "Survey with 412 responses", person: "emma", status: "Analyzing", tone: "neutral", when: "Oct 1" },
  ] },
  launch: { title: "Q4 launch plan", parent: "Pinned", summary: "Dates, owners, and what has to be true before each launch.", team: ["jasmine", "emma", "sofia", "marcus", "ava"], stats: [{ label: "Milestones", value: 9 }, { label: "Complete", value: 4 }, { label: "Weeks left", value: 11 }], list: "Next milestones", rows: [
    { title: "Beta invite list", detail: "1,200 customers from the waitlist", person: "jasmine", status: "Done", tone: "success", when: "Sep 20" },
    { title: "Launch review", detail: "Go or no go with support and sales", person: "emma", status: "Scheduled", tone: "info", when: "Oct 8" },
    { title: "Support playbook", detail: "Macros for payment questions", person: "sofia", status: "In progress", tone: "neutral", when: "Oct 10" },
  ] },
  critique: { title: "Critique notes", parent: "Pinned", summary: "Decisions from Thursday critiques, newest first.", team: ["jasmine", "sofia", "ava"], stats: [{ label: "Sessions", value: 14 }, { label: "Decisions", value: 38 }, { label: "Follow ups", value: 5 }], list: "Recent decisions", rows: [
    { title: "Payment sheet", detail: "Keep saved cards above the fold", person: "jasmine", status: "Decided", tone: "success", when: "Sep 18" },
    { title: "Onboarding tour", detail: "Cut the tour to three steps", person: "sofia", status: "Decided", tone: "success", when: "Sep 11" },
    { title: "Surface contrast", detail: "Revisit after the token audit", person: "ava", status: "Follow up", tone: "warning", when: "Sep 4" },
  ] },
  settings: { title: "Settings", summary: "Northline workspace, 14 members on the team plan.", team: ["emma", "marcus"], stats: [{ label: "Members", value: 14 }, { label: "Guests", value: 3 }, { label: "Integrations", value: 5 }], list: "Connected tools", rows: [
    { title: "Figma sync", detail: "Libraries and comments", person: "emma", status: "Connected", tone: "success", when: "4 min ago" },
    { title: "Slack digest", detail: "Posts to #design at 9:00 AM", person: "marcus", status: "Daily", tone: "neutral", when: "Today" },
    { title: "Guest access", detail: "Three guests, comment only", person: "emma", status: "Limited", tone: "neutral", when: "Sep 2" },
  ] },
};

const parentLabels = [...new Set(Object.values(pages).flatMap(page => (page.parent ? [page.parent] : [])))];

const curve = (points: readonly number[]) => [...points] as [number, number, number, number];
const instant: Transition = { duration: 0 };

/** Labels leave quickly so they are gone a beat before the rail settles, and return a beat after the width starts opening. */
function labelTiming(collapsed: boolean, reduce: boolean): Transition {
  if (reduce) return instant;
  return collapsed ? { duration: .14, ease: curve(motionTokens.ease.standard) } : { duration: .24, delay: .1, ease: curve(motionTokens.ease.enter) };
}

/** Rail-only marks (dividers and unread dots) arrive once the labels have cleared, and leave first when the rail opens. */
function markTiming(collapsed: boolean, reduce: boolean): Transition {
  if (reduce) return instant;
  return collapsed ? { duration: .2, delay: .16, ease: curve(motionTokens.ease.enter) } : { duration: .1, ease: curve(motionTokens.ease.standard) };
}

const rise: Variants = {
  hidden: { opacity: 0, y: 8, filter: `blur(${motionTokens.blur.soft}px)` },
  shown: { opacity: 1, y: 0, filter: "blur(0px)" },
  gone: { opacity: 0, y: -6, filter: `blur(${motionTokens.blur.subtle}px)` },
};

function RailTip({ enabled, label, note, children }: { enabled: boolean; label: string; note?: string; children: ReactElement }) {
  const [open, setOpen] = useState(false);
  // Closing the rail while a tip is open should not leave it armed for the next collapse.
  if (!enabled && open) setOpen(false);
  return <TooltipPrimitive.Root open={enabled && open} onOpenChange={next => setOpen(next && enabled)}>
    <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content className={styles.tip} side="right" sideOffset={14} collisionPadding={8}>{label}{note && <span className={styles.tipNote}>{note}</span>}</TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  </TooltipPrimitive.Root>;
}

type RowProps = { entry: Entry; nested?: boolean; current: boolean; lit: boolean; expanded?: boolean; turned?: boolean; controls?: string; collapsed: boolean; tips: boolean; layoutId: string; reduce: boolean; onClick: () => void };

function NavRow({ entry, nested, current, lit, expanded, turned, controls, collapsed, tips, layoutId, reduce, onClick }: RowProps) {
  const Icon = entry.icon;
  const fade = labelTiming(collapsed, reduce);
  const mark = markTiming(collapsed, reduce);
  return <RailTip enabled={tips} label={entry.label} note={entry.count ? `${entry.count} unread` : undefined}>
    <button type="button" className={[styles.item, nested ? styles.nested : "", lit ? styles.lit : ""].join(" ")} aria-current={current ? "page" : undefined} aria-expanded={expanded} aria-controls={controls} onClick={onClick}>
      {lit && <motion.span layoutId={layoutId} className={styles.highlight} style={{ borderRadius: 8 }} transition={reduce ? instant : motionTokens.spring.morph} />}
      {Icon && <Icon className={styles.icon} size={16} strokeWidth={1.75} aria-hidden="true" />}
      <motion.span className={styles.label} initial={false} animate={{ opacity: collapsed ? 0 : 1, x: collapsed ? -6 : 0 }} transition={fade}>{entry.label}{entry.count ? <span className={styles.srOnly}>, {entry.count} unread</span> : null}</motion.span>
      {entry.count ? <>
        <motion.span className={styles.count} aria-hidden="true" initial={false} animate={{ opacity: collapsed ? 0 : 1 }} transition={fade}>{entry.count}</motion.span>
        <motion.span className={styles.dot} aria-hidden="true" initial={false} animate={{ opacity: collapsed ? 1 : 0, scale: collapsed ? 1 : .3 }} transition={collapsed && !reduce ? { ...motionTokens.spring.snappy, delay: .16 } : mark} />
      </> : null}
      {turned !== undefined && <motion.span className={styles.chevron} aria-hidden="true" initial={false} animate={{ opacity: collapsed ? 0 : 1, rotate: turned ? 90 : 0 }} transition={{ opacity: fade, rotate: reduce ? instant : motionTokens.spring.snappy }}><ChevronRight size={14} strokeWidth={1.75} /></motion.span>}
    </button>
  </RailTip>;
}

type NavProps = { variant: "side" | "sheet"; baseId: string; collapsed: boolean; active: string; open: Record<string, boolean>; reduce: boolean; onSelect: (id: string) => void; onGroup: (id: string) => void };

function Navigation({ variant, baseId, collapsed, active, open, reduce, onSelect, onGroup }: NavProps) {
  const tips = variant === "side" && collapsed;
  const layoutId = `${variant}-active`;
  const fade = labelTiming(collapsed, reduce);
  const mark = markTiming(collapsed, reduce);
  const height = reduce ? instant : motionTokens.spring.smooth;
  const shared = { collapsed, tips, layoutId, reduce };
  return <motion.nav className={styles.nav} aria-label="Northline" layoutScroll>
    {sections.map(section => {
        const headingId = `${baseId}-${variant}-${section.id}`;
        return <div key={section.id} className={styles.section} role={section.heading ? "group" : undefined} aria-labelledby={section.heading ? headingId : undefined}>
          {section.heading && <motion.div className={styles.heading} initial={false} animate={{ height: collapsed ? 17 : 32 }} transition={height}>
            <motion.span id={headingId} className={styles.headingText} initial={false} animate={{ opacity: collapsed ? 0 : 1, x: collapsed ? -6 : 0 }} transition={fade}>{section.heading}</motion.span>
            <motion.span className={styles.divider} aria-hidden="true" initial={false} animate={{ opacity: collapsed ? 1 : 0, scaleX: collapsed ? 1 : .3 }} transition={mark} />
          </motion.div>}
          <ul className={styles.list} role="list">
            {section.items.map(entry => {
              if (!entry.children) return <li key={entry.id}><NavRow entry={entry} current={active === entry.id} lit={active === entry.id} onClick={() => onSelect(entry.id)} {...shared} /></li>;
              const listId = `${baseId}-${variant}-${entry.id}-list`;
              const shown = !!open[entry.id] && !collapsed;
              const holdsActive = entry.children.some(child => child.id === active);
              return <li key={entry.id}>
                <NavRow entry={entry} current={false} lit={holdsActive && !shown} expanded={shown} turned={!!open[entry.id]} controls={listId} onClick={() => onGroup(entry.id)} {...shared} />
                <motion.ul id={listId} className={styles.children} role="list" inert={!shown} initial={false} animate={shown ? { height: "auto", opacity: 1, transitionEnd: { overflow: "visible" } } : { height: 0, opacity: 0, overflow: "hidden" }} transition={{ height, opacity: reduce ? instant : { duration: shown ? .24 : .14, delay: shown ? .06 : 0, ease: curve(motionTokens.ease.standard) } }}>
                  {entry.children.map(child => <li key={child.id}><NavRow entry={child} nested current={active === child.id} lit={shown && active === child.id} onClick={() => onSelect(child.id)} {...shared} /></li>)}
                </motion.ul>
              </li>;
            })}
          </ul>
        </div>;
    })}
    <ul className={`${styles.list} ${styles.footerList}`} role="list"><li><NavRow entry={settingsEntry} current={active === "settings"} lit={active === "settings"} onClick={() => onSelect("settings")} {...shared} /></li></ul>
  </motion.nav>;
}

function Brand({ collapsed, reduce }: { collapsed: boolean; reduce: boolean }) {
  return <div className={styles.brand}>
    <span className={styles.mark} data-logo="" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3.5 5.5 19.5 12 15.6z" fill="currentColor" /><path d="M12 3.5l6.5 16-6.5-3.9z" fill="currentColor" opacity=".55" /></svg></span>
    <motion.span className={styles.stack} initial={false} animate={{ opacity: collapsed ? 0 : 1, x: collapsed ? -6 : 0 }} transition={labelTiming(collapsed, reduce)}><strong>Northline</strong><span>Product design</span></motion.span>
  </div>;
}

function Profile({ collapsed, reduce }: { collapsed: boolean; reduce: boolean }) {
  return <div className={styles.profile}>
    <Avatar name={people.emma.name} src={people.emma.src} size="sm" status="online" />
    <motion.span className={styles.stack} initial={false} animate={{ opacity: collapsed ? 0 : 1, x: collapsed ? -6 : 0 }} transition={labelTiming(collapsed, reduce)}><strong>Emma Collins</strong><span>Product designer</span></motion.span>
  </div>;
}

/** The divider in the panel icon slides with the sidebar, so the control shows what it is about to do. */
function PanelGlyph({ collapsed, reduce }: { collapsed: boolean; reduce: boolean }) {
  return <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
    <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="3.5" />
    <motion.path d="M8.25 4.25v11.5" initial={false} animate={{ x: collapsed ? -2.5 : 0 }} transition={reduce ? instant : motionTokens.spring.smooth} />
  </svg>;
}

export function SidebarRail() {
  const baseId = useId();
  const prefersReduced = !!useReducedMotion();
  // The first measurement settles the layout before paint, so it never animates.
  const [settling, setSettling] = useState(true);
  const reduce = prefersReduced || settling;
  const [collapsed, setCollapsed] = useState(false);
  const [floating, setFloating] = useState(false);
  const [active, setActive] = useState("checkout");
  const [open, setOpen] = useState<Record<string, boolean>>({ projects: true });
  const [sheetOpen, setSheetOpen] = useState(false);
  const [frame, setFrame] = useState<HTMLElement | null>(null);
  const [status, setStatus] = useState("");
  const sheet = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const dragging = useRef(false);
  const closeTimer = useRef(0);
  const page = pages[active];
  const sidebarId = `${baseId}-sidebar`;

  // The [ shortcut toggles the rail, or the sheet when the shell is narrow. It stays out of text fields and off-screen shells.
  useEffect(() => {
    if (!frame) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "[" || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || !frame) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const box = frame.getBoundingClientRect();
      if (!box.width || box.bottom < 0 || box.top > window.innerHeight) return;
      event.preventDefault();
      if (frame.clientWidth < COMPACT) { setSheetOpen(!sheetOpen); return; }
      setCollapsed(!collapsed);
      setStatus(collapsed ? "Sidebar expanded" : "Sidebar collapsed");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [frame, collapsed, sheetOpen]);

  // A mid-width shell starts on the rail; crossing the threshold later folds or opens it once, and a sheet has no place in the wide layout.
  const roomy = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    if (!frame) return;
    const fit = () => {
      const width = frame.clientWidth;
      if (width >= COMPACT) setSheetOpen(false);
      const floats = width >= COMPACT && width < FLOAT;
      setFloating(floats);
      const next = width >= ROOMY;
      if (roomy.current !== next) { roomy.current = next; setCollapsed(!next); }
      // A panel left open while the shell narrows would cover the page, so it folds back to the rail.
      else if (floats) setCollapsed(true);
    };
    fit();
    const settle = requestAnimationFrame(() => setSettling(false));
    const observer = new ResizeObserver(fit);
    observer.observe(frame);
    return () => { observer.disconnect(); cancelAnimationFrame(settle); };
  }, [frame]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  // Every parent label is measured up front, so a crumb that swaps one parent for another can spring between real widths.
  const sizers = useRef<HTMLSpanElement>(null);
  const [parentWidths, setParentWidths] = useState<Record<string, number>>({});
  useLayoutEffect(() => {
    const node = sizers.current;
    if (!node) return;
    const measure = () => setParentWidths(Object.fromEntries(Array.from(node.children, child => [(child as HTMLElement).dataset.label ?? "", (child as HTMLElement).offsetWidth])));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  function toggleRail() {
    setCollapsed(!collapsed);
    setStatus(collapsed ? "Sidebar expanded" : "Sidebar collapsed");
  }

  const overlaid = floating && !collapsed;

  function fold() {
    setCollapsed(true);
    setStatus("Sidebar collapsed");
  }

  function select(id: string, fromSheet = false) {
    if (fromSheet && dragging.current) return;
    setActive(id);
    setStatus(`${pages[id].title} opened`);
    if (!fromSheet && !overlaid) return;
    // Let the highlight arrive before the sheet or the floating panel slides away.
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => (fromSheet ? setSheetOpen(false) : setCollapsed(true)), reduce ? 0 : SETTLE_MS);
  }

  function toggleGroup(id: string, fromSheet = false) {
    if (fromSheet && dragging.current) return;
    // In the rail a group has nowhere to open, so the sidebar widens to reveal it.
    if (collapsed && !fromSheet) {
      setCollapsed(false);
      setOpen(current => ({ ...current, [id]: true }));
      setStatus("Sidebar expanded");
      return;
    }
    setOpen(current => ({ ...current, [id]: !current[id] }));
  }

  // The scrim follows the sheet, so a drag to dismiss lightens the page under the finger instead of waiting for release.
  const sheetX = useMotionValue<number | string>("-100%");
  const scrimOpacity = useTransform(sheetX, value => {
    const width = sheet.current?.offsetWidth || 288;
    const shift = typeof value === "number" ? value / width : value.endsWith("%") ? parseFloat(value) / 100 : parseFloat(value) / width;
    return Math.min(1, Math.max(0, 1 + (Number.isFinite(shift) ? shift : -1)));
  });

  const swap = reduce ? instant : { duration: motionTokens.duration.standard, ease: curve(motionTokens.ease.enter) };
  const stagger: Variants = { shown: { transition: { staggerChildren: reduce ? 0 : motionTokens.stagger.item } } };

  return <LayoutGroup id={baseId}>
    <TooltipPrimitive.Provider delayDuration={250} skipDelayDuration={300}>
      <section ref={setFrame} className={styles.shell} aria-label="Northline workspace" onKeyDown={event => { if (event.key === "Escape" && overlaid && !event.defaultPrevented) { event.preventDefault(); fold(); } }}>
        {/* The slot holds the sidebar's place in the row. On a floating shell it keeps the rail's width and the panel opens over the page. */}
        <motion.div className={styles.slot} initial={false} animate={{ width: floating || collapsed ? RAIL : FULL }} transition={reduce ? instant : motionTokens.spring.smooth}>
          <motion.div id={sidebarId} className={styles.sidebar} initial={false} animate={{ width: collapsed ? RAIL : FULL }} transition={reduce ? instant : motionTokens.spring.smooth} data-collapsed={collapsed || undefined} data-floating={overlaid || undefined}>
            <Brand collapsed={collapsed} reduce={reduce} />
            <Navigation variant="side" baseId={baseId} collapsed={collapsed} active={active} open={open} reduce={reduce} onSelect={id => select(id)} onGroup={id => toggleGroup(id)} />
            <Profile collapsed={collapsed} reduce={reduce} />
          </motion.div>
        </motion.div>
        <AnimatePresence>
          {overlaid && <motion.div key="float-scrim" className={`${styles.scrim} ${styles.floatScrim}`} aria-hidden="true" onClick={fold} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={reduce ? instant : { duration: motionTokens.duration.standard, ease: curve(motionTokens.ease.standard) }} />}
        </AnimatePresence>

        <div className={styles.main}>
          <header className={styles.topbar}>
            <Tooltip side="bottom" content={<span className={styles.shortcut}>{collapsed ? "Expand sidebar" : "Collapse sidebar"}<kbd>[</kbd></span>}>
              <button type="button" className={`${styles.iconButton} ${styles.railToggle}`} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed} aria-controls={sidebarId} aria-keyshortcuts="[" onClick={toggleRail}><PanelGlyph collapsed={collapsed} reduce={reduce} /></button>
            </Tooltip>
            <button ref={menuButton} type="button" className={`${styles.iconButton} ${styles.menuButton}`} aria-label="Open navigation" aria-haspopup="dialog" aria-expanded={sheetOpen} aria-keyshortcuts="[" onClick={() => setSheetOpen(true)}><PanelGlyph collapsed={false} reduce={reduce} /></button>
            <nav className={styles.crumbs} aria-label="Breadcrumb">
              <ol>
                <li className={styles.crumbRoot}>Northline</li>
                <AnimatePresence initial={false}>
                  {page.parent && <motion.li key="parent" className={styles.crumbParent} initial={{ width: 0, opacity: 0 }} animate={{ width: "auto", opacity: 1 }} exit={{ width: 0, opacity: 0 }} transition={reduce ? instant : motionTokens.spring.morph}>
                    {/* The parent can change while the crumb stays, so its width follows the new label instead of snapping. */}
                    <motion.span className={styles.crumbSwap} initial={false} animate={{ width: parentWidths[page.parent] ?? "auto" }} transition={reduce ? instant : motionTokens.spring.morph}><AnimatePresence mode="popLayout" initial={false}><motion.span key={page.parent} variants={rise} initial="hidden" animate="shown" exit="gone" transition={swap}>{page.parent}</motion.span></AnimatePresence></motion.span>
                  </motion.li>}
                </AnimatePresence>
                <li className={styles.crumbCurrent} aria-current="page"><AnimatePresence mode="popLayout" initial={false}><motion.span key={active} variants={rise} initial="hidden" animate="shown" exit="gone" transition={swap}>{page.title}</motion.span></AnimatePresence></li>
              </ol>
              <span ref={sizers} className={styles.crumbSizers} aria-hidden="true">{parentLabels.map(label => <span key={label} data-label={label}>{label}</span>)}</span>
            </nav>
            <div className={styles.team}><AvatarGroup members={page.team.map(person => people[person])} max={3} size="sm" label="People on this page" /></div>
          </header>

          <div className={styles.content}>
            <div className={styles.swap}>
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.div key={active} className={styles.intro} variants={rise} initial="hidden" animate="shown" exit="gone" transition={swap}>
                  <h2 className={styles.title}>{page.title}</h2>
                  <p className={styles.summary}>{page.summary}</p>
                </motion.div>
              </AnimatePresence>
            </div>

            <div className={styles.stats}>
              {page.stats.map((stat, index) => <div key={index} className={styles.stat}><AnimatedCounter value={stat.value} label={stat.label} suffix={stat.suffix} /></div>)}
            </div>

            <div className={styles.swap}>
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.div key={active} className={styles.listBlock} initial="hidden" animate="shown" exit="gone" variants={stagger}>
                  <motion.h3 className={styles.listTitle} variants={rise} transition={swap}>{page.list}</motion.h3>
                  <ul className={styles.rows} role="list">
                    {page.rows.map(row => <motion.li key={row.title} className={styles.row} variants={rise} transition={swap}>
                      <Avatar name={people[row.person].name} src={people[row.person].src} size="sm" />
                      <span className={styles.rowText}><strong>{row.title}</strong><span>{row.detail}</span></span>
                      <Badge tone={row.tone} size="sm">{row.status}</Badge>
                      <span className={styles.when}>{row.when}</span>
                    </motion.li>)}
                  </ul>
                </motion.div>
              </AnimatePresence>
            </div>
          </div>
          <p className={styles.srOnly} role="status" aria-live="polite">{status}</p>
        </div>

        <Dialog.Root open={sheetOpen} onOpenChange={setSheetOpen}>
          <AnimatePresence>
            {sheetOpen && frame && <Dialog.Portal forceMount container={frame}>
              <Dialog.Overlay asChild forceMount><motion.div className={styles.scrim} style={{ opacity: scrimOpacity }} /></Dialog.Overlay>
              <Dialog.Content asChild forceMount aria-describedby={undefined} onCloseAutoFocus={event => { event.preventDefault(); menuButton.current?.focus({ preventScroll: true }); }} onOpenAutoFocus={event => { const current = sheet.current?.querySelector<HTMLElement>("[aria-current='page']"); if (current && !current.closest("[inert]")) { event.preventDefault(); current.focus(); } }}>
                <motion.div ref={sheet} className={styles.sheet} style={{ x: sheetX }} initial={{ x: "-100%" }} animate={{ x: 0 }} exit={{ x: "-100%" }} transition={reduce ? instant : motionTokens.spring.smooth}
                  drag={prefersReduced ? false : "x"} dragConstraints={{ left: 0, right: 0 }} dragElastic={{ left: .9, right: .04 }} dragMomentum={false}
                  onDragStart={() => { dragging.current = true; sheet.current?.setAttribute("data-dragging", ""); }}
                  onDragEnd={(_, info) => { sheet.current?.removeAttribute("data-dragging"); window.setTimeout(() => { dragging.current = false; }, 0); if (info.offset.x < -72 || info.velocity.x < -480) setSheetOpen(false); }}>
                  <Dialog.Title className={styles.srOnly}>Navigation</Dialog.Title>
                  <div className={styles.sheetHead}>
                    <Brand collapsed={false} reduce={reduce} />
                    <Dialog.Close asChild><button type="button" className={styles.iconButton} aria-label="Close navigation"><X size={18} strokeWidth={1.75} aria-hidden="true" /></button></Dialog.Close>
                  </div>
                  <Navigation variant="sheet" baseId={baseId} collapsed={false} active={active} open={open} reduce={reduce} onSelect={id => select(id, true)} onGroup={id => toggleGroup(id, true)} />
                  <Profile collapsed={false} reduce={reduce} />
                </motion.div>
              </Dialog.Content>
            </Dialog.Portal>}
          </AnimatePresence>
        </Dialog.Root>
      </section>
    </TooltipPrimitive.Provider>
  </LayoutGroup>;
}

export default SidebarRail;
