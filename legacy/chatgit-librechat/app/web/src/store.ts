import { useSyncExternalStore } from "react";
import * as api from "./api";
import { t } from "./i18n";
import { children, draftNodeId, minimalParents, titleOf, type CanvasDoc, type Draft, type GNode, type Item, type Topic, type View } from "./model";

/* 应用状态：可变对象 + 版本号订阅。服务端是图与草稿的权威来源。 */
export type ModelChoice = { endpoint: string; model: string };
export type Session = "loading" | "ready" | "signed-out-local" | "signed-out";
export type State = {
  session: Session;
  canvases: api.CanvasSummary[];
  topic: Topic | null;
  loadingTopic: boolean;
  view: View;
  picked: Set<string>;
  merge: string[] | null;
  multi: boolean;
  queue: string[];
  focus: { id: string; n: number } | null;
  composerFocus: number;
  endpoints: Record<string, api.EndpointInfo>;
  models: Record<string, string[]>;
  settingsOpen: boolean;
  error: string | null;
};
type Notify = (o: { title: string; description?: string; type?: "success" | "info" | "warning" | "error"; action?: { label: string; onClick: () => void } }) => void;

const VIEW_KEY = "chatgit.view";
const LAST_KEY = "chatgit.lastCanvas";
const MODEL_KEY = "chatgit.model";

export const S: State = {
  session: "loading", canvases: [], topic: null, loadingTopic: false,
  view: (localStorage.getItem(VIEW_KEY) as View) || "split",
  picked: new Set(), merge: null, multi: false, queue: [], focus: null, composerFocus: 0,
  endpoints: {}, models: {}, settingsOpen: false, error: null,
};
let version = 0;
const listeners = new Set<() => void>();
let notifyImpl: Notify = () => {};
export const setNotify = (fn: Notify) => { notifyImpl = fn; };
export const notify: Notify = (o) => notifyImpl(o);
export const emit = () => { version++; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };
export function useApp() { useSyncExternalStore(subscribe, () => version); return S; }

export const topic = () => S.topic!;
export const node = (id: string) => S.topic?.nodes.get(id);
const bump = (id: string) => { S.focus = { id, n: (S.focus?.n ?? 0) + 1 }; };

function report(error: unknown, title = t("操作没有完成")) {
  const message = error instanceof api.ApiError ? error.message : String((error as Error)?.message ?? error);
  notify({ type: "error", title, description: message });
}

/* ---------- 启动与会话 ---------- */
export async function boot() {
  const jwt = await api.refresh();
  if (!jwt) {
    const local = await api.localStatus();
    S.session = local?.localMode ? "signed-out-local" : "signed-out";
    emit();
    return;
  }
  S.session = "ready";
  emit();
  await Promise.all([loadModels(), loadCanvasList()]);
  const last = localStorage.getItem(LAST_KEY);
  const pick = S.canvases.find((c) => c.id === last) ?? S.canvases[0];
  if (pick) await openCanvas(pick.id);
  else await newCanvas();
}

export async function loadModels() {
  try {
    const [endpoints, models] = await Promise.all([api.getEndpoints(), api.getModels()]);
    S.endpoints = Object.fromEntries(Object.entries(endpoints).filter(([name, info]) => info && name !== "agents" && info.type === "custom")) as Record<string, api.EndpointInfo>;
    S.models = Object.fromEntries(Object.keys(S.endpoints).map((name) => [name, models[name] ?? []]));
  } catch (error) {
    report(error, t("无法读取模型列表"));
  }
  emit();
}

export function availableModels(): ModelChoice[] {
  return Object.entries(S.models).flatMap(([endpoint, list]) => list.map((model) => ({ endpoint, model })));
}
function defaultModel(): ModelChoice | null {
  try {
    const saved = JSON.parse(localStorage.getItem(MODEL_KEY) ?? "null") as ModelChoice | null;
    if (saved && S.models[saved.endpoint]?.includes(saved.model)) return saved;
  } catch { /* ignore */ }
  return availableModels()[0] ?? null;
}
export function currentModel(): ModelChoice | null {
  const tp = S.topic;
  if (tp?.endpoint && tp.model) return { endpoint: tp.endpoint, model: tp.model };
  return defaultModel();
}
export async function setModel(choice: ModelChoice) {
  localStorage.setItem(MODEL_KEY, JSON.stringify(choice));
  if (!S.topic) return;
  S.topic.endpoint = choice.endpoint;
  S.topic.model = choice.model;
  emit();
  await api.patchCanvas(S.topic.id, choice).catch((e) => report(e));
}
export function openSettings(open = true) { S.settingsOpen = open; emit(); }

/* ---------- 画布 ---------- */
async function loadCanvasList() {
  try { S.canvases = (await api.listCanvases()).canvases; } catch (error) { report(error, t("无法读取画布列表")); }
  emit();
}
function adopt(doc: CanvasDoc, nodes: GNode[]): Topic {
  const tp: Topic = { ...doc, nodes: new Map(nodes.map((n) => [n.id, n])) };
  if (!tp.drafts.length) {
    const d: Draft = { id: uid(), letter: "A", name: "", items: [] };
    tp.drafts = [d]; tp.activeDraft = d.id; tp.draftSeq = 1;
  }
  if (tp.active && !tp.nodes.has(tp.active)) tp.active = null;
  if (!tp.active && nodes.length) tp.active = nodes[nodes.length - 1].id;
  return tp;
}
export async function openCanvas(id: string) {
  S.loadingTopic = true; S.picked.clear(); S.merge = null; S.queue = []; S.multi = false;
  emit();
  try {
    const { canvas, nodes } = await api.getCanvas(id);
    S.topic = adopt(canvas, nodes);
    localStorage.setItem(LAST_KEY, id);
    if (S.topic.active) bump(S.topic.active);
    pollIfStreaming();
  } catch (error) {
    report(error, t("无法打开这张画布"));
  } finally {
    S.loadingTopic = false;
    emit();
  }
}
export async function newCanvas() {
  try {
    const choice = defaultModel();
    const { canvas, nodes } = await api.createCanvas({ endpoint: choice?.endpoint ?? "", model: choice?.model ?? "" });
    S.topic = adopt(canvas, nodes);
    S.canvases.unshift({ id: canvas.id, name: canvas.name, updatedAt: new Date().toISOString() });
    localStorage.setItem(LAST_KEY, canvas.id);
    S.picked.clear(); S.merge = null; S.queue = []; S.multi = false;
    if (S.view === "canvas") S.view = "split";
    S.composerFocus++;
    emit();
  } catch (error) {
    report(error, t("无法新建画布"));
  }
}
export async function renameCanvas(id: string, name: string) {
  const clean = name.trim();
  const row = S.canvases.find((c) => c.id === id);
  if (row) row.name = clean;
  if (S.topic?.id === id) S.topic.name = clean;
  emit();
  await api.patchCanvas(id, { name: clean }).catch((e) => report(e));
}
export async function removeCanvas(id: string) {
  try {
    await api.deleteCanvas(id);
    S.canvases = S.canvases.filter((c) => c.id !== id);
    if (S.topic?.id === id) {
      S.topic = null;
      if (S.canvases[0]) await openCanvas(S.canvases[0].id);
      else await newCanvas();
    }
    emit();
  } catch (error) { report(error); }
}

/* 页面刷新后仍在生成的节点：轮询直到完成 */
let pollTimer: number | undefined;
function pollIfStreaming() {
  window.clearTimeout(pollTimer);
  const tp = S.topic;
  if (!tp) return;
  const orphan = [...tp.nodes.values()].some((n) => n.status === "streaming" && !live.has(n.id));
  if (!orphan) return;
  pollTimer = window.setTimeout(async () => {
    if (S.topic?.id !== tp.id) return;
    try {
      const { nodes } = await api.getCanvas(tp.id);
      for (const n of nodes) if (!live.has(n.id)) tp.nodes.set(n.id, n);
      emit();
    } catch { /* retry next tick */ }
    pollIfStreaming();
  }, 1500);
}
/** 回答完成后，摘要和推荐提问在后台生成；稍后取回一次 */
function refreshLater(id: string, tp: Topic) {
  for (const wait of [2500, 7000]) window.setTimeout(async () => {
    if (S.topic?.id !== tp.id) return;
    const local = tp.nodes.get(id);
    if (!local || local.suggestions?.length) return;
    try {
      const { nodes } = await api.getCanvas(tp.id);
      const fresh = nodes.find((n) => n.id === id);
      if (fresh && local.status === fresh.status) { local.summary = fresh.summary; local.suggestions = fresh.suggestions; emit(); }
    } catch { /* optional */ }
  }, wait);
}

/* ---------- 导航 ---------- */
let saveActive: number | undefined;
export function setActive(id: string | null, opts: { keepMerge?: boolean } = {}) {
  const tp = S.topic; if (!tp) return;
  tp.active = id;
  if (!opts.keepMerge) S.merge = null;
  if (id) bump(id);
  emit();
  window.clearTimeout(saveActive);
  saveActive = window.setTimeout(() => api.patchCanvas(tp.id, { active: id }).catch(() => {}), 600);
}
export function openReading(id: string) { if (S.view === "canvas") S.view = "split"; setActive(id); }
export function setView(v: View) { S.view = v; localStorage.setItem(VIEW_KEY, v); const a = S.topic?.active; if (a) bump(a); emit(); }
export function locate(id: string) { bump(id); emit(); }
export function focusComposer() { S.composerFocus++; emit(); }

/* ---------- 合并选择 ---------- */
export function togglePick(id: string) {
  const n = node(id);
  if (!n || (n.status !== "done" && n.status !== "stopped")) { notify({ type: "warning", title: t("只能选择已经完成的回答") }); return; }
  S.picked.has(id) ? S.picked.delete(id) : S.picked.add(id);
  emit();
}
export function clearPicked() { S.picked.clear(); emit(); }
export function startMerge() { S.merge = [...S.picked]; if (S.view === "canvas") S.view = "split"; S.composerFocus++; emit(); }
export function dropMerge(id: string) { S.merge = (S.merge ?? []).filter((x) => x !== id); S.picked.delete(id); if (S.merge.length < 2) S.merge = null; emit(); }
export function exitMerge() { S.merge = null; S.picked.clear(); emit(); }

/* ---------- 生成 ---------- */
const live = new Set<string>();
function handlers(tp: Topic, onFirst?: (n: GNode) => void): api.StreamHandlers {
  let first = true;
  return {
    onNode: (n) => { live.add(n.id); tp.nodes.set(n.id, n); if (first) { first = false; onFirst?.(n); } emit(); },
    onDelta: (id, text) => { const n = tp.nodes.get(id); if (n) { n.answer += text; emit(); } },
    onDone: (n) => { live.delete(n.id); tp.nodes.set(n.id, n); emit(); if (n.status === "done") refreshLater(n.id, tp); if (n.status === "error") notifyError(n); },
  };
}
function notifyError(n: GNode) {
  notify({ type: "error", title: t("回答没有完成"), description: errorText(n.error), action: n.error === "no_user_key" || n.error === "auth" ? { label: t("模型连接"), onClick: () => openSettings() } : undefined });
}
export function errorText(code?: string) {
  switch (code) {
    case "no_user_key": case "NO_USER_KEY": return t("还没有填写这个模型连接的 API Key。");
    case "no_base_url": case "NO_BASE_URL": return t("还没有填写这个模型连接的服务地址。");
    case "auth": return t("模型服务拒绝了凭据，请检查 API Key 或重新连接。");
    case "rate_limit": return t("模型服务暂时限流或额度不足，请稍后再试。");
    case "network": return t("连不上模型服务，请检查服务地址与网络。");
    case "interrupted": return t("服务重启，生成被中断。");
    default: return t("模型服务返回错误。");
  }
}

type Ask = { parentIds: string[]; items?: Item[]; question?: string };
async function ask(tp: Topic, req: Ask, follow: boolean) {
  const choice = currentModel();
  if (!choice) { notify({ type: "warning", title: t("还没有可用的模型"), description: t("先在“模型连接”里连接一个模型。"), action: { label: t("模型连接"), onClick: () => openSettings() } }); return; }
  try {
    await api.askNode(tp.id, { ...req, endpoint: choice.endpoint, model: choice.model }, handlers(tp, (n) => {
      if (follow) setActive(n.id); else bump(n.id);
      const row = S.canvases.find((c) => c.id === tp.id);
      if (row && !row.name) { row.name = titleOf(n).slice(0, 40); tp.name = row.name; }
    }));
  } catch (error) {
    report(error, t("问题没有发出去"));
  }
}

/** 输入框发送：一个问题跟过去；多个问题留在原地，同时生成 */
export function sendQuestions(parents: string[], questions: string[]) {
  const tp = S.topic; if (!tp) return;
  S.merge = null; S.picked.clear(); S.queue = []; S.multi = false;
  emit();
  questions.forEach((q) => void ask(tp, { parentIds: parents, question: q }, questions.length === 1));
  if (questions.length > 1) notify({ type: "info", title: t("已同时创建 {n} 个并行分支", { n: questions.length }) });
}
/** 划词立即发送：留在当前阅读位置，新分支在后台生成 */
export function sendQuote(source: string, quote: string, q: string) {
  const tp = S.topic; if (!tp) return;
  void ask(tp, { parentIds: [source], items: [{ quote, q, source }] }, false);
  notify({ type: "info", title: t("已创建新分支，正在生成"), description: q || t("解释「{quote}」", { quote }) });
}
export function suggest(q: string) { const a = S.topic?.active; if (a) sendQuestions([a], [q]); }
export async function stop(id: string) { const tp = S.topic; if (tp) await api.stopNode(tp.id, id).catch((e) => report(e)); }
export async function retry(id: string) {
  const tp = S.topic; if (!tp) return;
  const choice = currentModel();
  try { await api.retryNode(tp.id, id, choice ?? {}, handlers(tp)); } catch (error) { report(error, t("重试没有成功")); }
}
export async function removeNode(id: string) {
  const tp = S.topic; if (!tp) return;
  try {
    const { deleted, canvas } = await api.deleteNode(tp.id, id);
    deleted.forEach((d) => tp.nodes.delete(d));
    tp.drafts = canvas.drafts.length ? canvas.drafts : tp.drafts;
    if (tp.active && !tp.nodes.has(tp.active)) tp.active = null;
    S.picked.clear();
    emit();
    notify({ type: "info", title: t("已删除 {n} 个节点", { n: deleted.length }) });
  } catch (error) { report(error); }
}

/* ---------- 草稿 ---------- */
const uid = () => Math.random().toString(36).slice(2, 10);
/** 空名称表示默认名，按当前界面语言显示 */
export const draftLabel = (d: Draft) => d.name || t("草稿 {letter}", { letter: d.letter });
export const activeDraft = (tp: Topic) => tp.drafts.find((d) => d.id === tp.activeDraft) ?? tp.drafts[0];
export const liveDrafts = (tp: Topic) => tp.drafts.filter((d) => d.items.length || d.id === tp.activeDraft);
export const multiDraft = (tp: Topic) => tp.drafts.filter((d) => d.items.length).length > 1;
const draftOf = (id?: string) => { const tp = topic(); return (id && tp.drafts.find((d) => d.id === id)) || activeDraft(tp); };
let saveDrafts: number | undefined;
function persistDrafts() {
  const tp = S.topic; if (!tp) return;
  window.clearTimeout(saveDrafts);
  saveDrafts = window.setTimeout(() => {
    api.patchCanvas(tp.id, { drafts: tp.drafts, activeDraft: tp.activeDraft, draftSeq: tp.draftSeq }).catch((e) => report(e, t("草稿没有保存")));
  }, 400);
}
function changed() { persistDrafts(); emit(); }
/** 发送或清空后：去掉空的非当前草稿；当前草稿空了就切到另一个有内容的草稿 */
function tidy(tp: Topic) {
  const cur = activeDraft(tp);
  if (!cur.items.length) { const other = tp.drafts.find((d) => d.items.length && d.id !== cur.id); if (other) tp.activeDraft = other.id; }
  tp.drafts = tp.drafts.filter((d) => d.items.length || d.id === tp.activeDraft);
}
export function newDraft() {
  const tp = topic();
  const cur = activeDraft(tp);
  if (!cur.items.length) return cur;
  const letter = String.fromCharCode(65 + (tp.draftSeq++ % 26));
  const d: Draft = { id: uid(), letter, name: "", items: [] };
  tp.drafts.push(d); tp.activeDraft = d.id;
  changed();
  return d;
}
export function setActiveDraft(id: string) { const tp = topic(); tp.activeDraft = id; tp.drafts = tp.drafts.filter((d) => d.items.length || d.id === id); changed(); }
export function renameDraft(id: string, name: string) { const d = draftOf(id); d.name = name.trim(); changed(); }
/** target：草稿 id；"new" 表示新建一个草稿再加入 */
export function addPending(source: string, quote: string, q: string, target?: string) {
  const tp = topic();
  const d = target === "new" ? newDraft() : draftOf(target);
  tp.activeDraft = d.id;
  d.items.push({ quote, q, source });
  bump(draftNodeId(d));
  changed();
  notify({ type: "success", title: t("已加入{name}，共 {n} 条", { name: draftLabel(d), n: d.items.length }), description: t("继续划词，或一起发送。") });
}
export function editPending(i: number, q: string, draftId?: string) { draftOf(draftId).items[i].q = q; changed(); }
export function removePending(i: number, draftId?: string) { draftOf(draftId).items.splice(i, 1); changed(); }
export function clearPending(draftId?: string) { const d = draftOf(draftId); d.items = []; tidy(topic()); changed(); notify({ type: "info", title: t("已清空{name}", { name: draftLabel(d) }) }); }
/** 攒下的内容合成一个分支发送（可附带一个总问题） */
export function sendPending(question = "", draftId?: string) {
  const tp = topic();
  const d = draftOf(draftId);
  if (!d.items.length) return;
  const items = d.items.map((p) => ({ ...p }));
  d.items = [];
  tidy(tp);
  changed();
  S.queue = []; S.multi = false;
  void ask(tp, { parentIds: minimalParents(tp, items.map((p) => p.source)), items, question }, true);
}

/* ---------- 一次多问 ---------- */
export function setMulti(on: boolean) { S.multi = on; if (!on) S.queue = []; S.composerFocus++; emit(); }
export function enqueue(q: string) { S.queue.push(q); emit(); }
export function dequeue(i: number) { S.queue.splice(i, 1); emit(); }

export function composerTarget() {
  const tp = S.topic;
  const a = tp?.active ? tp.nodes.get(tp.active) : undefined;
  if (S.merge) return { kind: "merge" as const, parents: S.merge };
  if (!tp || !a) return { kind: tp?.nodes.size ? ("root-more" as const) : ("root" as const), parents: [] as string[] };
  if (a.status === "streaming") return { kind: "blocked" as const, parents: [], reason: t("这条回答还在生成，完成后可以继续追问。也可以先去其他分支提问。") };
  if (a.status === "error") return { kind: "blocked" as const, parents: [], reason: t("这条回答没有完成，请先重试。") };
  const kids = children(tp, a.id).length;
  return { kind: kids ? ("fork" as const) : ("continue" as const), parents: [a.id], kids, a };
}
