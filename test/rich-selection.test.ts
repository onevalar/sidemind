import { describe, expect, it } from 'vitest'
import { richSelectionSource } from '../src/rich-selection'
import { locate } from '../server/discussions'

describe('rich selection source mapping', () => {
  it('quotes the selected paragraph without inheriting the preceding heading', () => {
    const raw = '# 阅读\n\n## 从问题出发\n\n先确定自己想理解什么，再寻找材料中的证据。继续阅读。\n'
    const selected = '先确定自己想理解什么，再寻找材料中的证据。'
    expect(richSelectionSource(raw, selected)).toBe(selected)
  })

  it.each([
    ['# Title\r\n\r\nBefore **strong** and [linked text](https://example.com) after.\r\n', 'Before strong and linked text after.', 'Before **strong** and [linked text](https://example.com) after.'],
    ['# Title\n\nA [linked text](https://example.com) here.', 'linked', 'linked'],
    ['## Heading text\n\nA paragraph.', 'Heading', 'Heading'],
    ['# Title\n\nAn **important phrase** here.', 'portant phr', 'portant phr'],
    ['A &amp; B and \\*literal\\* text.', 'A & B and *literal* text.', 'A &amp; B and \\*literal\\* text.'],
    ['Before `inline code` after.\n', 'inline code', 'inline code'],
    ['## Heading\r\n\r\nParagraph with **bold** words.\r\n', 'Heading\nParagraph with bold', 'Heading\r\n\r\nParagraph with **bold'],
  ])('returns an exact, locatable raw quote for %s', (raw, selected, expected) => {
    const quote = richSelectionSource(raw, selected)
    expect(quote).toBe(expected)
    const found = locate(raw, quote!)
    expect(found).toHaveLength(1)
    expect(raw.slice(found[0]!.start, found[0]!.end)).toBe(expected)
  })

  it('refuses to guess among repeated passages or missing selections', () => {
    expect(richSelectionSource('One **passage**. Another passage.', 'passage')).toBe(null)
    expect(richSelectionSource('Some text.', 'Missing')).toBe(null)
  })
})
