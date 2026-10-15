// M0 baseline, not a Canvas Note test: runs ChatGit's own context builder (commit 1d2e9bf, plain CommonJS) on the
// "two asymmetric branches" scenario and records its known gaps. Set CHATGIT_DIR to a checkout; otherwise skipped.
// Canvas Note's replacement for the guarantees is in test/branches.test.ts; the gaps below are what M3 had to fix.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

const root = process.env.CHATGIT_DIR
const file = root ? path.join(root, 'app/api/server/services/ChatGit/canvasContext.js') : ''
const available = !!root && fs.existsSync(file)

let clock = 0
const node = (id: string, parentIds: string[], extra: Record<string, unknown> = {}) => { clock += 1; return { id, parentIds, status: 'done', question: `Q-${id}`, answer: `A-${id}`, createdAt: new Date(clock * 1000), ...extra } }
const graph = (...nodes: ReturnType<typeof node>[]) => new Map(nodes.map(item => [item.id, item]))
const texts = (messages: { role: string; content: string }[], role: string) => messages.filter(message => message.role === role).map(message => message.content)

describe.skipIf(!available)('ChatGit branch context (1d2e9bf)', () => {
  const ctx = available ? createRequire(import.meta.url)(file) : null
  beforeEach(() => { clock = 0 })

  // root → A (only A knows "钛很贵") and root → B ("木材密度因树种而异")
  const asymmetric = () => graph(node('r', []), node('a', ['r'], { answer: '只有 A 知道：钛很贵' }), node('b', ['r'], { answer: '只有 B 知道：木材密度因树种而异' }))

  it('keeps A-only facts out of a request that selects only B', () => {
    const { messages } = ctx.buildMessages(asymmetric(), { parentIds: ['b'], question: '继续' })
    const sent = JSON.stringify(messages)
    expect(sent).toContain('木材密度因树种而异')
    expect(sent).not.toContain('钛很贵')
  })

  it('merges both branches with the shared root sent once, and tells the model it is combining two branches', () => {
    const { messages } = ctx.buildMessages(asymmetric(), { parentIds: ['a', 'b'], question: '比较' })
    expect(messages.filter((message: { content: string }) => message.content === 'A-r')).toHaveLength(1)
    expect(JSON.stringify(messages)).toContain('钛很贵'); expect(JSON.stringify(messages)).toContain('木材密度因树种而异')
    expect(messages.some((message: { role: string; content: string }) => message.role === 'system' && /combining 2 branches/.test(message.content))).toBe(true)
  })

  // ---- known gaps (documented in Sidemind-M0-兼容与基线.md); these assert today's behaviour, not a guarantee ----
  it('GAP: order follows createdAt, not the graph — a child stamped earlier than its parent is sent first', () => {
    const parent = node('p', [], { createdAt: new Date(5000) }), child = node('c', ['p'], { createdAt: new Date(1000) })
    const { messages } = ctx.buildMessages(graph(parent, child), { parentIds: ['c'], question: 'next' })
    expect(texts(messages, 'user').slice(0, 2)).toEqual(['Q-c', 'Q-p'])
  })

  it('GAP: a cycle is silently walked once instead of being rejected', () => {
    const g = graph(node('x', ['y']), node('y', ['x']))
    expect(() => ctx.buildMessages(g, { parentIds: ['x'], question: 'go' })).not.toThrow()
  })

  it('GAP: the compression threshold counts characters, not model tokens, and there is no budget refusal', () => {
    expect(typeof ctx.COMPRESS_ABOVE_CHARS).toBe('number')
    const huge = 'z'.repeat(ctx.COMPRESS_ABOVE_CHARS * 3)
    const { messages } = ctx.buildMessages(graph(node('r', [], { answer: huge })), { parentIds: ['r'], question: 'q' })
    expect(JSON.stringify(messages)).toContain(huge)
  })
})
