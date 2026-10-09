import { promises as fs } from 'fs';
import { createHash, timingSafeEqual } from 'crypto';
import type { Request } from 'express';

/** Peer addresses of a socket opened on this machine's loopback interface. */
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Headers a proxy adds; their presence means the request did not come straight from a browser. */
const FORWARDING_HEADERS = new Set([
  'forwarded',
  'via',
  'x-real-ip',
  'x-client-ip',
  'x-cluster-client-ip',
  'true-client-ip',
  'cf-connecting-ip',
  'fastly-client-ip',
]);

const MIN_LAUNCH_KEY_LENGTH = 32;

/**
 * Reads the TCP peer, never `req.ip`: the app trusts one proxy hop by default, so `req.ip` and
 * `req.hostname` follow client-supplied forwarding headers.
 */
export function isDirectLoopback(req: Request): boolean {
  return LOOPBACK_PEERS.has(req.socket?.remoteAddress ?? '');
}

export function hasForwardingHeaders(req: Request): boolean {
  return Object.keys(req.headers).some(
    (name) => name.startsWith('x-forwarded-') || FORWARDING_HEADERS.has(name),
  );
}

/**
 * A request that reached the fixed loopback origin directly: loopback peer, no proxy headers,
 * and the exact `Host` the origin produces, which defeats DNS rebinding to 127.0.0.1.
 */
export function isFixedLoopbackRequest(req: Request, host: string): boolean {
  return isDirectLoopback(req) && !hasForwardingHeaders(req) && req.headers.host === host;
}

/** A browser fetch issued by a page on the fixed origin itself. */
export function isSameOriginBrowserRequest(req: Request, origin: string): boolean {
  const site = req.headers['sec-fetch-site'];
  return req.headers.origin === origin && (site === undefined || site === 'same-origin');
}

/** The launcher is not a browser; anything carrying browser request metadata is refused. */
export function hasBrowserMetadata(req: Request): boolean {
  return (
    req.headers.origin !== undefined ||
    req.headers.referer !== undefined ||
    req.headers.cookie !== undefined ||
    Object.keys(req.headers).some((name) => name.startsWith('sec-fetch-'))
  );
}

export type LaunchKeyCheck = 'valid' | 'invalid' | 'unavailable';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Compares the bearer key with the owner-only key file, re-read per request so a replaced key
 * takes effect without a restart. A key readable by other accounts is treated as unavailable.
 */
export async function checkLaunchKey(
  authorization: string | undefined,
  keyFile: string,
): Promise<LaunchKeyCheck> {
  let stored: string;
  try {
    const stat = await fs.stat(keyFile);
    if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
      return 'unavailable';
    }
    stored = (await fs.readFile(keyFile, 'utf8')).trim();
  } catch {
    return 'unavailable';
  }
  if (stored.length < MIN_LAUNCH_KEY_LENGTH) {
    return 'unavailable';
  }
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization ?? '');
  if (!match) {
    return 'invalid';
  }
  return timingSafeEqual(digest(match[1]), digest(stored)) ? 'valid' : 'invalid';
}
