"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import Image from "next/image";
import { AnimatePresence, LayoutGroup, MotionConfig, motion, useReducedMotion } from "motion/react";
import { ArrowUp, Check, FileText, Maximize2, Minimize2, RotateCcw, Sparkles, Square, SquarePen, X } from "lucide-react";
import { motionTokens } from "../../lib/motion-tokens";
import { TextStream } from "../../text-stream/text-stream";
import { prompts as samplePrompts, samplePage, scriptedAnswer } from "./ai-side-panel-data";
import type { Milestone, Owner, PageChange, PlanPage, ScriptedAnswer, SuggestedAction } from "./ai-side-panel-data";
import styles from "./ai-side-panel.module.css";

/**
 * An assistant docked beside a real page. It reads context chips from the page (select a milestone and its chip flies into
 * the composer), streams its answer word by word, and offers actions that change the page. Applying one highlights exactly
 * what changed; in the focused view the panel first shrinks back to its dock so you can see it land. The panel expands into
 * a focused full view with one continuous layout morph. Answers here are scripted; connect onAsk to your model.
 */

export type { Milestone, PageChange, PlanPage, ScriptedAnswer, SuggestedAction } from "./ai-side-panel-data";
export type PanelMode = "closed" | "docked" | "full";

export interface AiSidePanelProps {
  /** Initial page content. */
  defaultPage?: PlanPage;
  /** Called with the page after every applied or undone action. */
  onPageChange?: (page: PlanPage) => void;
  /** Answers a question. Return the full text and any actions; the block streams it. Defaults to the scripted sample. */
  onAsk?: (question: string, context: string[], page: PlanPage) => ScriptedAnswer | Promise<ScriptedAnswer>;
  /** Suggested prompts for an empty thread. */
  prompts?: string[];
  defaultMode?: PanelMode;
  className?: string;
}

type Message = { id: string; role: "user" | "assistant"; text: string; full: string; status: "streaming" | "done" | "stopped"; actions: SuggestedAction[]; revealed: boolean; context: string[] };
type Applied = Record<string, PageChange>;

const DOCK = 360;
const BAR = 52;
const cx = (...names: (string | false | undefined | null)[]) => names.filter(Boolean).join(" ");

function Face({ owner, size = 20 }: { owner?: Owner; size?: number }) {
  if (!owner) return null;
  return <span className={styles.face} style={{ width: size, height: size }}>{owner.avatar ? <Image src={owner.avatar} alt="" fill sizes={`${size}px`} /> : null}</span>;
}

/** Applies a change and returns the page plus the change that undoes it. */
function applyChange(page: PlanPage, change: PageChange): [PlanPage, PageChange] {
  if (change.kind === "status") return [{ ...page, status: change.status }, { kind: "status", status: page.status }];
  if (change.kind === "note") {
    const exists = page.notes.some(note => note.id === change.id);
    if (exists) return [{ ...page, notes: page.notes.filter(note => note.id !== change.id) }, change];
    return [{ ...page, notes: [...page.notes, { id: change.id, title: change.title, body: change.body }] }, change];
  }
  const current = page.milestones.find(item => item.id === change.id);
  if (!current) return [page, change];
  const previous = Object.fromEntries(Object.keys(change.patch).map(key => [key, current[key as keyof Milestone]])) as Partial<Milestone>;
  return [{ ...page, milestones: page.milestones.map(item => item.id === change.id ? { ...item, ...change.patch } : item) }, { kind: "milestone", id: change.id, patch: previous }];
}
const highlightKey = (change: PageChange) => change.kind === "milestone" ? `m-${change.id}` : change.kind === "status" ? "status" : `n-${change.id}`;

export function AiSidePanel({ defaultPage = samplePage, onPageChange, onAsk, prompts = samplePrompts, defaultMode = "docked", className }: AiSidePanelProps) {
  const uid = useId();
  const reduced = useReducedMotion() ?? false;
  const frameRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [size, setSize] = useState({ width: 960, height: 640 });
  const [mode, setMode] = useState<PanelMode>(defaultMode);
  const [page, setPage] = useState(defaultPage);
  const [context, setContext] = useState<string[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [applied, setApplied] = useState<Applied>({});
  const [flash, setFlash] = useState<{ key: string; n: number } | null>(null);
  const stick = useRef(true);

  // Frame resizes (first measure, window resize) move the panel at once; only a mode change springs it. Without this the panel
  // would spring in from the 960 by 640 placeholder geometry on mount.
  const [snapLayout, setSnapLayout] = useState(true);
  const changeMode = useCallback((next: PanelMode | ((current: PanelMode) => PanelMode)) => { setSnapLayout(false); setMode(next); }, []);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let last = "";
    const measure = (width: number, height: number) => {
      const key = `${width}x${height}`;
      if (key === last) return;
      last = key;
      setSnapLayout(true);
      setSize({ width, height });
    };
    measure(frame.clientWidth, frame.clientHeight);
    const observer = new ResizeObserver(([entry]) => measure(entry.contentRect.width, entry.contentRect.height));
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => window.clearInterval(timer.current), []);
  useEffect(() => { if (!flash) return; const id = window.setTimeout(() => setFlash(null), 1800); return () => window.clearTimeout(id); }, [flash]);

  const narrow = size.width < 720;
  const busy = messages.some(message => message.status === "streaming");
  const commitPage = (next: PlanPage) => { setPage(next); onPageChange?.(next); };

  // Keep the newest words in view while streaming, unless the reader scrolled up.
  useEffect(() => {
    const thread = threadRef.current;
    if (thread && stick.current) thread.scrollTop = thread.scrollHeight;
  });

  const ask = useCallback(async (question: string) => {
    const text = question.trim();
    if (!text || busy) return;
    const ctx = context;
    const user: Message = { id: `u${Date.now()}`, role: "user", text, full: text, status: "done", actions: [], revealed: true, context: ctx };
    const id = `a${Date.now()}`;
    setMessages(list => [...list, user, { id, role: "assistant", text: "", full: "", status: "streaming", actions: [], revealed: false, context: [] }]);
    setDraft("");
    stick.current = true;
    const answer = await (onAsk ?? ((q: string, c: string[], p: PlanPage) => scriptedAnswer(q, c, p)))(text, ctx, page);
    let shown = 0;
    window.clearInterval(timer.current);
    timer.current = window.setInterval(() => {
      shown = Math.min(answer.text.length, shown + 3 + Math.floor(Math.random() * 7));
      const done = shown >= answer.text.length;
      setMessages(list => list.map(message => message.id === id && message.status === "streaming" ? { ...message, text: answer.text.slice(0, shown), full: answer.text, actions: answer.actions, status: done ? "done" : "streaming" } : message));
      if (done) window.clearInterval(timer.current);
    }, 32);
  }, [busy, context, onAsk, page]);

  const stop = () => { window.clearInterval(timer.current); setMessages(list => list.map(message => message.status === "streaming" ? { ...message, status: "stopped", actions: [] } : message)); };
  const reset = () => { stop(); setMessages([]); setApplied({}); inputRef.current?.focus(); };

  const reveal = (id: string) => setMessages(list => list.map(message => message.id === id ? { ...message, revealed: true } : message));

  const flashChange = (change: PageChange) => {
    const key = highlightKey(change);
    const land = () => {
      setFlash({ key, n: Date.now() });
      requestAnimationFrame(() => {
        const main = mainRef.current, target = main?.querySelector<HTMLElement>(`[data-hl="${key}"]`);
        if (!main || !target) return;
        const box = target.getBoundingClientRect(), view = main.getBoundingClientRect();
        if (box.top < view.top + 8 || box.bottom > view.bottom - 8) main.scrollBy({ top: box.top - view.top - view.height / 3, behavior: reduced ? "auto" : "smooth" });
      });
    };
    if (mode === "full") { changeMode("docked"); window.setTimeout(land, reduced ? 0 : 420); } else land();
  };

  const apply = (action: SuggestedAction) => {
    const [next, inverse] = applyChange(page, action.change);
    commitPage(next);
    setApplied(map => ({ ...map, [action.id]: inverse }));
    flashChange(action.change);
  };
  const undo = (action: SuggestedAction) => {
    const inverse = applied[action.id];
    if (!inverse) return;
    const [next] = applyChange(page, inverse);
    commitPage(next);
    setApplied(map => { const copy = { ...map }; delete copy[action.id]; return copy; });
    flashChange(action.change);
  };

  const addContext = (id: string) => {
    setContext(list => list.includes(id) ? list : [...list, id]);
    if (mode === "closed") changeMode("docked");
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  };

  const onFrameKey = (event: ReactKeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") { event.preventDefault(); changeMode(current => current === "closed" ? "docked" : "closed"); }
    else if (event.key === "Escape" && mode === "full") { event.preventDefault(); changeMode("docked"); }
  };

  const { width: W, height: H } = size;
  const dock = narrow ? W : Math.min(DOCK, W);
  const geometry = mode === "full" && !narrow
    ? { left: 10, top: 10, width: W - 20, height: H - 20, borderRadius: 26 }
    : { left: W - dock, top: BAR, width: dock, height: H - BAR, borderRadius: 0 };
  const layoutSpring = reduced || snapLayout ? { duration: 0 } : motionTokens.spring.smooth;
  const open = mode !== "closed";
  const milestoneName = (id: string) => page.milestones.find(item => item.id === id)?.name ?? id;
  const hl = (key: string) => ({ "data-hl": key, "data-flash": flash?.key === key ? "" : undefined });
  const fk = (key: string) => flash?.key === key ? `${key}-${flash.n}` : key;

  return <MotionConfig reducedMotion="user">
    <div ref={frameRef} className={cx(styles.frame, className)} data-mode={mode} data-narrow={narrow || undefined} onKeyDown={onFrameKey}>
      <LayoutGroup id={uid}>
        <header className={styles.bar}>
          <nav className={styles.crumbs} aria-label="Breadcrumb"><span>{page.project}</span><span aria-hidden="true">/</span><span className={styles.crumbCurrent}>{page.title}</span></nav>
          <button type="button" className={styles.askButton} aria-pressed={open} aria-keyshortcuts="Control+J Meta+J" onClick={() => changeMode(current => current === "closed" ? "docked" : "closed")}>
            <Sparkles size={15} aria-hidden="true" /> Ask AI <kbd className={styles.kbd}>⌘J</kbd>
          </button>
        </header>

        <motion.main ref={mainRef} className={styles.main} initial={false} animate={{ marginRight: open && !narrow ? dock : 0, opacity: mode === "full" && !narrow ? .35 : 1 }} transition={layoutSpring} aria-hidden={mode === "full" || (narrow && open) || undefined}>
          <div className={styles.doc}>
            <h1 className={styles.docTitle}>{page.title}</h1>
            <dl className={styles.docMeta}>
              <div><dt>Status</dt><dd><span key={fk("status")} {...hl("status")} className={styles.statusValue} data-status={page.status}><span className={styles.statusDot} aria-hidden="true" />{page.status}</span></dd></div>
              <div><dt>Lead</dt><dd className={styles.person}><Face owner={page.lead} />{page.lead.name}</dd></div>
              <div><dt>Target</dt><dd>{page.target}</dd></div>
            </dl>
            <p className={styles.intro}>{page.intro}</p>
            <AnimatePresence initial={false}>
              {page.notes.map(note => <motion.section key={note.id} className={styles.noteOuter} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={layoutSpring}>
                <div key={fk(`n-${note.id}`)} {...hl(`n-${note.id}`)} className={styles.note}><h2><Sparkles size={13} aria-hidden="true" /> {note.title}</h2><p>{note.body}</p></div>
              </motion.section>)}
            </AnimatePresence>
            <h2 className={styles.sectionTitle}>Milestones</h2>
            <div className={styles.table} role="table" aria-label="Milestones">
              <div className={styles.thead} role="row"><span role="columnheader">Milestone</span><span role="columnheader">Owner</span><span role="columnheader">Due</span><span role="columnheader">Status</span><span role="columnheader" className={styles.srOnly}>Ask</span></div>
              {page.milestones.map(item => {
                const inContext = context.includes(item.id);
                return <div key={fk(`m-${item.id}`)} {...hl(`m-${item.id}`)} className={styles.tr} role="row" data-selected={inContext || undefined}>
                  <span role="cell" className={styles.name}>{item.name}</span>
                  <span role="cell" className={styles.person}>{item.owner ? <><Face owner={item.owner} /><span className={styles.ownerName}>{item.owner.name.split(" ")[0]}</span></> : <span className={styles.muted}><span className={styles.ownerName}>No owner</span><span aria-hidden="true" className={styles.noOwner} /></span>}</span>
                  <span role="cell" className={styles.due}>{item.due}</span>
                  <span role="cell"><span className={styles.statusValue} data-status={item.status}><span className={styles.statusDot} aria-hidden="true" />{item.status}</span></span>
                  <span role="cell" className={styles.askCell}>
                    {!inContext ? <motion.button layoutId={`${uid}-ctx-${item.id}`} transition={motionTokens.spring.morph} type="button" className={styles.rowAsk} aria-label={`Ask about ${item.name}`} onClick={() => addContext(item.id)}>
                      <Sparkles size={13} aria-hidden="true" /><span>Ask</span>
                    </motion.button> : <span className={styles.rowAskGhost}><Check size={13} aria-hidden="true" /></span>}
                  </span>
                </div>;
              })}
            </div>
          </div>
        </motion.main>

        <AnimatePresence initial={false}>
          {open ? <motion.aside
            key="panel"
            className={styles.panel}
            data-mode={mode}
            aria-label="Assistant"
            initial={{ ...geometry, left: W, top: BAR, height: H - BAR, width: dock, borderRadius: 0 }}
            animate={geometry}
            exit={{ left: W, top: BAR, height: H - BAR, width: dock, borderRadius: 0, transition: layoutSpring }}
            transition={layoutSpring}
          >
            <div className={styles.panelHead}>
              <span className={styles.panelTitle}><Sparkles size={15} aria-hidden="true" /> Assistant</span>
              <div className={styles.panelActions}>
                <button type="button" className={styles.icon} aria-label="New chat" disabled={!messages.length} onClick={reset}><SquarePen size={15} /></button>
                {!narrow ? <button type="button" className={styles.icon} aria-label={mode === "full" ? "Dock to the side" : "Expand to focused view"} aria-pressed={mode === "full"} onClick={() => changeMode(current => current === "full" ? "docked" : "full")}>
                  <AnimatePresence initial={false} mode="popLayout"><motion.span key={mode === "full" ? "min" : "max"} className={styles.iconSwap} initial={{ opacity: 0, scale: .6, rotate: -45 }} animate={{ opacity: 1, scale: 1, rotate: 0 }} exit={{ opacity: 0, scale: .6, rotate: 45 }} transition={motionTokens.spring.snappy}>{mode === "full" ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</motion.span></AnimatePresence>
                </button> : null}
                <button type="button" className={styles.icon} aria-label="Close assistant" onClick={() => changeMode("closed")}><X size={16} /></button>
              </div>
            </div>

            <div ref={threadRef} className={styles.thread} onScroll={event => { const el = event.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
              <div className={styles.column}>
                <AnimatePresence initial={false} mode="popLayout">
                  {!messages.length ? <motion.div key="empty" className={styles.welcome} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8, filter: "blur(4px)" }} transition={motionTokens.spring.smooth}>
                    <p className={styles.welcomeTitle}>Ask about {page.title}</p>
                    <p className={styles.welcomeText}>I can read this page and change it when you approve.</p>
                    <ul className={styles.prompts}>
                      {prompts.map((prompt, index) => <motion.li key={prompt} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ ...motionTokens.spring.smooth, delay: reduced ? 0 : .08 + index * .05 }}>
                        <button type="button" className={styles.prompt} onClick={() => void ask(prompt)}>{prompt}</button>
                      </motion.li>)}
                    </ul>
                  </motion.div> : <motion.ol key="thread" className={styles.messages} aria-live="polite" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                    {messages.map(message => message.role === "user" ? <motion.li key={message.id} className={styles.user} initial={{ opacity: 0, y: 10, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={motionTokens.spring.snappy}>
                      <p>{message.text}</p>
                      {message.context.length ? <span className={styles.userContext}>{message.context.map(milestoneName).join(", ")}</span> : null}
                    </motion.li> : <li key={message.id} className={styles.answer}>
                      {!message.text && message.status === "streaming" ? <span className={styles.thinking}>Reading the page</span> : <TextStream text={message.text} streaming={message.status === "streaming"} markdown speed="fast" onRevealed={() => reveal(message.id)} />}
                      {message.status === "stopped" ? <span className={styles.stopped}>Stopped</span> : null}
                      <AnimatePresence initial={false}>
                        {message.revealed && message.actions.length ? <motion.ul key="actions" className={styles.actions} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} transition={motionTokens.spring.smooth} aria-label="Suggested changes">
                          {message.actions.map((action, index) => {
                            const done = Boolean(applied[action.id]);
                            return <motion.li key={action.id} className={styles.action} data-applied={done || undefined} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ...motionTokens.spring.smooth, delay: reduced ? 0 : index * .06 }}>
                              <div className={styles.actionText}><span>{action.label}</span><small>{action.detail}</small></div>
                              <button type="button" className={done ? styles.undoButton : styles.applyButton} onClick={() => done ? undo(action) : apply(action)} aria-label={done ? `Undo ${action.label}` : action.label}>
                                <AnimatePresence initial={false} mode="popLayout">
                                  <motion.span key={done ? "done" : "apply"} className={styles.applyLabel} initial={{ opacity: 0, y: 8, filter: "blur(3px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={{ opacity: 0, y: -8, filter: "blur(3px)" }} transition={motionTokens.spring.snappy}>
                                    {done ? <><Check size={14} /> Applied <RotateCcw size={12} className={styles.undoIcon} /></> : "Apply"}
                                  </motion.span>
                                </AnimatePresence>
                              </button>
                            </motion.li>;
                          })}
                        </motion.ul> : null}
                      </AnimatePresence>
                    </li>)}
                  </motion.ol>}
                </AnimatePresence>
              </div>
            </div>

            <form className={styles.composerWrap} onSubmit={event => { event.preventDefault(); void ask(draft); }}>
              <div className={styles.composer}>
                <ul className={styles.chips} aria-label="Context">
                  <li className={styles.chip} data-static=""><FileText size={13} aria-hidden="true" /><span>{page.title}</span></li>
                  {context.map(id => <motion.li key={id} layoutId={`${uid}-ctx-${id}`} transition={motionTokens.spring.morph} className={styles.chip}>
                    {/* The body rides along at its own size, so the label never squashes while the chip flies in from its row. */}
                    <motion.span layout="position" transition={motionTokens.spring.morph} className={styles.chipBody}>
                      <Sparkles size={12} aria-hidden="true" /><span>{milestoneName(id)}</span>
                      <button type="button" className={styles.chipRemove} aria-label={`Remove ${milestoneName(id)}`} onClick={() => setContext(list => list.filter(entry => entry !== id))}><X size={12} /></button>
                    </motion.span>
                  </motion.li>)}
                </ul>
                <textarea
                  ref={inputRef}
                  className={styles.input}
                  rows={2}
                  value={draft}
                  placeholder={context.length ? `Ask about ${milestoneName(context[context.length - 1])}` : "Ask about this page"}
                  aria-label="Message the assistant"
                  onChange={event => setDraft(event.target.value)}
                  onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void ask(draft); } }}
                />
                <div className={styles.composerFoot}>
                  <span className={styles.hint}>Answers are simulated</span>
                  {busy ? <button type="button" className={styles.send} aria-label="Stop" onClick={stop}><Square size={12} fill="currentColor" /></button>
                    : <button type="submit" className={styles.send} aria-label="Send" disabled={!draft.trim()}><ArrowUp size={16} /></button>}
                </div>
              </div>
            </form>
          </motion.aside> : null}
        </AnimatePresence>
      </LayoutGroup>
    </div>
  </MotionConfig>;
}

export default AiSidePanel;
