import React, { useEffect, useRef, useState } from 'react';
import { useOnline } from '../../hooks/useOnline';
import { useSyncStore } from '../../store/syncStore';
import { useAuthStore } from '../../store/authStore';
import { useWorkbookStore } from '../../store/workbookStore';
import { isValidCompanyId } from '../../store/helpers/hydration';
import { getElectronApi, resolveElectronRuntimeMode, ElectronRuntimeModeResult } from '../../store/runtimeMode';
import { captureSessionIdentity, isSessionCurrent } from '../../store/sessionGuard';
import { runReconnect } from '../../store/businessMutations';
import { Wifi, WifiOff, RefreshCw, AlertTriangle } from 'lucide-react';

export function resolveManualSyncCompany(authCompanyId: unknown, licenseCompanyId: unknown): string | undefined {
  if (!isValidCompanyId(licenseCompanyId)) return undefined;
  if (authCompanyId !== null && authCompanyId !== undefined && authCompanyId !== licenseCompanyId) return undefined;
  return licenseCompanyId;
}

export function allowsManualSync(runtime: ElectronRuntimeModeResult): boolean {
  return runtime.success && runtime.mode === 'sync';
}

export function summarizeFailedOutboxOperations(operations: unknown): string[] {
  if (!Array.isArray(operations)) return [];
  return operations.slice(0, 5).map((operation: any) => {
    const command = typeof operation?.command_type === 'string' ? operation.command_type : 'Buyruq';
    const reason = operation?.last_error || operation?.error_message || operation?.status || 'SYNC_FAILED';
    return `${command}: ${String(reason).replace(/[\r\n]+/g, ' ').slice(0, 180)}`;
  });
}

export const ConnectionStatus: React.FC<{ style?: React.CSSProperties }> = ({ style }) => {
  const online = useOnline();
  const status = useSyncStore((s) => s.status);
  const pendingChanges = useSyncStore((s) => s.pendingChanges);
  const failedChanges = useSyncStore((s) => s.failedChanges);
  const setPending = useSyncStore((s) => s.setPending);
  const setFailed = useSyncStore((s) => s.setFailed);
  const setStatus = useSyncStore((s) => s.setStatus);
  const isServerConnected = useWorkbookStore((s) => s.isServerConnected);
  const syncing = status === 'syncing';
  const [failedOperationDetails, setFailedOperationDetails] = useState<string[]>([]);
  const authCompanyId = useAuthStore((s) => s.companyId);
  const licenseCompanyId = useWorkbookStore((s) => s.licenseStatus?.companyId);
  const activeCompanyId = resolveManualSyncCompany(authCompanyId, licenseCompanyId);
  const syncContextError = !isValidCompanyId(licenseCompanyId)
    ? 'Sinxronizatsiya bloklandi: faol litsenziya korxonasi aniqlanmadi.'
    : authCompanyId && authCompanyId !== licenseCompanyId
    ? 'Sinxronizatsiya bloklandi: autentifikatsiya va litsenziya korxonalari mos emas.'
    : null;
  const syncInFlight = useRef(false);

  const refreshPendingCount = async () => {
    const eAPI = getElectronApi();
    if (!activeCompanyId || typeof eAPI?.OutboxPending !== 'function') {
      setPending(0);
      setFailed(0);
      setFailedOperationDetails([]);
      return;
    }
    try {
      if (typeof eAPI.OutboxDiagnostics === 'function') {
        const result = await eAPI.OutboxDiagnostics(activeCompanyId);
        if (!result?.success) return;
        const diagnostics = result.diagnostics || {};
        setPending(Number(diagnostics.pendingCount || 0) + Number(diagnostics.sendingCount || 0));
        setFailed(Number(diagnostics.conflictCount || 0) + Number(diagnostics.deadLetterCount || 0));
        setFailedOperationDetails(summarizeFailedOutboxOperations(diagnostics.failedOperations));
        return;
      }
      const result = await eAPI.OutboxPending({ companyId: activeCompanyId, limit: 1000 });
      if (result?.success) setPending(Array.isArray(result.pending) ? result.pending.length : 0);
    } catch {
      // Keep the last known local outbox count if the IPC read is temporarily unavailable.
    }
  };

  const synchronize = async (manual: boolean) => {
    if (!online || !isValidCompanyId(activeCompanyId) || syncInFlight.current || manual && syncing) return;
    syncInFlight.current = true;
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
      const result = await runReconnect(eAPI, activeCompanyId);
      if (!isCurrent()) return;
      useWorkbookStore.setState({ isServerConnected: Boolean(result?.success) });
      await refreshPendingCount();
      const failures = useSyncStore.getState().failedChanges;
      setStatus(result?.success && failures === 0 ? 'synced' : 'error',
        failures > 0 ? `${failures} ta outbox buyrug'i serverda rad etilgan yoki conflict bo'lgan.` : result?.error || result?.code);
    } catch (error) {
      useWorkbookStore.setState({ isServerConnected: false });
      setStatus('error', error instanceof Error ? error.message : 'VPS sync failed');
    } finally {
      syncInFlight.current = false;
    }
  };

  const handleManualSync = () => synchronize(true);

  useEffect(() => {
    void refreshPendingCount();
    const interval = setInterval(() => void refreshPendingCount(), 3000);
    return () => clearInterval(interval);
  }, [activeCompanyId]);

  // Pull remote changes periodically so an idle second/third workstation sees
  // updates without requiring a click or another local write.
  useEffect(() => {
    const timer = setInterval(() => {
      if (online && activeCompanyId) void synchronize(false);
    }, 15_000);
    return () => clearInterval(timer);
  }, [activeCompanyId, online]);

  const hasSyncFailures = failedChanges > 0;
  const hasPendingChanges = pendingChanges > 0;
  const statusColor = !online || hasSyncFailures
    ? '#fca5a5'
    : hasPendingChanges || !isServerConnected
      ? '#fde047'
      : '#6ee7b7';
  const statusBackground = !online || hasSyncFailures
    ? 'rgba(239, 68, 68, 0.15)'
    : hasPendingChanges || !isServerConnected
      ? 'rgba(245, 158, 11, 0.15)'
      : 'rgba(16, 185, 129, 0.15)';
  const statusBorder = !online || hasSyncFailures
    ? 'rgba(239, 68, 68, 0.35)'
    : hasPendingChanges || !isServerConnected
      ? 'rgba(251, 191, 36, 0.35)'
      : 'rgba(52, 211, 153, 0.35)';
  const statusTitle = syncContextError || (!online
    ? 'Tarmoq uzilgan: o‘zgarishlar lokal navbatda saqlanadi.'
    : hasSyncFailures
      ? `${failedChanges} ta buyruq conflict yoki rad javobi olgan.${failedOperationDetails.length ? `\n${failedOperationDetails.join('\n')}` : ' Outbox tafsilotlarini tekshiring.'}`
      : hasPendingChanges
        ? `${pendingChanges} ta o‘zgarish VPSga yuborish navbatida. Qayta sinxronlash uchun bosing.`
        : isServerConnected
          ? 'Oxirgi tekshiruvda VPS bilan sync xatosiz yakunlandi.'
          : 'Internet bor, lekin VPS bilan sync hali tasdiqlanmagan. Qayta sinxronlash uchun bosing.');

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
         backgroundColor: statusBackground,
         color: statusColor,
         border: `1px solid ${statusBorder}`,
        backdropFilter: 'blur(8px)',
        transition: 'all 0.2s',
        userSelect: 'none',
        cursor: online && activeCompanyId ? 'pointer' : 'default',
        ...style
      }}
       title={syncing ? 'VPS bilan sinxronlanmoqda…' : statusTitle}
    >
      {syncing
        ? <RefreshCw size={13} className="spin-animation" color={statusColor} />
        : !online
          ? <WifiOff size={13} color={statusColor} />
          : hasSyncFailures
            ? <AlertTriangle size={13} color={statusColor} />
            : <Wifi size={13} color={statusColor} />}
      <span>{syncing ? 'Sinxron...' : !online ? 'Oflayn' : hasSyncFailures ? 'Sync xatosi' : hasPendingChanges ? 'Navbatda' : isServerConnected ? 'Sinxron' : 'VPS?'}</span>
      {pendingChanges > 0 && (
        <span style={{ marginLeft: '2px', background: '#d97706', color: '#fff', borderRadius: '10px', padding: '1px 5px', fontSize: '10px', fontWeight: 700 }}>
          {pendingChanges}
        </span>
      )}
      {failedChanges > 0 && (
        <span style={{ marginLeft: '2px', background: '#dc2626', color: '#fff', borderRadius: '10px', padding: '1px 5px', fontSize: '10px', fontWeight: 700 }}>
          !{failedChanges}
        </span>
      )}
    </div>
  );
};
