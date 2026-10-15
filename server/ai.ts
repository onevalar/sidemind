import type { AIConnection } from './ai-settings'
export class AIRequestError extends Error {}

export type AITool = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export type AICall = { id: string; type: 'function'; function: { name: string; arguments: string } }
export type AIMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: AICall[]; tool_call_id?: string; responseOutput?: unknown[] }
export type AITurn = { text: string; calls: AICall[]; responseOutput?: unknown[] }

export async function chat(connection: AIConnection | null, messages: AIMessage[], tools: AITool[], signal: AbortSignal, transport: typeof fetch = fetch, onDelta?: (text: string) => void): Promise<AITurn> {
  if (!connection) throw new AIRequestError('尚未连接模型服务，请先在设置中添加连接。')
  const response = await transport(connection.baseUrl.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(300000)]),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${connection.key}` },
    body: JSON.stringify({ model: connection.model, stream: true, messages: messages.map(({ responseOutput: _, ...message }) => message), ...(tools.length ? { tools } : {}) }),
  })
  if (!response.ok) throw new AIRequestError(`模型服务返回 ${response.status}。请检查连接，以及所选模型是否支持工具调用。`)
  // Servers that ignore `stream` answer with one JSON body; both shapes are accepted.
  const streamed = (response.headers.get('content-type') ?? '').includes('text/event-stream')
  const { text, calls, finish } = streamed ? await readStream(response, signal, onDelta) : readJSON(await response.json())
  if (finish === 'length') throw new AIRequestError('回复被截断，未执行本轮不完整的操作。请缩小范围后重试。')
  if (!Array.isArray(calls) || calls.length > 16 || calls.some(call => !call || typeof call.id !== 'string' || call.type !== 'function' || typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string') || (!text.trim() && !calls.length)) throw new AIRequestError('模型未返回有效回复。')
  return { text, calls }
}

function readJSON(data: { choices?: { message?: { content?: unknown; tool_calls?: AICall[] }; finish_reason?: string }[] }) {
  const choice = data.choices?.[0], message = choice?.message
  return { text: typeof message?.content === 'string' ? message.content : '', calls: message?.tool_calls ?? [], finish: choice?.finish_reason }
}

async function readStream(response: Response, signal: AbortSignal, onDelta?: (text: string) => void) {
  if (!response.body) throw new AIRequestError('模型未返回有效回复。')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = '', text = '', finish: string | undefined, size = 0, ended = false
  const calls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] = []
  const line = (raw: string) => {
    if (!raw.startsWith('data:')) return
    const data = raw.slice(5).trim()
    if (data === '[DONE]') { ended = true; return }
    let chunk: { choices?: { delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[] }
    try { chunk = JSON.parse(data) } catch { throw new AIRequestError('模型响应格式无效。') }
    const choice = chunk.choices?.[0]
    if (!choice) return
    if (typeof choice.delta?.content === 'string' && choice.delta.content) { text += choice.delta.content; onDelta?.(choice.delta.content) }
    for (const part of choice.delta?.tool_calls ?? []) {
      const call = calls[part.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } }
      if (part.id) call.id = part.id
      if (part.function?.name) call.function.name += part.function.name
      if (part.function?.arguments) call.function.arguments += part.function.arguments
    }
    if (choice.finish_reason) finish = choice.finish_reason
  }
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) { buffer += decoder.decode(); break }
      size += value.byteLength
      if (size > 32 * 1024 * 1024) throw new AIRequestError('模型回复过长。')
      buffer += decoder.decode(value, { stream: true })
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) { line(buffer.slice(0, at).replace(/\r$/, '')); buffer = buffer.slice(at + 1) }
    }
    if (buffer) line(buffer)
  } finally { void reader.cancel().catch(() => {}) }
  if (!ended && !finish) throw new AIRequestError('模型响应中断，未执行本轮操作。')
  return { text, calls: calls.filter(Boolean), finish }
}

/** OpenAI-compatible embeddings. Returns one vector per input, in order. */
export async function embed(connection: AIConnection, inputs: string[], signal: AbortSignal, transport: typeof fetch = fetch): Promise<number[][]> {
  const response = await transport(connection.baseUrl.replace(/\/$/, '') + '/embeddings', {
    method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${connection.key}` },
    body: JSON.stringify({ model: connection.model, input: inputs }),
  })
  if (!response.ok) throw new AIRequestError(`Embedding 服务返回 ${response.status}，请检查地址、模型和密钥。`)
  const data = await response.json() as { data?: { index?: number; embedding?: unknown }[] }
  const rows = [...(data.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  if (rows.length !== inputs.length || rows.some(row => !Array.isArray(row.embedding) || !row.embedding.length || row.embedding.some(value => typeof value !== 'number'))) throw new AIRequestError('Embedding 服务返回的数据无效。')
  return rows.map(row => row.embedding as number[])
}

export async function proposeEdit(connection: AIConnection | null, source: string, instruction: string, signal?: AbortSignal, transport: typeof fetch = fetch): Promise<string> {
  if (!connection) throw new AIRequestError('尚未连接模型服务，请先在设置中添加连接。')
  const { key, model, baseUrl } = connection
  const url = new URL(baseUrl.replace(/\/$/, '') + '/chat/completions')
  if (!['http:', 'https:'].includes(url.protocol)) throw new AIRequestError('AI 服务地址需要使用 HTTP 或 HTTPS。')
  const response = await transport(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(120000), ...(signal ? [signal] : [])]),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, stream: false, messages: [
      { role: 'system', content: 'Rewrite the supplied Markdown according to the instruction. Return ONLY the replacement Markdown, without an explanation or an outer code fence. Never modify content outside the supplied source.' },
      { role: 'user', content: JSON.stringify({ instruction, source }) },
    ] }),
  })
  if (!response.ok) throw new AIRequestError(`模型服务返回 ${response.status}，请检查连接及模型配置。`)
  const data = await response.json() as { choices?: { message?: { content?: string }; finish_reason?: string }[] }
  if (data.choices?.[0]?.finish_reason === 'length') throw new AIRequestError('修改结果被截断，请选择更短的段落重试。')
  const content = data.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) throw new AIRequestError('模型未返回有效修改内容。')
  return content
}
