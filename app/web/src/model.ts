import { t } from "./i18n";
/* 自有图模型：节点 = 一轮问答；parentIds 为上下文来源（多个即合并提问）。 */
export type Item = { quote: string; q: string; source: string };
export type Status = "done" | "streaming" | "error" | "stopped";
export type GNode = {
  id: string;
  parentIds: string[];
  /** 划词提问：每条是一段被选中的原文与针对它的问题 */
  items: Item[] | null;
  question: string;
  files?: { file_id: string; filename: string }[];
  status: Status;
  answer: string;
  error?: string;
  endpoint?: string;
  model?: string;
  summary?: string;
  suggestions?: string[];
  createdAt?: string;
};
export type Draft = { id: string; letter: string; name: string; items: Item[] };
export type CanvasDoc = {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  drafts: Draft[];
  activeDraft: string;
  draftSeq: number;
  active: string | null;
};
/** 前端持有的一张画布：服务端文档 + 节点表 */
export type Topic = CanvasDoc & { nodes: Map<string, GNode> };
export type View = "canvas" | "split" | "chat";
export type ContextPreview = { merged: boolean; turns: { id: string; title: string; mode: "raw" | "summary" }[] };

export const NODE_W = 264;
export const NODE_H = 140;
const HGAP = 32;
const VGAP = 72;
export const DRAFT_ID = "__draft";
export const draftNodeId = (d: Draft) => `${DRAFT_ID}:${d.id}`;

export function titleOf(n: GNode) {
  if (n.question) return n.question;
  if (n.items && n.items.length === 1) return n.items[0].q || t("解释「{quote}」", { quote: n.items[0].quote });
  if (n.items) return t("{n} 个问题：{quotes}", { n: n.items.length, quotes: n.items.map((i) => `「${i.quote}」`).join(t("、")) });
  return "";
}
export function shortTitle(n: GNode, max = 14) {
  const s = titleOf(n);
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
export function children(t: Topic, id: string) {
  return [...t.nodes.values()].filter((n) => n.parentIds.includes(id));
}
export function ancestors(t: Topic, id: string) {
  const set = new Set<string>();
  const visit = (x: string) => {
    if (set.has(x) || !t.nodes.has(x)) return;
    set.add(x);
    t.nodes.get(x)!.parentIds.forEach(visit);
  };
  visit(id);
  return set;
}
/** 从起点到 id 的全部上下文（合并节点包含所有来源），按创建顺序即拓扑序 */
export function pathOf(t: Topic, id: string | null) {
  if (!id) return [];
  const set = ancestors(t, id);
  return [...t.nodes.keys()].filter((k) => set.has(k));
}
function depthOf(t: Topic, id: string, memo = new Map<string, number>()): number {
  if (memo.has(id)) return memo.get(id)!;
  const ps = (t.nodes.get(id)?.parentIds ?? []).filter((p) => t.nodes.has(p));
  const d = ps.length ? 1 + Math.max(...ps.map((p) => depthOf(t, p, memo))) : 0;
  memo.set(id, d);
  return d;
}
/** 面包屑用的主干：每一层沿最深的来源往上走 */
export function primaryChain(t: Topic, id: string | null) {
  const chain: string[] = [];
  const memo = new Map<string, number>();
  let cur: string | undefined = id ?? undefined;
  while (cur && t.nodes.has(cur)) {
    chain.unshift(cur);
    const ps = t.nodes.get(cur)!.parentIds.filter((p) => t.nodes.has(p));
    cur = ps.sort((a, b) => depthOf(t, b, memo) - depthOf(t, a, memo))[0];
  }
  return chain;
}
/** 同一路径上问的几处只接在最深的节点后面；不在一条路径上的来源则成为合并 */
export function minimalParents(t: Topic, ids: string[]) {
  const uniq = [...new Set(ids)].filter((id) => t.nodes.has(id));
  return uniq.filter((a) => !uniq.some((b) => b !== a && ancestors(t, b).has(a)));
}

type LayoutNode = { id: string; parentIds: string[] };
/** 从上到下的树布局；合并节点挂在最深的来源下面，另一条来源边斜接过来 */
export function layout(t: Topic, extra: LayoutNode[] = []) {
  const list: LayoutNode[] = [...t.nodes.values(), ...extra];
  const ids = new Set(list.map((n) => n.id));
  const depth = new Map<string, number>();
  const dep = (n: LayoutNode): number => {
    if (depth.has(n.id)) return depth.get(n.id)!;
    const ps = n.parentIds.filter((p) => ids.has(p));
    const v = ps.length ? 1 + Math.max(...ps.map((p) => dep(list.find((x) => x.id === p)!))) : 0;
    depth.set(n.id, v);
    return v;
  };
  list.forEach(dep);
  const kids = new Map<string, string[]>();
  const roots: string[] = [];
  for (const n of list) {
    const ps = n.parentIds.filter((p) => ids.has(p));
    if (!ps.length) { roots.push(n.id); continue; }
    const best = ps.reduce((a, b) => (depth.get(b)! > depth.get(a)! ? b : a));
    if (!kids.has(best)) kids.set(best, []);
    kids.get(best)!.push(n.id);
  }
  const widths = new Map<string, number>();
  const width = (id: string): number => {
    if (widths.has(id)) return widths.get(id)!;
    const k = kids.get(id) ?? [];
    const sum = k.reduce((s, c) => s + width(c), 0) + HGAP * Math.max(0, k.length - 1);
    const v = Math.max(NODE_W, sum);
    widths.set(id, v);
    return v;
  };
  const pos = new Map<string, { x: number; y: number }>();
  const place = (id: string, left: number) => {
    const k = kids.get(id) ?? [];
    const w = width(id);
    pos.set(id, { x: left + w / 2 - NODE_W / 2, y: depth.get(id)! * (NODE_H + VGAP) });
    const sum = k.reduce((s, c) => s + width(c), 0) + HGAP * Math.max(0, k.length - 1);
    let cx = left + (w - sum) / 2;
    for (const c of k) { place(c, cx); cx += width(c) + HGAP; }
  };
  let left = 0;
  for (const r of roots) { place(r, left); left += width(r) + HGAP * 2; }
  return { list, pos };
}
