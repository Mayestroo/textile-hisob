/**
 * useOnline — internet connection status
 * Phase 4 — Offline-first
 */

import { useEffect } from 'react';
import { useSyncStore } from '../store/syncStore';

export function useOnline(): boolean {
  const online = useSyncStore((s) => s.online);
  const setOnline = useSyncStore((s) => s.setOnline);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [setOnline]);

  return online;
}
