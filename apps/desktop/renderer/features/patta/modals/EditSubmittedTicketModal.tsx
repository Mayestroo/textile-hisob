import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { useWorkbookStore } from '../../../store/workbookStore';
import { X, Check, AlertCircle, Plus, Trash2 } from 'lucide-react';
import { formatMoney } from '../../../engine/formulaEngine';
import { SubmittedTicketRecord } from '../../../types/workbook';
import { useAuthStore } from '../../../store/authStore';
import './EditSubmittedTicketModal.css';

export const EditSubmittedTicketModal: React.FC = () => {
  const modalType = useWorkbookStore((s) => s.modalState.type);
  const modalData = useWorkbookStore((s) => s.modalState.data) as SubmittedTicketRecord | undefined;
  const closeModal = useWorkbookStore((s) => s.closeModal);
  const openModal = useWorkbookStore((s) => s.openModal);
  const submittedTickets = useWorkbookStore((s) => s.submittedTickets);
  const models = useWorkbookStore((s) => s.models);
  const workers = useWorkbookStore((s) => s.workers);
  const updateSubmittedTicket = useWorkbookStore((s) => s.updateSubmittedTicket);
  const licenseStatus = useWorkbookStore((s) => s.licenseStatus);
  const currentPeriod = useWorkbookStore((s) => s.currentPeriod);
  const selectedArchiveFilename = useWorkbookStore((s) => s.selectedArchiveFilename);
  const payrollCompanyId = useWorkbookStore((s) => s.payrollValuation?.companyId);
  const canEditTickets = useAuthStore((s) => s.permissions.includes('edit:patta'));
  const authUserId = useAuthStore((s) => s.user?.uid || '');
  const authRole = useAuthStore((s) => s.role || '');

  const isOpen = modalType === 'edit_ticket';
  const returnToWorkerDetail = Number((modalData as any)?.returnToWorkerDetail);
  const closeTicketModal = useCallback(() => {
    if (Number.isSafeInteger(returnToWorkerDetail) && returnToWorkerDetail > 0) openModal({ type: 'worker_detail', workerId: returnToWorkerDetail, data: { focusTicketId: modalData?.id } });
    else closeModal();
  }, [returnToWorkerDetail, openModal, closeModal]);

  // Find the ticket from state to ensure fresh data
  const ticket = useMemo(() => {
    if (!isOpen || !modalData) return null;
    return submittedTickets.find((s) => s.id === modalData.id) || null;
  }, [isOpen, modalData, submittedTickets]);

  const model = useMemo(() => {
    if (!ticket) return null;
    return models.find((m) => m.id === ticket.modelId || m.name === ticket.modelId) || null;
  }, [ticket, models]);
  const jumpContext = (modalData as any)?.jumpContext;
  const jumpContextInvalid = Boolean(jumpContext && (
    jumpContext.companyId !== (licenseStatus?.companyId || useAuthStore.getState().companyId)
    || ((ticket as any)?.companyId && (ticket as any).companyId !== jumpContext.companyId)
    || (payrollCompanyId && jumpContext.companyId !== payrollCompanyId)
    || jumpContext.periodId !== currentPeriod.id
    || jumpContext.activationId !== (licenseStatus?.activationId || licenseStatus?.machineId || '')
    || jumpContext.authUserId !== authUserId
    || jumpContext.authRole !== authRole
    || ticket?.periodId !== currentPeriod.id
    || currentPeriod.isClosed || selectedArchiveFilename || !canEditTickets
  ));
  useEffect(() => {
    if (isOpen && jumpContext && jumpContextInvalid) closeTicketModal();
  }, [isOpen, jumpContext, jumpContextInvalid, closeTicketModal]);

  // Worker lookup map
  const workerMap = useMemo(() => {
    const map = new Map<number, string>();
    for (const w of workers) {
      map.set(w.id, w.name);
    }
    return map;
  }, [workers]);

  // Display the saved ticket rate, never today's tariff for old work.
  const operationsList = useMemo(() => {
    if (!model) return [];

    const order = model.pattaOpsOrder && model.pattaOpsOrder.length > 0
      ? model.pattaOpsOrder
      : model.operations.map((o) => o.name);

    return order.map((opName) => {
      const originals = (ticket?.entries || []).filter((entry) => entry.opName === opName);
      return {
        name: opName,
        rate: originals[0]?.rateSnapshot ?? null,
        entryId: originals.length === 1 ? originals[0].entryId : undefined
      };
    });
  }, [model, ticket]);

  type AllocationDraft = { key: string; opName: string; workerId: string; qty: string; entryId?: string; rateSnapshot?: number };
  const [allocations, setAllocations] = useState<AllocationDraft[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Initialize form when ticket changes
  useEffect(() => {
    if (isOpen && ticket) {
      setAllocations((ticket.entries || []).map((e, index) => ({ key: e.entryId || `existing-${index}`, opName: e.opName, workerId: String(e.workerId), qty: String(e.qty ?? ticket.qty), entryId: e.entryId, rateSnapshot: e.rateSnapshot })));
      setErrorMsg(null);
      setIsSaving(false);
    }
  }, [isOpen, ticket]);

  // Keyboard shortcut: Escape to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isOpen && e.key === 'Escape') {
        closeTicketModal();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, closeTicketModal]);

  const ticketQty = ticket?.qty || 0;
  const periodEditClosed = Boolean(currentPeriod?.isClosed || selectedArchiveFilename || (ticket?.periodId && ticket.periodId !== currentPeriod?.id));
  const allocationProgress = useMemo(() => model?.operations.map((operation) => {
    const total = allocations.filter((row) => row.opName === operation.name && row.workerId)
      .reduce((sum, row) => sum + (Number(row.qty) || 0), 0);
    return { name: operation.name, total, remaining: Math.max(0, ticketQty - total), complete: total === ticketQty };
  }) || [], [model, allocations, ticketQty]);

  if (!isOpen) return null;
  if (jumpContextInvalid || periodEditClosed || !ticket || !model || !canEditTickets) return <div role="alert" className="modal-overlay phase-c-dialog" style={{ zIndex: 9999, padding: 20 }}>
    <div className="modal-card" style={{ padding: 24, maxWidth: 520 }}>
      <p>Patta tahrirlash ochilmadi: tanlangan patta topilmadi yoki kompaniya, davr, arxiv holati yoxud ruxsat o‘zgardi.</p>
      <button className="soft-btn" onClick={closeTicketModal}>Yopish</button>
    </div>
  </div>;

  // Calculate live total sum for assigned operations
  let liveTotalAmount = 0;
  let assignedOpsCount = 0;
  let unknownRateCount = 0;

  for (const op of operationsList) {
    const rows = allocations.filter((entry) => entry.opName === op.name);
    for (const row of rows) {
    const wId = row.workerId ? parseInt(row.workerId, 10) : null;
    if (wId && workerMap.has(wId)) {
      if (op.rate !== null) liveTotalAmount += op.rate * (Number(row.qty) || 0);
      else unknownRateCount++;
      assignedOpsCount++;
    }
    }
  }

  const updateAllocation = (key: string, field: 'opName' | 'workerId' | 'qty', val: string) => {
    setAllocations((prev) => prev.map((row) => row.key === key ? { ...row, [field]: val.trim() } : row));
    if (errorMsg) setErrorMsg(null);
  };

  const handleSave = async () => {
    setErrorMsg(null);
    const latest = useWorkbookStore.getState();
    const actor = useAuthStore.getState();
    if (periodEditClosed || !latest.submittedTickets.some((item) => item.id === ticket.id && item.periodId === ticket.periodId)
      || (jumpContext && (latest.licenseStatus?.companyId !== jumpContext.companyId
        || ((latest.submittedTickets.find((item) => item.id === ticket.id) as any)?.companyId && (latest.submittedTickets.find((item) => item.id === ticket.id) as any)?.companyId !== jumpContext.companyId)
        || (latest.payrollValuation?.companyId && latest.payrollValuation.companyId !== jumpContext.companyId)
        || latest.currentPeriod.id !== jumpContext.periodId
        || (latest.licenseStatus?.activationId || latest.licenseStatus?.machineId || '') !== jumpContext.activationId))
      || (jumpContext && (actor.user?.uid || '') !== jumpContext.authUserId)
      || (jumpContext && (actor.role || '') !== jumpContext.authRole)
      || latest.selectedArchiveFilename || latest.currentPeriod.isClosed || !actor.permissions.includes('edit:patta')) {
      setErrorMsg('Kontekst yoki tahrirlash ruxsati o‘zgardi. Patta qayta ochilib tekshirilishi kerak.');
      return;
    }
    if ((ticket.entries || []).some((entry) => !model.operations.some((op) => op.name === entry.opName))) {
      setErrorMsg('Avvalgi operatsiya modelda topilmadi; uning tarixiy narxini taxmin qilib bo’lmaydi.');
      return;
    }

    // Validate: Check if all non-empty IDs are valid workers
    const updatedEntries: Array<{ opName: string; workerId: number; qty: number; rateSnapshot?: number; entryId?: string }> = [];

    for (const row of allocations) {
      if (row.workerId !== '') {
        const wId = Number(row.workerId);
        if (!Number.isSafeInteger(wId) || wId <= 0) {
          setErrorMsg(`«${row.opName}» uchun ishchi ID raqami noto'g'ri kiritilgan: "${row.workerId}"`);
          return;
        }
        if (!workerMap.has(wId)) {
          setErrorMsg(`«${row.opName}» uchun #${wId} ID ga ega ishchi ro'yxatda topilmadi!`);
          return;
        }
        const qty = Number(row.qty);
        if (!Number.isSafeInteger(qty) || qty <= 0) { setErrorMsg('Har bir taqsimot miqdori musbat butun son bo‘lishi kerak.'); return; }
        if (!model.operations.some((operation) => operation.name === row.opName)) { setErrorMsg('Operatsiya ushbu modelga tegishli emas.'); return; }
        updatedEntries.push({
          opName: row.opName,
          workerId: wId,
          qty,
          ...(row.entryId ? { entryId: row.entryId } : {}),
          ...(row.rateSnapshot !== undefined ? { rateSnapshot: row.rateSnapshot } : {})
        });
      }
    }

    if (updatedEntries.length === 0) {
      setErrorMsg("Hech bo'lmaganda bitta operatsiyaga ishchi ID sini kiriting.");
      return;
    }
    const totals = new Map<string, number>();
    const identities = new Set<string>();
    for (const entry of updatedEntries) {
      const identity = `${entry.opName}\u0000${entry.workerId}`;
      if (identities.has(identity)) { setErrorMsg('Bir operatsiyada bir ishchini ikki marta qo‘shib bo‘lmaydi.'); return; }
      identities.add(identity);
      const total = (totals.get(entry.opName) || 0) + entry.qty;
      if (total > ticketQty) { setErrorMsg(`«${entry.opName}» jami ${total}; chiqarilgan miqdor ${ticketQty} dan oshmasligi kerak.`); return; }
      totals.set(entry.opName, total);
    }

    setIsSaving(true);
    try {
      const success = await updateSubmittedTicket(ticket.id, updatedEntries);
      if (success) {
        closeTicketModal();
      }
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      className="modal-overlay phase-c-dialog ticket-edit-dialog"
      onClick={closeTicketModal}
    >
      <div
        className="modal-card ticket-edit-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ticket-edit-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="ticket-edit-header">
          <div className="ticket-edit-heading">
            <div className="ticket-edit-title-row">
              <h2 id="ticket-edit-title" style={{ fontSize: '20px', fontWeight: 800, margin: 0, color: 'var(--text-primary)' }}>
                Patta #{ticket.pattaNumber} ni tahrirlash
              </h2>
              <span style={{
                background: '#f59e0b',
                color: '#ffffff',
                padding: '2px 8px',
                borderRadius: 'var(--radius-full)',
                fontSize: '14.5px',
                fontWeight: 700
              }}>
                Partiya {ticket.partyNumber}
              </span>
            </div>
            <div style={{ fontSize: '15px', color: 'var(--text-muted)', marginTop: '4px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span>Model: <strong style={{ color: 'var(--text-primary)' }}>{model.name}</strong></span>
              <span>•</span>
              <span>Konveyer: <strong style={{ color: '#818cf8' }}>{ticket.konveyer ? `${ticket.konveyer}-Konveyer` : 'Noma\'lum'}</strong></span>
              <span>•</span>
              <span>Razmer: <strong>{ticket.size || '—'}</strong></span>
              <span>•</span>
              <span>Rang: <strong>{ticket.color || '—'}</strong></span>
              <span>•</span>
              <span>Ish soni: <strong style={{ color: 'var(--primary)' }}>{ticketQty.toLocaleString()} dona</strong></span>
            </div>
          </div>

          <button
            type="button"
            aria-label="Tahrirlash oynasini yopish"
            onClick={closeTicketModal}
            className="soft-btn"
            style={{
              padding: '6px',
              borderRadius: 'var(--radius-md)',
              border: 'none',
              background: 'transparent',
              color: 'var(--text-muted)',
              cursor: 'pointer'
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Error notification if any */}
        {errorMsg && (
          <div role="alert" style={{
            margin: '12px 20px 0 20px',
            padding: '10px 14px',
            background: 'rgba(239, 68, 68, 0.12)',
            border: '1px solid rgba(239, 68, 68, 0.35)',
            borderRadius: 'var(--radius-md)',
            color: '#ef4444',
            fontSize: '15px',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          }}>
            <AlertCircle size={16} />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Allocation editor with a separate scroll area on narrow screens. */}
        <div className="ticket-edit-body">
          <div style={{ fontSize: '15px', color: 'var(--text-muted)', marginBottom: '10px' }}>
            ℹ️ Xato kiritilgan operatsiyalarda kerakli <strong>Ishchi ID raqamini</strong> o'zgartiring. Saqlanganda ish sonlari va summalar butun tizim bo'ylab avtomatik yangilanadi.
          </div>

          <div className="ticket-edit-table-scroll" role="region" aria-label="Ishchi taqsimotlari" tabIndex={0}>
          <table className="ticket-edit-table">
            <colgroup>
              <col style={{ width: 48 }} /><col style={{ width: 240 }} /><col style={{ width: 120 }} />
              <col style={{ width: 100 }} /><col /><col style={{ width: 104 }} />
              <col style={{ width: 140 }} /><col style={{ width: 56 }} />
            </colgroup>
            <thead>
              <tr style={{ background: 'var(--bg-surface-subtle)', borderBottom: '2px solid var(--border-subtle)', height: '34px' }}>
                <th style={{ width: '45px', textAlign: 'center', color: 'var(--text-secondary)' }}>№</th>
                <th style={{ textAlign: 'left', paddingLeft: '12px', color: 'var(--text-secondary)' }}>Operatsiya nomi</th>
                <th style={{ width: '90px', textAlign: 'right', paddingRight: '12px', color: 'var(--text-secondary)' }}>Narxi</th>
                <th style={{ width: '110px', textAlign: 'center', color: 'var(--text-secondary)' }}>Ishchi ID</th>
                <th style={{ textAlign: 'left', paddingLeft: '12px', color: 'var(--text-secondary)' }}>Ishchi F.I.O</th>
                <th style={{ width: '90px', textAlign: 'center', color: 'var(--text-secondary)' }}>Dona</th>
                <th style={{ width: '115px', textAlign: 'right', paddingRight: '12px', color: 'var(--text-secondary)' }}>Summa</th>
                <th><span className="ticket-edit-sr-only">Amallar</span></th>
              </tr>
            </thead>
            <tbody>
              {allocations.map((row, idx) => {
                const op = operationsList.find((item) => item.name === row.opName);
                const valStr = row.workerId || '';
                const wId = valStr ? parseInt(valStr, 10) : null;
                const hasId = valStr !== '';
                const isFound = wId ? workerMap.has(wId) : false;
                const workerName = isFound && wId ? workerMap.get(wId) : '';
                const opAmount = isFound && op?.rate != null ? op.rate * (Number(row.qty) || 0) : null;

                return (
                  <tr
                    key={row.key}
                    style={{
                      height: '38px',
                      borderBottom: '1px solid var(--border-subtle)',
                      backgroundColor: isFound ? 'rgba(59, 130, 246, 0.03)' : 'transparent'
                    }}
                  >
                    {/* № */}
                    <td style={{ textAlign: 'center', fontWeight: 700, color: 'var(--text-muted)', fontSize: '14px' }}>
                      {idx + 1}
                    </td>

                    {/* Operatsiya nomi */}
                    <td style={{ paddingLeft: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
                      <select className="soft-input" aria-label={`${idx + 1}-taqsimot operatsiyasi`} value={row.opName} onChange={(e) => updateAllocation(row.key, 'opName', e.target.value)}>
                        {model.operations.map((operation) => <option key={operation.id} value={operation.name}>{operation.name}</option>)}
                      </select>
                    </td>

                    {/* Dona narxi */}
                    <td style={{ textAlign: 'right', paddingRight: '12px', color: 'var(--text-muted)', fontWeight: 600, fontSize: '15px' }}>
                      {op?.rate == null ? 'Noma’lum' : `${op.rate.toLocaleString()} so'm`}
                    </td>

                    {/* Worker ID input */}
                    <td style={{ padding: '4px 8px', textAlign: 'center' }}>
                      <input
                        type="number"
                        placeholder="ID"
                        aria-label={`${idx + 1}-taqsimot ishchi ID`}
                        value={valStr}
                        onChange={(e) => updateAllocation(row.key, 'workerId', e.target.value)}
                        className="soft-input"
                        style={{
                          width: '100%',
                          textAlign: 'center',
                          fontWeight: 700,
                          fontSize: '15px',
                          borderColor: hasId ? (isFound ? 'var(--primary)' : '#ef4444') : 'var(--border-subtle)',
                          backgroundColor: hasId ? (isFound ? 'var(--primary-light)' : 'rgba(239, 68, 68, 0.12)') : 'var(--bg-surface)'
                        }}
                      />
                    </td>

                    {/* Worker Name Display */}
                    <td style={{ paddingLeft: '12px', fontWeight: 600 }}>
                      {hasId ? (
                        isFound ? (
                          <span style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '5px',
                            background: 'var(--primary-light)',
                            color: 'var(--primary)',
                            padding: '2px 8px',
                            borderRadius: 'var(--radius-full)',
                            fontSize: '15px'
                          }}>
                            <span style={{ fontWeight: 800 }}>#{wId}</span>
                            <span>{workerName}</span>
                          </span>
                        ) : (
                          <span style={{ color: '#ef4444', fontStyle: 'italic', fontSize: '14.5px' }}>
                            Ishchi topilmadi! ({valStr})
                          </span>
                        )
                      ) : (
                        <span style={{ color: 'var(--text-muted)', fontSize: '14.5px' }}>—</span>
                      )}
                    </td>

                      {/* Allocation quantity and amount must occupy separate columns. */}
                    <td className="ticket-edit-qty">
                      <input type="number" min="1" max={ticketQty} value={row.qty} onChange={(e) => updateAllocation(row.key, 'qty', e.target.value)} className="soft-input" aria-label={`${row.opName} allocation quantity`} />
                    </td>
                    <td style={{ textAlign: 'right', paddingRight: '12px', fontWeight: 700, color: opAmount !== null && opAmount > 0 ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                      {opAmount === null ? '—' : formatMoney(opAmount)}
                    </td>
                    <td><button type="button" className="ticket-edit-remove" aria-label="Taqsimotni olib tashlash" onClick={() => setAllocations((prev) => prev.filter((item) => item.key !== row.key))}><Trash2 size={16} /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          <div style={{ marginTop: 10 }}><button type="button" className="soft-btn" onClick={() => setAllocations((prev) => [...prev, { key: `new-${Date.now()}-${Math.random()}`, opName: model.operations[0]?.name || '', workerId: '', qty: '' }])}><Plus size={14} /> Ishchi taqsimoti qo‘shish</button></div>
          <div aria-live="polite" className="ticket-edit-progress">
            {allocationProgress.map((progress) => <div key={progress.name} className="ticket-edit-progress-row">
              <span>{progress.name}: {progress.total}/{ticketQty} · qoldi {progress.remaining}</span>
              <strong style={{ color: progress.complete ? '#15803d' : '#b45309' }}>{progress.complete ? 'Tugallangan' : 'Tugallanmagan'}</strong>
            </div>)}
          </div>
        </div>

        {/* Footer */}
        <div className="ticket-edit-footer">
          <div>
            <div style={{ fontSize: '14.5px', color: 'var(--text-muted)' }}>
              Tanlangan operatsiyalar: <strong>{assignedOpsCount} ta</strong>
            </div>
            <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--primary)' }}>
              Jami summa: {formatMoney(liveTotalAmount)} so'm{unknownRateCount > 0 ? ` (${unknownRateCount} narx noma’lum)` : ''}
            </div>
          </div>

          <div className="ticket-edit-footer-actions">
            <button
              onClick={closeTicketModal}
              disabled={isSaving}
              className="soft-btn"
              style={{
                padding: '7px 16px',
                borderRadius: 'var(--radius-md)',
                fontSize: '15px',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Bekor qilish
            </button>

            <button
              onClick={handleSave}
              disabled={isSaving}
              className="soft-btn"
              style={{
                padding: '7px 20px',
                borderRadius: 'var(--radius-md)',
                fontSize: '15px',
                fontWeight: 700,
                backgroundColor: 'var(--primary)',
                color: '#ffffff',
                border: 'none',
                cursor: isSaving ? 'wait' : 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                boxShadow: 'var(--shadow-sm)'
              }}
            >
              <Check size={16} />
              <span>{isSaving ? 'Saqlanmoqda...' : 'Saqlash va hisoblarni yangilash'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
