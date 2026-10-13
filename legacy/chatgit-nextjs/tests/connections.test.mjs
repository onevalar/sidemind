import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionKey, conversationConnection, conversationCredential, restoreModelState } from '../src/connections.ts';

const original = { provider: 'openai', model: 'original-model', baseUrl: 'https://first.example/v1' };
test('legacy history retains its last saved connection and keeps keys outside history', () => {
  const restored = restoreModelState({ ...original, apiKey: 'legacy-key', activeConversationId: 'one', messages: { a: {} }, conversations: { old: {} } }, original);
  assert.deepEqual(restored.conversationModels.one, original);
  assert.deepEqual(restored.conversationModels.old, original);
  assert.equal(restored.connectionCredentials[connectionKey(original)], 'legacy-key');
  assert.equal(JSON.stringify(restored.conversationModels).includes('legacy-key'), false);
});
test('changing default model or provider cannot replace an existing conversation connection', () => {
  const state = { activeConversationId: 'one', conversationModels: { one: original }, provider: 'anthropic', model: 'new-model', baseUrl: '' };
  assert.deepEqual(conversationConnection(state), original);
  assert.equal(conversationConnection({ ...state, activeConversationId: 'new' }).provider, 'anthropic');
});
test('credentials are isolated by provider and endpoint while model changes reuse the same connection', () => {
  const state = { connectionCredentials: { [connectionKey(original)]: 'first-key' } };
  assert.equal(conversationCredential(state, { ...original, model: 'other', baseUrl: 'https://FIRST.example/v1/' }), 'first-key');
  assert.equal(conversationCredential(state, { ...original, baseUrl: 'https://second.example/v1' }), '');
  assert.equal(conversationCredential(state, { ...original, provider: 'zhipu' }), '');
});
test('an intentionally cleared key is not resurrected from legacy default fields', () => {
  const restored = restoreModelState({ apiKey: 'stale-key', connectionCredentials: { [connectionKey(original)]: '' }, conversationModels: { one: original } }, original);
  assert.equal(conversationCredential(restored, original), '');
  assert.deepEqual(restoreModelState(restored, original).conversationModels.one, original);
});
