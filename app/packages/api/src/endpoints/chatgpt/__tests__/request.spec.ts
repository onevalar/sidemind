import { createChatGPTFetch, sanitizeResponsesBody } from '../request';
import { ChatGPTError } from '../errors';

const RESPONSES_URL = 'https://api.openai.com/v1/responses';

function sse(events: Array<Record<string, unknown>>, terminator = true): string {
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return terminator ? body : body.slice(0, -2);
}

function streamResponse(text: string, init: ResponseInit = {}): Response {
  const encoded = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      /** Split mid-event to exercise buffering across chunks. */
      const mid = Math.floor(encoded.length / 2);
      controller.enqueue(encoded.slice(0, mid));
      controller.enqueue(encoded.slice(mid));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_123' },
    ...init,
  });
}

const context = [
  { role: 'system', content: 'You are ChatGit.' },
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Branch A root' }] },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Answer A' }] },
  { type: 'message', role: 'system', content: 'Canvas context: node 3 of 5' },
  { type: 'message', role: 'user', content: 'Follow-up on node 3' },
];

function requestBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: 'gpt-test',
    input: context,
    instructions: 'Be concise.',
    reasoning: { effort: 'medium' },
    stream: true,
    store: true,
    temperature: 0.2,
    top_p: 0.9,
    max_output_tokens: 1024,
    user: 'user-1',
    metadata: { a: '1' },
    previous_response_id: 'resp_old',
    truncation: 'auto',
    safety_identifier: 'x',
    prompt_cache_retention: '24h',
    ...overrides,
  });
}

describe('sanitizeResponsesBody', () => {
  it('forces store/stream, drops unsupported fields and keeps context order and content', () => {
    const body = sanitizeResponsesBody(JSON.parse(requestBody()));

    expect(body).toEqual({
      model: 'gpt-test',
      instructions: 'Be concise.',
      reasoning: { effort: 'medium' },
      store: false,
      stream: true,
      input: [
        { role: 'developer', content: 'You are ChatGit.' },
        context[1],
        context[2],
        { type: 'message', role: 'developer', content: 'Canvas context: node 3 of 5' },
        context[4],
      ],
    });
    /** Same items, same order: only explicit system roles change. */
    const input = body.input as Array<Record<string, unknown>>;
    expect(input.map(({ role: _role, ...rest }) => rest)).toEqual(
      context.map(({ role: _role, ...rest }) => rest),
    );
  });

  it('wraps string input in an input array', () => {
    expect(sanitizeResponsesBody({ model: 'm', input: 'hi' }).input).toEqual([
      { role: 'user', content: 'hi' },
    ]);
  });
});

describe('createChatGPTFetch', () => {
  function setup(response: () => Response | Promise<Response>) {
    const upstream = jest.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      response(),
    );
    const reportError = jest.fn();
    const getAccessToken = jest.fn(async () => 'oauth-access');
    const chatgptFetch = createChatGPTFetch({ getAccessToken, reportError, fetch: upstream });
    return { upstream, reportError, getAccessToken, chatgptFetch };
  }

  it('sends the sanitized body with the OAuth bearer and strips billing headers', async () => {
    const { upstream, chatgptFetch } = setup(() =>
      streamResponse(sse([{ type: 'response.completed', response: { id: 'r', output: [] } }])),
    );
    await chatgptFetch(RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer chatgpt-oauth-managed',
        'OpenAI-Organization': 'org_api_billing',
        'OpenAI-Project': 'proj_x',
      },
      body: requestBody(),
    });

    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe(RESPONSES_URL);
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer oauth-access');
    expect(headers.has('openai-organization')).toBe(false);
    expect(headers.has('openai-project')).toBe(false);
    const sent = JSON.parse(String(init?.body));
    expect(sent).toMatchObject({ store: false, stream: true });
    for (const field of [
      'temperature',
      'top_p',
      'max_output_tokens',
      'user',
      'previous_response_id',
    ]) {
      expect(sent).not.toHaveProperty(field);
    }
    expect(sent.input).toHaveLength(context.length);
  });

  it.each([
    ['chat completions', 'https://api.openai.com/v1/chat/completions', 'POST'],
    ['another host', 'https://chatgpt.com/backend-api/conversation', 'POST'],
    ['GET responses', RESPONSES_URL, 'GET'],
  ])('refuses %s without any network call', async (_label, url, method) => {
    const { upstream, getAccessToken, chatgptFetch } = setup(() => new Response('{}'));
    const res = await chatgptFetch(url, { method, body: method === 'POST' ? '{}' : undefined });
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('turns a mid-stream usage-limit failure into an SDK-visible sanitized error', async () => {
    const { reportError, chatgptFetch } = setup(() =>
      streamResponse(
        sse([
          { type: 'response.output_text.delta', delta: 'Hel' },
          {
            type: 'response.failed',
            response: {
              error: {
                code: 'subscription_sharing_usage_limit_exceeded',
                message: 'upstream detail that must not leak',
              },
            },
          },
        ]),
      ),
    );
    const res = await chatgptFetch(RESPONSES_URL, { method: 'POST', body: requestBody() });
    const text = await res.text();

    expect(text).toContain('response.output_text.delta');
    expect(text).toContain('event: error');
    expect(text).toContain('subscription_sharing_usage_limit_exceeded');
    expect(text).toContain('chatgpt.com/settings/usage');
    expect(text).not.toContain('upstream detail');
    expect(reportError).toHaveBeenCalledWith({
      status: 200,
      code: 'subscription_sharing_usage_limit_exceeded',
    });
  });

  it('raises when the stream ends without a terminal event', async () => {
    const { chatgptFetch } = setup(() =>
      streamResponse(sse([{ type: 'response.output_text.delta', delta: 'partial' }])),
    );
    const res = await chatgptFetch(RESPONSES_URL, { method: 'POST', body: requestBody() });
    const text = await res.text();
    expect(text.trim().endsWith('}')).toBe(true);
    expect(text).toContain('event: error');
  });

  it.each([true, false])(
    'does not report an incomplete answer as success (stream=%s)',
    async (stream) => {
      const { chatgptFetch } = setup(() =>
        streamResponse(
          sse([
            { type: 'response.output_text.delta', delta: 'partial answer' },
            { type: 'response.incomplete', response: { status: 'incomplete', output: [] } },
          ]),
        ),
      );
      const res = await chatgptFetch(RESPONSES_URL, {
        method: 'POST',
        body: requestBody({ stream }),
      });
      if (stream) {
        expect(await res.text()).toContain('event: error');
      } else {
        expect(res.status).toBe(502);
        expect((await res.json()).error.code).toBe('request_failed');
      }
    },
  );

  it('recognizes completion with CRLF framing split at every byte', async () => {
    const text = sse([
      { type: 'response.output_text.delta', delta: '你好' },
      { type: 'response.completed', response: { status: 'completed', output: [] } },
    ]).replace(/\n/g, '\r\n');
    const { chatgptFetch } = setup(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of new TextEncoder().encode(text)) {
                controller.enqueue(new Uint8Array([byte]));
              }
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const res = await chatgptFetch(RESPONSES_URL, { method: 'POST', body: requestBody() });
    const result = await res.text();
    expect(result).toContain('你好');
    expect(result).toContain('response.completed');
    expect(result).not.toContain('event: error');
  });

  it('serves non-streaming callers from the mandatory stream', async () => {
    const final = { id: 'resp_1', status: 'completed', output: [{ type: 'message' }] };
    const { upstream, chatgptFetch } = setup(() =>
      streamResponse(
        sse([
          { type: 'response.created', response: { id: 'resp_1' } },
          { type: 'response.completed', response: final },
        ]),
      ),
    );
    const res = await chatgptFetch(RESPONSES_URL, {
      method: 'POST',
      body: requestBody({ stream: false }),
    });
    expect(JSON.parse(String(upstream.mock.calls[0][1]?.body)).stream).toBe(true);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(final);
  });

  it('preserves status, code and request id but not upstream text on HTTP errors', async () => {
    const { reportError, chatgptFetch } = setup(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'subscription_sharing_unsupported_capability',
              param: 'tools[0]',
              message: 'secret upstream text',
            },
          }),
          { status: 400, headers: { 'x-request-id': 'req_abc' } },
        ),
    );
    const res = await chatgptFetch(RESPONSES_URL, { method: 'POST', body: requestBody() });
    expect(res.status).toBe(400);
    expect(res.headers.get('x-request-id')).toBe('req_abc');
    const body = await res.json();
    expect(body.error).toMatchObject({
      code: 'subscription_sharing_unsupported_capability',
    });
    expect(body.error.param).toBeUndefined();
    expect(body.error.message).toContain('req_abc');
    expect(JSON.stringify(body)).not.toContain('secret upstream text');
    expect(reportError).toHaveBeenCalledWith({
      status: 400,
      code: 'subscription_sharing_unsupported_capability',
    });
  });

  it('does not disclose arbitrary provider fields as diagnostics', async () => {
    const { chatgptFetch } = setup(
      () =>
        new Response(
          JSON.stringify({ error: { code: 'private content', param: 'private content' } }),
          { status: 400, headers: { 'x-request-id': 'private content' } },
        ),
    );
    const res = await chatgptFetch(RESPONSES_URL, { method: 'POST', body: requestBody() });
    expect(res.status).toBe(400);
    expect(res.headers.get('x-request-id')).toBeNull();
    const body = await res.json();
    expect(body.error.code).toBe('request_failed');
    expect(JSON.stringify(body)).not.toContain('private content');
  });

  it('fails without calling upstream when no plan token is available', async () => {
    const { upstream, chatgptFetch, getAccessToken } = setup(() => new Response('{}'));
    getAccessToken.mockRejectedValueOnce(new ChatGPTError('reauth_required', 401));
    const res = await chatgptFetch(RESPONSES_URL, { method: 'POST', body: requestBody() });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('reauth_required');
    expect(upstream).not.toHaveBeenCalled();
  });
});
