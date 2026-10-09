import path from 'path';
import { promises as fs } from 'fs';
import { randomBytes } from 'crypto';
import { SystemRoles } from 'librechat-data-provider';

/** A stored user as plain data; only the id is read here. */
export type LocalOwnerRecord = { _id: { toString(): string } };

export type LocalOwnerErrorCode =
  /** No binding yet, and the database already holds accounts: never adopt one of them. */
  | 'unbound_users_exist'
  /** No binding yet on a read-only path; only the key-authenticated launcher may create one. */
  | 'owner_unbound'
  /** The bound owner is gone while other accounts remain. */
  | 'owner_missing'
  /** The binding file is unreadable or malformed. */
  | 'binding_invalid';

export type LocalOwnerResult<U extends LocalOwnerRecord> =
  | { ok: true; value: { userId: string; user: U } }
  | { ok: false; error: { code: LocalOwnerErrorCode } };

type CreateResult = { ok: true } | { ok: false; error: { code: string } };

export interface LocalOwnerDeps<U extends LocalOwnerRecord, B = unknown> {
  ownerFile: string;
  getUserById: (userId: string) => Promise<U | null>;
  countUsers: () => Promise<number>;
  createUserWithIdIfAbsent: (
    userId: string,
    data: typeof LOCAL_OWNER_PROFILE,
    balanceConfig?: B,
  ) => Promise<CreateResult>;
  getBalanceConfig?: () => Promise<B | undefined>;
}

/** The one passwordless account local mode signs in. It has no credential of its own. */
export const LOCAL_OWNER_PROFILE: {
  name: string;
  username: string;
  email: string;
  emailVerified: boolean;
  provider: string;
  role: SystemRoles;
} = {
  name: 'Owner',
  username: 'owner',
  email: 'owner@chatgit.local',
  emailVerified: true,
  provider: 'local',
  role: SystemRoles.USER,
};

const BINDING_VERSION = 1;
const OBJECT_ID = /^[0-9a-f]{24}$/;

class BindingError extends Error {}

async function readBinding(file: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new BindingError('unreadable');
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed != null &&
      typeof parsed === 'object' &&
      'version' in parsed &&
      parsed.version === BINDING_VERSION &&
      'userId' in parsed &&
      typeof parsed.userId === 'string' &&
      OBJECT_ID.test(parsed.userId)
    ) {
      return parsed.userId;
    }
  } catch {
    // fall through
  }
  throw new BindingError('malformed');
}

/**
 * Writes the binding without ever clobbering one: the content is complete on disk before a hard
 * link publishes it, and the link fails if another writer published first. Returns the bound id.
 */
async function publishBinding(file: string, userId: string): Promise<string> {
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  const body = JSON.stringify({ version: BINDING_VERSION, userId, createdAt: new Date() });
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(`${body}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.link(temp, file);
    return userId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
    const existing = await readBinding(file);
    if (!existing) {
      throw new BindingError('vanished');
    }
    return existing;
  } finally {
    await fs.unlink(temp).catch(() => undefined);
  }
}

/**
 * Resolves the single local owner. `ensureOwner` (launcher only) may create it on a database
 * with no accounts at all; the id is persisted before the insert so an interrupted creation
 * resumes under the same id. It never adopts, modifies or removes any existing account.
 */
export function createLocalOwnerBinding<U extends LocalOwnerRecord, B = unknown>(
  deps: LocalOwnerDeps<U, B>,
): {
  ensureOwner: () => Promise<LocalOwnerResult<U>>;
  requireOwner: () => Promise<LocalOwnerResult<U>>;
} {
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };
  const fail = (code: LocalOwnerErrorCode): LocalOwnerResult<U> => ({ ok: false, error: { code } });
  const found = (userId: string, user: U): LocalOwnerResult<U> => ({
    ok: true,
    value: { userId, user },
  });

  const read = async (): Promise<{ ok: true; userId: string | null } | { ok: false }> => {
    try {
      return { ok: true, userId: await readBinding(deps.ownerFile) };
    } catch (error) {
      if (error instanceof BindingError) {
        return { ok: false };
      }
      throw error;
    }
  };

  const createOwner = async (userId: string): Promise<LocalOwnerResult<U>> => {
    if ((await deps.countUsers()) > 0) {
      return fail('owner_missing');
    }
    const balanceConfig = await deps.getBalanceConfig?.();
    await deps.createUserWithIdIfAbsent(userId, LOCAL_OWNER_PROFILE, balanceConfig);
    const user = await deps.getUserById(userId);
    return user ? found(userId, user) : fail('owner_missing');
  };

  const ensureOwner = (): Promise<LocalOwnerResult<U>> =>
    serialized(async () => {
      const binding = await read();
      if (!binding.ok) {
        return fail('binding_invalid');
      }
      let userId = binding.userId;
      if (userId == null) {
        if ((await deps.countUsers()) > 0) {
          return fail('unbound_users_exist');
        }
        try {
          userId = await publishBinding(deps.ownerFile, randomBytes(12).toString('hex'));
        } catch (error) {
          if (error instanceof BindingError) {
            return fail('binding_invalid');
          }
          throw error;
        }
      }
      const user = await deps.getUserById(userId);
      return user ? found(userId, user) : createOwner(userId);
    });

  const requireOwner = async (): Promise<LocalOwnerResult<U>> => {
    const binding = await read();
    if (!binding.ok) {
      return fail('binding_invalid');
    }
    if (binding.userId == null) {
      return fail('owner_unbound');
    }
    const user = await deps.getUserById(binding.userId);
    return user ? found(binding.userId, user) : fail('owner_missing');
  };

  return { ensureOwner, requireOwner };
}
