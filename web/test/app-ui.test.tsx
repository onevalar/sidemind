// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { App } from '../src/App'
import { api } from '../src/api'
import type { AgentRunDTO } from '../shared/types'

vi.mock('../src/api', () => ({
  api: { listNotes: vi.fn(), listFolders: vi.fn(), settings: vi.fn(), createFolder: vi.fn(), createNote: vi.fn(), search: vi.fn(), openWorkspaceFolder: vi.fn(), conversation: vi.fn(), changeSets: vi.fn(), agent: vi.fn(), stopAgentRun: vi.fn(), followAgent: vi.fn(), agentRun: vi.fn(), undoChangeSet: vi.fn(), acknowledgeAgentRun: vi.fn(), repoStatus: vi.fn(), push: vi.fn() },
  subscribeEvents: () => () => {},
}))
vi.mock('../src/LibraryCanvas', () => ({ LibraryCanvas: () => <div>文章画布</div> }))
vi.mock('../src/NoteWorkspace', () => ({ NoteWorkspace: ({ name }: { name: string }) => <div role="region" aria-label="文章编辑">{name}</div> }))

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  HTMLElement.prototype.scrollIntoView = vi.fn()
  vi.mocked(api.listNotes).mockResolvedValue([])
  vi.mocked(api.listFolders).mockResolvedValue([''])
  vi.mocked(api.conversation).mockResolvedValue(null)
  vi.mocked(api.changeSets).mockResolvedValue([])
  vi.mocked(api.repoStatus).mockResolvedValue({ git: true, dataDirectory: '/test', branch: 'main', changes: 0, noteChanges: 0, remote: null, ahead: null, head: null, pushing: false })
  vi.mocked(api.settings).mockImplementation(() => new Promise(() => {}))
  localStorage.clear()
})
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals() })

it('lets a clean workspace check remote updates and displays the sync result', async () => {
  vi.mocked(api.repoStatus).mockResolvedValue({ git: true, dataDirectory: '/test', branch: 'main', changes: 0, noteChanges: 0, remote: 'https://example.test/notes.git', ahead: 0, head: '1234567', pushing: false })
  vi.mocked(api.push).mockImplementation(async emit => {
    emit({ type: 'step', text: '正在拉取远端更新并同步本机提交' })
    emit({ type: 'report', report: { committed: null, message: '', notes: [], folders: [], stale: [], layout: [], pushed: true } })
  })
  render(<App/>)
  fireEvent.click(await screen.findByRole('button', { name: '同步 · 检查远端更新' }))
  expect(await screen.findByRole('dialog', { name: '同步' })).toBeTruthy()
  expect((await screen.findByRole('region', { name: '同步结果' })).textContent).toContain('已与远端同步')
  fireEvent.click(screen.getByRole('button', { name: '完成' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '同步' })).toBe(null))
})

it('opens the right-clicked folder instead of the active canvas and keeps folder-open errors visible', async () => {
  const opened: string[] = []
  vi.mocked(api.listFolders).mockResolvedValue(['', 'Work', 'Work/Research'])
  vi.mocked(api.openWorkspaceFolder).mockImplementation(async folder => { opened.push(folder); return { ok: true } })
  render(<App/>)
  const target = await screen.findByRole('button', { name: 'Work/Research' })
  expect(screen.queryByRole('button', { name: /在文件管理器中打开/ })).toBe(null)
  // A regular click still navigates; only a context-menu gesture opens actions.
  fireEvent.click(target)
  await waitFor(() => expect(target.getAttribute('aria-current')).toBe('page'))
  expect(screen.queryByRole('menu')).toBe(null)
  fireEvent.click(screen.getByRole('button', { name: '笔记文件夹' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '笔记文件夹' }).getAttribute('aria-current')).toBe('page'))
  target.focus()
  fireEvent.keyDown(target, { key: 'F10', shiftKey: true })
  const action = await screen.findByRole('menuitem', { name: '在文件管理器中打开' })
  await waitFor(() => expect(document.activeElement).toBe(action))
  fireEvent.keyDown(action, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBe(null)
  expect(document.activeElement).toBe(target)
  fireEvent.contextMenu(target, { clientX: 100, clientY: 200 })
  fireEvent.click(await screen.findByRole('menuitem', { name: '在文件管理器中打开' }))
  await waitFor(() => expect(opened).toEqual(['Work/Research']))
  expect(screen.getByRole('button', { name: '笔记文件夹' }).getAttribute('aria-current')).toBe('page')
  await waitFor(() => expect(document.activeElement).toBe(target))
  vi.mocked(api.openWorkspaceFolder).mockRejectedValueOnce(new Error('无法打开文件管理器。'))
  fireEvent.contextMenu(target, { clientX: 100, clientY: 200 })
  fireEvent.click(await screen.findByRole('menuitem', { name: '在文件管理器中打开' }))
  expect((await screen.findByRole('alert')).textContent).toContain('无法打开文件管理器。')
  expect(screen.getByRole('button', { name: '笔记文件夹' }).getAttribute('aria-current')).toBe('page')
})

it('remembers a collapsed sidebar while keeping search, creation and settings accessible', async () => {
  const app = render(<App/>)
  await screen.findByText('文章画布')
  fireEvent.click(screen.getByRole('button', { name: '折叠侧边栏' }))
  expect(screen.queryByRole('navigation', { name: '文件夹' })).toBe(null)
  expect(screen.getByRole('button', { name: '展开侧边栏' }).getAttribute('aria-expanded')).toBe('false')
  expect(screen.getByRole('button', { name: '搜索笔记' })).toBeTruthy()
  expect(screen.getAllByRole('button', { name: '新建文章' }).length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole('button', { name: '设置' }))
  expect(await screen.findByRole('dialog', { name: '设置' })).toBeTruthy()
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
  vi.mocked(api.search).mockResolvedValue([{ name: '观察.md', title: '观察记录', excerpt: '摘要中没有查询词', snippet: '截断的正文片段', space: '', mtime: 1, position: { x: 0, y: 0 } }])
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
  vi.mocked(api.listNotes).mockResolvedValue([{ name: '参考.md', title: '参考文章', excerpt: '', space: '', mtime: 1, position: { x: 0, y: 0 } }])
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

it('offers an Agent on the canvas, preserves its conversation when hidden and supports pure chat without notes', async () => {
  vi.mocked(api.listFolders).mockResolvedValue(['', 'Work'])
  const none = { configured: false, keySaved: false, model: '', baseUrl: '', source: 'none' as const }
  vi.mocked(api.settings).mockResolvedValue({ notesDirectory: '/test/notes', dataDirectory: '/test', summary: none, embedding: none, ai: { configured: true, keySaved: true, model: 'test-model', baseUrl: 'https://example.test/v1', source: 'saved' }, chatgpt: { configured: false, accounts: [], activeAccountId: null, model: '', loginStatus: 'idle' } })
  vi.mocked(api.agent).mockImplementation(async (input, emit) => {
    emit({ type: 'session', id: 'conversation-1' })
    emit({ type: 'message', text: input.scope.kind === 'chat' ? '你好，今天想聊什么？' : '这些笔记主要讨论反射。\n\n[光的反射](Work/%E5%85%89%E7%9A%84%E5%8F%8D%E5%B0%84.md)' })
    emit({ type: 'done' })
    return null
  })
  render(<App/>)
  await screen.findByText('文章画布')
  await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Work' })) })
  expect(screen.getByRole('button', { name: 'AI 助手', pressed: true }).title).toBe('关闭 AI 助手')
  const input = screen.getByRole('textbox', { name: 'AI 消息' }) as HTMLTextAreaElement
  fireEvent.click(screen.getByRole('button', { name: '概括笔记' }))
  expect(input.value).toBe('看看这个文件夹的文章和记忆，介绍主要主题和它们之间的联系。')
  expect(document.activeElement).toBe(input)
  expect(screen.queryByRole('log', { name: 'AI 对话' })).toBe(null)
  await act(async () => { fireEvent.change(input, { target: { value: '介绍这些文章' } }); fireEvent.keyDown(input, { key: 'Enter' }) })
  expect(await screen.findByText('这些笔记主要讨论反射。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '关闭 AI 助手' }))
  expect(screen.queryByRole('textbox', { name: 'AI 消息' })).toBe(null)
  expect(screen.getByRole('button', { name: 'AI 助手', pressed: false }).title).toBe('打开 AI 助手')
  fireEvent.click(screen.getByRole('button', { name: 'AI 助手' }))
  expect(screen.getByRole('button', { name: 'AI 助手', pressed: true }).title).toBe('关闭 AI 助手')
  expect(screen.getByText('这些笔记主要讨论反射。')).toBeTruthy()
  fireEvent.click(screen.getByRole('combobox', { name: '对话范围' }))
  fireEvent.click(await screen.findByRole('option', { name: '纯聊天 · 不读取笔记' }))
  expect(screen.queryByText('这些笔记主要讨论反射。')).toBe(null)
  fireEvent.change(input, { target: { value: '你好' } })
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
  expect(screen.queryByText('你好，今天想聊什么？')).toBe(null)
  await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
  expect(await screen.findByText('你好，今天想聊什么？')).toBeTruthy()
  expect(vi.mocked(api.agent).mock.calls.at(-1)![0]).toEqual({ scope: { kind: 'chat', folder: '' }, session: undefined, message: '你好' })
  fireEvent.click(screen.getByRole('combobox', { name: '对话范围' }))
  fireEvent.click(await screen.findByRole('option', { name: '文件夹 · Work' }))
  expect(screen.getByText('这些笔记主要讨论反射。')).toBeTruthy()
  // Stopping is a request to the server; the page keeps listening until the run reports it has ended.
  const stopped = { id: 'run-2', scope: { kind: 'folder' as const, folder: 'Work' }, requestKey: 'k', status: 'cancelled' as const, seq: 3, error: '已停止。已完成的修改保留在修改记录中，可以撤销。', createdAt: 1, updatedAt: 2 }
  let endRun: (run: typeof stopped) => void = () => {}
  vi.mocked(api.stopAgentRun).mockImplementation(async () => { endRun(stopped); return stopped })
  vi.mocked(api.agent).mockImplementationOnce(async (_, emit, __, hooks) => {
    hooks?.onRun?.({ ...stopped, status: 'running', error: undefined })
    emit({ type: 'delta', text: '继续分析这些笔记的关联…' })
    return new Promise(resolve => { endRun = resolve })
  })
  await act(async () => { fireEvent.change(input, { target: { value: '继续分析' } }); fireEvent.click(screen.getByRole('button', { name: '发送消息' })) })
  expect(await screen.findByText('继续分析这些笔记的关联…')).toBeTruthy()
  expect(screen.getByText(/任务在后台运行/)).toBeTruthy()
  expect(screen.getByRole('button', { name: '开始新对话' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('combobox', { name: '对话范围' }).hasAttribute('disabled')).toBe(true)
  fireEvent.change(input, { target: { value: '下一条消息草稿' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '停止生成' })) })
  expect(api.stopAgentRun).toHaveBeenCalledWith('run-2')
  expect((await screen.findByText(/已停止/)).getAttribute('role')).toBe('status')
  expect(screen.queryByRole('alert')).toBe(null)
  expect(screen.queryByText('继续分析这些笔记的关联…')).toBe(null)
  expect(screen.getByRole('button', { name: '发送消息' }).hasAttribute('disabled')).toBe(false)
  expect(input.value).toBe('下一条消息草稿')
  fireEvent.click(screen.getByRole('link', { name: '光的反射' }))
  expect((await screen.findByRole('region', { name: '文章编辑' })).textContent).toBe('Work/光的反射.md')
})

const running = { id: 'run-9', scope: { kind: 'folder' as const, folder: '' }, requestKey: 'k', status: 'running' as const, seq: 4, createdAt: 1, updatedAt: 2 }
const configured = () => {
  const none = { configured: false, keySaved: false, model: '', baseUrl: '', source: 'none' as const }
  vi.mocked(api.settings).mockResolvedValue({ notesDirectory: '/test/notes', dataDirectory: '/test', summary: none, embedding: none, ai: { configured: true, keySaved: true, model: 'test-model', baseUrl: 'https://example.test/v1', source: 'saved' }, chatgpt: { configured: false, accounts: [], activeAccountId: null, model: '', loginStatus: 'idle' } })
}

it('follows a request that was still running when the page opened, without repeating the messages it already wrote', async () => {
  configured()
  vi.mocked(api.conversation).mockResolvedValue({ id: 'c1', scope: running.scope, updatedAt: 1, messages: [{ role: 'user' as const, text: '整理一下' }, { role: 'assistant' as const, text: '已读取两篇。' }], changes: [], proposals: [], plan: [], activeRun: running })
  let end: (run: AgentRunDTO) => void = () => {}
  vi.mocked(api.followAgent).mockImplementation(async (_, emit) => {
    emit({ type: 'message', text: '已读取两篇。' })
    emit({ type: 'message', text: '正在整理…' })
    return new Promise(resolve => { end = resolve })
  })
  render(<App/>)
  expect(await screen.findByText('正在整理…')).toBeTruthy()
  expect(api.followAgent).toHaveBeenCalledWith('run-9', expect.any(Function), expect.any(AbortSignal))
  expect(screen.getAllByText('已读取两篇。')).toHaveLength(1)
  expect(screen.getByText('整理一下')).toBeTruthy()
  expect(screen.getByText(/任务在后台运行/)).toBeTruthy()
  expect(screen.getByRole('combobox', { name: '对话范围' }).hasAttribute('disabled')).toBe(true)
  await act(async () => { end({ ...running, status: 'completed' }) })
  await waitFor(() => expect(screen.queryByText(/任务在后台运行/)).toBe(null))
  expect(screen.getByRole('combobox', { name: '对话范围' }).hasAttribute('disabled')).toBe(false)
  expect(api.stopAgentRun).not.toHaveBeenCalled()
})

it('does not stop a running request when the panel is closed or the page goes away', async () => {
  configured()
  let signal: AbortSignal | undefined
  vi.mocked(api.agent).mockImplementation(async (_, emit, abort, hooks) => {
    signal = abort
    hooks?.onRun?.(running)
    emit({ type: 'delta', text: '分析进行中…' })
    return new Promise(() => {})
  })
  const view = render(<App/>)
  await screen.findByText('文章画布')
  const input = screen.getByRole('textbox', { name: 'AI 消息' })
  await act(async () => { fireEvent.change(input, { target: { value: '开始' } }); fireEvent.keyDown(input, { key: 'Enter' }) })
  expect(await screen.findByText('分析进行中…')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '关闭 AI 助手' }))
  fireEvent.click(screen.getByRole('button', { name: 'AI 助手' }))
  expect(screen.getByText('分析进行中…')).toBeTruthy()
  expect(screen.getByText(/任务在后台运行/)).toBeTruthy()
  view.unmount()
  // Leaving only detaches this page from the run; nothing asks the server to stop it.
  expect(signal!.aborted).toBe(true)
  expect(api.stopAgentRun).not.toHaveBeenCalled()
})

it('shows a run a restart stopped after it changed notes as needing a check, with the changes it made, until the user acknowledges it', async () => {
  configured()
  const change = { id: 'cs-1', request: '创建两篇', createdAt: 1, files: [{ name: '重启前.md', kind: 'create' as const }], layouts: [], undone: false, undoable: true, origin: 'agent' as const }
  const stopped = { ...running, status: 'recovery_required' as const, changes: ['cs-1'], error: '服务重启时这次任务尚未完成。它已经修改了 1 处笔记，但没有完成，可能只做了一部分。' }
  vi.mocked(api.conversation).mockResolvedValue({ id: 'c1', scope: running.scope, updatedAt: 1, messages: [{ role: 'user' as const, text: '创建两篇' }], changes: [change as never], proposals: [], plan: [], recovery: [stopped] })
  vi.mocked(api.acknowledgeAgentRun).mockResolvedValue({ ...stopped, status: 'interrupted' })
  render(<App/>)
  const warning = await screen.findByRole('alert', { name: '需要检查的中断任务' })
  expect(warning.textContent).toContain('已经修改了 1 处笔记')
  expect(within(warning).getByRole('button', { name: /查看：1 篇文章/ })).toBeTruthy()
  fireEvent.click(within(warning).getByRole('button', { name: '我已检查' }))
  await waitFor(() => expect(api.acknowledgeAgentRun).toHaveBeenCalledWith('run-9'))
  await waitFor(() => expect(screen.queryByRole('alert', { name: '需要检查的中断任务' })).toBe(null))
})

it.each([['Chrome/Firefox', { isComposing: true }], ['Safari', { keyCode: 229 }]])('does not send the Agent message when Enter only confirms an input-method candidate (%s)', async (_, init) => {
  configured()
  vi.mocked(api.agent).mockImplementation(async (_message, _emit, _signal, hooks) => { hooks?.onRun?.(running); return new Promise(() => {}) })
  render(<App/>)
  await screen.findByText('文章画布')
  const input = screen.getByRole('textbox', { name: 'AI 消息' })
  fireEvent.change(input, { target: { value: 'zhong' } })
  fireEvent.keyDown(input, { key: 'Enter', ...init })
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(api.agent).not.toHaveBeenCalled()
  expect((input as HTMLTextAreaElement).value).toBe('zhong')
  await act(async () => { fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 }) })
  expect(api.agent).toHaveBeenCalledTimes(1)
})

it('does not open the highlighted search result when Enter only confirms an input-method candidate', async () => {
  vi.mocked(api.listNotes).mockResolvedValue([{ name: '光的反射.md', title: '光的反射', space: '', preview: '', position: { x: 0, y: 0 } } as never])
  vi.mocked(api.search).mockResolvedValue([])
  render(<App/>)
  await screen.findByText('文章画布')
  fireEvent.click(screen.getByRole('button', { name: '搜索笔记' }))
  const box = await screen.findByRole('combobox')
  fireEvent.change(box, { target: { value: 'guang' } })
  fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 })
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(screen.queryByRole('region', { name: '文章编辑' })).toBe(null)
  expect(screen.getByRole('combobox')).toBeTruthy()
})
