import type { AIConnectionInput, PublicAIConfig, PublicChatGPTConfig, NoteDTO, NoteSummary, NotePosition, CanvasFrame, CanvasLayout, AgentScope, AgentEvent, ChangeSetSummary, ChangeSetDetail, ConversationState, ProposalSummary, ProposalDetail, MemoryFileDTO, MemoryTargetKind, RepoStatus, PushEvent, SourceRefDTO, ResolvedSourceDTO, DiscussionDTO, DiscussionSummaryDTO, DraftDTO, TurnDTO, CaptureDTO, RunDTO, RunEvent, ContextPreviewDTO, AgentRunDTO } from '../shared/types'

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

export type NoteResearch = { noteId: string; discussions: DiscussionDTO[]; drafts: DraftDTO[]; captures: CaptureDTO[]; sources: Record<string, SourceRefDTO>; runs: RunDTO[] }
export type DiscussionView = { discussion: DiscussionDTO; captures: CaptureDTO[]; sources: Record<string, SourceRefDTO>; runs: RunDTO[] }
export type CaptureTarget = { kind: 'append'; note: string } | { kind: 'new'; folder: string } | { kind: 'replace'; sourceId: string }
export type CaptureRequest = { discussionId: string; turnId: string; answerId: string; target: CaptureTarget; mode?: 'verbatim' | 'organized'; text?: string }
export type CapturePreview = { kind: 'append' | 'new' | 'replace'; noteName: string; before: string | null; after: string; expectedVersion: string | null; content: string }

/**
 * Reads a run's events until `done`. Every event has a sequence number, so a reconnect (the browser resends the last id)
 * never shows an event twice. Resolves with the final run state; rejects only if the connection cannot be kept.
 */
function followAgentRun(id: string, onEvent: (event: AgentEvent) => void, signal: AbortSignal): Promise<AgentRunDTO | null> {
  return new Promise((resolve, reject) => {
    const source = new EventSource(`/api/agent-runs/${enc(id)}/events`)
    let last = 0, settled = false, quiet: ReturnType<typeof setTimeout> | undefined
    const end = (action: () => void) => { if (settled) return; settled = true; clearTimeout(quiet); source.close(); signal.removeEventListener('abort', detach); action() }
    const detach = () => end(() => reject(new DOMException('Detached', 'AbortError')))
    const finish = () => end(() => { request<AgentRunDTO>(`/api/agent-runs/${enc(id)}`).then(resolve, () => resolve(null)) })
    if (signal.aborted) { detach(); return }
    signal.addEventListener('abort', detach, { once: true })
    source.addEventListener('snapshot', message => {
      const run = JSON.parse((message as MessageEvent).data) as AgentRunDTO
      // A finished run is replayed straight away if it is still buffered; otherwise there is nothing more to wait for.
      if (!['queued', 'running'].includes(run.status)) quiet = setTimeout(finish, 1500)
    })
    source.addEventListener('agent', message => {
      const entry = JSON.parse((message as MessageEvent).data) as { seq: number; event: AgentEvent }
      if (entry.seq <= last) return
      last = entry.seq
      onEvent(entry.event)
      if (entry.event.type === 'done') finish()
    })
    source.onerror = () => { if (source.readyState === EventSource.CLOSED) end(() => reject(new Error('与任务的连接中断。任务可能仍在运行，刷新页面可以重新接上。'))) }
  })
}

export type ModelSlot = 'main' | 'summary' | 'embedding'
export type AppSettings = { notesDirectory: string; dataDirectory: string; ai: PublicAIConfig; summary: PublicAIConfig; embedding: PublicAIConfig; chatgpt: PublicChatGPTConfig }
const slot = (value: ModelSlot) => value === 'main' ? '' : '?slot=' + value

export const api = {
  researchNote: (name: string) => request<NoteResearch>(`/api/research/note?name=${enc(name)}`),
  discussions: (archived?: boolean) => request<DiscussionSummaryDTO[]>('/api/discussions' + (archived === undefined ? '' : `?archived=${archived}`)),
  discussionView: (id: string) => request<DiscussionView>(`/api/discussions/${enc(id)}/view`),
  archiveDiscussion: (id: string, archived: boolean) => request<DiscussionDTO>(`/api/discussions/${enc(id)}/archived`, { method: 'PUT', body: JSON.stringify({ archived }) }),
  createSource: (note: string, quote: string) => request<SourceRefDTO>('/api/sources', { method: 'POST', body: JSON.stringify({ note, quote }) }),
  source: (id: string) => request<ResolvedSourceDTO>(`/api/sources/${enc(id)}`),
  createDraft: (input: { discussionId?: string; parentIds?: string[]; origin?: DiscussionDTO['origin']; items: { id: string; question: string; sourceIds: string[] }[] }) => request<DraftDTO>('/api/drafts', { method: 'POST', body: JSON.stringify(input) }),
  updateDraft: (id: string, revision: number, items: { id: string; question: string; sourceIds: string[] }[]) => request<DraftDTO>(`/api/drafts/${enc(id)}`, { method: 'PATCH', body: JSON.stringify({ revision, items }) }),
  sendDraft: (id: string, items: { id: string; question: string }[]) => request<{ discussion: DiscussionDTO; turns: TurnDTO[]; draft: DraftDTO }>(`/api/drafts/${enc(id)}/send`, { method: 'POST', body: JSON.stringify({ items }) }),
  context: (discussionId: string, turnId: string) => request<ContextPreviewDTO>(`/api/discussions/${enc(discussionId)}/turns/${enc(turnId)}/context`),
  startRun: (discussionId: string, turnId: string, requestKey: string) => request<RunDTO>(`/api/discussions/${enc(discussionId)}/turns/${enc(turnId)}/runs`, { method: 'POST', body: JSON.stringify({ requestKey }) }),
  stopRun: (id: string) => request<RunDTO>(`/api/runs/${enc(id)}/stop`, { method: 'POST', body: '{}' }),
  organize: (input: Pick<CaptureRequest, 'discussionId' | 'turnId' | 'answerId'>) => request<{ text: string }>('/api/captures/organize', { method: 'POST', body: JSON.stringify(input) }),
  capturePreview: (input: CaptureRequest) => request<CapturePreview>('/api/captures/preview', { method: 'POST', body: JSON.stringify(input) }),
  capture: (input: CaptureRequest & { requestKey: string; expectedVersion?: string | null }) => request<{ capture: CaptureDTO; change: ChangeSetSummary }>('/api/captures', { method: 'POST', body: JSON.stringify(input) }),
  /**
   * Runs one Agent request on the server and streams its events. The run belongs to the server: aborting `signal`
   * only stops listening. Use `stopAgentRun` to stop the work itself.
   */
  agent: async (input: { session?: string; scope: AgentScope; message: string; selection?: string }, onEvent: (event: AgentEvent) => void, signal: AbortSignal, hooks: { onRun?: (run: AgentRunDTO) => void } = {}): Promise<AgentRunDTO | null> => {
    const run = await request<AgentRunDTO>('/api/agent-runs', { method: 'POST', body: JSON.stringify({ ...input, requestKey: crypto.randomUUID() }), signal })
    hooks.onRun?.(run)
    return followAgentRun(run.id, onEvent, signal)
  },
  /** Attach to a run that is already going, for example after the page was reloaded. */
  followAgent: (runId: string, onEvent: (event: AgentEvent) => void, signal: AbortSignal) => followAgentRun(runId, onEvent, signal),
  acknowledgeAgentRun: (id: string) => request<AgentRunDTO>(`/api/agent-runs/${enc(id)}/acknowledge`, { method: 'POST', body: '{}' }),
  stopAgentRun: (id: string) => request<AgentRunDTO>(`/api/agent-runs/${enc(id)}/stop`, { method: 'POST', body: '{}' }),
  agentRun: (id: string) => request<AgentRunDTO>(`/api/agent-runs/${enc(id)}`),
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

/**
 * Follows one answer run. Every connection starts with a full snapshot, so a reconnect replaces what is shown
 * instead of appending to it; deltas at or below the snapshot's sequence number are ignored.
 */
export function subscribeRun(id: string, onRun: (run: RunDTO) => void, onLost: () => void): () => void {
  let run: RunDTO | null = null
  const source = new EventSource(`/api/runs/${enc(id)}/events`)
  const final = (value: RunDTO) => !['queued', 'running'].includes(value.status)
  source.addEventListener('snapshot', message => { run = JSON.parse((message as MessageEvent).data) as RunDTO; onRun(run); if (final(run)) source.close() })
  source.addEventListener('delta', message => {
    const event = JSON.parse((message as MessageEvent).data) as Extract<RunEvent, { type: 'delta' }>
    if (!run || event.seq <= run.seq) return
    run = { ...run, text: run.text + event.text, seq: event.seq }
    onRun(run)
  })
  source.addEventListener('status', message => {
    const event = JSON.parse((message as MessageEvent).data) as Extract<RunEvent, { type: 'status' }>
    if (run && event.seq <= run.seq) return
    run = event.run
    onRun(run)
    if (final(run)) source.close()
  })
  // The browser reconnects by itself; only report when it gave up.
  source.onerror = () => { if (source.readyState === EventSource.CLOSED && !(run && final(run))) onLost() }
  return () => source.close()
}
