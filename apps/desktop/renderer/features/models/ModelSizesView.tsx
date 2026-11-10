import React, { useMemo, useState, useEffect, useRef } from 'react';
import { Search, ChevronDown, Plus, Copy, X, Check } from 'lucide-react';
import { useWorkbookStore } from '../../store/workbookStore';
import { DEFAULT_BATCH_SIZES } from '../../constants/batchConstants';
import { DEFAULT_NUMERIC_BATCH_SIZES, sortPattaSizes, isNumericPattaSize } from '../../domain/pattaSizeSystem';

export type ScaleType = 'letters' | 'numbers' | 'custom';
export type FilterMode = 'all' | 'unconfigured';

export interface ModelSizesViewProps {
  models?: any[];
  pattaBatchConfigs?: Record<string, any>;
}

export const ModelSizesView: React.FC<ModelSizesViewProps> = (props) => {
  const storeModels = useWorkbookStore((s) => s.models) || [];
  const storeConfigs = useWorkbookStore((s) => s.pattaBatchConfigs) || {};
  const models = props.models ?? storeModels;
  const pattaBatchConfigs = props.pattaBatchConfigs ?? storeConfigs;
  const updatePattaBatchConfig = useWorkbookStore((s) => s.updatePattaBatchConfig);
  const saveToDisk = useWorkbookStore((s) => s.saveToDisk);
  const addNotification = useWorkbookStore((s) => s.addNotification);

  // Preferred ordering for seamless matching with standard factory catalog
  const preferredModelOrder = useMemo(() => [
    'barisha-tursik-100',
    'basiman',
    'dz-008-1',
    'dana-polo-long',
    'dana-polo',
    'body-t-shrit',
    'body-long',
    'бухоро лонг-1',
    'кик-фирма-ласина',
  ], []);

  // Selected model ID
  const [selectedModelId, setSelectedModelId] = useState<string>(() => {
    const barisha = models.find((m) => m.name.toLowerCase().includes('barisha-tursik-100'));
    return barisha?.id || models[0]?.id || 'm1';
  });

  // Search and filter in left list
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');

  // Copy modal state
  const [isCopyModalOpen, setIsCopyModalOpen] = useState(false);
  const [sourceModelId, setSourceModelId] = useState<string>('');

  // Add custom size modal state
  const [isAddSizeModalOpen, setIsAddSizeModalOpen] = useState(false);
  const [newSizeName, setNewSizeName] = useState('');

  // Custom scale dropdown state
  const [isScaleDropdownOpen, setIsScaleDropdownOpen] = useState(false);
  const scaleDropdownRef = useRef<HTMLDivElement>(null);

  // Close custom scale dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (scaleDropdownRef.current && !scaleDropdownRef.current.contains(e.target as Node)) {
        setIsScaleDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Active model config in local edit state
  // We maintain a local state for currently active sizes so changes can be previewed immediately
  // and saved with the "Saqlash" button.
  const [localActiveSizes, setLocalActiveSizes] = useState<Record<string, string[]>>({});
  const [localScaleTypes, setLocalScaleTypes] = useState<Record<string, ScaleType>>({});
  const [customSizesByModel, setCustomSizesByModel] = useState<Record<string, string[]>>({});

  // Ensure selected model exists
  useEffect(() => {
    if (!models.some((m) => m.id === selectedModelId) && models.length > 0) {
      setSelectedModelId(models[0].id);
    }
  }, [models, selectedModelId]);

  // Helper to determine if a model is configured
  const getModelActiveSizes = (modelId: string): string[] => {
    const scale = getModelScaleType(modelId);
    const filterByScale = (sizesList: string[]): string[] => {
      if (scale === 'numbers') return sizesList.filter(isNumericPattaSize);
      if (scale === 'letters') return sizesList.filter((s) => !isNumericPattaSize(s));
      return sizesList;
    };

    if (localActiveSizes[modelId] !== undefined) {
      return sortPattaSizes(filterByScale(localActiveSizes[modelId]));
    }
    const cfg = pattaBatchConfigs[modelId];
    if (cfg && cfg.isConfigured !== false && Array.isArray(cfg.sizeNames) && cfg.sizeNames.length > 0) {
      return sortPattaSizes(filterByScale(cfg.sizeNames));
    }
    // If explicitly marked unconfigured or empty
    if (cfg && (cfg.isConfigured === false || (Array.isArray(cfg.sizeNames) && cfg.sizeNames.length === 0))) {
      return [];
    }
    // Default demo heuristic for initial models: if m-lasina, m-kapalak, m5 -> unconfigured
    if (modelId === 'm-lasina' || modelId === 'm-kapalak' || modelId === 'm5') {
      return [];
    }
    // Default sizes based on scale
    if (scale === 'numbers') {
      return ['48', '50', '52', '54'];
    }
    return ['S', 'M', 'L', 'XL', 'XXL'];
  };

  const isModelConfigured = (modelId: string): boolean => {
    const sizes = getModelActiveSizes(modelId);
    return sizes.length > 0;
  };

  const getModelScaleType = (modelId: string): ScaleType => {
    if (localScaleTypes[modelId] !== undefined) {
      return localScaleTypes[modelId];
    }
    const cfg = pattaBatchConfigs[modelId];
    if (cfg?.scaleType) return cfg.scaleType as ScaleType;
    return 'letters';
  };

  const activeModel = models.find((m) => m.id === selectedModelId) || models[0];
  const activeScaleType = activeModel ? getModelScaleType(activeModel.id) : 'letters';
  const activeSizes = activeModel ? getModelActiveSizes(activeModel.id) : [];

  // Available sizes to display in the capsules row based on current scale type
  const availableSizesForActiveModel = useMemo(() => {
    if (!activeModel) return [];
    const modelCustoms = customSizesByModel[activeModel.id] || [];
    let baseList: string[] = [];
    if (activeScaleType === 'numbers') {
      baseList = [...DEFAULT_NUMERIC_BATCH_SIZES];
      const numericCustoms = modelCustoms.filter(isNumericPattaSize);
      const numericActive = activeSizes.filter(isNumericPattaSize);
      return sortPattaSizes(Array.from(new Set([...baseList, ...numericCustoms, ...numericActive])));
    } else if (activeScaleType === 'letters') {
      baseList = [...DEFAULT_BATCH_SIZES];
      const letterCustoms = modelCustoms.filter((s) => !isNumericPattaSize(s));
      const letterActive = activeSizes.filter((s) => !isNumericPattaSize(s));
      return sortPattaSizes(Array.from(new Set([...baseList, ...letterCustoms, ...letterActive])));
    } else {
      baseList = [...DEFAULT_BATCH_SIZES, ...DEFAULT_NUMERIC_BATCH_SIZES];
      return sortPattaSizes(Array.from(new Set([...baseList, ...modelCustoms, ...activeSizes])));
    }
  }, [activeModel, activeScaleType, customSizesByModel, activeSizes]);

  // Model statistics for filter pills
  const modelStats = useMemo(() => {
    let unconfiguredCount = 0;
    for (const m of models) {
      if (!isModelConfigured(m.id)) {
        unconfiguredCount++;
      }
    }
    return {
      total: models.length,
      unconfigured: unconfiguredCount,
    };
  }, [models, localActiveSizes, pattaBatchConfigs]);

  // Filtered and sorted model list
  const filteredModels = useMemo(() => {
    const list = models.filter((m) => {
      if (filterMode === 'unconfigured' && isModelConfigured(m.id)) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        return m.name.toLowerCase().includes(q) || (m.title && m.title.toLowerCase().includes(q));
      }
      return true;
    });

    return [...list].sort((a, b) => {
      const idxA = preferredModelOrder.indexOf(a.name.toLowerCase());
      const idxB = preferredModelOrder.indexOf(b.name.toLowerCase());
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return 0;
    });
  }, [models, filterMode, searchQuery, localActiveSizes, pattaBatchConfigs, preferredModelOrder]);

  // Toggle size ON / OFF
  const handleToggleSize = (size: string) => {
    if (!activeModel) return;
    const modelId = activeModel.id;
    setLocalActiveSizes((prev) => {
      const currentList = prev[modelId] !== undefined
        ? prev[modelId]
        : getModelActiveSizes(modelId);
      let nextList: string[];
      if (currentList.includes(size)) {
        nextList = currentList.filter((s) => s !== size);
      } else {
        nextList = [...currentList, size];
      }
      return {
        ...prev,
        [modelId]: sortPattaSizes(nextList),
      };
    });
  };

  // Change scale type
  const handleChangeScaleType = (newScale: ScaleType) => {
    if (!activeModel) return;
    setLocalScaleTypes((prev) => ({
      ...prev,
      [activeModel.id]: newScale,
    }));

    // Adjust active sizes to match the new scale
    const currentActive = localActiveSizes[activeModel.id] ?? pattaBatchConfigs[activeModel.id]?.sizeNames ?? [];
    let nextActive: string[];
    if (newScale === 'numbers') {
      const numeric = currentActive.filter(isNumericPattaSize);
      nextActive = numeric.length > 0 ? numeric : ['48', '50', '52', '54'];
    } else if (newScale === 'letters') {
      const letters = currentActive.filter((s) => !isNumericPattaSize(s));
      nextActive = letters.length > 0 ? letters : ['S', 'M', 'L', 'XL', 'XXL'];
    } else {
      nextActive = currentActive;
    }

    setLocalActiveSizes((prev) => ({
      ...prev,
      [activeModel.id]: sortPattaSizes(nextActive),
    }));
  };

  // Save changes
  const handleSave = async () => {
    if (!activeModel) return;
    const updatedSizes = sortPattaSizes(getModelActiveSizes(activeModel.id));
    const updatedScale = getModelScaleType(activeModel.id);

    // Update in store
    updatePattaBatchConfig(activeModel.id, {
      sizeNames: updatedSizes,
      scaleType: updatedScale,
      isConfigured: updatedSizes.length > 0,
    });

    try {
      await saveToDisk(undefined, { forceBackup: false });
    } catch {
      // non-blocking
    }

    addNotification('success', 'Saqlandi', `«${activeModel.name}» uchun model o'lchamlari muvaffaqiyatli saqlandi!`);
  };

  // Copy sizes from another model
  const handleCopyFromModel = () => {
    if (!activeModel || !sourceModelId) return;
    const sourceSizes = getModelActiveSizes(sourceModelId);
    const sourceScale = getModelScaleType(sourceModelId);

    setLocalActiveSizes((prev) => ({
      ...prev,
      [activeModel.id]: sortPattaSizes([...sourceSizes]),
    }));
    setLocalScaleTypes((prev) => ({
      ...prev,
      [activeModel.id]: sourceScale,
    }));

    setIsCopyModalOpen(false);
    const srcModel = models.find((m) => m.id === sourceModelId);
    addNotification('info', 'Nusxalandi', `«${srcModel?.name || sourceModelId}» razmerlari nusxalandi. Saqlash tugmasini bosing.`);
  };

  // Add new custom size
  const handleAddCustomSize = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = newSizeName.trim().toUpperCase();
    if (!clean || !activeModel) return;

    if (availableSizesForActiveModel.includes(clean)) {
      // If already exists, just toggle it ON
      if (!activeSizes.includes(clean)) {
        handleToggleSize(clean);
      }
      setIsAddSizeModalOpen(false);
      setNewSizeName('');
      return;
    }

    // Add to model custom sizes and toggle ON in sorted order
    setCustomSizesByModel((prev) => ({
      ...prev,
      [activeModel.id]: sortPattaSizes([...(prev[activeModel.id] || []), clean]),
    }));
    setLocalActiveSizes((prev) => ({
      ...prev,
      [activeModel.id]: sortPattaSizes([...(prev[activeModel.id] || getModelActiveSizes(activeModel.id)), clean]),
    }));

    setIsAddSizeModalOpen(false);
    setNewSizeName('');
    addNotification('success', "O'lcham qo'shildi", `Yangi «${clean}» razmeri qo'shildi va faollashtirildi.`);
  };

  return (
    <div className="model-sizes-page">
      {/* 1. Header Bar */}
      <header className="model-sizes-header">
        <div className="model-sizes-header-left">
          <h1 className="model-sizes-title">Model o'lchamlari</h1>
          <p className="model-sizes-subtitle">Har model uchun razmerlarni sozlash</p>
        </div>
        <div className="model-sizes-header-right">
          <button
            type="button"
            className="model-sizes-btn-outline"
            onClick={() => {
              const other = models.find((m) => m.id !== selectedModelId);
              setSourceModelId(other?.id || '');
              setIsCopyModalOpen(true);
            }}
          >
            Boshqa modeldan nusxalash
          </button>
          <button
            type="button"
            className="model-sizes-btn-primary"
            onClick={handleSave}
          >
            Saqlash
          </button>
        </div>
      </header>

      {/* 2. Main Two-Column Layout */}
      <div className="model-sizes-layout">
        {/* Left Column: Models List Card */}
        <aside className="model-sizes-left-card">
          {/* Search Box with icon and clear button */}
          <div className="model-sizes-search-wrap">
            <Search size={15} className="model-sizes-search-icon" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Model qidirish"
              className="model-sizes-search-input"
            />
            {searchQuery && (
              <button
                type="button"
                className="model-sizes-search-clear"
                onClick={() => setSearchQuery('')}
                title="Tozalash"
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* Filter Pills */}
          <div className="model-sizes-filter-pills">
            <button
              type="button"
              className={`model-sizes-filter-pill ${filterMode === 'all' ? 'active' : ''}`}
              onClick={() => setFilterMode('all')}
            >
              Hammasi · {modelStats.total}
            </button>
            <button
              type="button"
              className={`model-sizes-filter-pill ${filterMode === 'unconfigured' ? 'active' : ''}`}
              onClick={() => setFilterMode('unconfigured')}
            >
              Sozlanmagan · {modelStats.unconfigured}
            </button>
          </div>

          {/* Model Item Rows */}
          <div className="model-sizes-list">
            {filteredModels.map((m) => {
              const isSelected = m.id === selectedModelId;
              const configured = isModelConfigured(m.id);
              const count = getModelActiveSizes(m.id).length;

              return (
                <div
                  key={m.id}
                  onClick={() => setSelectedModelId(m.id)}
                  className={`model-sizes-item ${isSelected ? 'selected' : ''}`}
                >
                  <span className="model-sizes-item-name" title={m.name}>
                    {m.name}
                  </span>

                  {configured ? (
                    <span className={`model-sizes-item-badge ${isSelected ? 'badge-active' : ''}`}>
                      {count} razmer
                    </span>
                  ) : (
                    <span className="model-sizes-item-unconfigured">
                      Sozlanmagan
                    </span>
                  )}
                </div>
              );
            })}

            {filteredModels.length === 0 && (
              <div className="model-sizes-empty-list">
                Mos keladigan model topilmadi
              </div>
            )}
          </div>
        </aside>

        {/* Right Column: Size Configuration Cards */}
        <main className="model-sizes-right-col">
          {activeModel ? (
            <>
              {/* Card 1: Model Title and Scale Selection */}
              <div className="model-sizes-card model-sizes-scale-card">
                <div className="model-sizes-scale-header">
                  <h2 className="model-sizes-model-title">{activeModel.name}</h2>
                  <span className="model-sizes-green-pill">
                    {activeSizes.length} razmer
                  </span>
                </div>

                <div className="model-sizes-scale-body">
                  <label className="model-sizes-scale-label">Razmer shkalasi</label>
                  <div className="model-sizes-select-wrap" ref={scaleDropdownRef}>
                    <button
                      type="button"
                      className={`model-sizes-dropdown-btn ${isScaleDropdownOpen ? 'open' : ''}`}
                      onClick={() => setIsScaleDropdownOpen((prev) => !prev)}
                    >
                      <span>
                        {activeScaleType === 'numbers'
                          ? 'Raqamli (40 — 60)'
                          : activeScaleType === 'custom'
                          ? 'Maxsus (Barcha razmerlar)'
                          : 'Harfli (XXS — XXXL)'}
                      </span>
                      <ChevronDown size={15} className={`model-sizes-dropdown-arrow ${isScaleDropdownOpen ? 'open' : ''}`} />
                    </button>

                    {isScaleDropdownOpen && (
                      <div className="model-sizes-dropdown-menu">
                        {[
                          { value: 'letters' as ScaleType, label: 'Harfli (XXS — XXXL)' },
                          { value: 'numbers' as ScaleType, label: 'Raqamli (40 — 60)' },
                          { value: 'custom' as ScaleType, label: 'Maxsus (Barcha razmerlar)' },
                        ].map((opt) => (
                          <div
                            key={opt.value}
                            className={`model-sizes-dropdown-item ${activeScaleType === opt.value ? 'selected' : ''}`}
                            onClick={() => {
                              handleChangeScaleType(opt.value);
                              setIsScaleDropdownOpen(false);
                            }}
                          >
                            <span>{opt.label}</span>
                            {activeScaleType === opt.value && (
                              <Check size={16} className="model-sizes-dropdown-check" />
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Card 2: Ishlab chiqariladigan razmerlar & Toggle Capsules */}
              <div className="model-sizes-card model-sizes-sizes-card">
                <div className="model-sizes-card-header">
                  <div>
                    <h3 className="model-sizes-card-title">Ishlab chiqariladigan razmerlar</h3>
                    <p className="model-sizes-card-subtitle">
                      Faqat yoqilgan razmerlar buyurtma, bichuv va pattada ko'rinadi
                    </p>
                  </div>
                  <button
                    type="button"
                    className="model-sizes-btn-add"
                    onClick={() => {
                      setNewSizeName('');
                      setIsAddSizeModalOpen(true);
                    }}
                  >
                    <Plus size={13} strokeWidth={2.5} />
                    <span>O'lcham qo'shish</span>
                  </button>
                </div>

                {/* Size Toggle Capsules */}
                <div className="model-sizes-capsules-grid">
                  {availableSizesForActiveModel.map((size) => {
                    const isEnabled = activeSizes.includes(size);

                    return (
                      <div
                        key={size}
                        onClick={() => handleToggleSize(size)}
                        className={`model-sizes-capsule ${isEnabled ? 'capsule-on' : 'capsule-off'}`}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === ' ' || e.key === 'Enter') {
                            e.preventDefault();
                            handleToggleSize(size);
                          }
                        }}
                        title={`${size} razmerini ${isEnabled ? "o'chirish" : 'yoqish'}`}
                      >
                        <span className="model-sizes-capsule-label">{size}</span>
                        <div className={`model-sizes-switch-track ${isEnabled ? 'track-on' : 'track-off'}`}>
                          <div className={`model-sizes-switch-knob ${isEnabled ? 'knob-on' : 'knob-off'}`} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          ) : (
            <div className="model-sizes-empty-card">
              Iltimos, chap tarafdan modelni tanlang
            </div>
          )}

          {/* Footer Note */}
          <div className="model-sizes-footer-note">
            Modellar nomi haqiqiy. Razmerlar soni namuna.
          </div>
        </main>
      </div>

      {/* Copy From Another Model Modal */}
      {isCopyModalOpen && (
        <div className="model-sizes-modal-backdrop" onClick={() => setIsCopyModalOpen(false)}>
          <div className="model-sizes-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="model-sizes-modal-header">
              <div className="model-sizes-modal-title-group">
                <div className="model-sizes-modal-icon-badge">
                  <Copy size={18} strokeWidth={2.2} />
                </div>
                <div>
                  <h3 className="model-sizes-modal-title">Boshqa modeldan nusxalash</h3>
                  <p className="model-sizes-modal-subtitle">Model razmerlari ro'yxatini ko'chirish</p>
                </div>
              </div>
              <button
                type="button"
                className="model-sizes-modal-close"
                onClick={() => setIsCopyModalOpen(false)}
                title="Yopish"
              >
                <X size={16} />
              </button>
            </div>

            <div className="model-sizes-modal-body">
              <div className="model-sizes-modal-context">
                <span>Maqsad model:</span>
                <span className="model-sizes-modal-context-model">{activeModel?.name}</span>
              </div>

              <div className="model-sizes-form-group">
                <label className="model-sizes-form-label">
                  Qaysi modeldan nusxalanadi?
                </label>
                <select
                  value={sourceModelId}
                  onChange={(e) => setSourceModelId(e.target.value)}
                  className="model-sizes-form-input"
                  style={{ cursor: 'pointer' }}
                >
                  {models
                    .filter((m) => m.id !== selectedModelId)
                    .map((m) => {
                      const count = getModelActiveSizes(m.id).length;
                      return (
                        <option key={m.id} value={m.id}>
                          {m.name} ({count} razmer)
                        </option>
                      );
                    })}
                </select>
              </div>

              {sourceModelId && (
                <div className="model-sizes-form-hint" style={{ background: '#f8fafc', padding: '10px 14px', borderRadius: '10px', border: '1px solid #e2e8f0' }}>
                  <div style={{ fontWeight: 600, color: '#334155', marginBottom: '4px' }}>Nusxalanadigan razmerlar:</div>
                  <div style={{ color: '#047857', fontWeight: 700 }}>
                    {getModelActiveSizes(sourceModelId).join(', ') || 'Razmerlar yoqilmagan'}
                  </div>
                </div>
              )}
            </div>

            <div className="model-sizes-modal-footer">
              <button
                type="button"
                className="model-sizes-btn-modal-cancel"
                onClick={() => setIsCopyModalOpen(false)}
              >
                Bekor qilish
              </button>
              <button
                type="button"
                className="model-sizes-btn-modal-submit"
                onClick={handleCopyFromModel}
                disabled={!sourceModelId}
              >
                <Copy size={15} strokeWidth={2.2} />
                <span>Nusxalash</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Custom Size Modal */}
      {isAddSizeModalOpen && (
        <div className="model-sizes-modal-backdrop" onClick={() => setIsAddSizeModalOpen(false)}>
          <div className="model-sizes-modal-card" onClick={(e) => e.stopPropagation()}>
            <form onSubmit={handleAddCustomSize}>
              <div className="model-sizes-modal-header">
                <div className="model-sizes-modal-title-group">
                  <div className="model-sizes-modal-icon-badge">
                    <Plus size={18} strokeWidth={2.5} />
                  </div>
                  <div>
                    <h3 className="model-sizes-modal-title">Yangi o'lcham qo'shish</h3>
                    <p className="model-sizes-modal-subtitle">Model uchun maxsus razmer kiriting</p>
                  </div>
                </div>
                <button
                  type="button"
                  className="model-sizes-modal-close"
                  onClick={() => setIsAddSizeModalOpen(false)}
                  title="Yopish"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="model-sizes-modal-body">
                <div className="model-sizes-modal-context">
                  <span>Tanlangan model:</span>
                  <span className="model-sizes-modal-context-model">{activeModel?.name}</span>
                </div>

                <div className="model-sizes-form-group">
                  <label className="model-sizes-form-label">
                    O'lcham (razmer) nomi <span style={{ color: '#ef4444' }}>*</span>
                  </label>
                  <input
                    type="text"
                    autoFocus
                    value={newSizeName}
                    onChange={(e) => setNewSizeName(e.target.value)}
                    placeholder="Masalan: 4XL, 5XL, 38, 62"
                    className="model-sizes-form-input"
                  />
                  <p className="model-sizes-form-hint">
                    Namuna: <strong>4XL</strong>, <strong>5XL</strong>, <strong>38</strong>, <strong>62</strong>, <strong>104-110</strong>
                  </p>
                </div>
              </div>

              <div className="model-sizes-modal-footer">
                <button
                  type="button"
                  className="model-sizes-btn-modal-cancel"
                  onClick={() => setIsAddSizeModalOpen(false)}
                >
                  Bekor qilish
                </button>
                <button
                  type="submit"
                  className="model-sizes-btn-modal-submit"
                  disabled={!newSizeName.trim()}
                >
                  <Plus size={15} strokeWidth={2.5} />
                  <span>Qo'shish</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
