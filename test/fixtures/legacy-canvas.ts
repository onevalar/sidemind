/** Isolated old-format Canvas Note data: a v0.2 notes folder and a v1 repository whose history lives in cache/. */
import fs from 'node:fs/promises'
import path from 'node:path'

export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xfe])
export const NOTE_A = '# 甲\n\n铝很轻。\n'
export const NOTE_B = '# 乙\n\n木可燃。\n\n![图](diagram.png)\n'

/** v0.2: Markdown directly in the root, metadata in `.canvasnote/`. */
export async function makeV02(root: string) {
  await fs.mkdir(path.join(root, 'Work'), { recursive: true })
  await fs.mkdir(path.join(root, '.canvasnote', 'agent-changes'), { recursive: true })
  await fs.writeFile(path.join(root, 'A.md'), NOTE_A)
  await fs.writeFile(path.join(root, 'Work', 'B.md'), NOTE_B)
  await fs.writeFile(path.join(root, 'Work', 'diagram.png'), PNG)
  await fs.writeFile(path.join(root, '.canvasnote', 'library.json'), JSON.stringify({
    version: 1,
    notes: { 'A.md': { position: { x: 10, y: 20 } }, 'Work/B.md': { position: { x: 30, y: 40 } } },
    frames: [{ id: 'f1', space: 'Work', title: '分组', position: { x: 0, y: 0 }, width: 400, height: 320, members: ['Work/B.md'] }],
  }))
  await fs.writeFile(path.join(root, '.canvasnote', 'agent-changes', 'x.json'), '{"old":"v0.2 change record"}')
  await fs.writeFile(path.join(root, '.canvasnote', 'overviews.json'), '{}')
}

export const IDS = { good: '11111111-1111-4111-8111-111111111111', note: '22222222-2222-4222-8222-222222222222', corrupt: '33333333-3333-4333-8333-333333333333', wrong: '44444444-4444-4444-8444-444444444444', empty: '55555555-5555-4555-8555-555555555555', lead: '66666666-6666-4666-8666-666666666666', gone: '77777777-7777-4777-8777-777777777777' }
const conversation = (id: string, scope: unknown, transcript: { role: string; text: string; at: number }[], changesets: string[] = []) => ({ version: 1, id, scope, createdAt: transcript[0]?.at ?? 1000, updatedAt: transcript.at(-1)?.at ?? 1000, revision: 1, messages: [], transcript, changesets, distilled: 0 })

/** v1 repository: marker v1, notes/, memory/, canvas/ and an old `cache/` holding conversations, change sets and proposals. */
export async function makeV1(root: string) {
  for (const dir of ['notes/Work', 'memory', 'canvas', 'cache/conversations', 'cache/changesets', 'cache/proposals', 'cache/legacy-agent-changes']) await fs.mkdir(path.join(root, dir), { recursive: true })
  await fs.writeFile(path.join(root, 'canvasnote.json'), JSON.stringify({ format: 'canvas-note-repo', version: 1 }) + '\n')
  await fs.writeFile(path.join(root, '.gitignore'), 'cache/\n')
  await fs.writeFile(path.join(root, 'notes', 'A.md'), NOTE_A)
  await fs.writeFile(path.join(root, 'notes', 'Work', 'B.md'), NOTE_B)
  await fs.writeFile(path.join(root, 'cache', 'legacy-agent-changes', 'old.json'), '{"v0.2":true}')
  const put = (dir: string, name: string, value: unknown) => fs.writeFile(path.join(root, 'cache', dir, name), typeof value === 'string' ? value : JSON.stringify(value) + '\n')
  await put('conversations', IDS.good + '.json', conversation(IDS.good, { kind: 'folder', folder: '' }, [
    { role: 'user', text: '整理一下笔记', at: 1000 }, { role: 'assistant', text: '我读了两篇。', at: 1100 }, { role: 'assistant', text: '已经整理好了。', at: 1200 },
    { role: 'user', text: '再检查一遍', at: 2000 }, { role: 'assistant', text: '没有问题。', at: 2100 },
  ], ['c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000ff']))
  await put('conversations', IDS.note + '.json', conversation(IDS.note, { kind: 'note', folder: '', name: 'A.md' }, [{ role: 'user', text: '这篇讲什么？', at: 3000 }, { role: 'assistant', text: '讲铝。', at: 3100 }]))
  await put('conversations', IDS.gone + '.json', conversation(IDS.gone, { kind: 'note', folder: '', name: 'Deleted.md' }, [{ role: 'user', text: '关于已删除笔记的问题', at: 3500 }, { role: 'assistant', text: '好的。', at: 3600 }]))
  await put('conversations', IDS.lead + '.json', conversation(IDS.lead, { kind: 'chat', folder: '' }, [{ role: 'assistant', text: '开头没有提问的助手消息', at: 4000 }, { role: 'user', text: '问题', at: 4100 }, { role: 'assistant', text: '回答', at: 4200 }]))
  await put('conversations', IDS.empty + '.json', conversation(IDS.empty, { kind: 'chat', folder: '' }, []))
  await put('conversations', IDS.corrupt + '.json', '{ this is not json')
  await put('conversations', IDS.wrong + '.json', { version: 7, id: IDS.wrong })
  await put('changesets', 'c0000000-0000-4000-8000-000000000001.json', { id: 'c0000000-0000-4000-8000-000000000001', conversation: IDS.good, request: '整理', files: [], layouts: [], createdAt: 1150 })
  await put('changesets', 'c0000000-0000-4000-8000-000000000002.json', { id: 'c0000000-0000-4000-8000-000000000002', request: '无关联的旧改动', files: [], layouts: [], createdAt: 10 })
  await put('changesets', 'c0000000-0000-4000-8000-000000000003.json', '{ broken change set')
  await put('proposals', 'p0000000-0000-4000-8000-000000000001.json', { id: 'p0000000-0000-4000-8000-000000000001', conversation: IDS.good, reason: '建议', status: 'pending' })
  await put('proposals', 'p0000000-0000-4000-8000-000000000002.json', '[[[ nope')
}
