import type { MessageId, BranchId, AnchorId, Message, Anchor, ChatState, TextSlice } from '../types';
import { colorForIntent } from './colors';

const ROOT = 'br_root' as BranchId;
const SPACE = 'example_space' as BranchId;
const OPEN = 'example_open' as BranchId;
const DENSITY = 'example_density' as BranchId;
const now = Date.now();
const rootReply = `## 笔记工具的三个方向

先让人看清想法之间的关系，再逐步引入 AI。

### 空间帮助找回想法

固定的位置和自然的分组能帮助我们找回想法。让相近的笔记待在一起，用户再次打开工作区时就能沿着熟悉的位置继续思考。

### 内容保持开放

Markdown 让文字独立于应用存在。正文、链接与引用应能导出；空间位置可以作为额外信息保存，迁移时仍能带走内容。

### AI 的改动可以理解

展示 AI 将读取哪些内容，先提供修改预览，再由用户决定是否应用。保留撤销入口，让每次尝试都能退回。`;
const spaceReply = `## 让空间更容易记住

### 保留位置

整理之后，笔记应保留在用户放置的地方。新增内容可以在附近展开，已有卡片不随回复长度重新排队。

### 逐步展示细节

缩小时看到标题与关系，放大后按需查看。完整正文放在阅读视图中，避免每张卡片都被长文本撑满。

### 把来源留在身边

分支保留引用和返回原文的入口。读到一个结论时，用户能回到当时的问题，判断它适用于什么背景。`;

function example(id: string, role: 'user' | 'assistant', branchId: BranchId, content: string, parent: string | null, age: number): Message {
  return { id: id as MessageId, role, branchId, content, parentId: parent as MessageId | null,
    anchorIds: [], createdAt: now - age, example: true };
}
const messages: Record<string, Message> = {
  example_q: example('example_q', 'user', ROOT, '如何设计一款帮助研究者管理想法的笔记工具？', null, 60000),
  example_a: example('example_a', 'assistant', ROOT, rootReply, 'example_q', 55000),
  example_q2: example('example_q2', 'user', ROOT, '第一步怎样验证这些设计是否有帮助？', 'example_a', 12000),
  example_a2: example('example_a2', 'assistant', ROOT, `## 从一次小规模研究开始

选取 20 篇真实笔记，围绕一个具体研究问题整理它们。先完成保存、分组、阅读和再次找回，再决定哪些步骤需要 AI。

隔一天回到工作区，观察能否找回昨天的关键线索。记录卡住的位置、重复的操作和需要返回原文的时刻，用这些观察来决定下一轮调整。`, 'example_q2', 10000),
  space_q: example('space_q', 'user', SPACE, '有哪些具体的方法能让空间更容易记住？', null, 50000),
  space_a: example('space_a', 'assistant', SPACE, spaceReply, 'space_q', 45000),
  open_q: example('open_q', 'user', OPEN, '开放的数据格式应当保留哪些信息？', null, 40000),
  open_a: example('open_a', 'assistant', OPEN, `## 让内容可以完整带走

正文使用 Markdown，保留标题、链接与引用。把空间坐标和分组信息放在独立的元数据中，避免只能在某个应用里打开文字。

导出之后，应当能用普通文本编辑器阅读笔记；再次导入时，则恢复仍然有效的空间位置和关系。缺失的引用应明确提示，避免悄悄指向错误内容。`, 'open_q', 35000),
  density_q: example('density_q', 'user', DENSITY, '怎样在概览与完整阅读之间切换？', null, 30000),
  density_a: example('density_a', 'assistant', DENSITY, `## 让每种视图完成一件事

概览突出标题、引用关系和简短摘要，用于判断接下来读哪一条分支。展开阅读之后，显示完整正文、来源引用和继续提问的输入框。

返回画布时保留卡片位置。需要追溯背景时，使用返回引用位置的入口；需要比较路径时，再缩小查看整个关系图。`, 'density_q', 25000),
};

const anchors: Record<string, Anchor> = {};
function connect(id: string, source: string, target: BranchId, quotation: string, question: string): AnchorId {
  const content = messages[source].content;
  const offset = content.indexOf(quotation);
  const slice: TextSlice = { startOffset: offset, endOffset: offset + quotation.length, selectedText: quotation };
  const anchorId = id as AnchorId;
  anchors[id] = { id: anchorId, messageId: source as MessageId, branchId: target, slice,
    intent: 'new-branch', color: colorForIntent('new-branch'), status: 'done' };
  messages[source].anchorIds.push(anchorId);
  messages[question].quote = { raw: quotation, display: quotation, sourceMessageId: source as MessageId };
  return anchorId;
}
const spaceAnchor = connect('example_anchor_space', 'example_a', SPACE, '固定的位置和自然的分组能帮助我们找回想法。', 'space_q');
const openAnchor = connect('example_anchor_open', 'example_a', OPEN, 'Markdown 让文字独立于应用存在。', 'open_q');
const densityAnchor = connect('example_anchor_density', 'space_a', DENSITY, '缩小时看到标题与关系，放大后按需查看。', 'density_q');

type ConversationView = Pick<ChatState, 'messages' | 'anchors' | 'branches' | 'blackboard' | 'rootBranchId' | 'ui' | 'canvas'>;
const ui: ChatState['ui'] = { viewMode: 'linear', canvasMode: 'branches', focusedAnchorId: null, activeBranchPanelId: null, pendingSelection: null };

/** Explicitly selected onboarding content; no model request or connection is implied. */
export const mockState: ConversationView = {
  messages, anchors, rootBranchId: ROOT,
  branches: {
    [ROOT]: { id: ROOT, label: '笔记工具的产品研究', sourceAnchorId: null, sourceMessageId: null, messageIds: ['example_q', 'example_a', 'example_q2', 'example_a2'] as MessageId[], status: 'done' },
    [SPACE]: { id: SPACE, label: '空间如何帮助记忆', sourceAnchorId: spaceAnchor, sourceMessageId: 'example_a' as MessageId, messageIds: ['space_q', 'space_a'] as MessageId[], status: 'done' },
    [OPEN]: { id: OPEN, label: '内容为什么要开放', sourceAnchorId: openAnchor, sourceMessageId: 'example_a' as MessageId, messageIds: ['open_q', 'open_a'] as MessageId[], status: 'done' },
    [DENSITY]: { id: DENSITY, label: '渐进的信息密度', sourceAnchorId: densityAnchor, sourceMessageId: 'space_a' as MessageId, messageIds: ['density_q', 'density_a'] as MessageId[], status: 'done' },
  },
  blackboard: {
    [SPACE]: { branchId: SPACE, sourceMessageId: 'space_a' as MessageId, summary: '保留稳定的位置，细节按需展开；引用可以返回原文。', keyFacts: ['位置稳定', '按需展开', '来源可追溯'], updatedAt: now - 45000, example: true },
    [OPEN]: { branchId: OPEN, sourceMessageId: 'open_a' as MessageId, summary: '正文保持开放，空间信息单独保存，迁移时能够带走内容。', keyFacts: ['正文可导出', '元数据独立'], updatedAt: now - 35000, example: true },
  },
  ui: { ...ui }, canvas: { nodes: [], edges: [] },
};
export const emptyState: ConversationView = {
  messages: {}, anchors: {}, blackboard: {}, rootBranchId: ROOT,
  branches: { [ROOT]: { id: ROOT, label: '主线对话', sourceAnchorId: null, sourceMessageId: null, messageIds: [], status: 'idle' } },
  ui: { ...ui }, canvas: { nodes: [], edges: [] },
};
