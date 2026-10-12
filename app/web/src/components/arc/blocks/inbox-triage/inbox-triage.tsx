"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Archive, Clock3, RotateCcw } from "lucide-react";
import { Avatar } from "../../avatar/avatar";
import { Button } from "../../button/button";
import { avatar } from "../../lib/media";
import { motionTokens } from "../../lib/motion-tokens";
import styles from "./inbox-triage.module.css";

type Folder = "inbox" | "snoozed" | "archive";
type Message = { id: string; name: string; photo: string; subject: string; preview: string; body: string; time: string; folder: Folder; unread: boolean };
type Move = { id: string; subject: string; from: Folder; to: Folder; unread: boolean };

const initialMessages: Message[] = [
  { id: "emma", name: "Emma Collins", photo: avatar("emma-collins"), subject: "The latest prototype is ready", preview: "I tightened the handoff flow and left a few notes for review.", body: "I tightened the handoff flow and added notes around the empty states. The prototype is ready for a second look when you have a moment.", time: "9:42 AM", folder: "inbox", unread: true },
  { id: "marcus", name: "Marcus Johnson", photo: avatar("marcus-johnson"), subject: "Component review for Thursday", preview: "Could we look at the table and menu states together?", body: "Could we look at the table and menu states together on Thursday? I have two small interaction questions and a short list of things that are already in good shape.", time: "8:18 AM", folder: "inbox", unread: true },
  { id: "ava", name: "Ava Mitchell", photo: avatar("ava-mitchell"), subject: "Notes from the design review", preview: "The team aligned on the next pass for onboarding.", body: "The team aligned on the next pass for onboarding. I pulled the decisions into one note so the next iteration has a clear starting point.", time: "Yesterday", folder: "inbox", unread: false },
  { id: "jasmine", name: "Jasmine Brooks", photo: avatar("jasmine-brooks"), subject: "Preview environment is ready", preview: "The new preview is up with the interaction fixes.", body: "The new preview is up with the interaction fixes. You can check the keyboard path and responsive states whenever you are ready.", time: "Yesterday", folder: "inbox", unread: false },
  { id: "daniel", name: "Daniel Kim", photo: avatar("daniel-kim"), subject: "Webhook retries are live", preview: "Failed deliveries now retry five times over an hour.", body: "Failed deliveries now retry five times over an hour, with the attempt log on each event. Nothing to do on your side unless you want a longer window.", time: "Tue", folder: "inbox", unread: false },
  { id: "sofia", name: "Sofia Ramirez", photo: avatar("sofia-ramirez"), subject: "A time for our next check-in", preview: "Moving this to next week so we can review the final pass.", body: "Moving this to next week so we can review the final pass together. I will share a short agenda before we meet.", time: "Mon", folder: "snoozed", unread: false },
];

const folders: { value: Folder; label: string }[] = [{ value: "inbox", label: "Inbox" }, { value: "snoozed", label: "Snoozed" }, { value: "archive", label: "Archive" }];
const pastTense: Record<Folder, string> = { inbox: "Moved to Inbox", snoozed: "Snoozed", archive: "Archived" };

export function InboxTriage() {
  const id = useId();
  const reduce = !!useReducedMotion();
  const [messages, setMessages] = useState(initialMessages);
  const [folder, setFolder] = useState<Folder>("inbox");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [lastMove, setLastMove] = useState<Move | null>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const titleRef = useRef<HTMLHeadingElement>(null);
  const focusNext = useRef<string | null>(null);

  const visible = messages.filter((message) => message.folder === folder && (folder !== "inbox" || !unreadOnly || message.unread));
  const unreadCount = messages.filter((message) => message.folder === "inbox" && message.unread).length;
  const countOf = (value: Folder) => messages.filter((message) => message.folder === value).length;
  const rowTransition = reduce ? { duration: 0 } : motionTokens.spring.smooth;

  // Focus follows the list: after a row leaves, the next one takes focus so triage can continue from the keyboard.
  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    if (target === "title") titleRef.current?.focus();
    else triggers.current.get(target)?.focus();
  });

  function move(message: Message, to: Folder) {
    const index = visible.findIndex((item) => item.id === message.id);
    const neighbour = visible[index + 1] ?? visible[index - 1];
    setMessages((current) => current.map((item) => item.id === message.id ? { ...item, folder: to, unread: to === "inbox" ? item.unread : false } : item));
    setLastMove({ id: message.id, subject: message.subject, from: message.folder, to, unread: message.unread });
    setOpenId(null);
    focusNext.current = neighbour ? neighbour.id : "title";
  }

  function undo() {
    if (!lastMove) return;
    setMessages((current) => current.map((item) => item.id === lastMove.id ? { ...item, folder: lastMove.from, unread: lastMove.unread } : item));
    if (lastMove.from !== folder) setFolder(lastMove.from);
    setLastMove(null);
    focusNext.current = lastMove.id;
  }

  function chooseFolder(value: Folder) {
    setFolder(value);
    setOpenId(null);
  }

  function toggleMessage(message: Message) {
    if (openId === message.id) { setOpenId(null); return; }
    setOpenId(message.id);
    // Opening a message reads it.
    if (message.unread) setMessages((current) => current.map((item) => item.id === message.id ? { ...item, unread: false } : item));
  }

  function onRowKey(event: KeyboardEvent<HTMLButtonElement>, message: Message) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "arrowdown" || key === "arrowup") {
      event.preventDefault();
      const index = visible.findIndex((item) => item.id === message.id);
      const next = visible[index + (key === "arrowdown" ? 1 : -1)];
      if (next) triggers.current.get(next.id)?.focus();
    } else if (key === "e" && folder !== "archive") { event.preventDefault(); move(message, "archive"); }
    else if (key === "s" && folder === "inbox") { event.preventDefault(); move(message, "snoozed"); }
    else if (key === "u" && folder !== "inbox") { event.preventDefault(); move(message, "inbox"); }
  }

  function onTabKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const index = folders.findIndex((item) => item.value === folder);
    const next = folders[(index + (event.key === "ArrowRight" ? 1 : folders.length - 1)) % folders.length];
    chooseFolder(next.value);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-folder="${next.value}"]`)?.focus();
  }

  const archiveAction = { key: "archive", label: "Archive", shortcut: "E", icon: Archive, to: "archive" as Folder };
  const actions = folder === "inbox"
    ? [{ key: "snooze", label: "Snooze", shortcut: "S", icon: Clock3, to: "snoozed" as Folder }, archiveAction]
    : [{ key: "restore", label: "Move to Inbox", shortcut: "U", icon: RotateCcw, to: "inbox" as Folder }, ...(folder === "snoozed" ? [archiveAction] : [])];

  const emptyCopy = folder === "inbox" && unreadOnly ? { title: "Nothing unread", body: "You are caught up.", action: "Show all" }
    : folder === "inbox" ? { title: "Inbox zero", body: "Archived messages stay searchable.", action: "View archive" }
    : folder === "snoozed" ? { title: "Nothing snoozed", body: "Snoozed messages wait here until you bring them back.", action: "Back to inbox" }
    : { title: "Archive is empty", body: "Messages you archive land here.", action: "Back to inbox" };

  function emptyAction() {
    if (folder === "inbox" && unreadOnly) setUnreadOnly(false);
    else chooseFolder(folder === "inbox" ? "archive" : "inbox");
  }

  return (
    <section className={styles.triage} aria-labelledby={`${id}-title`}>
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h2 id={`${id}-title`} ref={titleRef} tabIndex={-1}>Messages</h2>
          <span className={styles.unreadCount}>{unreadCount} unread</span>
          <button type="button" className={styles.filter} aria-pressed={unreadOnly} disabled={folder !== "inbox"} onClick={() => { setUnreadOnly((value) => !value); setOpenId(null); }}>
            <span className={styles.filterDot} aria-hidden="true" />Unread only
          </button>
        </div>
        <div className={styles.tabs} role="tablist" aria-label="Folders" onKeyDown={onTabKey}>
          {folders.map((item) => {
            const selected = item.value === folder;
            const count = countOf(item.value);
            return (
              <button key={item.value} type="button" role="tab" data-folder={item.value} aria-selected={selected} aria-controls={`${id}-list`} tabIndex={selected ? 0 : -1} className={styles.tab} onClick={() => chooseFolder(item.value)}>
                {item.label}
                <span className={styles.tabCount}>{count}</span>
                {selected && <motion.span layoutId={`${id}-tab`} className={styles.tabIndicator} transition={reduce ? { duration: 0 } : motionTokens.spring.snappy} />}
              </button>
            );
          })}
        </div>
      </header>

      <div id={`${id}-list`} className={styles.list} role="tabpanel" aria-label={`${folders.find((item) => item.value === folder)?.label} messages`}>
        <motion.div key={folder} className={styles.panel} initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduce ? 0 : motionTokens.duration.fast }}>
          <AnimatePresence initial={false}>
            {visible.map((message) => {
              const open = openId === message.id;
              return (
                <motion.article key={message.id} className={`${styles.message} ${message.unread ? styles.unread : ""} ${open ? styles.open : ""}`}
                  initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { height: 0, opacity: 0 }} transition={rowTransition}>
                  <div className={styles.row}>
                    <button ref={(node) => { if (node) triggers.current.set(message.id, node); else triggers.current.delete(message.id); }} className={styles.trigger} type="button"
                      aria-expanded={open} aria-controls={open ? `${id}-${message.id}-detail` : undefined} aria-keyshortcuts={folder === "inbox" ? "E S" : folder === "snoozed" ? "U E" : "U"}
                      onClick={() => toggleMessage(message)} onKeyDown={(event) => onRowKey(event, message)}>
                      <span className={styles.dot} aria-hidden="true" />
                      <Avatar name={message.name} src={message.photo} size="sm" className={styles.avatar} />
                      <span className={styles.sender}>{message.name}{message.unread && <span className={styles.srOnly}>, unread</span>}</span>
                      <span className={styles.summary}><span className={styles.subject}>{message.subject}</span><span className={styles.preview}>{message.preview}</span></span>
                      <time className={styles.time}>{message.time}</time>
                    </button>
                    <span className={styles.quick}>
                      {actions.map((action) => (
                        <button key={action.key} type="button" className={styles.quickButton} aria-label={`${action.label}: ${message.subject}`} title={`${action.label} (${action.shortcut})`} tabIndex={-1} onClick={() => move(message, action.to)}>
                          <action.icon size={16} strokeWidth={1.75} aria-hidden="true" />
                        </button>
                      ))}
                    </span>
                  </div>
                  <AnimatePresence initial={false}>
                    {open && (
                      <motion.div id={`${id}-${message.id}-detail`} className={styles.detail} initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { height: 0, opacity: 0 }} transition={rowTransition}>
                        <div className={styles.detailInner}>
                          <p>{message.body}</p>
                          <div className={styles.detailActions}>
                            {actions.map((action, index) => (
                              <Button key={action.key} type="button" variant={index === 0 ? "secondary" : "ghost"} size="sm" onClick={() => move(message, action.to)}>
                                <action.icon size={15} strokeWidth={1.75} aria-hidden="true" />{action.label}<kbd className={styles.kbd}>{action.shortcut}</kbd>
                              </Button>
                            ))}
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.article>
              );
            })}
          </AnimatePresence>
          <AnimatePresence initial={false}>
            {visible.length === 0 && (
              <motion.div key="empty" className={styles.empty} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: reduce ? 0 : motionTokens.duration.exit } }}
                transition={{ duration: reduce ? 0 : motionTokens.duration.standard, ease: motionTokens.ease.standard }}>
                <p>{emptyCopy.title}</p>
                <span>{emptyCopy.body}</span>
                <Button type="button" variant="secondary" size="sm" onClick={emptyAction}>{emptyCopy.action}</Button>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </div>

      <footer className={styles.footer}>
        <p role="status" aria-live="polite" className={styles.status}>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span key={lastMove ? `${lastMove.id}-${lastMove.to}` : "idle"} className={styles.statusText}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -6, transition: { duration: motionTokens.duration.fast } }} transition={reduce ? { duration: 0 } : motionTokens.spring.snappy}>
              {lastMove ? <>{pastTense[lastMove.to]} <span className={styles.statusSubject}>{lastMove.subject}</span></> : <><span className={styles.hint}>{actions.map((action) => <span key={action.key}><kbd className={styles.kbd}>{action.shortcut}</kbd>{action.label.toLowerCase()}</span>)}</span><span className={styles.hintNarrow}>Open a message to {folder === "inbox" ? "snooze or archive it" : "move it"}</span></>}
            </motion.span>
          </AnimatePresence>
        </p>
        <Button type="button" variant="ghost" size="sm" className={styles.undo} onClick={undo} disabled={!lastMove} aria-hidden={!lastMove} tabIndex={lastMove ? 0 : -1}>
          <RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />Undo
        </Button>
      </footer>
    </section>
  );
}

export default InboxTriage;
