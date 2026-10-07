'use client';

import { useMemo } from 'react';
import { useChatStore } from '../store';
import type { MessageId } from '../types';

interface OutlineEntry {
  messageId: MessageId;
  level: 2 | 3;
  text: string;
}

/**
 * Extracts headings from assistant messages and renders a clickable TOC.
 * Clicking an entry scrolls the LinearChatView to that message.
 */
export function ContentOutline() {
  const rootBranchId = useChatStore((s) => s.rootBranchId);
  const messageIds = useChatStore(
    (s) => s.branches[s.rootBranchId]?.messageIds ?? [],
  );
  const messages = useChatStore((s) => s.messages);

  // Also show saved branches as navigation entries
  const branches = useChatStore((s) => s.branches);
  const setActiveBranchPanel = useChatStore((s) => s.setActiveBranchPanel);

  const childBranches = useMemo(
    () =>
      Object.values(branches).filter(
        (b) => b.id !== rootBranchId && b.messageIds.length > 0,
      ),
    [branches, rootBranchId],
  );

  const outline = useMemo(() => {
    const entries: OutlineEntry[] = [];
    for (const id of messageIds) {
      const msg = messages[id];
      if (!msg || msg.role !== 'assistant') continue;

      let inFence = false;
      for (const line of msg.content.split('\n')) {
        // Lines inside ``` blocks (e.g. "## comment") are not headings
        if (line.trimStart().startsWith('```')) {
          inFence = !inFence;
          continue;
        }
        if (inFence) continue;

        const m = /^(#{1,3})\s+(.+)$/.exec(line);
        if (!m) continue;
        entries.push({
          messageId: msg.id,
          level: m[1].length === 3 ? 3 : 2,
          text: m[2].trim(),
        });
      }
    }
    return entries;
  }, [messageIds, messages]);

  const scrollToMessage = (msgId: MessageId) => {
    const el = document.getElementById(`msg-${msgId}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  if (outline.length === 0 && childBranches.length === 0) {
    return (
      <div className="p-4">
        <p className="text-xs text-zinc-600 italic">
          对话内容的标题将显示在这里
        </p>
      </div>
    );
  }

  return (
    <div className="p-4">
      {/* Content outline */}
      {outline.length > 0 && (
        <>
          <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-3">
            内容目录
          </h3>
          <div className="space-y-0.5 mb-5">
            {outline.map((entry, i) => (
              <button
                key={`${entry.messageId}-${i}`}
                onClick={() => scrollToMessage(entry.messageId)}
                className={`w-full text-left py-1.5 rounded-md hover:bg-zinc-800/60 transition-colors text-xs text-zinc-400 hover:text-zinc-200 truncate ${
                  entry.level === 3 ? 'pl-6 pr-2' : 'pl-3 pr-2 font-medium'
                }`}
              >
                {entry.text}
              </button>
            ))}
          </div>
        </>
      )}

      {/* Branch list */}
      {childBranches.length > 0 && (
        <>
          <h3 className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-3">
            分支对话 ({childBranches.length})
          </h3>
          <div className="space-y-1.5">
            {childBranches.map((branch) => (
              <button
                key={branch.id}
                onClick={() => setActiveBranchPanel(branch.id)}
                className="w-full text-left p-2.5 rounded-lg border border-zinc-800 bg-zinc-800/30 hover:bg-zinc-800/60 transition-colors"
              >
                <p className="text-xs text-zinc-300 font-medium truncate">
                  {branch.label}
                </p>
                <p className="text-[10px] text-zinc-600 mt-0.5">
                  {branch.messageIds.length} 条消息
                </p>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
