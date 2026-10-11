import type { AIConnection } from './ai-settings'
export class AIRequestError extends Error {}

export type AITool = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export type AICall = { id: string; type: 'function'; function: { name: string; arguments: string } }
export type AIMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: AICall[]; tool_call_id?: string; responseOutput?: unknown[] }
export type AITurn = { text: string; calls: AICall[]; responseOutput?: unknown[] }

export async function chat(connection: AIConnection | null, messages: AIMessage[], tools: AITool[], signal: AbortSignal, transport: typeof fetch = fetch): Promise<AITurn> {
  if (!connection) throw new AIRequestError('尚未连接模型服务，请先在设置中添加连接。')
  const response = await transport(connection.baseUrl.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${connection.key}` },
    body: JSON.stringify({ model: connection.model, stream: false, messages: messages.map(({ responseOutput: _, ...message }) => message), ...(tools.length ? { tools } : {}) }),
  })
  if (!response.ok) throw new AIRequestError(`模型服务返回 ${response.status}。请检查连接，以及所选模型是否支持工具调用。`)
  const data = await response.json() as { choices?: { message?: { content?: unknown; tool_calls?: AICall[] }; finish_reason?: string }[] }
  const choice = data.choices?.[0], message = choice?.message
  if (choice?.finish_reason === 'length') throw new AIRequestError('回复被截断，未执行本轮不完整的操作。请缩小范围后重试。')
  const text = typeof message?.content === 'string' ? message.content : ''
  const calls = message?.tool_calls ?? []
  if (!Array.isArray(calls) || calls.length > 16 || calls.some(call => !call || typeof call.id !== 'string' || call.type !== 'function' || typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string') || (!text.trim() && !calls.length)) throw new AIRequestError('模型未返回有效回复。')
  return { text, calls }
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
