import { useVirtualizer } from '@tanstack/react-virtual';
import {
  AlertCircle,
  ArrowUpRight,
  Clock,
  Search,
  TrendingUp,
  Wallet,
  X
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatMoney, WorkerPayrollSummary } from '../../engine/formulaEngine';
import { displayedMoney, payrollDisplay } from '../../engine/payrollDisplay';
import { useWorkbookStore } from '../../store/workbookStore';
import { useAuthStore } from '../../store/authStore';
import { formatUzbekDate } from '../../utils/formatters';
import { getElectronApi, resolveElectronRuntimeMode } from '../../store/runtimeMode';

const VIRTUAL_THRESHOLD = 30;
const ROW_HEIGHT_STANDARD = 52;
const ROW_HEIGHT_COMPACT = 38;
const COLUMN_HEADER_HEIGHT_STANDARD = 44;
const COLUMN_HEADER_HEIGHT_COMPACT = 38;

interface WorkerSummaryRowProps {
  w: WorkerPayrollSummary;
  rowNum: number;
  isSelected?: boolean;
  isCompact?: boolean;
  onSelectRow?: (workerId: number, toggle?: boolean) => void;
  onAvansChange: (workerId: number, val: string) => Promise<boolean> | void;
  onJarimaChange: (workerId: number, val: string) => Promise<boolean> | void;
  onOkladChange: (workerId: number, val: string) => Promise<boolean>;
  onMagazinChange: (workerId: number, val: string) => Promise<boolean>;
  onCancelManualDraft: (label: string) => void;
  canEditManualMoney: boolean;
  manualMoneyReady: boolean;
  canEditPayrollAdjustments: boolean;
  periodContextKey: string;
  onCellFocus: (cellId: string, value: string, formula?: string) => void;
  onOpenWorkerManager: () => void;
  onOpenWorkerDetail: (workerId: number) => void;
  moneyReady: boolean;
  moneyIncomplete: boolean;
}

interface ManualMoneyCellProps {
  workerId: number;
  cellId: string;
  value: number;
  ready: boolean;
  disabled: boolean;
  contextKey: string;
  label: string;
  accent: string;
  isCompact?: boolean;
  onCommit: (workerId: number, val: string) => Promise<boolean>;
  onCellFocus: (cellId: string, value: string) => void;
  onCancelDraft: () => void;
  onSelectRow?: (workerId: number, toggle?: boolean) => void;
}

const ManualMoneyCell = React.memo<ManualMoneyCellProps>(({
  workerId, cellId, value, ready, disabled, contextKey, label, accent, isCompact,
  onCommit, onCellFocus, onCancelDraft, onSelectRow
}) => {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const suppressBlur = useRef(false);
  const focused = useRef(false);
  const draftRef = useRef<string | null>(null);
  const commitRef = useRef<(raw: string) => void>(() => {});
  const priorContext = useRef(contextKey);
  const currentContext = useRef(contextKey);
  currentContext.current = contextKey;
  draftRef.current = draft;

  useEffect(() => {
    if (priorContext.current === contextKey) return;
    const wasFocused = focused.current;
    const abandoned = wasFocused && draftRef.current !== null;
    suppressBlur.current = wasFocused;
    focused.current = false;
    setDraft(null);
    setError(false);
    setIsFocused(false);
    if (wasFocused) inputRef.current?.blur();
    priorContext.current = contextKey;
    if (abandoned) onCancelDraft();
  }, [contextKey, onCancelDraft]);

  useEffect(() => () => {
    if (focused.current && draftRef.current !== null && !inFlight.current) onCancelDraft();
  }, [onCancelDraft]);

  const commit = async (raw: string) => {
    if (disabled || inFlight.current) return;
    inFlight.current = true;
    const startedContext = contextKey;
    const normalized = raw.trim().replace(/[\s,]/g, '');
    const parsed = normalized === '' ? 0 : /^\d+$/.test(normalized) ? Number(normalized) : NaN;
    try {
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        try { await onCommit(workerId, 'invalid'); } catch { /* preserve rejected draft */ }
        if (currentContext.current === startedContext) {
          setDraft(formatMoney(value));
          setError(true);
        }
        return;
      }
      if (parsed === value) {
        if (currentContext.current === startedContext) { setDraft(null); setError(false); }
        return;
      }
      setSaving(true);
      setError(false);
      let accepted = false;
      try { accepted = await onCommit(workerId, String(parsed)); } catch { /* canonical failure stays visible */ }
      if (currentContext.current === startedContext) {
        setDraft(accepted ? null : formatMoney(value));
        setError(!accepted);
      }
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  commitRef.current = (raw) => { void commit(raw); };

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const handleNativeFocus = () => { focused.current = true; setIsFocused(true); suppressBlur.current = false; };
    const handleNativeBlur = () => {
      focused.current = false;
      setIsFocused(false);
      if (suppressBlur.current) return;
      if (draftRef.current !== null) commitRef.current(draftRef.current);
    };
    input.addEventListener('focus', handleNativeFocus);
    input.addEventListener('blur', handleNativeBlur);
    input.addEventListener('focusout', handleNativeBlur);
    return () => {
      input.removeEventListener('focus', handleNativeFocus);
      input.removeEventListener('blur', handleNativeBlur);
      input.removeEventListener('focusout', handleNativeBlur);
    };
  }, []);

  const shown = !ready
    ? 'Noma’lum'
    : draft !== null
    ? draft
    : isFocused
    ? (value > 0 ? String(value) : '')
    : (value > 0 ? formatMoney(value) : '—');

  return (
    <input
      ref={inputRef}
      className="umumiy-manual-input"
      type="text"
      inputMode="numeric"
      aria-label={`${label} #${workerId}`}
      title={!ready ? `${label}: hisob ma’lumoti noma’lum` : disabled ? `${label}: bu davrda tahrirlash mumkin emas` : label}
      value={shown}
      disabled={disabled || !ready || saving}
      aria-invalid={error}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => {
        if (!ready || disabled) return;
        suppressBlur.current = false;
        focused.current = true;
        setIsFocused(true);
        setDraft(null);
        setError(false);
        onCellFocus(cellId, String(value));
        onSelectRow?.(workerId, false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          suppressBlur.current = true;
          if (draftRef.current !== null) void commit(draftRef.current);
          inputRef.current?.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          suppressBlur.current = true;
          focused.current = false;
          setIsFocused(false);
          setDraft(null);
          setError(false);
          inputRef.current?.blur();
        }
      }}
      style={{
        height: isCompact ? '28px' : '34px',
        color: error ? 'var(--status-error-text)' : value > 0 ? accent : '#cbd5e1',
        fontWeight: value > 0 ? 600 : 400,
        opacity: disabled || !ready ? 0.7 : 1
      }}
    />
  );
});

const WorkerSummaryRow = React.memo<WorkerSummaryRowProps>(({
  w,
  rowNum,
  isSelected = false,
  isCompact = false,
  onSelectRow,
  onAvansChange,
  onJarimaChange,
  onOkladChange,
  onMagazinChange,
  onCancelManualDraft,
  canEditManualMoney,
  manualMoneyReady,
  canEditPayrollAdjustments,
  periodContextKey,
  onCellFocus,
  onOpenWorkerManager,
  onOpenWorkerDetail,
  moneyReady,
  moneyIncomplete
}) => {
  const [avansDraft, setAvansDraft] = useState<string | null>(null);
  const [isAvansFocused, setIsAvansFocused] = useState(false);
  const [jarimaDraft, setJarimaDraft] = useState<string | null>(null);
  const [isJarimaFocused, setIsJarimaFocused] = useState(false);
  const avansEdited = useRef(false);
  const jarimaEdited = useRef(false);

  const lastClickTimeRef = useRef(0);

  const handleRowClick = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const now = Date.now();
    if (now - lastClickTimeRef.current < 450) {
      lastClickTimeRef.current = 0;
      onOpenWorkerDetail(w.workerId);
      return;
    }
    lastClickTimeRef.current = now;
    onSelectRow && onSelectRow(w.workerId, false);
  }, [w.workerId, onOpenWorkerDetail, onSelectRow]);

  const handleWorkerNameClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const now = Date.now();
    if (now - lastClickTimeRef.current < 450) {
      lastClickTimeRef.current = 0;
      onOpenWorkerDetail(w.workerId);
      return;
    }
    lastClickTimeRef.current = now;
    onCellFocus(`B${rowNum}`, w.workerName);
    onSelectRow && onSelectRow(w.workerId, false);
  }, [rowNum, w.workerId, w.workerName, onCellFocus, onOpenWorkerDetail, onSelectRow]);

  const handleWorkerIdClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const now = Date.now();
    if (now - lastClickTimeRef.current < 450) {
      lastClickTimeRef.current = 0;
      onOpenWorkerDetail(w.workerId);
      return;
    }
    lastClickTimeRef.current = now;
    onCellFocus(`A${rowNum}`, String(w.workerId));
    onSelectRow && onSelectRow(w.workerId, true);
  }, [rowNum, w.workerId, onCellFocus, onOpenWorkerDetail, onSelectRow]);

  const handleDirectDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    lastClickTimeRef.current = 0;
    onOpenWorkerDetail(w.workerId);
  }, [w.workerId, onOpenWorkerDetail]);

  const formulaC = `=G${rowNum}-F${rowNum}-E${rowNum}-D${rowNum}-I${rowNum}`;
  const money = (value: number) => displayedMoney(value, moneyReady, moneyIncomplete);
  const cancelOkladDraft = useCallback(() => onCancelManualDraft('Oklad'), [onCancelManualDraft]);
  const cancelMagazinDraft = useCallback(() => onCancelManualDraft('Magazin'), [onCancelManualDraft]);

  const rowHeight = isCompact ? ROW_HEIGHT_COMPACT : ROW_HEIGHT_STANDARD;

  const avansShown = !moneyReady
    ? 'Noma’lum'
    : avansDraft !== null
    ? avansDraft
    : isAvansFocused
    ? (w.avans > 0 ? String(w.avans) : '')
    : (w.avans > 0 ? formatMoney(w.avans) : '—');

  const jarimaShown = !moneyReady
    ? 'Noma’lum'
    : jarimaDraft !== null
    ? jarimaDraft
    : isJarimaFocused
    ? (w.jarima > 0 ? String(w.jarima) : '')
    : (w.jarima > 0 ? formatMoney(w.jarima) : '—');

  return (
    <tr
      className={`umumiy-row ${isSelected ? 'selected' : ''}`}
      onClick={handleRowClick}
      onDoubleClick={handleDirectDoubleClick}
      style={{ height: `${rowHeight}px`, cursor: 'pointer' }}
    >
      {/* Col 1: ID */}
      <td
        style={{
          textAlign: 'center',
          position: 'sticky',
          left: 0,
          zIndex: 8,
          backgroundColor: isSelected ? 'rgba(59, 130, 246, 0.12)' : 'var(--bg-surface)'
        }}
        onClick={handleWorkerIdClick}
        onDoubleClick={handleDirectDoubleClick}
        title="Tanlash / Bekor qilish (2 marta: Ishchi hisoboti)"
      >
        <span className="umumiy-id-text" onDoubleClick={handleDirectDoubleClick}>{w.workerId}</span>
      </td>

      {/* Col 2: ISHCHI F.I.O */}
      <td
        style={{
          textAlign: 'left',
          paddingLeft: '16px',
          position: 'sticky',
          left: '50px',
          zIndex: 8,
          backgroundColor: isSelected ? 'rgba(59, 130, 246, 0.12)' : 'var(--bg-surface)',
          maxWidth: '220px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          userSelect: 'none'
        }}
        onClick={handleWorkerNameClick}
        onDoubleClick={handleDirectDoubleClick}
        title="2 marta bosing: Ishchi hisoboti va bajarilgan pattalar"
      >
        <span className="umumiy-worker-name" onDoubleClick={handleDirectDoubleClick}>{w.workerName}</span>
      </td>

      {/* Col 3: UMUMIY ISH HAQI */}
      <td
        style={{ textAlign: 'right', paddingRight: '14px' }}
        onClick={() => {
          onCellFocus(`G${rowNum}`, moneyReady ? String(w.umumiy) : 'Noma’lum', 'Davr bo‘yicha hisob');
          onSelectRow && onSelectRow(w.workerId, false);
        }}
      >
        {w.umumiy > 0 ? (
          <span style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: isCompact ? '15px' : '15px' }}>
            {money(w.umumiy)}
          </span>
        ) : (
          <span style={{ color: '#cbd5e1' }}>—</span>
        )}
      </td>

      {/* Col 4: OKLAD */}
      <td style={{ textAlign: 'right', padding: '2px 8px' }}>
        <ManualMoneyCell
          workerId={w.workerId}
          cellId={`H${rowNum}`}
          value={w.oklad}
          ready={manualMoneyReady}
          disabled={!canEditManualMoney}
          contextKey={periodContextKey}
          label="Oklad"
          accent="#059669"
          isCompact={isCompact}
          onCommit={onOkladChange}
          onCellFocus={onCellFocus}
          onSelectRow={onSelectRow}
          onCancelDraft={cancelOkladDraft}
        />
      </td>

      {/* Col 5: STAJ */}
      <td
        style={{ textAlign: 'right', paddingRight: '12px' }}
        onClick={() => {
          onCellFocus(`D${rowNum}`, String(w.staj));
          onSelectRow && onSelectRow(w.workerId, false);
          onOpenWorkerManager();
        }}
        title="Staj Ishchilar ro'yxatidan o'zgartiriladi (ochish uchun bosing)"
      >
        {w.staj > 0 ? (
          <span className="umumiy-staj-pill">{money(-w.staj)}</span>
        ) : (
          <span style={{ color: '#cbd5e1' }}>—</span>
        )}
      </td>

      {/* Col 6: AVANS */}
      <td
        style={{ textAlign: 'right', padding: '2px 8px' }}
        onClick={() => {
          onCellFocus(`E${rowNum}`, String(w.avans));
          onSelectRow && onSelectRow(w.workerId, false);
        }}
      >
        <input
          type="text"
          inputMode="numeric"
          className="umumiy-manual-input"
          aria-label={`Avans #${w.workerId}`}
          value={avansShown}
          disabled={!canEditPayrollAdjustments || !moneyReady}
          onChange={(e) => { avansEdited.current = true; setAvansDraft(e.target.value); }}
          onFocus={() => {
            avansEdited.current = false;
            setIsAvansFocused(true);
            setAvansDraft(w.avans > 0 ? String(w.avans) : '');
            onCellFocus(`E${rowNum}`, String(w.avans));
            onSelectRow && onSelectRow(w.workerId, false);
          }}
          onBlur={async (e) => {
            const raw = e.currentTarget.value;
            const changed = avansEdited.current && Math.max(0, Number(raw.replace(/[\s,]/g, '')) || 0) !== w.avans;
            avansEdited.current = false;
            setIsAvansFocused(false);
            if (changed) await onAvansChange(w.workerId, raw);
            setAvansDraft(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              avansEdited.current = false;
              setIsAvansFocused(false);
              setAvansDraft(null);
              e.currentTarget.blur();
            }
          }}
          style={{
            height: isCompact ? '28px' : '34px',
            color: w.avans > 0 ? '#d97706' : '#cbd5e1',
            fontWeight: w.avans > 0 ? 600 : 400
          }}
        />
      </td>

      {/* Col 7: JARIMA */}
      <td
        style={{ textAlign: 'right', padding: '2px 8px' }}
        onClick={() => {
          onCellFocus(`F${rowNum}`, String(w.jarima));
          onSelectRow && onSelectRow(w.workerId, false);
        }}
      >
        <input
          type="text"
          inputMode="numeric"
          className="umumiy-manual-input"
          aria-label={`Jarima #${w.workerId}`}
          value={jarimaShown}
          disabled={!canEditPayrollAdjustments || !moneyReady}
          onChange={(e) => { jarimaEdited.current = true; setJarimaDraft(e.target.value); }}
          onFocus={() => {
            jarimaEdited.current = false;
            setIsJarimaFocused(true);
            setJarimaDraft(w.jarima > 0 ? String(w.jarima) : '');
            onCellFocus(`F${rowNum}`, String(w.jarima));
            onSelectRow && onSelectRow(w.workerId, false);
          }}
          onBlur={async (e) => {
            const raw = e.currentTarget.value;
            const changed = jarimaEdited.current && Math.max(0, Number(raw.replace(/[\s,]/g, '')) || 0) !== w.jarima;
            jarimaEdited.current = false;
            setIsJarimaFocused(false);
            if (changed) await onJarimaChange(w.workerId, raw);
            setJarimaDraft(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              jarimaEdited.current = false;
              setIsJarimaFocused(false);
              setJarimaDraft(null);
              e.currentTarget.blur();
            }
          }}
          style={{
            height: isCompact ? '28px' : '34px',
            color: w.jarima > 0 ? '#ef4444' : '#cbd5e1',
            fontWeight: w.jarima > 0 ? 600 : 400
          }}
        />
      </td>

      {/* Col 8: MAGAZIN */}
      <td style={{ textAlign: 'right', padding: '2px 8px' }}>
        <ManualMoneyCell
          workerId={w.workerId}
          cellId={`I${rowNum}`}
          value={w.magazin}
          ready={manualMoneyReady}
          disabled={!canEditManualMoney}
          contextKey={periodContextKey}
          label="Magazin"
          accent="#0284c7"
          isCompact={isCompact}
          onCommit={onMagazinChange}
          onCellFocus={onCellFocus}
          onSelectRow={onSelectRow}
          onCancelDraft={cancelMagazinDraft}
        />
      </td>

      {/* Col 9: SOF FOYDA */}
      <td
        style={{ textAlign: 'right', paddingRight: '16px' }}
        onClick={() => {
          onCellFocus(`C${rowNum}`, moneyReady ? String(w.sofFoyda) : 'Noma’lum', formulaC);
          onSelectRow && onSelectRow(w.workerId, false);
        }}
        title={`Qo'lga tegadigan summa: ${money(w.sofFoyda)}`}
      >
        {w.sofFoyda > 0 ? (
          <span className="umumiy-sof-positive-pill">
            {money(w.sofFoyda)}
          </span>
        ) : w.sofFoyda < 0 ? (
          <span className="umumiy-sof-negative-pill">
            <AlertCircle size={13} strokeWidth={2.4} />
            <span>{money(w.sofFoyda)}</span>
          </span>
        ) : (
          <span style={{ color: '#cbd5e1' }}>—</span>
        )}
      </td>
    </tr>
  );
});

export const UmumiyView: React.FC = () => {
  const workers = useWorkbookStore((s) => s.workers);
  const models = useWorkbookStore((s) => s.models);
  const currentPeriod = useWorkbookStore((s) => s.currentPeriod);
  const selectedArchiveFilename = useWorkbookStore((s) => s.selectedArchiveFilename);
  const periods = useWorkbookStore((s) => s.periods);
  const payrollValuation = useWorkbookStore((s) => s.payrollValuation);
  const companyId = useWorkbookStore((s) => s.licenseStatus?.companyId);
  const licenseStatus = useWorkbookStore((s) => s.licenseStatus);
  const isServerConnected = useWorkbookStore((s) => s.isServerConnected);
  const updateWorker = useWorkbookStore((s) => s.updateWorker);
  const addNotification = useWorkbookStore((s) => s.addNotification);
  const setActiveCell = useWorkbookStore((s) => s.setActiveCell);
  const openModal = useWorkbookStore((s) => s.openModal);
  const authUserId = useAuthStore((s) => s.user?.uid || '');
  const authRole = useAuthStore((s) => s.role || '');
  const canEditWorkerMoney = useAuthStore((s) => s.companyId === companyId
    && s.permissions.includes('edit:workers') && s.permissions.includes('edit:avans'));

  const searchScopeKey = `umumiy-worker-search:${JSON.stringify([
    companyId || 'unbound', currentPeriod.id, selectedArchiveFilename || '',
    licenseStatus?.activationId || '', licenseStatus?.machineId || '', licenseStatus?.role || '', authUserId, authRole
  ])}`;

  const [searchState, setSearchState] = useState(() => {
    try { return { scope: searchScopeKey, value: window.sessionStorage.getItem(searchScopeKey) || '' }; }
    catch { return { scope: searchScopeKey, value: '' }; }
  });
  const searchQuery = searchState.scope === searchScopeKey ? searchState.value : '';

  useEffect(() => {
    try { setSearchState({ scope: searchScopeKey, value: window.sessionStorage.getItem(searchScopeKey) || '' }); }
    catch { setSearchState({ scope: searchScopeKey, value: '' }); }
  }, [searchScopeKey]);

  const updateSearchQuery = useCallback((value: string) => {
    setSearchState({ scope: searchScopeKey, value });
    try { window.sessionStorage.setItem(searchScopeKey, value); } catch { /* in-memory fallback */ }
  }, [searchScopeKey]);

  // Filter Pill Mode: 'all' | 'avans' | 'jarima' | 'manfiy' | 'nol' | 'oklad' | 'magazin'
  const [filterMode, setFilterMode] = useState<'all' | 'avans' | 'jarima' | 'manfiy' | 'nol' | 'oklad' | 'magazin'>('all');

  // Compact View toggle
  const [isCompact, setIsCompact] = useState(() => {
    try { return window.localStorage.getItem('umumiy_compact_view') === 'true'; }
    catch { return false; }
  });

  const toggleCompact = useCallback(() => {
    setIsCompact((prev) => {
      const next = !prev;
      try { window.localStorage.setItem('umumiy_compact_view', String(next)); } catch { /* fallback */ }
      return next;
    });
  }, []);

  const [selectedWorkerId, setSelectedWorkerId] = useState<number | null>(null);
  const payrollReadAttempt = useRef('');

  const handleSelectRow = useCallback((workerId: number, toggle = false) => {
    setSelectedWorkerId((prev) => {
      if (toggle) {
        return prev === workerId ? null : workerId;
      }
      return workerId;
    });
  }, []);

  // Keyboard shortcut: Escape clears row selection
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedWorkerId(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const display = useMemo(() => payrollDisplay(models, workers, payrollValuation, companyId, currentPeriod.id),
    [models, workers, payrollValuation, companyId, currentPeriod.id]);

  // The workbook projection and payroll valuation are read together at startup, but a
  // legacy/partial projection can lack the latter. Once sync runtime is ready, retry
  // the narrow company+period-bound SQLite payroll read instead of leaving the report
  // permanently at “Noma’lum”. Never use a result after the active company/period changes.
  useEffect(() => {
    const attemptKey = `${companyId || ''}:${currentPeriod.id}`;
    if (!companyId || !currentPeriod.id || !isServerConnected || display.reportReady
      || payrollReadAttempt.current === attemptKey) return;
    payrollReadAttempt.current = attemptKey;

    let cancelled = false;
    void (async () => {
      const api = getElectronApi();
      const runtime = await resolveElectronRuntimeMode(api);
      if (runtime.mode !== 'sync' || !runtime.success || typeof api?.PayrollRead !== 'function') return;
      try {
        const result = await api.PayrollRead(companyId, currentPeriod.id);
        const state = useWorkbookStore.getState();
        if (cancelled || state.licenseStatus?.companyId !== companyId || state.currentPeriod.id !== currentPeriod.id) return;
        if (result?.success && result.companyId === companyId && result.periodId === currentPeriod.id
          && result.payrollValuation?.companyId === companyId
          && result.payrollValuation.period?.periodId === currentPeriod.id) {
          useWorkbookStore.setState({ payrollValuation: result.payrollValuation });
        } else {
          addNotification('warning', 'Hisob ma’lumoti topilmadi',
            `Joriy davr (${currentPeriod.id}) uchun ish haqi hisobini SQLite’dan o‘qib bo‘lmadi: ${result?.error || result?.code || result?.payrollValuation?.accountingReasons?.join(', ') || 'davrga bog‘langan hisob ma’lumoti mavjud emas'}.`);
        }
      } catch (error) {
        if (!cancelled) addNotification('warning', 'Hisobni o‘qish xatosi',
          error instanceof Error ? error.message : 'SQLite ish haqi hisobini o‘qib bo‘lmadi.');
      }
    })();
    return () => { cancelled = true; };
  }, [addNotification, companyId, currentPeriod.id, display.reportReady, isServerConnected]);
  const masterReport = display.masterReport;
  const money = (value: number) => displayedMoney(value, display.reportReady, display.incomplete);
  const selectedPeriodOpen = periods.some((period) => period.id === currentPeriod.id && !period.isClosed)
    && !currentPeriod.isClosed;
  const canEditManualMoney = Boolean(companyId && canEditWorkerMoney && display.ready
    && selectedPeriodOpen && !display.closed);
  const canEditPayrollAdjustments = !companyId || Boolean(canEditWorkerMoney && display.ready
    && selectedPeriodOpen && !display.closed);
  const periodContextKey = `${companyId || 'unbound'}:${currentPeriod.id}`;

  // Filter workers based on search query and quick filter pills
  const filteredWorkers = useMemo(() => {
    let list = masterReport.workers;
    if (filterMode === 'avans') {
      list = list.filter((w) => w.avans > 0);
    } else if (filterMode === 'jarima') {
      list = list.filter((w) => w.jarima > 0);
    } else if (filterMode === 'manfiy') {
      list = list.filter((w) => w.sofFoyda < 0);
    } else if (filterMode === 'nol') {
      list = list.filter((w) => w.sofFoyda === 0);
    } else if (filterMode === 'oklad') {
      list = list.filter((w) => w.oklad > 0);
    } else if (filterMode === 'magazin') {
      list = list.filter((w) => w.magazin > 0);
    }

    if (!searchQuery.trim()) return list;
    const q = searchQuery.toLowerCase().trim();
    return list.filter(
      (w: WorkerPayrollSummary) => w.workerName.toLowerCase().includes(q) || String(w.workerId).includes(q)
    );
  }, [masterReport.workers, filterMode, searchQuery]);

  const handleAvansChange = useCallback((workerId: number, val: string) => {
    const num = Number(val.replace(/\s+/g, '').replace(/,/g, '')) || 0;
    return updateWorker(workerId, { avans: num });
  }, [updateWorker]);

  const handleJarimaChange = useCallback((workerId: number, val: string) => {
    const num = Number(val.replace(/\s+/g, '').replace(/,/g, '')) || 0;
    return updateWorker(workerId, { jarima: num });
  }, [updateWorker]);

  const parseManualTarget = (value: string) => {
    const normalized = value.trim().replace(/[\s,]/g, '');
    if (normalized === '') return 0;
    if (!/^\d+$/.test(normalized)) return NaN;
    const parsed = Number(normalized);
    return Number.isSafeInteger(parsed) ? parsed : NaN;
  };
  const savingWorkerMoney = useRef(new Set<string>());
  const handleManualChange = useCallback(async (workerId: number, field: 'oklad' | 'magazin', val: string) => {
    const key = `${periodContextKey}:${workerId}`;
    if (savingWorkerMoney.current.has(key)) {
      addNotification('warning', 'Tahrir davom etmoqda', 'Ushbu ishchi uchun oldingi pul o‘zgarishi yakunlansin.');
      return false;
    }
    savingWorkerMoney.current.add(key);
    try { return await updateWorker(workerId, { [field]: parseManualTarget(val) }); }
    finally { savingWorkerMoney.current.delete(key); }
  }, [periodContextKey, updateWorker, addNotification]);

  const handleOkladChange = useCallback((workerId: number, val: string) =>
    handleManualChange(workerId, 'oklad', val), [handleManualChange]);
  const handleMagazinChange = useCallback((workerId: number, val: string) =>
    handleManualChange(workerId, 'magazin', val), [handleManualChange]);
  const handleCancelManualDraft = useCallback((label: string) => {
    addNotification('warning', 'Tahrir bekor qilindi', `${label}: kompaniya yoki davr o‘zgardi; kiritilmagan qiymat saqlanmadi.`);
  }, [addNotification]);

  const handleCellFocus = useCallback((cellId: string, value: string, formula?: string) => {
    setActiveCell({
      cellId,
      sheetName: 'Umumiy',
      value,
      formula
    });
  }, [setActiveCell]);

  const handleOpenWorkerManager = useCallback(() => {
    openModal({ type: 'worker_manager' });
  }, [openModal]);

  const handleOpenWorkerDetail = useCallback((workerId: number) => {
    openModal({ type: 'worker_detail', workerId });
  }, [openModal]);

  const currentRowHeight = isCompact ? ROW_HEIGHT_COMPACT : ROW_HEIGHT_STANDARD;
  const currentHeaderHeight = isCompact ? COLUMN_HEADER_HEIGHT_COMPACT : COLUMN_HEADER_HEIGHT_STANDARD;

  const useVirtual = filteredWorkers.length > VIRTUAL_THRESHOLD;
  const tbodyRef = useRef<HTMLDivElement>(null);
  const grandTotalRowRef = useRef<HTMLTableRowElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: filteredWorkers.length,
    getScrollElement: () => tbodyRef.current,
    estimateSize: () => currentRowHeight,
    overscan: 8,
    enabled: useVirtual
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const paddingBottom = virtualItems.length > 0 ? (rowVirtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end) : 0;
  const totalCols = 9;

  return (
    <div className="umumiy-page">
      {/* 1. Header Title & Subtitle */}
      <div className="umumiy-heading">
        <h1>Umumiy oylik hisobot</h1>
        <p>
          {filteredWorkers.length === masterReport.workers.length
            ? `${masterReport.workers.length} ishchi • ${formatUzbekDate(currentPeriod.startDate)} dan`
            : `${filteredWorkers.length} / ${masterReport.workers.length} ishchi • ${formatUzbekDate(currentPeriod.startDate)} dan`}
        </p>
      </div>

      {/* 2. KPI Stat Cards (4 cards matching design screenshot 1:1) */}
      <div className="umumiy-kpi-grid">
        {/* Card 1: Sof to'lanadigan foyda */}
        <div className="umumiy-kpi-card">
          <div className="umumiy-kpi-icon" style={{ backgroundColor: '#e8f7ee', color: '#059669' }}>
            <Wallet size={20} strokeWidth={2.2} />
          </div>
          <div className="umumiy-kpi-copy">
            <span className="umumiy-kpi-label">Sof to'lanadigan foyda</span>
            <div className="umumiy-kpi-value" style={{ color: '#059669' }}>
              {money(masterReport.totalSofFoyda)}
              <span className="umumiy-kpi-unit">so'm</span>
            </div>
          </div>
        </div>

        {/* Card 2: Jami ishlangan summa */}
        <div className="umumiy-kpi-card">
          <div className="umumiy-kpi-icon" style={{ backgroundColor: '#eff6ff', color: '#2563eb' }}>
            <TrendingUp size={20} strokeWidth={2.2} />
          </div>
          <div className="umumiy-kpi-copy">
            <span className="umumiy-kpi-label">Jami ishlangan summa</span>
            <div className="umumiy-kpi-value" style={{ color: '#2563eb' }}>
              {money(masterReport.totalUmumiy)}
              <span className="umumiy-kpi-unit">so'm</span>
            </div>
          </div>
        </div>

        {/* Card 3: Berilgan avanslar */}
        <div className="umumiy-kpi-card">
          <div className="umumiy-kpi-icon" style={{ backgroundColor: '#fef3c7', color: '#d97706' }}>
            <ArrowUpRight size={20} strokeWidth={2.2} />
          </div>
          <div className="umumiy-kpi-copy">
            <span className="umumiy-kpi-label">Berilgan avanslar</span>
            <div className="umumiy-kpi-value" style={{ color: '#b45309' }}>
              {money(masterReport.totalAvans)}
              <span className="umumiy-kpi-unit">so'm</span>
            </div>
          </div>
        </div>

        {/* Card 4: Doimiy stajlar */}
        <div className="umumiy-kpi-card">
          <div className="umumiy-kpi-icon" style={{ backgroundColor: '#f3e8ff', color: '#7c3aed' }}>
            <Clock size={20} strokeWidth={2.2} />
          </div>
          <div className="umumiy-kpi-copy">
            <span className="umumiy-kpi-label">Doimiy stajlar</span>
            <div className="umumiy-kpi-value" style={{ color: '#7c3aed' }}>
              {money(-masterReport.totalStaj)}
              <span className="umumiy-kpi-unit">so'm</span>
            </div>
          </div>
        </div>
      </div>

      {/* 3. Toolbar: Search + Quick Filter Pills (Yonma-yon) + Zich ko'rinish Button (O'ngda) */}
      <div className="umumiy-toolbar">
        {/* Left: Search input and Quick Filter Pills together */}
        <div className="umumiy-toolbar-left">
          <div className="umumiy-search-box">
            <Search size={15} className="search-icon" />
            <input
              type="text"
              className="umumiy-search-input"
              placeholder="Ism yoki ID bo'yicha qidirish"
              value={searchQuery}
              onChange={(e) => updateSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                className="umumiy-search-clear"
                title="Qidiruvni tozalash"
                onClick={() => updateSearchQuery('')}
              >
                <X size={13} />
              </button>
            )}
          </div>

          <div className="umumiy-pills">
            <button
              type="button"
              className={`umumiy-pill-btn ${filterMode === 'all' ? 'active' : ''}`}
              onClick={() => setFilterMode('all')}
            >
              Hammasi
            </button>
            <button
              type="button"
              className={`umumiy-pill-btn ${filterMode === 'avans' ? 'active' : ''}`}
              onClick={() => setFilterMode('avans')}
            >
              Avansli
            </button>
            <button
              type="button"
              className={`umumiy-pill-btn ${filterMode === 'jarima' ? 'active' : ''}`}
              onClick={() => setFilterMode('jarima')}
            >
              Jarimali
            </button>
            <button
              type="button"
              className={`umumiy-pill-btn ${filterMode === 'manfiy' ? 'active' : ''}`}
              onClick={() => setFilterMode('manfiy')}
            >
              Manfiy
            </button>
            <button
              type="button"
              className={`umumiy-pill-btn ${filterMode === 'nol' ? 'active' : ''}`}
              onClick={() => setFilterMode('nol')}
            >
              Nol
            </button>
            <button
              type="button"
              className={`umumiy-pill-btn ${filterMode === 'oklad' ? 'active' : ''}`}
              onClick={() => setFilterMode('oklad')}
            >
              Okladli
            </button>
            <button
              type="button"
              className={`umumiy-pill-btn ${filterMode === 'magazin' ? 'active' : ''}`}
              onClick={() => setFilterMode('magazin')}
            >
              Magazinli
            </button>
          </div>
        </div>

        {/* Right: Zich ko'rinish pill button */}
        <button
          type="button"
          className={`umumiy-compact-btn ${isCompact ? 'active' : ''}`}
          onClick={toggleCompact}
          title="Zichlashtirilgan jadval ko'rinishi"
        >
          Zich ko'rinish
        </button>
      </div>

      {/* 4. Table Card */}
      <div ref={tbodyRef} className="umumiy-table-card">
        <table className={`umumiy-table ${isCompact ? 'compact' : ''}`}>
          <colgroup>
            <col style={{ width: '50px' }} />
            <col style={{ width: '220px' }} />
            <col style={{ width: '140px' }} />
            <col style={{ width: '110px' }} />
            <col style={{ width: '100px' }} />
            <col style={{ width: '110px' }} />
            <col style={{ width: '100px' }} />
            <col style={{ width: '110px' }} />
            <col style={{ width: '140px' }} />
          </colgroup>

          <thead>
            <tr style={{ height: `${currentHeaderHeight}px` }}>
              <th className="umumiy-th" style={{ width: '50px', textAlign: 'center', left: 0, zIndex: 25 }}>
                ID
              </th>
              <th className="umumiy-th" style={{ width: '220px', textAlign: 'left', paddingLeft: '16px', left: '50px', zIndex: 25 }}>
                ISHCHI F.I.O
              </th>
              <th className="umumiy-th" style={{ width: '140px', textAlign: 'right', paddingRight: '14px' }}>
                UMUMIY ISH HAQI
              </th>
              <th className="umumiy-th" style={{ width: '110px', textAlign: 'right', paddingRight: '12px' }}>
                OKLAD
              </th>
              <th className="umumiy-th" style={{ width: '100px', textAlign: 'right', paddingRight: '12px' }}>
                STAJ
              </th>
              <th className="umumiy-th" style={{ width: '110px', textAlign: 'right', paddingRight: '12px' }}>
                AVANS
              </th>
              <th className="umumiy-th" style={{ width: '100px', textAlign: 'right', paddingRight: '12px' }}>
                JARIMA
              </th>
              <th className="umumiy-th" style={{ width: '110px', textAlign: 'right', paddingRight: '12px' }}>
                MAGAZIN
              </th>
              <th className="umumiy-th" style={{ width: '140px', textAlign: 'right', paddingRight: '16px' }}>
                SOF FOYDA
              </th>
            </tr>
          </thead>

          <tbody>
            {useVirtual ? (
              <>
                {paddingTop > 0 && (
                  <tr style={{ height: `${paddingTop}px` }}>
                    <td colSpan={totalCols} style={{ padding: 0, border: 'none' }} />
                  </tr>
                )}
                {virtualItems.map((virtualRow) => {
                  const w = filteredWorkers[virtualRow.index];
                  const rowNum = 3 + virtualRow.index;
                  return (
                    <WorkerSummaryRow
                      key={w.workerId}
                      w={w}
                      rowNum={rowNum}
                      isSelected={selectedWorkerId === w.workerId}
                      isCompact={isCompact}
                      onSelectRow={handleSelectRow}
                      onAvansChange={handleAvansChange}
                      onJarimaChange={handleJarimaChange}
                      onOkladChange={handleOkladChange}
                      onMagazinChange={handleMagazinChange}
                      onCancelManualDraft={handleCancelManualDraft}
                      canEditManualMoney={canEditManualMoney}
                      manualMoneyReady={display.manualMoneyReady.has(w.workerId)}
                      canEditPayrollAdjustments={canEditPayrollAdjustments}
                      periodContextKey={periodContextKey}
                      onCellFocus={handleCellFocus}
                      onOpenWorkerManager={handleOpenWorkerManager}
                      onOpenWorkerDetail={handleOpenWorkerDetail}
                      moneyReady={display.workerMoneyReady.has(w.workerId)}
                      moneyIncomplete={display.incomplete}
                    />
                  );
                })}
                {paddingBottom > 0 && (
                  <tr style={{ height: `${paddingBottom}px` }}>
                    <td colSpan={totalCols} style={{ padding: 0, border: 'none' }} />
                  </tr>
                )}
              </>
            ) : (
              <>
                {filteredWorkers.map((w, idx) => {
                  const rowNum = 3 + idx;
                  return (
                    <WorkerSummaryRow
                      key={w.workerId}
                      w={w}
                      rowNum={rowNum}
                      isSelected={selectedWorkerId === w.workerId}
                      isCompact={isCompact}
                      onSelectRow={handleSelectRow}
                      onAvansChange={handleAvansChange}
                      onJarimaChange={handleJarimaChange}
                      onOkladChange={handleOkladChange}
                      onMagazinChange={handleMagazinChange}
                      onCancelManualDraft={handleCancelManualDraft}
                      canEditManualMoney={canEditManualMoney}
                      manualMoneyReady={display.manualMoneyReady.has(w.workerId)}
                      canEditPayrollAdjustments={canEditPayrollAdjustments}
                      periodContextKey={periodContextKey}
                      onCellFocus={handleCellFocus}
                      onOpenWorkerManager={handleOpenWorkerManager}
                      onOpenWorkerDetail={handleOpenWorkerDetail}
                      moneyReady={display.workerMoneyReady.has(w.workerId)}
                      moneyIncomplete={display.incomplete}
                    />
                  );
                })}
                {filteredWorkers.length === 0 && (
                  <tr>
                    <td
                      colSpan={totalCols}
                      style={{
                        textAlign: 'center',
                        padding: '36px',
                        color: 'var(--text-muted, #94a3b8)',
                        fontSize: '15px'
                      }}
                    >
                      Ishchi topilmadi
                    </td>
                  </tr>
                )}
                <tr className="umumiy-table-spacer">
                  <td colSpan={totalCols} style={{ padding: 0, border: 'none', height: '100%', background: 'transparent' }} />
                </tr>
              </>
            )}
          </tbody>

          {/* 5. Grand Total Row (Pinned Sticky Footer) */}
          <tfoot className="umumiy-tfoot">
            <tr className="umumiy-total-row" ref={grandTotalRowRef}>
              <td
                style={{
                  textAlign: 'center',
                  color: '#065f46',
                  fontWeight: 700,
                  fontSize: isCompact ? '15px' : '15px',
                  position: 'sticky',
                  left: 0,
                  bottom: 0,
                  zIndex: 22
                }}
              >
                —
              </td>
              <td
                style={{
                  textAlign: 'left',
                  paddingLeft: '16px',
                  fontWeight: 700,
                  fontSize: isCompact ? '15px' : '15px',
                  color: '#065f46',
                  whiteSpace: 'nowrap',
                  position: 'sticky',
                  left: '50px',
                  bottom: 0,
                  zIndex: 22
                }}
              >
                Jami - {masterReport.workers.length} ishchi
              </td>
              <td
                style={{
                  textAlign: 'right',
                  fontWeight: 800,
                  fontSize: isCompact ? '15px' : '17px',
                  paddingRight: '14px',
                  color: '#065f46',
                  cursor: 'pointer',
                  position: 'sticky',
                  bottom: 0,
                  zIndex: 20
                }}
                onClick={() => handleCellFocus(`G${workers.length + 3}`, display.reportReady ? String(masterReport.totalUmumiy) : 'Noma’lum', 'piecework + Oklad')}
              >
                {money(masterReport.totalUmumiy)}
              </td>
              <td
                style={{
                  textAlign: 'right',
                  fontWeight: 700,
                  fontSize: isCompact ? '15px' : '15px',
                  paddingRight: '12px',
                  color: '#065f46',
                  cursor: 'pointer',
                  position: 'sticky',
                  bottom: 0,
                  zIndex: 20
                }}
                onClick={() => handleCellFocus(`H${workers.length + 3}`, display.reportReady ? String(masterReport.totalOklad) : 'Noma’lum', 'Davr bo‘yicha Oklad')}
              >
                {masterReport.totalOklad > 0 ? money(masterReport.totalOklad) : '—'}
              </td>
              <td
                style={{
                  textAlign: 'right',
                  fontWeight: 700,
                  fontSize: isCompact ? '15px' : '15px',
                  paddingRight: '12px',
                  color: '#065f46',
                  cursor: 'pointer',
                  position: 'sticky',
                  bottom: 0,
                  zIndex: 20
                }}
                onClick={() => handleCellFocus(`D${workers.length + 3}`, display.reportReady ? String(masterReport.totalStaj) : 'Noma’lum', '=SUM(...)')}
              >
                {masterReport.totalStaj > 0 ? money(-masterReport.totalStaj) : '—'}
              </td>
              <td
                style={{
                  textAlign: 'right',
                  fontWeight: 700,
                  fontSize: isCompact ? '15px' : '15px',
                  paddingRight: '12px',
                  color: '#065f46',
                  cursor: 'pointer',
                  position: 'sticky',
                  bottom: 0,
                  zIndex: 20
                }}
                onClick={() => handleCellFocus(`E${workers.length + 3}`, display.reportReady ? String(masterReport.totalAvans) : 'Noma’lum', '=SUM(...)')}
              >
                {masterReport.totalAvans > 0 ? money(masterReport.totalAvans) : '—'}
              </td>
              <td
                style={{
                  textAlign: 'right',
                  fontWeight: 700,
                  fontSize: isCompact ? '15px' : '15px',
                  paddingRight: '12px',
                  color: '#065f46',
                  cursor: 'pointer',
                  position: 'sticky',
                  bottom: 0,
                  zIndex: 20
                }}
                onClick={() => handleCellFocus(`F${workers.length + 3}`, display.reportReady ? String(masterReport.totalJarima) : 'Noma’lum', '=SUM(...)')}
              >
                {masterReport.totalJarima > 0 ? money(masterReport.totalJarima) : '—'}
              </td>
              <td
                style={{
                  textAlign: 'right',
                  fontWeight: 700,
                  fontSize: isCompact ? '15px' : '15px',
                  paddingRight: '12px',
                  color: '#065f46',
                  cursor: 'pointer',
                  position: 'sticky',
                  bottom: 0,
                  zIndex: 20
                }}
                onClick={() => handleCellFocus(`I${workers.length + 3}`, display.reportReady ? String(masterReport.totalMagazin) : 'Noma’lum', 'Davr bo‘yicha Magazin')}
              >
                {masterReport.totalMagazin > 0 ? money(masterReport.totalMagazin) : '—'}
              </td>
              <td
                style={{
                  textAlign: 'right',
                  fontWeight: 800,
                  fontSize: isCompact ? '15px' : '17.5px',
                  paddingRight: '16px',
                  color: '#065f46',
                  cursor: 'pointer',
                  position: 'sticky',
                  bottom: 0,
                  zIndex: 20
                }}
                onClick={() => handleCellFocus(`C${workers.length + 3}`, display.reportReady ? String(masterReport.totalSofFoyda) : 'Noma’lum', `=G${workers.length + 3}-F${workers.length + 3}-E${workers.length + 3}-D${workers.length + 3}-I${workers.length + 3}`)}
              >
                {money(masterReport.totalSofFoyda)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
};
