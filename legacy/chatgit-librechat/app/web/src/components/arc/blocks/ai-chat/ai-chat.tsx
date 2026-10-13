"use client";

import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ChangeEvent, ClipboardEvent as ReactClipboardEvent, DragEvent as ReactDragEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { AnimatePresence, LayoutGroup, animate, motion, useMotionValue, useReducedMotion } from "motion/react";
import type { Transition } from "motion/react";
import { ArrowDown, ArrowUp, ArrowUpRight, Check, ChevronDown, ChevronLeft, ChevronRight, Code2, FileText, Globe, Image as ImageIcon, LoaderCircle, PanelLeft, PanelLeftClose, Paperclip, Pencil, RotateCcw, Search, SquarePen, X } from "lucide-react";
import { motionTokens } from "../../lib/motion-tokens";
import { TextShimmer } from "../../text-shimmer/text-shimmer";
import { TextScramble } from "../../text-scramble/text-scramble";
import { CopyControl, Markdown, StreamText, plainText } from "./markdown";
import { sampleConversations, sampleModels, sampleResponder, sampleSuggestions } from "./ai-chat-data";
import type { ChatAnswer, AiChatAttachment, ChatConversation, AiChatMessage, ChatModel, ChatResponder, ChatSource, ChatStreamEvent, ChatSuggestion, ChatToolCall } from "./ai-chat-data";
import styles from "./ai-chat.module.css";

export type { ChatAnswer, AiChatAttachment, ChatConversation, AiChatMessage, ChatModel, ChatRequest, ChatResponder, ChatSource, ChatStreamEvent, ChatSuggestion, ChatToolCall } from "./ai-chat-data";
export { sampleResponder } from "./ai-chat-data";

type Bezier = [number, number, number, number];
const { spring, duration, blur } = motionTokens;
const enter = [...motionTokens.ease.enter] as Bezier;
const standard = [...motionTokens.ease.standard] as Bezier;
/** Duration springs restated as stiffness and damping, so a retarget keeps the velocity already in flight. */
const physical = (visualDuration: number, bounce: number): Transition => {
  const root = 2 * Math.PI / (visualDuration * 1.2);
  return { type: "spring", stiffness: root * root, damping: 2 * (1 - bounce) * root, mass: 1 };
};
const GROW = physical(.44, .12), SHRINK = physical(.34, 0), GLIDE = physical(.3, .08);
const NARROW = 720;

const subscribe = () => () => {};
function useReducedFlag() {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

function useControllable<T>(value: T | undefined, initial: T, onChange?: (next: T) => void): [T, (next: T) => void] {
  const [inner, setInner] = useState(initial);
  const controlled = value !== undefined;
  const current = controlled ? value : inner;
  const set = useCallback((next: T) => { if (!controlled) setInner(next); onChange?.(next); }, [controlled, onChange]);
  return [current, set];
}

let counter = 0;
const makeId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
const domainOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };
const titleFrom = (prompt: string) => { const words = prompt.replace(/[?.!]+$/, "").split(/\s+/).slice(0, 6).join(" "); return words.length > 42 ? `${words.slice(0, 40)}…` : words; };

/** Height follows content on a spring, so streamed lines and opened panels grow instead of jumping. */
function AutoHeight({ children, className, reduced }: { children: ReactNode; className?: string; reduced: boolean }) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | "auto">("auto");
  useLayoutEffect(() => {
    const node = inner.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(node.offsetHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <motion.div className={styles.autoHeight} initial={false} animate={{ height }} transition={reduced ? { duration: 0 } : spring.smooth}>
    <div ref={inner} className={className}>{children}</div>
  </motion.div>;
}

/** Icons trade places with a small scale and fade, inside a fixed cell. */
function IconSwap({ id, reduced, children }: { id: string; reduced: boolean; children: ReactNode }) {
  const hidden = reduced ? { opacity: 0 } : { opacity: 0, scale: .7 };
  return <span className={styles.swapCell} aria-hidden="true"><AnimatePresence initial={false} mode="popLayout">
    <motion.span key={id} className={styles.swapItem} initial={hidden} animate={{ opacity: 1, scale: 1 }} exit={{ ...hidden, transition: { duration: reduced ? .08 : duration.instant } }}
      transition={reduced ? { duration: .12 } : { ...spring.smooth, opacity: { duration: duration.fast } }}>{children}</motion.span>
  </AnimatePresence></span>;
}

/* Citations -------------------------------------------------------------------------------------------------------- */

type CardState = { source: ChatSource; n: number; x: number; top?: number; bottom?: number; width: number; below: boolean; origin: number; key: string };
type CiteApi = { show: (source: ChatSource, n: number, anchor: HTMLElement, key: string) => void; hide: (delay?: number) => void; keep: () => void; toggle: (source: ChatSource, n: number, anchor: HTMLElement, key: string, mouse: boolean) => void; openKey: string | null; cardId: string };
const CiteContext = createContext<CiteApi | null>(null);

function CiteChip({ source, n, id }: { source: ChatSource | undefined; n: number; id: string }) {
  const api = useContext(CiteContext);
  const pointer = useRef("");
  if (!source || !api) return <span className={styles.citeMissing}>[{n}]</span>;
  const open = api.openKey === id;
  return <button type="button" className={styles.cite} data-open={open || undefined} aria-label={`Source ${n}: ${source.title}, ${domainOf(source.url)}`}
    aria-expanded={open} aria-controls={open ? api.cardId : undefined}
    onPointerEnter={event => { if (event.pointerType === "mouse") api.show(source, n, event.currentTarget, id); }}
    onPointerLeave={event => { if (event.pointerType === "mouse") api.hide(140); }}
    onFocus={event => { if (event.currentTarget.matches(":focus-visible")) api.show(source, n, event.currentTarget, id); }}
    onBlur={event => { if (!document.getElementById(api.cardId)?.contains(event.relatedTarget as Node | null)) api.hide(120); }}
    onPointerDown={event => { pointer.current = event.pointerType; }}
    onClick={event => { api.toggle(source, n, event.currentTarget, id, pointer.current === "mouse"); pointer.current = ""; }}>{n}</button>;
}

function SourceCard({ card, id, reduced, onEnter, onLeave }: { card: CardState; id: string; reduced: boolean; onEnter: () => void; onLeave: (delay: number) => void }) {
  const shift = card.below ? -6 : 6;
  return <motion.div id={id} role="dialog" aria-label={`Source ${card.n}`} className={styles.sourceCard}
    style={{ left: card.x, top: card.top, bottom: card.bottom, width: card.width, transformOrigin: `${card.origin}px ${card.below ? "0%" : "100%"}` }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onLeave(0); }}
    initial={reduced ? { opacity: 0 } : { opacity: 0, scale: .97, y: shift }}
    animate={{ opacity: 1, scale: 1, y: 0 }}
    exit={reduced ? { opacity: 0, transition: { duration: .08 } } : { opacity: 0, scale: .98, y: shift / 2, transition: { duration: duration.instant, ease: standard } }}
    transition={reduced ? { duration: .12 } : { ...spring.smooth, opacity: { duration: duration.fast, ease: enter } }}
    onPointerEnter={onEnter} onPointerLeave={event => { if (event.pointerType === "mouse") onLeave(140); }}>
    <p className={styles.sourceDomain}><Globe size={14} strokeWidth={1.75} aria-hidden="true" /><span>{domainOf(card.source.url)}</span><span className={styles.sourceIndex}>{card.n}</span></p>
    <p className={styles.sourceTitle}>{card.source.title}</p>
    {card.source.snippet && <p className={styles.sourceSnippet}>{card.source.snippet}</p>}
    <a className={styles.sourceLink} href={card.source.url} target="_blank" rel="noreferrer">Open source<ArrowUpRight size={14} strokeWidth={1.75} aria-hidden="true" /></a>
  </motion.div>;
}

/* Thinking and tools ----------------------------------------------------------------------------------------------- */

function Thinking({ answer, reduced, id }: { answer: ChatAnswer; reduced: boolean; id: string }) {
  const active = answer.status === "thinking";
  const [manual, setManual] = useState<boolean | null>(null);
  const hasText = !!answer.thinking;
  const open = hasText && (manual ?? active);
  const label = active ? "Thinking" : answer.thoughtFor ? `Thought for ${answer.thoughtFor}s` : answer.status === "stopped" ? "Stopped while thinking" : "Thought briefly";
  const panelRef = useRef<HTMLDivElement>(null);
  // While thoughts stream in, the newest line stays in view.
  useLayoutEffect(() => { const node = panelRef.current; if (node && active) node.scrollTop = node.scrollHeight; }, [answer.thinking, active]);
  return <div className={styles.thinking}>
    <button type="button" className={styles.thinkingHead} aria-expanded={open} aria-controls={open ? `${id}-thoughts` : undefined} disabled={!hasText} onClick={() => setManual(!open)}>
      <TextShimmer active={active}>{label}</TextShimmer>
      {hasText && <motion.span className={styles.thinkingChevron} initial={false} animate={{ rotate: open ? 0 : -90 }} transition={reduced ? { duration: 0 } : GLIDE} aria-hidden="true"><ChevronDown size={15} strokeWidth={1.75} /></motion.span>}
    </button>
    <AnimatePresence initial={false}>
      {open && <motion.div key="thoughts" id={`${id}-thoughts`} className={styles.thoughtsClip}
        initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
        transition={reduced ? { duration: 0 } : { height: active ? spring.smooth : SHRINK, opacity: { duration: duration.standard, ease: standard } }}>
        <div ref={panelRef} className={styles.thoughts} data-clamped={manual !== true || undefined}>
          <StreamText text={answer.thinking ?? ""} streaming={active} reduced={reduced} className={styles.thoughtsText} />
        </div>
      </motion.div>}
    </AnimatePresence>
  </div>;
}

const TOOL_ICON: Record<ChatToolCall["kind"], typeof Search> = { search: Search, read: FileText, image: ImageIcon, code: Code2 };

function Tools({ tools, reduced, id }: { tools: ChatToolCall[]; reduced: boolean; id: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const detail = tools.find(tool => tool.id === open);
  return <div className={styles.tools}>
    <div className={styles.toolRow}>
      <AnimatePresence initial={false}>
        {tools.map(tool => {
          const Icon = TOOL_ICON[tool.kind];
          const running = tool.status === "running";
          return <motion.button key={tool.id} type="button" layout="position" className={styles.toolChip} data-status={tool.status} aria-expanded={open === tool.id}
            aria-controls={open === tool.id ? `${id}-tool` : undefined} disabled={!tool.detail} onClick={() => setOpen(open === tool.id ? null : tool.id)}
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: .97 }} animate={{ opacity: 1, scale: 1 }}
            transition={reduced ? { duration: .12 } : { ...spring.smooth, opacity: { duration: duration.standard, ease: standard } }}>
            <IconSwap id={running ? "run" : tool.status} reduced={reduced}>
              {running ? <LoaderCircle className={styles.spin} size={14} strokeWidth={1.75} /> : tool.status === "error" ? <X size={14} strokeWidth={1.75} /> : <Icon size={14} strokeWidth={1.75} />}
            </IconSwap>
            <span className={styles.toolLabel}>
              <span data-on={running || undefined} aria-hidden={!running || undefined}>{tool.running}</span>
              <span data-on={!running || undefined} aria-hidden={running || undefined}>{tool.done}</span>
            </span>
            {!running && tool.status === "done" && <Check className={styles.toolCheck} size={13} strokeWidth={2} aria-label="Done" />}
          </motion.button>;
        })}
      </AnimatePresence>
    </div>
    <AnimatePresence initial={false}>
      {detail?.detail && <motion.div key="detail" id={`${id}-tool`} className={styles.toolDetailClip} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
        transition={reduced ? { duration: 0 } : { height: spring.smooth, opacity: { duration: duration.fast } }}>
        <p className={styles.toolDetail}><code>{detail.detail}</code></p>
      </motion.div>}
    </AnimatePresence>
  </div>;
}

function Sources({ sources, reduced, id }: { sources: ChatSource[]; reduced: boolean; id: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className={styles.sourcesButton} aria-expanded={open} aria-controls={open ? `${id}-sources` : undefined} onClick={() => setOpen(!open)}>
      <Globe size={15} strokeWidth={1.75} aria-hidden="true" />
      {sources.length} {sources.length === 1 ? "source" : "sources"}
    </button>
    <AnimatePresence initial={false}>
      {open && <motion.div key="list" id={`${id}-sources`} className={styles.sourceListClip} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
        transition={reduced ? { duration: 0 } : { height: spring.smooth, opacity: { duration: duration.fast } }}>
        <ol className={styles.sourceList}>
          {sources.map((source, index) => <li key={source.url}>
            <a href={source.url} target="_blank" rel="noreferrer" className={styles.sourceRow}>
              <span className={styles.sourceRowIndex}>{index + 1}</span>
              <span className={styles.sourceRowText}><span className={styles.sourceRowTitle}>{source.title}</span><span className={styles.sourceRowDomain}>{domainOf(source.url)}</span></span>
              <ArrowUpRight size={14} strokeWidth={1.75} aria-hidden="true" />
            </a>
          </li>)}
        </ol>
      </motion.div>}
    </AnimatePresence>
  </>;
}

/* Messages --------------------------------------------------------------------------------------------------------- */

function Attachments({ items, size = "message" }: { items: AiChatAttachment[]; size?: "message" | "composer" }) {
  return <>{items.map(item => <span key={item.id} className={size === "message" ? styles.messageThumb : styles.thumbImage}>
    {/* Attachments can be object URLs from the file picker, so a plain img is used. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src={item.url} alt={item.name} />
  </span>)}</>;
}

type UserProps = { message: Extract<AiChatMessage, { role: "user" }>; locked: boolean; reduced: boolean; onSave: (text: string) => void };

function UserMessage({ message, locked, reduced, onSave }: UserProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const field = useRef<HTMLTextAreaElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const node = field.current;
    if (!editing || !node) return;
    node.style.height = "0px";
    node.style.height = `${node.scrollHeight}px`;
  }, [draft, editing]);
  useEffect(() => { if (editing) { const node = field.current; node?.focus(); node?.setSelectionRange(node.value.length, node.value.length); } }, [editing]);
  const cancel = () => { setEditing(false); setDraft(message.text); requestAnimationFrame(() => editButton.current?.focus()); };
  const save = () => { const text = draft.trim(); if (!text) return; setEditing(false); if (text !== message.text) onSave(text); };
  const onKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") { event.preventDefault(); cancel(); }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); save(); }
  };
  return <div className={styles.user}>
    {!!message.attachments?.length && <div className={styles.messageThumbs}><Attachments items={message.attachments} /></div>}
    <motion.div layout={!reduced} transition={GROW} className={styles.bubble} data-editing={editing || undefined} style={{ borderRadius: 20 }}>
      <AnimatePresence initial={false} mode="popLayout">
        {editing
          ? <motion.div key="edit" className={styles.editor} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: duration.standard, delay: .05 } }} exit={{ opacity: 0, transition: { duration: .08 } }}>
            <textarea ref={field} className={styles.editField} value={draft} rows={1} aria-label="Edit message" onChange={event => setDraft(event.target.value)} onKeyDown={onKey} />
            <div className={styles.editActions}>
              <button type="button" className={styles.ghostButton} onClick={cancel}>Cancel</button>
              <button type="button" className={styles.solidButton} disabled={!draft.trim() || locked} onClick={save}>Send</button>
            </div>
          </motion.div>
          : <motion.p key="text" className={styles.bubbleText} layout={!reduced ? "position" : false} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: duration.standard, delay: .04 } }} exit={{ opacity: 0, transition: { duration: .08 } }}>{message.text}</motion.p>}
      </AnimatePresence>
    </motion.div>
    {!editing && <div className={styles.userActions}>
      <CopyControl value={message.text} reduced={reduced} iconOnly label="Copy message" className={styles.iconButton} />
      <button ref={editButton} type="button" className={styles.iconButton} aria-label="Edit message" disabled={locked} onClick={() => { setDraft(message.text); setEditing(true); }}>
        <Pencil size={15} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>}
  </div>;
}

type AssistantProps = {
  message: Extract<AiChatMessage, { role: "assistant" }>;
  models: ChatModel[];
  locked: boolean;
  reduced: boolean;
  onRegenerate: () => void;
  onVersion: (index: number) => void;
};

function AssistantMessage({ message, models, locked, reduced, onRegenerate, onVersion }: AssistantProps) {
  const answer = message.versions[message.current];
  const id = useId().replace(/:/g, "");
  const [direction, setDirection] = useState(0);
  const streaming = answer.status === "thinking" || answer.status === "streaming";
  const settled = !streaming;
  const sources = answer.sources ?? [];
  const cite = (n: number, key: string) => <CiteChip key={key} n={n} source={sources[n - 1]} id={`${id}-${message.current}-${key}`} />;
  const model = models.find(entry => entry.id === answer.model)?.name ?? answer.model;
  const count = message.versions.length;
  const go = (step: number) => { setDirection(step); onVersion(Math.min(count - 1, Math.max(0, message.current + step))); };
  const showThinking = !!answer.thinking || (answer.status === "thinking" && !answer.tools?.length);

  return <div className={styles.assistant} aria-busy={streaming || undefined}>
    <AutoHeight reduced={reduced}>
      <AnimatePresence initial={false} mode="popLayout" custom={direction}>
        <motion.div key={message.current} className={styles.answer}
          initial={reduced ? { opacity: 0 } : { opacity: 0, x: direction * 12 }}
          animate={{ opacity: 1, x: 0 }}
          exit={reduced ? { opacity: 0, transition: { duration: .08 } } : { opacity: 0, x: direction * -8, transition: { duration: duration.instant, ease: standard } }}
          transition={reduced ? { duration: .12 } : { x: spring.smooth, opacity: { duration: duration.standard, ease: standard } }}>
          <AnimatePresence initial={false}>
            {showThinking && <motion.div key="thinking" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className={styles.clip}
              transition={reduced ? { duration: 0 } : { height: spring.smooth, opacity: { duration: duration.fast } }}>
              <Thinking answer={answer} reduced={reduced} id={`${id}-${message.current}`} />
            </motion.div>}
          </AnimatePresence>
          {!!answer.tools?.length && <Tools tools={answer.tools} reduced={reduced} id={`${id}-${message.current}`} />}
          {answer.text && <Markdown text={answer.text} streaming={streaming} reduced={reduced} cite={cite} />}
          {answer.status === "error" && <p className={styles.errorNote}>The answer could not be generated.</p>}
        </motion.div>
      </AnimatePresence>
    </AutoHeight>

    {/* The action row keeps its space while the answer streams, so nothing below jumps when it fades in. */}
    <motion.div className={styles.answerFoot} inert={!settled || undefined} aria-hidden={!settled || undefined} initial={false}
      animate={{ opacity: settled ? 1 : 0 }} transition={{ duration: reduced ? 0 : settled ? duration.standard : duration.instant, ease: standard, delay: settled && !reduced ? .08 : 0 }}>
        <div className={styles.answerActions}>
          {count > 1 && <div className={styles.pager} role="group" aria-label="Answer versions">
            <button type="button" className={styles.iconButton} aria-label="Previous version" disabled={message.current === 0 || locked} onClick={() => go(-1)}><ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" /></button>
            <span className={styles.pagerCount} aria-live="polite">{message.current + 1} / {count}</span>
            <button type="button" className={styles.iconButton} aria-label="Next version" disabled={message.current === count - 1 || locked} onClick={() => go(1)}><ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" /></button>
          </div>}
          <CopyControl value={plainText(answer.text)} reduced={reduced} iconOnly label="Copy answer" className={styles.iconButton} />
          <button type="button" className={styles.iconButton} aria-label="Regenerate answer" disabled={locked} onClick={() => { setDirection(1); onRegenerate(); }}>
            <RotateCcw size={15} strokeWidth={1.75} aria-hidden="true" />
          </button>
          {!!sources.length && <Sources sources={sources} reduced={reduced} id={`${id}-${message.current}`} />}
          <span className={styles.answerMeta}>{answer.status === "stopped" ? `Stopped · ${model}` : model}</span>
        </div>
    </motion.div>
  </div>;
}

/* Model switcher --------------------------------------------------------------------------------------------------- */

/**
 * The trigger and its menu are one surface. Opening grows the pill from its own corner into the list; choosing a model shrinks it back
 * around the new name, and the header slot springs to the new width.
 */
function ModelSwitcher({ models, value, onChange, reduced }: { models: ChatModel[]; value: string; onChange: (id: string) => void; reduced: boolean }) {
  const uid = useId().replace(/:/g, "");
  const [open, setOpen] = useState(false);
  const selected = Math.max(0, models.findIndex(model => model.id === value));
  const [active, setActive] = useState(selected);
  const rootRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // "auto" until the first measurement, so the server render already shows the pill at its natural size.
  const width = useMotionValue<number | string>("auto"), height = useMotionValue<number | string>("auto"), radius = useMotionValue(18), slot = useMotionValue<number | string>("auto");
  const hy = useMotionValue(0), hh = useMotionValue(0);
  const ready = useRef(false);
  const live = useRef({ open, reduced });

  const place = useCallback(() => {
    const pill = pillRef.current, menu = menuRef.current;
    if (!pill || !menu) return;
    const closed = { w: pill.offsetWidth, h: pill.offsetHeight }, opened = { w: menu.offsetWidth, h: menu.offsetHeight };
    const { open: isOpen, reduced: still } = live.current;
    const next = isOpen ? { w: Math.max(opened.w, closed.w), h: opened.h, r: 18 } : { w: closed.w, h: closed.h, r: closed.h / 2 };
    if (!ready.current || still) {
      width.jump(next.w); height.jump(next.h); radius.jump(next.r); slot.jump(closed.w);
      ready.current = closed.w > 0;
      return;
    }
    const feel = isOpen ? GROW : SHRINK;
    animate(width as never, next.w, feel); animate(height as never, next.h, feel); animate(radius, next.r, feel);
    animate(slot as never, closed.w, GLIDE);
  }, [height, radius, slot, width]);

  useLayoutEffect(() => { live.current = { open, reduced }; place(); }, [open, reduced, place]);
  useLayoutEffect(() => {
    const pill = pillRef.current, menu = menuRef.current;
    if (!pill || !menu || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => place());
    observer.observe(pill); observer.observe(menu);
    return () => observer.disconnect();
  }, [place]);

  // The row highlight glides between options; it jumps into place when the menu opens.
  useLayoutEffect(() => {
    const row = listRef.current?.children[active] as HTMLElement | undefined;
    if (!row) return;
    if (!open || reduced) { hy.jump(row.offsetTop); hh.jump(row.offsetHeight); return; }
    animate(hy, row.offsetTop, GLIDE); animate(hh, row.offsetHeight, GLIDE);
  }, [active, open, reduced, hh, hy]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.focus({ preventScroll: true });
    const down = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }, [open]);

  const close = (focus = true) => { setOpen(false); if (focus) requestAnimationFrame(() => pillRef.current?.focus({ preventScroll: true })); };
  const choose = (index: number) => { const model = models[index]; if (model) onChange(model.id); close(); };
  const onListKey = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1 };
    if (event.key in moves) { event.preventDefault(); setActive((active + moves[event.key] + models.length) % models.length); return; }
    if (event.key === "Home" || event.key === "End") { event.preventDefault(); setActive(event.key === "Home" ? 0 : models.length - 1); return; }
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(active); return; }
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (event.key === "Tab") close(false);
  };
  const current = models[selected];
  return <motion.div ref={rootRef} className={styles.switcher} style={{ width: slot }} data-open={open || undefined}>
    <span className={styles.switcherSizer} aria-hidden="true">{current?.name}<ChevronDown size={15} strokeWidth={1.75} /></span>
    <motion.div className={styles.switcherSurface} style={{ width, height, borderRadius: radius }}>
      <motion.button ref={pillRef} type="button" className={styles.switcherPill} aria-haspopup="listbox" aria-expanded={open} aria-controls={`${uid}-models`}
        inert={open || undefined} initial={false}
        animate={open ? (reduced ? { opacity: 0 } : { opacity: 0, filter: `blur(${blur.subtle}px)` }) : { opacity: 1, filter: "blur(0px)" }}
        transition={open ? { duration: .1, ease: standard } : { duration: duration.standard, ease: enter, delay: reduced ? 0 : .08 }}
        onClick={() => { setActive(selected); setOpen(true); }}
        onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); setActive(selected); setOpen(true); } }}>
        <span>{current?.name}</span>
        <ChevronDown size={15} strokeWidth={1.75} aria-hidden="true" />
      </motion.button>
      <motion.div ref={menuRef} className={styles.switcherMenu} inert={!open || undefined} initial={false}
        animate={open ? { opacity: 1, y: 0, filter: "blur(0px)" } : (reduced ? { opacity: 0 } : { opacity: 0, y: -4, filter: `blur(${blur.subtle}px)` })}
        transition={open ? { duration: duration.standard, ease: enter, delay: reduced ? 0 : .05 } : { duration: .1, ease: standard }}>
        <p className={styles.switcherHeading} id={`${uid}-label`}>Model</p>
        <div className={styles.switcherListWrap}>
          <motion.span className={styles.switcherHighlight} style={{ y: hy, height: hh }} aria-hidden="true" />
          <ul ref={listRef} id={`${uid}-models`} className={styles.switcherList} role="listbox" tabIndex={-1} aria-labelledby={`${uid}-label`}
            aria-activedescendant={open ? `${uid}-model-${active}` : undefined} onKeyDown={onListKey}>
            {models.map((model, index) => <li key={model.id} id={`${uid}-model-${index}`} role="option" aria-selected={index === selected} className={styles.switcherOption}
              onPointerMove={() => { if (active !== index) setActive(index); }} onClick={() => choose(index)}>
              <span className={styles.switcherText}><span className={styles.switcherName}>{model.name}</span><span className={styles.switcherDescription}>{model.description}</span></span>
              <Check className={styles.switcherCheck} data-on={index === selected || undefined} size={16} strokeWidth={1.75} aria-hidden="true" />
            </li>)}
          </ul>
        </div>
      </motion.div>
    </motion.div>
  </motion.div>;
}

/* Composer --------------------------------------------------------------------------------------------------------- */

type ComposerProps = {
  busy: boolean;
  reduced: boolean;
  onSend: (text: string, attachments: AiChatAttachment[]) => void;
  onStop: () => void;
  focusKey: string;
};

function Composer({ busy, reduced, onSend, onStop, focusKey }: ComposerProps) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<AiChatAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const canSend = !!text.trim() || files.length > 0;

  useLayoutEffect(() => {
    const node = field.current;
    if (!node) return;
    node.style.height = "0px";
    node.style.height = `${Math.min(168, node.scrollHeight)}px`;
  }, [text]);
  const mounted = useRef(false);
  // Switching conversations puts the caret back in the composer; the first mount leaves page focus alone.
  useEffect(() => { if (mounted.current) field.current?.focus({ preventScroll: true }); mounted.current = true; }, [focusKey]);

  const addFiles = (list: FileList | File[]) => {
    const images = Array.from(list).filter(file => file.type.startsWith("image/")).slice(0, 4);
    if (!images.length) return;
    setFiles(current => [...current, ...images.map(file => ({ id: makeId("file"), name: file.name || "Pasted image", url: URL.createObjectURL(file) }))].slice(0, 4));
  };
  const remove = (id: string) => setFiles(current => {
    const gone = current.find(file => file.id === id);
    if (gone?.url.startsWith("blob:")) URL.revokeObjectURL(gone.url);
    return current.filter(file => file.id !== id);
  });
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) { onStop(); return; }
    if (!canSend) return;
    onSend(text.trim() || "What do you see in this image?", files);
    setText(""); setFiles([]);
  };
  const onKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!busy) submit(); }
    if (event.key === "Escape" && busy) { event.preventDefault(); onStop(); }
  };
  const onPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => { if (event.clipboardData.files.length) { event.preventDefault(); addFiles(event.clipboardData.files); } };
  const onDrop = (event: ReactDragEvent<HTMLFormElement>) => { event.preventDefault(); setDragging(false); if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files); };

  return <form className={styles.composer} data-dragging={dragging || undefined} onSubmit={submit}
    onDragOver={event => { if (Array.from(event.dataTransfer.types).includes("Files")) { event.preventDefault(); setDragging(true); } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }} onDrop={onDrop}>
    <AnimatePresence initial={false}>
      {files.length > 0 && <motion.div key="thumbs" className={styles.clip} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
        transition={reduced ? { duration: 0 } : { height: spring.smooth, opacity: { duration: duration.fast } }}>
        <ul className={styles.thumbs} aria-label="Attachments">
          <AnimatePresence initial={false} mode="popLayout">
            {files.map(file => <motion.li key={file.id} layout={!reduced} className={styles.thumb}
              initial={reduced ? { opacity: 0 } : { opacity: 0, scale: .9 }} animate={{ opacity: 1, scale: 1 }} exit={reduced ? { opacity: 0 } : { opacity: 0, scale: .9, transition: { duration: duration.instant } }}
              transition={reduced ? { duration: .1 } : spring.snappy}>
              <Attachments items={[file]} size="composer" />
              <button type="button" className={styles.thumbRemove} aria-label={`Remove ${file.name}`} onClick={() => remove(file.id)}><X size={12} strokeWidth={2} aria-hidden="true" /></button>
            </motion.li>)}
          </AnimatePresence>
        </ul>
      </motion.div>}
    </AnimatePresence>
    <textarea ref={field} className={styles.field} rows={1} value={text} placeholder="Ask anything" aria-label="Message"
      onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setText(event.target.value)} onKeyDown={onKey} onPaste={onPaste} />
    <div className={styles.composerBar}>
      <button type="button" className={styles.iconButton} aria-label="Attach images" onClick={() => picker.current?.click()} disabled={files.length >= 4}>
        <Paperclip size={17} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <input ref={picker} type="file" accept="image/*" multiple hidden onChange={event => { if (event.target.files) addFiles(event.target.files); event.target.value = ""; }} />
      <span className={styles.composerHint}>Enter to send, Shift Enter for a new line</span>
      <button type="submit" className={styles.send} data-busy={busy || undefined} aria-label={busy ? "Stop generating" : "Send message"} disabled={!busy && !canSend}>
        <IconSwap id={busy ? "stop" : "send"} reduced={reduced}>
          {busy ? <span className={styles.stopGlyph} /> : <ArrowUp size={18} strokeWidth={2} />}
        </IconSwap>
      </button>
    </div>
  </form>;
}

/* Block ------------------------------------------------------------------------------------------------------------ */

/**
 * A complete AI chat surface: a collapsible conversation list, streamed markdown answers whose words settle in, reasoning that folds
 * away when the answer starts, tool call chips, citations that open source cards, regenerate with versions, editable prompts, a model
 * switcher that morphs out of its own pill, image attachments, and a send button that becomes stop.
 * Connect `respond` to your model; the default responder streams scripted samples.
 */
export interface AiChatProps {
  /** Initial conversations. The block owns them afterwards; follow changes with `onConversationsChange`. */
  defaultConversations?: ChatConversation[];
  onConversationsChange?: (conversations: ChatConversation[]) => void;
  /** Open conversation id, or null for a new chat. */
  activeId?: string | null;
  defaultActiveId?: string | null;
  onActiveChange?: (id: string | null) => void;
  models?: ChatModel[];
  model?: string;
  defaultModel?: string;
  onModelChange?: (id: string) => void;
  sidebarOpen?: boolean;
  defaultSidebarOpen?: boolean;
  onSidebarOpenChange?: (open: boolean) => void;
  /** Prompts offered on an empty chat. */
  suggestions?: ChatSuggestion[];
  /** Streams an answer. Defaults to `sampleResponder`, which plays scripted samples. */
  respond?: ChatResponder;
  greeting?: string;
  /** A small note in the header, such as "Sample responses". Pass null to hide it. */
  notice?: ReactNode;
  user?: { name: string; avatar?: string; detail?: string };
  className?: string;
}

type Busy = { conversation: string; message: string } | null;

export function AiChat({
  defaultConversations = sampleConversations, onConversationsChange, activeId: activeProp, defaultActiveId = null, onActiveChange,
  models = sampleModels, model: modelProp, defaultModel = "atlas", onModelChange, sidebarOpen: sidebarProp, defaultSidebarOpen = true, onSidebarOpenChange,
  suggestions = sampleSuggestions, respond = sampleResponder, greeting = "What are we working on?", notice = "Sample responses",
  user = { name: "Emma Collins", avatar: "/media/people/emma-collins.jpg", detail: "Team plan" }, className,
}: AiChatProps) {
  const reduced = useReducedFlag();
  const uid = useId().replace(/:/g, "");
  const [conversations, setConversations] = useState(defaultConversations);
  const [activeId, setActiveId] = useControllable(activeProp, defaultActiveId, onActiveChange);
  const [model, setModel] = useControllable(modelProp, defaultModel, onModelChange);
  const [sidebarWide, setSidebarWide] = useControllable(sidebarProp, defaultSidebarOpen, onSidebarOpenChange);
  const [drawer, setDrawer] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [stuck, setStuck] = useState(true);
  const [card, setCard] = useState<CardState | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const controller = useRef<AbortController | null>(null);
  const stick = useRef(true);
  const hideTimer = useRef(0);
  const first = useRef(true);

  const active = conversations.find(conversation => conversation.id === activeId) ?? null;
  const sidebarVisible = narrow ? drawer : sidebarWide;
  const busyHere = !!busy && busy.conversation === activeId;

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    onConversationsChange?.(conversations);
  }, [conversations, onConversationsChange]);
  useEffect(() => () => controller.current?.abort(), []);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setNarrow(root.offsetWidth < NARROW));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // The thread follows new content while it is pinned to the bottom; scrolling up releases it.
  useLayoutEffect(() => {
    const thread = threadRef.current, content = contentRef.current;
    if (!thread || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (stick.current) thread.scrollTop = thread.scrollHeight; });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  const onScroll = () => {
    const thread = threadRef.current;
    if (!thread) return;
    const gap = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
    stick.current = gap < 56;
    if (stick.current !== stuck) setStuck(stick.current);
    if (card) setCard(null);
  };
  const toBottom = (smooth = true) => {
    const thread = threadRef.current;
    stick.current = true; setStuck(true);
    thread?.scrollTo({ top: thread.scrollHeight, behavior: smooth && !reduced ? "smooth" : "auto" });
  };

  /* Updates */
  const patchAnswer = useCallback((conversationId: string, messageId: string, version: number, update: (answer: ChatAnswer) => ChatAnswer) => {
    setConversations(list => list.map(conversation => conversation.id !== conversationId ? conversation : {
      ...conversation,
      messages: conversation.messages.map(message => message.id !== messageId || message.role !== "assistant" ? message : {
        ...message, versions: message.versions.map((answer, index) => index === version ? update(answer) : answer),
      }),
    }));
  }, []);

  const generate = useCallback(async (conversationId: string, messageId: string, version: number, history: AiChatMessage[], modelId: string) => {
    controller.current?.abort();
    const run = new AbortController();
    controller.current = run;
    setBusy({ conversation: conversationId, message: messageId });
    setAnnounce("Generating an answer");
    const lastUser = [...history].reverse().find(message => message.role === "user") as Extract<AiChatMessage, { role: "user" }> | undefined;
    const startedAt = performance.now();
    let thinkingSince: number | null = null;
    const seconds = () => thinkingSince === null ? undefined : Math.max(1, Math.round((performance.now() - thinkingSince) / 1000));
    const apply = (answer: ChatAnswer, event: ChatStreamEvent): ChatAnswer => {
      switch (event.type) {
        case "thinking": return { ...answer, thinking: (answer.thinking ?? "") + event.text, status: "thinking" };
        case "tool": {
          const tools = answer.tools ?? [];
          const exists = tools.some(tool => tool.id === event.tool.id);
          // A tool call ends the reasoning phase, so the thinking panel folds away as the first chip arrives.
          return { ...answer, tools: exists ? tools.map(tool => tool.id === event.tool.id ? event.tool : tool) : [...tools, event.tool], status: "streaming", thoughtFor: answer.thoughtFor ?? seconds() };
        }
        case "sources": return { ...answer, sources: event.sources };
        case "text": return { ...answer, text: answer.text + event.text, status: "streaming", thoughtFor: answer.thoughtFor ?? seconds() };
      }
    };
    try {
      for await (const event of respond({ conversationId, messages: history, prompt: lastUser?.text ?? "", attachments: lastUser?.attachments ?? [], model: modelId }, run.signal)) {
        if (run.signal.aborted) break;
        if (event.type === "thinking" && thinkingSince === null) thinkingSince = performance.now();
        patchAnswer(conversationId, messageId, version, answer => apply(answer, event));
      }
      if (run.signal.aborted) throw run.signal.reason;
      patchAnswer(conversationId, messageId, version, answer => ({ ...answer, status: "done", thoughtFor: answer.thoughtFor ?? seconds() }));
      setAnnounce(`Answer ready in ${Math.max(1, Math.round((performance.now() - startedAt) / 1000))} seconds`);
    } catch {
      const stopped = run.signal.aborted;
      patchAnswer(conversationId, messageId, version, answer => ({ ...answer, status: stopped ? "stopped" : "error", thoughtFor: answer.thoughtFor ?? seconds() }));
      setAnnounce(stopped ? "Stopped" : "The answer could not be generated");
    } finally {
      if (controller.current === run) { controller.current = null; setBusy(null); }
    }
  }, [patchAnswer, respond]);

  const stop = () => controller.current?.abort();

  const send = (text: string, attachments: AiChatAttachment[], title?: string) => {
    const userMessage: AiChatMessage = { id: makeId("user"), role: "user", text, attachments: attachments.length ? attachments : undefined };
    const reply: AiChatMessage = { id: makeId("answer"), role: "assistant", current: 0, versions: [{ text: "", status: "thinking", model }] };
    let conversationId = activeId;
    let history: AiChatMessage[];
    if (!active) {
      conversationId = makeId("chat");
      history = [userMessage];
      const created: ChatConversation = { id: conversationId, title: title ?? titleFrom(text), group: "Today", messages: [userMessage, reply] };
      setConversations(list => [created, ...list]);
      setFresh(conversationId);
      setActiveId(conversationId);
    } else {
      history = [...active.messages, userMessage];
      setConversations(list => list.map(conversation => conversation.id === active.id ? { ...conversation, messages: [...conversation.messages, userMessage, reply] } : conversation));
    }
    requestAnimationFrame(() => toBottom());
    void generate(conversationId!, reply.id, 0, history, model);
  };

  const regenerate = (messageId: string) => {
    if (!active || busy) return;
    const at = active.messages.findIndex(message => message.id === messageId);
    const target = active.messages[at];
    if (!target || target.role !== "assistant") return;
    const version = target.versions.length;
    setConversations(list => list.map(conversation => conversation.id !== active.id ? conversation : {
      ...conversation,
      messages: conversation.messages.map(message => message.id === messageId && message.role === "assistant" ? { ...message, current: version, versions: [...message.versions, { text: "", status: "thinking", model }] } : message),
    }));
    void generate(active.id, messageId, version, active.messages.slice(0, at), model);
  };

  const setVersion = (messageId: string, index: number) => {
    if (!active) return;
    setConversations(list => list.map(conversation => conversation.id !== active.id ? conversation : {
      ...conversation, messages: conversation.messages.map(message => message.id === messageId && message.role === "assistant" ? { ...message, current: index } : message),
    }));
  };

  const editPrompt = (messageId: string, text: string) => {
    if (!active || busy) return;
    const at = active.messages.findIndex(message => message.id === messageId);
    const original = active.messages[at];
    if (!original || original.role !== "user") return;
    const edited: AiChatMessage = { ...original, text };
    const reply: AiChatMessage = { id: makeId("answer"), role: "assistant", current: 0, versions: [{ text: "", status: "thinking", model }] };
    const history = [...active.messages.slice(0, at), edited];
    setConversations(list => list.map(conversation => conversation.id === active.id ? { ...conversation, messages: [...history, reply] } : conversation));
    stick.current = true;
    void generate(active.id, reply.id, 0, history, model);
  };

  const openConversation = (id: string | null) => {
    setCard(null);
    setActiveId(id);
    stick.current = true; setStuck(true);
    if (narrow) setDrawer(false);
    requestAnimationFrame(() => { const thread = threadRef.current; if (thread) thread.scrollTop = id ? thread.scrollHeight : 0; });
  };

  const closeRef = useRef<HTMLButtonElement>(null);
  /** Focus follows the control that replaces the one just pressed. */
  const toggleSidebar = () => {
    const opening = !sidebarVisible;
    if (narrow) setDrawer(opening); else setSidebarWide(opening);
    requestAnimationFrame(() => (opening ? closeRef.current : toggleRef.current)?.focus({ preventScroll: true }));
  };

  // Escape closes the drawer and hands focus back to its toggle.
  useEffect(() => {
    if (!narrow || !drawer) return;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { setDrawer(false); toggleRef.current?.focus(); } };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [drawer, narrow]);

  /* Citation cards */
  const cardId = `${uid}-source`;
  const place = useCallback((source: ChatSource, n: number, anchor: HTMLElement, key: string): CardState | null => {
    const root = rootRef.current;
    if (!root) return null;
    const box = root.getBoundingClientRect(), chip = anchor.getBoundingClientRect();
    const width = Math.min(300, box.width - 24);
    const center = chip.left + chip.width / 2 - box.left;
    const x = Math.min(box.width - width - 12, Math.max(12, center - width / 2));
    const below = chip.top - box.top < 200;
    return below
      ? { source, n, key, width, x, below, origin: center - x, top: chip.bottom - box.top + 8 }
      : { source, n, key, width, x, below, origin: center - x, bottom: box.bottom - chip.top + 8 };
  }, []);
  const citeApi = useMemo<CiteApi>(() => ({
    cardId,
    openKey: card?.key ?? null,
    show: (source, n, anchor, key) => {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => setCard(place(source, n, anchor, key)), card ? 0 : 90);
    },
    hide: (delay = 0) => { window.clearTimeout(hideTimer.current); hideTimer.current = window.setTimeout(() => setCard(null), delay); },
    keep: () => window.clearTimeout(hideTimer.current),
    toggle: (source, n, anchor, key, mouse) => {
      window.clearTimeout(hideTimer.current);
      // A mouse has already opened the card on hover, so its click keeps it open; touch and keyboard toggle.
      setCard(current => current?.key === key ? (mouse ? current : null) : place(source, n, anchor, key));
    },
  }), [card, cardId, place]);
  useEffect(() => {
    if (!card) return;
    const down = (event: PointerEvent) => { const target = event.target as HTMLElement; if (!target.closest(`.${styles.sourceCard}, .${styles.cite}`)) setCard(null); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setCard(null); };
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", down); document.removeEventListener("keydown", key); };
  }, [card]);
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  const groups = useMemo(() => {
    const order: string[] = [];
    const byGroup = new Map<string, ChatConversation[]>();
    for (const conversation of conversations) {
      if (!byGroup.has(conversation.group)) { byGroup.set(conversation.group, []); order.push(conversation.group); }
      byGroup.get(conversation.group)!.push(conversation);
    }
    return order.map(group => ({ group, items: byGroup.get(group)! }));
  }, [conversations]);

  const sidebar = <div className={styles.sidebarInner}>
    <div className={styles.sidebarTop}>
      <button ref={closeRef} type="button" className={styles.iconButton} aria-label="Close sidebar" onClick={toggleSidebar}><PanelLeftClose size={18} strokeWidth={1.75} aria-hidden="true" /></button>
      <button type="button" className={styles.newChat} onClick={() => openConversation(null)} aria-current={activeId === null || undefined}>
        <SquarePen size={16} strokeWidth={1.75} aria-hidden="true" />New chat
      </button>
    </div>
    <nav className={styles.history} aria-label="Conversations">
      <LayoutGroup id={`${uid}-history`}>
        {groups.map(({ group, items }) => <div key={group} className={styles.historyGroup}>
          <p className={styles.historyHeading}>{group}</p>
          <ul className={styles.historyList}>
            <AnimatePresence initial={false}>
              {items.map(conversation => {
                const current = conversation.id === activeId;
                const working = busy?.conversation === conversation.id;
                return <motion.li key={conversation.id} className={styles.historyItem}
                  initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} transition={reduced ? { duration: .1 } : { height: spring.smooth, opacity: { duration: duration.standard, delay: .06 } }}>
                  <button type="button" className={styles.historyButton} aria-current={current ? "page" : undefined} onClick={() => openConversation(conversation.id)}>
                    {current && <motion.span layoutId="active" className={styles.historyHighlight} transition={reduced ? { duration: 0 } : GLIDE} aria-hidden="true" />}
                    <span className={styles.historyTitle}>
                      {conversation.id === fresh ? <TextScramble trigger="mount" glyphs="abcdefghijklmnopqrstuvwxyz" duration={.8}>{conversation.title}</TextScramble> : conversation.title}
                    </span>
                    {working && <LoaderCircle className={`${styles.spin} ${styles.historyBusy}`} size={14} strokeWidth={1.75} aria-label="Generating" />}
                  </button>
                </motion.li>;
              })}
            </AnimatePresence>
          </ul>
        </div>)}
      </LayoutGroup>
    </nav>
    <div className={styles.account}>
      {user.avatar
        // eslint-disable-next-line @next/next/no-img-element
        ? <img className={styles.avatar} src={user.avatar} alt="" width={28} height={28} />
        : <span className={styles.avatar} aria-hidden="true" />}
      <span className={styles.accountText}><span className={styles.accountName}>{user.name}</span>{user.detail && <span className={styles.accountDetail}>{user.detail}</span>}</span>
    </div>
  </div>;

  return <CiteContext.Provider value={citeApi}>
    <div ref={rootRef} className={[styles.root, className].filter(Boolean).join(" ")} data-narrow={narrow || undefined}>
      {/* Wide layouts give the list its own column that springs open and shut; narrow ones slide it over the thread. */}
      {!narrow && <motion.aside className={styles.sidebar} aria-label="Chat history" initial={false} animate={{ width: sidebarVisible ? 264 : 0 }}
        transition={reduced ? { duration: 0 } : sidebarVisible ? GROW : SHRINK} inert={!sidebarVisible || undefined}>
        <motion.div className={styles.sidebarSlide} initial={false} animate={{ opacity: sidebarVisible ? 1 : 0, x: sidebarVisible || reduced ? 0 : -16 }} transition={{ duration: duration.standard, ease: enter }}>{sidebar}</motion.div>
      </motion.aside>}
      <AnimatePresence>
        {narrow && drawer && <>
          <motion.div key="scrim" className={styles.scrim} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: duration.standard }} onClick={() => setDrawer(false)} />
          <motion.aside key="drawer" className={styles.drawer} aria-label="Chat history" initial={reduced ? { opacity: 0 } : { x: "-104%" }} animate={reduced ? { opacity: 1 } : { x: 0 }} exit={reduced ? { opacity: 0 } : { x: "-104%" }}
            transition={reduced ? { duration: .12 } : spring.smooth}>{sidebar}</motion.aside>
        </>}
      </AnimatePresence>

      <section className={styles.main} aria-label={active?.title ?? "New chat"}>
        <header className={styles.header}>
          <AnimatePresence initial={false}>
            {!sidebarVisible && <motion.div key="tools" className={styles.headerTools} initial={reduced ? { opacity: 0 } : { opacity: 0, width: 0 }} animate={{ opacity: 1, width: "auto" }} exit={reduced ? { opacity: 0 } : { opacity: 0, width: 0 }}
              transition={reduced ? { duration: .1 } : { width: sidebarVisible ? SHRINK : GROW, opacity: { duration: duration.fast } }}>
              <button ref={toggleRef} type="button" className={styles.iconButton} aria-label="Open sidebar" aria-expanded={false} onClick={toggleSidebar}><PanelLeft size={18} strokeWidth={1.75} aria-hidden="true" /></button>
              <button type="button" className={styles.iconButton} aria-label="New chat" onClick={() => openConversation(null)}><SquarePen size={17} strokeWidth={1.75} aria-hidden="true" /></button>
            </motion.div>}
          </AnimatePresence>
          <ModelSwitcher models={models} value={model} onChange={setModel} reduced={reduced} />
          {notice && <span className={styles.notice}>{notice}</span>}
        </header>

        <div ref={threadRef} className={styles.thread} onScroll={onScroll}>
          <div ref={contentRef} className={styles.threadContent}>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div key={activeId ?? "new"} className={styles.page}
                initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: { duration: .1 } }} transition={reduced ? { duration: .12 } : { duration: duration.standard, ease: enter }}>
                {!active
                  ? <div className={styles.empty}>
                    <h3 className={styles.greeting}>{greeting}</h3>
                    <ul className={styles.suggestions}>
                      {suggestions.map((suggestion, index) => <motion.li key={suggestion.label}
                        initial={reduced ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: duration.considered, ease: enter, delay: reduced ? 0 : .04 + index * motionTokens.stagger.item * 1.5 }}>
                        <button type="button" className={styles.suggestion} onClick={() => send(suggestion.prompt, suggestion.attachments ?? [], suggestion.label)}>
                          <span className={styles.suggestionLabel}>{suggestion.label}</span>
                          {suggestion.attachments?.[0]
                            // eslint-disable-next-line @next/next/no-img-element
                            ? <img className={styles.suggestionThumb} src={suggestion.attachments[0].url} alt="" />
                            : <ArrowUpRight className={styles.suggestionArrow} size={16} strokeWidth={1.75} aria-hidden="true" />}
                        </button>
                      </motion.li>)}
                    </ul>
                  </div>
                  : <ol className={styles.messages}>
                    <AnimatePresence initial={false}>
                      {active.messages.map(message => <motion.li key={message.id} className={styles.messageItem} data-role={message.role}
                        initial={reduced ? { opacity: 0 } : message.role === "user" ? { opacity: 0, y: 14, scale: .98 } : { opacity: 0 }} animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, transition: { duration: .12 } }}
                        transition={reduced ? { duration: .12 } : { ...spring.smooth, opacity: { duration: duration.standard, ease: enter } }} style={{ transformOrigin: "100% 100%" }}>
                        {message.role === "user"
                          ? <UserMessage message={message} locked={!!busy} reduced={reduced} onSave={text => editPrompt(message.id, text)} />
                          : <AssistantMessage message={message} models={models} locked={!!busy} reduced={reduced} onRegenerate={() => regenerate(message.id)} onVersion={index => setVersion(message.id, index)} />}
                      </motion.li>)}
                    </AnimatePresence>
                  </ol>}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>

        <div className={styles.dock}>
          <AnimatePresence>
            {!stuck && active && <motion.button key="jump" type="button" className={styles.jump} aria-label="Jump to latest" onClick={() => toBottom()}
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8, scale: .9 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reduced ? { opacity: 0 } : { opacity: 0, y: 8, scale: .9 }} transition={reduced ? { duration: .1 } : spring.snappy}>
              <ArrowDown size={16} strokeWidth={1.75} aria-hidden="true" />
            </motion.button>}
          </AnimatePresence>
          <Composer busy={busyHere} reduced={reduced} onSend={send} onStop={stop} focusKey={activeId ?? "new"} />
        </div>
      </section>

      <AnimatePresence>
        {card && <SourceCard key={card.key} card={card} id={cardId} reduced={reduced} onEnter={citeApi.keep} onLeave={citeApi.hide} />}
      </AnimatePresence>
      <p className={styles.srOnly} aria-live="polite">{announce}</p>
    </div>
  </CiteContext.Provider>;
}

export default AiChat;
