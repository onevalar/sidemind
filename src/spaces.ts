import type { ConversationSpace } from './types';

export function restoreSpaces(rawSpaces: unknown, rawLocations: unknown) {
  const spaces: Record<string, ConversationSpace> = {};
  if (rawSpaces && typeof rawSpaces === 'object' && !Array.isArray(rawSpaces)) {
    for (const [id, value] of Object.entries(rawSpaces)) {
      if (!value || typeof value !== 'object' || id === '__proto__') continue;
      const name = (value as { name?: unknown }).name;
      if (typeof name === 'string' && name.trim()) spaces[id] = { id, name: name.trim().slice(0, 80) };
    }
  }
  const conversationSpaces: Record<string, string> = {};
  if (rawLocations && typeof rawLocations === 'object' && !Array.isArray(rawLocations)) {
    for (const [id, space] of Object.entries(rawLocations)) {
      if (typeof space === 'string' && Object.hasOwn(spaces, space) && id !== '__proto__') conversationSpaces[id] = space;
    }
  }
  return { spaces, conversationSpaces };
}

/** Removing a space only changes its assignments; conversation snapshots remain separate. */
export function withoutSpace(spaces: Record<string, ConversationSpace>, locations: Record<string, string>, id: string) {
  return {
    spaces: Object.fromEntries(Object.entries(spaces).filter(([key]) => key !== id)),
    conversationSpaces: Object.fromEntries(Object.entries(locations).filter(([, space]) => space !== id)),
  };
}
