import type { CookieOptions, Request, RequestHandler } from 'express';
import type { LocalAccessConfig } from './config';
import { isDirectLoopback, isFixedLoopbackRequest } from './guard';

/** Amp overwrites its identity headers at the portal proxy; direct external peers are refused. */
export function isOwnerPortalRequest(req: Request, config: LocalAccessConfig): boolean {
  if (!config.enabled || !config.ok || !config.portal) {
    return false;
  }
  const { portal } = config;
  const authenticated = req
    .get('x-amp-authenticated')
    ?.split(',')
    .map((part) => part.trim());
  return (
    isDirectLoopback(req) &&
    req.get('host') === portal.host &&
    req.get('x-forwarded-proto') === 'https' &&
    authenticated?.includes('amp-user=yes') === true &&
    authenticated.includes('collaborator=yes') &&
    req.get('x-amp-user-id') === portal.userId &&
    (!req.get('origin') || req.get('origin') === portal.origin)
  );
}

/** Protects every portal request, including requests carrying an existing ChatGit session. */
export function createPortalAccessMiddleware(config: LocalAccessConfig): RequestHandler {
  return (req, res, next) => {
    if (!config.enabled) {
      next();
      return;
    }
    if (!config.ok) {
      res.status(503).json({ code: 'LOCAL_MODE_MISCONFIGURED' });
      return;
    }
    if (!config.portal || isFixedLoopbackRequest(req, config.host)) {
      next();
      return;
    }
    if (!isOwnerPortalRequest(req, config)) {
      res.set('Cache-Control', 'no-store');
      res.status(403).json({ code: 'PORTAL_ACCESS_DENIED' });
      return;
    }
    // Express clearCookie also calls cookie, so issuance, refresh and deletion
    // share this policy. Other app cookies and direct local requests are unchanged.
    const cookie = res.cookie.bind(res);
    res.cookie = (name, value, options: CookieOptions = {}) =>
      cookie(
        name,
        value,
        name === 'refreshToken' || name === 'token_provider'
          ? { ...options, secure: true, sameSite: 'none', partitioned: true }
          : options,
      );
    res.removeHeader('X-Frame-Options');
    res.set('Content-Security-Policy', `frame-ancestors 'self' ${config.portal.frameOrigin}`);
    next();
  };
}
