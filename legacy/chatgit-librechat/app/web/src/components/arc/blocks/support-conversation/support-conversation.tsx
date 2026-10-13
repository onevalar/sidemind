"use client";

import { type ChangeEvent, useEffect, useId, useRef, useState, type ReactNode } from "react";
import Image from "next/image";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowUp, Check, FileText, Paperclip, RotateCcw, Settings2 } from "lucide-react";
import { avatar } from "../../lib/media";
import { motionTokens } from "../../lib/motion-tokens";
import styles from "./support-conversation.module.css";

type Attachment = { name: string; size: string };
type Message = { id: number; sender: "agent" | "you"; text: string; time: string; status?: "sent" | "read"; attachment?: Attachment };

const initialMessages: Message[] = [
  { id: 1, sender: "you", text: "The charts in my PDF export look small. Is there a way to make them larger?", time: "10:42", status: "read" },
  { id: 2, sender: "agent", text: "Yes, the Presentation page size gives charts more room. I can walk you through it.", time: "10:43" },
  { id: 3, sender: "you", text: "That would be great. I need to send this report to the board today.", time: "10:44", status: "read" },
];
const agentPhoto = avatar("ava-mitchell");
const suggestions = ["Show me the steps", "Do links stay clickable?"];
function formatTime(date = new Date()) { return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function replyFor(text: string) {
  const value = text.toLowerCase();
  if (value.includes("link")) return "Yes. Links in text and chart annotations stay clickable. Turn on Include links before downloading.";
  if (value.includes("thank") || value.includes("worked")) return "Happy to help. I’ll keep this thread open in case the board report needs another pass.";
  if (value.includes("file") || value.includes("attach")) return "Thanks for sending that over. I can see the report and the export settings look ready for a wider layout.";
  return "Open Export, choose PDF, then set Page size to Presentation. Your charts will use the wider layout automatically.";
}

/** Cross-fade for content that swaps inside the composer slot. */
function fade(reduce: boolean) {
  return { initial: { opacity: 0 }, animate: { opacity: 1, transition: { duration: reduce ? 0 : motionTokens.duration.standard, ease: motionTokens.ease.enter } }, exit: { opacity: 0, transition: { duration: reduce ? 0 : motionTokens.duration.fast, ease: motionTokens.ease.standard } } };
}
/** Animates its own height to follow its content, so swapping the composer for the resolved notice never snaps. */
function AutoHeight({ children, className, reduce }: { children: ReactNode; className?: string; reduce: boolean }) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | "auto">("auto");
  useEffect(() => {
    const node = innerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setHeight(entry.borderBoxSize?.[0]?.blockSize ?? node.offsetHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <motion.div className={styles.autoHeight} initial={false} animate={{ height }} transition={reduce ? { duration: 0 } : motionTokens.spring.smooth}><div ref={innerRef} className={className}>{children}</div></motion.div>;
}

export interface SupportConversationProps { onSend?: (message: string) => void; onResolve?: (resolved: boolean) => void }

export function SupportConversation({ onSend, onResolve }: SupportConversationProps) {
  const reduce = useReducedMotion();
  const inputId = useId();
  const [messages, setMessages] = useState(initialMessages);
  const [draft, setDraft] = useState("");
  const [typing, setTyping] = useState(false);
  const [resolved, setResolved] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const threadRef = useRef<HTMLDivElement>(null);
  const hasMountedRef = useRef(false);
  const pendingRef = useRef(0);
  const timersRef = useRef<number[]>([]);
  const nextId = useRef(4);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    if (!hasMountedRef.current) { hasMountedRef.current = true; return; }
    thread.scrollTo({ top: thread.scrollHeight, behavior: reduce ? "instant" : "smooth" });
  }, [messages, typing, reduce]);
  useEffect(() => () => timersRef.current.forEach(window.clearTimeout), []);

  function scheduleReply(text: string) {
    pendingRef.current += 1;
    setTyping(true);
    const timer = window.setTimeout(() => {
      setMessages((current) => [...current, { id: nextId.current++, sender: "agent", text: replyFor(text), time: formatTime() }]);
      pendingRef.current -= 1;
      setTyping(pendingRef.current > 0);
      setAnnouncement("Ava replied.");
      timersRef.current = timersRef.current.filter((item) => item !== timer);
    }, reduce ? 240 : 1050);
    timersRef.current.push(timer);
  }

  function send(value: string, attachment?: Attachment) {
    const text = value.trim();
    if ((!text && !attachment) || resolved) return;
    setMessages((current) => [...current, { id: nextId.current++, sender: "you", text: text || "I’ve attached the report for context.", time: formatTime(), status: "sent", attachment }]);
    setDraft("");
    setAnnouncement(attachment ? `${attachment.name} attached. Ava is replying.` : "Message sent. Ava is replying.");
    onSend?.(text || attachment?.name || "Attachment sent");
    scheduleReply(text || "I attached a file");
  }

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    send("", { name: file.name, size: `${Math.max(1, Math.round(file.size / 1024))} KB` });
    event.target.value = "";
  }
  function toggleResolved() {
    const next = !resolved;
    if (next) { timersRef.current.forEach(window.clearTimeout); timersRef.current = []; pendingRef.current = 0; setTyping(false); }
    setResolved(next);
    setAnnouncement(next ? "Conversation marked resolved." : "Conversation reopened.");
    onResolve?.(next);
  }

  return <section className={styles.surface} aria-label="Support conversation">
    <header className={styles.header}>
      <Image className={styles.headerPortrait} src={agentPhoto} width={32} height={32} alt="" />
      <div className={styles.headerText}><h2>Exporting charts</h2><span>Ava from support · Usually replies in 5 min</span></div>
      <button className={`${styles.resolve} ${resolved ? styles.resolved : ""}`} type="button" onClick={toggleResolved}>{resolved ? <RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" /> : <Check size={14} strokeWidth={1.75} aria-hidden="true" />}{resolved ? "Reopen" : "Resolve"}</button>
    </header>
    <div className={styles.thread} ref={threadRef}>
      <div className={styles.dateDivider}><span>Today</span></div>
      <AnimatePresence initial={false}>{messages.map((message) => <motion.div key={message.id} className={`${styles.messageRow} ${message.sender === "you" ? styles.yours : styles.theirs}`} initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={reduce ? { duration: 0 } : motionTokens.spring.gentle}>
        {message.sender === "agent" && <Image className={styles.portrait} src={agentPhoto} width={28} height={28} alt="Ava" />}
        <div className={styles.messageBody}><div className={styles.messageMeta}><strong>{message.sender === "agent" ? "Ava" : "You"}</strong><span>{message.time}</span></div><p>{message.text}</p>
          {message.attachment && <div className={styles.attachment}><FileText size={16} strokeWidth={1.75} aria-hidden="true" /><span><strong>{message.attachment.name}</strong><small>{message.attachment.size} · PDF</small></span></div>}
          {message.sender === "agent" && message.id === 2 && <button className={styles.contextAction} type="button" onClick={() => setShowSettings((value) => !value)}><Settings2 size={14} strokeWidth={1.75} aria-hidden="true" />{showSettings ? "Hide export settings" : "View export settings"}</button>}
          {message.sender === "agent" && message.id === 2 && <AnimatePresence initial={false}>{showSettings && <motion.div key="settings" className={styles.settingsWrap} initial={reduce ? false : { opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={reduce ? { duration: 0 } : motionTokens.spring.smooth}><div className={styles.settings}><div><strong>PDF export settings</strong><span>Page size · Presentation</span></div><div><strong>Include links</strong><span>On</span></div></div></motion.div>}</AnimatePresence>}
          {message.sender === "you" && message.status && <span className={styles.delivery}>{message.status === "read" ? "Read" : "Sent"} · {message.time}</span>}
        </div>
      </motion.div>)}</AnimatePresence>
      {typing && !resolved && <motion.div className={`${styles.messageRow} ${styles.theirs}`} initial={reduce ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={reduce ? { duration: 0 } : motionTokens.spring.responsive}><Image className={styles.portrait} src={agentPhoto} width={28} height={28} alt="" /><div className={styles.typing} aria-label="Ava is typing"><span /><span /><span /><span className={styles.srOnly}>Ava is typing</span></div></motion.div>}
    </div>
    <AutoHeight className={styles.composeArea} reduce={!!reduce}><AnimatePresence mode="popLayout" initial={false}>{resolved ? <motion.div key="resolved" className={styles.resolvedNotice} {...fade(!!reduce)}><Check size={16} strokeWidth={1.75} aria-hidden="true" /><span>Conversation resolved. Reopen it to ask another question.</span></motion.div> : <motion.div key="compose" {...fade(!!reduce)}>
      <div className={styles.suggestions}>{suggestions.map((suggestion) => <button key={suggestion} type="button" onClick={() => send(suggestion)}>{suggestion}</button>)}</div>
      <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); send(draft); }}><label className={styles.srOnly} htmlFor={inputId}>Write a message</label><input id={inputId} type="text" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Write a reply" /><input ref={fileInputRef} className={styles.srOnly} type="file" accept="application/pdf,.pdf" onChange={handleFile} aria-label="Attach a PDF" /><button className={styles.attach} type="button" onClick={() => fileInputRef.current?.click()} aria-label="Attach a PDF"><Paperclip size={16} strokeWidth={1.75} aria-hidden="true" /></button><button className={styles.send} type="submit" disabled={!draft.trim()} aria-label="Send message"><ArrowUp size={16} strokeWidth={2} aria-hidden="true" /></button></form>
    </motion.div>}</AnimatePresence></AutoHeight><span className={styles.srOnly} role="status" aria-live="polite">{announcement}</span>
  </section>;
}

export default SupportConversation;
