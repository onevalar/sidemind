import { createHash, randomBytes } from 'crypto';

/** Long enough to open a browser tab; a ticket is useless once this elapses. */
export const LAUNCH_TICKET_TTL_MS = 60_000;
/** Bounds memory if a launcher is run in a loop; the oldest unused tickets are dropped first. */
export const MAX_OUTSTANDING_TICKETS = 16;
/** 32 random bytes, base64url without padding. */
export const LAUNCH_TICKET_PATTERN: RegExp = /^[A-Za-z0-9_-]{43}$/;

export interface LaunchTicketStore {
  issue: () => { ticket: string; expiresInSec: number };
  /** True exactly once for a live ticket; expired, unknown and replayed tickets are false. */
  consume: (ticket: string) => boolean;
}

function hashTicket(ticket: string): string {
  return createHash('sha256').update(ticket, 'utf8').digest('hex');
}

/**
 * In-memory, process-local single-use tickets. Only hashes are kept, and consumption deletes the
 * entry synchronously before any await, so concurrent exchanges of one ticket cannot both pass.
 */
export function createLaunchTicketStore(
  options: { ttlMs?: number; now?: () => number } = {},
): LaunchTicketStore {
  const ttlMs = options.ttlMs ?? LAUNCH_TICKET_TTL_MS;
  const now = options.now ?? Date.now;
  const tickets = new Map<string, number>();

  const prune = (at: number) => {
    for (const [key, expiresAt] of tickets) {
      if (expiresAt <= at) {
        tickets.delete(key);
      }
    }
    while (tickets.size >= MAX_OUTSTANDING_TICKETS) {
      const oldest = tickets.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      tickets.delete(oldest);
    }
  };

  return {
    issue() {
      const at = now();
      prune(at);
      const ticket = randomBytes(32).toString('base64url');
      tickets.set(hashTicket(ticket), at + ttlMs);
      return { ticket, expiresInSec: Math.floor(ttlMs / 1000) };
    },
    consume(ticket) {
      if (!LAUNCH_TICKET_PATTERN.test(ticket)) {
        return false;
      }
      const key = hashTicket(ticket);
      const expiresAt = tickets.get(key);
      if (expiresAt === undefined) {
        return false;
      }
      tickets.delete(key);
      return expiresAt > now();
    },
  };
}
