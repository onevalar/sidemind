import Anthropic from '@anthropic-ai/sdk';

type Provider = 'anthropic' | 'zhipu' | 'openai';

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

export async function POST(req: Request) {
  const apiKey = req.headers.get('x-api-key');
  const provider = (req.headers.get('x-provider') ?? 'anthropic') as Provider;
  const baseUrl = req.headers.get('x-base-url') || DEFAULT_BASE_URLS[provider];

  if (!apiKey) {
    return Response.json({ error: 'Missing API key' }, { status: 401 });
  }

  const { messages } = (await req.json()) as {
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  };

  const encoder = new TextEncoder();

  // ── Anthropic native SDK path ────────────────────────────────────────────
  if (provider === 'anthropic') {
    const client = new Anthropic({ apiKey, baseURL: baseUrl });

    const stream = new ReadableStream({
      async start(controller) {
        try {
          const anthropicStream = client.messages.stream({
            model: DEFAULT_MODELS.anthropic,
            max_tokens: 2048,
            system:
              'You are a helpful assistant. Respond in the same language the user uses. Format your response with Markdown when it helps clarity.',
            messages,
          });

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
          const msg = err instanceof Error ? err.message : 'Unknown error';
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`),
          );
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  }

  // ── OpenAI-compatible path (ZhipuAI, OpenAI, etc.) ──────────────────────
  const chatUrl = baseUrl.endsWith('/chat/completions')
    ? baseUrl
    : `${baseUrl.replace(/\/$/, '')}/chat/completions`;

  const upstreamResp = await fetch(chatUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DEFAULT_MODELS[provider] ?? DEFAULT_MODELS.openai,
      stream: true,
      messages: [
        {
          role: 'system',
          content:
            'You are a helpful assistant. Respond in the same language the user uses. Format your response with Markdown when it helps clarity.',
        },
        ...messages,
      ],
    }),
  });

  if (!upstreamResp.ok || !upstreamResp.body) {
    const body = await upstreamResp.text().catch(() => '');
    return Response.json(
      { error: `Upstream error ${upstreamResp.status}: ${body}` },
      { status: upstreamResp.status },
    );
  }

  // Forward the OpenAI SSE stream, translating to our internal format
  const upstreamReader = upstreamResp.body.getReader();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        let buffer = '';
        while (true) {
          const { done, value } = await upstreamReader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6).trim();
            if (raw === '[DONE]') {
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
              return;
            }
            try {
              const chunk = JSON.parse(raw);
              const text: string =
                chunk?.choices?.[0]?.delta?.content ?? '';
              if (text) {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ text })}\n\n`,
                  ),
                );
              }
            } catch {
              // skip malformed chunks
            }
          }
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Stream error';
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`),
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
