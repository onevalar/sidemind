'use client';

import { useChatStore } from '../store';
import { MessageBubble } from './MessageBubble';
import { AnchorSidebar } from './AnchorSidebar';

export function ChatFlow() {
  const rootBranchId = useChatStore((s) => s.rootBranchId);
  const messageIds = useChatStore(
    (s) => s.branches[s.rootBranchId]?.messageIds ?? [],
  );
  const messages = useChatStore((s) => s.messages);

  return (
    <div className="flex h-screen">
      {/* Main conversation column */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-8">
          {/* Header */}
          <div className="mb-8 pb-4 border-b border-zinc-800">
            <h1 className="text-lg font-semibold text-zinc-100">ChatGit</h1>
            <p className="text-xs text-zinc-500 mt-1">
              划选 AI 回答中的文本即可创建分支对话
            </p>
          </div>

          {/* Messages */}
          {messageIds.map((id) => {
            const msg = messages[id];
            if (!msg) return null;
            return <MessageBubble key={id} message={msg} />;
          })}
        </div>
      </div>

      {/* Right sidebar for anchor list */}
      <AnchorSidebar />
    </div>
  );
}
