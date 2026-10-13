import express from 'express';
import type { Request, Response, Router, NextFunction, RequestHandler } from 'express';
import type { ChatGPTConnection, ChatGPTLogger } from './connection';
import { isChatGPTError } from './errors';

export interface ChatGPTRouterDeps {
  connection: ChatGPTConnection;
  /** The app's existing JWT middleware; it must populate `req.user`. */
  requireJwtAuth: RequestHandler;
  logger?: ChatGPTLogger;
}

type AuthedRequest = Request & { user?: { id?: string; _id?: unknown } };

function userIdOf(req: AuthedRequest): string | undefined {
  const id = req.user?.id ?? (req.user?._id != null ? String(req.user._id) : undefined);
  return typeof id === 'string' && id !== '' ? id : undefined;
}

const CALLBACK_COPY: Record<'success' | 'failure', { title: string; body: string }> = {
  success: {
    title: 'ChatGPT connected',
    body: 'ChatGit can now use your ChatGPT plan. You can close this tab and return to ChatGit.',
  },
  failure: {
    title: 'ChatGPT connection not completed',
    body: 'Nothing was saved. Return to ChatGit settings to see the reason and try again.',
  },
};

/** Static page: echoes nothing from the request, loads nothing, runs no script. */
function callbackPage(kind: 'success' | 'failure'): string {
  const { title, body } = CALLBACK_COPY[kind];
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

/**
 * Routes for the optional owner-only ChatGPT-plan connection. Mount at `/api/chatgpt`.
 * Every route 404s unless the connection gate is open (explicit local mode, not preview).
 * Status, login, cancel, disconnect and models require the existing JWT plus the exact
 * local owner. Only the OAuth callback is unauthenticated; it validates the pending
 * attempt's state before any code exchange and returns a static page.
 */
export function createChatGPTRouter(deps: ChatGPTRouterDeps): Router {
  const { connection } = deps;
  const router = express.Router();

  const sendError = (res: Response, error: unknown): void => {
    if (isChatGPTError(error)) {
      res.status(error.status).json({ error: { code: error.code } });
      return;
    }
    deps.logger?.warn('[chatgpt] Unexpected route failure');
    res.status(500).json({ error: { code: 'request_failed' } });
  };

  router.use((_req: Request, res: Response, next: NextFunction) => {
    noStore(res);
    if (!connection.isEnabled()) {
      res.status(404).json({ error: { code: 'disabled' } });
      return;
    }
    next();
  });

  router.get('/callback', async (req: Request, res: Response) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const result = await connection.handleCallback({
        state: req.query.state,
        code: req.query.code,
        error: req.query.error,
        client_id: req.query.client_id,
      });
      res
        .status(result.ok ? 200 : 400)
        .type('html')
        .send(callbackPage(result.ok ? 'success' : 'failure'));
    } catch {
      deps.logger?.warn('[chatgpt] Callback failed unexpectedly');
      res.status(500).type('html').send(callbackPage('failure'));
    }
  });

  const requireOwner = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!(await connection.isOwner(userIdOf(req as AuthedRequest)))) {
        res.status(403).json({ error: { code: 'forbidden' } });
        return;
      }
      next();
    } catch (error) {
      sendError(res, error);
    }
  };

  const owner = [deps.requireJwtAuth, requireOwner];

  router.get('/status', ...owner, async (_req: Request, res: Response) => {
    try {
      res.json(await connection.getStatus());
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/login', ...owner, async (req: Request, res: Response) => {
    try {
      res.json(await connection.startLogin(userIdOf(req as AuthedRequest) ?? ''));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/login/cancel', ...owner, async (_req: Request, res: Response) => {
    try {
      connection.cancelLogin();
      res.json(await connection.getStatus());
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/disconnect', ...owner, async (_req: Request, res: Response) => {
    try {
      res.json(await connection.disconnect());
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/models', ...owner, async (req: Request, res: Response) => {
    try {
      res.json({ models: await connection.listModels(userIdOf(req as AuthedRequest) ?? '') });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
