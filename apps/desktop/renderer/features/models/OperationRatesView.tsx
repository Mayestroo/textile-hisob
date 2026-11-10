import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  Search,
  X,
  Plus,
  Trash2,
  GripVertical,
  ChevronDown,
  Check
} from 'lucide-react';
import { useWorkbookStore } from '../../store/workbookStore';
import { ModelConfig, Operation } from '../../types/workbook';
import { isModelNarxsiz } from '../../components/layout/SheetTabs';

interface OperationRatesViewProps {
  initialModelId?: string;
  isModal?: boolean;
  onClose?: () => void;
}

export const OperationRatesView: React.FC<OperationRatesViewProps> = ({
  initialModelId,
  isModal,
  onClose
}) => {
  const models = useWorkbookStore((s) => s.models);
  const updateModelOperations = useWorkbookStore((s) => s.updateModelOperations);
  const addNotification = useWorkbookStore((s) => s.addNotification);

  // Search and filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'unpriced'>('all');

  // Selected model
  const [selectedModelId, setSelectedModelId] = useState<string>(() => {
    if (initialModelId && models.some((m) => m.id === initialModelId)) {
      return initialModelId;
    }
    // Prefer first unpriced model, matching user screenshot
    const firstUnpriced = models.find((m) => isModelNarxsiz(m));
    if (firstUnpriced) return firstUnpriced.id;
    return models[0]?.id || '';
  });

  // Keep selectedModel valid if models change
  useEffect(() => {
    if (!selectedModelId && models.length > 0) {
      const firstUnpriced = models.find((m) => isModelNarxsiz(m));
      setSelectedModelId(firstUnpriced?.id || models[0].id);
    }
  }, [models, selectedModelId]);

  const selectedModel = useMemo(() => {
    return models.find((m) => m.id === selectedModelId) || models[0] || null;
  }, [models, selectedModelId]);

  // Working draft operations for the selected model
  const [draftOps, setDraftOps] = useState<Operation[]>([]);
  const [isDirty, setIsDirty] = useState(false);

  // Bulk rate fill state
  const [bulkRate, setBulkRate] = useState<string>('');

  // Add new operation inline state
  const [isAddingOp, setIsAddingOp] = useState(false);
  const [newOpName, setNewOpName] = useState('');
  const [newOpRate, setNewOpRate] = useState('');

  // Copy dropdown popover
  const [showCopyDropdown, setShowCopyDropdown] = useState(false);
  const copyDropdownRef = useRef<HTMLDivElement>(null);

  // Sync draft operations when selected model changes
  useEffect(() => {
    if (!selectedModel) {
      setDraftOps([]);
      setIsDirty(false);
      return;
    }
    const cloned = (selectedModel.operations || []).map((op, idx) => ({
      ...op,
      rate: Number(op.rate) || 0,
      col: op.col ?? 3 + idx * 2,
      id: op.id || `op_${idx + 1}`
    }));
    setDraftOps(cloned);
    setIsDirty(false);
    setIsAddingOp(false);
    setNewOpName('');
    setNewOpRate('');
  }, [selectedModel?.id]);

  // Close copy dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (copyDropdownRef.current && !copyDropdownRef.current.contains(e.target as Node)) {
        setShowCopyDropdown(false);
      }
    };
    if (showCopyDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showCopyDropdown]);

  // Model categorization for left sidebar
  const { unpricedModels, pricedModels } = useMemo(() => {
    const unpriced: Array<{ model: ModelConfig; total: number; opCount: number }> = [];
    const priced: Array<{ model: ModelConfig; total: number; opCount: number }> = [];

    models.forEach((m) => {
      const ops = m.operations || [];
      const total = ops.reduce((sum, o) => sum + (Number(o.rate) || 0), 0);
      const isUnpriced = isModelNarxsiz(m);

      const entry = { model: m, total, opCount: ops.length };
      if (isUnpriced) {
        unpriced.push(entry);
      } else {
        priced.push(entry);
      }
    });

    return { unpricedModels: unpriced, pricedModels: priced };
  }, [models]);

  // Filtered lists based on search and pill
  const filteredUnpriced = useMemo(() => {
    return unpricedModels.filter(({ model }) => {
      if (!searchQuery.trim()) return true;
      return model.name.toLowerCase().includes(searchQuery.toLowerCase().trim());
    });
  }, [unpricedModels, searchQuery]);

  const filteredPriced = useMemo(() => {
    if (filterMode === 'unpriced') return [];
    return pricedModels.filter(({ model }) => {
      if (!searchQuery.trim()) return true;
      return model.name.toLowerCase().includes(searchQuery.toLowerCase().trim());
    });
  }, [pricedModels, searchQuery, filterMode]);

  // Metrics for draft operations
  const draftMetrics = useMemo(() => {
    const totalOps = draftOps.length;
    const pricedOps = draftOps.filter((o) => (Number(o.rate) || 0) > 0).length;
    const totalRate = draftOps.reduce((sum, o) => sum + (Number(o.rate) || 0), 0);
    const progressPercent = totalOps > 0 ? (pricedOps / totalOps) * 100 : 0;
    const isUnpriced = pricedOps < totalOps;
    return { totalOps, pricedOps, totalRate, progressPercent, isUnpriced };
  }, [draftOps]);

  // Handle individual rate input change
  const handleRateChange = (index: number, val: string) => {
    const numericVal = val === '' ? 0 : parseFloat(val.replace(/\s+/g, '')) || 0;
    setDraftOps((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], rate: numericVal };
      return copy;
    });
    setIsDirty(true);
  };

  // Handle bulk rate apply
  const handleApplyBulkRate = () => {
    const num = parseFloat(bulkRate.replace(/\s+/g, ''));
    if (isNaN(num) || num < 0) {
      addNotification('warning', 'Xatolik', 'Musbat son kiriting');
      return;
    }
    let updatedCount = 0;
    setDraftOps((prev) =>
      prev.map((op) => {
        if ((Number(op.rate) || 0) <= 0) {
          updatedCount++;
          return { ...op, rate: num };
        }
        return op;
      })
    );
    if (updatedCount > 0) {
      setIsDirty(true);
      addNotification('success', 'Qo\'llandi', `${updatedCount} ta bo'sh operatsiyaga ${num.toLocaleString('uz-UZ')} so'm narx belgilandi.`);
      setBulkRate('');
    } else {
      addNotification('info', 'Ma\'lumot', 'Bo\'sh narxli operatsiyalar topilmadi.');
    }
  };

  // Handle copy from another model
  const handleCopyFromModel = (sourceModel: ModelConfig) => {
    const sourceMap = new Map<string, number>();
    (sourceModel.operations || []).forEach((op) => {
      if (op.name && Number(op.rate) > 0) {
        sourceMap.set(op.name.trim().toLowerCase(), Number(op.rate));
      }
    });

    let matchCount = 0;
    setDraftOps((prev) =>
      prev.map((op) => {
        const key = (op.name || '').trim().toLowerCase();
        if (sourceMap.has(key)) {
          matchCount++;
          return { ...op, rate: sourceMap.get(key)! };
        }
        return op;
      })
    );

    setShowCopyDropdown(false);
    if (matchCount > 0) {
      setIsDirty(true);
      addNotification('success', 'Nusxalandi', `"${sourceModel.name}" modelidan ${matchCount} ta mos operatsiya narxi nusxalandi.`);
    } else {
      addNotification('info', 'Moslik yo\'q', `"${sourceModel.name}" modelida bir xil nomli operatsiyalar topilmadi.`);
    }
  };

  // Handle delete operation
  const handleDeleteOperation = (index: number) => {
    const target = draftOps[index];
    if (!target) return;
    setDraftOps((prev) => prev.filter((_, idx) => idx !== index));
    setIsDirty(true);
  };

  // Handle add new operation
  const handleAddNewOperation = () => {
    const trimmed = newOpName.trim();
    if (!trimmed) {
      addNotification('warning', 'Xatolik', 'Operatsiya nomini kiriting');
      return;
    }
    if (draftOps.some((o) => o.name.toLowerCase() === trimmed.toLowerCase())) {
      addNotification('warning', 'Mavjud', 'Ushbu operatsiya allaqachon mavjud');
      return;
    }
    const rateVal = parseFloat(newOpRate.replace(/\s+/g, '')) || 0;
    const newOp: Operation = {
      id: `op_${Date.now()}`,
      name: trimmed,
      rate: rateVal,
      col: 3 + draftOps.length * 2
    };
    setDraftOps((prev) => [...prev, newOp]);
    setIsDirty(true);
    setNewOpName('');
    setNewOpRate('');
    setIsAddingOp(false);
  };

  // Drag and Drop reordering
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);

  const handleDragStart = (idx: number) => {
    setDraggedIdx(idx);
  };

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    if (draggedIdx === null || draggedIdx === idx) return;
    const newOps = [...draftOps];
    const draggedItem = newOps[draggedIdx];
    newOps.splice(draggedIdx, 1);
    newOps.splice(idx, 0, draggedItem);
    setDraftOps(newOps);
    setDraggedIdx(idx);
    setIsDirty(true);
  };

  const handleDragEnd = () => {
    setDraggedIdx(null);
  };

  // Reset / Bekor qilish
  const handleReset = () => {
    if (!selectedModel) return;
    const cloned = (selectedModel.operations || []).map((op, idx) => ({
      ...op,
      rate: Number(op.rate) || 0,
      col: op.col ?? 3 + idx * 2,
      id: op.id || `op_${idx + 1}`
    }));
    setDraftOps(cloned);
    setIsDirty(false);
    setIsAddingOp(false);
    setNewOpName('');
    setNewOpRate('');
    addNotification('info', 'Bekor qilindi', 'O\'zgarishlar asl holiga qaytarildi.');
  };

  // Save / Saqlash
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
    if (!selectedModel) return;
    setIsSaving(true);
    try {
      const ok = await updateModelOperations(selectedModel.id, draftOps);
      if (ok) {
        setIsDirty(false);
        if (isModal && onClose) {
          onClose();
        }
      }
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className={`rates-page-container ${isModal ? 'rates-modal-view' : ''}`}>
      {/* 1. Page Header */}
      <div className="rates-page-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
          <div>
            <h1 className="rates-page-title">Operatsiya narxlari</h1>
            <p className="rates-page-subtitle">
              Model tanlang va har bir operatsiya uchun narx kiriting
            </p>
          </div>
          {isModal && onClose && (
            <button
              type="button"
              onClick={onClose}
              className="period-modal-close-btn"
              title="Yopish"
            >
              <X size={18} />
            </button>
          )}
        </div>
      </div>

      {/* 2. Main Two-Column Layout */}
      <div className="rates-content-grid">
        {/* Left Column: Sidebar Card */}
        <div className="rates-sidebar-card">
          {/* Search Box */}
          <div className="rates-search-box">
            <Search size={15} className="rates-search-icon" />
            <input
              type="text"
              placeholder="Model qidirish"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="rates-search-input"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="rates-search-clear"
                title="Tozalash"
              >
                <X size={13} />
              </button>
            )}
          </div>

          {/* Filter Pills */}
          <div className="rates-filter-pills">
            <button
              type="button"
              className={`rates-pill ${filterMode === 'all' ? 'active' : ''}`}
              onClick={() => setFilterMode('all')}
            >
              Hammasi · {models.length}
            </button>
            <button
              type="button"
              className={`rates-pill ${filterMode === 'unpriced' ? 'active' : ''}`}
              onClick={() => setFilterMode('unpriced')}
            >
              Narxi yo'q · {unpricedModels.length}
            </button>
          </div>

          {/* Models Scrollable List */}
          <div className="rates-models-scroll">
            {/* Group 1: Narxi kiritilmagan */}
            {filteredUnpriced.length > 0 && (
              <div className="rates-group">
                <div className="rates-group-title">
                  NARXI KIRITILMAGAN · {filteredUnpriced.length}
                </div>
                <div className="rates-group-list">
                  {filteredUnpriced.map(({ model, opCount }) => {
                    const isSelected = model.id === selectedModel?.id;
                    return (
                      <div
                        key={model.id}
                        className={`rates-model-item ${isSelected ? 'selected' : ''}`}
                        onClick={() => setSelectedModelId(model.id)}
                      >
                        <div className="rates-model-info">
                          <span className="rates-model-name" title={model.name}>
                            {model.name}
                          </span>
                          <span className="rates-model-ops">{opCount} op</span>
                        </div>
                        <span className="rates-badge-unpriced">Narx yo'q</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Group 2: Narxi kiritilgan */}
            {filteredPriced.length > 0 && (
              <div className="rates-group">
                <div className="rates-group-title">
                  NARXI KIRITILGAN · {filteredPriced.length}
                </div>
                <div className="rates-group-list">
                  {filteredPriced.map(({ model, total, opCount }) => {
                    const isSelected = model.id === selectedModel?.id;
                    return (
                      <div
                        key={model.id}
                        className={`rates-model-item ${isSelected ? 'selected' : ''}`}
                        onClick={() => setSelectedModelId(model.id)}
                      >
                        <div className="rates-model-info">
                          <span className="rates-model-name" title={model.name}>
                            {model.name}
                          </span>
                          <span className="rates-model-ops">{opCount} op</span>
                        </div>
                        <span className="rates-model-total">
                          {total > 0 ? total.toLocaleString() : '0'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {filteredUnpriced.length === 0 && filteredPriced.length === 0 && (
              <div className="rates-empty-search">
                Model topilmadi
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Main Editor Card */}
        <div className="rates-editor-card">
          {selectedModel ? (
            <>
              {/* Editor Header */}
              <div className="rates-editor-header">
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <h2 className="rates-editor-model-title">{selectedModel.name}</h2>
                    {draftMetrics.isUnpriced ? (
                      <span className="rates-badge-unpriced-pill">Narx kiritilmagan</span>
                    ) : (
                      <span className="rates-badge-priced-pill">Narx kiritilgan</span>
                    )}
                  </div>
                  <p className="rates-editor-model-sub">
                    {draftMetrics.totalOps} ta operatsiya · jami model narxi operatsiyalar yig'indisidan hisoblanadi
                  </p>
                </div>

                {/* Copy from other model dropdown */}
                <div className="rates-copy-wrapper" ref={copyDropdownRef}>
                  <button
                    type="button"
                    className="rates-copy-btn"
                    onClick={() => setShowCopyDropdown((prev) => !prev)}
                  >
                    <span>Boshqa modeldan nusxalash</span>
                    <ChevronDown size={15} />
                  </button>

                  {showCopyDropdown && (
                    <div className="rates-copy-popover">
                      <div className="rates-copy-popover-title">
                        Qaysi modeldan narxlarni nusxalaymiz?
                      </div>
                      <div className="rates-copy-popover-list">
                        {models
                          .filter((m) => m.id !== selectedModel.id && (m.operations || []).some((o) => Number(o.rate) > 0))
                          .map((m) => {
                            const sum = (m.operations || []).reduce((s, o) => s + (Number(o.rate) || 0), 0);
                            return (
                              <button
                                key={m.id}
                                type="button"
                                className="rates-copy-popover-item"
                                onClick={() => handleCopyFromModel(m)}
                              >
                                <span className="rates-copy-item-name">{m.name}</span>
                                <span className="rates-copy-item-rate">
                                  {m.operations?.length || 0} op · {sum.toLocaleString()} so'm
                                </span>
                              </button>
                            );
                          })}
                        {models.filter((m) => m.id !== selectedModel.id && (m.operations || []).some((o) => Number(o.rate) > 0)).length === 0 && (
                          <div style={{ padding: '12px', fontSize: '15px', color: '#94a3b8', textAlign: 'center' }}>
                            Narxi bor boshqa model topilmadi
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Bulk Rate Banner */}
              <div className="rates-bulk-banner">
                <span className="rates-bulk-label">Bo'sh narxlarga bir xil qiymat:</span>
                <div className="rates-bulk-input-wrapper">
                  <input
                    type="number"
                    min="0"
                    placeholder="0"
                    value={bulkRate}
                    onChange={(e) => setBulkRate(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleApplyBulkRate();
                      }
                    }}
                    className="rates-bulk-input"
                  />
                  <span className="rates-bulk-unit">so'm</span>
                </div>
                <button
                  type="button"
                  className="rates-bulk-btn"
                  onClick={handleApplyBulkRate}
                >
                  Qo'llash
                </button>
              </div>

              {/* Operations Table */}
              <div className="rates-table-container">
                <div className="rates-table-header">
                  <div className="rates-th rates-col-num">№</div>
                  <div className="rates-th rates-col-name">OPERATSIYA</div>
                  <div className="rates-th rates-col-rate">NARX</div>
                  <div className="rates-th rates-col-action" />
                </div>

                <div className="rates-table-body">
                  {draftOps.map((op, idx) => {
                    const rateNum = Number(op.rate) || 0;
                    return (
                      <div
                        key={op.id || idx}
                        className="rates-row"
                        draggable
                        onDragStart={() => handleDragStart(idx)}
                        onDragOver={(e) => handleDragOver(e, idx)}
                        onDragEnd={handleDragEnd}
                      >
                        {/* Drag Handle & Number */}
                        <div className="rates-col-num rates-cell-num">
                          <GripVertical size={14} className="rates-drag-icon" />
                          <span>{idx + 1}</span>
                        </div>

                        {/* Operation Name */}
                        <div className="rates-col-name rates-cell-name">
                          <span>{op.name}</span>
                        </div>

                        {/* Rate Input */}
                        <div className="rates-col-rate rates-cell-rate">
                          <div className="rates-rate-input-wrapper">
                            <input
                              type="number"
                              min="0"
                              value={rateNum === 0 ? '' : rateNum}
                              placeholder="0"
                              onChange={(e) => handleRateChange(idx, e.target.value)}
                              className="rates-rate-input"
                            />
                            <span className="rates-rate-unit">so'm</span>
                          </div>
                        </div>

                        {/* Trash Delete Action */}
                        <div className="rates-col-action rates-cell-action">
                          <button
                            type="button"
                            className="rates-delete-btn"
                            onClick={() => handleDeleteOperation(idx)}
                            title="Operatsiyani o'chirish"
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </div>
                    );
                  })}

                  {/* Inline Add Operation Form if open */}
                  {isAddingOp ? (
                    <div className="rates-add-row">
                      <div className="rates-col-num rates-cell-num">
                        <span>{draftOps.length + 1}</span>
                      </div>
                      <div className="rates-col-name">
                        <input
                          type="text"
                          placeholder="Yangi operatsiya nomi..."
                          value={newOpName}
                          onChange={(e) => setNewOpName(e.target.value)}
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleAddNewOperation();
                            if (e.key === 'Escape') setIsAddingOp(false);
                          }}
                          className="rates-new-op-input"
                        />
                      </div>
                      <div className="rates-col-rate">
                        <div className="rates-rate-input-wrapper">
                          <input
                            type="number"
                            min="0"
                            placeholder="0"
                            value={newOpRate}
                            onChange={(e) => setNewOpRate(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleAddNewOperation();
                              if (e.key === 'Escape') setIsAddingOp(false);
                            }}
                            className="rates-rate-input"
                          />
                          <span className="rates-rate-unit">so'm</span>
                        </div>
                      </div>
                      <div className="rates-col-action rates-add-actions">
                        <button
                          type="button"
                          onClick={handleAddNewOperation}
                          className="rates-add-confirm-btn"
                          title="Qo'shish"
                        >
                          <Check size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setIsAddingOp(false)}
                          className="rates-add-cancel-btn"
                          title="Bekor qilish"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* Add Operation Dashed Button */
                    <button
                      type="button"
                      className="rates-add-dashed-btn"
                      onClick={() => setIsAddingOp(true)}
                    >
                      <Plus size={16} />
                      <span>Operatsiya qo'shish</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Editor Footer Bar */}
              <div className="rates-editor-footer">
                <div className="rates-footer-left">
                  <span className="rates-footer-count">
                    {draftMetrics.pricedOps} / {draftMetrics.totalOps} narx kiritildi
                  </span>
                  <div className="rates-progress-track">
                    <div
                      className="rates-progress-fill"
                      style={{ width: `${draftMetrics.progressPercent}%` }}
                    />
                  </div>
                  <span className="rates-footer-total">
                    Jami model narxi:{' '}
                    <strong>{draftMetrics.totalRate.toLocaleString()} so'm</strong>
                  </span>
                </div>

                <div className="rates-footer-right">
                  <button
                    type="button"
                    onClick={handleReset}
                    disabled={!isDirty || isSaving}
                    className="rates-btn-cancel"
                  >
                    Bekor qilish
                  </button>
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={isSaving}
                    className="rates-btn-save"
                  >
                    {isSaving ? 'Saqlanmoqda...' : 'Saqlash'}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="rates-no-model">
              Model tanlanmagan
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
