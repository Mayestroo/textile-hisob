import React, { useMemo, useState } from 'react';
import {
  Download,
  FileSpreadsheet,
  Layers,
  Search,
  TrendingUp,
  Wallet,
  X
} from 'lucide-react';
import { formatMoney } from '../../engine/formulaEngine';
import { displayedMoney, payrollDisplay } from '../../engine/payrollDisplay';
import { useWorkbookStore } from '../../store/workbookStore';
import { OperationRatesModal } from './modals/OperationRatesModal';

export const ModellarJamiView: React.FC = () => {
  const models = useWorkbookStore((s) => s.models);
  const workers = useWorkbookStore((s) => s.workers);
  const submittedTickets = useWorkbookStore((s) => s.submittedTickets);
  const currentPeriod = useWorkbookStore((s) => s.currentPeriod);
  const payrollValuation = useWorkbookStore((s) => s.payrollValuation);
  const companyId = useWorkbookStore((s) => s.licenseStatus?.companyId);
  const setActiveSheet = useWorkbookStore((s) => s.setActiveSheet);
  const exportExcel = useWorkbookStore((s) => s.exportExcel);

  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'with_work' | 'no_work'>('with_work');
  const [showRatesModal, setShowRatesModal] = useState(false);

  // Compute payroll summary display
  const display = useMemo(
    () => payrollDisplay(models || [], workers || [], payrollValuation, companyId, currentPeriod?.id || 'current'),
    [models, workers, payrollValuation, companyId, currentPeriod?.id]
  );
  const masterReport = display.masterReport;
  const reportModels = display.displayModels;
  const money = (value: number) => displayedMoney(value, display.reportReady, display.incomplete);

  // Model-level sewn quantities
  const modelSewnQuantities = useMemo(() => {
    const map: Record<string, number> = {};
    for (const m of reportModels) {
      if (!models.some((model) => model.id === m.id)) {
        const quantities = Object.values(m.hisobQuantities).flatMap((ops) => Object.values(ops));
        map[m.id] = quantities.length ? Math.max(...quantities) : 0;
        continue;
      }
      const fromTickets = (submittedTickets || [])
        .filter((t) => t.modelId === m.id)
        .reduce((sum, t) => sum + (t.qty || 0), 0);

      if (fromTickets > 0) {
        map[m.id] = fromTickets;
      } else {
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
  }, [models, reportModels, submittedTickets, workers]);

  // Model calculation rows
  const modelRows = useMemo(() => {
    return reportModels.map((m) => {
      const qty = modelSewnQuantities[m.id] || 0;
      const amount = masterReport.modelTotals[m.id] || 0;
      const modelPrice = display.modelPrices[m.id];
      const hasPrice = modelPrice !== null && modelPrice > 0;
      const unknownAmount = workers.some((w) =>
        m.operations.some((op) => display.unknown.has(display.key(m.id, w.id, op.name)))
      );
      const expectedTotal = hasPrice ? (modelPrice * qty) : null;
      const tavofut = (hasPrice && !unknownAmount) ? ((modelPrice * qty) - amount) : null;
      const tavofutPercent = (tavofut !== null && expectedTotal && expectedTotal > 0)
        ? ((tavofut / expectedTotal) * 100)
        : null;

      return {
        id: m.id,
        name: m.name,
        price: modelPrice,
        hasPrice,
        qty,
        amount,
        unknownAmount,
        expectedTotal,
        tavofut,
        tavofutPercent
      };
    });
  }, [reportModels, modelSewnQuantities, masterReport.modelTotals, display.modelPrices, display.unknown, display.key, workers]);

  // Overall totals
  const totalModelsCount = reportModels.length;
  const withWorkCount = useMemo(() => modelRows.filter((r) => r.qty > 0).length, [modelRows]);
  const withoutWorkCount = totalModelsCount - withWorkCount;

  const totalSewnQty = useMemo(() => modelRows.reduce((sum, r) => sum + r.qty, 0), [modelRows]);
  const totalAmount = useMemo(() => modelRows.reduce((sum, r) => sum + r.amount, 0), [modelRows]);
  const totalTavofut = useMemo(() => {
    return modelRows.reduce((sum, r) => sum + (r.tavofut || 0), 0);
  }, [modelRows]);

  const totalExpectedAll = useMemo(() => {
    return modelRows.reduce((sum, r) => sum + (r.expectedTotal || 0), 0);
  }, [modelRows]);

  const overallTavofutPercent = totalExpectedAll > 0
    ? ((totalTavofut / totalExpectedAll) * 100)
    : (totalAmount > 0 ? (totalTavofut / totalAmount) * 100 : 0);

  // Filtered rows for main table
  const filteredRows = useMemo(() => {
    let list = [...modelRows];

    // Filter by mode
    if (filterMode === 'with_work') {
      list = list.filter((r) => r.qty > 0);
    } else if (filterMode === 'no_work') {
      list = list.filter((r) => r.qty === 0);
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter((r) => r.name.toLowerCase().includes(q));
    }

    // Default sort by amount descending (as in screenshot)
    list.sort((a, b) => {
      if (b.amount !== a.amount) return b.amount - a.amount;
      return b.qty - a.qty;
    });

    return list;
  }, [modelRows, filterMode, searchQuery]);

  return (
    <div className="modellar-jami-page">
      {/* 1. Page Header */}
      <div className="modellar-jami-header">
        <div className="modellar-jami-title-box">
          <h1>Modellar kesimida jami</h1>
          <p>Model narxi, tikilgan ish va tafovut</p>
        </div>
        <button
          type="button"
          className="modellar-excel-btn"
          onClick={exportExcel}
          title="Excel formatida yuklab olish"
        >
          <Download size={14} strokeWidth={2.4} />
          <span>Excel</span>
        </button>
      </div>

      {/* 2. 4 KPI Hero Stat Cards */}
      <div className="modellar-kpi-grid">
        {/* Card 1: Tikilgan ish soni */}
        <div className="modellar-kpi-card">
          <div className="modellar-kpi-icon" style={{ backgroundColor: '#eff6ff', color: '#2563eb' }}>
            <Layers size={22} strokeWidth={2.2} />
          </div>
          <div className="modellar-kpi-copy">
            <span className="modellar-kpi-label">Tikilgan ish soni</span>
            <div className="modellar-kpi-value" style={{ color: '#2563eb' }}>
              {totalSewnQty.toLocaleString()}
              <span className="modellar-kpi-unit">dona</span>
            </div>
          </div>
        </div>

        {/* Card 2: Jami summa */}
        <div className="modellar-kpi-card">
          <div className="modellar-kpi-icon" style={{ backgroundColor: '#f3e8ff', color: '#7c3aed' }}>
            <Wallet size={22} strokeWidth={2.2} />
          </div>
          <div className="modellar-kpi-copy">
            <span className="modellar-kpi-label">Jami summa</span>
            <div className="modellar-kpi-value" style={{ color: '#7c3aed' }}>
              {money(totalAmount)}
              <span className="modellar-kpi-unit">so'm</span>
            </div>
          </div>
        </div>

        {/* Card 3: Tafovut */}
        <div className="modellar-kpi-card">
          <div className="modellar-kpi-icon" style={{ backgroundColor: '#ecfdf5', color: '#059669' }}>
            <TrendingUp size={22} strokeWidth={2.2} />
          </div>
          <div className="modellar-kpi-copy">
            <span className="modellar-kpi-label">Tafovut</span>
            <div className="modellar-kpi-value" style={{ color: totalTavofut >= 0 ? '#059669' : '#dc2626' }}>
              {totalTavofut > 0 ? `+${money(totalTavofut)}` : money(totalTavofut)}
              <span className="modellar-kpi-unit">so'm</span>
            </div>
            <span className="modellar-kpi-subtext">
              Model narxidan {overallTavofutPercent.toFixed(1)}%
            </span>
          </div>
        </div>

        {/* Card 4: Modellar soni */}
        <div className="modellar-kpi-card">
          <div className="modellar-kpi-icon" style={{ backgroundColor: '#fef3c7', color: '#d97706' }}>
            <FileSpreadsheet size={22} strokeWidth={2.2} />
          </div>
          <div className="modellar-kpi-copy">
            <span className="modellar-kpi-label">Modellar</span>
            <div className="modellar-kpi-value" style={{ color: '#b45309' }}>
              {totalModelsCount}
              <span className="modellar-kpi-unit">ta</span>
            </div>
            <span className="modellar-kpi-subtext">
              {withWorkCount} tasida ish bajarilgan
            </span>
          </div>
        </div>
      </div>

      {/* 3. Toolbar: Search + Quick Filter Pills */}
      <div className="modellar-toolbar">
        <div className="modellar-toolbar-left">
          <div className="modellar-search-box">
            <Search size={15} className="search-icon" />
            <input
              type="text"
              className="modellar-search-input"
              placeholder="Model nomi bo'yicha qidirish"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                className="modellar-search-clear"
                title="Qidiruvni tozalash"
                onClick={() => setSearchQuery('')}
              >
                <X size={13} />
              </button>
            )}
          </div>

          <div className="modellar-pills">
            <button
              type="button"
              className={`modellar-pill-btn ${filterMode === 'all' ? 'active' : ''}`}
              onClick={() => setFilterMode('all')}
            >
              Hammasi · {totalModelsCount}
            </button>
            <button
              type="button"
              className={`modellar-pill-btn ${filterMode === 'with_work' ? 'active' : ''}`}
              onClick={() => setFilterMode('with_work')}
            >
              Ish bor · {withWorkCount}
            </button>
            <button
              type="button"
              className={`modellar-pill-btn ${filterMode === 'no_work' ? 'active' : ''}`}
              onClick={() => setFilterMode('no_work')}
            >
              Ish yo'q · {withoutWorkCount}
            </button>
          </div>
        </div>
      </div>

      {/* 4. Main Body: Full Width Models Table Card */}
      <div className="modellar-jami-layout">
        <div className="modellar-table-card">
          <table className="modellar-table">
            <thead>
              <tr>
                <th style={{ width: '48px', textAlign: 'center' }}>№</th>
                <th style={{ textAlign: 'left', paddingLeft: '16px' }}>MODEL NOMI</th>
                <th style={{ width: '150px', textAlign: 'right', paddingRight: '14px' }}>MODEL NARXI</th>
                <th style={{ width: '150px', textAlign: 'right', paddingRight: '14px' }}>TIKILGAN, DONA</th>
                <th style={{ width: '170px', textAlign: 'right', paddingRight: '16px' }}>JAMI SUMMA ↓</th>
                <th style={{ width: '150px', textAlign: 'right', paddingRight: '14px' }}>TAFOVUT</th>
                <th style={{ width: '120px', textAlign: 'right', paddingRight: '16px' }}>TAFOVUT, %</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r, idx) => (
                <tr
                  key={r.id}
                  className="modellar-row"
                  onDoubleClick={() => setActiveSheet(r.name)}
                  title="2 marta bosing: Model hisobot varag'iga o'tish"
                >
                  <td style={{ textAlign: 'center', color: '#64748b' }}>{idx + 1}</td>
                  <td style={{ textAlign: 'left', paddingLeft: '16px', fontWeight: 700, color: '#0f172a' }}>
                    {r.name}
                  </td>
                  <td style={{ textAlign: 'right', paddingRight: '14px' }}>
                    {r.hasPrice ? (
                      <span style={{ fontWeight: 500, color: '#0f172a' }}>{formatMoney(r.price!)}</span>
                    ) : (
                      <button
                        type="button"
                        className="modellar-no-price-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowRatesModal(true);
                        }}
                        title="Operatsiya narxlarini kiritish uchun bosing"
                      >
                        Narx kiritilmagan
                      </button>
                    )}
                  </td>
                  <td style={{ textAlign: 'right', paddingRight: '14px', fontWeight: 600, color: '#0f172a' }}>
                    {r.qty > 0 ? r.qty.toLocaleString() : '—'}
                  </td>
                  <td style={{ textAlign: 'right', paddingRight: '16px', fontWeight: 700, color: '#0f172a' }}>
                    {r.amount > 0 ? money(r.amount) : '—'}
                  </td>
                  <td style={{ textAlign: 'right', paddingRight: '14px' }}>
                    {r.tavofut !== null && r.hasPrice && r.qty > 0 ? (
                      <span className={r.tavofut >= 0 ? 'modellar-tavofut-pill-pos' : 'modellar-tavofut-pill-neg'}>
                        {r.tavofut > 0 ? `+${money(r.tavofut)}` : money(r.tavofut)}
                      </span>
                    ) : (
                      <span style={{ color: '#cbd5e1' }}>—</span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right', paddingRight: '16px', fontWeight: 600, color: '#0f172a' }}>
                    {r.tavofutPercent !== null && r.hasPrice && r.qty > 0 ? (
                      `${r.tavofutPercent.toFixed(1)}%`
                    ) : (
                      <span style={{ color: '#cbd5e1' }}>—</span>
                    )}
                  </td>
                </tr>
              ))}

              {filteredRows.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: '40px', color: '#94a3b8' }}>
                    Model topilmadi
                  </td>
                </tr>
              )}

              <tr className="modellar-table-spacer">
                <td colSpan={7} style={{ padding: 0, border: 'none', height: '100%', background: 'transparent' }} />
              </tr>
            </tbody>

            {/* Grand Total Row (Pinned Sticky Footer) */}
            <tfoot className="modellar-tfoot">
              <tr className="modellar-total-row">
                <td style={{ textAlign: 'center', color: '#065f46', position: 'sticky', bottom: 0, zIndex: 10 }}>—</td>
                <td style={{ textAlign: 'left', paddingLeft: '16px', color: '#065f46', fontWeight: 800, position: 'sticky', bottom: 0, zIndex: 10 }}>
                  Jami · {totalModelsCount} model
                </td>
                <td style={{ textAlign: 'right', paddingRight: '14px', color: '#065f46', position: 'sticky', bottom: 0, zIndex: 10 }}>—</td>
                <td style={{ textAlign: 'right', paddingRight: '14px', color: '#065f46', fontWeight: 800, position: 'sticky', bottom: 0, zIndex: 10 }}>
                  {totalSewnQty.toLocaleString()}
                </td>
                <td style={{ textAlign: 'right', paddingRight: '16px', color: '#065f46', fontWeight: 800, position: 'sticky', bottom: 0, zIndex: 10 }}>
                  {money(totalAmount)}
                </td>
                <td style={{ textAlign: 'right', paddingRight: '14px', color: '#065f46', fontWeight: 800, position: 'sticky', bottom: 0, zIndex: 10 }}>
                  {totalTavofut > 0 ? `+${money(totalTavofut)}` : money(totalTavofut)}
                </td>
                <td style={{ textAlign: 'right', paddingRight: '16px', color: '#065f46', fontWeight: 800, position: 'sticky', bottom: 0, zIndex: 10 }}>
                  {overallTavofutPercent.toFixed(1)}%
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Operation Rates Modal */}
      {showRatesModal && (
        <OperationRatesModal onClose={() => setShowRatesModal(false)} />
      )}
    </div>
  );
};

