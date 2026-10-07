'use client';

import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { useShallow } from 'zustand/react/shallow';
import { useChatStore } from '../store';
import {
  rehypeSourceMarks,
  type AnchorRange,
} from '../lib/rehype-source-marks';
import type { MessageId, Anchor, AnchorId } from '../types';

const REMARK_PLUGINS = [remarkGfm, remarkMath];

/**
 * Renders an assistant message's Markdown (GFM tables, KaTeX math) and
 * paints anchor highlights on top of it. Raw HTML in the model output is
 * NOT interpreted — it is shown as plain text.
 */
export function MarkdownRenderer({
  content,
  messageId,
}: {
  content: string;
  messageId: MessageId;
}) {
  const anchors = useChatStore(
    useShallow((s) => {
      const ids = s.messages[messageId]?.anchorIds;
      if (!ids || ids.length === 0) return [] as Anchor[];
      return ids.map((id: AnchorId) => s.anchors[id]).filter(Boolean);
    }),
  );

  const focusedAnchorId = useChatStore((s) => s.ui.focusedAnchorId);
  const focusAnchor = useChatStore((s) => s.focusAnchor);

  const rehypePlugins = useMemo(() => {
    const ranges: AnchorRange[] = anchors
      .filter((a) => a.slice.endOffset <= content.length)
      .map((a) => ({
        id: a.id,
        start: a.slice.startOffset,
        end: a.slice.endOffset,
        color: a.color,
      }));
    return [[rehypeSourceMarks, { anchors: ranges }], rehypeKatex] as never;
  }, [anchors, content.length]);

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={rehypePlugins}
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
                className="transition-all duration-200 cursor-pointer rounded-sm px-0.5 text-inherit"
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
        {content}
      </ReactMarkdown>
    </div>
  );
}
