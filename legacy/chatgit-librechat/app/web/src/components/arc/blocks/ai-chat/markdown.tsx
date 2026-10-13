"use client";

import { createContext, Fragment, useContext, useState } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, CircleAlert, Copy } from "lucide-react";
import { useCopyFeedback } from "../../lib/use-copy-feedback";
import styles from "./ai-chat.module.css";

/**
 * A small streaming friendly markdown renderer for chat answers: headings, paragraphs, lists, quotes, tables, fenced code with copy,
 * bold, inline code, links, and citations written as [1]. Blocks and words keep their keys as text grows, so only new words animate in.
 */

type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string }
  | { kind: "cite"; n: number };

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "h"; level: 2 | 3 | 4; text: string }
  | { kind: "ul" | "ol"; items: string[]; start: number }
  | { kind: "quote"; lines: string[] }
  | { kind: "code"; lang: string; lines: string[]; closed: boolean }
  | { kind: "table"; head: string[]; rows: string[][]; align: ("left" | "right" | "center")[] };

const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim());

export function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r/g, "").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    const fence = line.match(/^```\s*([\w+-]*)/);
    if (fence) {
      const body: string[] = [];
      index++;
      while (index < lines.length && !lines[index].startsWith("```")) body.push(lines[index++]);
      const closed = index < lines.length;
      if (closed) index++;
      blocks.push({ kind: "code", lang: fence[1] || "text", lines: body, closed });
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) { blocks.push({ kind: "h", level: (heading[1].length + 1) as 2 | 3 | 4, text: heading[2] }); index++; continue; }
    if (line.startsWith("|") && /^\|\s*:?-/.test(lines[index + 1] ?? "")) {
      const head = cells(line);
      const align = cells(lines[index + 1]).map(cell => cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "left") as ("left" | "right" | "center")[];
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].startsWith("|")) rows.push(cells(lines[index++]));
      blocks.push({ kind: "table", head, rows, align });
      continue;
    }
    const bullet = /^[-*]\s+/, numbered = /^(\d+)\.\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const pattern = ordered ? numbered : bullet;
      const start = ordered ? Number(line.match(numbered)?.[1] ?? 1) : 1;
      const items: string[] = [];
      while (index < lines.length && pattern.test(lines[index])) items.push(lines[index++].replace(pattern, ""));
      blocks.push({ kind: ordered ? "ol" : "ul", items, start });
      continue;
    }
    if (line.startsWith("> ")) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].startsWith("> ")) quote.push(lines[index++].slice(2));
      blocks.push({ kind: "quote", lines: quote });
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !/^(```|#{1,3}\s|[-*]\s|\d+\.\s|> )/.test(lines[index]) && !(lines[index].startsWith("|") && /^\|\s*:?-/.test(lines[index + 1] ?? ""))) paragraph.push(lines[index++]);
    if (!paragraph.length) paragraph.push(lines[index++]);
    blocks.push({ kind: "p", lines: paragraph });
  }
  return blocks;
}

function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`|\[(\d{1,2})\](?!\()|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) out.push({ kind: "text", text: text.slice(last, at) });
    if (match[1] !== undefined) out.push({ kind: "strong", children: parseInline(match[1]) });
    else if (match[2] !== undefined) out.push({ kind: "code", text: match[2] });
    else if (match[3] !== undefined) out.push({ kind: "cite", n: Number(match[3]) });
    else out.push({ kind: "link", text: match[4], href: match[5] });
    last = at + match[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

/** Strips markdown to plain text, for copying and for screen readers. */
export function plainText(markdown: string) {
  return markdown.replace(/```[\w+-]*\n?/g, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\s?\[(\d{1,2})\](?!\()/g, "").replace(/^#{1,3}\s+/gm, "");
}

export type CiteRenderer = (n: number, key: string) => ReactNode;
const Stream = createContext<{ animate: boolean; cite: CiteRenderer }>({ animate: false, cite: n => `[${n}]` });

/** A word decides at mount whether it fades in, so words that already landed never replay. */
function Word({ children }: { children: string }) {
  const { animate } = useContext(Stream);
  const [enter] = useState(animate);
  return <span className={enter ? `${styles.word} ${styles.wordIn}` : styles.word}>{children}</span>;
}

function Words({ text, id }: { text: string; id: string }) {
  const parts = text.split(/(\s+)/);
  return <>{parts.map((part, index) => !part ? null : /^\s+$/.test(part) ? <Fragment key={`${id}-${index}`}>{part}</Fragment> : <Word key={`${id}-${index}`}>{part}</Word>)}</>;
}

function Inlines({ nodes, id }: { nodes: Inline[]; id: string }) {
  const { cite } = useContext(Stream);
  return <>{nodes.map((node, index) => {
    const key = `${id}.${index}`;
    if (node.kind === "text") return <Words key={key} text={node.text} id={key} />;
    if (node.kind === "strong") return <strong key={key}><Inlines nodes={node.children} id={key} /></strong>;
    if (node.kind === "code") return <Enter key={key}><code className={styles.inlineCode}>{node.text}</code></Enter>;
    if (node.kind === "link") return <a key={key} className={styles.link} href={node.href} target="_blank" rel="noreferrer"><Words text={node.text} id={key} /></a>;
    return <Fragment key={key}>{cite(node.n, key)}</Fragment>;
  })}</>;
}

function Enter({ children }: { children: ReactNode }) {
  const { animate } = useContext(Stream);
  const [enter] = useState(animate);
  return <span className={enter ? styles.wordIn : undefined} style={{ display: "inline-block" }}>{children}</span>;
}

function Line({ text, id }: { text: string; id: string }) {
  return <Inlines nodes={parseInline(text)} id={id} />;
}

/** Plain regex highlighting for common chat languages. Good enough for short answers; swap in your highlighter for more. */
const KEYWORDS: Record<string, RegExp> = {
  sql: /\b(select|from|where|and|or|not|in|join|left|right|inner|outer|on|group|by|order|having|limit|as|create|table|primary|key|default|insert|into|values|update|set|delete|distinct|count|sum|avg|now|interval|with|null|true|false|references|index|if|exists|desc|asc)\b/gi,
  ts: /\b(const|let|var|function|return|if|else|for|while|await|async|import|from|export|type|interface|new|class|extends|true|false|null|undefined)\b/g,
  bash: /\b(npm|npx|pnpm|git|cd|echo|export|curl|sudo)\b/g,
};
KEYWORDS.js = KEYWORDS.ts; KEYWORDS.tsx = KEYWORDS.ts; KEYWORDS.typescript = KEYWORDS.ts; KEYWORDS.javascript = KEYWORDS.ts; KEYWORDS.sh = KEYWORDS.bash;

function highlight(line: string, lang: string): ReactNode[] {
  const keywords = KEYWORDS[lang.toLowerCase()];
  if (!keywords) return [line];
  const comment = lang === "sql" ? "--" : lang === "bash" || lang === "sh" ? "#" : "//";
  const at = line.indexOf(comment);
  const code = at >= 0 ? line.slice(0, at) : line, rest = at >= 0 ? line.slice(at) : "";
  const out: ReactNode[] = [];
  const token = new RegExp(`('[^']*'|"[^"]*"|\\$\\d+|\\b\\d+(?:\\.\\d+)?\\b|${keywords.source})`, "gi");
  let last = 0, index = 0;
  for (const match of code.matchAll(token)) {
    const start = match.index ?? 0;
    if (start > last) out.push(code.slice(last, start));
    const value = match[0];
    const kind = /^['"]/.test(value) ? "string" : /^\$|^\d/.test(value) ? "number" : "keyword";
    out.push(<span key={index++} className={styles[`tok-${kind}`]}>{value}</span>);
    last = start + value.length;
  }
  if (last < code.length) out.push(code.slice(last));
  if (rest) out.push(<span key="comment" className={styles["tok-comment"]}>{rest}</span>);
  return out;
}

const iconSwap = { initial: { opacity: 0, scale: .8 }, animate: { opacity: 1, scale: 1 }, exit: { opacity: 0, scale: .8 } };

/** A copy control whose icon and label trade places without changing its width. */
export function CopyControl({ value, label = "Copy", done = "Copied", reduced, className, iconOnly = false }: { value: string; label?: string; done?: string; reduced: boolean; className?: string; iconOnly?: boolean }) {
  const { state, copy } = useCopyFeedback(1600);
  const text = state === "copied" ? done : state === "error" ? "Failed" : label;
  const Icon = state === "copied" ? Check : state === "error" ? CircleAlert : Copy;
  return <button type="button" className={className} data-state={state} aria-label={iconOnly ? text : undefined} onClick={() => copy(value)}>
    <span className={styles.swapCell} aria-hidden="true">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span key={state} className={styles.swapItem} {...(reduced ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } } : iconSwap)} transition={{ duration: reduced ? .1 : .2 }}>
          <Icon size={15} strokeWidth={1.75} />
        </motion.span>
      </AnimatePresence>
    </span>
    {!iconOnly && <span className={styles.copyLabel}>
      {[label, done, "Failed"].map(option => <span key={option} data-on={option === text || undefined} aria-hidden={option !== text || undefined}>{option}</span>)}
    </span>}
    <span className={styles.srOnly} aria-live="polite">{state === "copied" ? "Copied to clipboard" : state === "error" ? "Copy failed" : ""}</span>
  </button>;
}

function CodeBlock({ lang, lines, closed, reduced }: { lang: string; lines: string[]; closed: boolean; reduced: boolean }) {
  return <div className={styles.codeBlock} data-open={!closed || undefined}>
    <div className={styles.codeHead}>
      <span className={styles.codeLang}>{lang === "text" ? "Code" : lang.toUpperCase() === "SQL" ? "SQL" : lang}</span>
      <CopyControl value={lines.join("\n")} reduced={reduced} className={styles.codeCopy} />
    </div>
    <pre className={styles.pre}><code>{lines.map((line, index) => <CodeLine key={index} line={line} lang={lang} />)}</code></pre>
  </div>;
}

function CodeLine({ line, lang }: { line: string; lang: string }) {
  const { animate } = useContext(Stream);
  const [enter] = useState(animate);
  return <span className={enter ? `${styles.codeLine} ${styles.lineIn}` : styles.codeLine}>{line ? highlight(line, lang) : " "}</span>;
}

function Row({ cells: values, align, id, head = false }: { cells: string[]; align: ("left" | "right" | "center")[]; id: string; head?: boolean }) {
  const { animate } = useContext(Stream);
  const [enter] = useState(animate);
  const Cell = head ? "th" : "td";
  return <tr className={enter ? styles.lineIn : undefined}>{values.map((value, index) => <Cell key={index} style={{ textAlign: align[index] ?? "left" }} scope={head ? "col" : undefined}><Line text={value} id={`${id}.${index}`} /></Cell>)}</tr>;
}

export function Markdown({ text, streaming, reduced, cite }: { text: string; streaming: boolean; reduced: boolean; cite: CiteRenderer }) {
  const blocks = parseBlocks(text);
  return <Stream.Provider value={{ animate: streaming && !reduced, cite }}>
    <div className={styles.markdown}>
      {blocks.map((block, index) => {
        const id = `b${index}`;
        switch (block.kind) {
          case "h": { const Tag = `h${block.level}` as "h2" | "h3" | "h4"; return <Tag key={id} className={styles.heading}><Line text={block.text} id={id} /></Tag>; }
          case "p": return <p key={id}>{block.lines.map((line, at) => <Fragment key={at}>{at > 0 && <br />}<Line text={line} id={`${id}.${at}`} /></Fragment>)}</p>;
          case "quote": return <blockquote key={id}>{block.lines.map((line, at) => <p key={at}><Line text={line} id={`${id}.${at}`} /></p>)}</blockquote>;
          case "ul": return <ul key={id}>{block.items.map((item, at) => <li key={at}><Line text={item} id={`${id}.${at}`} /></li>)}</ul>;
          case "ol": return <ol key={id} start={block.start}>{block.items.map((item, at) => <li key={at}><Line text={item} id={`${id}.${at}`} /></li>)}</ol>;
          case "code": return <CodeBlock key={id} lang={block.lang} lines={block.lines} closed={block.closed} reduced={reduced} />;
          case "table": return <div key={id} className={styles.tableWrap} tabIndex={0} role="region" aria-label="Table">
            <table>
              <thead><Row cells={block.head} align={block.align} id={`${id}.h`} head /></thead>
              <tbody>{block.rows.map((row, at) => <Row key={at} cells={row} align={block.align} id={`${id}.${at}`} />)}</tbody>
            </table>
          </div>;
        }
      })}
    </div>
  </Stream.Provider>;
}

/** Plain streamed text, such as reasoning: the same calm per-word fade as answers, without markdown blocks. */
export function StreamText({ text, streaming, reduced, className }: { text: string; streaming: boolean; reduced: boolean; className?: string }) {
  return <Stream.Provider value={{ animate: streaming && !reduced, cite: n => `[${n}]` }}>
    <p className={className}>{text.split("\n").map((line, at) => <Fragment key={at}>{at > 0 && <br />}<Words text={line} id={`t${at}`} /></Fragment>)}</p>
  </Stream.Provider>;
}
