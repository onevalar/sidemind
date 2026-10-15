// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteDTO } from '../shared/types'
import { NoteWorkspace } from '../src/NoteWorkspace'
import { api } from '../src/api'

// Real editors and note session. Agent conversations now belong to App, not this editor.
vi.mock('../src/api', () => ({ api: { loadNote: vi.fn(), saveContent: vi.fn() }, subscribeEvents: () => () => {} }))
const original = '# Note\r\n\r\nBefore stays.\r\n\r\nOriginal first line.\r\nOriginal second line.\r\n\r\nAfter stays.\r\n'
const selected = 'Original first line.\r\nOriginal second line.'
const nativeText = (content: string) => content.replace(/\r\n/g, '\n')
let disk: NoteDTO
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
    disk = { ...disk, content }; return structuredClone(disk)
  })
})
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals() })
const open = async (source = true, selection = { current: () => undefined as string | undefined }) => {
  render(<NoteWorkspace name="Note.md" beforeLeave={{ current: async () => true }} agentSelection={selection} theme="light" onOpenNote={() => {}} onBack={() => {}}/>)
  await screen.findByRole('textbox', { name: '文章正文' })
  await waitFor(() => expect(screen.queryByText('正在准备编辑器…')).toBe(null))
  if (!source) return screen.getByRole('textbox', { name: '文章正文' })
  fireEvent.click(screen.getByRole('button', { name: '源码' }))
  return screen.findByRole('textbox', { name: 'Markdown 正文' })
}

describe('revealing a saved passage', () => {
  it('selects the passage in the source editor with CRLF offsets mapped, and reports a missing one', async () => {
    const reveal = { current: (_quote: string, _start: number | null) => false }
    render(<NoteWorkspace name="Note.md" beforeLeave={{ current: async () => true }} reveal={reveal} theme="light" onOpenNote={() => {}} onBack={() => {}}/>)
    await screen.findByRole('textbox', { name: '文章正文' })
    await waitFor(() => expect(screen.queryByText('正在准备编辑器…')).toBe(null))
    fireEvent.click(screen.getByRole('button', { name: '源码' }))
    const editor = await screen.findByRole('textbox', { name: 'Markdown 正文' }) as HTMLTextAreaElement
    expect(reveal.current(selected, original.indexOf(selected))).toBe(true)
    expect(editor.value.slice(editor.selectionStart, editor.selectionEnd)).toBe(nativeText(selected))
    expect(reveal.current('不存在的文字', null)).toBe(false)
  })

  it('finds the passage in the rich editor and does not change the number of hooks between loading and loaded', async () => {
    const reveal = { current: (_quote: string, _start: number | null) => false }
    render(<NoteWorkspace name="Note.md" beforeLeave={{ current: async () => true }} reveal={reveal} theme="light" onOpenNote={() => {}} onBack={() => {}}/>)
    await screen.findByRole('textbox', { name: '文章正文' })
    await waitFor(() => expect(screen.queryByText('正在准备编辑器…')).toBe(null))
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    expect(reveal.current('Before stays.', null)).toBe(true)
    expect(scroll).toHaveBeenCalled()
  })
})

describe('article editing with the shared Agent', () => {
  it('keeps empty paragraphs editable and saves the latest rich text before leaving', async () => {
    disk.content = '# Note\r\n\r\nBefore stays.\r\n\r\n<br />\r\n\r\nAfter stays.\r\n'
    const beforeLeave = { current: async () => true }
    render(<NoteWorkspace name="Note.md" beforeLeave={beforeLeave} theme="light" onOpenNote={() => {}} onBack={() => {}}/>)
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
    render(<NoteWorkspace name="Note.md" beforeLeave={{ current: async () => true }} theme="light" onOpenNote={() => {}} onBack={() => {}}/>)
    const editor = await screen.findByRole('textbox', { name: 'Markdown 正文' }) as HTMLTextAreaElement
    expect(editor.value).toBe(nativeText(disk.content))
    expect(screen.getByText(/包含需要保留原样/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '写作' }))
    expect(screen.queryByRole('textbox', { name: '文章正文' })).toBe(null)
    await act(async () => { fireEvent.keyDown(editor, { key: 's', ctrlKey: true }) })
    expect(api.saveContent).not.toHaveBeenCalled()
  })

  it('renders editable Markdown and preserves backward source selection across mode switches', async () => {
    const editor = await open() as HTMLTextAreaElement
    const draft = '# Fresh title\n\nAn asymmetric **strong** paragraph.\n\nKeep this ending.\n'
    fireEvent.change(editor, { target: { value: draft } })
    const start = draft.indexOf('Keep this'), end = start + 'Keep this'.length
    editor.focus(); editor.setSelectionRange(start, end, 'backward'); fireEvent.select(editor)
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
    expect([reopened.selectionStart, reopened.selectionEnd, reopened.selectionDirection]).toEqual([start, end, 'backward'])
    await act(async () => { fireEvent.keyDown(reopened, { key: 's', ctrlKey: true }) })
    expect(disk.content).toBe(draft)
    fireEvent.keyDown(screen.getByRole('button', { name: '文章更多操作' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitem', { name: '撤销上次保存' }))
    await waitFor(() => expect(disk.content).toBe(original))
    expect(disk.content).toBe(original)
  })

  it('keeps the outline current, ignores code headings and navigates CRLF without writing', async () => {
    disk.content = '# Note\r\n\r\nIntroduction.\r\n\r\n```md\r\n## Not a section\r\n```\r\n\r\n### Target\r\n\r\nKeep this ending.\r\n'
    const editor = await open() as HTMLTextAreaElement, saved = disk.content
    const toggle = screen.getByRole('button', { name: '目录' })
    fireEvent.click(toggle)
    expect(screen.queryByRole('button', { name: '定位到：Not a section' })).toBe(null)
    fireEvent.click(screen.getByRole('button', { name: '定位到：Target' }))
    await waitFor(() => expect(editor.selectionStart).toBe(editor.value.indexOf('### Target')))
    expect(document.activeElement).toBe(editor)
    const draft = nativeText(saved).replace('Introduction.', 'New expanded introduction.').replace('### Target', '### Revised target')
    fireEvent.change(editor, { target: { value: draft } })
    expect(screen.queryByRole('button', { name: '定位到：Target' })).toBe(null)
    fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('button', { name: '定位到：Revised target' }))
    await waitFor(() => expect(editor.selectionStart).toBe(draft.indexOf('### Revised target')))
    expect(editor.value).toBe(draft)
    expect(disk.content).toBe(saved)
    fireEvent.click(toggle)
    fireEvent.keyDown(screen.getByRole('dialog', { name: '本文目录' }), { key: 'Escape' })
    await waitFor(() => expect(document.activeElement).toBe(toggle))
  })

  it('provides the original CRLF selected text as an Agent reference without changing the file', async () => {
    const selection = { current: () => undefined as string | undefined }
    const editor = await open(true, selection) as HTMLTextAreaElement
    const start = editor.value.indexOf(nativeText(selected))
    editor.focus(); editor.setSelectionRange(start, start + nativeText(selected).length); fireEvent.select(editor)
    expect(selection.current()).toBe(selected)
    expect(disk.content).toBe(original)
  })
})


describe('reading, writing and exploring a note', () => {
  it('previews the latest unsaved source, keeps reading non-editable, and restores source selection', async () => {
    const editor = await open() as HTMLTextAreaElement
    const draft = '# Revised note\n\nA paragraph to read and explore.\n'
    fireEvent.change(editor, { target: { value: draft } })
    const start = draft.indexOf('paragraph')
    editor.setSelectionRange(start, start + 9, 'backward'); fireEvent.select(editor)
    fireEvent.click(screen.getByRole('button', { name: '阅读' }))
    const preview = screen.getByRole('article', { name: '文章阅读预览' })
    expect(within(preview).getByRole('heading', { name: 'Revised note' })).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: '文章正文' })).toBe(null)
    expect(screen.queryByRole('textbox', { name: 'Markdown 正文' })).toBe(null)
    expect(api.saveContent).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '源码' }))
    const returned = screen.getByRole('textbox', { name: 'Markdown 正文' }) as HTMLTextAreaElement
    expect(returned.value).toBe(draft)
    expect([returned.selectionStart, returned.selectionEnd, returned.selectionDirection]).toEqual([start, start + 9, 'backward'])
  })

  it('offers exploration only for a real selection and passes exact CRLF source text without saving', async () => {
    const explore = vi.fn()
    render(<NoteWorkspace name="Note.md" beforeLeave={{ current: async () => true }} theme="light" onExplore={explore} onOpenNote={() => {}} onBack={() => {}}/>)
    await screen.findByRole('textbox', { name: '文章正文' })
    await waitFor(() => expect(screen.queryByText('正在准备编辑器…')).toBe(null))
    expect(screen.queryByRole('region', { name: '选区探索' })).toBe(null)
    fireEvent.click(screen.getByRole('button', { name: '源码' }))
    const editor = screen.getByRole('textbox', { name: 'Markdown 正文' }) as HTMLTextAreaElement
    const start = editor.value.indexOf(nativeText(selected))
    editor.setSelectionRange(start, start + nativeText(selected).length); fireEvent.select(editor)
    fireEvent.click(screen.getByRole('button', { name: '探索选区' }))
    expect(explore).toHaveBeenCalledExactlyOnceWith(selected)
    expect(api.saveContent).not.toHaveBeenCalled()
    editor.setSelectionRange(start, start); fireEvent.select(editor)
    expect(screen.queryByRole('region', { name: '选区探索' })).toBe(null)
  })

  it('captures a reading selection for exploration and clears it when returning to writing', async () => {
    const explore = vi.fn(), selection = { current: () => undefined as string | undefined }
    render(<NoteWorkspace name="Note.md" beforeLeave={{ current: async () => true }} agentSelection={selection} theme="light" onExplore={explore} onOpenNote={() => {}} onBack={() => {}}/>)
    await screen.findByRole('textbox', { name: '文章正文' })
    await waitFor(() => expect(screen.queryByText('正在准备编辑器…')).toBe(null))
    fireEvent.click(screen.getByRole('button', { name: '阅读' }))
    const preview = screen.getByRole('article', { name: '文章阅读预览' })
    const text = within(preview).getByText('Before stays.').firstChild!
    const range = document.createRange(); range.selectNodeContents(text)
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
    fireEvent.mouseUp(preview)
    expect(selection.current()).toBe('Before stays.')
    fireEvent.click(screen.getByRole('button', { name: '探索选区' }))
    expect(explore).toHaveBeenCalledExactlyOnceWith('Before stays.')
    fireEvent.click(screen.getByRole('button', { name: '写作' }))
    expect(screen.queryByRole('region', { name: '选区探索' })).toBe(null)
    expect(api.saveContent).not.toHaveBeenCalled()
  })
})


it('maps a real rich-text paragraph selection to original text without synthetic heading markers', async () => {
  disk.content = '# 阅读\n\n## 从问题出发\n\n先确定自己想理解什么，再寻找材料中的证据。继续阅读。\n'
  const selectedQuote = '先确定自己想理解什么，再寻找材料中的证据。'
  const agentSelection = { current: () => undefined as string | undefined }, explore = vi.fn()
  render(<NoteWorkspace name="Note.md" beforeLeave={{ current: async () => true }} agentSelection={agentSelection} theme="light" onExplore={explore} onOpenNote={() => {}} onBack={() => {}}/>)
  const editor = await screen.findByRole('textbox', { name: '文章正文' })
  await waitFor(() => expect(screen.queryByText('正在准备编辑器…')).toBe(null))
  const text = editor.querySelector('p')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, selectedQuote.length)
  editor.focus()
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
  fireEvent(document, new Event('selectionchange'))
  await waitFor(() => expect(agentSelection.current()).toBe(selectedQuote))
  fireEvent.click(screen.getByRole('button', { name: '探索选区' }))
  expect(explore).toHaveBeenCalledExactlyOnceWith(selectedQuote)
  expect(api.saveContent).not.toHaveBeenCalled()
})
