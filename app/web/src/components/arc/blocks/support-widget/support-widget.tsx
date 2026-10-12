"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { AnimatePresence, LayoutGroup, motion, useIsPresent, useReducedMotion, type Variants } from "motion/react";
import { ArrowUp, ChevronDown, ChevronLeft, ChevronRight, CircleCheck, Info, MessageCircleQuestionMark, TriangleAlert } from "lucide-react";
import { AnimatedCounter } from "../../animated-counter/animated-counter";
import { Avatar } from "../../avatar/avatar";
import { Button } from "../../button/button";
import { SearchField } from "../../search-field/search-field";
import { TextMorph } from "../../text-morph/text-morph";
import { motionTokens } from "../../lib/motion-tokens";
import { ARTICLES, FOLLOW_UP, SUGGESTIONS, TEAM, greetingFor, matcherOf, replyTo, searchArticles, tokensOf } from "./support-widget-data";
import styles from "./support-widget.module.css";

type View = "home" | "article" | "chat";
type Message = { id: number; from: "ava" | "you"; text: string; time: string; status?: "Sent" | "Seen" };
type Focus = "launcher" | "search" | "composer" | "talk" | "article" | "feedback" | "panel" | `card:${string}`;

const { spring, duration, ease, blur } = motionTokens;
const enterEase = [...ease.enter] as [number, number, number, number];
const standardEase = [...ease.standard] as [number, number, number, number];
/** Launcher diameter, header and footer heights, and the largest panel. The panel shrinks to fit narrow previews. */
const LAUNCHER = 56, HEADER = 60, FOOTER = 76, MAX_W = 384, MAX_H = 600;
const EXPORTS = [
  { name: "Weekly revenue summary", detail: "PDF · Mondays at 6:00", status: "Delivered Sep 21", ok: true },
  { name: "Churned accounts", detail: "CSV · Daily at 6:00", status: "Paused Sep 21", ok: false },
  { name: "Wholesale orders", detail: "CSV · Fridays at 6:00", status: "Delivered Sep 18", ok: true },
  { name: "Board metrics pack", detail: "PDF · 1st of the month", status: "Delivered Sep 1", ok: true },
];

/** Views slide the way you travel: deeper comes in from the right, back returns from the left. */
const slide: Variants = {
  enter: (dir: number) => ({ x: dir * 32, opacity: 0, filter: `blur(${blur.subtle}px)` }),
  center: { x: 0, opacity: 1, filter: "blur(0px)" },
  exit: (dir: number) => ({ x: dir * -32, opacity: 0, filter: `blur(${blur.subtle}px)`, transition: { x: spring.smooth, opacity: { duration: duration.fast, ease: standardEase }, filter: { duration: duration.fast } } }),
};
const fadeViews: Variants = { enter: { x: 0, opacity: 0, filter: "blur(0px)" }, center: { x: 0, opacity: 1, filter: "blur(0px)" }, exit: { x: 0, opacity: 0, filter: "blur(0px)", transition: { duration: duration.instant } } };

/** Outgoing copies are hidden from assistive tech while they leave; the ref lets popLayout measure them. */
function SwapItem({ children, reduced, ref }: { children: ReactNode; reduced: boolean; ref?: Ref<HTMLSpanElement> }) {
  const present = useIsPresent();
  return <motion.span ref={ref} className={styles.swapItem} aria-hidden={present ? undefined : true}
    initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6, filter: `blur(${blur.soft}px)` }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
    exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -4, filter: `blur(${blur.soft}px)`, transition: { duration: duration.fast, ease: standardEase } }}
    transition={reduced ? { duration: duration.instant } : { duration: duration.standard, ease: enterEase }}>{children}</motion.span>;
}
/** Changing text rises into place out of a small blur while the old line lifts away. */
function Swap({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  const reduced = !!useReducedMotion();
  return <span className={[styles.swap, className].filter(Boolean).join(" ")}><AnimatePresence mode="popLayout" initial={false}><SwapItem key={id} reduced={reduced}>{children}</SwapItem></AnimatePresence></span>;
}
function Highlight({ text, matcher }: { text: string; matcher: RegExp | null }) {
  if (!matcher) return <>{text}</>;
  return <>{text.split(matcher).map((part, index) => index % 2 ? <mark key={index}>{part}</mark> : part)}</>;
}

export interface SupportWidgetProps {
  /** Called with each message the person sends, so you can forward it to your inbox or chat provider. */
  onSend?: (message: string) => void;
  onOpenChange?: (open: boolean) => void;
}

export function SupportWidget({ onSend, onOpenChange }: SupportWidgetProps) {
  const reduced = !!useReducedMotion();
  const group = useId(), listId = useId(), composerId = useId();
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("home");
  const [back, setBack] = useState<"home" | "article">("home");
  const [dir, setDir] = useState(1);
  const [articleId, setArticleId] = useState(ARTICLES[0].id);
  const [query, setQuery] = useState("");
  const [feedback, setFeedback] = useState<Record<string, "yes" | "no">>({});
  const [messages, setMessages] = useState<Message[]>([]);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  const [suggestions, setSuggestions] = useState(SUGGESTIONS);
  const [unread, setUnread] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const stageRef = useRef<HTMLDivElement>(null), panelRef = useRef<HTMLDivElement>(null), launcherRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null), composerRef = useRef<HTMLInputElement>(null), talkRef = useRef<HTMLButtonElement>(null), threadRef = useRef<HTMLDivElement>(null);
  const focusTarget = useRef<Focus | null>(null);
  const live = useRef({ open: false, view: "home" as View });
  const timers = useRef(new Set<number>());
  const pending = useRef(0), nextId = useRef(1), clock = useRef(42), greeted = useRef(false), followed = useRef(false);

  const article = ARTICLES.find(item => item.id === articleId) ?? ARTICLES[0];
  const results = useMemo(() => searchArticles(query), [query]);
  const matcher = useMemo(() => matcherOf(tokensOf(query)), [query]);
  const searching = query.trim().length > 0;
  const chat = view === "chat";
  const under = chat ? back : view;
  const inset = stage.w && stage.w + 2 < 520 ? 12 : 20;
  const pw = stage.w ? Math.min(MAX_W, stage.w - inset * 2) : MAX_W;
  const ph = stage.h ? Math.min(MAX_H, stage.h - inset * 2) : MAX_H;
  const sheetOpen = ph - 2 - HEADER;

  useEffect(() => {
    const node = stageRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setStage({ w: Math.round(entry.contentRect.width), h: Math.round(entry.contentRect.height) }));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { live.current = { open, view }; }, [open, view]);
  useEffect(() => { const pendingTimers = timers.current; return () => pendingTimers.forEach(window.clearTimeout); }, []);
  // Focus follows the person: into the field they'll use next, and back to whatever opened a layer when it closes.
  useEffect(() => {
    const target = focusTarget.current;
    if (!target) return;
    focusTarget.current = null;
    const root = panelRef.current;
    const element: HTMLElement | null | undefined = target === "launcher" ? launcherRef.current : target === "search" ? searchRef.current : target === "composer" ? composerRef.current : target === "talk" ? talkRef.current : target === "panel" ? root
      : target === "article" ? root?.querySelector<HTMLElement>('[data-view="article"] h3') : target === "feedback" ? root?.querySelector<HTMLElement>('[data-view="article"] [data-feedback]')
      : root?.querySelector<HTMLElement>(`[data-view="home"] [data-article="${target.slice(5)}"]`) ?? searchRef.current;
    element?.focus({ preventScroll: true });
  }, [open, view, articleId, feedback]);
  useEffect(() => {
    const thread = threadRef.current;
    if (thread) thread.scrollTo({ top: thread.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  }, [messages, typing, open, view, reduced]);

  const typingField = (target: Focus): Focus => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches ? "panel" : target;
  function schedule(ms: number, run: () => void) {
    const timer = window.setTimeout(() => { timers.current.delete(timer); run(); }, ms);
    timers.current.add(timer);
  }
  function tick() { const total = 600 + clock.current++; return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`; }
  /** A simulated reply from Ava. If the widget is closed or on another view, it waits as an unread reply. */
  function deliver(text: string) {
    const id = nextId.current++, time = tick();
    setMessages(current => [...current, { id, from: "ava", text, time }]);
    pending.current = Math.max(0, pending.current - 1);
    setTyping(pending.current > 0);
    const seen = live.current.open && live.current.view === "chat";
    if (!seen) { setUnread(count => count + 1); setAnnouncement("Ava replied. Open help to read it."); }
  }

  function openWidget() {
    const toChat = unread > 0 || view === "chat";
    // Replies that came in while it was closed open the conversation directly.
    if (unread > 0 && view !== "chat") { setBack(view); setView("chat"); }
    setUnread(0);
    focusTarget.current = typingField(toChat ? "composer" : view === "article" ? "article" : "search");
    setOpen(true); onOpenChange?.(true);
    setAnnouncement(unread > 0 ? "Help opened on your conversation with Ava." : "");
  }
  function closeWidget() {
    if (panelRef.current?.contains(document.activeElement)) focusTarget.current = "launcher";
    setOpen(false); onOpenChange?.(false);
    // Leaving mid-conversation: Ava answers once more, so the launcher shows what came in while you were away.
    if (chat && greeted.current && pending.current === 0 && !followed.current) { followed.current = true; pending.current += 1; schedule(1600, () => deliver(FOLLOW_UP)); }
  }
  function openArticle(id: string) { setArticleId(id); setDir(1); setView("article"); focusTarget.current = "article"; }
  function goBack() {
    if (chat) { setView(back); focusTarget.current = "talk"; return; }
    setDir(-1); setView("home"); focusTarget.current = `card:${articleId}`;
  }
  function openChat(prefill?: string) {
    const from = view === "article" ? "article" : "home";
    setBack(from); setView("chat"); setUnread(0);
    if (prefill) setDraft(prefill);
    focusTarget.current = typingField("composer");
    if (greeted.current) return;
    greeted.current = true; pending.current += 1; setTyping(true);
    schedule(900, () => deliver(greetingFor(from === "article" ? article : undefined)));
  }
  function send(text: string) {
    const value = text.trim();
    if (!value) return;
    const id = nextId.current++;
    setMessages(current => [...current, { id, from: "you", text: value, time: tick(), status: "Sent" }]);
    setDraft(""); setSuggestions(current => current.filter(item => item !== text)); onSend?.(value);
    pending.current += 1;
    schedule(700, () => { setMessages(current => current.map(item => item.id === id ? { ...item, status: "Seen" } : item)); setTyping(true); });
    schedule(2200, () => deliver(replyTo(value)));
  }
  function rate(value: "yes" | "no") { setFeedback(current => ({ ...current, [articleId]: value })); focusTarget.current = "feedback"; }

  function onPanelKey(event: KeyboardEvent<HTMLDivElement>) { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeWidget(); } }
  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") { event.preventDefault(); panelRef.current?.querySelector<HTMLElement>('[data-view="home"] [data-article]')?.focus(); }
    if (event.key === "Enter" && searching && results[0]) { event.preventDefault(); openArticle(results[0].id); }
  }
  function onListKey(event: KeyboardEvent<HTMLUListElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const cards = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-article]"));
    const index = cards.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    const next = index + (event.key === "ArrowDown" ? 1 : -1);
    if (next < 0) searchRef.current?.focus(); else cards[Math.min(next, cards.length - 1)]?.focus();
  }
  function onCompose(event: FormEvent<HTMLFormElement>) { event.preventDefault(); send(draft); }

  const viewTransition = reduced ? { duration: duration.instant } : { x: spring.smooth, opacity: { duration: duration.standard, ease: enterEase }, filter: { duration: duration.standard, ease: enterEase } };
  const headKey = searching ? (results.length ? "results" : "none") : "popular";
  const rated = feedback[article.id];

  const home = <motion.div key="home" data-view="home" className={styles.view} layoutScroll custom={dir} variants={reduced ? fadeViews : slide} initial="enter" animate="center" exit="exit" transition={viewTransition}>
    <div className={styles.greeting}><p>Hi Jordan</p><h2>How can we help?</h2></div>
    <div className={styles.search}><SearchField ref={searchRef} label="Search help articles" placeholder="Search for answers" value={query} onValueChange={setQuery} onKeyDown={onSearchKey} autoComplete="off" aria-controls={listId} /></div>
    <p className={styles.listHead}><Swap id={headKey}>{headKey === "popular" ? "Popular articles" : headKey === "none" ? "No matching articles" : <><span className={styles.count}><AnimatedCounter value={results.length} /></span>{results.length === 1 ? " article" : " articles"}</>}</Swap></p>
    {results.length ? <ul id={listId} className={styles.list} aria-label={searching ? "Search results" : "Popular articles"} onKeyDown={onListKey}>
      <AnimatePresence mode="popLayout" initial={false}>{results.map(item => <motion.li key={item.id} layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: reduced ? 0 : duration.instant } }} transition={reduced ? { duration: 0 } : { layout: spring.smooth, opacity: { duration: duration.standard, ease: enterEase } }}>
        <button type="button" className={styles.card} data-article={item.id} onClick={() => openArticle(item.id)}>
          <span className={styles.cardText}><strong><Highlight text={item.title} matcher={matcher} /></strong><span><Highlight text={item.summary} matcher={matcher} /></span></span>
          <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </motion.li>)}</AnimatePresence>
    </ul> : <div className={styles.empty}><p>Nothing in the help center mentions “{query.trim()}” yet. Ava can answer it directly.</p><Button variant="secondary" size="sm" onClick={() => openChat(query.trim())}>Ask Ava</Button></div>}
  </motion.div>;

  const reading = <motion.div key={`article-${article.id}`} data-view="article" className={styles.view} custom={dir} variants={reduced ? fadeViews : slide} initial="enter" animate="center" exit="exit" transition={viewTransition}>
    <article className={styles.article}>
      <p className={styles.meta}>{article.category} · {article.minutes} min read</p>
      <h3 tabIndex={-1}><Highlight text={article.title} matcher={matcher} /></h3>
      <div className={styles.byline}><Avatar name={article.author.name} src={article.author.src} size="sm" /><span>{article.author.name} · Updated {article.updated}</span></div>
      <p><Highlight text={article.intro} matcher={matcher} /></p>
      <ol className={styles.steps}>{article.steps.map((step, index) => <li key={step}><span aria-hidden="true">{index + 1}</span><p><Highlight text={step} matcher={matcher} /></p></li>)}</ol>
      <p className={styles.note}><Info size={16} strokeWidth={1.75} aria-hidden="true" /><span><Highlight text={article.note} matcher={matcher} /></span></p>
      <div className={styles.feedback} data-feedback tabIndex={-1}>
        <Swap id={rated ?? "ask"}>{rated ? <span className={styles.rated}>{rated === "yes" ? <><CircleCheck size={16} strokeWidth={1.75} aria-hidden="true" />Thanks, glad it helped.</> : "Sorry it missed. Ava can take it from here."}</span>
          : <span className={styles.ask}><span>Was this helpful?</span><span className={styles.askButtons}><Button variant="secondary" size="sm" onClick={() => rate("yes")}>Yes</Button><Button variant="secondary" size="sm" onClick={() => rate("no")}>No</Button></span></span>}</Swap>
      </div>
    </article>
  </motion.div>;

  const panel = <motion.div key="panel" ref={panelRef} className={styles.panel} style={{ width: pw - 2, height: ph - 2 }} role="dialog" aria-label={chat ? "Conversation with Ava Mitchell" : "Help"} tabIndex={-1} onKeyDown={onPanelKey}
    initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: reduced ? duration.instant : duration.standard, delay: reduced ? 0 : .06, ease: enterEase } }} exit={{ opacity: 0, transition: { duration: reduced ? 0 : duration.instant, ease: standardEase } }}>
    <LayoutGroup id={group}>
      <header className={styles.header}>
        <motion.div className={styles.backSlot} inert={view === "home"} initial={false} animate={{ width: view === "home" ? 0 : 40, opacity: view === "home" ? 0 : 1 }} transition={reduced ? { duration: 0 } : spring.morph}>
          <button type="button" className={styles.iconButton} onClick={goBack} aria-label={chat ? "Back to help" : "Back to articles"}><ChevronLeft size={18} strokeWidth={1.75} aria-hidden="true" /></button>
        </motion.div>
        <motion.span className={styles.faceSlot} initial={false} animate={{ width: chat ? 40 : 0 }} transition={reduced ? { duration: 0 } : spring.morph}>
          {chat && <motion.span layoutId="ava" className={styles.face} transition={reduced ? { duration: 0 } : spring.morph}><Avatar name={TEAM.ava.name} src={TEAM.ava.src} status="online" /></motion.span>}
        </motion.span>
        <div className={styles.headTitle}><Swap id={chat ? "chat" : view === "article" ? `article-${article.category}` : "home"}>
          {chat ? <span className={styles.headStack}><strong>Ava Mitchell</strong><span>Support engineer · replies in about 4 min</span></span> : <strong>{view === "article" ? article.category : "Help"}</strong>}
        </Swap></div>
        <button type="button" className={styles.iconButton} onClick={closeWidget} aria-label="Close help"><ChevronDown size={18} strokeWidth={1.75} aria-hidden="true" /></button>
      </header>
      <div className={styles.body} inert={chat}>
        <AnimatePresence initial={false} custom={dir}>{under === "article" ? reading : home}</AnimatePresence>
      </div>
      {/* The footer is the handoff: it grows up into the conversation and its button becomes the composer in place. */}
      <motion.div className={styles.sheet} data-chat={chat || undefined} initial={false} animate={{ height: chat ? sheetOpen : FOOTER }} transition={reduced ? { duration: 0 } : spring.smooth}>
        <div className={styles.sheetInner} style={{ height: sheetOpen }}>
          <AnimatePresence initial={false}>{chat && <motion.div key="chat" className={styles.chatBody} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: reduced ? duration.instant : duration.standard, delay: reduced ? 0 : .08, ease: enterEase } }} exit={{ opacity: 0, transition: { duration: reduced ? 0 : duration.instant } }}>
            <div className={styles.thread} ref={threadRef} role="log" aria-label="Messages with Ava">
              <p className={styles.threadMeta}>Today</p>
              <AnimatePresence initial={false}>{messages.map(message => <motion.div key={message.id} className={message.from === "you" ? styles.mine : styles.theirs} initial={reduced ? { opacity: 0 } : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={reduced ? { duration: duration.instant } : { y: spring.smooth, opacity: { duration: duration.standard, ease: enterEase } }}>
                <p className={styles.bubble}>{message.text}</p>
                <span className={styles.stamp}>{message.from === "you" ? <Swap id={message.status ?? "Sent"}>{message.status} · {message.time}</Swap> : `Ava · ${message.time}`}</span>
              </motion.div>)}</AnimatePresence>
              <AnimatePresence initial={false}>{typing && <motion.div key="typing" className={styles.typing} initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: duration.instant } }} transition={reduced ? { duration: duration.instant } : spring.snappy}>
                <span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" /><span className={styles.srOnly}>Ava is typing</span>
              </motion.div>}</AnimatePresence>
            </div>
            {messages.length > 0 && suggestions.length > 0 && <div className={styles.suggestions} aria-label="Suggested replies" role="group">
              <AnimatePresence mode="popLayout" initial={false}>{suggestions.map(item => <motion.button key={item} type="button" layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: duration.instant } }} transition={reduced ? { duration: 0 } : { layout: spring.smooth, opacity: { duration: duration.standard } }} onClick={() => send(item)}>{item}</motion.button>)}</AnimatePresence>
            </div>}
          </motion.div>}</AnimatePresence>
          <div className={styles.dockRow}>
            {/* Both stay mounted and cross-fade in place, so the shared face never rides an exiting subtree. */}
            <motion.form className={styles.composer} onSubmit={onCompose} inert={!chat} initial={false} animate={{ opacity: chat ? 1 : 0 }}
              transition={reduced ? { duration: chat ? duration.instant : 0 } : chat ? { duration: duration.standard, ease: enterEase } : { duration: duration.fast, ease: standardEase }}>
              <label className={styles.srOnly} htmlFor={composerId}>Message Ava</label>
              <input ref={composerRef} id={composerId} type="text" value={draft} onChange={event => setDraft(event.target.value)} placeholder="Message Ava" autoComplete="off" />
              <button type="submit" className={styles.send} disabled={!draft.trim()} aria-label="Send message"><ArrowUp size={16} strokeWidth={2} aria-hidden="true" /></button>
            </motion.form>
            <motion.button ref={talkRef} type="button" className={styles.talk} onClick={() => openChat()} inert={chat} aria-label={unread ? `Talk to us, ${unread} new ${unread === 1 ? "reply" : "replies"} from Ava` : "Talk to us"}
              initial={false} animate={{ opacity: chat ? 0 : 1, filter: chat && !reduced ? `blur(${blur.subtle}px)` : "blur(0px)" }}
              transition={reduced ? { duration: chat ? 0 : duration.instant } : chat ? { duration: duration.fast, ease: standardEase } : { duration: duration.standard, delay: .1, ease: enterEase }}>
              <span className={styles.stack} aria-hidden="true">
                <motion.span layoutId="ava" className={styles.stackFace} transition={reduced ? { duration: 0 } : spring.morph}><Avatar name={TEAM.ava.name} src={TEAM.ava.src} size="sm" /></motion.span>
                <span className={styles.stackFace}><Avatar name={TEAM.marcus.name} src={TEAM.marcus.src} size="sm" /></span>
                <span className={styles.stackFace}><Avatar name={TEAM.sofia.name} src={TEAM.sofia.src} size="sm" /></span>
              </span>
              <TextMorph className={styles.talkLabel}>{unread ? "Ava replied" : "Talk to us"}</TextMorph>
              <Swap id={unread ? "new" : "time"} className={styles.talkMeta}>{unread ? `${unread} new` : "About 4 min"}</Swap>
            </motion.button>
          </div>
        </div>
      </motion.div>
    </LayoutGroup>
  </motion.div>;

  return <section className={styles.root} aria-label="Support widget">
    <div className={styles.stage} ref={stageRef}>
      <div className={styles.app} role="group" aria-label="Sample app page">
        <div className={styles.appBar}><strong>Harbor</strong><span className={styles.appNav}><span>Dashboards</span><span>Reports</span><span aria-current="page">Exports</span></span><span className={styles.appUser}>Fieldstone Roasters</span></div>
        <div className={styles.appHead}><h2>Scheduled exports</h2><p>4 schedules · times in UTC</p></div>
        <ul className={styles.appRows}>{EXPORTS.map(row => <li key={row.name}><span><strong>{row.name}</strong><small>{row.detail}</small></span>
          <span className={styles.appStatus} data-tone={row.ok ? "success" : "warning"}>{row.ok ? <CircleCheck size={16} strokeWidth={1.75} aria-hidden="true" /> : <TriangleAlert size={16} strokeWidth={1.75} aria-hidden="true" />}{row.status}</span></li>)}</ul>
      </div>
      <div className={styles.dock}>
        {/* One surface: the launcher's circle grows into the panel from the corner and shrinks back into it. */}
        <motion.div className={styles.widget} data-open={open || undefined} initial={false} animate={{ width: open ? pw : LAUNCHER, height: open ? ph : LAUNCHER, borderRadius: open ? 16 : 28 }} transition={reduced ? { duration: 0 } : open ? spring.morph : spring.smooth}>
          <AnimatePresence initial={false}>
            {open ? panel : <motion.button key="launcher" ref={launcherRef} type="button" className={styles.launcher} onClick={openWidget} aria-haspopup="dialog" aria-label={unread ? `Open help, ${unread} unread ${unread === 1 ? "reply" : "replies"} from Ava` : "Open help"}
              initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: reduced ? duration.instant : duration.fast, delay: reduced ? 0 : .12 } }} exit={{ opacity: 0, transition: { duration: reduced ? 0 : .08 } }}>
              <motion.span className={styles.launcherIcon} initial={reduced ? { opacity: 0 } : { opacity: 0, scale: .85, rotate: -12 }} animate={{ opacity: 1, scale: 1, rotate: 0 }} transition={reduced ? { duration: duration.instant } : { ...spring.snappy, delay: .12 }}><MessageCircleQuestionMark size={24} strokeWidth={1.75} aria-hidden="true" /></motion.span>
            </motion.button>}
          </AnimatePresence>
        </motion.div>
        <AnimatePresence>{!open && unread > 0 && <motion.span key="unread" className={styles.unread} aria-hidden="true" initial={reduced ? { opacity: 0 } : { opacity: 0, scale: .8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: reduced ? 1 : .8, transition: { duration: duration.instant } }} transition={reduced ? { duration: duration.instant } : { ...spring.snappy, delay: .2 }}>
          <Swap id={String(unread)}>{unread}</Swap>
        </motion.span>}</AnimatePresence>
      </div>
    </div>
    <span className={styles.srOnly} role="status" aria-live="polite">{announcement}</span>
  </section>;
}

export default SupportWidget;
