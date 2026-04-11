'use client';

import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import { useShallow } from 'zustand/react/shallow';
import { useChatStore } from '../store';
import type { MessageId, Anchor, AnchorId } from '../types';

export function MarkdownRenderer({
  content,
  messageId,
}: {
  content: string;
  messageId: MessageId;
}) {
  const anchorIds = useChatStore(
    (s) => s.messages[messageId]?.anchorIds,
  );
  const anchors = useChatStore(
    useShallow((s) => {
      const ids = s.messages[messageId]?.anchorIds;
      if (!ids || ids.length === 0) return [] as Anchor[];
      return ids
        .map((id: AnchorId) => s.anchors[id])
        .filter(Boolean)
        .sort((a: Anchor, b: Anchor) => a.slice.startOffset - b.slice.startOffset);
    }),
  );

  const focusedAnchorId = useChatStore((s) => s.ui.focusedAnchorId);
  const focusAnchor = useChatStore((s) => s.focusAnchor);

  const processedContent = useMemo(
    () => injectAnchorMarks(content, anchors),
    [content, anchors],
  );

  return (
    <div className="markdown-body prose prose-invert prose-sm max-w-none">
      <ReactMarkdown
        rehypePlugins={[rehypeRaw]}
        components={{
          mark: ({ children, ...props }) => {
            const anchorId = (props as Record<string, string>)[
              'data-anchor-id'
            ];
            const anchor = anchors.find((a) => a.id === anchorId);
            const isFocused = focusedAnchorId === anchorId;
            return (
              <mark
                data-anchor-id={anchorId}
                onClick={(e) => {
                  e.stopPropagation();
                  if (anchorId) {
                    focusAnchor(anchorId as AnchorId);
                  }
                }}
                className="transition-all duration-200 cursor-pointer rounded-sm px-0.5"
                style={{
                  backgroundColor: anchor
                    ? `${anchor.color}${isFocused ? '55' : '25'}`
                    : undefined,
                  borderBottom: anchor
                    ? `2px solid ${anchor.color}`
                    : undefined,
                  boxShadow: isFocused
                    ? `0 0 8px ${anchor?.color}44`
                    : undefined,
                }}
              >
                {children}
              </mark>
            );
          },
        }}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );
}

function injectAnchorMarks(content: string, anchors: Anchor[]): string {
  if (anchors.length === 0) return content;

  const sorted = [...anchors].sort(
    (a, b) => b.slice.startOffset - a.slice.startOffset,
  );

  let result = content;
  for (const anchor of sorted) {
    const { startOffset, endOffset } = anchor.slice;
    if (startOffset >= result.length || endOffset > result.length) continue;

    const before = result.slice(0, startOffset);
    const selected = result.slice(startOffset, endOffset);
    const after = result.slice(endOffset);

    result = `${before}<mark data-anchor-id="${anchor.id}">${selected}</mark>${after}`;
  }

  return result;
}
