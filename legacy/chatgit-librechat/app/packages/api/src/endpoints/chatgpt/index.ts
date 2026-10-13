export { CHATGPT_CALLBACK_PATH, CHATGPT_USAGE_URL } from './constants';
export { ChatGPTError, isChatGPTError } from './errors';
export { createFileCredentialStore } from './store';
export type { ChatGPTCredentialStore } from './store';
export { createChatGPTConnection } from './connection';
export type {
  ChatGPTLogger,
  ChatGPTConnection,
  ChatGPTInferenceAuth,
  ChatGPTConnectionDeps,
} from './connection';
export { createChatGPTFetch, sanitizeResponsesBody } from './request';
export { initializeChatGPTEndpoint } from './initialize';
export { isChatGPTAuthEndpoint } from './mode';
export { createChatGPTRouter } from './router';
export type { ChatGPTRouterDeps } from './router';

/**
 * The connection is available only in explicit local mode (`CHATGIT_LOCAL_MODE` exactly
 * `true`) and never in preview mode. Hosts pass the raw values; this reads no globals.
 */
export function isChatGPTConnectionAllowed(flags: {
  localMode?: string | null;
  previewMode?: string | null;
}): boolean {
  const preview = (flags.previewMode ?? '').trim().toLowerCase();
  if (preview === 'true' || preview === '1') {
    return false;
  }
  return flags.localMode === 'true';
}
