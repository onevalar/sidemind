'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { useChatStore } from '../store';

const subscribe = (onChange: () => void) =>
  useChatStore.persist.onFinishHydration(onChange);
const getSnapshot = () => useChatStore.persist.hasHydrated();
const getServerSnapshot = () => false;

/**
 * Restores the saved conversation + settings from localStorage after the
 * first client render (so server HTML and first client render match).
 * Returns true once the store holds the restored state.
 */
export function useStoreHydrated(): boolean {
  useEffect(() => {
    void useChatStore.persist.rehydrate();
  }, []);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
