// ============================================================
// ChatGit — Core Data Types
// DAG-based non-linear conversation model
// ============================================================

// --- Branded ID types for type safety ---
export type MessageId = string & { readonly __brand: 'MessageId' };
export type AnchorId = string & { readonly __brand: 'AnchorId' };
export type BranchId = string & { readonly __brand: 'BranchId' };

// --- Text Selection ---
/** Represents a precise text slice within a message's raw Markdown content. */
export interface TextSlice {
  /** Character offset (inclusive) in the source Markdown string */
  startOffset: number;
  /** Character offset (exclusive) */
  endOffset: number;
  /** Denormalized copy of the selected text for display convenience */
  selectedText: string;
}

// --- Anchor Intent ---
/** The routing intent chosen by the user when creating an anchor */
export type AnchorIntent = 'main' | 'new-branch' | 'existing-branch';

// --- Anchor ---
/**
 * An Anchor is the "edge" of our DAG.
 * It binds a highlighted text slice inside a parent message
 * to a child branch conversation.
 */
export interface Anchor {
  id: AnchorId;
  /** The assistant message this anchor lives on */
  messageId: MessageId;
  /** Exact text range that was selected */
  slice: TextSlice;
  /** The branch this anchor routes to */
  branchId: BranchId;
  /** Which routing intent was chosen */
  intent: AnchorIntent;
  /** Visual color tag — derived from intent (blue/green/purple) */
  color: string;
  /** Lifecycle: question sent (streaming) → answered (done) or failed (error) */
  status: 'streaming' | 'done' | 'error';
}

// --- Message ---
export type MessageRole = 'user' | 'assistant' | 'system';

/** The text a user quoted (by selecting it) when asking this question. */
export interface MessageQuote {
  /** Raw Markdown of the selected slice — this is what gets sent to the LLM */
  raw: string;
  /** Human-readable text of the selection — this is what the UI shows */
  display: string;
  /** The assistant message the text was selected from */
  sourceMessageId: MessageId;
}

export interface Message {
  example?: boolean;
  id: MessageId;
  role: MessageRole;
  /** Raw Markdown content */
  content: string;
  /** Previous message in the SAME branch (linked-list within a branch) */
  parentId: MessageId | null;
  /** Which branch this message belongs to */
  branchId: BranchId;
  /** Anchor IDs created on this message (only meaningful for assistant msgs) */
  anchorIds: AnchorId[];
  createdAt: number;
  /** Set on user messages that were asked about a selected passage */
  quote?: MessageQuote;
  /** Set when generating this (assistant) message failed or was interrupted */
  error?: string;
}

// --- Branch ---
/**
 * A Branch is a linear conversation thread.
 * The root branch has no source anchor.
 * Child branches are spawned from an anchor on a parent-branch message.
 */
export interface Branch {
  id: BranchId;
  /** Human-readable label for the branch (shown in dropdowns) */
  label: string;
  /** null for the root/main branch */
  sourceAnchorId: AnchorId | null;
  /** The message in the parent branch that contains the source anchor */
  sourceMessageId: MessageId | null;
  /** Ordered message IDs in this branch */
  messageIds: MessageId[];
  /** Branch processing state */
  status: 'idle' | 'queued' | 'streaming' | 'done' | 'error';
}

// --- Global Blackboard ---
/**
 * Each branch can publish a structured summary to the blackboard.
 * Other branches (and the main thread) read from it to gain
 * cross-branch context without explicit user intervention.
 */
export interface BlackboardEntry {
  example?: boolean;
  branchId: BranchId;
  /** Exact reply used to produce this conclusion; absent in older saved data. */
  sourceMessageId?: MessageId;
  /** Auto-extracted or LLM-summarized conclusion from this branch */
  summary: string;
  /** Key facts / entities extracted */
  keyFacts: string[];
  updatedAt: number;
}

// --- UI State (co-located in store but logically separate) ---
export interface UIState {
  messageReveal?: { messageId: MessageId; request: number };
  /** Current view mode */
  viewMode: 'linear' | 'canvas';
  canvasMode: 'branches' | 'messages';
  /** The anchor currently focused/highlighted (drives scroll-to + glow) */
  focusedAnchorId: AnchorId | null;
  /** Branch shown in the right side panel (linear mode) */
  activeBranchPanelId: BranchId | null;
  /** Pending text selection (before user confirms creating an anchor) */
  pendingSelection: {
    messageId: MessageId;
    slice: TextSlice;
    rect: DOMRect; // for positioning the popover
  } | null;
}

// --- Canvas-derived state (React Flow) ---
import type { Node, Edge } from '@xyflow/react';

export interface CanvasState {
  /** React Flow nodes derived from messages */
  nodes: Node[];
  /** React Flow edges (sequential + anchor) */
  edges: Edge[];
}

// --- Root Store Shape ---
export interface ChatState {
  branchPositions: Record<string, BranchPositions>;
  conversationModels: Record<string, ModelConnection>;
  connectionCredentials: Record<string, string>;
  providerConnections: Partial<Record<Provider, ModelConnection>>;
  spaces: Record<string, ConversationSpace>;
  conversationSpaces: Record<string, string>;
  activeSpaceId: string | null;
  conversations: Record<string, ConversationSnapshot>;
  activeConversationId: string;
  // ---- Normalized entity maps ----
  messages: Record<string, Message>;
  anchors: Record<string, Anchor>;
  branches: Record<string, Branch>;
  blackboard: Record<string, BlackboardEntry>;

  // ---- Structural ----
  rootBranchId: BranchId;

  // ---- Settings ----
  apiKey: string;
  provider: Provider;
  /** Custom base URL (for providers with self-hosted or custom endpoints) */
  baseUrl: string;
  model: string;

  // ---- UI ----
  ui: UIState;

  // ---- Canvas (derived, kept in sync) ----
  canvas: CanvasState;
}

// --- Store Actions (signatures only; implementation in store.ts) ---

/** Outcome of sending a message to a branch */
export type SendResult = 'ok' | 'error' | 'busy';

export interface AskFromSelectionArgs {
  branchLabel?: string;
  messageId: MessageId;
  slice: TextSlice;
  intent: AnchorIntent;
  /** Required for 'existing-branch' */
  targetBranchId?: BranchId;
  question: string;
}

export interface ChatActions {
  renameBranch: (id: BranchId, name: string) => void;
  setCanvasMode: (mode: UIState['canvasMode']) => void;
  updateCanvasNodes: (changes: import('@xyflow/react').NodeChange[]) => void;
  arrangeBranchCanvas: () => void;
  createSpace: (name: string) => void;
  renameSpace: (id: string, name: string) => void;
  deleteSpace: (id: string) => void;
  setActiveSpace: (id: string | null) => void;
  moveConversation: (conversationId: string, spaceId: string | null) => void;
  switchConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  stopGeneration: () => void;
  saveConnection: (config: ModelConnection, apiKey: string) => void;
  /**
   * Create an anchor from a text selection and immediately send the user's
   * question (with the selected passage attached) to the routed branch.
   * Returns the branch the question went to, or null if that branch is busy.
   */
  askFromSelection: (args: AskFromSelectionArgs) => BranchId | null;

  /** Navigate: focus an anchor and open its branch */
  focusAnchor: (anchorId: AnchorId | null) => void;

  /** Set/clear the transient text selection state */
  setPendingSelection: (sel: UIState['pendingSelection']) => void;

  /** Write a branch's conclusion to the global blackboard */
  publishToBlackboard: (
    branchId: BranchId,
    summary: string,
    keyFacts?: string[],
    sourceMessageId?: MessageId,
  ) => void;

  revealMessage: (messageId: MessageId) => void;

  /** Recompute canvas nodes/edges from the current normalized state */
  recomputeCanvas: () => void;

  /**
   * Send a user message to a branch and stream an AI response.
   * Resolves with 'busy' (and does nothing) if the branch is still generating.
   */
  sendMessage: (
    branchId: BranchId,
    userContent: string,
    quote?: MessageQuote,
  ) => Promise<SendResult>;

  /** Switch between linear and canvas views */
  setViewMode: (mode: 'linear' | 'canvas') => void;
  /** Open/close the branch side panel (linear mode) */
  setActiveBranchPanel: (branchId: BranchId | null) => void;

  /** Reset the entire conversation state to empty (new conversation) */
  resetToEmpty: () => void;
  /** Reset to mock/demo data */
  resetToMock: () => void;
}

export type ChatStore = ChatState & ChatActions;

export type Provider = 'anthropic' | 'zhipu' | 'openai';
export interface ModelConnection { provider: Provider; model: string; baseUrl: string }
export interface CanvasPoint { x: number; y: number }
export type BranchPositions = Record<string, CanvasPoint>;

export interface ConversationSpace { id: string; name: string }

export type ConversationData = Pick<ChatState, 'messages' | 'anchors' | 'branches' | 'blackboard' | 'rootBranchId'>;
export type ConversationSnapshot = ConversationData & { id: string; title: string; updatedAt: number };
