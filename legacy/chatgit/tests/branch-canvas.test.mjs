import test from 'node:test';
import assert from 'node:assert/strict';
import { branchCanvas, restoreBranchPositions, canvasExcerpt, BRANCH_CARD_WIDTH, BRANCH_CARD_HEIGHT } from '../src/lib/branch-canvas.ts';

function fixture() {
  return {
    rootBranchId: 'root', blackboard: {},
    branches: {
      root: { id: 'root', label: '主线', messageIds: ['question', 'reply'], sourceMessageId: null, status: 'done' },
      child: { id: 'child', label: '一个分支', messageIds: ['childQ', 'childA'], sourceMessageId: 'reply', status: 'done' },
    },
    messages: {
      question: { id: 'question', role: 'user', content: '# 我的研究问题', branchId: 'root', createdAt: 100 },
      reply: { id: 'reply', role: 'assistant', content: '## 一段完整回复\n这不是新生成的结论。', branchId: 'root', createdAt: 101 },
      childQ: { id: 'childQ', role: 'user', content: '追问', branchId: 'child', createdAt: 102 },
      childA: { id: 'childA', role: 'assistant', content: '分支回复', branchId: 'child', createdAt: 103 },
    },
    anchors: {
      first: { id: 'first', messageId: 'reply', branchId: 'child', status: 'done' },
      duplicate: { id: 'duplicate', messageId: 'reply', branchId: 'child', status: 'done' },
      sameBranch: { id: 'sameBranch', messageId: 'reply', branchId: 'root', status: 'done' },
      missing: { id: 'missing', messageId: 'gone', branchId: 'child', status: 'done' },
    },
  };
}

test('branch cards derive real relationships, counts, and excerpts without fabricating shared conclusions', () => {
  const source = fixture();
  const canvas = branchCanvas(source);
  assert.equal(canvas.nodes.length, 2);
  assert.equal(canvas.edges.length, 1);
  assert.deepEqual([canvas.edges[0].source, canvas.edges[0].target], ['root', 'child']);
  const root = canvas.nodes.find(node => node.id === 'root');
  assert.equal(root.data.title, '我的研究问题');
  assert.equal(root.data.messageCount, 2);
  assert.equal(root.data.previewKind, 'reply');
  source.blackboard.child = { summary: '真正发布的结论' };
  assert.equal(branchCanvas(source).nodes.find(node => node.id === 'child').data.previewKind, 'conclusion');
  assert.equal(branchCanvas(source).nodes.find(node => node.id === 'child').data.preview, '真正发布的结论');
});

test('saved card positions stay fixed during streaming and new nested branches occupy free space', () => {
  const source = fixture();
  const saved = { root: { x: 80, y: 100 }, child: { x: 496, y: 100 } };
  source.messages.childA.content += ' 很长的新增内容'.repeat(1000);
  const streamed = branchCanvas(source, saved);
  assert.deepEqual(streamed.positions, saved);
  source.branches.nested = { id: 'nested', label: '深入探索', messageIds: [], sourceMessageId: 'childA', status: 'idle' };
  source.anchors.nested = { id: 'nested', messageId: 'childA', branchId: 'nested', status: 'streaming' };
  const added = branchCanvas(source, saved);
  assert.deepEqual(added.positions.root, saved.root);
  assert.deepEqual(added.positions.child, saved.child);
  assert.ok(added.positions.nested.x > saved.child.x);
  for (const [id, point] of Object.entries(saved)) assert.ok(Math.abs(point.x - added.positions.nested.x) >= BRANCH_CARD_WIDTH || Math.abs(point.y - added.positions.nested.y) >= BRANCH_CARD_HEIGHT, id);
  assert.equal(added.edges.length, 2);
  assert.ok(added.edges.some(edge => edge.animated));
});

test('restoring layouts rejects malformed coordinates and keeps conversations isolated', () => {
  const restored = restoreBranchPositions({ one: { root: { x: 10, y: 20 }, bad: { x: Infinity, y: 0 }, invalid: { x: '10', y: 0 }, huge: { x: 100001, y: 0 } }, two: { root: { x: 50, y: 60 } }, array: [] });
  assert.deepEqual(restored, { one: { root: { x: 10, y: 20 } }, two: { root: { x: 50, y: 60 } } });
  assert.deepEqual(restoreBranchPositions(null), {});
});

test('empty workspaces and cross-branch cycles produce finite, valid layouts', () => {
  const source = fixture();
  source.anchors.back = { id: 'back', messageId: 'childA', branchId: 'root', status: 'done' };
  const cyclic = branchCanvas(source);
  assert.equal(cyclic.edges.length, 2);
  assert.ok(Object.values(cyclic.positions).every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
  assert.deepEqual(branchCanvas({ rootBranchId: 'root', branches: { root: { id: 'root', messageIds: [] } }, messages: {}, anchors: {}, blackboard: {} }).nodes, []);
});

test('Markdown previews remove presentation syntax and keep excerpts bounded', () => {
  assert.equal(canvasExcerpt('## 标题\n[链接](https://example.com) **正文**\n```js\nsecret-code();\n```'), '标题 链接 正文 代码片段');
  assert.equal(canvasExcerpt('一个很长的标题', 2), '一个');
});
