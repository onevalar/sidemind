import type { AIConnectionInput, PublicAIConfig, PublicChatGPTConfig, NoteDTO, NoteSummary, NotePosition, CanvasFrame, CanvasLayout, AgentScope, AgentEvent } from '../shared/types'

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

export const api = {
  agent: async (input: { session?: string; scope: AgentScope; message: string; selection?: string }, onEvent: (event: AgentEvent) => void, signal: AbortSignal) => {
    const response = await fetch('/api/ai/agent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal })
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || '无法连接 AI 助手。')
    if (!response.body) throw new Error('对话连接未建立。')
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let buffer = '', done = false
    const consume = () => {
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        if (!line) continue
        const event = JSON.parse(line) as AgentEvent
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
      if (!done) throw new Error('对话连接中断。已完成的修改仍保留，请检查修改记录。')
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  },
  agentChanges: (folder: string, name?: string) => request<import('../shared/types').AgentChange[]>(`/api/ai/changes?folder=${enc(folder)}${name ? '&name=' + enc(name) : ''}`),
  agentChange: (id: string) => request<import('../shared/types').AgentEdit>(`/api/ai/changes/${enc(id)}`),
  undoAgentChange: (id: string) => request<{ ok: true }>(`/api/ai/changes/${enc(id)}/undo`, { method: 'POST', body: '{}' }),
  openWorkspaceFolder: (folder: string) => request<{ ok: true }>('/api/workspace/open', { method: 'POST', body: JSON.stringify({ folder }) }),
  listNotes: () => request<NoteSummary[]>('/api/notes'),
  listFolders: () => request<string[]>('/api/folders'),
  createFolder: (folder: string) => request<{ ok: true }>('/api/folders', { method: 'POST', body: JSON.stringify({ folder }) }),
  createNote: (name?: string, content?: string, folder = '') =>
    request<{ name: string }>('/api/notes', { method: 'POST', body: JSON.stringify({ name, content, folder }) }),
  loadNote: (name: string, signal?: AbortSignal) => request<NoteDTO>(`/api/notes/${enc(name)}`, { signal }),
  recordOpen: (name: string) => request<{ ok: true }>(`/api/notes/${enc(name)}/open`, { method: 'POST', body: '{}' }),
  saveContent: (name: string, content: string, expectedContent: string) => request<NoteDTO>(`/api/notes/${enc(name)}/content`, { method: 'PUT', body: JSON.stringify({ content, expectedContent }) }),
  search: (query: string, signal?: AbortSignal) => request<(NoteSummary & { snippet: string })[]>(`/api/search?q=${enc(query)}`, { signal }),
  settings: () => request<{ notesDirectory: string; ai: PublicAIConfig; chatgpt: PublicChatGPTConfig }>('/api/settings'),
  saveAIConnection: (input: AIConnectionInput) => request<PublicAIConfig>('/api/ai/connection', { method: 'PUT', body: JSON.stringify(input) }),
  clearAIConnection: () => request<PublicAIConfig>('/api/ai/connection', { method: 'DELETE', body: '{}' }),
  chatGPT: () => request<PublicChatGPTConfig>('/api/ai/chatgpt'),
  loginChatGPT: (accountId?: string) => request<{ authorizationUrl: string }>('/api/ai/chatgpt/login', { method: 'POST', body: JSON.stringify({ accountId }) }),
  cancelChatGPTLogin: () => request<PublicChatGPTConfig>('/api/ai/chatgpt/login', { method: 'DELETE', body: '{}' }),
  chatGPTModels: () => request<{ slug: string; displayName: string }[]>('/api/ai/chatgpt/models'),
  selectChatGPT: (accountId: string | null, model?: string) => request<PublicChatGPTConfig>('/api/ai/chatgpt/account', { method: 'PUT', body: JSON.stringify({ accountId, model }) }),
  logoutChatGPT: (accountId: string) => request<PublicChatGPTConfig>('/api/ai/chatgpt/logout', { method: 'POST', body: JSON.stringify({ accountId }) }),
  testAIConnection: (input: AIConnectionInput, signal?: AbortSignal) => request<{ ok: true }>('/api/ai/test', { method: 'POST', body: JSON.stringify(input), signal }),
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

export type ServerEvent = { type: 'hello' } | { type: 'notes-changed' } | { type: 'note-changed'; name: string } | { type: 'canvas-changed'; folder: string }

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
