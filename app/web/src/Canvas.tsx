import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { GitBranch, GitMerge, Maximize, MessageSquare, Minus, Plus, Quote, Send, Trash2, X } from "lucide-react";
import { Button } from "@/components/arc/button/button";
import { Badge } from "@/components/arc/badge/badge";
import { Tooltip } from "@/components/arc/tooltip/tooltip";
import { ContextMenu } from "@/components/arc/context-menu/context-menu";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { Dialog, DialogContent } from "@/components/arc/dialog/dialog";
import { t } from "./i18n";
import { ancestors, children, draftNodeId, layout, minimalParents, NODE_H, NODE_W, titleOf, type Draft, type GNode } from "./model";
import * as A from "./store";

const plain = (s: string) => s.replace(/^###\s+/gm, "").replace(/\*\*/g, "").replace(/^\s*([-*]|\d+\.)\s+/gm, "").replace(/\s*\n+\s*/g, " ").trim();
type Cam = { x: number; y: number; s: number };

export function Canvas() {
  const S = A.useApp();
  const tp = A.topic()!;
  const vp = useRef<HTMLDivElement>(null);
  const [cam, setCam] = useState<Cam>({ x: 0, y: 0, s: 1 });
  const [glide, setGlide] = useState(false);
  const camRef = useRef(cam); camRef.current = cam;
  const dragged = useRef(false);

  const [doomed, setDoomed] = useState<GNode | null>(null);
  const drafts = tp.drafts.filter((d) => d.items.length);
  const draftById = new Map(drafts.map((d) => [draftNodeId(d), d]));
  const { list, pos } = layout(tp, drafts.map((d) => ({ id: draftNodeId(d), parentIds: minimalParents(tp, d.items.map((p) => p.source)) })));
  const onPath = tp.active ? ancestors(tp, tp.active) : new Set<string>();

  const move = (next: Cam, animate: boolean) => {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    setGlide(animate && !reduced);
    setCam(next);
  };
  const fit = (animate = true) => {
    const el = vp.current; if (!el || !el.clientWidth) return;
    const ps = [...pos.values()];
    if (!ps.length) { move({ x: el.clientWidth / 2 - NODE_W / 2, y: 80, s: 1 }, false); return; }
    const minX = Math.min(...ps.map((p) => p.x)), maxX = Math.max(...ps.map((p) => p.x + NODE_W));
    const minY = Math.min(...ps.map((p) => p.y)), maxY = Math.max(...ps.map((p) => p.y + NODE_H));
    const pad = 72;
    const s = Math.max(0.35, Math.min(1, (el.clientWidth - pad * 2) / (maxX - minX), (el.clientHeight - pad * 2) / (maxY - minY)));
    move({ s, x: (el.clientWidth - (maxX - minX) * s) / 2 - minX * s, y: Math.max(pad, (el.clientHeight - (maxY - minY) * s) / 2) - minY * s }, animate);
  };
  const zoom = (f: number, cx?: number, cy?: number) => {
    const el = vp.current!; const c = camRef.current;
    const px = cx ?? el.clientWidth / 2, py = cy ?? el.clientHeight / 2;
    const s = Math.max(0.3, Math.min(1.6, c.s * f)); const k = s / c.s;
    move({ s, x: px - (px - c.x) * k, y: py - (py - c.y) * k }, false);
  };

  // 打开画布或切换画布时适配全部节点
  useLayoutEffect(() => { fit(false); }, [tp.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // 有新节点、定位请求时，若目标不在视野内就平移过去
  useEffect(() => {
    const el = vp.current; const f = S.focus; if (!el || !f || S.view === "chat") return;
    const p = pos.get(f.id); if (!p) return;
    const c = camRef.current; const m = 40;
    const sx = p.x * c.s + c.x, sy = p.y * c.s + c.y;
    if (sx >= m && sy >= m && sx + NODE_W * c.s <= el.clientWidth - m && sy + NODE_H * c.s <= el.clientHeight - m) return;
    // 只平移到刚好露出目标（留出边距），避免整张画布大幅跳动
    let x = c.x, y = c.y;
    if (sx < m) x += m - sx; else if (sx + NODE_W * c.s > el.clientWidth - m) x -= sx + NODE_W * c.s - (el.clientWidth - m);
    if (sy < m) y += m - sy; else if (sy + NODE_H * c.s > el.clientHeight - m) y -= sy + NODE_H * c.s - (el.clientHeight - m);
    move({ s: c.s, x, y }, true);
  }, [S.focus?.n, S.view]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = vp.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) { const r = el.getBoundingClientRect(); zoom(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top); }
      else { const c = camRef.current; move({ ...c, x: c.x - e.deltaX, y: c.y - e.deltaY }, false); }
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("[data-card], [data-draft], button")) return;
    const start = { x: e.clientX, y: e.clientY, c: camRef.current };
    dragged.current = false;
    const el = e.currentTarget; el.setPointerCapture(e.pointerId); el.dataset.panning = "";
    const onMove = (ev: globalThis.PointerEvent) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) dragged.current = true;
      move({ ...start.c, x: start.c.x + dx, y: start.c.y + dy }, false);
    };
    const onUp = () => {
      delete el.dataset.panning;
      el.removeEventListener("pointermove", onMove);
      if (!dragged.current && S.picked.size) A.clearPicked();
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp, { once: true });
    el.addEventListener("pointercancel", onUp, { once: true });
  };

  const activate = (e: MouseEvent, id: string) => {
    e.stopPropagation(); // 左键只用于选中，菜单留给右键
    if (e.shiftKey || e.metaKey || e.ctrlKey) { A.togglePick(id); return; }
    if (S.picked.size) A.clearPicked();
    S.view === "canvas" ? A.setActive(id) : A.openReading(id);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const card = (e.target as HTMLElement).querySelector?.(":scope > [data-card]") as HTMLElement | null;
    if (!card) return;
    const id = card.dataset.card!;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.shiftKey ? A.togglePick(id) : A.openReading(id); }
  };

  const edges: JSX.Element[] = [];
  const labels: JSX.Element[] = [];
  for (const n of list) {
    const p2 = pos.get(n.id)!;
    const isDraft = draftById.has(n.id);
    for (const pid of n.parentIds) {
      const p1 = pos.get(pid); if (!p1) continue;
      const x1 = p1.x + NODE_W / 2, y1 = p1.y + NODE_H, x2 = p2.x + NODE_W / 2, y2 = p2.y, my = (y1 + y2) / 2;
      const on = !isDraft && onPath.has(n.id) && onPath.has(pid);
      edges.push(<path key={pid + n.id} data-on={on || undefined} data-draft={isDraft || undefined} d={`M${x1} ${y1} C${x1} ${my} ${x2} ${my} ${x2} ${y2}`} />);
      const items = isDraft ? draftById.get(n.id)!.items : (n as GNode).items;
      const qs = (items ?? []).filter((i) => i.source === pid).map((i) => i.quote);
      if (qs.length) labels.push(<span key={"l" + pid + n.id} className="cg-edge-label" data-on={on || undefined} title={qs.join("、")} style={{ transform: `translate(${(x1 + x2) / 2}px, ${my}px) translate(-50%, -50%)` }}>{`「${qs[0]}」${qs.length > 1 ? t(" 等 {n} 处", { n: qs.length }) : ""}`}</span>);
    }
  }

  return <section className="cg-canvas" aria-label={t("分支画布")}>
    <div ref={vp} className="cg-viewport" onPointerDown={onPointerDown} onKeyDown={onKeyDown}
      style={{ backgroundSize: `${22 * cam.s}px ${22 * cam.s}px`, backgroundPosition: `${cam.x}px ${cam.y}px` }}>
      <div className="cg-world" data-glide={glide || undefined} onTransitionEnd={() => setGlide(false)} style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.s})` }}>
        <svg className="cg-edges" aria-hidden="true">{edges}</svg>
        {list.map((n) => draftById.has(n.id)
          ? <DraftNode key={n.id} d={draftById.get(n.id)!} x={pos.get(n.id)!.x} y={pos.get(n.id)!.y} />
          : <NodeSlot key={n.id} n={n as GNode} x={pos.get(n.id)!.x} y={pos.get(n.id)!.y} on={onPath.has(n.id)} active={tp.active === n.id} picked={S.picked.has(n.id)} onActivate={activate} onDelete={setDoomed} />)}
        {labels}
        {S.view === "canvas" && tp.active && pos.get(tp.active) && <div className="cg-read" style={{ transform: `translate(${pos.get(tp.active)!.x + NODE_W}px, ${pos.get(tp.active)!.y - 10}px) translate(-100%, -100%)` }}>
          <Button size="sm" variant="secondary" onClick={() => A.openReading(tp.active!)}><MessageSquare size={14} aria-hidden="true" />{t("在对话中阅读")}</Button>
        </div>}
      </div>
    </div>
    {!tp.nodes.size && <div className="cg-canvas-empty"><EmptyState title={t("从一个问题开始")} description={t("在输入框里写下第一个问题。之后可以在回答里划词提问，或右键节点分出新分支。")} icon={<GitBranch size={20} />} /></div>}
    <div className="cg-zoom" role="toolbar" aria-label={t("画布缩放")}>
      <Tooltip content={t("放大")} side="top"><Button size="sm" variant="ghost" aria-label={t("放大")} onClick={() => zoom(1.2)}><Plus size={16} /></Button></Tooltip>
      <Tooltip content={t("缩小")} side="top"><Button size="sm" variant="ghost" aria-label={t("缩小")} onClick={() => zoom(1 / 1.2)}><Minus size={16} /></Button></Tooltip>
      <Tooltip content={t("显示全部节点")} side="top"><Button size="sm" variant="ghost" aria-label={t("显示全部节点")} onClick={() => fit(true)}><Maximize size={15} /></Button></Tooltip>
    </div>
    {S.picked.size > 0 && S.view !== "chat"
      ? <div className="cg-mergebar" role="region" aria-label={t("合并提问")}>
          <span>{S.picked.size < 2 ? t("已选 1 个节点，再 Shift + 点击一个") : t("已选 {n} 个节点", { n: S.picked.size })}</span>
          <Button size="sm" disabled={S.picked.size < 2} onClick={A.startMerge}><GitMerge size={14} aria-hidden="true" />{t("基于它们提问")}</Button>
          <Button size="sm" variant="ghost" onClick={A.clearPicked}>{t("取消")}</Button>
        </div>
      : <p className="cg-hint">{t("Shift + 点击多选合并 · 右键节点更多操作 · 拖动空白处平移")}</p>}
    <Dialog open={!!doomed} onOpenChange={(o) => { if (!o) setDoomed(null); }}>
      {doomed && <DialogContent className="cg-dialog" title={t("删除这个节点？")} description={t("「{title}」和从它长出的所有后续节点都会被删除，无法恢复。", { title: titleOf(doomed) })}>
        <div className="cg-dialog-actions">
          <Button variant="secondary" onClick={() => setDoomed(null)}>{t("取消")}</Button>
          <Button variant="danger" onClick={() => { void A.removeNode(doomed.id); setDoomed(null); }}>{t("删除")}</Button>
        </div>
      </DialogContent>}
    </Dialog>
  </section>;
}

function NodeSlot({ n, x, y, on, active, picked, onActivate, onDelete }: { n: GNode; x: number; y: number; on: boolean; active: boolean; picked: boolean; onActivate: (e: MouseEvent, id: string) => void; onDelete: (n: GNode) => void }) {
  const tp = A.topic()!;
  const kids = children(tp, n.id).length;
  const done = n.status === "done" || n.status === "stopped";
  const preview = plain(n.answer);
  const items = useMemo(() => [
    { id: "ask", label: kids ? t("从这里提问（新分支）") : t("从这里继续追问"), icon: <GitBranch size={15} />, disabled: !done, onSelect: () => { A.openReading(n.id); A.focusComposer(); } },
    { id: "read", label: t("在对话中阅读"), icon: <MessageSquare size={15} />, onSelect: () => A.openReading(n.id) },
    { id: "pick", label: picked ? t("取消合并选择") : t("选中以合并提问（Shift + 点击）"), icon: <GitMerge size={15} />, disabled: !done, onSelect: () => A.togglePick(n.id) },
    { id: "delete", label: t("删除…"), icon: <Trash2 size={15} />, destructive: true, disabled: n.status === "streaming", onSelect: () => onDelete(n) },
  ], [kids, done, picked, n, onDelete]);
  const kind = n.parentIds.length > 1 ? <><GitMerge size={13} aria-hidden="true" />{t("合并 {n} 个来源", { n: n.parentIds.length })}</>
    : n.items ? <><Quote size={12} aria-hidden="true" />{t("划词提问")}</> : <>{n.parentIds.length ? t("追问") : t("起点")}</>;
  return <div className="cg-slot" style={{ transform: `translate(${x}px, ${y}px)` }}>
    <ContextMenu label={t("节点操作：{title}", { title: titleOf(n) })} items={items}>
      <div className="cg-node" data-card={n.id} data-on={on || undefined} data-active={active || undefined} data-picked={picked || undefined} data-status={n.status}
        onClick={(e) => onActivate(e, n.id)} onDoubleClick={() => A.openReading(n.id)}>
        <div className="cg-node-q">{titleOf(n)}</div>
        <div className="cg-node-a">{preview}</div>
        <div className="cg-node-foot">
          <span className="cg-node-kind">{kind}</span>
          {n.status === "streaming" ? <Badge size="sm" tone="info">{t("生成中")}</Badge>
            : n.status === "error" ? <Badge size="sm" tone="danger">{t("生成中断")}</Badge>
            : n.status === "stopped" ? <Badge size="sm" tone="warning">{t("已停止")}</Badge>
            : kids ? <Badge size="sm">{t("{n} 个后续", { n: kids })}</Badge> : null}
        </div>
        {picked && <span className="cg-pick" aria-hidden="true">✓</span>}
      </div>
    </ContextMenu>
  </div>;
}

function DraftNode({ d, x, y }: { d: Draft; x: number; y: number }) {
  A.useApp();
  const tp = A.topic()!;
  const multi = A.multiDraft(tp);
  const current = d.id === tp.activeDraft;
  const name = A.draftLabel(d);
  return <div className="cg-draft" data-draft data-current={(multi && current) || undefined} style={{ transform: `translate(${x}px, ${y}px)` }} role="group" aria-label={t("{name}，{n} 条待发送", { name, n: d.items.length })}>
    <div className="cg-draft-head">
      {multi && !current ? <button type="button" className="cg-draft-switch" onClick={() => A.setActiveDraft(d.id)} title={t("设为当前草稿")}><strong>{name}</strong></button> : <strong>{name}</strong>}
      <span>{multi && current ? t("当前 · ") : ""}{t("{n} 条 · 发送后成为一个分支", { n: d.items.length })}</span></div>
    <ol>{d.items.map((it, i) => <li key={i}>
      <span className="cg-num" data-dim={(multi && !current) || undefined}>{multi ? d.letter : ""}{i + 1}</span>
      <span className="cg-draft-text"><span className="cg-draft-q">「{it.quote}」</span><span>{it.q || t("解释这段内容")}</span></span>
      <Button size="sm" variant="ghost" aria-label={t("移除第 {n} 条", { n: i + 1 })} onClick={() => A.removePending(i, d.id)}><X size={14} /></Button>
    </li>)}</ol>
    <div className="cg-draft-actions">
      <Button size="sm" variant="ghost" onClick={() => A.clearPending(d.id)}>{t("清空")}</Button>
      <Button size="sm" onClick={() => A.sendPending("", d.id)}><Send size={14} aria-hidden="true" />{t("发送")}</Button>
    </div>
  </div>;
}
