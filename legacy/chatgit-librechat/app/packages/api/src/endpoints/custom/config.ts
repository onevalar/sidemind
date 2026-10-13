import { EModelEndpoint, extractEnvVariable, normalizeEndpointName } from 'librechat-data-provider';
import type { TCustomEndpoints, TEndpoint } from 'librechat-data-provider';
import type { TCustomEndpointsConfig } from '~/types/endpoints';
import { CHATGPT_API_BASE_URL } from '~/endpoints/chatgpt/constants';
import { isChatGPTAuthEndpoint } from '~/endpoints/chatgpt/mode';
import { resolveEndpointProviderId } from './providers';
import { isUserProvided } from '~/utils';

/**
 * Load config endpoints from the cached configuration object
 * @param customEndpointsConfig - The configuration object
 */
export function loadCustomEndpointsConfig(
  customEndpoints?: TCustomEndpoints,
): TCustomEndpointsConfig | undefined {
  if (!customEndpoints) {
    return;
  }

  const customEndpointsConfig: TCustomEndpointsConfig = {};

  if (Array.isArray(customEndpoints)) {
    const filteredEndpoints = customEndpoints.filter(
      (endpoint) =>
        (endpoint.name && isChatGPTAuthEndpoint(endpoint)) ||
        (endpoint.baseURL &&
          endpoint.apiKey &&
          endpoint.name &&
          endpoint.models &&
          (endpoint.models.fetch || endpoint.models.default)),
    );

    for (let i = 0; i < filteredEndpoints.length; i++) {
      const endpoint = filteredEndpoints[i] as TEndpoint;
      if (isChatGPTAuthEndpoint(endpoint)) {
        const name = normalizeEndpointName(endpoint.name);
        /** Credentials come from the owner's ChatGPT connection, never a user key prompt. */
        customEndpointsConfig[name] = {
          type: EModelEndpoint.custom,
          authMode: 'chatgpt',
          userProvide: false,
          userProvideURL: false,
          modelDisplayLabel: endpoint.modelDisplayLabel,
          iconURL: endpoint.iconURL,
          customParams: { defaultParamsEndpoint: EModelEndpoint.openAI },
          providerId: resolveEndpointProviderId({
            name,
            baseURL: CHATGPT_API_BASE_URL,
            iconURL: endpoint.iconURL,
          }),
        };
        continue;
      }
      const {
        baseURL,
        apiKey,
        name: configName,
        iconURL,
        modelDisplayLabel,
        customParams,
        provider,
      } = endpoint;
      const name = normalizeEndpointName(configName);

      const resolvedApiKey = extractEnvVariable(apiKey ?? '');
      const resolvedBaseURL = extractEnvVariable(baseURL ?? '');
      const userProvideURL = isUserProvided(resolvedBaseURL);

      /**
       * A native `provider` (e.g. anthropic) implies its parameter set. Surface it
       * as `defaultParamsEndpoint` so the client param panel shows the right fields
       * (e.g. `maxOutputTokens`/`thinking` for Anthropic, not OpenAI `max_tokens`),
       * unless an admin explicitly chose a non-default `defaultParamsEndpoint`.
       */
      const resolvedCustomParams =
        provider != null &&
        (customParams?.defaultParamsEndpoint == null ||
          customParams.defaultParamsEndpoint === EModelEndpoint.custom)
          ? { ...customParams, defaultParamsEndpoint: provider }
          : customParams;

      customEndpointsConfig[name] = {
        type: EModelEndpoint.custom,
        userProvide: isUserProvided(resolvedApiKey) || userProvideURL,
        userProvideURL,
        customParams: resolvedCustomParams,
        modelDisplayLabel,
        iconURL,
        providerId: resolveEndpointProviderId({
          name,
          baseURL: resolvedBaseURL,
          iconURL,
          provider,
        }),
      };
    }
  }

  return customEndpointsConfig;
}
