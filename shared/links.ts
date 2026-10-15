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

/** Portable relative href from a note in `folder` to `target` (a workspace-relative note name). */
export function relativeHref(target: string, folder = ''): string {
  const from = folder ? folder.split('/') : [], parts = target.split('/')
  while (from.length && from[0] === parts[0]) { from.shift(); parts.shift() }
  const filename = parts.map(part => encodeURIComponent(part).replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase())).join('/')
  return (from.length ? '../'.repeat(from.length) : './') + filename
}
