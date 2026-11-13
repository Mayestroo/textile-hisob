import React, { useRef, useEffect, useState, useMemo } from 'react';
import { useWorkbookStore, DEFAULT_BATCH_SIZES } from '../../store/workbookStore';
import { ModelConfig } from '../../types/workbook';
import { getTicketPartyStatus } from '../../domain/ticketValidation';
import { Send, Plus, Trash2, Check, X, Layers, GripVertical } from 'lucide-react';
import { formatDateIso } from '../../utils/formatters';

interface PattaViewProps {
  model: ModelConfig;
}

export const PattaView: React.FC<PattaViewProps> = ({ model }) => {
  const workers = useWorkbookStore((s) => s.workers);
  const currentPeriod = useWorkbookStore((s) => s.currentPeriod);
  const hasActivePeriod = Boolean(currentPeriod && !currentPeriod.isClosed && currentPeriod.id !== 'period_default');

  const form = useWorkbookStore((s) => s.ticketForms[model.id]) || {
    date: formatDateIso(),
    party: model.party || '',
    color: model.color || '',
    size: model.size || '',
    qty: '',
    patta: '',
    entries: {}
  };
  const strictParty = form.strictParty ?? true;
  const strictPatta = form.strictPatta ?? true;
  const printedPartyHistory = useWorkbookStore((s) => s.printedPartyHistory);
  const submittedTickets = useWorkbookStore((s) => s.submittedTickets);
  const availableSizes = useWorkbookStore((s) => s.availableSizes);
  const updateTicketField = useWorkbookStore((s) => s.updateTicketField);
  const clearTicketForm = useWorkbookStore((s) => s.clearTicketForm);
  const jonatish = useWorkbookStore((s) => s.jonatish);
  const addNotification = useWorkbookStore((s) => s.addNotification);
  const setActiveCell = useWorkbookStore((s) => s.setActiveCell);
  const syncNewOperation = useWorkbookStore((s) => s.syncNewOperation);
  const syncDeleteOperation = useWorkbookStore((s) => s.syncDeleteOperation);
  const reorderOperations = useWorkbookStore((s) => s.reorderOperations);
  const openModal = useWorkbookStore((s) => s.openModal);
  const selectedPattaTicket = useMemo(() => (submittedTickets || []).find((ticket) =>
    ticket.modelId === model.id && String(ticket.partyNumber) === String(form.party).trim()
    && Number(ticket.pattaNumber) === Number(form.patta)
    && !['VOIDED', 'PENDING_DELETE'].includes(ticket.status || '')
  ), [submittedTickets, model.id, form.party, form.patta]);

  const currentPartyStr = String(form.party || '1');
  const { isNonExistentParty, isWrongModelParty, hasBlockingError, errorBannerText } =
    getTicketPartyStatus(form, model, printedPartyHistory, submittedTickets, { strictParty, strictPatta });

  // Active operation row tracking for focus outline

  // Helper to parse printedAt into YYYY-MM-DD for date input
  const parseToIsoDate = (val: string | undefined): string | null => {
    if (!val) return null;
    const trimmed = val.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
    if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) return trimmed.slice(0, 10);
    const dmy = trimmed.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
    if (dmy) {
      return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
    }
    const d = new Date(trimmed);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return null;
  };

  // 1. Initial resolution: default to active or latest printed party and next unsubmitted patta
  useEffect(() => {
    const history = printedPartyHistory || [];
    if (!form.party) {
      const activeParty = history.find((h) => h.modelId === model.id && !h.isClosed)
        || history.filter((h) => h.modelId === model.id).slice(-1)[0];
      if (activeParty) {
        updateTicketField(model.id, 'party', String(activeParty.partyNumber));
        const submittedForParty = (submittedTickets || []).filter(
          (t) => t.modelId === model.id && String(t.partyNumber) === String(activeParty.partyNumber)
        );
        const nextPatta = (activeParty.pattaStartNumber || 1) + submittedForParty.length;
        const maxPatta = activeParty.pattaEndNumber || ((activeParty.pattaStartNumber || 1) + activeParty.pattaCount - 1);
        if (!form.patta && nextPatta <= maxPatta) {
          updateTicketField(model.id, 'patta', String(nextPatta));
        }
      }
    }
  }, [model.id, form.party, form.patta, printedPartyHistory, submittedTickets, updateTicketField]);

  // 2. Comprehensive Auto-fill: Sana, Rang, Razmer, and Ish soni from printed party history
  useEffect(() => {
    const history = printedPartyHistory || [];
    let matchedParty = history.find(
      (h) => h.modelId === model.id && String(h.partyNumber).trim() === String(form.party || '').trim()
    );

    const pNum = parseInt(form.patta || '', 10);

    // If no party match, but patta number is given, search by patta range
    if (!matchedParty && !isNaN(pNum) && pNum > 0) {
      matchedParty = history.find((h) => {
        if (h.modelId !== model.id) return false;
        const start = h.pattaStartNumber ?? 1;
        const end = h.pattaEndNumber ?? (start + h.pattaCount - 1);
        return pNum >= start && pNum <= end;
      });
      if (matchedParty && (!form.party || form.party !== String(matchedParty.partyNumber))) {
        updateTicketField(model.id, 'party', String(matchedParty.partyNumber));
      }
    }

    if (!matchedParty) return;

    // Auto-fill Sana (Date)
    if (matchedParty.printedAt) {
      const isoDate = parseToIsoDate(matchedParty.printedAt);
      if (isoDate && form.date !== isoDate) {
        updateTicketField(model.id, 'date', isoDate);
      }
    }

    // Auto-fill Rang (Color)
    if (matchedParty.color && form.color !== matchedParty.color) {
      updateTicketField(model.id, 'color', matchedParty.color);
    }

    // Auto-fill Ish soni (Quantity)
    const perPatta = matchedParty.ishSoniPerPatta
      || (matchedParty.pattaCount > 0 ? Math.round(matchedParty.ishSoni / matchedParty.pattaCount) : matchedParty.ishSoni);
    if (perPatta > 0 && (!form.qty || form.qty === '0')) {
      updateTicketField(model.id, 'qty', String(perPatta));
    }

    // Auto-fill Razmer (Size) based on patta position within size distributions
    if (!isNaN(pNum) && pNum > 0 && matchedParty.sizes) {
      const startPatta = matchedParty.pattaStartNumber
        ?? (matchedParty.cumulativePattaCount > matchedParty.pattaCount
          ? matchedParty.cumulativePattaCount - matchedParty.pattaCount + 1
          : 1);
      const relPattaNum = pNum >= startPatta ? (pNum - startPatta + 1) : pNum;

      let counter = 1;
      let targetSize = '';
      const historicalOrder = Array.from(new Set([
        ...(Array.isArray(matchedParty.sizeOrder) ? matchedParty.sizeOrder : (availableSizes || DEFAULT_BATCH_SIZES)),
        ...Object.keys(matchedParty.sizes || {})
      ]));
      for (const sz of historicalOrder) {
        const count = parseInt(matchedParty.sizes[sz] || '0', 10) || 0;
        if (relPattaNum >= counter && relPattaNum < counter + count) {
          targetSize = sz;
          break;
        }
        counter += count;
      }
      if (targetSize && form.size !== targetSize) {
        updateTicketField(model.id, 'size', targetSize);
      }
    }
  }, [
    model.id,
    form.party,
    form.patta,
    form.date,
    form.color,
    form.size,
    form.qty,
    printedPartyHistory,
    availableSizes,
    updateTicketField
  ]);

  // Inline new operation state
  const [isAddingInline, setIsAddingInline] = useState(false);
  const [newOpName, setNewOpName] = useState('');
  const [newOpRate, setNewOpRate] = useState('');

  const newOpInputRef = useRef<HTMLInputElement>(null);
  const newRateInputRef = useRef<HTMLInputElement>(null);

  // Drag and drop state for operations reordering
  const [draggedOpIdx, setDraggedOpIdx] = useState<number | null>(null);
  const [dragOverOpIdx, setDragOverOpIdx] = useState<number | null>(null);

  const handleOpDragStart = (e: React.DragEvent<HTMLTableRowElement>, idx: number) => {
    if (hasBlockingError) {
      e.preventDefault();
      return;
    }
    const target = e.target as HTMLElement;
    if (
      target.tagName === 'INPUT' ||
      target.tagName === 'BUTTON' ||
      target.closest('input') ||
      target.closest('button')
    ) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(idx));
    setDraggedOpIdx(idx);
  };

  const handleOpDragOver = (e: React.DragEvent<HTMLTableRowElement>, idx: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverOpIdx !== idx) {
      setDragOverOpIdx(idx);
    }
  };

  const handleOpDrop = (e: React.DragEvent<HTMLTableRowElement>, targetIdx: number) => {
    e.preventDefault();
    if (draggedOpIdx !== null && draggedOpIdx !== targetIdx) {
      const newOrder = [...model.pattaOpsOrder];
      const [movedItem] = newOrder.splice(draggedOpIdx, 1);
      newOrder.splice(targetIdx, 0, movedItem);
      reorderOperations(model.id, newOrder);
    }
    setDraggedOpIdx(null);
    setDragOverOpIdx(null);
  };

  const handleOpDragEnd = () => {
    setDraggedOpIdx(null);
    setDragOverOpIdx(null);
  };

  // Build worker lookup map
  const workerMap = useMemo(() => {
    const map = new Map<number, string>();
    for (const w of workers) {
      map.set(w.id, w.name);
    }
    return map;
  }, [workers]);

  // Field input refs
  const konveyerInputRef = useRef<HTMLInputElement>(null);
  const partyInputRef = useRef<HTMLInputElement>(null);
  const pattaInputRef = useRef<HTMLInputElement>(null);
  const qtyInputRef = useRef<HTMLInputElement>(null);
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    if (konveyerInputRef.current) {
      konveyerInputRef.current.focus();
    } else if (partyInputRef.current) {
      partyInputRef.current.focus();
    }
  }, [model.id]);

  useEffect(() => {
    if (isAddingInline && newOpInputRef.current) {
      newOpInputRef.current.focus();
    }
  }, [isAddingInline]);

  const getOpAllocations = (opName: string): Array<{ workerId: string; qty: string }> => {
    const entry = form.entries?.[opName];
    if (Array.isArray(entry)) return entry.map((allocation) => ({ workerId: String(allocation.workerId ?? ''), qty: String(allocation.qty ?? '') }));
    return entry !== undefined && entry !== null && entry !== '' ? [{ workerId: String(entry), qty: String(form.qty || '') }] : [{ workerId: '', qty: '' }];
  };
  const safeFocus = (el: HTMLInputElement | null) => {
    if (!el) return;
    el.focus();
    try {
      if (el.type !== 'number') {
        el.select();
      }
    } catch {}
  };

  const submitTicketAndFocusKonveyer = () => {
    void jonatish(model.id).then((submitted) => {
      if (submitted) {
        requestAnimationFrame(() => safeFocus(konveyerInputRef.current));
      }
    });
  };

  const handleKonveyerKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      safeFocus(partyInputRef.current);
    }
  };

  const handlePartyKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (strictParty && (isNonExistentParty || isWrongModelParty)) {
        addNotification('warning', 'Partiya xatosi', errorBannerText);
      }
      safeFocus(pattaInputRef.current);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      safeFocus(konveyerInputRef.current);
    }
  };

  const handlePattaKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      if ((strictParty || strictPatta) && hasBlockingError) {
        addNotification('warning', 'Patta xatosi', errorBannerText);
      }
      if (qtyInputRef.current) {
        safeFocus(qtyInputRef.current);
      } else {
        const firstOp = model.pattaOpsOrder[0];
        if (firstOp && inputRefs.current[firstOp]) {
          safeFocus(inputRefs.current[firstOp]);
        }
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      safeFocus(partyInputRef.current);
    }
  };

  const handleQtyKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      if ((strictParty || strictPatta) && hasBlockingError) {
        addNotification('warning', 'Bloklangan', errorBannerText);
      }
      const firstOp = model.pattaOpsOrder[0];
      if (firstOp && inputRefs.current[firstOp]) {
        safeFocus(inputRefs.current[firstOp]);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      safeFocus(pattaInputRef.current);
    }
  };

  const handleCellFocus = (cellId: string, value: string, formula?: string) => {
    setActiveCell({
      cellId,
      sheetName: model.name,
      value,
      formula
    });
  };

  const handleSaveInlineOperation = () => {
    const cleanName = newOpName.trim();
    if (!cleanName) {
      setIsAddingInline(false);
      return;
    }
    const rateNum = Number(newOpRate);
    syncNewOperation(model.id, cleanName, isNaN(rateNum) ? 0 : rateNum);
    setNewOpName('');
    setNewOpRate('');
    setIsAddingInline(false);
  };

  const handleInlineKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.currentTarget === newOpInputRef.current) {
        newRateInputRef.current?.focus();
      } else {
        handleSaveInlineOperation();
      }
    } else if (e.key === 'Escape') {
      setIsAddingInline(false);
      setNewOpName('');
      setNewOpRate('');
    }
  };

  const handleDeleteOp = (opName: string, e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    syncDeleteOperation(model.id, opName);
  };

  const handleCancel = () => {
    clearTicketForm(model.id);
    addNotification('info', 'Tozalandi', "Kiritilgan ishchilar ro'yxati tozalandi.");
    const firstOp = model.pattaOpsOrder[0];
    if (firstOp && inputRefs.current[firstOp]) {
      safeFocus(inputRefs.current[firstOp]);
    }
  };

  const handleSubmit = () => {
    if ((strictParty || strictPatta) && hasBlockingError) {
      addNotification(
        'error',
        'Chop etilmagan partiya',
        errorBannerText || `Partiya ${currentPartyStr} hali chop etilmagan! Avval «Patta» varag'ida chop eting.`
      );
      return;
    }
    submitTicketAndFocusKonveyer();
  };

  // Calculations for operations and rates
  const totalRates = useMemo(() => {
    return model.pattaOpsOrder.reduce((sum, opName) => {
      const op = model.operations.find((o) => o.name === opName);
      return sum + (op ? Number(op.rate || 0) : 0);
    }, 0);
  }, [model.pattaOpsOrder, model.operations]);

  const filledOpsCount = useMemo(() => {
    return model.pattaOpsOrder.filter((opName) => {
      const val = form.entries?.[opName];
      const allocations = Array.isArray(val) ? val : val ? [{ workerId: val, qty: form.qty }] : [];
      return allocations.some((entry) => workerMap.has(Number(entry.workerId)) && Number(entry.qty) > 0);
    }).length;
  }, [model.pattaOpsOrder, form.entries, form.qty, workerMap]);

  const progressPct = useMemo(() => {
    const total = model.pattaOpsOrder.length;
    if (total === 0) return 0;
    return Math.min(100, Math.round((filledOpsCount / total) * 100));
  }, [model.pattaOpsOrder.length, filledOpsCount]);

  return (
    <div className="phase-b-patta-entry">
      <div className="patta-entry-card">
        {/* Pixel-Perfect Top Header */}
        <div className="patta-entry-header">
          <div className="patta-header-top">
            <div className="patta-header-icon">
              <Layers size={22} strokeWidth={2.4} />
            </div>
            <div>
              <div className="patta-header-title-row">
                <h1 className="patta-header-title">Patta kiritish</h1>
                <span className="patta-model-badge">{model.name}</span>
              </div>
              <div className="patta-header-subtitle">
                <span>Ishchi raqamini kiriting va</span>
                <kbd className="patta-kbd">Enter</kbd>
                <span>bosing, kursor keyingi qatorga o'tadi</span>
              </div>
            </div>
          </div>
          {/* Dynamic Progress Bar underneath header */}
          <div
            className="patta-header-progress-track"
            title={`Jarayon: ${filledOpsCount} / ${model.pattaOpsOrder.length} (${progressPct}%)`}
          >
            <div
              className="patta-header-progress-fill"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>

        {/* Section 1: Patta ma'lumotlari */}
        <div className="patta-info-section">
          <h2 className="patta-section-title">Patta ma'lumotlari</h2>
          <div className="patta-info-box">
            {/* ROW 1: Konveyer & Sana */}
            <div className="patta-info-row">
              <div className="patta-col-left">
                <div className="patta-label-wrapper">
                  <span className="patta-label-title">Konveyer</span>
                </div>
                <input
                  ref={konveyerInputRef}
                  data-patta-konveyer-input="true"
                  type="text"
                  value={form.konveyer || ''}
                  onChange={(e) => updateTicketField(model.id, 'konveyer', e.target.value)}
                  onKeyDown={handleKonveyerKeyDown}
                  onFocus={() => handleCellFocus('C2', form.konveyer || '')}
                  className="patta-input patta-input-short"
                  placeholder="Tanlang"
                />
              </div>

              <div className="patta-col-right">
                <label className="patta-right-label">Sana</label>
                <input
                  type="date"
                  value={form.date}
                  min={hasActivePeriod ? currentPeriod?.startDate : undefined}
                  max={hasActivePeriod ? currentPeriod?.endDate : undefined}
                  onChange={(e) => updateTicketField(model.id, 'date', e.target.value)}
                  onFocus={() => handleCellFocus('D2', form.date)}
                  className="patta-input patta-input-wide"
                />
              </div>
            </div>

            {/* ROW 2: Partiya & Rang */}
            <div className="patta-info-row">
              <div className="patta-col-left">
                <div className="patta-label-wrapper">
                  <span className="patta-label-title">Partiya</span>
                  <span className="patta-label-required">*</span>
                  <span className="patta-label-majburiy">Majburiy</span>
                </div>
                <label
                  className="patta-checkbox-label"
                  onClick={() => updateTicketField(model.id, 'strictParty', !strictParty)}
                >
                  <span className={`patta-custom-checkbox ${strictParty ? 'is-checked' : 'is-unchecked'}`}>
                    {strictParty && <Check size={11} strokeWidth={3.5} />}
                  </span>
                  <span>Qat'iy</span>
                </label>
                <input
                  ref={partyInputRef}
                  type="text"
                  value={form.party && (form.party.includes('6632') || form.party.includes('Мато Партия')) ? '' : form.party}
                  onChange={(e) => updateTicketField(model.id, 'party', e.target.value)}
                  onKeyDown={handlePartyKeyDown}
                  onFocus={() => handleCellFocus('C3', form.party)}
                  className="patta-input patta-input-short"
                  placeholder="Raqam"
                  style={{
                    borderColor: (strictParty && (isNonExistentParty || isWrongModelParty)) ? '#ef4444' : undefined,
                    backgroundColor: (strictParty && (isNonExistentParty || isWrongModelParty)) ? 'rgba(239, 68, 68, 0.08)' : undefined,
                    color: (strictParty && (isNonExistentParty || isWrongModelParty)) ? '#ef4444' : undefined
                  }}
                />
              </div>

              <div className="patta-col-right">
                <label className="patta-right-label">Rang</label>
                <input
                  type="text"
                  disabled={hasBlockingError}
                  value={form.color || ''}
                  onChange={(e) => updateTicketField(model.id, 'color', e.target.value)}
                  onFocus={() => handleCellFocus('D5', form.color || '')}
                  className="patta-input patta-input-wide"
                  placeholder=""
                />
              </div>
            </div>

            {/* ROW 3: Patta & Razmer */}
            <div className="patta-info-row">
              <div className="patta-col-left">
                <div className="patta-label-wrapper">
                  <span className="patta-label-title">Patta</span>
                  <span className="patta-label-required">*</span>
                  <span className="patta-label-majburiy">Majburiy</span>
                </div>
                <label
                  className="patta-checkbox-label"
                  onClick={() => updateTicketField(model.id, 'strictPatta', !strictPatta)}
                >
                  <span className={`patta-custom-checkbox ${strictPatta ? 'is-checked' : 'is-unchecked'}`}>
                    {strictPatta && <Check size={11} strokeWidth={3.5} />}
                  </span>
                  <span>Qat'iy</span>
                </label>
                <input
                  ref={pattaInputRef}
                  type="text"
                  value={form.patta !== undefined ? form.patta : ''}
                  onChange={(e) => updateTicketField(model.id, 'patta', e.target.value)}
                  onKeyDown={handlePattaKeyDown}
                  onFocus={() => handleCellFocus('C4', form.patta || '')}
                  className="patta-input patta-input-short"
                  placeholder="Raqam"
                  style={{
                    borderColor: (strictPatta && hasBlockingError) ? '#ef4444' : undefined,
                    backgroundColor: (strictPatta && hasBlockingError) ? 'rgba(239, 68, 68, 0.08)' : undefined,
                    color: (strictPatta && hasBlockingError) ? '#ef4444' : undefined
                  }}
                />
              </div>

              <div className="patta-col-right">
                <label className="patta-right-label">Razmer</label>
                <input
                  type="text"
                  disabled={hasBlockingError}
                  value={form.size || ''}
                  onChange={(e) => updateTicketField(model.id, 'size', e.target.value)}
                  onFocus={() => handleCellFocus('E5', form.size || '')}
                  className="patta-input patta-input-wide"
                  placeholder=""
                />
              </div>
            </div>

            {/* ROW 4: Ish soni */}
            <div className="patta-info-row">
              <div className="patta-col-left">
                <div className="patta-label-wrapper">
                  <span className="patta-label-title">Ish soni</span>
                </div>
                <input
                  ref={qtyInputRef}
                  type="number"
                  disabled={hasBlockingError}
                  value={form.qty || ''}
                  onChange={(e) => updateTicketField(model.id, 'qty', e.target.value)}
                  onKeyDown={handleQtyKeyDown}
                  onWheel={(e) => e.currentTarget.blur()}
                  onFocus={() => handleCellFocus('C5', String(form.qty || ''))}
                  className="patta-input patta-input-short"
                  placeholder="Dona"
                />
              </div>
              <div className="patta-col-right" />
            </div>
          </div>
        </div>

        {/* Section 2: Operatsiyalar */}
        <div className="patta-ops-section">
          <div className="patta-ops-header">
            <h2 className="patta-section-title" style={{ margin: 0 }}>Operatsiyalar</h2>
            <div className="patta-ops-badge">
              {model.pattaOpsOrder.length} ta · jami {totalRates.toLocaleString()} so'm
            </div>
          </div>

          <table className="patta-ops-table">
            <colgroup>
              <col style={{ width: '48px' }} />
              <col style={{ width: '30%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: '17%' }} />
              <col style={{ width: '31%' }} />
              <col style={{ width: '44px' }} />
            </colgroup>

            <thead>
              <tr>
                <th className="patta-ops-th" style={{ textAlign: 'center' }}>Nº</th>
                <th className="patta-ops-th" style={{ textAlign: 'left', paddingLeft: '12px' }}>OPERATSIYA</th>
                <th className="patta-ops-th" style={{ textAlign: 'right', paddingRight: '18px' }}>NARX</th>
               <th className="patta-ops-th" style={{ textAlign: 'center' }}>ISHCHI / DONA</th>
                <th className="patta-ops-th" style={{ textAlign: 'left', paddingLeft: '14px' }}>ISHCHI</th>
                <th className="patta-ops-th" style={{ width: '44px' }}></th>
              </tr>
            </thead>

            <tbody>
              {model.pattaOpsOrder.map((opName, idx) => {
                const opAllocations = getOpAllocations(opName);
                const workerIdVal = opAllocations[0]?.workerId || '';
                const workerNum = Number(workerIdVal);
                const workerName = workerNum && workerMap.has(workerNum) ? workerMap.get(workerNum) : '';
                const isInvalidWorker = workerIdVal !== '' && (!workerNum || !workerMap.has(workerNum));
                const allocated = opAllocations.reduce((sum, allocation) => sum + (Number(allocation.qty) || 0), 0);
                const hasSplitAllocation = opAllocations.filter((allocation) => Number(allocation.workerId) > 0).length > 1;
                const isComplete = allocated === Number(form.qty) && allocated > 0;
                const opConfig = model.operations.find((o) => o.name === opName);
                const isBeingDragged = draggedOpIdx === idx;
                const isOver = dragOverOpIdx === idx && draggedOpIdx !== null && draggedOpIdx !== idx;

                return (
                  <tr
                    key={opName}
                    className={`patta-op-row ${isComplete ? 'is-complete' : ''}`}
                    draggable={!hasBlockingError}
                    onDragStart={(e) => handleOpDragStart(e, idx)}
                    onDragOver={(e) => handleOpDragOver(e, idx)}
                    onDrop={(e) => handleOpDrop(e, idx)}
                    onDragEnd={handleOpDragEnd}
                    style={{
                      opacity: isBeingDragged ? 0.35 : hasBlockingError ? 0.6 : 1,
                      backgroundColor: isBeingDragged
                        ? 'var(--primary-light)'
                        : isOver
                        ? 'rgba(59, 130, 246, 0.12)'
                        : undefined
                    }}
                  >
                    {/* Col 1: Nº / Checkmark */}
                    <td style={{ textAlign: 'center' }}>
                      {isComplete ? (
                        <div className="patta-check-badge">
                          <Check size={14} strokeWidth={3.5} />
                        </div>
                      ) : (
                        <span className="patta-row-idx">{idx + 1}</span>
                      )}
                    </td>

                    {/* Col 2: Operatsiya Nomi with Drag Grip */}
                    <td style={{ paddingLeft: '12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span
                          title="O'rnini almashtirish uchun ushlab torting (Drag & Drop)"
                          className="patta-grip-icon"
                          style={{
                            cursor: hasBlockingError ? 'not-allowed' : 'grab',
                            display: 'inline-flex',
                            alignItems: 'center'
                          }}
                        >
                          <GripVertical size={14} />
                        </span>
                        <span className="patta-op-name" title={opName}>{opName}</span>
                      </div>
                    </td>

                    {/* Col 3: Narx */}
                    <td className="patta-rate-text">
                      {opConfig ? `${opConfig.rate} so'm` : "0 so'm"}
                    </td>

                    {/* Col 4: Single worker for the full patta quantity */}
                    <td style={{ textAlign: 'center', padding: '3px 8px' }}>
                      <select
                        aria-label={`${opName} worker`}
                        disabled={hasBlockingError}
                        value={workerIdVal}
                        onChange={(e) => updateTicketField(model.id, 'entries', { ...(form.entries || {}), [opName]: e.target.value })}
                        className="patta-input"
                        style={{ minWidth: 95 }}
                      >
                        <option value="">Ishchini tanlang</option>
                        {workers.filter((worker) => worker.status !== 'INACTIVE').map((worker) => <option key={worker.id} value={worker.id}>{worker.id} — {worker.name}</option>)}
                      </select>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Patta miqdori: {Number(form.qty || 0)} dona</div>
                      {hasSplitAllocation && (
                        <div role="status" style={{ fontSize: 11, color: '#b45309', marginTop: 3 }}>
                          Draftda oldingi taqsimot bor.{' '}
                          <button
                            type="button"
                            disabled={hasBlockingError || !workerIdVal}
                            onClick={() => updateTicketField(model.id, 'entries', { ...(form.entries || {}), [opName]: workerIdVal })}
                            style={{ border: 0, background: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer', padding: 0 }}
                          >
                            Butun patta miqdorini shu ishchiga biriktirish
                          </button>
                        </div>
                      )}
                    </td>

                    {/* Col 5: Ishchi Nomi */}
                    <td style={{ paddingLeft: '14px' }}>
                      {opAllocations.some((allocation) => Number(allocation.workerId) > 0) ? (
                        <span className="patta-worker-name">{workerMap.get(workerNum) || `#${workerIdVal}`}</span>
                      ) : workerName ? (
                        <span className="patta-worker-name">{workerName}</span>
                      ) : isInvalidWorker ? (
                        <span style={{ fontSize: '14.5px', color: '#dc2626', fontStyle: 'italic' }}>
                          Ishchi topilmadi! ({workerIdVal})
                        </span>
                      ) : (
                        <span className="patta-worker-placeholder">Raqam kiriting</span>
                      )}
                    </td>

                    {/* Col 6: Delete action */}
                    <td style={{ textAlign: 'center' }}>
                      <button
                        type="button"
                        onClick={(e) => handleDeleteOp(opName, e)}
                        className="patta-trash-btn"
                        title={`"${opName}" operatsiyasini o'chirish`}
                      >
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                );
              })}

              {/* INLINE NEW OPERATION ENTRY */}
              {isAddingInline && (
                <tr style={{ height: '42px', backgroundColor: '#ecfdf5' }}>
                  <td style={{ textAlign: 'center', fontWeight: 800, color: '#047857' }}>
                    {model.pattaOpsOrder.length + 1}
                  </td>
                  <td style={{ padding: '4px 8px' }}>
                    <input
                      ref={newOpInputRef}
                      type="text"
                      placeholder="Operatsiya nomini yozing..."
                      value={newOpName}
                      onChange={(e) => setNewOpName(e.target.value)}
                      onKeyDown={handleInlineKeyDown}
                      className="patta-input"
                      style={{ height: '32px', width: '100%' }}
                    />
                  </td>
                  <td style={{ padding: '4px 8px' }}>
                    <input
                      ref={newRateInputRef}
                      type="number"
                      placeholder="Narxi..."
                      value={newOpRate}
                      onChange={(e) => setNewOpRate(e.target.value)}
                      onKeyDown={handleInlineKeyDown}
                      onWheel={(e) => e.currentTarget.blur()}
                      className="patta-input"
                      style={{ height: '32px', width: '100%', textAlign: 'center' }}
                    />
                  </td>
                  <td colSpan={2} style={{ fontSize: '15px', color: '#64748b', paddingLeft: '14px' }}>
                    Enter bosing → hisobga qo'shiladi
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                      <button
                        type="button"
                        onClick={handleSaveInlineOperation}
                        className="patta-btn-submit"
                        style={{ height: '28px', padding: '0 8px', fontSize: '14.5px', borderRadius: '6px' }}
                      >
                        <Check size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setIsAddingInline(false)}
                        className="patta-btn-cancel"
                        style={{ height: '28px', padding: '0 8px', fontSize: '14.5px', borderRadius: '6px' }}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {/* Add Operation button */}
          {!isAddingInline && (
            <button
              type="button"
              className="patta-add-op-btn"
              onClick={() => {
                setIsAddingInline(true);
                setTimeout(() => newOpInputRef.current?.focus(), 50);
              }}
            >
              <Plus size={14} strokeWidth={2.5} />
              <span>Operatsiya qo'shish</span>
            </button>
          )}
        </div>

        {/* Footer */}
        {selectedPattaTicket && (
          <section aria-label="Patta operatsiya taqsimotlari" style={{ margin: '12px 20px', padding: 14, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <strong>Saqlangan patta taqsimotlari</strong>
                <div style={{ color: 'var(--text-muted)', marginTop: 4 }}>Partiya {selectedPattaTicket.partyNumber} · Patta #{selectedPattaTicket.pattaNumber} · Berilgan: {selectedPattaTicket.qty} dona</div>
                {(selectedPattaTicket.entries || []).map((entry, index) => <div key={entry.entryId || `${entry.opName}-${entry.workerId}-${index}`} style={{ fontSize: 14, marginTop: 3 }}>{entry.opName}: {workerMap.get(entry.workerId) || `#${entry.workerId}`} — {entry.qty ?? selectedPattaTicket.qty} dona</div>)}
                <div style={{ color: selectedPattaTicket.status === 'CONFLICT' ? '#dc2626' : 'var(--text-muted)', marginTop: 4 }}>Holat: {selectedPattaTicket.status === 'CONFLICT' ? 'Nizoli — tuzatish kerak' : selectedPattaTicket.status === 'CONFIRMED' ? 'Server tasdiqlagan' : 'Lokal saqlangan / sinxronlash kutilmoqda'}</div>
              </div>
              <button type="button" className="patta-btn-submit" disabled={Boolean(currentPeriod?.isClosed)} onClick={() => openModal({ type: 'edit_ticket', data: selectedPattaTicket })}>
                Taqsimotni boshqarish
              </button>
            </div>
          </section>
        )}
        <div className="patta-entry-footer">
          <div className="patta-footer-stats">
            <span>
              <strong>{filledOpsCount} / {model.pattaOpsOrder.length}</strong> operatsiya to'ldirildi
            </span>
            <span style={{ marginLeft: '18px' }}>
              Jami narx: <strong>{totalRates.toLocaleString()} so'm</strong>
            </span>
          </div>

          <div className="patta-footer-actions">
            <button
              type="button"
              className="patta-btn-cancel"
              onClick={handleCancel}
            >
              Bekor qilish
            </button>
            <button
              type="button"
              className="patta-btn-submit"
              onClick={handleSubmit}
              title="Kiritilgan ma'lumotlarni hisobga jo'natish (Enter)"
            >
              <Send size={14} />
              <span>Jo'natish</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
