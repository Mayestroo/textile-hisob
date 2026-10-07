import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useWorkbookStore } from '../../../store/workbookStore';
import {
  X,
  Calendar,
  CheckCircle2,
  Archive,
  History,
  Clock,
  FileSpreadsheet,
  Download,
  TrendingUp,
  Users,
  DollarSign,
  Wallet,
  Edit3,
  AlertCircle,
  Check
} from 'lucide-react';
import { calculateMasterPayroll, formatMoney } from '../../../engine/formulaEngine';
import { formatDateIso, formatUzbekDate, getUzbekMonthName } from '../../../utils/formatters';
import { exportWorkbookToExcel } from '../../../engine/excelSync';
import { SYSTEM_SHEETS } from '../../../constants/sheetConstants';
import { getElectronApi, resolveElectronRuntimeMode } from '../../../store/runtimeMode';

interface ArchiveItem {
  filename: string;
  excelFilename?: string;
  hasExcel?: boolean;
  period: {
    name: string;
    startDate: string;
    endDate?: string;
  };
  archivedAt: string;
  workersCount: number;
}

export const PeriodManagerModal: React.FC = () => {
  const modalType = useWorkbookStore((s) => s.modalState.type);
  const closeModal = useWorkbookStore((s) => s.closeModal);
  const currentPeriod = useWorkbookStore((s) => s.currentPeriod);
  const periods = useWorkbookStore((s) => s.periods);
  const updateCurrentPeriod = useWorkbookStore((s) => s.updateCurrentPeriod);
  const closeCurrentPeriod = useWorkbookStore((s) => s.closeCurrentPeriod);
  const confirmAction = useWorkbookStore((s) => s.confirmAction);
  const loadArchivedPeriod = useWorkbookStore((s) => s.loadArchivedPeriod);
  const setActiveSheet = useWorkbookStore((s) => s.setActiveSheet);
  const models = useWorkbookStore((s) => s.models);
  const workers = useWorkbookStore((s) => s.workers);
  const licenseStatus = useWorkbookStore((s) => s.licenseStatus);
  const companyId = licenseStatus?.companyId || 'company_main';
  const addNotification = useWorkbookStore((s) => s.addNotification);

  const [activeTab, setActiveTab] = useState<'current' | 'history'>('current');
  const [closeDate, setCloseDate] = useState(formatDateIso());
  const [nextPeriodStartDate, setNextPeriodStartDate] = useState(formatDateIso());
  const [nextPeriodName, setNextPeriodName] = useState('');
  const [isAutoName, setIsAutoName] = useState(true);

  // Edit current period state
  const [isEditingCurrent, setIsEditingCurrent] = useState(false);
  const [currentEditName, setCurrentEditName] = useState('');
  const [currentEditStartDate, setCurrentEditStartDate] = useState('');

  const [isProcessing, setIsProcessing] = useState(false);
  const [serverArchives, setServerArchives] = useState<ArchiveItem[]>([]);
  const [searchHistory, setSearchHistory] = useState('');

  const fetchArchives = useCallback(async () => {
    const eAPI = getElectronApi();
    const runtime = await resolveElectronRuntimeMode(eAPI);
    if (runtime.mode === 'sync') {
      const closedPeriods = useWorkbookStore.getState().periods.filter((period) => period.isClosed);
      setServerArchives(closedPeriods.map((period) => ({
        filename: period.archiveFilename || period.id,
        period: { name: period.name, startDate: period.startDate, endDate: period.endDate },
        archivedAt: period.closedAt || period.endDate || period.startDate,
        workersCount: 0
      })));
      return;
    }
    if (eAPI && eAPI.archivesList) {
      try {
        const res = await eAPI.archivesList(companyId);
        if (res.success && res.archives) {
          setServerArchives(res.archives);
          return;
        }
      } catch (err) {
        console.warn('IPC archives-list failed', err);
      }
    }

    try {
      const res = await fetch(`/api/archives?companyId=${encodeURIComponent(companyId)}`);
      if (res.ok) {
        const json = await res.json();
        if (json.success && json.archives) {
          setServerArchives(json.archives);
        }
      }
    } catch (e) {
      console.warn('Could not fetch server archives', e);
    }
  }, [companyId]);

  // These are modal-local drafts. A remote projection may replace the current
  // period ID while the modal is open, but must not overwrite dates being edited.
  useEffect(() => {
    if (modalType !== 'period_manager') return;
    const today = formatDateIso();
    setCloseDate(today);
    setNextPeriodStartDate(today);
    setNextPeriodName(getUzbekMonthName(today));
    setIsAutoName(true);
    setCurrentEditName(currentPeriod.name || getUzbekMonthName(currentPeriod.startDate));
    setCurrentEditStartDate(currentPeriod.startDate || today);
    setIsEditingCurrent(false);
  }, [modalType]);

  useEffect(() => {
    if (modalType === 'period_manager') void fetchArchives();
  }, [modalType, fetchArchives]);

  useEffect(() => {
    if (modalType !== 'period_manager' || isEditingCurrent) return;
    setCurrentEditName(currentPeriod.name || getUzbekMonthName(currentPeriod.startDate));
    setCurrentEditStartDate(currentPeriod.startDate || formatDateIso());
  }, [modalType, currentPeriod.id, currentPeriod.name, currentPeriod.startDate, isEditingCurrent]);

  // When close date changes, auto-suggest next start date & name if user hasn't typed custom name
  const handleCloseDateChange = (val: string) => {
    setCloseDate(val);
    setNextPeriodStartDate(val);
    if (isAutoName) {
      setNextPeriodName(getUzbekMonthName(val));
    }
  };

  const handleNextStartDateChange = (val: string) => {
    setNextPeriodStartDate(val);
    if (isAutoName) {
      setNextPeriodName(getUzbekMonthName(val));
    }
  };

  const payroll = useMemo(() => {
    if (modalType !== 'period_manager') return null;
    return calculateMasterPayroll(models, workers);
  }, [modalType, models, workers]);

  const totalAvans = useMemo(() => {
    return workers.reduce((sum, w) => sum + (Number(w.avans) || 0), 0);
  }, [workers]);

  if (modalType !== 'period_manager' || !payroll) return null;

  // Handle month closing
  const handleClosePeriod = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalNextName = nextPeriodName.trim() || getUzbekMonthName(nextPeriodStartDate);

    const confirmMsg =
      `«${currentPeriod.name}» oyligini ${formatUzbekDate(closeDate)} sanasi bilan yopishni tasdiqlaysizmi?\n\n` +
      `• Shu oylikning yakuniy hisob-kitob Excel fayli avtomatik yuklanadi.\n` +
      `• Barcha ma'lumotlar arxivga xavfsiz saqlanadi.\n` +
      `• To'liq topshirilgan partiyalar arxivlanadi, chala qolgan partiyalar yangi oyga o'tadi.\n` +
      `• Yangi boshlanadigan oy: «${finalNextName}» (${formatUzbekDate(nextPeriodStartDate)} dan)`;

    const ok = await confirmAction({
      title: "Oylik davrni yopish",
      message: confirmMsg,
      confirmText: "Ha, yopilsin",
      isDanger: false
    });

    if (!ok) {
      return;
    }

    setIsProcessing(true);
    try {
      const runtime = await resolveElectronRuntimeMode(getElectronApi());
      if (runtime.mode === 'sync' && !runtime.success) {
        addNotification('error', runtime.code || '_RUNTIME_NOT_READY', runtime.error || 'Runtime readiness failed.');
        return;
      }
      // 1. Export final Excel for the closing month
      const safePeriodName = (currentPeriod.name || 'Oylik').replace(/[^a-zA-Z0-9_\u0400-\u04FF-]/g, '_');
      exportWorkbookToExcel(models, workers, `Buxoro_Hisob_${safePeriodName}_${closeDate}.xlsx`);

      // 2. Close current period and initialize next
      const closed = await closeCurrentPeriod(closeDate, finalNextName, nextPeriodStartDate);
      if (!closed) return;

      // 3. Refresh archives and switch to history view
      await fetchArchives();
      setActiveTab('history');
      addNotification(runtime.mode === 'sync' ? 'info' : 'success', runtime.mode === 'sync' ? 'Sinxronlash navbatda' : 'Oy muvaffaqiyatli yopildi', runtime.mode === 'sync'
        ? `«${currentPeriod.name}» yopilishi lokal outboxga yozildi; VPS sinxron holati yuqoridagi indikator orqali ko‘rinadi.`
        : `«${currentPeriod.name}» arxivlandi. Yangi davr: «${finalNextName}»`);
    } catch (err: any) {
      console.error('Failed to close period', err);
      addNotification('error', 'Xatolik', 'Oyni yopishda xatolik yuz berdi: ' + (err.message || ''));
    } finally {
      setIsProcessing(false);
    }
  };

  // Handle current period rename / start date edit
  const handleSaveCurrentEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentEditName.trim()) return;
    setIsProcessing(true);
    try {
      const updated = await updateCurrentPeriod(currentEditName.trim(), currentEditStartDate);
      if (updated) setIsEditingCurrent(false);
    } finally {
      setIsProcessing(false);
    }
  };

  // Download Excel for archived period directly from archive data
  const handleDownloadArchiveExcel = async (item: ArchiveItem) => {
    const eAPI = getElectronApi();
    const runtime = await resolveElectronRuntimeMode(eAPI);
    let archiveData: any = null;

    if (runtime.mode === 'sync') {
      if (!runtime.success || !companyId || typeof eAPI?.PeriodArchiveRead !== 'function') {
        addNotification('error', runtime.code || 'PERIOD_ARCHIVE_READ_FAILED', runtime.error || 'Server arxivini o‘qish xizmati mavjud emas.');
        return;
      }
      try {
        const result = await eAPI.PeriodArchiveRead({ companyId, filename: item.filename });
        if (result?.success && result.data) archiveData = result.data;
        else {
          addNotification('error', result?.code || 'PERIOD_ARCHIVE_READ_FAILED', result?.error || 'Server arxivi topilmadi.');
          return;
        }
      } catch (error) {
        addNotification('error', 'PERIOD_ARCHIVE_READ_FAILED', error instanceof Error ? error.message : 'Server arxivini o‘qib bo‘lmadi.');
        return;
      }
    }

    if (runtime.mode !== 'sync' && eAPI && eAPI.archiveRead) {
      try {
        const res = await eAPI.archiveRead(item.filename);
        if (res.success && res.data) archiveData = res.data;
      } catch (err) {
        console.warn('Failed to read archive in electron', err);
      }
    }

    if (!archiveData && runtime.mode !== 'sync') {
      try {
        const res = await fetch(`/api/archive/${item.filename}`);
        if (res.ok) archiveData = await res.json();
      } catch (e) {
        console.warn('Failed to fetch archive via api', e);
      }
    }

    if (archiveData && archiveData.models && archiveData.workers) {
      const safeName = (item.period.name || 'Arxiv').replace(/[^a-zA-Z0-9_\u0400-\u04FF-]/g, '_');
      exportWorkbookToExcel(archiveData.models, archiveData.workers, `Arxiv_${safeName}.xlsx`);
      addNotification('success', 'Excel yuklandi', `«${item.period.name}» arxivining Excel hisoboti yuklab olindi.`);
    } else {
      addNotification('warning', 'Yuklab bo\'lmadi', 'Ushbu arxivning ichki modellari topilmadi.');
    }
  };

  const filteredArchives = serverArchives.filter((a) => {
    if (!searchHistory.trim()) return true;
    const q = searchHistory.toLowerCase();
    return (
      (a.period.name && a.period.name.toLowerCase().includes(q)) ||
      (a.period.startDate && a.period.startDate.includes(q)) ||
      (a.period.endDate && a.period.endDate.includes(q))
    );
  });

  return (
    <div className="modal-overlay" onClick={closeModal}>
      <div
        className="modal-card"
        style={{
          maxWidth: '700px',
          width: '95%',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: '20px',
          overflow: 'hidden',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.35)'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '18px 24px',
            background: 'var(--bg-surface)',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '12px',
                background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.2) 0%, rgba(5, 150, 105, 0.2) 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <Calendar size={22} color="#10b981" />
            </div>
            <div>
              <h2 style={{ margin: 0, fontSize: '17px', fontWeight: 800, color: 'var(--text-primary)' }}>
                Oylik Davri & Oyni Yopish
              </h2>
              <p style={{ margin: '2px 0 0', fontSize: '12px', color: 'var(--text-muted)' }}>
                Joriy oylik hisobotlari nazorati, oyni yopish va arxivlangan davrlar
              </p>
            </div>
          </div>

          <button
            onClick={closeModal}
            className="soft-btn soft-btn-secondary"
            style={{ width: '32px', height: '32px', padding: 0, borderRadius: 'var(--radius-full)' }}
            title="Oynani yopish"
          >
            <X size={16} />
          </button>
        </div>

        {/* Tab Switcher */}
        <div
          style={{
            display: 'flex',
            gap: '8px',
            padding: '10px 24px 0',
            background: 'var(--bg-surface-subtle)',
            borderBottom: '1px solid var(--border-subtle)'
          }}
        >
          <button
            onClick={() => setActiveTab('current')}
            style={{
              padding: '9px 18px',
              border: 'none',
              background: activeTab === 'current' ? 'var(--bg-surface)' : 'transparent',
              borderBottom: activeTab === 'current' ? '2px solid var(--primary)' : '2px solid transparent',
              borderRadius: '8px 8px 0 0',
              fontWeight: activeTab === 'current' ? 700 : 500,
              color: activeTab === 'current' ? 'var(--primary)' : 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: '13px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              transition: 'all 0.15s'
            }}
          >
            <Clock size={15} />
            <span>Joriy Oylik & Oyni Yopish</span>
          </button>

          <button
            onClick={() => {
              setActiveTab('history');
              fetchArchives();
            }}
            style={{
              padding: '9px 18px',
              border: 'none',
              background: activeTab === 'history' ? 'var(--bg-surface)' : 'transparent',
              borderBottom: activeTab === 'history' ? '2px solid var(--primary)' : '2px solid transparent',
              borderRadius: '8px 8px 0 0',
              fontWeight: activeTab === 'history' ? 700 : 500,
              color: activeTab === 'history' ? 'var(--primary)' : 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: '13px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              transition: 'all 0.15s'
            }}
          >
            <History size={15} />
            <span>Yopilgan Oylar Arxivi ({serverArchives.length || periods.length})</span>
          </button>
        </div>

        {/* Modal Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
          {activeTab === 'current' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
              {/* Card 1: Current Active Month Overview */}
              <div
                style={{
                  background: 'var(--bg-surface)',
                  border: '1.5px solid rgba(16, 185, 129, 0.3)',
                  borderRadius: '16px',
                  padding: '16px 20px',
                  boxShadow: 'var(--shadow-xs)'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px', marginBottom: '14px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>
                      🗓️ {currentPeriod.name || 'Joriy Oylik Davri'}
                    </span>
                    {!isEditingCurrent && (
                      <button
                        onClick={() => setIsEditingCurrent(true)}
                        className="soft-btn soft-btn-secondary"
                        style={{ padding: '3px 8px', fontSize: '11px', borderRadius: 'var(--radius-full)', gap: '4px' }}
                        title="Joriy oylik nomi yoki sanasini to'g'rilash"
                      >
                        <Edit3 size={12} />
                        <span>Tahrirlash</span>
                      </button>
                    )}
                  </div>

                  <span
                    style={{
                      fontSize: '11px',
                      background: 'rgba(16, 185, 129, 0.15)',
                      color: '#10b981',
                      border: '1px solid rgba(16, 185, 129, 0.3)',
                      padding: '3px 10px',
                      borderRadius: 'var(--radius-full)',
                      fontWeight: 700,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '5px'
                    }}
                  >
                    <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#10b981' }} />
                    FAOL OY (Kiritilmoqda)
                  </span>
                </div>

                {/* Inline Editing Form */}
                {isEditingCurrent ? (
                  <form
                    onSubmit={handleSaveCurrentEdit}
                    style={{
                      background: 'var(--bg-surface-subtle)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: '12px',
                      padding: '12px 14px',
                      marginBottom: '14px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '10px'
                    }}
                  >
                    <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)' }}>
                      Joriy oy nomi va boshlanish sanasini tuzatish:
                    </div>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      <input
                        type="text"
                        value={currentEditName}
                        onChange={(e) => setCurrentEditName(e.target.value)}
                        placeholder="Oylik nomi (masalan: 2026-Sentabr oyligi)..."
                        className="soft-input"
                        style={{ flex: 2, height: '34px', minWidth: '180px' }}
                        required
                      />
                      <input
                        type="date"
                        value={currentEditStartDate}
                        onChange={(e) => setCurrentEditStartDate(e.target.value)}
                        className="soft-input"
                        style={{ flex: 1, height: '34px', minWidth: '130px' }}
                        required
                      />
                      <button
                        type="submit"
                        disabled={isProcessing}
                        className="soft-btn soft-btn-primary"
                        style={{ padding: '0 14px', height: '34px' }}
                      >
                        <Check size={14} />
                        <span>Saqlash</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setIsEditingCurrent(false)}
                        className="soft-btn soft-btn-secondary"
                        style={{ padding: '0 12px', height: '34px' }}
                      >
                        Bekor qilish
                      </button>
                    </div>
                  </form>
                ) : (
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '14px' }}>
                    Boshlangan sana: <strong style={{ color: 'var(--text-primary)' }}>{formatUzbekDate(currentPeriod.startDate)}</strong>
                  </div>
                )}

                {/* 4 Clean Metric Cards */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(135px, 1fr))', gap: '10px' }}>
                  {/* Card 1: Workers */}
                  <div style={{ background: 'var(--bg-surface-subtle)', padding: '10px 12px', borderRadius: '10px', border: '1px solid var(--border-subtle)' }}>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px' }}>
                      <Users size={13} color="var(--primary)" />
                      <span>Ishchilar soni</span>
                    </div>
                    <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)' }}>
                      {workers.length} nafar
                    </div>
                  </div>

                  {/* Card 2: Total Earned */}
                  <div style={{ background: 'var(--bg-surface-subtle)', padding: '10px 12px', borderRadius: '10px', border: '1px solid var(--border-subtle)' }}>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px' }}>
                      <DollarSign size={13} color="#3b82f6" />
                      <span>Jami hisoblangan</span>
                    </div>
                    <div style={{ fontSize: '14px', fontWeight: 800, color: '#3b82f6' }}>
                      {formatMoney(payroll.totalUmumiy)} so'm
                    </div>
                  </div>

                  {/* Card 3: Total Advance */}
                  <div style={{ background: 'var(--bg-surface-subtle)', padding: '10px 12px', borderRadius: '10px', border: '1px solid var(--border-subtle)' }}>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px' }}>
                      <Wallet size={13} color="#f59e0b" />
                      <span>Berilgan avans</span>
                    </div>
                    <div style={{ fontSize: '14px', fontWeight: 800, color: '#f59e0b' }}>
                      {formatMoney(totalAvans)} so'm
                    </div>
                  </div>

                  {/* Card 4: Net Payable */}
                  <div
                    style={{
                      background: payroll.totalSofFoyda >= 0 ? 'rgba(16, 185, 129, 0.08)' : 'rgba(239, 68, 68, 0.08)',
                      padding: '10px 12px',
                      borderRadius: '10px',
                      border: `1px solid ${payroll.totalSofFoyda >= 0 ? 'rgba(16, 185, 129, 0.25)' : 'rgba(239, 68, 68, 0.25)'}`
                    }}
                  >
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '4px' }}>
                      <CheckCircle2 size={13} color={payroll.totalSofFoyda >= 0 ? '#10b981' : '#ef4444'} />
                      <span>To'lanadigan qoldiq</span>
                    </div>
                    <div style={{ fontSize: '14px', fontWeight: 800, color: payroll.totalSofFoyda >= 0 ? '#10b981' : '#ef4444' }}>
                      {payroll.totalSofFoyda >= 0 ? `${formatMoney(payroll.totalSofFoyda)} so'm` : '0 so\'m'}
                    </div>
                    {payroll.totalSofFoyda < 0 && (
                      <div style={{ fontSize: '10px', color: '#ef4444', marginTop: '2px', fontWeight: 600 }}>
                        Avans ko'proq: {formatMoney(Math.abs(payroll.totalSofFoyda))} so'm
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Card 2: Closing Month & Rollover Form */}
              <form
                onSubmit={handleClosePeriod}
                style={{
                  background: 'var(--bg-surface)',
                  border: '1.5px solid rgba(239, 68, 68, 0.35)',
                  borderRadius: '16px',
                  padding: '18px 20px',
                  boxShadow: 'var(--shadow-xs)'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', color: '#dc2626' }}>
                  <Archive size={18} />
                  <span style={{ fontSize: '14.5px', fontWeight: 800 }}>
                    Oyni Yopish va Yangi Oyga O'tish
                  </span>
                </div>

                <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '0 0 14px', lineHeight: '1.5' }}>
                  Oyni yopish vaqtida tizim quyidagi amallarni avtomatik bajaradi:
                </p>

                {/* Informative Checklist */}
                <div
                  style={{
                    background: 'rgba(239, 68, 68, 0.05)',
                    border: '1px solid rgba(239, 68, 68, 0.15)',
                    borderRadius: '10px',
                    padding: '10px 14px',
                    fontSize: '11.5px',
                    color: 'var(--text-secondary)',
                    marginBottom: '16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Check size={13} color="#10b981" />
                    <span>Shu oyning yakuniy <strong>Excel (.xlsx)</strong> hisoboti kompyuteringizga avtomatik yuklanadi.</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Check size={13} color="#10b981" />
                    <span>To'liq ma'lumotlar <strong>Arxivga</strong> saqlanadi (istalgan payt ko'rish mumkin).</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Check size={13} color="#10b981" />
                    <span>Kiritilmay qolgan partiyalar <strong>yangi oyga o'tadi</strong>, to'liq yopilganlari arxivlanadi.</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Check size={13} color="#10b981" />
                    <span>Ishchilar va stavkalar saqlangan holda yangi oyga <strong>toza jadval</strong> ochiladi.</span>
                  </div>
                </div>

                {/* Form Inputs Grid */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px', marginBottom: '16px' }}>
                  {/* Field 1: Close Date */}
                  <div>
                    <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '5px' }}>
                      📅 1. Oyni yopish sanasi:
                    </label>
                    <input
                      type="date"
                      value={closeDate}
                      onChange={(e) => handleCloseDateChange(e.target.value)}
                      required
                      className="soft-input"
                      style={{ height: '38px', width: '100%' }}
                    />
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '3px', display: 'block' }}>
                      Shu sana bilan oylik arxivga o'tadi
                    </span>
                  </div>

                  {/* Field 2: Next Period Start Date */}
                  <div>
                    <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '5px' }}>
                      ▶️ 2. Yangi oy boshlanish sanasi:
                    </label>
                    <input
                      type="date"
                      value={nextPeriodStartDate}
                      onChange={(e) => handleNextStartDateChange(e.target.value)}
                      required
                      className="soft-input"
                      style={{ height: '38px', width: '100%' }}
                    />
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '3px', display: 'block' }}>
                      Yangi hisoblar shu sanadan boshlanadi
                    </span>
                  </div>
                </div>

                {/* Field 3: Next Period Name */}
                <div style={{ marginBottom: '18px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '5px' }}>
                    <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>
                      🏷️ 3. Yangi ochiladigan oylik nomi:
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        const auto = getUzbekMonthName(nextPeriodStartDate);
                        setNextPeriodName(auto);
                        setIsAutoName(true);
                      }}
                      className="soft-btn soft-btn-secondary"
                      style={{ fontSize: '10.5px', padding: '2px 8px', height: '22px' }}
                    >
                      Avtomatik nomlash
                    </button>
                  </div>
                  <input
                    type="text"
                    value={nextPeriodName}
                    onChange={(e) => {
                      setNextPeriodName(e.target.value);
                      setIsAutoName(false);
                    }}
                    placeholder="Masalan: 2026-Sentabr oyligi"
                    required
                    className="soft-input"
                    style={{ height: '38px', width: '100%' }}
                  />
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '3px', display: 'block' }}>
                    Yangi ochiladigan oy sarlavhasi (istalgan vaqt o'zgartirish mumkin)
                  </span>
                </div>

                {/* Submit Close Button */}
                <button
                  type="submit"
                  disabled={isProcessing}
                  className="soft-btn"
                  style={{
                    width: '100%',
                    height: '42px',
                    background: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)',
                    color: '#ffffff',
                    fontSize: '13.5px',
                    fontWeight: 800,
                    borderRadius: '12px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px',
                    boxShadow: '0 4px 12px rgba(239, 68, 68, 0.25)',
                    cursor: isProcessing ? 'not-allowed' : 'pointer'
                  }}
                >
                  <Archive size={17} />
                  <span>{isProcessing ? 'Arxivlanmoqda va Excel yuklanmoqda...' : 'Oyni Yopish va Yangi Oyni Boshlash'}</span>
                </button>
              </form>
            </div>
          ) : (
            /* History Tab */
            <div>
              {/* Search in history */}
              {serverArchives.length > 3 && (
                <div style={{ marginBottom: '14px' }}>
                  <input
                    type="text"
                    value={searchHistory}
                    onChange={(e) => setSearchHistory(e.target.value)}
                    placeholder="Arxivlangan oylardan qidirish..."
                    className="soft-input"
                    style={{ width: '100%', height: '34px', fontSize: '12px' }}
                  />
                </div>
              )}

              {filteredArchives.length === 0 ? (
                <div
                  style={{
                    padding: '40px 20px',
                    textAlign: 'center',
                    background: 'var(--bg-surface-subtle)',
                    borderRadius: '14px',
                    border: '1px dashed var(--border-subtle)'
                  }}
                >
                  <div
                    style={{
                      width: '48px',
                      height: '48px',
                      borderRadius: '50%',
                      background: 'var(--bg-surface)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      margin: '0 auto 12px'
                    }}
                  >
                    <Archive size={24} color="var(--text-muted)" />
                  </div>
                  <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
                    Hozircha yopilgan oylar yo'q
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', maxWidth: '380px', margin: '0 auto' }}>
                    Oy yakunida «Joriy Oylik & Oyni Yopish» bo'limida oyni yopganingizda, barcha arxiv Excel hisobotlari va ma'lumotlari shu yerda saqlanadi.
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {filteredArchives.map((item, idx) => (
                    <div
                      key={idx}
                      style={{
                        border: '1px solid var(--border-subtle)',
                        borderRadius: '14px',
                        padding: '14px 18px',
                        background: 'var(--bg-surface)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: '12px',
                        boxShadow: 'var(--shadow-xs)'
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 800, fontSize: '14px', color: 'var(--primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <FileSpreadsheet size={16} />
                          <span>{item.period.name || 'Arxivlangan Oylik'}</span>
                          <span
                            style={{
                              fontSize: '10.5px',
                              background: 'rgba(99, 102, 241, 0.15)',
                              color: '#818cf8',
                              padding: '2px 8px',
                              borderRadius: 'var(--radius-full)',
                              fontWeight: 700
                            }}
                          >
                            YOPILGAN
                          </span>
                        </div>
                        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                          Davr: <strong>{formatUzbekDate(item.period.startDate)}</strong> — <strong>{formatUzbekDate(item.period.endDate) || '—'}</strong> ({item.workersCount || 0} nafar ishchi)
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <button
                          onClick={() => {
                            loadArchivedPeriod(item.filename);
                            setActiveSheet(SYSTEM_SHEETS.PATTA_HISOB);
                            closeModal();
                          }}
                          className="soft-btn soft-btn-secondary"
                          style={{ padding: '6px 14px', fontSize: '12px', borderRadius: 'var(--radius-full)', gap: '6px' }}
                          title="Ushbu oyning barcha partiyalari va statistikalarini ko'rish"
                        >
                          <TrendingUp size={13} color="var(--primary)" />
                          <span>Patta-hisobda ko'rish</span>
                        </button>

                        <button
                          onClick={() => handleDownloadArchiveExcel(item)}
                          className="soft-btn soft-btn-primary"
                          style={{ padding: '6px 14px', fontSize: '12px', borderRadius: 'var(--radius-full)', gap: '6px' }}
                          title="Shu oyning to'liq Excel (.xlsx) hisobotini yuklab olish"
                        >
                          <Download size={13} />
                          <span>Excel yuklash</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div
          style={{
            padding: '14px 24px',
            background: 'var(--bg-surface-subtle)',
            borderTop: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '10px'
          }}
        >
          <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <AlertCircle size={14} color="var(--primary)" />
            <span>Oyni yopishdan oldin barcha partiyalar va avanslar kiritilganini tekshirib oling.</span>
          </div>

          <button
            type="button"
            onClick={closeModal}
            className="soft-btn soft-btn-secondary"
            style={{ borderRadius: 'var(--radius-full)', padding: '6px 20px', fontSize: '12.5px' }}
          >
            Chiqish
          </button>
        </div>
      </div>
    </div>
  );
};
