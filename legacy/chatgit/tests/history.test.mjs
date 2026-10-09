import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotConversation, settledConversation } from '../src/history.ts';

function fixture() {
  return {
    rootBranchId: 'root',
    messages: {
      user: { id: 'user', role: 'user', content: '  一个\n独立的想法  ', branchId: 'root', parentId: null, anchorIds: [], createdAt: 100 },
      answer: { id: 'answer', role: 'assistant', content: '已收到的部分回复', branchId: 'root', parentId: 'user', anchorIds: ['anchor'], createdAt: 101 },
    },
    branches: { root: { id: 'root', label: '主线', sourceAnchorId: null, sourceMessageId: null, messageIds: ['user','answer'], status: 'streaming' } },
    anchors: { anchor: { id: 'anchor', messageId: 'answer', slice: { startOffset: 0, endOffset: 2, selectedText: '已收' }, branchId: 'root', intent: 'main', color: '#408368', status: 'streaming' } },
    blackboard: {},
    apiKey: 'must-never-be-archived', provider: 'openai', canvas: {}, ui: {},
  };
}
test('history snapshots preserve conversation data without credentials or UI state', () => {
  const original = fixture();
  const saved = snapshotConversation(original, 'one');
  assert.equal(saved.title, '一个 独立的想法');
  assert.equal(saved.updatedAt, 101);
  assert.equal(saved.messages.answer.content, original.messages.answer.content);
  for (const key of ['apiKey','provider','canvas','ui']) assert.equal(key in saved, false);
  assert.equal(original.branches.root.status, 'streaming');
  assert.equal(original.messages.answer.error, undefined);
});
test('switching or stopping keeps partial replies and makes every branch usable again', () => {
  const original = fixture();
  const stopped = settledConversation(original);
  assert.equal(stopped.branches.root.status, 'done');
  assert.match(stopped.messages.answer.error, /停止/);
  assert.equal(stopped.messages.answer.content, '已收到的部分回复');
  assert.equal(stopped.anchors.anchor.status, 'error');
  assert.deepEqual(settledConversation(stopped), stopped);
});
test('an empty conversation still has a stable root and title', () => {
  const original = fixture();
  original.messages = {};
  original.branches.root.messageIds = [];
  const saved = snapshotConversation(original, 'empty');
  assert.equal(saved.rootBranchId, 'root');
  assert.equal(saved.title, '新对话');
  assert.equal(saved.updatedAt, 0);
});
