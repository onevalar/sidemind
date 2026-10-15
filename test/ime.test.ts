// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { composing } from '../src/ime'

const key = (init: KeyboardEventInit & { keyCode?: number }) => new KeyboardEvent('keydown', { key: 'Enter', ...init })
describe('composing', () => {
  it('is true while the browser reports composition (Chrome, Firefox)', () => {
    expect(composing(key({ isComposing: true }))).toBe(true)
  })
  it("is true for the Enter that confirms a candidate in Safari: composition already ended but keyCode is 229", () => {
    expect(composing(key({ isComposing: false, keyCode: 229 }))).toBe(true)
  })
  it('is false for an ordinary Enter, and accepts React-style synthetic events', () => {
    expect(composing(key({ keyCode: 13 }))).toBe(false)
    expect(composing({ nativeEvent: key({ keyCode: 13 }) })).toBe(false)
    expect(composing({ nativeEvent: key({ keyCode: 229 }) })).toBe(true)
  })
})
