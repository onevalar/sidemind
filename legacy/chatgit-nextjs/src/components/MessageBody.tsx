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
          <div className="message-quote">
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
          className="error-note"
        >
          {message.error}
        </div>
      )}
    </>
  );
}
