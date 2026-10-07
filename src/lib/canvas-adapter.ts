/**
 * canvas-adapter.ts
 *
 * Pure pipeline that converts normalized ChatState into positioned
 * React Flow Node[] and Edge[] arrays, ready for rendering.
 *
 * Pipeline:
 *   ChatState
 *     → derive nodes + edges (flat mapping)
 *     → measure each node's height via pretext
 *     → compute (x, y) positions via dagre
 *     → return final arrays
 */

import type { Node, Edge } from '@xyflow/react';
import type {
  ChatState,
  Message,
  Anchor,
  Branch,
  BranchId,
  AnchorIntent,
} from '../types';
import { BUBBLE_WIDTH, BRANCH_LABEL_HEIGHT } from './typography';
import { measureMessage } from './measure';
import { applyDagreLayout } from './layout';

// ─── Node Data ──────────────────────────────────────────────────────────

export type MessageNodeData = {
  message: Message;
  /** Anchors on THIS message (sorted by startOffset) */
  anchors: Anchor[];
  /** The branch this message belongs to */
  branch: Branch;
  /** True if this is the first message in its branch */
  isFirstInBranch: boolean;
  /** True if this is the last message in its branch */
  isLastInBranch: boolean;
  /** Pretext-measured width */
  measuredWidth: number;
  /** Pretext-measured height (content + padding) */
  measuredHeight: number;
};

export type MessageNode = Node<MessageNodeData, 'message'>;

// ─── Edge Data ──────────────────────────────────────────────────────────

export type CanvasEdgeData = {
  /** 'sequential' = within a branch, 'anchor' = across branches */
  kind: 'sequential' | 'anchor';
  /** Present only when kind === 'anchor' */
  anchor?: Anchor;
  /** Intent color for anchor edges */
  intentColor?: string;
};

export type CanvasEdge = Edge<CanvasEdgeData>;

// ─── Constants ──────────────────────────────────────────────────────────

const INTENT_EDGE_STYLE: Record<AnchorIntent, string> = {
  main: '#60a5fa',
  'new-branch': '#34d399',
  'existing-branch': '#a78bfa',
};

// ─── Adapter ────────────────────────────────────────────────────────────

export function deriveCanvasElements(state: ChatState): {
  nodes: MessageNode[];
  edges: CanvasEdge[];
} {
  const { messages, anchors, branches, rootBranchId } = state;
  const rawNodes: MessageNode[] = [];
  const edges: CanvasEdge[] = [];

  // Process branches in stable order: root first, then alphabetical
  const branchIds = Object.keys(branches).sort((a, b) => {
    if (a === rootBranchId) return -1;
    if (b === rootBranchId) return 1;
    return a.localeCompare(b);
  }) as BranchId[];

  for (const branchId of branchIds) {
    const branch = branches[branchId];
    if (!branch) continue;

    const msgIds = branch.messageIds;

    for (let i = 0; i < msgIds.length; i++) {
      const msg = messages[msgIds[i]];
      if (!msg) continue;

      // Collect anchors on this message, sorted by offset
      const msgAnchors = msg.anchorIds
        .map((aid) => anchors[aid])
        .filter(Boolean)
        .sort((a, b) => a.slice.startOffset - b.slice.startOffset);

      // ── Measure ──
      const measuredWidth = BUBBLE_WIDTH;
      const measuredHeight =
        measureMessage(msg) + (i === 0 ? BRANCH_LABEL_HEIGHT : 0);

      // ── Create Node (position is 0,0 — dagre overwrites below) ──
      rawNodes.push({
        id: msg.id,
        type: 'message',
        position: { x: 0, y: 0 },
        data: {
          message: msg,
          anchors: msgAnchors,
          branch,
          isFirstInBranch: i === 0,
          isLastInBranch: i === msgIds.length - 1,
          measuredWidth,
          measuredHeight,
        },
        width: measuredWidth,
        height: measuredHeight,
      });

      // ── Sequential Edge (within branch) ──
      if (i > 0) {
        const prevMsgId = msgIds[i - 1];
        edges.push({
          id: `seq_${prevMsgId}_${msg.id}`,
          source: prevMsgId,
          target: msg.id,
          type: 'sequential',
          data: { kind: 'sequential' },
        });
      }
    }
  }

  // ── Anchor Edges (cross-branch) ──
  for (const anchor of Object.values(anchors)) {
    const targetBranch = branches[anchor.branchId];
    if (!targetBranch || targetBranch.messageIds.length === 0) continue;

    const targetFirstMsg = targetBranch.messageIds[0];

    edges.push({
      id: `anc_${anchor.id}`,
      source: anchor.messageId,
      target: targetFirstMsg,
      sourceHandle: `anchor-${anchor.id}`,
      type: 'anchor',
      animated: anchor.status === 'streaming',
      data: {
        kind: 'anchor',
        anchor,
        intentColor: INTENT_EDGE_STYLE[anchor.intent],
      },
    });
  }

  // ── Apply dagre layout → fill in real (x, y) positions ──
  const nodes = applyDagreLayout(rawNodes, edges);

  return { nodes, edges };
}
