"use client";

import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode, RefObject } from "react";
import { AnimatePresence, animate, motion, motionValue, useReducedMotion } from "motion/react";
import type { AnimationPlaybackControls, MotionStyle, MotionValue, Transition } from "motion/react";
import { ChevronDown, ChevronLeft, ChevronRight, MapPin, Plus } from "lucide-react";
import SegmentedControl from "../../segmented-control/segmented-control";
import { motionTokens } from "../../lib/motion-tokens";
import { DAY, createFormat, dayOf, fromWall, isWeekend, layoutDay, layoutLanes, minuteOf, startOfWeek, toWall, zoneLabel, type CalendarFormat, type Wall } from "./calendar-time";
import { SAMPLE_CALENDARS, SAMPLE_DATE, sampleEvents, type CalendarAttendee, type CalendarEvent, type CalendarSource } from "./week-calendar-data";
import { CalendarList, EventDetails, Faces, MiniMonth, CalendarPopover, QuickCreate, CalendarUndoToast, colorOf, monthOf, tint } from "./calendar-parts";
import styles from "./week-calendar.module.css";

export type { CalendarAttendee, CalendarColor, CalendarEvent, CalendarSource } from "./week-calendar-data";
export { SAMPLE_CALENDARS, sampleEvents } from "./week-calendar-data";

export type CalendarView = "week" | "workweek" | "day" | "3day" | "agenda";

export interface WeekCalendarProps {
  /** Controlled events. Pair with `onEventsChange`. */
  events?: CalendarEvent[];
  /** Starting events when uncontrolled. Without either, the calendar shows a sample week. */
  defaultEvents?: CalendarEvent[];
  /** Every change: create, move, resize, edit, delete and undo. */
  onEventsChange?: (events: CalendarEvent[]) => void;
  onCreate?: (event: CalendarEvent) => void;
  onUpdate?: (event: CalendarEvent, previous: CalendarEvent) => void;
  onDelete?: (event: CalendarEvent) => void;
  /** Calendars that color events and can be toggled. Events whose calendarId matches none render in neutral. */
  calendars?: CalendarSource[];
  /** The day to open on. Defaults to today, or to the sample week when showing sample events. */
  defaultDate?: Date;
  defaultView?: CalendarView;
  onViewChange?: (view: CalendarView) => void;
  /** 0 is Sunday, 1 is Monday. */
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** First and last visible hour of the day grid. */
  startHour?: number;
  endHour?: number;
  /** IANA zone the grid runs in, such as "America/New_York". Defaults to the browser's zone. */
  timeZone?: string;
  locale?: string;
  className?: string;
}

const { duration, ease } = motionTokens;
const enterEase = [...ease.enter] as [number, number, number, number];
/** Spring tokens restated as stiffness and damping, so a retarget keeps its feel instead of restarting. */
const physical = (visualDuration: number, bounce = 0): Transition => {
  const root = 2 * Math.PI / (visualDuration * 1.2);
  return { type: "spring", stiffness: root * root, damping: 2 * (1 - bounce) * root, mass: 1 };
};
/** Pages slide without overshoot; events settle into place; a dragged event hops quickly between slots. */
const slide = physical(.46);
const settle = physical(.38);
const follow = physical(.16);

/** Height of one hour in px. Keep in step with --hour in the stylesheet. */
const HOUR = 52;
const PX = HOUR / 60;
const SNAP = 15;
/** Height of one all day lane in px, and how many lanes show before the row collapses. */
const LANE = 24;
const MAX_LANES = 2;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** The wall clock as a whole minute, refreshed on each minute boundary. The server renders without it, so today and the now line appear after hydration. */
const subscribeMinute = (tick: () => void) => {
  let interval: ReturnType<typeof setInterval> | undefined;
  const timeout = setTimeout(() => { tick(); interval = setInterval(tick, 60000); }, 60000 - Date.now() % 60000 + 30);
  return () => { clearTimeout(timeout); clearInterval(interval); };
};
const readMinute = () => Math.floor(Date.now() / 60000);
const serverMinute = () => null;

type Size = "compact" | "regular" | "wide";
const sizeOf = (width: number): Size => width < 640 ? "compact" : width >= 1100 ? "wide" : "regular";
const effectiveView = (view: CalendarView, size: Size): CalendarView =>
  size === "compact" ? (view === "week" || view === "workweek" ? "3day" : view) : (view === "3day" || view === "agenda" ? "week" : view);
const stepOf = (view: CalendarView) => view === "day" ? 1 : view === "3day" ? 3 : 7;
function rangeFor(view: CalendarView, anchor: number, weekStartsOn: number) {
  if (view === "day") return [anchor];
  if (view === "3day") return [anchor, anchor + 1, anchor + 2];
  const first = startOfWeek(anchor, weekStartsOn);
  const days = Array.from({ length: 7 }, (_, i) => first + i);
  return view === "workweek" ? days.filter(day => !isWeekend(day)) : days;
}

const WIDE_VIEWS = [{ value: "week", label: "Week" }, { value: "workweek", label: "Work week" }, { value: "day", label: "Day" }];
const COMPACT_VIEWS = [{ value: "3day", label: "3 days" }, { value: "day", label: "Day" }, { value: "agenda", label: "Agenda" }];

type Item = { id: string; event: CalendarEvent; start: Wall; end: Wall; allDay: boolean; color: string; calendarName: string };
type Pane = { key: string; view: CalendarView; days: number[]; x: MotionValue<number>; opacity: MotionValue<number> };
type Drag = { kind: "create" | "move" | "resize"; id: string | null; start: Wall; end: Wall };
type Draft = { start: Wall; end: Wall; calendarId: string };
type PopoverState = { kind: "details"; id: string } | { kind: "create" } | { kind: "calendars" } | null;
type Gesture = {
  intent: "create" | "move" | "resize" | "swipe"; id: string | null; pointerId: number; touch: boolean;
  x0: number; y0: number; x: number; y: number; t: number; vx: number;
  state: "pending" | "active" | "swipe"; timer: ReturnType<typeof setTimeout> | null;
  anchorDay: number; anchorMinute: number; grab: number; origin: { start: Wall; end: Wall };
  /** A swipe moves the current range from `base` and shows its neighbors `width` away on either side. */
  base?: number; width?: number; peeks?: Pane[];
};
type Toast = { id: number; message: string; undo?: () => void };

const INSTRUCTIONS = "Drag on empty time to add an event, then name it and press Enter. Drag an event to move it, or drag its bottom edge to change its length. Arrow keys move between days, T goes to today, N adds an event, Delete removes the selected event, and Escape closes. With an event focused, Alt and an arrow key move it by a day or 15 minutes, and Alt Shift Up or Down changes its length.";

/**
 * A week calendar with the feel of a native app. Drag on empty time to draw an event, drag events between days and
 * times, stretch the bottom edge to resize, and click to edit in place; everything snaps to 15 minutes. Overlapping
 * events share their time side by side, weeks slide in the direction of travel, and phones get a three day view with
 * swipes, long press to drag, and an agenda list.
 */
export function WeekCalendar({
  events: controlled, defaultEvents, onEventsChange, onCreate, onUpdate, onDelete, calendars: calendarsProp, defaultDate, defaultView = "week", onViewChange,
  weekStartsOn = 1, startHour = 0, endHour = 24, timeZone, locale = "en-US", className,
}: WeekCalendarProps) {
  const sample = controlled === undefined && defaultEvents === undefined;
  const reduced = !!useReducedMotion();
  const fmt = useMemo(() => createFormat(locale), [locale]);
  const calendars = calendarsProp ?? SAMPLE_CALENDARS;
  const firstHour = clamp(Math.floor(startHour), 0, 23), lastHour = clamp(Math.ceil(endHour), firstHour + 1, 24);
  const dayStart = firstHour * 60, dayEnd = lastHour * 60, total = (dayEnd - dayStart) * PX;
  const instructionsId = useId();

  const [inner, setInner] = useState<CalendarEvent[]>(() => defaultEvents ?? sampleEvents(timeZone));
  const events = controlled ?? inner;
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set(calendars.filter(c => c.hidden).map(c => c.id)));

  const minute = useSyncExternalStore(subscribeMinute, readMinute, serverMinute);
  const nowWall = minute === null ? null : toWall(new Date(minute * 60000), timeZone);
  const today = nowWall === null ? null : dayOf(nowWall);
  const [zone, setZone] = useState("");

  const [anchorState, setAnchor] = useState<number | null>(() => defaultDate ? dayOf(toWall(defaultDate, timeZone)) : sample ? dayOf(toWall(SAMPLE_DATE, timeZone)) : null);
  const anchor = anchorState ?? today ?? dayOf(toWall(SAMPLE_DATE, timeZone));
  const [viewPref, setViewPref] = useState<CalendarView>(defaultView);
  const [size, setSize] = useState<Size>("regular");
  const view = effectiveView(viewPref, size);
  const days = useMemo(() => rangeFor(view, anchor, weekStartsOn), [view, anchor, weekStartsOn]);
  const key = `${view}:${days[0]}:${days.length}`;
  const [cursorState, setCursor] = useState<number | null>(null);
  const cursor = cursorState !== null && days.includes(cursorState) ? cursorState : today !== null && days.includes(today) ? today : days[0];

  const [enter, setEnter] = useState<{ key: string; x: number; opacity: number } | null>(null);
  const [leaving, setLeaving] = useState<Pane[]>([]);
  const [peeks, setPeeks] = useState<Pane[]>([]);
  const current = useMemo<Pane>(() => {
    const from = enter?.key === key ? enter : null;
    return { key, view, days, x: motionValue(from?.x ?? 0), opacity: motionValue(from?.opacity ?? 1) };
  }, [key, view, days, enter]);

  const [drag, setDrag] = useState<Drag | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [popover, setPopover] = useState<PopoverState>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [monthState, setMonth] = useState<number | null>(null);
  const month = monthState ?? monthOf(cursor);

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const agendaRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const calendarsButtonRef = useRef<HTMLButtonElement>(null);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const gesture = useRef<Gesture | null>(null);
  const latestEvents = useRef(events);
  const serial = useRef(0);
  const focusDay = useRef<number | null>(null);
  const anchorNode = useRef<HTMLElement | null>(null);
  const scrolledFor = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => { latestEvents.current = events; });

  // Container size decides the layout: phones get three days and an agenda, wide screens a sidebar.
  useLayoutEffect(() => {
    const node = rootRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { setSize(sizeOf(node.clientWidth)); setZone(zoneLabel(timeZone, locale)); });
    observer.observe(node);
    return () => observer.disconnect();
  }, [locale, timeZone]);

  // Start the entrance of a new page: it slides from the side it came from, or fades in for view changes and reduced motion.
  useEffect(() => {
    const moves: AnimationPlaybackControls[] = [];
    if (current.x.get() !== 0) moves.push(animate(current.x, 0, slide));
    if (current.opacity.get() !== 1) moves.push(animate(current.opacity, 1, { duration: duration.standard, ease: enterEase }));
    return () => moves.forEach(move => move.stop());
  }, [current]);

  const calendarById = useMemo(() => new Map(calendars.map(c => [c.id, c])), [calendars]);
  const items = useMemo(() => events.flatMap<Item>(event => {
    if (hidden.has(event.calendarId)) return [];
    const calendar = calendarById.get(event.calendarId);
    let start = toWall(event.start, timeZone), end = toWall(event.end, timeZone);
    if (event.allDay) { start = dayOf(start) * DAY; end = Math.max(start + DAY, Math.ceil(end / DAY) * DAY); }
    else end = Math.max(end, start + SNAP);
    return [{ id: event.id, event, start, end, allDay: !!event.allDay, color: colorOf(calendar), calendarName: calendar?.name ?? "Calendar" }];
  }), [events, hidden, calendarById, timeZone]);
  const itemById = useMemo(() => new Map(items.map(item => [item.id, item])), [items]);

  const defaultCalendar = calendars.find(c => !hidden.has(c.id))?.id ?? calendars[0]?.id ?? "default";
  const rangeTitle = fmt.dayRange(days[0], days[days.length - 1]);
  const isAgenda = view === "agenda";

  // Open on the working day, or on the now line when today is in view; again whenever the grid remounts.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || isAgenda) return;
    const fresh = scrolledFor.current !== scroller;
    if (!fresh && scroller.dataset.now) return;
    scrolledFor.current = scroller;
    if (nowWall !== null && days.includes(dayOf(nowWall))) {
      scroller.dataset.now = "1";
      scroller.scrollTop = Math.max(0, (minuteOf(nowWall) - dayStart) * PX - scroller.clientHeight * .3);
    } else if (fresh) scroller.scrollTop = Math.max(0, (8 * 60 - dayStart) * PX - 8);
  }, [nowWall, days, dayStart, isAgenda]);

  // Moves keyboard focus to the chosen day once its page is on screen.
  useEffect(() => {
    const day = focusDay.current;
    if (day === null) return;
    focusDay.current = null;
    surfaceRef.current?.querySelector<HTMLElement>(`[data-current] [data-day-cell="${day}"]`)?.focus({ preventScroll: true });
  }, [cursor, current]);

  const surfaceWidth = useCallback(() => (surfaceRef.current ?? agendaRef.current)?.clientWidth ?? 600, []);
  const register = useCallback((id: string, node: HTMLElement) => {
    nodes.current.set(id, node);
    return () => { if (nodes.current.get(id) === node) nodes.current.delete(id); };
  }, []);

  /** Shows another range or view. Direction slides the pages; zero crossfades; `offset` continues a swipe already in progress. */
  const go = (next: { anchor?: number; cursor?: number | null; view?: CalendarView; dir?: number; offset?: number }) => {
    const nextPref = next.view ?? viewPref;
    const nextView = effectiveView(nextPref, size);
    const nextAnchor = next.anchor ?? anchor;
    const nextDays = rangeFor(nextView, nextAnchor, weekStartsOn);
    const nextKey = `${nextView}:${nextDays[0]}:${nextDays.length}`;
    setAnchor(nextAnchor);
    setMonth(null);
    if (next.cursor !== undefined) setCursor(next.cursor);
    if (next.view && next.view !== viewPref) { setViewPref(next.view); onViewChange?.(nextView); }
    const offset = next.offset ?? 0;
    if (nextKey === current.key) { if (offset) animate(current.x, 0, slide); return; }
    setPopover(null); setDraft(null); setDrag(null); setPeeks([]);
    const dir = next.dir ?? 0, width = surfaceWidth(), outgoing = current;
    const sameLayout = (nextView === "agenda") === (current.view === "agenda");
    let done: { then: (resolve: () => void) => unknown };
    if (!sameLayout) { setEnter({ key: nextKey, x: 0, opacity: 0 }); done = Promise.resolve(); }
    else if (reduced || !dir) { setEnter({ key: nextKey, x: 0, opacity: 0 }); done = animate(outgoing.opacity, 0, { duration: duration.fast }); }
    else { setEnter({ key: nextKey, x: dir * width + offset, opacity: 1 }); done = animate(outgoing.x, -dir * width, slide); }
    if (sameLayout) {
      setLeaving(list => [...list.filter(pane => pane.key !== nextKey), outgoing]);
      done.then(() => setLeaving(list => list.filter(pane => pane !== outgoing)));
    } else setLeaving([]);
    const label = nextView === "day" ? fmt.longDate(nextDays[0]) : fmt.dayRange(nextDays[0], nextDays[nextDays.length - 1]);
    setAnnouncement(nextView === view ? label : `${nextView === "agenda" ? "Agenda" : nextView === "day" ? "Day view" : nextView === "3day" ? "Three days" : nextView === "workweek" ? "Work week" : "Week"}, ${label}`);
  };
  const navigate = (dir: number, offset = 0) => {
    const step = stepOf(view);
    go({ anchor: anchor + dir * step, cursor: cursorState === null ? null : cursor + dir * step, dir, offset });
  };
  const goToday = () => { if (today !== null) go({ anchor: today, cursor: today, dir: Math.sign(today - days[0]) }); };
  const goDay = (day: number) => go({ anchor: day, cursor: day, dir: Math.sign(day - days[0]) || (day > days[days.length - 1] ? 1 : 0) });

  const moveCursor = (delta: number) => {
    let next = cursor + delta;
    if (view === "workweek") while (isWeekend(next)) next += delta;
    focusDay.current = next;
    if (days.includes(next)) { setCursor(next); return; }
    go({ anchor: view === "3day" && delta < 0 ? next - 2 : next, cursor: next, dir: Math.sign(delta) });
  };

  // Changes to events: every path goes through apply, so controlled and uncontrolled use behave the same.
  const apply = (next: CalendarEvent[]) => {
    latestEvents.current = next;
    if (controlled === undefined) setInner(next);
    onEventsChange?.(next);
  };
  const notify = (message: string, undo?: () => void) => setToast({ id: ++serial.current, message, undo });
  const update = (id: string, patch: Partial<CalendarEvent>, message: string) => {
    const list = latestEvents.current, previous = list.find(e => e.id === id);
    if (!previous) return null;
    const next = { ...previous, ...patch };
    apply(list.map(e => e.id === id ? next : e));
    onUpdate?.(next, previous);
    setAnnouncement(message);
    return { previous, next };
  };
  const updateWithUndo = (id: string, patch: Partial<CalendarEvent>, message: string) => {
    const change = update(id, patch, message);
    if (!change) return;
    notify(message, () => {
      apply(latestEvents.current.map(e => e.id === id ? change.previous : e));
      onUpdate?.(change.previous, change.next);
      setAnnouncement(`Undone: ${message}`);
      setToast(null);
    });
  };
  const remove = (id: string) => {
    const list = latestEvents.current, index = list.findIndex(e => e.id === id);
    if (index < 0) return;
    const event = list[index];
    apply(list.filter(e => e.id !== id));
    onDelete?.(event);
    setSelectedId(null); setPopover(null);
    requestAnimationFrame(() => surfaceRef.current?.querySelector<HTMLElement>(`[data-current] [data-day-cell="${dayOf(toWall(event.start, timeZone))}"]`)?.focus({ preventScroll: true }));
    const message = `Deleted ${event.title}`;
    setAnnouncement(message);
    notify(message, () => {
      const restored = [...latestEvents.current];
      restored.splice(Math.min(index, restored.length), 0, event);
      apply(restored);
      onCreate?.(event);
      setSelectedId(event.id);
      setAnnouncement(`Restored ${event.title}`);
      setToast(null);
    });
  };
  const create = (title: string) => {
    if (!draft) return;
    const event: CalendarEvent = {
      id: `event-${Date.now().toString(36)}-${++serial.current}`, title: title.trim() || "Untitled event",
      start: fromWall(draft.start, timeZone), end: fromWall(draft.end, timeZone), calendarId: draft.calendarId,
    };
    apply([...latestEvents.current, event]);
    onCreate?.(event);
    setDraft(null); setPopover(null); setSelectedId(event.id);
    setAnnouncement(`Created ${event.title}, ${fmt.longDate(dayOf(draft.start))}, ${fmt.spoken(draft.start, draft.end)}`);
    requestAnimationFrame(() => nodes.current.get(event.id)?.focus({ preventScroll: true }));
  };
  const timePatch = (start: Wall, end: Wall) => ({ start: fromWall(start, timeZone), end: fromWall(end, timeZone) });

  /** Draws a new event and opens the quick create form beside it, scrolling it into view first. */
  const startDraft = (start: Wall, end: Wall) => {
    setDrag(null); setSelectedId(null);
    setDraft({ start, end, calendarId: defaultCalendar });
    setPopover({ kind: "create" });
    const scroller = scrollerRef.current;
    if (scroller && !isAgenda) {
      const top = (minuteOf(start) - dayStart) * PX, bottom = top + (end - start) * PX, head = headRef.current?.offsetHeight ?? 0;
      if (top < scroller.scrollTop + 8) scroller.scrollTop = top - 24;
      else if (bottom > scroller.scrollTop + scroller.clientHeight - head - 8) scroller.scrollTop = bottom - scroller.clientHeight + head + 48;
    }
  };
  /** The first free hour on a day: from the next half hour today, or from 9 AM. */
  const freeSlot = (day: number) => {
    let start = clamp(today === day && nowWall !== null ? Math.ceil(minuteOf(nowWall) / 30) * 30 : 9 * 60, dayStart, dayEnd - 60);
    const busy = items.filter(item => !item.allDay && item.start < (day + 1) * DAY && item.end > day * DAY);
    while (start + 60 <= dayEnd && busy.some(item => item.start < day * DAY + start + 60 && item.end > day * DAY + start)) start += 30;
    if (start + 60 > dayEnd) start = clamp(9 * 60, dayStart, dayEnd - 60);
    return day * DAY + start;
  };
  const newEvent = () => {
    if (isAgenda) { go({ view: "day", anchor: cursor, cursor, dir: 0 }); }
    const start = freeSlot(cursor);
    startDraft(start, start + 60);
  };
  const openDetails = (id: string, node?: HTMLElement) => { anchorNode.current = node ?? null; setDraft(null); setSelectedId(id); setPopover({ kind: "details", id }); };

  const closePopover = () => {
    const open = popover;
    setPopover(null);
    if (open?.kind === "create") { setDraft(null); surfaceRef.current?.querySelector<HTMLElement>(`[data-current] [data-day-cell="${cursor}"]`)?.focus({ preventScroll: true }); }
    else if (open?.kind === "details") nodes.current.get(open.id)?.focus({ preventScroll: true });
    else if (open?.kind === "calendars") calendarsButtonRef.current?.focus({ preventScroll: true });
  };

  // Pointer to slot: which day column and how many minutes into the day, unsnapped.
  const pointAt = (x: number, y: number) => {
    const rect = surfaceRef.current!.getBoundingClientRect();
    const index = clamp(Math.floor((x - rect.left) / (rect.width / days.length)), 0, days.length - 1);
    return { index, day: days[index], minute: dayStart + (y - rect.top) / PX };
  };

  const track = (g: Gesture) => {
    if (!surfaceRef.current) return;
    const { day, minute } = pointAt(g.x, g.y);
    const at = clamp(Math.round(minute / SNAP) * SNAP, dayStart, dayEnd);
    let next: Drag;
    if (g.intent === "create") {
      const base = g.anchorDay * DAY;
      next = at > g.anchorMinute
        ? { kind: "create", id: null, start: base + g.anchorMinute, end: base + Math.max(at, g.anchorMinute + SNAP) }
        : { kind: "create", id: null, start: base + at, end: base + g.anchorMinute + SNAP };
    } else if (g.intent === "move") {
      const span = g.origin.end - g.origin.start;
      let start: Wall;
      if (span <= dayEnd - dayStart) start = day * DAY + clamp(Math.round((minute - g.grab) / SNAP) * SNAP, dayStart, dayEnd - span);
      else start = Math.round((day * DAY + minute - g.grab) / SNAP) * SNAP;
      next = { kind: "move", id: g.id, start, end: start + span };
    } else {
      const endDay = dayOf(g.origin.end - 1);
      next = { kind: "resize", id: g.id, start: g.origin.start, end: clamp(endDay * DAY + at, g.origin.start + SNAP, endDay * DAY + dayEnd) };
    }
    setDrag(prev => prev && prev.kind === next.kind && prev.id === next.id && prev.start === next.start && prev.end === next.end ? prev : next);
  };
  const trackRef = useRef(track);
  useLayoutEffect(() => { trackRef.current = track; });

  const activate = (g: Gesture) => {
    g.state = "active";
    if (g.timer) { clearTimeout(g.timer); g.timer = null; }
    if (g.touch && typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate?.(10);
    if (hoverRef.current) hoverRef.current.style.opacity = "0";
    if (g.intent === "create") setDrag({ kind: "create", id: null, start: g.anchorDay * DAY + g.anchorMinute, end: g.anchorDay * DAY + g.anchorMinute + SNAP });
    else { setSelectedId(g.id); setDrag({ kind: g.intent === "resize" ? "resize" : "move", id: g.id, ...g.origin }); }
    track(g);
  };

  const showHover = (e: ReactPointerEvent<HTMLDivElement>) => {
    const node = hoverRef.current;
    if (!node || !surfaceRef.current) return;
    if (e.pointerType !== "mouse" || popover || (e.target as HTMLElement).closest("[data-event-id]")) { node.style.opacity = "0"; return; }
    const { index, day, minute } = pointAt(e.clientX, e.clientY);
    const slot = clamp(Math.floor(minute / 30) * 30, dayStart, dayEnd - 30);
    node.style.opacity = "1";
    node.style.width = `${100 / days.length}%`;
    node.style.transform = `translate(${index * 100}%, ${(slot - dayStart) * PX}px)`;
    const label = node.firstElementChild;
    if (label) label.textContent = fmt.time(day * DAY + slot);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.pointerType === "mouse" && e.button !== 0) || gesture.current || !surfaceRef.current) return;
    // With a popover open, a press outside only closes it (the popover listens for that).
    if (popover) return;
    const target = e.target as HTMLElement;
    const id = target.closest<HTMLElement>("[data-event-id]")?.dataset.eventId ?? null;
    const item = id ? itemById.get(id) : undefined;
    const resize = !!target.closest("[data-handle]");
    const { day, minute } = pointAt(e.clientX, e.clientY);
    const anchorMinute = clamp(Math.floor(minute / SNAP) * SNAP, dayStart, dayEnd - SNAP);
    const g: Gesture = {
      intent: item ? (resize ? "resize" : "move") : "create", id: item?.id ?? null, pointerId: e.pointerId, touch: e.pointerType !== "mouse",
      x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t: e.timeStamp, vx: 0, state: "pending", timer: null,
      anchorDay: day, anchorMinute, grab: item ? day * DAY + minute - item.start : 0,
      origin: item ? { start: item.start, end: item.end } : { start: day * DAY + anchorMinute, end: day * DAY + anchorMinute + SNAP },
    };
    gesture.current = g;
    // Keep keyboard shortcuts working after a click: focus the event, or the day cell under the pointer.
    if (!g.touch) {
      e.preventDefault();
      if (item) nodes.current.get(item.id)?.focus({ preventScroll: true });
      else { setCursor(day); e.currentTarget.querySelector<HTMLElement>(`[data-current] [data-day-cell="${day}"]`)?.focus({ preventScroll: true }); }
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    // Touch waits for a long press, so a swipe still scrolls the day or changes days instead of creating or moving an event.
    if (g.touch) g.timer = setTimeout(() => { if (gesture.current === g && g.state === "pending") activate(g); }, 380);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g) { if (!isAgenda) showHover(e); return; }
    if (e.pointerId !== g.pointerId) return;
    const dt = e.timeStamp - g.t;
    if (dt > 0) g.vx = g.vx * .4 + (e.clientX - g.x) / dt * .6;
    g.x = e.clientX; g.y = e.clientY; g.t = e.timeStamp;
    const dx = g.x - g.x0, dy = g.y - g.y0;
    if (g.state === "pending") {
      if (g.touch || g.intent === "swipe") {
        if (Math.hypot(dx, dy) < 8) return;
        if (g.timer) { clearTimeout(g.timer); g.timer = null; }
        if (Math.abs(dx) > Math.abs(dy) * 1.2) {
          g.state = "swipe";
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.setPointerCapture(e.pointerId);
          // The neighbors ride along at one page width, so letting go continues into the next range without a seam.
          current.x.stop();
          g.base = current.x.get(); g.width = surfaceWidth();
          const step = stepOf(view);
          g.peeks = [-1, 1].map(dir => {
            const peekDays = rangeFor(view, anchor + dir * step, weekStartsOn);
            return { key: `${view}:${peekDays[0]}:${peekDays.length}`, view, days: peekDays, x: motionValue(g.base! + dir * g.width!), opacity: motionValue(1) };
          });
          setPeeks(g.peeks);
        } else { gesture.current = null; return; }
      } else {
        if (Math.hypot(dx, dy) < 4) return;
        activate(g);
        return;
      }
    }
    if (g.state === "swipe") {
      const x = (g.base ?? 0) + dx;
      current.x.set(x);
      g.peeks?.forEach((pane, i) => pane.x.set(x + (i ? 1 : -1) * (g.width ?? 0)));
      return;
    }
    track(g);
  };

  const finish = (e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const g = gesture.current;
    if (!g || e.pointerId !== g.pointerId) return;
    if (g.timer) clearTimeout(g.timer);
    gesture.current = null;
    if (g.state === "swipe") {
      const dx = g.x - g.x0, width = g.width ?? surfaceWidth(), x = (g.base ?? 0) + dx;
      if (!cancelled && (Math.abs(x) > width * .2 || Math.abs(g.vx) > .4) && Math.sign(g.vx || dx) === Math.sign(dx)) navigate(dx < 0 ? 1 : -1, x);
      else {
        animate(current.x, 0, slide);
        const peeksNow = g.peeks ?? [];
        peeksNow.forEach((pane, i) => animate(pane.x, (i ? 1 : -1) * width, slide));
        setTimeout(() => setPeeks(list => list === peeksNow ? [] : list), 600);
      }
      return;
    }
    if (g.intent === "swipe") return;
    if (cancelled) { setDrag(null); return; }
    if (g.state === "pending") {
      // A tap opens an event, or drafts an hour on empty time.
      if (g.id) openDetails(g.id);
      else { const start = clamp(Math.floor(g.anchorMinute / 30) * 30, dayStart, dayEnd - 60); startDraft(g.anchorDay * DAY + start, g.anchorDay * DAY + start + 60); }
      return;
    }
    const done = drag;
    setDrag(null);
    if (!done) return;
    if (done.kind === "create") { startDraft(done.start, done.end); return; }
    const item = done.id ? itemById.get(done.id) : undefined;
    if (!item || (item.start === done.start && item.end === done.end)) return;
    const message = done.kind === "move"
      ? `Moved ${item.event.title} to ${fmt.shortDate(dayOf(done.start))}, ${fmt.time(done.start)}`
      : `${item.event.title} now ${fmt.range(done.start, done.end)}`;
    updateWithUndo(item.id, timePatch(done.start, done.end), message);
  };

  // Agenda rows are ordinary buttons; the list only listens for a horizontal swipe.
  const onAgendaPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" || gesture.current) return;
    gesture.current = {
      intent: "swipe", id: null, pointerId: e.pointerId, touch: true, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t: e.timeStamp, vx: 0,
      state: "pending", timer: null, anchorDay: 0, anchorMinute: 0, grab: 0, origin: { start: 0, end: 0 },
    };
  };

  // While a touch drag or swipe is live, the day stops scrolling under the finger. The listener is always attached, so the first move is already held.
  useEffect(() => {
    const scroller = scrollerRef.current ?? agendaRef.current;
    if (!scroller) return;
    const block = (e: TouchEvent) => { if (gesture.current && gesture.current.state !== "pending") e.preventDefault(); };
    scroller.addEventListener("touchmove", block, { passive: false });
    return () => scroller.removeEventListener("touchmove", block);
  }, [isAgenda]);

  // A horizontal trackpad swipe pages between ranges, once per swipe.
  const navigateRef = useRef(navigate);
  useLayoutEffect(() => { navigateRef.current = navigate; });
  useEffect(() => {
    const node = scrollerRef.current ?? agendaRef.current;
    if (!node) return;
    let sum = 0, locked = false, idle: ReturnType<typeof setTimeout> | undefined;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || gesture.current) return;
      e.preventDefault();
      clearTimeout(idle);
      idle = setTimeout(() => { sum = 0; locked = false; }, 240);
      if (locked) return;
      sum += e.deltaX;
      if (Math.abs(sum) > 80) { locked = true; navigateRef.current(sum > 0 ? 1 : -1); sum = 0; }
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => { node.removeEventListener("wheel", onWheel); clearTimeout(idle); };
  }, [isAgenda]);

  // While a drag is live, the day scrolls when the pointer nears its top or bottom edge, and Escape cancels it.
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let frame = 0;
    const tick = () => {
      const g = gesture.current;
      if (g?.state === "active") {
        const rect = scroller.getBoundingClientRect(), edge = 44;
        const top = rect.top + (headRef.current?.offsetHeight ?? 0) + edge, bottom = rect.bottom - edge;
        const speed = g.y < top ? -Math.min(18, (top - g.y) / 2.5 + 2) : g.y > bottom ? Math.min(18, (g.y - bottom) / 2.5 + 2) : 0;
        if (speed) {
          const before = scroller.scrollTop;
          scroller.scrollTop += speed;
          if (scroller.scrollTop !== before) trackRef.current(g);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || gesture.current?.state !== "active") return;
      e.preventDefault(); e.stopPropagation();
      gesture.current = null;
      setDrag(null);
      setAnnouncement("Drag cancelled");
    };
    window.addEventListener("keydown", onKey, true);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("keydown", onKey, true); };
  }, [dragging]);

  const onEventKey = (id: string, e: ReactKeyboardEvent<HTMLElement>) => {
    const item = itemById.get(id);
    if (!item || !e.key.startsWith("Arrow")) return;
    if (!e.altKey) {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault(); e.stopPropagation();
      const list = Array.from(e.currentTarget.closest("[data-pane]")?.querySelectorAll<HTMLElement>("[data-event-id]") ?? []);
      list[list.indexOf(e.currentTarget) + (e.key === "ArrowDown" ? 1 : -1)]?.focus();
      return;
    }
    e.preventDefault(); e.stopPropagation();
    if (item.allDay) return;
    const span = item.end - item.start;
    let { start, end } = item;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const delta = e.key === "ArrowLeft" ? -1 : 1;
      let day = dayOf(start) + delta;
      if (view === "workweek") while (isWeekend(day)) day += delta;
      if (!days.includes(day)) return;
      start = day * DAY + minuteOf(start); end = start + span;
    } else {
      const delta = e.key === "ArrowUp" ? -SNAP : SNAP, base = dayOf(start) * DAY;
      if (e.shiftKey) end = clamp(end + delta, start + SNAP, dayOf(end - 1) * DAY + dayEnd);
      else { start = clamp(start + delta, base + dayStart, base + dayEnd - span); end = start + span; }
    }
    if (start === item.start && end === item.end) return;
    update(id, timePatch(start, end), `${item.event.title}, ${fmt.shortDate(dayOf(start))}, ${fmt.spoken(start, end)}`);
    setSelectedId(id);
  };
  // Pointer presses open events through the gesture; this only answers Enter and Space, which report no click count.
  const onEventClick = (id: string, e: ReactMouseEvent<HTMLElement>) => { if (e.detail === 0) openDetails(id); };
  const onMore = () => setExpanded(true);
  const dismissToast = useCallback(() => setToast(null), []);
  /** The keyboard cursor follows focus, so arrows continue from the day or event someone is on. */
  const onFocusDay = (e: ReactFocusEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const cell = target.dataset.dayCell ? Number(target.dataset.dayCell) : null;
    const id = cell === null ? target.closest<HTMLElement>("[data-event-id]")?.dataset.eventId : undefined;
    const day = cell ?? (id ? dayOf(itemById.get(id)?.start ?? NaN) : NaN);
    if (Number.isFinite(day) && days.includes(day) && day !== cursorState) setCursor(day);
  };


  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, [contenteditable='true'], [role='dialog'], [role='listbox']")) return;
    if (e.metaKey || e.ctrlKey) {
      if (e.key.toLowerCase() === "z" && toast?.undo) { e.preventDefault(); toast.undo(); }
      return;
    }
    if (e.altKey) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === "Escape") {
      if (popover) closePopover();
      else if (selectedId) { setSelectedId(null); setAnnouncement("Selection cleared"); }
      else return;
    } else if (key === "t") goToday();
    else if (key === "n") newEvent();
    else if (key === "d") go({ view: "day", anchor: cursor, cursor, dir: 0 });
    else if (key === "w") go({ view: "week", cursor, dir: 0 });
    else if (key === "Delete" || key === "Backspace") {
      const id = target.closest<HTMLElement>("[data-event-id]")?.dataset.eventId ?? selectedId;
      if (!id) return;
      remove(id);
    } else if ((key === "ArrowLeft" || key === "ArrowRight") && !isAgenda && !target.closest("[data-toolbar]")) moveCursor(key === "ArrowLeft" ? -1 : 1);
    else if (key === "Enter" && target.dataset.dayCell) newEvent();
    else return;
    e.preventDefault();
  };

  const toggleCalendar = (id: string) => {
    const calendar = calendarById.get(id);
    setHidden(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
    if (calendar) setAnnouncement(`${calendar.name} ${hidden.has(id) ? "shown" : "hidden"}`);
  };


  const changeView = (value: string) => go({ view: value as CalendarView, cursor, anchor: value === "day" || value === "3day" ? cursor : anchor, dir: 0 });
  const latest = useRef({ onEventKey, onEventClick, goDay, openDetails, onMore, changeView, toggleCalendar });
  useLayoutEffect(() => { latest.current = { onEventKey, onEventClick, goDay, openDetails, onMore, changeView, toggleCalendar }; });
  const stableEventKey = useCallback((id: string, e: ReactKeyboardEvent<HTMLElement>) => latest.current.onEventKey(id, e), []);
  const stableEventClick = useCallback((id: string, e: ReactMouseEvent<HTMLElement>) => latest.current.onEventClick(id, e), []);
  const stableDay = useCallback((day: number) => latest.current.goDay(day), []);
  const stableOpen = useCallback((id: string, node?: HTMLElement) => latest.current.openDetails(id, node), []);
  const stableMore = useCallback(() => latest.current.onMore(), []);
  const stableView = useCallback((value: string) => latest.current.changeView(value), []);
  const stableToggle = useCallback((id: string) => latest.current.toggleCalendar(id), []);
  const latestClose = useRef(closePopover);
  useLayoutEffect(() => { latestClose.current = closePopover; });
  const stableClose = useCallback(() => latestClose.current(), []);

  // The all day row grows to fit its lanes up to a limit, then collapses behind a toggle.
  const allDayLanes = useMemo(() => allDayLayout(items, days).count, [items, days]);
  const collapsible = allDayLanes > MAX_LANES + 1;
  const allDayRows = allDayLanes === 0 ? 1 : collapsible && !expanded ? MAX_LANES + 1 : allDayLanes;

  const detailItem = popover?.kind === "details" ? itemById.get(popover.id) ?? null : null;
  const draftColor = colorOf(calendarById.get(draft?.calendarId ?? defaultCalendar));
  const detailAnchor = useCallback(() => popover?.kind !== "details" ? null : anchorNode.current?.isConnected ? anchorNode.current : nodes.current.get(popover.id) ?? null, [popover]);
  const ghostAnchor = useCallback(() => ghostRef.current, []);
  const calendarsAnchor = useCallback(() => calendarsButtonRef.current, []);
  const panes = [...leaving.filter(pane => (pane.view === "agenda") === isAgenda && !peeks.some(peek => peek.key === pane.key)), ...peeks.filter(peek => peek.key !== current.key), current];
  const nowIndex = nowWall === null ? -1 : days.indexOf(dayOf(nowWall));
  const hourMarks = useMemo(() => Array.from({ length: lastHour - firstHour }, (_, i) => (firstHour + i) * 60), [firstHour, lastHour]);
  const views = size === "compact" ? COMPACT_VIEWS : WIDE_VIEWS;

  return <div ref={rootRef} className={[styles.root, className].filter(Boolean).join(" ")} data-size={size} data-dragging={dragging || undefined} onKeyDown={onKeyDown}>
    <header className={styles.toolbar} data-toolbar="">
      <button type="button" className={`${styles.button} ${styles.today}`} onClick={goToday} disabled={today === null || days.includes(today)} aria-keyshortcuts="T">Today</button>
      <div className={styles.stepper}>
        <button type="button" className={styles.iconButton} onClick={() => navigate(-1)} aria-label={view === "day" ? "Previous day" : view === "3day" ? "Previous three days" : "Previous week"}><ChevronLeft size={18} strokeWidth={1.75} aria-hidden="true" /></button>
        <button type="button" className={styles.iconButton} onClick={() => navigate(1)} aria-label={view === "day" ? "Next day" : view === "3day" ? "Next three days" : "Next week"}><ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" /></button>
      </div>
      <h2 className={styles.title}>{view === "day" ? fmt.longDate(days[0]) : rangeTitle}</h2>
      <div className={styles.views}>
        <ViewSwitch views={views} value={view} onChange={stableView} />
      </div>
      {size !== "wide" && <button ref={calendarsButtonRef} type="button" className={styles.button} data-open={popover?.kind === "calendars" || undefined}
          aria-haspopup="dialog" aria-expanded={popover?.kind === "calendars"} onClick={() => setPopover(open => open?.kind === "calendars" ? null : { kind: "calendars" })}>
          <span className={styles.swatches} aria-hidden="true">{calendars.map(c => <span key={c.id} className={styles.swatch} data-off={hidden.has(c.id) || undefined} style={tint(colorOf(c))} />)}</span>
          <span className={styles.buttonLabel}>Calendars</span>
        </button>}
      <button ref={newButtonRef} type="button" className={styles.primary} onClick={newEvent} aria-keyshortcuts="N" aria-label="New event">
        <Plus size={16} strokeWidth={1.75} aria-hidden="true" /><span className={styles.primaryLabel}>New event</span>
      </button>
    </header>

    <div className={styles.frame}>
      {size === "wide" && <aside className={styles.sidebar} aria-label="Calendar navigation">
        <MiniMonth fmt={fmt} month={month} weekStartsOn={weekStartsOn} today={today} range={days} onMonth={setMonth} onPick={stableDay} />
        <div className={styles.sideSection}>
          <p className={styles.sideTitle}>Calendars</p>
          <CalendarList calendars={calendars} hidden={hidden} onToggle={stableToggle} />
        </div>
      </aside>}

      <div className={styles.main}>
        {isAgenda
          ? <div ref={agendaRef} className={styles.agendaScroller} onPointerDown={onAgendaPointerDown} onPointerMove={onPointerMove} onPointerUp={e => finish(e, false)} onPointerCancel={e => finish(e, true)}>
            {panes.map(pane => <AgendaPane key={pane.key} pane={pane} current={pane === current} items={items} fmt={fmt} today={today} selectedId={selectedId} register={register} onOpen={stableOpen} />)}
          </div>
          : <div ref={scrollerRef} className={styles.scroller} style={{ ["--hour" as string]: `${HOUR}px` }}>
            <div ref={headRef} className={styles.head}>
              <div className={styles.headRow}>
                <div className={styles.corner} aria-hidden="true">{zone}</div>
                <div className={styles.headViewport}>
                  {panes.map(pane => <HeadPane key={pane.key} pane={pane} current={pane === current} today={today} cursor={cursor} fmt={fmt} onDay={stableDay} />)}
                </div>
              </div>
              <div className={styles.allDayRow} style={{ height: allDayRows * LANE + 8 }}>
                <div className={styles.allDayGutter}>
                  {collapsible
                    ? <button type="button" className={styles.allDayToggle} aria-expanded={expanded} onClick={() => setExpanded(open => !open)} aria-label={expanded ? "Collapse all day events" : "Show all all day events"}>
                      <span>All day</span><ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" data-open={expanded || undefined} />
                    </button>
                    : <span className={styles.allDayLabel}>All day</span>}
                </div>
                <div className={styles.headViewport}>
                  {panes.map(pane => <AllDayPane key={pane.key} pane={pane} current={pane === current} items={items} fmt={fmt} expanded={expanded} selectedId={selectedId}
                    register={register} onOpen={stableOpen} onMore={stableMore} />)}
                </div>
              </div>
            </div>

            <div className={styles.body} style={{ height: total }}>
              <div className={styles.gutter} aria-hidden="true">
                {hourMarks.slice(1).map(m => <span key={m} className={styles.hour} style={{ top: (m - dayStart) * PX }}
                  data-hidden={nowIndex >= 0 && nowWall !== null && Math.abs((m - minuteOf(nowWall)) * PX) < 14 || undefined}>{fmt.hour(m)}</span>)}
                {nowIndex >= 0 && nowWall !== null && minuteOf(nowWall) >= dayStart && minuteOf(nowWall) <= dayEnd &&
                  <span className={styles.nowLabel} style={{ top: (minuteOf(nowWall) - dayStart) * PX }}>{size === "compact" ? fmt.short(nowWall) : fmt.time(nowWall)}</span>}
              </div>
              <div ref={surfaceRef} className={styles.surface} onFocus={onFocusDay} onPointerDown={onPointerDown} onPointerMove={onPointerMove}
                onPointerUp={e => finish(e, false)} onPointerCancel={e => finish(e, true)}
                onPointerLeave={() => { if (hoverRef.current) hoverRef.current.style.opacity = "0"; }}>
                <div className={styles.lines} aria-hidden="true">
                  {hourMarks.map(m => <span key={m} className={styles.hourLine} style={{ top: (m - dayStart) * PX }} />)}
                  {hourMarks.map(m => <span key={`h${m}`} className={styles.halfLine} style={{ top: (m + 30 - dayStart) * PX }} />)}
                </div>
                <div ref={hoverRef} className={styles.hover} aria-hidden="true"><span /></div>
                {panes.map(pane => <BodyPane key={pane.key} pane={pane} current={pane === current} items={items} drag={pane === current ? drag : null}
                  draft={pane === current ? draft : null} draftColor={draftColor} selectedId={selectedId} nowWall={nowWall} today={today} cursor={cursor}
                  dayStart={dayStart} dayEnd={dayEnd} fmt={fmt} reduced={reduced} label={rangeTitle} describedBy={instructionsId}
                  register={register} paneWidth={surfaceWidth} onEventKey={stableEventKey} onEventClick={stableEventClick} ghostRef={ghostRef} />)}
              </div>
            </div>
          </div>}
      </div>
      <AnimatePresence>
        {toast && <CalendarUndoToast key={toast.id} message={toast.message} onUndo={toast.undo} onDismiss={dismissToast} reduced={reduced} />}
      </AnimatePresence>
    </div>

    <p id={instructionsId} className={styles.srOnly}>{INSTRUCTIONS}</p>
    <p className={styles.srOnly} aria-live="polite">{announcement}</p>

    <AnimatePresence>
      {popover?.kind === "details" && detailItem && <CalendarPopover key={`details-${popover.id}`} anchor={detailAnchor} rootRef={rootRef} scrollerRef={scrollerRef} reduced={reduced}
        label="Event details" onClose={stableClose}>
        <EventDetails key={popover.id} fmt={fmt} event={detailItem.event} start={detailItem.start} end={detailItem.end} calendars={calendars}
          onTitle={title => update(detailItem.id, { title }, `Renamed to ${title}`)}
          onTime={(start, end) => updateWithUndo(detailItem.id, timePatch(start, end), `${detailItem.event.title} now ${fmt.shortDate(dayOf(start))}, ${fmt.range(start, end)}`)}
          onCalendar={calendarId => update(detailItem.id, { calendarId }, `Moved to ${calendarById.get(calendarId)?.name ?? "calendar"}`)}
          onDelete={() => remove(detailItem.id)} onClose={closePopover} />
      </CalendarPopover>}
      {popover?.kind === "create" && draft && <CalendarPopover key="create" anchor={ghostAnchor} rootRef={rootRef} scrollerRef={scrollerRef} reduced={reduced} width={320}
        label="New event" onClose={stableClose}>
        <QuickCreate fmt={fmt} start={draft.start} end={draft.end} calendars={calendars.filter(c => !hidden.has(c.id))} calendarId={draft.calendarId}
          onCalendar={calendarId => setDraft(d => d && { ...d, calendarId })} onSave={create} onCancel={closePopover} />
      </CalendarPopover>}
      {popover?.kind === "calendars" && <CalendarPopover key="calendars" anchor={calendarsAnchor} ignore={calendarsAnchor} rootRef={rootRef} placement="below" width={240} reduced={reduced}
        label="Calendars" onClose={stableClose}>
        <div className={styles.popBody}><CalendarList calendars={calendars} hidden={hidden} onToggle={stableToggle} /></div>
      </CalendarPopover>}
    </AnimatePresence>
  </div>;
}

/** The view switch, memoized so a drag never re-measures its shared highlight. */
const ViewSwitch = memo(function ViewSwitch({ views, value, onChange }: { views: { value: string; label: string }[]; value: string; onChange: (value: string) => void }) {
  return <SegmentedControl options={views} value={value} onValueChange={onChange} label="View" />;
});

/** All day bars for a range: each bar covers the visible days it spans and takes the first free lane. */
function allDayLayout(items: Item[], days: number[]) {
  const index = new Map(days.map((day, i) => [day, i]));
  const bars: { item: Item; from: number; to: number; id: string }[] = [];
  for (const item of items) {
    if (!item.allDay) continue;
    let from = -1, to = -1;
    for (let day = dayOf(item.start); day < dayOf(item.end - 1) + 1; day++) {
      const i = index.get(day);
      if (i === undefined) continue;
      if (from < 0) from = i;
      to = i;
    }
    if (from >= 0) bars.push({ item, from, to, id: item.id });
  }
  const { lanes, count } = layoutLanes(bars);
  return { bars: bars.map(bar => ({ ...bar, lane: lanes.get(bar.id)! })), count };
}

type PaneStyle = { pane: Pane; current: boolean };
const paneStyle = (pane: Pane, columns: number): MotionStyle => ({ x: pane.x, opacity: pane.opacity, ["--columns" as string]: columns });

const HeadPane = memo(function HeadPane({ pane, current, today, cursor, fmt, onDay }: PaneStyle & { today: number | null; cursor: number; fmt: CalendarFormat; onDay: (day: number) => void }) {
  return <motion.div className={styles.headPane} style={paneStyle(pane, pane.days.length)} aria-hidden={!current || undefined} data-current={current || undefined}>
    {pane.days.map(day => <button key={day} type="button" tabIndex={-1} className={styles.headDay} data-today={day === today || undefined} data-weekend={isWeekend(day) || undefined}
      data-cursor={day === cursor || undefined} onClick={() => onDay(day)} aria-label={`Show ${fmt.longDate(day)}`}>
      <span className={styles.weekday}>{fmt.weekdayShort(day)}</span>
      <span className={styles.date}>{fmt.date(day)}</span>
    </button>)}
  </motion.div>;
});

type AllDayProps = PaneStyle & {
  items: Item[]; fmt: CalendarFormat; expanded: boolean; selectedId: string | null;
  register: (id: string, node: HTMLElement) => () => void; onOpen: (id: string, node?: HTMLElement) => void; onMore: () => void;
};

const AllDayPane = memo(function AllDayPane({ pane, current, items, fmt, expanded, selectedId, register, onOpen, onMore }: AllDayProps) {
  const { days } = pane, n = days.length;
  const { bars, count } = useMemo(() => allDayLayout(items, days), [items, days]);
  const shown = count > MAX_LANES + 1 && !expanded ? MAX_LANES : count;
  const more = days.map((_, i) => bars.filter(bar => bar.lane >= shown && bar.from <= i && bar.to >= i).length);
  return <motion.div className={styles.allDayPane} style={paneStyle(pane, n)} aria-hidden={!current || undefined} data-pane="">
    {days.map((day, i) => <span key={day} className={styles.allDayColumn} data-weekend={isWeekend(day) || undefined} style={{ left: `${i / n * 100}%`, width: `${100 / n}%` }} />)}
    {bars.filter(bar => bar.lane < shown).map(({ item, from, to, lane }) => {
      const first = dayOf(item.start), last = dayOf(item.end - 1);
      return <button key={item.id} ref={current ? node => node ? register(item.id, node) : undefined : undefined} type="button" tabIndex={current ? 0 : -1}
        className={styles.allDay} data-event-id={item.id} data-selected={item.id === selectedId || undefined}
        data-cut-start={first < days[from] || undefined} data-cut-end={last > days[to] || undefined}
        style={{ left: `${from / n * 100}%`, width: `${(to - from + 1) / n * 100}%`, top: lane * LANE + 4, ...tint(item.color) }}
        aria-label={`${item.event.title}, all day, ${first === last ? fmt.longDate(first) : `${fmt.longDate(first)} to ${fmt.longDate(last)}`}, ${item.calendarName}`}
        aria-haspopup="dialog" onClick={e => onOpen(item.id, e.currentTarget)}>
        <span className={styles.allDayTitle}>{item.event.title}</span>
      </button>;
    })}
    {more.map((hiddenCount, i) => hiddenCount > 0 && <button key={`more-${days[i]}`} type="button" tabIndex={current ? 0 : -1} className={styles.more}
      style={{ left: `${i / n * 100}%`, width: `${100 / n}%`, top: shown * LANE + 4 }} onClick={onMore} aria-label={`${hiddenCount} more all day events on ${fmt.longDate(days[i])}`}>
      {hiddenCount} more
    </button>)}
  </motion.div>;
});

type Segment = { key: string; item: Item; index: number; start: Wall; end: Wall; head: boolean; tail: boolean };

/** Splits events into the parts that fall on each visible day and hour range. The first part keeps the event's id as its key. */
function segmentsOf(item: Item, start: Wall, end: Wall, days: number[], dayStart: number, dayEnd: number) {
  const parts: Segment[] = [];
  days.forEach((day, index) => {
    const from = Math.max(start, day * DAY + dayStart), to = Math.min(end, day * DAY + dayEnd);
    if (to <= from) return;
    parts.push({ key: parts.length ? `${item.id}:${day}` : item.id, item, index, start: from, end: to, head: start >= day * DAY + dayStart, tail: end <= day * DAY + dayEnd });
  });
  return parts;
}

type BodyProps = PaneStyle & {
  items: Item[]; drag: Drag | null; draft: Draft | null; draftColor: string; selectedId: string | null;
  nowWall: Wall | null; today: number | null; cursor: number; dayStart: number; dayEnd: number;
  fmt: CalendarFormat; reduced: boolean; label: string; describedBy: string;
  register: (id: string, node: HTMLElement) => () => void; paneWidth: () => number;
  onEventKey: (id: string, e: ReactKeyboardEvent<HTMLElement>) => void;
  onEventClick: (id: string, e: ReactMouseEvent<HTMLElement>) => void;
  ghostRef: RefObject<HTMLDivElement | null>;
};

/** One range of day columns. The grid cells carry the dates for assistive technology; events float above them as buttons. */
function BodyPane({ pane, current, items, drag, draft, draftColor, selectedId, nowWall, today, cursor, dayStart, dayEnd, fmt, reduced, label, describedBy, register, paneWidth, onEventKey, onEventClick, ghostRef }: BodyProps) {
  const { days } = pane, n = days.length;
  const first = days[0], last = days[n - 1];
  const laidOut = useMemo(() => {
    const perDay: Segment[][] = days.map(() => []);
    for (const item of items) {
      if (item.allDay || item.end <= first * DAY + dayStart || item.start >= last * DAY + dayEnd) continue;
      for (const segment of segmentsOf(item, item.start, item.end, days, dayStart, dayEnd)) perDay[segment.index].push(segment);
    }
    const placed = perDay.flatMap(list => {
      const layout = layoutDay(list.map(s => ({ id: s.key, start: s.start, end: s.end })), 22);
      return list.map(segment => ({ segment, place: layout.get(segment.key)! }));
    });
    return placed.sort((a, b) => a.segment.index - b.segment.index || a.segment.start - b.segment.start || a.place.column - b.place.column);
  }, [items, days, first, last, dayStart, dayEnd]);

  // Intl formatting is the costly part of a render, so every string is made once per change of events, not per drag step.
  const texts = useMemo(() => {
    const map = new Map<string, { label: string; range: string; time: string }>();
    for (const { segment: { item } } of laidOut) {
      if (map.has(item.id)) continue;
      const { title, location } = item.event;
      map.set(item.id, {
        label: `${title}, ${fmt.longDate(dayOf(item.start))}, ${fmt.spoken(item.start, item.end)}, ${item.calendarName}${location ? `, ${location}` : ""}`,
        range: fmt.range(item.start, item.end), time: fmt.time(item.start),
      });
    }
    return map;
  }, [laidOut, fmt]);
  const cellLabels = useMemo(() => days.map(day => {
    const count = items.filter(item => item.start < (day + 1) * DAY && item.end > day * DAY).length;
    return `${fmt.longDate(day)}${day === today ? ", today" : ""}, ${count === 0 ? "no events" : count === 1 ? "1 event" : `${count} events`}`;
  }), [items, days, today, fmt]);
  const moving = drag && drag.id ? drag : null;
  const movingItem = moving ? laidOut.find(entry => entry.segment.item.id === moving.id)?.segment.item ?? items.find(item => item.id === moving.id) : undefined;
  const movingParts = moving && movingItem ? segmentsOf(movingItem, moving.start, moving.end, days, dayStart, dayEnd) : [];
  const ghost = drag?.kind === "create" ? drag : draft;
  const nowIndex = nowWall === null ? -1 : days.indexOf(dayOf(nowWall));
  const nowTop = nowWall === null ? 0 : (minuteOf(nowWall) - dayStart) * PX;
  const showNow = nowIndex >= 0 && nowWall !== null && minuteOf(nowWall) >= dayStart && minuteOf(nowWall) <= dayEnd;
  const top = (wall: Wall) => (minuteOf(wall) - dayStart) * PX;
  const height = (start: Wall, end: Wall) => (end - start) * PX;

  const block = (segment: Segment, left: number, width: number, extra: { dragging?: boolean; placeholder?: boolean }) => {
    const { item } = segment;
    const start = extra.dragging && moving ? moving.start : item.start, end = extra.dragging && moving ? moving.end : item.end;
    const segmentTop = top(segment.start), segmentHeight = height(segment.start, segment.end);
    const text = texts.get(item.id)!;
    return <EventBlock key={extra.placeholder ? `origin:${segment.key}` : segment.key} id={item.id} register={current && !extra.placeholder && segment.key === item.id ? register : undefined}
      title={item.event.title} color={item.color} location={item.event.location} attendees={item.event.attendees}
      top={segmentTop} height={segmentHeight} left={left} width={width}
      time={extra.dragging ? fmt.range(start, end) : segmentHeight < 30 ? text.time : text.range} label={text.label}
      past={nowWall !== null && item.end <= nowWall} selected={item.id === selectedId} dragging={!!extra.dragging} placeholder={!!extra.placeholder}
      head={segment.head} tail={segment.tail} interactive={current} reduced={reduced} paneWidth={paneWidth} onEventKey={onEventKey} onEventClick={onEventClick} />;
  };

  // The dragged event keeps its place among its siblings, so the element under a finger is never moved in the DOM (that would end a touch drag).
  const blocks: ReactNode[] = [];
  for (const { segment, place } of laidOut) {
    if (moving && segment.item.id === moving.id) {
      if (segment.key === segment.item.id) movingParts.forEach(part => blocks.push(block(part, part.index / n, 1 / n, { dragging: true })));
      continue;
    }
    blocks.push(block(segment, (segment.index + place.column / place.columns) / n, place.span / place.columns / n, {}));
  }

  return <motion.div className={styles.pane} style={paneStyle(pane, n)} data-current={current || undefined} data-pane="" aria-hidden={!current || undefined}>
    <div className={styles.grid} role="grid" aria-label={label} aria-describedby={describedBy} aria-readonly="true">
      <div role="row" className={styles.gridRow}>
        {days.map((day, i) => <div key={day} role="gridcell" data-day-cell={day} tabIndex={current && day === cursor ? 0 : -1} className={styles.column}
          data-weekend={isWeekend(day) || undefined} data-today={day === today || undefined}
          aria-label={cellLabels[i]}
          style={{ left: `${i / n * 100}%`, width: `${100 / n}%` }} />)}
      </div>
    </div>

    {showNow && <>
      <div className={styles.nowRow} style={{ top: nowTop }} aria-hidden="true" />
      <div className={styles.now} style={{ top: nowTop, left: `${nowIndex / n * 100}%`, width: `${100 / n}%` }} aria-hidden="true" />
    </>}

    {moving && <div className={styles.events} aria-hidden="true">
      {laidOut.filter(({ segment }) => segment.item.id === moving.id).map(({ segment, place }) =>
        block(segment, (segment.index + place.column / place.columns) / n, place.span / place.columns / n, { placeholder: true }))}
    </div>}
    <div className={styles.events}>
      {blocks}
      {movingParts.length > 0 && moving && <div className={styles.dragLabel} style={{ top: top(movingParts[0].start), left: `${movingParts[0].index / n * 100}%`, width: `${100 / n}%` }} aria-hidden="true">
        <span>{fmt.range(moving.start, moving.end)}</span>
      </div>}
    </div>

    {ghost && dayOf(ghost.start) >= first && dayOf(ghost.start) <= last && <div ref={current ? ghostRef : undefined} className={styles.ghost} data-drawing={drag?.kind === "create" || undefined}
      style={{ top: top(ghost.start), height: Math.max(18, height(ghost.start, ghost.end) - 2), left: `${days.indexOf(dayOf(ghost.start)) / n * 100}%`, width: `${100 / n}%`, ...tint(draftColor) }} aria-hidden="true">
      <span className={styles.ghostInner}>
        <span className={styles.ghostTitle}>New event</span>
        <span className={styles.ghostTime}>{fmt.range(ghost.start, ghost.end)}</span>
      </span>
    </div>}
  </motion.div>;
}

type BlockProps = {
  id: string; title: string; color: string; location?: string; attendees?: CalendarAttendee[];
  top: number; height: number; left: number; width: number; time: string; label: string;
  past: boolean; selected: boolean; dragging: boolean; placeholder: boolean; head: boolean; tail: boolean; interactive: boolean; reduced: boolean;
  register?: (id: string, node: HTMLElement) => () => void; paneWidth: () => number;
  onEventKey: (id: string, e: ReactKeyboardEvent<HTMLElement>) => void;
  onEventClick: (id: string, e: ReactMouseEvent<HTMLElement>) => void;
};

/**
 * One event. Position and size are plain styles; when they change, the block keeps its old place with a transform
 * and springs to the new one, so reflow, drops and edits animate on transform alone. Memoized on primitives, so a
 * drag re-renders only the event that moves.
 */
const EventBlock = memo(function EventBlock({ id, title, color, location, attendees, top, height, left, width, time, label, past, selected, dragging, placeholder, head, tail, interactive, reduced, register, paneWidth, onEventKey, onEventClick }: BlockProps) {
  const node = useRef<HTMLElement | null>(null);
  const previous = useRef<{ left: number; top: number } | null>(null);
  const offset = useRef({ x: 0, y: 0 });
  const motionRef = useRef<AnimationPlaybackControls | null>(null);
  // FLIP on transform alone: the block renders in its new place, starts at its old one, and springs home. One progress
  // value drives both axes, which keeps the path straight and the work to one animation per block.
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = { left, top };
    const element = node.current;
    if (!before || !element) return;
    const dx = (before.left - left) * paneWidth() + offset.current.x, dy = before.top - top + offset.current.y;
    motionRef.current?.stop();
    const apply = (progress: number) => {
      offset.current = { x: dx * progress, y: dy * progress };
      element.style.transform = progress ? `translate3d(${dx * progress}px, ${dy * progress}px, 0)` : "";
    };
    if (reduced || (Math.abs(dx) < .5 && Math.abs(dy) < .5)) { apply(0); return; }
    apply(1);
    motionRef.current = animate(1, 0, { ...(dragging ? follow : settle), onUpdate: apply });
  }, [left, top, reduced, dragging, paneWidth]);
  useEffect(() => () => motionRef.current?.stop(), []);

  const ref = useCallback((element: HTMLElement | null) => {
    node.current = element;
    return element && register ? register(id, element) : undefined;
  }, [register, id]);
  const size = height < 30 ? "s" : height < 62 ? "m" : "l";
  const style = { top: top + 1, height: Math.max(18, height - 2), left: `${left * 100}%`, width: `${width * 100}%`, ...tint(color) };

  if (placeholder) return <div ref={ref} className={styles.origin} style={style} aria-hidden="true" />;
  return <button ref={ref} type="button" data-event-id={id} className={styles.event} data-size={size} data-past={past || undefined}
    data-selected={selected || undefined} data-dragging={dragging || undefined} data-cut-start={!head || undefined} data-cut-end={!tail || undefined}
    style={style} tabIndex={interactive && !dragging ? 0 : -1} aria-label={label} aria-haspopup="dialog"
    onKeyDown={e => onEventKey(id, e)} onClick={e => onEventClick(id, e)}>
    <span className={styles.eventBody}>
      <span className={styles.eventTitle}>{title}</span>
      <span className={styles.eventTime}>{time}</span>
      {size === "l" && location && <span className={styles.eventMeta}><MapPin size={11} strokeWidth={2} aria-hidden="true" /><span>{location}</span></span>}
      {size === "l" && attendees && attendees.length > 1 && <span className={styles.eventFaces}><Faces people={attendees} size={18} max={4} /></span>}
    </span>
    {tail && <span className={styles.handle} data-handle="end" aria-hidden="true" />}
  </button>;
});

type AgendaProps = PaneStyle & {
  items: Item[]; fmt: CalendarFormat; today: number | null; selectedId: string | null;
  register: (id: string, node: HTMLElement) => () => void; onOpen: (id: string, node?: HTMLElement) => void;
};

/** The phone list: each day of the range with its events in order, all day first. */
const AgendaPane = memo(function AgendaPane({ pane, current, items, fmt, today, selectedId, register, onOpen }: AgendaProps) {
  const { days } = pane;
  const byDay = useMemo(() => days.map(day => items
    .filter(item => item.start < (day + 1) * DAY && item.end > day * DAY)
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start || a.end - b.end)), [items, days]);
  return <motion.div className={styles.agenda} style={paneStyle(pane, days.length)} aria-hidden={!current || undefined} data-pane="">
    {days.map((day, i) => <section key={day} className={styles.agendaDay} aria-label={fmt.longDate(day)}>
      <h3 className={styles.agendaHead} data-today={day === today || undefined}>
        <span className={styles.agendaDate}>{fmt.date(day)}</span>
        <span className={styles.agendaWeekday}>{fmt.weekdayLong(day)}<span className={styles.muted}>{fmt.monthDay(day)}</span></span>
        {day === today && <span className={styles.todayTag}>Today</span>}
      </h3>
      {byDay[i].length === 0
        ? <p className={styles.agendaEmpty}>Nothing planned</p>
        : <ul className={styles.agendaList}>
          {byDay[i].map(item => <li key={item.id}>
            <button ref={current && Math.max(dayOf(item.start), days[0]) === day ? node => node ? register(item.id, node) : undefined : undefined} type="button" tabIndex={current ? 0 : -1} className={styles.agendaItem}
              data-event-id={item.id} data-selected={item.id === selectedId || undefined} style={tint(item.color)} aria-haspopup="dialog" onClick={e => onOpen(item.id, e.currentTarget)}
              aria-label={`${item.event.title}, ${item.allDay ? "all day" : fmt.spoken(item.start, item.end)}, ${item.calendarName}${item.event.location ? `, ${item.event.location}` : ""}`}>
              <span className={styles.agendaTime}>{item.allDay ? "All day" : <>{fmt.time(item.start)}<span className={styles.muted}>{fmt.time(item.end)}</span></>}</span>
              <span className={styles.agendaBar} aria-hidden="true" />
              <span className={styles.agendaText}>
                <span className={styles.agendaTitle}>{item.event.title}</span>
                {item.event.location && <span className={styles.muted}>{item.event.location}</span>}
              </span>
              {item.event.attendees && item.event.attendees.length > 1 && <Faces people={item.event.attendees} size={22} max={3} />}
            </button>
          </li>)}
        </ul>}
    </section>)}
  </motion.div>;
});

export default WeekCalendar;
