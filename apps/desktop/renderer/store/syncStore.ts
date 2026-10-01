/**
 * Sync Store — VPS sync status displayed by the desktop renderer.
 */

import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { SyncStatus, SyncInfo } from '../types/sync';

export interface SyncStore extends SyncInfo {
  setStatus: (status: SyncStatus, errorMessage?: string) => void;
  setOnline: (online: boolean) => void;
  setPending: (count: number) => void;
  setLastSyncedAt: (iso: string | null) => void;
  setServerConnected: (connected: boolean) => void;
  reset: () => void;
}

export const useSyncStore = create<SyncStore>((set) => ({
  status: 'idle',
  lastSyncedAt: null,
  pendingChanges: 0,
  online: typeof navigator !== 'undefined' ? navigator.onLine : true,
  isServerConnected: false,

  setStatus: (status, errorMessage) =>
    set({ status, errorMessage: errorMessage || undefined }),

  setOnline: (online) => set({ online }),

  setPending: (count) => set({ pendingChanges: count }),

  setLastSyncedAt: (iso) => set({ lastSyncedAt: iso }),

  setServerConnected: (connected) => set({ isServerConnected: connected }),

  reset: () =>
    set({
      status: 'idle',
      lastSyncedAt: null,
      pendingChanges: 0,
      errorMessage: undefined
    })
}));

export const useSyncStatus = () => useSyncStore((s) => s.status);
export const useSyncInfo = () => useSyncStore(useShallow((s) => ({
  status: s.status,
  online: s.online,
  pendingChanges: s.pendingChanges,
  lastSyncedAt: s.lastSyncedAt,
  isServerConnected: s.isServerConnected
})));
