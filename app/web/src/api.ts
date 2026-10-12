/* Same-origin API client: in-memory access token from the refresh cookie, one retry on 401. */
import type { CanvasDoc, ContextPreview, GNode } from "./model";

let token: string | null = null;
let refreshTimer: number | undefined;
let refreshing: Promise<string | null> | null = null;

function scheduleRefresh(jwt: string) {
  window.clearTimeout(refreshTimer);
  try {
    const { exp } = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    const wait = Math.max(30_000, exp * 1000 - Date.now() - 60_000);
    refreshTimer = window.setTimeout(() => { void refresh(); }, wait);
  } catch {
    // opaque token: refresh happens on the next 401
  }
}

export function refresh(): Promise<string | null> {
  refreshing ??= (async () => {
    try {
      const res = await fetch("/api/auth/refresh", { method: "POST", credentials: "include" });
      const data = res.ok ? await res.json().catch(() => null) : null;
      token = typeof data?.token === "string" ? data.token : null;
      if (token) scheduleRefresh(token);
      return token;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

async function raw(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const res = await fetch(path, { ...init, headers, credentials: "include" });
  if (res.status === 401 && retry && (await refresh())) return raw(path, init, false);
  return res;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await raw(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body?.message ?? body?.error ?? res.statusText);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const body = (data: unknown) => JSON.stringify(data);

/* ---------- session ---------- */
export async function localStatus(): Promise<{ localMode: boolean } | null> {
  const res = await fetch("/api/local/status").catch(() => null);
  return res?.ok ? res.json() : null;
}
export const logout = () => raw("/api/auth/logout", { method: "POST" });

/* ---------- models & connections ---------- */
export type EndpointInfo = { type?: string; userProvide?: boolean; userProvideURL?: boolean; authMode?: string; modelDisplayLabel?: string; order?: number };
export const getEndpoints = () => json<Record<string, EndpointInfo | null>>("/api/endpoints");
export const getModels = () => json<Record<string, string[]>>("/api/models");
export const getKeyExpiry = (name: string) => json<{ expiresAt: string | "never" | null }>(`/api/keys?name=${encodeURIComponent(name)}`);
export const saveKey = (name: string, value: { apiKey: string; baseURL?: string }) =>
  json<void>("/api/keys", { method: "PUT", body: body({ name, value: JSON.stringify(value), expiresAt: null }) });
export const deleteKey = (name: string) => json<void>(`/api/keys/${encodeURIComponent(name)}`, { method: "DELETE" });
export type ChatGPTStatus = { enabled: boolean; state: "disabled" | "disconnected" | "pending" | "connected" | "reauth_required"; email?: string; lastError?: string };
export const chatgptStatus = () => json<ChatGPTStatus>("/api/chatgpt/status");
export const chatgptLogin = () => json<{ authorizationUrl: string; expiresAt: string }>("/api/chatgpt/login", { method: "POST" });
export const chatgptCancel = () => json<void>("/api/chatgpt/login/cancel", { method: "POST" });
export const chatgptDisconnect = () => json<unknown>("/api/chatgpt/disconnect", { method: "POST" });

/* ---------- canvases ---------- */
export type CanvasSummary = { id: string; name: string; updatedAt: string };
export const listCanvases = () => json<{ canvases: CanvasSummary[] }>("/api/chatgit/canvases");
export const createCanvas = (data: { name?: string; endpoint?: string; model?: string }) =>
  json<{ canvas: CanvasDoc; nodes: GNode[] }>("/api/chatgit/canvases", { method: "POST", body: body(data) });
export const getCanvas = (id: string) => json<{ canvas: CanvasDoc; nodes: GNode[] }>(`/api/chatgit/canvases/${id}`);
export const patchCanvas = (id: string, data: Partial<CanvasDoc>) =>
  json<{ canvas: CanvasDoc }>(`/api/chatgit/canvases/${id}`, { method: "PATCH", body: body(data) });
export const deleteCanvas = (id: string) => json<void>(`/api/chatgit/canvases/${id}`, { method: "DELETE" });
export const deleteNode = (canvas: string, node: string) =>
  json<{ deleted: string[]; canvas: CanvasDoc }>(`/api/chatgit/canvases/${canvas}/nodes/${node}`, { method: "DELETE" });
export const stopNode = (canvas: string, node: string) => json<unknown>(`/api/chatgit/canvases/${canvas}/nodes/${node}/stop`, { method: "POST" });
export const contextPreview = (canvas: string, sources: string[]) =>
  json<ContextPreview>(`/api/chatgit/canvases/${canvas}/context?sources=${sources.map(encodeURIComponent).join(",")}`);

export type StreamHandlers = { onNode: (n: GNode) => void; onDelta: (id: string, text: string) => void; onDone: (n: GNode) => void };

/** POST that answers with an SSE stream (node → delta* → done). Resolves when the stream ends. */
export async function streamPost(path: string, data: unknown, handlers: StreamHandlers) {
  const res = await raw(path, { method: "POST", body: body(data) });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({}));
    throw new ApiError(res.status, err?.message ?? res.statusText);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const payload = /^data: (.*)$/m.exec(block)?.[1];
      if (!event || !payload) continue;
      const d = JSON.parse(payload);
      if (event === "node") handlers.onNode(d.node);
      else if (event === "delta") handlers.onDelta(d.id, d.text);
      else if (event === "done") handlers.onDone(d.node);
    }
  }
}
export const askNode = (canvas: string, data: { parentIds: string[]; items?: unknown[]; question?: string; endpoint?: string; model?: string }, h: StreamHandlers) =>
  streamPost(`/api/chatgit/canvases/${canvas}/nodes`, data, h);
export const retryNode = (canvas: string, node: string, data: { endpoint?: string; model?: string }, h: StreamHandlers) =>
  streamPost(`/api/chatgit/canvases/${canvas}/nodes/${node}/retry`, data, h);
