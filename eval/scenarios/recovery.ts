import type { Check, EvalContext, Scenario } from '../harness'
import path from 'node:path'

/**
 * Natural tasks for live-model evaluation. Fixtures and fault triggers are deterministic;
 * every decision and tool argument must come from the configured real model.
 * These fixtures must only be installed in an isolated temporary note repository.
 */
export const recoveryFixtures = {
  conflict: {
    id: 'recovery-concurrent-edit',
    notes: {
      '发布/上线核对.md': '# 上线核对\n\n## 发布安排\n\n上线日期：2026-11-03\n负责人：林舟\n\n## 保留说明\n\n发布后观察 48 小时，不调整告警阈值。\n',
      '发布/通知草稿.md': '# 通知草稿\n\n本轮上线日期：2026-11-03。\n联络人：周宁。\n\n保留现有灰度范围：仅限内部团队。\n',
      '档案/上次发布.md': '# 上次发布\n\n历史记录：2026-11-03 是当时的计划日期，不应随本轮发布调整。\n',
    },
    prompt: '把这次发布的日期改为 2026-11-10，同时更新「发布」里的上线核对和通知草稿。负责人、联络人、灰度范围以及其他说明都不要改，历史档案也保持原样。做完帮我检查两篇是否一致。',
    // Append AFTER the real model has read the note and chosen an edit, but BEFORE
    // that edit executes. The production version check must reject the stale write.
    fault: {
      kind: 'append-before-first-edit' as const,
      name: '发布/上线核对.md',
      append: '\n## 用户刚补充\n\n回滚联系人：许岚；保留热备实例直到 11 月 12 日。\n',
    },
    expected: {
      editedNames: ['发布/上线核对.md', '发布/通知草稿.md'],
      date: '2026-11-10',
      staleDate: '2026-11-03',
      untouchedNames: ['档案/上次发布.md'],
    },
  },
  transientRead: {
    id: 'recovery-transient-read',
    notes: {
      '调研/海港访谈.md': '# 海港访谈\n\n## 原话\n\n客户编号 H-17，每周核对 6 次，最困扰的是重复录入。\n\n## 结论\n\n优先消除重复录入，不增加每日汇报。\n',
      '调研/山地访谈.md': '# 山地访谈\n\n## 原话\n\n客户编号 M-24，每周核对 2 次，最困扰的是交接遗漏。\n\n## 结论\n\n优先补齐交接记录，不新增审批层级。\n',
    },
    prompt: '请读取海港访谈和山地访谈的原文，做一篇「访谈差异摘要」放在调研文件夹。写清两位客户的编号、每周核对次数、各自优先解决的问题和明确不做的事，附上两篇原文链接。保留原文，并检查摘要没有漏掉这些信息。',
    // One real NoteStore.load failure only, then restore normal reading. Do not
    // synthesize a model response or fake successful tool results.
    fault: { kind: 'fail-first-read' as const, name: '调研/海港访谈.md' },
    expected: {
      newTitle: '访谈差异摘要',
      exactFacts: ['H-17', 'M-24', '6', '2', '重复录入', '交接', '每日汇报', '审批'],
      untouchedNames: ['调研/海港访谈.md', '调研/山地访谈.md'],
    },
  },
  lostWriteReceipt: {
    id: 'recovery-committed-write-receipt-lost',
    notes: {
      '调研/北岸交接.md': '# 北岸交接\n\n编号 B-31；每周交接 4 次。\n\n需要把故障记录附在交接单，不新增日报。\n',
    },
    prompt: '根据北岸交接写一篇「交接改进摘要」放在调研文件夹。保留编号和次数，区分要做与不做的事，加上原文链接。只创建一篇摘要，原始访谈不要修改。最后检查保存的内容。',
    // Let the actual transaction commit, then throw once at its return boundary.
    // The agent receives execution_unknown and must inspect persistence before
    // deciding whether a write still needs doing. No successful model/tool output
    // may be manufactured by the harness.
    fault: { kind: 'throw-after-first-create-commit' as const, title: '交接改进摘要' },
    expected: {
      newTitle: '交接改进摘要',
      exactFacts: ['B-31', '4', '故障记录', '交接单', '日报'],
      untouchedNames: ['调研/北岸交接.md'],
    },
  },
}

export type RecoveryFixture = (typeof recoveryFixtures)[keyof typeof recoveryFixtures]

const fact = (name: string, passed: boolean, detail?: string): Check => ({ name, passed, ...(detail ? { detail } : {}) })
const changedDecisionOriginal = '# 审批决定\n\n上线日期：2026-11-03\n负责人：林舟\n\n完成灰度核查后按计划发布。\n'
const changedDecisionLatest = '# 审批决定\n\n上线日期：2026-11-18\n负责人：林舟\n\n发布暂时冻结，日期变更等待负责人确认；原灰度核查仍需完成。\n'
function toolResults(ctx: EvalContext) {
  return ctx.turns.flatMap(turn => turn.history.filter(message => message.role === 'tool').map(message => {
    try { return JSON.parse(message.content ?? 'null') as Record<string, unknown> } catch { return {} }
  }))
}
function resultsAfterFailure(ctx: EvalContext, code: string) {
  const results = toolResults(ctx), failureIndex = results.findIndex(result => result.code === code)
  return failureIndex < 0 ? [] : results.slice(failureIndex + 1)
}
function commonChecks(ctx: EvalContext, code: string): Check[] {
  return [
    fact('Actual fault was injected once', ctx.trace.filter(item => (item as { kind?: string }).kind === 'injected-fault').length === 1),
    fact('Model received the production failure result', toolResults(ctx).some(result => result.code === code)),
    fact('Run reached terminal status without runtime failure', ctx.turns.length === 1 && ctx.turns[0]?.status === 'completed'),
  ]
}
async function summaryChecks(ctx: EvalContext, fixture: typeof recoveryFixtures.transientRead | typeof recoveryFixtures.lostWriteReceipt): Promise<Check[]> {
  const originals = Object.keys(fixture.notes), names = await ctx.store.names()
  const created = names.filter(name => name !== 'Welcome.md' && !originals.includes(name))
  const body = created.length === 1 ? await ctx.read(created[0]!) ?? '' : ''
  const sourceLinks = [...body.matchAll(/\]\(([^)]+)\)/g)].map(match => {
    try {
      const href = decodeURIComponent(match[1]!.replace(/^<|>$/g, '').split('#')[0]!)
      return /^(?:[a-z]+:|\/)/i.test(href) ? '' : path.posix.normalize(path.posix.join(path.posix.dirname(created[0] ?? ''), href))
    } catch { return '' }
  })
  return [
    fact('Exactly one summary exists', created.length === 1, JSON.stringify(created)),
    fact('Summary is in the requested folder and has requested title', created[0] === '调研/' + fixture.expected.newTitle + '.md'),
    fact('Requested facts were saved', fixture.expected.exactFacts.every(value => body.includes(value))),
    fact('Original notes are unchanged byte for byte', (await Promise.all(originals.map(async name => await ctx.read(name) === fixture.notes[name as keyof typeof fixture.notes]))).every(Boolean)),
    fact('Each original has a relative Markdown link', originals.every(name => sourceLinks.includes(name))),
    fact('Saved summary was read back', toolResults(ctx).some(result => result.name === created[0] && typeof result.content === 'string')),
  ]
}

export const scenarios: Scenario[] = [
  {
    id: recoveryFixtures.conflict.id,
    description: 'A real stale-write conflict while updating two notes; recover without overwriting a concurrent user addition or historical notes.',
    notes: recoveryFixtures.conflict.notes,
    setup: async ctx => {
      const fixture = recoveryFixtures.conflict, originalApply = ctx.changes.apply.bind(ctx.changes)
      let injected = false
      ctx.changes.apply = async (set, files, layouts, operationId) => {
        if (!injected && files.some(op => op.area === 'notes' && op.name === fixture.fault.name && op.after !== null)) {
          injected = true
          const current = await ctx.store.load(fixture.fault.name)
          await ctx.store.saveContent(fixture.fault.name, current.content + fixture.fault.append, current.content)
          ctx.trace.push({ kind: 'injected-fault', fault: 'concurrent-external-edit', name: fixture.fault.name, note: 'External addition persisted after tool plan creation, before actual version validation.' })
        }
        await originalApply(set, files, layouts, operationId)
      }
    },
    execute: async ctx => { await ctx.run(recoveryFixtures.conflict.prompt) },
    verify: async ctx => {
      const fixture = recoveryFixtures.conflict
      return [
        ...commonChecks(ctx, 'conflict'),
        ...(await Promise.all(fixture.expected.editedNames.map(async name => fact('Only the requested date changed in ' + name,
          await ctx.read(name) === fixture.notes[name as keyof typeof fixture.notes].replaceAll(fixture.expected.staleDate, fixture.expected.date) + (name === fixture.fault.name ? fixture.fault.append : ''))))),
        fact('Concurrent addition was reread after conflict', resultsAfterFailure(ctx, 'conflict').some(result => result.name === fixture.fault.name && typeof result.content === 'string' && result.content.includes(fixture.fault.append))),
        fact('Historical archive remains byte-for-byte unchanged', await ctx.read('档案/上次发布.md') === fixture.notes['档案/上次发布.md']),
        fact('No duplicate notes created during recovery', (await ctx.store.names()).filter(name => name !== 'Welcome.md').length === Object.keys(fixture.notes).length),
      ]
    },
    humanReview: ['Did the model reread current content after conflict, preserve the external addition, then finish both requested edits?', 'Did it verify both actual notes and truthfully report remaining work rather than just state that a conflict happened?'],
  },
  {
    id: recoveryFixtures.lostWriteReceipt.id,
    description: 'A create transaction commits but its return fails; inspect actual saved state instead of creating a duplicate.',
    notes: recoveryFixtures.lostWriteReceipt.notes,
    setup: async ctx => {
      const fixture = recoveryFixtures.lostWriteReceipt, originalApply = ctx.changes.apply.bind(ctx.changes)
      let injected = false
      ctx.changes.apply = async (set, files, layouts, operationId) => {
        await originalApply(set, files, layouts, operationId)
        if (!injected && files.some(op => op.area === 'notes' && op.before === null && op.name.includes(fixture.fault.title))) {
          injected = true
          ctx.trace.push({ kind: 'injected-fault', fault: 'committed-write-receipt-lost', names: files.filter(op => op.area === 'notes').map(op => op.name) })
          throw new Error('Injected live-eval transport failure after the real create transaction committed')
        }
      }
    },
    execute: async ctx => { await ctx.run(recoveryFixtures.lostWriteReceipt.prompt) },
    verify: async ctx => [
      ...commonChecks(ctx, 'execution_unknown'), ...await summaryChecks(ctx, recoveryFixtures.lostWriteReceipt),
      fact('Committed summary was read after the uncertain write', resultsAfterFailure(ctx, 'execution_unknown').some(result => result.name === '调研/交接改进摘要.md' && typeof result.content === 'string')),
    ],
    humanReview: ['Did the model inspect the existing summary after the uncertain write, avoid repeating create_note, and verify the source-link and requested facts?', 'Does the final statement distinguish verified persistence from the failed return?'],
  },
  {
    id: 'recovery-concurrent-decision-changed',
    description: 'Concurrent edit changes the actual target and introduces a release freeze; preserve the new decision and ask only the material clarification.',
    notes: { '发布/审批决定.md': changedDecisionOriginal },
    setup: async ctx => {
      const originalApply = ctx.changes.apply.bind(ctx.changes)
      let injected = false
      ctx.changes.apply = async (set, files, layouts, operationId) => {
        if (!injected && files.some(op => op.area === 'notes' && op.name === '发布/审批决定.md' && op.after !== null)) {
          injected = true
          const current = await ctx.store.load('发布/审批决定.md')
          await ctx.store.saveContent('发布/审批决定.md', changedDecisionLatest, current.content)
          ctx.trace.push({ kind: 'injected-fault', fault: 'concurrent-target-and-constraint-changed', name: '发布/审批决定.md' })
        }
        await originalApply(set, files, layouts, operationId)
      }
    },
    execute: async ctx => { await ctx.run('把发布文件夹中「审批决定」的上线日期从 2026-11-03 改成 2026-11-10，其他内容保持原样，改完核实一下。') },
    verify: async ctx => [
      ...commonChecks(ctx, 'conflict'),
      fact('Concurrent target and release freeze were preserved exactly', await ctx.read('发布/审批决定.md') === changedDecisionLatest),
      fact('No extra files were created', (await ctx.store.names()).filter(name => name !== 'Welcome.md').length === 1),
      fact('Current decision was read after conflict', resultsAfterFailure(ctx, 'conflict').some(result => result.name === '发布/审批决定.md' && result.content === changedDecisionLatest)),
      fact('Response contains a clarification question', /[？?]/.test(ctx.turns[0]?.history.filter(message => message.role === 'assistant').at(-1)?.content ?? '')),
    ],
    humanReview: ['Does the final question specifically address the new 2026-11-18 date and release freeze, rather than simply repeat the original authorization?', 'Were the new decision and all other content preserved without a stale edit or a new replacement decision?'],
  },
  {
    id: recoveryFixtures.transientRead.id,
    description: 'The first source read fails once; recover the original facts before writing one cross-note summary.',
    notes: recoveryFixtures.transientRead.notes,
    setup: async ctx => {
      const fixture = recoveryFixtures.transientRead, originalLoad = ctx.store.load.bind(ctx.store)
      let injected = false
      ctx.store.load = async name => {
        if (!injected && name === fixture.fault.name) {
          injected = true
          ctx.trace.push({ kind: 'injected-fault', fault: 'transient-read-failure', name })
          throw Object.assign(new Error('Injected one-time live-eval read failure'), { code: 'EIO' })
        }
        return originalLoad(name)
      }
    },
    execute: async ctx => { await ctx.run(recoveryFixtures.transientRead.prompt) },
    verify: async ctx => [...commonChecks(ctx, 'execution_unknown'), ...await summaryChecks(ctx, recoveryFixtures.transientRead)],
    humanReview: ['Did the model obtain original source facts after the read failure, rather than invent facts from filenames/excerpts?', 'Do the summary distinguish the two customers and their separate non-goals accurately?'],
  },
]
