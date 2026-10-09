import { useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { dataService, QueryKeys, MutationKeys } from 'librechat-data-provider';
import type {
  TChatGPTModelsResponse,
  TChatGPTConnectionStatus,
  TChatGPTLoginStartResponse,
} from 'librechat-data-provider';
import type { UseQueryResult, UseMutationResult } from '@tanstack/react-query';

/** Poll interval while an authorization attempt is open in the user's browser. */
const PENDING_POLL_MS = 2000;

export const useGetChatGPTConnectionQuery = (
  enabled = true,
): UseQueryResult<TChatGPTConnectionStatus> =>
  useQuery<TChatGPTConnectionStatus>(
    [QueryKeys.chatgptConnection],
    () => dataService.getChatGPTConnection(),
    {
      enabled,
      retry: false,
      refetchOnWindowFocus: true,
      refetchInterval: (data) => (data?.state === 'pending' ? PENDING_POLL_MS : false),
    },
  );

export const useGetChatGPTModelsQuery = (enabled = true): UseQueryResult<TChatGPTModelsResponse> =>
  useQuery<TChatGPTModelsResponse>(
    [QueryKeys.chatgptModels],
    () => dataService.getChatGPTModels(),
    {
      enabled,
      retry: false,
      refetchOnWindowFocus: false,
    },
  );

/** Status changes alter which models the existing endpoint contract lists. */
function useInvalidateConnection() {
  const queryClient = useQueryClient();
  return (status?: TChatGPTConnectionStatus) => {
    if (status) {
      queryClient.setQueryData([QueryKeys.chatgptConnection], status);
    } else {
      queryClient.invalidateQueries([QueryKeys.chatgptConnection]);
    }
    queryClient.invalidateQueries([QueryKeys.chatgptModels]);
    queryClient.invalidateQueries([QueryKeys.models]);
  };
}

export const useStartChatGPTLoginMutation = (): UseMutationResult<
  TChatGPTLoginStartResponse,
  unknown,
  void
> => {
  const queryClient = useQueryClient();
  return useMutation(() => dataService.startChatGPTLogin(), {
    mutationKey: [MutationKeys.startChatGPTLogin],
    onSuccess: () => queryClient.invalidateQueries([QueryKeys.chatgptConnection]),
  });
};

export const useCancelChatGPTLoginMutation = (): UseMutationResult<
  TChatGPTConnectionStatus,
  unknown,
  void
> => {
  const invalidate = useInvalidateConnection();
  return useMutation(() => dataService.cancelChatGPTLogin(), {
    mutationKey: [MutationKeys.cancelChatGPTLogin],
    onSuccess: (status) => invalidate(status),
  });
};

export const useDisconnectChatGPTMutation = (): UseMutationResult<
  TChatGPTConnectionStatus,
  unknown,
  void
> => {
  const invalidate = useInvalidateConnection();
  return useMutation(() => dataService.disconnectChatGPT(), {
    mutationKey: [MutationKeys.disconnectChatGPT],
    onSuccess: (status) => invalidate(status),
  });
};

/** Call when polling observes the transition to `connected` so model pickers refresh. */
export function useRefreshChatGPTModels() {
  const queryClient = useQueryClient();
  return useCallback(() => {
    queryClient.invalidateQueries([QueryKeys.chatgptModels]);
    queryClient.invalidateQueries([QueryKeys.models]);
  }, [queryClient]);
}
