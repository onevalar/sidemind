import { describe, expect, it } from 'vitest'
import { parseBlocks, replaceRange } from '../server/markdown'

describe('parseBlocks', () => {
  it('splits every kind of top-level block, including tables, rules and html', () => {
    const md = '# T\n\npara\n\n- a\n- b\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n---\n\n<div>x</div>\n\n```js\nlet a\n```\n\n> q'
    expect(parseBlocks(md).map((b) => b.type)).toEqual([
      'heading-1', 'paragraph', 'list', 'table', 'thematicBreak', 'html', 'code', 'blockquote',
    ])
  })

  it('gives exact offsets so raw text matches the source slice', () => {
    const md = 'one\n\ntwo\nlines\n\n```\ncode\n```\n'
    for (const b of parseBlocks(md)) expect(md.slice(b.start, b.end)).toBe(b.raw)
  })

  it('treats CRLF files the same as LF files', () => {
    const lf = '# T\n\nPara one.\n\n```js\nx\n```\n\nPara two.'
    const crlf = lf.replace(/\n/g, '\r\n')
    const a = parseBlocks(lf)
    const b = parseBlocks(crlf)
    expect(b.map((x) => x.type)).toEqual(a.map((x) => x.type))
    expect(b.map((x) => x.hash)).toEqual(a.map((x) => x.hash))
    expect(crlf.slice(b[3]!.start, b[3]!.end)).toBe('Para two.')
  })

  it('hash is deterministic (not a per-process random hash)', () => {
    // Computed independently: printf 'paragraph\nHello world' | shasum -a 256 | cut -c1-16
    expect(parseBlocks('Hello world')[0]!.hash).toBe('810f54a589da99fe')
  })

  it('replaceRange touches only the target block', () => {
    const md = 'A\n\nB\n\nC'
    const [, b] = parseBlocks(md)
    expect(replaceRange(md, b!.start, b!.end, 'BB')).toBe('A\n\nBB\n\nC')
  })
})
