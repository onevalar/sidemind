import type { NoteSummary } from '../shared/types'

/** Resolve portable relative Markdown links, without escaping the workspace. */
export function linkedNoteName(href: string, source = ''): string | null {
  try {
    if (/^[a-z][a-z0-9+.-]*:|^\/|[\\?#]/i.test(href)) return null
    const parts = source.split('/').slice(0, -1)
    for (const encoded of href.split('/')) {
      const part = decodeURIComponent(encoded)
      if (/[\\/\0]/.test(part)) return null
      if (part === '.') continue
      if (part === '..') { if (!parts.length) return null; parts.pop(); continue }
      if (!part || part.startsWith('.') || part.length > 200) return null
      parts.push(part)
    }
    const name = parts.join('/')
    return name.endsWith('.md') && name.length <= 1000 ? name : null
  } catch { return null }
}

export function noteReference(note: Pick<NoteSummary, 'name' | 'title'>, folder = ''): string {
  const label = note.title.replace(/\s+/g, ' ').replace(/([\\[\]*_`<>~|])/g, '\\$1')
  const from = folder ? folder.split('/') : [], target = note.name.split('/')
  while (from.length && from[0] === target[0]) { from.shift(); target.shift() }
  const filename = target.map(part => encodeURIComponent(part).replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase())).join('/')
  return `[${label}](${from.length ? '../'.repeat(from.length) : './'}${filename})`
}

export function captureContent(text: string, references: Pick<NoteSummary, 'name' | 'title'>[], folder = '') {
  const body = text.trim()
  const title = body.split('\n')[0]?.replace(/^#+\s*/, '').slice(0, 60) || (references.length ? '相关笔记' : '未命名笔记')
  const unique = [...new Map(references.map(note => [note.name, note])).values()]
  const links = unique.length ? '\n\n## 相关笔记\n\n' + unique.map(note => '- ' + noteReference(note, folder)).join('\n') : ''
  return { title, content: '# ' + title + (body ? '\n\n' + body : '') + links + '\n' }
}
