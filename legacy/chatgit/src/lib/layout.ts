/**
 * layout.ts
 *
 * Dagre-based graph layout engine.
 *
 * Takes the flat MessageNode[] and CanvasEdge[] arrays (with measured sizes),
 * feeds them to dagre in LR (Left-to-Right) mode, and writes back
 * absolute (x, y) positions onto each node.
 *
 * Dagre returns center-of-node coordinates; we convert to top-left
 * for React Flow's coordinate system.
 */

import dagre from '@dagrejs/dagre';
import type { MessageNode, CanvasEdge } from './canvas-adapter';
import { DAGRE_RANKSEP, DAGRE_NODESEP } from './typography';

/**
 * Run dagre layout on the given nodes & edges.
 * Mutates nothing — returns new node objects with updated positions.
 */
export function applyDagreLayout(
  nodes: MessageNode[],
  edges: CanvasEdge[],
): MessageNode[] {
  const g = new dagre.graphlib.Graph();

  g.setGraph({
    rankdir: 'LR',
    nodesep: DAGRE_NODESEP,
    ranksep: DAGRE_RANKSEP,
    // Align top edges of nodes in the same rank for cleaner visuals
    rankalign: 'top',
  });

  g.setDefaultEdgeLabel(() => ({}));

  // Register nodes with their measured dimensions
  for (const node of nodes) {
    const w = node.data.measuredWidth;
    const h = node.data.measuredHeight;
    g.setNode(node.id, { width: w, height: h });
  }

  // Register all edges
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  // Run the layout algorithm
  dagre.layout(g);

  // Map dagre's center-coordinates → React Flow's top-left coordinates
  return nodes.map((node) => {
    const dagreNode = g.node(node.id);
    if (!dagreNode) return node;

    const w = node.data.measuredWidth;
    const h = node.data.measuredHeight;

    return {
      ...node,
      position: {
        x: dagreNode.x - w / 2,
        y: dagreNode.y - h / 2,
      },
    };
  });
}
