import path from 'node:path'
import type { Scenario } from '../harness'

/** Natural-language evaluations. Fixtures must only be loaded into a temporary workspace. */
export const correctionsScenario = {
  id: 'interrupt-and-correct-one-field',
  scope: { kind: 'folder' as const, folder: '发布协作' },
  notes: {
    '发布协作/研发准备.md': '# 研发准备\n\n负责人：林舟\n联调会议：周二 14:00\n会议地点：B 会议室\n\n## 发布前检查\n- [ ] 核对回滚开关\n- [ ] 备份数据库\n\n约束：不在周五正式发布。\n',
    '发布协作/运营准备.md': '# 运营准备\n\n负责人：陈雨\n联调会议：周二 14:00\n会议地点：B 会议室\n\n## 文案\n用户公告保留现有措辞，等待法务确认。\n\n关联：[研发准备](研发准备.md)\n',
    '参考/旧项目记录.md': '# 旧项目记录\n\n周二 14:00，B 会议室。此记录已归档，不属于本次发布。\n',
  },
  firstMessage: '把发布协作里研发和运营两份准备笔记的联调会议统一改成周五 15:00、A 会议室，负责人和其他原文都保留。再在这个文件夹建一篇《联调安排》，汇总两个负责人、会议时间地点和发布前检查项，链接到这两篇来源。做完核对三篇之间的信息一致。',
  // Interrupt after a real successful write receipt, never by substituting a model reply.
  interruptAfter: 'first-changeset' as const,
  correction: '等一下，会议时间改成下周一 10:30，其他不变。继续完成刚才的安排。',
  followupCorrection: '汇总里的会议地点改为线上，链接用 https://meet.example.invalid/release；两篇来源也一起同步，其他不要动。',
  rubric: [
    'Interrupted run reaches cancelled before the correction starts; correction reuses its session.',
    'Final three notes agree on 下周一 10:30 and A 会议室 after first correction, then agree on 线上 and the provided URL after follow-up.',
    'Exactly one 联调安排 note exists; no duplicate suffixed summary after cancellation or follow-up.',
    'Owners 林舟 and 陈雨 are retained, checklist and original release constraint are unchanged.',
    '运营准备 announcement wording and its source link are preserved; archived note is byte-for-byte unchanged.',
    'Summary has working relative Markdown links to both source notes and the requested checklist.',
    'Model reads persisted results after writes and its final report matches actual files.',
    'A one-off meeting correction does not become a permanent user preference in memory.',
  ],
}

export const scenarios: Scenario[] = [{
  id: correctionsScenario.id,
  description: '在真实模型首次写入后中止，只纠正时间继续同一目标；完成后再跨三篇同步地点。',
  notes: correctionsScenario.notes,
  scope: correctionsScenario.scope,
  humanReview: correctionsScenario.rubric,
  execute: async ctx => {
    const interrupted = await ctx.run(correctionsScenario.firstMessage, { stopWhen: event => event.type === 'changeset' })
    if (interrupted.status !== 'cancelled') throw new Error('Did not interrupt after a real write receipt: ' + interrupted.status)
    await ctx.run(correctionsScenario.correction, { session: interrupted.session })
    ctx.trace.push({ kind: 'first-correction-snapshot', notes: Object.fromEntries(await Promise.all((await ctx.store.names()).map(async name => [name, await ctx.read(name)]))) })
    await ctx.run(correctionsScenario.followupCorrection, { session: interrupted.session })
  },
  verify: async ctx => {
    const names = await ctx.store.names(), summaries = names.filter(name => name.includes('联调安排'))
    const summary = summaries.length === 1 ? await ctx.read(summaries[0]!) ?? '' : ''
    const sourceNames = ['发布协作/研发准备.md', '发布协作/运营准备.md']
    const sources = await Promise.all(sourceNames.map(name => ctx.read(name)))
    const first = ctx.trace.find(entry => (entry as { kind?: string }).kind === 'first-correction-snapshot') as { notes: Record<string, string> } | undefined
    const firstSummary = first && Object.entries(first.notes).find(([name]) => name.includes('联调安排'))?.[1]
    const targets = [summary, ...sources.map(value => value ?? '')]
    const links = [...summary.matchAll(/\]\(([^)]+)\)/g)].map(match => {
      try { return path.posix.normalize(path.posix.join(path.posix.dirname(summaries[0] ?? ''), decodeURIComponent(match[1]!))) } catch { return '' }
    })
    return [
      { name: 'same-session correction only after cancelled run', passed: ctx.turns.length === 3 && ctx.turns[0]!.status === 'cancelled' && ctx.turns.every(turn => turn.session === ctx.turns[0]!.session) },
      { name: 'interruption follows a real successful write receipt', passed: !!ctx.turns[0]?.events.some(event => event.type === 'changeset') },
      { name: 'no unrelated notes created or removed', passed: names.length === Object.keys(correctionsScenario.notes).length + 1 && Object.keys(correctionsScenario.notes).every(name => names.includes(name)) },
      { name: 'both corrections finish without tool-loop failure', passed: ctx.turns.slice(1).every(turn => turn.status === 'completed') },
      { name: 'first correction preserved original location and only changed time', passed: !!first && [...sourceNames.map(name => first.notes[name] ?? ''), firstSummary ?? ''].every(text => text.includes('下周一 10:30') && text.includes('A 会议室') && !text.includes('周五 15:00')) },
      { name: 'one summary only', passed: summaries.length === 1, detail: summaries.join(', ') },
      { name: 'final time and online location agree across three notes', passed: targets.every(text => text.includes('下周一 10:30') && text.includes('线上') && text.includes('https://meet.example.invalid/release') && !text.includes('周五 15:00') && !text.includes('A 会议室')) },
      { name: 'source owners and unrelated content preserved', passed: !!sources[0]?.includes('负责人：林舟') && !!sources[0]?.includes('## 发布前检查\n- [ ] 核对回滚开关\n- [ ] 备份数据库\n\n约束：不在周五正式发布。') && !!sources[1]?.includes('负责人：陈雨') && !!sources[1]?.includes('## 文案\n用户公告保留现有措辞，等待法务确认。\n\n关联：[研发准备](研发准备.md)') },
      { name: 'archived note untouched', passed: await ctx.read('参考/旧项目记录.md') === correctionsScenario.notes['参考/旧项目记录.md'] },
      { name: 'summary retains required people checklist and working source links', passed: ['林舟', '陈雨', '回滚开关', '备份数据库'].every(fact => summary.includes(fact)) && sourceNames.every(name => links.includes(name)) },
      { name: 'one-off correction not stored as preference', passed: !ctx.turns.some(turn => turn.history.some(message => message.tool_calls?.some(call => call.function.name === 'remember'))) },
    ]
  },
}]
