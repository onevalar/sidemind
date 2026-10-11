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
  /** Explicit user visits, independent of file modification time. */
  lastOpenedAt: number
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
