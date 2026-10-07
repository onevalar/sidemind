'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { MessageNodeData } from '../../lib/canvas-adapter';
import { MessageBody } from '../MessageBody';
import {
  BUBBLE_PAD_X,
  BUBBLE_PAD_Y,
  BRANCH_LABEL_HEIGHT,
} from '../../lib/typography';

/**
 * Custom React Flow node for rendering a single message bubble.
 *
 * - User messages: compact indigo card
 * - Assistant messages: dark card with Markdown rendering + anchor Handles
 *
 * The data-message-id / data-role attributes are preserved
 * so the global useTextSelection hook can detect selections inside
 * the canvas node — even through React Flow's CSS transforms.
 */
function MessageNodeInner({ data }: NodeProps) {
  const {
    message,
    anchors,
    branch,
    isFirstInBranch,
    measuredWidth,
    measuredHeight,
  } = data as MessageNodeData;

  const isUser = message.role === 'user';
  const isRoot = branch.sourceAnchorId === null;

  return (
    <>
      {/* ── Target Handle (left side — receives incoming edges) ── */}
      <Handle
        type="target"
        position={Position.Left}
        className="!w-2 !h-2 !bg-zinc-600 !border-zinc-500"
        style={{ opacity: isFirstInBranch && !isRoot ? 1 : 0 }}
      />

      {/* ── Card body ── */}
      <div
        className={`nopan nodrag nowheel rounded-xl border overflow-hidden ${
          isUser
            ? 'bg-indigo-600/70 border-indigo-500/30'
            : 'bg-zinc-900/90 border-zinc-700/50 select-text'
        }`}
        style={{
          width: measuredWidth,
          height: measuredHeight,
          padding: `${BUBBLE_PAD_Y}px ${BUBBLE_PAD_X}px`,
          cursor: isUser ? 'default' : 'text',
        }}
        data-message-id={message.id}
        data-role={message.role}
      >
        {/* Branch label badge (first message only) */}
        {isFirstInBranch && (
          <div
            className={`text-[10px] font-medium uppercase tracking-wider mb-2 ${
              isRoot ? 'text-zinc-500' : 'text-indigo-400'
            }`}
          >
            {branch.label}
          </div>
        )}

        {/* Content */}
        <div
          className="overflow-y-auto"
          style={{
            maxHeight:
              measuredHeight - BUBBLE_PAD_Y * 2 - (isFirstInBranch ? BRANCH_LABEL_HEIGHT : 0),
          }}
        >
          <MessageBody message={message} />
        </div>
      </div>

      {/* ── Default source Handle (right edge center) ── */}
      <Handle
        type="source"
        position={Position.Right}
        id="default"
        className="!w-2 !h-2 !bg-zinc-600 !border-zinc-500"
        style={{ opacity: 0 }}
      />

      {/* ── Per-anchor source Handles (positioned at approximate Y of the anchor text) ── */}
      {anchors.map((anchor) => {
        // Estimate Y position from the anchor's character offset ratio
        const contentHeight = measuredHeight - BUBBLE_PAD_Y * 2;
        const ratio = Math.min(
          anchor.slice.startOffset / Math.max(message.content.length, 1),
          0.95,
        );
        const anchorY = BUBBLE_PAD_Y + ratio * contentHeight;

        return (
          <Handle
            key={anchor.id}
            type="source"
            position={Position.Right}
            id={`anchor-${anchor.id}`}
            style={{
              top: anchorY,
              opacity: 0,
              width: 8,
              height: 8,
            }}
          />
        );
      })}
    </>
  );
}

export const MessageNodeComponent = memo(MessageNodeInner);
