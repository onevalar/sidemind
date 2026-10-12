"use client";

import { Fragment, useEffect, useId, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent, type PointerEvent, type ReactNode, type Ref } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { AnimatePresence, LayoutGroup, animate, motion, useAnimate, useIsPresent, useMotionValue, useReducedMotion } from "motion/react";
import { Check, ChevronDown, Copy, Lock, RotateCcw, Trash2 } from "lucide-react";
import { AnimatedCounter } from "../../animated-counter/animated-counter";
import { AvatarGroup, type AvatarGroupMember } from "../../avatar-group/avatar-group";
import { Button } from "../../button/button";
import { TextMorph } from "../../text-morph/text-morph";
import { motionTokens } from "../../lib/motion-tokens";
import styles from "./roles-permissions.module.css";

type Permission = { id: string; label: string };
type Group = { id: string; name: string; permissions: Permission[] };
type Role = { id: string; name: string; people: number; who?: string; locked?: boolean; custom?: boolean };
type Grants = Record<string, Record<string, boolean>>;
type Snapshot = { roles: Role[]; grants: Grants };
type ToggleState = "on" | "off" | "mixed";
type Phase = "idle" | "saving" | "saved";
type NavProps = { "data-nav": string; "data-key": string; "data-r": number; "data-c": number; tabIndex: number; onKeyDown: (event: KeyboardEvent<HTMLElement>) => void };

const { spring, duration, ease, blur, stagger } = motionTokens;
const enterEase = [...ease.enter] as [number, number, number, number];
const standardEase = [...ease.standard] as [number, number, number, number];
/** A group toggle ripples down its rows one step at a time. */
const WAVE = stagger.line * .75;
/** Discard and revert sweep the whole matrix top to bottom, so each row steps less and the sweep stays under .4s. */
const SWEEP = .03;
const SWEEP_MAX = .36;

const GROUPS: Group[] = [
  { id: "projects", name: "Projects", permissions: [{ id: "view-projects", label: "View projects" }, { id: "create-projects", label: "Create projects" }, { id: "edit-settings", label: "Edit project settings" }, { id: "delete-projects", label: "Delete projects" }] },
  { id: "members", name: "Members", permissions: [{ id: "invite", label: "Invite members" }, { id: "change-roles", label: "Change member roles" }, { id: "remove-members", label: "Remove members" }] },
  { id: "billing", name: "Billing", permissions: [{ id: "invoices", label: "View invoices" }, { id: "payment", label: "Manage payment methods" }, { id: "plan", label: "Change plan" }] },
  { id: "security", name: "Security", permissions: [{ id: "sso", label: "Configure single sign-on" }, { id: "audit-log", label: "View audit log" }, { id: "api-keys", label: "Manage API keys" }] },
];
const PERMISSIONS = GROUPS.flatMap(group => group.permissions);
const ROLES: Role[] = [
  { id: "owner", name: "Owner", people: 1, who: "Emma Collins", locked: true },
  { id: "admin", name: "Admin", people: 3, who: "Jasmine Brooks, Ava Mitchell and 1 other" },
  { id: "editor", name: "Editor", people: 8, who: "Marcus Johnson and 7 others" },
  { id: "viewer", name: "Viewer", people: 14, who: "14 people, including 9 guests" },
  { id: "billing", name: "Billing", people: 2, who: "Sofia Ramirez and 1 other" },
];
const GRANTED: Record<string, string[]> = {
  owner: PERMISSIONS.map(permission => permission.id),
  admin: ["view-projects", "create-projects", "edit-settings", "delete-projects", "invite", "change-roles", "remove-members", "invoices", "audit-log", "api-keys"],
  editor: ["view-projects", "create-projects", "edit-settings", "invite"],
  viewer: ["view-projects"],
  billing: ["invoices", "payment", "plan"],
};
const START: Snapshot = { roles: ROLES, grants: Object.fromEntries(ROLES.map(role => [role.id, Object.fromEntries(PERMISSIONS.map(permission => [permission.id, GRANTED[role.id].includes(permission.id)]))])) };
const OPEN = Object.fromEntries(GROUPS.map(group => [group.id, true]));
const MEMBERS: AvatarGroupMember[] = [
  { name: "Emma Collins", src: "/media/people/emma-collins.jpg" },
  { name: "Jasmine Brooks", src: "/media/people/jasmine-brooks.jpg" },
  { name: "Ava Mitchell", src: "/media/people/ava-mitchell.jpg" },
  { name: "Marcus Johnson", src: "/media/people/marcus-johnson.jpg" },
  { name: "Sofia Ramirez", src: "/media/people/sofia-ramirez.jpg" },
  ...Array.from({ length: 23 }, (_, index) => ({ name: `Workspace member ${index + 6}` })),
];

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const omit = (source: Grants, key: string) => Object.fromEntries(Object.entries(source).filter(([entry]) => entry !== key));
const cellKey = (roleId: string, permissionId: string) => `${roleId}:${permissionId}`;
const listNames = (names: string[]) => names.length <= 2 ? names.join(" and ") : names.length === 3 ? `${names[0]}, ${names[1]} and ${names[2]}` : `${names[0]}, ${names[1]} and ${names.length - 2} more`;
/** The first match that is not leaving the matrix. Exiting columns and rows are inert while they animate out. */
const pick = (root: HTMLElement | null | undefined, selector: string) => Array.from(root?.querySelectorAll<HTMLElement>(selector) ?? []).find(element => !element.closest("[inert]"));
const colOf = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>("[data-col]")?.dataset.col ?? null : null;

/** Compares the draft with the last save. A new role counts once, plus any cell toggled after it was copied. */
function diffOf(saved: Snapshot, roles: Role[], grants: Grants, seeds: Grants) {
  const savedIds = new Set(saved.roles.map(role => role.id));
  const liveIds = new Set(roles.map(role => role.id));
  const cells = new Set<string>();
  const touched: Role[] = [];
  for (const role of roles) {
    const base = saved.grants[role.id] ?? seeds[role.id] ?? {};
    let changed = !savedIds.has(role.id);
    for (const permission of PERMISSIONS) if (!!grants[role.id]?.[permission.id] !== !!base[permission.id]) { cells.add(cellKey(role.id, permission.id)); changed = true; }
    if (changed) touched.push(role);
  }
  const added = roles.filter(role => !savedIds.has(role.id)).length;
  const removed = saved.roles.filter(role => !liveIds.has(role.id));
  return { cells, touched, removed, savedIds, count: cells.size + added + removed.length };
}

function sweepOf(cells: Set<string>, roleIds: string[]) {
  const delays: Record<string, number> = {};
  PERMISSIONS.forEach((permission, index) => roleIds.forEach(roleId => { const key = cellKey(roleId, permission.id); if (cells.has(key)) delays[key] = Math.min(index * SWEEP, SWEEP_MAX); }));
  return delays;
}

/** Outgoing copies are hidden from assistive tech while they leave. The ref lets popLayout measure the leaving copy. */
function SwapPhase({ children, className, reduce, ref }: { children: ReactNode; className?: string; reduce: boolean; ref?: Ref<HTMLSpanElement> }) {
  const present = useIsPresent();
  return <motion.span ref={ref} className={className} aria-hidden={present ? undefined : true}
    initial={reduce ? { opacity: 0 } : { opacity: 0, y: "0.35em", filter: `blur(${blur.soft}px)` }} animate={{ opacity: 1, y: "0em", filter: "blur(0px)" }}
    exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: "-0.3em", filter: `blur(${blur.subtle}px)`, transition: { duration: duration.fast, ease: standardEase } }}
    transition={reduce ? { duration: 0 } : { duration: duration.standard, ease: enterEase }}>{children}</motion.span>;
}

/** New copy rises out of a soft blur while the old line lifts away out of flow. */
function Swap({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  const reduce = !!useReducedMotion();
  return <span className={[styles.swap, className].filter(Boolean).join(" ")}>
    <AnimatePresence mode="popLayout" initial={false}><SwapPhase key={id} className={styles.swapText} reduce={reduce}>{children}</SwapPhase></AnimatePresence>
  </span>;
}

/** One column slot. It grows from zero width with its cell pinned to the right edge, so a duplicated role slides out from behind its source. */
function Slot({ kind, col, head, onEntered, children }: { kind: "gridcell" | "columnheader"; col: string; head?: boolean; onEntered?: () => void; children: ReactNode }) {
  const reduce = !!useReducedMotion();
  const present = useIsPresent();
  return <motion.div role={kind} className={styles.slot} data-col={col} data-colhead={head ? col : undefined} inert={!present}
    initial={{ width: 0, opacity: 0 }} animate={{ width: "auto", opacity: 1 }} exit={{ width: 0, opacity: 0 }}
    transition={reduce ? { duration: 0 } : { width: spring.smooth, opacity: { duration: duration.standard, ease: enterEase } }} onAnimationComplete={onEntered}>
    <div className={styles.cell}>{children}</div>
  </motion.div>;
}

/** A group's rows. Height springs open and closed; rows on their way out are inert so arrow keys skip them. */
function GroupBody({ id, children }: { id: string; children: ReactNode }) {
  const reduce = !!useReducedMotion();
  const present = useIsPresent();
  return <motion.div id={id} className={styles.groupBody} inert={!present} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
    transition={reduce ? { duration: 0 } : { height: spring.smooth, opacity: { duration: duration.standard, ease: standardEase } }}>{children}</motion.div>;
}

type ToggleProps = { kind: "switch" | "checkbox"; state: ToggleState; label: string; locked?: boolean; dirty: boolean; delay: number; onToggle: () => void; nav: NavProps };

/** A compact checkbox. The delay lets a group toggle or a discard ripple through cells instead of flipping them all in one frame. */
function Toggle({ kind, state, label, locked, dirty, delay, onToggle, nav }: ToggleProps) {
  const reduce = !!useReducedMotion();
  const [box, animateBox] = useAnimate<HTMLSpanElement>();
  const wait = reduce ? 0 : delay;
  const draw = (visible: boolean) => ({ pathLength: visible ? 1 : 0, opacity: visible ? 1 : 0 });
  const stroke = reduce ? { duration: 0 } : { pathLength: { duration: duration.fast, ease: enterEase, delay: wait }, opacity: { duration: duration.instant, delay: wait } };
  function press() {
    // A locked cell nudges and settles, so the press is answered without the value changing.
    if (locked && !reduce && box.current) animateBox(box.current, { x: [0, 3, -2, 1, 0] }, { duration: .34, ease: "easeOut" });
    onToggle();
  }
  return <button type="button" role={kind} aria-checked={state === "mixed" ? "mixed" : state === "on"} aria-label={label} aria-disabled={locked || undefined}
    className={styles.toggle} data-state={state} data-locked={locked || undefined} style={{ "--delay": `${wait}s` } as CSSProperties} onClick={press} {...nav}>
    <span ref={box} className={styles.box}>
      <svg className={styles.mark} viewBox="0 0 16 16" aria-hidden="true">
        <motion.path d="M4.25 8.4 6.9 10.9 11.75 5.4" initial={false} animate={draw(state === "on")} transition={stroke} />
        <motion.path d="M5 8h6" initial={false} animate={draw(state === "mixed")} transition={stroke} />
      </svg>
    </span>
    <AnimatePresence initial={false}>
      {dirty && <motion.span key="dirty" className={styles.dirty} aria-hidden="true" initial={{ opacity: 0, scale: .3 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .3 }} transition={reduce ? { duration: 0 } : { ...spring.snappy, delay: wait }} />}
    </AnimatePresence>
  </button>;
}

type RoleHeaderProps = { role: Role; isNew: boolean; dirty: boolean; canRevert: boolean; nav: NavProps; onDuplicate: () => void; onRevert: () => void; onDelete: () => void; onCloseFocus: (event: Event) => void };

/** The column header opens the role menu. It anchors the menu, so it answers a press with color and never scales. */
function RoleHeader({ role, isNew, dirty, canRevert, nav, onDuplicate, onRevert, onDelete, onCloseFocus }: RoleHeaderProps) {
  const reduce = !!useReducedMotion();
  const group = useId();
  const [highlight, setHighlight] = useState<string | null>(null);
  const items = [
    { key: "duplicate", label: "Duplicate role", icon: <Copy size={16} strokeWidth={1.75} />, onSelect: onDuplicate, disabled: false, danger: false },
    ...(role.locked ? [] : [{ key: "revert", label: "Revert changes", icon: <RotateCcw size={16} strokeWidth={1.75} />, onSelect: onRevert, disabled: !canRevert, danger: false }]),
    ...(role.custom ? [{ key: "delete", label: "Delete role", icon: <Trash2 size={16} strokeWidth={1.75} />, onSelect: onDelete, disabled: false, danger: true }] : []),
  ];
  const people = isNew ? "New role" : role.people === 0 ? "No members" : `${role.people} ${role.people === 1 ? "person" : "people"}`;
  return <Menu.Root onOpenChange={next => { if (next) setHighlight(null); }}>
    <Menu.Trigger className={styles.roleTrigger} {...nav}>
      <span className={styles.roleName}>
        {role.locked && <Lock className={styles.lock} size={12} strokeWidth={1.75} aria-hidden="true" />}
        <span className={styles.roleText}>{role.name}</span>
        <ChevronDown className={styles.chev} size={12} strokeWidth={1.75} aria-hidden="true" />
      </span>
      <span className={styles.rolePeople}>
        <AnimatePresence initial={false}>
          {dirty && <motion.i key="dot" className={styles.roleDot} aria-hidden="true" initial={{ opacity: 0, scale: .3 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .3 }} transition={reduce ? { duration: 0 } : spring.snappy} />}
        </AnimatePresence>
        {people}
      </span>
      {role.locked && <span className={styles.srOnly}>, permissions are fixed</span>}
      {dirty && <span className={styles.srOnly}>, unsaved changes</span>}
    </Menu.Trigger>
    <Menu.Portal>
      <Menu.Content className={styles.menu} align="center" sideOffset={4} collisionPadding={12} loop onCloseAutoFocus={onCloseFocus}
        onFocus={(event: FocusEvent<HTMLDivElement>) => { const item = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[data-item]") : null; setHighlight(item?.dataset.item ?? null); }}>
        <Menu.Label className={styles.menuLabel}><span>{role.name}</span><small>{role.who ?? (isNew ? "Not saved yet" : "No members yet")}</small></Menu.Label>
        <LayoutGroup id={group}>
          {items.map(item => <Fragment key={item.key}>
            {item.danger && <Menu.Separator className={styles.menuSeparator} />}
            <Menu.Item className={styles.menuItem} data-item={item.key} data-tone={item.danger ? "danger" : undefined} disabled={item.disabled} onSelect={item.onSelect}>
              {highlight === item.key && <motion.span layoutId="highlight" className={styles.menuHighlight} aria-hidden="true" transition={reduce ? { duration: 0 } : spring.snappy} />}
              <span className={styles.menuIcon} aria-hidden="true">{item.icon}</span>
              <span className={styles.menuText}>{item.label}</span>
            </Menu.Item>
          </Fragment>)}
        </LayoutGroup>
      </Menu.Content>
    </Menu.Portal>
  </Menu.Root>;
}

export interface RolesPermissionsProps {
  /** The workspace named in the summary line. */
  workspace?: string;
}

export function RolesPermissions({ workspace = "Kestrel Analytics" }: RolesPermissionsProps = {}) {
  const id = useId();
  const reduce = !!useReducedMotion();
  const [saved, setSaved] = useState<Snapshot>(START);
  const [roles, setRoles] = useState<Role[]>(START.roles);
  const [grants, setGrants] = useState<Grants>(START.grants);
  const [seeds, setSeeds] = useState<Grants>({});
  const [wave, setWave] = useState<Record<string, number>>({});
  const [open, setOpen] = useState<Record<string, boolean>>(OPEN);
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState(`head:${START.roles[0].id}`);
  const innerRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const focusAfterMenu = useRef<string | null>(null);
  const reveal = useRef<string | null>(null);
  const bandCol = useRef<string | null>(null);
  const timers = useRef({ phase: 0, flash: 0 });
  const bandX = useMotionValue(0);
  const bandWidth = useMotionValue(0);
  const bandOpacity = useMotionValue(0);

  const change = diffOf(saved, roles, grants, seeds);
  const showBar = change.count > 0 || phase !== "idle";
  const savedView = phase === "saved" && change.count === 0;

  useEffect(() => {
    const current = timers.current;
    return () => { window.clearTimeout(current.phase); window.clearTimeout(current.flash); };
  }, []);

  // When the review bar leaves while it holds focus, focus returns to the matrix instead of dropping to the page.
  useEffect(() => {
    if (!showBar && barRef.current?.contains(document.activeElement)) innerRef.current?.querySelector<HTMLElement>('[data-nav][tabindex="0"]')?.focus({ preventScroll: true });
  }, [showBar]);

  function schedule(run: () => void, ms: number) {
    window.clearTimeout(timers.current.phase);
    timers.current.phase = window.setTimeout(run, ms);
  }

  /** One band sits behind the hovered or focused column and glides between columns. */
  function showBand(col: string | null) {
    if (bandCol.current === col) return;
    const glide = bandCol.current !== null && !reduce;
    const head = col ? pick(innerRef.current, `[data-colhead="${col}"]`) : undefined;
    if (!head) { bandCol.current = null; animate(bandOpacity, 0, { duration: reduce ? 0 : duration.fast }); return; }
    bandCol.current = col;
    if (glide) { animate(bandX, head.offsetLeft, spring.morph); animate(bandWidth, head.offsetWidth, spring.morph); }
    else { bandX.jump(head.offsetLeft); bandWidth.jump(head.offsetWidth); }
    animate(bandOpacity, 1, { duration: reduce ? 0 : duration.fast });
  }

  function onNavKey(event: KeyboardEvent<HTMLElement>) {
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || event.altKey || event.metaKey) return;
    const items = Array.from(innerRef.current?.querySelectorAll<HTMLElement>("[data-nav]") ?? []).filter(element => !element.closest("[inert]")).map(element => ({ element, r: Number(element.dataset.r), c: Number(element.dataset.c) }));
    const r = Number(event.currentTarget.dataset.r), c = Number(event.currentTarget.dataset.c);
    const inRow = (row: number) => items.filter(item => item.r === row).sort((a, b) => a.c - b.c);
    let next: (typeof items)[number] | undefined;
    if (event.key === "ArrowLeft") next = inRow(r).filter(item => item.c < c).at(-1);
    else if (event.key === "ArrowRight") next = inRow(r).find(item => item.c > c);
    else if (event.key === "Home") next = event.ctrlKey ? items[0] : inRow(r)[0];
    else if (event.key === "End") next = event.ctrlKey ? items.at(-1) : inRow(r).at(-1);
    else {
      const rows = [...new Set(items.map(item => item.r))].sort((a, b) => a - b);
      const row = event.key === "ArrowUp" ? rows.filter(value => value < r).at(-1) : rows.find(value => value > r);
      if (row !== undefined) next = inRow(row).sort((a, b) => Math.abs(a.c - c) - Math.abs(b.c - c))[0];
    }
    if (!next) return;
    event.preventDefault();
    next.element.focus();
  }

  function toggleCell(role: Role, permission: Permission) {
    if (role.locked) { setStatus(`${role.name} always has every permission`); return; }
    const value = !grants[role.id][permission.id];
    setGrants({ ...grants, [role.id]: { ...grants[role.id], [permission.id]: value } });
    setWave({});
    setStatus(`${role.name} ${value ? "can now" : "can no longer"} ${lower(permission.label)}`);
  }

  function toggleGroup(role: Role, group: Group) {
    if (role.locked) { setStatus(`${role.name} always has every permission`); return; }
    const value = !group.permissions.every(permission => grants[role.id][permission.id]);
    const delays: Record<string, number> = {};
    group.permissions.forEach((permission, index) => { if (grants[role.id][permission.id] !== value) delays[cellKey(role.id, permission.id)] = (index + 1) * WAVE; });
    setGrants({ ...grants, [role.id]: { ...grants[role.id], ...Object.fromEntries(group.permissions.map(permission => [permission.id, value])) } });
    setWave(delays);
    setStatus(`${value ? "Turned on" : "Turned off"} all ${group.name.toLowerCase()} permissions for ${role.name}`);
  }

  function duplicate(role: Role) {
    const roleId = `role-${++seq.current}`;
    const taken = new Set([...roles, ...saved.roles].map(item => item.name));
    let name = `${role.name} copy`;
    for (let count = 2; taken.has(name); count++) name = `${role.name} copy ${count}`;
    const copy = { ...grants[role.id] };
    const index = roles.findIndex(item => item.id === role.id);
    setRoles([...roles.slice(0, index + 1), { id: roleId, name, people: 0, custom: true }, ...roles.slice(index + 1)]);
    setGrants({ ...grants, [roleId]: copy });
    setSeeds({ ...seeds, [roleId]: copy });
    setWave({});
    focusAfterMenu.current = `head:${roleId}`;
    reveal.current = roleId;
    showBand(null);
    setStatus(`Duplicated ${role.name} as ${name}, not saved yet`);
  }

  function revertRole(role: Role) {
    const base = saved.grants[role.id] ?? seeds[role.id];
    if (!base) return;
    setGrants({ ...grants, [role.id]: { ...base } });
    setWave(sweepOf(change.cells, [role.id]));
    setStatus(`Reverted changes to ${role.name}`);
  }

  function deleteRole(role: Role) {
    const index = roles.findIndex(item => item.id === role.id);
    const neighbor = roles[index - 1] ?? roles[index + 1];
    setRoles(roles.filter(item => item.id !== role.id));
    setGrants(omit(grants, role.id));
    setSeeds(omit(seeds, role.id));
    setWave({});
    focusAfterMenu.current = neighbor ? `head:${neighbor.id}` : null;
    showBand(null);
    setStatus(change.savedIds.has(role.id) ? `Deleted ${role.name}. Save to apply.` : `Removed ${role.name}`);
  }

  function onMenuCloseFocus(event: Event) {
    const key = focusAfterMenu.current;
    if (!key) return;
    focusAfterMenu.current = null;
    event.preventDefault();
    pick(innerRef.current, `[data-key="${key}"]`)?.focus({ preventScroll: true });
  }

  /** After a duplicated column has slid in: bring it into view and light its band briefly. */
  function entered(roleId: string) {
    if (reveal.current !== roleId) return;
    reveal.current = null;
    const scroller = scrollerRef.current;
    const head = pick(innerRef.current, `[data-colhead="${roleId}"]`);
    const corner = innerRef.current?.querySelector<HTMLElement>("[data-corner]");
    if (scroller && head && corner) {
      const left = head.offsetLeft, right = left + head.offsetWidth, from = scroller.scrollLeft;
      const to = right > from + scroller.clientWidth ? right - scroller.clientWidth : left - corner.offsetWidth < from ? left - corner.offsetWidth : from;
      if (to !== from) scroller.scrollTo({ left: to, behavior: reduce ? "auto" : "smooth" });
    }
    showBand(roleId);
    window.clearTimeout(timers.current.flash);
    timers.current.flash = window.setTimeout(() => { if (bandCol.current === roleId && !innerRef.current?.matches(":hover")) showBand(null); }, 1400);
  }

  function save() {
    if (phase === "saving" || change.count === 0) return;
    const snapshot: Snapshot = { roles, grants };
    const count = change.count;
    setPhase("saving");
    setStatus(`Saving ${plural(count, "change")}`);
    schedule(() => {
      setSaved(snapshot);
      setPhase("saved");
      setStatus(`Saved ${plural(count, "change")}.`);
      schedule(() => setPhase("idle"), 1600);
    }, 900);
  }

  function discard() {
    if (phase === "saving" || change.count === 0) return;
    setWave(sweepOf(change.cells, saved.roles.map(role => role.id)));
    setRoles(saved.roles);
    setGrants(saved.grants);
    setSeeds({});
    showBand(null);
    setStatus(`Discarded ${plural(change.count, "unsaved change")}`);
  }

  // Row and column coordinates for arrow-key movement. Only one control in the matrix is in the tab order.
  const keys = new Set<string>();
  const rowOf: Record<string, number> = {};
  let rowCount = 0;
  roles.forEach(role => keys.add(`head:${role.id}`));
  GROUPS.forEach(group => {
    rowOf[group.id] = ++rowCount;
    keys.add(`g:${group.id}`);
    roles.forEach(role => keys.add(`g:${group.id}:${role.id}`));
    if (open[group.id]) group.permissions.forEach(permission => { rowOf[permission.id] = ++rowCount; roles.forEach(role => keys.add(`p:${permission.id}:${role.id}`)); });
  });
  const active = keys.has(cursor) ? cursor : `head:${roles[0].id}`;
  const nav = (key: string, r: number, c: number): NavProps => ({ "data-nav": "", "data-key": key, "data-r": r, "data-c": c, tabIndex: key === active ? 0 : -1, onKeyDown: onNavKey });

  const people = [...change.touched, ...change.removed].reduce((sum, role) => sum + role.people, 0);
  const summary = `${listNames([...change.touched.map(role => role.name), ...change.removed.map(role => role.name)])} · ${people ? `affects ${people} ${people === 1 ? "person" : "people"}` : "no members yet"}`;
  const subline = savedView ? "Saved" : phase === "saving" ? "Saving" : summary;

  return (
    <section className={styles.card} aria-labelledby={`${id}-title`}>
      <div className={styles.frame}>
        <header className={styles.header}>
          <div className={styles.heading}>
            <h2 id={`${id}-title`}>Roles and permissions</h2>
            <p className={styles.summary}>{workspace} · <span className={styles.count}>28</span> members across <span className={styles.count}><AnimatedCounter value={roles.length} /></span> roles</p>
          </div>
          <AvatarGroup members={MEMBERS} max={4} size="sm" label="Workspace members" />
        </header>

        <div ref={scrollerRef} className={styles.scroller} onScroll={event => event.currentTarget.toggleAttribute("data-scrolled", event.currentTarget.scrollLeft > 1)}>
          <div ref={innerRef} role="grid" aria-labelledby={`${id}-title`} className={styles.grid}
            onPointerMove={(event: PointerEvent<HTMLDivElement>) => { if (event.pointerType === "mouse" && event.currentTarget.contains(event.target as Node)) showBand(colOf(event.target)); }}
            onPointerLeave={() => showBand(null)}
            onFocus={(event: FocusEvent<HTMLDivElement>) => {
              if (!(event.target instanceof HTMLElement) || !event.currentTarget.contains(event.target)) return;
              if (event.target.dataset.key) setCursor(event.target.dataset.key);
              if (event.target.matches(":focus-visible")) showBand(colOf(event.target));
            }}
            onBlur={(event: FocusEvent<HTMLDivElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null) && !event.currentTarget.matches(":hover")) showBand(null); }}>
            <motion.span className={styles.band} style={{ x: bandX, width: bandWidth, opacity: bandOpacity }} aria-hidden="true" />

            <div role="row" className={`${styles.row} ${styles.headRow}`}>
              <div role="columnheader" className={`${styles.label} ${styles.corner}`} data-corner="">Permission</div>
              <AnimatePresence initial={false}>
                {roles.map((role, index) => <Slot key={role.id} kind="columnheader" col={role.id} head onEntered={() => entered(role.id)}>
                  <RoleHeader role={role} isNew={!change.savedIds.has(role.id)} dirty={change.touched.includes(role)} canRevert={PERMISSIONS.some(permission => change.cells.has(cellKey(role.id, permission.id)))}
                    nav={nav(`head:${role.id}`, 0, index + 1)} onDuplicate={() => duplicate(role)} onRevert={() => revertRole(role)} onDelete={() => deleteRole(role)} onCloseFocus={onMenuCloseFocus} />
                </Slot>)}
              </AnimatePresence>
            </div>

            {GROUPS.map(group => {
              const isOpen = open[group.id];
              return <Fragment key={group.id}>
                <div role="row" className={`${styles.row} ${styles.groupRow}`}>
                  <div role="rowheader" className={styles.label}>
                    <button type="button" className={styles.disclosure} aria-expanded={isOpen} aria-controls={isOpen ? `${id}-${group.id}` : undefined} onClick={() => setOpen({ ...open, [group.id]: !isOpen })} {...nav(`g:${group.id}`, rowOf[group.id], 0)}>
                      <motion.span className={styles.disclosureIcon} initial={false} animate={{ rotate: isOpen ? 0 : -90 }} transition={reduce ? { duration: 0 } : spring.snappy}><ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" /></motion.span>
                      <span className={styles.groupName}>{group.name}</span>
                      <span className={styles.groupCount}>{group.permissions.length}<span className={styles.srOnly}> permissions</span></span>
                    </button>
                  </div>
                  <AnimatePresence initial={false}>
                    {roles.map((role, index) => {
                      const on = group.permissions.filter(permission => grants[role.id]?.[permission.id]).length;
                      const state: ToggleState = on === 0 ? "off" : on === group.permissions.length ? "on" : "mixed";
                      return <Slot key={role.id} kind="gridcell" col={role.id}>
                        <Toggle kind="checkbox" state={state} label={`${role.name}: all ${group.name.toLowerCase()} permissions${role.locked ? ", always on" : ""}`} locked={role.locked} delay={0}
                          dirty={!isOpen && group.permissions.some(permission => change.cells.has(cellKey(role.id, permission.id)))} onToggle={() => toggleGroup(role, group)} nav={nav(`g:${group.id}:${role.id}`, rowOf[group.id], index + 1)} />
                      </Slot>;
                    })}
                  </AnimatePresence>
                </div>
                <AnimatePresence initial={false}>
                  {isOpen && <GroupBody key="body" id={`${id}-${group.id}`}>
                    {group.permissions.map(permission => <div key={permission.id} role="row" className={`${styles.row} ${styles.permRow}`}>
                      <div role="rowheader" className={`${styles.label} ${styles.permLabel}`}>{permission.label}</div>
                      <AnimatePresence initial={false}>
                        {roles.map((role, index) => {
                          const key = cellKey(role.id, permission.id);
                          const dirty = change.cells.has(key);
                          return <Slot key={role.id} kind="gridcell" col={role.id}>
                            <Toggle kind="switch" state={grants[role.id]?.[permission.id] ? "on" : "off"} label={`${role.name}: ${permission.label}${role.locked ? ", always on" : dirty ? ", unsaved" : ""}`} locked={role.locked}
                              dirty={dirty} delay={wave[key] ?? 0} onToggle={() => toggleCell(role, permission)} nav={nav(`p:${permission.id}:${role.id}`, rowOf[permission.id], index + 1)} />
                          </Slot>;
                        })}
                      </AnimatePresence>
                    </div>)}
                  </GroupBody>}
                </AnimatePresence>
              </Fragment>;
            })}
          </div>
        </div>

        <footer className={styles.foot}>
          <span className={styles.note}><Lock size={14} strokeWidth={1.75} aria-hidden="true" />Owners always have every permission</span>
          <span className={styles.note}><i className={styles.legendDot} aria-hidden="true" />Unsaved change</span>
        </footer>

        <p className={styles.srOnly} role="status" aria-live="polite">{status}</p>

        {/* The spacer makes room for the bar in flow; the zero-height sticky anchor keeps it in view while the matrix scrolls past the fold. */}
        <div className={styles.barSpace} data-open={showBar || undefined} aria-hidden="true" />
        <div className={styles.barAnchor}>
          <AnimatePresence>
            {showBar && <motion.div ref={barRef} key="bar" className={styles.bar} role="region" aria-label="Unsaved permission changes"
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: 16, transition: { y: spring.smooth, opacity: { duration: duration.standard, ease: standardEase } } }}
              transition={reduce ? { duration: 0 } : { y: spring.smooth, opacity: { duration: duration.fast, ease: enterEase } }}>
              <div className={styles.barText}>
                <Swap id={savedView ? "saved" : "pending"}>
                  {savedView
                    ? <span className={styles.barLine}><Check className={styles.savedIcon} size={16} strokeWidth={1.75} aria-hidden="true" />Permissions saved</span>
                    : <span className={styles.barLine}><span className={styles.count}><AnimatedCounter value={Math.max(change.count, 1)} /></span><span className={styles.unsavedWord}>unsaved</span><TextMorph>{change.count === 1 ? "change" : "changes"}</TextMorph></span>}
                </Swap>
                <Swap id={subline} className={styles.barSub}>{subline}</Swap>
              </div>
              <div className={styles.barActions}>
                <Button type="button" variant="ghost" size="sm" disabled={phase === "saving" || change.count === 0} onClick={discard}>Discard</Button>
                <Button type="button" size="sm" loading={phase === "saving"} onClick={save}>{savedView ? <><Check size={16} strokeWidth={1.75} aria-hidden="true" />Saved</> : "Save changes"}</Button>
              </div>
            </motion.div>}
          </AnimatePresence>
        </div>
      </div>
    </section>
  );
}

export default RolesPermissions;
