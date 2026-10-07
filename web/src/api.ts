import type { NoteDTO, NoteSummary } from '../shared/types'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => '')) || res.statusText}`)
  return res.json() as Promise<T>
}

const enc = encodeURIComponent

export const api = {
  listNotes: () => request<NoteSummary[]>('/api/notes'),
  createNote: (name?: string) =>
    request<{ name: string }>('/api/notes', { method: 'POST', body: JSON.stringify({ name }) }),
  loadNote: (name: string) => request<NoteDTO>(`/api/notes/${enc(name)}`),
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
