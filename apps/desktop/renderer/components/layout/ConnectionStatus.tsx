import React, { useEffect, useRef, useState } from 'react';
import { useOnline } from '../../hooks/useOnline';
import { useSyncStore } from '../../store/syncStore';
import { useAuthStore } from '../../store/authStore';
import { useWorkbookStore } from '../../store/workbookStore';
import { isValidCompanyId } from '../../store/helpers/hydration';
import { getElectronApi, resolveElectronRuntimeMode, ElectronRuntimeModeResult } from '../../store/runtimeMode';
import { captureSessionIdentity, isSessionCurrent } from '../../store/sessionGuard';
import { preserveWorkbookProjectionDrafts, reloadWorkbookProjection, runReconnect, runSyncPull } from '../../store/businessMutations';
import { Wifi, WifiOff, RefreshCw, AlertTriangle } from 'lucide-react';

export const BACKGROUND_CHANGE_POLL_INTERVAL_MS = 2_000;

export function resolveManualSyncCompany(authCompanyId: unknown, licenseCompanyId: unknown): string | undefined {
  if (!isValidCompanyId(licenseCompanyId)) return undefined;
  if (authCompanyId !== null && authCompanyId !== undefined && authCompanyId !== licenseCompanyId) return undefined;
  return licenseCompanyId;
}

export function allowsManualSync(runtime: ElectronRuntimeModeResult): boolean {
  return runtime.success && runtime.mode === 'sync';
}

export function isEditableInputTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as { tagName?: unknown; isContentEditable?: unknown };
  const tagName = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : '';
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(tagName) || element.isContentEditable === true;
}

export function shouldRunBackgroundSync(online: boolean, hasCompany: boolean, documentVisible: boolean): boolean {
  return online && hasCompany && documentVisible;
}

export function summarizeFailedOutboxOperations(operations: unknown): string[] {
  if (!Array.isArray(operations)) return [];
  return operations.slice(0, 5).map((operation: any) => {
    const command = typeof operation?.command_type === 'string' ? operation.command_type : 'Buyruq';
    const reason = operation?.last_error || operation?.error_message || operation?.status || 'SYNC_FAILED';
    return `${command}: ${String(reason).replace(/[\r\n]+/g, ' ').slice(0, 180)}`;
  });
}

export function summarizeReconnectFailure(result: any, pendingCount = 0): string | undefined {
  if (result?.success !== true) {
    const message = typeof result?.error === 'string'
      ? result.error
      : typeof result?.error?.message === 'string'
        ? result.error.message
        : result?.code;
    return `Sinxronlash bajarilmadi${message ? `: ${message}` : '.'}`;
  }

  const push = result?.result?.pushed;
  if (!push || typeof push !== 'object') {
    return pendingCount > 0
      ? `${pendingCount} ta navbatdagi buyruq bor, lekin sinxronlash natijasida yuborish holati qaytmadi.`
      : undefined;
  }

  const count = (value: unknown) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
  const transientErrors = count(push.transientErrors);
  if (transientErrors) {
    return `VPSga yuborishda vaqtinchalik xato (${transientErrors} ta buyruq): ${push.error || 'tarmoq so‘rovi bajarilmadi'}`;
  }

  const reauth = count(push.operatorReauthRequired);
  if (reauth) return `${reauth} ta buyruq uchun operator seansini qayta tasdiqlash kerak.`;

  const blocked = count(push.blockedCount);
  if (blocked) return `${blocked} ta buyruq oldingi sinxronlanmagan buyruqqa bog‘liq bo‘lgani uchun to‘xtab turibdi.`;

  const attempted = count(push.attempted);
  const accounted = count(push.synced) + count(push.conflict) + count(push.deadLetter) + reauth;
  if (attempted > accounted) {
    return `${attempted - accounted} ta yuborilgan buyruq uchun serverdan natija olinmadi.`;
  }

  if (pendingCount > 0 && attempted === 0) {
    return `${pendingCount} ta buyruq lokal navbatda bor, ammo yuborish uchun outbox’dan olinmadi.`;
  }

  return undefined;
}

export const ConnectionStatus: React.FC<{ style?: React.CSSProperties }> = ({ style }) => {
  const online = useOnline();
  const status = useSyncStore((s) => s.status);
  const errorMessage = useSyncStore((s) => s.errorMessage);
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
  const pullInFlight = useRef(false);
  const projectionDirty = useRef(false);
  const pullContinuationTimer = useRef<number | undefined>(undefined);

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
        setFailedOperationDetails([
          ...summarizeFailedOutboxOperations(diagnostics.failedOperations),
          ...summarizeFailedOutboxOperations(diagnostics.pendingErrors)
        ].slice(0, 5));
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
      if (manual) setStatus('syncing');
       const result = await runReconnect(eAPI, activeCompanyId);
       if (!isCurrent()) return;
       if (result?.success) {
         try {
           const refreshed = await reloadWorkbookProjection(eAPI, activeCompanyId);
           if (!isCurrent()) return;
           const safeProjection = preserveWorkbookProjectionDrafts(
             refreshed,
             useWorkbookStore.getState(),
             isEditableInputTarget(document.activeElement)
           );
            const { companyId: _projectionCompanyId, ...workbookProjection } = safeProjection;
            useWorkbookStore.setState({ ...workbookProjection, isServerConnected: true });
            projectionDirty.current = false;
         } catch {
           useWorkbookStore.setState({ isServerConnected: true });
         }
       } else {
         useWorkbookStore.setState({ isServerConnected: false });
       }
       await refreshPendingCount();
      const failures = useSyncStore.getState().failedChanges;
      const pending = useSyncStore.getState().pendingChanges;
      const reconnectFailure = summarizeReconnectFailure(result, pending);
      const error = failures > 0
        ? `${failures} ta outbox buyrug'i serverda rad etilgan yoki conflict bo'lgan.`
        : reconnectFailure;
      setStatus(result?.success && failures === 0 && !reconnectFailure ? 'synced' : 'error', error);
    } catch (error) {
      useWorkbookStore.setState({ isServerConnected: false });
      setStatus('error', error instanceof Error ? error.message : 'VPS sync failed');
    } finally {
      syncInFlight.current = false;
    }
  };

  const pullRemoteChanges = async () => {
    if (!online || !isValidCompanyId(activeCompanyId) || syncInFlight.current || pullInFlight.current) return;
    pullInFlight.current = true;
    const initialLicenseStatus = useWorkbookStore.getState().licenseStatus;
    const session = captureSessionIdentity(activeCompanyId);
    const isCurrent = () => useWorkbookStore.getState().licenseStatus === initialLicenseStatus
      && isSessionCurrent(session, useWorkbookStore.getState().licenseStatus?.companyId || useAuthStore.getState().companyId)
      && useWorkbookStore.getState().licenseStatus?.companyId === activeCompanyId
      && (!useAuthStore.getState().companyId || useAuthStore.getState().companyId === activeCompanyId);
    try {
      const eAPI = getElectronApi();
      const runtime = await resolveElectronRuntimeMode(eAPI);
      if (!allowsManualSync(runtime) || !isCurrent() || typeof eAPI?.SyncPull !== 'function') return;

      const response = await runSyncPull(eAPI, activeCompanyId);
      if (!isCurrent()) return;
      if (response?.success !== true || response.result?.success !== true) {
        if (useWorkbookStore.getState().isServerConnected) {
          useWorkbookStore.setState({ isServerConnected: false });
        }
        return;
      }

      const result = response.result;
      const pulledCount = Number(result.pulledCount ?? result.applied?.appliedCount ?? 0);
      const nextPattaNumber = Number(result.nextPattaNumber ?? result.pull?.nextPattaNumber);
      if (pulledCount > 0
        || (Number.isSafeInteger(nextPattaNumber) && nextPattaNumber !== useWorkbookStore.getState().nextPattaNumber)) {
        projectionDirty.current = true;
      }
      if (result.hasMore === true) {
        if (!useWorkbookStore.getState().isServerConnected) {
          useWorkbookStore.setState({ isServerConnected: true });
        }
        if (pullContinuationTimer.current === undefined) {
          pullContinuationTimer.current = window.setTimeout(() => {
            pullContinuationTimer.current = undefined;
            void pullRemoteChanges();
          }, 150);
        }
        return;
      }
      if (!projectionDirty.current) {
        if (!useWorkbookStore.getState().isServerConnected) {
          useWorkbookStore.setState({ isServerConnected: true });
        }
        return;
      }

      const refreshed = await reloadWorkbookProjection(eAPI, activeCompanyId);
      if (!isCurrent()) return;
      const safeProjection = preserveWorkbookProjectionDrafts(
        refreshed,
        useWorkbookStore.getState(),
        isEditableInputTarget(document.activeElement)
      );
      const { companyId: _projectionCompanyId, ...workbookProjection } = safeProjection;
      useWorkbookStore.setState({ ...workbookProjection, isServerConnected: true });
      projectionDirty.current = false;
    } catch {
      if (isCurrent() && useWorkbookStore.getState().isServerConnected) {
        useWorkbookStore.setState({ isServerConnected: false });
      }
    } finally {
      pullInFlight.current = false;
    }
  };

  const handleManualSync = () => synchronize(true);

  useEffect(() => {
    void refreshPendingCount();
    const interval = setInterval(() => void refreshPendingCount(), 3000);
    return () => clearInterval(interval);
  }, [activeCompanyId]);

  // Periodically run the full protocol to flush/recover local outbox operations.
  useEffect(() => {
    const syncWhileVisible = () => {
      if (!shouldRunBackgroundSync(online, Boolean(activeCompanyId), document.visibilityState === 'visible')) return;
      void synchronize(false);
    };
    const timer = setInterval(syncWhileVisible, 15_000);
    // Let the ticket/batch draft persistence debounce finish before the full reconnect.
    const handleFocusOut = () => window.setTimeout(syncWhileVisible, 1_500);
    document.addEventListener('focusout', handleFocusOut);
    return () => {
      clearInterval(timer);
      document.removeEventListener('focusout', handleFocusOut);
    };
  }, [activeCompanyId, online]);

  // Pull-only polling keeps other PCs' committed changes visible within two
  // seconds without dispatching local outbox work on every poll.
  useEffect(() => {
    projectionDirty.current = false;
    const pullWhileVisible = () => {
      if (!shouldRunBackgroundSync(online, Boolean(activeCompanyId), document.visibilityState === 'visible')) return;
      void pullRemoteChanges();
    };
    const timer = setInterval(pullWhileVisible, BACKGROUND_CHANGE_POLL_INTERVAL_MS);
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') pullWhileVisible();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    pullWhileVisible();
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (pullContinuationTimer.current !== undefined) {
        window.clearTimeout(pullContinuationTimer.current);
        pullContinuationTimer.current = undefined;
      }
    };
  }, [activeCompanyId, online]);

  const hasSyncFailures = failedChanges > 0;
  const hasSyncError = hasSyncFailures || status === 'error';
  const hasPendingChanges = pendingChanges > 0;
  const statusColor = !online || hasSyncError
    ? '#fca5a5'
    : hasPendingChanges || !isServerConnected
      ? '#fde047'
      : '#6ee7b7';
  const statusBackground = !online || hasSyncError
    ? 'rgba(239, 68, 68, 0.15)'
    : hasPendingChanges || !isServerConnected
      ? 'rgba(245, 158, 11, 0.15)'
      : 'rgba(16, 185, 129, 0.15)';
  const statusBorder = !online || hasSyncError
    ? 'rgba(239, 68, 68, 0.35)'
    : hasPendingChanges || !isServerConnected
      ? 'rgba(251, 191, 36, 0.35)'
      : 'rgba(52, 211, 153, 0.35)';
  const statusTitle = syncContextError || (!online
    ? 'Tarmoq uzilgan: o‘zgarishlar lokal navbatda saqlanadi.'
    : hasSyncFailures
      ? `${failedChanges} ta buyruq conflict yoki rad javobi olgan.${failedOperationDetails.length ? `\n${failedOperationDetails.join('\n')}` : ' Outbox tafsilotlarini tekshiring.'}`
      : status === 'error'
        ? `${errorMessage || 'Sinxronlash xatosi aniqlandi.'}${failedOperationDetails.length ? `\n${failedOperationDetails.join('\n')}` : ''}`
        : hasPendingChanges
          ? `${pendingChanges} ta o‘zgarish VPSga yuborish navbatida. Qayta sinxronlash uchun bosing.${failedOperationDetails.length ? `\n${failedOperationDetails.join('\n')}` : ''}`
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
          : hasSyncError
            ? <AlertTriangle size={13} color={statusColor} />
            : <Wifi size={13} color={statusColor} />}
      <span>{syncing ? 'Sinxron...' : !online ? 'Oflayn' : hasSyncError ? 'Sync xatosi' : hasPendingChanges ? 'Navbatda' : isServerConnected ? 'Sinxron' : 'VPS?'}</span>
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
