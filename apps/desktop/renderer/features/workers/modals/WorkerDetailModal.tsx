import React, { useState, useMemo } from 'react';
import { useWorkbookStore } from '../../../store/workbookStore';
import { useAuthStore } from '../../../store/authStore';
import { X, Layers, Search, Download, Clock } from 'lucide-react';
import { formatMoney } from '../../../engine/formulaEngine';
import { displayedMoney, payrollDisplay } from '../../../engine/payrollDisplay';
import { formatDateIso, formatTicketDateTime } from '../../../utils/formatters';
import { Worker } from '../../../types/workbook';

interface WorkerOperationRecord {
  kind: 'PAYROLL' | 'AUDIT';
  id: string;
  ticketId: string;
  periodId: string;
  submittedAt: string;
  konveyer: string;
  modelId: string;
  modelName: string;
  partyNumber: string;
  pattaNumber: number;
  size: string;
  color: string;
  opName: string;
  rate: number | null;
  qty: number | null;
  summa: number | null;
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
  const currentPeriod = useWorkbookStore((s) => s.currentPeriod);
  const payrollValuation = useWorkbookStore((s) => s.payrollValuation);
  const licenseCompanyId = useWorkbookStore((s) => s.licenseStatus?.companyId);
  const authCompanyId = useAuthStore((s) => s.companyId);
  const companyId = licenseCompanyId || authCompanyId;
  const periodId = currentPeriod.id;
  const displayWorkers = useMemo(() => {
    const known = new Set(workers.map((item) => Number(item.id)));
    const historic = payrollValuation.workers.filter((item: any) => !known.has(Number(item.workerId)))
      .map((item: any) => ({ id: Number(item.workerId), name: item.name || item.workerName || `Ishchi #${item.workerId}`,
        staj: Number(item.staj || 0), avans: Number(item.avans || 0), jarima: Number(item.jarima || 0) } as Worker));
    return [...workers, ...historic];
  }, [workers, payrollValuation]);
  const display = useMemo(() => payrollDisplay(models, displayWorkers, payrollValuation, companyId || undefined, periodId),
    [models, displayWorkers, payrollValuation, companyId, periodId]);

  const isOpen = modalType === 'worker_detail';

  const worker = useMemo(() => {
    if (!isOpen || !workerId) return null;
    const current = workers.find((w) => w.id === workerId);
    if (current) return current;
    const historical = payrollValuation.workers.find((w: any) => Number(w.workerId) === Number(workerId));
    return historical ? { id: Number(workerId), name: historical.name || historical.workerName || `Ishchi #${workerId}`,
      staj: Number(historical.staj || 0), avans: Number(historical.avans || 0), jarima: Number(historical.jarima || 0) } : null;
  }, [isOpen, workers, workerId, payrollValuation]);

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
  }, [isOpen, workerId, modalModelId, modalOpName, models]);

  // Source-ticket rows preserve capture/audit information only. They are never added to payroll totals.
  const operationRecords = useMemo<WorkerOperationRecord[]>(() => {
    if (!isOpen || !workerId) return [];

    const records: WorkerOperationRecord[] = [];
    const modelMetaMap = new Map(display.displayModels.map((m: any) => [m.id, m.name || m.id]));

    for (const ticket of submittedTickets || []) {
      const mName = modelMetaMap.get(ticket.modelId) || ticket.modelId;

      for (const entry of ticket.entries || []) {
        if (entry.workerId === workerId) {
          const rate = typeof entry.rateSnapshot === 'number' && Number.isFinite(entry.rateSnapshot)
            ? entry.rateSnapshot : null;
          const qty = ticket.qty || 0;

          records.push({
            kind: 'AUDIT',
            id: `${ticket.id}_${entry.opName}`,
            ticketId: ticket.id,
            periodId: ticket.periodId || 'Davr noma’lum',
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
            summa: null
          });
        }
      }
    }

    return records;
  }, [isOpen, workerId, display.displayModels, submittedTickets]);

  const payrollRecords = useMemo<WorkerOperationRecord[]>(() => {
    if (!isOpen || !workerId) return [];
    return display.displayModels.flatMap((model: any) => model.operations.flatMap((op: any) => {
      const cell = display.key(model.id, workerId, op.name);
      const amount = display.cellAmounts[cell] ?? null;
      const qty = display.cellQuantities[cell] ?? null;
      if (amount === 0 && qty === 0) return [];
      return [{ kind: 'PAYROLL' as const, id: `payroll_${model.id}_${workerId}_${op.name}`, ticketId: 'PAYROLL',
        periodId, submittedAt: `Davr: ${currentPeriod.name}`, konveyer: '—', modelId: model.id, modelName: model.name,
        partyNumber: '—', pattaNumber: 0, size: '—', color: '—', opName: op.name,
        rate: display.operationRates[model.id]?.[op.name] ?? null, qty, summa: amount }];
    }));
  }, [isOpen, workerId, display, periodId, currentPeriod.name]);

  const allRecords = useMemo(() => [...payrollRecords, ...operationRecords], [payrollRecords, operationRecords]);
  const workerHasUnknownMoney = !display.ready
    || (Boolean(companyId) && !payrollValuation.workers.some((entry: any) => Number(entry.workerId) === Number(workerId)))
    || payrollRecords.some((record) => record.summa === null);

  // Unique models and konveyers for filtering
  const uniqueModels = useMemo(() => {
    const set = new Set<string>();
    for (const r of allRecords) {
      set.add(r.modelName);
    }
    return Array.from(set);
  }, [allRecords]);

  const uniqueOperations = useMemo(() => {
    const set = new Set<string>();
    for (const r of allRecords) {
      if (selectedModel === 'all' || r.modelName === selectedModel) {
        set.add(r.opName);
      }
    }
    return Array.from(set);
  }, [allRecords, selectedModel]);

  const uniqueKonveyers = useMemo(() => {
    const set = new Set<string>();
    for (const r of allRecords) {
      if (r.konveyer && r.konveyer !== '—') set.add(r.konveyer);
    }
    return Array.from(set);
  }, [allRecords]);

  // Filtered records
  const filteredRecords = useMemo(() => {
    return allRecords.filter((r) => {
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
  }, [allRecords, selectedModel, selectedOp, selectedKonveyer, searchQuery]);

  // Summary totals
  const totals = useMemo(() => {
    let totalQty = 0;
    let totalSumma = 0;
    let unknownPayroll = false;
    for (const r of filteredRecords) {
      if (r.kind !== 'PAYROLL') continue;
      if (r.summa === null || r.qty === null) unknownPayroll = true;
      else { totalSumma += r.summa; totalQty += r.qty; }
    }
    if (filteredRecords.some((r) => r.kind === 'AUDIT') && !filteredRecords.some((r) => r.kind === 'PAYROLL')) unknownPayroll = true;
    return {
      totalOperations: filteredRecords.filter((r) => r.kind === 'PAYROLL').length,
      totalQty,
      totalSumma,
      unknownPayroll
    };
  }, [filteredRecords]);

  const toCsvCell = (value: unknown) => {
    const text = String(value ?? '');
    const safeText = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safeText.replace(/"/g, '""')}"`;
  };

  // Export to CSV
  const payrollWorker = display.masterReport.workers.find((row: any) => Number(row.workerId) === Number(worker?.id));

  const handleExportCSV = () => {
    if (!worker || (filteredRecords.length === 0 && !payrollWorker)) return;

    const headers = ['Tur', 'Davr', '№', 'Vaqt', 'Konveyer', 'Model', 'Partiya №', 'Patta №', 'Razmer', 'Rang', 'Operatsiya', 'Davr tarifi / saqlangan tarif', 'Ish Soni (dona)', 'Ish haqi (so‘m)'];
    const rows = filteredRecords.map((r, idx) => [
      r.kind === 'PAYROLL' ? 'DAVR ISH HAQI' : 'PATTA MA’LUMOTI — ISH HAQI EMAS',
      r.periodId,
      idx + 1,
      r.submittedAt,
      r.konveyer,
      r.modelName,
      r.partyNumber,
      r.pattaNumber,
      r.size,
      r.color,
      r.opName,
      r.rate === null ? 'Noma’lum' : r.rate,
      r.qty === null ? 'Noma’lum' : r.qty,
      r.kind === 'PAYROLL' ? (r.summa === null ? 'Noma’lum' : r.summa) : ''
    ]);

    const csvContent = '\uFEFF' + [
      toCsvCell(`Ishchi: ${worker.name} (ID: ${worker.id})`),
      toCsvCell(`Davr: ${currentPeriod.name} (${periodId})`),
      toCsvCell(`Hisob holati: ${display.label || 'Tasdiqlangan davr qiymati'}`),
      toCsvCell(`Piecework ish haqi: ${payrollWorker && !workerHasUnknownMoney ? displayedMoney(payrollWorker.pieceworkGross, display.ready, display.incomplete) : 'Noma’lum'} so‘m`),
      toCsvCell(`Oklad (piecework ustiga qo‘shilgan): ${payrollWorker && !workerHasUnknownMoney ? displayedMoney(payrollWorker.oklad, display.ready, display.incomplete) : 'Noma’lum'} so‘m`),
      toCsvCell(`Jami ish haqi (piecework + Oklad): ${payrollWorker && !workerHasUnknownMoney ? displayedMoney(payrollWorker.umumiy, display.ready, display.incomplete) : 'Noma’lum'} so‘m`),
      toCsvCell(`Magazin (sof to‘lovdan ayriladi): ${payrollWorker && !workerHasUnknownMoney ? displayedMoney(payrollWorker.magazin, display.ready, display.incomplete) : 'Noma’lum'} so‘m`),
      toCsvCell(`Avans: ${payrollWorker && !workerHasUnknownMoney ? displayedMoney(payrollWorker.avans, display.ready, display.incomplete) : 'Noma’lum'} so‘m`),
      toCsvCell(`Jarima: ${payrollWorker && !workerHasUnknownMoney ? displayedMoney(payrollWorker.jarima, display.ready, display.incomplete) : 'Noma’lum'} so‘m`),
      toCsvCell(`Staj: ${payrollWorker && !workerHasUnknownMoney ? displayedMoney(payrollWorker.staj, display.ready, display.incomplete) : 'Noma’lum'} so‘m`),
      toCsvCell(`Davr bo‘yicha sof qoldiq: ${payrollWorker && !workerHasUnknownMoney ? displayedMoney(payrollWorker.sofFoyda, display.ready, display.incomplete) : 'Noma’lum'} so‘m`),
      toCsvCell(`Ko‘rsatilgan operatsiyalar jami: ${displayedMoney(totals.totalSumma, display.ready && !workerHasUnknownMoney && !totals.unknownPayroll, display.incomplete || workerHasUnknownMoney || totals.unknownPayroll)} so‘m`),
      toCsvCell('Pattadagi saqlangan tariflar ma’lumot uchun; ish haqiga qayta qo‘shilmaydi.'),
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

  const staj = payrollWorker?.staj ?? worker.staj ?? 0;
  const avans = payrollWorker?.avans ?? worker.avans ?? 0;
  const jarima = payrollWorker?.jarima ?? worker.jarima ?? 0;
  const pieceworkGross = payrollWorker?.pieceworkGross ?? 0;
  const oklad = payrollWorker?.oklad ?? 0;
  const magazin = payrollWorker?.magazin ?? 0;
  const gross = payrollWorker?.umumiy ?? 0;
  const sofFoyda = payrollWorker?.sofFoyda ?? 0;

  return (
    <div className="modal-overlay phase-c-modal phase-c-worker-detail" onClick={closeModal} style={{ zIndex: 1100 }}>
      <div 
        className="modal-card e3-detail-card"
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
          className="modal-header e3-detail-header"
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
                <h2 style={{ fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>
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
              <button aria-label="Oynani yopish"
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
        <div className="e3-detail-stats" style={{
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
                  {workerHasUnknownMoney ? 'Noma’lum' : displayedMoney(sofFoyda, display.ready, display.incomplete)} <span style={{ fontSize: '11px', fontWeight: 500 }}>so'm</span>
              </div>
            </div>
          </div>

          {/* Piecework only */}
          <div className="kpi-card" style={{ borderLeft: '4px solid #6366f1', padding: '8px 12px' }}>
            <div>
              <div className="kpi-label" style={{ fontSize: '10.5px' }}>Piecework ish haqi</div>
              <div className="kpi-value" style={{ color: '#818cf8', fontSize: '16px' }}>
                {workerHasUnknownMoney ? 'Noma’lum' : displayedMoney(pieceworkGross, display.ready, display.incomplete)} <span style={{ fontSize: '11px', fontWeight: 500 }}>so'm</span>
              </div>
            </div>
          </div>

          <div className="kpi-card" style={{ borderLeft: '4px solid #059669', padding: '8px 12px' }}>
            <div><div className="kpi-label" style={{ fontSize: '10.5px' }}>Oklad qo‘shimchasi</div>
              <div className="kpi-value" style={{ color: '#059669', fontSize: '16px' }}>
                {workerHasUnknownMoney ? 'Noma’lum' : displayedMoney(oklad, display.ready, display.incomplete)} <span style={{ fontSize: '11px', fontWeight: 500 }}>so'm</span>
              </div>
            </div>
          </div>

          <div className="kpi-card" style={{ borderLeft: '4px solid #334155', padding: '8px 12px' }}>
            <div><div className="kpi-label" style={{ fontSize: '10.5px' }}>Jami ish haqi (ish + Oklad)</div>
              <div className="kpi-value" style={{ color: 'var(--text-primary)', fontSize: '16px' }}>
                {workerHasUnknownMoney ? 'Noma’lum' : displayedMoney(gross, display.ready, display.incomplete)} <span style={{ fontSize: '11px', fontWeight: 500 }}>so'm</span>
              </div>
            </div>
          </div>

          <div className="kpi-card" style={{ borderLeft: '4px solid #0284c7', padding: '8px 12px' }}>
            <div><div className="kpi-label" style={{ fontSize: '10.5px' }}>Magazin ushlanmasi</div>
              <div className="kpi-value" style={{ color: '#0284c7', fontSize: '16px' }}>
                {workerHasUnknownMoney ? 'Noma’lum' : displayedMoney(magazin, display.ready, display.incomplete)} <span style={{ fontSize: '11px', fontWeight: 500 }}>so'm</span>
              </div>
            </div>
          </div>

          {/* Jami Tikilgan Dona */}
          <div className="kpi-card" style={{ borderLeft: '4px solid #06b6d4', padding: '8px 12px' }}>
            <div>
              <div className="kpi-label" style={{ fontSize: '10.5px' }}>Jami Ish Soni</div>
              <div className="kpi-value" style={{ color: '#38bdf8', fontSize: '16px' }}>
                  {totals.unknownPayroll ? 'Noma’lum' : totals.totalQty.toLocaleString()} <span style={{ fontSize: '11px', fontWeight: 500 }}>dona</span>
              </div>
            </div>
          </div>

          {/* Staj */}
          <div className="kpi-card" style={{ borderLeft: '4px solid #8b5cf6', padding: '8px 12px' }}>
            <div>
              <div className="kpi-label" style={{ fontSize: '10.5px' }}>Staj Qo'shimchasi</div>
              <div className="kpi-value" style={{ color: '#a78bfa', fontSize: '16px' }}>
                {workerHasUnknownMoney ? 'Noma’lum' : displayedMoney(staj, display.ready, display.incomplete)} <span style={{ fontSize: '11px', fontWeight: 500 }}>so'm</span>
              </div>
            </div>
          </div>

          {/* Avans & Jarima */}
          <div className="kpi-card" style={{ borderLeft: '4px solid #f59e0b', padding: '8px 12px' }}>
            <div>
              <div className="kpi-label" style={{ fontSize: '10.5px' }}>Avans / Jarima</div>
              <div className="kpi-value" style={{ color: '#fbbf24', fontSize: '14px' }}>
                {workerHasUnknownMoney ? 'Noma’lum' : `${displayedMoney(avans, display.ready, display.incomplete)} / ${displayedMoney(jarima, display.ready, display.incomplete)}`}
              </div>
            </div>
          </div>
        </div>

        {display.label && (
          <div className="e3-detail-status" role="status" style={{ padding: '7px 20px', color: '#b45309', background: 'rgba(245, 158, 11, 0.1)', fontSize: '11px', fontWeight: 650 }}>
            {display.label} — ish haqi davr hisobidan olinadi; patta ma’lumoti qayta qo‘shilmaydi.
          </div>
        )}

        {/* Filter Controls Bar */}
        <div className="e3-detail-filters" style={{
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
          <div className="e3-detail-search" style={{ position: 'relative', width: '100%', maxWidth: '280px' }}>
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
        <div className="e3-detail-table" style={{ flex: 1, overflowY: 'auto', minHeight: 0, background: 'var(--bg-surface)' }}>
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
                  <th className="col-header" style={{ textAlign: 'left', paddingLeft: '12px' }}>Davr ish haqi / patta ma’lumoti</th>
                  <th className="col-header" style={{ width: '105px', textAlign: 'right' }}>Davr / saqlangan tarif</th>
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
                      {r.kind === 'PAYROLL' ? `${r.opName} — davr ish haqi (${r.periodId})` : `${r.opName} — patta ma’lumoti (${r.periodId})`}
                    </td>

                    <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--text-secondary)' }}>
                      {r.rate === null ? 'Noma’lum' : `${formatMoney(r.rate)} so'm`}
                    </td>

                    <td style={{ textAlign: 'right', fontWeight: 800, color: '#38bdf8' }}>
                      {r.qty === null ? 'Noma’lum' : `${r.qty.toLocaleString()} dona`}
                    </td>

                    <td style={{ textAlign: 'right', paddingRight: '16px', fontWeight: 800, color: 'var(--primary)', fontSize: '12.5px' }}>
                      {r.kind === 'AUDIT' ? 'Ish haqiga qo‘shilmaydi' : r.summa === null
                        ? 'Noma’lum' : `${displayedMoney(r.summa, display.ready, display.incomplete)} so'm`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Modal Footer Summary */}
        <div className="e3-detail-footer" style={{
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
            <span>Ish haqi satrlari: <strong style={{ color: 'var(--text-primary)' }}>{totals.totalOperations} ta</strong></span>
            <span>Operatsiyalar jami: <strong style={{ color: '#38bdf8' }}>{totals.unknownPayroll ? 'Noma’lum' : `${totals.totalQty.toLocaleString()} dona`}</strong></span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-secondary)' }}>
              Tanlangan satrlar jami:
            </span>
            <span style={{ fontSize: '16px', fontWeight: 800, color: 'var(--primary)' }}>
              {displayedMoney(totals.totalSumma, display.ready && !totals.unknownPayroll, display.incomplete || totals.unknownPayroll)} so'm
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
