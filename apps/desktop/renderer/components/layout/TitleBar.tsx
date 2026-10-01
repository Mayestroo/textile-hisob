import React, { useEffect, useState } from 'react';
import { Save, Download, Database, Users, Calendar, ShieldCheck, ShieldAlert, Clock, Code2, Sun, Moon, Building2, RefreshCw } from 'lucide-react';
import { useWorkbookStore } from '../../store/workbookStore';
import { selectWorkerCount } from '../../store/selectors';
import { getElectronApi, resolveElectronRuntimeMode } from '../../store/runtimeMode';
import { useTrialCountdown } from '../../hooks/useTrialCountdown';
import { useOnline } from '../../hooks/useOnline';
import { RoleBadge } from '../ui/RoleBadge';
import { ConnectionStatus } from './ConnectionStatus';
import { resolveDatabaseStatusLabel, type DatabaseRuntimeMode } from '../../utils/statusFormatters';

export const TitleBar: React.FC = () => {
  const workersCount = useWorkbookStore(selectWorkerCount);
  const currentPeriod = useWorkbookStore((s) => s.currentPeriod);
  const exportExcel = useWorkbookStore((s) => s.exportExcel);
  const addNotification = useWorkbookStore((s) => s.addNotification);
  const saveToDisk = useWorkbookStore((s) => s.saveToDisk);
  const isServerConnected = useWorkbookStore((s) => s.isServerConnected);
  const isSaving = useWorkbookStore((s) => s.isSaving);
  const openModal = useWorkbookStore((s) => s.openModal);
  const licenseStatus = useWorkbookStore((s) => s.licenseStatus);
  const availableUpdate = useWorkbookStore((s) => s.availableUpdate);
  const theme = useWorkbookStore((s) => s.theme);
  const toggleTheme = useWorkbookStore((s) => s.toggleTheme);
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
    isSaving
  });

  const handleSave = async () => {
    const saved = await saveToDisk(undefined, { forceBackup: true });
    if (saved) {
      addNotification('success', 'Diskka Saqlandi', 'Barcha ma\'lumotlar diskdagi bazaga va Buxoro_Hisob_Oxirgi.xlsx fayliga saqlandi!');
    }
  };

  const isLicActive = licenseStatus?.isActivated;

  return (
    <header className="excel-titlebar">
      <div className="excel-title-left">
        <div className="quick-actions">
          {/* Period Button */}
          <button 
            className="quick-btn" 
            title="Oylik davrini boshqarish va oyni yopish" 
            onClick={() => openModal({ type: 'period_manager' })}
          >
            <Calendar size={14} color="#a7f3d0" />
            <span>{currentPeriod.name || 'Joriy Oylik'}</span>
          </button>

          {/* Workers Button */}
          <button 
            className="quick-btn" 
            title="Ishchilar ro'yxati va doimiy stajlar" 
            onClick={() => openModal({ type: 'worker_manager' })}
          >
            <Users size={14} color="#a7f3d0" />
            <span>Ishchilar ({workersCount})</span>
          </button>
          
          <button className="quick-btn" title="Excel (.xlsx) yuklab olish" onClick={exportExcel}>
            <Download size={14} />
          </button>

          <button className="quick-btn" title="Zaxiralar va Baza tarixi" onClick={() => openModal({ type: 'backup_manager' })}>
            <Database size={14} />
          </button>

          <button 
            className="quick-btn" 
            title="Diskdagi bazaga saqlash (Ctrl+S)" 
            onClick={handleSave}
            style={{ 
              background: 'rgba(16, 185, 129, 0.22)', 
              borderColor: 'rgba(52, 211, 153, 0.4)',
              color: '#6ee7b7'
            }}
          >
            <Save size={14} color="#6ee7b7" />
            <span>Saqlash</span>
          </button>
        </div>
      </div>

      <div className="excel-title-right">
        {/* Dark / Light Mode Toggle (Icon only) */}
        <button
          onClick={toggleTheme}
          className="quick-btn"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '28px',
            height: '28px',
            background: 'rgba(255, 255, 255, 0.08)',
            border: '1px solid rgba(255, 255, 255, 0.18)',
            borderRadius: 'var(--radius-full)',
            padding: 0,
            cursor: 'pointer',
            backdropFilter: 'blur(8px)',
            transition: 'all 0.2s'
          }}
          title={theme === 'dark' ? "Yorug' (Light) rejimga o'tish" : "Tungi (Dark) rejimga o'tish"}
        >
          {theme === 'dark' ? <Sun size={14} color="#fde047" /> : <Moon size={14} color="#cbd5e1" />}
        </button>

        {/* Role Badge (RBAC) */}
        <RoleBadge />

        {/* Real-time Connection Status & Offline Queue */}
        <ConnectionStatus />


        {/* License / Trial Badge */}
        <div
          onClick={() => openModal({ type: 'license_activation' })}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '11.5px',
            background: licenseStatus?.isBlocked
              ? 'rgba(239, 68, 68, 0.15)'
              : isLicActive && !licenseStatus?.isTrial
              ? 'rgba(16, 185, 129, 0.15)'
              : licenseStatus?.isTrial
              ? 'rgba(56, 189, 248, 0.15)'
              : 'rgba(239, 68, 68, 0.15)',
            border: licenseStatus?.isBlocked
              ? '1px solid rgba(239, 68, 68, 0.35)'
              : isLicActive && !licenseStatus?.isTrial
              ? '1px solid rgba(52, 211, 153, 0.35)'
              : licenseStatus?.isTrial
              ? '1px solid rgba(56, 189, 248, 0.35)'
              : '1px solid rgba(239, 68, 68, 0.35)',
            padding: '4px 10px',
            borderRadius: 'var(--radius-full)',
            cursor: 'pointer',
            fontWeight: 600,
            color: licenseStatus?.isBlocked
              ? '#fca5a5'
              : isLicActive && !licenseStatus?.isTrial
              ? '#6ee7b7'
              : licenseStatus?.isTrial
              ? '#7dd3fc'
              : '#fca5a5',
            backdropFilter: 'blur(8px)',
            transition: 'all 0.2s'
          }}
          title={
            licenseStatus?.isTrial && countdown
              ? `Sinov muddati: ${countdown.formattedText} qoldi`
              : "Litsenziya holatini ko'rish va boshqarish"
          }
        >
          {licenseStatus?.isBlocked ? (
            <ShieldAlert size={13} color="#fca5a5" />
          ) : isLicActive && !licenseStatus?.isTrial ? (
            <ShieldCheck size={13} color="#6ee7b7" />
          ) : licenseStatus?.isTrial ? (
            <Clock size={13} color="#7dd3fc" />
          ) : (
            <ShieldAlert size={13} color="#fca5a5" />
          )}
          <span>
            {licenseStatus?.isBlocked
              ? 'BLOKLANGAN'
              : isLicActive && !licenseStatus?.isTrial
              ? (licenseStatus?.isLifetime ? 'Litsenziya: Faol' : `Litsenziya: ${licenseStatus?.expiry}`)
              : licenseStatus?.isTrial
              ? `Sinov: ${countdown ? countdown.formattedClock : (licenseStatus.remainingText || '24 soat')}`
              : 'Aktivatsiya kutilmoqda'}
          </span>
        </div>

        {/* Korxona (Sex) Badge */}
        {licenseStatus?.companyName && (
          <div
            className="quick-btn"
            style={{
              background: 'rgba(99, 102, 241, 0.12)',
              border: '1px solid rgba(129, 140, 248, 0.3)',
              borderRadius: 'var(--radius-full)',
              padding: '4px 10px',
              color: '#a5b4fc',
              fontSize: '11px',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: '5px',
              cursor: 'default'
            }}
            title={`Ulangan korxona: ${licenseStatus.companyName} (${licenseStatus.companyId || 'company_main'})`}
          >
            <Building2 size={12} color="#a5b4fc" />
            <span>{licenseStatus.companyName}</span>
          </div>
        )}

        {/* Developer Button */}
        <button
          onClick={() => openModal({ type: 'developer_info' })}
          className="quick-btn"
          style={{
            background: 'rgba(2, 132, 199, 0.15)',
            border: '1px solid rgba(56, 189, 248, 0.35)',
            borderRadius: 'var(--radius-full)',
            padding: '4px 10px',
            color: '#7dd3fc'
          }}
          title="Dasturchi bilan bog'lanish va buyurtma xizmatlari"
        >
          <Code2 size={13} color="#7dd3fc" />
          <span>Dasturchi</span>
        </button>

        {/* Database Status Chip */}
        <div 
          onClick={() => openModal({ type: 'backup_manager' })}
          style={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: '6px', 
            fontSize: '11.5px', 
            background: isServerConnected ? 'rgba(16, 185, 129, 0.12)' : 'rgba(245, 158, 11, 0.12)', 
            border: `1px solid ${isServerConnected ? 'rgba(52, 211, 153, 0.3)' : 'rgba(251, 191, 36, 0.3)'}`,
            padding: '4px 10px', 
            borderRadius: 'var(--radius-full)',
            cursor: 'pointer',
            fontWeight: 600,
            color: isServerConnected ? '#6ee7b7' : '#fde047',
            backdropFilter: 'blur(8px)'
          }}
          title={databaseRuntimeMode === 'sync'
            ? `Kanonik ma'lumotlar  SQLite bazasida saqlanadi · ${databaseStatusLabel}`
            : isServerConnected
              ? "Markaziy serverga ulangan (avtomatik sinxronizatsiya)"
              : "Lokal xotirada ishlamoqda"}
        >
          <span style={{ 
            width: '6px', 
            height: '6px', 
            borderRadius: '50%', 
            backgroundColor: isServerConnected ? '#10b981' : '#f59e0b',
            boxShadow: isServerConnected ? '0 0 6px rgba(16, 185, 129, 0.5)' : '0 0 6px rgba(245, 158, 11, 0.5)'
          }} />
          <span>{databaseStatusLabel}</span>
        </div>

        {/* Update Check / Status Icon Button */}
        <button
          onClick={() => openModal({ type: 'app_update' })}
          className="quick-btn"
          style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '28px',
            height: '28px',
            padding: 0,
            borderRadius: 'var(--radius-full)',
            background: availableUpdate ? 'rgba(16, 185, 129, 0.22)' : 'rgba(255, 255, 255, 0.08)',
            border: availableUpdate ? '1px solid rgba(52, 211, 153, 0.65)' : '1px solid rgba(255, 255, 255, 0.18)',
            color: availableUpdate ? '#34d399' : '#cbd5e1',
            cursor: 'pointer',
            transition: 'all 0.2s',
            backdropFilter: 'blur(8px)',
            boxShadow: availableUpdate ? '0 0 10px rgba(16, 185, 129, 0.45)' : 'none'
          }}
          title={availableUpdate ? `Yangi versiya mavjud: v${availableUpdate.version}. Bosib yangilang.` : "Dastur yangilanishlarini tekshirish"}
        >
          <RefreshCw size={14} color={availableUpdate ? '#34d399' : '#cbd5e1'} />
          {/* Notification dot badge when update is available */}
          {availableUpdate && (
            <span
              style={{
                position: 'absolute',
                top: '-2px',
                right: '-2px',
                width: '9px',
                height: '9px',
                backgroundColor: '#10b981',
                borderRadius: '50%',
                border: '2px solid #0f172a',
                boxShadow: '0 0 6px #10b981'
              }}
            />
          )}
        </button>
      </div>
    </header>
  );
};
