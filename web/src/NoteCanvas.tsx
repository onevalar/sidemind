import { useCallback, useEffect, useRef, useState } from 'react'
import {
  applyNodeChanges,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  type Edge,
  type NodeChange,
  type NodeTypes,
  type OnNodeDrag,
} from '@xyflow/react'
import type { NoteDTO } from '../shared/types'
import { api, subscribeEvents } from './api'
import { BlockCard, type BlockNode } from './BlockCard'

const nodeTypes: NodeTypes = { block: BlockCard }
const START_X = 80
const START_Y = 60
const GAP = 28
const FALLBACK_HEIGHT = 90

function toNodes(note: NoteDTO, previous: BlockNode[]): BlockNode[] {
  const prevById = new Map(previous.map((n) => [n.id, n]))
  return note.blocks.map((block) => {
    const placed = block.x !== null && block.y !== null
    const prev = prevById.get(block.id)
    return {
      // Keep the measured size of cards that already exist so they don't flash while re-measuring.
      ...(prev ?? {}),
      id: block.id,
      type: 'block',
      position: placed ? { x: block.x!, y: block.y! } : (prev?.position ?? { x: 0, y: 0 }),
      data: { block, placed },
      // Unplaced cards stay invisible until we know their height and have stacked them.
      style: { visibility: placed ? 'visible' : 'hidden' },
    } as BlockNode
  })
}

/** Faint arrows in reading order, so the document's sequence stays visible on the canvas. */
function readingOrderEdges(nodes: BlockNode[]): Edge[] {
  return nodes.slice(1).map((n, i) => ({
    id: `e-${nodes[i]!.id}-${n.id}`,
    source: nodes[i]!.id,
    target: n.id,
    selectable: false,
    focusable: false,
    className: 'reading-edge',
  }))
}

function Canvas({ name }: { name: string }) {
  const [nodes, setNodes] = useState<BlockNode[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nodesRef = useRef<BlockNode[]>([])
  const fitted = useRef(false)
  const initialized = useNodesInitialized()
  const { fitView } = useReactFlow<BlockNode>()

  const apply = useCallback((next: BlockNode[]) => {
    nodesRef.current = next
    setNodes(next)
    setEdges(readingOrderEdges(next))
  }, [])

  const load = useCallback(async () => {
    try {
      const note = await api.loadNote(name)
      apply(toNodes(note, nodesRef.current))
      setLoaded(true)
      setError(null)
    } catch (e) {
      setError(`无法打开笔记：${(e as Error).message}`)
    }
  }, [name, apply])

  useEffect(() => {
    void load()
    return subscribeEvents((e) => {
      if (e.type === 'note-changed' && e.name === name) void load()
    })
  }, [name, load])

  // Once cards are measured, stack any unplaced ones below what is already on the canvas.
  useEffect(() => {
    if (!initialized || !loaded) return
    const current = nodesRef.current
    const unplaced = current.filter((n) => !n.data.placed)
    if (unplaced.length === 0) {
      if (!fitted.current && current.length > 0) {
        fitted.current = true
        requestAnimationFrame(() => void fitView({ padding: 0.2, maxZoom: 1, duration: 250 }))
      }
      return
    }

    const placedNodes = current.filter((n) => n.data.placed)
    let y = placedNodes.length
      ? Math.max(...placedNodes.map((n) => n.position.y + (n.measured?.height ?? FALLBACK_HEIGHT))) + GAP
      : START_Y
    const x = placedNodes.length ? Math.min(...placedNodes.map((n) => n.position.x)) : START_X

    const positions: Record<string, { x: number; y: number }> = {}
    const laidOut = current.map((n) => {
      if (n.data.placed) return n
      const pos = { x, y }
      positions[n.id] = pos
      y += (n.measured?.height ?? FALLBACK_HEIGHT) + GAP
      return { ...n, position: pos, data: { ...n.data, placed: true }, style: { visibility: 'visible' } } as BlockNode
    })
    apply(laidOut)
    void api.savePositions(name, positions).catch((e) => setError(`保存位置失败：${(e as Error).message}`))
  }, [initialized, loaded, name, apply, fitView])

  // Let React Flow compute drags/selection/measurements, then mirror the result into our state.
  const onNodesChange = useCallback((changes: NodeChange<BlockNode>[]) => {
    const next = applyNodeChanges(changes, nodesRef.current)
    nodesRef.current = next
    setNodes(next)
  }, [])

  const onNodeDragStop: OnNodeDrag<BlockNode> = useCallback(
    (_e, _node, dragged) => {
      const positions: Record<string, { x: number; y: number }> = {}
      for (const n of dragged) positions[n.id] = { x: n.position.x, y: n.position.y }
      void api.savePositions(name, positions).catch((e) => setError(`保存位置失败：${(e as Error).message}`))
    },
    [name],
  )

  return (
    <div className="canvas">
      {error && <div className="banner">{error}</div>}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        nodesConnectable={false}
        edgesFocusable={false}
        minZoom={0.1}
        maxZoom={2}
        panOnScroll
        zoomOnPinch
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: 'default' }}
      >
        <Background gap={24} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeStrokeWidth={2} />
      </ReactFlow>
    </div>
  )
}

export function NoteCanvas({ name }: { name: string }) {
  return (
    <ReactFlowProvider>
      <Canvas name={name} />
    </ReactFlowProvider>
  )
}
