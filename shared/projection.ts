/**
 * Comparison form of Markdown text: whitespace, inline markers and leading list/quote markers removed, so a
 * passage selected in rendered text can be found in its source. `origin[i]` is the index in `text` of the
 * UTF-16 unit that produced unit `i` of the result.
 */
const NOISE = /[\s*_`\\>#]/u
const LEADING = /^[ \t]*(?:>[ \t]*)*(?:[-+*]|\d{1,9}[.)])[ \t]+/

export function project(text: string): { text: string; origin: number[] } {
  let result = ''
  const origin: number[] = []
  let lineStart = 0
  for (const line of text.split('\n')) {
    const skip = LEADING.exec(line)?.[0].length ?? 0
    for (let at = skip; at < line.length;) {
      const char = String.fromCodePoint(line.codePointAt(at)!)
      if (!NOISE.test(char)) { result += char; for (let unit = 0; unit < char.length; unit++) origin.push(lineStart + at + unit) }
      at += char.length
    }
    lineStart += line.length + 1
  }
  return { text: result, origin }
}
