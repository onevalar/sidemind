import type { NoteSummary } from '../shared/types'

export { linkedNoteName, relativeHref } from '../shared/links'
import { relativeHref } from '../shared/links'

export function noteReference(note: Pick<NoteSummary, 'name' | 'title'>, folder = ''): string {
  const label = note.title.replace(/\s+/g, ' ').replace(/([\\[\]*_`<>~|])/g, '\\$1')
  return `[${label}](${relativeHref(note.name, folder)})`
}

export function captureContent(text: string, references: Pick<NoteSummary, 'name' | 'title'>[], folder = '') {
  const body = text.trim()
  const title = body.split('\n')[0]?.replace(/^#+\s*/, '').slice(0, 60) || (references.length ? '相关笔记' : '未命名笔记')
  const unique = [...new Map(references.map(note => [note.name, note])).values()]
  const links = unique.length ? '\n\n## 相关笔记\n\n' + unique.map(note => '- ' + noteReference(note, folder)).join('\n') : ''
  return { title, content: '# ' + title + (body ? '\n\n' + body : '') + links + '\n' }
}
