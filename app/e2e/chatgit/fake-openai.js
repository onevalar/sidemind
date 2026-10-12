/**
 * OpenAI-compatible fixture for the ChatGit canvas checks. Calls no external model.
 *
 * - Streams a deterministic Markdown answer that echoes the question and contains fixed
 *   terms (潜空间, JEPA, 自回归) so a browser test can select them.
 * - Answers the summary/suggestion request (system prompt asks for JSON) with JSON.
 * - Records every request: GET /__requests returns them, POST /__reset clears them,
 *   POST /__behavior {"delayMs": n, "fail": true} changes how answers behave.
 *
 *   CANVAS_FIXTURE_PORT=8890 node app/e2e/chatgit/fake-openai.js
 */
const http = require('http');

const PORT = Number(process.env.CANVAS_FIXTURE_PORT) || 8890;
const requests = [];
let behavior = { delayMs: 25, fail: false };

const read = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });

const text = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((p) => p?.text ?? '').join('')
      : '';

function answerFor(messages) {
  const last = text(messages.filter((m) => m.role === 'user').pop()?.content).replace(/\s+/g, ' ').slice(0, 80);
  return [
    `你问的是：${last}`,
    '',
    '### 要点',
    '',
    '- 世界模型在**潜空间**里预测未来，而不是逐像素生成。',
    '- JEPA 预测的是表示；自回归模型逐个预测下一个元素。',
    '',
    `这是第 ${messages.length} 条消息之后的回答。`,
  ].join('\n');
}

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (req.method === 'GET' && url.pathname === '/__requests') return json(res, 200, requests);
    if (req.method === 'POST' && url.pathname === '/__reset') {
      requests.length = 0;
      behavior = { delayMs: 25, fail: false };
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/__behavior') {
      behavior = { ...behavior, ...(await read(req)) };
      return json(res, 200, behavior);
    }
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      return json(res, 200, { object: 'list', data: [{ id: 'chatgit-fixture', object: 'model' }] });
    }
    if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) return json(res, 404, { error: 'not found' });

    const body = await read(req);
    const messages = body.messages ?? [];
    requests.push({ at: Date.now(), model: body.model, stream: !!body.stream, messages });
    const wantsJson = messages.some((m) => m.role === 'system' && /Return only JSON/.test(text(m.content)));
    if (behavior.fail && !wantsJson) return json(res, 500, { error: { message: 'fixture failure' } });

    const content = wantsJson
      ? JSON.stringify({ summary: '摘要：' + text(messages[1]?.content).slice(9, 40), suggestions: ['能举个例子吗？', '和前面有什么联系？', '有哪些常见误解？'] })
      : answerFor(messages);
    if (!body.stream) {
      return json(res, 200, {
        id: 'cmpl-fixture', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    let closed = false;
    req.on('close', () => (closed = true));
    const chunk = (delta, finish = null) =>
      `data: ${JSON.stringify({ id: 'cmpl-fixture', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.write(chunk({ role: 'assistant', content: '' }));
    for (const piece of content.match(/[\s\S]{1,6}/g) ?? []) {
      if (closed) return;
      res.write(chunk({ content: piece }));
      await new Promise((r) => setTimeout(r, behavior.delayMs));
    }
    res.write(chunk({}, 'stop'));
    res.end('data: [DONE]\n\n');
  })
  .listen(PORT, '127.0.0.1', () => console.log(`[canvas-fixture] listening on http://127.0.0.1:${PORT}/v1`));
