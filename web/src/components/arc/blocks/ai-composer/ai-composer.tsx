"use client";

// Arc UI ai-composer block, adapted for a controlled Agent conversation.
// Demo replies, sample attachments and simulated streaming are intentionally removed.
import { useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowUp } from "lucide-react";
import { motionTokens } from "../../lib/motion-tokens";
import { CopyButton } from "../../copy-button/copy-button";
import { TextShimmer } from "../../text-shimmer/text-shimmer";
import { NoteMarkdown } from "../../../../NoteMarkdown";
import styles from "./ai-composer.module.css";

export type AiComposerMessage = { id: number; role: "user" | "assistant"; text: string };

export interface AiComposerProps {
  title: string;
  subtitle?: ReactNode;
  headerActions?: ReactNode;
  context?: ReactNode;
  messages: AiComposerMessage[];
  value: string;
  onValueChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  activity?: string;
  onOpenNote?: (name: string) => void;
  disabled?: boolean;
  emptyTitle: string;
  emptyText: string;
  suggestions?: { label: string; prompt: string }[];
  children?: ReactNode;
}

const easeStandard = [...motionTokens.ease.standard] as [number, number, number, number];

/** Arc's autosizing composer follows its content without jumping. */
function AutoHeight({ children }: { children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | "auto">("auto");
  const reduced = useReducedMotion();
  useLayoutEffect(() => {
    const node = inner.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(node.offsetHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <motion.div className={styles.autoHeight} initial={false} animate={{ height }} transition={reduced ? { duration: 0 } : motionTokens.spring.smooth}><div ref={inner}>{children}</div></motion.div>;
}

/** Arc's send button morphs into a stop control while the real request is pending. */
function SendButton({ busy, disabled, onSend, onStop }: { busy: boolean; disabled: boolean; onSend: () => void; onStop: () => void }) {
  const reduced = useReducedMotion();
  const hidden = reduced ? { opacity: 0 } : { opacity: 0, scale: .8 };
  return <motion.button type="button" className={styles.send} data-busy={busy || undefined} disabled={disabled} onClick={busy ? onStop : onSend} aria-label={busy ? "停止生成" : "发送消息"}
    initial={false} animate={{ width: busy ? 84 : 36 }} transition={reduced ? { duration: 0 } : motionTokens.spring.morph}>
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span key={busy ? "stop" : "send"} className={styles.sendFace} initial={hidden} animate={{ opacity: 1, scale: 1 }} exit={{ ...hidden, transition: { duration: motionTokens.duration.instant } }}
        transition={reduced ? { duration: motionTokens.duration.instant } : { ...motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.fast, delay: .05 } }}>
        {busy ? <><span className={styles.stopGlyph}/>停止</> : <ArrowUp size={18} strokeWidth={2} aria-hidden="true"/>}
      </motion.span>
    </AnimatePresence>
  </motion.button>;
}

export function AiComposer({ title, subtitle, headerActions, context, messages, value, onValueChange, onSend, onStop, busy, activity = "正在思考…", onOpenNote, disabled, emptyTitle, emptyText, suggestions = [], children }: AiComposerProps) {
  const reduced = useReducedMotion();
  const inputId = useId();
  const threadRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Keep the newest response visible, but preserve the reader's position when they scroll up.
  useLayoutEffect(() => {
    const thread = threadRef.current, inner = thread?.firstElementChild as HTMLElement | null;
    if (!thread || !inner || typeof ResizeObserver === "undefined") return;
    let last = inner.offsetHeight;
    const observer = new ResizeObserver(() => {
      const next = inner.offsetHeight, grew = next - last;
      last = next;
      if (grew > 0 && thread.scrollTop < -24) thread.scrollTop -= grew;
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 168)}px`;
  }, [value]);

  function send() {
    if (busy || disabled || !value.trim()) return;
    onSend();
    const thread = threadRef.current;
    if (thread) thread.scrollTop = 0;
  }
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); }
    else if (event.key === "Escape" && busy) { event.preventDefault(); onStop(); }
  }
  function applySuggestion(prompt: string) {
    onValueChange(prompt);
    textareaRef.current?.focus();
  }

  return <section className={styles.root} aria-label={title}>
    <header className={styles.header}>
      <div className={styles.heading}><h2 className={styles.title}>{title}</h2>{subtitle && <div className={styles.subtitle}>{subtitle}</div>}</div>
      {headerActions}
    </header>
    {context && <div className={styles.context}>{context}</div>}
    <div className={styles.stage}>
      <div ref={threadRef} className={styles.thread}>
        <div className={styles.threadInner}>
          <div role="log" aria-label="AI 对话" aria-live="polite" aria-relevant="additions">
            {messages.map(message => <div key={message.id} className={styles.messagePad}>
              {message.role === "user" ? <div className={styles.userRow}>
                <span className={styles.userCopy}><CopyButton value={message.text} label="复制消息" iconOnly variant="plain"/></span>
                <div className={styles.bubble}><span className={styles.srOnly}>你：</span><span className={styles.bubbleText}>{message.text}</span></div>
              </div> : <div className={styles.assistant}><span className={styles.meta}>AI 助手</span><div className={styles.answer}><NoteMarkdown onOpenNote={onOpenNote}>{message.text}</NoteMarkdown></div></div>}
            </div>)}
          </div>
          {busy && <div className={styles.messagePad}><TextShimmer className={styles.meta}>{activity}</TextShimmer></div>}
          {children}
        </div>
      </div>
      {!messages.length && <motion.div className={styles.empty} initial={reduced ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: motionTokens.duration.standard, ease: easeStandard }}>
        <h3 className={styles.emptyTitle}>{emptyTitle}</h3><p className={styles.emptyText}>{emptyText}</p>
      </motion.div>}
    </div>
    <div className={styles.dock}><div className={styles.dockInner}>
      {!messages.length && <div className={styles.suggestions} role="group" aria-label="建议话题">
        {suggestions.map(item => <button key={item.label} type="button" className={styles.suggestion} data-active={value === item.prompt || undefined} onClick={() => applySuggestion(item.prompt)}>{item.label}</button>)}
      </div>}
      <div className={styles.composer}>
        <AutoHeight><div className={styles.textPad}>
          <label className={styles.srOnly} htmlFor={inputId}>AI 消息</label>
          <textarea id={inputId} ref={textareaRef} className={styles.input} rows={3} value={value} placeholder="聊一聊，或交给我一件事…" onChange={event => onValueChange(event.target.value)} onKeyDown={handleKeyDown}/>
        </div></AutoHeight>
        <div className={styles.toolbar}><span className={styles.spacer}/><SendButton busy={busy} disabled={!busy && (!!disabled || !value.trim())} onSend={send} onStop={onStop}/></div>
      </div>
    </div></div>
    <p className={styles.srOnly} role="status" aria-live="polite">{busy ? activity : ""}</p>
  </section>;
}

export default AiComposer;
