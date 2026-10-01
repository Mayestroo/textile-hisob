import React, { useEffect } from 'react';
import { useOnline } from '../../hooks/useOnline';
import { useSyncStore } from '../../store/syncStore';
import { useAuthStore } from '../../store/authStore';
import { useWorkbookStore } from '../../store/workbookStore';
import { isValidCompanyId } from '../../store/helpers/hydration';
import { getElectronApi, resolveElectronRuntimeMode, ElectronRuntimeModeResult } from '../../store/runtimeMode';
import { captureSessionIdentity, isSessionCurrent } from '../../store/sessionGuard';
import { Wifi, WifiOff, RefreshCw } from 'lucide-react';

export function resolveManualSyncCompany(authCompanyId: unknown, licenseCompanyId: unknown): string | undefined {
  if (!isValidCompanyId(licenseCompanyId)) return undefined;
  if (authCompanyId !== null && authCompanyId !== undefined && authCompanyId !== licenseCompanyId) return undefined;
  return licenseCompanyId;
}

export function allowsManualSync(runtime: ElectronRuntimeModeResult): boolean {
  return runtime.success && runtime.mode === 'sync';
}

export const ConnectionStatus: React.FC<{ style?: React.CSSProperties }> = ({ style }) => {
  const online = useOnline();
  const status = useSyncStore((s) => s.status);
  const pendingChanges = useSyncStore((s) => s.pendingChanges);
  const setPending = useSyncStore((s) => s.setPending);
  const setStatus = useSyncStore((s) => s.setStatus);
  const syncing = status === 'syncing';
  const authCompanyId = useAuthStore((s) => s.companyId);
  const licenseCompanyId = useWorkbookStore((s) => s.licenseStatus?.companyId);
  const activeCompanyId = resolveManualSyncCompany(authCompanyId, licenseCompanyId);
  const syncContextError = !isValidCompanyId(licenseCompanyId)
    ? 'Sinxronizatsiya bloklandi: faol litsenziya korxonasi aniqlanmadi.'
    : authCompanyId && authCompanyId !== licenseCompanyId
    ? 'Sinxronizatsiya bloklandi: autentifikatsiya va litsenziya korxonalari mos emas.'
    : null;

  const refreshPendingCount = async () => {
    const eAPI = getElectronApi();
    if (!activeCompanyId || typeof eAPI?.OutboxPending !== 'function') {
      setPending(0);
      return;
    }
    try {
      const result = await eAPI.OutboxPending({ companyId: activeCompanyId, limit: 1000 });
      if (result?.success) setPending(Array.isArray(result.pending) ? result.pending.length : 0);
    } catch {
      // Keep the last known local outbox count if the IPC read is temporarily unavailable.
    }
  };

  const handleManualSync = async () => {
    if (!online || syncing || !isValidCompanyId(activeCompanyId)) return;
    const initialLicenseStatus = useWorkbookStore.getState().licenseStatus;
    const session = captureSessionIdentity(activeCompanyId);
    const isCurrent = () => useWorkbookStore.getState().licenseStatus === initialLicenseStatus
      && isSessionCurrent(session, useWorkbookStore.getState().licenseStatus?.companyId || useAuthStore.getState().companyId)
      && useWorkbookStore.getState().licenseStatus?.companyId === activeCompanyId
      && (!useAuthStore.getState().companyId || useAuthStore.getState().companyId === activeCompanyId);
    try {
      const eAPI = getElectronApi();
      const runtime = await resolveElectronRuntimeMode(eAPI);
      if (!allowsManualSync(runtime) || !isCurrent() || typeof eAPI?.SyncReconnect !== 'function') return;
      setStatus('syncing');
      const result = await eAPI.SyncReconnect(activeCompanyId);
      if (!isCurrent()) return;
      setStatus(result?.success ? 'idle' : 'error', result?.error || result?.code);
      await refreshPendingCount();
    } catch (error) {
      setStatus('error', error instanceof Error ? error.message : 'VPS sync failed');
    }
  };

  useEffect(() => {
    void refreshPendingCount();
    const interval = setInterval(() => void refreshPendingCount(), 3000);
    return () => clearInterval(interval);
  }, [activeCompanyId]);

  return (
    <div
      onClick={handleManualSync}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 10px',
        borderRadius: 'var(--radius-full)',
        fontSize: '11.5px',
        fontWeight: 600,
        backgroundColor: online ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
        color: online ? '#6ee7b7' : '#fca5a5',
        border: `1px solid ${online ? 'rgba(52, 211, 153, 0.35)' : 'rgba(239, 68, 68, 0.35)'}`,
        backdropFilter: 'blur(8px)',
        transition: 'all 0.2s',
        userSelect: 'none',
        cursor: online && activeCompanyId ? 'pointer' : 'default',
        ...style
      }}
      title={syncContextError || (online
        ? syncing
          ? 'VPS bilan sinxronlanmoqda...'
          : pendingChanges > 0
          ? `${pendingChanges} ta o'zgarish navbatda. Bosing — VPS bilan qayta sinxronlash`
          : 'VPS tarmog‘i ulangan (Online)'
        : 'Tarmoq uzilgan (Oflayn rejim — o‘zgarishlar mahalliy navbatda saqlanadi)')}
    >
      {online ? (
        syncing ? <RefreshCw size={13} className="spin-animation" color="#6ee7b7" /> : <Wifi size={13} color="#6ee7b7" />
      ) : <WifiOff size={13} color="#fca5a5" />}
      <span>{online ? (syncing ? 'Sinxron...' : 'Online') : 'Oflayn'}</span>
      {pendingChanges > 0 && (
        <span style={{ marginLeft: '2px', background: 'var(--status-error)', color: '#fff', borderRadius: '10px', padding: '1px 5px', fontSize: '10px', fontWeight: 700 }}>
          {pendingChanges}
        </span>
      )}
    </div>
  );
};
