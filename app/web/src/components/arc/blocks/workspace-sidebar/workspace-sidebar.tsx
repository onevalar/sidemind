"use client";

import Image from "next/image";
import { useEffect, useEffectEvent, useId, useRef, useState, useSyncExternalStore, type CSSProperties, type FocusEvent, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import * as Menu from "@radix-ui/react-dropdown-menu";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { AnimatePresence, LayoutGroup, Reorder, animate, motion, useDragControls, useIsPresent, useMotionValue, useReducedMotion, useTransform, type Transition } from "motion/react";
import { Check, ChevronsUpDown, FileText, Frame, LayoutGrid, Map as MapIcon, Plus, X } from "lucide-react";
import { AnimatedCounter } from "../../animated-counter/animated-counter";
import { Avatar } from "../../avatar/avatar";
import { Button } from "../../button/button";
import { SearchField } from "../../search-field/search-field";
import { TextMorph } from "../../text-morph/text-morph";
import { motionTokens } from "../../lib/motion-tokens";
import styles from "./workspace-sidebar.module.css";

type Tone = "blue" | "green" | "violet" | "amber" | "coral" | "slate";
type Kind = "prototype" | "doc" | "map" | "board";
type Favorite = { id: string; name: string; kind: Kind };
type Project = { id: string; name: string; tone: Tone; unread: boolean };
type Lists = { favorites: Favorite[]; projects: Project[]; active: string };
type Workspace = { id: string; name: string; initial: string; photo?: string; logo?: { color: string; glyph: ReactNode }; plan: string; members: string; used: number; limit: number };

/** Sample company marks: a white glyph on the company's own colour, like a real workspace logo. */
const northwindGlyph = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 9h9.5a2.75 2.75 0 1 0-2.6-3.6" /><path d="M4 12.5h13a2.75 2.75 0 1 1-2.6 3.6" /><path d="M4 16h5" /></svg>;
const fieldworkGlyph = <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.5 4.5C10.5 4.5 5 9 5 15.2c0 1.3.25 2.5.7 3.6 1.3-5 4.8-8.3 9.3-10.3-3.8 2.4-6.6 5.8-7.9 11 1.1.3 2.2.5 3.4.5 5.4 0 9-4.6 9-15.5z" /></svg>;

export interface WorkspaceSidebarProps {
  className?: string;
  /** Called when a favorite or project is opened. Connect it to your router. */
  onNavigate?: (target: { workspace: string; id: string; name: string }) => void;
  /** Start as the narrow icon rail. The sidebar is expanded by default. */
  defaultCollapsed?: boolean;
  /** Called when the sidebar collapses to its icon rail or expands again, from the toggle or the [ shortcut. */
  onCollapsedChange?: (collapsed: boolean) => void;
}

const workspaces: Workspace[] = [
  { id: "northwind", name: "Northwind", initial: "N", logo: { color: "#2f5bea", glyph: northwindGlyph }, plan: "Business", members: "24 members", used: 38.4, limit: 100 },
  { id: "fieldwork", name: "Fieldwork Labs", initial: "F", logo: { color: "#1d7f55", glyph: fieldworkGlyph }, plan: "Team", members: "8 members", used: 58.1, limit: 80 },
  { id: "personal", name: "Personal", initial: "M", photo: "/media/people/emma-collins.jpg", plan: "Free", members: "Just you", used: 4.6, limit: 5 },
];

const initialLists: Record<string, Lists> = {
  northwind: {
    active: "checkout",
    favorites: [{ id: "flows", name: "Checkout flows", kind: "prototype" }, { id: "critique", name: "Critique notes", kind: "doc" }, { id: "roadmap", name: "Q4 roadmap", kind: "map" }, { id: "audit", name: "Component audit", kind: "board" }],
    projects: [{ id: "checkout", name: "Checkout redesign", tone: "blue", unread: false }, { id: "mobile", name: "Mobile app 4.0", tone: "green", unread: true }, { id: "system", name: "Design system", tone: "violet", unread: false }, { id: "onboarding", name: "Onboarding", tone: "amber", unread: true }, { id: "help", name: "Help center", tone: "coral", unread: false }, { id: "admin", name: "Admin console", tone: "slate", unread: false }],
  },
  fieldwork: {
    active: "scheduling",
    favorites: [{ id: "synthesis", name: "Interview synthesis", kind: "doc" }, { id: "journey", name: "Patient journey", kind: "map" }, { id: "booking", name: "Booking prototype", kind: "prototype" }],
    projects: [{ id: "scheduling", name: "Clinic scheduling", tone: "green", unread: false }, { id: "intake", name: "Patient intake", tone: "blue", unread: true }, { id: "research", name: "Research ops", tone: "amber", unread: false }, { id: "a11y", name: "Accessibility audit", tone: "violet", unread: true }],
  },
  personal: {
    active: "portfolio",
    favorites: [{ id: "case", name: "Case study draft", kind: "doc" }, { id: "type", name: "Type explorations", kind: "board" }],
    projects: [{ id: "portfolio", name: "Portfolio 2026", tone: "coral", unread: false }, { id: "tide", name: "Tide weather app", tone: "blue", unread: true }, { id: "icons", name: "Icon set", tone: "slate", unread: false }],
  },
};

const tones: Tone[] = ["blue", "green", "violet", "amber", "coral", "slate"];
const kindIcons = { prototype: Frame, doc: FileText, map: MapIcon, board: LayoutGrid };
const { spring, duration, ease, blur } = motionTokens;
const enter = [...ease.enter] as [number, number, number, number];
const standard = [...ease.standard] as [number, number, number, number];
const instant: Transition = { duration: 0 };
/** Rows open and close their own height, so the list below follows every frame instead of jumping. */
const rowIn = { height: 0, opacity: 0, overflow: "hidden" };
const rowShown = { height: "auto", opacity: 1, transitionEnd: { overflow: "visible" } };
const rowOut = { height: 0, opacity: 0, overflow: "hidden" };
const rowMotion: Transition = { ...spring.smooth, opacity: { duration: duration.fast, ease: standard } };

const subscribeNothing = () => () => {};
/** Reduced motion is only known in the browser, so the first client render matches the server before it takes effect. */
function useReducedMotionSafe() {
  const hydrated = useSyncExternalStore(subscribeNothing, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

/** Phones get a top bar and an off-canvas drawer instead of a column beside the content. The stylesheet hides the inline column at the same width, so a phone never flashes it before hydration. */
const PHONE = "(max-width: 640px)";
const subscribePhone = (change: () => void) => {
  const query = window.matchMedia(PHONE);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
};
function usePhone() {
  return useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE).matches, () => false);
}

const focusable = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Rail width in px. The open width is the --full custom property, so a stylesheet can change it. */
const RAIL = 64;

/** The width follows one value from 0 (rail) to 1 (open) on the smooth spring, so the content beside the sidebar reflows every frame instead of jumping. */
function useRailWidth(rail: boolean, reduce: boolean, onOpened: () => void) {
  const open = useMotionValue(rail ? 0 : 1);
  const width = useTransform(open, value => `calc(${RAIL}px + (var(--full) - ${RAIL}px) * ${value})`);
  const opened = useEffectEvent(onOpened);
  useEffect(() => {
    const target = rail ? 0 : 1;
    if (reduce) { open.jump(target); if (!rail) opened(); return; }
    const controls = animate(open, target, { ...spring.smooth, onComplete: () => { if (!rail) opened(); } });
    return () => controls.stop();
  }, [rail, reduce, open]);
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

/** In the rail every item names itself on hover and focus. Closing the rail disarms any open tip. */
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
    <motion.path d="M8.25 4.25v11.5" initial={false} animate={{ x: collapsed ? -2.5 : 0 }} transition={reduce ? instant : spring.smooth} />
  </svg>;
}

const toneFor = (count: number) => tones[count % tones.length];
const matches = (name: string, query: string) => !query || name.toLowerCase().includes(query.toLowerCase());

/** Changed text rises out of a soft blur while the old text lifts away a little faster. */
function Swap({ text, className, reduce }: { text: string; className?: string; reduce: boolean }) {
  return <span className={[styles.swap, className].filter(Boolean).join(" ")}>
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span key={text} className={styles.swapText} initial={reduce ? { opacity: 0 } : { opacity: 0, y: "0.35em", filter: `blur(${blur.soft}px)` }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={reduce ? { opacity: 0, transition: instant } : { opacity: 0, y: "-0.35em", filter: `blur(${blur.subtle}px)`, transition: { duration: duration.fast, ease: standard } }} transition={reduce ? instant : { duration: duration.standard, ease: enter }}>{text}</motion.span>
    </AnimatePresence>
  </span>;
}

function Mark({ workspace, small = false, reduce }: { workspace: Workspace; small?: boolean; reduce: boolean }) {
  return <span className={[styles.mark, small ? styles.markSmall : ""].filter(Boolean).join(" ")} aria-hidden="true">
    <AnimatePresence initial={false}>
      <motion.span key={workspace.id} className={styles.markFace} data-photo={workspace.photo ? "" : undefined} data-logo={workspace.logo ? "" : undefined} style={workspace.logo ? { background: workspace.logo.color } : undefined} initial={reduce ? { opacity: 0 } : { opacity: 0, scale: .72, filter: `blur(${blur.subtle}px)` }} animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }} exit={reduce ? { opacity: 0, transition: instant } : { opacity: 0, scale: .72, filter: `blur(${blur.subtle}px)`, transition: { duration: duration.fast, ease: standard } }} transition={reduce ? instant : { ...spring.snappy, opacity: { duration: duration.fast }, filter: { duration: duration.fast } }}>
        {workspace.photo ? <Image src={workspace.photo} alt="" fill sizes={small ? "28px" : "32px"} /> : workspace.logo ? workspace.logo.glyph : workspace.initial}
      </motion.span>
    </AnimatePresence>
  </span>;
}

/** Search keeps the whole name readable and lifts the matching letters out of the dimmed rest. */
function Name({ name, query, unread = false }: { name: string; query: string; unread?: boolean }) {
  const index = query ? name.toLowerCase().indexOf(query.toLowerCase()) : -1;
  return <span className={styles.name} data-searching={query ? "" : undefined} data-unread={unread ? "" : undefined}>
    {index < 0 ? name : <>{name.slice(0, index)}<mark>{name.slice(index, index + query.length)}</mark>{name.slice(index + query.length)}</>}
  </span>;
}

function Highlight({ reduce }: { reduce: boolean }) {
  return <motion.span layoutId="active" className={styles.highlight} aria-hidden="true" transition={reduce ? instant : spring.morph} />;
}

/** Section titles fold into a hairline in the rail. The title leaves first, then the height closes. */
function SectionTitle({ id, text, rail, reduce }: { id: string; text: string; rail: boolean; reduce: boolean }) {
  return <motion.h2 id={id} className={styles.sectionTitle} initial={false} animate={{ height: rail ? 17 : 32 }} transition={reduce ? instant : spring.smooth}>
    <span className={styles.sectionText}>{text}</span>
    <span className={styles.divider} aria-hidden="true" />
  </motion.h2>;
}

type PanelProps = {
  workspace: Workspace; lists: Lists; query: string; reduce: boolean; rail: boolean;
  onExpand: () => void;
  onSelect: (workspace: string, id: string, name: string) => void;
  onReorder: (workspace: string, favorites: Favorite[]) => void;
  onMoved: (workspace: string, id: string, favorites?: Favorite[]) => void;
  onCreate: (workspace: string, name: string) => string;
  onClear: () => void;
};

function Panel({ workspace, lists, query, reduce, rail, onExpand, onSelect, onReorder, onMoved, onCreate, onClear }: PanelProps) {
  const group = useId();
  const present = useIsPresent();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocus = useRef<string | null>(null);
  const [draft, setDraft] = useState(0);
  const [created, setCreated] = useState<string | null>(null);
  const favorites = lists.favorites.filter(item => matches(item.name, query));
  const projects = lists.projects.filter(item => matches(item.name, query));
  const empty = !!query && favorites.length === 0 && projects.length === 0;

  function move(id: string, direction: -1 | 1) {
    const index = lists.favorites.findIndex(item => item.id === id);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= lists.favorites.length) return;
    const copy = [...lists.favorites];
    [copy[index], copy[next]] = [copy[next], copy[index]];
    onReorder(workspace.id, copy);
    onMoved(workspace.id, id, copy);
    requestAnimationFrame(() => buttons.current.get(id)?.focus());
  }

  function create(name: string, focus: boolean) {
    const id = onCreate(workspace.id, name);
    setCreated(id);
    setDraft(value => value + 1);
    if (focus) pendingFocus.current = id;
  }

  /** A project made with Enter takes focus as soon as its row exists, so the keyboard continues from the new item. */
  const register = (id: string) => (node: HTMLButtonElement | null) => {
    if (!node) { buttons.current.delete(id); return; }
    buttons.current.set(id, node);
    if (pendingFocus.current === id) { pendingFocus.current = null; node.focus({ preventScroll: true }); }
  };

  return <motion.div className={styles.panel} inert={!present} aria-hidden={present ? undefined : true} initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8, filter: `blur(${blur.soft}px)` }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={reduce ? { opacity: 0, transition: instant } : { opacity: 0, y: -4, filter: `blur(${blur.subtle}px)`, transition: { duration: duration.fast, ease: standard } }} transition={reduce ? instant : { duration: duration.standard + .04, ease: enter }}>
    <LayoutGroup id={group}>
      <AnimatePresence initial={false}>
        {favorites.length > 0 && <motion.section key="favorites" className={styles.section} aria-labelledby={`${group}-favorites`} initial={rowIn} animate={rowShown} exit={rowOut} transition={reduce ? instant : rowMotion}>
          <SectionTitle id={`${group}-favorites`} text="Favorites" rail={rail} reduce={reduce} />
          <p id={`${group}-hint`} className={styles.srOnly}>Drag, or press Alt with the up and down arrows, to reorder.</p>
          <Reorder.Group as="ul" axis="y" values={lists.favorites} onReorder={next => onReorder(workspace.id, next)} className={styles.list}>
            <AnimatePresence initial={false}>
              {favorites.map(item => <FavoriteRow key={item.id} item={item} query={query} active={lists.active === item.id} draggable={!query} reduce={reduce} rail={rail} hint={`${group}-hint`} buttonRef={register(item.id)} onSelect={() => onSelect(workspace.id, item.id, item.name)} onMove={direction => move(item.id, direction)} onDropped={() => onMoved(workspace.id, item.id)} />)}
            </AnimatePresence>
          </Reorder.Group>
        </motion.section>}

        {(projects.length > 0 || !query) && <motion.section key="projects" className={styles.section} aria-labelledby={`${group}-projects`} initial={rowIn} animate={rowShown} exit={rowOut} transition={reduce ? instant : rowMotion}>
          <SectionTitle id={`${group}-projects`} text="Projects" rail={rail} reduce={reduce} />
          <ul className={styles.list}>
            <AnimatePresence initial={false}>
              {projects.map(project => <motion.li key={project.id} className={styles.item} initial={created === project.id ? false : rowIn} animate={rowShown} exit={rowOut} transition={reduce ? instant : rowMotion}>
                <RailTip enabled={rail} label={project.name} note={project.unread ? "New activity" : undefined}>
                  <button ref={register(project.id)} type="button" className={styles.row} aria-current={lists.active === project.id ? "page" : undefined} onClick={() => onSelect(workspace.id, project.id, project.name)}>
                    {lists.active === project.id && <Highlight reduce={reduce} />}
                    <span className={styles.lead}><span className={styles.dot} data-tone={project.tone} /></span>
                    <Name name={project.name} query={query} unread={project.unread} />
                    <span className={styles.trail}>
                      <AnimatePresence initial={false}>
                        {project.unread && <motion.span key="unread" className={styles.unread} initial={{ opacity: 0, scale: .4 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .4 }} transition={reduce ? instant : spring.snappy}><span className={styles.srOnly}>, new activity</span></motion.span>}
                      </AnimatePresence>
                    </span>
                    {/* In the rail, new activity moves to a small dot on the project's corner. */}
                    <span className={styles.railDot} aria-hidden="true">
                      <AnimatePresence initial={false}>
                        {project.unread && <motion.span key="dot" className={styles.railDotFace} initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={reduce ? instant : spring.snappy} />}
                      </AnimatePresence>
                    </span>
                  </button>
                </RailTip>
              </motion.li>)}
            </AnimatePresence>
          </ul>
          <AnimatePresence initial={false}>
            {!query && <motion.div key="composer" initial={rowIn} animate={rowShown} exit={rowOut} transition={reduce ? instant : rowMotion}>
              <Composer key={draft} first={draft === 0} tone={toneFor(lists.projects.length)} reduce={reduce} rail={rail} onExpand={onExpand} taken={name => lists.projects.find(project => project.name.toLowerCase() === name.toLowerCase())?.name} onCreate={create} />
            </motion.div>}
          </AnimatePresence>
        </motion.section>}

        {empty && <motion.div key="empty" className={styles.empty} data-rail-hidden="" inert={rail} initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6, filter: `blur(${blur.soft}px)` }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={{ opacity: 0, transition: { duration: reduce ? 0 : duration.instant } }} transition={reduce ? instant : { duration: duration.standard, ease: enter, delay: duration.fast }}>
          <div className={styles.emptyBody}>
            <p>Nothing matches “{query}”</p>
            <span>Search looks at favorites and projects in {workspace.name}.</span>
            <Button type="button" size="sm" variant="secondary" onClick={onClear}>Show all projects</Button>
          </div>
        </motion.div>}
      </AnimatePresence>
    </LayoutGroup>
  </motion.div>;
}

/** A mouse lifts a favorite as soon as it moves. A finger has to hold still for a moment first, so a swipe over the list still scrolls it. */
const LONG_PRESS = 320;

function FavoriteRow({ item, query, active, draggable, reduce, rail, hint, buttonRef, onSelect, onMove, onDropped }: { item: Favorite; query: string; active: boolean; draggable: boolean; reduce: boolean; rail: boolean; hint: string; buttonRef: (node: HTMLButtonElement | null) => void; onSelect: () => void; onMove: (direction: -1 | 1) => void; onDropped: () => void }) {
  const dragged = useRef(false);
  const node = useRef<HTMLLIElement>(null);
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const armed = useRef(false);
  const controls = useDragControls();
  const [lifted, setLifted] = useState(false);
  const Icon = kindIcons[item.kind];

  // Once a touch has lifted the row, the finger drags it instead of scrolling the list.
  useEffect(() => {
    const element = node.current;
    if (!element) return;
    const hold = (event: TouchEvent) => { if (armed.current && event.cancelable) event.preventDefault(); };
    element.addEventListener("touchmove", hold, { passive: false });
    return () => { element.removeEventListener("touchmove", hold); if (press.current) window.clearTimeout(press.current.timer); };
  }, []);

  function cancelPress() {
    if (!press.current) return;
    window.clearTimeout(press.current.timer);
    press.current = null;
  }
  function onPointerDown(event: ReactPointerEvent<HTMLLIElement>) {
    dragged.current = false;
    if (!draggable || event.button !== 0) return;
    if (event.pointerType !== "touch") { controls.start(event); return; }
    const native = event.nativeEvent;
    cancelPress();
    press.current = { x: event.clientX, y: event.clientY, timer: window.setTimeout(() => {
      press.current = null;
      armed.current = true;
      // A long press never also opens the row.
      dragged.current = true;
      setLifted(true);
      controls.start(native);
    }, LONG_PRESS) };
  }
  function onPointerMove(event: ReactPointerEvent<HTMLLIElement>) {
    if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 8) cancelPress();
  }
  function onPointerEnd() {
    cancelPress();
    // A lifted row that never moved settles back down.
    if (armed.current) requestAnimationFrame(() => { if (armed.current) { armed.current = false; setLifted(false); } });
  }
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!event.altKey || !draggable || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    onMove(event.key === "ArrowUp" ? -1 : 1);
  }
  return <Reorder.Item ref={node} value={item} as="li" className={styles.item} data-lifted={lifted ? "" : undefined} drag={draggable ? "y" : false} dragListener={false} dragControls={controls} dragMomentum={false} dragTransition={{ bounceStiffness: 520, bounceDamping: 40 }}
    initial={rowIn} animate={rowShown} exit={rowOut} transition={reduce ? instant : { ...rowMotion, layout: spring.smooth }}
    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd} onContextMenu={event => { if (armed.current || press.current) event.preventDefault(); }}
    onDragStart={() => { dragged.current = true; setLifted(true); }} onDragEnd={() => { armed.current = false; setLifted(false); onDropped(); }}>
    <RailTip enabled={rail && !lifted} label={item.name}>
      <button ref={buttonRef} type="button" className={styles.row} aria-current={active ? "page" : undefined} aria-describedby={draggable ? hint : undefined} onKeyDown={onKeyDown} onClick={() => { if (dragged.current) { dragged.current = false; return; } onSelect(); }}>
        {active && <Highlight reduce={reduce} />}
        <span className={styles.lead}><Icon size={16} strokeWidth={1.75} aria-hidden="true" /></span>
        <Name name={item.name} query={query} />
      </button>
    </RailTip>
  </Reorder.Item>;
}

/** The last row opens into a field in place. On Enter its border dissolves and its dot fills, so the field itself becomes the new project. */
function Composer({ first, tone, reduce, rail, onExpand, taken, onCreate }: { first: boolean; tone: Tone; reduce: boolean; rail: boolean; onExpand: () => void; taken: (name: string) => string | undefined; onCreate: (name: string, focus: boolean) => void }) {
  const id = useId();
  const [state, setState] = useState<"idle" | "open" | "commit">("idle");
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  function open() {
    setState("open");
    requestAnimationFrame(() => input.current?.focus());
  }
  function close(returnFocus: boolean) {
    setState("idle"); setValue(""); setError("");
    if (returnFocus) requestAnimationFrame(() => trigger.current?.focus());
  }
  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (state !== "open") return;
    const name = value.trim().replace(/\s+/g, " ");
    if (!name) { close(true); return; }
    const existing = taken(name);
    if (existing) { setError(`There is already a project named ${existing}`); return; }
    setValue(name); setState("commit");
    const focus = !!event;
    timer.current = window.setTimeout(() => onCreate(name, focus), reduce ? 0 : 280);
  }
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
  }
  const idle = state === "idle";
  const swapIn = reduce ? { opacity: 0 } : { opacity: 0, y: "0.3em", filter: `blur(${blur.soft}px)` };
  const swapOut = reduce ? { opacity: 0, transition: instant } : { opacity: 0, y: "-0.3em", filter: `blur(${blur.subtle}px)`, transition: { duration: duration.instant, ease: standard } };

  return <motion.div className={styles.composerWrap} initial={first || reduce ? false : { opacity: 0, y: -6, filter: `blur(${blur.subtle}px)` }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} transition={{ duration: duration.standard, ease: enter, delay: .04 }}>
    <form className={styles.composer} data-state={state} data-invalid={error ? "" : undefined} onSubmit={submit}>
      <span className={styles.lead} aria-hidden="true">
        <AnimatePresence initial={false} mode="popLayout">
          {idle ? <motion.span key="plus" className={styles.plus} initial={{ opacity: 0, scale: .6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .6, transition: { duration: reduce ? 0 : duration.instant } }} transition={reduce ? instant : spring.snappy}><Plus size={15} strokeWidth={1.75} /></motion.span>
            : <motion.span key="dot" className={styles.dot} data-tone={tone} data-hollow={state === "open" ? "" : undefined} initial={{ opacity: 0, scale: .4 }} animate={{ opacity: 1, scale: state === "commit" && !reduce ? [1, 1.45, 1] : 1 }} exit={{ opacity: 0, transition: instant }} transition={reduce ? instant : state === "commit" ? { duration: .32, ease: standard } : spring.snappy} />}
        </AnimatePresence>
      </span>
      <span className={styles.composerField}>
        <AnimatePresence initial={false} mode="popLayout">
          {idle ? <motion.span key="label" className={styles.composerLabel} aria-hidden="true" initial={swapIn} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={swapOut} transition={reduce ? instant : { duration: duration.standard, ease: enter }}>New project</motion.span>
            : <motion.input key="input" ref={input} id={`${id}-name`} className={styles.composerInput} value={value} maxLength={32} readOnly={state === "commit"} placeholder="Project name" aria-label="Project name" aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : `${id}-help`} autoComplete="off" enterKeyHint="done"
              onChange={event => { setValue(event.target.value); if (error) setError(""); }} onKeyDown={onKeyDown} onBlur={() => { if (state === "open") { if (value.trim() && !error) submit(); else close(false); } }}
              initial={swapIn} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={swapOut} transition={reduce ? instant : { duration: duration.standard, ease: enter }} />}
        </AnimatePresence>
      </span>
      <span className={styles.composerNote} aria-hidden="true">
        <AnimatePresence initial={false}>
          {error && <motion.span key="taken" initial={swapIn} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={swapOut} transition={reduce ? instant : { duration: duration.standard, ease: enter }}>Name taken</motion.span>}
        </AnimatePresence>
      </span>
      {/* In the rail there is no room to type, so the sidebar opens first and the field follows. */}
      {idle && <RailTip enabled={rail} label="New project"><button ref={trigger} type="button" className={styles.composerTrigger} onClick={() => { if (rail) onExpand(); open(); }}>New project</button></RailTip>}
      <span id={`${id}-help`} className={styles.srOnly}>Press Enter to create the project or Escape to cancel.</span>
      <span id={`${id}-error`} className={styles.srOnly} role="alert">{error}</span>
    </form>
  </motion.div>;
}

/** Locks the page behind the open drawer, keeping the scrollbar's room so nothing shifts sideways. */
function usePageLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return;
    const root = document.documentElement;
    const previous = { overflow: root.style.overflow, gutter: root.style.scrollbarGutter };
    if (root.scrollHeight > root.clientHeight) root.style.scrollbarGutter = "stable";
    root.style.overflow = "hidden";
    return () => { root.style.overflow = previous.overflow; root.style.scrollbarGutter = previous.gutter; };
  }, [locked]);
}

export function WorkspaceSidebar({ className, onNavigate, defaultCollapsed = false, onCollapsedChange }: WorkspaceSidebarProps) {
  const reduce = useReducedMotionSafe();
  const phone = usePhone();
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [drawer, setDrawer] = useState(false);
  // The drawer stays visible until its slide out settles, then leaves the accessibility tree.
  const [shown, setShown] = useState(false);
  const returnFocus = useRef(false);
  const backdropPress = useRef(false);
  const menuOpen = useRef(false);
  // A phone has no rail: the drawer always opens at full width, and leaving phone width closes it.
  const rail = collapsed && !phone;
  if (!phone && (drawer || shown)) { setDrawer(false); setShown(false); }
  const navId = useId();
  const frame = useRef<HTMLElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef(0);
  // The drawer's offset and fade are motion values, so a finger can hold it mid-slide and the backdrop dims with its position.
  const sheetX = useMotionValue(-4096);
  const sheetFade = useMotionValue(1);
  const travel = useRef(320);
  const release = useRef(0);
  const swipe = useRef<{ id: number; x: number; y: number; time: number; axis: "x" | "y" | null; velocity: number } | null>(null);
  const shade = useTransform([sheetX, sheetFade], ([x, fade]: number[]) => Math.min(1, Math.max(0, 1 + x / travel.current)) * fade);
  const searchClip = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  // The search field keeps its open width while the sidebar moves, so it is uncovered from under the toggle instead of squeezed.
  const width = useRailWidth(rail, reduce, () => { if (searchClip.current) delete searchClip.current.dataset.frozen; });
  const [workspaceId, setWorkspaceId] = useState("northwind");
  const [lists, setLists] = useState(initialLists);
  const [query, setQuery] = useState("");
  const [away, setAway] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [highlight, setHighlight] = useState<{ top: number; height: number; glide: boolean } | null>(null);
  const pointer = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const workspace = workspaces.find(item => item.id === workspaceId) ?? workspaces[0];
  const current = lists[workspace.id];
  const page = current.projects.find(item => item.id === current.active) ?? current.favorites.find(item => item.id === current.active);
  const percent = Math.round((workspace.used / workspace.limit) * 100);
  const full = percent >= 90;
  const search = query.trim();
  usePageLock(phone && drawer);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);
  // Focus moves into the drawer once it can take it, and back to the bar's button once the bar is interactive again.
  useEffect(() => {
    if (drawer) sheet.current?.focus({ preventScroll: true });
    else if (returnFocus.current) { returnFocus.current = false; opener.current?.focus({ preventScroll: true, focusVisible: false } as FocusOptions); }
  }, [drawer]);
  // One spring carries the drawer in and out from wherever it is, including mid-swipe, so a reversal never restarts the slide.
  useEffect(() => {
    if (!shown) return;
    const settle = () => { if (!drawer) setShown(false); };
    if (reduce) {
      // Nothing travels: the drawer fades in place, and only moves off screen once it is invisible.
      if (drawer) sheetX.jump(0);
      const fade = animate(sheetFade, drawer ? 1 : 0, { duration: duration.fast, ease: standard, onComplete: () => { if (!drawer) sheetX.jump(-travel.current); settle(); } });
      return () => fade.stop();
    }
    sheetFade.jump(1);
    // A swipe hands over its release speed, so the close continues the throw instead of restarting it.
    const velocity = release.current;
    release.current = 0;
    const slide = animate(sheetX, drawer ? 0 : -travel.current, { ...spring.smooth, velocity, onComplete: settle });
    return () => slide.stop();
  }, [drawer, shown, reduce, sheetX, sheetFade]);

  function update(id: string, change: (current: Lists) => Lists) {
    setLists(all => ({ ...all, [id]: change(all[id]) }));
  }

  function switchTo(id: string) {
    const next = workspaces.find(item => item.id === id);
    if (!next || id === workspaceId) return;
    setWorkspaceId(id);
    setAnnouncement(`Switched to ${next.name}`);
  }

  function openDrawer() {
    window.clearTimeout(closeTimer.current);
    // The slide starts just past the drawer's own edge, measured each time so a rotated phone still travels the right distance.
    const node = sheet.current;
    if (node) travel.current = node.offsetLeft + node.offsetWidth + 12;
    if (!shown) { sheetX.jump(-travel.current); sheetFade.jump(reduce ? 0 : 1); }
    // Focus moves into the drawer itself, so the keyboard starts at its top without a phone keyboard popping up.
    setShown(true);
    setDrawer(true);
  }
  function closeDrawer(delay = 0) {
    window.clearTimeout(closeTimer.current);
    const close = () => {
      const active = document.activeElement;
      returnFocus.current = !active || active === document.body || !!sheet.current?.contains(active);
      setDrawer(false);
    };
    if (delay && !reduce) closeTimer.current = window.setTimeout(close, delay);
    else close();
  }

  function select(id: string, itemId: string, name: string) {
    update(id, current => ({ ...current, active: itemId, projects: current.projects.map(project => project.id === itemId ? { ...project, unread: false } : project) }));
    onNavigate?.({ workspace: id, id: itemId, name });
    // Picking a page on a phone puts the page back in view; the highlight lands first so the choice reads.
    if (phone) closeDrawer(140);
  }

  function announceMove(id: string, itemId: string, favorites = lists[id].favorites) {
    const index = favorites.findIndex(item => item.id === itemId);
    if (index >= 0) setAnnouncement(`${favorites[index].name} moved to position ${index + 1} of ${favorites.length}`);
  }

  function create(id: string, name: string) {
    const count = lists[id].projects.length;
    const project: Project = { id: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${count}`, name, tone: toneFor(count), unread: false };
    update(id, current => ({ ...current, active: project.id, projects: [...current.projects, project] }));
    setAnnouncement(`Created ${name}`);
    onNavigate?.({ workspace: id, id: project.id, name });
    if (phone) closeDrawer(420);
    return project.id;
  }

  function changeQuery(value: string) {
    setQuery(value);
    const text = value.trim();
    if (!text) { setAnnouncement("Showing all favorites and projects"); return; }
    const current = lists[workspaceId];
    const count = current.favorites.filter(item => matches(item.name, text)).length + current.projects.filter(item => matches(item.name, text)).length;
    setAnnouncement(count === 0 ? `No results for ${text}` : `${count} ${count === 1 ? "result" : "results"}`);
  }

  function setRail(next: boolean) {
    if (next === collapsed) return;
    const clip = searchClip.current;
    if (next && clip && !("frozen" in clip.dataset)) {
      clip.style.setProperty("--search-width", `${clip.clientWidth}px`);
      clip.dataset.frozen = "";
    }
    // Focus never stays behind in a part of the sidebar the rail hides.
    const active = document.activeElement;
    if (next && active instanceof HTMLElement && active.closest("[data-rail-hidden]") && frame.current?.contains(active)) toggleRef.current?.focus();
    setCollapsed(next);
    setAnnouncement(next ? "Sidebar collapsed" : "Sidebar expanded");
    onCollapsedChange?.(next);
  }
  useRailShortcut(frame, () => { if (phone) { if (drawer) closeDrawer(); else openDrawer(); } else setRail(!collapsed); });

  function toggleAway() {
    setAway(value => !value);
    setAnnouncement(away ? "Status set to active" : "Status set to away");
  }

  function onMenuFocus(event: FocusEvent<HTMLDivElement>) {
    const item = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[role="menuitemradio"]') : null;
    if (!item) { setHighlight(null); return; }
    const glide = pointer.current;
    setHighlight(current => ({ top: item.offsetTop, height: item.offsetHeight, glide: glide && current !== null }));
  }

  /** A horizontal swipe toward the edge drags the drawer with the finger; a flick or a pull past a third closes it, anything less springs back. Vertical moves stay with the list. */
  function onSheetPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" || !drawer || swipe.current) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("input, textarea, [data-lifted]")) return;
    swipe.current = { id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp, axis: null, velocity: 0 };
  }
  function onSheetPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = swipe.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    if (!gesture.axis) {
      if (Math.hypot(dx, dy) < 8) return;
      // A row lifted for reordering keeps the finger.
      gesture.axis = Math.abs(dx) > Math.abs(dy) * 1.2 && !sheet.current?.querySelector("[data-lifted]") ? "x" : "y";
      if (gesture.axis === "x") { gesture.x = event.clientX; event.currentTarget.setPointerCapture(event.pointerId); }
      return;
    }
    if (gesture.axis !== "x") return;
    const offset = event.clientX - gesture.x;
    // Past the open position the drawer gives a little and resists, like a sheet that is already fully out.
    const next = offset > 0 ? 10 * (1 - Math.exp(-offset / 60)) : offset;
    const elapsed = Math.max(1, event.timeStamp - gesture.time);
    gesture.velocity = (next - sheetX.get()) / elapsed * 1000;
    gesture.time = event.timeStamp;
    sheetX.jump(next);
  }
  function onSheetPointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = swipe.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    swipe.current = null;
    if (gesture.axis !== "x") return;
    const x = sheetX.get();
    const close = event.type !== "pointercancel" && (x < -travel.current / 3 || gesture.velocity < -500);
    if (!close) { animate(sheetX, 0, reduce ? instant : { ...spring.smooth, velocity: gesture.velocity }); return; }
    release.current = gesture.velocity;
    closeDrawer();
  }

  /** The drawer is a modal layer: Tab stays inside it and Escape closes it, unless a menu or field inside handled the key first. */
  function onSheetKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target instanceof Element ? event.target : null;
    if (event.defaultPrevented || !sheet.current || !target || !sheet.current.contains(target)) return;
    if (event.key === "Escape") { event.preventDefault(); closeDrawer(); return; }
    if (event.key !== "Tab") return;
    const items = [...sheet.current.querySelectorAll<HTMLElement>(focusable)].filter(item => !item.closest("[inert]") && item.getClientRects().length > 0);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === sheet.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  const nav = <motion.nav ref={frame} id={navId} className={[styles.sidebar, className].filter(Boolean).join(" ")} aria-label="Workspace" style={phone ? undefined : { width }} data-rail={rail || undefined} data-placement={phone ? "drawer" : "inline"}>
      <div className={styles.header}>
        <Menu.Root onOpenChange={open => { menuOpen.current = open; if (open) setHighlight(null); }}>
          <RailTip enabled={rail} label={workspace.name} note={`${workspace.plan} plan`}>
            <Menu.Trigger ref={trigger} className={styles.switcher} aria-label={`${workspace.name}, ${workspace.plan} plan. Switch workspace`}>
              <Mark workspace={workspace} reduce={reduce} />
              <span className={styles.switcherText}>
                <TextMorph className={styles.workspaceName}>{workspace.name}</TextMorph>
                <Swap className={styles.workspaceMeta} text={`${workspace.plan} · ${workspace.members}`} reduce={reduce} />
              </span>
              <ChevronsUpDown className={styles.chevron} size={16} strokeWidth={1.75} aria-hidden="true" />
            </Menu.Trigger>
          </RailTip>
          <Menu.Portal>
            <Menu.Content className={styles.menu} align="start" sideOffset={6} collisionPadding={12} loop onFocus={onMenuFocus} onCloseAutoFocus={event => { if (!pointer.current) return; event.preventDefault(); trigger.current?.focus({ preventScroll: true, focusVisible: false } as FocusOptions); }} onPointerMoveCapture={() => { pointer.current = true; }} onKeyDownCapture={() => { pointer.current = false; }}>
              <motion.span className={styles.menuHighlight} aria-hidden="true" initial={false} animate={highlight ? { y: highlight.top, height: highlight.height, opacity: 1 } : { opacity: 0 }} transition={{ default: highlight?.glide && !reduce ? spring.snappy : instant, opacity: { duration: reduce ? 0 : .08 } }} />
              <Menu.Label className={styles.menuLabel}>Switch workspace</Menu.Label>
              <Menu.RadioGroup value={workspaceId} onValueChange={switchTo}>
                {workspaces.map((item, index) => <Menu.RadioItem key={item.id} value={item.id} className={styles.menuItem} style={{ "--i": index } as CSSProperties}>
                  <Mark workspace={item} small reduce={reduce} />
                  <span className={styles.menuText}><span>{item.name}</span><small>{item.plan} plan · {item.members}</small></span>
                  <Menu.ItemIndicator className={styles.menuCheck}><Check size={16} strokeWidth={1.75} aria-hidden="true" /></Menu.ItemIndicator>
                </Menu.RadioItem>)}
              </Menu.RadioGroup>
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
        {/* The toggle rides the sidebar's edge, so it settles on the rail's icon axis as the width closes. In the drawer it closes the drawer. */}
        <div className={styles.searchRow}>
          <div ref={searchClip} className={styles.searchClip} data-rail-hidden="" inert={rail}>
            <div className={styles.search}>
              <SearchField label="Search favorites and projects" placeholder="Search" value={query} onValueChange={changeQuery} onKeyDown={event => { if (event.key === "Escape" && query) { event.preventDefault(); changeQuery(""); } }} />
            </div>
          </div>
          {phone
            ? <button ref={toggleRef} type="button" className={styles.toggle} aria-label="Close sidebar" onClick={() => closeDrawer()}><X size={18} strokeWidth={1.75} aria-hidden="true" /></button>
            : <RailTip label={collapsed ? "Expand sidebar" : "Collapse sidebar"} shortcut="[" side={collapsed ? "right" : "bottom"}>
              <button ref={toggleRef} type="button" className={styles.toggle} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed} aria-keyshortcuts="[" onClick={() => setRail(!collapsed)}><PanelGlyph collapsed={collapsed} reduce={reduce} /></button>
            </RailTip>}
        </div>
      </div>

      <motion.div className={styles.scroll} layoutScroll>
        <div className={styles.stack}>
          <AnimatePresence initial={false}>
            <Panel key={workspace.id} workspace={workspace} lists={current} query={search} reduce={reduce} rail={rail} onExpand={() => setRail(false)} onSelect={select}
              onReorder={(id, favorites) => update(id, current => ({ ...current, favorites }))} onMoved={announceMove} onCreate={create} onClear={() => changeQuery("")} />
          </AnimatePresence>
        </div>
      </motion.div>

      <div className={styles.footer}>
        {/* The meter has no useful rail form, so it folds away and returns with the labels. */}
        <motion.div className={styles.storageFold} data-rail-hidden="" inert={rail} initial={false} animate={{ height: rail ? 0 : "auto" }} transition={reduce ? instant : spring.smooth}>
          <div className={styles.storage} data-full={full ? "" : undefined}>
            <div className={styles.storageHead}>
              <Swap className={styles.storageLabel} text={full ? "Storage almost full" : "Storage"} reduce={reduce} />
              <span className={styles.percent}><AnimatedCounter value={percent} suffix="%" /></span>
            </div>
            <div className={styles.track} role="meter" aria-label="Storage used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${percent}%, ${workspace.used} of ${workspace.limit} GB`}>
              <motion.span className={styles.fill} initial={false} animate={{ scaleX: percent / 100 }} transition={reduce ? instant : spring.smooth} />
            </div>
            <Swap className={styles.storageDetail} text={`${workspace.used} GB of ${workspace.limit} GB`} reduce={reduce} />
          </div>
        </motion.div>
        <RailTip enabled={rail} label="Emma Collins" note={away ? "Away" : "Active"}>
          <button type="button" className={styles.user} onClick={toggleAway} aria-label={`Emma Collins, ${away ? "away" : "active"}. Set status to ${away ? "active" : "away"}`}>
            <Avatar name="Emma Collins" src="/media/people/emma-collins.jpg" size="md" status={away ? "offline" : "online"} />
            <span className={styles.userText}><span className={styles.userName}>Emma Collins</span><TextMorph className={styles.userStatus}>{away ? "Away" : "Active"}</TextMorph></span>
            <Swap className={styles.userHint} text={away ? "Set active" : "Set away"} reduce={reduce} />
          </button>
        </RailTip>
      </div>
      <p className={styles.srOnly} role="status" aria-live="polite">{announcement}</p>
    </motion.nav>;

  if (!phone) return <TooltipPrimitive.Provider delayDuration={250} skipDelayDuration={300}>{nav}</TooltipPrimitive.Provider>;

  /* Phones: a compact bar names the open page, and the sidebar slides in over the content from the bar's edge. It stays mounted while closed, so its scroll and state are where they were left. */
  return <TooltipPrimitive.Provider delayDuration={250} skipDelayDuration={300}>
    <div className={styles.topbar} inert={drawer}>
      <button ref={opener} type="button" className={styles.opener} aria-label="Open sidebar" aria-expanded={drawer} aria-controls={navId} aria-keyshortcuts="[" onClick={openDrawer}><PanelGlyph collapsed reduce={reduce} /></button>
      <Mark workspace={workspace} small reduce={reduce} />
      <span className={styles.topbarText}>
        <Swap className={styles.topbarPage} text={page?.name ?? workspace.name} reduce={reduce} />
        <Swap className={styles.topbarWorkspace} text={workspace.name} reduce={reduce} />
      </span>
    </div>
    {createPortal(<>
      <motion.div className={styles.backdrop} data-open={drawer ? "" : undefined} data-shown={shown ? "" : undefined} aria-hidden="true" style={{ opacity: shade }}
        onPointerDown={() => { backdropPress.current = !menuOpen.current; }} onClick={() => { if (backdropPress.current) closeDrawer(); backdropPress.current = false; }} />
      <motion.div ref={sheet} className={styles.sheet} data-shown={shown ? "" : undefined} role="dialog" aria-modal="true" aria-label="Workspace sidebar" tabIndex={-1} inert={!drawer} onKeyDown={onSheetKeyDown}
        style={{ x: sheetX, opacity: sheetFade }} onPointerDown={onSheetPointerDown} onPointerMove={onSheetPointerMove} onPointerUp={onSheetPointerEnd} onPointerCancel={onSheetPointerEnd}>
        {nav}
      </motion.div>
    </>, document.body)}
  </TooltipPrimitive.Provider>;
}

export default WorkspaceSidebar;
