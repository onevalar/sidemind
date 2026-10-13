'use client';

import { memo } from 'react';
import {
  BaseEdge,
  getBezierPath,
  getStraightPath,
  type EdgeProps,
} from '@xyflow/react';
import type { CanvasEdgeData } from '../../lib/canvas-adapter';

/**
 * Sequential edge: ghost-gray straight line between consecutive
 * messages within the same branch.
 */
function SequentialEdgeInner({
  sourceX,
  sourceY,
  targetX,
  targetY,
}: EdgeProps) {
  const [path] = getStraightPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
  });

  return (
    <BaseEdge
      path={path}
      style={{
        stroke: 'var(--border)',
        strokeWidth: 1.5,
        strokeDasharray: '6 4',
      }}
    />
  );
}

export const SequentialEdge = memo(SequentialEdgeInner);

/**
 * Anchor edge: smooth bezier curve from an anchor's highlight
 * inside a source message to the first message of the target branch.
 * Color matches the anchor's intent (blue / green / purple).
 */
function AnchorEdgeInner({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
}: EdgeProps) {
  const edgeData = data as CanvasEdgeData | undefined;
  const color = edgeData?.intentColor ?? '#60a5fa';
  const isStreaming = edgeData?.anchor?.status === 'streaming';

  const [path] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    curvature: 0.4,
  });

  return (
    <>
      {/* Glow halo (below main stroke) */}
      <BaseEdge
        path={path}
        style={{
          stroke: color,
          strokeWidth: 6,
          strokeOpacity: 0.1,
        }}
      />
      {/* Main stroke */}
      <BaseEdge
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: color,
          strokeWidth: 2,
          strokeOpacity: 0.75,
          ...(isStreaming
            ? { strokeDasharray: '8 4', animation: 'dash 0.6s linear infinite' }
            : {}),
        }}
      />
    </>
  );
}

export const AnchorEdge = memo(AnchorEdgeInner);
