import dagre from '@dagrejs/dagre';
import type { Node, Edge } from '@xyflow/react';
import type { ChatState, Branch, BranchId, BranchPositions, CanvasPoint } from '../types';

export const BRANCH_CARD_WIDTH = 304;
export const BRANCH_CARD_HEIGHT = 204;
const HORIZONTAL_GAP = 112;
const VERTICAL_GAP = 56;

export type BranchCardData = {
  branch: Branch;
  title: string;
  preview: string;
  previewKind: 'conclusion' | 'reply' | 'question' | 'empty';
  messageCount: number;
  sourceLabel: string | null;
  updatedAt: number;
  isRoot: boolean;
  isExample: boolean;
};
export type BranchCardNode = Node<BranchCardData, 'branch'>;

/** Plain excerpts preserve content while removing Markdown-only presentation. */
export function canvasExcerpt(raw: string, limit = 160): string {
  return raw.replace(/```[\s\S]*?```/g, ' 代码片段 ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/gm, '')
    .replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function validCanvasPoint(value: unknown): value is CanvasPoint {
  if (!value || typeof value !== 'object') return false;
  const point = value as CanvasPoint;
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Math.abs(point.x) <= 100000 && Math.abs(point.y) <= 100000;
}

export function restoreBranchPositions(value: unknown): Record<string, BranchPositions> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, points]) => points && typeof points === 'object' && !Array.isArray(points)).map(([id, points]) => [
    id, Object.fromEntries(Object.entries(points).filter((entry): entry is [string, CanvasPoint] => validCanvasPoint(entry[1])).map(([branch, point]) => [branch, { x: point.x, y: point.y }])),
  ]));
}

/** Existing positions stay fixed; only new branches need a free location. */
export function branchCanvas(state: Pick<ChatState, 'messages' | 'branches' | 'anchors' | 'blackboard' | 'rootBranchId'>, saved: BranchPositions = {}) {
  const branches = Object.values(state.branches).filter(branch => branch.messageIds.length || branch.id !== state.rootBranchId);
  const ids = new Set(branches.map(branch => branch.id));
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const anchor of Object.values(state.anchors)) {
    const source = state.messages[anchor.messageId]?.branchId;
    const target = anchor.branchId;
    if (!source || source === target || !ids.has(source) || !ids.has(target)) continue;
    const key = JSON.stringify([source, target]);
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ id: 'branch-' + anchor.id, source, target, type: 'smoothstep', animated: anchor.status === 'streaming',
      style: { stroke: 'var(--border)', strokeWidth: 1.5 },
      ariaLabel: `${state.branches[source].label} → ${state.branches[target].label}` });
  }

  const positions: BranchPositions = Object.fromEntries(Object.entries(saved).filter(([id, point]) => ids.has(id as BranchId) && validCanvasPoint(point)));
  const hadPositions = Object.keys(positions).length > 0;
  const graph = new dagre.graphlib.Graph();
  // Streaming only updates excerpts; layout runs on first use or an explicit rearrange.
  if (!hadPositions && branches.length) {
    graph.setGraph({ rankdir: 'LR', ranksep: HORIZONTAL_GAP, nodesep: VERTICAL_GAP, marginx: 32, marginy: 32 });
    graph.setDefaultEdgeLabel(() => ({}));
    for (const branch of branches) graph.setNode(branch.id, { width: BRANCH_CARD_WIDTH, height: BRANCH_CARD_HEIGHT });
    for (const edge of edges) graph.setEdge(edge.source, edge.target);
    dagre.layout(graph);
  }
  const remaining = branches.filter(branch => !positions[branch.id]);
  // Parents first when records arrive in an arbitrary order; DAG cycles remain valid relations.
  while (remaining.length) {
    const index = remaining.findIndex(branch => !hadPositions || !branch.sourceMessageId || positions[state.messages[branch.sourceMessageId]?.branchId]);
    const branch = remaining.splice(index < 0 ? 0 : index, 1)[0];
    const parent = branch.sourceMessageId && positions[state.messages[branch.sourceMessageId]?.branchId];
    const layout = graph.node(branch.id);
    let point = hadPositions ? { x: parent ? parent.x + BRANCH_CARD_WIDTH + HORIZONTAL_GAP : 32, y: parent ? parent.y : 32 }
      : { x: layout.x - BRANCH_CARD_WIDTH / 2, y: layout.y - BRANCH_CARD_HEIGHT / 2 };
    if (!validCanvasPoint(point)) point = { x: 32, y: 32 };
    if (hadPositions) {
      while (Object.values(positions).some(other => Math.abs(point.x - other.x) < BRANCH_CARD_WIDTH + 24 && Math.abs(point.y - other.y) < BRANCH_CARD_HEIGHT + 24)) point.y += BRANCH_CARD_HEIGHT + VERTICAL_GAP;
    }
    positions[branch.id] = point;
  }

  const nodes: BranchCardNode[] = branches.map(branch => {
    const messages = branch.messageIds.map(id => state.messages[id]).filter(Boolean);
    const question = messages.find(message => message.role === 'user');
    const reply = messages.filter(message => message.role === 'assistant' && message.content.trim()).at(-1);
    const conclusion = state.blackboard[branch.id]?.summary;
    const isRoot = branch.id === state.rootBranchId;
    const sourceBranch = branch.sourceMessageId && state.messages[branch.sourceMessageId]?.branchId;
    return { id: branch.id, type: 'branch', position: positions[branch.id],
      width: BRANCH_CARD_WIDTH, height: BRANCH_CARD_HEIGHT, dragHandle: '.branch-card-drag',
      ariaLabel: `${isRoot ? '主线' : '分支'}：${branch.label}，${messages.length} 条消息`,
      data: { branch, isRoot, isExample: Boolean(conclusion ? state.blackboard[branch.id]?.example : reply ? reply.example : question?.example), messageCount: messages.length,
        title: isRoot && ['主线', '主线对话', '主干对话'].includes(branch.label) ? canvasExcerpt(question?.content || branch.label, 64) : branch.label,
        preview: canvasExcerpt(conclusion || reply?.content || question?.content || '', 240),
        previewKind: conclusion ? 'conclusion' : reply ? 'reply' : question ? 'question' : 'empty',
        sourceLabel: sourceBranch ? state.branches[sourceBranch]?.label || null : null,
        updatedAt: messages.reduce((latest, message) => Math.max(latest, message.createdAt), 0) } };
  });
  return { nodes, edges, positions };
}
