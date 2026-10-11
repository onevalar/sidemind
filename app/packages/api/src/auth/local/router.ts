import express from 'express';
import { randomBytes } from 'crypto';
import { logger } from '@librechat/data-schemas';
import type { Request, Response, Router } from 'express';
import type { LocalOwnerDeps, LocalOwnerErrorCode, LocalOwnerRecord } from './owner';
import type { LaunchTicketStore } from './tickets';
import type { LocalAccessConfig } from './config';
import {
  checkLaunchKey,
  hasBrowserMetadata,
  isFixedLoopbackRequest,
  isSameOriginBrowserRequest,
} from './guard';
import { sanitizeUserForAuthResponse } from '~/auth/localRefresh';
import { createLaunchTicketStore } from './tickets';
import { createLocalOwnerBinding } from './owner';
import { isOwnerPortalRequest } from './portal';

export interface LocalAccessRouterDeps<U extends LocalOwnerRecord, B = unknown>
  extends Omit<LocalOwnerDeps<U, B>, 'ownerFile'> {
  config: LocalAccessConfig;
  /** Issues the ordinary refresh-cookie session, exactly as a password login does. */
  setAuthTokens: (userId: string, res: Response, unused: null, req: Request) => Promise<string>;
  tickets?: LaunchTicketStore;
}

/** Stable codes the launcher and bootstrap page map to user-facing copy. */
export const LocalAccessCodes = {
  DISABLED: 'LOCAL_MODE_DISABLED',
  MISCONFIGURED: 'LOCAL_MODE_MISCONFIGURED',
  DENIED: 'LOCAL_ACCESS_DENIED',
  KEY_INVALID: 'LOCAL_LAUNCH_KEY_INVALID',
  KEY_UNAVAILABLE: 'LOCAL_LAUNCH_KEY_UNAVAILABLE',
  TICKET_INVALID: 'LOCAL_TICKET_INVALID',
  FAILED: 'LOCAL_ACCESS_FAILED',
} as const;

const OWNER_CODES: Record<LocalOwnerErrorCode, string> = {
  unbound_users_exist: 'LOCAL_DATABASE_HAS_ACCOUNTS',
  owner_unbound: 'LOCAL_OWNER_UNBOUND',
  owner_missing: 'LOCAL_OWNER_MISSING',
  binding_invalid: 'LOCAL_OWNER_BINDING_INVALID',
};

const noStore = (res: Response) => {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
};

const refuse = (res: Response, status: number, code: string): void => {
  noStore(res);
  res.status(status).json({ code });
};

/**
 * The bootstrap page reads the ticket from the fragment and removes it from the address bar and
 * history before anything else runs. It loads no other script; the app itself is only loaded by
 * the final navigation, after the fragment is gone.
 */
function bootstrapPage(nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="referrer" content="no-referrer" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ChatGit</title>
<script nonce="${nonce}">
(function () {
  var hash = window.location.hash;
  window.history.replaceState(null, '', window.location.pathname);
  var match = /^#ticket=([A-Za-z0-9_-]{43})$/.exec(hash);
  function show(text) {
    var write = function () { document.getElementById('status').textContent = text; };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', write);
    } else {
      write();
    }
  }
  var retry = 'This link has expired or was already used. On this device, run "npm run open" in the ChatGit folder to open ChatGit again.';
  if (!match) {
    show(retry);
    return;
  }
  fetch('/api/local/session', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket: match[1] })
  }).then(function (response) {
    if (!response.ok) {
      throw new Error('refused');
    }
    window.location.replace('/c/new');
  }).catch(function () {
    show(retry);
  });
})();
</script>
</head>
<body>
<p id="status" role="status">Opening ChatGit…</p>
</body>
</html>`;
}

/**
 * Account-free local entry. Every route refuses unless local mode resolved cleanly, and only
 * requests that reach the fixed loopback origin directly are served:
 *
 * - `GET  /status`  → `{ localMode }`, so the login screen can show the recovery instruction.
 * - `POST /launch`  → launcher only: `Authorization: Bearer <launch key>`, no browser metadata.
 *                     Creates the owner on an empty database, then returns a single-use ticket.
 * - `GET  /open`    → bootstrap page; the ticket travels in the fragment, never to the server.
 * - `POST /session` → exact Origin, JSON `{ ticket }`; consumes it and issues the normal session.
 */
export function createLocalAccessRouter<U extends LocalOwnerRecord, B = unknown>(
  deps: LocalAccessRouterDeps<U, B>,
): Router {
  const router = express.Router();
  const { config } = deps;

  router.get('/status', (_req, res) => {
    noStore(res);
    res.json({ localMode: config.enabled });
  });

  if (!config.enabled) {
    router.use((_req, res) => refuse(res, 404, LocalAccessCodes.DISABLED));
    return router;
  }
  if (!config.ok) {
    logger.error(`[localAccess] Local mode is misconfigured and stays closed: ${config.reason}`);
    router.use((_req, res) => refuse(res, 503, LocalAccessCodes.MISCONFIGURED));
    return router;
  }

  const { origin, host, launchKeyFile, ownerFile } = config;
  const tickets = deps.tickets ?? createLaunchTicketStore();
  const owner = createLocalOwnerBinding<U, B>({
    ownerFile,
    getUserById: deps.getUserById,
    countUsers: deps.countUsers,
    createUserWithIdIfAbsent: deps.createUserWithIdIfAbsent,
    getBalanceConfig: deps.getBalanceConfig,
  });

  const ownerRefusal = (res: Response, code: LocalOwnerErrorCode): void => {
    logger.warn(`[localAccess] Refused: ${code}`);
    refuse(res, 409, OWNER_CODES[code]);
  };

  router.get('/portal', async (req, res) => {
    if (!config.portal) {
      return refuse(res, 404, LocalAccessCodes.DISABLED);
    }
    if (!isOwnerPortalRequest(req, config)) {
      return refuse(res, 403, 'PORTAL_ACCESS_DENIED');
    }
    try {
      const resolved = await owner.ensureOwner();
      if (!resolved.ok) {
        return ownerRefusal(res, resolved.error.code);
      }
      await deps.setAuthTokens(resolved.value.userId, res, null, req);
      noStore(res);
      return res.redirect('/c/new');
    } catch (error) {
      logger.error('[localAccess] Portal entry failed', {
        name: error instanceof Error ? error.name : typeof error,
      });
      return refuse(res, 500, LocalAccessCodes.FAILED);
    }
  });

  router.post('/launch', async (req, res) => {
    if (!isFixedLoopbackRequest(req, host) || hasBrowserMetadata(req)) {
      return refuse(res, 403, LocalAccessCodes.DENIED);
    }
    try {
      const key = await checkLaunchKey(req.headers.authorization, launchKeyFile);
      if (key === 'unavailable') {
        logger.error('[localAccess] Launch key file is missing or readable by other accounts');
        return refuse(res, 503, LocalAccessCodes.KEY_UNAVAILABLE);
      }
      if (key === 'invalid') {
        return refuse(res, 401, LocalAccessCodes.KEY_INVALID);
      }
      const resolved = await owner.ensureOwner();
      if (!resolved.ok) {
        return ownerRefusal(res, resolved.error.code);
      }
      const { ticket, expiresInSec } = tickets.issue();
      noStore(res);
      res.status(200).json({ ticket, expiresIn: expiresInSec });
    } catch (error) {
      logger.error('[localAccess] Launch failed', {
        name: error instanceof Error ? error.name : typeof error,
      });
      return refuse(res, 500, LocalAccessCodes.FAILED);
    }
  });

  router.get('/open', (req, res) => {
    if (!isFixedLoopbackRequest(req, host)) {
      return refuse(res, 403, LocalAccessCodes.DENIED);
    }
    const nonce = randomBytes(16).toString('base64');
    noStore(res);
    res.set(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; ` +
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Frame-Options', 'DENY');
    res.set('X-Content-Type-Options', 'nosniff');
    res.type('html');
    res.status(200).send(bootstrapPage(nonce));
  });

  router.post('/session', express.json({ limit: '1kb' }), async (req, res) => {
    if (
      !isFixedLoopbackRequest(req, host) ||
      !isSameOriginBrowserRequest(req, origin) ||
      !req.is('application/json')
    ) {
      return refuse(res, 403, LocalAccessCodes.DENIED);
    }
    const ticket: unknown = req.body?.ticket;
    if (typeof ticket !== 'string' || !tickets.consume(ticket)) {
      return refuse(res, 401, LocalAccessCodes.TICKET_INVALID);
    }
    try {
      const resolved = await owner.requireOwner();
      if (!resolved.ok) {
        return ownerRefusal(res, resolved.error.code);
      }
      const { userId, user } = resolved.value;
      const token = await deps.setAuthTokens(userId, res, null, req);
      logger.info('[localAccess] Local owner session issued');
      noStore(res);
      res.status(200).json({ token, user: { ...sanitizeUserForAuthResponse(user), id: userId } });
    } catch (error) {
      logger.error('[localAccess] Session exchange failed', {
        name: error instanceof Error ? error.name : typeof error,
      });
      return refuse(res, 500, LocalAccessCodes.FAILED);
    }
  });

  router.use((_req, res) => refuse(res, 404, LocalAccessCodes.DISABLED));
  return router;
}
