import type { TEndpoint } from 'librechat-data-provider';

/** Endpoint uses the local ChatGPT-plan connection instead of `apiKey`/`baseURL`. */
export function isChatGPTAuthEndpoint(endpointConfig?: Partial<TEndpoint> | null): boolean {
  return (endpointConfig as { authMode?: string } | null | undefined)?.authMode === 'chatgpt';
}
