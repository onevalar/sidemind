// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ExplorePanel } from '../src/ExplorePanel'
import { api } from '../src/api'

vi.mock('../src/api', () => ({
  api: { researchNote: vi.fn(), createSource: vi.fn(), createDraft: vi.fn(), updateDraft: vi.fn(), sendDraft: vi.fn(), startRun: vi.fn(), changeSet: vi.fn() },
  subscribeEvents: () => () => {},
  subscribeRun: vi.fn(() => () => {}),
}))
const hex = (n: number) => String(n).padStart(32, '0')
const idle = { current: async () => true } as React.MutableRefObject<() => Promise<boolean>>
const selection = (text: string) => ({ current: () => text }) as React.MutableRefObject<() => string | undefined>
const reveal = { current: () => false } as React.MutableRefObject<(quote: string, start: number | null) => boolean>

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn()
  vi.mocked(api.researchNote).mockResolvedValue({ noteId: hex(6), discussions: [], drafts: [], captures: [], sources: {}, runs: [] })
  vi.mocked(api.createSource).mockResolvedValue({ id: hex(2), noteId: hex(6), notePath: 'Materials.md', noteVersion: 'v', quote: '铝很轻。', before: '', after: '', section: '', start: 0, end: 4, createdAt: 1 })
  vi.mocked(api.createDraft).mockImplementation(async input => ({ id: hex(4), title: '', discussionId: null, parentIds: [], origin: { kind: 'chat' }, items: input.items, revision: 1, createdAt: 1, updatedAt: 1 }))
  vi.mocked(api.sendDraft).mockRejectedValue(new Error('停在这里'))
})
afterEach(() => { cleanup(); vi.resetAllMocks() })

const mount = (model: string | null = 'm') => render(<ExplorePanel name="Materials.md" model={model} active beforeSend={idle} selection={selection('铝很轻。')} reveal={reveal} onConfigure={() => {}} onOpenNote={() => {}}/>)

it('asks "explain this" when a passage is selected and no question is written', async () => {
  mount()
  const ask = await screen.findByRole('button', { name: '提问' })
  await waitFor(() => expect((ask as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(ask)
  await waitFor(() => expect(api.createDraft).toHaveBeenCalledTimes(1))
  expect(vi.mocked(api.createDraft).mock.calls[0]![0]).toMatchObject({ items: [expect.objectContaining({ question: '请解释这段内容。', sourceIds: [hex(2)] })] })
  expect(api.sendDraft).toHaveBeenCalledWith(hex(4), [expect.objectContaining({ question: '请解释这段内容。' })])
})

it('keeps the typed question when there is one, and still needs a selection', async () => {
  mount()
  fireEvent.change(await screen.findByRole('textbox', { name: '你的问题' }), { target: { value: '为什么轻？' } })
  fireEvent.click(await screen.findByRole('button', { name: '提问' }))
  await waitFor(() => expect(api.createDraft).toHaveBeenCalledTimes(1))
  expect(vi.mocked(api.createDraft).mock.calls[0]![0]).toMatchObject({ items: [expect.objectContaining({ question: '为什么轻？' })] })
})

it('does not offer to ask without a selected passage', async () => {
  render(<ExplorePanel name="Materials.md" model="m" active beforeSend={idle} selection={selection('')} reveal={reveal} onConfigure={() => {}} onOpenNote={() => {}}/>)
  const ask = await screen.findByRole('button', { name: '提问' })
  expect((ask as HTMLButtonElement).disabled).toBe(true)
})
