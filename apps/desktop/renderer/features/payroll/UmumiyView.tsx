import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useWorkbookStore } from '../../store/workbookStore';
import { calculateMasterPayroll, formatMoney } from '../../engine/formulaEngine';
import { Search, Calendar, DollarSign, Wallet, Award, TrendingUp } from 'lucide-react';
import { WorkerPayrollSummary } from '../../engine/formulaEngine';

const VIRTUAL_THRESHOLD = 30;
const ROW_HEIGHT = 32;

interface WorkerSummaryRowProps {
  w: WorkerPayrollSummary;
  rowNum: number;
  isSelected?: boolean;
  onSelectRow?: (workerId: number, toggle?: boolean) => void;
  onAvansChange: (workerId: number, val: string) => Promise<boolean> | void;
  onJarimaChange: (workerId: number, val: string) => Promise<boolean> | void;
  onCellFocus: (cellId: string, value: string, formula?: string) => void;
  onOpenWorkerManager: () => void;
  onOpenWorkerDetail: (workerId: number) => void;
}

const WorkerSummaryRow = React.memo<WorkerSummaryRowProps>(({
  w,
  rowNum,
  isSelected = false,
  onSelectRow,
  onAvansChange,
  onJarimaChange,
  onCellFocus,
  onOpenWorkerManager,
  onOpenWorkerDetail
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const [avansDraft, setAvansDraft] = useState<string | null>(null);
  const [jarimaDraft, setJarimaDraft] = useState<string | null>(null);
  const formulaC = `=G${rowNum}-F${rowNum}-E${rowNum}-D${rowNum}`;

  return (
    <tr
      className={`fast-row ${isSelected ? 'selected-row' : ''}`}
      onClick={() => onSelectRow && onSelectRow(w.workerId, false)}
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
          color: isSelected ? '#1d4ed8' : (isHovered ? 'var(--primary)' : 'var(--text-secondary)'),
          cursor: 'pointer',
          position: 'sticky',
          left: 0,
          zIndex: 8,
          backgroundColor: isSelected
            ? 'rgba(59, 130, 246, 0.20)'
            : (isHovered ? 'var(--bg-surface-hover)' : 'var(--bg-surface)'),
          borderRight: '1px solid var(--border-subtle)',
          transition: 'background-color 0.12s ease'
        }}
        onClick={(e) => {
          e.stopPropagation();
          onCellFocus(`A${rowNum}`, String(w.workerId));
          onSelectRow && onSelectRow(w.workerId, true);
        }}
        onDoubleClick={() => onOpenWorkerDetail(w.workerId)}
        title="Tanlash / Bekor qilish (2 marta: Ishchi hisoboti)"
      >
        <span style={{ 
          background: isSelected
            ? '#2563eb'
            : (isHovered ? 'var(--border-default)' : 'var(--bg-surface-subtle)'), 
          color: isSelected ? '#ffffff' : (isHovered ? 'var(--text-primary)' : 'inherit'),
          padding: '2px 8px', 
          borderRadius: 'var(--radius-full)',
          fontSize: '11.5px',
          fontWeight: isSelected ? 800 : 700,
          transition: 'all 0.12s ease'
        }}>
          {w.workerId}
        </span>
      </td>

      {/* Col B: Name */}
      <td 
        style={{
          fontWeight: isSelected ? 700 : 600,
          paddingLeft: '14px',
          color: isSelected ? '#1d4ed8' : (isHovered ? 'var(--primary-hover)' : 'var(--text-primary)'),
          cursor: 'pointer',
          position: 'sticky',
          left: '54px',
          zIndex: 8,
          backgroundColor: isSelected
            ? 'rgba(59, 130, 246, 0.20)'
            : (isHovered ? 'var(--bg-surface-hover)' : 'var(--bg-surface)'),
          borderRight: '1px solid var(--border-subtle)',
          whiteSpace: 'nowrap',
          transition: 'background-color 0.12s ease'
        }}
        onClick={() => {
          onCellFocus(`B${rowNum}`, w.workerName);
          onSelectRow && onSelectRow(w.workerId, false);
        }}
        onDoubleClick={() => onOpenWorkerDetail(w.workerId)}
        title="2 marta bosing: Ishchining bajargan barcha ishlari, pattalari va narxlari tarixi"
      >
        {w.workerName}
      </td>

      {/* Col C: Sof Foyda (= G - F - E - D) */}
      <td
        style={{
          textAlign: 'right',
          fontWeight: 700,
          paddingRight: '14px',
          backgroundColor: isSelected
            ? 'rgba(16, 185, 129, 0.28)'
            : (isHovered
                ? (w.sofFoyda > 0 ? 'rgba(16, 185, 129, 0.24)' : 'var(--bg-surface-hover)')
                : (w.sofFoyda > 0 ? 'var(--primary-light)' : 'transparent')),
          color: w.sofFoyda > 0 ? 'var(--primary)' : w.sofFoyda < 0 ? '#ef4444' : 'var(--text-muted)',
          fontSize: '13.5px',
          borderRight: '1px solid var(--border-subtle)',
          cursor: 'pointer',
          transition: 'background-color 0.12s ease'
        }}
        onClick={() => {
          onCellFocus(`C${rowNum}`, String(w.sofFoyda), formulaC);
          onSelectRow && onSelectRow(w.workerId, false);
        }}
      >
        {formatMoney(w.sofFoyda)}
      </td>

      {/* Col D: Staj */}
      <td
        style={{
          textAlign: 'right',
          paddingRight: '12px',
          fontWeight: w.staj > 0 ? 600 : 400,
          color: w.staj > 0 ? '#a78bfa' : 'var(--text-muted)',
          backgroundColor: isSelected
            ? 'rgba(139, 92, 246, 0.28)'
            : (isHovered
                ? (w.staj > 0 ? 'rgba(139, 92, 246, 0.24)' : 'var(--bg-surface-hover)')
                : (w.staj > 0 ? 'rgba(139, 92, 246, 0.15)' : 'transparent')),
          borderRight: '1px solid var(--border-subtle)',
          cursor: 'pointer',
          transition: 'background-color 0.12s ease'
        }}
        onClick={() => {
          onCellFocus(`D${rowNum}`, String(w.staj));
          onSelectRow && onSelectRow(w.workerId, false);
          onOpenWorkerManager();
        }}
        title="Staj Ishchilar ro'yxatidan o'zgartiriladi (ochish uchun bosing)"
      >
        {w.staj > 0 ? formatMoney(w.staj) : '—'}
      </td>

      {/* Col E: Avans */}
      <td 
        style={{ 
          textAlign: 'right', 
          padding: '2px 6px', 
          backgroundColor: isSelected
            ? 'rgba(245, 158, 11, 0.28)'
            : (isHovered
                ? (w.avans > 0 ? 'rgba(245, 158, 11, 0.24)' : 'var(--bg-surface-hover)')
                : (w.avans > 0 ? 'rgba(245, 158, 11, 0.15)' : 'transparent')), 
          borderRight: '1px solid var(--border-subtle)',
          cursor: 'pointer',
          transition: 'background-color 0.12s ease'
        }}
        onClick={() => {
          onCellFocus(`E${rowNum}`, String(w.avans));
          onSelectRow && onSelectRow(w.workerId, false);
        }}
      >
        <input
          type="text"
          inputMode="numeric"
          value={avansDraft ?? (w.avans > 0 ? formatMoney(w.avans) : '')}
          onChange={(e) => setAvansDraft(e.target.value)}
          onFocus={() => {
            setAvansDraft(w.avans > 0 ? formatMoney(w.avans) : '');
            onCellFocus(`E${rowNum}`, String(w.avans));
            onSelectRow && onSelectRow(w.workerId, false);
          }}
          onBlur={async (e) => {
            await onAvansChange(w.workerId, e.currentTarget.value);
            setAvansDraft(null);
          }}
          placeholder=""
          style={{
            width: '100%',
            height: '28px',
            border: '1px solid transparent',
            borderRadius: 'var(--radius-sm)',
            outline: 'none',
            background: 'transparent',
            textAlign: 'right',
            paddingRight: '8px',
            fontFamily: 'inherit',
            fontSize: '12.5px',
            color: w.avans > 0 ? '#f59e0b' : 'var(--text-muted)',
            fontWeight: w.avans > 0 ? 600 : 400,
            transition: 'all 0.15s'
          }}
        />
      </td>

      {/* Col F: Jarima */}
      <td 
        style={{ 
          textAlign: 'right', 
          padding: '2px 6px', 
          backgroundColor: isSelected
            ? 'rgba(239, 68, 68, 0.28)'
            : (isHovered
                ? (w.jarima > 0 ? 'rgba(239, 68, 68, 0.24)' : 'var(--bg-surface-hover)')
                : (w.jarima > 0 ? 'rgba(239, 68, 68, 0.15)' : 'transparent')), 
          borderRight: '1px solid var(--border-subtle)',
          cursor: 'pointer',
          transition: 'background-color 0.12s ease'
        }}
        onClick={() => {
          onCellFocus(`F${rowNum}`, String(w.jarima));
          onSelectRow && onSelectRow(w.workerId, false);
        }}
      >
        <input
          type="text"
          inputMode="numeric"
          value={jarimaDraft ?? (w.jarima > 0 ? formatMoney(w.jarima) : '')}
          onChange={(e) => setJarimaDraft(e.target.value)}
          onFocus={() => {
            setJarimaDraft(w.jarima > 0 ? formatMoney(w.jarima) : '');
            onCellFocus(`F${rowNum}`, String(w.jarima));
            onSelectRow && onSelectRow(w.workerId, false);
          }}
          onBlur={async (e) => {
            await onJarimaChange(w.workerId, e.currentTarget.value);
            setJarimaDraft(null);
          }}
          placeholder=""
          style={{
            width: '100%',
            height: '28px',
            border: '1px solid transparent',
            borderRadius: 'var(--radius-sm)',
            outline: 'none',
            background: 'transparent',
            textAlign: 'right',
            paddingRight: '8px',
            fontFamily: 'inherit',
            fontSize: '12.5px',
            color: w.jarima > 0 ? '#ef4444' : 'var(--text-muted)',
            fontWeight: w.jarima > 0 ? 600 : 400,
            transition: 'all 0.15s'
          }}
        />
      </td>

      {/* Col G: Umumiy */}
      <td
        style={{
          textAlign: 'right',
          fontWeight: 700,
          paddingRight: '14px',
          color: w.umumiy > 0 ? 'var(--text-primary)' : 'var(--text-muted)',
          backgroundColor: isSelected
            ? 'rgba(16, 185, 129, 0.28)'
            : (isHovered
                ? (w.umumiy > 0 ? 'rgba(16, 185, 129, 0.24)' : 'var(--bg-surface-hover)')
                : (w.umumiy > 0 ? 'var(--primary-light)' : 'transparent')),
          borderRight: '1px solid var(--border-subtle)',
          fontSize: '13.5px',
          cursor: 'pointer',
          transition: 'background-color 0.12s ease'
        }}
        onClick={() => {
          onCellFocus(`G${rowNum}`, String(w.umumiy), `UpdateUmumiy()`);
          onSelectRow && onSelectRow(w.workerId, false);
        }}
        title={`Ishchining barcha modellardan yig'ilgan summasi: ${formatMoney(w.umumiy)}`}
      >
        {formatMoney(w.umumiy)}
      </td>
    </tr>
  );
});

export const UmumiyView: React.FC = () => {
  const workers = useWorkbookStore((s) => s.workers);
  const models = useWorkbookStore((s) => s.models);
  const submittedTickets = useWorkbookStore((s) => s.submittedTickets);
  const currentPeriod = useWorkbookStore((s) => s.currentPeriod);
  const updateWorker = useWorkbookStore((s) => s.updateWorker);
  const setActiveCell = useWorkbookStore((s) => s.setActiveCell);
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

  const masterReport = useMemo(() => {
    return calculateMasterPayroll(models, workers);
  }, [models, workers]);

  // Model-level sewn quantities (from submitted tickets / hisob entries)
  const modelSewnQuantities = useMemo(() => {
    const map: Record<string, number> = {};
    for (const m of models) {
      // 1. Exact quantity from submitted tickets for this model
      const fromTickets = (submittedTickets || [])
        .filter((t) => t.modelId === m.id)
        .reduce((sum, t) => sum + (t.qty || 0), 0);

      if (fromTickets > 0) {
        map[m.id] = fromTickets;
      } else {
        // Fallback: max quantity among operations in hisobQuantities if tickets not used
        let maxOpQty = 0;
        const operations = Array.isArray(m.operations) ? m.operations : [];
        const hq = (m.hisobQuantities && typeof m.hisobQuantities === 'object') ? (m.hisobQuantities as any) : {};
        for (const op of operations) {
          let opQty = 0;
          for (const w of workers) {
            opQty += hq[w.id]?.[op.name] || 0;
          }
          if (opQty > maxOpQty) maxOpQty = opQty;
        }
        map[m.id] = maxOpQty;
      }
    }
    return map;
  }, [models, submittedTickets, workers]);

  const filteredWorkers = useMemo(() => {
    if (!searchQuery.trim()) return masterReport.workers;
    const q = searchQuery.toLowerCase().trim();
    return masterReport.workers.filter(
      (w: WorkerPayrollSummary) => w.workerName.toLowerCase().includes(q) || String(w.workerId).includes(q)
    );
  }, [masterReport.workers, searchQuery]);

  const handleAvansChange = useCallback((workerId: number, val: string) => {
    const num = Number(val.replace(/\s+/g, '').replace(/,/g, '')) || 0;
    return updateWorker(workerId, { avans: num });
  }, [updateWorker]);

  const handleJarimaChange = useCallback((workerId: number, val: string) => {
    const num = Number(val.replace(/\s+/g, '').replace(/,/g, '')) || 0;
    return updateWorker(workerId, { jarima: num });
  }, [updateWorker]);

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
  const totalCols = 7;

  return (
    <div className="excel-grid-container" style={{ display: 'flex', flexDirection: 'column', background: 'var(--bg-app)' }}>
      {/* Top Section: KPI Stat Summary Cards */}
      <div style={{ 
        padding: '14px 18px 12px', 
        display: 'flex', 
        flexDirection: 'column', 
        gap: '12px',
        backgroundColor: 'var(--bg-surface)',
        borderBottom: '1px solid var(--border-subtle)',
        flexShrink: 0
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <h1 style={{ fontSize: '17px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.3px' }}>
              Umumiy Oylik Hisobot
            </h1>
            <button
              onClick={() => openModal({ type: 'period_manager' })}
              className="soft-btn soft-btn-secondary"
              style={{ padding: '4px 12px', borderRadius: 'var(--radius-full)', fontSize: '12px' }}
              title="Oylik davrini boshqarish"
            >
              <Calendar size={13} color="var(--primary)" />
              <span>{currentPeriod.name || 'Joriy Oylik'} ({currentPeriod.startDate} dan)</span>
            </button>
          </div>

          {/* Search bar */}
          <div style={{ position: 'relative', width: '260px' }}>
            <Search size={14} color="var(--text-muted)" style={{ position: 'absolute', left: '12px', top: '10px' }} />
            <input
              type="text"
              placeholder="Ishchi qidirish (ID / Ism)..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="soft-input"
              style={{ paddingLeft: '32px', height: '32px', borderRadius: 'var(--radius-full)', fontSize: '12.5px' }}
            />
          </div>
        </div>

        {/* 4 Soft KPI Metric Cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' }}>
          {/* Card 1: Sof Foyda */}
          <div className="kpi-card" style={{ borderLeft: '4px solid var(--primary)', padding: '10px 14px' }}>
            <div className="kpi-icon-container" style={{ background: 'var(--primary-light)', width: '36px', height: '36px' }}>
              <Wallet size={18} color="var(--primary)" />
            </div>
            <div>
              <div className="kpi-label">Sof To'lanadigan Foyda</div>
              <div className="kpi-value" style={{ color: 'var(--primary)', fontSize: '16px' }}>
                {formatMoney(masterReport.totalSofFoyda)} <span style={{ fontSize: '11px', fontWeight: 500 }}>so'm</span>
              </div>
            </div>
          </div>

          {/* Card 2: Jami Ishlangan */}
          <div className="kpi-card" style={{ borderLeft: '4px solid #818cf8', padding: '10px 14px' }}>
            <div className="kpi-icon-container" style={{ background: 'rgba(99, 102, 241, 0.15)', width: '36px', height: '36px' }}>
              <DollarSign size={18} color="#818cf8" />
            </div>
            <div>
              <div className="kpi-label">Jami Ishlangan Summa</div>
              <div className="kpi-value" style={{ color: '#818cf8', fontSize: '16px' }}>
                {formatMoney(masterReport.totalUmumiy)} <span style={{ fontSize: '11px', fontWeight: 500 }}>so'm</span>
              </div>
            </div>
          </div>

          {/* Card 3: Avans & Jarima */}
          <div className="kpi-card" style={{ borderLeft: '4px solid #f59e0b', padding: '10px 14px' }}>
            <div className="kpi-icon-container" style={{ background: 'rgba(245, 158, 11, 0.15)', width: '36px', height: '36px' }}>
              <TrendingUp size={18} color="#f59e0b" />
            </div>
            <div>
              <div className="kpi-label">Berilgan Avanslar</div>
              <div className="kpi-value" style={{ color: '#f59e0b', fontSize: '16px' }}>
                {formatMoney(masterReport.totalAvans)} <span style={{ fontSize: '11px', fontWeight: 500 }}>so'm</span>
              </div>
            </div>
          </div>

          {/* Card 4: Staj & Jarima */}
          <div className="kpi-card" style={{ borderLeft: '4px solid #a78bfa', padding: '10px 14px' }}>
            <div className="kpi-icon-container" style={{ background: 'rgba(139, 92, 246, 0.15)', width: '36px', height: '36px' }}>
              <Award size={18} color="#a78bfa" />
            </div>
            <div>
              <div className="kpi-label">Doimiy Stajlar</div>
              <div className="kpi-value" style={{ color: '#a78bfa', fontSize: '16px' }}>
                {formatMoney(masterReport.totalStaj)} <span style={{ fontSize: '11px', fontWeight: 500 }}>so'm</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Modern Soft Table Grid */}
      <div ref={tbodyRef} style={{ flex: 1, overflow: 'auto', position: 'relative', background: 'var(--bg-app)' }}>
        <table className="excel-table" style={{ width: 'max-content', minWidth: '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
          <colgroup>
            <col style={{ width: '54px' }} />
            <col style={{ width: '240px' }} />
            <col style={{ width: '150px' }} />
            <col style={{ width: '120px' }} />
            <col style={{ width: '130px' }} />
            <col style={{ width: '120px' }} />
            <col style={{ width: '150px' }} />
          </colgroup>

          <thead>
            {/* Header Columns */}
            <tr style={{ height: '38px' }}>
              <th
                className="col-header"
                style={{
                  width: '54px',
                  position: 'sticky',
                  top: 0,
                  left: 0,
                  zIndex: 25,
                  backgroundColor: 'var(--bg-surface-subtle)'
                }}
              >
                № (ID)
              </th>
              <th
                className="col-header"
                style={{
                  width: '240px',
                  textAlign: 'left',
                  paddingLeft: '14px',
                  position: 'sticky',
                  top: 0,
                  left: '54px',
                  zIndex: 25,
                  backgroundColor: 'var(--bg-surface-subtle)'
                }}
              >
                Ishchi F.I.O
              </th>
              <th
                className="col-header"
                style={{
                  width: '150px',
                  textAlign: 'right',
                  paddingRight: '14px',
                  color: 'var(--primary)',
                  position: 'sticky',
                  top: 0,
                  zIndex: 15,
                  backgroundColor: 'var(--bg-surface-subtle)'
                }}
              >
                Sof foyda
              </th>
              <th
                className="col-header"
                style={{
                  width: '120px',
                  textAlign: 'right',
                  paddingRight: '12px',
                  color: '#7c3aed',
                  position: 'sticky',
                  top: 0,
                  zIndex: 15,
                  backgroundColor: 'var(--bg-surface-subtle)'
                }}
              >
                Staj
              </th>
              <th
                className="col-header"
                style={{
                  width: '130px',
                  textAlign: 'right',
                  paddingRight: '12px',
                  color: '#d97706',
                  position: 'sticky',
                  top: 0,
                  zIndex: 15,
                  backgroundColor: 'var(--bg-surface-subtle)'
                }}
              >
                Avans
              </th>
              <th
                className="col-header"
                style={{
                  width: '120px',
                  textAlign: 'right',
                  paddingRight: '12px',
                  color: '#dc2626',
                  position: 'sticky',
                  top: 0,
                  zIndex: 15,
                  backgroundColor: 'var(--bg-surface-subtle)'
                }}
              >
                Jarima
              </th>
              <th
                className="col-header"
                style={{
                  width: '150px',
                  textAlign: 'right',
                  paddingRight: '14px',
                  position: 'sticky',
                  top: 0,
                  zIndex: 15,
                  backgroundColor: 'var(--bg-surface-subtle)'
                }}
              >
                Umumiy ish haqi
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
                      onSelectRow={handleSelectRow}
                      onAvansChange={handleAvansChange}
                      onJarimaChange={handleJarimaChange}
                      onCellFocus={handleCellFocus}
                      onOpenWorkerManager={handleOpenWorkerManager}
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
              filteredWorkers.map((w, idx) => {
                const rowNum = 3 + idx;
                return (
                  <WorkerSummaryRow
                    key={w.workerId}
                    w={w}
                    rowNum={rowNum}
                    isSelected={selectedWorkerId === w.workerId}
                    onSelectRow={handleSelectRow}
                    onAvansChange={handleAvansChange}
                    onJarimaChange={handleJarimaChange}
                    onCellFocus={handleCellFocus}
                    onOpenWorkerManager={handleOpenWorkerManager}
                    onOpenWorkerDetail={handleOpenWorkerDetail}
                  />
                );
              })
            )}

            {/* Grand Total Row with Soft UI styling */}
            <tr
              style={{
                backgroundColor: 'var(--primary-light)',
                fontWeight: 800,
                height: '42px',
                borderTop: '2px solid var(--primary)'
              }}
            >
              <td
                colSpan={2}
                style={{
                  textAlign: 'center',
                  fontWeight: 800,
                  fontSize: '14px',
                  color: 'var(--primary)',
                  cursor: 'pointer',
                  position: 'sticky',
                  left: 0,
                  zIndex: 8,
                  backgroundColor: 'var(--bg-surface)'
                }}
                onClick={() => handleCellFocus(`A${workers.length + 3}`, 'ЖАМИ')}
              >
                ЖАМИ (ИТОГО)
              </td>
              <td style={{ textAlign: 'right', fontWeight: 800, fontSize: '15px', paddingRight: '14px', color: 'var(--primary)', cursor: 'pointer' }} onClick={() => handleCellFocus(`C${workers.length + 3}`, String(masterReport.totalSofFoyda), `=SUM(...)`)}>
                {formatMoney(masterReport.totalSofFoyda)}
              </td>
              <td style={{ textAlign: 'right', fontWeight: 700, fontSize: '13px', paddingRight: '12px', color: '#a78bfa', cursor: 'pointer' }} onClick={() => handleCellFocus(`D${workers.length + 3}`, String(masterReport.totalStaj), `=SUM(...)`)}>
                {formatMoney(masterReport.totalStaj)}
              </td>
              <td style={{ textAlign: 'right', fontWeight: 700, fontSize: '13px', paddingRight: '12px', color: '#f59e0b', cursor: 'pointer' }} onClick={() => handleCellFocus(`E${workers.length + 3}`, String(masterReport.totalAvans), `=SUM(...)`)}>
                {formatMoney(masterReport.totalAvans)}
              </td>
              <td style={{ textAlign: 'right', fontWeight: 700, fontSize: '13px', paddingRight: '12px', color: '#ef4444', cursor: 'pointer' }} onClick={() => handleCellFocus(`F${workers.length + 3}`, String(masterReport.totalJarima), `=SUM(...)`)}>
                {formatMoney(masterReport.totalJarima)}
              </td>
              <td style={{ textAlign: 'right', fontWeight: 800, fontSize: '15px', paddingRight: '14px', color: 'var(--text-primary)', cursor: 'pointer' }} onClick={() => handleCellFocus(`G${workers.length + 3}`, String(masterReport.totalUmumiy), `=SUM(...)`)}>
                {formatMoney(masterReport.totalUmumiy)}
              </td>
            </tr>

            {/* Model Breakdown Section */}
            <tr style={{ backgroundColor: 'var(--bg-surface-subtle)', height: '32px', borderTop: '2px solid var(--border-default)' }}>
              <td colSpan={2} style={{ fontWeight: 700, paddingLeft: '14px', color: 'var(--text-secondary)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.4px', position: 'sticky', left: 0, zIndex: 6, backgroundColor: 'var(--bg-surface-subtle)' }}>
                Modellar kesimida jami:
              </td>
              <td colSpan={3}></td>
              <td style={{ textAlign: 'right', fontWeight: 700, paddingRight: '12px', color: 'var(--text-secondary)', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.3px' }}>
                Tikilgan ish soni
              </td>
              <td style={{ textAlign: 'right', fontWeight: 700, paddingRight: '14px', color: 'var(--text-secondary)', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.3px' }}>
                Jami summa
              </td>
            </tr>

            {models.map((m, mIdx) => {
              const qty = modelSewnQuantities[m.id] || 0;
              const amount = masterReport.modelTotals[m.id] || 0;

              return (
                <tr key={m.id} style={{ height: '32px', backgroundColor: 'var(--bg-surface)' }}>
                  <td style={{ textAlign: 'center', color: 'var(--text-muted)', position: 'sticky', left: 0, zIndex: 6, backgroundColor: 'var(--bg-surface)' }}>
                    {mIdx + 1}
                  </td>
                  <td style={{ paddingLeft: '20px', color: 'var(--text-primary)', fontWeight: 500, position: 'sticky', left: '54px', zIndex: 6, backgroundColor: 'var(--bg-surface)' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#6366f1' }} />
                      <span style={{ fontWeight: 600 }}>{m.name}</span>
                      {qty > 0 && (
                        <span style={{
                          fontSize: '11px',
                          fontWeight: 700,
                          color: '#10b981',
                          background: 'rgba(16, 185, 129, 0.12)',
                          padding: '1px 8px',
                          borderRadius: 'var(--radius-full)'
                        }}>
                          {qty.toLocaleString()} dona
                        </span>
                      )}
                    </span>
                  </td>
                  <td colSpan={3}></td>
                  <td style={{ textAlign: 'right', fontWeight: 700, paddingRight: '12px', color: qty > 0 ? '#10b981' : 'var(--text-muted)', fontSize: '13px' }}>
                    {qty.toLocaleString()} <span style={{ fontSize: '11px', fontWeight: 500 }}>dona</span>
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700, paddingRight: '14px', color: amount > 0 ? 'var(--primary)' : 'var(--text-muted)', fontSize: '13px' }}>
                    {formatMoney(amount)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
