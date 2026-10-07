'use client';

import { useEffect } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  useReactFlow,
  ReactFlowProvider,
  type NodeTypes,
  type EdgeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { useChatStore } from '../../store';
import { MessageNodeComponent } from './MessageNode';
import { SequentialEdge, AnchorEdge } from './CanvasEdges';

// Register custom types (stable references — must not be created inside render)
const nodeTypes: NodeTypes = {
  message: MessageNodeComponent,
};

const edgeTypes: EdgeTypes = {
  sequential: SequentialEdge,
  anchor: AnchorEdge,
};

function CanvasBoardInner() {
  const nodes = useChatStore((s) => s.canvas.nodes);
  const edges = useChatStore((s) => s.canvas.edges);
  const messageCount = useChatStore((s) => Object.keys(s.messages).length);
  const { fitView } = useReactFlow();

  // Re-fit only when cards/edges are added or removed — not on every
  // streamed token, which would keep yanking the viewport around.
  const structureKey = `${nodes.length}:${edges.length}`;
  useEffect(() => {
    if (nodes.length > 0) {
      requestAnimationFrame(() => fitView({ padding: 0.15, duration: 300 }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey, fitView]);

  return (
    <div className="w-screen h-screen bg-zinc-950">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        // Allow pan and zoom (middle + right button only, so left-click allows text selection)
        panOnDrag={[1, 2]}
        selectionOnDrag={false}
        zoomOnScroll
        zoomOnPinch
        minZoom={0.1}
        maxZoom={2}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        proOptions={{ hideAttribution: true }}
      >
        {/* Dot-grid background */}
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
          color="#27272a"
        />

        {/* Zoom controls (bottom-left) */}
        <Controls
          showInteractive={false}
          className="!bg-zinc-900 !border-zinc-700 !rounded-lg !shadow-xl [&>button]:!bg-zinc-800 [&>button]:!border-zinc-700 [&>button]:!text-zinc-400 [&>button:hover]:!bg-zinc-700"
        />

        {/* Mini-map (bottom-right) */}
        <MiniMap
          position="bottom-right"
          nodeColor={(node) => {
            const role = (node.data as { message?: { role?: string } })
              ?.message?.role;
            return role === 'user' ? '#6366f1' : '#3f3f46';
          }}
          maskColor="rgba(0, 0, 0, 0.7)"
          className="!bg-zinc-900/80 !border-zinc-700 !rounded-lg"
          pannable
          zoomable
        />

        {messageCount === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center">
              <div className="text-4xl mb-3">💬</div>
              <p className="text-sm text-zinc-500">在下方输入框开始对话</p>
              <p className="text-xs text-zinc-600 mt-1">AI 回复后，划选文本即可创建分支</p>
            </div>
          </div>
        )}
      </ReactFlow>
    </div>
  );
}

export function CanvasBoard() {
  return (
    <ReactFlowProvider>
      <CanvasBoardInner />
    </ReactFlowProvider>
  );
}
