/** A mongoexport-shaped copy of ChatGit data: `_id.$oid`, `createdAt.$date`, and the `user` field that must never be imported. */
import fs from 'node:fs/promises'
import path from 'node:path'

const oid = (value: string) => ({ $oid: value })
const date = (iso: string) => ({ $date: iso })
const T = (minute: number) => date(`2026-09-01T10:${String(minute).padStart(2, '0')}:00.000Z`)
export const CANVAS = { research: 'aaaaaaaaaaaaaaaaaaaaaaaa', cycle: 'bbbbbbbbbbbbbbbbbbbbbbbb', empty: 'cccccccccccccccccccccccc' }
const node = (canvas: string, nodeId: string, minute: number, extra: Record<string, unknown> = {}) => ({
  _id: oid('n' + nodeId.padEnd(23, '0')), user: 'SECRET-USER-ID', canvas, nodeId, parentIds: [], question: 'Q-' + nodeId, status: 'done', answer: 'A-' + nodeId,
  error: '', endpoint: 'ChatGit Fixture', model: 'chatgit-fixture', summary: '', suggestions: [], createdAt: T(minute), updatedAt: T(minute + 1), ...extra,
})
const LONG = '很长的回答。'.repeat(100)

export const canvases = [
  {
    _id: oid(CANVAS.research), user: 'SECRET-USER-ID', name: '材料研究', endpoint: 'ChatGit Fixture', model: 'chatgit-fixture', activeDraft: 'd1', draftSeq: 1, active: 'a',
    drafts: [
      { id: 'd1', letter: 'A', name: '', items: [{ quote: '铝很轻', q: '为什么轻？', source: 'a' }, { quote: '木可燃', q: '', source: 'b' }, { quote: '来源已丢失', q: '为什么？', source: 'gone' }] },
      { id: 'd2', letter: 'B', name: '空草稿', items: [] },
    ],
    createdAt: T(0), updatedAt: T(40),
  },
  { _id: oid(CANVAS.cycle), user: 'SECRET-USER-ID', name: '成环', endpoint: '', model: '', drafts: [], createdAt: T(0), updatedAt: T(1) },
  { _id: oid(CANVAS.empty), user: 'SECRET-USER-ID', name: '', endpoint: '', model: '', drafts: [], createdAt: T(2), updatedAt: T(2) },
]
export const nodes = [
  node(CANVAS.research, 'root', 1, { summary: '短摘要', suggestions: ['下一步？', '为什么？'], answer: LONG, question: '材料有哪些类别？' }),
  node(CANVAS.research, 'a', 3, { parentIds: ['root'], question: '铝怎么样？', answer: '铝很轻。' }),
  node(CANVAS.research, 'b', 5, { parentIds: ['root'], question: '木怎么样？', answer: '木可燃。' }),
  node(CANVAS.research, 'c', 7, { parentIds: ['b'], question: '木的优点？', answer: '木易加工。' }),
  node(CANVAS.research, 'm', 9, { parentIds: ['a', 'c'], question: '比较铝和木', answer: '铝更强，木更轻。' }),
  node(CANVAS.research, 'q', 11, { parentIds: ['a'], question: '', items: [{ quote: '很轻', q: '', source: 'a' }, { quote: '铝', q: '纯度？', source: 'a' }], answer: '划词回答。' }),
  node(CANVAS.research, 's', 13, { parentIds: ['a'], question: '仍在生成', status: 'streaming', answer: '写到一半的文字' }),
  node(CANVAS.research, 'e', 15, { parentIds: ['a'], question: '出错的问题', status: 'error', answer: '', error: 'The model service returned an error.' }),
  node(CANVAS.research, 'x', 17, { parentIds: ['a'], question: '被停止的问题', status: 'stopped', answer: '停在这里' }),
  node(CANVAS.research, 'rl', 18, { parentIds: ['a'], question: '被限流', status: 'error', answer: '', error: 'rate_limit' }),
  node(CANVAS.research, 'f', 19, { parentIds: ['b'], question: '带附件', files: [{ file_id: 'file-1', filename: '资料.pdf', text: '附件正文' }] }),
  node(CANVAS.research, 'n', 21, { parentIds: ['a'], question: '没有回答', status: 'done', answer: '' }),
  node(CANVAS.research, 'd', 23, { parentIds: ['missing-parent'], question: '悬空父节点' }),
  node(CANVAS.cycle, 'p', 1, { parentIds: ['r'], question: '循环 P' }),
  node(CANVAS.cycle, 'r', 2, { parentIds: ['p'], question: '循环 R' }),
  node('dddddddddddddddddddddddd', 'orphan', 3, { question: '属于一个不在导出里的画布' }),
]

/** Writes `chatgit_canvases.json` / `chatgit_nodes.json` (mongoexport --jsonArray) into a directory. */
export async function writeExport(dir: string, data: { canvases?: unknown[]; nodes?: unknown[] } = {}, format: 'array' | 'lines' = 'array') {
  await fs.mkdir(dir, { recursive: true })
  const put = (name: string, docs: unknown[]) => fs.writeFile(path.join(dir, name + (format === 'array' ? '.json' : '.jsonl')), format === 'array' ? JSON.stringify(docs) : docs.map(doc => JSON.stringify(doc)).join('\n') + '\n')
  await put('chatgit_canvases', data.canvases ?? canvases)
  await put('chatgit_nodes', data.nodes ?? nodes)
}
