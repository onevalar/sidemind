// @vitest-environment jsdom
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  const props = { notes, folder: 'Work', theme: 'light' as const, viewport: { x: 0, y: 0, zoom: 1 }, onViewport: () => {}, onOpen: () => {}, onPreview: () => {}, onCreate: () => {}, beforeLeave: { current: async () => true } }
  const canvas = render(<LibraryCanvas {...props}/>)
  await waitFor(() => expect(screen.getByRole('button', { name: 'A' })).toBeTruthy())
  // Wait for the initial layout to be read before using the menu.
  await waitFor(() => expect(screen.getByTestId('canvas').getAttribute('aria-busy')).toBe('false'))
  fireEvent.contextMenu(screen.getByRole('button', { name: 'A' }), { clientX: 100, clientY: 100 })
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
