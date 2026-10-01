import React, { useRef, useEffect, useState } from 'react';
import { useWorkbookStore, DEFAULT_BATCH_SIZES } from '../../store/workbookStore';
import { ModelConfig } from '../../types/workbook';
import { getTicketPartyStatus } from '../../domain/ticketValidation';
import { Send, Plus, Trash2, Check, X, Layers, GripVertical } from 'lucide-react';

interface PattaViewProps {
  model: ModelConfig;
}

export const PattaView: React.FC<PattaViewProps> = ({ model }) => {
  const licenseStatus = useWorkbookStore((s) => s.licenseStatus);
  const requireTicketValidation = licenseStatus?.requireTicketValidation !== false;
  const workers = useWorkbookStore((s) => s.workers);

  const form = useWorkbookStore((s) => s.ticketForms[model.id]) || {
    date: new Date().toISOString().slice(0, 10),
    party: requireTicketValidation ? (model.party || '') : '',
    color: model.color || '',
    size: model.size || '',
    qty: '',
    patta: '',
    entries: {}
  };
  const printedPartyHistory = useWorkbookStore((s) => s.printedPartyHistory);
  const submittedTickets = useWorkbookStore((s) => s.submittedTickets);
  const availableSizes = useWorkbookStore((s) => s.availableSizes);
  const updateTicketField = useWorkbookStore((s) => s.updateTicketField);
  const setTicketWorker = useWorkbookStore((s) => s.setTicketWorker);
  const jonatish = useWorkbookStore((s) => s.jonatish);
  const addNotification = useWorkbookStore((s) => s.addNotification);
  const setActiveCell = useWorkbookStore((s) => s.setActiveCell);
  const syncNewOperation = useWorkbookStore((s) => s.syncNewOperation);
  const syncDeleteOperation = useWorkbookStore((s) => s.syncDeleteOperation);
  const reorderOperations = useWorkbookStore((s) => s.reorderOperations);

  const currentPartyStr = String(form.party || '1');
  const { isNonExistentParty, isWrongModelParty, hasBlockingError, errorBannerText } =
    getTicketPartyStatus(form, model, printedPartyHistory, submittedTickets, { requireTicketValidation });

  // When strict mode is OFF (free mode), clear default pre-filled party and patta
  useEffect(() => {
    if (!requireTicketValidation) {
      const cur = useWorkbookStore.getState().ticketForms[model.id];
      if (cur) {
        if (cur.party === (model.party || '1') || cur.party === '1') {
          updateTicketField(model.id, 'party', '');
        }
        if (cur.patta === '1') {
          updateTicketField(model.id, 'patta', '');
        }
      }
    }
  }, [requireTicketValidation, model.id, model.party, updateTicketField]);

  // Auto fill size & qty from printed history if available (ONLY in strict mode)
  useEffect(() => {
    if (!requireTicketValidation) return;
    if (!form.party || !form.patta) return;
    const pNum = parseInt(form.patta, 10);
    if (isNaN(pNum) || pNum <= 0) return;

    const matchedParty = (printedPartyHistory || []).find(
      (h) => h.modelId === model.id && String(h.partyNumber) === String(form.party)
    );
    if (matchedParty && matchedParty.sizes) {
      const startPatta = (matchedParty.cumulativePattaCount > matchedParty.pattaCount)
        ? (matchedParty.cumulativePattaCount - matchedParty.pattaCount + 1)
        : 1;
      const relPattaNum = pNum >= startPatta ? (pNum - startPatta + 1) : pNum;

      let counter = 1;
      let targetSize = '';
      for (const sz of (availableSizes || DEFAULT_BATCH_SIZES)) {
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
      if (matchedParty.color && (!form.color || form.color === 'Кора')) {
        updateTicketField(model.id, 'color', matchedParty.color);
      }
    }
  }, [requireTicketValidation, form.party, form.patta, printedPartyHistory, model.id, availableSizes, updateTicketField, form.size, form.color]);

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
  const workerMap = React.useMemo(() => {
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

  const handleWorkerIdChange = (opName: string, val: string) => {
    setTicketWorker(model.id, opName, val);
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

  const handleKonveyerKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      safeFocus(partyInputRef.current);
    }
  };

  const handlePartyKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (requireTicketValidation && (isNonExistentParty || isWrongModelParty)) {
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
      if (requireTicketValidation && hasBlockingError) {
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
      if (requireTicketValidation && hasBlockingError) {
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

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, currentIndex: number) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const nextIndex = currentIndex + 1;
      if (nextIndex < model.pattaOpsOrder.length) {
        const nextOp = model.pattaOpsOrder[nextIndex];
        safeFocus(inputRefs.current[nextOp]);
      } else {
        jonatish(model.id);
        setTimeout(() => {
          safeFocus(pattaInputRef.current);
        }, 150);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIndex = currentIndex + 1;
      if (nextIndex < model.pattaOpsOrder.length) {
        const nextOp = model.pattaOpsOrder[nextIndex];
        safeFocus(inputRefs.current[nextOp]);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIndex = currentIndex - 1;
      if (prevIndex >= 0) {
        const prevOp = model.pattaOpsOrder[prevIndex];
        safeFocus(inputRefs.current[prevOp]);
      } else {
        safeFocus(qtyInputRef.current);
      }
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

  return (
    <div className="excel-grid-container" style={{ padding: '20px', background: 'var(--bg-app)' }}>
      <div style={{
        maxWidth: '960px',
        margin: '0 auto',
        background: 'var(--bg-surface)',
        borderRadius: 'var(--radius-xl)',
        boxShadow: 'var(--shadow-md)',
        border: '1px solid var(--border-subtle)',
        overflow: 'hidden'
      }}>
        {/* Modern Top Header */}
        <div style={{
          padding: '16px 20px',
          background: 'var(--bg-surface)',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '12px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{
              width: '36px',
              height: '36px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--primary-light)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              <Layers size={18} color="var(--primary)" />
            </div>
            <div>
              <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>
                Patta Kiritish — {model.name}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                Ishchilar raqamini ketma-ket kiritib Enter bosing
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              onClick={() => {
                setIsAddingInline(true);
                setTimeout(() => newOpInputRef.current?.focus(), 50);
              }}
              className="soft-btn soft-btn-secondary"
              style={{ borderRadius: 'var(--radius-full)', padding: '6px 14px' }}
            >
              <Plus size={14} color="var(--primary)" />
              <span>Operatsiya qo'shish</span>
            </button>

            <button
              onClick={() => {
                if (requireTicketValidation && hasBlockingError) {
                  addNotification(
                    'error',
                    'Chop etilmagan partiya',
                    errorBannerText || `Partiya ${currentPartyStr} hali chop etilmagan! Avval «Patta» varag'ida chop eting.`
                  );
                  return;
                }
                jonatish(model.id);
              }}
              className="soft-btn soft-btn-primary"
              style={{
                borderRadius: 'var(--radius-full)',
                padding: '6px 18px'
              }}
              title="Kiritilgan ma'lumotlarni hisobga jo'natish (Enter / F5)"
            >
              <Send size={15} />
              <span>Jo'natish</span>
            </button>
          </div>
        </div>

        {/* Form Card Grid Table */}
        <table className="excel-table" style={{ width: '100%' }}>
          <colgroup>
            <col style={{ width: '54px' }} />
            <col style={{ width: '270px' }} />
            <col style={{ width: '120px' }} />
            <col style={{ width: '260px' }} />
            <col style={{ width: '180px' }} />
          </colgroup>

          <tbody>
            {/* ROW 1: Model Title */}
            <tr style={{ height: '38px', backgroundColor: 'var(--bg-surface-subtle)' }}>
              <td></td>
              <td 
                colSpan={4} 
                style={{ 
                  fontWeight: 800, 
                  fontSize: '15px', 
                  color: 'var(--primary)', 
                  textAlign: 'center',
                  letterSpacing: '0.2px'
                }}
              >
                {(() => {
                  const raw = model.title || model.name;
                  const clean = raw.replace(/^(Модел-\s*|Модель-\s*|Model-\s*)+/i, '').trim();
                  return `Модел- ${clean}`;
                })()}
              </td>
            </tr>

            {/* ROW 2: Konveyer & Date */}
            <tr style={{ height: '36px' }}>
              <td></td>
              <td style={{ fontWeight: 700, textAlign: 'right', paddingRight: '16px', color: 'var(--text-secondary)' }}>
                Конвейер
              </td>
              <td style={{ padding: '4px 8px' }}>
                <input
                  ref={konveyerInputRef}
                  type="text"
                  value={form.konveyer || ''}
                  onChange={(e) => updateTicketField(model.id, 'konveyer', e.target.value)}
                  onKeyDown={handleKonveyerKeyDown}
                  onFocus={() => handleCellFocus('C2', form.konveyer || '')}
                  className="soft-input"
                  style={{ height: '30px', textAlign: 'center', fontWeight: 700 }}
                  placeholder={requireTicketValidation ? "" : "(ixtiyoriy)"}
                />
              </td>
              <td colSpan={2} style={{ fontWeight: 600, textAlign: 'center' }}>
                <span style={{ color: 'var(--text-secondary)', marginRight: '8px' }}>Сана:</span>
                <input
                  type="date"
                  value={form.date}
                  onChange={(e) => updateTicketField(model.id, 'date', e.target.value)}
                  onFocus={() => handleCellFocus('D2', form.date)}
                  className="soft-input"
                  style={{ width: 'auto', display: 'inline-block', height: '30px', fontWeight: 600 }}
                />
              </td>
            </tr>

            {/* ROW 3: Party */}
            <tr style={{ height: '36px' }}>
              <td></td>
              <td style={{ fontWeight: 700, textAlign: 'right', paddingRight: '16px', color: 'var(--text-secondary)' }}>
                Партия
              </td>
              <td style={{ padding: '4px 8px' }}>
                <input
                  ref={partyInputRef}
                  type="text"
                  value={form.party && (form.party.includes('6632') || form.party.includes('Мато Партия')) ? '' : form.party}
                  onChange={(e) => updateTicketField(model.id, 'party', e.target.value)}
                  onKeyDown={handlePartyKeyDown}
                  onFocus={() => handleCellFocus('C3', form.party)}
                  className="soft-input"
                  style={{
                    height: '30px',
                    textAlign: 'center',
                    fontWeight: 700,
                    borderColor: (requireTicketValidation && (isNonExistentParty || isWrongModelParty)) ? '#ef4444' : undefined,
                    backgroundColor: (requireTicketValidation && (isNonExistentParty || isWrongModelParty)) ? 'rgba(239, 68, 68, 0.15)' : 'var(--bg-surface)',
                    color: (requireTicketValidation && (isNonExistentParty || isWrongModelParty)) ? '#f87171' : 'var(--text-primary)'
                  }}
                  placeholder={requireTicketValidation ? "" : "(ixtiyoriy)"}
                />
              </td>
              <td colSpan={2}></td>
            </tr>

            {/* ROW 4: Patta, Rang, Razmer */}
            <tr style={{ height: '36px' }}>
              <td></td>
              <td style={{ fontWeight: 700, textAlign: 'right', paddingRight: '16px', color: 'var(--text-secondary)' }}>
                Патта
              </td>
              <td style={{ padding: '4px 8px' }}>
                <input
                  ref={pattaInputRef}
                  type="text"
                  value={form.patta !== undefined ? form.patta : ''}
                  onChange={(e) => updateTicketField(model.id, 'patta', e.target.value)}
                  onKeyDown={handlePattaKeyDown}
                  onFocus={() => handleCellFocus('C4', form.patta || '')}
                  className="soft-input"
                  style={{
                    height: '30px',
                    textAlign: 'center',
                    fontWeight: 700,
                    borderColor: (requireTicketValidation && hasBlockingError) ? '#ef4444' : undefined,
                    backgroundColor: (requireTicketValidation && hasBlockingError) ? 'rgba(239, 68, 68, 0.15)' : 'var(--bg-surface)',
                    color: (requireTicketValidation && hasBlockingError) ? '#f87171' : 'var(--text-primary)'
                  }}
                  placeholder={requireTicketValidation ? "" : "(ixtiyoriy)"}
                />
              </td>
              <td style={{ fontWeight: 700, textAlign: 'center', color: 'var(--text-secondary)' }}>Ранг</td>
              <td style={{ fontWeight: 700, textAlign: 'center', color: 'var(--text-secondary)' }}>Размер</td>
            </tr>

            {/* ROW 5: Qty, Color, Size */}
            <tr style={{ height: '38px' }}>
              <td></td>
              <td style={{ fontWeight: 700, textAlign: 'right', paddingRight: '16px', color: 'var(--text-secondary)' }}>
                Иш сони
              </td>
              <td style={{ padding: '4px 8px' }}>
                <input
                  ref={qtyInputRef}
                  type="number"
                  disabled={hasBlockingError}
                  value={form.qty || ''}
                  onChange={(e) => updateTicketField(model.id, 'qty', e.target.value)}
                  onKeyDown={handleQtyKeyDown}
                  onFocus={() => handleCellFocus('C5', String(form.qty || ''))}
                  className="soft-input"
                  style={{
                    height: '32px',
                    textAlign: 'center',
                    fontWeight: 800,
                    fontSize: '14px',
                    color: hasBlockingError ? 'var(--text-muted)' : 'var(--primary)',
                    backgroundColor: hasBlockingError ? 'var(--bg-surface-subtle)' : 'var(--primary-light)',
                    borderColor: hasBlockingError ? 'var(--border-default)' : 'rgba(52, 211, 153, 0.4)',
                    opacity: hasBlockingError ? 0.6 : 1,
                    cursor: hasBlockingError ? 'not-allowed' : 'text'
                  }}
                  placeholder=""
                />
              </td>
              <td style={{ padding: '4px 8px' }}>
                <input
                  type="text"
                  disabled={hasBlockingError}
                  value={form.color || ''}
                  onChange={(e) => updateTicketField(model.id, 'color', e.target.value)}
                  onFocus={() => handleCellFocus('D5', form.color || '')}
                  className="soft-input"
                  style={{
                    height: '30px',
                    textAlign: 'center',
                    fontWeight: 600,
                    backgroundColor: hasBlockingError ? 'var(--bg-surface-subtle)' : 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                    opacity: hasBlockingError ? 0.6 : 1,
                    cursor: hasBlockingError ? 'not-allowed' : 'text'
                  }}
                  placeholder=""
                />
              </td>
              <td style={{ padding: '4px 8px' }}>
                <input
                  type="text"
                  disabled={hasBlockingError}
                  value={form.size || ''}
                  onChange={(e) => updateTicketField(model.id, 'size', e.target.value)}
                  onFocus={() => handleCellFocus('E5', form.size || '')}
                  className="soft-input"
                  style={{
                    height: '30px',
                    textAlign: 'center',
                    fontWeight: 600,
                    backgroundColor: hasBlockingError ? 'var(--bg-surface-subtle)' : 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                    opacity: hasBlockingError ? 0.6 : 1,
                    cursor: hasBlockingError ? 'not-allowed' : 'text'
                  }}
                  placeholder=""
                />
              </td>
            </tr>

            {/* ROW 6: Column Headers */}
            <tr style={{ backgroundColor: 'var(--bg-surface-subtle)', fontWeight: 700, height: '36px' }}>
              <td style={{ textAlign: 'center' }}>№</td>
              <td style={{ paddingLeft: '14px' }}>Операция номи</td>
              <td style={{ textAlign: 'center', color: 'var(--primary)' }}>Номер</td>
              <td style={{ paddingLeft: '14px' }}>Исм фамилия</td>
              <td style={{ textAlign: 'center' }}>Брак иш / Амал</td>
            </tr>

            {/* ROW 7+: Operations List */}
            {model.pattaOpsOrder.map((opName, idx) => {
              const rowNum = 7 + idx;
              const workerIdVal = (form.entries && form.entries[opName] !== undefined && form.entries[opName] !== null) ? String(form.entries[opName]) : '';
              const workerNum = Number(workerIdVal);
              const workerName = workerNum && workerMap.has(workerNum) ? workerMap.get(workerNum) : '';
              const isInvalidWorker = workerIdVal !== '' && (!workerNum || !workerMap.has(workerNum));
              const opConfig = model.operations.find((o) => o.name === opName);
              const isBeingDragged = draggedOpIdx === idx;
              const isOver = dragOverOpIdx === idx && draggedOpIdx !== null && draggedOpIdx !== idx;

              return (
                <tr
                  key={opName}
                  draggable={!hasBlockingError}
                  onDragStart={(e) => handleOpDragStart(e, idx)}
                  onDragOver={(e) => handleOpDragOver(e, idx)}
                  onDrop={(e) => handleOpDrop(e, idx)}
                  onDragEnd={handleOpDragEnd}
                  style={{
                    height: '34px',
                    transition: 'background-color 0.15s, box-shadow 0.15s, opacity 0.15s',
                    opacity: isBeingDragged ? 0.35 : hasBlockingError ? 0.6 : 1,
                    backgroundColor: isBeingDragged
                      ? 'var(--primary-light)'
                      : isOver
                      ? 'rgba(59, 130, 246, 0.12)'
                      : undefined,
                    boxShadow: isOver
                      ? (draggedOpIdx !== null && draggedOpIdx < idx
                          ? 'inset 0 -3px 0 0 var(--primary)'
                          : 'inset 0 3px 0 0 var(--primary)')
                      : undefined
                  }}
                  onMouseEnter={(e) => {
                    if (!hasBlockingError && draggedOpIdx === null) e.currentTarget.style.backgroundColor = 'var(--bg-surface-subtle)';
                  }}
                  onMouseLeave={(e) => {
                    if (!hasBlockingError && draggedOpIdx === null) e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                >
                  {/* Col A: № */}
                  <td style={{ textAlign: 'center', fontWeight: 700, color: 'var(--text-secondary)' }}>
                    <span style={{ 
                      background: 'var(--bg-surface-subtle)', 
                      padding: '2px 8px', 
                      borderRadius: 'var(--radius-full)',
                      fontSize: '11px'
                    }}>
                      {idx + 1}
                    </span>
                  </td>
                  
                  {/* Col B: Operatsiya nomi */}
                  <td style={{ fontWeight: 600, paddingLeft: '14px', color: 'var(--text-primary)', userSelect: 'none' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span
                          title="O'rnini almashtirish uchun ushlab torting (Drag & Drop)"
                          style={{
                            cursor: hasBlockingError ? 'not-allowed' : 'grab',
                            display: 'inline-flex',
                            alignItems: 'center',
                            color: 'var(--text-muted)',
                            opacity: 0.55,
                            flexShrink: 0
                          }}
                        >
                          <GripVertical size={15} />
                        </span>
                        <span>{opName}</span>
                      </div>
                      {opConfig && (
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: '6px' }}>
                          ({opConfig.rate} so'm)
                        </span>
                      )}
                    </div>
                  </td>

                  {/* Col C: Worker Number Input */}
                  <td style={{ padding: '2px 8px', textAlign: 'center' }}>
                    <input
                      ref={(el) => { inputRefs.current[opName] = el; }}
                      type="number"
                      disabled={hasBlockingError}
                      value={workerIdVal}
                      onChange={(e) => handleWorkerIdChange(opName, e.target.value)}
                      onKeyDown={(e) => handleKeyDown(e, idx)}
                      onFocus={() => handleCellFocus(`C${rowNum}`, workerIdVal)}
                      className="soft-input"
                      placeholder=""
                      style={{
                        height: '28px',
                        textAlign: 'center',
                        fontWeight: 700,
                        fontSize: '13px',
                        backgroundColor: hasBlockingError ? 'var(--bg-surface-subtle)' : (workerIdVal ? 'var(--primary-light)' : isInvalidWorker ? 'rgba(239, 68, 68, 0.15)' : 'var(--bg-surface)'),
                        borderColor: hasBlockingError ? 'var(--border-subtle)' : (workerIdVal ? 'var(--primary)' : isInvalidWorker ? '#ef4444' : 'var(--border-subtle)'),
                        color: isInvalidWorker ? '#f87171' : (workerIdVal ? 'var(--primary)' : 'var(--text-primary)'),
                        opacity: hasBlockingError ? 0.6 : 1,
                        cursor: hasBlockingError ? 'not-allowed' : 'text'
                      }}
                    />
                  </td>

                  {/* Col D: Worker Name */}
                  <td style={{ paddingLeft: '14px', fontWeight: 600 }}>
                    {workerName ? (
                      <span style={{ color: 'var(--primary)', background: 'var(--primary-light)', padding: '2px 8px', borderRadius: 'var(--radius-full)', fontSize: '12px' }}>
                        {workerName}
                      </span>
                    ) : isInvalidWorker ? (
                      <span style={{ fontSize: '11.5px', color: '#dc2626', fontStyle: 'italic' }}>
                        Ishchi topilmadi! ({workerIdVal})
                      </span>
                    ) : null}
                  </td>

                  {/* Col E: Actions / Brak */}
                  <td style={{ textAlign: 'center' }}>
                    <button
                      type="button"
                      onClick={(e) => handleDeleteOp(opName, e)}
                      className="soft-btn soft-btn-danger"
                      style={{
                        padding: '4px 8px',
                        borderRadius: 'var(--radius-full)',
                        fontSize: '11px'
                      }}
                      title={`"${opName}" operatsiyasini o'chirish`}
                    >
                      <Trash2 size={12} />
                      <span>O'chirish</span>
                    </button>
                  </td>
                </tr>
              );
            })}

            {/* INLINE NEW OPERATION ENTRY */}
            {isAddingInline ? (
              <tr style={{ height: '42px', backgroundColor: 'var(--primary-light)' }}>
                <td style={{ textAlign: 'center', fontWeight: 800, color: 'var(--primary)' }}>
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
                    className="soft-input"
                    style={{ height: '32px', fontWeight: 600 }}
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
                    className="soft-input"
                    style={{ height: '32px', textAlign: 'center', fontWeight: 700 }}
                  />
                </td>
                <td style={{ fontSize: '12px', color: 'var(--text-muted)', paddingLeft: '14px' }}>
                  Enter bosing → hisobga qo'shiladi
                </td>
                <td style={{ textAlign: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                    <button
                      onClick={handleSaveInlineOperation}
                      className="soft-btn soft-btn-primary"
                      style={{ padding: '4px 10px', fontSize: '11.5px', borderRadius: 'var(--radius-full)' }}
                    >
                      <Check size={13} />
                      <span>Saqlash</span>
                    </button>
                    <button
                      onClick={() => setIsAddingInline(false)}
                      className="soft-btn soft-btn-secondary"
                      style={{ padding: '4px 8px', borderRadius: 'var(--radius-full)' }}
                    >
                      <X size={13} />
                    </button>
                  </div>
                </td>
              </tr>
            ) : (
              <tr 
                onClick={() => {
                  setIsAddingInline(true);
                  setTimeout(() => newOpInputRef.current?.focus(), 50);
                }}
                style={{ height: '36px', cursor: 'pointer', backgroundColor: 'var(--bg-surface)', transition: 'background-color 0.15s' }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-surface-subtle)')}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-surface)')}
              >
                <td style={{ textAlign: 'center' }}>
                  <span style={{ 
                    background: 'var(--bg-surface-subtle)', 
                    padding: '2px 8px', 
                    borderRadius: 'var(--radius-full)', 
                    fontSize: '11px',
                    color: 'var(--primary)',
                    fontWeight: 700
                  }}>
                    +
                  </span>
                </td>
                <td style={{ paddingLeft: '14px', color: 'var(--primary)', fontWeight: 600, fontSize: '12.5px' }}>
                  + Yangi operatsiya va narx kiritish uchun bosing...
                </td>
                <td colSpan={3}></td>
              </tr>
            )}
          </tbody>
        </table>

        {/* Footer */}
        <div style={{
          padding: '14px 20px',
          background: 'var(--bg-surface-subtle)',
          borderTop: '1px solid var(--border-subtle)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: '12px',
          color: 'var(--text-secondary)'
        }}>
          <div>
            <strong>Tezkor kiritish:</strong> Raqamni kiritib <strong>Enter</strong> bosilganda avtomatik keyingi qatorga o'tadi.
          </div>
          <div style={{ fontWeight: 700, color: 'var(--primary)' }}>
            Jami: {model.pattaOpsOrder.length} ta operatsiya
          </div>
        </div>
      </div>
    </div>
  );
};
