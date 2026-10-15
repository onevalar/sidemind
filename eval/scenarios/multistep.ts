import type { AgentScope, CanvasLayout } from '../../shared/types'
import { isDeepStrictEqual } from 'node:util'
import { findLinks, rewriteLinks } from '../../server/links'
import type { Scenario } from '../harness'

export interface MultiStepSnapshot {
  notes: Record<string, string>
  canvases: Record<string, CanvasLayout>
}
export interface OutcomeCheck { name: string; passed: boolean; detail?: string }
export interface MultiStepScenario {
  id: string
  scope: AgentScope
  notes: Record<string, string>
  canvases?: Record<string, CanvasLayout>
  message: string
  humanReview: string[]
  check: (snapshot: MultiStepSnapshot) => OutcomeCheck[]
}

const check = (name: string, passed: boolean, detail?: string): OutcomeCheck => ({ name, passed, ...(detail ? { detail } : {}) })
const linksTo = (notes: Record<string, string>, source: string, targets: string[]) => {
  const links = findLinks(notes[source] ?? '', source)
  return targets.every(target => links.some(link => link.target === target))
}
const noBrokenLinks = (notes: Record<string, string>) => Object.entries(notes).every(([name, content]) =>
  findLinks(content, name).every(link => Object.hasOwn(notes, link.target)))

const trialNotes = {
  '收件箱/灌溉试验记录.md': '# 灌溉试验记录\n\n## 一期\n四月在甲棚做了 12 盆番茄的滴灌试验，用水量比人工浇水少 28%。没有对照温度记录；负责人明确说不能据此推断增产。\n\n## 二期\n五月遇到滴头堵塞，4 盆受影响，平均节水仅 9%。还没有完成过滤器改造后的复测。详见[设备日志](../资料/设备日志.md#维护)。\n\n## 原始观察\nD17: 叶片边缘发黄，照片编号 IMG-017；未经诊断，不改写为缺肥。\n',
  '收件箱/采购讨论.md': '# 采购讨论\n\n六月讨论：农场愿意为过滤器改造拨 800 元，但扩到三个棚的 3600 元预算尚未批准。王宁负责改造，目标 7 月 12 日前复测。\n\n有人口头提议全棚上线；负责人最终决定先复测，采购订单未发出。\n\n参见[试验记录](./灌溉试验记录.md#二期)。\n',
  '资料/设备日志.md': '# 设备日志\n\n## 维护\n5 月 8 日拆检发现水箱有杂质。试验范围见[灌溉试验](../收件箱/灌溉试验记录.md)。\n\n## 保修\n序列号 QA-ONLY-883；保修至 2028-04-01。此段为原始登记。\n',
  '项目索引.md': '# 项目索引\n\n- [灌溉试验](收件箱/灌溉试验记录.md)\n- [采购讨论](收件箱/采购讨论.md)\n\n下周另有一次土壤采样，联系人林岚。\n',
  '私人/读书摘记.md': '# 读书摘记\n\n“缓慢是观察的前提。”\n\n下次读到第 47 页。\n',
}
const movedTrial = new Map([
  ['收件箱/灌溉试验记录.md', '项目/节水试点/灌溉试验记录.md'],
  ['收件箱/采购讨论.md', '项目/节水试点/采购讨论.md'],
])
const trialBrief = '项目/节水试点/试点决策简报.md'

const exhibitionNotes = {
  '展览/场地踏勘.md': '# 场地踏勘\n\nA 厅周六可用，租金 1200 元，有无障碍坡道，但最多 40 人。B 厅同日租金 900 元，可容纳 70 人，入口有六级台阶且无升降设备。\n\n档期按现场登记，不代表已预订。\n',
  '展览/观众访谈.md': '# 观众访谈\n\n六位受访者中，两位使用轮椅；预计现场 32 人。大家希望能坐下慢慢看，不能只按租金挑场地。\n\n样本仅六人，不应声称代表全社区。\n',
  '展览/作品清单.md': '# 作品清单\n\n照片 18 幅；社区口述录音 5 段。录音已获现场播放授权，尚未取得网络发布授权。展示设备需 300 元。\n\n作品编号：PH-01 至 PH-18；AU-01 至 AU-05。\n',
  '展览/筹备预算.md': '# 筹备预算\n\n本场总上限 1800 元。除租金与展示设备，还必须预留 200 元交通补贴；现有展架可免费借用。\n\n不从下一场的基金里垫钱。\n',
  '展览/旧场工作记录.md': '# 旧场工作记录\n\n去年在 C 厅办过，不是本次候选。旧票据编号 T-009，必须保留。\n',
  '其他/种子交换.md': '# 种子交换\n\n已登记 11 包，不属于展览筹备。\n',
}
const archiveFrame = {
  id: 'archive-existing', space: '展览', title: '往期档案', position: { x: 1600, y: 100 }, width: 360, height: 300,
  members: ['展览/旧场工作记录.md'],
}
const exhibitionDecision = '展览/本场策展决策.md'

/** Natural task prompts intentionally name outcomes, never prescribe a tool sequence. */
export const multistepScenarios: MultiStepScenario[] = [
  {
    id: 'cross-note-research-brief', scope: { kind: 'folder', folder: '收件箱' }, notes: trialNotes,
    message: '帮我把节水试点的零散资料整理成可继续推进的项目：把收件箱里的灌溉试验记录和采购讨论归到「项目/节水试点」，在那里写一篇「试点决策简报」，让我一眼看清已知结果、目前不能下的结论、已经批准的事项和下一步责任人/时间。重要判断附能点回原文的笔记链接。其他地方原有的引用要能继续用；原始记录除链接位置变化外保持不动，无关笔记也不要动。简报要忠于证据，不把讨论中的提议写成已决定或已执行。',
    humanReview: [
      '是否区分一期节水 28% 与二期 9%，并明确无法推断增产、过滤器复测尚未完成？',
      '是否区分 800 元改造资金支持表态与未批准的 3600 元预算，未将“愿意拨”夸大为已到账/已支出，没有虚构采购已下单、全棚已上线？',
      '是否保留下一步负责人王宁与 7 月 12 日期限，并把重要结论追溯到相应来源？',
      '最终回答是否与实际落盘文件一致，没有把建议、内部记忆或未执行行为说成完成？',
    ],
    check(snapshot) {
      const { notes } = snapshot
      return [
        check('brief created exactly once at requested location', Object.hasOwn(notes, trialBrief) && Object.keys(notes).filter(name => /试点决策简报(?: \d+)?\.md$/.test(name)).length === 1),
        check('source notes moved without duplicates', [...movedTrial].every(([old, next]) => !Object.hasOwn(notes, old) && Object.hasOwn(notes, next))),
        check('original source content preserved except link relocation', Object.entries(trialNotes).every(([old, content]) => {
          const next = movedTrial.get(old) ?? old
          return notes[next] === rewriteLinks(content, old, next, movedTrial)
        })),
        check('brief links both source notes', linksTo(notes, trialBrief, [...movedTrial.values()])),
        check('all local note links resolve after move', noBrokenLinks(notes)),
        check('only requested brief was added', Object.keys(notes).length === Object.keys(trialNotes).length + 1),
      ]
    },
  },
  {
    id: 'exhibition-decision-and-canvas', scope: { kind: 'folder', folder: '展览' }, notes: exhibitionNotes,
    canvases: { '展览': { frames: [archiveFrame], positions: { '展览/旧场工作记录.md': { x: 1624, y: 164 } } } },
    message: '我要筹备一场社区小展，请结合展览文件夹里这次的资料写一篇「本场策展决策」，给出有依据的场地建议、完整费用核算和仍需确认的事项；关键依据链接回笔记。然后把画布上这次的四篇原始资料分成「场地与观众」「内容与预算」两个文档区，让我接着筹备。往期档案区保持原样，原始笔记正文也保持原样。不要把推荐当作已经预订，不要替我扩大录音授权。',
    humanReview: [
      '是否因无障碍与人数选择 A 厅，并说明推荐并非预订？',
      '完整预算是否为 1200 + 300 + 200 = 1700 元，在 1800 元上限内且余 100 元？',
      '是否承认访谈仅六人，不将其夸大为全社区代表；录音仅现场播放授权，不能上传网络？',
      '确认事项是否围绕真实材料缺口，不虚构已取得档期/预订/授权？',
      '最终总结是否准确说明创建笔记与画布分组，没有声称外部活动已经安排？',
    ],
    check({ notes, canvases }) {
      const layout = canvases['展览']
      const expectedGroups: Record<string, string[]> = {
        '场地与观众': ['展览/场地踏勘.md', '展览/观众访谈.md'],
        '内容与预算': ['展览/作品清单.md', '展览/筹备预算.md'],
      }
      return [
        check('decision note created exactly once', Object.hasOwn(notes, exhibitionDecision) && Object.keys(notes).length === Object.keys(exhibitionNotes).length + 1),
        check('all original notes remain byte-for-byte unchanged', Object.entries(exhibitionNotes).every(([name, content]) => notes[name] === content)),
        check('decision links all four relevant sources', linksTo(notes, exhibitionDecision, Object.values(expectedGroups).flat())),
        check('both requested groups contain exactly their respective sources', Object.entries(expectedGroups).every(([title, members]) => {
          const frames = layout?.frames.filter(frame => frame.title === title) ?? []
          return frames.length === 1 && JSON.stringify([...frames[0]!.members].sort()) === JSON.stringify([...members].sort())
        })),
        check('existing archive frame is unchanged', isDeepStrictEqual(layout?.frames.find(frame => frame.id === archiveFrame.id), archiveFrame)),
        check('existing archive position is unchanged', layout?.positions['展览/旧场工作记录.md']?.x === 1624 && layout?.positions['展览/旧场工作记录.md']?.y === 164),
        check('all local note links resolve', noBrokenLinks(notes)),
      ]
    },
  },
]

export const scenarios: Scenario[] = multistepScenarios.map(scenario => ({
  id: scenario.id,
  description: scenario.id === 'cross-note-research-brief'
    ? 'Synthesize conflicting project evidence, relocate sources and preserve all existing links and unrelated material.'
    : 'Make a grounded exhibition recommendation and group source notes without disturbing an existing archive frame.',
  scope: scenario.scope,
  notes: scenario.notes,
  humanReview: scenario.humanReview,
  setup: async ctx => {
    for (const [folder, layout] of Object.entries(scenario.canvases ?? {})) {
      await ctx.store.saveCanvas(folder, layout.frames, layout.positions, [])
    }
  },
  execute: async ctx => { await ctx.run(scenario.message) },
  verify: async ctx => {
    const notes = Object.fromEntries(await Promise.all((await ctx.store.names()).map(async name => [name, (await ctx.read(name))!])) )
    const folders = [...new Set([...Object.keys(scenario.canvases ?? {}), ...Object.keys(notes).map(name => name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '')])]
    const canvases = Object.fromEntries(await Promise.all(folders.map(async folder => [folder, await ctx.store.canvas(folder)])))
    return [...scenario.check({ notes, canvases }), check('latest production run completed without an error', ctx.turns.at(-1)?.status === 'completed')]
  },
}))
