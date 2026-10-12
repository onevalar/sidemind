// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ChatWorkspace } from '../src/ChatWorkspace'
import { api } from '../src/api'
import type { DiscussionDTO, DiscussionSummaryDTO, RunDTO } from '../shared/types'

vi.mock('../src/api', () => ({
  api: { discussions: vi.fn(), discussionView: vi.fn(), archiveDiscussion: vi.fn(), createDraft: vi.fn(), sendDraft: vi.fn(), startRun: vi.fn(), capture: vi.fn(), changeSet: vi.fn(), context: vi.fn(), stopRun: vi.fn() },
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
