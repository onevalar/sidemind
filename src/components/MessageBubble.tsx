'use client';

import type { Message } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { useChatStore } from '../store';

export function MessageBubble({ message }: { message: Message }) {
  const anchorCount = useChatStore(
    (s) => s.messages[message.id]?.anchorIds.length ?? 0,
  );

  const isUser = message.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      <div
        className={`relative max-w-[85%] rounded-2xl px-5 py-4 ${
          isUser
            ? 'bg-indigo-600/80 text-white'
            : 'bg-zinc-800/80 border border-zinc-700/50 text-zinc-100'
        }`}
        // These data attributes are read by the text selection hook
        data-message-id={message.id}
        data-raw-md={message.content}
        data-role={message.role}
      >
        {isUser ? (
          <p className="text-sm leading-relaxed whitespace-pre-wrap">
            {message.content}
          </p>
        ) : (
          <MarkdownRenderer content={message.content} messageId={message.id} />
        )}

        {/* Anchor count badge */}
        {anchorCount > 0 && (
          <div className="absolute -top-2 -right-2 bg-indigo-500 text-white text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center shadow-lg">
            {anchorCount}
          </div>
        )}
      </div>
    </div>
  );
}
