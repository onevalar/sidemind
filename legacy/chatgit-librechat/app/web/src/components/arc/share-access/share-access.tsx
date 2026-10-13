"use client";

import { ArcImage } from "../lib/arc-provider";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion } from "motion/react";
import type { Transition } from "motion/react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ClipboardEvent as ReactClipboardEvent, CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { AlertCircle, Check, ChevronDown, Globe, Link2, Lock, X } from "lucide-react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./share-access.module.css";

export type ShareRole = "viewer" | "commenter" | "editor";
export type ShareGeneralAccess = "restricted" | "link";

export interface ShareAccessContact {
  email: string;
  name?: string;
  /** Square portrait url. */
  src?: string;
}

export interface ShareAccessMember extends ShareAccessContact {
  id: string;
  /** The owner cannot be changed or removed. */
  role: ShareRole | "owner";
  /** Invited but not opened yet. */
  pending?: boolean;
}

export interface ShareAccessProps {
  /** Name of what is being shared, used in the heading. */
  title?: string;
  /** People with access. Pass with onMembersChange to control the list. */
  members?: readonly ShareAccessMember[];
  defaultMembers?: readonly ShareAccessMember[];
  onMembersChange?: (members: ShareAccessMember[]) => void;
  /** Who can open it without an invite. */
  access?: ShareGeneralAccess;
  defaultAccess?: ShareGeneralAccess;
  onAccessChange?: (access: ShareGeneralAccess) => void;
  /** What anyone with the link can do. */
  linkRole?: ShareRole;
  defaultLinkRole?: ShareRole;
  onLinkRoleChange?: (role: ShareRole) => void;
  /** People to suggest while typing, from your workspace directory. */
  directory?: readonly ShareAccessContact[];
  /** The link Copy link puts on the clipboard. */
  link?: string;
  /** Id of the member using the app, marked You. */
  selfId?: string;
  /** Role preselected for new invites. */
  defaultInviteRole?: ShareRole;
  /** Called when Invite is pressed with valid addresses. Return a promise to show progress; reject to keep the chips and show the error. */
  onInvite?: (people: ShareAccessContact[], role: ShareRole) => void | Promise<void>;
  onCopyLink?: (link: string) => void;
  /** Shows a Done button that calls this, for example to close the popover. */
  onDone?: () => void;
  className?: string;
  style?: CSSProperties;
}

const ROLES: { value: ShareRole; label: string; hint: string }[] = [
  { value: "viewer", label: "Can view", hint: "Read only" },
  { value: "commenter", label: "Can comment", hint: "Suggest and discuss" },
  { value: "editor", label: "Can edit", hint: "Make any change" },
];
const roleLabel = (role: ShareRole) => ROLES.find(entry => entry.value === role)!.label;
const ACCESS: { value: ShareGeneralAccess; label: string; hint: string }[] = [
  { value: "restricted", label: "Restricted", hint: "Only people with access can open" },
  { value: "link", label: "Anyone with the link", hint: "No sign in needed" },
];

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i;
const EASE = [...motionTokens.ease.standard] as [number, number, number, number];

interface Chip extends ShareAccessContact { key: string; valid: boolean }

function initialsOf(text: string) {
  const parts = text.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return parts.slice(0, 2).map(part => part[0]!.toUpperCase()).join("") || "?";
}

function Face({ contact, size }: { contact: ShareAccessContact; size: number }) {
  const [failed, setFailed] = useState<string>();
  return <span className={styles.face} style={{ width: size, height: size, fontSize: size * .36 }} aria-hidden="true">
    <span>{initialsOf(contact.name ?? contact.email)}</span>
    {contact.src && failed !== contact.src ? <ArcImage src={contact.src} alt="" fill sizes={`${size}px`} className={styles.photo} onError={() => setFailed(contact.src)} draggable={false} /> : null}
  </span>;
}

/** Text that crossfades to its new value while its width follows on a spring, so nothing beside it jumps. */
function MorphText({ text, reduceMotion }: { text: string; reduceMotion: boolean }) {
  const measure = useRef<HTMLSpanElement>(null);
  const width = useMotionValue(0);
  const ready = useRef(false);
  useLayoutEffect(() => {
    const node = measure.current;
    if (!node) return;
    const apply = () => {
      // offsetWidth ignores transforms, so a panel that is still scaling in does not skew the measure.
      const next = node.offsetWidth + 1;
      if (!ready.current || reduceMotion) { width.jump(next); ready.current = true; }
      else animate(width, next, motionTokens.spring.morph);
    };
    apply();
    // Web fonts can land after the first measure; follow them too.
    const observer = new ResizeObserver(apply);
    observer.observe(node);
    let live = true;
    document.fonts?.ready.then(() => { if (live) apply(); });
    return () => { live = false; observer.disconnect(); };
  }, [text, reduceMotion, width]);
  return <>
    <span ref={measure} className={styles.morphMeasure} aria-hidden="true">{text}</span>
    <motion.span className={styles.morph} style={{ width }}>
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span key={text} className={styles.morphText} initial={{ opacity: 0, y: reduceMotion ? 0 : 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduceMotion ? 0 : -6 }} transition={reduceMotion ? { duration: 0 } : motionTokens.spring.snappy}>{text}</motion.span>
    </AnimatePresence>
    </motion.span>
  </>;
}

/** A count that rolls up or down on tabular figures. */
function RollingCount({ value, reduceMotion }: { value: number; reduceMotion: boolean }) {
  const [state, setState] = useState({ value, direction: 1 });
  if (state.value !== value) setState({ value, direction: value < state.value ? -1 : 1 });
  return <span className={styles.count}>
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span key={value} initial={{ opacity: 0, y: reduceMotion ? 0 : `${.6 * state.direction}em` }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduceMotion ? 0 : `${-.6 * state.direction}em` }} transition={reduceMotion ? { duration: 0 } : motionTokens.spring.snappy}>{value}</motion.span>
    </AnimatePresence>
  </span>;
}

interface Option<T extends string> { value: T; label: string; hint?: string }

/** A compact menu for a role or access level: a text trigger whose label morphs, and a small floating list with checks. */
function ChoiceMenu<T extends string>({ value, options, onChange, label, reduceMotion, onRemove, align = "end", className, children }: { value: T; options: Option<T>[]; onChange: (value: T) => void; label: string; reduceMotion: boolean; onRemove?: () => void; align?: "start" | "end"; className?: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const current = options.find(option => option.value === value)!;
  return <Menu.Root open={open} onOpenChange={setOpen} modal={false}>
    <Menu.Trigger className={[styles.menuTrigger, className].filter(Boolean).join(" ")} aria-label={`${label}: ${current.label}`}>
      {children}
      <MorphText text={current.label} reduceMotion={reduceMotion} />
      <ChevronDown className={styles.chevron} size={16} strokeWidth={1.75} aria-hidden="true" />
    </Menu.Trigger>
    <AnimatePresence>
      {open ? <Menu.Portal forceMount>
        <Menu.Content forceMount asChild align={align} sideOffset={6} collisionPadding={12} loop>
          <motion.div
            className={styles.menu}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: .96, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, scale: .98, y: -2, transition: { duration: motionTokens.duration.fast, ease: EASE } }}
            transition={reduceMotion ? { duration: 0 } : motionTokens.spring.snappy}
          >
            <Menu.RadioGroup value={value} onValueChange={next => onChange(next as T)}>
              {options.map(option => <Menu.RadioItem key={option.value} value={option.value} className={styles.menuItem}>
                <span className={styles.menuText}>
                  <span>{option.label}</span>
                  {option.hint ? <span className={styles.menuHint}>{option.hint}</span> : null}
                </span>
                <Menu.ItemIndicator className={styles.menuCheck}><Check size={16} strokeWidth={1.75} aria-hidden="true" /></Menu.ItemIndicator>
              </Menu.RadioItem>)}
            </Menu.RadioGroup>
            {onRemove ? <>
              <Menu.Separator className={styles.menuSeparator} />
              <Menu.Item className={[styles.menuItem, styles.menuDanger].join(" ")} onSelect={onRemove}>Remove access</Menu.Item>
            </> : null}
          </motion.div>
        </Menu.Content>
      </Menu.Portal> : null}
    </AnimatePresence>
  </Menu.Root>;
}

type CopyState = "idle" | "copied" | "failed";

/**
 * A share panel. Invite people by name or email as validated chips with suggestions from your directory, set each person's
 * role from a compact menu, remove access with an undo, choose who else can open it, and copy the link. Every change lands in
 * place: new people slide into the list, removed rows fold away, labels morph to their new width and counts roll.
 */
export function ShareAccess({ title = "Q3 launch plan", members: membersProp, defaultMembers = [], onMembersChange, access: accessProp, defaultAccess = "restricted", onAccessChange, linkRole: linkRoleProp, defaultLinkRole = "viewer", onLinkRoleChange, directory = [], link = "https://fieldwork.example/d/q3-launch-plan", selfId, defaultInviteRole = "editor", onInvite, onCopyLink, onDone, className, style }: ShareAccessProps) {
  const reduceMotion = !!useReducedMotion();
  const id = useId();
  const spring = (kind: keyof typeof motionTokens.spring): Transition => reduceMotion ? { duration: 0 } : motionTokens.spring[kind];

  const [membersState, setMembersState] = useState<ShareAccessMember[]>(() => [...defaultMembers]);
  const members = membersProp ?? membersState;
  const setMembers = (next: ShareAccessMember[]) => { if (membersProp === undefined) setMembersState(next); onMembersChange?.(next); };
  const [accessState, setAccessState] = useState(defaultAccess);
  const access = accessProp ?? accessState;
  const setAccess = (next: ShareGeneralAccess) => { if (accessProp === undefined) setAccessState(next); onAccessChange?.(next); announce(next === "link" ? "Anyone with the link can open" : "Restricted to people with access"); };
  const [linkRoleState, setLinkRoleState] = useState(defaultLinkRole);
  const linkRole = linkRoleProp ?? linkRoleState;
  const setLinkRole = (next: ShareRole) => { if (linkRoleProp === undefined) setLinkRoleState(next); onLinkRoleChange?.(next); announce(`Anyone with the link ${roleLabel(next).toLowerCase()}`); };

  const [announcement, setAnnouncement] = useState("");
  const announce = (text: string) => setAnnouncement(text);

  /* Invite field ------------------------------------------------------------------------------------- */
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [chips, setChips] = useState<Chip[]>([]);
  const [armed, setArmed] = useState(false);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const [inviteRole, setInviteRole] = useState<ShareRole>(defaultInviteRole);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [fresh, setFresh] = useState<string[]>([]);

  const taken = (email: string) => members.some(member => member.email.toLowerCase() === email.toLowerCase()) || chips.some(chip => chip.email.toLowerCase() === email.toLowerCase());
  const needle = query.trim().toLowerCase();
  const suggestions = needle ? directory.filter(contact => !taken(contact.email) && ((contact.name ?? "").toLowerCase().split(/\s+/).some(part => part.startsWith(needle)) || (contact.name ?? "").toLowerCase().startsWith(needle) || contact.email.toLowerCase().startsWith(needle))).slice(0, 5) : [];
  const listOpen = focused && suggestions.length > 0;
  const activeIndex = Math.min(active, Math.max(0, suggestions.length - 1));

  const addContacts = (entries: (ShareAccessContact & { valid?: boolean })[]) => {
    const added: Chip[] = [];
    let duplicate: string | null = null;
    for (const entry of entries) {
      const email = entry.email.trim();
      if (!email) continue;
      const lower = email.toLowerCase();
      const known = directory.find(contact => contact.email.toLowerCase() === lower || contact.name?.toLowerCase() === lower);
      const contact = known ?? { email };
      if (taken(contact.email) || added.some(chip => chip.email.toLowerCase() === contact.email.toLowerCase())) {
        const member = members.find(item => item.email.toLowerCase() === contact.email.toLowerCase());
        duplicate = member ? `${member.name ?? member.email} already has access` : `${contact.name ?? contact.email} is already added`;
        continue;
      }
      added.push({ ...contact, key: `${contact.email}-${Date.now()}-${added.length}`, valid: !!known || EMAIL.test(contact.email) });
    }
    if (added.length) { setChips(current => [...current, ...added]); announce(added.map(chip => `${chip.name ?? chip.email} added${chip.valid ? "" : ", not a valid email"}`).join(". ")); }
    setNotice(duplicate);
    if (duplicate) announce(duplicate);
  };
  const commitQuery = () => {
    if (!query.trim()) return false;
    addContacts(query.split(/[,;\s]+/).map(email => ({ email })));
    setQuery("");
    setActive(0);
    return true;
  };
  const pickSuggestion = (contact: ShareAccessContact) => { addContacts([contact]); setQuery(""); setActive(0); input.current?.focus(); };
  const removeChip = (key: string) => { setChips(current => current.filter(chip => chip.key !== key)); setArmed(false); input.current?.focus(); };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && listOpen) { event.preventDefault(); setActive((activeIndex + 1) % suggestions.length); return; }
    if (event.key === "ArrowUp" && listOpen) { event.preventDefault(); setActive((activeIndex - 1 + suggestions.length) % suggestions.length); return; }
    if (event.key === "Enter") {
      event.preventDefault();
      if (listOpen) pickSuggestion(suggestions[activeIndex]);
      else if (!commitQuery() && chips.length && !chips.some(chip => !chip.valid)) invite();
      return;
    }
    if (event.key === "," || event.key === ";" || (event.key === " " && query.includes("@")) || (event.key === "Tab" && query.trim() && !event.shiftKey)) {
      if (query.trim()) { event.preventDefault(); commitQuery(); }
      return;
    }
    if (event.key === "Escape" && (query || listOpen)) { event.preventDefault(); event.stopPropagation(); setQuery(""); return; }
    if (event.key === "Backspace" && !query && chips.length) {
      event.preventDefault();
      // The first press marks the last chip; the second removes it.
      if (armed) { const last = chips[chips.length - 1]; setChips(chips.slice(0, -1)); setArmed(false); announce(`${last.name ?? last.email} removed`); }
      else setArmed(true);
      return;
    }
    setArmed(false);
  };
  const onPaste = (event: ReactClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    if (!/[,;\n\s]/.test(text.trim())) return;
    event.preventDefault();
    addContacts(text.split(/[,;\n\s]+/).map(email => ({ email })));
  };

  const invalid = chips.find(chip => !chip.valid);
  const message = invalid ? `“${invalid.email}” isn’t a valid email address` : notice;

  async function invite() {
    const people = chips.filter(chip => chip.valid).map(({ email, name, src }) => ({ email, name, src }));
    if (!people.length || invalid || sending) return;
    try {
      const result = onInvite?.(people, inviteRole);
      if (result && typeof (result as Promise<void>).then === "function") { setSending(true); await result; }
    } catch {
      setSending(false);
      setNotice("Couldn’t send the invites. Try again.");
      return;
    }
    setSending(false);
    const added: ShareAccessMember[] = people.map(person => ({ ...person, id: `invite-${person.email}`, role: inviteRole, pending: true }));
    setMembers([...members, ...added]);
    setFresh(added.map(member => member.id));
    setChips([]);
    setNotice(null);
    announce(`Invited ${people.length === 1 ? people[0].name ?? people[0].email : `${people.length} people`} as ${roleLabel(inviteRole).toLowerCase()}`);
  }
  useEffect(() => {
    if (!fresh.length) return;
    const timer = window.setTimeout(() => setFresh([]), 1600);
    return () => window.clearTimeout(timer);
  }, [fresh]);

  /* Members ------------------------------------------------------------------------------------------ */
  const [removed, setRemoved] = useState<{ member: ShareAccessMember; index: number } | null>(null);
  useEffect(() => {
    if (!removed) return;
    const timer = window.setTimeout(() => setRemoved(null), 6000);
    return () => window.clearTimeout(timer);
  }, [removed]);
  const changeRole = (member: ShareAccessMember, role: ShareRole) => {
    if (member.role === role) return;
    setMembers(members.map(item => item.id === member.id ? { ...item, role } : item));
    announce(`${member.name ?? member.email} ${roleLabel(role).toLowerCase()}`);
  };
  const remove = (member: ShareAccessMember) => {
    const index = members.findIndex(item => item.id === member.id);
    setMembers(members.filter(item => item.id !== member.id));
    setRemoved({ member, index });
    announce(`Removed ${member.name ?? member.email}`);
  };
  const undo = () => {
    if (!removed) return;
    const next = [...members];
    next.splice(Math.min(removed.index, next.length), 0, removed.member);
    setMembers(next);
    setFresh([removed.member.id]);
    announce(`${removed.member.name ?? removed.member.email} has access again`);
    setRemoved(null);
  };

  /* Copy link ---------------------------------------------------------------------------------------- */
  const [copy, setCopy] = useState<CopyState>("idle");
  useEffect(() => {
    if (copy === "idle") return;
    const timer = window.setTimeout(() => setCopy("idle"), 1800);
    return () => window.clearTimeout(timer);
  }, [copy]);
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopy("copied");
      announce("Link copied");
      onCopyLink?.(link);
    } catch {
      setCopy("failed");
      announce("Couldn’t copy the link");
    }
  };

  const listboxId = `${id}-suggestions`;
  const errorId = `${id}-error`;
  const heading = `Share “${title}”`;
  const AccessIcon = access === "link" ? Globe : Lock;

  return <section className={[styles.root, className].filter(Boolean).join(" ")} style={style} aria-label={heading}>
    <h2 className={styles.title}>{heading}</h2>

    <div className={styles.inviteArea}>
      <div className={styles.fieldWrap}>
      <div
        className={[styles.field, focused ? styles.fieldFocused : "", invalid ? styles.fieldInvalid : ""].join(" ")}
        onPointerDown={event => { if (event.target === event.currentTarget) { event.preventDefault(); input.current?.focus(); } }}
      >
        <AnimatePresence initial={false} mode="popLayout">
          {chips.map((chip, index) => <motion.span
            key={chip.key}
            layout={!reduceMotion}
            className={[styles.chip, chip.valid ? "" : styles.chipInvalid, armed && index === chips.length - 1 ? styles.chipArmed : ""].join(" ")}
            initial={{ opacity: 0, scale: reduceMotion ? 1 : .8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: reduceMotion ? 1 : .8, transition: { duration: reduceMotion ? 0 : motionTokens.duration.fast, ease: EASE } }}
            transition={spring("snappy")}
          >
            {chip.valid ? <Face contact={chip} size={20} /> : <AlertCircle className={styles.chipAlert} size={16} strokeWidth={1.75} aria-hidden="true" />}
            <span className={styles.chipText}>{chip.name ?? chip.email}</span>
            <button type="button" className={styles.chipRemove} onClick={() => removeChip(chip.key)} aria-label={`Remove ${chip.name ?? chip.email}`}><X size={14} strokeWidth={1.75} aria-hidden="true" /></button>
          </motion.span>)}
          <motion.input
            key="input"
            layout={!reduceMotion}
            transition={spring("snappy")}
            ref={input}
            className={styles.input}
            value={query}
            placeholder={chips.length ? "" : "Add people by name or email"}
            aria-label="Add people by name or email"
            role="combobox"
            aria-expanded={listOpen}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={listOpen ? `${listboxId}-${activeIndex}` : undefined}
            aria-invalid={!!invalid}
            aria-describedby={message ? errorId : undefined}
            autoComplete="off"
            spellCheck={false}
            onChange={event => { setQuery(event.target.value); setActive(0); setArmed(false); if (notice && !invalid) setNotice(null); }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onFocus={() => setFocused(true)}
            onBlur={() => { setFocused(false); setArmed(false); if (query.includes("@")) commitQuery(); }}
          />
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {listOpen ? <motion.ul
          key="list"
          id={listboxId}
          role="listbox"
          aria-label="Suggestions"
          className={styles.suggestions}
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4, scale: .98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={reduceMotion ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -2, scale: .99, transition: { duration: motionTokens.duration.fast, ease: EASE } }}
          transition={spring("snappy")}
        >
          {suggestions.map((contact, index) => <li
            key={contact.email}
            id={`${listboxId}-${index}`}
            role="option"
            aria-selected={index === activeIndex}
            className={styles.option}
            onPointerDown={event => event.preventDefault()}
            onPointerMove={() => setActive(index)}
            onClick={() => pickSuggestion(contact)}
          >
            {index === activeIndex ? <motion.span layoutId={`${id}-highlight`} className={styles.optionHighlight} transition={spring("morph")} /> : null}
            <Face contact={contact} size={28} />
            <span className={styles.personText}>
              <span className={styles.personName}>{contact.name ?? contact.email}</span>
              <span className={styles.personMeta}>{contact.email}</span>
            </span>
          </li>)}
        </motion.ul> : null}
      </AnimatePresence>
      </div>

      <AnimatePresence initial={false}>
        {message ? <motion.p key="message" id={errorId} className={[styles.message, invalid ? styles.messageError : ""].join(" ")} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring("smooth")}>
          <span className={styles.messageInner}>{message}</span>
        </motion.p> : null}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {chips.length ? <motion.div key="invite" className={styles.inviteRowWrap} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring("smooth")}>
          <div className={styles.inviteRow}>
            <ChoiceMenu label="Invite as" value={inviteRole} options={ROLES} onChange={setInviteRole} reduceMotion={reduceMotion} align="start" className={styles.inviteRole}>
              <span className={styles.inviteAs}>Invite as</span>
            </ChoiceMenu>
            <button type="button" className={styles.primary} onClick={invite} disabled={!!invalid || sending} aria-busy={sending}>
              <span className={styles.stack}>
                <span className={sending ? styles.hidden : ""}>Invite {chips.length > 1 ? chips.length : ""}</span>
                <span className={sending ? "" : styles.hidden} aria-hidden={!sending}>Sending</span>
              </span>
            </button>
          </div>
        </motion.div> : null}
      </AnimatePresence>
    </div>

    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>People with access <RollingCount value={members.length} reduceMotion={reduceMotion} /></h3>
      <ul className={styles.people}>
        <AnimatePresence initial={false}>
          {members.map(member => {
            const you = member.id === selfId;
            const name = member.name ?? member.email;
            return <motion.li
              key={member.id}
              className={styles.personWrap}
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={spring("smooth")}
            >
              <div className={[styles.person, fresh.includes(member.id) ? styles.fresh : ""].join(" ")}>
                <Face contact={member} size={32} />
                <span className={styles.personText}>
                  <span className={styles.personName}>{name}{you ? <span className={styles.you}> (you)</span> : null}</span>
                  <span className={styles.personMeta}>{member.pending ? `Invited · ${member.email}` : member.name ? member.email : "Guest"}</span>
                </span>
                {member.role === "owner"
                  ? <span className={styles.owner}>Owner</span>
                  : <ChoiceMenu label={`Role for ${name}`} value={member.role} options={ROLES} onChange={role => changeRole(member, role)} onRemove={() => remove(member)} reduceMotion={reduceMotion} />}
              </div>
            </motion.li>;
          })}
        </AnimatePresence>
      </ul>
      <AnimatePresence initial={false}>
        {removed ? <motion.div key={removed.member.id} className={styles.undoWrap} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring("smooth")}>
          <div className={styles.undo}>
            <span className={styles.undoText}>Removed {removed.member.name ?? removed.member.email}</span>
            <button type="button" className={styles.link} onClick={undo}>Undo</button>
          </div>
        </motion.div> : null}
      </AnimatePresence>
    </div>

    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>General access</h3>
      <div className={styles.general}>
        <span className={styles.generalIcon} aria-hidden="true">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span key={access} initial={{ opacity: 0, scale: .6, rotate: reduceMotion ? 0 : -30 }} animate={{ opacity: 1, scale: 1, rotate: 0 }} exit={{ opacity: 0, scale: .6, rotate: reduceMotion ? 0 : 30 }} transition={spring("snappy")} className={styles.iconSwap}>
              <AccessIcon size={20} strokeWidth={1.75} />
            </motion.span>
          </AnimatePresence>
        </span>
        <span className={styles.generalText}>
          <ChoiceMenu label="General access" value={access} options={ACCESS} onChange={setAccess} reduceMotion={reduceMotion} align="start" className={styles.accessTrigger} />
          <span className={styles.generalHint}>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span key={`${access}-${linkRole}`} className={styles.generalHintText} initial={{ opacity: 0, y: reduceMotion ? 0 : 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduceMotion ? 0 : -4 }} transition={spring("snappy")}>
                {access === "link" ? `Anyone who has the link ${roleLabel(linkRole).toLowerCase()}` : "Only people with access can open"}
              </motion.span>
            </AnimatePresence>
          </span>
        </span>
        <AnimatePresence initial={false}>
          {access === "link" ? <motion.span key="link-role" className={styles.linkRole} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={spring("smooth")}>
            <motion.span className={styles.linkRoleInner} initial={{ x: reduceMotion ? 0 : 10 }} animate={{ x: 0 }} exit={{ x: reduceMotion ? 0 : 10 }} transition={spring("snappy")}>
              <ChoiceMenu label="Link permission" value={linkRole} options={ROLES} onChange={setLinkRole} reduceMotion={reduceMotion} />
            </motion.span>
          </motion.span> : null}
        </AnimatePresence>
      </div>
    </div>

    <div className={styles.footer}>
      <button type="button" className={[styles.secondary, copy === "failed" ? styles.secondaryFailed : ""].join(" ")} onClick={copyLink}>
        <span className={styles.stack}>
          {(["idle", "copied", "failed"] as const).map(state => <motion.span
            key={state}
            className={styles.copyLabel}
            aria-hidden={copy !== state}
            initial={false}
            animate={{ opacity: copy === state ? 1 : 0, y: copy === state ? 0 : state === "idle" ? -6 : 6, scale: copy === state ? 1 : .96 }}
            transition={spring("snappy")}
          >
            {state === "idle" ? <Link2 size={16} strokeWidth={1.75} aria-hidden="true" /> : state === "copied" ? <Check size={16} strokeWidth={1.75} aria-hidden="true" /> : <AlertCircle size={16} strokeWidth={1.75} aria-hidden="true" />}
            {state === "idle" ? "Copy link" : state === "copied" ? "Link copied" : "Couldn’t copy"}
          </motion.span>)}
        </span>
      </button>
      {onDone ? <button type="button" className={styles.primary} onClick={onDone}>Done</button> : null}
    </div>

    <span className={styles.srOnly} role="status" aria-live="polite">{announcement}</span>
  </section>;
}

export default ShareAccess;
