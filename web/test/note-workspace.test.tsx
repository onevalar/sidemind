// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteDTO } from '../shared/types'
import { NoteWorkspace } from '../src/NoteWorkspace'
import { api } from '../src/api'

// Exercise the real workspace, both editors and note session; only the server is mocked.
vi.mock('../src/api', () => ({
  api: { loadNote: vi.fn(), saveContent: vi.fn(), proposeEdit: vi.fn() },
  subscribeEvents: () => () => {},
}))

const original = '# Note\r\n\r\nBefore stays.\r\n\r\nOriginal first line.\r\nOriginal second line.\r\n\r\nAfter stays.\r\n'
const selected = 'Original first line.\r\nOriginal second line.'
const replacement = 'Revised first line.\r\nRevised second line.'
const nativeText = (content: string) => content.replace(/\r\n/g, '\n')
let disk: NoteDTO

// jsdom has no layout; editor geometry is verified in Chromium instead.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList
Range.prototype.getBoundingClientRect = () => new DOMRect()

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  disk = { name: 'Note.md', content: original, space: '个人灵感' }
  vi.mocked(api.loadNote).mockImplementation(async () => structuredClone(disk))
  vi.mocked(api.saveContent).mockImplementation(async (_, content, expected) => {
    if (disk.content !== expected) throw new Error('笔记已在其他地方修改，请重新载入后再保存。')
    disk = { ...disk, content }
    return structuredClone(disk)
  })
  vi.mocked(api.proposeEdit).mockResolvedValue({ replacement })
})
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals() })

const open = async (source = true) => {
  render(<NoteWorkspace name="Note.md" beforeLeave={{ current: async () => true }} onUpdated={() => {}}
    onConfigureAI={() => {}} aiModel="test-model" theme="light" onOpenNote={() => {}} onBack={() => {}}/>)
  await screen.findByRole('textbox', { name: '文章正文' })
  await waitFor(() => expect(screen.queryByText('正在准备编辑器…')).toBe(null))
  if (!source) return await screen.findByRole('textbox', { name: '文章正文' })
  await screen.findByRole('button', { name: '源码' })
  fireEvent.click(screen.getByRole('button', { name: '源码' }))
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
  it('keeps empty paragraphs editable and saves the latest rich text before leaving', async () => {
    disk.content = '# Note\r\n\r\nBefore stays.\r\n\r\n<br />\r\n\r\nAfter stays.\r\n'
    const beforeLeave = { current: async () => true }
    render(<NoteWorkspace name="Note.md" beforeLeave={beforeLeave} onUpdated={() => {}}
      onConfigureAI={() => {}} aiModel="test-model" theme="light" onOpenNote={() => {}} onBack={() => {}}/>)
    const editor = await screen.findByRole('textbox', { name: '文章正文' })
    await waitFor(() => expect(screen.queryByText('正在准备编辑器…')).toBe(null))
    expect(screen.queryByRole('textbox', { name: 'Markdown 正文' })).toBe(null)
    expect(api.saveContent).not.toHaveBeenCalled()
    await act(async () => {
      editor.querySelector('p')!.firstChild!.textContent = 'Immediately saved edit.'
      fireEvent.input(editor, { inputType: 'insertText', data: 'Immediately saved edit.' })
    })
    await act(async () => { expect(await beforeLeave.current()).toBe(true) })
    expect(disk.content).toBe('# Note\r\n\r\nImmediately saved edit.\r\n\r\n<br />\r\n\r\nAfter stays.\r\n')
    expect(screen.getByRole('textbox', { name: '文章正文' })).toBe(editor)
  })

  it('preserves frontmatter, reference links and HTML in source mode without rewriting on open', async () => {
    disk.content = '---\r\ntitle: 保留原文\r\n---\r\n\r\n# Note\r\n\r\n[链接][ref]\r\n\r\n[ref]: https://example.com "Title"\r\n\r\n<div>原始 HTML</div>\r\n'
    render(<NoteWorkspace name="Note.md" beforeLeave={{ current: async () => true }} onUpdated={() => {}}
      onConfigureAI={() => {}} aiModel="test-model" theme="light" onOpenNote={() => {}} onBack={() => {}}/>)
    const editor = await screen.findByRole('textbox', { name: 'Markdown 正文' }) as HTMLTextAreaElement
    expect(editor.value).toBe(nativeText(disk.content))
    expect(screen.getByText(/包含需要保留原样/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '写作' }))
    expect(screen.queryByRole('textbox', { name: '文章正文' })).toBe(null)
    await act(async () => { fireEvent.keyDown(editor, { key: 's', ctrlKey: true }) })
    expect(api.saveContent).not.toHaveBeenCalled()
  })

  it('replaces the selected second occurrence in rich text, then restores the original file on undo', async () => {
    disk.content = '# Note\n\nRepeated phrase.\n\nBetween stays.\n\nPrefix Repeated phrase. Suffix\n\nAfter stays.\n'
    const saved = disk.content
    vi.mocked(api.proposeEdit).mockResolvedValue({ replacement: 'Only this occurrence.' })
    const editor = await open(false)
    const paragraphs = editor.querySelectorAll('p')
    const selectedNode = paragraphs[2]!.firstChild!
    act(() => {
      editor.focus()
      const range = document.createRange()
      range.setStart(selectedNode, 'Prefix '.length)
      range.setEnd(selectedNode, 'Prefix Repeated phrase.'.length)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(range)
      fireEvent(document, new Event('selectionchange'))
    })
    const preview = await propose()
    expect(screen.getByText('已选择的文字')).toBeTruthy()
    expect(api.proposeEdit).toHaveBeenCalledWith('Repeated phrase.\n', 'Make this clearer.', expect.any(AbortSignal))
    expect(disk.content).toBe(saved)
    await act(async () => { fireEvent.click(within(preview).getByRole('button', { name: '应用修改' })) })
    await waitFor(() => expect(disk.content).toBe('# Note\n\nRepeated phrase.\n\nBetween stays.\n\nPrefix Only this occurrence. Suffix\n\nAfter stays.\n'))
    expect(editor.textContent).toContain('Only this occurrence.')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '撤销上次保存' })) })
    await waitFor(() => expect(disk.content).toBe(saved))
    expect(editor.textContent).not.toContain('Only this occurrence.')
  })

  it('renders Markdown in the editable document without a toolbar and switches to source without writing the file', async () => {
    const editor = await open() as HTMLTextAreaElement
    const draft = '# Fresh title\n\nAn asymmetric **strong** paragraph.\n\nKeep this ending.\n'
    fireEvent.change(editor, { target: { value: draft } })
    const resumeFrom = draft.indexOf('Keep this'), resumeTo = resumeFrom + 'Keep this'.length
    editor.focus(); editor.setSelectionRange(resumeFrom, resumeTo, 'backward')
    fireEvent.select(editor)
    fireEvent.click(screen.getByRole('button', { name: '写作' }))
    const rich = await screen.findByRole('textbox', { name: '文章正文' })
    expect(within(rich).getByRole('heading', { name: 'Fresh title' })).toBeTruthy()
    expect(rich.querySelector('strong')?.textContent).toBe('strong')
    expect(rich.getAttribute('contenteditable')).toBe('true')
    expect(screen.queryByRole('button', { name: '斜体' })).toBe(null)
    expect(api.saveContent).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '源码' }))
    const reopened = screen.getByRole('textbox', { name: 'Markdown 正文' }) as HTMLTextAreaElement
    expect(reopened.value).toBe(draft)
    expect(reopened.selectionStart).toBe(resumeFrom)
    expect(reopened.selectionEnd).toBe(resumeTo)
    expect(reopened.selectionDirection).toBe('backward')
    await act(async () => { fireEvent.keyDown(reopened, { key: 's', ctrlKey: true }) })
    expect(disk.content).toBe(draft)
    expect(screen.getByRole('status').textContent).toBe('已保存')
  })

  it('keeps an editable outline current, ignores code headings and navigates CRLF and changed drafts without changing content', async () => {
    disk.content = '# Note\r\n\r\nA longer introductory paragraph.\r\n\r\n```md\r\n## Not a section\r\n```\r\n\r\n### Target\r\n\r\nKeep this ending.\r\n'
    const editor = await open() as HTMLTextAreaElement, saved = disk.content
    const toggle = screen.getByRole('button', { name: '目录' })
    expect(screen.queryByRole('complementary', { name: '本文目录' })).toBe(null)
    fireEvent.click(toggle)
    expect(screen.queryByRole('button', { name: '定位到：Not a section' })).toBe(null)
    fireEvent.click(screen.getByRole('button', { name: '定位到：Target' }))
    expect(editor.selectionStart).toBe(editor.value.indexOf('### Target'))
    expect(editor.selectionEnd).toBe(editor.selectionStart)
    expect(document.activeElement).toBe(editor)
    expect(editor.value).toBe(nativeText(saved))

    const draft = nativeText(saved).replace('A longer introductory paragraph.', 'A newly expanded introduction with a different length.').replace('### Target', '### Revised target')
    fireEvent.change(editor, { target: { value: draft } })
    expect(screen.queryByRole('button', { name: '定位到：Target' })).toBe(null)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(toggle)
    expect(screen.queryByRole('complementary', { name: '本文目录' })).toBe(null)
    fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('button', { name: '定位到：Revised target' }))
    expect(editor.selectionStart).toBe(draft.indexOf('### Revised target'))
    expect(document.activeElement).toBe(editor)
    expect(editor.value).toBe(draft)
    expect(disk.content).toBe(saved)
    expect(screen.getByRole('status').textContent).toContain('未保存')
    fireEvent.click(screen.getByRole('button', { name: '关闭目录' }))
    expect(screen.queryByRole('complementary', { name: '本文目录' })).toBe(null)
    expect(document.activeElement).toBe(toggle)
    fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('button', { name: 'AI 助手' }))
    expect(screen.queryByRole('complementary', { name: '本文目录' })).toBe(null)
    fireEvent.click(toggle)
    expect(screen.queryByRole('button', { name: '关闭 AI 助手' })).toBe(null)
  })

  it('opens the full article editor by default and previews a whole-article suggestion without changing the article', async () => {
    const editor = await open(false)
    expect(editor.textContent).toContain('Original first line.')
    expect(screen.queryByRole('button', { name: '分栏预览' })).toBe(null)

    const preview = await propose()
    expect(screen.getByText('当前整篇文章')).toBeTruthy()
    expect(api.proposeEdit).toHaveBeenCalledWith(original, 'Make this clearer.', expect.any(AbortSignal))
    expect(within(preview).getByText('尚未应用')).toBeTruthy()
    expect((within(preview).getByRole('button', { name: '应用修改' }) as HTMLButtonElement).disabled).toBe(false)
    expect(editor.textContent).toContain('Original first line.')
    expect(disk.content).toBe(original)
    expect(api.saveContent).not.toHaveBeenCalled()
  })

  it('maps native LF selection offsets to CRLF source and replaces only that selection after applying', async () => {
    const editor = await open() as HTMLTextAreaElement
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
    const editor = await open() as HTMLTextAreaElement
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
