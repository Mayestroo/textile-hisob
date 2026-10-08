import React, { useState, useRef, useMemo, useEffect } from 'react';
import { useWorkbookStore, DEFAULT_BATCH_SIZES } from '../../store/workbookStore';
import { Printer, Plus, X, Layers, CheckCircle2, AlertCircle, TrendingUp } from 'lucide-react';
import { PattaPrintModal, PrintBatchItem } from './modals/PattaPrintModal';
import { ModelConfig } from '../../types/workbook';
import { buildPartyTicketsList } from '../../domain/partyAnalytics';
import { calculateBatchWorkQuantities, normalizePattaSizeCounts } from '../../domain/pattaQuantity';
import { getPattaSizesForSystem, isDefaultPattaSize, PattaSizeSystem } from '../../domain/pattaSizeSystem';
import { getElectronApi, resolveElectronRuntimeMode } from '../../store/runtimeMode';
import { selectPartyDashboardRecords } from '../../store/selectors';

export const PattaBatchView: React.FC = () => {
  const models = useWorkbookStore((s) => s.models);
  const printedPartyHistory = useWorkbookStore(selectPartyDashboardRecords);
  const submittedTickets = useWorkbookStore((s) => s.submittedTickets);
  const pattaBatchConfigs = useWorkbookStore((s) => s.pattaBatchConfigs);
  const availableSizes = useWorkbookStore((s) => s.availableSizes);
  const addCustomSize = useWorkbookStore((s) => s.addCustomSize);
  const deleteCustomSize = useWorkbookStore((s) => s.deleteCustomSize);
  const confirmAction = useWorkbookStore((s) => s.confirmAction);
  const nextPartyNumber = useWorkbookStore((s) => s.nextPartyNumber);
  const updatePattaBatchConfig = useWorkbookStore((s) => s.updatePattaBatchConfig);
  const updatePattaBatchSize = useWorkbookStore((s) => s.updatePattaBatchSize);
  const batchPrintCompleted = useWorkbookStore((s) => s.batchPrintCompleted);
  const completePartySeries = useWorkbookStore((s) => s.completePartySeries);
  const addNotification = useWorkbookStore((s) => s.addNotification);
  const [runtimeMode, setRuntimeMode] = useState<'checking' | 'legacy' | 'sync'>('checking');
  const [sizeSystem, setSizeSystem] = useState<PattaSizeSystem>('letters');

  useEffect(() => {
    let active = true;
    void resolveElectronRuntimeMode(getElectronApi()).then((runtime) => {
      if (active) setRuntimeMode(runtime.mode === 'sync' ? 'sync' : 'legacy');
    });
    return () => {
      active = false;
    };
  }, []);

  const canUseBatchMutation = () => runtimeMode !== 'checking';

  const guardedAddCustomSize = (sizeName: string) => addCustomSize(sizeName);
  const guardedDeleteCustomSize = (sizeName: string) => deleteCustomSize(sizeName);
  const guardedUpdateBatchConfig = (modelId: string, updates: any) => {
    // Keep controlled inputs responsive while runtime readiness is checked.
    // The store applies the change locally first and resolves persistence mode
    // asynchronously, so gating the handler here drops early keystrokes.
    updatePattaBatchConfig(modelId, updates);
  };
  const guardedUpdateBatchSize = (modelId: string, size: string, count: string) => {
    updatePattaBatchSize(modelId, size, count);
  };
  const guardedBatchPrintCompleted = (printedSummary: any) => {
    if (canUseBatchMutation()) batchPrintCompleted(printedSummary);
  };
  
  const allKnownSizes = useMemo(() => {
    const sizes = new Set<string>(availableSizes && availableSizes.length > 0 ? availableSizes : DEFAULT_BATCH_SIZES);
    for (const config of Object.values(pattaBatchConfigs || {})) {
      for (const size of Object.keys(config.sizes || {})) sizes.add(size);
    }
    return Array.from(sizes);
  }, [availableSizes, pattaBatchConfigs]);
  const activeSizes = useMemo(
    () => getPattaSizesForSystem(allKnownSizes, sizeSystem),
    [allKnownSizes, sizeSystem]
  );

  const getActiveSizeValues = (modelId: string) => {
    const savedSizes = pattaBatchConfigs[modelId]?.sizes || {};
    return Object.fromEntries(activeSizes.map((size) => [size, savedSizes[size] || '']));
  };

  const [printBatchItems, setPrintBatchItems] = useState<PrintBatchItem[] | null>(null);
  const [isAddSizeModalOpen, setIsAddSizeModalOpen] = useState(false);
  const [isClosePartyModalOpen, setIsClosePartyModalOpen] = useState(false);
  const [isClosingParty, setIsClosingParty] = useState(false);
  const [newCustomSizeInput, setNewCustomSizeInput] = useState('');
  const customSizeInputRef = useRef<HTMLInputElement>(null);

  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const getTotalPattaCount = (modelId: string) => {
    if (!pattaBatchConfigs[modelId]?.sizes) return 0;
    try {
      return normalizePattaSizeCounts(getActiveSizeValues(modelId)).pattaCount;
    } catch {
      return 0;
    }
  };

  const { effectiveParties, partyConflicts } = useMemo(() => {
    const parties: Record<string, string> = {};
    const conflicts: Record<string, string> = {};

    // 1. Gather all existing active party numbers from printedPartyHistory
    const activeHistory = (printedPartyHistory || []).filter((h) => !h.isClosed);
    const existingActivePartyNumbers = new Set<string>();
    let maxExistingPartyNum = 0;
    for (const h of activeHistory) {
      const pStr = String(h.partyNumber || '').trim();
      if (pStr) {
        existingActivePartyNumbers.add(pStr);
        const pInt = parseInt(pStr, 10);
        if (!isNaN(pInt) && pInt > maxExistingPartyNum) {
          maxExistingPartyNum = pInt;
        }
      }
    }

    const usedPartyNumbers = new Set<string>(existingActivePartyNumbers);
    const customNumbersEntered = new Map<string, string>(); // partyNumber -> firstModelId

    // 2. Check custom numbers entered by user
    for (const m of models) {
      const cfg = pattaBatchConfigs[m.id];
      if (cfg?.isCustomParty && cfg?.partyNumber && cfg.partyNumber.trim() !== '') {
        const val = cfg.partyNumber.trim();
        parties[m.id] = val;

        // Check collision with existing active printed history
        if (existingActivePartyNumbers.has(val)) {
          conflicts[m.id] = `Partiya ${val} allaqachon faol partiyalarda mavjud!`;
        }
        // Check collision with another model in current batch
        if (customNumbersEntered.has(val)) {
          conflicts[m.id] = `Partiya ${val} boshqa modelda ham kiritilgan!`;
          const prevModelId = customNumbersEntered.get(val)!;
          if (!conflicts[prevModelId]) {
            conflicts[prevModelId] = `Partiya ${val} boshqa modelda ham kiritilgan!`;
          }
        } else {
          customNumbersEntered.set(val, m.id);
        }

        usedPartyNumbers.add(val);
      }
    }

    let partyCounter = 1;

    const getNextSequential = () => {
      while (usedPartyNumbers.has(String(partyCounter))) {
        partyCounter++;
      }
      const val = String(partyCounter);
      usedPartyNumbers.add(val);
      partyCounter++;
      return val;
    };

    // 3. Assign unique sequential party numbers to all FILLED models
    for (const m of models) {
      if (parties[m.id]) continue;
      if (getTotalPattaCount(m.id) > 0) {
        parties[m.id] = getNextSequential();
      }
    }

    // 4. For unfilled models, show what the prospective sequential numbers would be (filling lowest available gaps)
    let prospectiveCounter = 1;
    for (const m of models) {
      if (!parties[m.id]) {
        while (usedPartyNumbers.has(String(prospectiveCounter))) {
          prospectiveCounter++;
        }
        parties[m.id] = String(prospectiveCounter);
        usedPartyNumbers.add(String(prospectiveCounter));
        prospectiveCounter++;
      }
    }

    return { effectiveParties: parties, partyConflicts: conflicts };
  }, [models, pattaBatchConfigs, nextPartyNumber, printedPartyHistory, activeSizes]);

  const totalBatchPattas = useMemo(() => {
    let total = 0;
    for (const m of models) {
      total += getTotalPattaCount(m.id);
    }
    return total;
  }, [models, pattaBatchConfigs, activeSizes]);

  const filledModelsCount = useMemo(() => {
    return models.filter((m) => getTotalPattaCount(m.id) > 0).length;
  }, [models, pattaBatchConfigs, activeSizes]);

  const missingIshSoniModels = useMemo(() => {
    return models.filter((m) => {
      const pCount = getTotalPattaCount(m.id);
      if (pCount === 0) return false;
      return !pattaBatchConfigs[m.id]?.totalIshSoni?.trim();
    });
  }, [models, pattaBatchConfigs, activeSizes]);

  const invalidPattaSizeModels = useMemo(() => {
    return models.filter((model) => {
      try {
        normalizePattaSizeCounts(getActiveSizeValues(model.id));
        return false;
      } catch {
        return true;
      }
    });
  }, [models, pattaBatchConfigs, activeSizes]);

  const canAttemptBatchPrint = totalBatchPattas > 0 || invalidPattaSizeModels.length > 0;

  const handleOpenBatchPrint = () => {
    if (!canUseBatchMutation()) return;

    const normalizedSizesByModelId = new Map<string, ReturnType<typeof normalizePattaSizeCounts>>();
    for (const model of models) {
      try {
        normalizedSizesByModelId.set(
          model.id,
          normalizePattaSizeCounts(getActiveSizeValues(model.id))
        );
      } catch (error) {
        const errorCode = error instanceof Error ? error.message : '';
        const invalidSize = errorCode.startsWith('INVALID_PATTA_SIZE_COUNT:')
          ? errorCode.slice('INVALID_PATTA_SIZE_COUNT:'.length)
          : '';
        const message = errorCode === 'INVALID_PATTA_SIZE_TOTAL'
          ? `"${model.name}" modelidagi jami patta soni xavfsiz butun son chegarasidan oshdi.`
          : `"${model.name}" modelida ${invalidSize ? `${invalidSize} razmer uchun ` : ''}patta soni manfiy bo'lmagan butun son bo'lishi kerak.`;
        addNotification('error', 'Razmer soni xato!', message);
        return;
      }
    }

    if (missingIshSoniModels.length > 0) {
      const firstMissing = missingIshSoniModels[0];
      inputRefs.current[`ish_soni_${firstMissing.id}`]?.focus();
      inputRefs.current[`ish_soni_${firstMissing.id}`]?.select();
      addNotification(
        'warning',
        'Ish soni kiritilishi shart!',
        `Quyidagi model(lar) uchun "Ish soni" kiritilmagan: ${missingIshSoniModels.map((m: ModelConfig) => m.name).join(', ')}`
      );
      return;
    }

    // Check party conflicts for filled models
    const filledModelsWithConflict = models.filter(
      (m) => getTotalPattaCount(m.id) > 0 && partyConflicts[m.id]
    );
    if (filledModelsWithConflict.length > 0) {
      const firstConflictModel = filledModelsWithConflict[0];
      inputRefs.current[`party_${firstConflictModel.id}`]?.focus();
      inputRefs.current[`party_${firstConflictModel.id}`]?.select();
      addNotification(
        'error',
        'Partiya raqami xato!',
        `Quyidagi model(lar)da partiya raqami takrorlangan: ${filledModelsWithConflict.map((m) => `${m.name} (${partyConflicts[m.id]})`).join('; ')}`
      );
      return;
    }

    for (const model of models) {
      const pattaCount = normalizedSizesByModelId.get(model.id)?.pattaCount || 0;
      if (pattaCount === 0) continue;

      const ishSoniPerPatta = Number(pattaBatchConfigs[model.id]?.totalIshSoni);
      try {
        calculateBatchWorkQuantities(ishSoniPerPatta, pattaCount);
      } catch {
        inputRefs.current[`ish_soni_${model.id}`]?.focus();
        inputRefs.current[`ish_soni_${model.id}`]?.select();

        const message = `"${model.name}" modeli uchun 1 ta pattadagi ish soni musbat butun son bo'lishi va jami (${ishSoniPerPatta} × ${pattaCount}) xavfsiz butun son bo'lishi kerak.`;
        addNotification('error', 'Jami ish soni xato!', message);
        return;
      }
    }

    const itemsToPrint: PrintBatchItem[] = models
      .filter((m) => (normalizedSizesByModelId.get(m.id)?.pattaCount || 0) > 0)
      .map((m) => {
        const cfg = pattaBatchConfigs[m.id] || { sizes: {}, totalIshSoni: '', color: m.color || 'Кора' };
        const normalizedSizes = normalizedSizesByModelId.get(m.id)!.sizes;
        return {
          model: m,
          partyNumber: effectiveParties[m.id] || '1',
          sizes: Object.fromEntries(Object.entries(normalizedSizes).map(([size, count]) => [size, String(count)])),
          ishSoniPerPatta: cfg.totalIshSoni || '',
          color: cfg.color || m.color || 'Кора'
        };
      });

    if (itemsToPrint.length > 0) {
      setPrintBatchItems(itemsToPrint);
    }
  };

  const getFieldOrder = (modelId: string) => {
    return [
      `ish_soni_${modelId}`,
      `party_${modelId}`,
      `color_${modelId}`,
      ...activeSizes.map((size) => `size_${modelId}_${size}`)
    ];
  };

  const handleInputKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    model: ModelConfig,
    currentKey: string
  ) => {
    const order = getFieldOrder(model.id);
    const currentIndex = order.indexOf(currentKey);

    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIndex = currentIndex + 1;
      if (nextIndex < order.length) {
        const nextKey = order[nextIndex];
        inputRefs.current[nextKey]?.focus();
        inputRefs.current[nextKey]?.select();
      } else {
        const modelIdx = models.findIndex((m) => m.id === model.id);
        if (modelIdx < models.length - 1) {
          const nextModel = models[modelIdx + 1];
          const nextModelFirstKey = `ish_soni_${nextModel.id}`;
          inputRefs.current[nextModelFirstKey]?.focus();
          inputRefs.current[nextModelFirstKey]?.select();
        }
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIndex = currentIndex - 1;
      if (prevIndex >= 0) {
        const prevKey = order[prevIndex];
        inputRefs.current[prevKey]?.focus();
        inputRefs.current[prevKey]?.select();
      }
    }
  };

  const handleAddCustomSizeSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const clean = newCustomSizeInput.trim();
    if (!clean) return;
    await guardedAddCustomSize(clean);
    if (useWorkbookStore.getState().availableSizes.some((size) => size.toUpperCase() === clean.toUpperCase())) {
      setNewCustomSizeInput('');
      setIsAddSizeModalOpen(false);
    }
  };

  // Barcha modellar bo'yicha saralangan partiya, patta va ish soni statistikasi
  const modelsSummaryList = useMemo(() => {
    const modelMap = new Map<string, { modelId: string; modelName: string; partyCount: number; pattaCount: number; ishSoni: number }>();

    for (const m of models) {
      modelMap.set(m.id, {
        modelId: m.id,
        modelName: m.name,
        partyCount: 0,
        pattaCount: 0,
        ishSoni: 0
      });
    }

    for (const h of printedPartyHistory || []) {
      const existing = modelMap.get(h.modelId);
      const pCount = h.pattaCount || 0;
      const ish = h.totalIshSoni || h.ishSoni || (pCount * (h.ishSoniPerPatta || 0));

      if (existing) {
        existing.partyCount += 1;
        existing.pattaCount += pCount;
        existing.ishSoni += ish;
      } else {
        modelMap.set(h.modelId, {
          modelId: h.modelId,
          modelName: h.modelName || h.modelId,
          partyCount: 1,
          pattaCount: pCount,
          ishSoni: ish
        });
      }
    }

    return Array.from(modelMap.values()).sort((a, b) =>
      a.modelName.localeCompare(b.modelName, 'uz', { numeric: true, sensitivity: 'base' })
    );
  }, [models, printedPartyHistory]);

  const grandTotals = useMemo(() => {
    return modelsSummaryList.reduce(
      (acc, item) => {
        acc.parties += item.partyCount;
        acc.pattas += item.pattaCount;
        acc.ishSoni += item.ishSoni;
        return acc;
      },
      { parties: 0, pattas: 0, ishSoni: 0 }
    );
  }, [modelsSummaryList]);

  // Active unclosed parties and their unsubmitted pattas count for warning dialog
  const activeUnclosedParties = useMemo(() => {
    return (printedPartyHistory || []).filter((h) => !h.isClosed);
  }, [printedPartyHistory]);

  const pendingPattasCount = useMemo(() => {
    let count = 0;
    for (const p of activeUnclosedParties) {
      const tickets = buildPartyTicketsList(p, submittedTickets || [], allKnownSizes);
      const unsubmitted = tickets.filter((t) => !t.isSubmitted).length;
      count += unsubmitted;
    }
    return count;
  }, [activeUnclosedParties, submittedTickets, allKnownSizes]);

  return (
    <div className="excel-grid-container" style={{ padding: '16px 20px', backgroundColor: 'var(--bg-app)', overflowY: 'auto' }}>
      
      {/* Top Global Action Bar */}
      <div 
        style={{ 
          width: '100%', 
          marginBottom: '16px',
          background: 'var(--bg-surface)', 
          border: '1px solid var(--border-subtle)', 
          borderRadius: 'var(--radius-xl)', 
          padding: '12px 20px',
          boxShadow: 'var(--shadow-sm)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '12px'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
          <div style={{
            background: 'var(--primary-light)',
            color: 'var(--primary)',
            padding: '6px 12px',
            borderRadius: 'var(--radius-full)',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontWeight: 800,
            fontSize: '13px'
          }}>
            <Layers size={16} />
            <span>Pattalar Pechati (Partiyalar)</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)' }}>Razmer turi:</span>
            <div
              role="group"
              aria-label="Razmer turi"
              title="Tanlangan turdagi razmerlar ko‘rsatiladi; boshqa turdagi qiymatlar saqlanib qoladi."
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '3px',
                padding: '3px',
                borderRadius: 'var(--radius-full)',
                background: 'var(--bg-surface-subtle)',
                border: '1px solid var(--border-subtle)'
              }}
            >
              {([
                { value: 'letters', label: 'Harfli (S, M, L)' },
                { value: 'numbers', label: 'Raqamli (36, 38, 40)' }
              ] as const).map((option) => {
                const selected = sizeSystem === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setSizeSystem(option.value)}
                    style={{
                      border: 'none',
                      borderRadius: 'var(--radius-full)',
                      padding: '6px 10px',
                      background: selected ? 'var(--primary)' : 'transparent',
                      color: selected ? '#fff' : 'var(--text-secondary)',
                      fontSize: '11px',
                      fontWeight: 700,
                      whiteSpace: 'nowrap',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease'
                    }}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ fontSize: '13px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '14px' }}>
            <span>To'ldirilgan: <strong style={{ color: filledModelsCount > 0 ? 'var(--primary)' : 'var(--text-primary)' }}>{filledModelsCount} ta model</strong></span>
            <span>Jami patta: <strong style={{ color: totalBatchPattas > 0 ? '#4f46e5' : 'var(--text-primary)' }}>{totalBatchPattas} ta</strong></span>
            {totalBatchPattas > 0 && (
              <span style={{ color: 'var(--primary)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                <CheckCircle2 size={15} /> ({Math.ceil(totalBatchPattas / 2)} ta A4 varaq)
              </span>
            )}
            {missingIshSoniModels.length > 0 && (
              <span style={{
                color: '#dc2626',
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                background: '#fee2e2',
                padding: '4px 10px',
                borderRadius: 'var(--radius-full)'
              }}>
                <AlertCircle size={14} /> {missingIshSoniModels.length} ta modelda Ish soni kiritilmagan!
              </span>
            )}
          </div>
        </div>

        {/* Global Action Buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          {/* Partiyani yakunlash tugmasi */}
          <button
            type="button"
            onClick={() => setIsClosePartyModalOpen(true)}
            className="soft-btn"
            style={{
              borderRadius: 'var(--radius-full)',
              padding: '8px 18px',
              fontSize: '13px',
              fontWeight: 600,
              background: 'var(--bg-surface-subtle)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border-subtle)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '7px',
              transition: 'all 0.15s ease'
            }}
            title="Joriy partiyalar turkumini yakunlash va partiya/patta raqamini 1 dan boshlash"
          >
            <CheckCircle2 size={16} color="#10b981" />
            <span>Partiyani yakunlash</span>
          </button>

          {/* Global Print Action Button */}
          <button
            onClick={handleOpenBatchPrint}
            disabled={!canAttemptBatchPrint}
            className="soft-btn soft-btn-primary"
            style={{
              borderRadius: 'var(--radius-full)',
              padding: '8px 22px',
              fontSize: '13.5px',
              background: !canAttemptBatchPrint
                ? 'var(--bg-surface-subtle)'
                : invalidPattaSizeModels.length > 0 || missingIshSoniModels.length > 0
                ? 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)'
                : undefined,
              color: canAttemptBatchPrint ? '#ffffff' : 'var(--text-muted)',
              cursor: canAttemptBatchPrint ? 'pointer' : 'not-allowed',
              opacity: canAttemptBatchPrint ? 1 : 0.6
            }}
            title={
              !canAttemptBatchPrint
                ? 'Kamida bitta modelga razmer kiriting' 
                : invalidPattaSizeModels.length > 0
                ? 'Razmer sonlarida xatolik bor!'
                : missingIshSoniModels.length > 0 
                ? 'Ish soni kiritilmagan modellar bor!' 
                : `Barcha to'ldirilgan modellarni chop etish (${totalBatchPattas} ta patta)`
            }
          >
            <Printer size={16} />
            <span>
              {invalidPattaSizeModels.length > 0
                ? `Razmerlarni tekshiring (${invalidPattaSizeModels.length})`
                : missingIshSoniModels.length > 0
                ? `Ish sonini kiriting (${missingIshSoniModels.length})`
                : `Pechat (${totalBatchPattas} ta patta)`}
            </span>
          </button>
        </div>
      </div>

      {/* Grid of All Model Cards */}
      <div 
        style={{ 
          width: '100%', 
          display: 'grid', 
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', 
          gap: '12px' 
        }}
      >
        {models.map((model) => {
          const config = pattaBatchConfigs[model.id] || {
            partyNumber: '',
            isCustomParty: false,
            totalIshSoni: '',
            color: model.color || 'Кора',
            sizes: {}
          };
          const totalPattaCount = getTotalPattaCount(model.id);
          const currentParty = effectiveParties[model.id] || String(nextPartyNumber || 1);
          const partyConflictError = partyConflicts[model.id];

          const ishSoniPerPatta = Number(config.totalIshSoni);
          const isIshSoniMissing = totalPattaCount > 0 && !config.totalIshSoni?.trim();
          let totalIshCalculated = 0;
          if (totalPattaCount > 0 && Number.isSafeInteger(ishSoniPerPatta) && ishSoniPerPatta > 0) {
            try {
              totalIshCalculated = calculateBatchWorkQuantities(ishSoniPerPatta, totalPattaCount).totalIshSoni;
            } catch {}
          }

          return (
            <div 
              key={model.id}
              style={{
                background: 'var(--bg-surface)',
                border: partyConflictError
                  ? '1.5px solid #ef4444'
                  : isIshSoniMissing 
                  ? '1.5px solid #ef4444' 
                  : totalPattaCount > 0 
                  ? '1.5px solid var(--primary)' 
                  : '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-lg)',
                boxShadow: totalPattaCount > 0 ? 'var(--shadow-md)' : 'var(--shadow-xs)',
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)'
              }}
            >
              {/* Card Header */}
              <div 
                style={{ 
                  padding: '10px 14px', 
                  background: isIshSoniMissing 
                    ? 'rgba(239, 68, 68, 0.15)' 
                    : totalPattaCount > 0 
                    ? 'var(--primary-light)' 
                    : 'var(--bg-surface-subtle)', 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'space-between',
                  gap: '6px'
                }}
              >
                <span 
                  style={{ 
                    fontWeight: 800, 
                    fontSize: '13px', 
                    color: isIshSoniMissing ? '#ef4444' : totalPattaCount > 0 ? 'var(--primary)' : 'var(--text-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                  title={model.title || model.name}
                >
                  {model.name}
                </span>
                <span style={{
                  fontSize: '11px',
                  color: 'var(--text-secondary)',
                  fontWeight: 600,
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border-subtle)',
                  padding: '2px 8px',
                  borderRadius: 'var(--radius-full)'
                }}>
                  {model.operations.length} op
                </span>
              </div>

              {/* Form Controls */}
              <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px', flex: 1 }}>
                {/* 1. Ish Soni */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <label style={{ width: '60px', fontSize: '11px', fontWeight: 700, color: isIshSoniMissing ? '#ef4444' : 'var(--text-secondary)' }}>
                    1 patta ish:
                  </label>
                  <input
                    ref={(el) => { inputRefs.current[`ish_soni_${model.id}`] = el; }}
                    type="number"
                    min="1"
                    value={config.totalIshSoni || ''}
                     onChange={(e) => guardedUpdateBatchConfig(model.id, { totalIshSoni: e.target.value })}
                    onKeyDown={(e) => handleInputKeyDown(e, model, `ish_soni_${model.id}`)}
                    placeholder=""
                    className="soft-input"
                    style={{
                      height: '28px',
                      textAlign: 'center',
                      fontWeight: 800,
                      fontSize: '12px',
                      color: isIshSoniMissing ? '#ef4444' : 'var(--primary)',
                      borderColor: isIshSoniMissing ? '#ef4444' : undefined,
                      backgroundColor: isIshSoniMissing ? 'rgba(239, 68, 68, 0.15)' : undefined
                    }}
                  />
                </div>

                {/* 2. Party */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <label style={{ width: '60px', fontSize: '11px', fontWeight: 700, color: partyConflictError ? '#ef4444' : 'var(--text-secondary)' }}>
                      Partiya:
                    </label>
                    <input
                      ref={(el) => { inputRefs.current[`party_${model.id}`] = el; }}
                      type="text"
                      value={config.isCustomParty && config.partyNumber ? config.partyNumber : currentParty}
                      onChange={(e) => {
                        const val = e.target.value;
                         guardedUpdateBatchConfig(model.id, {
                          partyNumber: val,
                          isCustomParty: val.trim() !== ''
                        });
                      }}
                      onKeyDown={(e) => handleInputKeyDown(e, model, `party_${model.id}`)}
                      className="soft-input"
                      style={{
                        height: '28px',
                        textAlign: 'center',
                        fontWeight: 700,
                        fontSize: '12px',
                        borderColor: partyConflictError ? '#ef4444' : undefined,
                        backgroundColor: partyConflictError ? 'rgba(239, 68, 68, 0.12)' : undefined,
                        color: partyConflictError ? '#ef4444' : undefined
                      }}
                    />
                  </div>
                  {partyConflictError && (
                    <div style={{ fontSize: '10.5px', color: '#ef4444', fontWeight: 700, marginLeft: '66px', marginTop: '1px' }}>
                      ⚠️ {partyConflictError}
                    </div>
                  )}
                </div>

                {/* 3. Color */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <label style={{ width: '60px', fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)' }}>
                    Rang:
                  </label>
                  <input
                    ref={(el) => { inputRefs.current[`color_${model.id}`] = el; }}
                    type="text"
                    value={config.color !== undefined ? config.color : (model.color || 'Кора')}
                    onChange={(e) => guardedUpdateBatchConfig(model.id, { color: e.target.value })}
                    onKeyDown={(e) => handleInputKeyDown(e, model, `color_${model.id}`)}
                    placeholder=""
                    className="soft-input"
                    style={{ height: '28px', textAlign: 'center', fontWeight: 600, fontSize: '12px' }}
                  />
                </div>

                {/* Metric Summary Pill */}
                <div style={{
                  padding: '6px 10px',
                  borderRadius: 'var(--radius-md)',
                  backgroundColor: totalPattaCount > 0 ? 'var(--primary-light)' : 'var(--bg-surface-subtle)',
                  color: totalPattaCount > 0 ? 'var(--primary)' : 'var(--text-secondary)',
                  textAlign: 'center',
                  fontSize: '11.5px',
                  fontWeight: 700
                }}>
                  <div>Patta: <strong>{totalPattaCount} ta</strong></div>
                  {totalIshCalculated > 0 && (
                    <div style={{ fontSize: '10.5px', color: 'var(--text-primary)', marginTop: '2px' }}>
                      Jami ish soni: {totalIshCalculated.toLocaleString()} dona
                    </div>
                  )}
                </div>

                {/* Sizes Matrix */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '2px' }}>
                  {activeSizes.map((sizeName) => {
                    const sizeVal = config.sizes ? config.sizes[sizeName] || '' : '';
                    const key = `size_${model.id}_${sizeName}`;
                    const isCustom = !isDefaultPattaSize(sizeName);

                    return (
                      <div key={sizeName} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <div style={{
                          width: '60px',
                          fontSize: '11.5px',
                          fontWeight: 700,
                          color: isCustom ? '#818cf8' : 'var(--text-primary)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between'
                        }}>
                          <span>{sizeName}</span>
                          {isCustom && (
                            <button
                              type="button"
                              onClick={async (e) => {
                                e.stopPropagation();
                                const ok = await confirmAction({
                                  title: "Razmerni o'chirish",
                                  message: `«${sizeName}» razmerini o'chirmoqchimisiz?`,
                                  confirmText: "Ha, o'chirilsin",
                                  isDanger: true
                                });
                                if (ok) {
                                   await guardedDeleteCustomSize(sizeName);
                                }
                              }}
                              style={{ border: 'none', background: 'transparent', color: '#ef4444', cursor: 'pointer', padding: '0 2px' }}
                              title={`«${sizeName}» razmerini o'chirish`}
                            >
                              <X size={11} />
                            </button>
                          )}
                        </div>
                        <input
                          ref={(el) => { inputRefs.current[key] = el; }}
                          type="number"
                          min="0"
                          value={sizeVal}
                          onChange={(e) => guardedUpdateBatchSize(model.id, sizeName, e.target.value)}
                          onKeyDown={(e) => handleInputKeyDown(e, model, key)}
                          placeholder=""
                          className="soft-input"
                          style={{
                            height: '26px',
                            textAlign: 'center',
                            fontWeight: 700,
                            fontSize: '12px',
                            backgroundColor: sizeVal ? 'var(--primary-light)' : 'transparent',
                            borderColor: sizeVal ? 'var(--primary)' : 'var(--border-subtle)',
                            color: sizeVal ? 'var(--primary)' : 'var(--text-primary)'
                          }}
                        />
                      </div>
                    );
                  })}

                  {/* Add Size Trigger */}
                  <button
                    type="button"
                    onClick={() => {
                      setNewCustomSizeInput('');
                      setIsAddSizeModalOpen(true);
                      setTimeout(() => customSizeInputRef.current?.focus(), 50);
                    }}
                    style={{
                      marginTop: '4px',
                      padding: '5px',
                      background: 'transparent',
                      border: '1px dashed var(--border-default)',
                      borderRadius: 'var(--radius-sm)',
                      color: 'var(--primary)',
                      fontSize: '11px',
                      fontWeight: 700,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '4px'
                    }}
                  >
                    <Plus size={12} />
                    <span>Razmer qo'shish</span>
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Barcha modellar bo'yicha partiya, patta va ish soni statistikasi */}
      <div style={{
        marginTop: '28px',
        background: 'var(--bg-surface)',
        borderRadius: 'var(--radius-xl)',
        boxShadow: 'var(--shadow-md)',
        border: '1px solid var(--border-subtle)',
        overflow: 'hidden'
      }}>
        {/* Header */}
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
              color: 'var(--primary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              <TrendingUp size={18} />
            </div>
            <div>
              <h3 style={{ fontSize: '14px', fontWeight: 800, margin: 0, color: 'var(--text-primary)' }}>
                Barcha modellar bo'yicha partiya, patta va ish soni statistikasi
              </h3>
              <p style={{ fontSize: '11.5px', color: 'var(--text-muted)', margin: 0 }}>
                Modellar kesimida chiqarilgan partiyalar, pattalar va jami ish soni xulosasi
              </p>
            </div>
          </div>

          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            fontSize: '12px',
            fontWeight: 700,
            background: 'var(--bg-surface-subtle)',
            padding: '6px 14px',
            borderRadius: 'var(--radius-full)',
            border: '1px solid var(--border-subtle)'
          }}>
            <span>Jami: <strong style={{ color: 'var(--text-primary)' }}>{modelsSummaryList.length} ta model</strong></span>
            <span style={{ color: 'var(--border-subtle)' }}>•</span>
            <span><strong style={{ color: '#818cf8' }}>{grandTotals.parties} ta</strong> partiya</span>
            <span style={{ color: 'var(--border-subtle)' }}>•</span>
            <span><strong style={{ color: '#10b981' }}>{grandTotals.pattas} ta</strong> patta</span>
            <span style={{ color: 'var(--border-subtle)' }}>•</span>
            <span><strong style={{ color: 'var(--primary)' }}>{grandTotals.ishSoni.toLocaleString()} dona</strong> ish</span>
          </div>
        </div>

        {/* Table */}
        <div style={{ overflowX: 'auto' }}>
          <table className="excel-table" style={{ width: '100%' }}>
            <thead>
              <tr style={{ height: '36px', background: 'var(--bg-surface-subtle)' }}>
                <th className="col-header" style={{ width: '50px', textAlign: 'center' }}>№</th>
                <th className="col-header" style={{ textAlign: 'left', paddingLeft: '16px' }}>Model nomi</th>
                <th className="col-header" style={{ textAlign: 'right', width: '180px', color: '#818cf8' }}>Partiya soni</th>
                <th className="col-header" style={{ textAlign: 'right', width: '180px', color: '#10b981' }}>Patta soni</th>
                <th className="col-header" style={{ textAlign: 'right', width: '220px', color: 'var(--primary)' }}>Jami Ish soni</th>
              </tr>
            </thead>
            <tbody>
              {modelsSummaryList.map((item, idx) => {
                const hasData = item.partyCount > 0;

                return (
                  <tr
                    key={item.modelId}
                    style={{
                      height: '38px',
                      backgroundColor: idx % 2 === 0 ? 'var(--bg-surface)' : 'var(--bg-surface-subtle)',
                      transition: 'background-color 0.15s'
                    }}
                  >
                    <td style={{ textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)' }}>
                      {idx + 1}
                    </td>
                    <td style={{ paddingLeft: '16px', fontWeight: 700, fontSize: '13px', color: 'var(--text-primary)' }}>
                      {item.modelName}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, fontSize: '12.5px', color: hasData ? '#818cf8' : 'var(--text-muted)' }}>
                      {hasData ? `${item.partyCount} ta` : '0 ta'}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, fontSize: '12.5px', color: hasData ? '#10b981' : 'var(--text-muted)' }}>
                      {hasData ? `${item.pattaCount} ta` : '0 ta'}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 800, fontSize: '13px', color: hasData ? 'var(--primary)' : 'var(--text-muted)' }}>
                      {hasData ? `${item.ishSoni.toLocaleString()} dona` : '0 dona'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ height: '40px', background: 'var(--bg-surface-subtle)', borderTop: '2px solid var(--border-subtle)', fontWeight: 800 }}>
                <td colSpan={2} style={{ paddingLeft: '16px', fontSize: '13px', color: 'var(--text-primary)' }}>
                  ЖАМИ (Барча моделлар):
                </td>
                <td style={{ textAlign: 'right', fontSize: '13px', color: '#818cf8' }}>
                  {grandTotals.parties} ta
                </td>
                <td style={{ textAlign: 'right', fontSize: '13px', color: '#10b981' }}>
                  {grandTotals.pattas} ta
                </td>
                <td style={{ textAlign: 'right', fontSize: '13.5px', color: 'var(--primary)' }}>
                  {grandTotals.ishSoni.toLocaleString()} dona
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Add Custom Size Modal */}
      {isAddSizeModalOpen && (
        <div className="modal-overlay" onClick={() => setIsAddSizeModalOpen(false)}>
          <div className="modal-card" style={{ maxWidth: '400px' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--primary)' }}>
                <Plus size={18} />
                <span>Yangi Razmer Qo'shish</span>
              </div>
              <button onClick={() => setIsAddSizeModalOpen(false)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)' }}>
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleAddCustomSizeSubmit} style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                  Razmer nomi (masalan: 4XL, 5XL, 40-42, Standart):
                </label>
                <input 
                  ref={customSizeInputRef}
                  type="text"
                  value={newCustomSizeInput}
                  onChange={(e) => setNewCustomSizeInput(e.target.value)}
                  placeholder="Masalan: 40-42"
                  className="soft-input"
                />
              </div>

              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                Ushbu razmer barcha modellarning patta jadvallariga avtomatik qo'shiladi.
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '6px' }}>
                <button type="button" onClick={() => setIsAddSizeModalOpen(false)} className="soft-btn soft-btn-secondary">
                  Bekor qilish
                </button>
                <button type="submit" disabled={!newCustomSizeInput.trim()} className="soft-btn soft-btn-primary">
                  Qo'shish
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Confirm Close Party Series Modal */}
      {isClosePartyModalOpen && (
        <div 
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.55)',
            backdropFilter: 'blur(3px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: '20px'
          }}
          onClick={() => !isClosingParty && setIsClosePartyModalOpen(false)}
        >
          <div 
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-xl)',
              padding: '24px',
              width: '100%',
              maxWidth: '480px',
              boxShadow: 'var(--shadow-xl)',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: 'var(--radius-full)',
                  background: 'rgba(16, 185, 129, 0.15)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#10b981'
                }}>
                  <CheckCircle2 size={20} />
                </div>
                <h3 style={{ margin: 0, fontSize: '17px', fontWeight: 800, color: 'var(--text-primary)' }}>
                  Partiyani yakunlash
                </h3>
              </div>
              <button 
                type="button"
                onClick={() => !isClosingParty && setIsClosePartyModalOpen(false)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
              >
                <X size={18} />
              </button>
            </div>

            <div style={{ fontSize: '13.5px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              Haqiqatan ham joriy partiyalar turkumini yakunlab, yangi turkumni <strong>Partiya 1</strong> va <strong>Patta 1</strong> dan boshlamoqchimisiz?
            </div>

            <div style={{
              background: 'var(--bg-surface-subtle)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)',
              padding: '12px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              fontSize: '12.5px'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-primary)' }}>
                <span style={{ color: '#10b981', fontWeight: 700 }}>✓</span>
                <span>Navbatdagi partiya raqami <strong>1</strong> ga qaytariladi</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-primary)' }}>
                <span style={{ color: '#10b981', fontWeight: 700 }}>✓</span>
                <span>Keyingi chop etiladigan patta raqami <strong>№ 1</strong> dan boshlanadi</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-primary)' }}>
                <span style={{ color: '#10b981', fontWeight: 700 }}>✓</span>
                <span>Barcha modellarning kiritilgan razmer va sonlari tozalanadi</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)' }}>
                <span style={{ color: '#6366f1', fontWeight: 700 }}>ℹ</span>
                <span>Oldingi barcha partiyalar va kiritilgan pattalar «Patta hisobi»da saqlanadi</span>
              </div>
            </div>

            {pendingPattasCount > 0 && (
              <div style={{
                background: '#fffbeb',
                border: '1px solid #fef3c7',
                borderRadius: 'var(--radius-lg)',
                padding: '10px 14px',
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                fontSize: '12.5px',
                color: '#b45309'
              }}>
                <AlertCircle size={18} style={{ flexShrink: 0 }} />
                <span>
                  <strong>Diqqat:</strong> Joriy partiyalarda hali kiritilmagan <strong>{pendingPattasCount} ta patta</strong> mavjud. Yakunlangandan keyin ham ularning hisoboti «Patta hisobi» bo'limida to'liq saqlanadi.
                </span>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '8px' }}>
              <button 
                type="button" 
                onClick={() => setIsClosePartyModalOpen(false)} 
                disabled={isClosingParty}
                className="soft-btn soft-btn-secondary"
                style={{ padding: '8px 16px', fontSize: '13px' }}
              >
                Bekor qilish
              </button>
              <button 
                type="button" 
                onClick={async () => {
                  setIsClosingParty(true);
                  try {
                     if (canUseBatchMutation()) {
                       await completePartySeries();
                       setIsClosePartyModalOpen(false);
                     }
                  } finally {
                    setIsClosingParty(false);
                  }
                }}
                disabled={isClosingParty}
                className="soft-btn"
                style={{
                  padding: '8px 20px',
                  fontSize: '13px',
                  fontWeight: 700,
                  background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: 'var(--radius-md)',
                  cursor: isClosingParty ? 'wait' : 'pointer'
                }}
              >
                {isClosingParty ? "Yakunlanmoqda..." : "Ha, yakunlash (1 dan boshlash)"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Print Modal */}
      {printBatchItems && printBatchItems.length > 0 && (
        <PattaPrintModal
          items={printBatchItems}
          onPrinted={(printedSummary) => {
             guardedBatchPrintCompleted(printedSummary);
          }}
          onClose={() => setPrintBatchItems(null)}
        />
      )}

    </div>
  );
};
