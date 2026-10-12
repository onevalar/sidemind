import type { AIConnectionInput, PublicAIConfig, PublicChatGPTConfig, NoteDTO, NoteSummary, NotePosition, CanvasFrame, CanvasLayout, AgentScope, AgentEvent, ChangeSetSummary, ChangeSetDetail, ConversationState, ProposalSummary, ProposalDetail, MemoryFileDTO, MemoryTargetKind, RepoStatus, PushEvent } from '../shared/types'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error || `${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

const enc = encodeURIComponent

/** Reads a newline-delimited JSON stream until a `done` event. */
async function ndjson<T extends { type: string }>(response: Response, onEvent: (event: T) => void, interrupted: string): Promise<void> {
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || `${response.status} ${response.statusText}`)
  if (!response.body) throw new Error(interrupted)
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = '', done = false
  const consume = () => {
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
      if (!line) continue
      const event = JSON.parse(line) as T
      if (event.type === 'done') done = true
      onEvent(event)
    }
  }
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) { buffer += decoder.decode(); consume(); break }
      buffer += decoder.decode(chunk.value, { stream: true }); consume()
    }
    if (!done) throw new Error(interrupted)
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export type ModelSlot = 'main' | 'summary' | 'embedding'
export type AppSettings = { notesDirectory: string; dataDirectory: string; ai: PublicAIConfig; summary: PublicAIConfig; embedding: PublicAIConfig; chatgpt: PublicChatGPTConfig }
const slot = (value: ModelSlot) => value === 'main' ? '' : '?slot=' + value

export const api = {
  agent: async (input: { session?: string; scope: AgentScope; message: string; selection?: string }, onEvent: (event: AgentEvent) => void, signal: AbortSignal) => {
    const response = await fetch('/api/ai/agent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal })
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || '无法连接 AI 助手。')
    await ndjson(response, onEvent, '对话连接中断。已完成的修改仍保留，请检查修改记录。')
  },
  conversation: (scope: AgentScope) => request<ConversationState | null>(`/api/ai/conversation?scope=${enc(JSON.stringify(scope))}`),
  changeSets: (filter: { folder?: string; name?: string } = {}) => request<ChangeSetSummary[]>(`/api/ai/changes?folder=${enc(filter.folder ?? '')}${filter.name ? '&name=' + enc(filter.name) : ''}`),
  changeSet: (id: string) => request<ChangeSetDetail>(`/api/ai/changes/${enc(id)}`),
  undoChangeSet: (id: string) => request<ChangeSetSummary>(`/api/ai/changes/${enc(id)}/undo`, { method: 'POST', body: '{}' }),
  proposal: (id: string) => request<ProposalDetail>(`/api/ai/proposals/${enc(id)}`),
  acceptProposal: (id: string) => request<{ proposal: ProposalSummary; changeset: ChangeSetSummary }>(`/api/ai/proposals/${enc(id)}/accept`, { method: 'POST', body: '{}' }),
  rejectProposal: (id: string) => request<ProposalSummary>(`/api/ai/proposals/${enc(id)}/reject`, { method: 'POST', body: '{}' }),
  memory: (target: MemoryTargetKind, name = '') => request<MemoryFileDTO>(`/api/memory?target=${target}&name=${enc(name)}`),
  saveMemory: (target: MemoryTargetKind, name: string, content: string, expected: string | null) => request<{ ok: true }>('/api/memory', { method: 'PUT', body: JSON.stringify({ target, name, content, expected }) }),
  repoStatus: () => request<RepoStatus>('/api/repo/status'),
  setRemote: (url: string | null) => request<RepoStatus>('/api/repo/remote', { method: 'PUT', body: JSON.stringify({ url }) }),
  push: async (onEvent: (event: PushEvent) => void, signal: AbortSignal) => {
    const response = await fetch('/api/repo/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal })
    await ndjson(response, onEvent, '同步连接中断。请刷新状态后重试。')
  },
  openWorkspaceFolder: (folder: string) => request<{ ok: true }>('/api/workspace/open', { method: 'POST', body: JSON.stringify({ folder }) }),
  listNotes: () => request<NoteSummary[]>('/api/notes'),
  listFolders: () => request<string[]>('/api/folders'),
  createFolder: (folder: string) => request<{ ok: true }>('/api/folders', { method: 'POST', body: JSON.stringify({ folder }) }),
  createNote: (name?: string, content?: string, folder = '') =>
    request<{ name: string }>('/api/notes', { method: 'POST', body: JSON.stringify({ name, content, folder }) }),
  loadNote: (name: string, signal?: AbortSignal) => request<NoteDTO>(`/api/notes/${enc(name)}`, { signal }),
  saveContent: (name: string, content: string, expectedContent: string) => request<NoteDTO>(`/api/notes/${enc(name)}/content`, { method: 'PUT', body: JSON.stringify({ content, expectedContent }) }),
  search: (query: string, signal?: AbortSignal) => request<(NoteSummary & { snippet: string })[]>(`/api/search?q=${enc(query)}`, { signal }),
  settings: () => request<AppSettings>('/api/settings'),
  saveAIConnection: (input: AIConnectionInput, target: ModelSlot = 'main') => request<PublicAIConfig>('/api/ai/connection' + slot(target), { method: 'PUT', body: JSON.stringify(input) }),
  clearAIConnection: (target: ModelSlot = 'main') => request<PublicAIConfig>('/api/ai/connection' + slot(target), { method: 'DELETE', body: '{}' }),
  chatGPT: () => request<PublicChatGPTConfig>('/api/ai/chatgpt'),
  loginChatGPT: (accountId?: string) => request<{ authorizationUrl: string }>('/api/ai/chatgpt/login', { method: 'POST', body: JSON.stringify({ accountId }) }),
  cancelChatGPTLogin: () => request<PublicChatGPTConfig>('/api/ai/chatgpt/login', { method: 'DELETE', body: '{}' }),
  chatGPTModels: () => request<{ slug: string; displayName: string }[]>('/api/ai/chatgpt/models'),
  selectChatGPT: (accountId: string | null, model?: string) => request<PublicChatGPTConfig>('/api/ai/chatgpt/account', { method: 'PUT', body: JSON.stringify({ accountId, model }) }),
  logoutChatGPT: (accountId: string) => request<PublicChatGPTConfig>('/api/ai/chatgpt/logout', { method: 'POST', body: JSON.stringify({ accountId }) }),
  testAIConnection: (input: AIConnectionInput, signal?: AbortSignal, target: ModelSlot = 'main') => request<{ ok: true }>('/api/ai/test' + slot(target), { method: 'POST', body: JSON.stringify(input), signal }),
  proposeEdit: (source: string, instruction: string, signal?: AbortSignal) => request<{ replacement: string }>('/api/ai/propose', { method: 'POST', body: JSON.stringify({ source, instruction }), signal }),
  canvas: (folder: string) => request<CanvasLayout>(`/api/canvas?folder=${enc(folder)}`),
  saveCanvas: (folder: string, frames: CanvasFrame[], positions: Record<string, NotePosition>, expectedFrames: CanvasFrame[]) =>
    request<CanvasLayout>('/api/canvas', { method: 'PUT', body: JSON.stringify({ folder, frames, positions, expectedFrames }) }),
  savePositions: (positions: Record<string, NotePosition>) =>
    request<{ ok: true }>('/api/canvas/positions', {
      method: 'PUT',
      body: JSON.stringify({ positions }),
    }),
}

export type ServerEvent = { type: 'hello' } | { type: 'notes-changed' } | { type: 'note-changed'; name: string } | { type: 'canvas-changed'; folder: string } | { type: 'memory-changed' } | { type: 'repo-changed' }

const listeners = new Set<(event: ServerEvent) => void>()
let events: EventSource | null = null

/** Subscribes to file-change pushes; the browser reconnects automatically if the server restarts. */
export function subscribeEvents(onEvent: (e: ServerEvent) => void): () => void {
  listeners.add(onEvent)
  // Navigation must not open another persistent connection or trigger another initial hello.
  if (!events) {
    events = new EventSource('/api/events')
    events.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as ServerEvent
        for (const listener of listeners) listener(event)
      } catch {
        /* ignore malformed frames */
      }
    }
  }
  return () => {
    listeners.delete(onEvent)
    // Reuse the connection across React's cleanup/remount and canvas → editor handoff.
    queueMicrotask(() => {
      if (!listeners.size) { events?.close(); events = null }
    })
  }
}
