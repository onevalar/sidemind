import type { AIConnectionInput, PublicAIConfig, PublicChatGPTConfig, NoteDTO, NoteSummary, NotePosition, CanvasFrame, CanvasLayout } from '../shared/types'

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
  openWorkspaceFolder: () => request<{ ok: true }>('/api/workspace/open', { method: 'POST', body: '{}' }),
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
