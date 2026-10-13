// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { findTextRange, plainText } from '../src/reveal'

const root = (html: string) => { const element = document.createElement('div'); element.innerHTML = html; document.body.append(element); return element }

describe('finding a quoted passage in the rendered note', () => {
  it('matches Markdown source against rendered text across inline formatting and line breaks', () => {
    const editor = root('<p>前言。</p><ul><li><strong>铝</strong>很轻，</li></ul><p>密度约 <em>2.7</em>。</p>')
    const range = findTextRange(editor, '- **铝**很轻，\n  密度约 *2.7*。')!
    expect(range.toString()).toBe('铝很轻，密度约 2.7。')
    expect(range.startContainer.parentElement?.tagName).toBe('STRONG')
  })

  it('falls back to the longest line when a long selection no longer matches as a whole', () => {
    const editor = root('<p>第一段已被改写。</p><p>这一行保持不变，可以被找到。</p>')
    expect(findTextRange(editor, '第一段原来的文字\n这一行保持不变，可以被找到。')!.toString()).toBe('这一行保持不变，可以被找到。')
  })

  it('returns null rather than guessing when nothing matches, and ignores marker-only quotes', () => {
    const editor = root('<p>只有这些内容。</p>')
    expect(findTextRange(editor, '完全不同')).toBeNull()
    expect(findTextRange(editor, '***')).toBeNull()
    expect(plainText('# a *b*_ `c`')).toBe('abc')
    expect(plainText('- 项目\n  1. 编号\n> 引用')).toBe('项目编号引用')
  })
})
