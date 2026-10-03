import React, { useState, useEffect } from 'react';
import { useWorkbookStore } from '../../../store/workbookStore';
import { useAuthStore } from '../../../store/authStore';
import { isValidCompanyId } from '../../../store/helpers/hydration';
import { getElectronApi, resolveElectronRuntimeMode } from '../../../store/runtimeMode';
import { X, Database, RotateCcw, Clock, Star, ShieldCheck, Server } from 'lucide-react';
import { formatTicketDateTime } from '../../../utils/formatters';

interface BackupItem {
  filename: string;
  size: number;
  createdAt: string;
  isArchive?: boolean;
  filledOpsCount?: number;
  workersCount?: number;
  modelsCount?: number;
}

export async function requestBackupRestore(
  electronApi: { backupRestore?: (filename: string, companyId: string) => Promise<any> },
  filename: string,
  companyId: string | undefined
) {
  if (!isValidCompanyId(companyId)) throw new Error('Active company context is required');
  if (!electronApi.backupRestore) throw new Error('Backup restore API is unavailable');
  return electronApi.backupRestore(filename, companyId);
}

export const BackupManagerModal: React.FC = () => {
  const modalType = useWorkbookStore((s) => s.modalState.type);
  const closeModal = useWorkbookStore((s) => s.closeModal);
  const addNotification = useWorkbookStore((s) => s.addNotification);
  const initStore = useWorkbookStore((s) => s.initStore);
  const setLoadingMessage = useWorkbookStore((s) => s.setLoadingMessage);
  const licenseStatus = useWorkbookStore((s) => s.licenseStatus);
  const authCompanyId = useAuthStore((s) => s.companyId);
  const restoreFromVps = useWorkbookStore((s) => s.restoreFromVps);
  const confirmAction = useWorkbookStore((s) => s.confirmAction);

  const [backups, setBackups] = useState<BackupItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isServerRestoring, setIsServerRestoring] = useState(false);

  const activeCompanyId = licenseStatus?.companyId || authCompanyId || undefined;
  const activeCompanyName = licenseStatus?.companyName || activeCompanyId || 'Biriktirilmagan';

  useEffect(() => {
    if (modalType === 'backup_manager') {
      fetchBackups();
    }
  }, [modalType]);

  const handleServerRestore = async () => {
    if (!isValidCompanyId(activeCompanyId)) {
      addNotification('warning', 'Korxona yo\'q', 'Ushbu kompyuterga hali korxona biriktirilmagan!');
      return;
    }

    const ok = await confirmAction({
      title: 'VPS serverdan tiklash',
      message: `[${activeCompanyName}] korxonasining so'nggi kanonik VPS ma'lumotlarini ushbu kompyuterga qayta yuklaysizmi?`,
      confirmText: "Tiklash",
      isDanger: true
    });

    if (!ok) {
      return;
    }

    setIsServerRestoring(true);
    closeModal();
    try {
      await restoreFromVps(activeCompanyId);
    } finally {
      setIsServerRestoring(false);
    }
  };

  const fetchBackups = async () => {
    setIsLoading(true);
    const eAPI = getElectronApi();
    const runtime = await resolveElectronRuntimeMode(eAPI);
    if (runtime.mode === 'sync') {
      setBackups([]);
      setIsLoading(false);
      return;
    }

    if (eAPI && eAPI.backupsList) {
      try {
        const res = await eAPI.backupsList();
        if (res.success && res.backups) {
          setBackups(res.backups);
          setIsLoading(false);
          return;
        }
      } catch (err) {
        console.warn('IPC backups-list failed', err);
      }
    }

    setBackups([]);
    setIsLoading(false);
  };

  const handleRestore = async (filename: string) => {
    const ok = await confirmAction({
      title: "Zaxira nusxasini tiklash",
      message: "Haqiqatan ham ushbu zaxira nusxasini tiklamoqchimisiz?\n\nJoriy o'zgarishlar ushbu zaxiradagi holatga qaytariladi.",
      confirmText: "Tiklash",
      isDanger: true
    });
    if (!ok) return;

    const runtime = await resolveElectronRuntimeMode(getElectronApi());
    if (runtime.mode === 'sync') {
      addNotification('error', runtime.code || '_LEGACY_STORAGE_FORBIDDEN', runtime.error || ' backup restore is unavailable.');
      return;
    }
    
    setLoadingMessage("Zaxira nusxasi tiklanmoqda...");
    closeModal();

    try {
      const eAPI = getElectronApi();

      if (eAPI && eAPI.backupRestore) {
        const res = await requestBackupRestore(eAPI, filename, activeCompanyId);
        if (res.success) {
          await initStore();
          addNotification('success', 'Tiklandi', `Zaxira nusxasi muvaffaqiyatli tiklandi!`);
          return;
        } else {
          addNotification('error', 'Xatolik', res.error || 'Tiklashda xatolik yuz berdi');
          return;
        }
      }

      addNotification('error', 'Xatolik', 'Zaxira nusxasini tiklash uchun desktop ilova talab qilinadi.');
    } catch (err: any) {
      addNotification('error', 'Xatolik', err.message || 'Tiklashda xatolik yuz berdi');
    } finally {
      setTimeout(() => {
        setLoadingMessage(null);
      }, 400);
    }
  };

  const formatDisplayTime = (b: BackupItem) => {
    const matchLocal = b.filename.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
    if (matchLocal) {
      const [, y, m, d, hh, mm, ss] = matchLocal;
      return formatTicketDateTime(`${y}-${m}-${d}T${hh}:${mm}:${ss}`);
    }

    const matchIso = b.filename.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    if (matchIso) {
      const [, y, m, d, hh, mm, ss] = matchIso;
      return formatTicketDateTime(`${y}-${m}-${d}T${hh}:${mm}:${ss}Z`);
    }

    if (b.createdAt) return formatTicketDateTime(b.createdAt);
    return b.filename;
  };

  if (modalType !== 'backup_manager') return null;

  return (
    <div className="modal-overlay" onClick={closeModal}>
      <div className="modal-card" style={{ maxWidth: '680px' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--primary)' }}>
            <Database size={20} />
            <span style={{ fontWeight: 800 }}>Doimiy Zaxiralar & Baza Tarixi</span>
          </div>
          <button
            onClick={closeModal}
            className="soft-btn soft-btn-secondary"
            style={{ width: '32px', height: '32px', padding: 0, borderRadius: 'var(--radius-full)' }}
          >
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div style={{
            fontSize: '12.5px',
            color: 'var(--text-secondary)',
            background: 'var(--primary-light)',
            padding: '12px 16px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid rgba(16, 185, 129, 0.25)'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700, color: 'var(--primary)', marginBottom: '4px' }}>
              <ShieldCheck size={16} />
              <span>Avtomatik xavfsizlik himoyasi:</span>
            </div>
            <div>Har bir asosiy amal (jonatish, qaytarish, yangi operatsiya) da to'liq zaxira saqlanadi.</div>
            <div style={{ marginTop: '2px', color: 'var(--text-muted)', fontSize: '11.5px' }}>
              Istalgan zaxira yonidagi <strong>"Tiklash"</strong> tugmasini bosib, o'sha paytdagi ma'lumotlarni qaytarib olishingiz mumkin.
            </div>
          </div>

          {/* VPS Disaster Recovery Card */}
          <div
            style={{
              fontSize: '12.5px',
              color: 'var(--text-secondary)',
              background: 'rgba(59, 130, 246, 0.07)',
              padding: '12px 16px',
              borderRadius: 'var(--radius-md)',
              border: '1px solid rgba(59, 130, 246, 0.25)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px'
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700, color: '#2563eb', marginBottom: '3px' }}>
                <Server size={16} />
                <span>VPS serverdan tiklash:</span>
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-primary)' }}>
                Biriktirilgan korxona: <strong style={{ color: '#2563eb' }}>{activeCompanyName}</strong> {activeCompanyId ? `(${activeCompanyId})` : ''}
              </div>
              <div style={{ marginTop: '2px', color: 'var(--text-muted)', fontSize: '11px', lineHeight: 1.4 }}>
                Agar kompyuter bazasi o'chib ketgan bo'lsa, ushbu korxonaning kanonik ma'lumotlarini VPS serverdan qayta yuklang.
              </div>
            </div>

            <button
              onClick={handleServerRestore}
              disabled={!activeCompanyId || activeCompanyId === 'unassigned' || isServerRestoring}
              className="soft-btn"
              style={{
                background: 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)',
                color: '#ffffff',
                borderRadius: 'var(--radius-full)',
                padding: '8px 16px',
                fontSize: '12px',
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                whiteSpace: 'nowrap',
                boxShadow: '0 2px 6px rgba(37, 99, 235, 0.25)'
              }}
              title="Faqat ushbu korxonaning VPS ma'lumotlarini tiklash"
            >
              <Server size={15} />
              <span>VPS dan tiklash</span>
            </button>
          </div>

          <div style={{ fontWeight: 700, fontSize: '13px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Mavjud zaxiralar ({backups.length} ta):</span>
            <span style={{ fontSize: '11.5px', fontWeight: 500, color: 'var(--text-muted)' }}>
              Toshkent vaqti bilan
            </span>
          </div>

          <div style={{
            maxHeight: '380px',
            overflowY: 'auto',
            overflowX: 'hidden',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-lg)'
          }}>
            {isLoading ? (
              <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)' }}>Yuklanmoqda...</div>
            ) : backups.length === 0 ? (
              <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)' }}>
                Hozircha saqlangan zaxiralar yo'q.
              </div>
            ) : (
              <table className="excel-table" style={{ width: '100%' }}>
                <thead style={{ position: 'sticky', top: 0, zIndex: 2 }}>
                  <tr style={{ height: '36px', background: 'var(--bg-surface-subtle)' }}>
                    <th className="col-header" style={{ textAlign: 'left', paddingLeft: '14px' }}>Zaxira vaqti & Turi</th>
                    <th className="col-header" style={{ textAlign: 'center', width: '140px' }}>Ma'lumotlar</th>
                    <th className="col-header" style={{ textAlign: 'center', width: '110px' }}>Amal</th>
                  </tr>
                </thead>
                <tbody>
                  {backups.map((b) => {
                    const isBeforeReset = b.filename.includes('before_reset');
                    const formattedTime = formatDisplayTime(b);

                    return (
                      <tr
                        key={b.filename}
                        style={{
                          height: '42px',
                          backgroundColor: isBeforeReset ? '#fefce8' : 'var(--bg-surface)'
                        }}
                      >
                        <td style={{ paddingLeft: '14px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                            {isBeforeReset ? (
                              <Star size={16} color="#d97706" fill="#fef3c7" />
                            ) : (
                              <Clock size={15} color="var(--primary)" />
                            )}
                            <div>
                              <div style={{ fontWeight: 700, color: isBeforeReset ? '#b45309' : 'var(--text-primary)' }}>
                                {isBeforeReset ? 'Qaytarishdan oldingi zaxira' : 'Avtomatik zaxira'}
                              </div>
                              <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '1px' }}>
                                {formattedTime}
                              </div>
                            </div>
                          </div>
                        </td>

                        <td style={{ textAlign: 'center' }}>
                          <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
                            {b.workersCount !== undefined ? `${b.workersCount} ta ishchi` : ''}
                          </div>
                          <div style={{ fontSize: '11px', color: (b.filledOpsCount || 0) > 0 ? 'var(--primary)' : 'var(--text-muted)' }}>
                            {(b.filledOpsCount || 0) > 0 ? `${b.filledOpsCount} ta hisob yozuvi` : `${(b.size / 1024).toFixed(1)} KB`}
                          </div>
                        </td>

                        <td style={{ textAlign: 'center' }}>
                          <button
                            onClick={() => handleRestore(b.filename)}
                            className={isBeforeReset ? "soft-btn" : "soft-btn soft-btn-secondary"}
                            style={{
                              padding: '4px 12px',
                              borderRadius: 'var(--radius-full)',
                              fontSize: '11.5px',
                              background: isBeforeReset ? 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)' : undefined,
                              color: isBeforeReset ? '#ffffff' : 'var(--primary)'
                            }}
                            title="Ushbu zaxira holatiga qaytarish"
                          >
                            <RotateCcw size={12} />
                            <span>Tiklash</span>
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="modal-footer">
          <button
            onClick={closeModal}
            className="soft-btn soft-btn-primary"
            style={{ borderRadius: 'var(--radius-full)', padding: '6px 20px' }}
          >
            Yopish
          </button>
        </div>
      </div>
    </div>
  );
};
