'use client';

import { useEffect, useRef } from 'react';
import { useChatStore } from '../store';
import { MarkdownRenderer } from './MarkdownRenderer';

/**
 * Standard linear chat view — messages scroll vertically like a normal chat app.
 * Text selection on assistant messages triggers the global useTextSelection hook.
 */
export function LinearChatView() {
  const rootBranchId = useChatStore((s) => s.rootBranchId);
  const messageIds = useChatStore(
    (s) => s.branches[s.rootBranchId]?.messageIds ?? [],
  );
  const messages = useChatStore((s) => s.messages);
  const rootStatus = useChatStore(
    (s) => s.branches[s.rootBranchId]?.status,
  );
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messageIds.length]);

  if (messageIds.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="text-5xl mb-4">💬</div>
          <h2 className="text-lg font-medium text-zinc-400 mb-1">开始新对话</h2>
          <p className="text-sm text-zinc-600">
            在下方输入框发送消息，AI 回复后划选文本即可创建分支
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8 pb-32">
        {messageIds.map((id) => {
          const msg = messages[id];
          if (!msg) return null;
          const isUser = msg.role === 'user';

          return (
            <div
              key={id}
              id={`msg-${id}`}
              className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-5`}
            >
              <div
                className={`relative rounded-2xl px-5 py-4 ${
                  isUser
                    ? 'max-w-[75%] bg-indigo-600/80 text-white'
                    : 'max-w-[85%] bg-zinc-800/80 border border-zinc-700/50 text-zinc-100'
                }`}
                data-message-id={msg.id}
                data-raw-md={msg.content}
                data-role={msg.role}
              >
                {isUser ? (
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">
                    {msg.content}
                  </p>
                ) : (
                  <MarkdownRenderer
                    content={msg.content}
                    messageId={msg.id}
                  />
                )}
              </div>
            </div>
          );
        })}

        {/* Streaming indicator */}
        {rootStatus === 'streaming' && (
          <div className="flex justify-start mb-5">
            <div className="bg-zinc-800/80 border border-zinc-700/50 rounded-2xl px-5 py-4">
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-pulse" />
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-pulse [animation-delay:0.2s]" />
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-pulse [animation-delay:0.4s]" />
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}
