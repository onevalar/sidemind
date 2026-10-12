export interface NoteDTO {
  name: string
  content: string
  /** Relative folder path; an empty string is the workspace root. */
  space: string
}

export interface NotePosition {
  x: number
  y: number
}

export interface CanvasFrame {
  id: string
  space: string
  title: string
  position: NotePosition
  width: number
  height: number
  /** One article can belong to at most one frame, in its own folder. */
  members: string[]
}

export interface CanvasLayout {
  frames: CanvasFrame[]
  /** Persisted world coordinates, including articles inside a frame. */
  positions: Record<string, NotePosition>
}

export interface NoteSummary {
  name: string
  mtime: number
  title: string
  excerpt: string
  space: string
  /** Article coordinates, unrelated to content or sorting. */
  position: NotePosition
}

export interface PublicAIConfig {
  configured: boolean
  keySaved: boolean
  model: string
  baseUrl: string
  source: 'saved' | 'environment' | 'none'
  /** Recoverable configuration error; never includes credentials. */
  error?: string
}
export interface AIConnectionInput {
  model: string
  baseUrl: string
  key?: string
}

export interface PublicChatGPTConfig {
  configured: boolean
  accounts: { id: string; label: string; signedIn: boolean }[]
  activeAccountId: string | null
  model: string
  loginStatus: 'idle' | 'waiting' | 'success' | 'error'
  /** Cannot determine the selected provider safely; do not fall back to an API key. */
  unavailable?: boolean
  error?: string
}

export type AgentScope = { kind: 'chat'; folder: string } | { kind: 'folder'; folder: string } | { kind: 'note'; folder: string; name: string }
/** One user request's worth of Agent changes, undone as a whole. */
export interface ChangeSetSummary {
  id: string
  request: string
  createdAt: number
  origin: 'request' | 'proposal'
  undone: boolean
  /** False once any touched file changed again; undo would refuse. */
  undoable: boolean
  files: { name: string; kind: 'create' | 'edit' | 'delete' }[]
  /** Number of memory files touched. */
  memory: number
  /** Folders whose canvas layout changed. */
  layouts: string[]
}
export interface ChangeSetDetail extends ChangeSetSummary {
  diffs: { area: 'notes' | 'memory'; name: string; before: string | null; after: string | null }[]
}
export interface PlanStep { text: string; status: 'pending' | 'active' | 'done' }
export interface ProposalSummary {
  id: string
  createdAt: number
  reason: string
  conversation?: string
  files: { name: string; kind: 'create' | 'edit' | 'delete' }[]
  layouts: string[]
  status: 'pending' | 'applied' | 'rejected' | 'stale'
}
export interface ProposalDetail extends ProposalSummary {
  diffs: { name: string; before: string | null; after: string | null }[]
}
export type AgentEvent =
  | { type: 'session'; id: string }
  | { type: 'activity'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'message'; text: string }
  | { type: 'plan'; steps: PlanStep[] }
  | { type: 'changeset'; change: ChangeSetSummary }
  | { type: 'proposal'; proposal: ProposalSummary }
  | { type: 'focus'; folder: string; names: string[] }
  | { type: 'error'; text: string }
  | { type: 'done' }
export interface ConversationState {
  id: string
  scope: AgentScope
  updatedAt: number
  messages: { role: 'user' | 'assistant'; text: string }[]
  changes: ChangeSetSummary[]
  proposals: ProposalSummary[]
  plan: PlanStep[]
  /** Set when the conversation has a request still running on the server. */
  activeRun?: AgentRunDTO
  /** Runs a restart stopped after they had changed notes, not yet acknowledged by the user. */
  recovery?: AgentRunDTO[]
}
export type MemoryTargetKind = 'note' | 'folder' | 'library'
export interface MemoryFileDTO { target: MemoryTargetKind; name: string; file: string; content: string; exists: boolean }

export interface ModelSlotConfig {
  configured: boolean
  keySaved: boolean
  model: string
  baseUrl: string
  source: 'saved' | 'environment' | 'none'
  error?: string
}
export interface RepoStatus {
  /** False when git is unavailable; notes still work, pushing does not. */
  git: boolean
  dataDirectory: string
  branch: string
  /** Uncommitted paths in the data repository. */
  changes: number
  noteChanges: number
  remote: string | null
  /** Local commits not yet on the remote, or null without an upstream. */
  ahead: number | null
  head: string | null
  pushing: boolean
}
export type PushEvent =
  | { type: 'step'; text: string }
  | { type: 'note'; name: string; kind: string; detail?: string }
  | { type: 'warning'; text: string }
  | { type: 'report'; report: PushReport }
  | { type: 'error'; text: string }
  | { type: 'done' }
export interface PushReport {
  committed: string | null
  message: string
  notes: { name: string; kind: string; memory: 'updated' | 'unchanged' | 'pending' | 'removed' | 'moved' }[]
  folders: string[]
  stale: { name: string; because: string }[]
  layout: string[]
  pushed: boolean
  pushError?: string
}

/** A frozen reference to selected note text. The quote is evidence even when the note later changes. */
export interface SourceRefDTO {
  id: string
  noteId: string
  /** Path at capture time; resolve through `noteId` for the current path. */
  notePath: string
  noteVersion: string
  quote: string
  before: string
  after: string
  section: string
  start: number
  end: number
  createdAt: number
}
export type SourceStatus = 'current' | 'moved' | 'ambiguous' | 'missing' | 'note-deleted'
export interface ResolvedSourceDTO { source: SourceRefDTO; status: SourceStatus; notePath: string | null; start: number | null; end: number | null }

export interface AnswerVersionDTO {
  id: string; text: string; createdAt: number; runId?: string
  /** Earlier turns whose answers were sent as summaries (not verbatim) when this answer was generated. */
  summarizedTurns?: string[]
}
export interface TurnDTO {
  id: string
  /** Turns whose answers form the context; several parents is a merge. */
  parents: string[]
  question: string
  sourceIds: string[]
  /** Idempotency key that produced this turn. */
  requestKey: string
  /** Answer version of every ancestor as it was when this question was asked; later retries do not change this question's context. */
  frozen?: Record<string, string>
  answers: AnswerVersionDTO[]
  createdAt: number
}
export interface DiscussionDTO {
  id: string
  title: string
  origin: { kind: 'chat' } | { kind: 'note'; noteId: string; sourceId?: string }
  revision: number
  archived: boolean
  turns: TurnDTO[]
  createdAt: number
  updatedAt: number
}
export interface DiscussionSummaryDTO extends Omit<DiscussionDTO, 'turns'> {
  turnCount: number
  lastQuestion: string
  /** Current path of the note the discussion started from; null for a plain chat or a deleted note. */
  notePath: string | null
}
export interface DraftItemDTO { id: string; question: string; sourceIds: string[] }
export interface DraftDTO {
  id: string
  title: string
  discussionId: string | null
  /** Answers' parent turns for every question in this draft. */
  parentIds: string[]
  origin: DiscussionDTO['origin']
  items: DraftItemDTO[]
  revision: number
  createdAt: number
  updatedAt: number
}
export interface CaptureDTO {
  id: string
  requestKey: string
  mode: 'verbatim' | 'organized'
  target: { kind: 'new' | 'append' | 'replace'; noteId: string; notePath: string; beforeVersion: string | null; afterVersion: string }
  answers: { discussionId: string; turnId: string; answerId: string; text: string }[]
  sourceIds: string[]
  /** For `organized` captures: the exact text that was written, as confirmed by the user. */
  writtenText?: string
  changeSetId?: string
  createdAt: number
}

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
/** One generation of an answer. It lives on the server, not in the page that asked for it. */
export interface RunDTO {
  id: string
  discussionId: string
  turnId: string
  requestKey: string
  status: RunStatus
  /** Answer text so far; kept after a failure, stop or restart. */
  text: string
  /** Increases with every delta, so a client can tell what it has already shown. */
  seq: number
  error?: string
  answerId?: string
  createdAt: number
  updatedAt: number
}
export type RunEvent = { seq: number; type: 'delta'; text: string } | { seq: number; type: 'status'; run: RunDTO }

export interface ContextPreviewDTO {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  /** Rough size, not an exact token count: each model counts differently. */
  estimatedTokens: number
  budget: number
  exceeded: boolean
  /** Turns whose answers are in this context, oldest first. */
  turns: { id: string; question: string; answerId: string | null; /** `summary`: the earlier answer is sent as a summary because the context would not fit otherwise. */ mode: 'raw' | 'summary' }[]
  /** Earlier answers that could be shortened to a summary but have none yet (never the branches selected directly). */
  summarizable: { turnId: string; answerId: string }[]
}

/** One Note Agent request running on the server. Its history lives in the conversation; this tracks the run itself. */
/**
 * An Agent run is `queued`/`running` while the model loop works. It then ends as `completed`, or: `waiting_confirmation`
 * (finished, but proposals it queued still await the user), `recovery_required` (stopped by a restart after it had
 * already changed notes, so it may have done only part of its work), `interrupted`, `cancelled` or `failed`.
 */
export type AgentRunStatus = RunStatus | 'waiting_confirmation' | 'recovery_required'
export interface AgentRunDTO {
  id: string
  scope: AgentScope
  /** Conversation this run writes to, once known. */
  session?: string
  requestKey: string
  status: AgentRunStatus
  /** Change sets and proposals this run produced, recorded as they happen so a restart can tell what it already did. */
  changes?: string[]
  proposals?: string[]
  /** Sequence number of the latest event; events are numbered from 1. */
  seq: number
  error?: string
  createdAt: number
  updatedAt: number
}
