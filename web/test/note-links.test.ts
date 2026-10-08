import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import type { Root, Link, Paragraph } from 'mdast'
import { describe, expect, it } from 'vitest'
import { captureContent, linkedNoteName, noteReference } from '../src/note-links'
import { NoteStore } from '../server/store'

describe('portable note references', () => {
  it('round-trips punctuation, Chinese, encoded separators in titles and special filename characters through Markdown', () => {
    const note = { name: '阅读 (#1) [draft]? 100%.md', title: '阅读 [草稿] **重点** _划线_ `代码` <img> \\ 路径' }
    const root = unified().use(remarkParse).parse(noteReference(note)) as Root
    const link = (root.children[0] as Paragraph).children[0] as Link
    expect(link.type).toBe('link')
    expect(link.children).toEqual([{ type: 'text', value: note.title, position: expect.any(Object) }])
    expect(linkedNoteName(link.url)).toBe(note.name)
    expect(noteReference(note)).not.toContain('<img>')
  })

  it('does not navigate external URLs, paths, hidden files, fragments or malformed escapes as local notes', () => {
    for (const href of ['https://example.com/a.md', 'javascript:a.md', 'file:///a.md', '/a.md', '../a.md', './.private.md', 'a/b.md', 'a%2Fb.md', 'a%5Cb.md', 'a%00.md', 'a.md#heading', 'a.md?x=1', 'a%ZZ.md', 'a.txt', 'a'.repeat(200) + '.md']) {
      expect(linkedNoteName(href), href).toBeNull()
    }
    expect(linkedNoteName('./中文.md')).toBe('中文.md')
    expect(linkedNoteName('a%252Fb.md')).toBe('a%2Fb.md')
  })

  it('creates an ordinary Markdown file with deduplicated references and independent space metadata', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cn-reference-'))
    try {
      const store = new NoteStore(dir)
      await store.init()
      const linked = { name: 'Welcome.md', title: '欢迎使用画布笔记' }
      const draft = captureContent('下一步的想法\n\n从已有观察继续。', [linked, linked])
      const name = await store.create(draft.title, draft.content)
      await store.saveSpace(name, '产品与设计')
      const loaded = await new NoteStore(dir).load(name)
      expect(loaded.space).toBe('产品与设计')
      expect(await fs.readFile(path.join(dir, name), 'utf8')).toBe(draft.content)
      expect(loaded.content.match(/\]\(\.\/Welcome\.md\)/g)).toHaveLength(1)
      expect(loaded.blocks.some(block => block.type === 'list' && block.raw.includes('./Welcome.md'))).toBe(true)
      expect((await store.search('已有观察')).map(note => note.name)).toContain(name)
      expect(captureContent('', [linked]).title).toBe('相关笔记')
      expect(captureContent('', []).title).toBe('未命名笔记')
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
})
