import React, { useState, useEffect, useLayoutEffect, useMemo, useCallback } from 'react';
import { useWorkbookStore } from '../../../store/workbookStore';
import {
  X,
  Calendar,
  Archive,
  FileSpreadsheet,
  Download,
  Check
} from 'lucide-react';
import { formatMoney } from '../../../engine/formulaEngine';
import { displayedMoney, payrollDisplay } from '../../../engine/payrollDisplay';
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
  const payrollValuation = useWorkbookStore((s) => s.payrollValuation);
  const licenseStatus = useWorkbookStore((s) => s.licenseStatus);
  const companyId = licenseStatus?.companyId || 'company_main';
  const addNotification = useWorkbookStore((s) => s.addNotification);

  const [activeTab, setActiveTab] = useState<'current' | 'history'>('current');
  const [closeDate, setCloseDate] = useState(formatDateIso());
  const [nextPeriodStartDate, setNextPeriodStartDate] = useState(formatDateIso());
  const [nextPeriodName, setNextPeriodName] = useState('');
  const [isAutoName, setIsAutoName] = useState(true);
  const [confirmed, setConfirmed] = useState(false);

  // Edit current period state
  const [isEditingCurrent, setIsEditingCurrent] = useState(false);
  const [currentEditName, setCurrentEditName] = useState('');
  const [currentEditStartDate, setCurrentEditStartDate] = useState('');

  const [isProcessing, setIsProcessing] = useState(false);
  const [serverArchives, setServerArchives] = useState<ArchiveItem[]>([]);
  const [searchHistory, setSearchHistory] = useState('');
  const [periodSummary, setPeriodSummary] = useState<any>(null);
  const [archiveSummary, setArchiveSummary] = useState<{ filename: string; periodName: string; display: any } | null>(null);
  const [archiveSummaryError, setArchiveSummaryError] = useState('');
  const [isArchiveReading, setIsArchiveReading] = useState(false);

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
    setConfirmed(false);
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

  useLayoutEffect(() => {
    if (modalType !== 'period_manager') return;
    let cancelled = false;
    const capturedCompanyId = companyId;
    const capturedPeriodId = currentPeriod.id;
    const api = getElectronApi();
    setPeriodSummary({ companyId: capturedCompanyId, periodId: capturedPeriodId, valuation: null });
    setArchiveSummary(null);
    setArchiveSummaryError('');
    void (async () => {
      const runtime = await resolveElectronRuntimeMode(api);
      if (cancelled) return;
      if (runtime.mode === 'sync' || (api && typeof api.dbRead === 'function')) {
        if (!runtime.success && runtime.mode === 'sync') {
          setPeriodSummary({ companyId: capturedCompanyId, periodId: capturedPeriodId, valuation: null });
          return;
        }
        try {
          const result = await api?.dbRead?.(capturedCompanyId);
          const latest = useWorkbookStore.getState();
          if (cancelled || latest.licenseStatus?.companyId !== capturedCompanyId || latest.currentPeriod.id !== capturedPeriodId) return;
          const data = result?.success ? result.data : null;
          const valid = data?.companyId === capturedCompanyId && data?.currentPeriod?.id === capturedPeriodId
            && data?.payrollValuation?.companyId === capturedCompanyId
            && data?.payrollValuation?.period?.periodId === capturedPeriodId;
          setPeriodSummary({ companyId: capturedCompanyId, periodId: capturedPeriodId,
            valuation: valid ? data.payrollValuation : null });
        } catch {
          if (!cancelled) setPeriodSummary({ companyId: capturedCompanyId, periodId: capturedPeriodId, valuation: null });
        }
        return;
      }
      const valid = payrollValuation?.companyId === capturedCompanyId && payrollValuation.period?.periodId === capturedPeriodId;
      setPeriodSummary({ companyId: capturedCompanyId, periodId: capturedPeriodId, valuation: valid ? payrollValuation : null });
    })();
    return () => { cancelled = true; };
  }, [modalType, companyId, currentPeriod.id]);

  const currentDisplay = useMemo(() => {
    if (modalType !== 'period_manager') return null;
    const valuation = periodSummary?.companyId === companyId && periodSummary?.periodId === currentPeriod.id
      ? periodSummary.valuation : null;
    return payrollDisplay(models, workers, valuation || {
      companyId, period: null, workers: [], accountingStatus: 'UNAVAILABLE',
      accountingReasons: ['PAYROLL_VALUATION_UNAVAILABLE'], syncStatus: 'UNKNOWN'
    }, companyId, currentPeriod.id);
  }, [modalType, models, workers, companyId, currentPeriod.id, periodSummary]);
  const payroll = currentDisplay?.masterReport || null;

  const totalAvans = useMemo(() => {
    return workers.reduce((sum, w) => sum + (Number(w.avans) || 0), 0);
  }, [workers]);

  if (modalType !== 'period_manager' || !payroll || !currentDisplay) return null;

  // Handle month closing
  const handleClosePeriod = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!confirmed) return;
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
      if (runtime.mode === 'sync' || (getElectronApi() && typeof getElectronApi()?.dbRead === 'function')) {
        const fresh = await getElectronApi()?.dbRead?.(companyId);
        const data = fresh?.success ? fresh.data : null;
        const stillSamePeriod = useWorkbookStore.getState().currentPeriod.id === currentPeriod.id
          && useWorkbookStore.getState().licenseStatus?.companyId === companyId;
        const trusted = stillSamePeriod && data?.companyId === companyId && data?.currentPeriod?.id === currentPeriod.id;
        if (!stillSamePeriod) return;
        const valuation = trusted && data.payrollValuation?.companyId === companyId
          && data.payrollValuation.period?.periodId === currentPeriod.id
          ? data.payrollValuation
          : { companyId, period: null, workers: [], accountingStatus: 'UNAVAILABLE' as const,
            accountingReasons: ['PAYROLL_VALUATION_UNAVAILABLE'], syncStatus: 'UNKNOWN' as const };
        exportWorkbookToExcel(trusted ? data.models || [] : models, trusted ? data.workers || [] : workers,
          `Buxoro_Hisob_${safePeriodName}_${closeDate}.xlsx`, valuation);
      } else {
        const boundValuation = payrollValuation?.companyId === companyId && payrollValuation.period?.periodId === currentPeriod.id
          ? payrollValuation : (companyId ? { companyId, period: null, workers: [], accountingStatus: 'UNAVAILABLE' as const,
            accountingReasons: ['PAYROLL_VALUATION_UNAVAILABLE'], syncStatus: 'UNKNOWN' as const } : undefined);
        exportWorkbookToExcel(models, workers, `Buxoro_Hisob_${safePeriodName}_${closeDate}.xlsx`, boundValuation);
      }

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

  const readSelectedArchive = async (item: ArchiveItem) => {
    const eAPI = getElectronApi();
    const runtime = await resolveElectronRuntimeMode(eAPI);
    const capturedCompanyId = companyId;
    const capturedPeriodId = currentPeriod.id;
    let archiveData: any = null;
    let valuation: any = null;
    const expectedPeriod = periods.find((period) => period.id === item.filename || period.archiveFilename === item.filename);

    if (runtime.mode === 'sync') {
      if (!runtime.success || !companyId || typeof eAPI?.PeriodArchiveRead !== 'function') {
        addNotification('error', runtime.code || 'PERIOD_ARCHIVE_READ_FAILED', runtime.error || 'Server arxivini o‘qish xizmati mavjud emas.');
        return null;
      }
      try {
        const result = await eAPI.PeriodArchiveRead({ companyId, filename: item.filename });
        if (result?.success && result.data) {
          archiveData = result.data;
          if (result.companyId === capturedCompanyId && result.periodId
            && (!expectedPeriod || result.periodId === expectedPeriod.id)
            && result.payrollValuation?.companyId === capturedCompanyId
            && result.payrollValuation.period?.periodId === result.periodId) valuation = result.payrollValuation;
        }
        else {
          addNotification('error', result?.code || 'PERIOD_ARCHIVE_READ_FAILED', result?.error || 'Server arxivi topilmadi.');
          return null;
        }
      } catch (error) {
        addNotification('error', 'PERIOD_ARCHIVE_READ_FAILED', error instanceof Error ? error.message : 'Server arxivini o‘qib bo‘lmadi.');
        return null;
      }
    }

    if (runtime.mode !== 'sync' && eAPI && eAPI.archiveRead) {
      try {
        const res = await eAPI.archiveRead({ filename: item.filename, companyId });
        if (res.success && res.data) {
          archiveData = res.data;
          const archivedPeriodId = archiveData.period?.id;
          if (res.payrollValuation?.companyId === capturedCompanyId
            && res.payrollValuation.period?.periodId === archivedPeriodId) valuation = res.payrollValuation;
        }
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

    const latest = useWorkbookStore.getState();
    if (latest.licenseStatus?.companyId !== capturedCompanyId || latest.currentPeriod.id !== capturedPeriodId) return null;
    if (archiveData && archiveData.models && archiveData.workers) {
      const archivePeriodId = archiveData.period?.id || (expectedPeriod?.id ?? null);
      if (!valuation || valuation.companyId !== capturedCompanyId || valuation.period?.periodId !== archivePeriodId) {
        valuation = { companyId: capturedCompanyId, period: null, workers: [], accountingStatus: 'UNAVAILABLE',
          accountingReasons: ['PAYROLL_VALUATION_UNAVAILABLE'], syncStatus: 'UNKNOWN' };
      }
      return { archiveData, valuation };
    }
    addNotification('warning', 'Yuklab bo\'lmadi', 'Ushbu arxivning ichki modellari topilmadi.');
    return null;
  };

  // Download the selected archive without activating it or touching global workbook state.
  const handleDownloadArchiveExcel = async (item: ArchiveItem) => {
    const read = await readSelectedArchive(item);
    if (read) {
      const { archiveData, valuation } = read;
      const safeName = (item.period.name || 'Arxiv').replace(/[^a-zA-Z0-9_\u0400-\u04FF-]/g, '_');
      exportWorkbookToExcel(archiveData.models, archiveData.workers, `Arxiv_${safeName}.xlsx`, valuation);
      addNotification(valuation.accountingStatus === 'UNAVAILABLE' ? 'warning' : 'success', 'Excel yuklandi',
        valuation.accountingStatus === 'UNAVAILABLE'
          ? `«${item.period.name}» arxivi yuklandi; ish haqi ma’lumoti noma’lum deb belgilandi.`
          : `«${item.period.name}» arxivining Excel hisoboti yuklab olindi.`);
    }
  };

  const handleShowArchiveSummary = async (item: ArchiveItem) => {
    setIsArchiveReading(true);
    setArchiveSummaryError('');
    setArchiveSummary(null);
    try {
      const read = await readSelectedArchive(item);
      if (!read) {
        setArchiveSummaryError('Arxiv davrining ish haqi qiymatini ishonchli o‘qib bo‘lmadi.');
        return;
      }
      const { archiveData, valuation } = read;
      setArchiveSummary({ filename: item.filename, periodName: item.period.name,
        display: payrollDisplay(archiveData.models, archiveData.workers, valuation, companyId, valuation.period?.periodId || '') });
    } finally {
      setIsArchiveReading(false);
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

  const formatPeriodStartDate = (dateStr?: string) => {
    if (!dateStr) return '';
    const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) {
      return `${match[3]}.${match[2]}.${match[1]}`;
    }
    return dateStr;
  };

  const closedCount = serverArchives.length > 0 ? serverArchives.length : periods.filter((p) => p.isClosed).length;

  return (
    <div className="period-modal-overlay" onClick={closeModal}>
      <div
        className="period-modal-card"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            <div
              style={{
                width: '44px',
                height: '44px',
                borderRadius: '12px',
                background: '#dcfce7',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0
              }}
            >
              <Calendar size={22} color="#059669" strokeWidth={2.2} />
            </div>
            <div>
              <h2 style={{ margin: 0, fontSize: '23px', fontWeight: 800, color: 'var(--text-primary, #0f172a)', letterSpacing: '-0.02em', lineHeight: 1.2 }}>
                Oyni yopish
              </h2>
              <p style={{ margin: '3px 0 0', fontSize: '15px', color: 'var(--text-muted, #64748b)', fontWeight: 500 }}>
                Joriy oyni arxivga o'tkazing va yangisini boshlang
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={closeModal}
            className="period-modal-close-btn"
            title="Oynani yopish"
          >
            <X size={16} strokeWidth={2.2} />
          </button>
        </div>

        {/* Segmented Control Tabs */}
        <div className="period-segmented-track">
          <button
            type="button"
            className={`period-segmented-pill ${activeTab === 'current' ? 'active' : ''}`}
            onClick={() => setActiveTab('current')}
          >
            Joriy oy
          </button>
          <button
            type="button"
            className={`period-segmented-pill ${activeTab === 'history' ? 'active' : ''}`}
            onClick={() => {
              setActiveTab('history');
              void fetchArchives();
            }}
          >
            Arxiv ({closedCount})
          </button>
        </div>

        {/* Body */}
        {activeTab === 'current' ? (
          <form onSubmit={handleClosePeriod}>
            {/* Active Month Overview Card */}
            <div className="period-summary-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '21px', fontWeight: 800, color: 'var(--text-primary, #0f172a)' }}>
                    {currentPeriod.name || 'Joriy oylik'}
                  </span>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      background: '#dcfce7',
                      color: '#15803d',
                      padding: '2px 10px',
                      borderRadius: '9999px',
                      fontSize: '15px',
                      fontWeight: 700
                    }}
                  >
                    <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#22c55e' }} />
                    Faol
                  </span>
                </div>

                <button
                  type="button"
                  onClick={() => setIsEditingCurrent(!isEditingCurrent)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#047857',
                    fontWeight: 700,
                    fontSize: '15px',
                    cursor: 'pointer',
                    padding: '2px 6px'
                  }}
                >
                  {isEditingCurrent ? 'Yopish' : 'Tahrirlash'}
                </button>
              </div>

              <div style={{ fontSize: '15px', color: 'var(--text-muted, #64748b)', marginTop: '4px' }}>
                {formatPeriodStartDate(currentPeriod.startDate)} dan boshlangan
              </div>

              {/* Inline Editing Form if toggled */}
              {isEditingCurrent && (
                <div
                  style={{
                    background: 'var(--bg-surface-subtle, #f8fafc)',
                    border: '1px solid var(--border-subtle, #e2e8f0)',
                    borderRadius: '12px',
                    padding: '12px 14px',
                    marginTop: '12px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px'
                  }}
                >
                  <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-secondary, #475569)' }}>
                    Joriy oy nomi va boshlanish sanasini tuzatish:
                  </div>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <input
                      type="text"
                      value={currentEditName}
                      onChange={(e) => setCurrentEditName(e.target.value)}
                      placeholder="Oylik nomi..."
                      className="period-modal-input"
                      style={{ flex: 2, height: '36px', minWidth: '180px' }}
                      required
                    />
                    <input
                      type="date"
                      value={currentEditStartDate}
                      onChange={(e) => setCurrentEditStartDate(e.target.value)}
                      className="period-modal-input"
                      style={{ flex: 1, height: '36px', minWidth: '130px' }}
                      required
                    />
                    <button
                      type="button"
                      disabled={isProcessing}
                      onClick={handleSaveCurrentEdit}
                      className="period-btn-primary"
                      style={{ padding: '0 14px', height: '36px', fontSize: '15px' }}
                    >
                      <Check size={14} />
                      <span>Saqlash</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsEditingCurrent(false)}
                      className="period-btn-secondary"
                      style={{ padding: '0 12px', height: '36px', fontSize: '15px' }}
                    >
                      Bekor qilish
                    </button>
                  </div>
                </div>
              )}

              {/* Divider */}
              <div style={{ borderTop: '1px solid var(--border-subtle, #f1f5f9)', margin: '16px 0 14px' }} />

              {/* 4 Stats Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
                <div>
                  <div style={{ fontSize: '15px', color: 'var(--text-muted, #64748b)', fontWeight: 500, marginBottom: '4px' }}>
                    Ishchilar
                  </div>
                  <div style={{ fontSize: '21px', fontWeight: 800, color: 'var(--text-primary, #0f172a)' }}>
                    {workers.length}
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: '15px', color: 'var(--text-muted, #64748b)', fontWeight: 500, marginBottom: '4px' }}>
                    Jami hisoblangan
                  </div>
                  <div style={{ fontSize: '21px', fontWeight: 800, color: 'var(--text-primary, #0f172a)' }}>
                    {displayedMoney(payroll.totalUmumiy, currentDisplay.ready, currentDisplay.incomplete)}
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: '15px', color: 'var(--text-muted, #64748b)', fontWeight: 500, marginBottom: '4px' }}>
                    Avans
                  </div>
                  <div style={{ fontSize: '21px', fontWeight: 800, color: 'var(--text-primary, #0f172a)' }}>
                    {formatMoney(totalAvans)}
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: '15px', color: 'var(--text-muted, #64748b)', fontWeight: 500, marginBottom: '4px' }}>
                    To'lanadigan
                  </div>
                  <div style={{ fontSize: '21px', fontWeight: 800, color: '#047857' }}>
                    {displayedMoney(Math.max(0, payroll.totalSofFoyda), currentDisplay.ready, currentDisplay.incomplete)}
                  </div>
                </div>
              </div>

              {currentDisplay.label && (
                <div role="status" style={{ marginTop: '10px', padding: '6px 10px', borderRadius: '8px', background: 'rgba(245, 158, 11, 0.1)', color: '#b45309', fontSize: '14px', fontWeight: 650 }}>
                  {currentDisplay.label}
                </div>
              )}
            </div>

            {/* Section: Yopilganda nima bo'ladi */}
            <div style={{ marginTop: '22px' }}>
              <h3 style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary, #0f172a)', margin: '0 0 12px' }}>
                Yopilganda nima bo'ladi
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '15px', color: 'var(--text-secondary, #334155)', lineHeight: 1.45 }}>
                  <span
                    style={{
                      width: '18px',
                      height: '18px',
                      borderRadius: '50%',
                      background: '#dcfce7',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#16a34a',
                      flexShrink: 0
                    }}
                  >
                    <Check size={12} strokeWidth={3} />
                  </span>
                  <span>
                    Hisobot <strong style={{ color: 'var(--text-primary, #0f172a)', fontWeight: 700 }}>Excel (.xlsx)</strong> fayli sifatida yuklab olinadi
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '15px', color: 'var(--text-secondary, #334155)', lineHeight: 1.45 }}>
                  <span
                    style={{
                      width: '18px',
                      height: '18px',
                      borderRadius: '50%',
                      background: '#dcfce7',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#16a34a',
                      flexShrink: 0
                    }}
                  >
                    <Check size={12} strokeWidth={3} />
                  </span>
                  <span>
                    To'liq ma'lumotlar <strong style={{ color: 'var(--text-primary, #0f172a)', fontWeight: 700 }}>Arxivga</strong> saqlanadi, istalgan payt ko'rish mumkin
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '15px', color: 'var(--text-secondary, #334155)', lineHeight: 1.45 }}>
                  <span
                    style={{
                      width: '18px',
                      height: '18px',
                      borderRadius: '50%',
                      background: '#dcfce7',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#16a34a',
                      flexShrink: 0
                    }}
                  >
                    <Check size={12} strokeWidth={3} />
                  </span>
                  <span>
                    Kiritilmagan partiyalar yangi oyga o'tadi. Ishchilar va stavkalar saqlanadi
                  </span>
                </div>
              </div>
            </div>

            {/* Input Fields (2 columns) */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginTop: '20px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '15px', fontWeight: 700, color: 'var(--text-primary, #0f172a)', marginBottom: '6px' }}>
                  Yopish sanasi
                </label>
                <input
                  type="date"
                  value={closeDate}
                  onChange={(e) => handleCloseDateChange(e.target.value)}
                  required
                  className="period-modal-input"
                />
                <span style={{ display: 'block', fontSize: '14.5px', color: 'var(--text-muted, #64748b)', marginTop: '5px' }}>
                  Yangi oy shu sanadan boshlanadi
                </span>
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                  <label style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary, #0f172a)' }}>
                    Yangi oy nomi
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      const auto = getUzbekMonthName(nextPeriodStartDate);
                      setNextPeriodName(auto);
                      setIsAutoName(true);
                    }}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#047857',
                      fontSize: '15px',
                      fontWeight: 700,
                      cursor: 'pointer',
                      padding: 0
                    }}
                  >
                    Avtomatik
                  </button>
                </div>
                <input
                  type="text"
                  value={nextPeriodName}
                  onChange={(e) => {
                    setNextPeriodName(e.target.value);
                    setIsAutoName(false);
                  }}
                  placeholder="Masalan: 2026-Oktabr oyligi"
                  required
                  className="period-modal-input"
                />
                <span style={{ display: 'block', fontSize: '14.5px', color: 'var(--text-muted, #64748b)', marginTop: '5px' }}>
                  Keyinroq o'zgartirish mumkin
                </span>
              </div>
            </div>

            {/* Checkbox & Bottom Actions */}
            <div style={{ borderTop: '1px solid var(--border-subtle, #f1f5f9)', margin: '22px -24px 0', padding: '18px 24px 0' }}>
              <div
                role="checkbox"
                aria-checked={confirmed}
                tabIndex={0}
                onClick={() => setConfirmed(!confirmed)}
                onKeyDown={(e) => {
                  if (e.key === ' ' || e.key === 'Enter') {
                    e.preventDefault();
                    setConfirmed(!confirmed);
                  }
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  cursor: 'pointer',
                  userSelect: 'none',
                  marginBottom: '18px'
                }}
              >
                <div
                  style={{
                    width: '20px',
                    height: '20px',
                    borderRadius: '5px',
                    border: confirmed ? '1.5px solid #047857' : '1.5px solid #cbd5e1',
                    background: confirmed ? '#047857' : '#ffffff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#ffffff',
                    transition: 'all 0.15s ease',
                    flexShrink: 0
                  }}
                >
                  {confirmed && <Check size={14} strokeWidth={3} />}
                </div>
                <span style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary, #0f172a)' }}>
                  Barcha partiya va avanslar kiritilganini tekshirdim
                </span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                <button
                  type="button"
                  onClick={closeModal}
                  className="period-btn-secondary"
                >
                  Bekor qilish
                </button>
                <button
                  type="submit"
                  disabled={!confirmed || isProcessing}
                  className="period-btn-primary"
                >
                  {isProcessing ? 'Yopilmoqda...' : 'Oyni yopish va yangisini boshlash'}
                </button>
              </div>
            </div>
          </form>
        ) : (
          /* History / Archives Tab */
          <div>
            {serverArchives.length > 3 && (
              <div style={{ marginBottom: '14px', marginTop: '16px' }}>
                <input
                  type="text"
                  value={searchHistory}
                  onChange={(e) => setSearchHistory(e.target.value)}
                  placeholder="Arxivlangan oylardan qidirish..."
                  className="period-modal-input"
                  style={{ height: '38px', fontSize: '15px' }}
                />
              </div>
            )}

            {filteredArchives.length === 0 ? (
              <div
                style={{
                  padding: '40px 20px',
                  textAlign: 'center',
                  background: 'var(--bg-surface-subtle, #f8fafc)',
                  borderRadius: '16px',
                  border: '1px dashed var(--border-subtle, #e2e8f0)',
                  marginTop: '18px'
                }}
              >
                <div
                  style={{
                    width: '48px',
                    height: '48px',
                    borderRadius: '50%',
                    background: '#ffffff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    margin: '0 auto 12px',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.06)'
                  }}
                >
                  <Archive size={24} color="#64748b" />
                </div>
                <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary, #0f172a)', marginBottom: '4px' }}>
                  Hozircha yopilgan oylar yo'q
                </div>
                <div style={{ fontSize: '15px', color: 'var(--text-muted, #64748b)', maxWidth: '380px', margin: '0 auto', lineHeight: 1.5 }}>
                  Oy yakunida «Joriy oy» bo'limida oyni yopganingizda, barcha arxiv Excel hisobotlari va ma'lumotlari shu yerda saqlanadi.
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '18px' }}>
                {filteredArchives.map((item, idx) => (
                  <div
                    key={idx}
                    style={{
                      border: '1px solid var(--border-subtle, #e2e8f0)',
                      borderRadius: '14px',
                      padding: '14px 18px',
                      background: 'var(--bg-surface, #ffffff)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      gap: '12px',
                      boxShadow: '0 1px 2px rgba(0,0,0,0.04)'
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 800, fontSize: '17px', color: '#047857', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <FileSpreadsheet size={16} />
                        <span>{item.period.name || 'Arxivlangan Oylik'}</span>
                        <span
                          style={{
                            fontSize: '13.5px',
                            background: '#dcfce7',
                            color: '#15803d',
                            padding: '2px 8px',
                            borderRadius: '9999px',
                            fontWeight: 700
                          }}
                        >
                          YOPILGAN
                        </span>
                      </div>
                      <div style={{ fontSize: '15px', color: 'var(--text-secondary, #64748b)', marginTop: '4px' }}>
                        Davr: <strong>{formatUzbekDate(item.period.startDate)}</strong> — <strong>{formatUzbekDate(item.period.endDate) || '—'}</strong> ({item.workersCount || 0} nafar ishchi)
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <button
                        type="button"
                        onClick={() => handleShowArchiveSummary(item)}
                        disabled={isArchiveReading}
                        className="period-btn-secondary"
                        style={{ height: '34px', padding: '0 12px', fontSize: '15px', borderRadius: '8px' }}
                        title="Arxiv davrining umumiy ish haqi qiymatini ko‘rish"
                      >
                        <span>{isArchiveReading ? 'O‘qilmoqda…' : 'Hisobni ko‘rish'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          loadArchivedPeriod(item.filename);
                          setActiveSheet(SYSTEM_SHEETS.PATTA_HISOB);
                          closeModal();
                        }}
                        className="period-btn-secondary"
                        style={{ height: '34px', padding: '0 12px', fontSize: '15px', borderRadius: '8px' }}
                        title="Ushbu oyning barcha partiyalari va statistikalarini ko'rish"
                      >
                        <span>Patta-hisobda ko'rish</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDownloadArchiveExcel(item)}
                        className="period-btn-primary"
                        style={{ height: '34px', padding: '0 14px', fontSize: '15px', borderRadius: '8px' }}
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

            {archiveSummaryError && (
              <div role="status" style={{ marginTop: '12px', color: '#b91c1c', fontSize: '15px' }}>
                {archiveSummaryError}
              </div>
            )}
            {archiveSummary && (
              <div
                role="status"
                data-period-summary={archiveSummary.filename}
                style={{
                  marginTop: '14px',
                  padding: '12px 14px',
                  borderRadius: '12px',
                  border: '1px solid var(--border-subtle, #e2e8f0)',
                  background: 'var(--bg-surface-subtle, #f8fafc)'
                }}
              >
                <strong>{archiveSummary.periodName} — tarixiy ish haqi</strong>
                <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap', marginTop: '6px', fontSize: '15px' }}>
                  <span>
                    Hisoblangan: <strong>{displayedMoney(archiveSummary.display.masterReport.totalUmumiy, archiveSummary.display.ready, archiveSummary.display.incomplete)} so‘m</strong>
                  </span>
                  <span>
                    To‘lanadigan qoldiq: <strong>{displayedMoney(archiveSummary.display.masterReport.totalSofFoyda, archiveSummary.display.ready, archiveSummary.display.incomplete)} so‘m</strong>
                  </span>
                </div>
                {archiveSummary.display.label && (
                  <div style={{ marginTop: '6px', color: '#b45309', fontSize: '14px' }}>
                    {archiveSummary.display.label}
                  </div>
                )}
              </div>
            )}

            {/* Close button for archive tab */}
            <div style={{ borderTop: '1px solid var(--border-subtle, #f1f5f9)', margin: '22px -24px 0', padding: '18px 24px 0', display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={closeModal}
                className="period-btn-secondary"
              >
                Yopish
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
