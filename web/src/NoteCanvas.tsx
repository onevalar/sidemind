
import { useCallback, useEffect, useRef, useState } from 'react'
import { applyNodeChanges, Controls, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow, type Node, type NodeChange, type NodeProps, type NodeTypes, type OnNodeDrag } from '@xyflow/react'
import type { CanvasGroup, NoteDTO } from '../shared/types'
import { api } from './api'
import { BlockCard, CARD_WIDTH, type BlockNode } from './BlockCard'
import { Button, Dialog, Icon, IconButton, Input } from './ui'

type StackNode = Node<{ title: string; count: number; dissolve: () => void }, 'stack'>
type CanvasNode = BlockNode | StackNode
function Stack({ data }: NodeProps<StackNode>) {
  return <div className="stack-surface"><div className="stack-heading"><Icon name="folder"/><strong>{data.title}</strong><span className="count">{data.count}</span><IconButton icon="close" label="解散容器，保留内容" onPress={data.dissolve}/></div></div>
}
const nodeTypes: NodeTypes = { block: BlockCard, stack: Stack }
const WIDTH = CARD_WIDTH + 36

/** Stacks own vertical layout; heights come from actual card measurements. */
function arrange(nodes: CanvasNode[], groups: CanvasGroup[]): CanvasNode[] {
  const next = nodes.map((n) => ({ ...n }))
  for (const group of groups) {
    let y = 62
    for (const id of group.blockIds) {
      const node = next.find((n) => n.id === id)
      if (!node) continue
      node.position = { x: 18, y }
      y += (node.measured?.height ?? 110) + 14
    }
    const parent = next.find((n) => n.id === group.id)
    if (parent) parent.style = { ...parent.style, width: WIDTH, height: Math.max(150, y + 8) }
  }
  return next
}

function Canvas({ note, onSelect, onEdit, onAdd, onChanged, theme, onOpenNote }: { note: NoteDTO; onOpenNote: (name: string) => void; theme: 'light' | 'dark'; onSelect: (id: string | null) => void; onEdit: (id: string) => void; onAdd: () => void; onChanged: () => void }) {
  const [nodes, setNodes] = useState<CanvasNode[]>([])
  const nodeRef = useRef<CanvasNode[]>([])
  const groups = useRef<CanvasGroup[]>(note.groups)
  const [error, setError] = useState<string | null>(null)
  const [groupOpen, setGroupOpen] = useState(false)
  const [groupTitle, setGroupTitle] = useState('新的内容组')
  const { setViewport } = useReactFlow()
  const nodesInitialized = useNodesInitialized()
  const fitted = useRef(false)
  const apply = useCallback((next: CanvasNode[]) => { nodeRef.current = next; setNodes(next) }, [])
  const persistGroups = async (next: CanvasGroup[], positions: Record<string, { x: number; y: number }> = {}) => {
    try {
      if (Object.keys(positions).length) await api.savePositions(note.name, positions)
      await api.saveGroups(note.name, next); groups.current = next; setError(null); onChanged()
    } catch (e) { setError((e as Error).message) }
  }
  const dissolve = (id: string) => {
    const g = groups.current.find((g) => g.id === id)
    const positions: Record<string, { x: number; y: number }> = {}
    if (g) for (const n of nodeRef.current.filter((n) => n.parentId === id)) positions[n.id] = { x: g.x + n.position.x, y: g.y + n.position.y }
    void persistGroups(groups.current.filter((g) => g.id !== id), positions)
  }

  useEffect(() => {
    groups.current = note.groups
    const previous = new Map(nodeRef.current.map((n) => [n.id, n]))
    const membership = new Map(note.groups.flatMap((g) => g.blockIds.map((id) => [id, g.id] as const)))
    const stacks: StackNode[] = note.groups.map((g) => ({ id: g.id, type: 'stack', position: { x: g.x, y: g.y }, dragHandle: '.stack-heading', data: { title: g.title, count: g.blockIds.length, dissolve: () => dissolve(g.id) }, style: { width: WIDTH, height: 160 }, zIndex: 0 }))
    let y = 40
    const cards = note.blocks.map((block): BlockNode => {
      const old = previous.get(block.id)
      const parentId = membership.get(block.id)
      const pos = parentId ? { x: 18, y: 62 } : { x: block.x ?? 48, y: block.y ?? y }
      y += (old?.measured?.height ?? 110) + 20
      return { id: block.id, type: 'block', position: pos, ...(parentId ? { parentId } : {}), measured: old?.measured, selected: old?.selected, data: { block, placed: true, onOpenNote }, zIndex: 1 }
    })
    apply(arrange([...stacks, ...cards], note.groups))
  }, [note, apply])

  useEffect(() => {
    if (fitted.current || !nodesInitialized) return
    const roots = nodeRef.current.filter((node) => !node.parentId)
    if (!roots.length) return
    fitted.current = true
    // Keep text readable on long notes; Controls still offers an all-content overview.
    void setViewport({ x: 40 - Math.min(...roots.map((node) => node.position.x)), y: 32 - Math.min(...roots.map((node) => node.position.y)), zoom: 1 })
  }, [nodesInitialized, setViewport])

  const onNodesChange = (changes: NodeChange<CanvasNode>[]) => {
    let next = applyNodeChanges(changes, nodeRef.current)
    if (changes.some((c) => c.type === 'dimensions')) next = arrange(next, groups.current)
    apply(next)
  }
  const onDragStop: OnNodeDrag<CanvasNode> = (_, node, dragged) => {
    if (node.type === 'stack') {
      void persistGroups(groups.current.map((g) => { const n = dragged.find((d) => d.id === g.id); return n ? { ...g, ...n.position } : g }))
      return
    }
    const parent = groups.current.find((g) => g.id === node.parentId)
    const absolute = { x: node.position.x + (parent?.x ?? 0), y: node.position.y + (parent?.y ?? 0) }
    const target = groups.current.find((g) => {
      const stack = nodeRef.current.find((n) => n.id === g.id)
      return absolute.x + CARD_WIDTH / 2 >= g.x && absolute.x + CARD_WIDTH / 2 <= g.x + WIDTH && absolute.y + 20 >= g.y && absolute.y <= g.y + Number(stack?.style?.height ?? 160)
    })
    if (target || parent) {
      const next = groups.current.map((g) => {
        const ids = g.blockIds.filter((id) => id !== node.id)
        if (target?.id === g.id) {
          const at = ids.findIndex((id) => { const other = nodeRef.current.find((n) => n.id === id); return (other?.position.y ?? 0) + (other?.measured?.height ?? 110) / 2 > absolute.y - g.y })
          ids.splice(at < 0 ? ids.length : at, 0, node.id)
        }
        return { ...g, blockIds: ids }
      })
      void persistGroups(next, { [node.id]: absolute })
    } else {
      void api.savePositions(note.name, Object.fromEntries(dragged.map((n) => [n.id, n.position]))).catch((e) => setError((e as Error).message))
    }
  }
  const createGroup = () => {
    const selected = nodeRef.current.filter((n) => n.type === 'block' && n.selected)
    const ids = (selected.length ? selected : nodeRef.current.filter((n) => n.type === 'block' && !n.parentId)).map((n) => n.id)
    if (!ids.length) { setError('先选择需要分组的内容块。'); return }
    const next = groups.current.map((g) => ({ ...g, blockIds: g.blockIds.filter((id) => !ids.includes(id)) }))
    next.push({ id: 'stack-' + crypto.randomUUID(), title: groupTitle.trim() || '内容组', x: 60 + next.length * (WIDTH + 50), y: 40, blockIds: ids })
    void persistGroups(next); setGroupOpen(false)
  }
  return <div className="canvas">
    {error && <div className="banner" role="alert">{error}</div>}
    <ReactFlow colorMode={theme} data-theme={'linear-' + theme} nodes={nodes} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onNodeDragStop={onDragStop} onNodeClick={(_, n) => { if (n.type === 'block') onSelect(n.id) }} onNodeDoubleClick={(_, n) => { if (n.type === 'block') onEdit(n.id) }} onPaneClick={() => onSelect(null)} nodesConnectable={false} deleteKeyCode={null} minZoom={.15} maxZoom={2} panOnScroll selectionOnDrag>
      <Controls showInteractive={false}/>
    </ReactFlow>
    <div className="canvas-actions"><IconButton icon="plus" label="添加内容块" onPress={onAdd}/><Button variant="ghost" size="sm" onPress={() => setGroupOpen(true)}><Icon name="group"/>创建容器</Button><span>双击编辑 · 拖入分组 · Shift 多选</span></div>
    <Dialog title="创建内容组" open={groupOpen} onClose={() => setGroupOpen(false)} footer={<><Button variant="ghost" onPress={() => setGroupOpen(false)}>取消</Button><Button onPress={createGroup}>创建分组</Button></>}><Input aria-label="分组名称" value={groupTitle} onChange={(e) => setGroupTitle(e.target.value)} autoFocus fullWidth/><p className="muted">已选卡片将组成纵向容器；没有选择时，收纳尚未分组的内容。</p></Dialog>
  </div>
}
export function NoteCanvas(props: Parameters<typeof Canvas>[0]) { return <ReactFlowProvider><Canvas {...props}/></ReactFlowProvider> }
