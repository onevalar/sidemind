import Anthropic from '@anthropic-ai/sdk';

type Provider = 'anthropic' | 'zhipu' | 'openai';
type ChatMessage = { role: 'user' | 'assistant'; content: string };

// Default base URLs per provider
const DEFAULT_BASE_URLS: Record<Provider, string> = {
  anthropic: 'https://api.anthropic.com',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  openai: 'https://api.openai.com/v1',
};

// Default models per provider
const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  zhipu: 'glm-4-flash',
  openai: 'gpt-4o-mini',
};

const BASE_SYSTEM_PROMPT =
  'You are a helpful assistant. Respond in the same language the user uses. Format your response with Markdown when it helps clarity.';

const MAX_TOKENS = 4096;
const MAX_CONTEXT_CHARS = 30000;

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
};

function isProvider(v: string): v is Provider {
  return v in DEFAULT_BASE_URLS;
}

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

/** Private / loopback / link-local hosts (the server must not be a proxy into them) */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h.includes(':')) {
    // IPv6: loopback, unspecified, unique-local (fc00::/7), link-local (fe80::/10)
    return h === '::1' || h === '::' || /^f[cd]/.test(h) || h.startsWith('fe80');
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** Returns an error message when the custom base URL is not acceptable */
function checkBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '自定义 Base URL 格式不正确';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return '自定义 Base URL 只支持 http(s)';
  }
  // In production the server could be reached by other people: don't let a
  // custom URL point it at internal addresses (set ALLOW_PRIVATE_BASE_URL=1
  // to allow e.g. a local Ollama).
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.ALLOW_PRIVATE_BASE_URL !== '1' &&
    isPrivateHost(url.hostname)
  ) {
    return '线上环境不允许使用内网或本机地址作为 Base URL';
  }
  return null;
}

export async function POST(req: Request) {
  const apiKey = req.headers.get('x-api-key');
  const providerHeader = req.headers.get('x-provider') ?? 'anthropic';
  const customBaseUrl = req.headers.get('x-base-url');

  if (!apiKey) return jsonError('Missing API key', 401);
  if (!isProvider(providerHeader)) {
    return jsonError(`Unknown provider: ${providerHeader}`, 400);
  }
  const provider: Provider = providerHeader;

  if (customBaseUrl) {
    const problem = checkBaseUrl(customBaseUrl);
    if (problem) return jsonError(problem, 400);
  }
  const baseUrl = customBaseUrl || DEFAULT_BASE_URLS[provider];

  let body: { messages?: unknown; context?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const messages = body.messages as ChatMessage[] | undefined;
  if (
    !Array.isArray(messages) ||
    messages.length === 0 ||
    !messages.every(
      (m) =>
        m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string',
    )
  ) {
    return jsonError('messages must be a non-empty array of {role, content}', 400);
  }

  // Background the branch needs (source conversation, blackboard summaries)
  const context =
    typeof body.context === 'string' ? body.context.slice(0, MAX_CONTEXT_CHARS) : '';
  const systemPrompt = context
    ? `${BASE_SYSTEM_PROMPT}\n\n## 背景信息\n${context}`
    : BASE_SYSTEM_PROMPT;

  const encoder = new TextEncoder();

  // ── Anthropic native SDK path ────────────────────────────────────────────
  if (provider === 'anthropic') {
    const client = new Anthropic({ apiKey, baseURL: baseUrl });

    const stream = new ReadableStream({
      async start(controller) {
        try {
          const anthropicStream = client.messages.stream(
            {
              model: DEFAULT_MODELS.anthropic,
              max_tokens: MAX_TOKENS,
              system: systemPrompt,
              messages,
            },
            { signal: req.signal },
          );

          for await (const event of anthropicStream) {
            if (
              event.type === 'content_block_delta' &&
              event.delta.type === 'text_delta'
            ) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ text: event.delta.text })}\n\n`,
                ),
              );
            }
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch (err) {
          if (req.signal.aborted) {
            controller.close();
            return;
          }
          const msg = err instanceof Error ? err.message : 'Unknown error';
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`),
          );
          controller.close();
        }
      },
    });

    return new Response(stream, { headers: SSE_HEADERS });
  }

  // ── OpenAI-compatible path (ZhipuAI, OpenAI, etc.) ──────────────────────
  const chatUrl = baseUrl.endsWith('/chat/completions')
    ? baseUrl
    : `${baseUrl.replace(/\/$/, '')}/chat/completions`;

  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(chatUrl, {
      method: 'POST',
      signal: req.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DEFAULT_MODELS[provider],
        stream: true,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Network error';
    return jsonError(`无法连接到模型服务：${msg}`, 502);
  }

  if (!upstreamResp.ok || !upstreamResp.body) {
    const text = await upstreamResp.text().catch(() => '');
    return jsonError(
      `Upstream error ${upstreamResp.status}: ${text}`,
      upstreamResp.status || 502,
    );
  }

  // Forward the OpenAI SSE stream, translating to our internal format
  const upstreamReader = upstreamResp.body.getReader();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async start(controller) {
      const handleLine = (line: string): boolean => {
        if (!line.startsWith('data: ')) return false;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') return true;
        try {
          const chunk = JSON.parse(raw);
          const text: string = chunk?.choices?.[0]?.delta?.content ?? '';
          if (text) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ text })}\n\n`),
            );
          }
        } catch {
          // skip malformed chunks
        }
        return false;
      };

      try {
        let buffer = '';
        let finished = false;
        while (!finished) {
          const { done, value } = await upstreamReader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (handleLine(line)) {
              finished = true;
              break;
            }
          }
        }
        if (!finished && buffer) handleLine(buffer);

        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (err) {
        if (req.signal.aborted) {
          controller.close();
          return;
        }
        const msg = err instanceof Error ? err.message : 'Stream error';
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`),
        );
        controller.close();
      }
    },
    cancel() {
      upstreamReader.cancel().catch(() => {});
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
