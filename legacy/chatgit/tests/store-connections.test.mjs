import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
const load = createRequire(import.meta.url);
const ts = load('typescript');

// Compile the real store and its local TS imports using the existing compiler.
// All requests below are intercepted; no API keys or conversations leave this test.
const previousTs = Module._extensions['.ts'];
Module._extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const { useChatStore } = load('../src/store.ts');
Module._extensions['.ts'] = previousTs;
useChatStore.persist.setOptions({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });

test('real send actions retain model and credential routing across defaults, branches, and history switches', { timeout: 5000 }, async () => {
  const priorFetch = global.fetch;
  const requests = [];
  global.fetch = async (_url, request) => {
    requests.push(request);
    return new Response('data: {"text":"A complete test answer."}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    let store = useChatStore.getState();
    store.saveConnection({ provider: 'openai', model: 'old-model', baseUrl: 'https://old.example/v1' }, 'old-key');
    await store.sendMessage(store.rootBranchId, 'first question');
    const oldId = useChatStore.getState().activeConversationId;
    store = useChatStore.getState();
    store.saveConnection({ provider: 'anthropic', model: 'new-model', baseUrl: '' }, 'new-key');
    await store.sendMessage(store.rootBranchId, 'follow up on old conversation');
    assert.equal(requests[1].headers['x-model'], 'old-model');
    assert.equal(requests[1].headers['x-api-key'], 'old-key');
    assert.equal(requests[1].headers['x-base-url'], 'https://old.example/v1');

    store = useChatStore.getState();
    const answer = Object.values(store.messages).find(m => m.role === 'assistant');
    const branch = store.askFromSelection({ messageId: answer.id, slice: { startOffset: 0, endOffset: 1, selectedText: 'A' }, intent: 'new-branch', branchLabel: '自定义分支名称', question: 'a branch question' });
    assert.ok(branch);
    assert.equal(useChatStore.getState().branches[branch].label, '自定义分支名称');
    assert.equal(requests[2].headers['x-provider'], 'openai');
    assert.equal(requests[2].headers['x-api-key'], 'old-key');
    // Allow the real response stream to settle before switching histories.
    while (useChatStore.getState().branches[branch].status === 'streaming') await new Promise(resolve => setImmediate(resolve));
    const published = useChatStore.getState().blackboard[branch];
    assert.ok(published.sourceMessageId, 'conclusions retain the exact completed reply');
    assert.equal(useChatStore.getState().messages[published.sourceMessageId].role, 'assistant');
    assert.equal(useChatStore.getState().messages[published.sourceMessageId].branchId, branch);
    assert.ok(published.updatedAt > 0);
    useChatStore.getState().setViewMode('canvas');
    useChatStore.getState().revealMessage(published.sourceMessageId);
    let navigation = useChatStore.getState().ui;
    assert.equal(navigation.viewMode, 'linear');
    assert.equal(navigation.activeBranchPanelId, branch);
    assert.equal(navigation.messageReveal.messageId, published.sourceMessageId);
    const firstRequest = navigation.messageReveal.request;
    useChatStore.getState().revealMessage(published.sourceMessageId);
    assert.ok(useChatStore.getState().ui.messageReveal.request > firstRequest, 'repeated navigation can reveal the same reply again');
    navigation = useChatStore.getState().ui;
    useChatStore.getState().revealMessage('missing-reply');
    assert.equal(useChatStore.getState().ui, navigation, 'removed sources never navigate to an unrelated reply');
    useChatStore.getState().setActiveBranchPanel(null);
    assert.equal(useChatStore.getState().ui.messageReveal, undefined);

    useChatStore.getState().resetToEmpty();
    store = useChatStore.getState();
    await store.sendMessage(store.rootBranchId, 'new conversation');
    assert.equal(requests[3].headers['x-provider'], 'anthropic');
    assert.equal(requests[3].headers['x-model'], 'new-model');
    assert.equal(requests[3].headers['x-api-key'], 'new-key');

    useChatStore.getState().switchConversation(oldId);
    store = useChatStore.getState();
    assert.equal(store.blackboard[branch].sourceMessageId, published.sourceMessageId, 'history switches preserve exact conclusion provenance');
    await store.sendMessage(store.rootBranchId, 'restored old conversation');
    assert.equal(requests[4].headers['x-api-key'], 'old-key');
    assert.equal(requests[4].headers['x-model'], 'old-model');

    store = useChatStore.getState();
    store.saveConnection({ provider: 'openai', model: 'old-model', baseUrl: 'https://old.example/v1' }, '');
    assert.equal(await store.sendMessage(store.rootBranchId, 'missing key'), 'error');
    assert.equal(requests.length, 5, 'missing bound key never falls back to a different connection');
    assert.ok(Object.values(useChatStore.getState().messages).some(m => /连接密钥/.test(m.error || '')));
  } finally { global.fetch = priorFetch; }
});

test('real canvas actions persist dragged positions per conversation and restore names and layouts', async () => {
  useChatStore.getState().resetToMock();
  useChatStore.getState().setViewMode('canvas');
  let store = useChatStore.getState();
  const firstId = store.activeConversationId;
  const root = store.rootBranchId;
  assert.equal(store.canvas.nodes.length, 4);
  const child = store.canvas.nodes.find(node => node.id !== root).id;
  store.updateCanvasNodes([{ id: child, type: 'select', selected: true }]);
  assert.equal(useChatStore.getState().ui.activeBranchPanelId, child);
  store.updateCanvasNodes([{ id: root, type: 'position', position: { x: 140, y: 260 }, dragging: false }]);
  store = useChatStore.getState();
  assert.deepEqual(store.branchPositions[firstId][root], { x: 140, y: 260 });
  store.renameBranch(root, '重命名后的主线');
  assert.equal(useChatStore.getState().branches[root].label, '重命名后的主线');
  assert.equal(useChatStore.getState().canvas.nodes.find(node => node.id === root).data.title, '重命名后的主线');
  assert.deepEqual(useChatStore.getState().canvas.nodes.find(node => node.id === root).position, { x: 140, y: 260 });
  store.updateCanvasNodes([{ id: root, type: 'position', position: { x: NaN, y: 0 } }, { id: root, type: 'remove' }]);
  assert.deepEqual(useChatStore.getState().branchPositions[firstId][root], { x: 140, y: 260 });
  assert.equal(useChatStore.getState().canvas.nodes.length, 4);

  useChatStore.getState().resetToMock();
  useChatStore.getState().setViewMode('canvas');
  store = useChatStore.getState();
  assert.notEqual(store.activeConversationId, firstId);
  assert.notDeepEqual(store.branchPositions[store.activeConversationId][root], { x: 140, y: 260 });
  store.switchConversation(firstId);
  useChatStore.getState().setViewMode('canvas');
  assert.deepEqual(useChatStore.getState().canvas.nodes.find(node => node.id === root).position, { x: 140, y: 260 });

  const saved = JSON.parse(JSON.stringify(useChatStore.persist.getOptions().partialize(useChatStore.getState())));
  useChatStore.persist.setOptions({ storage: { getItem: () => ({ state: saved, version: 1 }), setItem: () => {}, removeItem: () => {} } });
  useChatStore.setState({ branchPositions: {} });
  await useChatStore.persist.rehydrate();
  useChatStore.getState().setViewMode('canvas');
  assert.deepEqual(useChatStore.getState().canvas.nodes.find(node => node.id === root).position, { x: 140, y: 260 });
  assert.equal(useChatStore.getState().branches[root].label, '重命名后的主线');
});

test('onboarding content has complete, explicitly marked examples and exact nested citations', () => {
  useChatStore.getState().resetToMock();
  const state = useChatStore.getState();
  assert.equal(Object.keys(state.messages).length, 10);
  assert.equal(Object.keys(state.branches).length, 4);
  assert.ok(Object.values(state.messages).every(message => message.example && !/此处省略/.test(message.content)));
  assert.ok(Object.values(state.blackboard).every(entry => entry.example));
  for (const anchor of Object.values(state.anchors)) {
    const source = state.messages[anchor.messageId];
    assert.ok(source);
    assert.equal(source.content.slice(anchor.slice.startOffset, anchor.slice.endOffset), anchor.slice.selectedText);
    const branch = state.branches[anchor.branchId];
    assert.equal(branch.sourceMessageId, source.id);
    const question = state.messages[branch.messageIds[0]];
    assert.equal(question.quote.raw, anchor.slice.selectedText);
    assert.equal(question.quote.sourceMessageId, source.id);
  }
});
