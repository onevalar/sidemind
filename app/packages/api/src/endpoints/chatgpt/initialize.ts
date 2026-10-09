import { EModelEndpoint } from 'librechat-data-provider';
import type { TEndpoint } from 'librechat-data-provider';
import type { InitializeResultBase, EndpointTokenConfig, OpenAIConfigOptions } from '~/types';
import type { ChatGPTInferenceAuth } from './connection';
import { getOpenAIConfig } from '~/endpoints/openai/config';
import { CHATGPT_API_BASE_URL } from './constants';
import { createChatGPTFetch } from './request';
import { ChatGPTError } from './errors';

/**
 * Non-secret placeholder handed to the SDK. The real OAuth token is attached per request
 * by the final fetch boundary, so a bypassed boundary fails closed with a 401 instead of
 * succeeding, and the token never lands in a serializable LLM config.
 */
export const CHATGPT_SDK_API_KEY = 'chatgpt-oauth-managed';

/** Camel-case LLM fields that serialize to fields the preview rejects. */
const UNSUPPORTED_LLM_FIELDS = [
  'temperature',
  'topP',
  'maxTokens',
  'maxCompletionTokens',
  'user',
  'frequencyPenalty',
  'presencePenalty',
  'n',
  'logprobs',
  'topLogprobs',
  'service_tier',
  'truncation',
  'previous_response_id',
  'promptCache',
  'promptCacheTtl',
] as const;

const UNSUPPORTED_MODEL_KWARGS = [
  'max_output_tokens',
  'max_tool_calls',
  'metadata',
  'moderation',
  'multi_agent',
  'prompt',
  'prompt_cache_retention',
  'safety_identifier',
  'temperature',
  'top_logprobs',
  'top_p',
  'truncation',
  'user',
  'previous_response_id',
  'service_tier',
  'background',
  'conversation',
] as const;

export interface InitializeChatGPTParams {
  endpointConfig: Partial<TEndpoint>;
  userId: string;
  auth?: ChatGPTInferenceAuth;
  model_parameters?: Record<string, unknown>;
  endpointTokenConfig?: EndpointTokenConfig;
  transportTimeouts?: OpenAIConfigOptions['transportTimeouts'];
  proxy?: string | null;
  streamRate?: number;
}

/**
 * Builds the OpenAI-client config for a `authMode: chatgpt` custom endpoint. Conversation
 * state, context assembly and pruning stay with the existing agent client; this only fixes
 * the destination (official Responses API), credentials (OAuth via the connection) and
 * request shape. No API-key path exists here, so quota failures cannot fall back to billing.
 */
export async function initializeChatGPTEndpoint(
  params: InitializeChatGPTParams,
): Promise<InitializeResultBase> {
  const { auth, userId, endpointConfig } = params;
  if (!auth) {
    throw new ChatGPTError('disabled', 404);
  }
  /** Fails fast (disabled, non-owner, disconnected, plan usage not granted) before any run. */
  await auth.getAccessToken(userId);

  const modelOptions: Record<string, unknown> = {
    ...(params.model_parameters ?? {}),
    useResponsesApi: true,
  };
  delete modelOptions.user;

  const result = getOpenAIConfig(
    CHATGPT_SDK_API_KEY,
    {
      modelOptions: modelOptions as OpenAIConfigOptions['modelOptions'],
      reverseProxyUrl: CHATGPT_API_BASE_URL,
      streaming: true,
      addParams: endpointConfig.addParams,
      dropParams: endpointConfig.dropParams,
      customParams: { paramDefinitions: endpointConfig.customParams?.paramDefinitions },
      transportTimeouts: params.transportTimeouts,
      proxy: params.proxy ?? null,
    },
    EModelEndpoint.openAI,
  );

  const llmConfig = result.llmConfig as Record<string, unknown>;
  for (const field of UNSUPPORTED_LLM_FIELDS) {
    delete llmConfig[field];
  }
  const modelKwargs = llmConfig.modelKwargs as Record<string, unknown> | undefined;
  if (modelKwargs) {
    for (const field of UNSUPPORTED_MODEL_KWARGS) {
      delete modelKwargs[field];
    }
  }
  llmConfig.useResponsesApi = true;
  /** `store: false` means item ids cannot be referenced later; replay full items instead. */
  llmConfig.zdrEnabled = true;
  llmConfig.streaming = true;
  llmConfig.maxRetries = 0;
  if (params.streamRate != null) {
    llmConfig._lc_stream_delay = params.streamRate;
  }

  const configOptions = { ...(result.configOptions ?? {}) } as Record<string, unknown>;
  delete configOptions.defaultHeaders;
  delete configOptions.defaultQuery;
  delete configOptions.organization;
  delete configOptions.project;
  configOptions.baseURL = CHATGPT_API_BASE_URL;
  configOptions.maxRetries = 0;
  configOptions.fetch = createChatGPTFetch({
    getAccessToken: () => auth.getAccessToken(userId),
    reportError: (error) => auth.reportInferenceError(error),
  });

  return {
    llmConfig: llmConfig as InitializeResultBase['llmConfig'],
    configOptions: configOptions as InitializeResultBase['configOptions'],
    tools: result.tools,
    endpointTokenConfig: params.endpointTokenConfig,
  };
}
