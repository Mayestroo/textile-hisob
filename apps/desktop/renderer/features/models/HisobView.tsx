import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useWorkbookStore } from '../../store/workbookStore';
import { ModelConfig } from '../../types/workbook';
import { calculateModelTotals, formatNumber } from '../../engine/formulaEngine';
import { displayedMoney, payrollDisplay } from '../../engine/payrollDisplay';
import { getExcelColumnLetter } from '../../utils/excelUtils';
import { Search, Plus, Trash2, ArrowLeft } from 'lucide-react';
import { CustomSelect } from '../../components/ui/CustomSelect';
import { getElectronApi, resolveElectronRuntimeMode } from '../../store/runtimeMode';
import { captureSessionIdentity, isSessionCurrent, type SessionIdentity } from '../../store/sessionGuard';

type AdjustmentSource = {
  originalTicketId: string;
  originalEntryId: string;
  originalPeriodId: string | null;
  periodName: string | null;
  periodStartDate: string | null;
  originalRateSnapshot: number | null;
  partyNumber: string;
  pattaNumber: number;
};

export function AdjustmentSourceSelection({
  sources,
  selectedEntry,
  onSelect
}: {
  sources: AdjustmentSource[];
  selectedEntry: string;
  onSelect: (entryId: string) => void;
}) {
  if (sources.length === 0) return <p>Mos kiritilgan ish topilmadi. Tuzatish yuborilmadi.</p>;
  return (
    <CustomSelect
      ariaLabel="Asl patta va davr"
      value={selectedEntry}
      onChange={(val: any) => onSelect(typeof val === 'string' ? val : val?.target?.value ?? String(val))}
      placeholder="Manbani tanlang"
      width="100%"
      options={[
        { value: '', label: 'Manbani tanlang' },
        ...sources.map((source) => ({
          value: source.originalEntryId,
          label: `Patta ${source.partyNumber}/${source.pattaNumber} · ${source.periodName || source.periodStartDate || source.originalPeriodId || 'Davr noma’lum'} · saqlangan narx: ${source.originalRateSnapshot == null ? 'noma’lum' : `${source.originalRateSnapshot} so‘m`}`
        }))
      ]}
    />
  );
}

export async function readEnteredAdjustmentSources(
  companyId: string,
  modelId: string,
  workerId: number,
  opName: string
): Promise<AdjustmentSource[]> {
  const result = await getElectronApi()?.AdjustmentSources?.(companyId, modelId, workerId, opName);
  if (!result?.success || !Array.isArray(result.data)) throw new Error('Adjustment sources unavailable');
  return result.data;
}

export class SourceRequestGuard {
  private generation = 0;
  private active = true;
  begin() { return ++this.generation; }
  invalidate() { ++this.generation; }
  dispose() { this.active = false; this.invalidate(); }
  isCurrent(generation: number) { return this.active && generation === this.generation; }
}

export function isAdjustmentEditContextCurrent(
  context: { companyId: string; periodId: string; session: SessionIdentity; modelId: string; workerId: number; opName: string },
  latest: { companyId?: string | null; periodId: string; modelId: string; workerIds: number[]; operationNames: string[] }
) {
  return context.periodId === latest.periodId && context.modelId === latest.modelId
    && latest.workerIds.includes(context.workerId) && latest.operationNames.includes(context.opName)
    && isSessionCurrent(context.session, latest.companyId);
}

export async function guardedAdjustmentSources(
  guard: SourceRequestGuard,
  generation: number,
  contextIsCurrent: () => boolean,
  read: () => Promise<AdjustmentSource[]>,
  onSuccess: (sources: AdjustmentSource[]) => void,
  onError: () => void,
  onDone: () => void
) {
  const current = () => guard.isCurrent(generation) && contextIsCurrent();
  try {
    const sources = await read();
    if (current()) onSuccess(sources);
  } catch {
    if (current()) onError();
  } finally {
    if (current()) onDone();
  }
}

export const HISTORICAL_TOTAL_WARNING = 'Asl ish davri qayd etiladi. Ochiq oyda barcha ish joriy tarifda, yopiq oyda yopilish arxivi tarifida hisoblanadi. Saqlangan patta narxi faqat tarix uchun; tasdiqlanmagan summa taxminiy.';

export function AdjustmentSourceDialog({
  selection,
  selectedEntry,
  selectionSaving,
  selectionError,
  currentQty,
  onSelect,
  onConfirm,
  onCancel
}: {
  selection: { workerId: number; opName: string; qty: number; sources: AdjustmentSource[] };
  selectedEntry: string;
  selectionSaving: boolean;
  selectionError: string;
  currentQty: number;
  onSelect: (entryId: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-label="Asl kiritilgan ishni tanlash"
      style={{
        padding: '16px 20px',
        margin: '0 0 16px',
        background: '#ffffff',
        borderRadius: '12px',
        border: '1px solid #e2e8f0',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.05)'
      }}
    >
      <strong style={{ fontSize: '17px', color: '#0f172a' }}>
        Asl kiritilgan ishni tanlang: {selection.opName}, ishchi #{selection.workerId}, o‘zgarish {selection.qty - currentQty}
      </strong>
      <p style={{ margin: '6px 0', fontSize: '15px', color: '#64748b' }}>
        Faqat kiritilgan pattalar. Asl davr va saqlangan narxni tekshiring; noma’lum narx to‘lov hisoblanganini bildirmaydi.
      </p>
      <p style={{ margin: '4px 0 10px', fontSize: '15px', color: '#94a3b8' }}>
        {HISTORICAL_TOTAL_WARNING}
      </p>
      <AdjustmentSourceSelection sources={selection.sources} selectedEntry={selectedEntry} onSelect={onSelect} />
      {selectionError && <p role="alert" style={{ color: '#ef4444', fontSize: '15px', marginTop: '6px' }}>{selectionError}</p>}
      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        <button
          type="button"
          disabled={!selectedEntry || selectionSaving}
          onClick={onConfirm}
          className="hisob-back-btn"
          style={{ background: '#047857', color: '#ffffff', border: 'none' }}
        >
          Tuzatishni saqlash
        </button>
        <button
          type="button"
          disabled={selectionSaving}
          onClick={onCancel}
          className="hisob-back-btn"
        >
          Bekor qilish
        </button>
      </div>
    </div>
  );
}

export function parseEditableNumericDraft(raw: string, min = 0): number | null {
  if (raw.trim() === '') return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= min ? parsed : null;
}

interface EditableNumericInputProps {
  value: number;
  min?: number;
  onCommit: (value: number) => Promise<boolean> | boolean | void;
  onFocus?: React.FocusEventHandler<HTMLInputElement>;
  onDoubleClick?: React.MouseEventHandler<HTMLInputElement>;
  placeholder?: string;
  title?: string;
  style?: React.CSSProperties;
  className?: string;
}

const EditableNumericInput: React.FC<EditableNumericInputProps> = React.memo(({
  value,
  min = 0,
  onCommit,
  onFocus,
  onDoubleClick,
  placeholder,
  title,
  style,
  className
}) => {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const draftRef = useRef<string | null>(null);
  const savingRef = useRef(false);

  const changeDraft = (next: string | null) => {
    draftRef.current = next;
    setDraft(next);
  };

  const commitDraft = async () => {
    if (savingRef.current) return;
    const raw = draftRef.current;
    if (raw === null) return;
    const parsed = parseEditableNumericDraft(raw, min);
    if (parsed === null) return;
    if (parsed === Number(value || 0)) {
      changeDraft(null);
      return;
    }

    savingRef.current = true;
    setSaving(true);
    try {
      const result = await onCommit(parsed);
      if (result !== false) changeDraft(null);
    } catch {
      // Keep draft visible on error
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <input
      type="number"
      value={draft !== null ? draft : (value === 0 ? '' : value)}
      min={min}
      disabled={saving}
      placeholder={placeholder || (value === 0 ? '·' : String(value))}
      title={title}
      style={style}
      className={className}
      onChange={(e) => changeDraft(e.target.value)}
      onWheel={(e) => e.currentTarget.blur()}
      onBlur={() => void commitDraft()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void commitDraft();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          changeDraft(null);
        }
      }}
      onFocus={onFocus}
      onDoubleClick={onDoubleClick}
    />
  );
});

interface HisobViewProps {
  model: ModelConfig;
}

export const HisobView: React.FC<HisobViewProps> = ({ model }) => {
  const workers = useWorkbookStore((s) => s.workers);
  const currentPeriodId = useWorkbookStore((s) => s.currentPeriod.id);
  const payrollValuation = useWorkbookStore((s) => s.payrollValuation);
  const activeCompanyId = useWorkbookStore((s) => s.licenseStatus?.companyId);
  const updateHisobQuantity = useWorkbookStore((s) => s.updateHisobQuantity);
  const updateOperationRate = useWorkbookStore((s) => s.updateOperationRate);
  const openModal = useWorkbookStore((s) => s.openModal);
  const setActiveCell = useWorkbookStore((s) => s.setActiveCell);
  const setActiveSheet = useWorkbookStore((s) => s.setActiveSheet);

  const [searchQuery, setSearchQuery] = useState('');
  const [filterTab, setFilterTab] = useState<'all' | 'worked' | 'not_worked'>('all');
  const [selectedWorkerId, setSelectedWorkerId] = useState<number | null>(null);

  // Source selection state for quantity adjustments
  const [sourceLoading, setSourceLoading] = useState(false);
  const [selection, setSelection] = useState<{ workerId: number; opName: string; qty: number; sources: AdjustmentSource[]; companyId: string } | null>(null);
  const [selectedEntry, setSelectedEntry] = useState('');
  const [selectionSaving, setSelectionSaving] = useState(false);
  const [selectionError, setSelectionError] = useState('');

  const sourceGuard = useRef(new SourceRequestGuard());
  const pendingContext = useRef<{ companyId: string; periodId: string; session: SessionIdentity; modelId: string; workerId: number; opName: string } | null>(null);
  const contextRef = useRef({ model, workers, activeCompanyId, currentPeriodId, payrollValuation });

  useEffect(() => {
    contextRef.current = { model, workers, activeCompanyId, currentPeriodId, payrollValuation };
  }, [model, workers, activeCompanyId, currentPeriodId, payrollValuation]);

  useEffect(() => () => { sourceGuard.current.dispose(); }, []);

  const contextIsCurrent = useCallback((target: { companyId: string; periodId: string; session: SessionIdentity; modelId: string; workerId: number; opName: string }) => {
    const latest = {
      companyId: contextRef.current.activeCompanyId,
      periodId: contextRef.current.currentPeriodId,
      modelId: contextRef.current.model.id,
      workerIds: contextRef.current.workers.map((w) => w.id),
      operationNames: contextRef.current.model.operations.map((o) => o.name)
    };
    return isAdjustmentEditContextCurrent(target, latest);
  }, []);

  const handleOpenWorkerDetail = useCallback((workerId: number, modelId?: string, opName?: string) => {
    openModal({ type: 'worker_detail', workerId, modelId, opName });
  }, [openModal]);

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

  // Compute model totals and payroll display
  const display = useMemo(() => payrollDisplay([model], workers, payrollValuation, activeCompanyId, currentPeriodId),
    [model, workers, payrollValuation, activeCompanyId, currentPeriodId]);
  const modelTotals = display.modelTotals[model.id] || calculateModelTotals(model, workers);

  // Partition workers into worked vs not worked
  const workedWorkers = useMemo(() => {
    return workers.filter((w) => {
      const earnings = modelTotals.workerTotals[w.id]?.totalEarnings || 0;
      const workerQuantities = model.hisobQuantities?.[w.id] || {};
      const sumQty = Object.values(workerQuantities).reduce((acc, val) => acc + Number(val || 0), 0);
      return earnings > 0 || sumQty > 0;
    });
  }, [workers, modelTotals.workerTotals, model.hisobQuantities]);

  const notWorkedWorkers = useMemo(() => {
    const workedSet = new Set(workedWorkers.map((w) => w.id));
    return workers.filter((w) => !workedSet.has(w.id));
  }, [workers, workedWorkers]);

  const filteredWorkers = useMemo(() => {
    let list = workers;
    if (filterTab === 'worked') list = workedWorkers;
    else if (filterTab === 'not_worked') list = notWorkedWorkers;

    if (!searchQuery.trim()) return list;
    const q = searchQuery.toLowerCase().trim();
    return list.filter((w) =>
      w.name.toLowerCase().includes(q) || String(w.id).includes(q)
    );
  }, [workers, filterTab, workedWorkers, notWorkedWorkers, searchQuery]);

  const handleCellFocus = useCallback((cellId: string, value: string, formula?: string) => {
    setActiveCell({
      cellId,
      sheetName: model.hisobSheetName,
      value,
      formula
    });
  }, [model.hisobSheetName, setActiveCell]);

  const handleQuantityChange = useCallback(async (workerId: number, opName: string, qty: number) => {
    const generation = sourceGuard.current.begin();
    pendingContext.current = null;
    setSelection(null);
    setSelectionError('');
    setSourceLoading(false);
    setSelectionSaving(false);

    const startCompanyId = useWorkbookStore.getState().licenseStatus?.companyId;
    const startPeriodId = useWorkbookStore.getState().currentPeriod.id;
    const session = captureSessionIdentity(startCompanyId);
    const eAPI = getElectronApi();
    const runtime = await resolveElectronRuntimeMode(eAPI);

    if (!sourceGuard.current.isCurrent(generation)) return false;
    if (contextRef.current.model.id !== model.id || !contextRef.current.model.operations.some((op) => op.name === opName)
      || !contextRef.current.workers.some((worker) => worker.id === workerId)
      || useWorkbookStore.getState().licenseStatus?.companyId !== startCompanyId
      || useWorkbookStore.getState().currentPeriod.id !== startPeriodId
      || !isSessionCurrent(session, startCompanyId)) return false;

    if (runtime.mode === 'legacy') return updateHisobQuantity(model.id, workerId, opName, qty);
    if (!runtime.success || !eAPI?.AdjustmentSources) {
      useWorkbookStore.getState().addNotification('error', 'Manba', 'Manbalarni yuklash imkonsiz. Qayta urinib ko‘ring.');
      return false;
    }
    const companyId = startCompanyId;
    if (!companyId || !session) return false;
    const context = { companyId, periodId: startPeriodId, session, modelId: model.id, workerId, opName };
    if (!contextIsCurrent(context)) return false;

    const current = Number(model.hisobQuantities?.[workerId]?.[opName] || 0);
    if (qty === current) return true;

    pendingContext.current = context;
    setSourceLoading(true);
    await guardedAdjustmentSources(
      sourceGuard.current,
      generation,
      () => contextIsCurrent(context),
      () => readEnteredAdjustmentSources(companyId, model.id, workerId, opName),
      (sources) => {
        setSelection({ workerId, opName, qty, sources, companyId });
        setSelectedEntry('');
        setSelectionError('');
      },
      () => useWorkbookStore.getState().addNotification('error', 'Manba', 'Manbalarni yuklash imkonsiz. Qayta urinib ko‘ring.'),
      () => setSourceLoading(false)
    );
    return false;
  }, [model, updateHisobQuantity, contextIsCurrent]);

  const confirmSource = async () => {
    if (!selection || !selectedEntry || selectionSaving || !pendingContext.current || !contextIsCurrent(pendingContext.current)) return;
    const generation = sourceGuard.current.begin();
    const source = selection.sources.find((item) => item.originalEntryId === selectedEntry);
    if (!source || useWorkbookStore.getState().licenseStatus?.companyId !== selection.companyId) {
      if (sourceGuard.current.isCurrent(generation)) setSelectionError('Kompaniya yoki manba o‘zgardi. Qayta tanlang.');
      return;
    }
    setSelectionSaving(true);
    try {
      const saved = await updateHisobQuantity(model.id, selection.workerId, selection.opName, selection.qty,
        { originalTicketId: source.originalTicketId, originalEntryId: source.originalEntryId });
      if (!sourceGuard.current.isCurrent(generation) || !pendingContext.current || !contextIsCurrent(pendingContext.current)) return;
      if (saved) {
        pendingContext.current = null;
        setSelection(null);
      } else {
        setSelectionError('Tuzatish saqlanmadi. Manbani tekshiring.');
      }
    } catch {
      if (sourceGuard.current.isCurrent(generation) && pendingContext.current && contextIsCurrent(pendingContext.current)) {
        setSelectionError('Tuzatish saqlanmadi. Qayta urinib ko‘ring.');
      }
    } finally {
      if (sourceGuard.current.isCurrent(generation)) setSelectionSaving(false);
    }
  };

  return (
    <div className="phase-b-hisob hisob-view-container">
      {/* 1. Header Bar */}
      <div className="hisob-header-bar">
        <div className="hisob-header-left">
          <button
            type="button"
            onClick={() => setActiveSheet(model.name)}
            className="hisob-back-btn"
            title="Patta kiritish sahifasiga qaytish"
          >
            <ArrowLeft size={15} />
            <span>Pattaga qaytish</span>
          </button>

          <div className="hisob-title-block">
            <h1 className="hisob-title">{model.name} · Hisob-kitob</h1>
            <p className="hisob-subtitle">Ishchilar bo'yicha operatsiyalarda bajarilgan ish soni</p>
          </div>
        </div>

        <div className="hisob-header-right">
          <button
            type="button"
            onClick={() => openModal({ type: 'new_operation', modelId: model.id })}
            className="hisob-add-op-btn"
          >
            <Plus size={15} />
            <span>Yangi operatsiya</span>
          </button>

          <div className="hisob-summary-pill">
            Jami: {displayedMoney(modelTotals.grandTotalAmount, display.ready, display.incomplete)} so'm · {formatNumber(modelTotals.grandTotalQuantity)} dona
          </div>
        </div>
      </div>

      {/* 2. Filters & Search Bar */}
      <div className="hisob-filters-bar">
        <div className="hisob-search-box">
          <Search size={15} className="hisob-search-icon" />
          <input
            type="text"
            placeholder="Ishchi ismi yoki ID"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="hisob-search-input"
          />
        </div>

        <div className="hisob-filter-pills">
          <button
            type="button"
            className={`hisob-filter-pill ${filterTab === 'all' ? 'is-active' : ''}`}
            onClick={() => setFilterTab('all')}
          >
            Hammasi · {workers.length}
          </button>
          <button
            type="button"
            className={`hisob-filter-pill ${filterTab === 'worked' ? 'is-active' : ''}`}
            onClick={() => setFilterTab('worked')}
          >
            Ishlagan · {workedWorkers.length}
          </button>
          <button
            type="button"
            className={`hisob-filter-pill ${filterTab === 'not_worked' ? 'is-active' : ''}`}
            onClick={() => setFilterTab('not_worked')}
          >
            Ishlamagan · {notWorkedWorkers.length}
          </button>
        </div>
      </div>

      {/* Source Loading & Adjustment Dialog */}
      {sourceLoading && (
        <div style={{ padding: '8px 16px', background: '#ecfdf5', borderRadius: '8px', marginBottom: '12px', fontSize: '15px', color: '#047857' }}>
          Asl ishlar yuklanmoqda...
        </div>
      )}

      {selection && pendingContext.current && contextIsCurrent(pendingContext.current) && (
        <AdjustmentSourceDialog
          selection={selection}
          selectedEntry={selectedEntry}
          selectionSaving={selectionSaving}
          selectionError={selectionError}
          currentQty={Number(model.hisobQuantities?.[selection.workerId]?.[selection.opName] || 0)}
          onSelect={setSelectedEntry}
          onConfirm={() => void confirmSource()}
          onCancel={() => {
            sourceGuard.current.invalidate();
            pendingContext.current = null;
            setSelection(null);
            setSelectionError('');
          }}
        />
      )}

      {/* 3. Pixel-Perfect Table Card */}
      <div className="hisob-card">
        <div className="hisob-scroll-area">
          <table className="hisob-table">
            <colgroup>
              <col style={{ width: '50px' }} />
              <col style={{ width: '200px' }} />
              {model.operations.map((op) => (
                <col key={op.name} style={{ width: '96px' }} />
              ))}
              <col style={{ width: '90px' }} />
              <col style={{ width: '115px' }} />
            </colgroup>

            {/* Table Header */}
            <thead>
              <tr>
                <th className="hisob-th-sticky-top hisob-th-col-num" onClick={() => handleCellFocus('A1', '№')}>
                  №
                </th>
                <th className="hisob-th-sticky-top hisob-th-col-fio" onClick={() => handleCellFocus('B1', 'F.I.O')}>
                  F.I.O
                </th>

                {model.operations.map((op, opIdx) => {
                  const colLetter = getExcelColumnLetter(3 + opIdx);
                  return (
                    <th
                      key={op.name}
                      className="hisob-th-sticky-top hisob-th-op"
                      onClick={() => handleCellFocus(`${colLetter}1`, op.name)}
                    >
                      <div className="hisob-op-header-inner">
                        <div className="hisob-op-name-row">
                          <span className="hisob-op-name-text" title={op.name}>{op.name}</span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openModal({ type: 'delete_operation', modelId: model.id, opName: op.name });
                            }}
                            className="hisob-op-del-btn"
                            title="Operatsiyani o'chirish"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>

                        <EditableNumericInput
                          value={Number(op.rate || 0)}
                          min={0}
                          onCommit={(newRate) => updateOperationRate(model.id, op.name, newRate)}
                          placeholder={`${op.rate} so'm`}
                          className="hisob-rate-pill"
                          style={{
                            border: '1px solid #fde68a',
                            outline: 'none',
                            textAlign: 'center',
                            cursor: 'pointer',
                            background: '#fef3c7',
                            color: '#b45309',
                            fontWeight: 700,
                            fontSize: '14px',
                            width: '74px',
                            height: '20px',
                            borderRadius: '9999px',
                            padding: '0 4px'
                          }}
                          title={`Tarif: ${op.rate} so'm (o'zgartirish uchun bosing)`}
                        />
                      </div>
                    </th>
                  );
                })}

                <th className="hisob-th-sticky-top hisob-th-summary">
                  JAMI DONA
                </th>
                <th className="hisob-th-sticky-top hisob-th-summary-sum">
                  JAMI SUMMA
                </th>
              </tr>
            </thead>

            {/* Table Body */}
            <tbody>
              {filteredWorkers.map((worker, rowIdx) => {
                const workerQuantities = model.hisobQuantities?.[worker.id] || {};
                const workerDona = Object.values(workerQuantities).reduce((acc, v) => acc + Number(v || 0), 0);
                const workerTot = modelTotals.workerTotals[worker.id]?.totalEarnings || 0;
                const isSelected = selectedWorkerId === worker.id;
                const rowNum = 2 + rowIdx;

                return (
                  <tr
                    key={worker.id}
                    className={`hisob-row ${isSelected ? 'is-selected' : ''}`}
                    onClick={() => setSelectedWorkerId(worker.id)}
                  >
                    {/* Col 1: № */}
                    <td
                      className="hisob-td-num"
                      onClick={() => handleCellFocus(`A${rowNum}`, String(rowIdx + 1))}
                    >
                      {rowIdx + 1}
                    </td>

                    {/* Col 2: F.I.O */}
                    <td
                      className="hisob-td-fio"
                      onClick={() => handleCellFocus(`B${rowNum}`, worker.name)}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        handleOpenWorkerDetail(worker.id, model.id);
                      }}
                      title="2 marta bosing: ishchi profili va pattalar tarixi"
                    >
                      {worker.name}
                    </td>

                    {/* Operation Quantity Cells */}
                    {model.operations.map((op, opIdx) => {
                      const qty = workerQuantities[op.name] || 0;
                      const colLet = getExcelColumnLetter(3 + opIdx);
                      return (
                        <td
                          key={op.name}
                          className="hisob-td-cell"
                          onClick={() => handleCellFocus(`${colLet}${rowNum}`, String(qty), `=${qty} * ${op.rate}`)}
                        >
                          <EditableNumericInput
                            value={Number(qty || 0)}
                            min={0}
                            onCommit={(nextQty) => handleQuantityChange(worker.id, op.name, nextQty)}
                            placeholder={qty > 0 ? String(qty) : '·'}
                            className={qty > 0 ? 'hisob-qty-box' : 'hisob-empty-dot'}
                            style={{
                              border: 'none',
                              outline: 'none',
                              textAlign: 'center',
                              cursor: 'pointer',
                              background: qty > 0 ? '#e8f8f0' : 'transparent',
                              color: qty > 0 ? '#059669' : '#cbd5e1',
                              fontWeight: qty > 0 ? 800 : 700,
                              fontSize: qty > 0 ? '15px' : '19px',
                              width: '100%',
                              height: '32px',
                              borderRadius: '6px'
                            }}
                          />
                        </td>
                      );
                    })}

                    {/* Col: JAMI DONA */}
                    <td
                      className="hisob-td-dona"
                      onClick={() => handleCellFocus(`${getExcelColumnLetter(3 + model.operations.length)}${rowNum}`, String(workerDona))}
                    >
                      {workerDona > 0 ? formatNumber(workerDona) : <span className="hisob-empty-dot">·</span>}
                    </td>

                    {/* Col: JAMI SUMMA */}
                    <td
                      className="hisob-td-summa"
                      onClick={() => handleCellFocus(`${getExcelColumnLetter(4 + model.operations.length)}${rowNum}`, String(workerTot))}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        handleOpenWorkerDetail(worker.id, model.id);
                      }}
                      title="2 marta bosing: ishchi profili"
                    >
                      {workerTot > 0 ? displayedMoney(workerTot, display.ready, display.incomplete) : <span className="hisob-empty-dot">·</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>

            {/* Table Footer Total Row */}
            <tfoot>
              <tr className="hisob-tfoot-row">
                <td className="hisob-tf-sticky" style={{ textAlign: 'center' }} />
                <td className="hisob-tf-fio">
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontWeight: 800, fontSize: '15px', color: '#064e3b' }}>
                      Jami · {filteredWorkers.length}
                    </span>
                    <span style={{ fontWeight: 700, fontSize: '14px', color: '#047857' }}>
                      ishchi
                    </span>
                  </div>
                </td>

                {/* Operations totals */}
                {model.operations.map((op, opIdx) => {
                  const opTot = modelTotals.operations[op.name];
                  const hasOpWork = opTot && opTot.totalQuantity > 0;
                  const colLet = getExcelColumnLetter(3 + opIdx);
                  return (
                    <td
                      key={op.name}
                      className="hisob-tf-cell"
                      onClick={() => handleCellFocus(`${colLet}${filteredWorkers.length + 2}`, String(opTot?.totalQuantity || 0))}
                    >
                      {hasOpWork ? (
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                          <span style={{ fontWeight: 800, fontSize: '15px', color: '#047857' }}>
                            {formatNumber(opTot.totalQuantity)}
                          </span>
                          <span style={{ fontWeight: 600, fontSize: '13.5px', color: '#064e3b', marginTop: '1px' }}>
                            {displayedMoney(opTot.totalAmount, display.ready, display.incomplete)} so'm
                          </span>
                        </div>
                      ) : (
                        <span className="hisob-empty-dot">·</span>
                      )}
                    </td>
                  );
                })}

                {/* Grand Total Dona */}
                <td className="hisob-tf-dona">
                  {formatNumber(modelTotals.grandTotalQuantity)}
                </td>

                {/* Grand Total Summa */}
                <td className="hisob-tf-summa">
                  {displayedMoney(modelTotals.grandTotalAmount, display.ready, display.incomplete)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
};
