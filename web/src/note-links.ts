import type { NoteSummary } from '../shared/types'

/** Only sibling Markdown files are internal notes; never treat arbitrary URLs as file paths. */
export function linkedNoteName(href: string): string | null {
  try {
    const relative = href.startsWith('./') ? href.slice(2) : href
    if (/[\\/:?#]/.test(relative)) return null
    const name = decodeURIComponent(relative)
    return name.endsWith('.md') && name.length <= 200 && !name.startsWith('.') && !/[\\/\0]/.test(name) ? name : null
  } catch { return null }
}

export function noteReference(note: Pick<NoteSummary, 'name' | 'title'>): string {
  const label = note.title.replace(/\s+/g, ' ').replace(/([\\[\]*_`<>~|])/g, '\\$1')
  const filename = encodeURIComponent(note.name).replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase())
  return `[${label}](./${filename})`
}

export function captureContent(text: string, references: Pick<NoteSummary, 'name' | 'title'>[]) {
  const body = text.trim()
  const title = body.split('\n')[0]?.replace(/^#+\s*/, '').slice(0, 60) || (references.length ? '相关笔记' : '未命名笔记')
  const unique = [...new Map(references.map(note => [note.name, note])).values()]
  const links = unique.length ? '\n\n## 相关笔记\n\n' + unique.map(note => '- ' + noteReference(note)).join('\n') : ''
  return { title, content: '# ' + title + (body ? '\n\n' + body : '') + links + '\n' }
}
