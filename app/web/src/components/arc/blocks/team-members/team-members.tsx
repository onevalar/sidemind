"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent, ReactNode } from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { AnimatePresence, LayoutGroup, MotionConfig, motion, useReducedMotion } from "motion/react";
import type { Transition, Variants } from "motion/react";
import { AlertCircle, Check, ChevronDown, UserMinus, X } from "lucide-react";
import { AnimatedCounter } from "../../animated-counter/animated-counter";
import { Avatar } from "../../avatar/avatar";
import { Button } from "../../button/button";
import { SearchField } from "../../search-field/search-field";
import { TextMorph } from "../../text-morph/text-morph";
import { avatar } from "../../lib/media";
import { motionTokens } from "../../lib/motion-tokens";
import styles from "./team-members.module.css";

type Role = "owner" | "admin" | "member" | "viewer";
type Member = { id: string; name: string; email: string; photo: string; role: Role; active: string; online?: boolean; you?: boolean };
type Invite = { id: string; email: string; role: Role; sent: string };
type Tone = "hint" | "warning" | "error";

const SEATS = 10;
const WORKSPACE = "Fieldnote";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const roleNames: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member", viewer: "Viewer" };
const roleOptions: { value: Role; hint: string }[] = [
  { value: "admin", hint: "Manages members, billing, and settings" },
  { value: "member", hint: "Creates and edits projects" },
  { value: "viewer", hint: "Views and comments, no editing" },
];

// Sample workspace. Replace members and invites with your own directory and invitations API.
const initialMembers: Member[] = [
  { id: "emma", name: "Emma Collins", email: "emma@fieldnote.example", photo: avatar("emma-collins"), role: "owner", active: "Active now", online: true, you: true },
  { id: "ava", name: "Ava Mitchell", email: "ava@fieldnote.example", photo: avatar("ava-mitchell"), role: "admin", active: "Active now", online: true },
  { id: "marcus", name: "Marcus Johnson", email: "marcus@fieldnote.example", photo: avatar("marcus-johnson"), role: "member", active: "Active 2 hours ago" },
  { id: "jasmine", name: "Jasmine Brooks", email: "jasmine@fieldnote.example", photo: avatar("jasmine-brooks"), role: "member", active: "Active yesterday" },
  { id: "sofia", name: "Sofia Ramirez", email: "sofia@fieldnote.example", photo: avatar("sofia-ramirez"), role: "viewer", active: "Active Sep 14" },
];
const initialInvites: Invite[] = [
  { id: "jordan", email: "jordan.blake@fieldnote.example", role: "member", sent: "Invited Sep 19" },
  { id: "priya", email: "priya.shah@harborline.studio", role: "viewer", sent: "Invited Sep 20" },
];

const { spring, duration, blur } = motionTokens;
type Bezier = [number, number, number, number];
const easeEnter = [...motionTokens.ease.enter] as Bezier;
const easeStandard = [...motionTokens.ease.standard] as Bezier;
const instant: Transition = { duration: 0 };
const withArticle = (role: Role) => (role === "admin" ? "an admin" : `a ${role}`);
const initialsOf = (email: string) => email.split("@")[0].split(/[._-]+/).filter(Boolean).slice(0, 2).map(part => part[0].toUpperCase()).join("");

/** A chip sharpens in where it was typed. Removed by hand it blurs away; sent, it hands its place to the pending row it becomes. */
const chipVariants: Variants = {
  enter: { opacity: 0, scale: .9, filter: `blur(${blur.soft}px)` },
  rest: { opacity: 1, scale: 1, filter: "blur(0px)" },
  exit: (mode: "removed" | "sent") => mode === "sent" ? { opacity: 0, transition: instant } : { opacity: 0, scale: .9, filter: `blur(${blur.soft}px)`, transition: { duration: duration.exit, ease: easeStandard } },
};
const chipTransition: Transition = { ...spring.snappy, opacity: { duration: duration.fast, ease: easeEnter }, filter: { duration: duration.fast, ease: easeEnter }, layout: spring.morph };

function useMeasuredHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState<number | "auto">("auto");
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(node.offsetHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, height] as const;
}

/** A list row that opens and closes its own height, so the rows around it close the gap instead of jumping. It also follows its content, like the confirm state. */
function Row({ children, className, fade = true, open = false, confirming = false }: { children: ReactNode; className: string; fade?: boolean; open?: boolean; confirming?: boolean }) {
  const reduce = useReducedMotion();
  const [inner, height] = useMeasuredHeight<HTMLDivElement>();
  return <motion.li className={className} data-confirming={confirming || undefined} style={{ overflow: open ? "visible" : "hidden" }}
    initial={{ height: 0, opacity: fade ? 0 : 1 }} animate={{ height, opacity: 1 }}
    exit={{ height: 0, opacity: 0, transition: reduce ? instant : { height: spring.smooth, opacity: { duration: duration.fast, ease: easeStandard } } }}
    transition={reduce ? instant : { height: spring.smooth, opacity: { duration: duration.standard, ease: easeEnter } }}>
    <div ref={inner}>{children}</div>
  </motion.li>;
}

/** Changing text rises in out of a small blur while the old copy lifts away. */
function Swap({ text }: { text: string }) {
  const reduce = useReducedMotion();
  return <span className={styles.swap} aria-hidden="true"><AnimatePresence mode="popLayout" initial={false}>
    <motion.span key={text} className={styles.swapText} initial={reduce ? { opacity: 0 } : { opacity: 0, y: "0.45em", filter: `blur(${blur.soft}px)` }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      exit={reduce ? { opacity: 0, transition: instant } : { opacity: 0, y: "-0.35em", filter: `blur(${blur.subtle}px)`, transition: { duration: duration.fast, ease: easeStandard } }}
      transition={reduce ? { duration: duration.instant } : { duration: duration.standard, ease: easeEnter }}>{text}</motion.span>
  </AnimatePresence></span>;
}

/** A compact role picker. The trigger never scales, since it anchors the menu; its label morphs and the width follows on a spring. */
function RoleSelect({ label, value, onChange, field = false, disabled }: { label: string; value: Role; onChange: (role: Role) => void; field?: boolean; disabled?: boolean }) {
  return <SelectPrimitive.Root value={value} onValueChange={next => onChange(next as Role)} disabled={disabled}>
    <SelectPrimitive.Trigger className={[styles.roleTrigger, field ? styles.roleField : ""].filter(Boolean).join(" ")} aria-label={label}>
      <span className={styles.srOnly}><SelectPrimitive.Value /></span>
      <span aria-hidden="true"><TextMorph>{roleNames[value]}</TextMorph></span>
      <SelectPrimitive.Icon className={styles.roleChevron}><ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" /></SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content className={styles.roleMenu} position="popper" align="end" sideOffset={6} collisionPadding={12}>
        <SelectPrimitive.Viewport>
          {roleOptions.map(option => <SelectPrimitive.Item key={option.value} value={option.value} className={styles.roleItem}>
            <span className={styles.roleItemText}><SelectPrimitive.ItemText>{roleNames[option.value]}</SelectPrimitive.ItemText><span className={styles.roleHint}>{option.hint}</span></span>
            <SelectPrimitive.ItemIndicator className={styles.roleCheck}><Check size={16} strokeWidth={2} aria-hidden="true" /></SelectPrimitive.ItemIndicator>
          </SelectPrimitive.Item>)}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  </SelectPrimitive.Root>;
}

export function TeamMembers() {
  const id = useId();
  const reduce = useReducedMotion();
  const [members, setMembers] = useState(initialMembers);
  const [invites, setInvites] = useState(initialInvites);
  const [chips, setChips] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("member");
  const [sending, setSending] = useState(false);
  const [exitMode, setExitMode] = useState<"removed" | "sent">("removed");
  const [arriving, setArriving] = useState<string[]>([]);
  const [resending, setResending] = useState<Record<string, "sending" | "sent">>({});
  const [query, setQuery] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [status, setStatus] = useState("Changes apply right away");
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const removeRefs = useRef(new Map<string, HTMLButtonElement>());
  const revokeRefs = useRef(new Map<string, HTMLButtonElement>());
  const serial = useRef(0);
  const timers = useRef<number[]>([]);
  const [fieldRef, fieldHeight] = useMeasuredHeight<HTMLDivElement>();
  const [messageRef, messageHeight] = useMeasuredHeight<HTMLDivElement>();

  useEffect(() => { const pending = timers.current; return () => pending.forEach(window.clearTimeout); }, []);
  useEffect(() => { if (confirmId) requestAnimationFrame(() => cancelRef.current?.focus({ preventScroll: true })); }, [confirmId]);

  const used = members.length + invites.length;
  const seatsLeft = Math.max(0, SEATS - used);
  const over = chips.length - seatsLeft;
  const needle = query.trim().toLowerCase();
  const shownMembers = members.filter(member => !needle || member.name.toLowerCase().includes(needle) || member.email.includes(needle));
  const shownInvites = invites.filter(invite => !needle || invite.email.includes(needle));
  const inviteCount = chips.length + (EMAIL.test(draft.trim().toLowerCase()) ? 1 : 0);
  const message: { tone: Tone; text: string } = error ? { tone: "error", text: error }
    : over > 0 ? { tone: "warning", text: seatsLeft === 0 ? `All ${SEATS} seats are taken. Remove someone or revoke an invite first` : `${seatsLeft} ${seatsLeft === 1 ? "seat" : "seats"} left. Remove ${over} ${over === 1 ? "address" : "addresses"} to send` }
    : seatsLeft === 0 ? { tone: "warning", text: `All ${SEATS} seats are taken` }
    : { tone: "hint", text: "Separate addresses with commas or press Enter. Invites expire in 7 days" };

  function later(run: () => void, ms: number) { timers.current.push(window.setTimeout(run, ms)); }
  function focusLater(node: HTMLElement | null | undefined) { requestAnimationFrame(() => { if (node?.isConnected) node.focus({ preventScroll: true }); }); }

  /** Turns typed or pasted text into chips. Valid addresses become chips, anything unfinished stays in the field with a reason. */
  function commit(raw: string) {
    const next = [...chips];
    const rest: string[] = [];
    let problem = "";
    for (const token of raw.split(/[\s,;]+/)) {
      const email = token.replace(/^<|>$/g, "").toLowerCase();
      if (!email) continue;
      const member = members.find(item => item.email === email);
      if (!EMAIL.test(email)) { rest.push(token); problem ||= `“${token}” is not a complete email address`; }
      else if (member) problem ||= `${member.name} is already a member`;
      else if (invites.some(item => item.email === email)) problem ||= `${email} already has a pending invite`;
      else if (!next.includes(email)) next.push(email);
    }
    setChips(next);
    setDraft(rest.join(", "));
    setError(problem);
    return { next, problem };
  }

  function removeChip(email: string) {
    setExitMode("removed");
    setChips(current => current.filter(item => item !== email));
    setError("");
    setStatus(`Removed ${email} from the invite`);
  }

  function send() {
    if (sending) return;
    const { next, problem } = draft.trim() ? commit(draft) : { next: chips, problem: "" };
    if (problem) return;
    if (!next.length) { setError("Add at least one email address"); inputRef.current?.focus(); return; }
    if (next.length > seatsLeft) return;
    const role = inviteRole;
    setSending(true);
    setError("");
    setQuery("");
    setConfirmId(null);
    // Simulated delivery. Swap this timer for your invitations endpoint.
    later(() => {
      const created = next.map(email => ({ id: `sent-${++serial.current}`, email, role, sent: "Invited just now" }));
      setExitMode("sent");
      setChips([]);
      setInvites(current => [...current, ...created]);
      setArriving(created.map(invite => invite.id));
      setSending(false);
      setStatus(created.length === 1 ? `Invited ${created[0].email} as ${withArticle(role)}` : `Invited ${created.length} people as ${role === "admin" ? "admins" : `${role}s`}`);
      inputRef.current?.focus({ preventScroll: true });
      later(() => setArriving([]), 1400);
    }, 700);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") { event.preventDefault(); if (draft.trim()) commit(draft); else if (chips.length) send(); return; }
    if ((event.key === "," || event.key === ";" || event.key === " ") && draft.trim()) { event.preventDefault(); commit(draft); return; }
    if (event.key === "Backspace" && !draft && chips.length && !sending) { event.preventDefault(); removeChip(chips[chips.length - 1]); }
  }

  function onPaste(event: ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData("text");
    if (!/[\s,;]/.test(text.trim())) return;
    event.preventDefault();
    commit(`${draft} ${text}`);
  }

  function changeRole(member: Member, role: Role) {
    setMembers(current => current.map(item => item.id === member.id ? { ...item, role } : item));
    setStatus(`${member.name} is now ${withArticle(role)}`);
  }

  function cancel(memberId: string) {
    setConfirmId(null);
    requestAnimationFrame(() => focusLater(removeRefs.current.get(memberId)));
  }

  function removeMember(member: Member) {
    const removable = shownMembers.filter(item => !item.you);
    const index = removable.findIndex(item => item.id === member.id);
    const next = removable[index + 1] ?? removable[index - 1];
    setMembers(current => current.filter(item => item.id !== member.id));
    setConfirmId(null);
    setStatus(`${member.name} was removed from ${WORKSPACE}`);
    focusLater(next ? removeRefs.current.get(next.id) : searchRef.current);
  }

  function resend(invite: Invite) {
    if (resending[invite.id]) return;
    setResending(current => ({ ...current, [invite.id]: "sending" }));
    later(() => {
      setResending(current => ({ ...current, [invite.id]: "sent" }));
      setInvites(current => current.map(item => item.id === invite.id ? { ...item, sent: "Resent just now" } : item));
      setStatus(`Invite resent to ${invite.email}`);
      later(() => setResending(current => { const next = { ...current }; delete next[invite.id]; return next; }), 1800);
    }, 600);
  }

  function revoke(invite: Invite) {
    const index = shownInvites.findIndex(item => item.id === invite.id);
    const next = shownInvites[index + 1] ?? shownInvites[index - 1];
    setInvites(current => current.filter(item => item.id !== invite.id));
    setStatus(`Invite to ${invite.email} revoked`);
    focusLater(next ? revokeRefs.current.get(next.id) : inputRef.current);
  }

  const swapIn = reduce ? { opacity: 0 } : { opacity: 0, y: 6, filter: `blur(${blur.soft}px)` };
  const swapOut = reduce ? { opacity: 0, transition: instant } : { opacity: 0, y: -4, filter: `blur(${blur.soft}px)`, transition: { duration: duration.exit, ease: easeStandard } };
  const swapTransition = reduce ? instant : { ...spring.smooth, opacity: { duration: duration.standard, ease: easeEnter }, filter: { duration: duration.standard, ease: easeEnter } };

  return (
    <MotionConfig reducedMotion="user">
      <LayoutGroup id={id}>
        <section className={styles.block} aria-labelledby={`${id}-title`}>
          <header className={styles.header}>
            <div className={styles.heading}>
              <h2 id={`${id}-title`}>Members</h2>
              <p>Manage who can work in the {WORKSPACE} workspace.</p>
            </div>
            <div className={styles.seats} data-full={seatsLeft === 0 || undefined}>
              <p className={styles.seatText}><span className={styles.number}><AnimatedCounter value={used} /></span> of {SEATS} seats</p>
              <div className={styles.seatTrack} role="meter" aria-label="Seats used" aria-valuemin={0} aria-valuemax={SEATS} aria-valuenow={used} aria-valuetext={`${used} of ${SEATS} seats used`}>
                <motion.span className={styles.seatFill} initial={false} animate={{ width: `${Math.min(used / SEATS, 1) * 100}%` }} transition={reduce ? instant : spring.morph} />
              </div>
            </div>
          </header>

          <form className={styles.invite} noValidate onSubmit={event => { event.preventDefault(); send(); }}>
            <label className={styles.inviteLabel} htmlFor={`${id}-invite`}>Invite people</label>
            <div className={styles.inviteRow}>
              <motion.div className={styles.field} data-invalid={error ? "" : undefined} initial={false} animate={{ height: fieldHeight === "auto" ? "auto" : fieldHeight + 2 }} transition={reduce ? instant : spring.smooth}
                onPointerDown={event => { if (!(event.target as HTMLElement).closest("button, input")) { event.preventDefault(); inputRef.current?.focus(); } }}>
                <div ref={fieldRef} className={styles.fieldInner}>
                  <AnimatePresence mode="popLayout" initial={false} custom={exitMode}>
                    {chips.map(email => (
                      <motion.span key={email} layoutId={`invite-${email}`} className={styles.chip} custom={exitMode} variants={chipVariants} initial="enter" animate="rest" exit="exit" transition={reduce ? instant : chipTransition}>
                        <span className={styles.chipText}>{email}</span>
                        <button type="button" className={styles.chipRemove} aria-label={`Remove ${email}`} disabled={sending} onClick={() => { removeChip(email); inputRef.current?.focus(); }}><X size={12} strokeWidth={2} aria-hidden="true" /></button>
                      </motion.span>
                    ))}
                  </AnimatePresence>
                  <motion.input layout="position" transition={reduce ? instant : { layout: spring.morph }} ref={inputRef} id={`${id}-invite`} className={styles.draft} type="text" inputMode="email" autoComplete="off" autoCapitalize="off" spellCheck={false}
                    placeholder={chips.length ? "" : "name@example.com"} value={draft} readOnly={sending} aria-invalid={error ? true : undefined} aria-describedby={`${id}-message`}
                    onChange={event => { setDraft(event.target.value); if (error) setError(""); }} onKeyDown={onKeyDown} onPaste={onPaste}
                    onBlur={() => { if (!sending && EMAIL.test(draft.trim().toLowerCase())) commit(draft); }} />
                </div>
              </motion.div>
              <div className={styles.inviteActions}>
                <RoleSelect field label="Invite as" value={inviteRole} onChange={setInviteRole} disabled={sending} />
                <Button type="submit" size="sm" loading={sending} disabled={!sending && ((!chips.length && !draft.trim()) || over > 0)}>{inviteCount > 1 ? `Send ${inviteCount} invites` : "Send invite"}</Button>
              </div>
            </div>
            <motion.div className={styles.messageSlot} initial={false} animate={{ height: messageHeight }} transition={reduce ? instant : spring.smooth}>
              <div ref={messageRef} id={`${id}-message`} className={styles.messageInner} aria-live="polite">
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.p key={message.text} className={styles.message} data-tone={message.tone} initial={swapIn} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={swapOut} transition={reduce ? instant : { duration: duration.standard, ease: easeEnter }}>
                    {message.tone !== "hint" && <AlertCircle size={14} strokeWidth={1.75} aria-hidden="true" />}<span>{message.text}</span>
                  </motion.p>
                </AnimatePresence>
              </div>
            </motion.div>
          </form>

          <div className={styles.lists}>
            <div className={styles.sectionHead}>
              <h3 id={`${id}-members`} className={styles.sectionTitle}>Members <span className={styles.count}><AnimatedCounter value={shownMembers.length} /></span></h3>
              <div className={styles.search}><SearchField ref={searchRef} label="Search people" placeholder="Search by name or email" value={query} onValueChange={value => { setQuery(value); setConfirmId(null); }} /></div>
            </div>
            <ul className={styles.list} aria-labelledby={`${id}-members`}>
              <AnimatePresence initial={false}>
                {shownMembers.map(member => {
                  const confirming = confirmId === member.id;
                  return <Row key={member.id} className={styles.row} confirming={confirming}>
                    <div className={styles.rowInner}>
                      <Avatar name={member.name} src={member.photo} status={member.online ? "online" : undefined} />
                      <div className={styles.rowBody} onKeyDown={event => { if (event.key === "Escape" && confirming) { event.stopPropagation(); cancel(member.id); } }}>
                        <AnimatePresence mode="popLayout" initial={false}>
                          {confirming ? (
                            <motion.div key="confirm" className={styles.confirm} initial={swapIn} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={swapOut} transition={swapTransition}>
                              <div className={styles.identity}><span className={styles.name}>Remove {member.name}?</span><span className={styles.detail}>They lose access to {WORKSPACE} right away</span></div>
                              <div className={styles.confirmActions}>
                                <Button ref={cancelRef} type="button" variant="secondary" size="sm" onClick={() => cancel(member.id)}>Cancel</Button>
                                <Button type="button" variant="danger" size="sm" onClick={() => removeMember(member)}>Remove</Button>
                              </div>
                            </motion.div>
                          ) : (
                            <motion.div key="view" className={styles.view} initial={swapIn} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={swapOut} transition={swapTransition}>
                              <div className={styles.identity}>
                                <span className={styles.name}>{member.name}{member.you && <span className={styles.you}>You</span>}</span>
                                <span className={styles.detail}>{member.email}</span>
                                <span className={`${styles.detail} ${styles.activeInline}`}>{member.active}</span>
                              </div>
                              <span className={styles.active}>{member.active}</span>
                              {member.role === "owner" ? <span className={styles.owner}>Owner</span> : <RoleSelect label={`Role for ${member.name}`} value={member.role} onChange={role => changeRole(member, role)} />}
                              {member.you ? <span className={styles.spacer} aria-hidden="true" /> : <Button ref={node => { if (node) removeRefs.current.set(member.id, node); }} type="button" variant="ghost" size="sm" className={styles.iconButton} aria-label={`Remove ${member.name}`} onClick={() => setConfirmId(member.id)}><UserMinus size={16} strokeWidth={1.75} aria-hidden="true" /></Button>}
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    </div>
                  </Row>;
                })}
                {shownMembers.length === 0 && <Row key="members-empty" className={styles.emptyRow}>
                  <div className={styles.empty}><p>No members match “{query.trim()}”</p><Button type="button" variant="secondary" size="sm" onClick={() => { setQuery(""); searchRef.current?.focus(); }}>Clear search</Button></div>
                </Row>}
              </AnimatePresence>
            </ul>

            <div className={styles.sectionHead}>
              <h3 id={`${id}-pending`} className={styles.sectionTitle}>Pending invites <span className={styles.count}><AnimatedCounter value={shownInvites.length} /></span></h3>
            </div>
            <ul className={styles.list} aria-labelledby={`${id}-pending`}>
              <AnimatePresence initial={false}>
                {shownInvites.map(invite => {
                  const order = arriving.indexOf(invite.id);
                  const landing = order >= 0;
                  const state = resending[invite.id];
                  const settle = reduce ? instant : { duration: duration.standard, ease: easeEnter, delay: .24 + Math.max(order, 0) * motionTokens.stagger.line };
                  return <Row key={invite.id} className={styles.row} fade={!landing} open={landing}>
                    <div className={styles.rowInner}>
                      <motion.span className={styles.pendingAvatar} aria-hidden="true" initial={landing ? { opacity: 0, scale: .6 } : false} animate={{ opacity: 1, scale: 1 }} transition={reduce ? instant : { ...spring.snappy, delay: .2 + Math.max(order, 0) * motionTokens.stagger.line }}>{initialsOf(invite.email)}</motion.span>
                      <div className={styles.pendingBody}>
                        <div className={styles.identity}>
                          {/* Shares its layout id with the chip it was typed as, so a sent address travels from the invite field into this row. */}
                          <motion.span layoutId={`invite-${invite.email}`} layout="position" layoutCrossfade={false} className={[styles.inviteEmail, landing ? styles.landing : ""].filter(Boolean).join(" ")}
                            transition={reduce ? instant : { layout: { ...spring.morph, visualDuration: .5 + Math.max(order, 0) * .06 } }}>{invite.email}</motion.span>
                          <motion.span className={styles.detail} initial={landing ? { opacity: 0 } : false} animate={{ opacity: 1 }} transition={settle}>
                            <span className={styles.srOnly}>{roleNames[invite.role]}, {invite.sent}</span><Swap text={`${roleNames[invite.role]} · ${invite.sent}`} />
                          </motion.span>
                        </div>
                        <motion.div className={styles.pendingActions} initial={landing ? { opacity: 0, y: 4 } : false} animate={{ opacity: 1, y: 0 }} transition={settle}>
                          <Button type="button" variant="ghost" size="sm" loading={state === "sending"} aria-label={state === "sent" ? `Sent, invite to ${invite.email} resent` : `Resend invite to ${invite.email}`} onClick={() => resend(invite)}>{state === "sent" ? <><Check size={15} strokeWidth={2} aria-hidden="true" /> Sent</> : "Resend"}</Button>
                          <Button ref={node => { if (node) revokeRefs.current.set(invite.id, node); }} type="button" variant="ghost" size="sm" aria-label={`Revoke invite to ${invite.email}`} onClick={() => revoke(invite)}>Revoke</Button>
                        </motion.div>
                      </div>
                    </div>
                  </Row>;
                })}
                {shownInvites.length === 0 && <Row key="invites-empty" className={styles.emptyRow}><p className={styles.emptyLine}>{needle && invites.length ? "No invites match your search" : "No pending invites"}</p></Row>}
              </AnimatePresence>
            </ul>
          </div>

          <footer className={styles.footer}>
            <p className={styles.srOnly} role="status" aria-live="polite">{status}</p>
            <span className={styles.status}><Swap text={status} /></span>
          </footer>
        </section>
      </LayoutGroup>
    </MotionConfig>
  );
}

export default TeamMembers;
