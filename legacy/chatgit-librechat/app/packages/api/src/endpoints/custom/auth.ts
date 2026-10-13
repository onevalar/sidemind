import type { ChatGPTInferenceAuth } from '~/endpoints/chatgpt/connection';

/**
 * Credential providers for custom endpoints whose `authMode` is not `apiKey`.
 *
 * Provider initialization is reached through the static provider map from many call
 * sites (chat, titles, summaries, labels), so the host registers its providers once at
 * startup instead of threading them through every caller. Nothing is registered by
 * default: a `chatgpt` endpoint then fails closed and lists no models.
 */
export interface CustomEndpointAuthProviders {
  chatgpt?: ChatGPTInferenceAuth;
}

let providers: CustomEndpointAuthProviders = {};

export function setCustomEndpointAuthProviders(next: CustomEndpointAuthProviders): void {
  providers = { ...next };
}

export function getCustomEndpointAuthProviders(): CustomEndpointAuthProviders {
  return providers;
}
