// @vitest-environment jsdom
// M0 baseline, not a Canvas Note test. The failure simulated here is one that happens BEFORE the server creates a node
// (network drop, rejected request, expired session). A provider error AFTER acceptance is different: the real server has
// already created an error node holding the questions, with a Retry button (see the whole-machine check in M0 doc §6).
// it runs ChatGit's own front-end store (pinned commit) against a failing server and
// records what the user loses. Set CHATGIT_DIR to a checkout of onevalar/chat-git at 1d2e9bf; without it the file is skipped.
// The assertions describe the CURRENT, KNOWN-BAD behaviour. When the unified product replaces this protocol, the
// equivalent Canvas scenario (test/chat-workspace.test.tsx "keeps the question when sending fails") is the replacement.
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const root = process.env.CHATGIT_DIR
const src = root ? path.join(root, 'app/web/src') : ''
const available = !!root && fs.existsSync(path.join(src, 'store.ts'))

type Fetched = { url: string; method: string; body: unknown }
let calls: Fetched[], notes: { title: string; description?: string; type?: string }[]
let store: unknown

describe.skipIf(!available)('ChatGit draft send failure (1d2e9bf)', () => {
  beforeAll(async () => {
    // The store is plain TypeScript apart from `react`; copy the few files it needs next to this test (git-ignored) so
    // bare imports resolve from this project's node_modules. localStorage and window come from jsdom.
    const copy = path.join(import.meta.dirname, '.chatgit-src')
    fs.rmSync(copy, { recursive: true, force: true }); fs.mkdirSync(copy, { recursive: true })
    for (const file of ['store.ts', 'api.ts', 'model.ts', 'i18n.ts', 'locales.ts']) fs.copyFileSync(path.join(src, file), path.join(copy, file))
    localStorage.setItem('chatgit.lang', 'zh-Hans')
    store = await import(/* @vite-ignore */ path.join(copy, 'store.ts'))
  })
  beforeEach(() => {
    vi.useFakeTimers()
    calls = []; notes = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const record = { url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined }
      calls.push(record)
      if (record.method === 'POST' && /\/nodes$/.test(record.url)) return new Response(JSON.stringify({ message: '模型服务不可用' }), { status: 502, headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify({ canvas: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const s = (store as any)
    s.setNotify((n: (typeof notes)[number]) => notes.push(n))
    s.S.topic = {
      id: 'c1', name: '基线', endpoint: 'custom', model: 'fake', active: null, activeDraft: 'd1', draftSeq: 1,
      drafts: [{ id: 'd1', letter: 'A', name: '', items: [{ quote: '铝很轻', q: '为什么轻？', source: 'n1' }, { quote: '木材密度因树种而异', q: '差多少？', source: 'n1' }] }],
      nodes: new Map([['n1', { id: 'n1', parentIds: [], items: null, question: '材料', status: 'done', answer: '……' }]]),
    }
    s.S.queue = []
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
  afterAll(() => fs.rmSync(path.join(import.meta.dirname, '.chatgit-src'), { recursive: true, force: true }))

  it('sendPending: a request that fails before the server accepts it still empties the draft locally and saves the empty draft', async () => {
    const s = store as any
    s.sendPending('一起看')
    await vi.runAllTimersAsync()
    const post = calls.find(call => call.method === 'POST' && /\/nodes$/.test(call.url))
    expect(post, '请求确实发出了').toBeTruthy()
    expect(notes.some(note => note.type === 'error' && note.title === '问题没有发出去'), '用户只看到一条错误通知').toBe(true)
    // The known defect: nothing is left to resend.
    expect(s.S.topic.drafts.flatMap((draft: { items: unknown[] }) => draft.items)).toEqual([])
    const saved = calls.filter(call => call.method === 'PATCH')
    expect(saved.length).toBeGreaterThan(0)
    expect((saved.at(-1)!.body as { drafts: { items: unknown[] }[] }).drafts.every(draft => draft.items.length === 0), '服务端保存的也是空草稿').toBe(true)
  })

  it('sendQuestions: failed parallel questions are also gone from the queue, with one error per question', async () => {
    const s = store as any
    s.S.topic.nodes.get('n1').status = 'done'; s.S.topic.active = 'n1'
    s.S.queue = ['问题一', '问题二']
    s.sendQuestions(['n1'], ['问题一', '问题二'])
    await vi.runAllTimersAsync()
    expect(s.S.queue).toEqual([])
    expect(notes.filter(note => note.type === 'error' && note.title === '问题没有发出去')).toHaveLength(2)
  })

  it('sendPending with no model connected: the draft is cleared before the "no model" warning, nothing was sent', async () => {
    const s = store as any
    s.S.topic.endpoint = ''; s.S.topic.model = ''; s.S.models = {}
    s.sendPending('')
    await vi.runAllTimersAsync()
    expect(calls.some(call => call.method === 'POST' && /\/nodes$/.test(call.url))).toBe(false)
    expect(notes.some(note => note.type === 'warning')).toBe(true)
    expect(s.S.topic.drafts.flatMap((draft: { items: unknown[] }) => draft.items)).toEqual([])
  })
})
