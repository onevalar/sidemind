// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { App } from '../src/App'
import { api } from '../src/api'

vi.mock('../src/api', () => ({
  api: { listNotes: vi.fn(), listFolders: vi.fn(), settings: vi.fn(), createFolder: vi.fn(), createNote: vi.fn(), recordOpen: vi.fn(), search: vi.fn() },
  subscribeEvents: () => () => {},
}))
vi.mock('../src/LibraryCanvas', () => ({ LibraryCanvas: () => <div>文章画布</div> }))
vi.mock('../src/NoteWorkspace', () => ({ NoteWorkspace: ({ name }: { name: string }) => <div role="region" aria-label="文章编辑">{name}</div> }))

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.mocked(api.listNotes).mockResolvedValue([])
  vi.mocked(api.listFolders).mockResolvedValue([''])
  vi.mocked(api.settings).mockImplementation(() => new Promise(() => {}))
  localStorage.clear()
})
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals() })

it('remembers a collapsed sidebar while keeping search, creation and settings accessible', async () => {
  const app = render(<App/>)
  await screen.findByText('文章画布')
  fireEvent.click(screen.getByRole('button', { name: '折叠侧边栏' }))
  expect(screen.queryByRole('navigation', { name: '文件夹' })).toBe(null)
  expect(screen.getByRole('button', { name: '展开侧边栏' }).getAttribute('aria-expanded')).toBe('false')
  expect(screen.getByRole('button', { name: '搜索笔记' })).toBeTruthy()
  expect(screen.getAllByRole('button', { name: '新建文章' }).length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole('button', { name: '设置与外观' }))
  expect(await screen.findByRole('dialog', { name: '设置与外观' })).toBeTruthy()
  app.unmount()
  render(<App/>)
  await screen.findByText('文章画布')
  expect(screen.queryByRole('navigation', { name: '文件夹' })).toBe(null)
  fireEvent.click(screen.getByRole('button', { name: '展开侧边栏' }))
  expect(screen.getByRole('navigation', { name: '文件夹' })).toBeTruthy()
})

it('submits a folder form once, preserves the name on failure, and allows retry', async () => {
  let finish!: () => void
  const folders = ['']
  vi.mocked(api.listFolders).mockImplementation(async () => [...folders])
  vi.mocked(api.createFolder).mockRejectedValueOnce(new Error('暂时无法写入'))
  vi.mocked(api.createFolder).mockImplementation(async name => {
    await new Promise<void>(resolve => { finish = resolve })
    folders.push(name)
    return { ok: true }
  })
  render(<App/>)
  await screen.findByText('文章画布')
  fireEvent.click(screen.getByRole('button', { name: '新建文件夹' }))
  const input = await screen.findByRole('textbox', { name: '文件夹名称' }) as HTMLInputElement
  fireEvent.change(input, { target: { value: '阅读与观察' } })
  const form = screen.getByRole('form', { name: '新建文件夹' })
  fireEvent.submit(form)
  expect((await screen.findByRole('alert')).textContent).toContain('名称已保留')
  expect(input.value).toBe('阅读与观察')
  act(() => { fireEvent.submit(form); fireEvent.submit(form) })
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  expect(screen.getByRole('button', { name: '正在创建…' }).hasAttribute('disabled')).toBe(true)
  await act(async () => { finish() })
  await waitFor(() => expect(screen.queryByRole('form', { name: '新建文件夹' })).toBe(null))
  expect(folders).toEqual(['', '阅读与观察'])
  expect(screen.getByRole('button', { name: '阅读与观察' }).getAttribute('aria-current')).toBe('page')
})

it('keeps a multiline article draft after a failed form submission and creates it on retry', async () => {
  const created: { title?: string; content: string; folder?: string }[] = []
  vi.mocked(api.createNote).mockRejectedValueOnce(new Error('暂时无法写入'))
  vi.mocked(api.createNote).mockImplementation(async (title, content, folder) => {
    created.push({ title, content: content ?? '', folder })
    return { name: '写作计划.md' }
  })
  render(<App/>)
  await screen.findByText('文章画布')
  fireEvent.click(screen.getAllByRole('button', { name: '新建文章' })[0]!)
  const title = await screen.findByRole('textbox', { name: '标题 （可留空）' }) as HTMLInputElement
  const body = screen.getByRole('textbox', { name: '正文 （可留空）' }) as HTMLTextAreaElement
  fireEvent.change(title, { target: { value: '写作计划' } })
  fireEvent.change(body, { target: { value: '先记录问题。\n再写下三个例子。' } })
  expect(fireEvent.keyDown(title, { key: 'Enter', isComposing: true })).toBe(false)
  fireEvent.submit(screen.getByRole('form', { name: '新建文章' }))
  expect((await screen.findByRole('alert')).textContent).toContain('输入已保留')
  expect(title.value).toBe('写作计划')
  expect(body.value).toBe('先记录问题。\n再写下三个例子。')
  fireEvent.click(screen.getByRole('button', { name: '创建并编辑' }))
  expect((await screen.findByRole('region', { name: '文章编辑' })).textContent).toBe('写作计划.md')
  expect(created).toEqual([{ title: '写作计划', content: '# 写作计划\n\n先记录问题。\n再写下三个例子。\n', folder: '' }])
})

it('opens a full-body search match without filtering it again or treating IME confirmation as selection', async () => {
  vi.mocked(api.search).mockResolvedValue([{ name: '观察.md', title: '观察记录', excerpt: '摘要中没有查询词', snippet: '截断的正文片段', space: '', mtime: 1, lastOpenedAt: 0, position: { x: 0, y: 0 } }])
  render(<App/>)
  await screen.findByText('文章画布')
  fireEvent.click(screen.getByRole('button', { name: '搜索笔记' }))
  const input = await screen.findByRole('combobox', { name: '搜索标题或正文' })
  fireEvent.change(input, { target: { value: '正文深处' } })
  await screen.findByRole('option', { name: /观察记录/ })
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  expect(screen.queryByRole('region', { name: '文章编辑' })).toBe(null)
  fireEvent.keyDown(input, { key: 'Enter' })
  expect((await screen.findByRole('region', { name: '文章编辑' })).textContent).toBe('观察.md')
})

it('returns focus to the reference action after selecting an article in nested search', async () => {
  vi.mocked(api.listNotes).mockResolvedValue([{ name: '参考.md', title: '参考文章', excerpt: '', space: '', mtime: 1, lastOpenedAt: 0, position: { x: 0, y: 0 } }])
  render(<App/>)
  await screen.findByText('文章画布')
  fireEvent.click(screen.getAllByRole('button', { name: '新建文章' })[0]!)
  const reference = await screen.findByRole('button', { name: '引用已有文章' })
  reference.focus()
  fireEvent.click(reference)
  const input = await screen.findByRole('combobox', { name: '查找要引用的笔记' })
  await waitFor(() => expect(document.activeElement).toBe(input))
  fireEvent.click(screen.getByRole('option', { name: /参考文章/ }))
  await screen.findByRole('button', { name: '移除引用：参考文章' })
  await waitFor(() => expect(document.activeElement).toBe(reference))
})
