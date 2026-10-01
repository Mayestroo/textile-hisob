import React, { useState, useMemo, useEffect } from 'react';
import { useWorkbookStore } from '../../../store/workbookStore';
import { X, Check, AlertCircle } from 'lucide-react';
import { formatMoney } from '../../../engine/formulaEngine';
import { SubmittedTicketRecord } from '../../../types/workbook';

export const EditSubmittedTicketModal: React.FC = () => {
  const modalType = useWorkbookStore((s) => s.modalState.type);
  const modalData = useWorkbookStore((s) => s.modalState.data) as SubmittedTicketRecord | undefined;
  const closeModal = useWorkbookStore((s) => s.closeModal);
  const submittedTickets = useWorkbookStore((s) => s.submittedTickets);
  const models = useWorkbookStore((s) => s.models);
  const workers = useWorkbookStore((s) => s.workers);
  const updateSubmittedTicket = useWorkbookStore((s) => s.updateSubmittedTicket);

  const isOpen = modalType === 'edit_ticket';

  // Find the ticket from state to ensure fresh data
  const ticket = useMemo(() => {
    if (!isOpen || !modalData) return null;
    return submittedTickets.find((s) => s.id === modalData.id) || modalData;
  }, [isOpen, modalData, submittedTickets]);

  const model = useMemo(() => {
    if (!ticket) return null;
    return models.find((m) => m.id === ticket.modelId || m.name === ticket.modelId) || null;
  }, [ticket, models]);

  // Worker lookup map
  const workerMap = useMemo(() => {
    const map = new Map<number, string>();
    for (const w of workers) {
      map.set(w.id, w.name);
    }
    return map;
  }, [workers]);

  // Operations order and rate map
  const operationsList = useMemo(() => {
    if (!model) return [];
    const opRateMap = new Map<string, number>();
    for (const op of model.operations) {
      opRateMap.set(op.name, op.rate);
    }

    const order = model.pattaOpsOrder && model.pattaOpsOrder.length > 0
      ? model.pattaOpsOrder
      : model.operations.map((o) => o.name);

    return order.map((opName) => {
      const op = model.operations.find((o) => o.name === opName);
      return {
        name: opName,
        rate: op?.rate !== undefined ? op.rate : (opRateMap.get(opName) || 0)
      };
    });
  }, [model]);

  // Form state: opName -> workerId string (e.g. "4")
  const [entriesMap, setEntriesMap] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Initialize form when ticket changes
  useEffect(() => {
    if (isOpen && ticket) {
      const initial: Record<string, string> = {};
      for (const e of ticket.entries || []) {
        if (e.opName && e.workerId) {
          initial[e.opName] = String(e.workerId);
        }
      }
      setEntriesMap(initial);
      setErrorMsg(null);
      setIsSaving(false);
    }
  }, [isOpen, ticket]);

  // Keyboard shortcut: Escape to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isOpen && e.key === 'Escape') {
        closeModal();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, closeModal]);

  if (!isOpen || !ticket || !model) return null;

  const ticketQty = ticket.qty || 0;

  // Calculate live total sum for assigned operations
  let liveTotalAmount = 0;
  let assignedOpsCount = 0;

  for (const op of operationsList) {
    const val = entriesMap[op.name];
    const wId = val ? parseInt(val, 10) : null;
    if (wId && workerMap.has(wId)) {
      liveTotalAmount += op.rate * ticketQty;
      assignedOpsCount++;
    }
  }

  const handleWorkerChange = (opName: string, val: string) => {
    setEntriesMap((prev) => ({
      ...prev,
      [opName]: val.trim()
    }));
    if (errorMsg) setErrorMsg(null);
  };

  const handleSave = async () => {
    setErrorMsg(null);

    // Validate: Check if all non-empty IDs are valid workers
    const updatedEntries: Array<{ opName: string; workerId: number; rateSnapshot?: number }> = [];

    for (const op of operationsList) {
      const valStr = entriesMap[op.name];
      if (valStr !== undefined && valStr !== '') {
        const wId = Number(valStr);
        if (!Number.isSafeInteger(wId) || wId <= 0) {
          setErrorMsg(`«${op.name}» uchun ishchi ID raqami noto'g'ri kiritilgan: "${valStr}"`);
          return;
        }
        if (!workerMap.has(wId)) {
          setErrorMsg(`«${op.name}» uchun #${wId} ID ga ega ishchi ro'yxatda topilmadi!`);
          return;
        }
        updatedEntries.push({
          opName: op.name,
          workerId: wId,
          rateSnapshot: op.rate
        });
      }
    }

    if (updatedEntries.length === 0) {
      setErrorMsg("Hech bo'lmaganda bitta operatsiyaga ishchi ID sini kiriting.");
      return;
    }

    setIsSaving(true);
    try {
      const success = await updateSubmittedTicket(ticket.id, updatedEntries);
      if (success) {
        closeModal();
      }
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div 
      className="modal-overlay" 
      onClick={closeModal}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        backdropFilter: 'blur(4px)',
        padding: '20px'
      }}
    >
      <div 
        className="modal-card" 
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: '780px',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: 'var(--bg-surface)',
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-xl)',
          border: '1px solid var(--border-subtle)',
          overflow: 'hidden'
        }}
      >
        {/* Header */}
        <div style={{
          padding: '16px 22px',
          borderBottom: '1px solid var(--border-subtle)',
          background: 'var(--bg-surface-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between'
        }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <h2 style={{ fontSize: '17px', fontWeight: 800, margin: 0, color: 'var(--text-primary)' }}>
                Patta #{ticket.pattaNumber} ni tahrirlash
              </h2>
              <span style={{
                background: '#f59e0b',
                color: '#ffffff',
                padding: '2px 8px',
                borderRadius: 'var(--radius-full)',
                fontSize: '11.5px',
                fontWeight: 700
              }}>
                Partiya {ticket.partyNumber}
              </span>
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
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
            onClick={closeModal}
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
          <div style={{
            margin: '12px 20px 0 20px',
            padding: '10px 14px',
            background: 'rgba(239, 68, 68, 0.12)',
            border: '1px solid rgba(239, 68, 68, 0.35)',
            borderRadius: 'var(--radius-md)',
            color: '#ef4444',
            fontSize: '12.5px',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          }}>
            <AlertCircle size={16} />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* 1 Column Operations Table */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px' }}>
            ℹ️ Xato kiritilgan operatsiyalarda kerakli <strong>Ishchi ID raqamini</strong> o'zgartiring. Saqlanganda ish sonlari va summalar butun tizim bo'ylab avtomatik yangilanadi.
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
            <thead>
              <tr style={{ background: 'var(--bg-surface-subtle)', borderBottom: '2px solid var(--border-subtle)', height: '34px' }}>
                <th style={{ width: '45px', textAlign: 'center', color: 'var(--text-secondary)' }}>№</th>
                <th style={{ textAlign: 'left', paddingLeft: '12px', color: 'var(--text-secondary)' }}>Operatsiya nomi</th>
                <th style={{ width: '90px', textAlign: 'right', paddingRight: '12px', color: 'var(--text-secondary)' }}>Narxi</th>
                <th style={{ width: '110px', textAlign: 'center', color: 'var(--text-secondary)' }}>Ishchi ID</th>
                <th style={{ textAlign: 'left', paddingLeft: '12px', color: 'var(--text-secondary)' }}>Ishchi F.I.O</th>
                <th style={{ width: '115px', textAlign: 'right', paddingRight: '12px', color: 'var(--text-secondary)' }}>Summa</th>
              </tr>
            </thead>
            <tbody>
              {operationsList.map((op, idx) => {
                const valStr = entriesMap[op.name] || '';
                const wId = valStr ? parseInt(valStr, 10) : null;
                const hasId = valStr !== '';
                const isFound = wId ? workerMap.has(wId) : false;
                const workerName = isFound && wId ? workerMap.get(wId) : '';
                const opAmount = isFound ? op.rate * ticketQty : 0;

                return (
                  <tr 
                    key={op.name}
                    style={{
                      height: '38px',
                      borderBottom: '1px solid var(--border-subtle)',
                      backgroundColor: isFound ? 'rgba(59, 130, 246, 0.03)' : 'transparent'
                    }}
                  >
                    {/* № */}
                    <td style={{ textAlign: 'center', fontWeight: 700, color: 'var(--text-muted)', fontSize: '11px' }}>
                      {idx + 1}
                    </td>

                    {/* Operatsiya nomi */}
                    <td style={{ paddingLeft: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
                      {op.name}
                    </td>

                    {/* Dona narxi */}
                    <td style={{ textAlign: 'right', paddingRight: '12px', color: 'var(--text-muted)', fontWeight: 600, fontSize: '12px' }}>
                      {op.rate.toLocaleString()} so'm
                    </td>

                    {/* Worker ID input */}
                    <td style={{ padding: '4px 8px', textAlign: 'center' }}>
                      <input
                        type="number"
                        placeholder="ID"
                        value={valStr}
                        onChange={(e) => handleWorkerChange(op.name, e.target.value)}
                        className="soft-input"
                        style={{
                          width: '100%',
                          height: '28px',
                          textAlign: 'center',
                          fontWeight: 700,
                          fontSize: '13px',
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
                            fontSize: '12px'
                          }}>
                            <span style={{ fontWeight: 800 }}>#{wId}</span>
                            <span>{workerName}</span>
                          </span>
                        ) : (
                          <span style={{ color: '#ef4444', fontStyle: 'italic', fontSize: '11.5px' }}>
                            Ishchi topilmadi! ({valStr})
                          </span>
                        )
                      ) : (
                        <span style={{ color: 'var(--text-muted)', fontSize: '11.5px' }}>—</span>
                      )}
                    </td>

                    {/* Subtotal */}
                    <td style={{ textAlign: 'right', paddingRight: '12px', fontWeight: 700, color: opAmount > 0 ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                      {opAmount > 0 ? formatMoney(opAmount) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div style={{
          padding: '14px 22px',
          borderTop: '1px solid var(--border-subtle)',
          background: 'var(--bg-surface-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '12px'
        }}>
          <div>
            <div style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
              Tanlangan operatsiyalar: <strong>{assignedOpsCount} ta</strong>
            </div>
            <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--primary)' }}>
              Jami summa: {formatMoney(liveTotalAmount)} so'm
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button
              onClick={closeModal}
              disabled={isSaving}
              className="soft-btn"
              style={{
                padding: '7px 16px',
                borderRadius: 'var(--radius-md)',
                fontSize: '13px',
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
                fontSize: '13px',
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
