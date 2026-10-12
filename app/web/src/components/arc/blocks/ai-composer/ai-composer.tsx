"use client";

import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion } from "motion/react";
import type { AnimationPlaybackControls, MotionValue } from "motion/react";
import { ArrowUp, FileSpreadsheet, FileText, Paperclip, RotateCcw, SquarePen, X } from "lucide-react";
import { motionTokens } from "../../lib/motion-tokens";
import { CopyButton } from "../../copy-button/copy-button";
import { TextShimmer } from "../../text-shimmer/text-shimmer";
import styles from "./ai-composer.module.css";

type Topic = "churn" | "mobile" | "release" | "checkout" | "pricing" | "general";
type SampleFile = { id: string; name: string; size: string; kind: "doc" | "sheet"; topic: Topic };
type UserMessage = { id: number; role: "user"; text: string; files: SampleFile[]; landed: boolean; grow: boolean };
type Phase = "thinking" | "streaming" | "done" | "stopped";
/** `ask` keeps the question a reply answers, so a stopped reply can be asked again in place. */
type AssistantMessage = { id: number; role: "assistant"; text: string; shown: number; phase: Phase; steps: string[]; step: number; summary: string; grow: boolean; ask?: { text: string; files: SampleFile[] } };
type Message = UserMessage | AssistantMessage;
type Status = "idle" | "sending" | "thinking" | "streaming";
type Box = { left: number; top: number; width: number; height: number };
type Flight = { message: UserMessage; from: Box; run: number };

const sampleFiles: SampleFile[] = [
  { id: "interviews", name: "september-interviews.md", size: "38 KB", kind: "doc", topic: "churn" },
  { id: "funnel", name: "trial-funnel-aug-sep.csv", size: "1.2 MB", kind: "sheet", topic: "mobile" },
  { id: "checkout", name: "checkout-flow-v4.pdf", size: "2.4 MB", kind: "doc", topic: "checkout" },
];

const suggestions = [
  { id: "churn", label: "Summarize churn interviews", prompt: "Summarize what churned teams said in the September interviews. What should we fix first?" },
  { id: "mobile", label: "Why did mobile trials dip?", prompt: "Why did trial conversion dip on mobile after the 4.2 release? Break it down by platform." },
  { id: "release", label: "Draft offline mode notes", prompt: "Draft short release notes for offline mode. Keep the tone plain and skip the marketing words." },
];

const replies: Record<Topic, { steps: string[]; summary: string; text: string }> = {
  churn: {
    steps: ["Reading September interviews", "Grouping 14 conversations"],
    summary: "Grouped 14 interviews",
    text: "Three reasons came up again and again across the 14 interviews.\n\nSetup took longer than the trial. Seven teams never finished connecting their calendar and Slack.\nManagers had no shared view, so Tandem stayed with one person. Five teams said this.\nTwo teams left after a budget freeze and would not have stayed at any price.\n\nFix setup first. Every team that finished it within two days is still paying.",
  },
  mobile: {
    steps: ["Querying the trial funnel", "Splitting by platform"],
    summary: "Queried 8 days of trials",
    text: "Mobile trial conversion fell from 11.8% to 9.2% in the eight days after 4.2 shipped. Almost all of it is iOS, down from 12.4% to 8.1%, where the new sign in sheet asks people to confirm their email twice. Android held steady at 12.1%.\n\nPutting the second confirmation behind a flag would tell us within a week.",
  },
  release: {
    steps: ["Reading the offline mode spec", "Drafting"],
    summary: "Read the offline mode spec",
    text: "Here is a first draft.\n\nOffline mode. Notes, tasks, and comments now open and save without a connection. Everything syncs as soon as you are back online, and if two people edit the same note, you see both versions side by side.\n\nWant a one line version for the in-app changelog?",
  },
  checkout: {
    steps: ["Reading checkout-flow-v4.pdf", "Comparing with v3"],
    summary: "Compared v4 with v3",
    text: "Checkout v4 drops the seat picker from the first step and moves tax into the summary, so the flow goes from four screens to three.\n\nThe riskiest change is hiding seat count. 22% of Team plan buyers changed it last month, so keep it one tap away on the summary screen.",
  },
  pricing: {
    steps: ["Checking checkout analytics", "Comparing plan mix"],
    summary: "Checked 6,030 checkouts",
    text: "With two more days of data, annual plan share is holding at 38% and refund requests are flat at 1.1%. Starter is still taking a bigger share, so revenue per visitor has not moved.\n\nOffering the discount only on Team and above keeps the lift without the downgrade.",
  },
  general: {
    steps: ["Checking product analytics", "Looking for changes"],
    summary: "Checked 30 days of analytics",
    text: "Weekly active teams grew 6.4% over the last 30 days, to 2,318. Most of the gain came from workspaces that turned on recurring tasks, which now retain 9 points better at week four. Nothing else moved outside its normal range.\n\nWant me to pull interviews from those teams next?",
  },
};

const easeStandard: [number, number, number, number] = [...motionTokens.ease.standard];
const easeEnter: [number, number, number, number] = [...motionTokens.ease.enter];

/** Where each word ends in the reply, so a stream can reveal whole words and keep line breaks. */
const wordEnds = (text: string) => Array.from(text.matchAll(/\S+/g), match => (match.index ?? 0) + match[0].length);
/** Words arrive in small uneven bursts, like a real token stream, but the pattern is fixed so it stays deterministic. */
const burst = [2, 1, 3, 2, 1, 2, 3, 1];
/** The bubble padding, mirrored from the stylesheet, so text lifted out of the composer lines up with the bubble it becomes. */
const bubblePad = { x: 15, y: 9 };

const firstAnswer = "The 20% annual discount lifted annual plan share from 31% to 38% across 4,212 checkouts. Revenue per visitor held flat at $2.41, because more of those teams picked Starter over Team.\n\nI would let it run through Friday before calling it.";
const initialMessages: Message[] = [
  { id: 1, role: "user", text: "How did the annual plan discount test do last week?", files: [], landed: true, grow: false },
  { id: 2, role: "assistant", text: firstAnswer, shown: wordEnds(firstAnswer).length, phase: "done", steps: [], step: 0, summary: "Checked 4,212 checkouts", grow: false },
];

function topicFor(text: string, files: SampleFile[]): Topic {
  const value = text.toLowerCase();
  if (/interview|churn/.test(value)) return "churn";
  if (/mobile|trial|ios|android|4\.2/.test(value)) return "mobile";
  if (/release|offline|changelog/.test(value)) return "release";
  if (/checkout|v4/.test(value)) return "checkout";
  if (/discount|annual|pricing|price|plan/.test(value)) return "pricing";
  return files[0]?.topic ?? "general";
}

function buildReply(text: string, files: SampleFile[]) {
  const reply = replies[topicFor(text, files)];
  if (!files.length) return reply;
  const reading = files.length === 1 ? files[0].name : `${files.length} files`;
  return { ...reply, steps: [`Reading ${reading}`, reply.steps[1]], summary: `Read ${reading}` };
}

function boxWithin(element: Element, root: HTMLElement): Box {
  const rect = element.getBoundingClientRect(), origin = root.getBoundingClientRect();
  return { left: rect.left - origin.left - root.clientLeft, top: rect.top - origin.top - root.clientTop, width: rect.width, height: rect.height };
}

function FileGlyph({ kind, size }: { kind: SampleFile["kind"]; size: number }) {
  return kind === "sheet" ? <FileSpreadsheet size={size} strokeWidth={1.75} aria-hidden="true" /> : <FileText size={size} strokeWidth={1.75} aria-hidden="true" />;
}

/**
 * Springs its height to whatever its content measures, so nothing resizes in a single frame.
 * `grow` opens from zero on mount; otherwise the first measurement is taken as is.
 */
function AutoHeight({ children, grow = false, className }: { children: ReactNode; grow?: boolean; className?: string }) {
  const inner = useRef<HTMLDivElement>(null);
  const [start] = useState<number | "auto">(() => (grow ? 0 : "auto"));
  const height = useMotionValue<number | "auto">(start);
  const reduced = useReducedMotion();
  useLayoutEffect(() => {
    const node = inner.current;
    if (!node) return;
    let last = -1;
    let controls: AnimationPlaybackControls | undefined;
    const measure = () => {
      const next = node.offsetHeight;
      if (next === last) return;
      const first = last < 0;
      last = next;
      controls?.stop();
      if ((first && !grow) || reduced) height.set(next);
      else controls = animate(height as MotionValue<number>, next, motionTokens.spring.smooth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => { observer.disconnect(); controls?.stop(); };
  }, [grow, height, reduced]);
  return <motion.div className={className ? `${styles.autoHeight} ${className}` : styles.autoHeight} style={{ height }}><div ref={inner}>{children}</div></motion.div>;
}

/** A file chip that is born as the attach button's circle, then stretches into place while its label arrives a beat later. */
function FileChip({ file, originRef, onRemove }: { file: SampleFile; originRef: RefObject<HTMLButtonElement | null>; onRemove: (file: SampleFile) => void }) {
  const shell = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLSpanElement>(null);
  const reduced = useReducedMotion();
  useLayoutEffect(() => {
    const node = shell.current, inner = content.current, origin = originRef.current;
    if (!node || !inner || !origin || reduced) return;
    const from = origin.getBoundingClientRect(), to = node.getBoundingClientRect();
    const dx = from.left - to.left, dy = from.top + (from.height - to.height) / 2 - to.top;
    const round = to.height / 2;
    node.style.width = `${from.width}px`;
    node.style.borderRadius = `${round}px`;
    node.style.transform = `translateX(${dx}px) translateY(${dy}px)`;
    inner.style.opacity = "0";
    const move = animate(node, { x: [dx, 0], y: [dy, 0] }, motionTokens.spring.morph);
    const shape = animate(node, { width: [from.width, to.width], borderRadius: [round, 12] }, { ...motionTokens.spring.morph, delay: .03 });
    const reveal = animate(inner, { opacity: [0, 1] }, { duration: motionTokens.duration.standard, delay: .14, ease: easeStandard });
    void shape.then(() => { node.style.width = ""; node.style.borderRadius = ""; });
    return () => {
      move.stop(); shape.stop(); reveal.stop();
      node.style.width = ""; node.style.borderRadius = ""; node.style.transform = ""; inner.style.opacity = ""; inner.style.filter = "";
    };
  }, [originRef, reduced]);
  return <div ref={shell} className={styles.chip}>
    <span ref={content} className={styles.chipContent}>
      <FileGlyph kind={file.kind} size={16} />
      <span className={styles.chipName}>{file.name}</span>
      <span className={styles.chipSize}>{file.size}</span>
      <button type="button" className={styles.chipRemove} onClick={() => onRemove(file)} aria-label={`Remove ${file.name}`}><X size={14} strokeWidth={1.75} aria-hidden="true" /></button>
    </span>
  </div>;
}

function BubbleBody({ text, files }: { text: string; files: SampleFile[] }) {
  return <>
    {files.length > 0 && <span className={styles.bubbleFiles}>{files.map(file => <span key={file.id} className={styles.bubbleFile}><FileGlyph kind={file.kind} size={14} /><span className={styles.bubbleFileName}>{file.name}</span></span>)}</span>}
    {text && <span className={styles.bubbleText}>{text}</span>}
  </>;
}

/**
 * The sent message lifts out of the composer and becomes its bubble. It follows the live bubble position every frame,
 * so it lands exactly even while the thread scrolls and the composer shrinks underneath it.
 */
function FlightGhost({ flight, rootRef, onLand }: { flight: Flight; rootRef: RefObject<HTMLElement | null>; onLand: (flight: Flight) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const land = useRef(onLand);
  useLayoutEffect(() => { land.current = onLand; });
  useLayoutEffect(() => {
    const node = box.current, bg = fill.current, content = body.current, root = rootRef.current;
    if (!node || !bg || !content || !root) return;
    const { from } = flight;
    const place = (progress: number) => {
      const target = root.querySelector(`[data-bubble="${flight.message.id}"]`);
      if (!target) return;
      const to = boxWithin(target, root);
      const mix = (a: number, b: number) => a + (b - a) * progress;
      node.style.visibility = "visible";
      node.style.transform = `translate3d(${mix(from.left, to.left)}px, ${mix(from.top, to.top)}px, 0)`;
      node.style.width = `${Math.max(0, mix(from.width, to.width))}px`;
      node.style.height = `${Math.max(0, mix(from.height, to.height))}px`;
      content.style.width = `${to.width}px`;
      bg.style.opacity = `${Math.min(1, Math.max(0, progress * 1.5))}`;
    };
    place(0);
    const controls = animate(0, 1, { type: "spring", visualDuration: .5, bounce: .14, onUpdate: place, onComplete: () => land.current(flight) });
    return () => controls.stop();
  }, [flight, rootRef]);
  return <div ref={box} className={styles.ghost} aria-hidden="true">
    <div ref={fill} className={styles.ghostFill} />
    <div ref={body} className={`${styles.bubble} ${styles.ghostBody}`}><BubbleBody text={flight.message.text} files={flight.message.files} /></div>
  </div>;
}

/** A word fades in once, at mount, while the reply streams; words already on screen never replay. */
function StreamWord({ word, animate: enter }: { word: string; animate: boolean }) {
  const [fade] = useState(enter);
  return <span className={fade ? styles.wordIn : undefined}>{word}</span>;
}

/**
 * Streamed reply text. Words stay inline, so wrapping and line height never change as they land;
 * each new word only settles in with a short opacity fade.
 */
function StreamText({ text, streaming, className }: { text: string; streaming: boolean; className?: string }) {
  const reduced = useReducedMotion();
  const paragraphs = text.split(/\n{2,}/);
  return <div className={className}>
    {paragraphs.map((paragraph, p) => <p key={p}>
      {paragraph.split("\n").map((line, l) => <span key={l}>{l > 0 && <br />}
        {line.split(/(\s+)/).map((part, w) => !part ? null : /^\s+$/.test(part) ? " " : <StreamWord key={w} word={part} animate={streaming && !reduced} />)}
      </span>)}
    </p>)}
  </div>;
}

const UserRow = memo(function UserRow({ message }: { message: UserMessage }) {
  const copyValue = message.text || message.files.map(file => file.name).join(", ");
  return <div className={styles.userRow}>
    <span className={styles.userCopy}><CopyButton value={copyValue} label="Copy message" iconOnly variant="plain" /></span>
    <div className={styles.bubble} data-bubble={message.id} style={message.landed ? undefined : { visibility: "hidden" }}>
      <span className={styles.srOnly}>You: </span>
      <BubbleBody text={message.text} files={message.files} />
    </div>
  </div>;
});

const AssistantRow = memo(function AssistantRow({ message, onRetry }: { message: AssistantMessage; onRetry?: (id: number) => void }) {
  const ends = useMemo(() => wordEnds(message.text), [message.text]);
  const visible = message.text.slice(0, ends[message.shown - 1] ?? 0);
  const thinking = message.phase === "thinking";
  const finished = message.phase === "done" || message.phase === "stopped";
  const label = thinking ? message.steps[message.step] : message.phase === "stopped" && !message.shown ? "Stopped before replying" : message.summary;
  return <div className={styles.assistant}>
    <span className={styles.srOnly}>Assistant: </span>
    <TextShimmer className={styles.meta} active={thinking}>{label}</TextShimmer>
    {message.shown > 0 && <StreamText className={styles.answer} text={visible} streaming={message.phase === "streaming"} />}
    <AnimatePresence initial={false}>
      {finished && message.shown > 0 && <motion.div key="actions" className={styles.actions} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: motionTokens.duration.standard, delay: .08, ease: easeStandard }}>
        <CopyButton value={visible} label="Copy reply" iconOnly variant="plain" />
        {message.phase === "stopped" && <span className={styles.stoppedNote}>Stopped</span>}
        {message.phase === "stopped" && onRetry && message.ask && <button type="button" className={styles.retry} onClick={() => onRetry(message.id)}><RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />Try again</button>}
      </motion.div>}
      {message.phase === "stopped" && !message.shown && onRetry && message.ask && <motion.div key="retry-empty" className={styles.actions} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: motionTokens.duration.standard, ease: easeStandard }}>
        <button type="button" className={styles.retry} onClick={() => onRetry(message.id)}><RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />Try again</button>
      </motion.div>}
    </AnimatePresence>
  </div>;
});

/** One thread entry. Memoized so a streaming reply re-renders only itself, not every message above it. */
const MessageItem = memo(function MessageItem({ message, onRetry }: { message: Message; onRetry?: (id: number) => void }) {
  return <AutoHeight grow={message.grow}>
    <div className={styles.messagePad}>{message.role === "user" ? <UserRow message={message} /> : <AssistantRow message={message} onRetry={onRetry} />}</div>
  </AutoHeight>;
});

const faceIn = { opacity: 0, scale: .8 };
const faceRest = { opacity: 1, scale: 1 };
const faceOut = { opacity: 0, scale: .8, transition: { duration: motionTokens.duration.instant, ease: easeStandard } };

/** Send stretches into a stop pill while a reply is on its way, and folds back when it lands. */
function SendButton({ busy, disabled, onSend, onStop }: { busy: boolean; disabled: boolean; onSend: () => void; onStop: () => void }) {
  const reduced = useReducedMotion();
  return <motion.button type="button" className={styles.send} data-busy={busy || undefined} disabled={disabled} onClick={busy ? onStop : onSend} aria-label={busy ? "Stop response" : "Send message"}
    initial={false} animate={{ width: busy ? 84 : 36 }} transition={reduced ? { duration: 0 } : motionTokens.spring.morph}>
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span key={busy ? "stop" : "send"} className={styles.sendFace} initial={reduced ? { opacity: 0 } : faceIn} animate={faceRest} exit={faceOut}
        transition={reduced ? { duration: motionTokens.duration.instant } : { ...motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.fast, delay: .05 } }}>
        {busy ? <><span className={styles.stopGlyph} />Stop</> : <ArrowUp size={18} strokeWidth={2} aria-hidden="true" />}
      </motion.span>
    </AnimatePresence>
  </motion.button>;
}

export interface AiComposerProps {
  /** Called with the text and sample file names each time a message is sent. Replies in the preview are simulated. */
  onSend?: (message: { text: string; files: string[] }) => void;
  /** Heading in the composer header. */
  title?: string;
  /** One line under the heading, such as the assistant name. */
  subtitle?: string;
}

export function AiComposer({ onSend, title = "Product questions", subtitle = "Tandem assistant" }: AiComposerProps) {
  const reduced = useReducedMotion();
  const inputId = useId();
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [threadKey, setThreadKey] = useState(0);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<SampleFile[]>([]);
  const [batch, setBatch] = useState(0);
  const [used, setUsed] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [flight, setFlight] = useState<Flight | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const rootRef = useRef<HTMLElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const attachRef = useRef<HTMLButtonElement>(null);
  const timers = useRef(new Set<number>());
  const run = useRef(0);
  const nextId = useRef(3);
  const busy = status !== "idle";
  const canSend = draft.trim().length > 0 || files.length > 0;
  const nextFile = sampleFiles.find(file => !files.some(item => item.id === file.id));
  const openSuggestions = suggestions.filter(item => !used.includes(item.id));

  useEffect(() => {
    const pending = timers.current;
    return () => { pending.forEach(window.clearTimeout); pending.clear(); };
  }, []);

  // The thread is bottom anchored (column-reverse), so it follows the stream on its own. When the reader has scrolled up,
  // growth below would drag their text upward; offset it so what they are reading stays put until they return to the bottom.
  useLayoutEffect(() => {
    const thread = threadRef.current, inner = thread?.firstElementChild as HTMLElement | null;
    if (!thread || !inner) return;
    let last = inner.offsetHeight;
    const observer = new ResizeObserver(() => {
      const next = inner.offsetHeight, grew = next - last;
      last = next;
      if (grew > 0 && thread.scrollTop < -24) thread.scrollTop -= grew;
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  // The field sizes itself to its text; the wrapper around it springs to that height.
  useLayoutEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 168)}px`;
  }, [draft]);

  function later(ms: number, task: () => void) {
    const id = window.setTimeout(() => { timers.current.delete(id); task(); }, ms);
    timers.current.add(id);
  }
  function clearTimers() {
    timers.current.forEach(window.clearTimeout);
    timers.current.clear();
  }
  function patchAssistant(id: number, patch: Partial<AssistantMessage>) {
    setMessages(list => list.map(item => item.id === id && item.role === "assistant" ? { ...item, ...patch } : item));
  }

  /** The composer's content box, padded out to the bubble's inset so the lifted text starts exactly where it was typed. */
  function fieldBox(): Box | null {
    const root = rootRef.current, area = textareaRef.current;
    if (!root || !area) return null;
    const parts = [chipsRef.current, area].filter((node): node is HTMLDivElement | HTMLTextAreaElement => Boolean(node)).map(node => boxWithin(node, root)).filter(part => part.height > 0);
    if (!parts.length) return null;
    const left = Math.min(...parts.map(part => part.left)), top = Math.min(...parts.map(part => part.top));
    const right = Math.max(...parts.map(part => part.left + part.width)), bottom = Math.max(...parts.map(part => part.top + part.height));
    return { left: left - bubblePad.x, top: top - bubblePad.y, width: right - left + bubblePad.x * 2, height: bottom - top + bubblePad.y * 2 };
  }

  function stream(token: number, id: number, total: number) {
    let shown = 0, tick = 0;
    setStatus("streaming");
    const next = () => {
      if (run.current !== token) return;
      shown = Math.min(total, shown + burst[tick++ % burst.length]);
      const done = shown >= total;
      patchAssistant(id, { shown, phase: done ? "done" : "streaming" });
      if (done) { setStatus("idle"); setAnnouncement("Reply ready."); return; }
      later(reduced ? 24 : 56, next);
    };
    next();
  }

  function think(token: number, text: string, attached: SampleFile[], reuse?: number) {
    if (run.current !== token) return;
    const reply = buildReply(text, attached);
    const id = reuse ?? nextId.current++;
    const next: AssistantMessage = { id, role: "assistant", text: reply.text, shown: 0, phase: "thinking", steps: reply.steps, step: 0, summary: reply.summary, grow: true, ask: { text, files: attached } };
    setMessages(list => reuse === undefined ? [...list, next] : list.map(item => item.id === reuse ? { ...next, grow: item.grow } : item));
    setStatus("thinking");
    setAnnouncement("The assistant is thinking.");
    const pause = reduced ? 320 : 880;
    later(pause, () => patchAssistant(id, { step: 1 }));
    later(pause * 2, () => stream(token, id, wordEnds(reply.text).length));
  }

  function land(done: Flight) {
    setFlight(null);
    setMessages(list => list.map(item => item.id === done.message.id && item.role === "user" ? { ...item, landed: true } : item));
    if (run.current === done.run) think(done.run, done.message.text, done.message.files);
  }

  function send() {
    const text = draft.trim();
    if (busy || (!text && !files.length)) return;
    const token = ++run.current;
    const from = reduced ? null : fieldBox();
    const message: UserMessage = { id: nextId.current++, role: "user", text, files, landed: !from, grow: true };
    const inFlight = flight?.message.id;
    setMessages(list => [...list.map(item => item.id === inFlight && item.role === "user" ? { ...item, landed: true } : item), message]);
    setDraft("");
    setFiles([]);
    setBatch(value => value + 1);
    const suggestion = suggestions.find(item => item.prompt === text);
    if (suggestion) setUsed(list => [...list, suggestion.id]);
    setStatus("sending");
    setAnnouncement("Message sent.");
    onSend?.({ text, files: files.map(file => file.name) });
    threadRef.current?.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
    if (from) setFlight({ message, from, run: token });
    else { setFlight(null); later(0, () => think(token, text, message.files)); }
  }

  function stop() {
    run.current++;
    clearTimers();
    setMessages(list => list.map(item => item.role === "assistant" && (item.phase === "thinking" || item.phase === "streaming") ? { ...item, phase: "stopped" } : item));
    setStatus("idle");
    setAnnouncement("Response stopped.");
    textareaRef.current?.focus();
  }

  /** A stopped reply is asked again in place: its row keeps its slot and streams a fresh answer. */
  function retry(id: number) {
    if (status !== "idle") return;
    const message = messages.find((item): item is AssistantMessage => item.id === id && item.role === "assistant");
    if (!message?.ask) return;
    const token = ++run.current;
    setStatus("sending");
    setAnnouncement("Trying again.");
    think(token, message.ask.text, message.ask.files, id);
  }
  const retryRef = useRef(retry);
  useLayoutEffect(() => { retryRef.current = retry; });
  const onRetry = useCallback((id: number) => retryRef.current(id), []);

  function reset() {
    run.current++;
    clearTimers();
    setFlight(null);
    setMessages([]);
    setThreadKey(value => value + 1);
    setStatus("idle");
    setUsed([]);
    setFiles([]);
    setBatch(value => value + 1);
    setDraft("");
    setAnnouncement("New thread started.");
    textareaRef.current?.focus();
  }

  function attach() {
    if (!nextFile) return;
    setFiles(list => [...list, nextFile]);
    setAnnouncement(`${nextFile.name} attached.`);
  }

  function removeFile(file: SampleFile) {
    setFiles(list => list.filter(item => item.id !== file.id));
    setAnnouncement(`${file.name} removed.`);
    textareaRef.current?.focus();
  }

  function applySuggestion(prompt: string) {
    setDraft(prompt);
    const node = textareaRef.current;
    if (!node) return;
    node.focus();
    window.requestAnimationFrame(() => node.setSelectionRange(prompt.length, prompt.length));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); }
    else if (event.key === "Escape" && busy) { event.preventDefault(); stop(); }
  }

  const leave = { duration: motionTokens.duration.exit, ease: easeStandard };

  return <section ref={rootRef} className={styles.root} aria-label="AI composer">
    <header className={styles.header}>
      <div className={styles.heading}>
        <h2 className={styles.title}>{title}</h2>
        <p className={styles.subtitle}>{subtitle}</p>
      </div>
      <button type="button" className={styles.newThread} onClick={reset} disabled={!messages.length && !busy}><SquarePen size={16} strokeWidth={1.75} aria-hidden="true" />New thread</button>
    </header>

    <div className={styles.stage}>
      <div ref={threadRef} className={styles.thread}>
        <div className={styles.threadInner}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={threadKey} exit={reduced ? { opacity: 0, transition: { duration: motionTokens.duration.instant } } : { opacity: 0, y: -6, transition: leave }}>
              {messages.map(message => <MessageItem key={message.id} message={message} onRetry={busy ? undefined : onRetry} />)}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
      <AnimatePresence>
        {messages.length === 0 && <motion.div key="empty" className={styles.empty}
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 0, transition: { duration: motionTokens.duration.instant } } : { opacity: 0, y: -4, transition: leave }}
          transition={{ duration: reduced ? motionTokens.duration.fast : motionTokens.duration.considered, delay: reduced ? 0 : .16, ease: easeEnter }}>
          <h3 className={styles.emptyTitle}>What should we look into?</h3>
          <p className={styles.emptyText}>Ask about trials, churn, or the next release. Attach a sample file for context.</p>
        </motion.div>}
      </AnimatePresence>
    </div>

    <div className={styles.dock}>
      <div className={styles.dockInner}>
        <AutoHeight>
          <motion.div className={styles.suggestions} layoutScroll role="group" aria-label="Suggested questions">
            <AnimatePresence mode="popLayout" initial={false}>
              {openSuggestions.map(item => <motion.button key={item.id} layout="position" type="button" className={styles.suggestion} data-active={draft === item.prompt || undefined} onClick={() => applySuggestion(item.prompt)}
                exit={{ opacity: 0, scale: .96, transition: leave }} transition={reduced ? { duration: 0 } : motionTokens.spring.smooth}>{item.label}</motion.button>)}
            </AnimatePresence>
          </motion.div>
        </AutoHeight>

        <div className={styles.composer}>
          <AutoHeight className={styles.reveal}>
            <div key={batch} className={styles.chipsPad}>
              <div ref={chipsRef} className={styles.chips}>
                <AnimatePresence mode="popLayout" initial={false}>
                  {files.map(file => <motion.div key={file.id} className={styles.chipSlot} layout="position" transition={reduced ? { duration: 0 } : motionTokens.spring.smooth}
                    exit={{ opacity: 0, scale: .96, transition: leave }}>
                    <FileChip file={file} originRef={attachRef} onRemove={removeFile} />
                  </motion.div>)}
                </AnimatePresence>
              </div>
            </div>
          </AutoHeight>
          <AutoHeight>
            <div className={styles.textPad}>
              <label className={styles.srOnly} htmlFor={inputId}>Message the assistant</label>
              <textarea id={inputId} ref={textareaRef} className={styles.input} rows={1} value={draft} placeholder="Ask about trials, churn, or releases"
                onChange={event => setDraft(event.target.value)} onKeyDown={handleKeyDown} />
            </div>
          </AutoHeight>
          <div className={styles.toolbar}>
            <button ref={attachRef} type="button" className={styles.attach} onClick={attach} disabled={!nextFile}
              aria-label={nextFile ? `Attach sample file ${nextFile.name}` : "All sample files attached"} title={nextFile ? `Attach ${nextFile.name}` : "All sample files attached"}>
              <Paperclip size={18} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <span className={styles.spacer} />
            <span className={styles.hint} aria-hidden="true">
              <AnimatePresence initial={false}>
                <motion.span key={busy ? "stop" : "send"} className={styles.hintText} initial={reduced ? { opacity: 0 } : { opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -2, transition: { duration: motionTokens.duration.instant } }} transition={{ duration: motionTokens.duration.standard, ease: easeStandard }}>
                  {busy ? "Esc to stop" : "Return to send"}
                </motion.span>
              </AnimatePresence>
            </span>
            <SendButton busy={busy} disabled={!busy && !canSend} onSend={send} onStop={stop} />
          </div>
        </div>
      </div>
    </div>

    {flight && <FlightGhost key={flight.message.id} flight={flight} rootRef={rootRef} onLand={land} />}
    <p className={styles.srOnly} role="status" aria-live="polite">{announcement}</p>
  </section>;
}

export default AiComposer;
