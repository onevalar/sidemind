import type { ConversationData, ConversationSnapshot } from './types';

/** Stop transient generation states before archiving or restoring a conversation. */
export function settledConversation(data: ConversationData): ConversationData {
  const streaming = new Set(Object.values(data.branches).filter(b => b.status === 'streaming' || b.status === 'queued').map(b => b.id));
  return {
    rootBranchId: data.rootBranchId,
    blackboard: data.blackboard,
    messages: Object.fromEntries(Object.entries(data.messages).map(([id, m]) => [
      id, m.role === 'assistant' && streaming.has(m.branchId) && !m.error
        ? { ...m, error: '生成已停止，可以继续提问。' } : m,
    ])),
    branches: Object.fromEntries(Object.entries(data.branches).map(([id, b]) => [
      id, streaming.has(b.id) ? { ...b, status: 'done' as const } : b,
    ])),
    anchors: Object.fromEntries(Object.entries(data.anchors).map(([id, a]) => [
      id, a.status === 'streaming' ? { ...a, status: 'error' as const } : a,
    ])),
  };
}

export function snapshotConversation(data: ConversationData, id: string): ConversationSnapshot {
  const first = data.branches[data.rootBranchId]?.messageIds.map(mid => data.messages[mid]).find(m => m?.role === 'user');
  return {
    ...settledConversation(data), id,
    title: first?.content.trim().replace(/\s+/g, ' ').slice(0, 48) || '新对话',
    updatedAt: Object.values(data.messages).reduce((latest, m) => Math.max(latest, m.createdAt), 0),
  };
}
