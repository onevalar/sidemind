import { EditorSelection, Transaction, type EditorState, type TransactionSpec } from '@codemirror/state'
import { isolateHistory } from '@codemirror/commands'
import { ifNotIn, pickedCompletion, type CompletionSource, type Completion } from '@codemirror/autocomplete'

export const insertions = [
  { label: '一级标题', keywords: 'heading h1 title 标题', text: '# 标题', select: '标题' },
  { label: '二级标题', keywords: 'heading h2 subtitle 标题', text: '## 标题', select: '标题' },
  { label: '引用', keywords: 'quote 引用', text: '> 引用内容', select: '引用内容' },
  { label: '无序列表', keywords: 'bullet list 列表', text: '- 列表内容', select: '列表内容' },
  { label: '待办事项', keywords: 'todo task checklist 待办', text: '- [ ] 待办事项', select: '待办事项' },
  { label: '代码块', keywords: 'code 代码', text: '```\n代码\n```', select: '代码' },
  { label: '分隔线', keywords: 'divider rule 分隔线', text: '---\n\n', select: '' },
] as const

export function insertionTransaction(from: number, to: number, item: typeof insertions[number]): TransactionSpec {
  const offset = item.select ? item.text.indexOf(item.select) : item.text.length
  return { changes: { from, to, insert: item.text }, selection: EditorSelection.single(from + offset, from + offset + item.select.length),
    annotations: [Transaction.userEvent.of('input.complete'), isolateHistory.of('full')] }
}

export const slashCompletions: CompletionSource = ifNotIn(['FencedCode', 'CodeBlock', 'InlineCode', 'Link', 'URL', 'Autolink'], context => {
  if (!context.state.selection.main.empty || context.state.selection.ranges.length !== 1) return null
  const line = context.state.doc.lineAt(context.pos)
  const match = /^( {0,3})\/([^\s/]*)$/.exec(line.text.slice(0, context.pos - line.from))
  if (!match) return null
  const query = match[2]!.toLocaleLowerCase()
  const options: Completion[] = insertions.filter(item => (item.label + ' ' + item.keywords).includes(query)).map(item => ({
    label: item.label, detail: item.text.split('\n')[0],
    apply: (view, completion, from, to) => {
      const transaction = insertionTransaction(from, to, item)
      view.dispatch({ ...transaction, annotations: [Transaction.userEvent.of('input.complete'), isolateHistory.of('full'), pickedCompletion.of(completion)] })
    },
  }))
  return options.length ? { from: line.from + match[1]!.length, to: context.pos, filter: false, options } : null
})

export type InlineFormat = 'bold' | 'italic' | 'code' | 'link'
export function formatSelection(state: EditorState, format: InlineFormat): TransactionSpec | null {
  let { from, to } = state.selection.main
  let text = state.sliceDoc(from, to)
  if (!text.trim() || state.selection.ranges.length !== 1 || text.includes('\n')) return null
  if (format === 'bold' || format === 'italic') {
    from += text.length - text.trimStart().length
    to -= text.length - text.trimEnd().length
    text = state.sliceDoc(from, to)
  }
  let insert: string, start: number, end: number
  if (format === 'link') {
    const label = text.replace(/[\\[\]]/g, '\\$&')
    insert = `[${label}](https://example.com)`
    start = from + label.length + 3
    end = start + 'https://example.com'.length
  } else {
    const ticks = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length)) + 1
    const marker = format === 'bold' ? '**' : format === 'italic' ? '*' : '`'.repeat(ticks)
    const pad = format === 'code' && (/^`|`$/.test(text) || /^ .* $/.test(text)) ? ' ' : ''
    insert = marker + pad + text + pad + marker
    start = from + marker.length + pad.length
    end = start + text.length
    if (format !== 'code' && state.sliceDoc(Math.max(0, from - marker.length), from) === marker && state.sliceDoc(to, to + marker.length) === marker) {
      return { changes: { from: from - marker.length, to: to + marker.length, insert: text }, selection: EditorSelection.single(from - marker.length, to - marker.length), annotations: isolateHistory.of('full'), userEvent: 'input.format' }
    }
  }
  return { changes: { from, to, insert }, selection: EditorSelection.single(start, end), annotations: isolateHistory.of('full'), userEvent: 'input.format' }
}
