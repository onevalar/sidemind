import type { Scenario } from '../harness'
export const scenarios: Scenario[] = [{
  id: 'smoke', description: 'Real configured model can read a synthetic note without editing it.',
  notes: { 'Fixture.md': '# Fixture\n\n这是一份合成评测资料，标识为 LIME-742。\n' },
  execute: async ctx => { await ctx.run('请读 Fixture 这篇笔记，告诉我里面的标识。不要修改任何文件。', { maxCalls: 4 }) },
  verify: async ctx => [
    { name: 'real-model-read', passed: ctx.turns[0]?.events.some(e => e.type === 'message' && e.text.includes('LIME-742')) ?? false },
    { name: 'unchanged', passed: await ctx.read('Fixture.md') === '# Fixture\n\n这是一份合成评测资料，标识为 LIME-742。\n' },
  ],
}]
