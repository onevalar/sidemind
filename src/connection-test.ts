import type { ModelConnection } from './types';

export type ConnectionTestResult = { kind: 'success' | 'error' | 'stopped'; message: string };

async function readBounded(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) throw new Error('服务未返回完整回复。');
  const reader = response.body.getReader();
  const stop = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', stop, { once: true });
  const decoder = new TextDecoder();
  let text = '', bytes = 0;
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 64 * 1024) throw new Error('测试回复过长，请检查服务地址和模型。');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    signal.removeEventListener('abort', stop);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function checkReply(body: string) {
  let complete = false, answer = '';
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (raw === '[DONE]') { complete = true; break; }
    let event;
    try { event = JSON.parse(raw); } catch { throw new Error('服务返回了无法识别的回复。'); }
    if (event && typeof event.error === 'string') throw new Error(event.error);
    if (event && typeof event.text === 'string') answer += event.text;
  }
  if (!complete || !answer.trim()) throw new Error('服务未返回完整回复。');
}

/** One test at a time. Invalidated or closed forms can never receive an old result. */
export class ConnectionTest {
  private controller: AbortController | null = null;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  constructor(fetcher: typeof fetch = (input, init) => fetch(input, init), timeoutMs = 45000) {
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
  }
  cancel() {
    const pending = this.controller;
    this.controller = null;
    pending?.abort();
  }
  async run(config: ModelConnection, key: string): Promise<ConnectionTestResult | null> {
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(new DOMException('Connection test timed out', 'TimeoutError')), this.timeoutMs);
    try {
      const response = await this.fetcher('/api/chat', {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'x-api-key': key.trim(), 'x-provider': config.provider,
          ...(config.baseUrl.trim() ? { 'x-base-url': config.baseUrl.trim() } : {}),
          ...(config.model.trim() ? { 'x-model': config.model.trim() } : {}) },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Reply with OK only.' }] }),
      });
      const body = await readBounded(response, controller.signal);
      if (!response.ok) {
        let message = `连接失败（HTTP ${response.status}）。`;
        try { const error = JSON.parse(body); if (typeof error?.error === 'string') message = error.error; } catch { /* Do not show arbitrary HTML error pages. */ }
        throw new Error(message);
      }
      checkReply(body);
      if (this.controller !== controller) return null;
      return { kind: 'success', message: '连接成功，模型已返回回复。测试不会保存设置。' };
    } catch (error) {
      if (this.controller !== controller) return null;
      return { kind: 'error', message: controller.signal.reason?.name === 'TimeoutError'
        ? '连接测试超时，请稍后重试。' : error instanceof Error ? error.message : '连接失败，请检查设置。' };
    } finally {
      clearTimeout(timer);
      if (this.controller === controller) this.controller = null;
    }
  }
}
