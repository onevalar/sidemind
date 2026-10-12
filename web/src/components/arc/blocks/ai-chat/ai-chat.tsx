"use client";

// Arc Pro AI Chat, adapted from anvalar/arc-ui custom/arc/blocks/ai-chat.
// Keep the source thread, message, suggestion and composer surfaces. The app
// owns persistence and tool execution; do not restore the template responder.
import { useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowDown, ArrowDownToLine, ArrowUp, Settings, SquarePen, X } from "lucide-react";
import { motionTokens } from "../../lib/motion-tokens";
import { Button } from "../../button/button";
import { CopyButton } from "../../copy-button/copy-button";
import { TextShimmer } from "../../text-shimmer/text-shimmer";
import { NoteMarkdown } from "../../../../NoteMarkdown";
import styles from "./ai-chat.module.css";
import { composing } from '../../../../ime'

export type AiChatMessage = { id: number; role: "user" | "assistant"; text: string };

export interface AiChatProps {
  title: string;
  model: string | null;
  onConfigure: () => void;
  onNew: () => void;
  onClose: () => void;
  context?: ReactNode;
  messages: AiChatMessage[];
  value: string;
  onValueChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  locked?: boolean;
  activity?: string;
  onOpenNote?: (name: string) => void;
  disabled?: boolean;
  emptyTitle: string;
  emptyText: string;
  suggestions?: { label: string; prompt: string }[];
  streaming?: string;
  children?: ReactNode;
}

function IconSwap({ id, children }: { id: string; children: ReactNode }) {
  const reduced = useReducedMotion();
  const hidden = reduced ? { opacity: 0 } : { opacity: 0, scale: .7 };
  return <span className={styles.swapCell} aria-hidden="true"><AnimatePresence initial={false} mode="popLayout">
    <motion.span key={id} className={styles.swapItem} initial={hidden} animate={{ opacity: 1, scale: 1 }} exit={hidden}
      transition={reduced ? { duration: .12 } : { ...motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.fast } }}>{children}</motion.span>
  </AnimatePresence></span>;
}

/** The original AI Chat column, controlled by the real Agent rather than demo state. */
export function AiChat({ title, model, onConfigure, onNew, onClose, context, messages, value, onValueChange, onSend, onStop, busy, locked,
  activity = "正在思考…", onOpenNote, disabled, emptyTitle, emptyText, suggestions = [], streaming, children }: AiChatProps) {
  const reduced = useReducedMotion();
  const threadRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const [stuck, setStuck] = useState(true);

  // Arc's bottom pin releases while reading older messages; the jump button restores it.
  useLayoutEffect(() => {
    const thread = threadRef.current, content = contentRef.current;
    if (!thread || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (stick.current) thread.scrollTop = thread.scrollHeight; });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "0px";
    node.style.height = `${Math.min(168, node.scrollHeight)}px`;
  }, [value]);

  function toBottom() {
    const thread = threadRef.current;
    stick.current = true; setStuck(true);
    thread?.scrollTo({ top: thread.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  }
  function send() {
    if (busy || disabled || !value.trim()) return;
    stick.current = true; setStuck(true);
    onSend();
  }
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (composing(event)) return;
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); }
    if (event.key === "Escape" && busy) { event.preventDefault(); onStop(); }
  }
  const transition = reduced ? { duration: 0 } : { ...motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.standard } };

  return <div className={styles.root} data-embedded>
    <section className={styles.main} aria-label={title}>
      <header className={styles.header}>
        <div className={styles.headerTools}>
          <button type="button" className={styles.iconButton} aria-label="开始新对话" disabled={locked} onClick={onNew}><SquarePen size={17} strokeWidth={1.75} aria-hidden="true"/></button>
        </div>
        <button type="button" className={styles.switcherPill} aria-label={model ? `配置模型：${model}` : "连接模型"} title={model ?? "连接模型"} onClick={onConfigure}>
          <span className={styles.modelName}>{model ?? "连接模型"}</span><Settings size={15} strokeWidth={1.75} aria-hidden="true"/>
        </button>
        <button type="button" className={`${styles.iconButton} ${styles.closeAction}`} aria-label="关闭 AI 助手" onClick={onClose}><X size={18} strokeWidth={1.75} aria-hidden="true"/></button>
      </header>
      <div ref={threadRef} className={styles.thread} onScroll={() => {
        const thread = threadRef.current;
        if (!thread) return;
        stick.current = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 56;
        setStuck(stick.current);
      }}>
        <div ref={contentRef} className={styles.threadContent}>
          <div className={styles.page}>
            {!messages.length && !busy ? <div className={styles.empty}>
              <h3 className={styles.greeting}>{emptyTitle}</h3><p className={styles.emptyDescription}>{emptyText}</p>
              {!!suggestions.length && <div className={styles.suggestionsSection}>
                <p className={styles.suggestionsHint}>点击填入输入框，修改后发送</p>
                <ul className={styles.suggestions} aria-label="示例问题">
                  {suggestions.map((suggestion, index) => <motion.li key={suggestion.label}
                    initial={reduced ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: motionTokens.duration.considered, delay: reduced ? 0 : index * motionTokens.stagger.item }}>
                    <Button type="button" variant="secondary" className={styles.suggestion} onClick={() => { onValueChange(suggestion.prompt); textareaRef.current?.focus(); }}>
                      <ArrowDownToLine size={16} strokeWidth={1.75} aria-hidden="true"/>{suggestion.label}
                    </Button>
                  </motion.li>)}
                </ul>
              </div>}
            </div> : <>
              <div role="log" aria-label="AI 对话" aria-live="polite" aria-relevant="additions">
                <ol className={styles.messages}>
                  {messages.map(message => <motion.li key={message.id} className={styles.messageItem} data-role={message.role}
                    initial={reduced ? false : message.role === "user" ? { opacity: 0, y: 14, scale: .98 } : { opacity: 0 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={transition}>
                    {message.role === "user" ? <div className={styles.user}>
                      <div className={styles.bubble} style={{ borderRadius: 20 }}><p className={styles.bubbleText}><span className={styles.srOnly}>你：</span>{message.text}</p></div>
                      <div className={styles.userActions}><CopyButton value={message.text} label="复制消息" iconOnly variant="plain"/></div>
                    </div> : <div className={styles.assistant}>
                      <div className={styles.answer}><span className={styles.srOnly}>AI 助手：</span><div className={styles.markdown}><NoteMarkdown onOpenNote={onOpenNote}>{message.text}</NoteMarkdown></div></div>
                      <div className={styles.answerFoot}><div className={styles.answerActions}><CopyButton value={message.text} label="复制回复" iconOnly variant="plain"/><span className={styles.answerMeta}>{model ?? "AI 助手"}</span></div></div>
                    </div>}
                  </motion.li>)}
                </ol>
              </div>
              {busy && <div className={styles.liveAnswer} aria-hidden="true" inert>
                {streaming ? <div className={styles.markdown}><NoteMarkdown onOpenNote={onOpenNote}>{streaming}</NoteMarkdown></div>
                  : <div className={styles.thinkingHead}><TextShimmer>{activity}</TextShimmer></div>}
              </div>}
            </>}
            {children}
          </div>
        </div>
      </div>
      <div className={styles.dock}>
        <AnimatePresence>{!stuck && <motion.button type="button" className={styles.jump} aria-label="跳到最新消息" onClick={toBottom}
          initial={reduced ? false : { opacity: 0, y: 8, scale: .9 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0 }} transition={transition}><ArrowDown size={16} strokeWidth={1.75} aria-hidden="true"/></motion.button>}</AnimatePresence>
        {context && <div className={styles.context}>{context}</div>}
        <form className={styles.composer} onSubmit={event => { event.preventDefault(); if (busy) onStop(); else send(); }}>
          <textarea ref={textareaRef} className={styles.field} rows={1} value={value} placeholder="输入问题或操作要求…" aria-label="AI 消息" onChange={event => onValueChange(event.target.value)} onKeyDown={handleKeyDown}/>
          <div className={styles.composerBar}><span className={styles.composerHint}>Enter 发送 · Shift Enter 换行</span>
            <button type="submit" className={styles.send} data-busy={busy || undefined} aria-label={busy ? "停止生成" : "发送消息"} disabled={!busy && (!!disabled || !value.trim())}>
              <IconSwap id={busy ? "stop" : "send"}>{busy ? <span className={styles.stopGlyph}/> : <ArrowUp size={18} strokeWidth={2}/>}</IconSwap>
            </button>
          </div>
        </form>
      </div>
      <p className={styles.srOnly} role="status" aria-live="polite">{busy ? activity : ""}</p>
    </section>
  </div>;
}

export default AiChat;
