import { LIBRARY_MEMORY, folderMemory, noteMemory, type MemoryFiles } from './memory-files'

/**
 * Memory exists to support FUTURE USE of a note (writing new articles, review, discussion, fact lookup),
 * not to keep a diary. See 技术路线-v0.3-AI-Agent.md §4.
 */
export const NOTE_TYPES = ['学习笔记', '会议/讨论记录', '资料/事实摘录', '观点/论述', '写作草稿', '随记/日志'] as const
export type NoteType = typeof NOTE_TYPES[number]

export const NOTE_CORE = ['摘要', '章节', '用途', '现行结论', '已废弃的观点', '术语与表述', '决定与约束', '关联', '被引用', '缺口'] as const
export const TYPE_MODULES: Record<NoteType, string[]> = {
  '学习笔记': ['概念与前置', '理解状态', '个人理解方式', '自测问题', '复习记录'],
  '会议/讨论记录': ['相关人员与立场', '论点地图', '行动项'],
  '资料/事实摘录': ['事实条目'],
  '观点/论述': ['立场与把握', '论点地图', '决策记录'],
  '写作草稿': ['写作意图与进度'],
  '随记/日志': [],
}
export const NOTE_SECTIONS = [...NOTE_CORE, ...new Set(Object.values(TYPE_MODULES).flat()), '敏感'] as string[]
export const FOLDER_SECTIONS = ['全景与覆盖', '权威来源', '共识与分歧', '决定与约束', '写法惯例', '画布含义', '学习路径与薄弱点', '议题与立场', '冲突事实', '观点演进']
export const LIBRARY_SECTIONS = ['关于用户', '写作风格与术语', '跨文件夹主线', '跨文件夹关联']
export const NOTE_STATUS = ['活跃', '定稿', '归档', '过时'] as const
export const MEMORY_SOURCES = ['原文', '用户', '推断', '使用记录'] as const

export const MEMORY_LIMITS = { note: 9000, folder: 10000, library: 8000 }

export type MemoryTarget = { kind: 'note'; name: string } | { kind: 'folder'; folder: string } | { kind: 'library' }
export type MemoryMeta = Record<string, string | string[]>
export type MemoryDoc = { meta: MemoryMeta; sections: { title: string; body: string }[] }

export function memoryFile(target: MemoryTarget): string {
  return target.kind === 'note' ? noteMemory(target.name) : target.kind === 'folder' ? folderMemory(target.folder) : LIBRARY_MEMORY
}
export function allowedSections(target: MemoryTarget): string[] {
  return target.kind === 'note' ? NOTE_SECTIONS : target.kind === 'folder' ? FOLDER_SECTIONS : LIBRARY_SECTIONS
}
export function sectionsForTypes(types: string[]): string[] {
  return [...NOTE_CORE, ...new Set(types.flatMap(type => TYPE_MODULES[type as NoteType] ?? []))]
}

/** Parses the small frontmatter subset we write (`key: value`, `key: [a, b]`) and `## ` sections. */
export function parseMemory(text: string | null): MemoryDoc {
  const doc: MemoryDoc = { meta: {}, sections: [] }
  if (!text) return doc
  let body = text.replace(/\r\n?/g, '\n')
  const front = /^---\n([\s\S]*?)\n---\n?/.exec(body)
  if (front) {
    for (const line of front[1]!.split('\n')) {
      const match = /^([A-Za-z_]+):\s*(.*)$/.exec(line)
      if (!match) continue
      const value = match[2]!.replace(/\s+#.*$/, '').trim()
      doc.meta[match[1]!] = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1).split(',').map(item => item.trim()).filter(Boolean) : value
    }
    body = body.slice(front[0].length)
  }
  let current: { title: string; body: string } | null = null
  const preamble: string[] = []
  for (const line of body.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) { current = { title: heading[1]!, body: '' }; doc.sections.push(current); continue }
    if (current) current.body += (current.body ? '\n' : '') + line
    else if (line.trim()) preamble.push(line)
  }
  for (const section of doc.sections) section.body = section.body.trim()
  if (preamble.length) doc.sections.unshift({ title: '备注', body: preamble.join('\n').trim() })
  return doc
}

export function renderMemory(doc: MemoryDoc, header?: string): string {
  const meta = Object.entries(doc.meta).filter(([, value]) => Array.isArray(value) ? value.length : value !== '')
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? '[' + value.join(', ') + ']' : value}`)
  const sections = doc.sections.filter(section => section.body.trim()).map(section => `## ${section.title}\n${section.body.trim()}\n`)
  return (meta.length ? `---\n${meta.join('\n')}\n---\n` : '') + (header ? header + '\n\n' : '') + sections.join('\n')
}

export function getSection(doc: MemoryDoc, title: string): string {
  return doc.sections.find(section => section.title === title)?.body ?? ''
}

/** Replaces (or removes, when empty) one section, keeping the conventional order for known sections. */
export function setSection(doc: MemoryDoc, title: string, body: string, order: string[] = []): void {
  const index = doc.sections.findIndex(section => section.title === title)
  if (!body.trim()) { if (index >= 0) doc.sections.splice(index, 1); return }
  if (index >= 0) { doc.sections[index]!.body = body.trim(); return }
  const rank = (name: string) => { const at = order.indexOf(name); return at < 0 ? order.length : at }
  const insert = doc.sections.findIndex(section => rank(section.title) > rank(title))
  doc.sections.splice(insert < 0 ? doc.sections.length : insert, 0, { title, body: body.trim() })
}

/** One memory entry line: content plus anchor and source tag, e.g. `- 结论 〔§目标用户 · 原文〕`. */
export function entry(text: string, source: string, anchor?: string, extra?: string): string {
  const tags = [anchor ? '§' + anchor.replace(/^§/, '') : '', source, extra ?? ''].filter(Boolean).join(' · ')
  return `- ${text.replace(/\s*\n\s*/g, ' ').trim()}${tags ? ` 〔${tags}〕` : ''}`
}

export function appendEntry(doc: MemoryDoc, title: string, line: string, order: string[] = []): boolean {
  const current = getSection(doc, title)
  if (current.split('\n').some(existing => existing.trim() === line.trim())) return false
  setSection(doc, title, current ? current + '\n' + line : line, order)
  return true
}

/** Reads one target's memory; a missing file is an empty document. */
export async function readMemory(files: MemoryFiles, target: MemoryTarget): Promise<{ file: string; text: string | null; doc: MemoryDoc }> {
  const file = memoryFile(target), text = await files.read(file)
  return { file, text, doc: parseMemory(text) }
}

export function defaultMeta(target: MemoryTarget): MemoryMeta {
  return target.kind === 'note' ? { note: target.name } : target.kind === 'folder' ? { folder: target.folder || '/' } : { scope: 'library' }
}
