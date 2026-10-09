import type { TEndpoint } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { ChatGPTInferenceAuth } from '~/endpoints/chatgpt/connection';
import type { BaseInitializeParams, ServerRequest } from '~/types';
import { createLoadConfigModels } from '~/endpoints/config/models';
import { setCustomEndpointAuthProviders } from './auth';
import { loadCustomEndpointsConfig } from './config';
import { initializeCustom } from './initialize';

const chatgptEndpoint = {
  name: 'ChatGPT',
  authMode: 'chatgpt',
  models: { default: ['hardcoded-should-not-appear'], fetch: true },
  addParams: { temperature: 0.4, max_output_tokens: 99 },
} as unknown as TEndpoint;

const apiKeyEndpoint = {
  name: 'Other',
  apiKey: 'sk-other',
  baseURL: 'https://other.example.com/v1',
  models: { default: ['other-model'] },
} as TEndpoint;

const appConfig = {
  endpoints: { custom: [chatgptEndpoint, apiKeyEndpoint] },
} as unknown as AppConfig;

function makeAuth(overrides: Partial<ChatGPTInferenceAuth> = {}): ChatGPTInferenceAuth {
  return {
    getAccessToken: jest.fn(async () => 'oauth-access'),
    listModels: jest.fn(async () => [
      { slug: 'gpt-live', displayName: 'GPT Live' },
      { slug: 'gpt-live-mini', displayName: 'GPT Live Mini' },
    ]),
    reportInferenceError: jest.fn(),
    ...overrides,
  };
}

function params(userId = 'owner-1'): BaseInitializeParams {
  return {
    req: {
      user: { id: userId },
      body: {},
      config: appConfig,
    } as unknown as BaseInitializeParams['req'],
    endpoint: 'ChatGPT',
    model_parameters: { model: 'gpt-live', temperature: 0.7, topP: 0.5, maxTokens: 500 },
    db: { getUserKey: jest.fn(), getUserKeyValues: jest.fn() },
  };
}

afterEach(() => setCustomEndpointAuthProviders({}));

describe('authMode: chatgpt custom endpoint', () => {
  it('fails closed when the host registered no ChatGPT connection', async () => {
    await expect(initializeCustom(params())).rejects.toMatchObject({ code: 'disabled' });
  });

  it('propagates connection refusals (non-owner, disconnected) before building a client', async () => {
    const auth = makeAuth({
      getAccessToken: jest.fn(async () => {
        throw Object.assign(new Error('forbidden'), { code: 'forbidden' });
      }),
    });
    setCustomEndpointAuthProviders({ chatgpt: auth });
    await expect(initializeCustom(params('intruder'))).rejects.toMatchObject({ code: 'forbidden' });
    expect(auth.getAccessToken).toHaveBeenCalledWith('intruder');
  });

  it('builds an official Responses config with the OAuth boundary and no API-key path', async () => {
    const auth = makeAuth();
    setCustomEndpointAuthProviders({ chatgpt: auth });
    const result = await initializeCustom(params());
    const llmConfig = result.llmConfig as Record<string, unknown>;
    const configOptions = result.configOptions as Record<string, unknown>;

    expect(configOptions.baseURL).toBe('https://api.openai.com/v1');
    expect(typeof configOptions.fetch).toBe('function');
    expect(configOptions.defaultHeaders).toBeUndefined();
    expect(llmConfig).toMatchObject({
      model: 'gpt-live',
      useResponsesApi: true,
      zdrEnabled: true,
      streaming: true,
      maxRetries: 0,
    });
    for (const field of ['temperature', 'topP', 'maxTokens', 'user']) {
      expect(llmConfig).not.toHaveProperty(field);
    }
    expect(JSON.stringify(llmConfig)).not.toContain('oauth-access');
    expect(result.provider).toBeUndefined();

    /** The boundary is the only path to the network and it uses the connection's token. */
    const upstream = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r"}}\n\n',
          { status: 200 },
        ),
      );
    try {
      const fetchFn = configOptions.fetch as typeof fetch;
      await fetchFn('https://api.openai.com/v1/responses', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-live', input: [], temperature: 1, stream: true }),
      });
      const [, init] = upstream.mock.calls[0];
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer oauth-access');
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'gpt-live',
        input: [],
        store: false,
        stream: true,
      });
    } finally {
      upstream.mockRestore();
    }
  });

  it('surfaces the endpoint without apiKey/baseURL and leaves other endpoints unchanged', () => {
    const config = loadCustomEndpointsConfig([chatgptEndpoint, apiKeyEndpoint]);
    expect(config?.ChatGPT).toMatchObject({
      type: 'custom',
      authMode: 'chatgpt',
      userProvide: false,
      userProvideURL: false,
    });
    expect(config?.Other).toMatchObject({ type: 'custom', userProvide: false });
    expect(config?.Other).not.toHaveProperty('authMode');
  });

  it('lists only account models, never configured defaults', async () => {
    const auth = makeAuth();
    const fetchModels = jest.fn();
    const loadConfigModels = createLoadConfigModels({
      getAppConfig: jest.fn(),
      getUserKeyValues: jest.fn(),
      fetchModels,
      getCustomAuthProviders: () => ({ chatgpt: auth }),
    });
    const req = { user: { id: 'owner-1' }, config: appConfig } as unknown as ServerRequest;
    await expect(loadConfigModels(req)).resolves.toEqual({
      ChatGPT: ['gpt-live', 'gpt-live-mini'],
      Other: ['other-model'],
    });

    const failing = createLoadConfigModels({
      getAppConfig: jest.fn(),
      getUserKeyValues: jest.fn(),
      fetchModels,
      getCustomAuthProviders: () => ({
        chatgpt: makeAuth({
          listModels: jest.fn(async () => {
            throw Object.assign(new Error('x'), { code: 'not_connected' });
          }),
        }),
      }),
    });
    await expect(failing(req)).resolves.toMatchObject({ ChatGPT: [] });
    expect(fetchModels).not.toHaveBeenCalled();
  });
});
