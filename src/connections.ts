import type { ChatState, ModelConnection, Provider } from './types';

export const connectionDefaults: Record<Provider, { name: string; model: string; url: string }> = {
  zhipu: { name: '智谱 AI', model: 'glm-4-flash', url: 'https://open.bigmodel.cn/api/paas/v4' },
  anthropic: { name: 'Anthropic', model: 'claude-haiku-4-5-20251001', url: 'https://api.anthropic.com' },
  openai: { name: 'OpenAI', model: 'gpt-4o-mini', url: 'https://api.openai.com/v1' },
};

export function modelConnection(config: ModelConnection): ModelConnection {
  const defaults = connectionDefaults[config.provider];
  return { provider: config.provider, model: config.model.trim() || defaults.model,
    baseUrl: config.baseUrl.trim() || defaults.url };
}

/** Credentials belong to a provider AND endpoint, never just a model name. */
export function connectionKey(config: ModelConnection): string {
  const { provider, baseUrl } = modelConnection(config);
  let endpoint = baseUrl.replace(/\/+$/, '');
  try { endpoint = new URL(endpoint).href.replace(/\/+$/, ''); } catch { /* validation occurs before sending */ }
  return JSON.stringify([provider, endpoint]);
}

function readConnection(value: unknown): ModelConnection | null {
  if (!value || typeof value !== 'object') return null;
  const config = value as Partial<ModelConnection>;
  if (!config.provider || !Object.hasOwn(connectionDefaults, config.provider) ||
    typeof config.model !== 'string' || typeof config.baseUrl !== 'string') return null;
  return modelConnection(config as ModelConnection);
}

type ModelState = Pick<ChatState, 'conversationModels' | 'connectionCredentials' | 'providerConnections'>;

/** Upgrade old settings without copying credentials into conversation history. */
export function restoreModelState(value: Partial<ChatState>, fallback: ModelConnection): ModelState {
  const conversationModels: ModelState['conversationModels'] = {};
  const connectionCredentials: ModelState['connectionCredentials'] = {};
  const providerConnections: ModelState['providerConnections'] = {};
  for (const [id, raw] of Object.entries(value.conversationModels || {})) {
    const config = readConnection(raw);
    if (config && id !== '__proto__') conversationModels[id] = config;
  }
  for (const provider of Object.keys(connectionDefaults) as Provider[]) {
    const config = readConnection(value.providerConnections?.[provider]);
    if (config?.provider === provider) providerConnections[provider] = config;
  }
  for (const [key, secret] of Object.entries(value.connectionCredentials || {})) {
    if (typeof secret === 'string' && key.startsWith('["')) connectionCredentials[key] = secret;
  }
  const current = modelConnection(fallback);
  providerConnections[current.provider] = current;
  if (!Object.hasOwn(connectionCredentials, connectionKey(current)) && typeof value.apiKey === 'string') {
    connectionCredentials[connectionKey(current)] = value.apiKey;
  }
  // Legacy histories did not record a model; retain their last saved connection.
  const ids = Object.keys(value.conversations || {});
  if (value.activeConversationId && Object.keys(value.messages || {}).length) ids.push(value.activeConversationId);
  for (const id of ids) if (id !== '__proto__' && !Object.hasOwn(conversationModels, id)) conversationModels[id] = current;
  return { conversationModels, connectionCredentials, providerConnections };
}

export function conversationConnection(state: Pick<ChatState, 'activeConversationId' | 'conversationModels' | 'provider' | 'model' | 'baseUrl'>): ModelConnection {
  return state.conversationModels[state.activeConversationId] || modelConnection(state);
}

export function conversationCredential(state: Pick<ChatState, 'connectionCredentials'>, config: ModelConnection): string {
  return state.connectionCredentials[connectionKey(config)] || '';
}
