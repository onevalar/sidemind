import { describe, expect, it } from 'vitest'
import { editPreview } from '../src/edit-preview'

describe('lossless AI preview range', () => {
  it.each([
    ['', '新增\n'], ['删除\n', ''], ['同一行\n', '同一行'],
    ['重复\n重复\n旧\n重复\n', '重复\n重复\n新\n重复\n'],
    ['a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n'],
    ['开头\n旧一\n未变\n旧二\n结尾\n', '开头\n新一\n未变\n新二\n结尾\n'],
  ])('preserves all source characters for %j → %j', (original, replacement) => {
    const result = editPreview(original, replacement)
    expect(result.prefix + result.removed + result.suffix).toBe(original)
    expect(result.prefix + result.added + result.suffix).toBe(replacement)
    expect(result.changed).toBe(true)
  })
  it('focuses a long note on the changed paragraph without marking unchanged text as removed', () => {
    const prefix = Array.from({ length: 5000 }, (_, i) => `段落 ${i}\n`).join('')
    const suffix = '\n## 后续\n保持\n不变\n'
    const result = editPreview(prefix + '原文\n' + suffix, prefix + '建议\n' + suffix)
    expect(result.removed).toBe('原文\n')
    expect(result.added).toBe('建议\n')
    expect(result.hiddenLeading).toBe(4998)
    expect(result.hiddenTrailing).toBe(2)
    expect(result.leadingContext).toBe('段落 4998\n段落 4999\n')
  })
  it('recognizes identical and empty responses', () => {
    for (const value of ['', '正文', '正文\n']) {
      const result = editPreview(value, value)
      expect(result.changed).toBe(false)
      expect(result.removed).toBe('')
      expect(result.added).toBe('')
    }
  })
})
