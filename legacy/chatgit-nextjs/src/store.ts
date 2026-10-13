import { create } from 'zustand';
import {
  persist,
  type PersistStorage,
  type StorageValue,
} from 'zustand/middleware';
import type {
  ChatState,
  ChatStore,
  BranchId,
  MessageId,
  AnchorId,
  AnchorIntent,
  Anchor,
  Branch,
  Message,
  MessageQuote,
  SendResult,
  UIState,
} from './types';
import { settledConversation, snapshotConversation } from './history';
import { restoreSpaces, withoutSpace } from './spaces';
import { modelConnection, connectionKey, conversationConnection, conversationCredential, restoreModelState } from './connections';
import { createMessageId, createAnchorId, createBranchId } from './lib/id';
import { colorForIntent } from './lib/colors';
import { mockState, emptyState } from './lib/mock';
import { deriveCanvasElements } from './lib/canvas-adapter';
import { branchCanvas, validCanvasPoint, restoreBranchPositions } from './lib/branch-canvas';
import { applyNodeChanges } from '@xyflow/react';
import {
  buildApiMessages,
  buildContext,
  summarizeExchange,
} from './lib/context';

// ─── Persistence ────────────────────────────────────────────────────────

/** What survives a page refresh: settings + the whole conversation */
type PersistedSlice = Pick<
  ChatState,
  | 'messages'
  | 'anchors'
  | 'branches'
  | 'blackboard'
  | 'rootBranchId'
  | 'apiKey'
  | 'provider'
  | 'baseUrl'
  | 'model'
  | 'conversations'
  | 'activeConversationId'
  | 'spaces'
  | 'conversationSpaces'
  | 'activeSpaceId'
  | 'conversationModels'
  | 'connectionCredentials'
  | 'providerConnections'
  | 'branchPositions'
>;

const PROVIDERS: ChatState['provider'][] = ['anthropic', 'zhipu', 'openai'];
const STORAGE_KEY = 'chatgit-settings';
const WRITE_DELAY_MS = 600;

/**
 * localStorage adapter that writes at most once per WRITE_DELAY_MS.
 * During streaming the store changes on every token; serialising the whole
 * conversation each time would be wasteful, so only the latest snapshot is
 * written (and flushed when the tab is hidden or closed).
 */
function createPersistStorage(): PersistStorage<PersistedSlice> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { name: string; value: StorageValue<PersistedSlice> } | null =
    null;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!pending) return;
    const { name, value } = pending;
    pending = null;
    try {
      localStorage.setItem(name, JSON.stringify(value));
    } catch {
      // Storage full or blocked — keep working without persistence
    }
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }

  return {
    getItem: (name) => {
      try {
        const raw = localStorage.getItem(name);
        return raw ? (JSON.parse(raw) as StorageValue<PersistedSlice>) : null;
      } catch {
        return null;
      }
    },
    setItem: (name, value) => {
      pending = { name, value };
      if (!timer) timer = setTimeout(flush, WRITE_DELAY_MS);
    },
    removeItem: (name) => {
      pending = null;
      try {
        localStorage.removeItem(name);
      } catch {
        // ignore
      }
    },
  };
}

/** Repair a restored snapshot: nothing can still be "generating" after a reload */
function sanitizePersisted(p: Partial<PersistedSlice>): Partial<PersistedSlice> {
  const out: Partial<PersistedSlice> = {};

  if (typeof p.apiKey === 'string') out.apiKey = p.apiKey;
  if (p.provider && PROVIDERS.includes(p.provider)) out.provider = p.provider;
  if (typeof p.baseUrl === 'string') out.baseUrl = p.baseUrl;
  if (typeof p.model === 'string') out.model = p.model;
  if (p.conversations && typeof p.conversations === 'object') out.conversations = p.conversations;
  if (typeof p.activeConversationId === 'string') out.activeConversationId = p.activeConversationId;
  const organization = restoreSpaces(p.spaces, p.conversationSpaces);
  Object.assign(out, organization);
  out.activeSpaceId = typeof p.activeSpaceId === 'string' && Object.hasOwn(organization.spaces, p.activeSpaceId) ? p.activeSpaceId : null;
  Object.assign(out, restoreModelState(p, { provider: out.provider || 'zhipu', model: out.model || '', baseUrl: out.baseUrl || '' }));
  out.branchPositions = restoreBranchPositions(p.branchPositions);

  const hasConversation =
    p.messages && p.branches && p.rootBranchId && p.branches[p.rootBranchId];
  if (!hasConversation) return out;

  const messages: Record<string, Message> = {};
  for (const [id, m] of Object.entries(p.messages!)) {
    messages[id] =
      m.role === 'assistant' && !m.content && !m.error
        ? { ...m, error: '回复被中断，请重新提问' }
        : m;
  }

  const branches: Record<string, Branch> = {};
  for (const [id, b] of Object.entries(p.branches!)) {
    branches[id] = b.status === 'streaming' ? { ...b, status: 'done' } : b;
  }

  const anchors: Record<string, Anchor> = {};
  for (const [id, a] of Object.entries(p.anchors ?? {})) {
    anchors[id] = a.status === 'streaming' ? { ...a, status: 'done' } : a;
  }

  out.messages = messages;
  out.branches = branches;
  out.anchors = anchors;
  out.blackboard = p.blackboard ?? {};
  out.rootBranchId = p.rootBranchId;
  return out;
}

// ─── Streaming protocol ─────────────────────────────────────────────────

type SseEvent = 'done' | { text?: string; error?: string } | null;

/** Parse one `data: …` line of the /api/chat event stream */
function parseSseLine(line: string): SseEvent {
  if (!line.startsWith('data: ')) return null;
  const raw = line.slice(6).trim();
  if (raw === '[DONE]') return 'done';
  try {
    return JSON.parse(raw) as { text?: string; error?: string };
  } catch {
    return null;
  }
}

const CANVAS_THROTTLE_MS = 250;
const FOCUS_GLOW_MS = 2500;

export const useChatStore = create<ChatStore>()(
  persist<ChatStore, [], [], PersistedSlice>(
    (set, get) => {
      // ── Canvas derivation (throttled; only when the canvas is visible) ──
      let lastCanvasRun = 0;
      let canvasTimer: ReturnType<typeof setTimeout> | null = null;

      function runCanvas() {
        lastCanvasRun = Date.now();
        const state = get();
        if (state.ui.canvasMode === 'branches') {
          const { nodes, edges, positions } = branchCanvas(state, state.branchPositions[state.activeConversationId]);
          set({ canvas: { nodes, edges }, branchPositions: { ...state.branchPositions, [state.activeConversationId]: positions } });
        } else {
          const { nodes, edges } = deriveCanvasElements(state);
          set({ canvas: { nodes, edges } });
        }
      }

      function recompute(force = false) {
        if (get().ui.viewMode !== 'canvas') return;
        if (canvasTimer) {
          clearTimeout(canvasTimer);
          canvasTimer = null;
        }
        const wait = CANVAS_THROTTLE_MS - (Date.now() - lastCanvasRun);
        if (force || wait <= 0) {
          runCanvas();
        } else {
          canvasTimer = setTimeout(() => {
            canvasTimer = null;
            runCanvas();
          }, wait);
        }
      }

      // ── In-flight requests (so "new conversation" can cancel them) ──
      let generationEpoch = 0;
      const controllers = new Set<AbortController>();
      function abortAll() {
        generationEpoch++;
        controllers.forEach((c) => c.abort());
        controllers.clear();
      }

      // ── Safe patch helpers (the target may vanish on reset) ──
      function patchMessage(id: MessageId, patch: Partial<Message>) {
        set((s) =>
          s.messages[id]
            ? { messages: { ...s.messages, [id]: { ...s.messages[id], ...patch } } }
            : s,
        );
      }
      function patchBranch(id: BranchId, patch: Partial<Branch>) {
        set((s) =>
          s.branches[id]
            ? { branches: { ...s.branches, [id]: { ...s.branches[id], ...patch } } }
            : s,
        );
      }
      function patchAnchor(id: AnchorId, patch: Partial<Anchor>) {
        set((s) =>
          s.anchors[id]
            ? { anchors: { ...s.anchors, [id]: { ...s.anchors[id], ...patch } } }
            : s,
        );
      }

      /** Append a message to the end of a branch */
      function appendMessage(
        branchId: BranchId,
        role: Message['role'],
        content: string,
        extra: Partial<Message> = {},
      ): MessageId {
        const id = createMessageId();
        const branch = get().branches[branchId];
        const parentId =
          branch.messageIds.length > 0
            ? (branch.messageIds[branch.messageIds.length - 1] as MessageId)
            : null;

        set((s) => ({
          messages: {
            ...s.messages,
            [id]: {
              id,
              role,
              content,
              parentId,
              branchId,
              anchorIds: [],
              createdAt: Date.now(),
              ...extra,
            },
          },
          branches: {
            ...s.branches,
            [branchId]: {
              ...s.branches[branchId],
              messageIds: [...s.branches[branchId].messageIds, id],
            },
          },
        }));
        return id;
      }

      /**
       * Ask the model to answer the branch's last user message.
       * Resolves 'ok' on success, 'error' otherwise (the failure is shown
       * on the assistant message itself).
       */
      async function streamAssistantReply(
        branchId: BranchId,
      ): Promise<'ok' | 'error'> {
        // Snapshot what the model should see BEFORE the empty reply is added
        const epoch = generationEpoch;
        const apiMessages = buildApiMessages(get(), branchId);
        const context = buildContext(get(), branchId);
        const questionMsg = get().messages[
          get().branches[branchId].messageIds.slice(-1)[0]
        ];

        const assistantMsgId = appendMessage(branchId, 'assistant', '');
        patchBranch(branchId, { status: 'streaming' });
        recompute();

        const controller = new AbortController();
        controllers.add(controller);

        let accumulated = '';
        let failure: string | null = null;

        try {
          const connection = conversationConnection(get());
          const { provider, baseUrl, model } = connection;
          const apiKey = conversationCredential(get(), connection);
          if (!apiKey) throw new Error(`请先在模型设置中配置此对话使用的 ${provider} 连接密钥（${baseUrl}）。`);

          const response = await fetch('/api/chat', {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'x-provider': provider,
              ...(baseUrl ? { 'x-base-url': baseUrl } : {}),
              ...(model ? { 'x-model': model } : {}),
            },
            body: JSON.stringify({ messages: apiMessages, context }),
          });

          if (!response.ok || !response.body) {
            const err = await response
              .json()
              .catch(() => ({ error: `HTTP ${response.status}` }));
            throw new Error(err.error ?? `HTTP ${response.status}`);
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let finished = false;

          const handle = (line: string) => {
            if (controller.signal.aborted || epoch !== generationEpoch) return;
            const evt = parseSseLine(line);
            if (!evt) return;
            if (evt === 'done') {
              finished = true;
              return;
            }
            if (evt.error) throw new Error(evt.error);
            if (evt.text) {
              accumulated += evt.text;
              patchMessage(assistantMsgId, { content: accumulated });
              recompute();
            }
          };

          while (!finished) {
            const { done, value } = await reader.read();
            if (done) break;

            // An event can be split across network chunks — buffer by line
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              handle(line);
              if (finished) break;
            }
          }
          if (!finished && buffer) handle(buffer);
          if (!finished) throw new Error('连接提前结束，已保留收到的内容，请重试。');

          if (!accumulated.trim()) {
            throw new Error('AI 没有返回内容，请稍后重试');
          }
        } catch (err) {
          if (controller.signal.aborted) {
            // Conversation was reset while generating — nothing to report
            controllers.delete(controller);
            return 'error';
          }
          failure = err instanceof Error ? err.message : '请求失败';
        }

        controllers.delete(controller);

        if (epoch !== generationEpoch) return 'error';
        patchMessage(assistantMsgId, failure ? { error: failure } : { error: undefined });
        patchBranch(branchId, { status: failure ? 'error' : 'done' });

        // Publish this exchange so other branches can see the conclusion
        if (!failure && get().branches[branchId]?.sourceAnchorId) {
          const { summary, keyFacts } = summarizeExchange(
            questionMsg?.content ?? '',
            accumulated,
          );
          get().publishToBlackboard(branchId, summary, keyFacts, assistantMsgId);
        }

        recompute(true);
        return failure ? 'error' : 'ok';
      }

      let focusTimer: ReturnType<typeof setTimeout> | null = null;

      return {
        // ---- Initial state ----
        ...emptyState,
        apiKey: '',
        provider: 'zhipu' as const,
        baseUrl: '',
        model: '',
        conversations: {},
        activeConversationId: 'initial',
        spaces: {},
        conversationSpaces: {},
        activeSpaceId: null,
        branchPositions: {},
        conversationModels: {},
        connectionCredentials: {},
        providerConnections: {},

        createSpace: (name) => {
          const title = name.trim().slice(0, 80);
          if (!title) return;
          const id = crypto.randomUUID();
          set(s => ({ spaces: { ...s.spaces, [id]: { id, name: title } }, activeSpaceId: id }));
        },
        renameSpace: (id, name) => {
          const title = name.trim().slice(0, 80);
          if (!title || !get().spaces[id]) return;
          set(s => ({ spaces: { ...s.spaces, [id]: { id, name: title } } }));
        },
        deleteSpace: (id) => set(s => ({ ...withoutSpace(s.spaces, s.conversationSpaces, id), activeSpaceId: s.activeSpaceId === id ? null : s.activeSpaceId })),
        setActiveSpace: (id) => { if (id === null || Object.hasOwn(get().spaces, id)) set({ activeSpaceId: id }); },
        moveConversation: (conversationId, spaceId) => {
          if (spaceId !== null && !Object.hasOwn(get().spaces, spaceId)) return;
          set(s => {
            const conversationSpaces = { ...s.conversationSpaces };
            if (spaceId) conversationSpaces[conversationId] = spaceId;
            else delete conversationSpaces[conversationId];
            return { conversationSpaces, activeSpaceId: spaceId };
          });
        },

        // ---- Settings ----
        saveConnection: (config, key) => {
          const connection = modelConnection(config);
          const apiKey = key.trim();
          set(s => ({ ...connection, apiKey,
            conversationModels: Object.keys(s.messages).length && !s.conversationModels[s.activeConversationId]
              ? { ...s.conversationModels, [s.activeConversationId]: modelConnection(s) } : s.conversationModels,
            connectionCredentials: { ...s.connectionCredentials, [connectionKey(connection)]: apiKey },
            providerConnections: { ...s.providerConnections, [connection.provider]: connection } }));
        },

        // ---- Actions ----

        sendMessage: async (
          branchId: BranchId,
          userContent: string,
          quote?: MessageQuote,
        ): Promise<SendResult> => {
          const branch = get().branches[branchId];
          if (!branch) return 'error';
          if (branch.status === 'streaming') return 'busy';

          const text = userContent.trim();
          if (!text) return 'error';

          // Bind once for the whole conversation, including every child branch.
          if (!get().conversationModels[get().activeConversationId]) {
            set(s => ({ conversationModels: { ...s.conversationModels, [s.activeConversationId]: modelConnection(s) } }));
          }

          appendMessage(branchId, 'user', text, quote ? { quote } : {});
          patchBranch(branchId, { status: 'streaming' });
          recompute();

          return streamAssistantReply(branchId);
        },

        askFromSelection: ({
          messageId,
          slice,
          intent,
          targetBranchId,
          branchLabel,
          question,
        }) => {
          const s = get();
          const sourceMsg = s.messages[messageId];
          const text = question.trim();
          if (!sourceMsg || !text) return null;

          const anchorId = createAnchorId();
          let branchId: BranchId;
          let newBranch: Record<string, Branch> = {};

          switch (intent) {
            case 'main':
              branchId = s.rootBranchId;
              break;
            case 'existing-branch':
              if (!targetBranchId || !s.branches[targetBranchId]) return null;
              branchId = targetBranchId;
              break;
            case 'new-branch':
            default: {
              branchId = createBranchId();
              const preview = slice.selectedText.slice(0, 20);
              newBranch = {
                [branchId]: {
                  id: branchId,
                  label: branchLabel?.trim().slice(0, 120) || `分支 · ${preview}${slice.selectedText.length > 20 ? '…' : ''}`,
                  sourceAnchorId: anchorId,
                  sourceMessageId: messageId,
                  messageIds: [],
                  status: 'idle',
                },
              };
              break;
            }
          }

          // The target is still answering something else — don't interleave
          if (s.branches[branchId]?.status === 'streaming') return null;

          set((st) => ({
            anchors: {
              ...st.anchors,
              [anchorId]: {
                id: anchorId,
                messageId,
                slice,
                branchId,
                intent: intent as AnchorIntent,
                color: colorForIntent(intent),
                status: 'streaming',
              },
            },
            branches: { ...st.branches, ...newBranch },
            messages: {
              ...st.messages,
              [messageId]: {
                ...st.messages[messageId],
                anchorIds: [...st.messages[messageId].anchorIds, anchorId],
              },
            },
          }));

          const quote: MessageQuote = {
            raw: sourceMsg.content.slice(slice.startOffset, slice.endOffset),
            display: slice.selectedText,
            sourceMessageId: messageId,
          };

          const epoch = generationEpoch;
          void get()
            .sendMessage(branchId, text, quote)
            .then((result) => {
              if (epoch !== generationEpoch) return;
              patchAnchor(anchorId, {
                status: result === 'ok' ? 'done' : 'error',
              });
              recompute(true);
            });

          return branchId;
        },

        focusAnchor: (anchorId: AnchorId | null) => {
          if (focusTimer) {
            clearTimeout(focusTimer);
            focusTimer = null;
          }

          set((s) => {
            if (!anchorId) {
              return { ui: { ...s.ui, focusedAnchorId: null } };
            }
            const anchor = s.anchors[anchorId];
            if (!anchor) return s;

            return {
              ui: {
                ...s.ui,
                focusedAnchorId: anchorId,
                messageReveal: undefined,
                // Jump to the branch this highlight leads to
                activeBranchPanelId:
                  anchor.branchId !== s.rootBranchId
                    ? anchor.branchId
                    : s.ui.activeBranchPanelId,
              },
            };
          });

          if (anchorId) {
            focusTimer = setTimeout(() => {
              focusTimer = null;
              set((s) =>
                s.ui.focusedAnchorId === anchorId
                  ? { ui: { ...s.ui, focusedAnchorId: null } }
                  : s,
              );
            }, FOCUS_GLOW_MS);
          }
        },

        setPendingSelection: (sel: UIState['pendingSelection']) => {
          set((s) => ({
            ui: { ...s.ui, pendingSelection: sel },
          }));
        },

        publishToBlackboard: (
          branchId: BranchId,
          summary: string,
          keyFacts: string[] = [],
          sourceMessageId?: MessageId,
        ) => {
          set((s) => ({
            blackboard: {
              ...s.blackboard,
              [branchId]: {
                branchId,
                summary,
                keyFacts,
                sourceMessageId,
                updatedAt: Date.now(),
              },
            },
          }));
        },

        recomputeCanvas: () => {
          recompute(true);
        },

        revealMessage: (messageId) => {
          set((s) => {
            const message = s.messages[messageId];
            if (!message || !s.branches[message.branchId]?.messageIds.includes(messageId)) return s;
            return { ui: { ...s.ui, viewMode: 'linear', pendingSelection: null,
              activeBranchPanelId: message.branchId === s.rootBranchId ? null : message.branchId,
              messageReveal: { messageId, request: (s.ui.messageReveal?.request ?? 0) + 1 } } };
          });
        },

        stopGeneration: () => {
          abortAll();
          set(settledConversation(get()));
          recompute(true);
        },
        switchConversation: (id) => {
          if (id === get().activeConversationId || !get().conversations[id]) return;
          abortAll();
          const s = get();
          const saved = snapshotConversation(s, s.activeConversationId);
          const next = settledConversation(s.conversations[id]);
          set({ ...next, activeConversationId: id,
            activeSpaceId: s.conversationSpaces[id] || null,
            conversations: { ...s.conversations, [saved.id]: saved },
            ui: { ...emptyState.ui }, canvas: { nodes: [], edges: [] } });
        },
        deleteConversation: (id) => {
          if (id === get().activeConversationId) abortAll();
          const conversations = { ...get().conversations };
          delete conversations[id];
          const conversationSpaces = { ...get().conversationSpaces };
          delete conversationSpaces[id];
          const conversationModels = { ...get().conversationModels };
          delete conversationModels[id];
          const branchPositions = { ...get().branchPositions };
          delete branchPositions[id];
          const nextId = crypto.randomUUID();
          if (id === get().activeConversationId && get().activeSpaceId) conversationSpaces[nextId] = get().activeSpaceId!;
          set(id === get().activeConversationId
            ? { ...emptyState, activeConversationId: nextId, conversations, conversationSpaces, conversationModels, branchPositions }
            : { conversations, conversationSpaces, conversationModels, branchPositions });
        },
        resetToEmpty: () => {
          abortAll();
          const s = get();
          const saved = snapshotConversation(s, s.activeConversationId);
          const id = crypto.randomUUID();
          const conversationSpaces = { ...s.conversationSpaces };
          if (!Object.keys(saved.messages).length) delete conversationSpaces[s.activeConversationId];
          if (s.activeSpaceId) conversationSpaces[id] = s.activeSpaceId;
          set({ ...emptyState, activeConversationId: id,
            conversationSpaces,
            conversations: Object.keys(saved.messages).length ? { ...s.conversations, [saved.id]: saved } : s.conversations });
        },
        resetToMock: () => {
          get().resetToEmpty();
          set(s => ({ ...mockState, conversationModels: { ...s.conversationModels, [s.activeConversationId]: modelConnection(s) } }));
        },

        setViewMode: (mode: 'linear' | 'canvas') => {
          set((s) => ({ ui: { ...s.ui, viewMode: mode, messageReveal: undefined } }));
          if (mode === 'canvas') recompute(true);
        },

        renameBranch: (id, name) => {
          const label = name.trim().slice(0, 120);
          if (!label || !get().branches[id]) return;
          patchBranch(id, { label }); recompute(true);
        },
        setCanvasMode: (canvasMode) => {
          set(s => ({ ui: { ...s.ui, canvasMode }, canvas: { nodes: [], edges: [] } }));
          recompute(true);
        },
        updateCanvasNodes: (changes) => {
          if (get().ui.canvasMode !== 'branches') return;
          set(s => {
            const accepted = changes.filter(change => change.type === 'dimensions' || change.type === 'select' ||
              (change.type === 'position' && (!change.position || validCanvasPoint(change.position))));
            const points = { ...s.branchPositions[s.activeConversationId] };
            let activeBranchPanelId = s.ui.activeBranchPanelId;
            for (const change of accepted) if (change.type === 'position' && change.position && s.branches[change.id]) points[change.id] = change.position;
            for (const change of accepted) if (change.type === 'select' && change.selected && s.branches[change.id]) activeBranchPanelId = change.id === s.rootBranchId ? null : change.id as BranchId;
            return { canvas: { ...s.canvas, nodes: applyNodeChanges(accepted, s.canvas.nodes) },
              branchPositions: { ...s.branchPositions, [s.activeConversationId]: points }, ui: { ...s.ui, activeBranchPanelId } };
          });
        },
        arrangeBranchCanvas: () => {
          const s = get();
          const { nodes, edges, positions } = branchCanvas(s);
          set({ canvas: { nodes, edges }, branchPositions: { ...s.branchPositions, [s.activeConversationId]: positions } });
        },

        setActiveBranchPanel: (branchId: BranchId | null) => {
          set((s) => ({ ui: { ...s.ui, activeBranchPanelId: branchId, messageReveal: undefined } }));
        },
      };
    },
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createPersistStorage(),
      // Hydrate on the client after first render (see useStoreHydrated) so
      // the server-rendered HTML and the first client render match.
      skipHydration: true,
      partialize: (state) => ({
        messages: state.messages,
        anchors: state.anchors,
        branches: state.branches,
        blackboard: state.blackboard,
        rootBranchId: state.rootBranchId,
        apiKey: state.apiKey,
        provider: state.provider,
        baseUrl: state.baseUrl,
        model: state.model,
        conversations: state.conversations,
        activeConversationId: state.activeConversationId,
        spaces: state.spaces,
        conversationSpaces: state.conversationSpaces,
        activeSpaceId: state.activeSpaceId,
        conversationModels: state.conversationModels,
        connectionCredentials: state.connectionCredentials,
        providerConnections: state.providerConnections,
        branchPositions: state.branchPositions,
      }),
      merge: (persisted, current) => ({
        ...current,
        ...sanitizePersisted((persisted ?? {}) as Partial<PersistedSlice>),
      }),
    },
  ),
);
