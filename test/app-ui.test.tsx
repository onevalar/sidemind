// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { App } from '../src/App'
import { AgentPanel } from '../src/AgentPanel'
import { api } from '../src/api'
import type { AgentRunDTO } from '../shared/types'

vi.mock('../src/api', () => ({
  api: { discussions: vi.fn(), listNotes: vi.fn(), listFolders: vi.fn(), settings: vi.fn(), createFolder: vi.fn(), createNote: vi.fn(), search: vi.fn(), openWorkspaceFolder: vi.fn(), conversation: vi.fn(), changeSets: vi.fn(), agent: vi.fn(), stopAgentRun: vi.fn(), followAgent: vi.fn(), agentRuns: vi.fn(), agentRun: vi.fn(), undoChangeSet: vi.fn(), acknowledgeAgentRun: vi.fn(), repoStatus: vi.fn(), push: vi.fn(), syncStatus: vi.fn(), startSync: vi.fn(), stopSync: vi.fn() },
  subscribeEvents: () => () => {},
}))
vi.mock('../src/LibraryCanvas', () => ({ LibraryCanvas: () => <div>文章画布</div> }))
vi.mock('../src/NoteWorkspace', () => ({ NoteWorkspace: ({ name }: { name: string }) => <div role="region" aria-label="文章编辑">{name}</div> }))

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  HTMLElement.prototype.scrollIntoView = vi.fn()
  vi.mocked(api.discussions).mockResolvedValue([])
  vi.mocked(api.listNotes).mockResolvedValue([])
  vi.mocked(api.listFolders).mockResolvedValue([''])
  vi.mocked(api.conversation).mockResolvedValue(null)
  vi.mocked(api.changeSets).mockResolvedValue([])
  vi.mocked(api.agentRuns).mockResolvedValue([])
  vi.mocked(api.repoStatus).mockResolvedValue({ git: true, dataDirectory: '/test', branch: 'main', changes: 0, noteChanges: 0, remote: null, ahead: null, head: null, pushing: false })
  vi.mocked(api.settings).mockImplementation(() => new Promise(() => {}))
  vi.mocked(api.syncStatus).mockResolvedValue(null)
  localStorage.clear()
})
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals() })

it('lets a clean workspace check remote updates and displays the sync result', async () => {
  vi.mocked(api.repoStatus).mockResolvedValue({ git: true, dataDirectory: '/test', branch: 'main', changes: 0, noteChanges: 0, remote: 'https://example.test/notes.git', ahead: 0, head: '1234567', pushing: false })
  vi.mocked(api.startSync).mockResolvedValue({ id: 'sync-1', status: 'completed', enrich: false, startedAt: 1, updatedAt: 2, activity: '同步已完成', events: [], report: { committed: null, message: '', notes: [], folders: [], stale: [], layout: [], pushed: true } })
  render(<App/>)
  fireEvent.click(await screen.findByRole('button', { name: '同步 · 检查远端更新' }))
  await waitFor(() => expect(api.startSync).toHaveBeenCalledWith({ enrich: false }))
  expect(screen.queryByRole('dialog', { name: '同步' })).toBe(null)
  fireEvent.click(await screen.findByRole('button', { name: '同步详情' }))
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
  fireEvent.keyDown(screen.getByRole('button', { name: '对话范围' }), { key: 'Enter' })
  await act(async () => { fireEvent.click(await screen.findByRole('menuitem', { name: '纯聊天 · 不读取笔记' })); await new Promise(resolve => setTimeout(resolve, 30)) })
  expect(screen.queryByText('这些笔记主要讨论反射。')).toBe(null)
  fireEvent.change(input, { target: { value: '你好' } })
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
  expect(screen.queryByText('你好，今天想聊什么？')).toBe(null)
  await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
  expect(await screen.findByText('你好，今天想聊什么？')).toBeTruthy()
  expect(vi.mocked(api.agent).mock.calls.at(-1)![0]).toEqual({ scope: { kind: 'chat', folder: '' }, session: undefined, message: '你好' })
  fireEvent.keyDown(screen.getByRole('button', { name: '对话范围' }), { key: 'Enter' })
  await act(async () => { fireEvent.click(await screen.findByRole('menuitem', { name: '当前文件夹 · Work' })); await new Promise(resolve => setTimeout(resolve, 30)) })
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
  expect(screen.getByLabelText('当前任务')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '运行详情' })).toBe(null)
  expect(screen.getByRole('button', { name: '开始新对话' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: '对话范围' }).hasAttribute('disabled')).toBe(true)
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

it('stops before sending an in-flight adjustment in the same session and preserves IME input', async () => {
  configured()
  let finish!: (run: AgentRunDTO) => void
  vi.mocked(api.agent).mockImplementationOnce(async (_, emit, __, hooks) => {
    emit({ type: 'session', id: 'original-session' })
    hooks?.onRun?.(running)
    return new Promise(resolve => { finish = resolve })
  }).mockImplementationOnce(async (_, emit) => { emit({ type: 'message', text: '已经按调整继续。' }); return { ...running, status: 'completed' } })
  vi.mocked(api.stopAgentRun).mockResolvedValue(running) // An acknowledgement is not completion.
  render(<App/>); await screen.findByText('文章画布')
  const input = screen.getByRole('textbox', { name: 'AI 消息' }) as HTMLTextAreaElement
  await act(async () => { fireEvent.change(input, { target: { value: '更新两篇笔记，保留负责人' } }); fireEvent.keyDown(input, { key: 'Enter' }) })
  fireEvent.change(input, { target: { value: '时间改成周一，其他不变' } })
  expect(screen.getByRole('button', { name: '停止并发送调整' })).toBeTruthy()
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
  expect(api.stopAgentRun).not.toHaveBeenCalled()
  await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.keyDown(input, { key: 'Enter' }) })
  expect(api.stopAgentRun).toHaveBeenCalledTimes(1)
  expect(api.agent).toHaveBeenCalledTimes(1)
  expect(input.value).toBe('时间改成周一，其他不变')
  await act(async () => { finish({ ...running, status: 'cancelled' }) })
  await screen.findByText('已经按调整继续。')
  expect(api.agent).toHaveBeenCalledTimes(2)
  expect(vi.mocked(api.agent).mock.calls[1]![0]).toEqual({ scope: running.scope, session: 'original-session', message: '时间改成周一，其他不变' })
  expect(input.readOnly).toBe(false)
})

it('keeps the adjustment draft when stopping fails and does not start another task', async () => {
  configured()
  let finish!: (run: AgentRunDTO) => void
  vi.mocked(api.agent).mockImplementation(async (_, emit, __, hooks) => {
    emit({ type: 'session', id: 'original-session' }); hooks?.onRun?.(running)
    return new Promise(resolve => { finish = resolve })
  })
  vi.mocked(api.stopAgentRun).mockRejectedValue(new Error('连接中断'))
  render(<App/>); await screen.findByText('文章画布')
  const input = screen.getByRole('textbox', { name: 'AI 消息' }) as HTMLTextAreaElement
  await act(async () => { fireEvent.change(input, { target: { value: '整理发布准备' } }); fireEvent.keyDown(input, { key: 'Enter' }) })
  fireEvent.change(input, { target: { value: '只调整时间，其他不变' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '停止并发送调整' })) })
  expect((await screen.findByRole('alert')).textContent).toContain('调整尚未发送：连接中断')
  expect(input.value).toBe('只调整时间，其他不变')
  expect(input.readOnly).toBe(false)
  expect(api.agent).toHaveBeenCalledTimes(1)
  await act(async () => { finish({ ...running, status: 'completed' }) })
})

it('does not send another workspace draft as an adjustment to the running conversation', async () => {
  configured(); vi.mocked(api.listFolders).mockResolvedValue(['', 'Work'])
  let finish!: (run: AgentRunDTO) => void
  vi.mocked(api.agent).mockImplementation(async (_, emit, __, hooks) => {
    emit({ type: 'session', id: 'original-session' }); hooks?.onRun?.(running)
    return new Promise(resolve => { finish = resolve })
  })
  render(<App/>); await screen.findByText('文章画布')
  const input = screen.getByRole('textbox', { name: 'AI 消息' }) as HTMLTextAreaElement
  await act(async () => { fireEvent.change(input, { target: { value: '整理当前笔记' } }); fireEvent.keyDown(input, { key: 'Enter' }) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Work' })) })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Work' }).getAttribute('aria-current')).toBe('page'))
  fireEvent.change(input, { target: { value: '这是另一个文件夹的问题' } })
  expect(screen.queryByRole('button', { name: '停止并发送调整' })).toBe(null)
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(api.stopAgentRun).not.toHaveBeenCalled()
  expect(api.agent).toHaveBeenCalledTimes(1)
  expect(input.value).toBe('这是另一个文件夹的问题')
  await act(async () => { finish({ ...running, status: 'completed' }) })
})

it('sends the captured message and preserves a newer draft typed during the save before sending', async () => {
  let saved!: (ok: boolean) => void
  const beforeSend = { current: () => new Promise<boolean>(resolve => { saved = resolve }) }
  const selection = { current: () => '发送时的原文选区' }
  vi.mocked(api.agent).mockImplementation(async (_, emit) => { emit({ type: 'session', id: 'c-save' }); return { ...running, status: 'completed' } })
  render(<AgentPanel folder="" name="当前文章.md" model="test-model" beforeSend={beforeSend} selection={selection} onConfigure={() => {}} onClose={() => {}} onOpenNote={() => {}}/>)
  const input = screen.getByRole('textbox', { name: 'AI 消息' }) as HTMLTextAreaElement
  fireEvent.change(input, { target: { value: '先发送这条任务' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.change(input, { target: { value: '保留这条下一轮草稿' } })
  selection.current = () => '稍后来自另一篇文章的选区'
  expect(api.agent).not.toHaveBeenCalled()
  await act(async () => { saved(true) })
  expect(vi.mocked(api.agent).mock.calls[0]![0].message).toBe('先发送这条任务')
  expect(vi.mocked(api.agent).mock.calls[0]![0].selection).toBe('发送时的原文选区')
  expect(input.value).toBe('保留这条下一轮草稿')
})

it('lets Stop cancel a pending adjustment while the old task is still stopping', async () => {
  configured()
  let finish!: (run: AgentRunDTO) => void
  vi.mocked(api.agent).mockImplementation(async (_, emit, __, hooks) => {
    emit({ type: 'session', id: 'original-session' }); hooks?.onRun?.(running)
    return new Promise(resolve => { finish = resolve })
  })
  vi.mocked(api.stopAgentRun).mockResolvedValue(running)
  render(<App/>); await screen.findByText('文章画布')
  const input = screen.getByRole('textbox', { name: 'AI 消息' }) as HTMLTextAreaElement
  await act(async () => { fireEvent.change(input, { target: { value: '整理资料' } }); fireEvent.keyDown(input, { key: 'Enter' }) })
  fireEvent.change(input, { target: { value: '时间改为周一' } })
  await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
  fireEvent.keyDown(input, { key: 'Escape' })
  await act(async () => { finish({ ...running, status: 'cancelled' }) })
  expect(api.agent).toHaveBeenCalledTimes(1)
  expect(input.value).toBe('时间改为周一')
  expect(input.readOnly).toBe(false)
})

it.each(['unmount', 'escape'] as const)('does not resume an adjustment after %s when the stop acknowledgement arrives after the terminal event', async action => {
  configured()
  let finish!: (run: AgentRunDTO) => void, acknowledge!: (run: AgentRunDTO) => void
  vi.mocked(api.agent).mockImplementation(async (_, emit, __, hooks) => {
    emit({ type: 'session', id: 'original-session' }); hooks?.onRun?.(running)
    return new Promise(resolve => { finish = resolve })
  })
  vi.mocked(api.stopAgentRun).mockImplementation(() => new Promise(resolve => { acknowledge = resolve }))
  const app = render(<App/>); await screen.findByText('文章画布')
  const input = screen.getByRole('textbox', { name: 'AI 消息' })
  await act(async () => { fireEvent.change(input, { target: { value: '整理资料' } }); fireEvent.keyDown(input, { key: 'Enter' }) })
  fireEvent.change(input, { target: { value: '时间改为周一' } })
  await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
  await act(async () => { finish({ ...running, status: 'cancelled' }) })
  // watch has already cleared request.current; stopping and dismissal still need to work.
  if (action === 'unmount') app.unmount()
  else fireEvent.keyDown(input, { key: 'Escape' })
  await act(async () => { acknowledge({ ...running, status: 'cancelled' }) })
  expect(api.agent).toHaveBeenCalledTimes(1)
})

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
  expect(screen.getByLabelText('当前任务')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '运行详情' })).toBe(null)
  expect(screen.getByRole('button', { name: '对话范围' }).hasAttribute('disabled')).toBe(true)
  await act(async () => { end({ ...running, status: 'completed' }) })
  await waitFor(() => expect(screen.queryByRole('button', { name: '运行详情' })).toBe(null))
  expect(screen.getByRole('button', { name: '对话范围' }).hasAttribute('disabled')).toBe(false)
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
  expect(screen.getByLabelText('当前任务')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '运行详情' })).toBe(null)
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


it('switches workspaces with the dropdown and puts chat navigation in the shared sidebar', async () => {
  render(<App/>)
  const switcher = await screen.findByRole('button', { name: '切换工作区：笔记' })
  fireEvent.keyDown(switcher, { key: 'ArrowDown' })
  fireEvent.click(await screen.findByRole('menuitem', { name: '对话' }))
  const chatSwitcher = await screen.findByRole('button', { name: '切换工作区：对话' })
  const sidebar = screen.getByRole('complementary', { name: '工作区导航' })
  expect(within(sidebar).getByRole('navigation', { name: '对话列表' })).toBeTruthy()
  expect(screen.queryByRole('navigation', { name: '文件夹' })).toBe(null)
  expect(screen.queryByRole('button', { name: '新建文章' })).toBe(null)
  fireEvent.change(screen.getByRole('textbox', { name: '你的问题' }), { target: { value: '切换后保留' } })
  fireEvent.keyDown(chatSwitcher, { key: 'ArrowDown' })
  fireEvent.click(await screen.findByRole('menuitem', { name: '笔记' }))
  expect(await screen.findByRole('navigation', { name: '文件夹' })).toBeTruthy()
  fireEvent.keyDown(screen.getByRole('button', { name: '切换工作区：笔记' }), { key: 'ArrowDown' })
  fireEvent.click(await screen.findByRole('menuitem', { name: '对话' }))
  expect((await screen.findByRole('textbox', { name: '你的问题' }) as HTMLTextAreaElement).value).toBe('切换后保留')
})

it('keeps assistant drafts while switching to exploration and back', async () => {
  configured()
  render(<App/>); await screen.findByText('文章画布')
  fireEvent.change(screen.getByRole('textbox', { name: 'AI 消息' }), { target: { value: '尚未发送的整理要求' } })
  fireEvent.keyDown(screen.getByRole('button', { name: '助手' }), { key: 'ArrowDown' })
  fireEvent.click(await screen.findByRole('menuitem', { name: '探索 · 围绕原文深入讨论' }))
  fireEvent.click(await screen.findByRole('button', { name: '需要查找或整理笔记？前往助手' }))
  expect((await screen.findByRole('textbox', { name: 'AI 消息' }) as HTMLTextAreaElement).value).toBe('尚未发送的整理要求')
  expect(api.agent).not.toHaveBeenCalled()
})

it('does not present a previous note run as the new note reply and can still stop it', async () => {
  let finish!: (run: AgentRunDTO) => void
  vi.mocked(api.agent).mockImplementation(async (_, emit, __, hooks) => {
    emit({ type: 'session', id: 'original' }); hooks?.onRun?.(running)
    emit({ type: 'activity', text: '正在阅读第一篇笔记' })
    return new Promise(resolve => { finish = resolve })
  })
  vi.mocked(api.stopAgentRun).mockResolvedValue(running)
  const openTask = vi.fn()
  const props = { folder: '', model: 'm', beforeSend: { current: async () => true }, selection: { current: () => undefined }, onConfigure() {}, onClose() {}, onOpenNote: openTask }
  const app = render(<AgentPanel {...props} name="First.md"/>)
  await act(async () => { fireEvent.change(screen.getByRole('textbox', { name: 'AI 消息' }), { target: { value: '阅读' } }); fireEvent.keyDown(screen.getByRole('textbox', { name: 'AI 消息' }), { key: 'Enter' }) })
  expect(screen.getByLabelText('当前任务').textContent).toContain('正在阅读第一篇笔记')
  expect(screen.queryByRole('button', { name: '运行详情' })).toBe(null)
  app.rerender(<AgentPanel {...props} name="Second.md"/>)
  expect(screen.queryByLabelText('当前任务')).toBe(null)
  expect(screen.getByText('另一段对话的任务仍在运行')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '返回任务' }))
  expect(openTask).toHaveBeenCalledWith('First.md')
  fireEvent.click(screen.getByRole('button', { name: '停止任务' }))
  expect(api.stopAgentRun).toHaveBeenCalledWith(running.id)
  await act(async () => finish({ ...running, status: 'cancelled' }))
  expect(screen.queryByText('另一段对话的任务仍在运行')).toBe(null)
})

it('shows only meaningful task steps and keeps the composer as the stop control', async () => {
  let finish!: (run: AgentRunDTO) => void
  vi.mocked(api.agent).mockImplementation(async (_, emit, __, hooks) => {
    hooks?.onRun?.(running)
    emit({ type: 'activity', text: '正在读取原文' })
    emit({ type: 'plan', steps: [{ text: '阅读文章', status: 'active' }, { text: '调整段落', status: 'pending' }] })
    return new Promise(resolve => { finish = resolve })
  })
  render(<AgentPanel folder="" name={null} model="m" beforeSend={{ current: async () => true }} selection={{ current: () => undefined }} onConfigure={() => {}} onClose={() => {}} onOpenNote={() => {}}/>)
  await act(async () => { fireEvent.change(screen.getByRole('textbox', { name: 'AI 消息' }), { target: { value: '重排段落' } }); fireEvent.keyDown(screen.getByRole('textbox', { name: 'AI 消息' }), { key: 'Enter' }) })
  expect(screen.getByLabelText('当前任务').textContent).toContain('正在读取原文')
  expect(screen.getAllByRole('button', { name: '停止生成' })).toHaveLength(1)
  expect(screen.queryByRole('button', { name: '停止' })).toBe(null)
  const steps = screen.getByRole('button', { name: '任务步骤 · 0/2' })
  expect(steps.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('list', { name: '任务计划' })).toBe(null)
  fireEvent.click(steps)
  expect(screen.getByRole('list', { name: '任务计划' }).textContent).toContain('调整段落')
  await act(async () => finish({ ...running, status: 'completed' }))
  expect(screen.queryByLabelText('当前任务')).toBe(null)
})

it('collapses completed edits by default and exposes distinct review and undo actions', async () => {
  const change = { id: 'cs-compact', memory: 0, request: '重排段落', createdAt: 1, files: [{ name: '基本粒子.md', kind: 'edit' as const }], layouts: [], undone: false, undoable: true, origin: 'request' as const }
  vi.mocked(api.conversation).mockResolvedValue({ id: 'c1', scope: running.scope, updatedAt: 1, messages: [{ role: 'assistant', text: '段落已调整。' }], changes: [change], proposals: [], plan: [] })
  vi.mocked(api.undoChangeSet).mockResolvedValue({ ...change, undone: true })
  render(<AgentPanel folder="" name={null} model="m" beforeSend={{ current: async () => true }} selection={{ current: () => undefined }} onConfigure={() => {}} onClose={() => {}} onOpenNote={() => {}}/>)
  const summary = await screen.findByRole('button', { name: '已修改 · 1 篇文章' })
  expect(summary.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('button', { name: '查看改动' })).toBe(null)
  fireEvent.click(summary)
  expect(screen.getByRole('button', { name: '查看改动' })).toBeTruthy()
  expect(within(screen.getByRole('region', { name: '一次修改' })).queryByText('重排段落')).toBe(null)
  fireEvent.click(screen.getByRole('button', { name: '撤销这次修改' }))
  await waitFor(() => expect(api.undoChangeSet).toHaveBeenCalledWith('cs-compact'))
  expect(await screen.findByRole('button', { name: '已撤销 · 1 篇文章' })).toBeTruthy()
})

it('opens the exact requested task session, including a pure chat task', async () => {
  const chatScope = { kind: 'chat' as const, folder: '' }
  vi.mocked(api.conversation).mockImplementation(async (scope, session) => session === 'older-chat' ? { id: session, scope, updatedAt: 1, messages: [{ role: 'user', text: '此前的任务' }, { role: 'assistant', text: '此前的结果' }], changes: [], proposals: [], plan: [] } : null)
  render(<AgentPanel folder="" name={null} model="m" taskRequest={{ key: 1, run: { ...running, status: 'completed', scope: chatScope, session: 'older-chat' } }} beforeSend={{ current: async () => true }} selection={{ current: () => undefined }} onConfigure={() => {}} onClose={() => {}} onOpenNote={() => {}}/>)
  expect(await screen.findByText('此前的结果')).toBeTruthy()
  expect(api.conversation).toHaveBeenCalledWith(chatScope, 'older-chat')
  expect(screen.getByRole('button', { name: '对话范围' }).textContent).toContain('纯聊天')
})

it.each(['other-scope', 'same-scope'] as const)('reads an older %s task while keeping the active stream attached, then returns to that stream', async target => {
  let finish!: (run: AgentRunDTO) => void
  let signal!: AbortSignal
  const scope = { kind: 'note' as const, folder: '', name: 'Current.md' }
  const activeRun = { ...running, scope, session: 'active-session' }
  const olderScope = target === 'same-scope' ? scope : { ...scope, name: 'Earlier.md' }
  const props = { folder: '', name: scope.name, model: 'm', beforeSend: { current: async () => true }, selection: { current: () => undefined }, onConfigure() {}, onClose() {}, onOpenNote() {} }
  vi.mocked(api.agent).mockImplementation(async (_, emit, abort, hooks) => {
    signal = abort
    emit({ type: 'session', id: 'active-session' }); hooks?.onRun?.(activeRun)
    emit({ type: 'delta', text: '仍在处理当前文章' })
    return new Promise(resolve => { finish = resolve })
  })
  vi.mocked(api.conversation).mockImplementation(async (scope, session) => session === 'older-session' ? { id: session, scope, updatedAt: 1, messages: [{ role: 'user', text: '以前的请求' }, { role: 'assistant', text: '以前已完成的结果' }], changes: [], proposals: [], plan: [] } : null)
  const view = render(<AgentPanel {...props}/>)
  await act(async () => { fireEvent.change(screen.getByRole('textbox', { name: 'AI 消息' }), { target: { value: '处理当前文章' } }); fireEvent.keyDown(screen.getByRole('textbox', { name: 'AI 消息' }), { key: 'Enter' }) })
  expect(await screen.findByText('仍在处理当前文章')).toBeTruthy()
  view.rerender(<AgentPanel {...props} name={olderScope.name} taskRequest={{ key: 1, run: { ...activeRun, id: 'old-run', session: 'older-session', status: 'completed', scope: olderScope } }}/>)
  expect(await screen.findByText('以前已完成的结果')).toBeTruthy()
  expect(api.conversation).toHaveBeenCalledWith(olderScope, 'older-session')
  expect(screen.queryByText('仍在处理当前文章')).toBe(null)
  expect(screen.getByText('另一段对话的任务仍在运行')).toBeTruthy()
  expect(signal.aborted).toBe(false)
  expect(api.stopAgentRun).not.toHaveBeenCalled()
  expect(api.followAgent).not.toHaveBeenCalled()
  view.rerender(<AgentPanel {...props} taskRequest={{ key: 2, run: activeRun }}/>)
  expect(await screen.findByText('仍在处理当前文章')).toBeTruthy()
  expect(screen.queryByText('以前已完成的结果')).toBe(null)
  expect(api.agent).toHaveBeenCalledTimes(1)
  expect(api.followAgent).not.toHaveBeenCalled()
  await act(async () => finish({ ...activeRun, status: 'completed' }))
})

it('shows a failed task without a session from its run record, never unrelated latest scope history', async () => {
  vi.mocked(api.conversation).mockResolvedValue({ id: 'unrelated', scope: running.scope, updatedAt: 1, messages: [{ role: 'assistant', text: '不相关的旧结果' }], changes: [], proposals: [], plan: [] })
  render(<AgentPanel folder="" name={null} model="m" taskRequest={{ key: 1, run: { ...running, status: 'failed', request: '整理今天的资料', error: '模型连接失败' } }} beforeSend={{ current: async () => true }} selection={{ current: () => undefined }} onConfigure={() => {}} onClose={() => {}} onOpenNote={() => {}}/>)
  expect(await screen.findByText('整理今天的资料')).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toBe('模型连接失败')
  expect(screen.queryByText('不相关的旧结果')).toBe(null)
  expect(api.conversation).not.toHaveBeenCalled()
})

it.each(['note', 'chat'] as const)('follows an exact pre-session %s task without loading an unrelated saved conversation', async kind => {
  let finish!: (run: AgentRunDTO) => void
  let signal!: AbortSignal
  const scope = kind === 'note' ? { kind, folder: '', name: 'Current.md' } : { kind, folder: '' }
  const task = { ...running, scope, request: '当前刚发出的请求', activity: '正在连接模型' }
  vi.mocked(api.conversation).mockResolvedValue({ id: 'unrelated', scope, updatedAt: 1, messages: [{ role: 'assistant', text: '不相关的旧结果' }], changes: [], proposals: [], plan: [] })
  vi.mocked(api.followAgent).mockImplementation(async (_, emit, abort) => {
    signal = abort
    emit({ type: 'session', id: 'new-session' })
    emit({ type: 'delta', text: '当前任务的回复' })
    return new Promise(resolve => { finish = resolve })
  })
  const props = { folder: '', name: kind === 'note' ? 'Current.md' : null, model: 'm', beforeSend: { current: async () => true }, selection: { current: () => undefined }, onConfigure() {}, onClose() {}, onOpenNote() {} }
  const view = render(<AgentPanel {...props} taskRequest={{ key: 1, run: task }}/>)
  expect(await screen.findByText('当前任务的回复')).toBeTruthy()
  expect(screen.getAllByText('当前刚发出的请求')).toHaveLength(1)
  expect(screen.queryByText('不相关的旧结果')).toBe(null)
  expect(api.conversation).not.toHaveBeenCalled()
  expect(api.followAgent).toHaveBeenCalledWith(task.id, expect.any(Function), expect.any(AbortSignal))
  view.rerender(<AgentPanel {...props} taskRequest={{ key: 2, run: task }}/>)
  expect(screen.getByText('当前任务的回复')).toBeTruthy()
  expect(api.followAgent).toHaveBeenCalledTimes(1)
  expect(signal.aborted).toBe(false)
  await act(async () => finish({ ...task, session: 'new-session', status: 'completed' }))
})

it('detaches the old listener to follow a newly selected active task without stopping either server task', async () => {
  let oldSignal!: AbortSignal, newSignal!: AbortSignal
  let finish!: (run: AgentRunDTO) => void
  vi.mocked(api.agent).mockImplementation(async (_, emit, signal, hooks) => {
    oldSignal = signal; emit({ type: 'session', id: 'first-session' }); hooks?.onRun?.(running)
    emit({ type: 'delta', text: '旧任务的流' })
    return new Promise(resolve => signal.addEventListener('abort', () => resolve(null), { once: true }))
  })
  const task = { ...running, id: 'new-active', request: '在另一个窗口开始的任务' }
  vi.mocked(api.followAgent).mockImplementation(async (_, emit, signal) => {
    newSignal = signal; emit({ type: 'session', id: 'new-session' }); emit({ type: 'delta', text: '新选择任务的流' })
    return new Promise(resolve => { finish = resolve })
  })
  const props = { folder: '', name: null, model: 'm', beforeSend: { current: async () => true }, selection: { current: () => undefined }, onConfigure() {}, onClose() {}, onOpenNote() {} }
  const view = render(<AgentPanel {...props}/>)
  await act(async () => { fireEvent.change(screen.getByRole('textbox', { name: 'AI 消息' }), { target: { value: '旧任务' } }); fireEvent.keyDown(screen.getByRole('textbox', { name: 'AI 消息' }), { key: 'Enter' }) })
  expect(await screen.findByText('旧任务的流')).toBeTruthy()
  view.rerender(<AgentPanel {...props} taskRequest={{ key: 1, run: task }}/>)
  expect(await screen.findByText('新选择任务的流')).toBeTruthy()
  expect(oldSignal.aborted).toBe(true)
  expect(newSignal.aborted).toBe(false)
  expect(api.stopAgentRun).not.toHaveBeenCalled()
  expect(api.followAgent).toHaveBeenCalledWith('new-active', expect.any(Function), expect.any(AbortSignal))
  await act(async () => finish({ ...task, session: 'new-session', status: 'completed' }))
})
