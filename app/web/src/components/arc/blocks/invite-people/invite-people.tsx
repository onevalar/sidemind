"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ClipboardEvent as ReactClipboardEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import Image from "next/image";
import { AnimatePresence, LayoutGroup, MotionConfig, motion, useReducedMotion } from "motion/react";
import type { Transition } from "motion/react";
import { AlertCircle, Check, ChevronDown, ClipboardPaste, LoaderCircle, Mail, RotateCcw, Send, X } from "lucide-react";
import { AnimatedCounter } from "../../animated-counter/animated-counter";
import { motionTokens } from "../../lib/motion-tokens";
import { DIRECTORY, INVITED, PLANS, ROLES, SAMPLE_LIST, TEAM, isEmail, parseToken, roleLabel, splitList } from "./invite-people-data";
import type { Entry, PlanId, Role } from "./invite-people-data";
import styles from "./invite-people.module.css";

type Chip =
  | { kind: "ok"; key: string; entry: Entry; role: Role; flown: boolean }
  | { kind: "error"; key: string; text: string; message: string };
type Status = "sending" | "sent" | "joined";
type Invite = { key: string; entry: Entry; role: Role; status: Status; note: string };
type Option = { id: string; kind: "person" | "email" | "blocked"; entry: Entry; note: string };

const { spring, duration, ease, blur } = motionTokens;
const enterEase = [...ease.enter] as [number, number, number, number];
/** Avatars travel between the field, the pending list, and the team on one spring with a little life. */
const FLY: Transition = { type: "spring", visualDuration: .5, bounce: .16 };
const SHAKE = [[0, -6, 6, -4, 4, -2, 0], [0, 6, -6, 4, -4, 2, 0]];
const VISIBLE_TEAM = 5;
const icon = { size: 16, strokeWidth: 1.75, "aria-hidden": true } as const;
const cx = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

const subscribe = () => () => {};
function useReducedFlag() {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

/** Width follows the content on a spring, so a label that changes length never snaps its control to a new size. */
function AutoWidth({ children, className }: { children: ReactNode; className?: string }) {
  const reduced = useReducedFlag();
  const inner = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number | "auto">("auto");
  useLayoutEffect(() => {
    const node = inner.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(node.offsetWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <motion.span className={cx(styles.autoWidth, className)} initial={false} animate={{ width }} transition={reduced ? { duration: 0 } : spring.morph}>
    <span ref={inner} className={styles.autoWidthInner}>{children}</span>
  </motion.span>;
}

/** Height follows the content on a spring. Nothing is clipped, so avatars can fly in from outside. `decor` sits behind the content and fills the
 * animated box, so a border drawn there grows with the height instead of snapping ahead of it. */
function AutoHeight({ children, className, decor }: { children: ReactNode; className?: string; decor?: ReactNode }) {
  const reduced = useReducedFlag();
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | "auto">("auto");
  useLayoutEffect(() => {
    const node = inner.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(node.offsetHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <motion.div className={className} initial={false} animate={{ height }} transition={reduced ? { duration: 0 } : spring.smooth}>{decor}<div ref={inner}>{children}</div></motion.div>;
}

/** Copy keyed by `id` crossfades in place: the new text rises in as the old one lifts away. */
function Swap({ id, children }: { id: string; children: ReactNode }) {
  const reduced = useReducedFlag();
  return <span className={styles.swap}>
    <AnimatePresence initial={false} mode="popLayout">
      <motion.span key={id} className={styles.swapItem}
        initial={reduced ? { opacity: 0 } : { opacity: 0, y: "0.4em", filter: `blur(${blur.subtle}px)` }}
        animate={{ opacity: 1, y: "0em", filter: "blur(0px)", transitionEnd: { filter: "none" } }}
        exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: "-0.4em", filter: `blur(${blur.subtle}px)`, transition: { duration: duration.fast } }}
        transition={reduced ? { duration: duration.instant } : { duration: duration.standard, ease: enterEase }}>{children}</motion.span>
    </AnimatePresence>
  </span>;
}

/** Height opens and closes with the content, for messages that come and go under the field. */
function Collapse({ children, className }: { children: ReactNode; className?: string }) {
  const reduced = useReducedFlag();
  return <motion.div className={cx(styles.collapse, className)} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
    transition={reduced ? { duration: 0 } : { height: spring.smooth, opacity: { duration: duration.standard } }}>{children}</motion.div>;
}

function Avatar({ entry, size, layoutId, alt = "" }: { entry: Entry; size: number; layoutId?: string; alt?: string }) {
  return <motion.span layoutId={layoutId} className={styles.avatar} style={{ width: size, height: size, borderRadius: "50%" }} transition={{ layout: FLY }}>
    {entry.src
      ? <Image src={entry.src} alt={alt} width={size} height={size} sizes={`${size}px`} draggable={false} />
      : <span className={styles.initial} aria-hidden={!alt || undefined} role={alt ? "img" : undefined} aria-label={alt || undefined}>{entry.email.charAt(0).toUpperCase()}</span>}
  </motion.span>;
}

const initialPending = (): Invite[] => [{ key: INVITED.entry.email, entry: INVITED.entry, role: INVITED.role, status: "sent", note: INVITED.note }];

/**
 * An invite form for a workspace. People are picked from the directory or typed and pasted as emails, each with its own
 * role. Avatars fly from the suggestion into the field, from the field into the pending list, and from a row into the team
 * once someone joins. A seat meter shows members, pending invites, and the new selection against the plan limit.
 * Sending, joining, resending, and upgrading are simulated.
 */
export function InvitePeople() {
  const uid = useId();
  const reduced = useReducedFlag();
  const rootRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const pendingHeading = useRef<HTMLHeadingElement>(null);
  const seq = useRef(0);
  const joinedOnce = useRef(false);
  const timers = useRef<number[]>([]);

  const [team, setTeam] = useState<Entry[]>(TEAM);
  const [pending, setPending] = useState<Invite[]>(initialPending);
  const [chips, setChips] = useState<Chip[]>([]);
  const [plan, setPlan] = useState<PlanId>("starter");
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const [armed, setArmed] = useState(false);
  const [menu, setMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  const [nudge, setNudge] = useState(0);
  const [resent, setResent] = useState<Record<string, boolean>>({});
  const [live, setLive] = useState("");

  const pendingRef = useRef(pending);
  useEffect(() => { pendingRef.current = pending; });
  useEffect(() => {
    const list = timers.current;
    return () => list.forEach(timer => window.clearTimeout(timer));
  }, []);
  const later = (ms: number, run: () => void) => { timers.current.push(window.setTimeout(run, ms)); };

  const avatarId = (email: string) => `${uid}-avatar-${email}`;
  const okChips = chips.filter((chip): chip is Extract<Chip, { kind: "ok" }> => chip.kind === "ok");
  const errorChips = chips.filter((chip): chip is Extract<Chip, { kind: "error" }> => chip.kind === "error");
  const teamSet = useMemo(() => new Set(team.map(entry => entry.email)), [team]);
  const pendingSet = useMemo(() => new Set(pending.map(invite => invite.key)), [pending]);

  // Seats: people already in, invites out, and the new selection, against the plan.
  const joinedRows = pending.filter(invite => invite.status === "joined").length;
  const members = team.length + joinedRows;
  const out = pending.length - joinedRows;
  const selected = okChips.length;
  const limit = PLANS[plan].seats;
  const total = members + out + selected;
  const overBy = Math.max(0, total - limit);
  const blocked = selected === 0 || errorChips.length > 0 || overBy > 0;

  const options = useMemo<Option[]>(() => {
    const q = query.trim().toLowerCase();
    const chosen = new Set(chips.map(chip => chip.key));
    const status = (entry: Entry) => teamSet.has(entry.email) ? "On the team" : pendingSet.has(entry.email) ? "Invited" : chosen.has(entry.email) ? "Added" : null;
    if (!q) return DIRECTORY.filter(entry => !status(entry)).slice(0, 4).map(entry => ({ id: entry.email, kind: "person", entry, note: entry.title ?? "" }));
    const hits = DIRECTORY.filter(entry => entry.name!.toLowerCase().includes(q) || entry.email.includes(q))
      .map((entry): Option => { const note = status(entry); return { id: entry.email, kind: note ? "blocked" : "person", entry, note: note ?? entry.title ?? "" }; })
      .sort((a, b) => Number(a.kind === "blocked") - Number(b.kind === "blocked"))
      .slice(0, 5);
    if (isEmail(q) && !DIRECTORY.some(entry => entry.email === q) && !chosen.has(q)) hits.unshift({ id: `new:${q}`, kind: "email", entry: { email: q }, note: "Invite by email" });
    return hits;
  }, [chips, pendingSet, query, teamSet]);
  const firstEnabled = options.findIndex(option => option.kind !== "blocked");
  const activeIndex = options[active] && options[active].kind !== "blocked" ? active : firstEnabled;
  const listOpen = focused && !dismissed && (options.length > 0 || !!query.trim());
  const listId = `${uid}-list`, hintId = `${uid}-hint`, errorsId = `${uid}-errors`, seatsId = `${uid}-seats`, headingId = `${uid}-pending`;

  const showHint = (text: string) => {
    setHint(text);
    later(3200, () => setHint(current => current === text ? null : current));
  };

  /** Turns typed or pasted text into chips. Good entries become people, bad ones become error chips that say what is wrong. */
  const commit = (text: string) => {
    const taken = { team: teamSet, pending: pendingSet };
    const next = [...chips];
    let added = 0, invalid = 0, duplicates = 0;
    for (const token of splitList(text)) {
      const parsed = parseToken(token, taken);
      if (!parsed) continue;
      if (parsed.kind === "ok") {
        if (next.some(chip => chip.key === parsed.entry.email)) { duplicates++; continue; }
        next.push({ kind: "ok", key: parsed.entry.email, entry: parsed.entry, role: "member", flown: false });
        added++;
      } else {
        if (next.some(chip => chip.kind === "error" && chip.text.toLowerCase() === parsed.text.toLowerCase())) { duplicates++; continue; }
        next.push({ kind: "error", key: `error-${seq.current++}`, text: parsed.text, message: parsed.message });
        invalid++;
      }
    }
    setChips(next);
    setArmed(false);
    const parts = [added && `Added ${plural(added, "person", "people")}`, invalid && `${plural(invalid, "entry", "entries")} need a fix`, duplicates && `skipped ${plural(duplicates, "duplicate")}`].filter(Boolean) as string[];
    if (parts.length) {
      const sentence = parts.join(", ").replace(/^./, char => char.toUpperCase());
      setLive(sentence);
      if (parts.length > 1 || duplicates) showHint(sentence);
    }
  };

  const pick = (option: Option | undefined) => {
    if (!option || option.kind === "blocked") return;
    setChips(current => current.some(chip => chip.key === option.entry.email) ? current : [...current, { kind: "ok", key: option.entry.email, entry: option.entry, role: "member", flown: option.kind === "person" }]);
    setQuery("");
    setActive(0);
    setArmed(false);
    setLive(`Added ${option.entry.name ?? option.entry.email}`);
  };

  const removeChip = (key: string, label: string) => {
    setChips(current => current.filter(chip => chip.key !== key));
    setArmed(false);
    setLive(`Removed ${label}`);
    inputRef.current?.focus({ preventScroll: true });
  };

  const editChip = (chip: Extract<Chip, { kind: "error" }>) => {
    setChips(current => current.filter(entry => entry.key !== chip.key));
    setQuery(chip.text);
    setDismissed(false);
    setLive(`Editing ${chip.text}`);
    const input = inputRef.current;
    if (input) { input.focus({ preventScroll: true }); requestAnimationFrame(() => input.setSelectionRange(chip.text.length, chip.text.length)); }
  };

  const removeInvalid = () => {
    setChips(current => current.filter(chip => chip.kind === "ok"));
    setLive(`Removed ${plural(errorChips.length, "entry", "entries")}`);
  };

  const moveActive = (step: number) => {
    const enabled = options.map((option, index) => option.kind === "blocked" ? -1 : index).filter(index => index >= 0);
    if (!enabled.length) return;
    const at = enabled.indexOf(activeIndex);
    setActive(enabled[(at + step + enabled.length) % enabled.length]);
  };

  const onInputKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!listOpen) { setDismissed(false); return; }
      moveActive(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = listOpen && activeIndex >= 0 ? options[activeIndex] : undefined;
      if (option && (query.trim() || option.kind === "person")) { pick(option); return; }
      if (query.trim()) { commit(query); setQuery(""); }
    } else if ((event.key === "," || event.key === ";") && query.trim()) {
      event.preventDefault();
      commit(query);
      setQuery("");
    } else if (event.key === "Backspace" && !query && chips.length) {
      const last = chips[chips.length - 1];
      if (armed) removeChip(last.key, last.kind === "ok" ? last.entry.name ?? last.entry.email : last.text);
      else { setArmed(true); setLive(`Press backspace again to remove ${last.kind === "ok" ? last.entry.name ?? last.entry.email : last.text}`); }
    } else if (event.key === "Escape") {
      if (listOpen) { event.preventDefault(); setDismissed(true); }
      else if (query) { event.preventDefault(); setQuery(""); }
    }
  };

  const onPaste = (event: ReactClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    if (splitList(text).length < 2) return;
    event.preventDefault();
    commit(text);
  };

  // Role menu: anchored under the chip's role button, rendered at the card so the field never clips it.
  const openMenu = (key: string, trigger: HTMLButtonElement) => {
    const root = rootRef.current;
    if (!root) return;
    if (menu?.key === key) { setMenu(null); return; }
    const box = root.getBoundingClientRect(), anchor = trigger.getBoundingClientRect();
    const width = 232;
    menuTrigger.current = trigger;
    setMenu({ key, x: Math.max(8, Math.min(anchor.left - box.left - 8, box.width - width - 8)), y: anchor.bottom - box.top + 6 });
  };
  const closeMenu = (restore: boolean) => {
    setMenu(null);
    if (restore) menuTrigger.current?.focus({ preventScroll: true });
  };
  const menuChip = menu ? okChips.find(chip => chip.key === menu.key) : undefined;
  const menuKey = menuChip?.key;
  useEffect(() => {
    if (!menuKey) return;
    menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus({ preventScroll: true });
    const down = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || menuTrigger.current?.contains(target)) return;
      setMenu(null);
    };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }, [menuKey]);
  const chooseRole = (role: Role) => {
    if (!menuChip) return;
    setChips(current => current.map(chip => chip.key === menuChip.key && chip.kind === "ok" ? { ...chip, role } : chip));
    setLive(`${menuChip.entry.name ?? menuChip.entry.email} will join as ${roleLabel(role).toLowerCase()}`);
    closeMenu(true);
  };
  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]'));
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (index: number) => { event.preventDefault(); items[(index + items.length) % items.length]?.focus(); };
    if (event.key === "ArrowDown") go(at + 1);
    else if (event.key === "ArrowUp") go(at - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(items.length - 1);
    else if (event.key === "Escape") { event.preventDefault(); closeMenu(true); }
    else if (event.key === "Tab") setMenu(null);
  };

  const send = () => {
    if (!selected) { inputRef.current?.focus(); return; }
    if (errorChips.length) { setShake(count => count + 1); setLive(`Fix or remove ${plural(errorChips.length, "entry", "entries")} before sending`); return; }
    if (overBy) { setNudge(count => count + 1); setLive(`${plural(overBy, "seat")} over the ${PLANS[plan].name} plan. Upgrade or remove people to send.`); return; }
    const batch: Invite[] = okChips.map(chip => ({ key: chip.key, entry: chip.entry, role: chip.role, status: "sending", note: "Sending" }));
    setMenu(null);
    setChips([]);
    setQuery("");
    setPending(current => [...batch, ...current]);
    setLive(`Sending ${plural(batch.length, "invite")}`);
    const step = reduced ? 0 : 160, first = reduced ? 300 : 700;
    batch.forEach((invite, index) => later(first + index * step, () => setPending(current => current.map(row => row.key === invite.key && row.status === "sending" ? { ...row, status: "sent", note: "Sent just now" } : row))));
    const settled = first + batch.length * step;
    later(settled, () => setLive(`${plural(batch.length, "invite")} sent`));
    if (joinedOnce.current) return;
    joinedOnce.current = true;
    const joiner = batch[0];
    const name = joiner.entry.name ?? joiner.entry.email;
    later(settled + 2400, () => {
      if (!pendingRef.current.some(row => row.key === joiner.key && row.status === "sent")) { joinedOnce.current = false; return; }
      setPending(current => current.map(row => row.key === joiner.key ? { ...row, status: "joined", note: "Joined" } : row));
      setLive(`${name} accepted and joined Fieldwork`);
      later(1200, () => {
        if (!pendingRef.current.some(row => row.key === joiner.key && row.status === "joined")) return;
        setPending(current => current.filter(row => row.key !== joiner.key));
        setTeam(current => [joiner.entry, ...current]);
      });
    });
  };

  const resend = (invite: Invite) => {
    setResent(current => ({ ...current, [invite.key]: true }));
    setLive(`Invite sent again to ${invite.entry.name ?? invite.entry.email}`);
    later(2000, () => setResent(current => ({ ...current, [invite.key]: false })));
  };

  const revoke = (invite: Invite) => {
    setPending(current => current.filter(row => row.key !== invite.key));
    setLive(`Revoked the invite for ${invite.entry.name ?? invite.entry.email}. One seat freed.`);
    pendingHeading.current?.focus({ preventScroll: true });
  };

  const upgrade = () => {
    setPlan("team");
    setLive(`Upgraded to the Team plan with ${PLANS.team.seats} seats.`);
    showHint("Upgraded to Team");
  };

  const reset = () => {
    timers.current.splice(0).forEach(timer => window.clearTimeout(timer));
    joinedOnce.current = false;
    setTeam(TEAM);
    setPending(initialPending());
    setChips([]);
    setPlan("starter");
    setQuery("");
    setMenu(null);
    setHint(null);
    setResent({});
    setArmed(false);
    setLive("Preview reset");
  };

  const smooth: Transition = reduced ? { duration: 0 } : spring.smooth;
  const snappy: Transition = reduced ? { duration: 0 } : spring.snappy;
  const layoutMove: Transition = reduced ? { duration: 0 } : spring.smooth;
  const visibleTeam = team.slice(0, VISIBLE_TEAM);
  const extra = team.length - visibleTeam.length;
  const pct = (count: number) => `${Math.min(100, (count / limit) * 100)}%`;

  const renderChip = (chip: Chip) => {
    if (chip.kind === "error") return <motion.li key={chip.key} layout="position" className={styles.chip} data-kind="error" data-armed={armed && chip === chips[chips.length - 1] || undefined}
      initial={{ opacity: 0, x: 0 }} animate={{ opacity: 1, x: reduced ? 0 : SHAKE[shake % 2] }} exit={{ opacity: 0, scale: .92, transition: { duration: duration.fast } }}
      transition={{ opacity: { duration: duration.fast }, x: { duration: .42, ease: "easeOut" }, layout: layoutMove }}>
      <span className={styles.chipSkin} aria-hidden="true" />
      <button type="button" className={styles.errorEdit} onClick={() => editChip(chip)} aria-label={`Edit ${chip.text}. ${chip.message}`} title="Edit">
        <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" />
        <span className={styles.chipLabel}>{chip.text}</span>
      </button>
      <button type="button" className={styles.chipRemove} aria-label={`Remove ${chip.text}`} onClick={() => removeChip(chip.key, chip.text)}><X size={14} strokeWidth={1.75} aria-hidden="true" /></button>
    </motion.li>;
    const label = chip.entry.name ?? chip.entry.email;
    const open = menu?.key === chip.key;
    return <motion.li key={chip.key} layout="position" className={styles.chip} data-armed={armed && chip === chips[chips.length - 1] || undefined}
      initial={chip.flown ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: duration.fast } }}
      transition={{ opacity: { duration: duration.fast }, layout: layoutMove }}>
      <motion.span className={styles.chipSkin} aria-hidden="true" initial={reduced ? false : { opacity: 0, scale: .9 }} animate={{ opacity: 1, scale: 1 }} transition={snappy} />
      <Avatar entry={chip.entry} size={22} layoutId={avatarId(chip.entry.email)} />
      <motion.span className={styles.chipBody} initial={reduced ? false : { opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} transition={reduced ? { duration: 0 } : { ...spring.smooth, delay: chip.flown ? .08 : 0 }}>
        <span className={styles.chipLabel} title={chip.entry.email}>{label}</span>
        <button type="button" className={styles.role} aria-haspopup="menu" aria-expanded={open} aria-label={`Role for ${label}: ${roleLabel(chip.role)}`} data-open={open || undefined}
          onClick={event => openMenu(chip.key, event.currentTarget)}
          onKeyDown={event => { if (event.key === "ArrowDown" && !open) { event.preventDefault(); openMenu(chip.key, event.currentTarget); } }}>
          <AutoWidth><Swap id={chip.role}>{roleLabel(chip.role)}</Swap></AutoWidth>
          <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button type="button" className={styles.chipRemove} aria-label={`Remove ${label}`} onClick={() => removeChip(chip.key, label)}><X size={14} strokeWidth={1.75} aria-hidden="true" /></button>
      </motion.span>
    </motion.li>;
  };

  return <MotionConfig reducedMotion="user">
    <LayoutGroup id={uid}>
      <section ref={rootRef} className={styles.root} aria-labelledby={`${uid}-title`}>
        <header className={styles.header}>
          <div className={styles.heading}>
            <h2 id={`${uid}-title`} className={styles.title}>Invite teammates</h2>
            <p className={styles.subtitle}>Add people to Fieldwork by name or email</p>
          </div>
          <ul className={styles.team} aria-label={`Team, ${plural(team.length, "member")}`}>
            <AnimatePresence initial={false} mode="popLayout">
              {/* New members only arrive by flying in from their pending row, so they need no entrance of their own. */}
              {visibleTeam.map(entry => <motion.li key={entry.email} layout="position" className={styles.teamItem}
                initial={false} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .9 }} transition={{ ...snappy, layout: layoutMove }}>
                <Avatar entry={entry} size={28} layoutId={avatarId(entry.email)} alt={entry.name ?? entry.email} />
              </motion.li>)}
              {extra > 0 && <motion.li key="more" layout="position" className={cx(styles.teamItem, styles.teamMore)}
                initial={{ opacity: 0, scale: .9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .9 }} transition={{ ...snappy, layout: layoutMove }}>
                <span aria-hidden="true">+{extra}</span><span className={styles.srOnly}>and {extra} more</span>
              </motion.li>}
            </AnimatePresence>
          </ul>
        </header>

        <div className={styles.fieldWrap}>
          <AutoHeight className={styles.fieldShell} decor={<span className={styles.fieldSkin} aria-hidden="true" />}>
            <div className={styles.field} data-focused={focused || undefined} onClick={event => { if (!(event.target as HTMLElement).closest("button, input")) inputRef.current?.focus(); }}>
              <ul className={styles.chips} aria-label="People to invite">
                <AnimatePresence initial={false} mode="popLayout">{chips.map(renderChip)}</AnimatePresence>
                <motion.li layout="position" transition={{ layout: layoutMove }} className={styles.inputItem}>
                  <input ref={inputRef} className={styles.input} type="text" role="combobox" aria-label="Emails or names" aria-expanded={listOpen} aria-controls={listId} aria-autocomplete="list"
                    aria-activedescendant={listOpen && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined} aria-describedby={hintId}
                    placeholder={chips.length ? "Add more" : "Name or email, like emma@fieldwork.example"} value={query} autoComplete="off" spellCheck={false}
                    onChange={event => { setQuery(event.target.value); setActive(0); setDismissed(false); setArmed(false); }}
                    onKeyDown={onInputKey} onPaste={onPaste}
                    onFocus={() => { setFocused(true); setDismissed(false); }} onBlur={() => { setFocused(false); setArmed(false); }} />
                </motion.li>
              </ul>
            </div>
          </AutoHeight>

          <AnimatePresence>
            {listOpen && <motion.div key="list" className={styles.popover} onPointerDown={event => event.preventDefault()}
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: -4, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, y: -4, scale: .98, transition: { duration: duration.fast } }} transition={reduced ? { duration: duration.instant } : spring.snappy}>
              {!query.trim() && <p className={styles.popHeading}>Suggested</p>}
              <ul id={listId} className={styles.options} role="listbox" aria-label="Suggestions">
                {options.map((option, index) => <motion.li key={option.id} id={`${listId}-${index}`} role="option" aria-selected={index === activeIndex} aria-disabled={option.kind === "blocked" || undefined}
                  className={styles.option} data-kind={option.kind} layout="position" transition={{ layout: layoutMove }}
                  onPointerMove={() => { if (option.kind !== "blocked" && index !== activeIndex) setActive(index); }} onClick={() => pick(option)}>
                  {index === activeIndex && <motion.span layoutId={`${uid}-highlight`} className={styles.optionHighlight} transition={reduced ? { duration: 0 } : spring.morph} aria-hidden="true" />}
                  {option.kind === "email"
                    ? <span className={cx(styles.avatar, styles.mailAvatar)} style={{ width: 30, height: 30 }}><Mail size={15} strokeWidth={1.75} aria-hidden="true" /></span>
                    : <Avatar entry={option.entry} size={30} layoutId={option.kind === "person" ? avatarId(option.entry.email) : undefined} />}
                  <span className={styles.optionText}>
                    <span className={styles.optionName}>{option.kind === "email" ? option.entry.email : option.entry.name}</span>
                    <span className={styles.optionEmail}>{option.kind === "email" ? "Invite by email" : option.entry.email}</span>
                  </span>
                  {option.kind !== "email" && <span className={styles.optionNote}>{option.note}</span>}
                </motion.li>)}
              </ul>
              {!options.length && <p className={styles.popEmpty}>No one matches “{query.trim()}”. Type a full email to invite them.</p>}
            </motion.div>}
          </AnimatePresence>
        </div>

        <div className={styles.hintRow}>
          <p id={hintId} className={styles.hint}><Swap id={hint ?? "default"}>{hint ?? "Separate with commas, or paste a whole list"}</Swap></p>
          <button type="button" className={styles.textButton} onClick={() => commit(SAMPLE_LIST)}><ClipboardPaste {...icon} size={14} />Paste a sample list</button>
        </div>

        <AnimatePresence initial={false}>
          {errorChips.length > 0 && <Collapse key="errors">
            <div id={errorsId} className={styles.errors}>
              <div className={styles.errorsHead}>
                <span className={styles.errorsTitle}><AlertCircle {...icon} /><AutoWidth><Swap id={String(errorChips.length)}>{plural(errorChips.length, "entry", "entries")} can’t be invited</Swap></AutoWidth></span>
                <button type="button" className={styles.textButton} onClick={removeInvalid}>Remove invalid</button>
              </div>
              <ul className={styles.errorList}>
                <AnimatePresence initial={false}>
                  {errorChips.map(chip => <motion.li key={chip.key} className={styles.collapse} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                    transition={reduced ? { duration: 0 } : { height: spring.smooth, opacity: { duration: duration.fast } }}>
                    <span className={styles.errorLine}>{chip.message}</span>
                  </motion.li>)}
                </AnimatePresence>
              </ul>
              <p className={styles.errorsFoot}>Select an entry to fix it</p>
            </div>
          </Collapse>}
        </AnimatePresence>

        <div className={styles.seats} id={seatsId}>
          <div className={styles.seatsHead}>
            <span className={styles.seatsCount} data-over={overBy > 0 || undefined}>
              <span className={styles.num}><AnimatedCounter value={total} /></span>
              <span className={styles.seatsOf}>of</span>
              <span className={styles.num}><AnimatedCounter value={limit} /></span>
              <span className={styles.seatsOf}>seats</span>
            </span>
            <span className={styles.plan}><Swap id={plan}>{PLANS[plan].name} plan</Swap></span>
          </div>
          <div className={styles.track} role="meter" aria-label="Seats" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(total, limit)}
            aria-valuetext={`${total} of ${limit} seats${overBy ? `, ${overBy} over the limit` : ""}`}>
            <motion.span className={styles.segment} data-kind={overBy ? "over" : "new"} initial={false} animate={{ width: pct(total) }} transition={smooth} />
            <motion.span className={styles.segment} data-kind="pending" data-edge={selected > 0 || undefined} initial={false} animate={{ width: pct(members + out) }} transition={smooth} />
            <motion.span className={styles.segment} data-kind="members" data-edge={out + selected > 0 || undefined} initial={false} animate={{ width: pct(members) }} transition={smooth} />
          </div>
          <ul className={styles.legend} aria-hidden="true">
            <li><span className={styles.swatch} data-kind="members" />{plural(members, "member")}</li>
            <li><span className={styles.swatch} data-kind="pending" />{out} pending</li>
            <li><span className={styles.swatch} data-kind={overBy ? "over" : "new"} />{selected} new</li>
          </ul>
          <AnimatePresence initial={false}>
            {overBy > 0 && <Collapse key="over">
              <motion.div className={styles.over} animate={{ x: reduced || !nudge ? 0 : SHAKE[nudge % 2] }} transition={{ duration: .42, ease: "easeOut" }}>
                <AlertCircle {...icon} />
                <span className={styles.overText}><AutoWidth><Swap id={String(overBy)}>{plural(overBy, "seat")} over</Swap></AutoWidth> the {PLANS[plan].name} plan</span>
                {plan === "starter"
                  ? <button type="button" className={styles.ghost} onClick={upgrade}>Upgrade to Team</button>
                  : <span className={styles.overHelp}>Remove people to send</span>}
              </motion.div>
            </Collapse>}
          </AnimatePresence>
        </div>

        <footer className={styles.footer}>
          <div className={styles.footerActions}>
            <button type="button" className={styles.iconButton} onClick={reset} aria-label="Reset preview" title="Reset preview"><RotateCcw {...icon} /></button>
            <button type="button" className={styles.send} onClick={send} aria-disabled={blocked || undefined}
              aria-describedby={errorChips.length ? errorsId : overBy ? seatsId : undefined} aria-label={selected ? `Send ${plural(selected, "invite")}` : "Send invites"}>
              <Send {...icon} />
              <span className={styles.sendLabel} aria-hidden="true">
                Send
                <motion.span className={styles.sendCount} initial={false} animate={{ width: selected ? "auto" : 0, opacity: selected ? 1 : 0 }} transition={reduced ? { duration: 0 } : spring.morph}>
                  <span className={styles.num}><AnimatedCounter value={Math.max(1, selected)} /></span>
                </motion.span>
                <AutoWidth className={styles.sendWord}><Swap id={selected === 1 ? "one" : "many"}>{selected === 1 ? "invite" : "invites"}</Swap></AutoWidth>
              </span>
            </button>
          </div>
        </footer>

        <section className={styles.pending} aria-labelledby={headingId}>
          <h3 id={headingId} ref={pendingHeading} tabIndex={-1} className={styles.pendingHead}>
            Pending <span className={styles.pendingCount}><span className={styles.num}><AnimatedCounter value={out} /></span></span>
          </h3>
          <ul className={styles.rows}>
            <AnimatePresence initial={false}>
              {pending.map(invite => {
                const label = invite.entry.name ?? invite.entry.email;
                const again = !!resent[invite.key];
                return <motion.li key={invite.key} className={styles.row} initial={{ height: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                  transition={reduced ? { duration: 0 } : { height: spring.smooth, opacity: { duration: duration.fast } }}>
                  <div className={styles.rowInner}>
                    <Avatar entry={invite.entry} size={36} layoutId={avatarId(invite.entry.email)} />
                    <motion.div className={styles.rowText} initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: duration.standard, delay: .12 }}>
                      <span className={styles.rowName}>{label}</span>
                      <span className={styles.rowMeta}>{roleLabel(invite.role)}{invite.entry.name ? ` · ${invite.entry.email}` : ""}</span>
                    </motion.div>
                    <motion.span className={styles.status} data-status={invite.status} initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: duration.standard, delay: .12 }}>
                      <AutoWidth>
                        <Swap id={invite.status + invite.note}>
                          <span className={styles.statusInner}>
                            {invite.status === "sending" && <LoaderCircle className={styles.spin} size={13} strokeWidth={1.75} aria-hidden="true" />}
                            {invite.status === "joined" && <Check size={13} strokeWidth={2} aria-hidden="true" />}
                            {invite.note}
                          </span>
                        </Swap>
                      </AutoWidth>
                    </motion.span>
                    <motion.div className={styles.rowActions} data-hidden={invite.status === "joined" || undefined} initial={reduced ? false : { opacity: 0 }}
                      animate={{ opacity: invite.status === "joined" ? 0 : 1 }} transition={{ duration: invite.status === "joined" ? duration.fast : duration.standard, delay: invite.status === "joined" ? 0 : .12 }}>
                      <button type="button" className={styles.textButton} onClick={() => { if (!again) resend(invite); }} disabled={invite.status !== "sent"} aria-disabled={again || undefined}
                        aria-label={again ? `Invite sent again to ${label}` : `Resend invite to ${label}`}>
                        <span className={styles.stack}>
                          <span data-on={!again || undefined}>Resend</span>
                          <span data-on={again || undefined}><Check size={13} strokeWidth={2} aria-hidden="true" />Sent again</span>
                        </span>
                      </button>
                      <button type="button" className={styles.iconButton} data-size="sm" onClick={() => revoke(invite)} disabled={invite.status !== "sent"}
                        aria-label={`Revoke invite for ${label}`} title="Revoke invite"><X size={15} strokeWidth={1.75} aria-hidden="true" /></button>
                    </motion.div>
                  </div>
                </motion.li>;
              })}
            </AnimatePresence>
          </ul>
          <AnimatePresence initial={false}>
            {pending.length === 0 && <Collapse key="empty"><p className={styles.empty}>No pending invites</p></Collapse>}
          </AnimatePresence>
        </section>

        <AnimatePresence>
          {menu && menuChip && <motion.div key="menu" ref={menuRef} className={styles.menu} role="menu" aria-label={`Role for ${menuChip.entry.name ?? menuChip.entry.email}`}
            style={{ left: menu.x, top: menu.y }} onKeyDown={onMenuKey}
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: -4, scale: .97 }} animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -4, scale: .97, transition: { duration: duration.fast } }} transition={reduced ? { duration: duration.instant } : spring.snappy}>
            {ROLES.map(role => <button key={role.value} type="button" role="menuitemradio" aria-checked={menuChip.role === role.value} className={styles.menuItem}
              onPointerMove={event => { if (document.activeElement !== event.currentTarget) event.currentTarget.focus({ preventScroll: true }); }}
              onClick={() => chooseRole(role.value)}>
              <span className={styles.menuLabel}>{role.label}</span>
              <span className={styles.menuDescription}>{role.description}</span>
              {menuChip.role === role.value && <Check className={styles.menuCheck} size={15} strokeWidth={2} aria-hidden="true" />}
            </button>)}
          </motion.div>}
        </AnimatePresence>

        <p className={styles.srOnly} aria-live="polite">{live}</p>
      </section>
    </LayoutGroup>
  </MotionConfig>;
}

export default InvitePeople;
