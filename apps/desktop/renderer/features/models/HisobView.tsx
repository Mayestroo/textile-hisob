import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useWorkbookStore } from '../../store/workbookStore';
import { ModelConfig, Worker } from '../../types/workbook';
import { calculateModelTotals, formatMoney, formatNumber } from '../../engine/formulaEngine';
import { getExcelColumnLetter } from '../../utils/excelUtils';
import { Search, Plus, Trash2, ArrowLeft, DollarSign } from 'lucide-react';

const VIRTUAL_THRESHOLD = 30;
const ROW_HEIGHT = 32;

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
  isSelected: boolean;
  onSelectRow: (workerId: number, toggle?: boolean) => void;
  onQuantityChange: (workerId: number, opName: string, valStr: string) => void;
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
  isSelected,
  onSelectRow,
  onQuantityChange,
  onCellFocus,
  onOpenWorkerDetail
}) => {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <tr
      className={`fast-row ${isSelected ? 'selected-row' : ''}`}
      onClick={() => onSelectRow(worker.id, false)}
      style={{
        backgroundColor: isSelected 
          ? 'rgba(59, 130, 246, 0.15)' 
          : (isHovered ? 'var(--bg-surface-hover)' : 'var(--bg-surface)'),
        height: '32px',
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
          left: '54px',
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
        const amount = qty * op.rate;
        const amountColLetter = getExcelColumnLetter(2 + i * 2);
        const qtyColLetter = getExcelColumnLetter(3 + i * 2);
        const formulaStr = `=$${amountColLetter}$2*${qty}`;

        return (
          <React.Fragment key={op.id || op.name}>
            {/* Amount column */}
            <td
              style={{
                textAlign: 'right',
                fontWeight: 600,
                paddingRight: '8px',
                color: amount > 0 ? (isSelected ? 'var(--primary-hover)' : 'var(--primary)') : 'var(--text-muted)',
                borderLeft: '1px solid var(--border-subtle)',
                backgroundColor: isSelected
                  ? (amount > 0 ? 'rgba(16, 185, 129, 0.28)' : 'rgba(59, 130, 246, 0.12)')
                  : (amount > 0 ? 'var(--primary-light)' : (isHovered ? 'var(--bg-surface-hover)' : 'transparent')),
                cursor: 'pointer',
                transition: 'background-color 0.12s ease'
              }}
              onClick={() => {
                onCellFocus(`${amountColLetter}${rowNum}`, String(amount), formulaStr);
                onSelectRow(worker.id, false);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                onOpenWorkerDetail && onOpenWorkerDetail(worker.id, modelId, op.name);
              }}
              title="2 marta bosing: Qaysi pattalardan kelib tushganini ko'rish"
            >
              {amount > 0 ? formatMoney(amount) : '—'}
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
              <input
                type="number"
                value={qty > 0 ? qty : ''}
                onChange={(e) => onQuantityChange(worker.id, op.name, e.target.value)}
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
                title="2 marta bosing: Qaysi pattalardan kelib tushganini ko'rish"
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
              onCellFocus(`${sumColLetter}${rowNum}`, String(workerTot), `=SUM(...)`);
              onSelectRow(worker.id, false);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onOpenWorkerDetail && onOpenWorkerDetail(worker.id, modelId);
            }}
            title="2 marta bosing: Ushbu modeldagi barcha pattalar va ishlar"
          >
            {formatMoney(workerTot)}
          </td>
        );
      })()}
    </tr>
  );
});

export const HisobView: React.FC<HisobViewProps> = ({ model }) => {
  const workers = useWorkbookStore((s) => s.workers);
  const updateHisobQuantity = useWorkbookStore((s) => s.updateHisobQuantity);
  const updateOperationRate = useWorkbookStore((s) => s.updateOperationRate);
  const setActiveCell = useWorkbookStore((s) => s.setActiveCell);
  const setActiveSheet = useWorkbookStore((s) => s.setActiveSheet);
  const openModal = useWorkbookStore((s) => s.openModal);

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedWorkerId, setSelectedWorkerId] = useState<number | null>(null);

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

  const modelTotals = useMemo(() => {
    return calculateModelTotals(model, workers);
  }, [model, workers]);

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

  const handleQuantityChange = useCallback((workerId: number, opName: string, valStr: string) => {
    const qty = Number(valStr);
    updateHisobQuantity(model.id, workerId, opName, isNaN(qty) ? 0 : qty);
  }, [model.id, updateHisobQuantity]);

  // Phase 2: virtualization for large worker counts
  const useVirtual = filteredWorkers.length > VIRTUAL_THRESHOLD;
  const tbodyRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: filteredWorkers.length,
    getScrollElement: () => tbodyRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    enabled: useVirtual
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const paddingBottom = virtualItems.length > 0 ? (rowVirtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end) : 0;
  const totalCols = 2 + model.operations.length * 2 + 1;

  return (
    <div className="excel-grid-container" style={{ display: 'flex', flexDirection: 'column', background: 'var(--bg-app)' }}>
      {/* Top Header Bar */}
      <div
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
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button
            onClick={() => setActiveSheet(model.name)}
            className="soft-btn soft-btn-secondary"
            style={{ padding: '6px 12px', fontSize: '12px', borderRadius: 'var(--radius-full)' }}
          >
            <ArrowLeft size={14} />
            <span>Pattaga qaytish ({model.name})</span>
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>
              {model.hisobSheetName}
            </span>
            <span style={{ fontSize: '11px', background: 'var(--bg-surface-subtle)', color: 'var(--text-secondary)', padding: '2px 8px', borderRadius: 'var(--radius-full)', fontWeight: 600 }}>
              Hisob-Kitob
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {/* Search Box */}
          <div style={{ position: 'relative', width: '220px' }}>
            <Search size={14} color="var(--text-muted)" style={{ position: 'absolute', left: '10px', top: '10px' }} />
            <input
              type="text"
              placeholder="Ishchi qidirish..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="soft-input"
              style={{ paddingLeft: '30px', height: '32px', borderRadius: 'var(--radius-full)', fontSize: '12px' }}
            />
          </div>

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
            <span>Jami: {formatMoney(modelTotals.grandTotalAmount)} so'm ({formatNumber(modelTotals.grandTotalQuantity)} dona)</span>
          </div>
        </div>
      </div>

      {/* Modern Spreadsheet Table Grid */}
      <div ref={tbodyRef} style={{ flex: 1, overflow: 'auto', position: 'relative', background: 'var(--bg-app)' }}>
        <table
          className="excel-table"
          style={{
            width: 'max-content',
            minWidth: '100%',
            borderCollapse: 'separate',
            borderSpacing: 0
          }}
        >
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
                  position: 'sticky', left: '54px', top: 0,
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
                  position: 'sticky', left: '54px', top: `${ROW1_H}px`,
                  backgroundColor: 'var(--bg-surface-subtle)', zIndex: 29
                }}
              />
              {model.operations.map((op, i) => {
                const rateColLet = getExcelColumnLetter(2 + i * 2);
                const qtyColLet = getExcelColumnLetter(3 + i * 2);
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
                      title={`Operatsiya narxi: ${op.rate} so'm`}
                      onClick={() => handleCellFocus(`${rateColLet}2`, String(op.rate))}
                    >
                      <input
                        type="number"
                        value={op.rate > 0 ? op.rate : ''}
                        onChange={(e) => updateOperationRate(model.id, op.name, Number(e.target.value) || 0)}
                        onFocus={() => handleCellFocus(`${rateColLet}2`, String(op.rate))}
                        placeholder=""
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
                        title="Dona narxini o'zgartirish"
                      />
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

            <tbody>
              {useVirtual ? (
                <>
                  {paddingTop > 0 && (
                    <tr style={{ height: `${paddingTop}px` }}>
                      <td colSpan={totalCols} style={{ padding: 0, border: 'none' }} />
                    </tr>
                  )}
                  {virtualItems.map((virtualRow) => {
                    const worker = filteredWorkers[virtualRow.index];
                    const rowNum = 3 + virtualRow.index;
                    const workerQtyMap = (model.hisobQuantities && model.hisobQuantities[worker.id]) || {};
                    const workerTot = modelTotals.workerTotals[worker.id]?.totalEarnings || 0;
                    return (
                      <WorkerRow
                        key={worker.id}
                        worker={worker}
                        rowNum={rowNum}
                        modelId={model.id}
                        hisobSheetName={model.hisobSheetName}
                        operations={model.operations}
                        workerQtyMap={workerQtyMap}
                        workerTot={workerTot}
                        isSelected={selectedWorkerId === worker.id}
                        onSelectRow={handleSelectRow}
                        onQuantityChange={handleQuantityChange}
                        onCellFocus={handleCellFocus}
                        onOpenWorkerDetail={handleOpenWorkerDetail}
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
                filteredWorkers.map((worker, wIdx) => {
                  const rowNum = 3 + wIdx;
                  const workerQtyMap = (model.hisobQuantities && model.hisobQuantities[worker.id]) || {};
                  const workerTot = modelTotals.workerTotals[worker.id]?.totalEarnings || 0;

                  return (
                    <WorkerRow
                      key={worker.id}
                      worker={worker}
                      rowNum={rowNum}
                      modelId={model.id}
                      hisobSheetName={model.hisobSheetName}
                      operations={model.operations}
                      workerQtyMap={workerQtyMap}
                      workerTot={workerTot}
                      isSelected={selectedWorkerId === worker.id}
                      onSelectRow={handleSelectRow}
                      onQuantityChange={handleQuantityChange}
                      onCellFocus={handleCellFocus}
                      onOpenWorkerDetail={handleOpenWorkerDetail}
                    />
                  );
                })
              )}

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
                        onClick={() => handleCellFocus(`${amountColLetter}${workers.length + 3}`, String(opTot?.totalAmount || 0), `=SUM(...)`)}
                      >
                        {formatMoney(opTot?.totalAmount || 0)}
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
                  onClick={() => handleCellFocus(`${getExcelColumnLetter(2 + model.operations.length * 2)}${workers.length + 3}`, String(modelTotals.grandTotalAmount), `=SUM(...)`)}
                >
                  {formatMoney(modelTotals.grandTotalAmount)}
                </td>
              </tr>
            </tbody>
          </table>
      </div>
    </div>
  );
};
