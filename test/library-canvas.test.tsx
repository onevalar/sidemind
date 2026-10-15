// @vitest-environment jsdom
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ReactFlowProps } from '@xyflow/react'
import { NoteStore } from '../server/store'
import { createApp } from '../server/app'
import { EventBus } from '../server/events'
import { LibraryCanvas } from '../src/LibraryCanvas'
import { api } from '../src/api'

vi.mock('../src/api', () => ({ api: { canvas: vi.fn(), saveCanvas: vi.fn() }, subscribeEvents: () => () => {} }))
// Render the node components without the browser-only pan/zoom engine. All actions
// still use the real menus, card keyboard handlers and filesystem-backed API.
vi.mock('@xyflow/react', async importOriginal => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  ReactFlow: ({ nodes, nodeTypes, nodesDraggable }: ReactFlowProps) => <div data-testid="canvas" aria-busy={!nodesDraggable}>{nodes?.map(node => {
    const Component = nodeTypes![node.type!]!
    return <Component key={node.id} id={node.id} type={node.type!} data={node.data} selected={!!node.selected}
      dragging={false} draggable selectable deletable zIndex={0} isConnectable={false}
      positionAbsoluteX={node.position.x} positionAbsoluteY={node.position.y}/>
  })}</div>,
  Controls: () => null,
  NodeResizeControl: () => null,
}))

let dir: string, store: NoteStore
beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cn-canvas-ui-'))
  store = new NoteStore(dir)
  await store.init()
  await store.createFolder('Work')
  for (const title of ['A', 'B', 'C']) await store.create(title, `# ${title}\n\nOriginal ${title}.`, 'Work')
  await store.savePositions({ 'Work/A.md': { x: 91, y: 173 }, 'Work/B.md': { x: 403, y: 173 }, 'Work/C.md': { x: 15, y: 201 } })
  const app = createApp(store, new EventBus())
  vi.mocked(api.canvas).mockImplementation(async folder => (await app.request('/api/canvas?folder=' + encodeURIComponent(folder), { headers: { host: 'localhost:3001' } })).json())
  vi.mocked(api.saveCanvas).mockImplementation(async (folder, frames, positions, expectedFrames) => {
    const response = await app.request('/api/canvas', { method: 'PUT', headers: { host: 'localhost:3001', 'content-type': 'application/json' }, body: JSON.stringify({ folder, frames, positions, expectedFrames }) })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error)
    return result
  })
})
afterEach(async () => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); await fs.rm(dir, { recursive: true, force: true }) })

it('groups only Shift-right-click selections, then auto-fits an entering card without moving other documents', async () => {
  const notes = (await store.list()).filter(note => note.space === 'Work')
  const opened: string[] = [], previewed: string[] = []
  const props = { notes, folder: 'Work', theme: 'light' as const, viewport: { x: 0, y: 0, zoom: 1 }, onViewport: () => {}, onOpen: (name: string) => opened.push(name), onPreview: (name: string) => previewed.push(name), onCreate: () => {}, beforeLeave: { current: async () => true } }
  const canvas = render(<LibraryCanvas {...props}/>)
  await waitFor(() => expect(screen.getByRole('button', { name: 'A' })).toBeTruthy())
  // Wait for the initial layout to be read before using the menu.
  await waitFor(() => expect(screen.getByTestId('canvas').getAttribute('aria-busy')).toBe('false'))
  const first = screen.getByRole('button', { name: 'A' })
  fireEvent.click(first)
  expect(first.getAttribute('aria-pressed')).toBe('true')
  expect(screen.queryByRole('menu')).toBe(null)
  fireEvent.doubleClick(first)
  expect(opened).toEqual(['Work/A.md'])
  fireEvent.keyDown(first, { key: 'F10', shiftKey: true })
  const previewAction = await screen.findByRole('menuitem', { name: '预览文章' })
  fireEvent.keyDown(previewAction, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '打开并编辑' }))
  // Menu navigation must not move the underlying article.
  expect((await store.canvas('Work')).positions['Work/A.md']).toEqual({ x: 91, y: 173 })
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  expect(document.activeElement).toBe(first)
  fireEvent.keyDown(first, { key: ' ' })
  expect(previewed).toEqual(['Work/A.md'])
  fireEvent.contextMenu(first, { clientX: 100, clientY: 100 })
  await screen.findByRole('menuitem', { name: '创建文档区' })
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  fireEvent.contextMenu(screen.getByRole('button', { name: 'B' }), { shiftKey: true, clientX: 400, clientY: 100 })
  await screen.findByText('已选择 2 篇文章')
  fireEvent.click(screen.getByRole('menuitem', { name: '创建文档区' }))
  await waitFor(async () => expect((await store.canvas('Work')).frames[0]?.members).toEqual(['Work/A.md', 'Work/B.md']))
  const grouped = await store.canvas('Work')
  expect(grouped.frames[0]).toMatchObject({ position: { x: 67, y: 109 }, width: 640, height: 280 })
  expect(grouped.positions).toEqual({ 'Work/A.md': { x: 91, y: 173 }, 'Work/B.md': { x: 403, y: 173 }, 'Work/C.md': { x: 15, y: 201 } })

  // C's centre enters the region, but its left edge stays outside the old bounds.
  const third = screen.getByRole('button', { name: 'C' })
  fireEvent.focus(third)
  fireEvent.keyDown(third, { key: 'ArrowLeft' })
  await waitFor(async () => expect((await store.canvas('Work')).frames[0]?.members).toContain('Work/C.md'))
  const fitted = await store.canvas('Work')
  expect(fitted.frames[0]).toMatchObject({ position: { x: -29, y: 109 }, width: 736, height: 308 })
  expect(fitted.positions).toEqual({ 'Work/A.md': { x: 91, y: 173 }, 'Work/B.md': { x: 403, y: 173 }, 'Work/C.md': { x: -5, y: 201 } })
  for (const title of ['A', 'B', 'C']) expect((await store.load(`Work/${title}.md`)).content).toBe(`# ${title}\n\nOriginal ${title}.`)
  canvas.unmount()
  render(<LibraryCanvas {...props}/>)
  expect((await screen.findByRole('button', { name: '移动文档区：文档区' })).textContent).toContain('3 篇')
  expect(await new NoteStore(dir).canvas('Work')).toEqual(fitted)
})


it('exposes preview and editing only for the selection, and clears selection without changing the layout', async () => {
  const notes = (await store.list()).filter(note => note.space === 'Work')
  const onOpen = vi.fn(), onPreview = vi.fn()
  render(<LibraryCanvas notes={notes} folder="Work" theme="light" viewport={{ x: 0, y: 0, zoom: 1 }} onViewport={() => {}} onOpen={onOpen} onPreview={onPreview} onCreate={() => {}} beforeLeave={{ current: async () => true }}/>)
  await waitFor(() => expect(screen.getByTestId('canvas').getAttribute('aria-busy')).toBe('false'))
  expect(screen.queryByRole('group', { name: '所选内容操作' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'B' }))
  const actions = screen.getByRole('group', { name: '所选内容操作' })
  fireEvent.click(within(actions).getByRole('button', { name: '预览' }))
  fireEvent.click(within(actions).getByRole('button', { name: '编辑' }))
  expect(onPreview).toHaveBeenCalledWith('Work/B.md')
  expect(onOpen).toHaveBeenCalledWith('Work/B.md')
  fireEvent.click(within(actions).getByRole('button', { name: '取消选择' }))
  expect(screen.queryByRole('group', { name: '所选内容操作' })).toBeNull()
  expect(document.activeElement).toBe(screen.getByLabelText('文章画布'))
  expect(api.saveCanvas).not.toHaveBeenCalled()
  fireEvent.keyDown(screen.getByLabelText('文章画布'), { key: 'a', metaKey: true })
  expect(screen.getByText('已选 3 篇')).toBeTruthy()
  fireEvent.keyDown(screen.getByLabelText('文章画布'), { key: 'Escape' })
  expect(screen.queryByRole('group', { name: '所选内容操作' })).toBeNull()
})

it('arranges selected documents within their regions and retains unsaved conflict protection', async () => {
  const before = await store.canvas('Work')
  const region = { id: 'reading', space: 'Work', title: 'Reading', members: ['Work/A.md', 'Work/B.md'], position: { x: 67, y: 109 }, width: 640, height: 280 }
  await api.saveCanvas('Work', [region], before.positions, [])
  const notes = (await store.list()).filter(note => note.space === 'Work')
  const beforeLeave = { current: async () => true }
  render(<LibraryCanvas notes={notes} folder="Work" theme="dark" viewport={{ x: 0, y: 0, zoom: 1 }} onViewport={() => {}} onOpen={() => {}} onPreview={() => {}} onCreate={() => {}} beforeLeave={beforeLeave}/>)
  await waitFor(() => expect(screen.getByTestId('canvas').getAttribute('aria-busy')).toBe('false'))
  // Move B down first so explicit arranging produces a meaningful grid change.
  const second = screen.getByRole('button', { name: 'B' })
  fireEvent.focus(second)
  fireEvent.keyDown(second, { key: 'ArrowDown' })
  await waitFor(async () => expect((await store.canvas('Work')).positions['Work/B.md']?.y).toBe(193))
  fireEvent.keyDown(second, { key: 'a', ctrlKey: true })
  fireEvent.pointerDown(screen.getByRole('button', { name: '整理' }), { button: 0, ctrlKey: false, pointerType: 'mouse' })
  fireEvent.click(await screen.findByRole('menuitem', { name: '整齐排列所选文章' }))
  await waitFor(async () => expect((await store.canvas('Work')).positions['Work/B.md']).toEqual({ x: 403, y: 173 }))
  const arranged = await store.canvas('Work')
  expect(arranged.frames[0]?.members).toEqual(['Work/A.md', 'Work/B.md'])
  expect(arranged.positions['Work/C.md']).toEqual(before.positions['Work/C.md'])
  expect(await beforeLeave.current()).toBe(true)
  for (const title of ['A', 'B', 'C']) expect((await store.load(`Work/${title}.md`)).content).toBe(`# ${title}\n\nOriginal ${title}.`)

  vi.mocked(api.saveCanvas).mockRejectedValueOnce(new Error('文档区已被其他窗口修改'))
  fireEvent.focus(second)
  fireEvent.keyDown(second, { key: 'ArrowRight' })
  await screen.findByRole('alert')
  expect(await beforeLeave.current()).toBe(false)
  expect((await store.canvas('Work')).positions).toEqual(arranged.positions)
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await waitFor(async () => expect(await beforeLeave.current()).toBe(true))
  expect((await store.canvas('Work')).positions['Work/B.md']).toEqual({ x: 423, y: 173 })
})

it('leaves unselected documents in place and skips occupied grid cells when arranging', async () => {
  const notes = (await store.list()).filter(note => note.space === 'Work')
  render(<LibraryCanvas notes={notes} folder="Work" theme="light" viewport={{ x: 0, y: 0, zoom: 1 }} onViewport={() => {}} onOpen={() => {}} onPreview={() => {}} onCreate={() => {}} beforeLeave={{ current: async () => true }}/>)
  await waitFor(() => expect(screen.getByTestId('canvas').getAttribute('aria-busy')).toBe('false'))
  fireEvent.click(screen.getByRole('button', { name: 'A' }))
  fireEvent.click(screen.getByRole('button', { name: 'C' }), { shiftKey: true })
  fireEvent.pointerDown(screen.getByRole('button', { name: '整理' }), { button: 0, ctrlKey: false, pointerType: 'mouse' })
  fireEvent.click(await screen.findByRole('menuitem', { name: '整齐排列所选文章' }))
  await waitFor(async () => expect((await store.canvas('Work')).positions).toEqual({
    'Work/A.md': { x: 15, y: 173 }, 'Work/B.md': { x: 403, y: 173 }, 'Work/C.md': { x: 15, y: 397 },
  }))
})


it('keeps canvas tools in the header and identifies only the article with an active AI task', async () => {
  const before = await store.canvas('Work')
  await api.saveCanvas('Work', [{ id: 'reading', space: 'Work', title: 'Reading', members: ['Work/A.md', 'Work/B.md'], position: { x: 67, y: 109 }, width: 640, height: 280 }], before.positions, [])
  const notes = (await store.list()).filter(note => note.space === 'Work')
  const onSearch = vi.fn()
  const props = { notes, folder: 'Work', theme: 'light' as const, viewport: { x: 0, y: 0, zoom: 1 }, onViewport: () => {}, onOpen: () => {}, onPreview: () => {}, onCreate: () => {}, onSearch, beforeLeave: { current: async () => true } }
  const renderWorkspace = (runningNotes: string[]) => <><header aria-label="画布顶栏"><div id="canvas-toolbar"/></header><LibraryCanvas {...props} runningNotes={runningNotes}/></>
  const view = render(renderWorkspace(['Work/A.md']))
  await waitFor(() => expect(screen.getByTestId('canvas').getAttribute('aria-busy')).toBe('false'))
  const header = screen.getByRole('banner', { name: '画布顶栏' })
  fireEvent.click(within(header).getByRole('button', { name: '搜索文章' }))
  expect(onSearch).toHaveBeenCalledOnce()
  expect(within(screen.getByLabelText('文章画布')).queryByRole('group', { name: '画布视图' })).toBeNull()
  expect(screen.queryByText('布局已保存')).toBeNull()
  expect(screen.queryByText('单击选择 · 双击编辑')).toBeNull()
  expect(screen.getAllByText('Reading')).toHaveLength(1)
  expect(screen.queryByText('A.md')).toBeNull()
  expect(within(screen.getByRole('button', { name: 'A' })).getByRole('status').textContent).toBe('AI 处理中')
  expect(within(screen.getByRole('button', { name: 'B' })).queryByRole('status')).toBeNull()
  view.rerender(renderWorkspace([]))
  await waitFor(() => expect(screen.queryByText('AI 处理中')).toBeNull())
  // Keyboard help remains available through the view menu, without permanent instructional chrome.
  fireEvent.pointerDown(within(header).getByRole('button', { name: '画布视图，缩放 100%' }), { button: 0, ctrlKey: false, pointerType: 'mouse' })
  fireEvent.click(await screen.findByRole('menuitem', { name: '画布操作指南' }))
  expect(await screen.findByRole('dialog', { name: '画布操作指南' })).toBeTruthy()
})
