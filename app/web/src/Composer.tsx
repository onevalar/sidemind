import { useEffect, useRef } from "react";
import { GitMerge, ListPlus, LocateFixed, Plus, Send, X } from "lucide-react";
import { Button } from "@/components/arc/button/button";
import { Badge } from "@/components/arc/badge/badge";
import { InlineEdit } from "@/components/arc/inline-edit/inline-edit";
import { ShortcutKbd } from "@/components/arc/shortcut-recorder/shortcut-recorder";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import { ChatComposer, type ChatComposerHandle, type ChatDraft } from "@/components/arc/chat-thread/chat-thread";
import { editMessages, t } from "./i18n";
import { draftNodeId, minimalParents, shortTitle, titleOf } from "./model";
import * as A from "./store";

/* 唯一的输入框：说明这一问接在哪里；草稿分支在这里编辑和发送 */
export function Composer() {
  const S = A.useApp();
  const tp = A.topic()!;
  const target = A.composerTarget();
  const ref = useRef<ChatComposerHandle>(null);
  const draft = A.activeDraft(tp);
  const anyDraft = tp.drafts.some((d) => d.items.length);
  const tray = anyDraft ? draft.items : [];
  const multiDraft = A.multiDraft(tp);
  const tabs = A.liveDrafts(tp);
  const sources = [...new Set(tray.map((p) => p.source))];
  const parents = minimalParents(tp, sources);
  useEffect(() => { if (S.composerFocus) ref.current?.focus(); }, [S.composerFocus]);

  if (target.kind === "blocked") return <div className="cg-composer"><p className="cg-comp-note">{target.reason}</p></div>;

  const onSend = ({ text }: ChatDraft) => {
    if (tray.length) { A.sendPending(text); return; }
    if (S.multi) { A.enqueue(text); return; }
    A.sendQuestions(target.parents, [text]);
  };

  let meta;
  if (target.kind === "merge") meta = <><strong>{t("合并提问")}</strong><span>{t("基于")}</span>
    {target.parents.map((id) => tp.nodes.get(id) && <span className="cg-chip" key={id}><span>{shortTitle(tp.nodes.get(id)!)}</span>
      <button type="button" aria-label={t("移除「{title}」", { title: shortTitle(tp.nodes.get(id)!) })} onClick={() => A.dropMerge(id)}><X size={12} /></button></span>)}
    <Button size="sm" variant="ghost" onClick={A.exitMerge}>{t("取消合并")}</Button></>;
  else if (target.kind === "continue") meta = <><strong>{t("继续追问")}</strong><span>{t("接在")}</span><span className="cg-tgt">「{titleOf(target.a)}」</span><span>{t("之后")}</span></>;
  else if (target.kind === "fork") meta = <><strong>{t("新建分支")}</strong><span>{t("「{title}」已有 {n} 个后续，这一问会成为第 {m} 个", { title: shortTitle(target.a), n: target.kids, m: target.kids + 1 })}</span></>;
  else if (target.kind === "root") meta = <><strong>{t("第一个问题")}</strong><span>{t("从这里开始一张新画布")}</span></>;
  else meta = <><strong>{t("新的起点")}</strong><span>{t("不接任何已有对话，在画布上另起一棵树")}</span></>;

  const placeholder = tray.length ? t("补充一个总的问题（可选），回车发送") : S.multi ? t("输入一个问题，回车加入列表") : target.kind === "merge" ? t("比较、综合这几个节点…") : target.kind.startsWith("root") ? t("想研究什么？") : t("继续问…");

  return <div className="cg-composer">
    <div className="cg-comp-meta">{meta}</div>
    {anyDraft && <div className="cg-tray" data-compact role="group" aria-label={t("草稿分支")}>
      {tabs.length > 1 && <div className="cg-tray-tabs">
        <SegmentedControl label={t("草稿")} value={draft.id} onValueChange={A.setActiveDraft}
          options={tabs.map((d) => ({ value: d.id, label: A.draftLabel(d), accessory: <Badge size="sm">{d.items.length}</Badge> }))} />
        <Button size="sm" variant="ghost" disabled={!draft.items.length} onClick={() => { A.newDraft(); A.focusComposer(); }}><Plus size={14} aria-hidden="true" />{t("新草稿")}</Button>
      </div>}
      <div className="cg-tray-head">
        <span className="cg-tray-name"><InlineEdit messages={editMessages()} value={draft.name} onSave={(v) => A.renameDraft(draft.id, v)} label={t("草稿名称")} placeholder={t("草稿 {letter}", { letter: draft.letter })} variant="body" /></span>
        <span className="cg-tray-sub">{!tray.length ? t("空草稿：划词后加入") : parents.length > 1 ? t("将合并接在 {n} 个节点之后", { n: parents.length }) : ""}</span>
        <span className="cg-tray-actions">
          {tabs.length < 2 && <Button size="sm" variant="ghost" disabled={!draft.items.length} onClick={() => { A.newDraft(); A.focusComposer(); }}><Plus size={14} aria-hidden="true" />{t("新草稿")}</Button>}
          {S.view !== "chat" && tray.length > 0 && <Button size="sm" variant="ghost" aria-label={t("在画布中查看{name}", { name: A.draftLabel(draft) })} onClick={() => A.locate(draftNodeId(draft))}><LocateFixed size={14} /></Button>}
          <Button size="sm" variant="ghost" disabled={!tray.length} onClick={() => A.clearPending()}>{t("清空")}</Button>
          <Button size="sm" disabled={!tray.length} onClick={() => A.sendPending()}><Send size={14} aria-hidden="true" />{multiDraft ? t("发送{name}", { name: A.draftLabel(draft) }) : t("作为一个分支发送")}</Button>
        </span>
      </div>
      <ul>{tray.map((it, i) => <li key={i} data-tray-item={i}>
        <span className="cg-num" aria-hidden="true">{multiDraft ? draft.letter : ""}{i + 1}</span>
        <div className="cg-tray-body"><blockquote>{it.quote}</blockquote>
          <InlineEdit messages={editMessages()} value={it.q} onSave={(v) => A.editPending(i, v)} label={t("关于第 {n} 段内容的问题", { n: i + 1 })} placeholder={t("想问什么？留空则请 AI 解释")} variant="body" /></div>
        <Button size="sm" variant="ghost" aria-label={t("移除第 {n} 段", { n: i + 1 })} onClick={() => A.removePending(i)}><X size={14} /></Button>
      </li>)}</ul>
    </div>}
    {S.multi && S.queue.length > 0 && <ol className="cg-queue" aria-label={t("将并行发送的问题")}>
      {S.queue.map((q, i) => <li key={i}><span className="cg-num">{i + 1}</span><span className="cg-queue-q">{q}</span>
        <Button size="sm" variant="ghost" aria-label={t("删除第 {n} 个问题", { n: i + 1 })} onClick={() => A.dequeue(i)}><X size={14} /></Button></li>)}
    </ol>}
    <ChatComposer ref={ref} onSend={onSend} placeholder={placeholder} allowAttachments={false}
      labels={{ send: S.multi && !tray.length ? t("加入列表") : t("发送"), attach: t("添加附件"), attachments: t("附件"), removeFile: (n) => t("移除 {name}", { name: n }) }} />
    <div className="cg-comp-actions">
      {!tray.length && target.kind !== "merge" && <Button size="sm" variant="ghost" aria-pressed={S.multi} data-on={S.multi || undefined} onClick={() => A.setMulti(!S.multi)}>
        <ListPlus size={15} aria-hidden="true" />{S.multi ? t("结束多问") : t("一次问多个")}</Button>}
      {target.kind === "merge" && <Badge size="sm" tone="info" icon={<GitMerge size={12} />}>{t("共同历史只发送一次")}</Badge>}
      {!(S.multi && S.queue.length > 0) && <span className="cg-comp-hint"><ShortcutKbd size="sm">Enter</ShortcutKbd> {S.multi && !tray.length ? t("加入列表") : t("发送")} · <ShortcutKbd size="sm">Shift</ShortcutKbd><ShortcutKbd size="sm">Enter</ShortcutKbd> {t("换行")}</span>}
      {S.multi && S.queue.length > 0 && <Button size="sm" style={{ marginLeft: "auto" }} onClick={() => A.sendQuestions(target.parents, S.queue)}><Send size={14} aria-hidden="true" />{t("发送 {n} 个并行分支", { n: S.queue.length })}</Button>}
    </div>
  </div>;
}
