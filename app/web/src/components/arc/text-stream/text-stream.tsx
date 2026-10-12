"use client";
import { Fragment, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AnimatePresence, animate, motion, useReducedMotion } from "motion/react";
import { Check, CircleAlert, Copy, RotateCcw, Square } from "lucide-react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./text-stream.module.css";

const subscribeHydration = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;
/** Words that land in one render share at most this much stagger, in seconds. With smoothing on, a render rarely adds more than one word. */
const maxStagger = .12;

function useReduced() {
  const prefersReduced = useReducedMotion();
  const hydrated = useSyncExternalStore(subscribeHydration, clientSnapshot, serverSnapshot);
  return { hydrated, reduced: Boolean(hydrated && prefersReduced) };
}

/* ---------------------------------------------------------------------------------------------------------------
 * Smoothing: text arrives in uneven bursts; readers want a steady pace. Incoming text is buffered and revealed at a
 * rate that tracks the recent arrival rate plus a small lag, so bursts are absorbed and stalls are bridged. Reveal
 * snaps to whole words, so a half-received word never shows. When the stream ends, the remainder drains quickly.
 * ------------------------------------------------------------------------------------------------------------- */

export type StreamSpeed = "slow" | "normal" | "fast" | number;
const speeds = { slow: 40, normal: 80, fast: 160 } as const;
/** Seconds of text kept in reserve while streaming, so a late chunk never leaves the reader waiting. */
const LAG = .35;
/** How quickly the reveal closes the gap to the reserve, in seconds. */
const CATCH_UP = .6;
/** Once the stream ends, the rest is shown within about this long, in seconds. */
const DRAIN = .3;

export interface SmoothTextOptions {
  /** More text is still expected. While true, reveal stops at the last complete word. */
  streaming?: boolean;
  /** Base pace in characters per second, used before the arrival rate is known and as the drain floor. Defaults to "normal" (80). */
  speed?: StreamSpeed;
  /** Turn off to show text exactly as it arrives. Reduced motion always does. */
  enabled?: boolean;
}

/** Last whitespace at or before `n`, so only whole words are revealed. */
function wordCut(text: string, n: number, streaming: boolean) {
  if (n >= text.length && !streaming) return text.length;
  let i = Math.min(Math.floor(n), text.length);
  if (i < text.length && /\s/.test(text[i]!)) return i;
  while (i > 0 && !/\s/.test(text[i - 1]!)) i--;
  return i;
}

/**
 * Buffers streamed text and returns the part to show now. Pass the full text received so far.
 * `revealing` is true while buffered text is still being shown after it arrived.
 */
export function useSmoothText(text: string, { streaming = false, speed = "normal", enabled = true }: SmoothTextOptions = {}) {
  const { hydrated, reduced } = useReduced();
  const active = enabled && hydrated && !reduced;
  const base = typeof speed === "number" ? Math.max(1, speed) : speeds[speed];
  // Text that is already complete at mount shows as is; a stream joined midway reveals from the start.
  const [shown, setShown] = useState(() => streaming ? 0 : text.length);
  const [previous, setPrevious] = useState(text);
  let count = shown;
  if (previous !== text) {
    setPrevious(text);
    // A new response, not a continuation: start over.
    if (!text.startsWith(previous)) { count = 0; setShown(0); }
  }
  const cursor = useRef(count);
  const last = useRef(text);
  const samples = useRef<[number, number][]>([]);

  useEffect(() => {
    const now = performance.now();
    if (!text.startsWith(last.current)) { cursor.current = 0; samples.current = []; }
    last.current = text;
    const list = samples.current;
    list.push([now, text.length]);
    while (list.length > 2 && now - list[1]![0] > 1500) list.shift();
    if (!active) return;
    let frame = 0, then = now, committed = -1;
    const rate = (at: number) => {
      const first = list[0]!, span = (at - first[0]) / 1000;
      return list.length > 1 && span > .25 ? (text.length - first[1]) / span : base;
    };
    const tick = (at: number) => {
      const dt = Math.min(.1, Math.max(0, (at - then) / 1000));
      then = at;
      const backlog = text.length - cursor.current;
      if (backlog > 0) {
        const arrival = rate(at);
        const pace = streaming ? Math.max(base * .25, arrival + (backlog - arrival * LAG) / CATCH_UP) : Math.max(base, backlog / DRAIN);
        cursor.current = Math.min(text.length, cursor.current + pace * dt);
      }
      const cut = wordCut(text, cursor.current, streaming);
      if (cut !== committed) { committed = cut; setShown(cut); }
      if (cursor.current < text.length) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text, streaming, active, base]);

  const visible = active ? text.slice(0, Math.min(count, text.length)) : text;
  return { text: visible, revealing: visible.length < text.length };
}

/* ---------------------------------------------------------------------------------------------------------------
 * Markdown: a small, streaming tolerant subset. Unclosed bold, italics, inline code, links, and code fences render as
 * if they were already closed, and a trailing list, heading, or fence marker waits for its first word, so syntax never
 * flashes on screen. Every unit keeps its index as more text arrives, so nothing that has landed replays.
 * ------------------------------------------------------------------------------------------------------------- */

type UnitData =
  | { kind: "text"; text: string; bold: boolean; italic: boolean }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href?: string }
  | { kind: "cite"; n: number };
type Unit = UnitData & { space: boolean; index: number };
type Line = { text: string; index: number };
type Block =
  | { kind: "p" | "h"; units: Unit[] }
  | { kind: "ul" | "ol"; items: Unit[][]; start: number }
  | { kind: "code"; lang: string; lines: Line[]; source: string };
type RawBlock =
  | { kind: "p" | "h"; text: string }
  | { kind: "ul" | "ol"; items: string[]; start: number }
  | { kind: "code"; lang: string; lines: string[] };

function inlineUnits(src: string, counter: { n: number }): Unit[] {
  const units: Unit[] = [];
  let bold = false, italic = false, buf = "", space = false, i = 0;
  const push = (unit: UnitData) => { units.push({ ...unit, space: space && units.length > 0, index: counter.n++ }); space = false; };
  const flush = () => {
    for (const token of buf.split(/(\s+)/)) {
      if (!token) continue;
      if (/^\s+$/.test(token)) space = true;
      else push({ kind: "text", text: token, bold, italic });
    }
    buf = "";
  };
  while (i < src.length) {
    if (src.startsWith("**", i)) { flush(); bold = !bold; i += 2; continue; }
    // A single asterisk opens italics only before a word and closes only after one, so "2 * 3" stays literal.
    if (src[i] === "*" && (italic ? i > 0 && /\S/.test(src[i - 1]!) : i + 1 < src.length && /[^\s*]/.test(src[i + 1]!))) { flush(); italic = !italic; i += 1; continue; }
    if (src[i] === "`") {
      flush();
      const close = src.indexOf("`", i + 1);
      const end = close === -1 ? src.length : close;
      const code = src.slice(i + 1, end);
      if (code) push({ kind: "code", text: code });
      i = close === -1 ? src.length : close + 1;
      continue;
    }
    if (src[i] === "[") {
      const cite = /^\[(\d{1,2})\]/.exec(src.slice(i, i + 4));
      if (cite) { flush(); push({ kind: "cite", n: Number(cite[1]) }); i += cite[0].length; continue; }
      const close = src.indexOf("]", i + 1);
      if (close === -1 || src[close + 1] === "(" || close === src.length - 1) {
        // A link, or the start of one: its text shows right away and the address attaches once it is complete.
        flush();
        const label = src.slice(i + 1, close === -1 ? src.length : close);
        let href: string | undefined, next = close === -1 ? src.length : close + 1;
        if (close !== -1 && src[close + 1] === "(") {
          const end = src.indexOf(")", close + 2);
          if (end !== -1) href = src.slice(close + 2, end).trim();
          next = end === -1 ? src.length : end + 1;
        }
        if (label) push({ kind: "link", text: label, href: href && /^(https?:|mailto:|\/|#)/.test(href) ? href : undefined });
        i = next;
        continue;
      }
    }
    buf += src[i++];
  }
  flush();
  return units;
}

/** A last line that is only a list, heading, or fence marker waits until its first word arrives. */
const pendingMarker = /^\s*(#{1,6}|[-*+]|\d+[.)]?|`{1,2})\s*$/;

function rawBlocks(text: string): RawBlock[] {
  const blocks: RawBlock[] = [];
  const lines = text.split("\n");
  let current: RawBlock | null = null;
  const close = () => { if (current) blocks.push(current); current = null; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      close();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) body.push(lines[i++]!);
      // An open fence whose text ends on a line break would show an empty row that vanishes when the closing fence lands.
      if (i >= lines.length && body.length && !body[body.length - 1]) body.pop();
      blocks.push({ kind: "code", lang: fence[1]!.trim(), lines: body });
      continue;
    }
    if (!line.trim()) { close(); continue; }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const kind = bullet ? "ul" : "ol";
      const body = bullet ? bullet[1]! : numbered![2]!;
      const open = current as RawBlock | null;
      if (open && open.kind === kind) open.items.push(body);
      else { close(); current = { kind, items: [body], start: numbered ? Number(numbered[1]) : 1 }; }
      continue;
    }
    if (heading) { close(); blocks.push({ kind: "h", text: heading[1]! }); continue; }
    const open = current as RawBlock | null;
    if (open && (open.kind === "ul" || open.kind === "ol")) { open.items[open.items.length - 1] += ` ${line.trim()}`; continue; }
    if (open && open.kind === "p") { open.text += ` ${line.trim()}`; continue; }
    close();
    current = { kind: "p", text: line.trim() };
  }
  close();
  return blocks;
}

function parseMarkdown(source: string, live: boolean) {
  let text = source;
  if (live) {
    const lastBreak = text.lastIndexOf("\n");
    if (pendingMarker.test(text.slice(lastBreak + 1))) text = text.slice(0, lastBreak + 1);
  }
  const counter = { n: 0 };
  const blocks: Block[] = rawBlocks(text).map(block => {
    if (block.kind === "code") return { kind: "code", lang: block.lang, source: block.lines.join("\n"), lines: block.lines.map(line => ({ text: line, index: counter.n++ })) };
    if ("items" in block) return { kind: block.kind, start: block.start, items: block.items.map(item => inlineUnits(item, counter)) };
    return { kind: block.kind, units: inlineUnits(block.text, counter) };
  });
  return { blocks, count: counter.n };
}

/** Strips the supported markdown so a streamed answer can be copied as plain text. */
export function streamPlainText(markdown: string) {
  return markdown
    .replace(/^\s*```.*$/gm, "")
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/(^|[^\S\n]|[(])\*(?=\S)([^*\n]+?)\*/g, "$1$2")
    .replace(/`/g, "")
    .replace(/\s?\[\d{1,2}\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ------------------------------------------------------------------------------------------------------------- */

function StreamWord({ children, enter, delay, className }: { children: ReactNode; enter: boolean; delay: number; className?: string }) {
  // Decided once at mount, so a word never replays its entrance when later words arrive.
  const [entrance] = useState(() => enter ? { animationDelay: `${delay.toFixed(3)}s` } : undefined);
  return <span className={[styles.word, entrance && styles.enter, className].filter(Boolean).join(" ")} style={entrance}>{children}</span>;
}

/** A small dot that rides the end of the text. It holds still while words flow and breathes only while waiting. */
function Caret({ reduced, pulse }: { reduced: boolean; pulse: number }) {
  const dot = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = dot.current;
    if (!node || reduced) return;
    node.style.opacity = "1";
    const breathe = animate(node, { opacity: [1, .35, 1] }, { duration: 1.4, ease: [...motionTokens.ease.inOut], repeat: Infinity, delay: .6 });
    return () => breathe.stop();
  }, [reduced, pulse]);
  return <motion.span className={styles.caret} aria-hidden="true" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.standard] } }} transition={{ duration: motionTokens.duration.instant }}><span ref={dot} className={styles.dot} /></motion.span>;
}

type CopyState = "idle" | "copied" | "failed";
function useCopy() {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async (value: string) => {
    window.clearTimeout(timer.current);
    try { await navigator.clipboard.writeText(value); setState("copied"); }
    catch { setState("failed"); }
    timer.current = window.setTimeout(() => setState("idle"), 1600);
  };
  return { state, copy };
}

/** Icon and label swap in place. Every label is stacked in one grid cell, so the button never changes width. */
function CopyLabel({ state, idle }: { state: CopyState; idle: string }) {
  const icon = state === "copied" ? <Check key="ok" /> : state === "failed" ? <CircleAlert key="err" /> : <Copy key="idle" />;
  return <>
    <span className={styles.iconSlot} aria-hidden="true"><AnimatePresence initial={false} mode="popLayout">
      <motion.span key={state} className={styles.icon} initial={{ opacity: 0, scale: .7 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .7 }} transition={{ duration: motionTokens.duration.fast, ease: [...motionTokens.ease.standard] }}>{icon}</motion.span>
    </AnimatePresence></span>
    <span className={styles.labelStack}>
      {(["idle", "copied", "failed"] as const).map(key => <span key={key} data-active={state === key || undefined} aria-hidden={state !== key || undefined}>{key === "idle" ? idle : key === "copied" ? "Copied" : "Try again"}</span>)}
    </span>
  </>;
}

function CodeBlock({ block, enter, children }: { block: Extract<Block, { kind: "code" }>; enter: boolean; children: ReactNode }) {
  const { state, copy } = useCopy();
  const [entrance] = useState(enter);
  return <div className={[styles.codeBlock, entrance && styles.blockEnter].filter(Boolean).join(" ")}>
    <div className={styles.codeHeader}>
      <span className={styles.codeLang}>{block.lang || "Code"}</span>
      <button type="button" className={styles.codeCopy} onClick={() => copy(block.source)} aria-label={state === "copied" ? "Code copied" : state === "failed" ? "Copy failed, try again" : "Copy code"}>
        <CopyLabel state={state} idle="Copy" />
      </button>
    </div>
    <pre className={styles.pre}><code>{children}</code></pre>
  </div>;
}

function ListItem({ enter, children }: { enter: boolean; children: ReactNode }) {
  const [entrance] = useState(enter);
  return <li className={entrance ? styles.itemEnter : undefined}>{children}</li>;
}

/**
 * Streams an AI response or other generated text in place. Pass the full text received so far. Incoming text is
 * buffered and revealed word by word at a steady pace, only new words fade in, and a small dot rides the end while
 * text is still arriving. Lines that have landed never move. To start a new response, reset `text` or change the key.
 * Set `markdown` to render paragraphs, headings, lists, bold, italics, links, inline code, fenced code with a copy
 * button, and `[1]` citations. The element sets `aria-busy` while streaming instead of announcing every word;
 * announce the finished text from your own polite live region, or use StreamAnswer, which does.
 */
export interface TextStreamProps {
  /** The full text received so far. */
  text: string;
  /** More text is expected. Shows the caret and marks the text busy. */
  streaming?: boolean;
  as?: "p" | "div" | "span";
  className?: string;
  id?: string;
  /** Renders a small markdown subset. The root becomes a `div` unless `as` says otherwise. */
  markdown?: boolean;
  /** Renders a `[n]` citation in markdown mode. Defaults to a small numbered mark. */
  renderCitation?: (n: number) => ReactNode;
  /** Buffers bursts and reveals at a steady pace. Turn off when the text is already paced upstream. Defaults to true. */
  smooth?: boolean;
  /** Base reveal pace for smoothing: "slow", "normal", "fast", or characters per second. */
  speed?: StreamSpeed;
  /** Called once the stream has ended and every buffered word is on screen. */
  onRevealed?: () => void;
}
export function TextStream({ text: incoming, streaming = false, as, className, id, markdown = false, renderCitation, smooth = true, speed, onRevealed }: TextStreamProps) {
  const { hydrated, reduced } = useReduced();
  const { text, revealing } = useSmoothText(incoming, { streaming, speed, enabled: smooth });
  const live = streaming || revealing;
  const parsed = markdown ? parseMarkdown(text, live) : null;
  const words = parsed ? [] : text.split(/(\s+)/).filter(Boolean);
  const count = parsed ? parsed.count : words.length;
  // Text present at hydration or at a finished mount appears as is. Mounting mid stream fades in what has arrived.
  const [seen, setSeen] = useState(() => ({ count, from: streaming && hydrated ? 0 : count }));
  let from = seen.from;
  if (seen.count !== count) { from = Math.min(seen.count, count); setSeen({ count, from }); }
  const step = Math.min(motionTokens.stagger.word, maxStagger / Math.max(1, count - from - 1));
  const animateNew = hydrated && !reduced;
  const enterAt = (index: number) => animateNew && index >= from;
  const delayAt = (index: number) => Math.max(0, index - from) * step;
  const caret = <AnimatePresence initial={false}>{live ? <Caret key="caret" reduced={reduced} pulse={count} /> : null}</AnimatePresence>;

  const revealed = !live && text.length > 0;
  const notify = useRef(onRevealed);
  useEffect(() => { notify.current = onRevealed; });
  useEffect(() => { if (revealed) notify.current?.(); }, [revealed]);

  if (!parsed) {
    const Tag = as ?? "p";
    return <Tag id={id} className={[styles.stream, className].filter(Boolean).join(" ")} aria-busy={live || undefined}>
      <span className={styles.srOnly}>{text}</span>
      <span aria-hidden="true">
        {words.map((token, index) => /^\s+$/.test(token) ? <Fragment key={index}>{token.includes("\n") ? token.replace(/[^\n]/g, "") : " "}</Fragment> : <StreamWord key={index} enter={enterAt(index)} delay={delayAt(index)}>{token}</StreamWord>)}
        {caret}
      </span>
    </Tag>;
  }

  const content = (unit: Unit) => {
    if (unit.kind === "text") {
      const body = unit.italic ? <em className={styles.em}>{unit.text}</em> : unit.text;
      return unit.bold ? <strong className={styles.strong}>{body}</strong> : body;
    }
    if (unit.kind === "code") return <code className={styles.inlineCode}>{unit.text}</code>;
    if (unit.kind === "link") return unit.href ? <a className={styles.link} href={unit.href} target="_blank" rel="noreferrer">{unit.text}</a> : <span className={styles.link}>{unit.text}</span>;
    return renderCitation ? renderCitation(unit.n) : <sup className={styles.citeMark}>{unit.n}</sup>;
  };
  const units = (list: Unit[], tail?: ReactNode) => <>
    {list.map(unit => <Fragment key={unit.index}>
      {unit.space ? " " : null}
      <StreamWord enter={enterAt(unit.index)} delay={delayAt(unit.index)} className={unit.kind === "cite" ? styles.citeWord : undefined}>{content(unit)}</StreamWord>
    </Fragment>)}
    {tail}
  </>;
  const last = parsed.blocks.length - 1;
  const Tag = as ?? "div";
  return <Tag id={id} className={[styles.markdown, className].filter(Boolean).join(" ")} aria-busy={live || undefined}>
    {parsed.blocks.map((block, index) => {
      const tail = index === last ? caret : null;
      if (block.kind === "code") {
        const first = block.lines[0]?.index ?? count;
        return <CodeBlock key={`code-${index}`} block={block} enter={enterAt(first)}>
          {block.lines.map((line, row) => <StreamWord key={line.index} className={styles.codeLine} enter={enterAt(line.index)} delay={delayAt(line.index)}>{line.text || " "}{row === block.lines.length - 1 ? tail : null}</StreamWord>)}
          {block.lines.length ? null : tail}
        </CodeBlock>;
      }
      if ("items" in block) {
        const List = block.kind;
        return <List key={`${block.kind}-${index}`} className={styles.list} start={block.kind === "ol" && block.start !== 1 ? block.start : undefined}>
          {block.items.map((item, row) => <ListItem key={row} enter={enterAt(item[0]?.index ?? count)}>{units(item, row === block.items.length - 1 ? tail : null)}</ListItem>)}
        </List>;
      }
      if (block.kind === "h") return <h3 key={`h-${index}`} className={styles.heading}>{units(block.units, tail)}</h3>;
      return <p key={`p-${index}`} className={styles.paragraph}>{units(block.units, tail)}</p>;
    })}
    {parsed.blocks.length ? null : caret}
  </Tag>;
}

/* ---------------------------------------------------------------------------------------------------------------
 * StreamAnswer: a complete assistant reply. A quiet thinking line, smoothed markdown with source previews, and a
 * reserved action row that swaps Stop for Copy and Regenerate once the answer is on screen.
 * ------------------------------------------------------------------------------------------------------------- */

export interface StreamSource {
  title: string;
  url: string;
  /** Shown above the title. Derived from `url` when omitted. */
  domain?: string;
  snippet?: string;
}
export type StreamAnswerStatus = "thinking" | "streaming" | "done" | "stopped";
export interface StreamAnswerProps {
  /** Markdown received so far. `[1]` marks cite `sources[0]`. */
  text: string;
  status: StreamAnswerStatus;
  sources?: StreamSource[];
  /** Label shown while the model is thinking. */
  thinkingLabel?: string;
  /** Shows a regenerate action once the answer is done or stopped. */
  onRegenerate?: () => void;
  /** Shows a Stop action while thinking or streaming. Set `status` to "stopped" in response. */
  onStop?: () => void;
  /** Buffers bursts and reveals at a steady pace. Defaults to true. */
  smooth?: boolean;
  /** Base reveal pace: "slow", "normal", "fast", or characters per second. */
  speed?: StreamSpeed;
  /** Keeps the nearest scrolling ancestor pinned to the newest line while the reader is at the bottom. Scrolling up releases it. Defaults to true. */
  autoScroll?: boolean;
  className?: string;
}

function domainOf(source: StreamSource) {
  if (source.domain) return source.domain;
  try { return new URL(source.url).hostname.replace(/^www\./, ""); } catch { return source.url; }
}

function scrollParent(node: HTMLElement | null) {
  for (let el = node?.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    if (/(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY)) return el;
  }
  return null;
}

type Via = "hover" | "click" | "keyboard";
type OpenCite = { n: number; left: number; top: number; origin: number; chip: HTMLButtonElement; via: Via };

export function StreamAnswer({ text, status, sources = [], thinkingLabel = "Thinking", onRegenerate, onStop, smooth = true, speed, autoScroll = true, className }: StreamAnswerProps) {
  const { reduced } = useReduced();
  const root = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef(0);
  const popoverId = useId();
  const [open, setOpen] = useState<OpenCite | null>(null);
  const { state: copyState, copy } = useCopy();
  const { text: shown, revealing } = useSmoothText(text, { streaming: status === "streaming", speed, enabled: smooth });
  const writing = status === "streaming" || revealing;
  const finished = (status === "done" || status === "stopped") && !revealing;
  const thinking = status === "thinking" || (status === "streaming" && !shown.trim());
  const quick = { duration: reduced ? motionTokens.duration.instant : motionTokens.duration.fast, ease: [...motionTokens.ease.standard] } as const;

  // Follow the newest line only while the reader is at the bottom. Scrolling up lets go; scrolling back down picks it up again.
  useEffect(() => {
    const node = root.current, scroller = autoScroll ? scrollParent(root.current) : null;
    if (!node || !scroller) return;
    let pinned = true;
    const onScroll = () => { pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24; };
    const observer = new ResizeObserver(() => { if (pinned) scroller.scrollTop = scroller.scrollHeight; });
    scroller.addEventListener("scroll", onScroll, { passive: true });
    observer.observe(node);
    return () => { scroller.removeEventListener("scroll", onScroll); observer.disconnect(); };
  }, [autoScroll]);

  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  useEffect(() => {
    if (!open) return;
    if (open.via === "keyboard") popover.current?.querySelector<HTMLElement>("a")?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); open.chip.focus(); setOpen(null); } };
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popover.current?.contains(target) || open.chip.contains(target)) return;
      setOpen(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onDown); };
  }, [open]);

  // A new response closes any open preview.
  const [lastText, setLastText] = useState(text);
  if (text !== lastText) { setLastText(text); if (!text && open) setOpen(null); }

  const place = (n: number, chip: HTMLButtonElement, via: Via) => {
    const host = root.current;
    if (!host) return;
    const hostBox = host.getBoundingClientRect(), box = chip.getBoundingClientRect();
    const width = Math.min(288, hostBox.width);
    const center = box.left - hostBox.left + box.width / 2;
    const left = Math.max(0, Math.min(center - width / 2, hostBox.width - width));
    setOpen({ n, chip, via, left, top: box.bottom - hostBox.top + 6, origin: center - left });
  };
  const hoverOpen = (n: number, chip: HTMLButtonElement) => {
    window.clearTimeout(hoverTimer.current);
    if (open?.n === n) return;
    // The first preview waits a beat so a passing pointer does not open it; moving between chips is instant.
    hoverTimer.current = window.setTimeout(() => place(n, chip, "hover"), open ? 0 : 220);
  };
  const hoverClose = () => {
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setOpen(current => current?.via === "hover" ? null : current), 160);
  };
  const keepOpen = () => window.clearTimeout(hoverTimer.current);
  const toggle = (n: number, chip: HTMLButtonElement, viaKeyboard: boolean) => {
    window.clearTimeout(hoverTimer.current);
    if (open?.n === n && open.via === "hover" && !viaKeyboard) { setOpen({ ...open, via: "click" }); return; }
    if (open?.n === n) { setOpen(null); return; }
    place(n, chip, viaKeyboard ? "keyboard" : "click");
  };

  const renderCitation = (n: number) => {
    const source = sources[n - 1];
    if (!source) return <sup className={styles.citeMark}>{n}</sup>;
    const active = open?.n === n;
    return <button type="button" className={styles.chip} data-active={active || undefined} aria-expanded={active} aria-controls={active ? popoverId : undefined} aria-label={`Source ${n}: ${source.title}`}
      onPointerEnter={event => { if (event.pointerType === "mouse") hoverOpen(n, event.currentTarget); }}
      onPointerLeave={event => { if (event.pointerType === "mouse") hoverClose(); }}
      onClick={event => toggle(n, event.currentTarget, event.detail === 0)}>{n}</button>;
  };

  const openSource = open ? sources[open.n - 1] : undefined;
  const plain = streamPlainText(text);
  const busy = status === "thinking" || writing;

  return <div ref={root} className={[styles.answerRoot, className].filter(Boolean).join(" ")}>
    {/* The thinking line and the answer share one cell, so the first words land exactly where the label was. */}
    <div className={styles.stage} aria-busy={busy || undefined}>
      <AnimatePresence initial={false}>
        {thinking && <motion.div key="thinking" className={styles.thinking} role="status" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: quick }} transition={quick}>
          <span className={reduced ? styles.thinkingStatic : styles.shimmer}>{thinkingLabel}</span>
        </motion.div>}
      </AnimatePresence>
      {shown ? <TextStream markdown text={shown} streaming={writing} smooth={false} renderCitation={renderCitation} className={styles.answerText} /> : null}
    </div>

    {/* A reserved row: Stop while writing, then Copy and Regenerate once every word is on screen. Nothing below moves. */}
    <div className={styles.actions}>
      <AnimatePresence initial={false}>
        {busy && onStop ? <motion.div key="busy" className={styles.actionGroup} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: quick }} transition={quick}>
          <button type="button" className={styles.action} onClick={onStop}>
            <span className={styles.iconSlot} aria-hidden="true"><Square className={styles.stopIcon} /></span><span>Stop</span>
          </button>
        </motion.div> : null}
        {finished && (shown || onRegenerate) ? <motion.div key="done" className={styles.actionGroup} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: quick }} transition={{ ...quick, delay: reduced ? 0 : .08 }}>
          {shown ? <button type="button" className={styles.action} onClick={() => copy(plain)} aria-label={copyState === "copied" ? "Answer copied" : copyState === "failed" ? "Copy failed, try again" : "Copy answer"}>
            <CopyLabel state={copyState} idle="Copy" />
          </button> : null}
          {onRegenerate && <button type="button" className={styles.action} onClick={onRegenerate}>
            <span className={styles.iconSlot} aria-hidden="true"><RotateCcw className={styles.regenIcon} /></span><span>Regenerate</span>
          </button>}
          {status === "stopped" && <span className={styles.note}>Stopped</span>}
        </motion.div> : null}
      </AnimatePresence>
    </div>

    {/* Screen readers hear the finished answer once, not every word. */}
    <div className={styles.srOnly} aria-live="polite">{finished && text ? status === "stopped" ? `Stopped. ${plain}` : plain : ""}</div>

    <AnimatePresence>
      {open && openSource && <motion.div ref={popover} key={open.n} id={popoverId} role="dialog" aria-label={`Source ${open.n}`} className={styles.popover}
        style={{ left: open.left, top: open.top, transformOrigin: `${open.origin}px 0px` }}
        onPointerEnter={event => { if (event.pointerType === "mouse") keepOpen(); }}
        onPointerLeave={event => { if (event.pointerType === "mouse") hoverClose(); }}
        initial={reduced ? { opacity: 0 } : { opacity: 0, scale: .97 }} animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, transition: { duration: motionTokens.duration.instant, ease: [...motionTokens.ease.standard] } }}
        transition={reduced ? { duration: motionTokens.duration.instant } : { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.enter] }}>
        <span className={styles.popDomain}><span className={styles.popIndex}>{open.n}</span>{domainOf(openSource)}</span>
        <span className={styles.popTitle}>{openSource.title}</span>
        {openSource.snippet && <span className={styles.popSnippet}>{openSource.snippet}</span>}
        <a className={styles.popLink} href={openSource.url} target="_blank" rel="noreferrer" onKeyDown={event => { if (event.key === "Tab") { open.chip.focus(); setOpen(null); } }}>Open source</a>
      </motion.div>}
    </AnimatePresence>
  </div>;
}

export default TextStream;
