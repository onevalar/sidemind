// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest'
import { prefs } from '../src/prefs'

beforeEach(() => localStorage.clear())

it('reads what Canvas Note stored until a Sidemind value exists, and writes only under the new name', () => {
  localStorage.setItem('canvas.theme', 'dark')
  expect(prefs.get('theme')).toBe('dark')
  prefs.set('theme', 'light')
  expect(prefs.get('theme')).toBe('light')
  expect(localStorage.getItem('sidemind.theme')).toBe('light')
  expect(localStorage.getItem('canvas.theme')).toBe('dark')
})

it('removes the value under both names', () => {
  localStorage.setItem('canvas.mode', 'chat'); localStorage.setItem('sidemind.mode', 'chat')
  prefs.remove('mode')
  expect(prefs.get('mode')).toBe(null)
})
