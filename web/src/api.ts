import type { AIConnectionInput, PublicAIConfig, CanvasGroup, NoteDTO, NoteSummary } from '../shared/types'

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
  createNote: (name?: string, content?: string) =>
    request<{ name: string }>('/api/notes', { method: 'POST', body: JSON.stringify({ name, content }) }),
  loadNote: (name: string) => request<NoteDTO>(`/api/notes/${enc(name)}`),
  recordOpen: (name: string) => request<{ ok: true }>(`/api/notes/${enc(name)}/open`, { method: 'POST', body: '{}' }),
  saveContent: (name: string, content: string, expectedContent: string) => request<NoteDTO>(`/api/notes/${enc(name)}/content`, { method: 'PUT', body: JSON.stringify({ content, expectedContent }) }),
  saveGroups: (name: string, groups: CanvasGroup[]) => request<{ ok: true }>(`/api/notes/${enc(name)}/groups`, { method: 'PUT', body: JSON.stringify({ groups }) }),
  saveSpace: (name: string, space: string) => request<{ ok: true }>(`/api/notes/${enc(name)}/space`, { method: 'PUT', body: JSON.stringify({ space }) }),
  search: (query: string, signal?: AbortSignal) => request<(NoteSummary & { snippet: string })[]>(`/api/search?q=${enc(query)}`, { signal }),
  settings: () => request<{ notesDirectory: string; ai: PublicAIConfig }>('/api/settings'),
  saveAIConnection: (input: AIConnectionInput) => request<PublicAIConfig>('/api/ai/connection', { method: 'PUT', body: JSON.stringify(input) }),
  clearAIConnection: () => request<PublicAIConfig>('/api/ai/connection', { method: 'DELETE', body: '{}' }),
  testAIConnection: (input: AIConnectionInput, signal?: AbortSignal) => request<{ ok: true }>('/api/ai/test', { method: 'POST', body: JSON.stringify(input), signal }),
  proposeEdit: (source: string, instruction: string, signal?: AbortSignal) => request<{ replacement: string }>('/api/ai/propose', { method: 'POST', body: JSON.stringify({ source, instruction }), signal }),
  savePositions: (name: string, positions: Record<string, { x: number; y: number }>) =>
    request<{ ok: true }>(`/api/notes/${enc(name)}/positions`, {
      method: 'PUT',
      body: JSON.stringify({ positions }),
    }),
}

export type ServerEvent = { type: 'hello' } | { type: 'notes-changed' } | { type: 'note-changed'; name: string }

/** Subscribes to file-change pushes; the browser reconnects automatically if the server restarts. */
export function subscribeEvents(onEvent: (e: ServerEvent) => void): () => void {
  const source = new EventSource('/api/events')
  source.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data) as ServerEvent)
    } catch {
      /* ignore malformed frames */
    }
  }
  return () => source.close()
}
