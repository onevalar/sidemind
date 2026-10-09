import path from 'path';
import crypto from 'crypto';
import { promises as fs } from 'fs';

/** Account/client binding retained across sign-out so later sign-ins reuse the issued client. */
export interface ChatGPTRegistration {
  issuer: string;
  subject: string;
  clientId: string;
  email?: string;
}

/** Credentials for the registration above; replaced together on every refresh. */
export interface ChatGPTTokenSet {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  scopes: string[];
  /** Epoch milliseconds. */
  expiresAt: number;
  /** Epoch milliseconds, when the token response supplied `earliest_refresh_at`. */
  earliestRefreshAt?: number;
  savedAt: string;
}

export interface ChatGPTCredentialRecord {
  version: 1;
  registration: ChatGPTRegistration | null;
  tokens: ChatGPTTokenSet | null;
}

export interface ChatGPTCredentialStore {
  read(): Promise<ChatGPTCredentialRecord>;
  write(record: ChatGPTCredentialRecord): Promise<void>;
  /** Opaque, persistent host identifier (`urn:uuid:...`), created once and reused. */
  getHostId(): Promise<string>;
}

const CREDENTIALS_FILE = 'chatgpt-credentials.json';
const HOST_ID_FILE = 'chatgpt-host-id';
const HOST_ID_PATTERN = /^urn:uuid:[0-9a-f-]{36}$/;

export const EMPTY_RECORD: ChatGPTCredentialRecord = {
  version: 1,
  registration: null,
  tokens: null,
};

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

async function ensurePrivateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
}

/** Writes via a same-directory temp file, fsync and rename so readers never see a torn file. */
async function writeFileAtomic(file: string, contents: string): Promise<void> {
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const handle = await fs.open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
  await fs.chmod(file, 0o600);
}

function parseRecord(raw: string): ChatGPTCredentialRecord {
  const parsed = JSON.parse(raw) as Partial<ChatGPTCredentialRecord>;
  if (parsed?.version !== 1) {
    throw new Error('Unsupported ChatGPT credential record version');
  }
  return {
    version: 1,
    registration: parsed.registration ?? null,
    tokens: parsed.tokens ?? null,
  };
}

/**
 * File-backed store under an explicit local state directory supplied by the host
 * (never the repository tree). Files are owner-only (0600) inside a 0700 directory.
 * A corrupt record throws instead of reading as "disconnected".
 */
export function createFileCredentialStore(stateDir: string): ChatGPTCredentialStore {
  if (!path.isAbsolute(stateDir)) {
    throw new Error('ChatGPT state directory must be an absolute path');
  }
  const credentialsFile = path.join(stateDir, CREDENTIALS_FILE);
  const hostIdFile = path.join(stateDir, HOST_ID_FILE);
  let hostIdPromise: Promise<string> | null = null;

  async function readHostId(): Promise<string> {
    await ensurePrivateDir(stateDir);
    try {
      const existing = (await fs.readFile(hostIdFile, 'utf8')).trim();
      if (HOST_ID_PATTERN.test(existing)) {
        return existing;
      }
      throw new Error('Invalid ChatGPT host id file');
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) {
        throw error;
      }
    }
    const created = `urn:uuid:${crypto.randomUUID()}`;
    try {
      const handle = await fs.open(hostIdFile, 'wx', 0o600);
      try {
        await handle.writeFile(created, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return created;
    } catch (error) {
      if (isErrno(error, 'EEXIST')) {
        return (await fs.readFile(hostIdFile, 'utf8')).trim();
      }
      throw error;
    }
  }

  return {
    async read() {
      try {
        return parseRecord(await fs.readFile(credentialsFile, 'utf8'));
      } catch (error) {
        if (isErrno(error, 'ENOENT')) {
          return { ...EMPTY_RECORD };
        }
        throw error;
      }
    },
    async write(record) {
      await ensurePrivateDir(stateDir);
      await writeFileAtomic(credentialsFile, JSON.stringify(record));
    },
    getHostId() {
      hostIdPromise ??= readHostId().catch((error) => {
        hostIdPromise = null;
        throw error;
      });
      return hostIdPromise;
    },
  };
}
