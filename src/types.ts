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
  /** Lifecycle: user created it → typed a question → got an answer */
  status: 'pending' | 'queued' | 'streaming' | 'done' | 'error';
  /** The user's question text attached to this anchor (before it becomes a message) */
  pendingInput: string;
}

// --- Message ---
export type MessageRole = 'user' | 'assistant' | 'system';

export interface Message {
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
  branchId: BranchId;
  /** Auto-extracted or LLM-summarized conclusion from this branch */
  summary: string;
  /** Key facts / entities extracted */
  keyFacts: string[];
  updatedAt: number;
}

// --- UI State (co-located in store but logically separate) ---
export interface UIState {
  /** Current view mode */
  viewMode: 'linear' | 'canvas';
  /** Branch IDs currently expanded/visible in the side panel */
  activeBranchIds: BranchId[];
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
  /** Monotonic version counter — bumped on every recompute so React Flow
   *  can detect changes via reference equality on the arrays. */
  version: number;
}

// --- Root Store Shape ---
export interface ChatState {
  // ---- Normalized entity maps ----
  messages: Record<string, Message>;
  anchors: Record<string, Anchor>;
  branches: Record<string, Branch>;
  blackboard: Record<string, BlackboardEntry>;

  // ---- Structural ----
  rootBranchId: BranchId;

  // ---- Settings ----
  apiKey: string;
  provider: 'anthropic' | 'zhipu' | 'openai';
  /** Custom base URL (for providers with self-hosted or custom endpoints) */
  baseUrl: string;

  // ---- UI ----
  ui: UIState;

  // ---- Canvas (derived, kept in sync) ----
  canvas: CanvasState;
}

// --- Store Actions (signatures only; implementation in store.ts) ---
export interface ChatActions {
  /** Append a message to a branch */
  addMessage: (
    branchId: BranchId,
    role: MessageRole,
    content: string,
  ) => MessageId;

  /** Create an anchor from a text selection with a routing intent */
  createAnchor: (
    messageId: MessageId,
    slice: TextSlice,
    intent: AnchorIntent,
    targetBranchId?: BranchId,
  ) => AnchorId;

  /** Update the pending question text on an anchor */
  updateAnchorInput: (anchorId: AnchorId, text: string) => void;

  /** Fire all queued anchors concurrently */
  submitQueuedAnchors: () => void;

  /** Navigate: focus an anchor and expand its branch */
  focusAnchor: (anchorId: AnchorId | null) => void;

  /** Set/clear the transient text selection state */
  setPendingSelection: (sel: UIState['pendingSelection']) => void;

  /** Write a branch's conclusion to the global blackboard */
  publishToBlackboard: (
    branchId: BranchId,
    summary: string,
    keyFacts?: string[],
  ) => void;

  /** Read aggregated blackboard context (for prompt assembly) */
  getBlackboardContext: () => string;

  /** Recompute canvas nodes/edges from the current normalized state */
  recomputeCanvas: () => void;

  /**
   * Send a user message to a branch and stream an AI response.
   * Handles: adding messages, calling /api/chat, streaming content updates.
   */
  sendMessage: (branchId: BranchId, userContent: string) => Promise<void>;

  /** Switch between linear and canvas views */
  setViewMode: (mode: 'linear' | 'canvas') => void;
  /** Open/close the branch side panel (linear mode) */
  setActiveBranchPanel: (branchId: BranchId | null) => void;

  setApiKey: (key: string) => void;
  setProvider: (provider: ChatState['provider']) => void;
  setBaseUrl: (url: string) => void;

  /** Reset the entire conversation state to empty (new conversation) */
  resetToEmpty: () => void;
  /** Reset to mock/demo data */
  resetToMock: () => void;
}

export type ChatStore = ChatState & ChatActions;
