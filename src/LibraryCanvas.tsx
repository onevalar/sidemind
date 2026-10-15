import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { createPortal } from 'react-dom'
import { TextShimmer } from './components/arc/text-shimmer/text-shimmer'
import { applyNodeChanges, NodeResizeControl, ReactFlow, type Node, type NodeProps, type ReactFlowInstance, type Viewport } from '@xyflow/react'
import type { CanvasFrame, CanvasLayout, NotePosition, NoteSummary } from '../shared/types'
import { api, subscribeEvents } from './api'
import { Button, Card, ContextMenu, Dialog, DropdownMenu, EmptyState, Icon, IconButton, Input } from './ui'
import { composing } from './ime'
import './canvas-workspace.css'

type ArticleNode = Node<{ note: NoteSummary; running: boolean; chosen: boolean; selectionCount: number; choose: (extend?: boolean, preserve?: boolean) => void; open: () => void; preview: () => void; group: () => void }, 'article'>
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
  return <ContextMenu label="文章操作" heading={data.selectionCount > 1 ? `已选择 ${data.selectionCount} 篇文章` : data.note.title} items={[
    { id: 'preview', label: '预览文章', icon: <Icon name="note" size={16}/>, onSelect: data.preview },
    { id: 'edit', label: '打开并编辑', icon: <Icon name="arrow" size={16}/>, onSelect: data.open },
    { id: 'group', label: '创建文档区', icon: <Icon name="group" size={16}/>, onSelect: data.group },
  ]}>
      <Card role="button" tabIndex={0} className={'article-card' + (data.chosen ? ' is-selected' : '')} aria-label={data.note.title}
        title={data.note.title} description={data.note.excerpt || '还没有正文，双击开始写作。'}
        onContextMenu={event => data.choose(event.shiftKey, true)}
        aria-pressed={data.chosen} onPointerDown={event => { if (event.button === 0 || event.button === 2) data.choose(event.shiftKey, true) }}
        onClick={event => data.choose(event.shiftKey)} onFocus={() => data.choose(false, true)} onDoubleClick={data.open}>
        {data.running && <span className="article-task-state" role="status"><Icon name="spark" size={14}/><TextShimmer>AI 处理中</TextShimmer></span>}
      </Card>
  </ContextMenu>
}
function FrameCard({ data }: NodeProps<FrameNode>) {
  return <div className={'theme-frame' + (data.chosen ? ' is-selected' : '')}>
    <div className="frame-header"><Button variant="ghost" className="frame-handle" aria-label={'移动文档区：' + data.frame.title} aria-pressed={data.chosen} onPress={data.choose} onFocus={data.choose}>
      <Icon name="group" size={18}/><strong>{data.frame.title}</strong><span>{data.frame.members.length} 篇</span>
    </Button><Button className="nodrag nopan frame-edit" size="sm" variant="ghost" isIconOnly aria-label={'编辑文档区：' + data.frame.title} onPress={data.edit}><Icon name="more"/></Button></div>
    {!data.frame.members.length && <span className="frame-empty">将文档拖入这里</span>}
    {data.chosen && <NodeResizeControl className="frame-resize" position="bottom-right" minWidth={data.minimum.width} minHeight={data.minimum.height} maxWidth={10000000} maxHeight={10000000}
      onResizeEnd={(_, size) => data.resize(size.width, size.height)}><span aria-hidden="true">↘</span></NodeResizeControl>}
  </div>
}
const nodeTypes = { article: ArticleCard, frame: FrameCard }

export function LibraryCanvas({ notes, folder, theme, viewport, onViewport, onOpen, onPreview, onCreate, onSearch, beforeLeave, focus, runningNotes = [] }: {
  notes: NoteSummary[]; theme: 'light' | 'dark'; viewport: Viewport; onViewport: (viewport: Viewport) => void
  folder: string; onOpen: (name: string) => void; onPreview: (name: string) => void; onCreate: () => void; onSearch?: () => void
  beforeLeave: MutableRefObject<() => Promise<boolean>>
  /** Notes the Agent pointed at: selected and brought into view once they are on the canvas. */
  focus?: { names: string[]; key: number } | null
  runningNotes?: string[]
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
  const [helpOpen, setHelpOpen] = useState(false)
  const [zoom, setZoom] = useState(viewport.zoom)
  const [toolbarHost, setToolbarHost] = useState<HTMLElement | null>(null)
  useEffect(() => { setToolbarHost(document.getElementById('canvas-toolbar')) }, [])
  const canvasRoot = useRef<HTMLDivElement>(null)
  const pending = useRef(new Map<string, { position: NotePosition; version: number }>())
  const pendingVersion = useRef<number | null>(null)
  const queue = useRef<Promise<boolean>>(Promise.resolve(true))
  const version = useRef(0)
  const loadAction = useRef<() => Promise<void>>(async () => {})
  const apply = useCallback((next: CanvasNode[]) => { nodeRef.current = next; setNodes(next) }, [])
  const flow = useRef<ReactFlowInstance<CanvasNode> | null>(null)
  const focused = useRef(0)
  useEffect(() => {
    if (!focus || focused.current === focus.key || !ready) return
    const present = focus.names.filter(name => nodes.some(node => node.id === name))
    if (!present.length) return
    focused.current = focus.key
    setChosen(present)
    requestAnimationFrame(() => { void flow.current?.fitView({ nodes: present.map(id => ({ id })), padding: 0.4, maxZoom: 1.2, duration: 400 }) })
  }, [focus, nodes, ready])
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
        data: { note, running: runningNotes.includes(note.name), chosen: chosen.includes(note.name), selectionCount: chosen.filter(id => notes.some(note => note.name === id)).length,
          choose: (extend = false, preserve = false) => setChosen(current => preserve && current.includes(note.name) ? current : extend ? [...current.filter(id => notes.some(note => note.name === id) && id !== note.name), note.name] : [note.name]),
          open: () => onOpen(note.name), preview: () => onPreview(note.name), group: () => createFrame(chosen.includes(note.name) ? chosen : [note.name]) },
      }
    })
    // React Flow requires parents before children. Only rendering uses relative coordinates.
    apply([...frames, ...articles])
    const available = chosen.filter(id => notes.some(note => note.name === id) || frames.some(frame => frame.id === id))
    if (available.length !== chosen.length) setChosen(available)
  }, [notes, layout, chosen, onOpen, onPreview, apply, runningNotes.join("\0")])
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
  function fitSelection() {
    if (!chosen.length) return
    void flow.current?.fitView({ nodes: chosen.map(id => ({ id })), padding: 0.35, maxZoom: 1.2, duration: 250 })
  }
  function clearSelection() {
    setChosen([])
    canvasRoot.current?.focus({ preventScroll: true })
  }
  function arrangeSelection() {
    if (!ready || selectedNotes.length < 2) return
    const current = layoutRef.current
    const positions = { ...Object.fromEntries(notes.map(note => [note.name, note.position])), ...current.positions }
    const moved: Record<string, NotePosition> = {}
    // Arrange within each existing region, never silently regroup documents.
    const groups = new Map<string, string[]>()
    for (const name of selectedNotes) {
      const region = current.frames.find(frame => frame.members.includes(name))?.id ?? ''
      groups.set(region, [...(groups.get(region) ?? []), name])
    }
    for (const [region, members] of groups) {
      if (members.length < 2) continue
      members.sort((a, b) => positions[a]!.y - positions[b]!.y || positions[a]!.x - positions[b]!.x || a.localeCompare(b))
      const left = Math.min(...members.map(name => positions[name]!.x)), top = Math.min(...members.map(name => positions[name]!.y))
      const columns = Math.ceil(Math.sqrt(members.length))
      const occupied = notes.filter(note => !members.includes(note.name) && (current.frames.find(frame => frame.members.includes(note.name))?.id ?? '') === region).map(note => positions[note.name]!)
      let cell = 0
      for (const name of members) {
        let position: NotePosition
        do {
          position = { x: left + cell % columns * 312, y: top + Math.floor(cell / columns) * 224 }
          cell++
        } while (occupied.some(other => Math.abs(other.x - position.x) < 296 && Math.abs(other.y - position.y) < 208))
        moved[name] = position
      }
    }
    if (!Object.keys(moved).length) return
    Object.assign(positions, moved)
    const frames = current.frames.map(frame => frame.members.some(name => name in moved) ? fitFrame(frame, positions) : frame)
    persist({ frames, positions }, moved)
  }
  const selectedNotes = chosen.filter(name => notes.some(note => note.name === name))
  const selectedTitle = selectedNotes.length === 1 ? notes.find(note => note.name === selectedNotes[0])?.title : undefined
  const canArrange = new Set(selectedNotes.map(name => layout.frames.find(frame => frame.members.includes(name))?.id)).size < selectedNotes.length
  const active = chosen.at(-1)
  const selectedFrame = layout.frames.find(frame => frameNodeId(frame.id) === active)

  const viewActions = <div className="canvas-view-actions" role="group" aria-label="画布视图">
          <DropdownMenu label="画布视图" align="start" trigger={<Button size="sm" variant="ghost" aria-label={`画布视图，缩放 ${Math.round(zoom * 100)}%`}>{Math.round(zoom * 100)}%<Icon name="down" size={14}/></Button>} items={[
            { label: '放大画布', icon: <Icon name="plus" size={16}/>, onSelect: () => { void flow.current?.zoomIn() } },
            { label: '缩小画布', icon: <Icon name="minus" size={16}/>, onSelect: () => { void flow.current?.zoomOut() } },
            { label: '查看全部文章', icon: <Icon name="fit" size={16}/>, disabled: !notes.length && !layout.frames.length, onSelect: () => { void flow.current?.fitView({ padding: 0.2, duration: 250 }) } },
            { label: '恢复 100% 缩放', onSelect: () => { void flow.current?.zoomTo(1, { duration: 250 }) } },
            { label: '选择全部文章', separatorBefore: true, disabled: !notes.length, onSelect: () => setChosen(notes.map(note => note.name)) },
            { label: '画布操作指南', onSelect: () => setHelpOpen(true) },
          ]}/>
          <IconButton icon="fit" label="查看全部文章" isDisabled={!notes.length && !layout.frames.length} onPress={() => { void flow.current?.fitView({ padding: 0.2, duration: 250 }) }}/>
          {onSearch && <IconButton icon="search" label="搜索文章" onPress={onSearch}/>}
        </div>

  return <div ref={canvasRoot} className="canvas-wrap canvas-workspace" tabIndex={-1} aria-label="文章画布" onKeyDownCapture={event => {
    const target = event.target as HTMLElement
    if (!event.defaultPrevented && !composing(event) && !target.closest('input,textarea,[contenteditable="true"],[role="menu"],[role="dialog"]')) {
      if (event.key === 'Escape' && chosen.length) { event.preventDefault(); event.stopPropagation(); clearSelection(); return }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); setChosen(notes.map(note => note.name)); return }
    }
    if (event.defaultPrevented || composing(event) || event.repeat || event.ctrlKey || event.metaKey || event.altKey || !active || !(event.target as HTMLElement).closest('.article-card,.frame-handle')) return
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
      <ReactFlow nodes={nodes} nodeTypes={nodeTypes} colorMode={theme} defaultViewport={viewport} nodesDraggable={ready} onInit={instance => { flow.current = instance }}
        proOptions={{ hideAttribution: true }}
        onMoveEnd={(_, view) => { setZoom(view.zoom); onViewport(view) }} onNodesChange={changes => apply(applyNodeChanges(changes, nodeRef.current))}
        onNodeDragStart={(_, node) => setChosen(current => current.includes(node.id) ? current : [node.id])} onNodeDragStop={(_, node, dragged) => {
          if (node.type === 'frame') moveFrame(node.data.frame.id, node.position); else moveArticles(Object.fromEntries(dragged.filter(node => node.type === 'article').map(node => [node.id, absolutePosition(node)])))
        }}
        onPaneClick={() => setChosen([])} nodesConnectable={false} nodesFocusable={false} elementsSelectable={false}
        deleteKeyCode={null} zoomOnDoubleClick={false} minZoom={.2} maxZoom={2} panOnScroll>
      </ReactFlow>
      {!toolbarHost && <div className="canvas-fallback-tools">{viewActions}</div>}
      {chosen.length > 0 && <div className="canvas-controls canvas-workspace-controls nodrag nopan" role="group" aria-label="画布工具">
        <div className="canvas-selection-actions" role="group" aria-label="所选内容操作">
          <span className="canvas-selection-label" title={selectedFrame?.title ?? selectedTitle} aria-live="polite">{selectedFrame ? selectedFrame.title : `已选 ${selectedNotes.length} 篇`}</span>
          {selectedNotes.length === 1 && <>
            <Button size="sm" variant="ghost" onPress={() => onPreview(selectedNotes[0]!)}>预览</Button>
            <Button size="sm" variant="secondary" onPress={() => onOpen(selectedNotes[0]!)}>编辑</Button>
          </>}
          {selectedFrame && <Button size="sm" variant="secondary" onPress={() => editFrame(selectedFrame)}>编辑文档区</Button>}
          <DropdownMenu label="整理" items={[
            { label: '定位所选内容', icon: <Icon name="fit" size={16}/>, onSelect: fitSelection },
            ...(selectedNotes.length ? [
              { label: '创建文档区', icon: <Icon name="group" size={16}/>, disabled: !ready, onSelect: () => createFrame(selectedNotes) },
              { label: '整齐排列所选文章', icon: <Icon name="grid" size={16}/>, disabled: !ready || !canArrange, onSelect: arrangeSelection },
            ] : []),
            { label: '取消选择', separatorBefore: true, onSelect: clearSelection },
          ]}/>
          <IconButton icon="close" label="取消选择" onPress={clearSelection}/>
        </div>
      </div>}
    </div>
    {toolbarHost && createPortal(viewActions, toolbarHost)}
    {!error && (saving || !ready) && <div className="canvas-save-state" role="status" aria-live="polite">{saving ? '正在保存布局…' : '正在载入布局…'}</div>}
    {ready && !notes.length && !layout.frames.length && <div className="canvas-empty canvas-empty-overlay"><EmptyState title="为想法留一个位置" description="创建文章后，预览、编辑，再将相关内容整理到文档区。" icon={<Icon name="grid" size={24}/>} action={<Button onPress={onCreate}><Icon name="plus"/>创建第一篇文章</Button>}/></div>}
    {error && <div className="banner" role="alert"><span>{error}</span><div className="toolbar"><Button size="sm" variant="outline" isDisabled={saving} onPress={() => pendingVersion.current !== null ? persist(layoutRef.current, {}) : void loadAction.current()}>重试</Button>{pendingVersion.current !== null && <Button size="sm" variant="ghost" isDisabled={saving} onPress={() => setReloadOpen(true)}>重新载入</Button>}</div></div>}
    <Dialog title="画布操作指南" open={helpOpen} onClose={() => setHelpOpen(false)} footer={<Button onPress={() => setHelpOpen(false)}>知道了</Button>}>
      <dl className="canvas-shortcuts">
        <div><dt>浏览与写作</dt><dd>单击选择文章；双击或 Enter 打开编辑；空格预览。</dd></div>
        <div><dt>选择多篇</dt><dd>按住 Shift 单击或右键追加选择；⌘ / Ctrl + A 选择全部；Esc 取消选择。</dd></div>
        <div><dt>整理与移动</dt><dd>拖动文章或用方向键移动；通过「整理」创建文档区，或按网格排列所选文章。排列保留现有分组。</dd></div>
        <div><dt>文档区</dt><dd>拖动标题可整组移动。文章拖入加入，拖出脱离；解散文档区会保留文章。</dd></div>
        <div><dt>定位与视图</dt><dd>滚动平移画布；通过缩放菜单查看全部，或通过「整理」定位所选内容。</dd></div>
      </dl>
    </Dialog>
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
