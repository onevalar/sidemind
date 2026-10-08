'use client';
import { useCallback, useEffect, useRef } from 'react';
import {
  ReactFlow, Background, BackgroundVariant, useReactFlow, ReactFlowProvider,
  useNodesInitialized, useViewport, type NodeTypes, type EdgeTypes, type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useChatStore } from '../../store';
import type { BranchId } from '../../types';
import { canvasExcerpt } from '../../lib/branch-canvas';
import { MessageNodeComponent } from './MessageNode';
import { BranchNodeComponent } from './BranchNode';
import { SequentialEdge, AnchorEdge } from './CanvasEdges';
import { Button, Icon } from '../ui';

const nodeTypes: NodeTypes = { message: MessageNodeComponent, branch: BranchNodeComponent };
const edgeTypes: EdgeTypes = { sequential: SequentialEdge, anchor: AnchorEdge };

function CanvasBoardInner({ theme }: { theme: 'light' | 'dark' }) {
  const nodes = useChatStore(s => s.canvas.nodes);
  const edges = useChatStore(s => s.canvas.edges);
  const mode = useChatStore(s => s.ui.canvasMode);
  const messages = useChatStore(s => s.messages);
  const branches = useChatStore(s => s.branches);
  const conclusionCount = useChatStore(s => Object.keys(s.blackboard).length);
  const updateNodes = useChatStore(s => s.updateCanvasNodes);
  const { fitView, zoomIn, zoomOut, zoomTo } = useReactFlow();
  const { zoom } = useViewport();
  const initialized = useNodesInitialized();
  const fitted = useRef(false);
  const messageCount = Object.keys(messages).length;
  useEffect(() => {
    if (!initialized || !nodes.length || fitted.current) return;
    fitted.current = true;
    void fitView({ padding: 0.18, minZoom: mode === 'branches' ? 0.5 : 0.2, maxZoom: 1 });
  }, [initialized, nodes.length, fitView, mode]);

  const readNode = useCallback((event: React.MouseEvent, node: Node) => {
    if (node.type !== 'branch' || (event.target as HTMLElement).closest('button')) return;
    const store = useChatStore.getState();
    store.setActiveBranchPanel(node.id === store.rootBranchId ? null : node.id as BranchId);
    store.setViewMode('linear');
  }, []);

  function createBranch() {
    const store = useChatStore.getState();
    const branch = store.branches[store.ui.activeBranchPanelId || store.rootBranchId];
    const reply = branch.messageIds.map(id => store.messages[id]).filter(message => message?.role === 'assistant' && message.content.trim()).at(-1);
    if (!reply) { store.setViewMode('linear'); return; }
    store.setPendingSelection({ messageId: reply.id, slice: { startOffset: 0, endOffset: reply.content.length,
      selectedText: canvasExcerpt(reply.content, 500) }, rect: new DOMRect() });
  }

  return <div className="canvas-board" data-density={zoom < 0.6 ? 'compact' : zoom >= 1.1 ? 'expanded' : 'normal'}>
    <header className="canvas-heading"><div><h2>对话的每一次展开，都有来处。</h2><p>{Math.max(0, Object.keys(branches).length - 1)} 条分支 · {messageCount} 条消息 · {conclusionCount} 条共享结论</p></div>
      <Button variant="outline" size="sm" isDisabled={!messageCount} onPress={createBranch}><Icon name="plus" size={14}/>创建分支</Button>
    </header>
    <div className="canvas-graph"><ReactFlow
      colorMode={theme} data-theme={'linear-' + theme} nodes={nodes} edges={edges}
      nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={updateNodes}
      onNodeDoubleClick={readNode} nodesDraggable={mode === 'branches'} nodeDragThreshold={6}
      nodesConnectable={false} elementsSelectable={mode === 'branches'} nodesFocusable={mode === 'branches'} edgesFocusable={false} deleteKeyCode={null}
      panOnDrag selectionOnDrag={false} zoomOnScroll zoomOnPinch minZoom={0.15} maxZoom={2}
      ariaLabelConfig={{ 'node.a11yDescription.default': '拖动卡片顶部调整位置。聚焦卡片后按 Enter 选中，使用方向键移动；展开阅读按钮打开完整对话。', 'edge.a11yDescription.default': '分支引用关系' }}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--border)"/>
      {!messageCount && <div className="canvas-empty"><Icon name="branch" size={26}/><h3>从一个问题开始，思路自然展开。</h3><p>回复中的文字可以成为新的分支，每一次探索都有迹可循。</p><Button variant="outline" onPress={() => useChatStore.getState().setViewMode('linear')}>开始对话</Button></div>}
    </ReactFlow></div>
    <div className="canvas-tools">
      <div className="canvas-mode-switch"><Button size="sm" variant={mode === 'branches' ? 'secondary' : 'ghost'} onPress={() => useChatStore.getState().setCanvasMode('branches')}>分支概览</Button><Button size="sm" variant={mode === 'messages' ? 'secondary' : 'ghost'} onPress={() => useChatStore.getState().setCanvasMode('messages')}>消息详情</Button></div>
      <div className="canvas-zoom"><Button size="sm" variant="ghost" isIconOnly aria-label="缩小画布" onPress={() => void zoomOut({ duration: 160 })}>−</Button><Button size="sm" variant="ghost" aria-label="重置缩放为 100%" onPress={() => void zoomTo(1, { duration: 160 })}>{Math.round(zoom * 100)}%</Button><Button size="sm" variant="ghost" isIconOnly aria-label="放大画布" onPress={() => void zoomIn({ duration: 160 })}>+</Button><Button size="sm" variant="ghost" aria-label="适应画布" onPress={() => void fitView({ padding: 0.18, maxZoom: 1, duration: 160 })}><Icon name="grid" size={14}/></Button></div>
      {mode === 'branches' && <Button size="sm" variant="outline" className="canvas-arrange" isDisabled={!nodes.length} onPress={() => { useChatStore.getState().arrangeBranchCanvas(); requestAnimationFrame(() => void fitView({ padding: 0.18, maxZoom: 1, duration: 160 })); }}>重新排列</Button>}
    </div>
    <p className="canvas-help">{mode === 'branches' ? '拖动卡片顶部调整位置 · 展开阅读完整对话 · 缩放查看不同层次' : '划选回复创建分支 · 拖动画布浏览 · 返回概览查看关系'}</p>
  </div>;
}

export function CanvasBoard({ theme }: { theme: 'light' | 'dark' }) {
  const id = useChatStore(s => s.activeConversationId + ':' + s.ui.canvasMode);
  return <ReactFlowProvider key={id}><CanvasBoardInner theme={theme}/></ReactFlowProvider>;
}
