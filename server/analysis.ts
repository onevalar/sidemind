import { diff } from './diff'
import { splitSections, type Section } from './sections'

/** Ordered by severity. `wording` never needs a model call; see 技术路线-v0.3 §5.2. */
export type Severity = 'unchanged' | 'wording' | 'addition' | 'semantic'
export const SEVERITY: Severity[] = ['unchanged', 'wording', 'addition', 'semantic']
const worst = (a: Severity, b: Severity): Severity => SEVERITY.indexOf(a) >= SEVERITY.indexOf(b) ? a : b

export type SectionChange = {
  key: string
  heading: string
  change: 'added' | 'removed' | 'modified' | 'moved' | 'renamed'
  severity: Severity
  /** Short human explanation, e.g. "改了 2 句措辞" or "删除了 1 句、数字变化". */
  detail: string
  before?: string
  after?: string
}
export type NoteAnalysis = {
  kind: 'new' | 'deleted' | Severity
  sections: SectionChange[]
  summary: string
}

const PUNCTUATION: Record<string, string> = { '，': ',', '。': '.', '：': ':', '；': ';', '！': '!', '？': '?', '（': '(', '）': ')', '【': '[', '】': ']', '“': '"', '”': '"', '‘': "'", '’': "'", '、': ',', '—': '-', '～': '~', '《': '<', '》': '>' }
/** Ignores punctuation width, whitespace and emphasis markers so pure formatting reads as wording. */
export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[，。：；！？（）【】“”‘’、—～《》]/g, character => PUNCTUATION[character]!)
    .replace(/[*_~`]+/g, '').replace(/[ \t　]+/g, ' ').replace(/ *\n */g, '\n').trim()
}
export function sentences(text: string): string[] {
  return normalizeText(text).split(/(?<=[.!?;])\s+|(?<=[.!?;])(?=[^\x00-\x7f])|\n+/).map(item => item.trim()).filter(Boolean)
}
const numbers = (text: string) => (text.match(/\d+(?:\.\d+)?%?/g) ?? []).join('|')
const negations = (text: string) => (text.match(/[不没无非未否别勿]|\b(?:not|no|never|none|cannot)\b/gi) ?? []).length

export function similarity(a: string, b: string): number {
  if (a === b) return 1
  if (!a.length || !b.length) return 0
  const ops = diff([...a], [...b])
  const same = ops.filter(op => op.kind === 'same').length
  return 2 * same / (a.length + b.length)
}

/** Classifies a changed section body at sentence level. */
export function classifyText(before: string, after: string): { severity: Severity; detail: string } {
  if (normalizeText(before) === normalizeText(after)) return { severity: 'wording', detail: '只调整了格式或标点' }
  const ops = diff(sentences(before), sentences(after))
  const removed = ops.filter(op => op.kind === 'remove').map(op => op.item)
  const added = ops.filter(op => op.kind === 'add').map(op => op.item)
  let wording = 0, rewritten = 0, deleted = 0, inserted = 0, factual = false
  const unused = new Set(added.keys())
  for (const old of removed) {
    let best = -1, score = 0
    for (const index of unused) { const value = similarity(old, added[index]!); if (value > score) { score = value; best = index } }
    if (best < 0 || score < 0.5) { deleted++; continue }
    unused.delete(best)
    const next = added[best]!, changed = Math.round(Math.max(old.length, next.length) * (1 - score))
    if (numbers(old) !== numbers(next) || negations(old) !== negations(next)) { factual = true; rewritten++ }
    else if (1 - score <= 0.15 && changed <= 20) wording++
    else rewritten++
  }
  inserted = unused.size
  const parts = [wording && `改了 ${wording} 句措辞`, rewritten && `实质改写 ${rewritten} 句`, deleted && `删除 ${deleted} 句`, inserted && `新增 ${inserted} 句`, factual && '数字或否定表述变化'].filter(Boolean)
  const severity: Severity = rewritten || deleted ? 'semantic' : inserted ? 'addition' : 'wording'
  return { severity, detail: parts.join('，') || '措辞调整' }
}

const body = (section: Section) => section.level ? section.text.slice(section.text.indexOf('\n') + 1) : section.text

/** Pairs sections by key, then by identical text (moved), then by similar body (heading renamed). */
export function analyze(before: string | null, after: string | null): NoteAnalysis {
  if (before === null && after === null) return { kind: 'unchanged', sections: [], summary: '' }
  if (before === null) return { kind: 'new', sections: splitSections(after!).map(section => ({ key: section.key, heading: section.heading, change: 'added', severity: 'addition', detail: '新文章', after: section.text })), summary: '新建文章' }
  if (after === null) return { kind: 'deleted', sections: [], summary: '删除文章' }
  if (before === after) return { kind: 'unchanged', sections: [], summary: '' }
  const old = splitSections(before), next = splitSections(after)
  const changes: SectionChange[] = []
  const oldLeft = new Map(old.map(section => [section.key, section])), newLeft = new Map(next.map(section => [section.key, section]))
  for (const section of next) {
    const previous = oldLeft.get(section.key)
    if (!previous) continue
    oldLeft.delete(section.key); newLeft.delete(section.key)
    if (previous.hash === section.hash) continue
    const { severity, detail } = classifyText(body(previous), body(section))
    changes.push({ key: section.key, heading: section.heading, change: 'modified', severity, detail, before: previous.text, after: section.text })
  }
  for (const [key, section] of [...newLeft]) {
    const match = [...oldLeft.values()].find(previous => previous.hash === section.hash)
    if (!match) continue
    oldLeft.delete(match.key); newLeft.delete(key)
    changes.push({ key, heading: section.heading, change: 'moved', severity: 'wording', detail: '章节位置调整（原「' + match.key + '」）', before: match.text, after: section.text })
  }
  for (const [key, section] of [...newLeft]) {
    let best: Section | null = null, score = 0
    for (const previous of oldLeft.values()) { const value = similarity(normalizeText(body(previous)).slice(0, 1500), normalizeText(body(section)).slice(0, 1500)); if (value > score) { score = value; best = previous } }
    if (!best || score < 0.6) continue
    oldLeft.delete(best.key); newLeft.delete(key)
    const inner = classifyText(body(best), body(section))
    changes.push({ key, heading: section.heading, change: 'renamed', severity: 'semantic', detail: `标题「${best.heading}」改为「${section.heading}」` + (inner.detail ? '；' + inner.detail : ''), before: best.text, after: section.text })
  }
  for (const section of newLeft.values()) changes.push({ key: section.key, heading: section.heading, change: 'added', severity: 'addition', detail: '新增章节', after: section.text })
  for (const section of oldLeft.values()) changes.push({ key: section.key, heading: section.heading, change: 'removed', severity: 'semantic', detail: '删除章节', before: section.text })
  const kind = changes.reduce<Severity>((current, change) => worst(current, change.severity), changes.length ? 'unchanged' : 'wording')
  const order = new Map(next.map((section, index) => [section.key, index]))
  changes.sort((a, b) => (order.get(a.key) ?? 1e9) - (order.get(b.key) ?? 1e9))
  return { kind: kind === 'unchanged' ? 'wording' : kind, sections: changes, summary: changes.map(change => `「${change.heading}」${change.detail}`).join('；') || '只调整了空白或格式' }
}
