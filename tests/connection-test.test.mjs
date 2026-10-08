import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionTest } from '../src/connection-test.ts';
const config = { provider: 'openai', model: 'fixture-model', baseUrl: 'https://fixture.example/v1' };
const complete = () => new Response('data: {"text":"OK"}\n\ndata: [DONE]\n\n');
test('the default browser fetch keeps its native invocation context', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async function () {
    assert.equal(this, undefined);
    return complete();
  };
  try {
    assert.equal((await new ConnectionTest().run(config, 'fixture-key')).kind, 'success');
  } finally { globalThis.fetch = original; }
});
test('connection tests send only the minimal query with the selected endpoint and key', async () => {
  const tester = new ConnectionTest(async (url, request) => {
    assert.equal(url, '/api/chat');
    assert.deepEqual(JSON.parse(request.body), { messages: [{ role: 'user', content: 'Reply with OK only.' }] });
    assert.equal(request.headers['x-base-url'], config.baseUrl);
    assert.equal(request.headers['x-model'], config.model);
    assert.equal(request.headers['x-api-key'], 'fixture-key');
    return complete();
  });
  assert.equal((await tester.run(config, ' fixture-key ')).kind, 'success');
});
test('old responses cannot mark a changed or closed connection as successful', async () => {
  let resolveOld;
  let oldSignal;
  let count = 0;
  const tester = new ConnectionTest(async (_url, request) => {
    if (++count === 1) { oldSignal = request.signal; return new Promise(resolve => { resolveOld = resolve; }); }
    return complete();
  });
  const old = tester.run(config, 'old-key');
  assert.equal((await tester.run({ ...config, baseUrl: 'https://new.example/v1' }, 'new-key')).kind, 'success');
  assert.equal(oldSignal.aborted, true);
  resolveOld(complete());
  assert.equal(await old, null);
});
test('stopping a test cancels a stalled body and never publishes a late result', async () => {
  let cancelled = false;
  const tester = new ConnectionTest(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  const pending = tester.run(config, 'fixture-key');
  await new Promise(resolve => setImmediate(resolve));
  tester.cancel();
  assert.equal(await pending, null);
  assert.equal(cancelled, true);
});
test('timeout covers the body after headers and remains distinct from user cancellation', async () => {
  let cancelled = false;
  const tester = new ConnectionTest(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })), 20);
  const result = await tester.run(config, 'fixture-key');
  assert.equal(result.kind, 'error');
  assert.match(result.message, /超时/);
  assert.equal(cancelled, true);
});
test('completion must be a real event followed by a nonempty answer', async () => {
  for (const body of ['data: {"text":"partial"}\n\n', 'data: [DONE]\n\n', 'data: {"text":"data: [DONE]"}\n\n', 'data: {"error":"fixture failure"}\n\n', 'data: malformed\n\n']) {
    const result = await new ConnectionTest(async () => new Response(body)).run(config, 'fixture-key');
    assert.equal(result.kind, 'error');
  }
});
test('oversized replies are cancelled and upstream HTML errors are not shown', async () => {
  let cancelled = false;
  const oversized = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65537)); }, cancel() { cancelled = true; } }));
  const result = await new ConnectionTest(async () => oversized).run(config, 'fixture-key');
  assert.match(result.message, /过长/);
  assert.equal(cancelled, true);
  const failed = await new ConnectionTest(async () => new Response('<html>internal upstream details</html>', { status: 502 })).run(config, 'fixture-key');
  assert.equal(failed.kind, 'error');
  assert.equal(failed.message, '连接失败（HTTP 502）。');
});
