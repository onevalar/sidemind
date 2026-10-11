import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { applyNodeChanges, Controls, NodeResizeControl, ReactFlow, type Node, type NodeProps, type ReactFlowInstance, type Viewport } from '@xyflow/react'
import type { CanvasFrame, CanvasLayout, NotePosition, NoteSummary } from '../shared/types'
import { api, subscribeEvents } from './api'
import { Button, Dialog, Icon, Input } from './ui'

type ArticleNode = Node<{ note: NoteSummary; frameTitle?: string; chosen: boolean; choose: () => void; open: () => void }, 'article'>
type FrameNode = Node<{ frame: CanvasFrame; chosen: boolean; minimum: { width: number; height: number }; choose: () => void; edit: () => void; resize: (width: number, height: number) => void }, 'frame'>
type CanvasNode = ArticleNode | FrameNode
const frameNodeId = (id: string) => 'frame:' + id
function contains(frame: CanvasFrame, position: NotePosition) {
  return position.x >= frame.position.x + 16 && position.y >= frame.position.y + 56 &&
    position.x + 280 <= frame.position.x + frame.width - 16 && position.y + 192 <= frame.position.y + frame.height - 16
}
function minimumSize(frame: CanvasFrame, positions: CanvasLayout['positions']) {
  return {
    width: Math.max(336, ...frame.members.map(name => positions[name]!.x - frame.position.x + 296)),
    height: Math.max(280, ...frame.members.map(name => positions[name]!.y - frame.position.y + 208)),
  }
}
function ArticleCard({ data }: NodeProps<ArticleNode>) {
  return <button type="button" className={'article-card' + (data.chosen ? ' is-selected' : '')} aria-label={data.note.title}
    aria-pressed={data.chosen} onClick={data.choose} onFocus={data.choose} onDoubleClick={data.open}>
    {data.frameTitle && <span className="article-label"><Icon name="group" size={14}/><span>{data.frameTitle}</span></span>}
    <strong title={data.note.title}>{data.note.title}</strong>
    <span className="article-summary">{data.note.excerpt || '还没有正文，双击开始写作。'}</span>
    <span className="article-footer"><Icon name="note" size={13}/><span>{data.note.name.split('/').at(-1)}</span></span>
  </button>
}
function FrameCard({ data }: NodeProps<FrameNode>) {
  return <div className={'theme-frame' + (data.chosen ? ' is-selected' : '')}>
    <div className="frame-header"><button type="button" className="frame-handle" aria-label={'移动底板：' + data.frame.title} aria-pressed={data.chosen} onClick={data.choose} onFocus={data.choose}>
      <Icon name="group" size={18}/><strong>{data.frame.title}</strong><span>{data.frame.members.length} 篇</span>
    </button><Button className="nodrag nopan frame-edit" size="sm" variant="ghost" isIconOnly aria-label={'编辑底板：' + data.frame.title} onPress={data.edit}><Icon name="more"/></Button></div>
    {!data.frame.members.length && <span className="frame-empty">将文章完整拖入这里<br/>拖动标题可整组移动</span>}
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
  const flow = useRef<ReactFlowInstance<CanvasNode> | null>(null)
  const host = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<CanvasLayout>({ frames: [], positions: {} })
  const layoutRef = useRef(layout)
  const savedFrames = useRef<CanvasFrame[]>([])
  const [ready, setReady] = useState(false)
  const [chosen, setChosen] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<{ id: string | null; title: string; width: string; height: string } | null>(null)
  const [formError, setFormError] = useState('')
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
        style: { width: frame.width, height: frame.height }, data: { frame, chosen: chosen === id, minimum: minimumSize(frame, layout.positions),
          choose: () => setChosen(id), edit: () => editFrame(frame), resize: (width, height) => resizeFrame(frame.id, width, height) } }
    })
    const articles: ArticleNode[] = notes.map(note => {
      const old = previous.get(note.name)
      const frame = layout.frames.find(frame => frame.members.includes(note.name))
      const absolute = layout.positions[note.name] ?? note.position
      return {
        id: note.name, type: 'article', parentId: frame ? frameNodeId(frame.id) : undefined, zIndex: 1,
        position: old?.dragging ? old.position : frame ? { x: absolute.x - frame.position.x, y: absolute.y - frame.position.y } : absolute,
        dragging: old?.dragging, measured: old?.measured, data: { note, frameTitle: frame?.title, chosen: chosen === note.name, choose: () => setChosen(note.name), open: () => onOpen(note.name) },
      }
    })
    // React Flow requires parents before children. Only rendering uses relative coordinates.
    apply([...frames, ...articles])
    if (chosen && !notes.some(note => note.name === chosen) && !frames.some(frame => frame.id === chosen)) setChosen(null)
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

  function moveArticle(name: string, position: NotePosition) {
    if (!ready) return
    const current = layoutRef.current
    const previous = current.frames.find(frame => frame.members.includes(name))
    const destination = previous && contains(previous, position) ? previous : [...current.frames].reverse().find(frame => contains(frame, position))
    const frames = current.frames.map(frame => ({ ...frame, members: frame.id === destination?.id ? [...frame.members.filter(member => member !== name), name] : frame.members.filter(member => member !== name) }))
    persist({ frames, positions: { ...current.positions, [name]: position } }, { [name]: position })
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
    setChosen(frameNodeId(frame.id)); setFormError('')
    setForm({ id: frame.id, title: frame.title, width: String(frame.width), height: String(frame.height) })
  }
  function submitFrame() {
    if (!form || !form.title.trim()) return
    const current = layoutRef.current, existing = current.frames.find(frame => frame.id === form.id)
    const width = Number(form.width), height = Number(form.height), minimum = existing ? minimumSize(existing, current.positions) : { width: 336, height: 280 }
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < minimum.width || height < minimum.height || width > 10000000 || height > 10000000) {
      setFormError(`底板至少需要 ${Math.ceil(minimum.width)} × ${Math.ceil(minimum.height)}，以容纳已有文章。`); return
    }
    const bounds = host.current!.getBoundingClientRect()
    const center = flow.current!.screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 })
    const selected = notes.find(note => note.name === chosen), article = selected ? current.positions[selected.name] ?? selected.position : null
    const frame: CanvasFrame = existing ? { ...existing, title: form.title.trim(), width, height } : {
      id: crypto.randomUUID(), space: folder, title: form.title.trim(), width, height, members: [],
      position: article ? { x: article.x - 24, y: article.y - 64 } : { x: center.x - width / 2, y: center.y - height / 2 },
    }
    if (!existing) frame.members = notes.filter(note => !current.frames.some(frame => frame.members.includes(note.name)) && contains(frame, current.positions[note.name] ?? note.position)).map(note => note.name)
    persist({ ...current, frames: existing ? current.frames.map(old => old.id === frame.id ? frame : old) : [...current.frames, frame] }, {})
    setChosen(frameNodeId(frame.id)); setForm(null)
  }
  function absolutePosition(node: CanvasNode): NotePosition {
    const parent = node.parentId ? nodeRef.current.find(parent => parent.id === node.parentId) : null
    return parent ? { x: parent.position.x + node.position.x, y: parent.position.y + node.position.y } : node.position
  }
  const selectedFrame = layout.frames.find(frame => frameNodeId(frame.id) === chosen)

  return <div ref={host} className="canvas-wrap" onKeyDownCapture={event => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey || !chosen || !(event.target as HTMLElement).closest('.article-card,.frame-handle')) return
    if (!selectedFrame && (event.key === ' ' || event.key === 'Enter')) {
      event.preventDefault(); event.stopPropagation()
      if (event.key === ' ') onPreview(chosen); else onOpen(chosen)
    }
    const movement: Record<string, NotePosition> = { ArrowLeft: { x: -20, y: 0 }, ArrowRight: { x: 20, y: 0 }, ArrowUp: { x: 0, y: -20 }, ArrowDown: { x: 0, y: 20 } }
    const delta = movement[event.key]
    if (delta) {
      event.preventDefault(); event.stopPropagation()
      const node = nodeRef.current.find(node => node.id === chosen)
      if (!node) return
      const absolute = absolutePosition(node), position = { x: absolute.x + delta.x, y: absolute.y + delta.y }
      if (selectedFrame) moveFrame(selectedFrame.id, position); else moveArticle(chosen, position)
    }
  }}>
    <div className="canvas">
      <ReactFlow nodes={nodes} nodeTypes={nodeTypes} colorMode={theme} defaultViewport={viewport} onInit={instance => { flow.current = instance }} nodesDraggable={ready}
        ariaLabelConfig={{ 'controls.zoomIn.ariaLabel': '放大画布', 'controls.zoomOut.ariaLabel': '缩小画布', 'controls.fitView.ariaLabel': '查看全部文章' }}
        onMoveEnd={(_, view) => onViewport(view)} onNodesChange={changes => apply(applyNodeChanges(changes, nodeRef.current))}
        onNodeDragStart={(_, node) => setChosen(node.id)} onNodeDragStop={(_, node) => {
          if (node.type === 'frame') moveFrame(node.data.frame.id, node.position); else moveArticle(node.id, absolutePosition(node))
        }}
        onPaneClick={() => setChosen(null)} nodesConnectable={false} nodesFocusable={false} elementsSelectable={false}
        deleteKeyCode={null} zoomOnDoubleClick={false} minZoom={.2} maxZoom={2} panOnScroll>
        <Controls showInteractive={false}/>
      </ReactFlow>
    </div>
    {ready && !notes.length && !layout.frames.length && <div className="canvas-empty canvas-empty-overlay"><Icon name="grid" size={30}/><h1>为想法留一个位置</h1><p className="muted">创建文章自由摆放，或先建底板划分主题区域。</p><Button onPress={onCreate}><Icon name="plus"/>创建第一篇文章</Button></div>}
    <Button className="canvas-add-frame" size="sm" variant="ghost" isDisabled={!ready} onPress={() => { setFormError(''); setForm({ id: null, title: '', width: '640', height: '320' }) }}><Icon name="group" size={16}/>新建底板</Button>
    <span className="layout-status muted" role="status">{saving ? '正在保存布局…' : error ? '布局未保存' : ready ? '布局已保存' : '正在载入布局…'}</span>
    {error && <div className="banner" role="alert"><span>{error}</span><div className="toolbar"><Button size="sm" variant="outline" isDisabled={saving} onPress={() => pendingVersion.current !== null ? persist(layoutRef.current, {}) : void loadAction.current()}>重试</Button>{pendingVersion.current !== null && <Button size="sm" variant="ghost" isDisabled={saving} onPress={() => setReloadOpen(true)}>重新载入</Button>}</div></div>}
    <div className={'canvas-actions' + (chosen ? '' : ' is-idle')}>{selectedFrame ? <><span>{selectedFrame.members.length} 篇文章 · 拖动标题整组移动</span><Button variant="secondary" size="sm" onPress={() => editFrame(selectedFrame)}>编辑底板</Button></> : chosen ? <><Button variant="ghost" size="sm" onPress={() => onPreview(chosen)}>预览</Button><Button variant="secondary" size="sm" onPress={() => onOpen(chosen)}>打开文章</Button></> : <span>拖动卡片整理思路 · 双击继续写作</span>}</div>
    <Dialog title={form?.id ? '编辑主题底板' : '新建主题底板'} open={!!form} onClose={() => setForm(null)} footer={<>
      {form?.id && <Button variant="ghost" onPress={() => { const current = layoutRef.current; persist({ ...current, frames: current.frames.filter(frame => frame.id !== form.id) }, {}); setForm(null); setChosen(null) }}>解散底板</Button>}
      <Button variant="ghost" onPress={() => setForm(null)}>取消</Button><Button type="submit" form="theme-frame-form" isDisabled={!form?.title.trim()}>{form?.id ? '保存底板' : '创建底板'}</Button>
    </>}>
      <form id="theme-frame-form" onSubmit={event => { event.preventDefault(); submitFrame() }}>
      <div className="new-note-fields"><label htmlFor="frame-title">底板名称</label><Input id="frame-title" value={form?.title ?? ''} maxLength={80} autoFocus fullWidth placeholder="例如：阅读资料、项目 A" onChange={event => setForm(current => current && { ...current, title: event.target.value })}/>
        <div className="frame-size-fields"><div><label htmlFor="frame-width">宽度</label><Input id="frame-width" type="number" step="any" required value={form?.width ?? ''} min={336} max={10000000} aria-describedby={formError ? 'frame-size-error' : undefined} fullWidth onChange={event => { setFormError(''); setForm(current => current && { ...current, width: event.target.value }) }}/></div><div><label htmlFor="frame-height">高度</label><Input id="frame-height" type="number" step="any" required value={form?.height ?? ''} min={280} max={10000000} aria-describedby={formError ? 'frame-size-error' : undefined} fullWidth onChange={event => { setFormError(''); setForm(current => current && { ...current, height: event.target.value }) }}/></div></div>
      </div><p className="muted">文章完整拖入底板后加入，拖出后独立移动。拖动底板标题会带着已加入的文章一起移动。</p><p className="muted">解散底板只移除背景，文章、正文和当前位置都保留。</p>{formError && <p id="frame-size-error" className="error-text" role="alert">{formError}</p>}
      </form>
    </Dialog>
    <Dialog title="重新载入画布" open={reloadOpen} onClose={() => setReloadOpen(false)} footer={<><Button variant="ghost" onPress={() => setReloadOpen(false)}>保留修改</Button><Button onPress={() => { version.current++; pending.current.clear(); pendingVersion.current = null; setReloadOpen(false); void loadAction.current() }}>放弃未保存布局并重新载入</Button></>}><p>仅放弃这次未保存的底板和文章位置修改，Markdown 正文不会改变。</p></Dialog>
  </div>
}
