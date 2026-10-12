// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatWorkspace } from '../src/ChatWorkspace'
import { api } from '../src/api'
import type { DiscussionDTO, DiscussionSummaryDTO, RunDTO } from '../shared/types'

vi.mock('../src/api', () => ({
  api: { organize: vi.fn(), capturePreview: vi.fn(), discussions: vi.fn(), discussionView: vi.fn(), archiveDiscussion: vi.fn(), createDraft: vi.fn(), sendDraft: vi.fn(), startRun: vi.fn(), capture: vi.fn(), changeSet: vi.fn(), context: vi.fn(), stopRun: vi.fn() },
  subscribeEvents: () => () => {},
  subscribeRun: vi.fn(() => () => {}),
}))

const hex = (n: number) => String(n).padStart(32, '0')
const discussion = (id: string, question: string, answer?: string): DiscussionDTO => ({
  id, title: question, origin: { kind: 'chat' }, revision: 2, archived: false, createdAt: 1, updatedAt: 2,
  turns: [{ id: hex(9), parents: [], question, sourceIds: [], requestKey: 'k', answers: answer ? [{ id: hex(8), text: answer, createdAt: 2 }] : [], createdAt: 1 }],
})
const summary = (value: DiscussionDTO): DiscussionSummaryDTO => { const { turns, ...rest } = value; return { ...rest, turnCount: turns.length, lastQuestion: turns.at(-1)?.question ?? '', notePath: null } }
const idle = { current: async () => true } as unknown as React.MutableRefObject<() => Promise<boolean>>
const mount = (props: Partial<Parameters<typeof ChatWorkspace>[0]> = {}) => render(<ChatWorkspace notes={[{ name: 'Materials.md', title: 'Materials' }]} model="test-model" active beforeSend={idle} onConfigure={() => {}} onOpenNote={() => {}} {...props}/>)

beforeEach(() => {
  localStorage.clear()
  HTMLElement.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals() })

it('lists conversations, opens one and appends its answer to a chosen note', async () => {
  const first = discussion(hex(1), '什么是弹性模量？', '它衡量材料抵抗形变的能力。')
  vi.mocked(api.discussions).mockResolvedValue([summary(first)])
  vi.mocked(api.discussionView).mockResolvedValue({ discussion: first, captures: [], sources: {}, runs: [] })
  vi.mocked(api.capture).mockResolvedValue({ capture: { id: hex(7), requestKey: 'r', mode: 'verbatim', target: { kind: 'append', noteId: hex(6), notePath: 'Materials.md', beforeVersion: 'a'.repeat(64), afterVersion: 'b'.repeat(64) }, answers: [], sourceIds: [], createdAt: 3 }, change: {} as never })
  mount()
  fireEvent.click(await screen.findByRole('button', { name: /什么是弹性模量/ }))
  expect(await screen.findByText('它衡量材料抵抗形变的能力。')).toBeTruthy()
  // No target is chosen yet, so only "save as new note" is offered.
  expect(screen.queryByRole('button', { name: /追加到/ })).toBe(null)
  expect(screen.getByRole('button', { name: '存为新笔记' })).toBeTruthy()
  fireEvent.click(screen.getByRole('combobox', { name: '写入笔记' }))
  fireEvent.click(await screen.findByRole('option', { name: 'Materials' }))
  fireEvent.click(await screen.findByRole('button', { name: '追加到《Materials》' }))
  await waitFor(() => expect(api.capture).toHaveBeenCalledWith(expect.objectContaining({ discussionId: first.id, answerId: hex(8), target: { kind: 'append', note: 'Materials.md' } })))
})

it('starts a new conversation from the first question and follows its answer', async () => {
  vi.mocked(api.discussions).mockResolvedValue([])
  const started = discussion(hex(1), '铝为什么轻？')
  const run: RunDTO = { id: hex(5), discussionId: started.id, turnId: hex(9), requestKey: 'k', status: 'running', text: '', seq: 0, createdAt: 1, updatedAt: 1 }
  vi.mocked(api.createDraft).mockImplementation(async input => ({ id: hex(4), title: '', discussionId: null, parentIds: [], origin: { kind: 'chat' }, items: input.items, revision: 1, createdAt: 1, updatedAt: 1 }))
  vi.mocked(api.sendDraft).mockResolvedValue({ discussion: started, turns: started.turns, draft: { id: hex(4), title: '', discussionId: started.id, parentIds: [], origin: { kind: 'chat' }, items: [], revision: 2, createdAt: 1, updatedAt: 2 } })
  vi.mocked(api.discussionView).mockResolvedValue({ discussion: started, captures: [], sources: {}, runs: [run] })
  vi.mocked(api.startRun).mockResolvedValue(run)
  mount()
  fireEvent.change(await screen.findByRole('textbox', { name: '你的问题' }), { target: { value: '铝为什么轻？' } })
  fireEvent.click(screen.getByRole('button', { name: '开始对话' }))
  await waitFor(() => expect(api.startRun).toHaveBeenCalledWith(started.id, hex(9), expect.any(String)))
  expect(vi.mocked(api.createDraft).mock.calls[0]![0]).toMatchObject({ items: [expect.objectContaining({ question: '铝为什么轻？', sourceIds: [] })] })
  expect(await screen.findByRole('textbox', { name: '继续提问' })).toBeTruthy()
  expect(within(screen.getByLabelText('讨论：铝为什么轻？')).getByText('铝为什么轻？')).toBeTruthy()
})

it('does not read anything while hidden, and offers no send without a model', async () => {
  vi.mocked(api.discussions).mockResolvedValue([])
  const { rerender } = mount({ active: false, model: null })
  expect(api.discussions).not.toHaveBeenCalled()
  rerender(<ChatWorkspace notes={[]} model={null} active beforeSend={idle} onConfigure={() => {}} onOpenNote={() => {}}/>)
  await waitFor(() => expect(api.discussions).toHaveBeenCalled())
  fireEvent.change(screen.getByRole('textbox', { name: '你的问题' }), { target: { value: '你好' } })
  expect((screen.getByRole('button', { name: '开始对话' }) as HTMLButtonElement).disabled).toBe(true)
})

it('keeps the question when sending fails and retries with the same draft instead of creating a second question', async () => {
  vi.mocked(api.discussions).mockResolvedValue([])
  const started = discussion(hex(1), '铝为什么轻？')
  vi.mocked(api.createDraft).mockImplementation(async input => ({ id: hex(4), title: '', discussionId: null, parentIds: [], origin: { kind: 'chat' }, items: input.items, revision: 1, createdAt: 1, updatedAt: 1 }))
  vi.mocked(api.sendDraft).mockRejectedValueOnce(new Error('网络中断')).mockResolvedValue({ discussion: started, turns: started.turns, draft: { id: hex(4), title: '', discussionId: started.id, parentIds: [], origin: { kind: 'chat' }, items: [], revision: 2, createdAt: 1, updatedAt: 2 } })
  vi.mocked(api.discussionView).mockResolvedValue({ discussion: started, captures: [], sources: {}, runs: [] })
  vi.mocked(api.startRun).mockResolvedValue({ id: hex(5), discussionId: started.id, turnId: hex(9), requestKey: 'k', status: 'running', text: '', seq: 0, createdAt: 1, updatedAt: 1 })
  mount()
  const box = await screen.findByRole('textbox', { name: '你的问题' }) as HTMLTextAreaElement
  fireEvent.change(box, { target: { value: '铝为什么轻？' } })
  fireEvent.keyDown(box, { key: 'Enter' })
  expect((await screen.findByRole('alert')).textContent).toContain('网络中断')
  expect(box.value).toBe('铝为什么轻？')
  fireEvent.keyDown(box, { key: 'Enter' })
  await waitFor(() => expect(api.startRun).toHaveBeenCalledTimes(1))
  expect(api.createDraft).toHaveBeenCalledTimes(1)
  expect(vi.mocked(api.sendDraft).mock.calls.map(call => call[0])).toEqual([hex(4), hex(4)])
})

it('does not send on Enter while an input method is composing, and falls back when the remembered conversation is gone', async () => {
  localStorage.setItem('canvas.chat-selected', hex(3))
  vi.mocked(api.discussions).mockResolvedValue([])
  vi.mocked(api.discussionView).mockRejectedValue(new Error('找不到讨论。'))
  mount()
  const box = await screen.findByRole('textbox', { name: '你的问题' })
  expect(localStorage.getItem('canvas.chat-selected')).toBe(null)
  fireEvent.change(box, { target: { value: '你好' } })
  fireEvent.keyDown(box, { key: 'Enter', isComposing: true })
  expect(api.createDraft).not.toHaveBeenCalled()
})

describe('write dialog', () => {
  const first = discussion(hex(1), '什么是弹性模量？', '它衡量材料抵抗形变的能力。')
  const captured = { capture: { id: hex(7), requestKey: 'r', mode: 'organized', target: { kind: 'append', noteId: hex(6), notePath: 'Materials.md', beforeVersion: 'a'.repeat(64), afterVersion: 'b'.repeat(64) }, answers: [], sourceIds: [], createdAt: 3 }, change: {} as never }
  const shown = { kind: 'append' as const, noteName: 'Materials.md', before: '# 材料\n', after: '# 材料\n\n整理后的结论。\n', expectedVersion: 'c'.repeat(64), content: '整理后的结论。' }
  async function openDialog() {
    vi.mocked(api.discussions).mockResolvedValue([summary(first)])
    vi.mocked(api.discussionView).mockResolvedValue({ discussion: first, captures: [], sources: {}, runs: [] })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /什么是弹性模量/ }))
    fireEvent.click(await screen.findByRole('button', { name: '写入…' }))
    return await screen.findByRole('dialog', { name: '写入笔记' })
  }

  it('organizes first, lets the text be edited, shows the difference, and saves exactly what was confirmed', async () => {
    vi.mocked(api.organize).mockResolvedValue({ text: '整理后的结论。' })
    vi.mocked(api.capturePreview).mockResolvedValue(shown)
    vi.mocked(api.capture).mockResolvedValue(captured as never)
    const dialog = await openDialog()
    fireEvent.click(within(dialog).getByRole('button', { name: '整理后' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '生成整理结果' }))
    const box = await within(dialog).findByRole('textbox', { name: '整理后的文字' }) as HTMLTextAreaElement
    await waitFor(() => expect(box.value).toBe('整理后的结论。'))
    fireEvent.change(box, { target: { value: '整理后的结论。（我改过）' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '预览差异' }))
    expect(await within(dialog).findByRole('region', { name: '写入前后的差异' })).toBeTruthy()
    expect(api.capturePreview).toHaveBeenCalledWith(expect.objectContaining({ mode: 'organized', text: '整理后的结论。（我改过）', target: { kind: 'append', note: 'Materials.md' } }))
    expect(api.capture).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '确认写入' }))
    await waitFor(() => expect(api.capture).toHaveBeenCalledWith(expect.objectContaining({ mode: 'organized', text: '整理后的结论。（我改过）', expectedVersion: shown.expectedVersion })))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '写入笔记' })).toBe(null))
  })

  it('drops the shown difference when the note changed after the preview, so a fresh one is required', async () => {
    vi.mocked(api.capturePreview).mockResolvedValue({ ...shown, after: '# 材料\n\n它衡量材料抵抗形变的能力。\n' })
    vi.mocked(api.capture).mockRejectedValue(new Error('笔记在预览之后被修改，请重新预览后再写入。'))
    const dialog = await openDialog()
    fireEvent.click(within(dialog).getByRole('button', { name: '预览差异' }))
    fireEvent.click(await within(dialog).findByRole('button', { name: '确认写入' }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('预览之后被修改')
    expect(within(dialog).queryByRole('region', { name: '写入前后的差异' })).toBe(null)
    expect(within(dialog).getByRole('button', { name: '预览差异' })).toBeTruthy()
  })

  it('offers replacing the cited passage only for an answer that has one', async () => {
    const dialog = await openDialog()
    fireEvent.click(within(dialog).getByRole('combobox', { name: '方式' }))
    expect(await screen.findByRole('option', { name: '存为新笔记' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /替换/ })).toBe(null)
  })
})

it('keeps the open conversation when it is chosen again instead of blanking it', async () => {
  const first = discussion(hex(1), '什么是弹性模量？', '它衡量材料抵抗形变的能力。')
  localStorage.setItem('canvas.chat-selected', first.id)
  vi.mocked(api.discussions).mockResolvedValue([summary(first)])
  vi.mocked(api.discussionView).mockResolvedValue({ discussion: first, captures: [], sources: {}, runs: [] })
  mount()
  expect(await screen.findByText('它衡量材料抵抗形变的能力。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /什么是弹性模量/ }))
  expect(await screen.findByText('它衡量材料抵抗形变的能力。')).toBeTruthy()
  expect(screen.queryByText('正在读取对话…')).toBe(null)
})
