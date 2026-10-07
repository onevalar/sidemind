'use client';

import type { Message } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';

/**
 * Shared body of a message bubble (used by the linear view, the branch
 * panel and the canvas cards):
 *  - user message: optional "quoted passage" strip + plain text
 *  - assistant message: Markdown + optional red error note
 */
export function MessageBody({ message }: { message: Message }) {
  if (message.role === 'user') {
    return (
      <>
        {message.quote && (
          <div className="mb-2 border-l-2 border-white/40 pl-2 text-xs leading-4 text-white/70 line-clamp-3">
            {message.quote.display}
          </div>
        )}
        <p className="text-sm leading-[22px] whitespace-pre-wrap">
          {message.content}
        </p>
      </>
    );
  }

  return (
    <>
      {message.content && (
        <MarkdownRenderer content={message.content} messageId={message.id} />
      )}
      {message.error && (
        <div
          className={`rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs leading-4 text-red-300 ${
            message.content ? 'mt-3' : ''
          }`}
        >
          ⚠️ {message.error}
        </div>
      )}
    </>
  );
}
