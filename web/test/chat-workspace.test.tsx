// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatWorkspace } from '../src/ChatWorkspace'
import { api } from '../src/api'
import type { DiscussionDTO, DiscussionSummaryDTO, RunDTO } from '../shared/types'

vi.mock('../src/api', () => ({
  api: { summarizeEarlier: vi.fn(), organize: vi.fn(), capturePreview: vi.fn(), discussions: vi.fn(), discussionView: vi.fn(), archiveDiscussion: vi.fn(), createDraft: vi.fn(), sendDraft: vi.fn(), startRun: vi.fn(), capture: vi.fn(), changeSet: vi.fn(), context: vi.fn(), stopRun: vi.fn() },
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

describe('context over budget', () => {
  const first = discussion(hex(1), '什么是弹性模量？', '它衡量材料抵抗形变的能力。')
  const base = { messages: [{ role: 'system' as const, content: '指令' }, { role: 'user' as const, content: '问题：什么是弹性模量？' }], budget: 24000, estimatedTokens: 31000 }

  it('offers summaries when earlier answers could be shortened, and then explains which were replaced', async () => {
    vi.mocked(api.discussions).mockResolvedValue([summary(first)])
    vi.mocked(api.discussionView).mockResolvedValue({ discussion: first, captures: [], sources: {}, runs: [] })
    vi.mocked(api.context).mockResolvedValue({ ...base, exceeded: true, summarizable: [{ turnId: hex(9), answerId: hex(8) }], turns: [{ id: hex(9), question: 'q', answerId: hex(8), mode: 'raw' }] })
    vi.mocked(api.summarizeEarlier).mockResolvedValue({ ...base, estimatedTokens: 9000, exceeded: false, summarizable: [], turns: [{ id: hex(9), question: 'q', answerId: hex(8), mode: 'summary' }], messages: [...base.messages, { role: 'assistant', content: '（以下是较早回答的摘要，不是原文）\n摘要。' }] })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /什么是弹性模量/ }))
    fireEvent.click(await screen.findByRole('button', { name: '查看上下文' }))
    const dialog = await screen.findByRole('dialog', { name: '发送给模型的上下文' })
    expect(within(dialog).getByText(/超出上限，发送会被拒绝/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '为较早的 1 条回答生成摘要' }))
    await waitFor(() => expect(api.summarizeEarlier).toHaveBeenCalledWith(first.id, hex(9)))
    expect((await within(dialog).findByRole('status')).textContent).toContain('1 条回答以摘要代替原文')
    expect(within(dialog).getByText('先前回答的摘要')).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: /生成摘要/ })).toBe(null)
  })

  it('says plainly when nothing can be summarized instead of offering a useless button', async () => {
    vi.mocked(api.discussions).mockResolvedValue([summary(first)])
    vi.mocked(api.discussionView).mockResolvedValue({ discussion: first, captures: [], sources: {}, runs: [] })
    vi.mocked(api.context).mockResolvedValue({ ...base, exceeded: true, summarizable: [], turns: [{ id: hex(9), question: 'q', answerId: null, mode: 'raw' }] })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /什么是弹性模量/ }))
    fireEvent.click(await screen.findByRole('button', { name: '查看上下文' }))
    const dialog = await screen.findByRole('dialog', { name: '发送给模型的上下文' })
    expect(within(dialog).queryByRole('button', { name: /生成摘要/ })).toBe(null)
    expect(within(dialog).getByText(/直接选中的分支不会被摘要/)).toBeTruthy()
  })
})

describe('input method composition', () => {
  const started = discussion(hex(1), '铝为什么轻？')
  async function ready() {
    vi.mocked(api.discussions).mockResolvedValue([])
    vi.mocked(api.createDraft).mockImplementation(async input => ({ id: hex(4), title: '', discussionId: null, parentIds: [], origin: { kind: 'chat' }, items: input.items, revision: 1, createdAt: 1, updatedAt: 1 }))
    vi.mocked(api.sendDraft).mockResolvedValue({ discussion: started, turns: started.turns, draft: { id: hex(4), title: '', discussionId: started.id, parentIds: [], origin: { kind: 'chat' }, items: [], revision: 2, createdAt: 1, updatedAt: 2 } })
    vi.mocked(api.discussionView).mockResolvedValue({ discussion: started, captures: [], sources: {}, runs: [] })
    vi.mocked(api.startRun).mockResolvedValue({ id: hex(5), discussionId: started.id, turnId: hex(9), requestKey: 'k', status: 'running', text: '', seq: 0, createdAt: 1, updatedAt: 1 })
    mount()
    const box = await screen.findByRole('textbox', { name: '你的问题' }) as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'tie' } })
    return box
  }

  it.each([['Chrome/Firefox', { isComposing: true }], ['Safari', { keyCode: 229 }]])('does not send when Enter confirms a candidate (%s)', async (_, init) => {
    const box = await ready()
    fireEvent.keyDown(box, { key: 'Enter', ...init })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(api.createDraft).not.toHaveBeenCalled()
    expect(box.value).toBe('tie')
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 })       // the user's next, real Enter sends
    await waitFor(() => expect(api.createDraft).toHaveBeenCalledTimes(1))
  })

  it('does not send on Shift+Enter, which is a newline', async () => {
    const box = await ready()
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true, keyCode: 13 })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(api.createDraft).not.toHaveBeenCalled()
  })
})

describe('keyboard focus', () => {
  it('keeps the composer enabled (read-only, never disabled) while a question is being sent, so focus is not dropped', async () => {
    vi.mocked(api.discussions).mockResolvedValue([])
    vi.mocked(api.createDraft).mockImplementation(async input => ({ id: hex(4), title: '', discussionId: null, parentIds: [], origin: { kind: 'chat' }, items: input.items, revision: 1, createdAt: 1, updatedAt: 1 }))
    let release!: () => void
    vi.mocked(api.sendDraft).mockImplementation(() => new Promise((_, reject) => { release = () => reject(new Error('网络中断')) }))
    mount()
    const box = await screen.findByRole('textbox', { name: '你的问题' }) as HTMLTextAreaElement
    box.focus()
    fireEvent.change(box, { target: { value: '第一个问题' } })
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 13 })
    await waitFor(() => expect(box.readOnly).toBe(true))
    expect(box.disabled).toBe(false)
    expect(document.activeElement).toBe(box)
    release()
    await waitFor(() => expect(box.readOnly).toBe(false))
    expect(document.activeElement).toBe(box)
    expect(box.value).toBe('第一个问题')
  })
})

describe('organizing several compared answers', () => {
  const two: DiscussionDTO = {
    id: hex(1), title: '两个分支', origin: { kind: 'chat' }, revision: 3, archived: false, createdAt: 1, updatedAt: 3,
    turns: [
      { id: hex(11), parents: [], question: '铝怎么样？', sourceIds: [], requestKey: 'a', answers: [{ id: hex(21), text: '铝很轻。', createdAt: 2 }], createdAt: 1 },
      { id: hex(12), parents: [], question: '钛怎么样？', sourceIds: [], requestKey: 'b', answers: [{ id: hex(22), text: '钛更强但更贵。', createdAt: 3 }], createdAt: 2 },
    ],
  }
  it('opens one organized write for the picked answers, with no verbatim option and no replace', async () => {
    vi.mocked(api.discussions).mockResolvedValue([summary(two)])
    vi.mocked(api.discussionView).mockResolvedValue({ discussion: two, captures: [], sources: {}, runs: [] })
    vi.mocked(api.organize).mockResolvedValue({ text: '共识：都是金属。分歧：钛更贵。' })
    vi.mocked(api.capturePreview).mockResolvedValue({ kind: 'append', noteName: 'Materials.md', before: '# 材料\n', after: '# 材料\n\n共识…\n', expectedVersion: 'c'.repeat(64), content: '共识…' })
    vi.mocked(api.capture).mockResolvedValue({ capture: { id: hex(7), requestKey: 'r', mode: 'organized', target: { kind: 'append', noteId: hex(6), notePath: 'Materials.md', beforeVersion: 'a'.repeat(64), afterVersion: 'b'.repeat(64) }, answers: [], sourceIds: [], createdAt: 3 }, change: {} as never })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /两个分支/ }))
    for (const button of await screen.findAllByRole('button', { name: '选择比较' })) fireEvent.click(button)
    fireEvent.click(await screen.findByRole('button', { name: '整理所选并写入…' }))
    const dialog = await screen.findByRole('dialog', { name: '写入笔记' })
    expect(within(dialog).queryByRole('button', { name: '原样' })).toBe(null)
    expect(within(dialog).getByText(/一起整理成共识、分歧/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('combobox', { name: '方式' }))
    expect(await screen.findByRole('option', { name: '存为新笔记' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /替换/ })).toBe(null)
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    fireEvent.click(within(dialog).getByRole('button', { name: '生成整理结果' }))
    await waitFor(() => expect(api.organize).toHaveBeenCalledWith({ answers: [{ discussionId: two.id, turnId: hex(11), answerId: hex(21) }, { discussionId: two.id, turnId: hex(12), answerId: hex(22) }] }))
    fireEvent.click(await within(dialog).findByRole('button', { name: '预览差异' }))
    fireEvent.click(await within(dialog).findByRole('button', { name: '确认写入' }))
    await waitFor(() => expect(api.capture).toHaveBeenCalledWith(expect.objectContaining({ mode: 'organized', text: '共识：都是金属。分歧：钛更贵。', answers: expect.arrayContaining([expect.objectContaining({ answerId: hex(21) }), expect.objectContaining({ answerId: hex(22) })]) })))
  })
})

describe('branch graph', () => {
  const turn = (n: number, parents: number[], answer?: string) => ({ id: hex(30 + n), parents: parents.map(parent => hex(30 + parent)), question: `问题${n}`, sourceIds: [], requestKey: 'k' + n, answers: answer ? [{ id: hex(40 + n), text: answer, createdAt: n }] : [], createdAt: n })
  const branched: DiscussionDTO = { id: hex(1), title: '分叉', origin: { kind: 'chat' }, revision: 5, archived: false, createdAt: 1, updatedAt: 5, turns: [turn(1, [], '根回答'), turn(2, [1], 'A 回答'), turn(3, [1], 'B 回答'), turn(4, [2, 3])] }

  it('is offered only when there is more than one question, shows each node with its state and merges, and jumps to the chosen question', async () => {
    vi.mocked(api.discussions).mockResolvedValue([summary(branched)])
    vi.mocked(api.discussionView).mockResolvedValue({ discussion: branched, captures: [], sources: {}, runs: [] })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /分叉/ }))
    fireEvent.click(await screen.findByRole('button', { name: '分支图' }))
    const graph = screen.getByRole('group', { name: '分支图' })
    expect(within(graph).getAllByRole('button')).toHaveLength(4)
    expect(within(graph).getByRole('button', { name: '问题：问题1（已回答）' })).toBeTruthy()
    expect(within(graph).getByRole('button', { name: '合并比较：问题4（未回答）' })).toBeTruthy()
    expect(within(graph).getByText(/合并 2 条/)).toBeTruthy()
    // One path per parent into the merge, drawn dashed.
    expect(graph.querySelectorAll('path[data-merge]')).toHaveLength(2)
    expect(graph.querySelectorAll('path')).toHaveLength(4)
    const scrolled = vi.mocked(HTMLElement.prototype.scrollIntoView)
    scrolled.mockClear()
    fireEvent.click(within(graph).getByRole('button', { name: '问题：问题3（已回答）' }))
    expect(scrolled).toHaveBeenCalled()
    const target = document.getElementById('turn-' + hex(33))!
    expect(document.activeElement).toBe(target)
    expect(target.getAttribute('data-reached')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '收起分支图' }))
    expect(screen.queryByRole('group', { name: '分支图' })).toBe(null)
  })

  it('is not offered for a single question', async () => {
    const single = discussion(hex(2), '只有一个问题', '回答')
    vi.mocked(api.discussions).mockResolvedValue([summary(single)])
    vi.mocked(api.discussionView).mockResolvedValue({ discussion: single, captures: [], sources: {}, runs: [] })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /只有一个问题/ }))
    await screen.findByText('回答')
    expect(screen.queryByRole('button', { name: '分支图' })).toBe(null)
  })

  it('shows a question that is still generating or failed distinctly from an answered one', async () => {
    const live: DiscussionDTO = { ...branched, turns: [turn(1, [], '根回答'), turn(2, [1]), turn(3, [1])] }
    vi.mocked(api.discussions).mockResolvedValue([summary(live)])
    vi.mocked(api.discussionView).mockResolvedValue({ discussion: live, captures: [], sources: {}, runs: [
      { id: hex(51), discussionId: live.id, turnId: hex(32), requestKey: 'x', status: 'running', text: '', seq: 1, createdAt: 1, updatedAt: 1 },
      { id: hex(52), discussionId: live.id, turnId: hex(33), requestKey: 'y', status: 'failed', text: '', seq: 1, createdAt: 1, updatedAt: 1, error: '失败' },
    ] })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /分叉/ }))
    fireEvent.click(await screen.findByRole('button', { name: '分支图' }))
    const graph = screen.getByRole('group', { name: '分支图' })
    expect(within(graph).getByRole('button', { name: '问题：问题2（生成中）' })).toBeTruthy()
    expect(within(graph).getByRole('button', { name: '问题：问题3（未成功）' })).toBeTruthy()
  })
})
