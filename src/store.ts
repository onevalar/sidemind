import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type {
  ChatStore,
  BranchId,
  MessageRole,
  MessageId,
  TextSlice,
  AnchorId,
  AnchorIntent,
  UIState,
  Message,
} from './types';
import { createMessageId, createAnchorId, createBranchId } from './lib/id';
import { colorForIntent } from './lib/colors';
import { mockState, emptyState } from './lib/mock';
import { deriveCanvasElements } from './lib/canvas-adapter';

export const useChatStore = create<ChatStore>()(
  persist(
    (set, get) => {
      /** Recompute canvas arrays from current state */
      function recompute() {
        const s = get();
        const { nodes, edges } = deriveCanvasElements(s);
        set({
          canvas: {
            nodes,
            edges,
            version: s.canvas.version + 1,
          },
        });
      }

      /** Core streaming helper */
      async function streamAssistantReply(
        branchId: BranchId,
        apiMessages: Array<{ role: 'user' | 'assistant'; content: string }>,
      ): Promise<MessageId> {
        const assistantMsgId = createMessageId();
        const branch = get().branches[branchId];
        const parentId =
          branch.messageIds.length > 0
            ? (branch.messageIds[branch.messageIds.length - 1] as MessageId)
            : null;

        const assistantMsg: Message = {
          id: assistantMsgId,
          role: 'assistant',
          content: '',
          parentId,
          branchId,
          anchorIds: [],
          createdAt: Date.now(),
        };

        set((s) => ({
          messages: { ...s.messages, [assistantMsgId]: assistantMsg },
          branches: {
            ...s.branches,
            [branchId]: {
              ...s.branches[branchId],
              messageIds: [...s.branches[branchId].messageIds, assistantMsgId],
              status: 'streaming',
            },
          },
        }));
        recompute();

        try {
          const { apiKey, provider, baseUrl } = get();
          if (!apiKey) throw new Error('未配置 API Key，请点击右上角⚙️设置');

          const response = await fetch('/api/chat', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'x-provider': provider,
              ...(baseUrl ? { 'x-base-url': baseUrl } : {}),
            },
            body: JSON.stringify({ messages: apiMessages }),
          });

          if (!response.ok || !response.body) {
            const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
            throw new Error(err.error ?? `HTTP ${response.status}`);
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let accumulated = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            for (const line of chunk.split('\n')) {
              if (!line.startsWith('data: ')) continue;
              const raw = line.slice(6).trim();
              if (raw === '[DONE]') break;
              try {
                const parsed = JSON.parse(raw) as { text?: string; error?: string };
                if (parsed.error) throw new Error(parsed.error);
                if (parsed.text) {
                  accumulated += parsed.text;
                  set((s) => ({
                    messages: {
                      ...s.messages,
                      [assistantMsgId]: {
                        ...s.messages[assistantMsgId],
                        content: accumulated,
                      },
                    },
                  }));
                  recompute();
                }
              } catch {
                // ignore parse errors on individual chunks
              }
            }
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Request failed';
          set((s) => ({
            messages: {
              ...s.messages,
              [assistantMsgId]: {
                ...s.messages[assistantMsgId],
                content: `> ⚠️ ${errorMsg}`,
              },
            },
          }));
          recompute();
        }

        set((s) => ({
          branches: {
            ...s.branches,
            [branchId]: { ...s.branches[branchId], status: 'done' },
          },
        }));
        recompute();

        return assistantMsgId;
      }

      return {
        // ---- Initial state ----
        ...emptyState,
        apiKey: '',
        provider: 'zhipu' as const,
        baseUrl: '',

        // ---- Settings ----
        setApiKey: (key: string) => set({ apiKey: key.trim() }),
        setProvider: (provider) => set({ provider }),
        setBaseUrl: (url: string) => set({ baseUrl: url.trim() }),

        // ---- Actions ----

        addMessage: (branchId: BranchId, role: MessageRole, content: string) => {
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

          recompute();
          return id;
        },

        createAnchor: (
          messageId: MessageId,
          slice: TextSlice,
          intent: AnchorIntent,
          targetBranchId?: BranchId,
        ) => {
          const anchorId = createAnchorId();
          const color = colorForIntent(intent);

          let branchId: BranchId;
          let newBranch: Record<string, (typeof get extends () => infer S ? S : never)['branches'][string]> = {};

          switch (intent) {
            case 'main':
              branchId = get().rootBranchId;
              break;
            case 'existing-branch':
              branchId = targetBranchId!;
              break;
            case 'new-branch':
            default:
              branchId = createBranchId();
              newBranch = {
                [branchId]: {
                  id: branchId,
                  label: `分支 · ${slice.selectedText.slice(0, 20)}…`,
                  sourceAnchorId: anchorId,
                  sourceMessageId: messageId,
                  messageIds: [],
                  status: 'idle',
                },
              };
              break;
          }

          set((s) => ({
            anchors: {
              ...s.anchors,
              [anchorId]: {
                id: anchorId,
                messageId,
                slice,
                branchId,
                intent,
                color,
                status: 'pending',
                pendingInput: '',
              },
            },
            branches: {
              ...s.branches,
              ...newBranch,
            },
            messages: {
              ...s.messages,
              [messageId]: {
                ...s.messages[messageId],
                anchorIds: [...s.messages[messageId].anchorIds, anchorId],
              },
            },
          }));

          recompute();
          return anchorId;
        },

        updateAnchorInput: (anchorId: AnchorId, text: string) => {
          set((s) => ({
            anchors: {
              ...s.anchors,
              [anchorId]: {
                ...s.anchors[anchorId],
                pendingInput: text,
                status: text.trim() ? 'queued' : 'pending',
              },
            },
          }));
          recompute();
        },

        submitQueuedAnchors: () => {
          const { anchors } = get();
          const queued = Object.values(anchors).filter((a) => a.status === 'queued');
          if (queued.length === 0) return;

          for (const anchor of queued) {
            set((s) => ({
              anchors: {
                ...s.anchors,
                [anchor.id]: { ...s.anchors[anchor.id], status: 'streaming' },
              },
            }));

            const targetBranchId = anchor.branchId;
            const userContent = anchor.pendingInput;

            const userMsgId = createMessageId();
            const branch = get().branches[targetBranchId];
            const parentId =
              branch.messageIds.length > 0
                ? (branch.messageIds[branch.messageIds.length - 1] as MessageId)
                : null;

            set((s) => ({
              messages: {
                ...s.messages,
                [userMsgId]: {
                  id: userMsgId,
                  role: 'user',
                  content: userContent,
                  parentId,
                  branchId: targetBranchId,
                  anchorIds: [],
                  createdAt: Date.now(),
                },
              },
              branches: {
                ...s.branches,
                [targetBranchId]: {
                  ...s.branches[targetBranchId],
                  messageIds: [...s.branches[targetBranchId].messageIds, userMsgId],
                },
              },
            }));
            recompute();

            const apiMessages = get()
              .branches[targetBranchId].messageIds.map((id) => get().messages[id])
              .filter(Boolean)
              .filter((m) => m.role !== 'system')
              .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

            streamAssistantReply(targetBranchId, apiMessages).then(() => {
              set((s) => ({
                anchors: {
                  ...s.anchors,
                  [anchor.id]: { ...s.anchors[anchor.id], status: 'done' },
                },
              }));
              recompute();
            });
          }
        },

        focusAnchor: (anchorId: AnchorId | null) => {
          set((s) => {
            if (!anchorId) {
              return { ui: { ...s.ui, focusedAnchorId: null } };
            }
            const anchor = s.anchors[anchorId];
            if (!anchor) return s;

            const activeBranchIds = s.ui.activeBranchIds.includes(anchor.branchId)
              ? s.ui.activeBranchIds
              : [...s.ui.activeBranchIds, anchor.branchId];

            return {
              ui: {
                ...s.ui,
                focusedAnchorId: anchorId,
                activeBranchIds,
              },
            };
          });
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
        ) => {
          set((s) => ({
            blackboard: {
              ...s.blackboard,
              [branchId]: {
                branchId,
                summary,
                keyFacts,
                updatedAt: Date.now(),
              },
            },
          }));
        },

        getBlackboardContext: () => {
          const entries = Object.values(get().blackboard);
          if (entries.length === 0) return '';
          return entries
            .map(
              (e) =>
                `[Branch Summary] ${e.summary}\nKey facts: ${e.keyFacts.join('; ')}`,
            )
            .join('\n\n');
        },

        recomputeCanvas: () => {
          recompute();
        },

        resetToEmpty: () => {
          set(emptyState);
          recompute();
        },
        resetToMock: () => {
          set(mockState);
          recompute();
        },

        sendMessage: async (branchId: BranchId, userContent: string) => {
          const userMsgId = createMessageId();
          const branch = get().branches[branchId];
          const parentId =
            branch.messageIds.length > 0
              ? (branch.messageIds[branch.messageIds.length - 1] as MessageId)
              : null;

          set((s) => ({
            messages: {
              ...s.messages,
              [userMsgId]: {
                id: userMsgId,
                role: 'user',
                content: userContent,
                parentId,
                branchId,
                anchorIds: [],
                createdAt: Date.now(),
              },
            },
            branches: {
              ...s.branches,
              [branchId]: {
                ...s.branches[branchId],
                messageIds: [...s.branches[branchId].messageIds, userMsgId],
              },
            },
          }));
          recompute();

          const apiMessages = get()
            .branches[branchId].messageIds.map((id) => get().messages[id])
            .filter(Boolean)
            .filter((m) => m.role !== 'system')
            .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

          await streamAssistantReply(branchId, apiMessages);
        },

        setViewMode: (mode: 'linear' | 'canvas') => {
          set((s) => ({ ui: { ...s.ui, viewMode: mode } }));
          if (mode === 'canvas') recompute();
        },

        setActiveBranchPanel: (branchId: BranchId | null) => {
          set((s) => ({ ui: { ...s.ui, activeBranchPanelId: branchId } }));
        },
      };
    },
    {
      name: 'chatgit-settings',
      storage: createJSONStorage(() => localStorage),
      // Only persist settings — conversation state resets on refresh
      partialize: (state) => ({
        apiKey: state.apiKey,
        provider: state.provider,
        baseUrl: state.baseUrl,
      }),
    },
  ),
);

// Bootstrap: run initial canvas derivation after store is created
useChatStore.getState().recomputeCanvas();
