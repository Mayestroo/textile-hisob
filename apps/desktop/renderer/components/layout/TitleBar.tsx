import React, { useEffect, useState, useMemo } from 'react';
import {
  Download, Database, Users, ShieldAlert,
  Clock, Code2, Sun, Moon, RefreshCw, ChevronLeft, ChevronRight,
  Wallet
} from 'lucide-react';
import { useWorkbookStore } from '../../store/workbookStore';
import { useAuthStore } from '../../store/authStore';
import { selectWorkerCount } from '../../store/selectors';
import { getElectronApi, resolveElectronRuntimeMode } from '../../store/runtimeMode';
import { useTrialCountdown } from '../../hooks/useTrialCountdown';
import { useOnline } from '../../hooks/useOnline';
import { useSyncStore } from '../../store/syncStore';
import { ConnectionStatus } from './ConnectionStatus';
import { resolveDatabaseStatusLabel, type DatabaseRuntimeMode } from '../../utils/statusFormatters';

const UZBEK_MONTH_NAMES = [
  'Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun',
  'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'
];

function formatPeriodHeader(period: { name?: string; startDate?: string }): string {
  if (period.startDate) {
    const parts = period.startDate.slice(0, 10).split('-');
    if (parts.length === 3) {
      const year = parts[0];
      const mIdx = parseInt(parts[1], 10) - 1;
      const month = UZBEK_MONTH_NAMES[mIdx] || parts[1];
      return `${year} — ${month}`;
    }
  }
  if (period.name) {
    const match = period.name.match(/^(\d{4})[-_\s]+([a-zA-Zа-яА-Я]+)/);
    if (match) return `${match[1]} — ${match[2]}`;
    return period.name;
  }
  return '2026 — Oktabr';
}

export const TitleBar: React.FC = () => {
  const workersCount = useWorkbookStore(selectWorkerCount);
  const currentPeriod = useWorkbookStore((s) => s.currentPeriod);
  const exportExcel = useWorkbookStore((s) => s.exportExcel);
  const addNotification = useWorkbookStore((s) => s.addNotification);
  const saveToDisk = useWorkbookStore((s) => s.saveToDisk);
  const isServerConnected = useWorkbookStore((s) => s.isServerConnected);
  const isSaving = useWorkbookStore((s) => s.isSaving);
  const pendingSyncChanges = useSyncStore((s) => s.pendingChanges);
  const failedSyncChanges = useSyncStore((s) => s.failedChanges);
  const openModal = useWorkbookStore((s) => s.openModal);
  const licenseStatus = useWorkbookStore((s) => s.licenseStatus);
  const canViewWorkers = useAuthStore((s) => s.permissions.includes('view:workers'));
  const availableUpdate = useWorkbookStore((s) => s.availableUpdate);
  const theme = useWorkbookStore((s) => s.theme);
  const toggleTheme = useWorkbookStore((s) => s.toggleTheme);
  const authRole = useAuthStore((s) => s.role || 'admin');
  const countdown = useTrialCountdown(licenseStatus);
  const online = useOnline();
  const [databaseRuntimeMode, setDatabaseRuntimeMode] = useState<DatabaseRuntimeMode>('checking');

  useEffect(() => {
    let active = true;
    void resolveElectronRuntimeMode(getElectronApi()).then((runtime) => {
      if (active) setDatabaseRuntimeMode(runtime.mode);
    });
    return () => {
      active = false;
    };
  }, []);

  const databaseStatusLabel = resolveDatabaseStatusLabel({
    runtimeMode: databaseRuntimeMode,
    online,
    isServerConnected,
    isSaving,
    pendingChanges: pendingSyncChanges,
    failedChanges: failedSyncChanges
  });
  const isSyncHealthy = isServerConnected && pendingSyncChanges === 0 && failedSyncChanges === 0;
  const syncHasFailures = failedSyncChanges > 0;

  const handleSave = async () => {
    const saved = await saveToDisk(undefined, { forceBackup: true });
    if (saved) {
      addNotification('success', 'Diskka Saqlandi', 'Barcha ma\'lumotlar diskdagi bazaga va Buxoro_Hisob_Oxirgi.xlsx fayliga saqlandi!');
    }
  };

  const isLicActive = licenseStatus?.isActivated;
  const periodDisplay = useMemo(() => formatPeriodHeader(currentPeriod), [currentPeriod]);
  const avatarLetter = (authRole === 'print' ? 'P' : authRole === 'type' ? 'T' : 'A').toUpperCase();

  return (
    <header className="excel-titlebar">
      <div className="excel-title-left">
        {/* Brand Logo & Name */}
        <div className="titlebar-brand">
          <div className="titlebar-brand-icon">
            <Wallet size={18} strokeWidth={2.4} />
          </div>
          <div className="titlebar-brand-text">
            <span className="titlebar-brand-title">Oylik</span>
            <span className="titlebar-brand-subtitle">hisobot</span>
          </div>
        </div>

        {/* Period Pill: < 2026 — Oktabr > */}
        <div className="titlebar-period-pill">
          <button
            type="button"
            className="titlebar-period-btn"
            title="Oylik davrini boshqarish"
            onClick={() => openModal({ type: 'period_manager' })}
          >
            <ChevronLeft size={14} />
          </button>
          <span
            className="titlebar-period-label"
            title="Oylik davrini boshqarish (bosish orqali ochish)"
            onClick={() => openModal({ type: 'period_manager' })}
          >
            {periodDisplay}
          </span>
          <button
            type="button"
            className="titlebar-period-btn"
            title="Oylik davrini boshqarish"
            onClick={() => openModal({ type: 'period_manager' })}
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      <div className="excel-title-right" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        {/* Subtle Utility Actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <button
            onClick={toggleTheme}
            className="titlebar-utility-btn"
            title={theme === 'dark' ? "Yorug' (Light) rejimga o'tish" : "Tungi (Dark) rejimga o'tish"}
          >
            {theme === 'dark' ? <Sun size={14} color="#fde047" /> : <Moon size={14} />}
          </button>

          {canViewWorkers && (
            <button
              onClick={() => openModal({ type: 'worker_manager' })}
              className="titlebar-utility-btn"
              title={`Ishchilar ro'yxati (${workersCount})`}
            >
              <Users size={14} />
            </button>
          )}

          <button
            onClick={() => openModal({ type: 'backup_manager' })}
            className="titlebar-utility-btn"
            title="Zaxiralar va Baza tarixi"
          >
            <Database size={14} />
          </button>

          <button
            onClick={() => openModal({ type: 'developer_info' })}
            className="titlebar-utility-btn"
            title="Dasturchi bilan bog'lanish"
          >
            <Code2 size={14} />
          </button>

          {/* License badge if trial or blocked */}
          {(!isLicActive || licenseStatus?.isTrial || licenseStatus?.isBlocked) && (
            <div
              onClick={() => openModal({ type: 'license_activation' })}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                fontSize: '11px',
                padding: '4px 8px',
                borderRadius: 'var(--radius-full)',
                cursor: 'pointer',
                fontWeight: 600,
                background: licenseStatus?.isBlocked ? 'rgba(239, 68, 68, 0.15)' : 'rgba(56, 189, 248, 0.15)',
                color: licenseStatus?.isBlocked ? '#fca5a5' : '#7dd3fc',
                border: `1px solid ${licenseStatus?.isBlocked ? 'rgba(239, 68, 68, 0.35)' : 'rgba(56, 189, 248, 0.35)'}`
              }}
              title="Litsenziya holati"
            >
              {licenseStatus?.isBlocked ? <ShieldAlert size={12} /> : <Clock size={12} />}
              <span>{licenseStatus?.isBlocked ? 'BLOKLANGAN' : countdown ? countdown.formattedClock : 'Sinov'}</span>
            </div>
          )}

          {/* Update dot if available */}
          {availableUpdate && (
            <button
              onClick={() => openModal({ type: 'app_update' })}
              className="titlebar-utility-btn"
              style={{ position: 'relative', color: '#10b981' }}
              title={`Yangi versiya: v${availableUpdate.version}`}
            >
              <RefreshCw size={14} />
              <span
                style={{
                  position: 'absolute',
                  top: '2px',
                  right: '2px',
                  width: '6px',
                  height: '6px',
                  backgroundColor: '#10b981',
                  borderRadius: '50%'
                }}
              />
            </button>
          )}
        </div>

        {/* Real-time Connection Status & Offline Queue */}
        <ConnectionStatus />

        {/* Status Pill: ● Sinxronlangan */}
        <div
          className="titlebar-status-pill"
          title={databaseRuntimeMode === 'sync'
            ? `Lokal SQLite · ${databaseStatusLabel}`
            : isServerConnected
              ? "Markaziy serverga ulangan (avtomatik sinxronizatsiya)"
              : "Lokal xotirada ishlamoqda"}
          onClick={() => openModal({ type: 'backup_manager' })}
          style={{ cursor: 'pointer' }}
        >
          <span
            className="titlebar-status-dot"
            style={{
              backgroundColor: syncHasFailures ? '#ef4444' : isSyncHealthy ? '#22c55e' : '#f59e0b'
            }}
          />
          <span>{databaseStatusLabel || 'Sinxronlangan'}</span>
        </div>

        {/* Excel Button: ⤓ Excel */}
        <button
          type="button"
          className="titlebar-excel-btn"
          title="Excel (.xlsx) yuklab olish"
          onClick={exportExcel}
        >
          <Download size={13} strokeWidth={2.4} />
          <span>Excel</span>
        </button>

        {/* Saqlash Button: solid dark green */}
        <button
          type="button"
          className="titlebar-save-btn"
          title="Diskdagi bazaga saqlash (Ctrl+S)"
          onClick={handleSave}
        >
          <span>Saqlash</span>
        </button>

        {/* User Profile Avatar: (A) */}
        <div
          className="titlebar-avatar"
          title={`Foydalanuvchi: ${authRole === 'admin' ? 'Admin' : authRole === 'print' ? 'Chop etuvchi' : authRole === 'type' ? 'Kirituvchi' : 'Foydalanuvchi'}`}
          onClick={() => openModal({ type: 'developer_info' })}
        >
          {avatarLetter}
        </div>
      </div>
    </header>
  );
};
