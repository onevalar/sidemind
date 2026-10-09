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
