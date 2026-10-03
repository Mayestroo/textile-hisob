import React, { useState, useMemo } from 'react';
import { useWorkbookStore } from '../../../store/workbookStore';
import { X, Layers, Search, Download, Clock } from 'lucide-react';
import { formatMoney } from '../../../engine/formulaEngine';
import { formatDateIso, formatTicketDateTime } from '../../../utils/formatters';

interface WorkerOperationRecord {
  id: string;
  ticketId: string;
  submittedAt: string;
  konveyer: string;
  modelId: string;
  modelName: string;
  partyNumber: string;
  pattaNumber: number;
  size: string;
  color: string;
  opName: string;
  rate: number;
  qty: number;
  summa: number;
}

export const WorkerDetailModal: React.FC = () => {
  const modalType = useWorkbookStore((s) => s.modalState.type);
  const workerId = useWorkbookStore((s) => s.modalState.workerId);
  const modalModelId = useWorkbookStore((s) => s.modalState.modelId);
  const modalOpName = useWorkbookStore((s) => s.modalState.opName);
  const closeModal = useWorkbookStore((s) => s.closeModal);
  const workers = useWorkbookStore((s) => s.workers);
  const models = useWorkbookStore((s) => s.models);
  const submittedTickets = useWorkbookStore((s) => s.submittedTickets);

  const isOpen = modalType === 'worker_detail';

  const worker = useMemo(() => {
    if (!isOpen || !workerId) return null;
    return workers.find((w) => w.id === workerId) || null;
  }, [isOpen, workers, workerId]);

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedModel, setSelectedModel] = useState<string>('all');
  const [selectedOp, setSelectedOp] = useState<string>('all');
  const [selectedKonveyer, setSelectedKonveyer] = useState<string>('all');

  // React to modal opening with specific model and operation
  React.useEffect(() => {
    if (isOpen) {
      if (modalModelId) {
        const m = models.find((mod) => mod.id === modalModelId || mod.name === modalModelId);
        setSelectedModel(m ? m.name : 'all');
      } else {
        setSelectedModel('all');
      }
      if (modalOpName) {
        setSelectedOp(modalOpName);
      } else {
        setSelectedOp('all');
      }
      setSelectedKonveyer('all');
      setSearchQuery('');
    }
  }, [isOpen, modalModelId, modalOpName, models]);

  // Extract all operations performed by this worker across all submitted tickets
  const operationRecords = useMemo<WorkerOperationRecord[]>(() => {
    if (!isOpen || !workerId) return [];

    const records: WorkerOperationRecord[] = [];
    // Precompute model name and operation rate lookup map for O(1) operations
    const modelMetaMap = new Map<string, { name: string; opRates: Map<string, number> }>();
    for (const m of models) {
      const opRates = new Map<string, number>();
      for (const op of m.operations) {
        opRates.set(op.name, op.rate);
      }
      modelMetaMap.set(m.id, { name: m.name || m.id, opRates });
    }

    for (const ticket of submittedTickets || []) {
      const meta = modelMetaMap.get(ticket.modelId);
      const mName = meta?.name || ticket.modelId;
      const opRates = meta?.opRates;

      for (const entry of ticket.entries || []) {
        if (entry.workerId === workerId) {
          const rate = entry.rateSnapshot !== undefined && entry.rateSnapshot > 0 
            ? entry.rateSnapshot 
            : (opRates?.get(entry.opName) || 0);
          const qty = ticket.qty || 0;
          const summa = qty * rate;

          records.push({
            id: `${ticket.id}_${entry.opName}`,
            ticketId: ticket.id,
            submittedAt: formatTicketDateTime(ticket),
            konveyer: ticket.konveyer ? `${ticket.konveyer}-Konveyer` : '—',
            modelId: ticket.modelId,
            modelName: mName,
            partyNumber: String(ticket.partyNumber),
            pattaNumber: ticket.pattaNumber,
            size: ticket.size || '—',
            color: ticket.color || '—',
            opName: entry.opName,
            rate,
            qty,
            summa
          });
        }
      }
    }

    // Also check direct model hisobQuantities if any direct quantities were entered
    for (const m of models) {
      const workerOpMap = m.hisobQuantities?.[workerId];
      if (workerOpMap) {
        for (const [opName, totalHqQty] of Object.entries(workerOpMap)) {
          if (typeof totalHqQty === 'number' && totalHqQty > 0) {
            const fromTicketsSum = records
              .filter((r) => r.modelId === m.id && r.opName === opName)
              .reduce((s, r) => s + r.qty, 0);

            const directDiff = totalHqQty - fromTicketsSum;
            if (directDiff > 0) {
              const op = m.operations.find((o) => o.name === opName);
              const rate = op?.rate || 0;
              records.push({
                id: `direct_${m.id}_${workerId}_${opName}`,
                ticketId: 'direct',
                submittedAt: 'Jadvaldan kiritilgan',
                konveyer: '—',
                modelId: m.id,
                modelName: m.name || m.id,
                partyNumber: '—',
                pattaNumber: 0,
                size: '—',
                color: '—',
                opName,
                rate,
                qty: directDiff,
                summa: directDiff * rate
              });
            }
          }
        }
      }
    }

    return records;
  }, [isOpen, workerId, models, submittedTickets]);

  // Unique models and konveyers for filtering
  const uniqueModels = useMemo(() => {
    const set = new Set<string>();
    for (const r of operationRecords) {
      set.add(r.modelName);
    }
    return Array.from(set);
  }, [operationRecords]);

  const uniqueOperations = useMemo(() => {
    const set = new Set<string>();
    for (const r of operationRecords) {
      if (selectedModel === 'all' || r.modelName === selectedModel) {
        set.add(r.opName);
      }
    }
    return Array.from(set);
  }, [operationRecords, selectedModel]);

  const uniqueKonveyers = useMemo(() => {
    const set = new Set<string>();
    for (const r of operationRecords) {
      if (r.konveyer && r.konveyer !== '—') set.add(r.konveyer);
    }
    return Array.from(set);
  }, [operationRecords]);

  // Filtered records
  const filteredRecords = useMemo(() => {
    return operationRecords.filter((r) => {
      if (selectedModel !== 'all' && r.modelName !== selectedModel) return false;
      if (selectedOp !== 'all' && r.opName !== selectedOp) return false;
      if (selectedKonveyer !== 'all' && r.konveyer !== selectedKonveyer) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchOp = r.opName.toLowerCase().includes(q);
        const matchModel = r.modelName.toLowerCase().includes(q);
        const matchParty = r.partyNumber.toLowerCase().includes(q);
        const matchPatta = String(r.pattaNumber).includes(q);
        const matchSize = r.size.toLowerCase().includes(q);
        const matchColor = r.color.toLowerCase().includes(q);
        if (!matchOp && !matchModel && !matchParty && !matchPatta && !matchSize && !matchColor) {
          return false;
        }
      }
      return true;
    });
  }, [operationRecords, selectedModel, selectedOp, selectedKonveyer, searchQuery]);

  // Summary totals
  const totals = useMemo(() => {
    let totalQty = 0;
    let totalSumma = 0;
    for (const r of filteredRecords) {
      totalQty += r.qty;
      totalSumma += r.summa;
    }
    return {
      totalOperations: filteredRecords.length,
      totalQty,
      totalSumma
    };
  }, [filteredRecords]);

  const toCsvCell = (value: unknown) => {
    const text = String(value ?? '');
    const safeText = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safeText.replace(/"/g, '""')}"`;
  };

  // Export to CSV
  const handleExportCSV = () => {
    if (!worker || filteredRecords.length === 0) return;

    const headers = ['№', 'Vaqt', 'Konveyer', 'Model', 'Partiya №', 'Patta №', 'Razmer', 'Rang', 'Bajarilgan Operatsiya', 'Dona Narxi (so\'m)', 'Ish Soni (dona)', 'Jami Summa (so\'m)'];
    const rows = filteredRecords.map((r, idx) => [
      idx + 1,
      r.submittedAt,
      r.konveyer,
      r.modelName,
      r.partyNumber,
      r.pattaNumber,
      r.size,
      r.color,
      r.opName,
      r.rate,
      r.qty,
      r.summa
    ]);

    const csvContent = '\uFEFF' + [
      toCsvCell(`Ishchi: ${worker.name} (ID: ${worker.id})`),
      toCsvCell(`Jami Ish Soni: ${totals.totalQty} dona`),
      toCsvCell(`Jami Hisoblangan Summa: ${totals.totalSumma} so'm`),
      '',
      headers.join(','),
      ...rows.map((row) => row.map(toCsvCell).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
      link.setAttribute('download', `${worker.name.replace(/\s+/g, '_')}_Bajargan_ishlari_${formatDateIso()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (!isOpen || !worker) return null;

  const staj = worker.staj || 0;
  const avans = worker.avans || 0;
  const jarima = worker.jarima || 0;
  const sofFoyda = totals.totalSumma + staj - avans - jarima;

  return (
    <div className="modal-overlay" onClick={closeModal} style={{ zIndex: 1100 }}>
      <div 
        className="modal-card" 
        style={{ 
          maxWidth: '1050px', 
          width: '95vw', 
          maxHeight: '90vh', 
          display: 'flex', 
          flexDirection: 'column', 
          padding: 0,
          overflow: 'hidden'
        }} 
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div 
          className="modal-header" 
          style={{ 
            padding: '16px 20px', 
            background: 'var(--bg-surface-subtle)', 
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{
              width: '42px',
              height: '42px',
              borderRadius: 'var(--radius-full)',
              background: 'var(--primary-light)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--primary)',
              fontWeight: 800,
              fontSize: '16px',
              border: '1px solid rgba(16, 185, 129, 0.3)'
            }}>
              {worker.id}
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <h2 style={{ fontSize: '17px', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>
                  {worker.name}
                </h2>
                <span style={{
                  fontSize: '11px',
                  fontWeight: 700,
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--text-secondary)',
                  padding: '2px 8px',
                  borderRadius: 'var(--radius-full)'
                }}>
                  ID: #{worker.id}
                </span>
              </div>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '2px 0 0' }}>
                Bajarilgan barcha operatsiyalar, pattalar va ish haqi tafsilotlari
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {filteredRecords.length > 0 && (
              <button
                onClick={handleExportCSV}
                className="soft-btn soft-btn-secondary"
                style={{ fontSize: '12px', padding: '6px 14px' }}
                title="Excel (CSV) fayl sifatida yuklab olish"
              >
                <Download size={14} />
                <span>Excelga eksport</span>
              </button>
            )}
            <button 
              onClick={closeModal} 
              style={{ 
                border: 'none', 
                background: 'transparent', 
                cursor: 'pointer', 
                color: 'var(--text-muted)',
                padding: '6px',
                borderRadius: 'var(--radius-md)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Financial KPI Summary Cards */}
        <div style={{ 
          padding: '12px 20px', 
          background: 'var(--bg-surface)', 
          borderBottom: '1px solid var(--border-subtle)',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
          gap: '10px'
        }}>
          {/* Sof Foyda */}
          <div className="kpi-card" style={{ borderLeft: '4px solid #10b981', padding: '8px 12px' }}>
            <div>
              <div className="kpi-label" style={{ fontSize: '10.5px' }}>Sof Foyda (Qo'lga)</div>
              <div className="kpi-value" style={{ color: 'var(--primary)', fontSize: '16px' }}>
                {formatMoney(sofFoyda)} <span style={{ fontSize: '11px', fontWeight: 500 }}>so'm</span>
              </div>
            </div>
          </div>

          {/* Jami Hisoblangan */}
          <div className="kpi-card" style={{ borderLeft: '4px solid #6366f1', padding: '8px 12px' }}>
            <div>
              <div className="kpi-label" style={{ fontSize: '10.5px' }}>Hisoblangan Ish Haqi</div>
              <div className="kpi-value" style={{ color: '#818cf8', fontSize: '16px' }}>
                {formatMoney(totals.totalSumma)} <span style={{ fontSize: '11px', fontWeight: 500 }}>so'm</span>
              </div>
            </div>
          </div>

          {/* Jami Tikilgan Dona */}
          <div className="kpi-card" style={{ borderLeft: '4px solid #06b6d4', padding: '8px 12px' }}>
            <div>
              <div className="kpi-label" style={{ fontSize: '10.5px' }}>Jami Ish Soni</div>
              <div className="kpi-value" style={{ color: '#38bdf8', fontSize: '16px' }}>
                {totals.totalQty.toLocaleString()} <span style={{ fontSize: '11px', fontWeight: 500 }}>dona</span>
              </div>
            </div>
          </div>

          {/* Staj */}
          <div className="kpi-card" style={{ borderLeft: '4px solid #8b5cf6', padding: '8px 12px' }}>
            <div>
              <div className="kpi-label" style={{ fontSize: '10.5px' }}>Staj Qo'shimchasi</div>
              <div className="kpi-value" style={{ color: '#a78bfa', fontSize: '16px' }}>
                {formatMoney(staj)} <span style={{ fontSize: '11px', fontWeight: 500 }}>so'm</span>
              </div>
            </div>
          </div>

          {/* Avans & Jarima */}
          <div className="kpi-card" style={{ borderLeft: '4px solid #f59e0b', padding: '8px 12px' }}>
            <div>
              <div className="kpi-label" style={{ fontSize: '10.5px' }}>Avans / Jarima</div>
              <div className="kpi-value" style={{ color: '#fbbf24', fontSize: '14px' }}>
                {formatMoney(avans)} / {formatMoney(jarima)}
              </div>
            </div>
          </div>
        </div>

        {/* Filter Controls Bar */}
        <div style={{
          padding: '10px 20px',
          background: 'var(--bg-surface-subtle)',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '10px',
          flexWrap: 'wrap'
        }}>
          {/* Search Box */}
          <div style={{ position: 'relative', width: '100%', maxWidth: '280px' }}>
            <Search size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            <input
              type="text"
              placeholder="Operatsiya yoki patta raqami..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="soft-input"
              style={{ paddingLeft: '32px', height: '30px', fontSize: '12px', width: '100%' }}
            />
          </div>

          {/* Model, Operation & Konveyer Filters */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            {uniqueModels.length > 1 && (
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="soft-input"
                style={{ height: '30px', fontSize: '12px', padding: '0 8px' }}
              >
                <option value="all">Barcha modellar ({uniqueModels.length})</option>
                {uniqueModels.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            )}

            {uniqueOperations.length > 1 && (
              <select
                value={selectedOp}
                onChange={(e) => setSelectedOp(e.target.value)}
                className="soft-input"
                style={{
                  height: '30px',
                  fontSize: '12px',
                  padding: '0 8px',
                  fontWeight: selectedOp !== 'all' ? 700 : 400,
                  borderColor: selectedOp !== 'all' ? '#3b82f6' : undefined,
                  color: selectedOp !== 'all' ? '#2563eb' : undefined
                }}
              >
                <option value="all">Barcha operatsiyalar ({uniqueOperations.length})</option>
                {uniqueOperations.map((op) => (
                  <option key={op} value={op}>{op}</option>
                ))}
              </select>
            )}

            {uniqueKonveyers.length > 1 && (
              <select
                value={selectedKonveyer}
                onChange={(e) => setSelectedKonveyer(e.target.value)}
                className="soft-input"
                style={{ height: '30px', fontSize: '12px', padding: '0 8px' }}
              >
                <option value="all">Barcha konveyerlar</option>
                {uniqueKonveyers.map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
            )}

            {selectedOp !== 'all' && (
              <div style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                background: 'rgba(59, 130, 246, 0.12)',
                border: '1px solid rgba(59, 130, 246, 0.35)',
                color: '#1d4ed8',
                padding: '2px 8px',
                borderRadius: 'var(--radius-full)',
                fontSize: '11.5px',
                fontWeight: 700
              }}>
                <span>Operatsiya: {selectedOp}</span>
                <button
                  onClick={() => setSelectedOp('all')}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    color: '#2563eb',
                    padding: 0,
                    fontWeight: 800
                  }}
                  title="Barcha operatsiyalarni ko'rish"
                >
                  ✕
                </button>
              </div>
            )}

            <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 600 }}>
              Topildi: <strong style={{ color: 'var(--text-primary)' }}>{filteredRecords.length}</strong> ta operatsiya
            </span>
          </div>
        </div>

        {/* Operations Table */}
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, background: 'var(--bg-surface)' }}>
          {filteredRecords.length === 0 ? (
            <div style={{
              padding: '60px 20px',
              textAlign: 'center',
              color: 'var(--text-muted)',
              fontSize: '13.5px'
            }}>
              <Layers size={36} color="var(--text-muted)" style={{ margin: '0 auto 10px', display: 'block', opacity: 0.5 }} />
              <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
                Hozircha birorta bajarilgan ish topilmadi
              </div>
              <div>
                Ushbu ishchi ishtirok etgan pattalar kiritilganda barcha ma'lumotlar bu yerda avtomatik jamlanadi.
              </div>
            </div>
          ) : (
            <table className="excel-table" style={{ width: '100%', fontSize: '12px' }}>
              <thead>
                <tr style={{ height: '34px', background: 'var(--bg-surface-subtle)', position: 'sticky', top: 0, zIndex: 10 }}>
                  <th className="col-header" style={{ width: '45px', textAlign: 'center' }}>№</th>
                  <th className="col-header" style={{ width: '80px', textAlign: 'center' }}>Vaqt</th>
                  <th className="col-header" style={{ width: '110px', textAlign: 'center' }}>Konveyer</th>
                  <th className="col-header" style={{ width: '130px', textAlign: 'left', paddingLeft: '12px' }}>Model</th>
                  <th className="col-header" style={{ width: '75px', textAlign: 'center' }}>Partiya</th>
                  <th className="col-header" style={{ width: '75px', textAlign: 'center' }}>Patta №</th>
                  <th className="col-header" style={{ width: '75px', textAlign: 'center' }}>Razmer</th>
                  <th className="col-header" style={{ width: '85px', textAlign: 'center' }}>Rang</th>
                  <th className="col-header" style={{ textAlign: 'left', paddingLeft: '12px' }}>Bajarilgan Operatsiya</th>
                  <th className="col-header" style={{ width: '105px', textAlign: 'right' }}>Dona Narxi</th>
                  <th className="col-header" style={{ width: '105px', textAlign: 'right' }}>Ish Soni</th>
                  <th className="col-header" style={{ width: '125px', textAlign: 'right', paddingRight: '16px' }}>Jami Summa</th>
                </tr>
              </thead>
              <tbody>
                {filteredRecords.map((r, idx) => (
                  <tr 
                    key={r.id} 
                    style={{ 
                      height: '32px',
                      backgroundColor: idx % 2 === 0 ? 'var(--bg-surface)' : 'var(--bg-surface-subtle)',
                      transition: 'background-color 0.1s'
                    }}
                  >
                    <td style={{ textAlign: 'center', color: 'var(--text-muted)', fontWeight: 600 }}>
                      {idx + 1}
                    </td>

                    <td style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                        <Clock size={11} />
                        {r.submittedAt}
                      </span>
                    </td>

                    <td style={{ textAlign: 'center' }}>
                      {r.konveyer !== '—' ? (
                        <span style={{
                          background: 'rgba(139, 92, 246, 0.15)',
                          color: '#a78bfa',
                          border: '1px solid rgba(139, 92, 246, 0.3)',
                          padding: '1px 8px',
                          borderRadius: 'var(--radius-full)',
                          fontSize: '11px',
                          fontWeight: 700
                        }}>
                          {r.konveyer}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                      )}
                    </td>

                    <td style={{ paddingLeft: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>
                      {r.modelName}
                    </td>

                    <td style={{ textAlign: 'center', fontWeight: 700, color: 'var(--text-primary)' }}>
                      {r.partyNumber && r.partyNumber !== '—' ? r.partyNumber : "No'malum Partiya"}
                    </td>

                    <td style={{ textAlign: 'center', fontWeight: 800 }}>
                      {r.pattaNumber > 0 ? (
                        <span style={{
                          background: 'rgba(245, 158, 11, 0.15)',
                          color: '#d97706',
                          border: '1px solid rgba(245, 158, 11, 0.35)',
                          padding: '2px 8px',
                          borderRadius: 'var(--radius-full)',
                          fontSize: '11.5px',
                          fontWeight: 800
                        }}>
                          Patta #{r.pattaNumber}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>No'malum Patta</span>
                      )}
                    </td>

                    <td style={{ textAlign: 'center', fontWeight: 700 }}>
                      {r.size !== '—' ? (
                        <span style={{ background: 'var(--bg-surface-subtle)', border: '1px solid var(--border-subtle)', padding: '1px 6px', borderRadius: '4px', fontSize: '11px' }}>
                          {r.size}
                        </span>
                      ) : '—'}
                    </td>

                    <td style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
                      {r.color}
                    </td>

                    <td style={{ paddingLeft: '12px', fontWeight: 700, color: '#818cf8' }}>
                      {r.opName}
                    </td>

                    <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--text-secondary)' }}>
                      {formatMoney(r.rate)} so'm
                    </td>

                    <td style={{ textAlign: 'right', fontWeight: 800, color: '#38bdf8' }}>
                      {r.qty.toLocaleString()} dona
                    </td>

                    <td style={{ textAlign: 'right', paddingRight: '16px', fontWeight: 800, color: 'var(--primary)', fontSize: '12.5px' }}>
                      {formatMoney(r.summa)} so'm
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Modal Footer Summary */}
        <div style={{
          padding: '12px 20px',
          background: 'var(--bg-surface-subtle)',
          borderTop: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '12px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', fontSize: '12.5px' }}>
            <span>Jami operatsiyalar: <strong style={{ color: 'var(--text-primary)' }}>{totals.totalOperations} ta</strong></span>
            <span>Jami ish soni: <strong style={{ color: '#38bdf8' }}>{totals.totalQty.toLocaleString()} dona</strong></span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-secondary)' }}>
              Jami Hisoblangan Ish Haqi:
            </span>
            <span style={{ fontSize: '16px', fontWeight: 800, color: 'var(--primary)' }}>
              {formatMoney(totals.totalSumma)} so'm
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
