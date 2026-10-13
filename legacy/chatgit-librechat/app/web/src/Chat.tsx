import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import * as RadixPopover from "@radix-ui/react-popover";
import { GitBranch, GitMerge, RotateCw, Square, X } from "lucide-react";
import { Button } from "@/components/arc/button/button";
import { Badge } from "@/components/arc/badge/badge";
import { Breadcrumb } from "@/components/arc/breadcrumb/breadcrumb";
import { ScrollArea } from "@/components/arc/scroll-area/scroll-area";
import { Accordion } from "@/components/arc/accordion/accordion";
import { TextStream } from "@/components/arc/text-stream/text-stream";
import { CopyButton } from "@/components/arc/copy-button/copy-button";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { Textarea } from "@/components/arc/textarea/textarea";
import { ShortcutKbd } from "@/components/arc/shortcut-recorder/shortcut-recorder";
import { Popover, PopoverContent } from "@/components/arc/popover/popover";
import { SplitButton } from "@/components/arc/split-button/split-button";
import { contextPreview } from "./api";
import { copyMessages, t } from "./i18n";
import { children, pathOf, primaryChain, shortTitle, titleOf, type ContextPreview, type GNode, type Topic } from "./model";
import * as A from "./store";
import { Composer } from "./Composer";

const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

/* 在渲染好的回答里按文字找位置（忽略空白），用于 CSS 高亮，不改动 React 管理的 DOM */
function findRange(root: HTMLElement, quote: string): Range | null {
  const needle = quote.replace(/\s+/g, "");
  if (!needle) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const map: [Text, number][] = [];
  let hay = "";
  let tn: Node | null;
  while ((tn = walker.nextNode())) {
    const text = tn as Text;
    for (let i = 0; i < text.data.length; i++) {
      if (/\s/.test(text.data[i])) continue;
      hay += text.data[i];
      map.push([text, i]);
    }
  }
  const at = hay.indexOf(needle);
  if (at < 0) return null;
  const [sNode, sOff] = map[at];
  const [eNode, eOff] = map[at + needle.length - 1];
  const r = document.createRange();
  r.setStart(sNode, sOff);
  r.setEnd(eNode, eOff + 1);
  return r;
}
const hasHighlights = () => typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
const caretAt = (e: MouseEvent) => (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(e.clientX, e.clientY) ?? null;

type Pop = { source: string; text: string; rect: DOMRect };
type Badge = { key: string; n: string; dim: boolean; left: number; top: number };

export function Chat() {
  const S = A.useApp();
  const tp = A.topic()!;
  const viewport = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const asked = useRef<{ range: Range; target: string }[]>([]);
  const noted = useRef<{ range: Range; i: number; draft: string }[]>([]);
  const [badges, setBadges] = useState<Badge[]>([]);
  const [pop, setPop] = useState<Pop | null>(null);
  const path = pathOf(tp, tp.active);

  // 换到另一个节点时，滚到这条路径的最后一问
  useLayoutEffect(() => {
    const vp = viewport.current; if (!vp) return;
    const last = vp.querySelector<HTMLElement>("[data-turn]:last-of-type");
    vp.scrollTop = path.length > 1 && last ? last.offsetTop - 12 : 0;
  }, [tp.active, tp.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 原文标记：已问过的片段（虚线，点击跳到分支）与草稿条目（编号高亮）
  const decoKey = path.map((id) => { const n = tp.nodes.get(id)!; return id + n.status + children(tp, id).length; }).join("|")
    + "#" + tp.drafts.map((d) => d.id + ":" + d.items.map((p) => p.source + p.quote).join("|")).join("#") + tp.activeDraft;
  const decorate = useCallback(() => {
    const root = inner.current; if (!root || !hasHighlights()) return;
    const askedRanges: { range: Range; target: string }[] = [];
    const notes: Range[] = [];
    const dimNotes: Range[] = [];
    const noteRanges: { range: Range; i: number; draft: string }[] = [];
    const next: Badge[] = [];
    const multi = A.multiDraft(tp);
    const box = root.getBoundingClientRect();
    for (const id of path) {
      const n = tp.nodes.get(id)!;
      if (n.status !== "done" && n.status !== "stopped") continue;
      const body = root.querySelector<HTMLElement>(`[data-body="${id}"]`); if (!body) continue;
      for (const k of children(tp, id)) for (const it of k.items ?? []) if (it.source === id) {
        const r = findRange(body, it.quote); if (r) askedRanges.push({ range: r, target: k.id });
      }
      for (const d of tp.drafts) d.items.forEach((p, i) => {
        if (p.source !== id) return;
        const r = findRange(body, p.quote); if (!r) return;
        const dim = multi && d.id !== tp.activeDraft;
        (dim ? dimNotes : notes).push(r);
        noteRanges.push({ range: r, i, draft: d.id });
        const rects = r.getClientRects(); const last = rects[rects.length - 1];
        if (last) next.push({ key: d.id + i, n: (multi ? d.letter : "") + (i + 1), dim, left: last.right - box.left, top: last.top - box.top });
      });
    }
    asked.current = askedRanges;
    noted.current = noteRanges;
    CSS.highlights.set("cg-asked", new Highlight(...askedRanges.map((a) => a.range)));
    CSS.highlights.set("cg-note", new Highlight(...notes));
    CSS.highlights.set("cg-note-dim", new Highlight(...dimNotes));
    setBadges(next);
  }, [decoKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { decorate(); }, [decorate]);
  useEffect(() => {
    const root = inner.current; if (!root) return;
    const ro = new ResizeObserver(() => decorate());
    ro.observe(root);
    return () => ro.disconnect();
  }, [decorate]);
  useEffect(() => () => { if (hasHighlights()) ["cg-asked", "cg-note", "cg-note-dim", "cg-sel"].forEach((k) => CSS.highlights.delete(k)); }, []);

  const hit = <T extends { range: Range }>(list: T[], e: MouseEvent) => {
    const c = caretAt(e); if (!c) return null;
    return list.find((a) => a.range.isPointInRange(c.startContainer, c.startOffset)) ?? null;
  };
  const trySelection = () => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    const el = (x: Node) => (x.nodeType === 1 ? (x as Element) : x.parentElement)!;
    const body = el(range.startContainer).closest<HTMLElement>("[data-body]");
    if (!body || body !== el(range.endContainer).closest("[data-body]")) return false;
    const n = tp.nodes.get(body.dataset.body!);
    if (!n || (n.status !== "done" && n.status !== "stopped")) return false;
    const text = sel.toString().replace(/\s+/g, " ").trim().slice(0, 1500);
    if (!text) return false;
    if (hasHighlights()) CSS.highlights.set("cg-sel", new Highlight(range.cloneRange()));
    setPop({ source: n.id, text, rect: range.getBoundingClientRect() });
    sel.removeAllRanges();
    return true;
  };
  const onMouseUp = (e: MouseEvent) => {
    window.setTimeout(() => {
      if (trySelection()) return;
      const a = hit(asked.current, e);
      if (a) { A.openReading(a.target); return; }
      const note = hit(noted.current, e);
      if (!note) return;
      if (note.draft !== A.topic()!.activeDraft) A.setActiveDraft(note.draft);
      requestAnimationFrame(() => {
        const li = document.querySelector<HTMLElement>(`[data-tray-item="${note.i}"]`);
        if (!li) return;
        li.scrollIntoView({ block: "nearest" });
        li.dataset.flash = "";
        window.setTimeout(() => delete li.dataset.flash, 700);
        li.querySelector<HTMLElement>("[role='button'], button, [tabindex]")?.focus();
      });
    }, 0);
  };
  const onKeyUp = (e: KeyboardEvent) => { if (e.shiftKey && /Arrow|Home|End/.test(e.key)) trySelection(); };
  const onMouseMove = (e: MouseEvent) => { if (viewport.current) viewport.current.style.cursor = hit(asked.current, e) || hit(noted.current, e) ? "pointer" : ""; };
  const closePop = () => { setPop(null); if (hasHighlights()) CSS.highlights.delete("cg-sel"); };

  const chain = primaryChain(tp, tp.active);
  const crumbs = chain.length > 3 ? [chain[0], chain[chain.length - 2], chain[chain.length - 1]] : chain;

  return <section className="cg-chat" aria-label={t("分支对话")}>
    <header className="cg-chat-head">
      {crumbs.length ? <Breadcrumb ariaLabel={t("当前路径")} items={crumbs.map((id, i) => ({
        label: (chain.length > 3 && i === 1 ? "… / " : "") + shortTitle(tp.nodes.get(id)!, crumbs.length > 2 ? 9 : 14),
        onClick: id === tp.active ? undefined : () => A.openReading(id),
      }))} /> : <span className="cg-muted">{t("还没有对话")}</span>}
    </header>
    <div className="cg-thread-wrap">
      <ScrollArea className="cg-thread" viewportRef={viewport} label={t("对话内容")}>
        {!tp.active
          ? <div className="cg-thread-empty"><EmptyState
              title={tp.nodes.size ? t("选择一个节点") : t("这里会显示一条分支的完整对话")}
              description={tp.nodes.size ? t("在画布上点击任意节点，从起点到它的整条对话会显示在这里。") : t("在下面输入第一个问题。回答完成后，可以选中其中的词句继续追问。")}
              icon={<GitBranch size={20} />} /></div>
          : <div ref={inner} className="cg-inner" onMouseUp={onMouseUp} onKeyUp={onKeyUp} onMouseMove={onMouseMove}>
              <ContextSummary tp={tp} path={path} />
              {path.map((id, i) => <Turn key={id} n={tp.nodes.get(id)!} isLast={i === path.length - 1} path={path} />)}
              {badges.map((b) => <span key={b.key} className="cg-note-badge" data-dim={b.dim || undefined} style={{ left: b.left, top: b.top }} aria-hidden="true">{b.n}</span>)}
            </div>}
      </ScrollArea>
    </div>
    <Composer />
    <SelectionPopover pop={pop} onClose={closePop} />
    {S.loadingTopic && <div className="cg-loading" aria-live="polite">{t("正在打开…")}</div>}
  </section>;
}

/* 下一问会带上的上下文：由服务端按同一套规则计算 */
function ContextSummary({ tp, path }: { tp: Topic; path: string[] }) {
  const [preview, setPreview] = useState<ContextPreview | null>(null);
  const active = tp.active;
  const key = path.map((id) => id + (tp.nodes.get(id)?.status ?? "") + (tp.nodes.get(id)?.summary ? "s" : "")).join("|");
  useEffect(() => {
    let alive = true;
    if (!active || path.length < 2) { setPreview(null); return; }
    const n = tp.nodes.get(active);
    if (!n || (n.status !== "done" && n.status !== "stopped")) return;
    contextPreview(tp.id, [active]).then((p) => { if (alive) setPreview(p); }).catch(() => {});
    return () => { alive = false; };
  }, [tp.id, key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!preview || preview.turns.length < 2) return null;
  const raw = preview.turns.filter((x) => x.mode === "raw").length;
  const summary = preview.turns.length - raw;
  const sum = summary ? t("{raw} 轮原文，{summary} 轮压缩为摘要", { raw, summary }) : t("{n} 轮全部原文", { n: raw });
  const merged = path.some((id) => tp.nodes.get(id)!.parentIds.length > 1);
  return <div className="cg-ctx"><Accordion defaultOpen={-1} items={[{
    title: t("下一问会带上：{sum}", { sum }) + (merged ? t("，共同历史只计一次") : ""),
    content: <ol className="cg-ctx-list">{preview.turns.map((turn) => <li key={turn.id}><span>{turn.title}</span>
      <Badge size="sm" tone={turn.mode === "raw" ? "info" : "neutral"}>{turn.mode === "raw" ? t("原文") : t("摘要")}</Badge></li>)}</ol>,
  }]} /></div>;
}

function Turn({ n, isLast, path }: { n: GNode; isLast: boolean; path: string[] }) {
  A.useApp();
  const tp = A.topic()!;
  const kids = children(tp, n.id);
  const next = path.find((p) => tp.nodes.get(p)!.parentIds.includes(n.id));
  const others = kids.filter((k) => k.id !== next);
  const done = n.status === "done";
  return <article className="cg-turn" data-turn={n.id} aria-label={titleOf(n)}>
    {n.parentIds.length > 1 && <span className="cg-turn-badge"><GitMerge size={13} aria-hidden="true" />{t("合并自 {n} 个节点：", { n: n.parentIds.length })}{n.parentIds.map((p) => tp.nodes.get(p) ? `「${shortTitle(tp.nodes.get(p)!)}」` : "").join(" ")}</span>}
    <div className="cg-ask">
      {n.items ? n.items.map((it, i) => <div className="cg-ask-item" key={i}><blockquote>{it.quote}</blockquote><p>{it.q || t("请解释这段内容。")}</p></div>) : null}
      {n.question && <div className="cg-ask-item"><p>{n.question}</p></div>}
    </div>
    <div className="cg-answer" data-body={n.id}>
      {n.answer || n.status !== "streaming"
        ? <TextStream text={n.answer} markdown streaming={n.status === "streaming"} smooth={n.status === "streaming"} className="cg-md" />
        : <p className="cg-muted cg-thinking">{t("正在思考…")}</p>}
    </div>
    <div className="cg-foot">
      {n.status === "streaming" && <><Badge size="sm" tone="info">{t("正在回答")}</Badge><Button size="sm" variant="ghost" onClick={() => A.stop(n.id)}><Square size={12} aria-hidden="true" />{t("停止")}</Button></>}
      {n.status === "error" && <><span className="cg-danger">{A.errorText(n.error)}</span><Button size="sm" variant="secondary" onClick={() => A.retry(n.id)}><RotateCw size={13} aria-hidden="true" />{t("重试")}</Button></>}
      {n.status === "stopped" && <span className="cg-muted">{t("已停止生成")}</span>}
      {(done || n.status === "stopped") && n.answer && <CopyButton value={n.answer} label={t("复制")} variant="plain" messages={copyMessages()} />}
      {n.model && <span className="cg-model-tag">{n.model}</span>}
    </div>
    {isLast && kids.length > 0 && <Forks head={t("从这里分出的 {n} 个分支", { n: kids.length })} kids={kids} />}
    {!isLast && others.length > 0 && <Forks head={t("此处还有 {n} 个其他分支", { n: others.length })} kids={others} />}
    {isLast && done && n.suggestions?.length ? <div className="cg-sugs"><span className="cg-sugs-head">{t("可以接着问")}</span>
      {n.suggestions.map((s) => <Button key={s} size="sm" variant="secondary" onClick={() => A.suggest(s)}>{s}</Button>)}</div> : null}
  </article>;
}

function Forks({ head, kids }: { head: string; kids: GNode[] }) {
  return <nav className="cg-forks" aria-label={head}>
    <div className="cg-forks-head">{head}</div>
    {kids.map((k) => <button type="button" key={k.id} className="cg-row cg-fork" onClick={() => A.openReading(k.id)}>
      {k.parentIds.length > 1 ? <GitMerge size={14} aria-hidden="true" /> : <GitBranch size={14} aria-hidden="true" />}
      <span className="cg-fork-t">{titleOf(k)}</span>
      {k.status === "streaming" && <Badge size="sm" tone="info">{t("生成中")}</Badge>}
      {k.status === "error" && <Badge size="sm" tone="danger">{t("生成中断")}</Badge>}
    </button>)}
  </nav>;
}

/* 划词提问浮窗：小输入框，立即发送或加入草稿 */
function SelectionPopover({ pop, onClose }: { pop: Pop | null; onClose: () => void }) {
  A.useApp();
  const [q, setQ] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setQ(""); }, [pop]);
  if (!pop) return null;
  const tp = A.topic()!;
  const cur = A.activeDraft(tp);
  const count = cur.items.length;
  const others = tp.drafts.filter((d) => d.id !== cur.id);
  const act = (kind: "send" | "add", target?: string) => {
    if (kind === "send") A.sendQuote(pop.source, pop.text, q.trim());
    else A.addPending(pop.source, pop.text, q.trim(), target);
    onClose();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    if ((e.metaKey || e.ctrlKey) && e.shiftKey) { e.preventDefault(); act("add", count ? "new" : undefined); }
    else if (e.metaKey || e.ctrlKey) { e.preventDefault(); act("add"); }
    else if (!e.shiftKey) { e.preventDefault(); act("send"); }
  };
  const anchor = { current: { getBoundingClientRect: () => pop.rect } };
  return <Popover open onOpenChange={(o) => { if (!o) onClose(); }}>
    <RadixPopover.Anchor virtualRef={anchor as never} />
    <PopoverContent side="bottom" align="center" className="cg-pop" aria-label={t("就选中的内容提问")}
      onOpenAutoFocus={(e) => { e.preventDefault(); ta.current?.focus(); }}
      onInteractOutside={(e) => { if (q.trim()) e.preventDefault(); }}>
      <div className="cg-pop-head">
        <blockquote>{pop.text}</blockquote>
        <Button size="sm" variant="ghost" aria-label={t("关闭")} onClick={onClose}><X size={14} /></Button>
      </div>
      <Textarea ref={ta} label={t("就这段内容提问")} rows={2} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown} placeholder={t("想问什么？留空则请 AI 解释这段")} />
      <div className="cg-pop-hint">
        <span><ShortcutKbd size="sm">Enter</ShortcutKbd> {t("发送为新分支")}</span>
        <span><ShortcutKbd size="sm">{MOD}</ShortcutKbd><ShortcutKbd size="sm">Enter</ShortcutKbd> {t("加入{name}", { name: A.draftLabel(cur) })}</span>
        {count > 0 && <span><ShortcutKbd size="sm">{MOD}</ShortcutKbd><ShortcutKbd size="sm">Shift</ShortcutKbd><ShortcutKbd size="sm">Enter</ShortcutKbd> {t("加入新草稿")}</span>}
        <span><ShortcutKbd size="sm">Shift</ShortcutKbd><ShortcutKbd size="sm">Enter</ShortcutKbd> {t("换行")}</span>
      </div>
      <div className="cg-pop-actions">
        {count > 0
          ? <SplitButton variant="secondary" label={t("加入{name}（{n}）", { name: A.draftLabel(cur), n: count })} onClick={() => act("add")} actions={[
              ...others.map((d) => ({ label: t("加入{name}（{n} 条）", { name: A.draftLabel(d), n: d.items.length }), onSelect: () => act("add", d.id) })),
              { label: t("加入新草稿"), onSelect: () => act("add", "new") },
            ]} />
          : <Button size="sm" variant="secondary" onClick={() => act("add")}>{t("加入{name}", { name: A.draftLabel(cur) })}</Button>}
        <Button size="sm" onClick={() => act("send")}><GitBranch size={14} aria-hidden="true" />{t("发送为新分支")}</Button>
      </div>
    </PopoverContent>
  </Popover>;
}
