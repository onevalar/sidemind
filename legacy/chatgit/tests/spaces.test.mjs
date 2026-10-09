import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreSpaces, withoutSpace } from '../src/spaces.ts';

test('legacy storage and removed folder assignments restore into the all-conversations view', () => {
  assert.deepEqual(restoreSpaces(undefined, undefined), { spaces: {}, conversationSpaces: {} });
  const restored = restoreSpaces({ research: { id: 'wrong', name: '  阅读与研究 ' }, invalid: { name: 7 } }, { one: 'research', two: 'deleted', three: null });
  assert.deepEqual(restored, { spaces: { research: { id: 'research', name: '阅读与研究' } }, conversationSpaces: { one: 'research' } });
});

test('removing a space releases its conversations without changing other spaces or its input', () => {
  const spaces = { a: { id: 'a', name: '研究' }, b: { id: 'b', name: '灵感' } };
  const locations = { one: 'a', two: 'a', three: 'b' };
  assert.deepEqual(withoutSpace(spaces, locations, 'a'), { spaces: { b: spaces.b }, conversationSpaces: { three: 'b' } });
  assert.equal(locations.one, 'a');
  assert.equal(spaces.a.name, '研究');
});
