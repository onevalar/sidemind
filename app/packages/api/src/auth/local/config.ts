import path from 'path';

/**
 * Account-free local mode, resolved from the environment the ChatGit runtime
 * (`scripts/chatgit_runtime.py`) composes. Local mode is an explicit runtime boundary rather than
 * a `librechat.yaml` field: it also forces the bind address, the managed database and the
 * disabled sign-in methods, which must be decided before the app config loads.
 */
export type LocalAccessConfig =
  | { enabled: false }
  | { enabled: true; ok: false; reason: string }
  | {
      enabled: true;
      ok: true;
      /** Exact browser origin, e.g. `http://127.0.0.1:3080`. */
      origin: string;
      /** Exact `Host` header the origin produces, e.g. `127.0.0.1:3080`. */
      host: string;
      /** Owner-only file holding the persistent launcher key. */
      launchKeyFile: string;
      /** File recording the id of the single local owner. */
      ownerFile: string;
    };

type LocalAccessEnv = Partial<Record<string, string | undefined>>;

const LOOPBACK_HOST = '127.0.0.1';
const LOOPBACK_MONGO = /^mongodb:\/\/127\.0\.0\.1:\d{1,5}\//;

function parseOrigin(value: string | undefined): URL | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    const plain =
      url.protocol === 'http:' &&
      url.hostname === LOOPBACK_HOST &&
      url.port !== '' &&
      url.pathname === '/' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash;
    return plain ? url : null;
  } catch {
    return null;
  }
}

/** Fails closed: local mode with any inconsistent setting yields `ok: false`. */
export function resolveLocalAccessConfig(env: LocalAccessEnv): LocalAccessConfig {
  if (env.CHATGIT_LOCAL_MODE !== 'true') {
    return { enabled: false };
  }
  const url = parseOrigin(env.CHATGIT_LOCAL_ORIGIN);
  if (!url) {
    return {
      enabled: true,
      ok: false,
      reason: 'CHATGIT_LOCAL_ORIGIN must be http://127.0.0.1:<port>',
    };
  }
  if (env.HOST !== LOOPBACK_HOST) {
    return { enabled: true, ok: false, reason: 'HOST must be 127.0.0.1 in local mode' };
  }
  if (env.PORT && env.PORT !== url.port) {
    return { enabled: true, ok: false, reason: 'PORT does not match CHATGIT_LOCAL_ORIGIN' };
  }
  if (!LOOPBACK_MONGO.test(env.MONGO_URI ?? '')) {
    return { enabled: true, ok: false, reason: 'MONGO_URI must be the managed loopback database' };
  }
  const launchKeyFile = env.CHATGIT_LAUNCH_KEY_FILE ?? '';
  const ownerFile = env.CHATGIT_LOCAL_OWNER_FILE ?? '';
  if (!path.isAbsolute(launchKeyFile) || !path.isAbsolute(ownerFile)) {
    return {
      enabled: true,
      ok: false,
      reason: 'CHATGIT_LAUNCH_KEY_FILE and CHATGIT_LOCAL_OWNER_FILE must be absolute paths',
    };
  }
  return { enabled: true, ok: true, origin: url.origin, host: url.host, launchKeyFile, ownerFile };
}
