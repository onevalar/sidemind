import { AIRequestError, chat, embed, type AIMessage, type AITool, type AITurn } from './ai'
import type { AISettings } from './ai-settings'
import { ChatGPTError, type ChatGPTConnection } from './chatgpt'

export type ModelCall = (messages: AIMessage[], tools: AITool[], signal: AbortSignal, onDelta?: (text: string) => void) => Promise<AITurn>
export type Embedder = { model: string; embed: (inputs: string[], signal: AbortSignal) => Promise<number[][]> }

/** Resolves the three model slots. The summary slot falls back to the main model when not configured. */
export class Models {
  constructor(private main: AISettings, private chatgpt: ChatGPTConnection, private transport?: typeof fetch) {}

  get summarySettings() { return this.main.forSlot('summary') }
  get embeddingSettings() { return this.main.forSlot('embedding') }

  async mainModel(): Promise<{ call: ModelCall; label: string }> {
    const config = await this.chatgpt.publicConfig()
    if (config.unavailable) throw new ChatGPTError(config.error ?? '无法读取 ChatGPT 连接，请检查设置。')
    if (config.activeAccountId) return { call: (messages, tools, signal, onDelta) => this.chatgpt.chat(messages, tools, signal, onDelta), label: 'ChatGPT · ' + config.model }
    const connection = await this.main.connection()
    if (!connection) throw new AIRequestError('尚未连接模型服务，请先在设置中添加连接。')
    return { call: (messages, tools, signal, onDelta) => chat(connection, messages, tools, signal, this.transport, onDelta), label: connection.model }
  }

  async summaryModel(): Promise<{ call: ModelCall; label: string; fallback: boolean }> {
    const connection = await this.summarySettings.connection()
    if (connection) return { call: (messages, tools, signal, onDelta) => chat(connection, messages, tools, signal, this.transport, onDelta), label: connection.model, fallback: false }
    return { ...await this.mainModel(), fallback: true }
  }

  async embedder(): Promise<Embedder | null> {
    const connection = await this.embeddingSettings.connection().catch(() => null)
    if (!connection) return null
    return { model: connection.baseUrl + '#' + connection.model, embed: (inputs, signal) => embed(connection, inputs, signal, this.transport) }
  }
}

/** One-shot text completion on a model call. */
export async function complete(call: ModelCall, system: string, user: string, signal: AbortSignal): Promise<string> {
  const turn = await call([{ role: 'system', content: system }, { role: 'user', content: user }], [], signal)
  return turn.text
}

/** Extracts the first JSON object from a model reply, tolerating code fences and surrounding prose. */
export function parseJSONReply<T>(text: string): T {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1]
  const source = fenced ?? text
  const start = source.indexOf('{'), end = source.lastIndexOf('}')
  if (start < 0 || end <= start) throw new AIRequestError('模型没有返回有效的 JSON。')
  try { return JSON.parse(source.slice(start, end + 1)) as T }
  catch { throw new AIRequestError('模型没有返回有效的 JSON。') }
}
