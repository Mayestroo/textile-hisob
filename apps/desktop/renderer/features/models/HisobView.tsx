import React, { useState, useMemo, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useWorkbookStore } from '../../store/workbookStore';
import { ModelConfig, Worker } from '../../types/workbook';
import { calculateModelTotals, formatMoney, formatNumber } from '../../engine/formulaEngine';
import { displayedMoney, payrollDisplay } from '../../engine/payrollDisplay';
import { getExcelColumnLetter } from '../../utils/excelUtils';
import { Search, Plus, Trash2, ArrowLeft, DollarSign } from 'lucide-react';
import { getElectronApi, resolveElectronRuntimeMode } from '../../store/runtimeMode';
import { captureSessionIdentity, isSessionCurrent, type SessionIdentity } from '../../store/sessionGuard';

type AdjustmentSource = { originalTicketId: string; originalEntryId: string; originalPeriodId: string | null;
  periodName: string | null; periodStartDate: string | null; originalRateSnapshot: number | null;
  partyNumber: string; pattaNumber: number };

export function AdjustmentSourceSelection({ sources, selectedEntry, onSelect }: {
  sources: AdjustmentSource[]; selectedEntry: string; onSelect: (entryId: string) => void
}) {
  if (sources.length === 0) return <p>Mos kiritilgan ish topilmadi. Tuzatish yuborilmadi.</p>;
  return <select aria-label="Asl patta va davr" value={selectedEntry} onChange={(event) => onSelect(event.target.value)}>
    <option value="">Manbani tanlang</option>
    {sources.map((source) => <option key={`${source.originalTicketId}:${source.originalEntryId}`} value={source.originalEntryId}>
      Patta {source.partyNumber}/{source.pattaNumber} · {source.periodName || source.periodStartDate || source.originalPeriodId || 'Davr noma’lum'} · saqlangan narx: {source.originalRateSnapshot == null ? 'noma’lum' : `${source.originalRateSnapshot} so‘m`}
    </option>)}
  </select>;
}

export async function readEnteredAdjustmentSources(
  companyId: string, modelId: string, workerId: number, opName: string
): Promise<AdjustmentSource[]> {
  const result = await getElectronApi()?.AdjustmentSources?.(companyId, modelId, workerId, opName);
  if (!result?.success || !Array.isArray(result.data)) throw new Error('Adjustment sources unavailable');
  return result.data;
}

// Each edit owns a generation, including the runtime-mode lookup preceding the source read.
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
  guard: SourceRequestGuard, generation: number, contextIsCurrent: () => boolean,
  read: () => Promise<AdjustmentSource[]>, onSuccess: (sources: AdjustmentSource[]) => void,
  onError: () => void, onDone: () => void
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

export function AdjustmentSourceDialog({ selection, selectedEntry, selectionSaving, selectionError, currentQty, onSelect, onConfirm, onCancel }: {
  selection: { workerId: number; opName: string; qty: number; sources: AdjustmentSource[] };
  selectedEntry: string; selectionSaving: boolean; selectionError: string; currentQty: number;
  onSelect: (entryId: string) => void; onConfirm: () => void; onCancel: () => void;
}) {
  return <div role="dialog" aria-label="Asl kiritilgan ishni tanlash" style={{ padding: 16, background: 'var(--bg-surface)', borderBottom: '1px solid var(--border-subtle)' }}>
    <strong>Asl kiritilgan ishni tanlang: {selection.opName}, ishchi #{selection.workerId}, o‘zgarish {selection.qty - currentQty}</strong>
    <p>Faqat kiritilgan pattalar. Asl davr va saqlangan narxni tekshiring; noma’lum narx to‘lov hisoblanganini bildirmaydi.</p>
    <p>{HISTORICAL_TOTAL_WARNING}</p>
    <AdjustmentSourceSelection sources={selection.sources} selectedEntry={selectedEntry} onSelect={onSelect} />
    {selectionError && <p role="alert">{selectionError}</p>}
    <button type="button" disabled={!selectedEntry || selectionSaving} onClick={onConfirm}>Tuzatishni saqlash</button>
    <button type="button" disabled={selectionSaving} onClick={onCancel}>Bekor qilish</button>
  </div>;
}

const VIRTUAL_THRESHOLD = 30;
const ROW_HEIGHT = 32;

interface EditableNumericInputProps {
  value: number;
  min?: number;
  onCommit: (value: number) => Promise<boolean> | boolean | void;
  onFocus?: React.FocusEventHandler<HTMLInputElement>;
  onDoubleClick?: React.MouseEventHandler<HTMLInputElement>;
  placeholder?: string;
  title?: string;
  style?: React.CSSProperties;
}

export function parseEditableNumericDraft(raw: string, min = 0): number | null {
  if (raw.trim() === '') return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= min ? parsed : null;
}

const EditableNumericInput: React.FC<EditableNumericInputProps> = React.memo(({
  value,
  min = 0,
  onCommit,
  onFocus,
  onDoubleClick,
  placeholder,
  title,
  style
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
      // Keep the draft visible when the local command is rejected.
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <input
      type="number"
      min={min}
      step="any"
      value={draft ?? (value > 0 ? String(value) : '')}
      onChange={(event) => changeDraft(event.target.value)}
      onFocus={(event) => {
        if (draftRef.current === null) changeDraft(value > 0 ? String(value) : '');
        onFocus?.(event);
      }}
      onBlur={() => void commitDraft()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          changeDraft(null);
          event.currentTarget.blur();
        }
      }}
      onDoubleClick={onDoubleClick}
      disabled={saving}
      placeholder={placeholder}
      title={title}
      style={style}
    />
  );
});



interface HisobViewProps {
  model: ModelConfig;
}

// Header row heights for sticky top offsets
const ROW1_H = 32;       // Operation names row
const ROW2_H = 30;       // Rates row

interface WorkerRowProps {
  worker: Worker;
  rowNum: number;
  modelId: string;
  hisobSheetName: string;
  operations: ModelConfig['operations'];
  workerQtyMap: Record<string, number>;
  workerTot: number;
  cellAmounts: Record<string, number | null>;
  moneyReady: boolean;
  moneyIncomplete: boolean;
  idColumnWidth: number;
  virtualStart?: number;
  gridColumns?: string;
  isSelected: boolean;
  onSelectRow: (workerId: number, toggle?: boolean) => void;
  onQuantityChange: (workerId: number, opName: string, value: number) => Promise<boolean> | boolean | void;
  quantityReset: number;
  onCellFocus: (cellId: string, value: string, formula?: string) => void;
  onOpenWorkerDetail?: (workerId: number, modelId?: string, opName?: string) => void;
}

const WorkerRow = React.memo<WorkerRowProps>(({
  worker,
  rowNum,
  modelId,
  operations,
  workerQtyMap,
  workerTot,
  cellAmounts,
  moneyReady,
  moneyIncomplete,
  idColumnWidth,
  virtualStart,
  gridColumns,
  isSelected,
  onSelectRow,
  onQuantityChange,
  quantityReset,
  onCellFocus,
  onOpenWorkerDetail
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const workerTotalKnown = !operations.some(op => cellAmounts[JSON.stringify([modelId, worker.id, op.name])] === null);

  return (
    <tr
      className={`fast-row ${isSelected ? 'selected-row' : ''}`}
      onClick={() => onSelectRow(worker.id, false)}
      style={{
        backgroundColor: isSelected 
          ? 'rgba(59, 130, 246, 0.15)' 
          : (isHovered ? 'var(--bg-surface-hover)' : 'var(--bg-surface)'),
        height: '32px',
        ...(virtualStart === undefined ? {} : {
          position: 'absolute' as const, top: 0, width: '100%', display: 'grid',
          gridTemplateColumns: gridColumns, transform: `translateY(${virtualStart}px)`
        }),
        cursor: 'pointer',
        transition: 'background-color 0.12s ease',
        boxShadow: isSelected 
          ? 'inset 0 1.5px 0 #3b82f6, inset 0 -1.5px 0 #3b82f6' 
          : undefined
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Col A: ID */}
      <td
        style={{
          textAlign: 'center',
          fontWeight: 700,
          position: 'sticky',
          left: 0,
          backgroundColor: isSelected
            ? 'rgba(59, 130, 246, 0.20)'
            : (isHovered ? 'var(--bg-surface-hover)' : 'var(--bg-surface)'),
          zIndex: 8,
          cursor: 'pointer',
          borderRight: '1px solid var(--border-subtle)',
          transition: 'background-color 0.12s ease'
        }}
        onClick={(e) => {
          e.stopPropagation();
          onCellFocus(`A${rowNum}`, String(worker.id));
          onSelectRow(worker.id, true);
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onOpenWorkerDetail && onOpenWorkerDetail(worker.id, modelId);
        }}
        title="Tanlash / Bekor qilish (2 marta bosing: Ishchi hisoboti va pattalari)"
      >
        <span style={{ 
          background: isSelected
            ? '#2563eb'
            : (isHovered ? 'var(--border-default)' : 'var(--bg-surface-subtle)'), 
          padding: '2px 8px', 
          borderRadius: 'var(--radius-full)',
          fontSize: '11.5px',
          color: isSelected ? '#ffffff' : (isHovered ? 'var(--text-primary)' : 'var(--text-secondary)'),
          fontWeight: isSelected ? 800 : 700,
          transition: 'all 0.12s ease'
        }}>
          {worker.id}
        </span>
      </td>

      {/* Col B: Name */}
      <td
        style={{
          fontWeight: isSelected ? 700 : 600,
          paddingLeft: '12px',
          position: 'sticky',
          left: `${idColumnWidth}px`,
          backgroundColor: isSelected
            ? 'rgba(59, 130, 246, 0.20)'
            : (isHovered ? 'var(--bg-surface-hover)' : 'var(--bg-surface)'),
          zIndex: 8,
          whiteSpace: 'nowrap',
          color: isSelected ? '#1d4ed8' : 'var(--text-primary)',
          cursor: 'pointer',
          borderRight: '1px solid var(--border-subtle)',
          transition: 'background-color 0.12s ease'
        }}
        onClick={() => {
          onCellFocus(`B${rowNum}`, worker.name);
          onSelectRow(worker.id, false);
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onOpenWorkerDetail && onOpenWorkerDetail(worker.id, modelId);
        }}
        title="2 marta bosing: Ishchining barcha bajargan ishlari va pattalari tarixi"
      >
        {worker.name}
      </td>

      {/* Operations Columns */}
      {operations.map((op, i) => {
        const qty = workerQtyMap[op.name] || 0;
        const valued = cellAmounts[JSON.stringify([modelId, worker.id, op.name])];
        const amount = valued === undefined ? qty * op.rate : valued;
        const amountColLetter = getExcelColumnLetter(2 + i * 2);
        const qtyColLetter = getExcelColumnLetter(3 + i * 2);
        const formulaStr = valued === undefined ? `=$${amountColLetter}$2*${qty}` : 'Davr tarifi bo‘yicha hisob';

        return (
          <React.Fragment key={op.id || op.name}>
            {/* Amount column */}
            <td
              style={{
                textAlign: 'right',
                fontWeight: 600,
                paddingRight: '8px',
                 color: (amount || 0) > 0 ? (isSelected ? 'var(--primary-hover)' : 'var(--primary)') : 'var(--text-muted)',
                borderLeft: '1px solid var(--border-subtle)',
                backgroundColor: isSelected
                   ? ((amount || 0) > 0 ? 'rgba(16, 185, 129, 0.28)' : 'rgba(59, 130, 246, 0.12)')
                   : ((amount || 0) > 0 ? 'var(--primary-light)' : (isHovered ? 'var(--bg-surface-hover)' : 'transparent')),
                cursor: 'pointer',
                transition: 'background-color 0.12s ease'
              }}
              onClick={() => {
                 onCellFocus(`${amountColLetter}${rowNum}`, amount === null ? 'Noma’lum' : String(amount), formulaStr);
                onSelectRow(worker.id, false);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                onOpenWorkerDetail && onOpenWorkerDetail(worker.id, modelId, op.name);
              }}
              title="2 marta bosing: Qaysi pattalardan kelib tushganini ko'rish"
            >
               {amount === null ? 'Noma’lum' : amount > 0 ? displayedMoney(amount, moneyReady, moneyIncomplete) : amount === 0 && qty > 0 ? displayedMoney(0, moneyReady, moneyIncomplete) : '—'}
            </td>

            {/* Quantity column (editable) */}
            <td
              style={{
                textAlign: 'center',
                padding: '2px 4px',
                borderLeft: '1px solid var(--border-subtle)',
                backgroundColor: isSelected
                  ? (qty > 0 ? 'rgba(16, 185, 129, 0.28)' : 'rgba(59, 130, 246, 0.12)')
                  : (qty > 0 ? 'var(--primary-light)' : (isHovered ? 'var(--bg-surface-hover)' : 'transparent')),
                transition: 'background-color 0.12s ease',
                cursor: 'pointer'
              }}
              onClick={() => {
                onCellFocus(`${qtyColLetter}${rowNum}`, String(qty));
                onSelectRow(worker.id, false);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                onOpenWorkerDetail && onOpenWorkerDetail(worker.id, modelId, op.name);
              }}
              title="2 marta bosing: Qaysi pattalardan kelib tushganini ko'rish"
            >
              <EditableNumericInput
                key={`${op.name}-${quantityReset}`}
                value={qty}
                min={0}
                onCommit={(value) => onQuantityChange(worker.id, op.name, value)}
                onFocus={() => {
                  onCellFocus(`${qtyColLetter}${rowNum}`, String(qty));
                  onSelectRow(worker.id, false);
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  onOpenWorkerDetail && onOpenWorkerDetail(worker.id, modelId, op.name);
                }}
                placeholder="—"
                style={{
                  width: '100%',
                  height: '26px',
                  border: '1px solid transparent',
                  borderRadius: 'var(--radius-sm)',
                  outline: 'none',
                  background: 'transparent',
                  textAlign: 'center',
                  fontFamily: 'inherit',
                  fontSize: '12.5px',
                  fontWeight: qty > 0 ? 700 : 400,
                  color: qty > 0 ? 'var(--text-primary)' : 'var(--text-muted)',
                  transition: 'all 0.15s',
                  cursor: 'pointer'
                }}
                title="Ish sonini kiritish; ikki marta bosib kelib tushgan pattalarni ko‘ring"
              />
            </td>
          </React.Fragment>
        );
      })}

      {/* Worker total */}
      {(() => {
        const sumColLetter = getExcelColumnLetter(2 + operations.length * 2);
        return (
          <td
            style={{
              textAlign: 'right',
              fontWeight: 700,
              paddingRight: '12px',
              color: workerTot > 0 ? (isSelected ? '#15803d' : 'var(--primary)') : 'var(--text-muted)',
              backgroundColor: isSelected
                ? (workerTot > 0 ? 'rgba(16, 185, 129, 0.35)' : 'rgba(59, 130, 246, 0.16)')
                : (workerTot > 0 ? 'var(--primary-light)' : (isHovered ? 'var(--bg-surface-hover)' : 'transparent')),
              borderLeft: '2px solid var(--primary)',
              fontSize: '13.5px',
              cursor: 'pointer',
              transition: 'background-color 0.12s ease'
            }}
            onClick={() => {
               onCellFocus(`${sumColLetter}${rowNum}`, moneyReady && workerTotalKnown ? String(workerTot) : 'Noma’lum', `Davr bo‘yicha hisob`);
              onSelectRow(worker.id, false);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onOpenWorkerDetail && onOpenWorkerDetail(worker.id, modelId);
            }}
            title="2 marta bosing: Ushbu modeldagi barcha pattalar va ishlar"
          >
              {displayedMoney(workerTot, moneyReady && workerTotalKnown, moneyIncomplete)}
          </td>
        );
      })()}
    </tr>
  );
});

// Measure the entire canonical model, not the subset currently mounted by the row virtualizer.
// Widths only change when model/worker data changes, never as a result of scrolling.
function getHisobColumnWidths(model: ModelConfig, workers: Worker[], totals: ReturnType<typeof calculateModelTotals>) {
  const canvas = typeof document === 'undefined' ? null : document.createElement('canvas');
  const context = canvas?.getContext('2d');
  const measure = (text: string, font: string) => {
    if (!context) return text.length * 9;
    context.font = font;
    return context.measureText(text).width;
  };
  const money = (value: number) => measure(formatMoney(value), '700 14.5px sans-serif');
  const id = Math.ceil(workers.reduce((width, w) => Math.max(width, measure(String(w.id), '700 12.5px sans-serif') + 32), 54));
  const name = Math.ceil(workers.reduce((width, w) => Math.max(width, measure(w.name, '700 12.5px sans-serif') + 34), 200));
  const widths = [id, name];
  for (const op of model.operations) {
    const header = measure(op.name, '700 12.5px sans-serif') + 48; // label + delete action
    let amount = Math.max(170, money(op.rate) + 26, money(totals.operations[op.name]?.totalAmount || 0) + 28);
    let quantity = Math.max(150, measure(formatNumber(totals.operations[op.name]?.totalQuantity || 0), '700 12.5px sans-serif') + 24);
    for (const worker of workers) {
      const value = model.hisobQuantities?.[worker.id]?.[op.name] || 0;
      amount = Math.max(amount, money(value * op.rate) + 28);
      quantity = Math.max(quantity, measure(String(value), '700 12.5px sans-serif') + 48);
    }
    amount = Math.ceil(amount);
    quantity = Math.ceil(quantity);
    widths.push(Math.max(amount, header - quantity), quantity);
  }
  widths.push(Math.ceil(workers.reduce((width, w) => Math.max(width, money(totals.workerTotals[w.id]?.totalEarnings || 0) + 32),
    Math.max(140, money(totals.grandTotalAmount) + 32))));
  return widths;
}

interface HisobTableViewportProps {
  model: ModelConfig;
  filteredWorkers: Worker[];
  modelTotals: ReturnType<typeof calculateModelTotals>;
  cellAmounts: Record<string, number | null>;
  moneyReady: boolean;
  moneyIncomplete: boolean;
  columnWidths: number[];
  selectedWorkerId: number | null;
  quantityReset: number;
  onSelectRow: WorkerRowProps['onSelectRow'];
  onQuantityChange: WorkerRowProps['onQuantityChange'];
  onCellFocus: WorkerRowProps['onCellFocus'];
  onOpenWorkerDetail: WorkerRowProps['onOpenWorkerDetail'];
  header: React.ReactNode;
  footer: React.ReactNode;
}

const HisobTableViewport = React.memo(({
  model, filteredWorkers, modelTotals, cellAmounts, moneyReady, moneyIncomplete, columnWidths, selectedWorkerId, quantityReset,
  onSelectRow, onQuantityChange, onCellFocus, onOpenWorkerDetail, header, footer
}: HisobTableViewportProps) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const useVirtual = filteredWorkers.length > VIRTUAL_THRESHOLD;
  const rowVirtualizer = useVirtualizer({
    count: filteredWorkers.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => filteredWorkers[index]?.id ?? index,
    overscan: 8,
    scrollMargin: ROW1_H + ROW2_H,
    enabled: useVirtual
  });
  const virtualItems = rowVirtualizer.getVirtualItems();
  const gridColumns = useMemo(() => columnWidths.map(width => `${width}px`).join(' '), [columnWidths]);
  // Absolute virtual rows bound native sticky cells to the row; pin only their
  // ID/name cells without invalidating the whole table on horizontal scroll.
  const pinVirtualCells = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll || !useVirtual) return;
    const translation = `translateX(${scroll.scrollLeft}px)`;
    for (const row of scroll.querySelectorAll<HTMLTableRowElement>('tbody:first-of-type tr.fast-row')) {
      if (row.cells[0]) row.cells[0].style.transform = translation;
      if (row.cells[1]) row.cells[1].style.transform = translation;
    }
    // Chromium does not pin the sticky header cells against horizontally scrolled
    // absolute virtual rows; keep header/total anchored to the same scroll offset.
    for (const row of scroll.querySelectorAll<HTMLTableRowElement>('thead tr, tbody:last-of-type tr')) {
      if (row.cells[0]) row.cells[0].style.transform = translation;
      if (row.cells[1] && row.closest('thead')) row.cells[1].style.transform = translation;
    }
  }, [useVirtual]);
  useLayoutEffect(() => { pinVirtualCells(); }, [pinVirtualCells, virtualItems]);
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || !useVirtual) return;
    scroll.addEventListener('scroll', pinVirtualCells, { passive: true });
    return () => scroll.removeEventListener('scroll', pinVirtualCells);
  }, [pinVirtualCells, useVirtual]);
  const renderRow = (worker: Worker, index: number, virtualStart?: number) =>
    <WorkerRow key={worker.id} worker={worker} rowNum={3 + index} modelId={model.id}
      hisobSheetName={model.hisobSheetName} operations={model.operations}
      workerQtyMap={model.hisobQuantities?.[worker.id] || {}}
      workerTot={modelTotals.workerTotals[worker.id]?.totalEarnings || 0} idColumnWidth={columnWidths[0]}
      cellAmounts={cellAmounts} moneyReady={moneyReady} moneyIncomplete={moneyIncomplete}
      virtualStart={virtualStart} gridColumns={useVirtual ? gridColumns : undefined}
      isSelected={selectedWorkerId === worker.id} onSelectRow={onSelectRow}
      onQuantityChange={onQuantityChange} quantityReset={quantityReset}
      onCellFocus={onCellFocus} onOpenWorkerDetail={onOpenWorkerDetail} />;

  return <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflow: 'auto', position: 'relative', background: 'var(--bg-app)' }}>
    <table className="excel-table e2c-hisob-grid" style={{ tableLayout: 'fixed', width: `${columnWidths.reduce((a, b) => a + b, 0)}px`,
       minWidth: useVirtual ? undefined : '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
      <colgroup>{columnWidths.map((width, index) => <col key={index} style={{ width: `${width}px` }} />)}</colgroup>
      {header}
       {useVirtual ? <tbody style={{ display: 'block', position: 'relative', width: `${columnWidths.reduce((a, b) => a + b, 0)}px`, height: `${rowVirtualizer.getTotalSize()}px` }}>
        {virtualItems.map(item => renderRow(filteredWorkers[item.index], item.index, item.start - (ROW1_H + ROW2_H)))}
      </tbody> : <tbody>{filteredWorkers.map((worker, index) => renderRow(worker, index))}</tbody>}
      <tbody>{footer}</tbody>
    </table>
  </div>;
});

export const HisobView: React.FC<HisobViewProps> = ({ model }) => {
  const workers = useWorkbookStore((s) => s.workers);
  const activeCompanyId = useWorkbookStore((s) => s.licenseStatus?.companyId);
  const currentPeriodId = useWorkbookStore((s) => s.currentPeriod.id);
  const payrollValuation = useWorkbookStore((s) => s.payrollValuation);
  const updateHisobQuantity = useWorkbookStore((s) => s.updateHisobQuantity);
  const updateOperationRate = useWorkbookStore((s) => s.updateOperationRate);
  const setActiveCell = useWorkbookStore((s) => s.setActiveCell);
  const setActiveSheet = useWorkbookStore((s) => s.setActiveSheet);
  const openModal = useWorkbookStore((s) => s.openModal);

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedWorkerId, setSelectedWorkerId] = useState<number | null>(null);
  const [quantityReset, setQuantityReset] = useState(0);
  const [selection, setSelection] = useState<{ workerId: number; opName: string; qty: number; sources: AdjustmentSource[]; companyId: string } | null>(null);
  const [selectedEntry, setSelectedEntry] = useState('');
  const [selectionError, setSelectionError] = useState('');
  const [selectionSaving, setSelectionSaving] = useState(false);
  const [sourceLoading, setSourceLoading] = useState(false);
  const sourceGuard = useRef(new SourceRequestGuard());
  const pendingContext = useRef<{ companyId: string; periodId: string; session: SessionIdentity; modelId: string; workerId: number; opName: string } | null>(null);
  const contextRef = useRef({ model, workers });
  contextRef.current = { model, workers };
  const contextIsCurrent = (context: NonNullable<typeof pendingContext.current>) => {
    const { model: latestModel, workers: latestWorkers } = contextRef.current;
    const state = useWorkbookStore.getState();
    return isAdjustmentEditContextCurrent(context, {
      companyId: state.licenseStatus?.companyId, periodId: state.currentPeriod.id,
      modelId: latestModel.id, workerIds: latestWorkers.map((worker) => worker.id),
      operationNames: latestModel.operations.map((op) => op.name)
    });
  };
  useEffect(() => {
    if (pendingContext.current && !contextIsCurrent(pendingContext.current)) {
      sourceGuard.current.invalidate();
      pendingContext.current = null;
      setSourceLoading(false);
      setSelection(null);
      setSelectionError('');
      setSelectionSaving(false);
    }
  }, [model, workers, activeCompanyId, currentPeriodId, payrollValuation]);
  useEffect(() => () => { sourceGuard.current.dispose(); }, []);

  const handleSelectRow = useCallback((workerId: number, toggle = false) => {
    setSelectedWorkerId((prev) => {
      if (toggle) {
        return prev === workerId ? null : workerId;
      }
      return workerId;
    });
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

  const display = useMemo(() => payrollDisplay([model], workers, payrollValuation, activeCompanyId, currentPeriodId),
    [model, workers, payrollValuation, activeCompanyId, currentPeriodId]);
  const modelTotals = display.modelTotals[model.id];

  const filteredWorkers = useMemo(() => {
    if (!searchQuery.trim()) return workers;
    const q = searchQuery.toLowerCase().trim();
    return workers.filter((w) =>
      w.name.toLowerCase().includes(q) || String(w.id).includes(q)
    );
  }, [workers, searchQuery]);

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
    await guardedAdjustmentSources(sourceGuard.current, generation, () => contextIsCurrent(context),
      () => readEnteredAdjustmentSources(companyId, model.id, workerId, opName), (sources) => {
      setSelection({ workerId, opName, qty, sources, companyId });
      setSelectedEntry('');
      setSelectionError('');
    }, () => useWorkbookStore.getState().addNotification('error', 'Manba', 'Manbalarni yuklash imkonsiz. Qayta urinib ko‘ring.'),
    () => setSourceLoading(false));
    return false;
  }, [model, updateHisobQuantity]);

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
        setQuantityReset((value) => value + 1);
      } else setSelectionError('Tuzatish saqlanmadi. Manbani tekshiring.');
    } catch {
      if (sourceGuard.current.isCurrent(generation) && pendingContext.current && contextIsCurrent(pendingContext.current))
        setSelectionError('Tuzatish saqlanmadi. Qayta urinib ko‘ring.');
    } finally {
      if (sourceGuard.current.isCurrent(generation)) setSelectionSaving(false);
    }
  };

  const columnWidths = useMemo(() => getHisobColumnWidths(model, workers, modelTotals), [model, workers, modelTotals]);

  return (
    <div className="excel-grid-container phase-b-view phase-b-hisob" style={{ display: 'flex', flexDirection: 'column', background: 'var(--bg-app)' }}>
      {/* Top Header Bar */}
      <div className="e2c-hisob-header"
        style={{
          padding: '14px 20px',
          background: 'var(--bg-surface)',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
          gap: '12px',
          flexWrap: 'wrap'
        }}
      >
        <div className="e2c-hisob-heading" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button
            onClick={() => setActiveSheet(model.name)}
            className="soft-btn soft-btn-secondary"
            style={{ padding: '6px 12px', fontSize: '12px', borderRadius: 'var(--radius-full)' }}
          >
            <ArrowLeft size={14} />
            <span>Pattaga qaytish ({model.name})</span>
          </button>

          <div className="e2c-hisob-title" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>
              {model.hisobSheetName}
            </span>
            <span style={{ fontSize: '11px', background: 'var(--bg-surface-subtle)', color: 'var(--text-secondary)', padding: '2px 8px', borderRadius: 'var(--radius-full)', fontWeight: 600 }}>
              Hisob-Kitob
            </span>
          </div>
        </div>

        <div className="e2c-hisob-actions" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button
            onClick={() => openModal({ type: 'new_operation', modelId: model.id })}
            className="soft-btn soft-btn-secondary"
            style={{ padding: '6px 12px', fontSize: '12px', borderRadius: 'var(--radius-full)' }}
          >
            <Plus size={14} color="var(--primary)" />
            <span>Yangi operatsiya</span>
          </button>

          {/* Model Total Metric Pill */}
          <div style={{
            fontSize: '12.5px',
            fontWeight: 700,
            color: 'var(--primary)',
            background: 'var(--primary-light)',
            border: '1px solid rgba(16, 185, 129, 0.3)',
            padding: '6px 14px',
            borderRadius: 'var(--radius-full)',
            display: 'flex',
            alignItems: 'center',
            gap: '6px'
          }}>
            <DollarSign size={14} color="var(--primary)" />
            <span>Jami: {displayedMoney(modelTotals.grandTotalAmount, display.ready, display.incomplete)} so'm ({formatNumber(modelTotals.grandTotalQuantity)} dona)</span>
          </div>
        </div>
      </div>

      <div className="e2c-hisob-filters">
        <div className="e2c-hisob-search">
          <Search size={16} color="var(--text-muted)" aria-hidden="true" />
          <input type="text" placeholder="Ishchi qidirish..." value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)} className="soft-input" />
        </div>
        <span className="e2c-hisob-filter-count">{filteredWorkers.length} / {workers.length} ishchi</span>
      </div>

      <p style={{ margin: '4px 20px', fontSize: '12px', color: 'var(--text-secondary)' }}>{HISTORICAL_TOTAL_WARNING}</p>
      <p role="status" style={{ margin: '4px 20px', fontSize: '12px' }}>{display.label}</p>

      {sourceLoading && <div><p role="status">Asl ishlar yuklanmoqda...</p>
        <button type="button" onClick={() => {
          sourceGuard.current.invalidate();
          pendingContext.current = null;
          setSourceLoading(false);
        }}>Bekor qilish</button></div>}
      {selection && pendingContext.current && contextIsCurrent(pendingContext.current) &&
        <AdjustmentSourceDialog selection={selection} selectedEntry={selectedEntry} selectionSaving={selectionSaving}
          selectionError={selectionError} currentQty={Number(model.hisobQuantities?.[selection.workerId]?.[selection.opName] || 0)}
          onSelect={setSelectedEntry} onConfirm={() => void confirmSource()} onCancel={() => {
            sourceGuard.current.invalidate();
            pendingContext.current = null;
            setSelection(null);
            setSelectionError('');
          }} />}

      {/* Modern Spreadsheet Table Grid */}
      <HisobTableViewport model={model} filteredWorkers={filteredWorkers} modelTotals={modelTotals}
        cellAmounts={display.cellAmounts} moneyReady={display.ready} moneyIncomplete={display.incomplete}
        columnWidths={columnWidths} selectedWorkerId={selectedWorkerId} quantityReset={quantityReset}
        onSelectRow={handleSelectRow} onQuantityChange={handleQuantityChange} onCellFocus={handleCellFocus}
        onOpenWorkerDetail={handleOpenWorkerDetail} header={
          <thead>
            {/* ROW 1: Operation Names */}
            <tr style={{ backgroundColor: 'var(--bg-surface-subtle)', height: `${ROW1_H}px` }}>
              <td
                style={{
                  fontWeight: 700, textAlign: 'center',
                  position: 'sticky', left: 0, top: 0,
                  backgroundColor: 'var(--bg-surface-subtle)', zIndex: 29, cursor: 'pointer',
                  color: 'var(--text-secondary)'
                }}
                onClick={() => handleCellFocus('A1', '№')}
              >№</td>
              <td
                style={{
                  fontWeight: 700, paddingLeft: '12px',
                   position: 'sticky', left: `${columnWidths[0]}px`, top: 0,
                  backgroundColor: 'var(--bg-surface-subtle)', zIndex: 29, cursor: 'pointer',
                  color: 'var(--text-secondary)'
                }}
                onClick={() => handleCellFocus('B1', 'F.I.O')}
              >F.I.O</td>
              {model.operations.map((op, i) => {
                const colLet = getExcelColumnLetter(2 + i * 2);
                return (
                  <td
                    key={op.id || op.name}
                    colSpan={2}
                    style={{
                      fontWeight: 700,
                      textAlign: 'center',
                      backgroundColor: 'var(--bg-surface-subtle)',
                      borderLeft: '1px solid var(--border-subtle)',
                      color: 'var(--text-primary)',
                      position: 'sticky',
                      top: 0,
                      zIndex: 19,
                      cursor: 'pointer'
                    }}
                    title={`Operatsiya: ${op.name}`}
                    onClick={() => handleCellFocus(`${colLet}1`, op.name)}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                      <span>{op.name}</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openModal({ type: 'delete_operation', modelId: model.id, opName: op.name });
                        }}
                        style={{
                          border: 'none',
                          background: 'transparent',
                          cursor: 'pointer',
                          color: 'var(--text-muted)',
                          display: 'flex',
                          alignItems: 'center',
                          padding: '2px',
                          borderRadius: '4px'
                        }}
                        title="Operatsiyani o'chirish"
                      >
                        <Trash2 size={13} color="#ef4444" />
                      </button>
                    </div>
                  </td>
                );
              })}
              <td
                style={{
                  fontWeight: 800, textAlign: 'center',
                  backgroundColor: 'var(--primary-light)', color: 'var(--primary)',
                  borderLeft: '2px solid var(--primary)',
                  position: 'sticky', top: 0, zIndex: 19, cursor: 'pointer'
                }}
                onClick={() => handleCellFocus(`${getExcelColumnLetter(2 + model.operations.length * 2)}1`, 'Сумма')}
              >
                Сумма
              </td>
            </tr>

            {/* ROW 2: Rates & 'Сони' Headers */}
            <tr style={{ backgroundColor: 'var(--bg-surface-subtle)', height: `${ROW2_H}px` }}>
              <td
                style={{
                  position: 'sticky', left: 0, top: `${ROW1_H}px`,
                  backgroundColor: 'var(--bg-surface-subtle)', zIndex: 29
                }}
              />
              <td
                style={{
                   position: 'sticky', left: `${columnWidths[0]}px`, top: `${ROW1_H}px`,
                  backgroundColor: 'var(--bg-surface-subtle)', zIndex: 29
                }}
              />
              {model.operations.map((op, i) => {
                const rateColLet = getExcelColumnLetter(2 + i * 2);
                const qtyColLet = getExcelColumnLetter(3 + i * 2);
                const shownRate = display.closed ? display.operationRates[model.id]?.[op.name] ?? null : op.rate;
                const rateLabel = shownRate == null || !Number.isFinite(Number(shownRate)) ? 'Noma’lum' : String(shownRate);
                return (
                  <React.Fragment key={op.id || op.name}>
                    <td
                      style={{
                        fontWeight: 700,
                        textAlign: 'right',
                        backgroundColor: 'rgba(245, 158, 11, 0.15)',
                        borderLeft: '1px solid var(--border-subtle)',
                        padding: '2px 4px',
                        position: 'sticky',
                        top: `${ROW1_H}px`,
                        zIndex: 19
                      }}
                       title={`${display.closed ? 'Yopilish tarifi' : 'Joriy operatsiya narxi'}: ${rateLabel}${display.closed ? ' so‘m' : ' so‘m'}`}
                       onClick={display.closed ? undefined : () => handleCellFocus(`${rateColLet}2`, rateLabel)}
                      >
                        {display.closed ? <span aria-label={`Yopilish tarifi: ${rateLabel}`} style={{ color: '#f59e0b' }}>{rateLabel}</span> : <EditableNumericInput
                         value={op.rate == null || !Number.isFinite(Number(op.rate)) ? 0 : Number(op.rate)}
                         min={0}
                         onCommit={(rate) => updateOperationRate(model.id, op.name, rate)}
                         onFocus={() => handleCellFocus(`${rateColLet}2`, op.rate == null ? 'Noma’lum' : String(op.rate))}
                         placeholder={op.rate == null || !Number.isFinite(Number(op.rate)) ? 'Noma’lum' : Number(op.rate) === 0 ? '0' : ''}
                        title="Dona narxini o'zgartirish"
                        style={{
                          width: '100%',
                          height: '24px',
                          border: '1px solid transparent',
                          borderRadius: 'var(--radius-sm)',
                          outline: 'none',
                          background: 'transparent',
                          textAlign: 'right',
                          paddingRight: '6px',
                          fontFamily: 'inherit',
                          fontSize: '12px',
                          fontWeight: 700,
                          color: '#f59e0b'
                        }}
                       />}
                    </td>
                    <td
                      style={{
                        fontWeight: 600, textAlign: 'center',
                        backgroundColor: 'var(--bg-surface-subtle)', fontSize: '11.5px',
                        color: 'var(--text-secondary)',
                        position: 'sticky',
                        top: `${ROW1_H}px`,
                        zIndex: 19,
                        cursor: 'pointer'
                      }}
                      onClick={() => handleCellFocus(`${qtyColLet}2`, 'Сони')}
                    >
                      Сони
                    </td>
                  </React.Fragment>
                );
              })}
              <td
                style={{
                  backgroundColor: 'var(--primary-light)',
                  borderLeft: '2px solid var(--primary)',
                  position: 'sticky',
                  top: `${ROW1_H}px`,
                  zIndex: 19
                }}
              />
            </tr>
          </thead>
        } footer={
          <>
              {/* Grand Total Row */}
              <tr
                style={{
                  backgroundColor: 'var(--primary-light)',
                  fontWeight: 800,
                  height: '40px',
                  borderTop: '2px solid var(--primary)'
                }}
              >
                <td
                  colSpan={2}
                  style={{
                    textAlign: 'center',
                    fontWeight: 800,
                    fontSize: '13.5px',
                    color: 'var(--primary)',
                    position: 'sticky',
                    left: 0,
                    backgroundColor: 'var(--bg-surface)',
                    zIndex: 8,
                    cursor: 'pointer'
                  }}
                  onClick={() => handleCellFocus(`A${workers.length + 3}`, 'ЖАМИ')}
                >
                  ЖАМИ (ИТОГО)
                </td>

                {model.operations.map((op, i) => {
                  const opTot = modelTotals.operations[op.name];
                  const amountColLetter = getExcelColumnLetter(2 + i * 2);
                  const qtyColLetter = getExcelColumnLetter(3 + i * 2);

                  return (
                    <React.Fragment key={op.id || op.name}>
                      <td
                        style={{
                          textAlign: 'right',
                          fontWeight: 700,
                          paddingRight: '8px',
                          color: 'var(--primary)',
                          borderLeft: '1px solid var(--border-subtle)',
                          cursor: 'pointer'
                        }}
                        onClick={() => handleCellFocus(`${amountColLetter}${workers.length + 3}`,
                          !display.ready || workers.some(w => display.unknown.has(display.key(model.id, w.id, op.name)))
                            ? 'Noma’lum' : String(opTot?.totalAmount || 0), `Davr bo‘yicha hisob`)}
                      >
                        {displayedMoney(opTot?.totalAmount || 0, display.ready && !workers.some(w => display.unknown.has(display.key(model.id, w.id, op.name))), display.incomplete)}
                      </td>
                      <td
                        style={{
                          textAlign: 'center',
                          fontWeight: 700,
                          color: 'var(--text-primary)',
                          cursor: 'pointer'
                        }}
                        onClick={() => handleCellFocus(`${qtyColLetter}${workers.length + 3}`, String(opTot?.totalQuantity || 0), `=SUM(...)`)}
                      >
                        {formatNumber(opTot?.totalQuantity || 0)}
                      </td>
                    </React.Fragment>
                  );
                })}

                <td
                  style={{
                    textAlign: 'right',
                    fontWeight: 800,
                    fontSize: '14.5px',
                    paddingRight: '12px',
                    color: 'var(--primary)',
                    backgroundColor: 'var(--primary-light)',
                    borderLeft: '2px solid var(--primary)',
                    cursor: 'pointer'
                  }}
                  onClick={() => handleCellFocus(`${getExcelColumnLetter(2 + model.operations.length * 2)}${workers.length + 3}`,
                    display.ready ? String(modelTotals.grandTotalAmount) : 'Noma’lum', `Davr bo‘yicha hisob`)}
                >
                  {displayedMoney(modelTotals.grandTotalAmount, display.ready, display.incomplete)}
                </td>
              </tr>
          </>
        } />
    </div>
  );
};
