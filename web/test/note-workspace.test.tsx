// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteDTO } from '../shared/types'
import { NoteWorkspace } from '../src/NoteWorkspace'
import { api } from '../src/api'

// Exercise the real workspace, uiw editor, preview and note session; only the server is mocked.
vi.mock('../src/api', () => ({
  api: { loadNote: vi.fn(), saveContent: vi.fn(), proposeEdit: vi.fn() },
  subscribeEvents: () => () => {},
}))

const original = '# Note\r\n\r\nBefore stays.\r\n\r\nOriginal first line.\r\nOriginal second line.\r\n\r\nAfter stays.\r\n'
const selected = 'Original first line.\r\nOriginal second line.'
const replacement = 'Revised first line.\r\nRevised second line.'
const nativeText = (content: string) => content.replace(/\r\n/g, '\n')
let disk: NoteDTO

beforeEach(() => {
  disk = { name: 'Note.md', content: original, space: '个人灵感' }
  vi.mocked(api.loadNote).mockImplementation(async () => structuredClone(disk))
  vi.mocked(api.saveContent).mockImplementation(async (_, content, expected) => {
    if (disk.content !== expected) throw new Error('笔记已在其他地方修改，请重新载入后再保存。')
    disk = { ...disk, content }
    return structuredClone(disk)
  })
  vi.mocked(api.proposeEdit).mockResolvedValue({ replacement })
})
afterEach(() => { cleanup(); vi.resetAllMocks() })

const open = async () => {
  render(<NoteWorkspace name="Note.md" beforeLeave={{ current: async () => true }} onUpdated={() => {}}
    onConfigureAI={() => {}} aiModel="test-model" theme="light" onOpenNote={() => {}} onBack={() => {}}/>)
  return await screen.findByRole('textbox', { name: 'Markdown 正文' }) as HTMLTextAreaElement
}
const selectText = (editor: HTMLTextAreaElement) => {
  const text = nativeText(selected)
  const start = editor.value.indexOf(text)
  expect(start).toBeGreaterThan(-1)
  editor.focus()
  editor.setSelectionRange(start, start + text.length)
  fireEvent.select(editor)
}
const propose = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'AI 助手' }))
  fireEvent.change(screen.getByRole('textbox', { name: '修改要求' }), { target: { value: 'Make this clearer.' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '生成修改建议' })) })
  return screen.findByRole('region', { name: '修改预览' })
}

describe('article editing and deliberate AI application', () => {
  it('formats selected text, switches between editing and previews without losing the draft, and saves it', async () => {
    const editor = await open()
    const draft = '# Fresh title\n\nAn asymmetric **strong** paragraph.\n\n<h2 onclick="alert(1)">Embedded heading</h2>\n\n```js\nconst result = 19;\n```\n\nKeep this ending.\n'
    fireEvent.change(editor, { target: { value: draft } })
    const from = draft.indexOf('asymmetric')
    editor.focus(); editor.setSelectionRange(from, from + 'asymmetric'.length)
    fireEvent.click(screen.getByRole('button', { name: '斜体' }))
    const formatted = draft.replace('asymmetric', '*asymmetric*')
    expect(editor.value).toBe(formatted)

    const resumeFrom = formatted.indexOf('Keep this'), resumeTo = resumeFrom + 'Keep this'.length
    editor.focus(); editor.setSelectionRange(resumeFrom, resumeTo, 'backward')
    fireEvent.select(editor)
    fireEvent.click(screen.getByRole('button', { name: '分栏预览' }))
    expect(screen.getByRole('button', { name: '分栏预览' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('textbox', { name: 'Markdown 正文' })).toBe(editor)
    expect(screen.getByRole('heading', { name: 'Fresh title' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Embedded heading' }).hasAttribute('onclick')).toBe(false)
    expect(screen.getByText('const result = 19;').textContent).toBe('const result = 19;\n')
    fireEvent.click(screen.getByRole('button', { name: '阅读模式' }))
    expect(screen.queryByRole('textbox', { name: 'Markdown 正文' })).toBe(null)
    expect(screen.getByRole('heading', { name: 'Fresh title' })).toBeTruthy()
    expect(screen.getByText('Keep this ending.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    const reopened = screen.getByRole('textbox', { name: 'Markdown 正文' }) as HTMLTextAreaElement
    expect(reopened.value).toBe(formatted)
    expect(reopened.selectionStart).toBe(resumeFrom)
    expect(reopened.selectionEnd).toBe(resumeTo)
    expect(reopened.selectionDirection).toBe('backward')
    fireEvent.click(screen.getByRole('button', { name: 'AI 助手' }))
    expect(screen.getByText('已选择的文字')).toBeTruthy()
    await act(async () => { fireEvent.keyDown(reopened, { key: 's', ctrlKey: true }) })
    expect(disk.content).toBe(formatted)
    expect(screen.getByRole('status').textContent).toBe('已保存')
  })

  it('keeps an editable outline current, ignores code headings and navigates CRLF and changed drafts without changing content', async () => {
    disk.content = '# Note\r\n\r\nA longer introductory paragraph.\r\n\r\n```md\r\n## Not a section\r\n```\r\n\r\n### Target\r\n\r\nKeep this ending.\r\n'
    const editor = await open(), saved = disk.content
    expect(screen.queryByRole('button', { name: '定位到：Not a section' })).toBe(null)
    fireEvent.click(screen.getByRole('button', { name: '定位到：Target' }))
    expect(editor.selectionStart).toBe(editor.value.indexOf('### Target'))
    expect(editor.selectionEnd).toBe(editor.selectionStart)
    expect(document.activeElement).toBe(editor)
    expect(editor.value).toBe(nativeText(saved))

    const draft = nativeText(saved).replace('A longer introductory paragraph.', 'A newly expanded introduction with a different length.').replace('### Target', '### Revised target')
    fireEvent.change(editor, { target: { value: draft } })
    expect(screen.queryByRole('button', { name: '定位到：Target' })).toBe(null)
    const toggle = screen.getByRole('button', { name: '目录' })
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(toggle)
    fireEvent.click(screen.getByRole('button', { name: '定位到：Revised target' }))
    expect(editor.selectionStart).toBe(draft.indexOf('### Revised target'))
    expect(document.activeElement).toBe(editor)
    expect(editor.value).toBe(draft)
    expect(disk.content).toBe(saved)
    expect(screen.getByRole('status').textContent).toContain('未保存')
  })

  it('opens the full article editor by default and previews a whole-article suggestion without changing the article', async () => {
    const editor = await open()
    expect(editor.value).toBe(nativeText(original))
    expect(screen.getByRole('button', { name: '阅读模式' })).toBeTruthy()

    const preview = await propose()
    expect(screen.getByText('当前整篇文章')).toBeTruthy()
    expect(api.proposeEdit).toHaveBeenCalledWith(original, 'Make this clearer.', expect.any(AbortSignal))
    expect(within(preview).getByText('尚未应用')).toBeTruthy()
    expect((within(preview).getByRole('button', { name: '应用修改' }) as HTMLButtonElement).disabled).toBe(false)
    expect(editor.value).toBe(nativeText(original))
    expect(disk.content).toBe(original)
    expect(api.saveContent).not.toHaveBeenCalled()
  })

  it('maps native LF selection offsets to CRLF source and replaces only that selection after applying', async () => {
    const editor = await open()
    selectText(editor)
    const preview = await propose()
    expect(screen.getByText('已选择的文字')).toBeTruthy()
    expect(api.proposeEdit).toHaveBeenCalledWith(selected, 'Make this clearer.', expect.any(AbortSignal))
    expect(editor.value).toBe(nativeText(original))
    expect(disk.content).toBe(original)
    expect(api.saveContent).not.toHaveBeenCalled()

    await act(async () => { fireEvent.click(within(preview).getByRole('button', { name: '应用修改' })) })
    const expected = original.replace(selected, replacement)
    await waitFor(() => expect(disk.content).toBe(expected))
    expect(editor.value).toBe(nativeText(expected))
    expect(screen.queryByRole('region', { name: '修改预览' })).toBe(null)
  })

  it('refuses a stale suggestion after unsaved typing and preserves the newer draft', async () => {
    const editor = await open()
    selectText(editor)
    const preview = await propose()
    const draft = nativeText(original) + 'New unsaved writing.\n'
    fireEvent.change(editor, { target: { value: draft } })
    expect(screen.getByRole('status').textContent).toContain('未保存')
    expect(disk.content).toBe(original)

    await act(async () => { fireEvent.click(within(preview).getByRole('button', { name: '应用修改' })) })
    expect(screen.getByRole('alert').textContent).toContain('文章已发生变化')
    expect(editor.value).toBe(draft)
    expect(disk.content).toBe(original)
    expect(api.saveContent).not.toHaveBeenCalled()
    expect(screen.getByRole('region', { name: '修改预览' })).toBeTruthy()
  })
})
