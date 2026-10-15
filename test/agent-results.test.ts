import { describe, expect, it } from 'vitest'
import { serializeToolResult } from '../server/agent'

describe('bounded Agent tool results', () => {
  it('preserves small results and returns parseable evidence with explicit truncation for oversized results', () => {
    const small = { content: '已读取', nextOffset: null }
    expect(JSON.parse(serializeToolResult(small))).toEqual(small)
    const encoded = serializeToolResult({ changeSet: 'completed-set', content: '\\"\n'.repeat(60000) })
    expect(encoded.length).toBeLessThanOrEqual(120000)
    const result = JSON.parse(encoded)
    expect(result).toMatchObject({ truncated: true, changeSet: 'completed-set', writeCompleted: true })
    expect(result.note).toContain('不要重复已成功的写入')
    expect(result.totalCharacters).toBeGreaterThan(120000)
  })
})
