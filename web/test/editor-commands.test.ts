import { describe, expect, it } from 'vitest'
import { EditorState, type TransactionSpec } from '@codemirror/state'
import { CompletionContext } from '@codemirror/autocomplete'
import { history, undo, redo } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import { formatSelection, insertions, insertionTransaction, slashCompletions } from '../src/editor-commands'

function editor(doc: string, from = doc.length, to = from) {
  return EditorState.create({ doc, selection: { anchor: from, head: to }, extensions: [markdown(), history()] })
}
describe('Markdown editor commands', () => {
  it('offers slash commands only in standalone text, filtering both Chinese and English without hijacking paths or code', async () => {
    for (const doc of ['/', '  /', '/标题', '/quote', '前言\n\n/todo']) {
      const state = editor(doc)
      const result = await slashCompletions(new CompletionContext(state, state.selection.main.head, false))
      expect(result?.options.length, doc).toBeGreaterThan(0)
    }
    for (const doc of ['https://example.com/', '路径 /', '    /', '```md\n/', '~~~\n/quote', '`/quote`', '/找不到的命令', '/a/b', '```\ntext\n\n/']) {
      const state = editor(doc)
      expect(await slashCompletions(new CompletionContext(state, state.selection.main.head, false)), doc).toBeNull()
    }
  })
  it('inserts real Markdown blocks, selects the editable placeholder and undoes/redoes the whole command without losing surrounding text', () => {
    for (const item of insertions) {
      const original = '保留前文\n\n  /\n\n保留后文'
      const from = original.indexOf('/')
      let state = editor(original, from + 1)
      const apply = (transaction: TransactionSpec) => { state = state.update(transaction).state }
      apply(insertionTransaction(from, from + 1, item))
      expect(state.doc.toString()).toBe(original.replace('/', item.text))
      expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe(item.select)
      expect(unified().use(remarkParse).parse(state.doc.toString()).children.length).toBeGreaterThan(2)
      const completed = state.doc.toString()
      expect(undo({ get state() { return state }, dispatch: transaction => { state = transaction.state } })).toBe(true)
      expect(state.doc.toString()).toBe(original)
      expect(redo({ get state() { return state }, dispatch: transaction => { state = transaction.state } })).toBe(true)
      expect(state.doc.toString()).toBe(completed)
    }
  })
  it('formats selected Unicode text as Markdown, retains exact source text and removes bold on a second application', () => {
    const original = '前文 继续思考✨ 后文'
    let state = editor(original, 3, 9)
    state = state.update(formatSelection(state, 'bold')!).state
    expect(state.doc.toString()).toBe('前文 **继续思考✨** 后文')
    const root = unified().use(remarkParse).parse(state.doc.toString())
    expect(JSON.stringify(root)).toContain('strong')
    state = state.update(formatSelection(state, 'bold')!).state
    expect(state.doc.toString()).toBe(original)
    const code = editor('含 `符号` 的文本', 0, 10)
    const formatted = code.update(formatSelection(code, 'code')!).state
    expect(JSON.stringify(unified().use(remarkParse).parse(formatted.doc.toString()))).toContain('inlineCode')
  })
  it('escapes selected link labels and selects only the replacement URL; leaves empty and multiline selections alone', () => {
    const text = '阅读 [草稿] \\ 路径'
    const state = editor(text, 0, text.length)
    const result = state.update(formatSelection(state, 'link')!).state
    expect(result.sliceDoc(result.selection.main.from, result.selection.main.to)).toBe('https://example.com')
    const tree = unified().use(remarkParse).parse(result.doc.toString())
    expect(JSON.stringify(tree)).toContain('"value":"阅读 [草稿] \\\\ 路径"')
    expect(formatSelection(editor('正文'), 'bold')).toBeNull()
    expect(formatSelection(editor('第一行\n第二行', 0, 7), 'bold')).toBeNull()
  })
})
