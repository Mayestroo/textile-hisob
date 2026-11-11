import React, { useState, useRef, useMemo, useEffect } from 'react';
import { useWorkbookStore, DEFAULT_BATCH_SIZES } from '../../store/workbookStore';
import { Printer, Plus, X, CheckCircle2, AlertCircle, Pencil, Search } from 'lucide-react';
import { PattaPrintModal, PrintBatchItem } from './modals/PattaPrintModal';
import { ModelConfig } from '../../types/workbook';
import { buildPartyTicketsList } from '../../domain/partyAnalytics';
import { calculateBatchWorkQuantities, normalizePattaSizeCounts } from '../../domain/pattaQuantity';
import { isDefaultPattaSize, PattaSizeSystem, sortPattaSizes, DEFAULT_NUMERIC_BATCH_SIZES } from '../../domain/pattaSizeSystem';
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
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'filled' | 'empty'>('all');

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

  const guardedAddCustomSize = (modelId: string, sizeName: string) => addCustomSize(modelId, sizeName);
  const guardedDeleteCustomSize = (modelId: string, sizeName: string) => deleteCustomSize(modelId, sizeName);
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

  const getModelSizes = (modelId: string) => {
    const config = pattaBatchConfigs[modelId];
    if (config && config.isConfigured !== false && Array.isArray(config.sizeNames) && config.sizeNames.length > 0) {
      // Model has explicitly configured sizes in ModelSizesView!
      const activeFromConfig = config.sizeNames;
      const withCounts = Object.entries(config.sizes || {})
        .filter(([, count]) => Number(count) > 0)
        .map(([size]) => size);
      return sortPattaSizes(Array.from(new Set([...activeFromConfig, ...withCounts])));
    }

    // Fallback for unconfigured models:
    const scale = config?.scaleType || (sizeSystem === 'numbers' ? 'numbers' : 'letters');
    if (scale === 'numbers') {
      const withCounts = Object.entries(config?.sizes || {})
        .filter(([, count]) => Number(count) > 0)
        .map(([size]) => size);
      return sortPattaSizes(Array.from(new Set([...DEFAULT_NUMERIC_BATCH_SIZES, ...withCounts])));
    }
    const withCounts = Object.entries(config?.sizes || {})
      .filter(([, count]) => Number(count) > 0)
      .map(([size]) => size);
    return sortPattaSizes(Array.from(new Set([...(availableSizes?.length ? availableSizes : DEFAULT_BATCH_SIZES), ...withCounts])));
  };
  const allKnownSizes = useMemo(() => sortPattaSizes([...new Set(models.flatMap((model) => getModelSizes(model.id)))]), [models, pattaBatchConfigs, availableSizes, sizeSystem]);

  const getActiveSizeValues = (modelId: string) => {
    const savedSizes = pattaBatchConfigs[modelId]?.sizes || {};
    return Object.fromEntries(getModelSizes(modelId).map((size) => [size, savedSizes[size] || '']));
  };

  const [printBatchItems, setPrintBatchItems] = useState<PrintBatchItem[] | null>(null);
  const [isAddSizeModalOpen, setIsAddSizeModalOpen] = useState(false);
  const [addSizeModelId, setAddSizeModelId] = useState<string | null>(null);
  const [renameSize, setRenameSize] = useState<{ modelId: string; sizeName: string } | null>(null);
  const [renameSizeInput, setRenameSizeInput] = useState('');
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

    // 1. Gather all existing party numbers in the current series (both active and closed from previous months)
    const seriesHistory = (printedPartyHistory || []).filter((h) => h.isArchived !== true);
    const existingSeriesPartyNumbers = new Set<string>();
    let maxExistingPartyNum = 0;
    for (const h of seriesHistory) {
      const pStr = String(h.partyNumber || '').trim();
      if (pStr) {
        existingSeriesPartyNumbers.add(pStr);
        const pInt = parseInt(pStr, 10);
        if (!isNaN(pInt) && pInt > maxExistingPartyNum) {
          maxExistingPartyNum = pInt;
        }
      }
    }

    const usedPartyNumbers = new Set<string>(existingSeriesPartyNumbers);
    const customNumbersEntered = new Map<string, string>(); // partyNumber -> firstModelId

    // 2. Check custom numbers entered by user
    for (const m of models) {
      const cfg = pattaBatchConfigs[m.id];
      if (cfg?.isCustomParty && cfg?.partyNumber && cfg.partyNumber.trim() !== '') {
        const val = cfg.partyNumber.trim();
        parties[m.id] = val;

        // Check collision with existing printed history of current series
        if (existingSeriesPartyNumbers.has(val)) {
          conflicts[m.id] = `Partiya ${val} allaqachon joriy turkumda mavjud!`;
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

    let partyCounter = Math.max(1, maxExistingPartyNum + 1);

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

    // 4. For unfilled models, show what the prospective sequential numbers would be (continuing forward)
    let prospectiveCounter = partyCounter;
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
  }, [models, pattaBatchConfigs, nextPartyNumber, printedPartyHistory, availableSizes, sizeSystem]);

  const totalBatchPattas = useMemo(() => {
    let total = 0;
    for (const m of models) {
      total += getTotalPattaCount(m.id);
    }
    return total;
  }, [models, pattaBatchConfigs, availableSizes, sizeSystem]);

  const filledModelsCount = useMemo(() => {
    return models.filter((m) => getTotalPattaCount(m.id) > 0).length;
  }, [models, pattaBatchConfigs, availableSizes, sizeSystem]);

  const filteredModels = useMemo(() => {
    return models.filter((model) => {
      if (searchQuery.trim() && !model.name.toLowerCase().includes(searchQuery.toLowerCase().trim())) {
        return false;
      }
      const pCount = getTotalPattaCount(model.id);
      if (statusFilter === 'filled') return pCount > 0;
      if (statusFilter === 'empty') return pCount === 0;
      return true;
    });
  }, [models, searchQuery, statusFilter, pattaBatchConfigs, availableSizes, sizeSystem]);

  const missingIshSoniModels = useMemo(() => {
    return models.filter((m) => {
      const pCount = getTotalPattaCount(m.id);
      if (pCount === 0) return false;
      return !pattaBatchConfigs[m.id]?.totalIshSoni?.trim();
    });
  }, [models, pattaBatchConfigs, availableSizes, sizeSystem]);

  const missingColorModels = useMemo(() => {
    return models.filter((m) => {
      const pCount = getTotalPattaCount(m.id);
      if (pCount === 0) return false;
      const col = pattaBatchConfigs[m.id]?.color;
      return !col || !col.trim();
    });
  }, [models, pattaBatchConfigs, availableSizes, sizeSystem]);

  const invalidPattaSizeModels = useMemo(() => {
    return models.filter((model) => {
      try {
        normalizePattaSizeCounts(getActiveSizeValues(model.id));
        return false;
      } catch {
        return true;
      }
    });
  }, [models, pattaBatchConfigs, availableSizes, sizeSystem]);

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

    if (missingColorModels.length > 0) {
      const firstMissing = missingColorModels[0];
      inputRefs.current[`color_${firstMissing.id}`]?.focus();
      inputRefs.current[`color_${firstMissing.id}`]?.select();
      addNotification(
        'warning',
        'Rang kiritilishi shart!',
        `Quyidagi model(lar) uchun "Rang" kiritilmagan: ${missingColorModels.map((m: ModelConfig) => m.name).join(', ')}`
      );
      return;
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
        const cfg = pattaBatchConfigs[m.id] || { sizes: {}, totalIshSoni: '', color: '' };
        const normalizedSizes = normalizedSizesByModelId.get(m.id)!.sizes;
        const modelOrderedSizes = sortPattaSizes(
          getModelSizes(m.id).filter((size) => Number(normalizedSizes[size] || 0) > 0)
        );
        return {
          model: m,
          partyNumber: effectiveParties[m.id] || '1',
          sizes: Object.fromEntries(modelOrderedSizes.map((size) => [size, String(normalizedSizes[size])])),
          sizeOrder: modelOrderedSizes,
          ishSoniPerPatta: cfg.totalIshSoni || '',
          color: cfg.color?.trim() || ''
        };
      });

    if (itemsToPrint.length > 0) {
      setPrintBatchItems(itemsToPrint);
    }
  };

  const getFieldOrder = (modelId: string) => {
    return [
      `color_${modelId}`,
      `ish_soni_${modelId}`,
      ...getModelSizes(modelId).map((size) => `size_${modelId}_${size}`)
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
          const nextModelFirstKey = `color_${nextModel.id}`;
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
    if (!addSizeModelId) return;
    await guardedAddCustomSize(addSizeModelId, clean);
    if (useWorkbookStore.getState().pattaBatchConfigs[addSizeModelId]?.sizeNames?.some((size) => size.toUpperCase() === clean.toUpperCase())) {
      setNewCustomSizeInput('');
      setIsAddSizeModalOpen(false);
    }
  };


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
    <div className="patta-batch-container">
      {/* 1. Header */}
      <div className="patta-batch-header">
        <div>
          <h1 className="patta-batch-title">Pattalar pechati</h1>
          <p className="patta-batch-subtitle">
            Partiya bo'yicha razmerlarni kiriting, keyin pattalarni chop eting
          </p>
        </div>

        <div className="patta-batch-actions">
          {/* Partiyani yakunlash */}
          <button
            type="button"
            onClick={() => setIsClosePartyModalOpen(true)}
            className="patta-batch-btn-secondary"
            title="Joriy partiyalar turkumini yakunlash va partiya/patta raqamini 1 dan boshlash"
          >
            <CheckCircle2 size={16} />
            <span>Partiyani yakunlash</span>
          </button>

          {/* Pechat · X ta patta */}
          <button
            type="button"
            onClick={handleOpenBatchPrint}
            disabled={!canAttemptBatchPrint}
            className="patta-batch-btn-primary"
            title={
              !canAttemptBatchPrint
                ? 'Kamida bitta modelga razmer kiriting'
                : invalidPattaSizeModels.length > 0
                ? 'Razmer sonlarida xatolik bor!'
                : missingColorModels.length > 0
                ? 'Rang kiritilmagan modellar bor!'
                : missingIshSoniModels.length > 0
                ? 'Ish soni kiritilmagan modellar bor!'
                : `Barcha to'ldirilgan modellarni chop etish (${totalBatchPattas} ta patta)`
            }
          >
            <Printer size={16} />
            <span>
              {invalidPattaSizeModels.length > 0
                ? `Razmerlarni tekshiring (${invalidPattaSizeModels.length})`
                : missingColorModels.length > 0
                ? `Rangni kiriting (${missingColorModels.length})`
                : missingIshSoniModels.length > 0
                ? `Ish sonini kiriting (${missingIshSoniModels.length})`
                : `Pechat · ${totalBatchPattas} ta patta`}
            </span>
          </button>
        </div>
      </div>

      {/* 2. Controls / Filter Toolbar */}
      <div className="patta-batch-toolbar">
        <div className="patta-batch-toolbar-left">
          {/* Razmer turi */}
          <div className="patta-toolbar-size-system">
            <span className="patta-toolbar-label">Razmer turi</span>
            <div className="patta-segmented-control" role="group" aria-label="Razmer turi">
              <button
                type="button"
                className={`patta-segment-btn ${sizeSystem === 'letters' ? 'active' : ''}`}
                onClick={() => setSizeSystem('letters')}
              >
                Harfli (S, M, L)
              </button>
              <button
                type="button"
                className={`patta-segment-btn ${sizeSystem === 'numbers' ? 'active' : ''}`}
                onClick={() => setSizeSystem('numbers')}
              >
                Raqamli (36, 38, 40)
              </button>
            </div>
          </div>

          {/* Search Box */}
          <div className="patta-search-wrapper">
            <Search size={14} className="patta-search-icon" />
            <input
              type="text"
              placeholder="Model nomi bo'yicha qidirish"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="patta-search-input"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="patta-search-clear"
                title="Tozalash"
              >
                <X size={12} />
              </button>
            )}
          </div>

          {/* Filter Status Pills */}
          <div className="patta-filter-pills">
            <button
              type="button"
              className={`patta-filter-pill ${statusFilter === 'all' ? 'active' : ''}`}
              onClick={() => setStatusFilter('all')}
            >
              Hammasi
            </button>
            <button
              type="button"
              className={`patta-filter-pill ${statusFilter === 'filled' ? 'active' : ''}`}
              onClick={() => setStatusFilter('filled')}
            >
              To'ldirilgan
            </button>
            <button
              type="button"
              className={`patta-filter-pill ${statusFilter === 'empty' ? 'active' : ''}`}
              onClick={() => setStatusFilter('empty')}
            >
              Bo'sh
            </button>
          </div>
        </div>

        {/* Right Stats */}
        <div className="patta-batch-toolbar-right">
          <div className="patta-stat-item">
            <span className="patta-stat-label">To'ldirilgan model</span>
            <span className="patta-stat-val-dark">{filledModelsCount} ta</span>
          </div>
          <div className="patta-stat-item">
            <span className="patta-stat-label">Jami patta</span>
            <span className="patta-stat-val-green">{totalBatchPattas} ta</span>
          </div>
        </div>
      </div>

      {/* 3. Grid of Cards */}
      <div className="patta-cards-grid">
        {filteredModels.map((model) => {
          const config = pattaBatchConfigs[model.id] || {
            partyNumber: '',
            isCustomParty: false,
            totalIshSoni: '',
            color: '',
            sizes: {}
          };
          const totalPattaCount = getTotalPattaCount(model.id);
          const currentParty = effectiveParties[model.id] || String(nextPartyNumber || 1);
          const partyConflictError = partyConflicts[model.id];

          const isFilled = totalPattaCount > 0;
          const isIshSoniMissing = isFilled && !config.totalIshSoni?.trim();
          const isColorMissing = isFilled && (!config.color || !config.color.trim());
          const hasError = isIshSoniMissing || isColorMissing || partyConflictError;

          return (
            <div
              key={model.id}
              className={`patta-card ${isFilled && !hasError ? 'is-filled' : ''} ${partyConflictError ? 'has-conflict' : ''} ${hasError ? 'has-error' : ''}`}
              data-model-id={model.id}
            >
              {/* Card Header */}
              <div className="patta-card-header">
                <span className="patta-card-title" title={model.name}>
                  {model.name}
                </span>
                {isFilled ? (
                  isColorMissing ? (
                    <span className="patta-badge-error">Rang shart</span>
                  ) : isIshSoniMissing ? (
                    <span className="patta-badge-error">Ish soni yo'q</span>
                  ) : (
                    <span className="patta-badge-filled">To'ldirildi</span>
                  )
                ) : (
                  <span className="patta-badge-op">{model.operations?.length || 0} op</span>
                )}
              </div>

              {/* Row 1: Partiya & Rang side by side */}
              <div className="patta-card-row-two">
                <div className="patta-card-field">
                  <label className="patta-field-label">Partiya</label>
                  <input
                    type="text"
                    value={currentParty}
                    readOnly
                    tabIndex={-1}
                    className="patta-field-input patta-field-input-readonly"
                    title="Partiya raqami avtomatik hisoblanadi (o'zgartirilmaydi)"
                  />
                </div>

                <div className="patta-card-field">
                  <label className="patta-field-label">
                    Rang <span style={{ color: '#ef4444' }}>*</span>
                  </label>
                  <input
                    ref={(el) => { inputRefs.current[`color_${model.id}`] = el; }}
                    type="text"
                    value={config.color !== undefined ? config.color : ''}
                    onChange={(e) => guardedUpdateBatchConfig(model.id, { color: e.target.value })}
                    onKeyDown={(e) => handleInputKeyDown(e, model, `color_${model.id}`)}
                    className={`patta-field-input ${isColorMissing ? 'input-error' : ''}`}
                    placeholder="Rang*"
                  />
                  {isColorMissing && (
                    <span className="patta-input-error-msg">⚠️ Rang shart</span>
                  )}
                </div>
              </div>

              {/* Row 2: Ish / patta (dona) */}
              <div className="patta-card-field-full">
                <label className="patta-field-label">Ish / patta (dona)</label>
                <input
                  ref={(el) => { inputRefs.current[`ish_soni_${model.id}`] = el; }}
                  type="number"
                  min="1"
                  value={config.totalIshSoni || ''}
                  onChange={(e) => guardedUpdateBatchConfig(model.id, { totalIshSoni: e.target.value })}
                  onKeyDown={(e) => handleInputKeyDown(e, model, `ish_soni_${model.id}`)}
                  onWheel={(e) => e.currentTarget.blur()}
                  className={`patta-field-input-full ${isFilled && config.totalIshSoni ? 'input-filled' : ''} ${isIshSoniMissing ? 'input-error' : ''}`}
                  placeholder=""
                />
              </div>

              {/* Row 3: Sizes Grid (4 columns) */}
              <div className="patta-card-sizes-grid">
                {getModelSizes(model.id).map((sizeName) => {
                  const sizeVal = config.sizes ? config.sizes[sizeName] || '' : '';
                  const key = `size_${model.id}_${sizeName}`;
                  const isCustom = !isDefaultPattaSize(sizeName);
                  const hasVal = Number(sizeVal) > 0;

                  return (
                    <div key={sizeName} className="patta-size-box">
                      <div className="patta-size-label-row">
                        <span className={`patta-size-label ${isCustom ? 'custom-size' : ''}`}>
                          {sizeName}
                        </span>
                        {isCustom && (
                          <button
                            type="button"
                            className="patta-size-del-btn"
                            aria-label={`${sizeName} razmerini nomlash`}
                            title="Nomini o'zgartirish"
                            onClick={() => { setRenameSize({ modelId: model.id, sizeName }); setRenameSizeInput(sizeName); }}
                          >
                            <Pencil size={9} />
                          </button>
                        )}
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
                              if (ok) guardedDeleteCustomSize(model.id, sizeName);
                            }}
                            className="patta-size-del-btn"
                            title="O'chirish"
                          >
                            <X size={9} />
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
                        onWheel={(e) => e.currentTarget.blur()}
                        className={`patta-size-input ${hasVal ? 'size-input-filled' : ''}`}
                        placeholder=""
                      />
                    </div>
                  );
                })}
              </div>

              {/* Row 4: Card Footer */}
              <div className="patta-card-footer">
                <span className="patta-card-patta-count">
                  Patta: <strong>{totalPattaCount} ta</strong>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setNewCustomSizeInput('');
                    setAddSizeModelId(model.id);
                    setIsAddSizeModalOpen(true);
                    setTimeout(() => customSizeInputRef.current?.focus(), 50);
                  }}
                  className="patta-card-add-size-btn"
                >
                  + Razmer
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {filteredModels.length === 0 && (
        <div style={{ padding: '40px 20px', textAlign: 'center', color: '#94a3b8', fontSize: '17px' }}>
          Mos model topilmadi
        </div>
      )}

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
                <label style={{ display: 'block', fontSize: '15px', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '6px' }}>
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

              <div style={{ fontSize: '15px', color: 'var(--text-muted)' }}>
                 Ushbu razmer faqat {models.find((model) => model.id === addSizeModelId)?.name || 'tanlangan model'} jadvaliga qo'shiladi.
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

      {renameSize && (
        <div className="modal-overlay" onClick={() => setRenameSize(null)}>
          <div className="modal-card" style={{ maxWidth: '400px' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header"><div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--primary)' }}><Pencil size={17} /> Razmer nomini o'zgartirish</div>
              <button type="button" aria-label="Rename dialog close" onClick={() => setRenameSize(null)}><X size={18} /></button></div>
            <form onSubmit={(e) => {
              e.preventDefault();
              const renamed = renameSizeInput.trim().toUpperCase();
              if (!renamed) return;
              const config = useWorkbookStore.getState().pattaBatchConfigs[renameSize.modelId];
              const names = getModelSizes(renameSize.modelId);
              if (renamed.toUpperCase() !== renameSize.sizeName.toUpperCase() && names.some((name) => name.toUpperCase() === renamed.toUpperCase())) {
                addNotification('warning', 'Mavjud razmer', `«${renamed}» razmeri ushbu modelda mavjud.`);
                return;
              }
              const sizes = { ...(config?.sizes || {}) };
              const oldKey = Object.keys(sizes).find((name) => name.toUpperCase() === renameSize.sizeName.toUpperCase());
              if (oldKey) { sizes[renamed] = sizes[oldKey]; delete sizes[oldKey]; }
              const owned = config?.sizeNames ?? [...new Set([...(availableSizes || DEFAULT_BATCH_SIZES), ...Object.keys(config?.sizes || {})])];
              void guardedUpdateBatchConfig(renameSize.modelId, {
                sizeNames: owned.map((name) => name.toUpperCase() === renameSize.sizeName.toUpperCase() ? renamed : name), sizes
              });
              setRenameSize(null);
            }} style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <label style={{ fontSize: 15, fontWeight: 700 }}>Yangi razmer nomi
                <input autoFocus value={renameSizeInput} onChange={(e) => setRenameSizeInput(e.target.value)} className="soft-input" />
              </label>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button type="button" onClick={() => setRenameSize(null)} className="soft-btn soft-btn-secondary">Bekor qilish</button>
                <button type="submit" disabled={!renameSizeInput.trim()} className="soft-btn soft-btn-primary">Saqlash</button>
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
                <h3 style={{ margin: 0, fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)' }}>
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

            <div style={{ fontSize: '15px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
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
              fontSize: '15px'
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
                fontSize: '15px',
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
                style={{ padding: '8px 16px', fontSize: '15px' }}
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
                  fontSize: '15px',
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
