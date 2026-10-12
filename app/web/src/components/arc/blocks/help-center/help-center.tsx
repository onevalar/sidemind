"use client";

import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from "react";
import { AnimatePresence, LayoutGroup, animate, motion, useMotionValue, useReducedMotion } from "motion/react";
import { ArrowLeft, ArrowRight, Check, ChevronRight, Clock, CreditCard, FileText, LifeBuoy, Loader2, Plug, Rocket, Search, Shield, ThumbsDown, ThumbsUp, Users, Wrench, X } from "lucide-react";
import { motionTokens } from "../../lib/motion-tokens";
import { sampleArticles, sampleCategories } from "./help-center-data";
import type { HelpArticle, HelpCategory, HelpIcon } from "./help-center-data";
import styles from "./help-center.module.css";

export type { HelpArticle, HelpCategory, HelpIcon, HelpSection } from "./help-center-data";

type View = { kind: "home" } | { kind: "category"; id: string } | { kind: "article"; id: string };

export interface HelpCenterProps {
  articles?: HelpArticle[];
  categories?: HelpCategory[];
  /** Name shown in the top bar. */
  brand?: string;
  heading?: string;
  /** Opens this article on mount. */
  defaultArticleId?: string;
  /** Replaces the built-in search. Return the matching articles in ranked order. */
  search?: (query: string, articles: HelpArticle[]) => HelpArticle[];
  /** Records a helpful vote and the optional comment. */
  onFeedback?: (articleId: string, helpful: boolean, comment?: string) => void | Promise<void>;
  /** Opens your support channel. Without it the preview simulates a sent request. */
  onContact?: () => void | Promise<void>;
  /** Quick searches under the big search field. */
  suggestions?: string[];
  /** Called when an article opens, for routing or analytics. */
  onArticleOpen?: (article: HelpArticle) => void;
  className?: string;
}

const icons: Record<HelpIcon, ReactNode> = {
  start: <Rocket size={18} strokeWidth={1.75} />,
  billing: <CreditCard size={18} strokeWidth={1.75} />,
  team: <Users size={18} strokeWidth={1.75} />,
  integrations: <Plug size={18} strokeWidth={1.75} />,
  security: <Shield size={18} strokeWidth={1.75} />,
  troubleshooting: <Wrench size={18} strokeWidth={1.75} />,
};
const easeEnter = [...motionTokens.ease.enter] as [number, number, number, number];
const easeStandard = [...motionTokens.ease.standard] as [number, number, number, number];
const instant = { duration: 0 };
const depth = (view: View) => view.kind === "home" ? 0 : view.kind === "category" ? 1 : 2;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Ranks title matches above summary and body matches; every word of the query must appear somewhere. */
export function searchArticles(query: string, articles: HelpArticle[]) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return articles.map(article => {
    const title = article.title.toLowerCase();
    const summary = article.summary.toLowerCase();
    const body = article.sections.map(section => `${section.heading} ${section.paragraphs.join(" ")} ${(section.steps ?? []).join(" ")}`).join(" ").toLowerCase();
    let score = 0;
    for (const word of words) {
      if (title.includes(word)) score += title.startsWith(word) ? 6 : 4;
      else if (summary.includes(word)) score += 2;
      else if (body.includes(word)) score += 1;
      else return { article, score: 0 };
    }
    return { article, score: score + (article.popular ? .5 : 0) };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score).map(item => item.article);
}

/** The first sentence of the body that contains a query word, for result snippets. */
function snippetFor(article: HelpArticle, query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(word => word.length > 1);
  const text = article.sections.flatMap(section => [...section.paragraphs, ...(section.steps ?? [])]).join(" ");
  const sentences = text.split(/(?<=\.)\s+/);
  return sentences.find(sentence => words.some(word => sentence.toLowerCase().includes(word))) ?? article.summary;
}

function Highlight({ text, query }: { text: string; query: string }) {
  const words = query.trim().split(/\s+/).filter(Boolean).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${words.join("|")})`, "gi"));
  return <>{parts.map((part, index) => index % 2 ? <mark key={index}>{part}</mark> : <Fragment key={index}>{part}</Fragment>)}</>;
}

/** A help center: a big instant search, categories, and popular articles, opening into an article with a table of contents and feedback. */
export function HelpCenter({
  articles = sampleArticles,
  categories = sampleCategories,
  brand = "Northwind",
  heading = "How can we help?",
  defaultArticleId,
  search = searchArticles,
  onFeedback,
  onContact,
  onArticleOpen,
  suggestions = ["invoice", "single sign-on", "slack"],
  className,
}: HelpCenterProps) {
  const reduced = !!useReducedMotion();
  const [view, setView] = useState<View>(defaultArticleId ? { kind: "article", id: defaultArticleId } : { kind: "home" });
  const [direction, setDirection] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);
  const byId = useMemo(() => new Map(articles.map(article => [article.id, article])), [articles]);
  const category = (id: string) => categories.find(item => item.id === id);

  const go = (next: View) => {
    setDirection(depth(next) >= depth(view) ? 1 : -1);
    setView(next);
    if (next.kind === "article") { const article = byId.get(next.id); if (article) onArticleOpen?.(article); }
  };
  const openArticle = (article: HelpArticle) => go({ kind: "article", id: article.id });

  const article = view.kind === "article" ? byId.get(view.id) : undefined;
  const popular = articles.filter(item => item.popular).slice(0, 6);
  const shift = reduced ? 0 : 16;

  return <div className={[styles.root, className].filter(Boolean).join(" ")}>
    <header className={styles.top}>
      <button type="button" className={styles.brand} onClick={() => go({ kind: "home" })}><LifeBuoy size={18} strokeWidth={1.75} aria-hidden="true" /><span>{brand}</span><span className={styles.brandMuted}>Help</span></button>
      <AnimatePresence initial={false}>{view.kind !== "home" && <motion.div key="search" className={styles.topSearch} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: motionTokens.duration.instant } }} transition={{ duration: reduced ? 0 : motionTokens.duration.fast }}>
        <SearchBox size="sm" articles={articles} categories={categories} search={search} onOpen={openArticle} reduced={reduced} />
      </motion.div>}</AnimatePresence>
    </header>

    <div ref={scroller} className={styles.scroll}>
      {/* The page returns to the top once the old view has faded, so it never jumps while still on screen. */}
      <AnimatePresence mode="wait" initial={false} custom={direction} onExitComplete={() => scroller.current?.scrollTo({ top: 0 })}>
        <motion.div key={view.kind === "home" ? "home" : `${view.kind}-${view.id}`} className={styles.view}
          initial={{ opacity: 0, x: direction * shift }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: direction * -shift / 2, transition: { duration: reduced ? 0 : motionTokens.duration.instant, ease: easeStandard } }}
          transition={reduced ? { duration: motionTokens.duration.fast } : { duration: motionTokens.duration.standard, ease: easeEnter }}>
          {view.kind === "home" && <div className={styles.home}>
            <section className={styles.hero}>
              <h2>{heading}</h2>
              <SearchBox size="lg" articles={articles} categories={categories} search={search} onOpen={openArticle} reduced={reduced} suggestions={suggestions} />
            </section>
            <section aria-labelledby="help-categories" className={styles.section}>
              <h3 id="help-categories" className={styles.sectionTitle}>Browse by topic</h3>
              <ul className={styles.categories}>{categories.map(item => { const count = articles.filter(entry => entry.categoryId === item.id).length; return <li key={item.id}>
                <button type="button" className={styles.category} onClick={() => go({ kind: "category", id: item.id })}>
                  <span className={styles.categoryIcon} aria-hidden="true">{icons[item.icon]}</span>
                  <span className={styles.categoryName}>{item.name}</span>
                  <span className={styles.categoryText}>{item.description}</span>
                  <span className={styles.categoryCount}>{count} {count === 1 ? "article" : "articles"}</span>
                </button>
              </li>; })}</ul>
            </section>
            <section aria-labelledby="help-popular" className={styles.section}>
              <h3 id="help-popular" className={styles.sectionTitle}>Popular articles</h3>
              <ArticleList articles={popular} category={category} onOpen={openArticle} />
            </section>
            <ContactCard onContact={onContact} />
          </div>}

          {view.kind === "category" && (() => { const current = category(view.id); const list = articles.filter(item => item.categoryId === view.id); return <div className={styles.narrow}>
            <nav className={styles.crumbs} aria-label="Breadcrumb"><button type="button" onClick={() => go({ kind: "home" })}><ArrowLeft size={15} strokeWidth={1.75} aria-hidden="true" />All topics</button></nav>
            <div className={styles.categoryHead}><span className={styles.categoryIcon} aria-hidden="true">{current && icons[current.icon]}</span><div><h2>{current?.name}</h2><p>{current?.description}</p></div></div>
            <ArticleList articles={list} category={category} onOpen={openArticle} showSummary />
          </div>; })()}

          {view.kind === "article" && article && <ArticleView key={article.id} article={article} category={category(article.categoryId)} related={articles.filter(item => item.categoryId === article.categoryId && item.id !== article.id).slice(0, 3)}
            scroller={scroller} reduced={reduced} onBack={() => go({ kind: "category", id: article.categoryId })} onHome={() => go({ kind: "home" })} onOpen={openArticle} onFeedback={onFeedback} />}
          {view.kind === "article" && !article && <div className={styles.narrow}><p>This article was moved or deleted.</p><button type="button" className={styles.secondary} onClick={() => go({ kind: "home" })}>Back to help center</button></div>}
        </motion.div>
      </AnimatePresence>
    </div>
  </div>;
}

function ArticleList({ articles, category, onOpen, showSummary }: { articles: HelpArticle[]; category: (id: string) => HelpCategory | undefined; onOpen: (article: HelpArticle) => void; showSummary?: boolean }) {
  return <ul className={styles.articles}>{articles.map(article => <li key={article.id}>
    <button type="button" className={styles.articleRow} onClick={() => onOpen(article)}>
      <FileText size={16} strokeWidth={1.75} aria-hidden="true" />
      <span className={styles.articleRowText}><span className={styles.articleRowTitle}>{article.title}</span><span className={styles.muted}>{showSummary ? article.summary : category(article.categoryId)?.name}</span></span>
      <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" className={styles.chevron} />
    </button>
  </li>)}</ul>;
}

function ContactCard({ onContact }: { onContact?: () => void | Promise<void> }) {
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  const contact = async () => {
    if (state !== "idle") return;
    setState("busy");
    try { if (onContact) await onContact(); else await wait(700); setState("sent"); } catch { setState("idle"); }
  };
  return <section className={styles.contact}>
    <div><h3>Still need help?</h3><p className={styles.muted}>{state === "sent" ? "Request sent. We reply by email within one business day." : "Our support team replies within one business day."}</p></div>
    <button type="button" className={styles.primary} onClick={contact} disabled={state === "sent"} aria-live="polite">
      <span className={styles.stack}>
        <span data-shown={state === "idle"}>Contact support</span>
        <span data-shown={state === "busy"}><Loader2 size={15} strokeWidth={1.75} className={styles.spin} aria-hidden="true" />Sending</span>
        <span data-shown={state === "sent"}><Check size={15} strokeWidth={1.75} aria-hidden="true" />Request sent</span>
      </span>
    </button>
  </section>;
}

/** A combobox: results appear as you type, arrows move through them, Enter opens one, Escape clears. */
function SearchBox({ size, articles, categories, search, onOpen, reduced, suggestions }: { suggestions?: string[]; size: "lg" | "sm"; articles: HelpArticle[]; categories: HelpCategory[]; search: (query: string, articles: HelpArticle[]) => HelpArticle[]; onOpen: (article: HelpArticle) => void; reduced: boolean }) {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const results = useMemo(() => search(query, articles).slice(0, 6), [search, query, articles]);
  const open = focused && query.trim().length > 0;
  const index = Math.min(active, Math.max(0, results.length - 1));
  const categoryName = (id: string) => categories.find(item => item.id === id)?.name;

  const choose = (article: HelpArticle) => { setQuery(""); setFocused(false); input.current?.blur(); onOpen(article); };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!results.length) return;
      event.preventDefault();
      setActive((index + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
    } else if (event.key === "Enter") {
      if (results[index]) { event.preventDefault(); choose(results[index]); }
    } else if (event.key === "Escape") {
      if (query) { event.preventDefault(); setQuery(""); } else input.current?.blur();
    }
  };

  return <div className={styles.search} data-size={size} data-open={open || undefined} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setFocused(false); }}>
    <div className={styles.field}>
      <Search size={size === "lg" ? 18 : 15} strokeWidth={1.75} aria-hidden="true" />
      <input ref={input} type="text" role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={open && results[index] ? `${listId}-${results[index].id}` : undefined}
        value={query} onChange={event => { setQuery(event.target.value); setActive(0); }} onFocus={() => setFocused(true)} onKeyDown={onKeyDown}
        placeholder={size === "lg" ? "Search articles, like invite or SSO" : "Search help"} aria-label="Search help articles" autoComplete="off" spellCheck={false} />
      {query && <button type="button" className={styles.clear} onClick={() => { setQuery(""); input.current?.focus(); }} aria-label="Clear search"><X size={14} strokeWidth={1.75} /></button>}
    </div>
    {suggestions && <p className={styles.suggest}>Try {suggestions.map(word => <button key={word} type="button" className={styles.suggestion} onClick={() => { setQuery(word); setActive(0); input.current?.focus(); }}>{word}</button>)}</p>}
    <AnimatePresence>
      {open && <motion.div className={styles.results} initial={reduced ? { opacity: 0 } : { opacity: 0, y: -4, scale: .985 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, transition: { duration: motionTokens.duration.instant } }} transition={reduced ? instant : { duration: motionTokens.duration.fast, ease: easeEnter }}>
        <ul id={listId} role="listbox" aria-label="Matching articles">
          {results.map((article, position) => <li key={article.id} id={`${listId}-${article.id}`} role="option" aria-selected={position === index} className={styles.result} onMouseDown={event => event.preventDefault()} onMouseMove={() => { if (position !== index) setActive(position); }} onClick={() => choose(article)}>
            <span className={styles.resultTitle}><Highlight text={article.title} query={query} /></span>
            <span className={styles.resultSnippet}><Highlight text={snippetFor(article, query)} query={query} /></span>
            <span className={styles.resultMeta}>{categoryName(article.categoryId)}</span>
          </li>)}
        </ul>
        {!results.length && <p className={styles.noResults}>No articles match &ldquo;{query.trim()}&rdquo;. Try fewer words.</p>}
        <p className={styles.srOnly} role="status" aria-live="polite">{results.length} {results.length === 1 ? "result" : "results"}</p>
      </motion.div>}
    </AnimatePresence>
  </div>;
}

function ArticleView({ article, category, related, scroller, reduced, onBack, onHome, onOpen, onFeedback }: {
  article: HelpArticle; category?: HelpCategory; related: HelpArticle[]; scroller: RefObject<HTMLDivElement | null>; reduced: boolean;
  onBack: () => void; onHome: () => void; onOpen: (article: HelpArticle) => void; onFeedback?: (articleId: string, helpful: boolean, comment?: string) => void | Promise<void>;
}) {
  const [active, setActive] = useState<string | undefined>(article.sections[0]?.id);
  const tocId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const lockUntil = useRef(0);

  useEffect(() => {
    const scroll = scroller.current;
    if (!scroll) return;
    const onScroll = () => {
      if (performance.now() < lockUntil.current) return;
      const top = scroll.getBoundingClientRect().top + 96;
      const headings = [...(bodyRef.current?.querySelectorAll<HTMLElement>("[data-section]") ?? [])];
      const atEnd = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 4;
      const current = atEnd ? headings[headings.length - 1] : headings.filter(node => node.getBoundingClientRect().top <= top).pop() ?? headings[0];
      if (current) setActive(current.dataset.section);
    };
    scroll.addEventListener("scroll", onScroll, { passive: true });
    return () => scroll.removeEventListener("scroll", onScroll);
  }, [scroller]);

  const jump = (id: string, stamp: number) => {
    const scroll = scroller.current, node = bodyRef.current?.querySelector<HTMLElement>(`[data-section="${id}"]`);
    if (!scroll || !node) return;
    setActive(id);
    lockUntil.current = stamp + (reduced ? 50 : 700);
    scroll.scrollTo({ top: scroll.scrollTop + node.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 20, behavior: reduced ? "auto" : "smooth" });
    node.focus({ preventScroll: true });
  };

  return <div className={styles.articleLayout}>
    <article className={styles.article}>
      <nav className={styles.crumbs} aria-label="Breadcrumb">
        <button type="button" onClick={onHome}>Help</button><ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />
        <button type="button" onClick={onBack}>{category?.name ?? "Articles"}</button>
      </nav>
      <h2 className={styles.articleTitle}>{article.title}</h2>
      <p className={styles.articleMeta}><span>Updated {article.updated}</span><span aria-hidden="true">·</span><span className={styles.metaIcon}><Clock size={13} strokeWidth={1.75} aria-hidden="true" />{article.minutes} min read</span></p>
      <p className={styles.lede}>{article.summary}</p>
      <div ref={bodyRef} className={styles.prose}>
        {article.sections.map(section => <section key={section.id} aria-labelledby={`${tocId}-${section.id}`}>
          <h3 id={`${tocId}-${section.id}`} data-section={section.id} tabIndex={-1}>{section.heading}</h3>
          {section.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
          {section.steps && <ol>{section.steps.map(step => <li key={step}>{step}</li>)}</ol>}
        </section>)}
      </div>
      <Feedback key={article.id} articleId={article.id} reduced={reduced} onFeedback={onFeedback} />
      {related.length > 0 && <section className={styles.related} aria-labelledby={`${tocId}-related`}>
        <h3 id={`${tocId}-related`} className={styles.sectionTitle}>Related articles</h3>
        <ul>{related.map(item => <li key={item.id}><button type="button" onClick={() => onOpen(item)}>{item.title}<ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" /></button></li>)}</ul>
      </section>}
    </article>
    {article.sections.length > 1 && <aside className={styles.toc} aria-label="On this page">
      <p className={styles.tocTitle}>On this page</p>
      <LayoutGroup id={tocId}>
        <ul>{article.sections.map(section => <li key={section.id}>
          <button type="button" aria-current={active === section.id ? "location" : undefined} onClick={event => jump(section.id, event.timeStamp)}>
            {active === section.id && <motion.span layoutId="toc-bar" className={styles.tocBar} transition={reduced ? instant : motionTokens.spring.snappy} />}
            {section.heading}
          </button>
        </li>)}</ul>
      </LayoutGroup>
    </aside>}
  </div>;
}

function Feedback({ articleId, reduced, onFeedback }: { articleId: string; reduced: boolean; onFeedback?: (articleId: string, helpful: boolean, comment?: string) => void | Promise<void> }) {
  const [state, setState] = useState<"ask" | "comment" | "thanks">("ask");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const height = useMotionValue<number | "auto">("auto");
  // The card follows its content's measured height on a spring. A layout animation would scale the rows mid swap.
  useEffect(() => {
    const node = inner.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    let measured = false;
    const observer = new ResizeObserver(() => {
      const next = node.offsetHeight;
      if (!measured || reduced) { measured = next > 0; height.jump(next || "auto"); return; }
      animate(height, next, motionTokens.spring.smooth);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [height, reduced]);
  const send = async (helpful: boolean, note?: string) => {
    setBusy(true);
    try { await onFeedback?.(articleId, helpful, note); setState("thanks"); } catch { /* keep the question open so the person can retry */ }
    setBusy(false);
  };
  const swap = { initial: reduced ? { opacity: 0 } : { opacity: 0, y: 6, filter: `blur(${motionTokens.blur.subtle}px)` }, animate: { opacity: 1, y: 0, filter: "blur(0px)" }, exit: { opacity: 0, transition: { duration: motionTokens.duration.instant } }, transition: reduced ? instant : { duration: motionTokens.duration.standard, ease: easeEnter } };

  return <motion.section className={styles.feedback} aria-live="polite" style={{ height }}>
    <div ref={inner} className={styles.feedbackInner}><AnimatePresence mode="wait" initial={false}>
      {state === "ask" && <motion.div key="ask" className={styles.feedbackRow} {...swap}>
        <p>Was this article helpful?</p>
        <div className={styles.votes}>
          <button type="button" className={styles.vote} onClick={() => send(true)} disabled={busy}><ThumbsUp size={15} strokeWidth={1.75} aria-hidden="true" />Yes</button>
          <button type="button" className={styles.vote} onClick={() => { setState("comment"); requestAnimationFrame(() => textarea.current?.focus()); }}><ThumbsDown size={15} strokeWidth={1.75} aria-hidden="true" />No</button>
        </div>
      </motion.div>}
      {state === "comment" && <motion.form key="comment" className={styles.feedbackForm} {...swap} onSubmit={event => { event.preventDefault(); send(false, comment.trim() || undefined); }}>
        <label htmlFor={`${articleId}-comment`}>What was missing?</label>
        <textarea ref={textarea} id={`${articleId}-comment`} value={comment} onChange={event => setComment(event.target.value)} rows={3} placeholder="Tell us what you were looking for" />
        <div className={styles.votes}>
          <button type="button" className={styles.vote} onClick={() => setState("ask")}>Back</button>
          <button type="submit" className={styles.primary} disabled={busy}>Send feedback</button>
        </div>
      </motion.form>}
      {state === "thanks" && <motion.div key="thanks" className={styles.feedbackRow} {...swap}>
        <p className={styles.thanks}><Check size={16} strokeWidth={1.75} aria-hidden="true" />Thanks for the feedback.</p>
      </motion.div>}
    </AnimatePresence></div>
  </motion.section>;
}

export default HelpCenter;
