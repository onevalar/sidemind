"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { AnimatePresence, animate, motion, useIsPresent, useMotionValue, useReducedMotion } from "motion/react";
import type { Transition, Variants } from "motion/react";
import { ChevronDown, CornerDownLeft, Search, X } from "lucide-react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./morph-nav.module.css";

/** One destination inside a dropdown panel. */
export interface MorphNavLink {
  label: string;
  /** One short line under the label. */
  description?: string;
  /** Plain decorative icon shown beside the label. */
  icon?: ReactNode;
  href?: string;
}

/** A top level destination. Items with links open a panel; items without links act as plain links. */
export interface MorphNavItem {
  /** Stable value, also used for `current`. */
  value: string;
  label: string;
  href?: string;
  links?: MorphNavLink[];
  /** Link columns in the panel. Defaults to 2 when there are more than three links. */
  columns?: 1 | 2;
  /** A rich slot beside the links, such as a featured story. Clicking a link or button inside it closes the panel. */
  feature?: ReactNode;
  /** A slim row under the links, such as a changelog note. */
  footer?: ReactNode;
}

export interface MorphNavSearchItem {
  label: string;
  description?: string;
  /** Where the result lives, shown at the end of the row. */
  group?: string;
  icon?: ReactNode;
  href?: string;
  /** Extra words that should match this result. */
  keywords?: string;
}

/** What `onNavigate` receives. */
export interface MorphNavDestination {
  label: string;
  href?: string;
  /** The top level item the destination belongs to, when there is one. */
  section?: string;
}

/**
 * A navigation bar made of one continuous surface. A highlight glides between items, an item with links grows the bar
 * downward into its panel, moving to a neighbour slides the new content in from that side while the surface springs to
 * its size, search morphs out of the bar itself, and a compact state tightens everything on scroll.
 * Use it for marketing and product sites with a handful of sections that each hold several destinations.
 */
export interface MorphNavProps {
  items: MorphNavItem[];
  brand?: { name: string; mark: ReactNode; href?: string };
  /** The one primary action at the end of the bar. */
  action?: { label: string; icon?: ReactNode; href?: string; onClick?: () => void };
  /** Search entries. Leave it out to hide search. */
  search?: { placeholder?: string; items: MorphNavSearchItem[] };
  /** Value of the item that holds the current page. */
  current?: string;
  /** Tightens the bar, for example once the page scrolls. */
  compact?: boolean;
  /** Below this container width in px the items fold into one menu. Defaults to 720. */
  collapseBelow?: number;
  /** Called for every destination: links, results, plain items, and the brand. */
  onNavigate?: (destination: MorphNavDestination) => void;
  /** Accessible name of the navigation landmark. */
  label?: string;
  className?: string;
}

type Mode = "nav" | "search";
type Size = { w: number; h: number };

const { blur } = motionTokens;
type Bezier = [number, number, number, number];
const enter = [...motionTokens.ease.enter] as Bezier;
const standard = [...motionTokens.ease.standard] as Bezier;
/** Duration based springs restated as stiffness and damping, so every retarget keeps the velocity already in flight. */
const physical = (visualDuration: number, bounce: number): Transition => {
  const root = 2 * Math.PI / (visualDuration * 1.2);
  return { type: "spring", stiffness: root * root, damping: 2 * (1 - bounce) * root, mass: 1 };
};
/** Growing carries only a trace of overshoot; shrinking settles faster and never overshoots. Panels slide without bounce. */
const GROW = physical(.44, .06), SHRINK = physical(.34, 0), GLIDE = physical(.3, .04), SLIDE = physical(.4, 0);
const PANEL_RADIUS = 22;
const MENU = "__menu", SEARCH = "__search";
const HOVER_INTENT = 60, LEAVE_GRACE = 180, TRAVEL = 20;

const subscribe = () => () => {};
function useReducedFlag() {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

/** Panels slide in from the side the pointer came from and leave toward the other side. Opening from closed drops in from the bar. */
const faceVariants: Variants = {
  hidden: (direction: number) => ({ opacity: 0, x: direction * TRAVEL, y: direction ? 0 : -4, filter: `blur(${blur.soft}px)` }),
  shown: { opacity: 1, x: 0, y: 0, filter: "blur(0px)", transition: { x: SLIDE, y: SLIDE, opacity: { duration: .24, ease: enter, delay: .04 }, filter: { duration: .26, ease: enter, delay: .04 } } },
  gone: (direction: number) => ({ opacity: 0, x: direction * -TRAVEL * .5, y: direction ? 0 : -2, filter: `blur(${blur.soft}px)`, transition: { x: SLIDE, y: { duration: .14, ease: standard }, opacity: { duration: .12, ease: standard }, filter: { duration: .12, ease: standard } } }),
};
const fadeVariants: Variants = { hidden: { opacity: 0 }, shown: { opacity: 1, transition: { duration: .16 } }, gone: { opacity: 0, transition: { duration: .1 } } };

/** A panel face reports its natural size while it is the current one; a leaving face turns inert and stops reporting. */
function Face({ id, direction, reduced, onSize, className, children, onClick }: { id: string; direction: number; reduced: boolean; onSize: (id: string, width: number, height: number) => void; className?: string; children: ReactNode; onClick?: (event: ReactMouseEvent<HTMLDivElement>) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const present = useIsPresent();
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !present) return;
    const report = () => onSize(id, node.offsetWidth, node.offsetHeight);
    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(node);
    return () => observer.disconnect();
  }, [id, onSize, present]);
  return <motion.div ref={ref} className={[styles.face, className].filter(Boolean).join(" ")} data-face={id} custom={direction}
    variants={reduced ? fadeVariants : faceVariants} initial="hidden" animate="shown" exit="gone" inert={!present || undefined} onClick={onClick}>{children}</motion.div>;
}

function score(item: MorphNavSearchItem, query: string) {
  const label = item.label.toLowerCase();
  if (label.startsWith(query)) return 3;
  if (label.includes(query)) return 2;
  return `${item.description ?? ""} ${item.group ?? ""} ${item.keywords ?? ""}`.toLowerCase().includes(query) ? 1 : 0;
}

export function MorphNav({ items, brand, action, search, current, compact = false, collapseBelow = 720, onNavigate, label = "Main", className }: MorphNavProps) {
  const reduced = useReducedFlag();
  const uid = useId();
  const panelId = `${uid}-panel`, resultsId = `${uid}-results`;
  const rootRef = useRef<HTMLElement>(null);
  const navRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);

  const [mode, setMode] = useState<Mode>("nav");
  const [open, setOpen] = useState<string | null>(null);
  const [direction, setDirection] = useState(0);
  const [hovered, setHovered] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [narrow, setNarrow] = useState(false);

  const menuItem = useMemo<MorphNavItem>(() => ({ value: MENU, label: "Menu" }), []);
  const bar = narrow ? [menuItem] : items;
  const hasPanel = (item: MorphNavItem) => item.value === MENU || !!item.links?.length || !!item.feature;
  const panelKey = mode === "search" ? SEARCH : open;
  const openIndex = bar.findIndex(item => item.value === open);
  const openItem = openIndex >= 0 ? bar[openIndex] : null;

  const results = useMemo(() => {
    const all = search?.items ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return all.slice(0, 5);
    return all.map(item => ({ item, rank: score(item, needle) })).filter(entry => entry.rank > 0).sort((a, b) => b.rank - a.rank).slice(0, 6).map(entry => entry.item);
  }, [query, search]);
  const activeResult = Math.min(active, Math.max(0, results.length - 1));

  /* The shape. One surface whose width, height, and corner spring to the bar face and the current panel. */
  const width = useMotionValue(0), height = useMotionValue(0), radius = useMotionValue(28);
  const sizes = useRef<{ nav: Size; search: Size; panel: (Size & { id: string }) | null }>({ nav: { w: 0, h: 0 }, search: { w: 0, h: 0 }, panel: null });
  const live = useRef({ panelKey: null as string | null, mode: "nav" as Mode, reduced: false, ready: false });
  const target = useRef({ w: 0, h: 0, r: 0 });
  const flight = useRef({ settled: true });
  const springNext = useRef(false);
  const queued = useRef(false);

  const update = useCallback(() => {
    queued.current = false;
    const state = live.current, measured = sizes.current;
    const face = state.mode === "search" ? measured.search : measured.nav;
    if (!face.w || !measured.nav.h) return;
    const panel = state.panelKey && measured.panel?.id === state.panelKey ? measured.panel : null;
    const next = { w: Math.max(face.w, panel?.w ?? 0), h: measured.nav.h + (panel?.h ?? 0), r: panel ? PANEL_RADIUS : measured.nav.h / 2 };
    const last = target.current;
    const moved = Math.abs(next.w - last.w) > .5 || Math.abs(next.h - last.h) > .5 || Math.abs(next.r - last.r) > .5;
    const wantsSpring = springNext.current;
    springNext.current = false;
    if (!moved) return;
    target.current = next;
    if (!state.ready || state.reduced || (!wantsSpring && flight.current.settled)) {
      // At rest the shape follows its faces exactly, so a compact bar tightens in step with its own content. The size is written
      // straight to the surface as well: measurements arrive after this frame's animation step, and waiting for the next one
      // would leave the edge a frame behind content that is still tightening.
      width.jump(next.w); height.jump(next.h); radius.jump(next.r);
      const surface = surfaceRef.current;
      if (surface) { surface.style.width = `${next.w}px`; surface.style.height = `${next.h}px`; surface.style.borderRadius = `${next.r}px`; }
      live.current.ready = true;
      return;
    }
    const transition = next.w * next.h >= last.w * last.h ? GROW : SHRINK;
    const run = { settled: false };
    flight.current = run;
    Promise.all([animate(width, next.w, transition), animate(height, next.h, transition), animate(radius, next.r, transition)]).then(() => { run.settled = true; });
  }, [height, radius, width]);

  /** Measurements from several faces land in the same commit; one microtask reads them all before the frame paints. */
  const schedule = useCallback((spring = false) => {
    if (spring) springNext.current = true;
    if (queued.current) return;
    queued.current = true;
    queueMicrotask(update);
  }, [update]);

  const onPanelSize = useCallback((id: string, w: number, h: number) => {
    sizes.current.panel = { id, w, h };
    schedule(true);
  }, [schedule]);

  useLayoutEffect(() => {
    live.current.panelKey = panelKey;
    live.current.mode = mode;
    live.current.reduced = reduced;
    schedule(true);
  }, [mode, panelKey, reduced, schedule]);

  useLayoutEffect(() => {
    const nav = navRef.current, searchFace = searchRef.current, root = rootRef.current;
    if (!nav || !root) return;
    const read = () => {
      sizes.current.nav = { w: nav.offsetWidth, h: nav.offsetHeight };
      if (searchFace) sizes.current.search = { w: searchFace.offsetWidth, h: searchFace.offsetHeight };
      setNarrow(root.offsetWidth < collapseBelow);
      schedule();
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    [nav, root, searchFace].forEach(node => { if (node) observer.observe(node); });
    return () => observer.disconnect();
  }, [collapseBelow, schedule]);

  /* The hover highlight glides between items on its own spring and fades when the pointer leaves the bar. */
  const hx = useMotionValue(0), hw = useMotionValue(0), ho = useMotionValue(0);
  const lit = hovered ?? (openIndex >= 0 ? openIndex : null);
  useLayoutEffect(() => {
    const track = trackRef.current;
    const node = lit === null ? null : track?.querySelector<HTMLElement>(`[data-index="${lit}"]`);
    if (!node) { animate(ho, 0, { duration: reduced ? 0 : .16, ease: standard }); return; }
    const place = [node.offsetLeft, node.offsetWidth];
    if (ho.get() < .05 || reduced) { hx.jump(place[0]); hw.jump(place[1]); }
    else { animate(hx, place[0], GLIDE); animate(hw, place[1], GLIDE); }
    animate(ho, 1, { duration: reduced ? 0 : .14, ease: enter });
  }, [compact, ho, hw, hx, lit, narrow, reduced]);

  /* Intent timers: a short pause before a panel opens from rest, a grace period before it closes when the pointer leaves. */
  const timers = useRef<{ open?: number; leave?: number }>({});
  const clearTimers = () => { window.clearTimeout(timers.current.open); window.clearTimeout(timers.current.leave); };
  useEffect(() => () => { window.clearTimeout(timers.current.open); window.clearTimeout(timers.current.leave); }, []);

  const pendingFocus = useRef<"panel" | "input" | "search-button" | string | null>(null);
  const openedAt = useRef(0);
  const wasOpen = open !== null;
  useEffect(() => { if (wasOpen) openedAt.current = performance.now(); }, [wasOpen]);

  const show = (value: string | null) => {
    if (value === open) return;
    const from = bar.findIndex(item => item.value === open), to = bar.findIndex(item => item.value === value);
    setDirection(open && value && from >= 0 && to >= 0 ? Math.sign(to - from) : 0);
    setOpen(value);
  };

  // Compact and narrow states retune the bar, so any open panel closes first rather than chase a moving bar.
  const [layoutKey, setLayoutKey] = useState(`${compact}-${narrow}`);
  if (layoutKey !== `${compact}-${narrow}`) { setLayoutKey(`${compact}-${narrow}`); setOpen(null); setHovered(null); }

  const closeAll = useCallback((focus?: "trigger" | "search-button") => {
    clearTimers();
    if (focus === "trigger" && open) pendingFocus.current = `${uid}-trigger-${open}`;
    if (focus === "search-button") pendingFocus.current = "search-button";
    setOpen(null);
    setMode("nav");
    setHovered(null);
  }, [open, uid]);

  const navigate = (destination: MorphNavDestination) => {
    onNavigate?.(destination);
    closeAll();
  };

  const enterSearch = () => {
    clearTimers();
    setOpen(null);
    setHovered(null);
    setQuery("");
    setActive(0);
    setDirection(0);
    pendingFocus.current = "input";
    setMode("search");
  };

  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    const root = rootRef.current;
    if (!root) return;
    if (target === "input") inputRef.current?.focus({ preventScroll: true });
    else if (target === "search-button") searchButtonRef.current?.focus({ preventScroll: true });
    else if (target === "panel") root.querySelector<HTMLElement>(`[data-face="${panelKey}"] :is(a[href], button)`)?.focus({ preventScroll: true });
    else document.getElementById(target)?.focus({ preventScroll: true });
  }, [mode, panelKey]);

  // A press outside folds everything back into the bar.
  const listening = open !== null || mode === "search";
  useEffect(() => {
    if (!listening) return;
    const down = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) closeAll(); };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }, [closeAll, listening]);

  const onItemEnter = (index: number, pointerType: string) => {
    if (pointerType !== "mouse") return;
    window.clearTimeout(timers.current.leave);
    window.clearTimeout(timers.current.open);
    setHovered(index);
    const item = bar[index];
    if (!hasPanel(item)) { if (open) show(null); return; }
    if (open) show(item.value);
    else timers.current.open = window.setTimeout(() => show(item.value), HOVER_INTENT);
  };

  /** Moving onto the brand or the tools reads as leaving the items: the highlight lets go and any panel folds away. */
  const leaveItems = (event: ReactPointerEvent) => {
    if (event.pointerType !== "mouse") return;
    window.clearTimeout(timers.current.open);
    setHovered(null);
    if (open) show(null);
  };

  const onItemClick = (item: MorphNavItem, at: number) => {
    if (!hasPanel(item)) { navigate({ label: item.label, href: item.href, section: item.value }); return; }
    // A hover that just opened this panel should not be undone by the click that follows it.
    if (open === item.value) { if (at - openedAt.current > 400) show(null); return; }
    show(item.value);
  };

  const triggers = () => Array.from(trackRef.current?.querySelectorAll<HTMLElement>("[data-index]") ?? []);
  const onItemKey = (event: ReactKeyboardEvent<HTMLElement>, index: number) => {
    const item = bar[index], all = triggers();
    const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };
    if (event.key in moves || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? bar.length - 1 : (index + moves[event.key] + bar.length) % bar.length;
      all[next]?.focus();
      setHovered(next);
      if (open) show(hasPanel(bar[next]) ? bar[next].value : null);
      return;
    }
    if ((event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") && hasPanel(item)) {
      event.preventDefault();
      if (open === item.value) { rootRef.current?.querySelector<HTMLElement>(`[data-face="${item.value}"] :is(a[href], button)`)?.focus({ preventScroll: true }); return; }
      pendingFocus.current = "panel";
      show(item.value);
    }
  };

  const onPanelKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const focusables = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(":is(a[href], button)"));
    const at = focusables.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    event.preventDefault();
    if (event.key === "ArrowUp" && at === 0 && open) { document.getElementById(`${uid}-trigger-${open}`)?.focus(); return; }
    focusables[Math.min(focusables.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };

  const onRootKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (mode === "search") { event.preventDefault(); closeAll("search-button"); return; }
    if (open) { event.preventDefault(); closeAll("trigger"); }
  };

  const onRootBlur = (event: ReactFocusEvent<HTMLElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && !event.currentTarget.contains(next) && open) { setOpen(null); setHovered(null); }
  };

  const chooseResult = (item: MorphNavSearchItem | undefined) => {
    if (!item) return;
    pendingFocus.current = "search-button";
    navigate({ label: item.label, href: item.href, section: item.group });
  };

  const onSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!results.length) return;
      setActive((activeResult + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      chooseResult(results[activeResult]);
    }
  };

  const closeOnActivate = (event: ReactMouseEvent<HTMLDivElement>) => {
    const hit = (event.target as HTMLElement).closest("a, button");
    if (!hit || !event.currentTarget.contains(hit) || !open) return;
    // Keyboard users land back on the trigger they came from.
    pendingFocus.current = event.currentTarget.contains(document.activeElement) ? `${uid}-trigger-${open}` : null;
    setOpen(null);
    setHovered(null);
  };

  const linkRow = (link: MorphNavLink, section: string, dense = false) => {
    const body = <>
      {link.icon && <span className={styles.linkIcon} aria-hidden="true">{link.icon}</span>}
      <span className={styles.linkText}>
        <span className={styles.linkLabel}>{link.label}</span>
        {!dense && link.description && <span className={styles.linkDescription}>{link.description}</span>}
      </span>
    </>;
    const go = () => onNavigate?.({ label: link.label, href: link.href, section });
    return <li key={link.label}>
      {link.href
        ? <a className={styles.link} data-dense={dense || undefined} href={link.href} onClick={go}>{body}</a>
        : <button type="button" className={styles.link} data-dense={dense || undefined} onClick={go}>{body}</button>}
    </li>;
  };

  const renderPanel = (item: MorphNavItem) => {
    if (item.value === MENU) return <div className={styles.menu}>
      {items.map(entry => entry.links?.length
        ? <div key={entry.value} className={styles.menuGroup}>
          <p className={styles.menuHeading}>{entry.label}</p>
          <ul className={styles.links} data-columns="1">{entry.links.map(link => linkRow(link, entry.value, true))}</ul>
        </div>
        : <ul key={entry.value} className={styles.links} data-columns="1">{linkRow({ label: entry.label, href: entry.href }, entry.value, true)}</ul>)}
    </div>;
    const columns = item.columns ?? ((item.links?.length ?? 0) > 3 ? 2 : 1);
    return <>
      <div className={styles.panelBody}>
        {!!item.links?.length && <ul className={styles.links} data-columns={columns}>{item.links.map(link => linkRow(link, item.value))}</ul>}
        {item.feature && <div className={styles.feature}>{item.feature}</div>}
      </div>
      {item.footer && <div className={styles.footer}>{item.footer}</div>}
    </>;
  };

  if (!items.length) return null;

  return <nav ref={rootRef} className={[styles.root, className].filter(Boolean).join(" ")} aria-label={label} data-compact={compact || undefined} data-narrow={narrow || undefined}
    data-open={panelKey ? "" : undefined} onKeyDown={onRootKey} onBlur={onRootBlur}
    onPointerEnter={() => window.clearTimeout(timers.current.leave)}
    onPointerLeave={event => {
      if (event.pointerType !== "mouse") return;
      window.clearTimeout(timers.current.open);
      setHovered(null);
      if (open) timers.current.leave = window.setTimeout(() => show(null), LEAVE_GRACE);
    }}>
    <motion.div ref={surfaceRef} className={styles.surface} style={{ width, height, borderRadius: radius }}>
      {/* The bar: brand, items, and tools. It fades and blurs away as search takes its place. */}
      <motion.div ref={navRef} className={styles.bar} inert={mode === "search" || undefined} initial={false}
        animate={mode === "nav" ? { opacity: 1, scale: 1, filter: "blur(0px)" } : reduced ? { opacity: 0 } : { opacity: 0, scale: .96, filter: `blur(${blur.soft}px)` }}
        transition={reduced ? { duration: .12 } : mode === "nav" ? { opacity: { duration: .22, ease: enter, delay: .06 }, filter: { duration: .24, ease: enter, delay: .06 }, scale: GROW } : { duration: .14, ease: standard }}>
        {brand && <button type="button" className={styles.brand} onPointerEnter={leaveItems} onClick={() => navigate({ label: brand.name, href: brand.href })}>
          <span className={styles.brandMark} aria-hidden="true">{brand.mark}</span>
          <span className={styles.brandName}><span>{brand.name}</span></span>
        </button>}

        <div ref={trackRef} className={styles.track}>
          <motion.span className={styles.highlight} style={{ x: hx, width: hw, opacity: ho }} aria-hidden="true" />
          {bar.map((item, index) => {
            const panel = hasPanel(item), expanded = open === item.value, isCurrent = current === item.value;
            const common = {
              id: `${uid}-trigger-${item.value}`,
              className: styles.item,
              "data-index": index,
              "data-current": isCurrent || undefined,
              onPointerEnter: (event: ReactPointerEvent) => onItemEnter(index, event.pointerType),
              onFocus: () => setHovered(index),
              onBlur: () => setHovered(current => current === index ? null : current),
              onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => onItemKey(event, index),
            };
            if (!panel && item.href) return <a key={item.value} {...common} href={item.href} aria-current={isCurrent ? "page" : undefined} onClick={() => navigate({ label: item.label, href: item.href, section: item.value })}>
              <span className={styles.itemLabel}>{item.label}</span>
            </a>;
            return <button key={item.value} type="button" {...common} aria-current={isCurrent ? "page" : undefined}
              aria-expanded={panel ? expanded : undefined} aria-controls={panel && expanded ? panelId : undefined} onClick={event => onItemClick(item, event.timeStamp)}>
              <span className={styles.itemLabel}>{item.label}</span>
              {panel && <motion.span className={styles.chevron} aria-hidden="true" initial={false} animate={{ rotate: expanded ? 180 : 0 }} transition={reduced ? { duration: 0 } : GLIDE}><ChevronDown size={14} strokeWidth={1.75} /></motion.span>}
            </button>;
          })}
        </div>

        <div className={styles.tools} onPointerEnter={leaveItems}>
          {search && <button ref={searchButtonRef} type="button" className={styles.tool} aria-label="Search" onClick={enterSearch}>
            <Search size={17} strokeWidth={1.75} aria-hidden="true" />
          </button>}
          {action && (action.href
            ? <a className={styles.action} href={action.href} onClick={action.onClick}>{action.icon}<span>{action.label}</span></a>
            : <button type="button" className={styles.action} onClick={action.onClick}>{action.icon}<span>{action.label}</span></button>)}
        </div>
      </motion.div>

      {/* Search grows out of the same surface: the bar gives way to a field and results open underneath. */}
      {search && <motion.div ref={searchRef} className={styles.searchBar} inert={mode !== "search" || undefined} initial={false}
        animate={mode === "search" ? { opacity: 1, scale: 1, filter: "blur(0px)" } : reduced ? { opacity: 0 } : { opacity: 0, scale: .97, filter: `blur(${blur.soft}px)` }}
        transition={reduced ? { duration: .12 } : mode === "search" ? { opacity: { duration: .22, ease: enter, delay: .07 }, filter: { duration: .24, ease: enter, delay: .07 }, scale: GROW } : { duration: .12, ease: standard }}>
        <Search className={styles.searchIcon} size={18} strokeWidth={1.75} aria-hidden="true" />
        <input ref={inputRef} className={styles.input} type="text" role="combobox" aria-label="Search" aria-expanded={mode === "search"} aria-controls={resultsId} aria-autocomplete="list"
          aria-activedescendant={mode === "search" && results.length ? `${resultsId}-${activeResult}` : undefined}
          placeholder={search.placeholder ?? "Search"} value={query} autoComplete="off" spellCheck={false}
          onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={onSearchKey} />
        <button type="button" className={styles.tool} aria-label="Close search" onClick={() => closeAll("search-button")}><X size={17} strokeWidth={1.75} aria-hidden="true" /></button>
      </motion.div>}

      <AnimatePresence initial={false} custom={direction}>
        {mode === "search" && search && <Face key={SEARCH} id={SEARCH} direction={0} reduced={reduced} onSize={onPanelSize} className={styles.resultsFace}>
          <p className={styles.resultsHeading} aria-live="polite">{query.trim() ? results.length ? `${results.length} ${results.length === 1 ? "result" : "results"}` : `No results for “${query.trim()}”` : "Suggested"}</p>
          <ul id={resultsId} className={styles.results} role="listbox" aria-label="Search results">
            {results.map((item, index) => <li key={`${item.group}-${item.label}`} id={`${resultsId}-${index}`} role="option" aria-selected={index === activeResult}
              className={styles.result} onPointerMove={() => { if (index !== activeResult) setActive(index); }} onPointerDown={event => event.preventDefault()} onClick={() => chooseResult(item)}>
              {item.icon && <span className={styles.linkIcon} aria-hidden="true">{item.icon}</span>}
              <span className={styles.linkText}>
                <span className={styles.linkLabel}>{item.label}</span>
                {item.description && <span className={styles.linkDescription}>{item.description}</span>}
              </span>
              {item.group && <span className={styles.resultGroup}>{item.group}</span>}
              <CornerDownLeft className={styles.resultEnter} size={14} strokeWidth={1.75} aria-hidden="true" />
            </li>)}
          </ul>
        </Face>}
        {mode === "nav" && openItem && hasPanel(openItem) && <Face key={openItem.value} id={openItem.value} direction={direction} reduced={reduced} onSize={onPanelSize} onClick={closeOnActivate}>
          <div id={panelId} role="region" aria-labelledby={`${uid}-trigger-${openItem.value}`} onKeyDown={onPanelKey}>
            {renderPanel(openItem)}
          </div>
        </Face>}
      </AnimatePresence>
    </motion.div>
  </nav>;
}

export default MorphNav;
