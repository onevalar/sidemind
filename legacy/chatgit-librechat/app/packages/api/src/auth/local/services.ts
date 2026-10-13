import path from 'path';
import express from 'express';
import type { RequestHandler, Router } from 'express';
import type { LocalAccessRouterDeps } from './router';
import type { LocalOwnerRecord } from './owner';
import { setCustomEndpointAuthProviders } from '~/endpoints/custom/auth';
import { createChatGPTConnection } from '~/endpoints/chatgpt/connection';
import { createFileCredentialStore } from '~/endpoints/chatgpt/store';
import { createChatGPTRouter } from '~/endpoints/chatgpt/router';
import { createLocalAccessRouter } from './router';
import { createLocalOwnerBinding } from './owner';

/** One local owner and one optional provider connection, wired by the Express host. */
export function createChatGitRouter<U extends LocalOwnerRecord, B = unknown>(
  deps: LocalAccessRouterDeps<U, B> & { requireJwtAuth: RequestHandler },
): Router {
  const router = express.Router();
  router.use('/local', createLocalAccessRouter(deps));
  const { config } = deps;
  if (!config.enabled || !config.ok) {
    setCustomEndpointAuthProviders({});
    router.use('/chatgpt', (_req, res) => {
      res.sendStatus(404);
    });
    return router;
  }

  const owner = createLocalOwnerBinding({ ...deps, ownerFile: config.ownerFile });
  const connection = createChatGPTConnection({
    port: Number(new URL(config.origin).port),
    store: createFileCredentialStore(path.join(path.dirname(config.ownerFile), 'chatgpt')),
    isEnabled: () => true,
    getLocalOwnerId: async () => {
      const result = await owner.requireOwner();
      return result.ok ? result.value.userId : null;
    },
  });
  setCustomEndpointAuthProviders({ chatgpt: connection });
  router.use('/chatgpt', createChatGPTRouter({ connection, requireJwtAuth: deps.requireJwtAuth }));
  return router;
}
