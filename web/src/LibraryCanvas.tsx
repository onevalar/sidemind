import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { applyNodeChanges, Controls, NodeResizeControl, ReactFlow, type Node, type NodeProps, type Viewport } from '@xyflow/react'
import * as ContextMenu from '@radix-ui/react-context-menu'
import type { CanvasFrame, CanvasLayout, NotePosition, NoteSummary } from '../shared/types'
import { api, subscribeEvents } from './api'
import { Button, Dialog, Icon, Input } from './ui'

type ArticleNode = Node<{ note: NoteSummary; frameTitle?: string; chosen: boolean; selectionCount: number; choose: (extend?: boolean, preserve?: boolean) => void; open: () => void; preview: () => void; group: () => void }, 'article'>
type FrameNode = Node<{ frame: CanvasFrame; chosen: boolean; minimum: { width: number; height: number }; choose: () => void; edit: () => void; resize: (width: number, height: number) => void }, 'frame'>
type CanvasNode = ArticleNode | FrameNode
const frameNodeId = (id: string) => 'frame:' + id
function contains(frame: CanvasFrame, position: NotePosition) {
  const x = position.x + 140, y = position.y + 96
  return x >= frame.position.x + 16 && y >= frame.position.y + 48 &&
    x <= frame.position.x + frame.width - 16 && y <= frame.position.y + frame.height - 16
}
function fitFrame(frame: CanvasFrame, positions: CanvasLayout['positions']): CanvasFrame {
  if (!frame.members.length) return frame
  const cards = frame.members.map(name => positions[name]!)
  const x = Math.min(...cards.map(p => p.x)) - 24, y = Math.min(...cards.map(p => p.y)) - 64
  return { ...frame, position: { x, y },
    width: Math.max(336, Math.max(...cards.map(p => p.x)) + 304 - x),
    height: Math.max(280, Math.max(...cards.map(p => p.y)) + 216 - y) }
}
function minimumSize(frame: CanvasFrame, positions: CanvasLayout['positions']) {
  return {
    width: Math.max(336, ...frame.members.map(name => positions[name]!.x - frame.position.x + 296)),
    height: Math.max(280, ...frame.members.map(name => positions[name]!.y - frame.position.y + 208)),
  }
}
function ArticleCard({ data }: NodeProps<ArticleNode>) {
  return <ContextMenu.Root modal={false}>
    <ContextMenu.Trigger asChild onContextMenu={event => data.choose(event.shiftKey, true)}>
      <button type="button" className={'article-card' + (data.chosen ? ' is-selected' : '')} aria-label={data.note.title}
        aria-pressed={data.chosen} onPointerDown={event => { if (event.button === 0 || event.button === 2) data.choose(event.shiftKey, true) }}
        onClick={event => data.choose(event.shiftKey)} onFocus={() => data.choose(false, true)} onDoubleClick={data.open}>
        {data.frameTitle && <span className="article-label"><Icon name="group" size={14}/><span>{data.frameTitle}</span></span>}
        <strong title={data.note.title}>{data.note.title}</strong>
        <span className="article-summary">{data.note.excerpt || '还没有正文，双击开始写作。'}</span>
        <span className="article-footer"><Icon name="note" size={13}/><span>{data.note.name.split('/').at(-1)}</span></span>
      </button>
    </ContextMenu.Trigger>
    <ContextMenu.Portal><ContextMenu.Content className="canvas-context-menu" collisionPadding={8} aria-label="文章操作">
      <ContextMenu.Label className="canvas-menu-label">{data.selectionCount > 1 ? `已选择 ${data.selectionCount} 篇文章` : data.note.title}</ContextMenu.Label>
      <ContextMenu.Item className="canvas-menu-item" onSelect={data.preview}><Icon name="note" size={16}/>预览文章</ContextMenu.Item>
      <ContextMenu.Item className="canvas-menu-item" onSelect={data.open}><Icon name="arrow" size={16}/>打开并编辑</ContextMenu.Item>
      <ContextMenu.Separator className="canvas-menu-separator"/>
      <ContextMenu.Item className="canvas-menu-item" onSelect={data.group}><Icon name="group" size={16}/>创建文档区</ContextMenu.Item>
    </ContextMenu.Content></ContextMenu.Portal>
  </ContextMenu.Root>
}
function FrameCard({ data }: NodeProps<FrameNode>) {
  return <div className={'theme-frame' + (data.chosen ? ' is-selected' : '')}>
    <div className="frame-header"><button type="button" className="frame-handle" aria-label={'移动文档区：' + data.frame.title} aria-pressed={data.chosen} onClick={data.choose} onFocus={data.choose}>
      <Icon name="group" size={18}/><strong>{data.frame.title}</strong><span>{data.frame.members.length} 篇</span>
    </button><Button className="nodrag nopan frame-edit" size="sm" variant="ghost" isIconOnly aria-label={'编辑文档区：' + data.frame.title} onPress={data.edit}><Icon name="more"/></Button></div>
    {!data.frame.members.length && <span className="frame-empty">将文档拖入这里</span>}
    {data.chosen && <NodeResizeControl className="frame-resize" position="bottom-right" minWidth={data.minimum.width} minHeight={data.minimum.height} maxWidth={10000000} maxHeight={10000000}
      onResizeEnd={(_, size) => data.resize(size.width, size.height)}><span aria-hidden="true">↘</span></NodeResizeControl>}
  </div>
}
const nodeTypes = { article: ArticleCard, frame: FrameCard }

export function LibraryCanvas({ notes, folder, theme, viewport, onViewport, onOpen, onPreview, onCreate, beforeLeave }: {
  notes: NoteSummary[]; theme: 'light' | 'dark'; viewport: Viewport; onViewport: (viewport: Viewport) => void
  folder: string; onOpen: (name: string) => void; onPreview: (name: string) => void; onCreate: () => void
  beforeLeave: MutableRefObject<() => Promise<boolean>>
}) {
  const [nodes, setNodes] = useState<CanvasNode[]>([])
  const nodeRef = useRef<CanvasNode[]>([])
  const [layout, setLayout] = useState<CanvasLayout>({ frames: [], positions: {} })
  const layoutRef = useRef(layout)
  const savedFrames = useRef<CanvasFrame[]>([])
  const [ready, setReady] = useState(false)
  const [chosen, setChosen] = useState<string[]>([])
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<{ id: string; title: string } | null>(null)
  const [reloadOpen, setReloadOpen] = useState(false)
  const pending = useRef(new Map<string, { position: NotePosition; version: number }>())
  const pendingVersion = useRef<number | null>(null)
  const queue = useRef<Promise<boolean>>(Promise.resolve(true))
  const version = useRef(0)
  const loadAction = useRef<() => Promise<void>>(async () => {})
  const apply = useCallback((next: CanvasNode[]) => { nodeRef.current = next; setNodes(next) }, [])
  const applyLayout = useCallback((next: CanvasLayout) => { layoutRef.current = next; setLayout(next) }, [])
  useEffect(() => {
    let active = true, request = 0
    const load = async () => {
      const revision = ++request, currentVersion = version.current
      try {
        const next = await api.canvas(folder)
        if (!active || revision !== request || currentVersion !== version.current || pendingVersion.current !== null) return
        savedFrames.current = next.frames; applyLayout(next); setReady(true); setError('')
      } catch (error) { if (active && revision === request) setError('画布布局无法载入：' + (error as Error).message) }
    }
    loadAction.current = load
    void load()
    const unsubscribe = subscribeEvents(event => {
      if (event.type === 'hello' || event.type === 'notes-changed' || event.type === 'canvas-changed' && event.folder === folder) void load()
    })
    return () => { active = false; unsubscribe() }
  }, [folder, applyLayout])

  useEffect(() => {
    const previous = new Map(nodeRef.current.map(node => [node.id, node]))
    const frames: FrameNode[] = layout.frames.map(frame => {
      const id = frameNodeId(frame.id), old = previous.get(id)
      return { id, type: 'frame', position: old?.dragging ? old.position : frame.position, dragging: old?.dragging, measured: old?.measured, zIndex: 0, dragHandle: '.frame-handle',
        style: { width: frame.width, height: frame.height }, data: { frame, chosen: chosen.includes(id), minimum: minimumSize(frame, layout.positions),
          choose: () => setChosen([id]), edit: () => editFrame(frame), resize: (width, height) => resizeFrame(frame.id, width, height) } }
    })
    const articles: ArticleNode[] = notes.map(note => {
      const old = previous.get(note.name)
      const frame = layout.frames.find(frame => frame.members.includes(note.name))
      const absolute = layout.positions[note.name] ?? note.position
      return {
        id: note.name, type: 'article', parentId: frame ? frameNodeId(frame.id) : undefined, zIndex: 1,
        position: old?.dragging ? old.position : frame ? { x: absolute.x - frame.position.x, y: absolute.y - frame.position.y } : absolute,
        selected: chosen.includes(note.name), dragging: old?.dragging, measured: old?.measured,
        data: { note, frameTitle: frame?.title, chosen: chosen.includes(note.name), selectionCount: chosen.filter(id => notes.some(note => note.name === id)).length,
          choose: (extend = false, preserve = false) => setChosen(current => preserve && current.includes(note.name) ? current : extend ? [...current.filter(id => notes.some(note => note.name === id) && id !== note.name), note.name] : [note.name]),
          open: () => onOpen(note.name), preview: () => onPreview(note.name), group: () => createFrame(chosen.includes(note.name) ? chosen : [note.name]) },
      }
    })
    // React Flow requires parents before children. Only rendering uses relative coordinates.
    apply([...frames, ...articles])
    const available = chosen.filter(id => notes.some(note => note.name === id) || frames.some(frame => frame.id === id))
    if (available.length !== chosen.length) setChosen(available)
  }, [notes, layout, chosen, onOpen, apply])
  useEffect(() => {
    beforeLeave.current = async () => { await queue.current; return pendingVersion.current === null }
    return () => { beforeLeave.current = async () => true }
  }, [beforeLeave])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (pendingVersion.current !== null) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  function persist(next: CanvasLayout, positions: Record<string, NotePosition>) {
    const current = ++version.current
    pendingVersion.current = current
    // Auto-fitting can shift the region's origin without moving its documents.
    // Explicit world coordinates prevent the server treating this as a group drag.
    for (const frame of next.frames) {
      const previous = layoutRef.current.frames.find(old => old.id === frame.id)
      if (previous && (previous.position.x !== frame.position.x || previous.position.y !== frame.position.y)) {
        for (const name of frame.members) positions[name] = next.positions[name]!
      }
    }
    for (const [name, position] of Object.entries(positions)) pending.current.set(name, { position, version: current })
    const entries = [...pending.current], snapshot = Object.fromEntries(entries.map(([name, entry]) => [name, entry.position]))
    applyLayout(next)
    setSaving(true)
    queue.current = queue.current.then(async () => {
      try {
        const saved = await api.saveCanvas(folder, next.frames, snapshot, savedFrames.current)
        savedFrames.current = saved.frames
        for (const [name, entry] of entries) if (pending.current.get(name)?.version === entry.version) pending.current.delete(name)
        if (current === version.current) { pendingVersion.current = null; applyLayout(saved); setError('') }
        return true
      } catch (error) { setError('布局尚未保存：' + (error as Error).message); return false }
      finally { if (current === version.current) setSaving(false) }
    })
  }

  function moveArticles(moved: Record<string, NotePosition>) {
    if (!ready) return
    const current = layoutRef.current
    const positions = { ...current.positions, ...moved }, affected = new Set<string>()
    let frames = current.frames.map(frame => ({ ...frame, members: [...frame.members] }))
    for (const [name, position] of Object.entries(moved)) {
      const previous = current.frames.find(frame => frame.members.includes(name))
      const destination = previous && contains(previous, position) ? previous : [...current.frames].reverse().find(frame => contains(frame, position))
      if (previous) affected.add(previous.id)
      if (destination) affected.add(destination.id)
      frames = frames.map(frame => ({ ...frame, members: frame.id === destination?.id ? [...frame.members.filter(member => member !== name), name] : frame.members.filter(member => member !== name) }))
    }
    frames = frames.map(frame => affected.has(frame.id) ? fitFrame(frame, positions) : frame)
    persist({ frames, positions }, { ...moved })
  }
  function moveFrame(id: string, position: NotePosition) {
    const current = layoutRef.current, frame = current.frames.find(frame => frame.id === id)
    if (!frame) return
    const dx = position.x - frame.position.x, dy = position.y - frame.position.y
    const positions = Object.fromEntries(frame.members.map(name => [name, { x: current.positions[name]!.x + dx, y: current.positions[name]!.y + dy }]))
    persist({ frames: current.frames.map(frame => frame.id === id ? { ...frame, position } : frame), positions: { ...current.positions, ...positions } }, positions)
  }
  function resizeFrame(id: string, width: number, height: number) {
    const current = layoutRef.current
    persist({ ...current, frames: current.frames.map(frame => frame.id === id ? { ...frame, width, height } : frame) }, {})
  }
  function editFrame(frame: CanvasFrame) {
    setChosen([frameNodeId(frame.id)])
    setForm({ id: frame.id, title: frame.title })
  }
  function createFrame(selection: string[]) {
    if (!ready) return
    const current = layoutRef.current, members = selection.filter(name => notes.some(note => note.name === name))
    if (!members.length) return
    const positions = { ...Object.fromEntries(notes.map(note => [note.name, note.position])), ...current.positions }
    const frame = fitFrame({ id: crypto.randomUUID(), space: folder, title: '文档区', width: 336, height: 280, position: { x: 0, y: 0 }, members }, positions)
    const frames = current.frames.map(old => old.members.some(name => members.includes(name)) ? fitFrame({ ...old, members: old.members.filter(name => !members.includes(name)) }, positions) : old)
    persist({ frames: [...frames, frame], positions }, {})
    setChosen([frameNodeId(frame.id)])
  }
  function absolutePosition(node: CanvasNode): NotePosition {
    const parent = node.parentId ? nodeRef.current.find(parent => parent.id === node.parentId) : null
    return parent ? { x: parent.position.x + node.position.x, y: parent.position.y + node.position.y } : node.position
  }
  const active = chosen.at(-1)
  const selectedFrame = layout.frames.find(frame => frameNodeId(frame.id) === active)

  return <div className="canvas-wrap" onKeyDownCapture={event => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey || !active || !(event.target as HTMLElement).closest('.article-card,.frame-handle')) return
    if (!selectedFrame && (event.key === ' ' || event.key === 'Enter')) {
      event.preventDefault(); event.stopPropagation()
      if (event.key === ' ') onPreview(active); else onOpen(active)
    }
    const movement: Record<string, NotePosition> = { ArrowLeft: { x: -20, y: 0 }, ArrowRight: { x: 20, y: 0 }, ArrowUp: { x: 0, y: -20 }, ArrowDown: { x: 0, y: 20 } }
    const delta = movement[event.key]
    if (delta) {
      event.preventDefault(); event.stopPropagation()
      const node = nodeRef.current.find(node => node.id === active)
      if (!node) return
      const absolute = absolutePosition(node), position = { x: absolute.x + delta.x, y: absolute.y + delta.y }
      if (selectedFrame) moveFrame(selectedFrame.id, position); else moveArticles(Object.fromEntries(chosen.map(name => {
        const old = layoutRef.current.positions[name] ?? notes.find(note => note.name === name)!.position
        return [name, { x: old.x + delta.x, y: old.y + delta.y }]
      })))
    }
  }}>
    <div className="canvas">
      <ReactFlow nodes={nodes} nodeTypes={nodeTypes} colorMode={theme} defaultViewport={viewport} nodesDraggable={ready}
        proOptions={{ hideAttribution: true }}
        ariaLabelConfig={{ 'controls.zoomIn.ariaLabel': '放大画布', 'controls.zoomOut.ariaLabel': '缩小画布', 'controls.fitView.ariaLabel': '查看全部文章' }}
        onMoveEnd={(_, view) => onViewport(view)} onNodesChange={changes => apply(applyNodeChanges(changes, nodeRef.current))}
        onNodeDragStart={(_, node) => setChosen(current => current.includes(node.id) ? current : [node.id])} onNodeDragStop={(_, node, dragged) => {
          if (node.type === 'frame') moveFrame(node.data.frame.id, node.position); else moveArticles(Object.fromEntries(dragged.filter(node => node.type === 'article').map(node => [node.id, absolutePosition(node)])))
        }}
        onPaneClick={() => setChosen([])} nodesConnectable={false} nodesFocusable={false} elementsSelectable={false}
        deleteKeyCode={null} zoomOnDoubleClick={false} minZoom={.2} maxZoom={2} panOnScroll>
        <Controls showInteractive={false}/>
      </ReactFlow>
    </div>
    {ready && !notes.length && !layout.frames.length && <div className="canvas-empty canvas-empty-overlay"><Icon name="grid" size={30}/><h1>为想法留一个位置</h1><p className="muted">创建文章，自由摆放。</p><Button onPress={onCreate}><Icon name="plus"/>创建第一篇文章</Button></div>}
    {error && <div className="banner" role="alert"><span>{error}</span><div className="toolbar"><Button size="sm" variant="outline" isDisabled={saving} onPress={() => pendingVersion.current !== null ? persist(layoutRef.current, {}) : void loadAction.current()}>重试</Button>{pendingVersion.current !== null && <Button size="sm" variant="ghost" isDisabled={saving} onPress={() => setReloadOpen(true)}>重新载入</Button>}</div></div>}
    <Dialog title="编辑文档区" open={!!form} onClose={() => setForm(null)} footer={<>
      <Button variant="ghost" onPress={() => { if (!form) return; const current = layoutRef.current; persist({ ...current, frames: current.frames.filter(frame => frame.id !== form.id) }, {}); setForm(null); setChosen([]) }}>解散文档区</Button>
      <Button variant="ghost" onPress={() => setForm(null)}>取消</Button><Button type="submit" form="theme-frame-form" isDisabled={!form?.title.trim()}>保存名称</Button>
    </>}>
      <form id="theme-frame-form" onSubmit={event => { event.preventDefault(); if (!form?.title.trim()) return; const current = layoutRef.current; persist({ ...current, frames: current.frames.map(frame => frame.id === form.id ? { ...frame, title: form.title.trim() } : frame) }, {}); setForm(null) }}>
      <div className="new-note-fields"><label htmlFor="frame-title">文档区名称</label><Input id="frame-title" value={form?.title ?? ''} maxLength={80} autoFocus fullWidth placeholder="例如：阅读资料、项目 A" onChange={event => setForm(current => current && { ...current, title: event.target.value })}/></div>
      <p className="muted">拖入文档自动加入，拖出后脱离，区域大小随内容调整。</p><p className="muted">解散只移除分组，文章正文和位置都保留。</p>
      </form>
    </Dialog>
    <Dialog title="重新载入画布" open={reloadOpen} onClose={() => setReloadOpen(false)} footer={<><Button variant="ghost" onPress={() => setReloadOpen(false)}>保留修改</Button><Button onPress={() => { version.current++; pending.current.clear(); pendingVersion.current = null; setReloadOpen(false); void loadAction.current() }}>放弃未保存布局并重新载入</Button></>}><p>仅放弃这次未保存的文档区和文章位置修改，Markdown 正文不会改变。</p></Dialog>
  </div>
}
