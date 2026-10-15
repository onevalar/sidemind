import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import type { Root, Link, List, Paragraph } from 'mdast'
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

  it('resolves sibling, nested and parent links relative to the source article', () => {
    for (const [href, source, expected] of [
      ['a/b.md', '', 'a/b.md'],
      ['./同伴%20notes.md', 'Work/Source.md', 'Work/同伴 notes.md'],
      ['Research/topic.md', 'Work/Source.md', 'Work/Research/topic.md'],
      ['../Sibling.md', 'Work/deep/Source.md', 'Work/Sibling.md'],
      ['../../Root.md', 'Work/deep/Source.md', 'Root.md'],
      ['%2e%2e/Other/n.md', 'Work/Source.md', 'Other/n.md'],
      ['./Research/../Sibling.md', 'Work/Source.md', 'Work/Sibling.md'],
    ] as const) expect(linkedNoteName(href, source), href).toBe(expected)
    expect(linkedNoteName('../escape.md', 'Root.md')).toBeNull()
    expect(linkedNoteName('../../../escape.md', 'Work/deep/Source.md')).toBeNull()
    expect(linkedNoteName('%2e%2e/escape.md')).toBeNull()
  })

  it('does not navigate external URLs, paths, hidden files, fragments or malformed escapes as local notes', () => {
    for (const href of ['https://example.com/a.md', 'javascript:a.md', 'file:///a.md', '/a.md', '//host/a.md', './.private.md', '.canvasnote/a.md', 'nested/%2Eprivate/a.md', 'a%2Fb.md', 'a%5Cb.md', 'a%00.md', 'a.md#heading', 'a.md?x=1', 'a%ZZ.md', 'a.txt', 'a'.repeat(200) + '.md']) {
      expect(linkedNoteName(href, 'Work/Source.md'), href).toBeNull()
    }
    expect(linkedNoteName('./中文.md')).toBe('中文.md')
    expect(linkedNoteName('a%252Fb.md')).toBe('a%2Fb.md')
  })

  it('generates folder-aware relative references that round-trip through Markdown', () => {
    for (const [folder, name, href] of [
      ['Work', 'Work/同伴 (#1).md', './%E5%90%8C%E4%BC%B4%20%28%231%29.md'],
      ['Work', 'Work/Research/topic.md', './Research/topic.md'],
      ['Work/Research', 'Work/Parent.md', '../Parent.md'],
      ['Work/Research', 'Root.md', '../../Root.md'],
      ['Work/Research', 'Other/topic.md', '../../Other/topic.md'],
      ['', 'Work/Research/topic.md', './Work/Research/topic.md'],
    ] as const) {
      const markdown = noteReference({ name, title: 'A [linked] article' }, folder)
      const root = unified().use(remarkParse).parse(markdown) as Root
      const link = (root.children[0] as Paragraph).children[0] as Link
      expect(link.url).toBe(href)
      expect(linkedNoteName(link.url, folder ? folder + '/Capture.md' : 'Capture.md')).toBe(name)
    }
  })

  it('creates a whole Markdown capture in a real folder with deduplicated, resolvable references', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cn-reference-'))
    try {
      const store = new NoteStore(dir)
      await store.init()
      await store.createFolder('Work')
      await store.createFolder('Work/Research')
      const references = [
        { name: 'Welcome.md', title: '欢迎使用 Sidemind' },
        { name: await store.create('同伴 (#1)', '# 同伴', 'Work'), title: '同伴' },
        { name: await store.create('Topic', '# Topic', 'Work/Research'), title: 'Topic' },
      ]
      const draft = captureContent('下一步的想法\n\n从已有观察继续。', [...references, references[0]!], 'Work')
      const name = await store.create(draft.title, draft.content, 'Work')
      const loaded = await new NoteStore(dir).load(name)
      expect(loaded).toEqual({ name, space: 'Work', content: draft.content })
      expect(await fs.readFile(path.join(dir, name), 'utf8')).toBe(draft.content)
      const list = unified().use(remarkParse).parse(loaded.content).children.find(node => node.type === 'list') as List
      const resolved = list.children.map(item => linkedNoteName(((item.children[0] as Paragraph).children[0] as Link).url, name))
      expect(resolved).toEqual(references.map(note => note.name))
      for (const reference of resolved) expect((await store.load(reference!)).name).toBe(reference)
      expect((await store.search('已有观察')).map(note => note.name)).toContain(name)
      expect(captureContent('', references).title).toBe('相关笔记')
      expect(captureContent('', []).title).toBe('未命名笔记')
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
})
