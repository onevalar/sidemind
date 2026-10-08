import type { AIConnection } from './ai-settings'
export class AIRequestError extends Error {}

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
