import {
  ChevronsLeft,
  ChevronsRight,
  Copy,
  Edit3,
  FileText,
  Folder,
  History,
  Layers,
  LayoutGrid,
  MoreVertical,
  Plus,
  Printer,
  Ruler,
  Search,
  Table,
  Tag,
  Trash2,
  X
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SYSTEM_SHEETS, SYSTEM_SHEET_NAMES } from '../../constants/sheetConstants';
import { OperationRatesModal } from '../../features/models/modals/OperationRatesModal';
import { useWorkbookStore } from '../../store/workbookStore';
import { ModelConfig, SubmittedTicketRecord } from '../../types/workbook';

interface ContextMenuState {
  x: number;
  y: number;
  sheetName: string;
}

export const isModelNarxsiz = (m: ModelConfig): boolean => {
  if (!m.operations || m.operations.length === 0) return true;
  return m.operations.some((op) => !op.rate || op.rate <= 0);
};

export const isModelFaol = (m: ModelConfig, submittedTickets: SubmittedTicketRecord[] = []): boolean => {
  if (isModelNarxsiz(m)) return false;
  const hasTickets = submittedTickets.some((t) => t.modelId === m.id);
  const hasQuantities = Object.values(m.hisobQuantities || {}).some((ops) =>
    Object.values(ops || {}).some((qty) => typeof qty === 'number' && qty > 0)
  );
  return hasTickets || hasQuantities;
};

export const isModelPatta = (m: ModelConfig, currentSheet: string): boolean => {
  return currentSheet === m.name || currentSheet === m.id;
};

export const isModelHisob = (m: ModelConfig, currentSheet: string): boolean => {
  return (
    currentSheet === m.hisobSheetName ||
    currentSheet === `${m.name}-hisob` ||
    currentSheet === `${m.id}-hisob`
  );
};

export const isModelActive = (m: ModelConfig, currentSheet: string): boolean => {
  return isModelPatta(m, currentSheet) || isModelHisob(m, currentSheet);
};

export const SheetTabs: React.FC = () => {
  const activeSheet = useWorkbookStore((s) => s.activeSheet);
  const setActiveSheet = useWorkbookStore((s) => s.setActiveSheet);
  const models = useWorkbookStore((s) => s.models);
  const submittedTickets = useWorkbookStore((s) => s.submittedTickets) || [];
  const openModal = useWorkbookStore((s) => s.openModal);
  const deleteModel = useWorkbookStore((s) => s.deleteModel);
  const renameModel = useWorkbookStore((s) => s.renameModel);
  const confirmAction = useWorkbookStore((s) => s.confirmAction);
  const addModel = useWorkbookStore((s) => s.addModel);
  const addNotification = useWorkbookStore((s) => s.addNotification);

  const [isOpen, setIsOpen] = useState(false);
  const [searchFilter, setSearchFilter] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'active' | 'no_rates'>('all');
  const [showRatesModal, setShowRatesModal] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Resizable drawer width (standard 360px, customizable 320px - 700px)
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('hisob:sidebar-width');
      if (saved) {
        const val = parseInt(saved, 10);
        if (Number.isFinite(val) && val >= 320 && val <= 700) return val;
      }
    } catch {}
    return 360;
  });
  const [isResizing, setIsResizing] = useState(false);
  const isResizingRef = useRef(false);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    setIsResizing(true);
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isResizingRef.current) return;
      const newWidth = Math.min(Math.max(startWidth + (moveEvent.clientX - startX), 320), 700);
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      if (!isResizingRef.current) return;
      isResizingRef.current = false;
      setIsResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setSidebarWidth((curr) => {
        try {
          localStorage.setItem('hisob:sidebar-width', String(curr));
        } catch {}
        return curr;
      });
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [sidebarWidth]);

  // In-app rename modal state
  const [renameTargetModel, setRenameTargetModel] = useState<ModelConfig | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const searchInputRef = useRef<HTMLInputElement>(null);

  // Auto-close drawer whenever a sheet is selected
  const handleSheetClick = useCallback((name: string) => {
    setActiveSheet(name);
    setIsOpen(false);
  }, [setActiveSheet]);

  // Global keyboard shortcuts (Ctrl+B to toggle, / to focus search, ESC to close)
  useEffect(() => {
    const handleOutsideClick = () => setContextMenu(null);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (contextMenu) {
          setContextMenu(null);
        } else if (renameTargetModel) {
          setRenameTargetModel(null);
        } else if (showRatesModal) {
          setShowRatesModal(false);
        } else if (isOpen) {
          setIsOpen(false);
        }
      }

      // Shortcut Ctrl+B or Cmd+B to toggle sidebar drawer
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      }

      // Shortcut '/' to focus search input if drawer is open and not typing in an input
      if (e.key === '/' && isOpen && !showRatesModal && !renameTargetModel && !contextMenu) {
        const target = e.target as HTMLElement | null;
        const isEditing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
        if (!isEditing) {
          e.preventDefault();
          searchInputRef.current?.focus();
        }
      }
    };

    window.addEventListener('click', handleOutsideClick);
    window.addEventListener('contextmenu', handleOutsideClick);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('click', handleOutsideClick);
      window.removeEventListener('contextmenu', handleOutsideClick);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [contextMenu, isOpen, renameTargetModel, showRatesModal]);

  const getTargetModel = (name: string) => {
    return models.find((m) => m.name === name || m.id === name || m.hisobSheetName === name);
  };

  const isSystemSheet = (name: string) => {
    return (SYSTEM_SHEET_NAMES as readonly string[]).includes(name);
  };

  const handleTabContextMenu = useCallback((e: React.MouseEvent, name: string) => {
    e.preventDefault();
    e.stopPropagation();

    const targetEl = e.currentTarget as HTMLElement | null;
    let xPos: number;
    let yPos: number;

    if (targetEl && (targetEl.tagName === 'BUTTON' || targetEl.closest('button'))) {
      const btn = (targetEl.tagName === 'BUTTON' ? targetEl : targetEl.closest('button')) as HTMLElement;
      const rect = btn.getBoundingClientRect();
      if (rect.right + 230 <= window.innerWidth) {
        xPos = rect.right + 6;
      } else {
        xPos = Math.max(10, rect.left - 230);
      }
      yPos = Math.max(10, Math.min(rect.top - 6, window.innerHeight - 290));
    } else {
      xPos = Math.max(10, Math.min(e.clientX + 4, window.innerWidth - 240));
      yPos = Math.max(10, Math.min(e.clientY - 6, window.innerHeight - 290));
    }

    setContextMenu({
      x: xPos,
      y: yPos,
      sheetName: name
    });
  }, []);

  // Context Menu Actions
  const handleOpenPattaSheet = () => {
    if (contextMenu) {
      const model = getTargetModel(contextMenu.sheetName);
      if (model) {
        handleSheetClick(model.name);
      } else {
        handleSheetClick(contextMenu.sheetName);
      }
      setContextMenu(null);
    }
  };

  const handleOpenHisobSheet = () => {
    if (contextMenu) {
      const model = getTargetModel(contextMenu.sheetName);
      if (model) {
        handleSheetClick(model.hisobSheetName || `${model.name}-hisob`);
      }
      setContextMenu(null);
    }
  };

  const handleDeleteSheet = async () => {
    if (!contextMenu) return;
    const model = getTargetModel(contextMenu.sheetName);
    if (!model) {
      addNotification('warning', 'Ogohlantirish', 'Tizimning asosiy varag\'ini o\'chirib bo\'lmaydi.');
      setContextMenu(null);
      return;
    }

    if (models.length <= 1) {
      addNotification('error', 'Xatolik', 'Oxirgi modelni o\'chirib bo\'lmaydi.');
      setContextMenu(null);
      return;
    }

    setContextMenu(null);
    setIsOpen(false);

    const ok = await confirmAction({
      title: "Modelni o'chirish",
      message: `Haqiqatan ham "${model.name}" modelini va unga tegishli barcha varaq va operatsiyalarni butunlay o'chirmoqchimisiz?`,
      confirmText: "Ha, o'chirilsin",
      isDanger: true
    });

    if (ok) {
      deleteModel(model.id);
    }
  };

  const handleRenameSheet = () => {
    if (!contextMenu) return;
    const model = getTargetModel(contextMenu.sheetName);
    if (!model) {
      addNotification('info', 'Ma\'lumot', 'Faqat modellar nomini o\'zgartirish mumkin.');
      setContextMenu(null);
      return;
    }

    setRenameValue(model.name);
    setRenameTargetModel(model);
    setContextMenu(null);
  };

  const submitRename = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!renameTargetModel) return;
    const clean = renameValue.trim();
    if (!clean) {
      addNotification('warning', 'Ogohlantirish', 'Model nomi bo\'sh bo\'lishi mumkin emas.');
      return;
    }
    if (clean !== renameTargetModel.name) {
      renameModel(renameTargetModel.id, clean);
    }
    setRenameTargetModel(null);
    setIsOpen(false);
    setContextMenu(null);
  };

  const handleDuplicateModel = () => {
    if (!contextMenu) return;
    const model = getTargetModel(contextMenu.sheetName);
    if (!model) {
      openModal({ type: 'new_model' });
      setIsOpen(false);
      setContextMenu(null);
      return;
    }

    let cloneName = `${model.name}_Nusxa`;
    let counter = 2;
    while (
      models.some(
        (m) =>
          m.name.toLowerCase() === cloneName.toLowerCase() ||
          m.id.toLowerCase() === cloneName.toLowerCase()
      )
    ) {
      cloneName = `${model.name}_Nusxa_${counter}`;
      counter++;
    }

    addModel(cloneName, {
      templateType: 'clone',
      cloneFromId: model.id,
      title: `Модел- ${cloneName}`,
      party: model.party || '',
      color: model.color || 'Кора',
      size: model.size || 'XL'
    });
    setIsOpen(false);
    setContextMenu(null);
  };

  // Metrics for filter pills
  const faolCount = useMemo(() => {
    return models.filter((m) => isModelFaol(m, submittedTickets)).length;
  }, [models, submittedTickets]);

  const narxsizCount = useMemo(() => {
    return models.filter((m) => isModelNarxsiz(m)).length;
  }, [models]);

  // Filtered models list
  const filteredModels = useMemo(() => {
    return models.filter((m) => {
      // Pill filter
      if (filterMode === 'active' && !isModelFaol(m, submittedTickets)) return false;
      if (filterMode === 'no_rates' && !isModelNarxsiz(m)) return false;

      // Search query
      if (searchFilter.trim()) {
        const query = searchFilter.toLowerCase().trim();
        const matchName = m.name.toLowerCase().includes(query);
        const matchHisob = m.hisobSheetName.toLowerCase().includes(query);
        if (!matchName && !matchHisob) return false;
      }
      return true;
    });
  }, [models, filterMode, searchFilter, submittedTickets]);

  return (
    <>
      {/* 1. Toggle button (protrudes on left edge when collapsed) */}
      {!isOpen && (
        <button
          type="button"
          className="excel-sidebar-floating-toggle closed"
          onClick={() => setIsOpen(true)}
          title="Varaqlar menyusini ochish (>>)"
          aria-label="Varaqlar menyusini ochish"
        >
          <ChevronsRight size={16} strokeWidth={2.5} />
        </button>
      )}

      {/* 2. Backdrop Overlay (click to close) */}
      <div
        className={`excel-sidebar-backdrop ${isOpen ? 'open' : ''}`}
        onClick={() => {
          setIsOpen(false);
          setContextMenu(null);
        }}
      />

      {/* 3. Pixel-Perfect Sidebar Drawer */}
      <aside
        className={`excel-sidebar ${isOpen ? 'open' : ''} ${isResizing ? 'is-resizing' : ''}`}
        style={{ width: `${sidebarWidth}px` }}
        onContextMenu={(e) => handleTabContextMenu(e, activeSheet)}
      >
        {/* Right edge resizer handle */}
        {isOpen && (
          <div
            className={`excel-sidebar-resizer ${isResizing ? 'active' : ''}`}
            onMouseDown={handleResizeMouseDown}
            title="Enini o'zgartirish uchun suring (2 marta bosilsa standart 360px ga qaytadi)"
            onDoubleClick={() => {
              setSidebarWidth(360);
              try { localStorage.setItem('hisob:sidebar-width', '360'); } catch {}
            }}
          />
        )}

        {/* Floating close tab on drawer right edge */}
        {isOpen && (
          <button
            type="button"
            className="excel-sidebar-floating-toggle open"
            onClick={() => setIsOpen(false)}
            title="Varaqlar menyusini yopish (<<)"
            aria-label="Varaqlar menyusini yopish"
          >
            <ChevronsLeft size={16} strokeWidth={2.5} />
          </button>
        )}

        {/* Header: Brand title + "+ Model" button + Close button */}
        <div className="excel-sidebar-header">
          <div className="excel-sidebar-brand">
            <LayoutGrid size={18} strokeWidth={2.2} className="excel-sidebar-brand-icon" />
            <span className="excel-sidebar-brand-title">Varaqlar</span>
          </div>

          <div className="excel-sidebar-header-actions">
            <button
              type="button"
              onClick={() => {
                openModal({ type: 'new_model' });
                setIsOpen(false);
              }}
              className="excel-sidebar-add-btn"
              title="Yangi model qo'shish (+)"
            >
              <Plus size={14} strokeWidth={2.5} />
              <span>Model</span>
            </button>

            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="excel-sidebar-close-btn"
              title="Yopish (Esc)"
              aria-label="Yopish"
            >
              <X size={15} strokeWidth={2} />
            </button>
          </div>
        </div>

        {/* Scrollable Main Area */}
        <div className="excel-sidebar-body">
          {/* Section: ASOSIY */}
          <div className="excel-sidebar-section-heading">ASOSIY</div>

          <div className="excel-sidebar-nav-group">
            {/* 1. Umumiy hisobot */}
            <button
              type="button"
              className={`excel-sidebar-nav-item ${activeSheet === 'Umumiy' ? 'active' : ''}`}
              onClick={() => handleSheetClick('Umumiy')}
              onContextMenu={(e) => handleTabContextMenu(e, 'Umumiy')}
              title="Umumiy oylik hisobot va ishchilar maoshi"
            >
              <Folder size={17} strokeWidth={2} className="excel-sidebar-nav-icon" />
              <span className="excel-sidebar-nav-label">Umumiy hisobot</span>
            </button>

            {/* 2. Modellar kesimida jami */}
            <button
              type="button"
              className={`excel-sidebar-nav-item ${
                activeSheet === 'Modellar-jami' ||
                activeSheet === 'Modellar' ||
                activeSheet === 'Modellar kesimida jami' ||
                activeSheet === 'Modellar kesimi jami'
                  ? 'active'
                  : ''
              }`}
              onClick={() => handleSheetClick('Modellar-jami')}
              onContextMenu={(e) => handleTabContextMenu(e, 'Modellar-jami')}
              title="Modellar kesimida jami hisobot, narx va tafovutlar"
            >
              <LayoutGrid size={17} strokeWidth={2} className="excel-sidebar-nav-icon" />
              <span className="excel-sidebar-nav-label">Modellar kesimida jami</span>
            </button>

            {/* 3. Patta chiqarish */}
            <button
              type="button"
              className={`excel-sidebar-nav-item ${activeSheet === 'Patta' ? 'active' : ''}`}
              onClick={() => handleSheetClick('Patta')}
              onContextMenu={(e) => handleTabContextMenu(e, 'Patta')}
              title="Pattalar chop etish va partiyalarni boshqarish"
            >
              <Printer size={17} strokeWidth={2} className="excel-sidebar-nav-icon" />
              <span className="excel-sidebar-nav-label">Patta chiqarish</span>
            </button>

            {/* 3. Patta-hisob (jurnal) */}
            <button
              type="button"
              className={`excel-sidebar-nav-item ${activeSheet === 'Patta-hisob' ? 'active' : ''}`}
              onClick={() => handleSheetClick('Patta-hisob')}
              onContextMenu={(e) => handleTabContextMenu(e, 'Patta-hisob')}
              title="Topshirilgan pattalar jurnali va arxivi"
            >
              <FileText size={17} strokeWidth={2} className="excel-sidebar-nav-icon" />
              <span className="excel-sidebar-nav-label">Patta-hisob (jurnal)</span>
            </button>

            {/* 4. Konveyer */}
            <button
              type="button"
              className={`excel-sidebar-nav-item ${activeSheet === 'Konveyer' || activeSheet === 'Конвейер' ? 'active' : ''}`}
              onClick={() => handleSheetClick('Konveyer')}
              onContextMenu={(e) => handleTabContextMenu(e, 'Konveyer')}
              title="Konveyer operatsiyalari va taqsimoti"
            >
              <Layers size={17} strokeWidth={2} className="excel-sidebar-nav-icon" />
              <span className="excel-sidebar-nav-label">Konveyer</span>
            </button>

            {/* 5. Operatsiya narxlari */}
            <button
              type="button"
              className={`excel-sidebar-nav-item ${activeSheet === SYSTEM_SHEETS.OPERATSIYA_NARXLARI || activeSheet === 'Operatsiya-narxlari' ? 'active' : ''}`}
              onClick={() => handleSheetClick(SYSTEM_SHEETS.OPERATSIYA_NARXLARI)}
              onContextMenu={(e) => handleTabContextMenu(e, SYSTEM_SHEETS.OPERATSIYA_NARXLARI)}
              title="Barcha operatsiyalar va ularning narxlarini boshqarish"
            >
              <Tag size={16} strokeWidth={2} className="excel-sidebar-nav-icon" />
              <span className="excel-sidebar-nav-label">Operatsiya narxlari</span>
            </button>

            {/* 6. Amallar jurnali */}
            <button
              type="button"
              className={`excel-sidebar-nav-item ${
                activeSheet === SYSTEM_SHEETS.AMALLAR_JURNALI ||
                activeSheet === 'Amallar-jurnali' ||
                activeSheet === 'Amallar jurnali'
                  ? 'active'
                  : ''
              }`}
              onClick={() => handleSheetClick(SYSTEM_SHEETS.AMALLAR_JURNALI)}
              onContextMenu={(e) => handleTabContextMenu(e, SYSTEM_SHEETS.AMALLAR_JURNALI)}
              title="Kim qachon nimani qilgan — amallar jurnali"
            >
              <History size={16} strokeWidth={2} className="excel-sidebar-nav-icon" />
              <span className="excel-sidebar-nav-label">Amallar jurnali</span>
            </button>

            {/* 7. Model o'lchamlari */}
            <button
              type="button"
              className={`excel-sidebar-nav-item ${
                activeSheet === SYSTEM_SHEETS.MODEL_OLCHAMLARI ||
                activeSheet === 'Model-olchamlari' ||
                activeSheet === 'Model o\'lchamlari'
                  ? 'active'
                  : ''
              }`}
              onClick={() => handleSheetClick(SYSTEM_SHEETS.MODEL_OLCHAMLARI)}
              onContextMenu={(e) => handleTabContextMenu(e, SYSTEM_SHEETS.MODEL_OLCHAMLARI)}
              title="Har model uchun razmerlarni sozlash"
            >
              <Ruler size={16} strokeWidth={2} className="excel-sidebar-nav-icon" />
              <span className="excel-sidebar-nav-label">Model o'lchamlari</span>
            </button>
          </div>

          {/* Section: MODELLAR */}
          <div className="excel-sidebar-section-heading" style={{ marginTop: '14px' }}>
            MODELLAR · {models.length}
          </div>

          {/* Search Input */}
          <div className="excel-sidebar-search-container">
            <div className="excel-sidebar-search-box">
              <Search size={15} className="excel-sidebar-search-icon" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                placeholder="Model qidirish"
                className="excel-sidebar-search-input"
              />
              {searchFilter ? (
                <button
                  type="button"
                  onClick={() => setSearchFilter('')}
                  className="excel-sidebar-search-clear"
                  title="Tozalash"
                >
                  <X size={13} />
                </button>
              ) : (
                <kbd className="excel-sidebar-search-badge" title="Qidirish tugmasi (/)">/</kbd>
              )}
            </div>
          </div>

          {/* Filter Pills Row */}
          <div className="excel-sidebar-pills-row">
            <button
              type="button"
              className={`excel-sidebar-filter-pill ${filterMode === 'all' ? 'active' : ''}`}
              onClick={() => setFilterMode('all')}
            >
              Hammasi
            </button>

            <button
              type="button"
              className={`excel-sidebar-filter-pill ${filterMode === 'active' ? 'active' : ''}`}
              onClick={() => setFilterMode('active')}
            >
              <span className="excel-sidebar-pill-dot dot-green" />
              <span>Faol · {faolCount}</span>
            </button>

            <button
              type="button"
              className={`excel-sidebar-filter-pill ${filterMode === 'no_rates' ? 'active' : ''}`}
              onClick={() => setFilterMode('no_rates')}
            >
              <span className="excel-sidebar-pill-dot dot-amber" />
              <span>Narxsiz · {narxsizCount}</span>
            </button>
          </div>

          {/* Models List */}
          <div className="excel-sidebar-models-list">
            {filteredModels.map((m) => {
              const active = isModelActive(m, activeSheet);
              const isHisob = isModelHisob(m, activeSheet);
              const isNarxsiz = isModelNarxsiz(m);
              const isFaol = isModelFaol(m, submittedTickets);

              return (
                <div
                  key={m.id}
                  className={`excel-sidebar-model-item ${active ? 'active' : ''}`}
                  onClick={() => handleSheetClick(m.name)}
                  onContextMenu={(e) => handleTabContextMenu(e, m.name)}
                  title={`${m.name} — Patta kiritish varag'i (O'ng tugma: qo'shimcha amallar)`}
                >
                  <FileText
                    size={16}
                    strokeWidth={1.8}
                    className={`excel-sidebar-model-icon ${active ? 'active' : ''}`}
                  />
                  <span className="excel-sidebar-model-title">{m.name}</span>

                  {/* Actions (Hisob Table Icon [ 田 ] + 3-dots Menu [ ⋮ ]) */}
                  <div
                    className={`excel-sidebar-model-actions ${active ? 'always-visible' : ''}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      className={`excel-sidebar-action-btn excel-sidebar-hisob-btn ${isHisob ? 'active' : ''}`}
                      onClick={() => handleSheetClick(m.hisobSheetName || `${m.name}-hisob`)}
                      title={`${m.hisobSheetName || `${m.name}-hisob`} — Model hisob-kitobini ochish`}
                      aria-label={`${m.name} hisob varag'i`}
                    >
                      <Table size={15} strokeWidth={2} />
                    </button>
                    <button
                      type="button"
                      className="excel-sidebar-action-btn"
                      onClick={(e) => handleTabContextMenu(e, m.name)}
                      title="Model amallari (nomini o'zgartirish, o'chirish...)"
                      aria-label="Model amallari"
                    >
                      <MoreVertical size={14} />
                    </button>
                  </div>

                  {/* Status Indicator Dot */}
                  <div className="excel-sidebar-model-status">
                    {isNarxsiz ? (
                      <span className="excel-sidebar-status-dot dot-amber" title="Operatsiya narxi kiritilmagan" />
                    ) : isFaol ? (
                      <span className="excel-sidebar-status-dot dot-green" title="Faol ishlab chiqarishdagi model" />
                    ) : null}
                  </div>
                </div>
              );
            })}

            {filteredModels.length === 0 && (
              <div style={{ padding: '24px 12px', textAlign: 'center', fontSize: '15px', color: '#94a3b8' }}>
                Model topilmadi
              </div>
            )}
          </div>
        </div>

        {/* Footer: Count and Status */}
        <div className="excel-sidebar-footer">
          <span className="excel-sidebar-footer-left">{models.length} ta model</span>
          <div className="excel-sidebar-footer-right">
            <span className="excel-sidebar-pill-dot dot-green" />
            <span>Tayyor</span>
          </div>
        </div>

        {/* Modern Context Menu */}
        {contextMenu && typeof document !== 'undefined' && createPortal(
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'fixed',
              left: `${contextMenu.x}px`,
              top: `${contextMenu.y}px`,
              zIndex: 9999,
              minWidth: '220px',
              backgroundColor: 'var(--bg-surface, #ffffff)',
              border: '1px solid var(--border-subtle, #e5e7eb)',
              borderRadius: '12px',
              boxShadow: '0 12px 30px rgba(0,0,0,0.2)',
              padding: '6px',
              display: 'flex',
              flexDirection: 'column',
              gap: '2px',
              animation: 'menuSlideUp 0.15s cubic-bezier(0.16, 1, 0.3, 1)'
            }}
          >
            {/* Header pill indicator */}
            <div style={{
              padding: '6px 10px 8px',
              fontSize: '14px',
              fontWeight: 700,
              color: 'var(--text-muted, #64748b)',
              borderBottom: '1px solid var(--border-subtle, #f1f5f9)',
              marginBottom: '4px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '140px' }}>
                Varaq: {contextMenu.sheetName}
              </span>
              <span style={{
                fontSize: '13px',
                padding: '1px 6px',
                borderRadius: '9999px',
                background: isSystemSheet(contextMenu.sheetName) ? '#f1f5f9' : '#ecfdf5',
                color: isSystemSheet(contextMenu.sheetName) ? '#64748b' : '#047857'
              }}>
                {isSystemSheet(contextMenu.sheetName) ? 'Tizim' : 'Model'}
              </span>
            </div>

            {/* 1. Open Patta Sheet */}
            <button
              onClick={handleOpenPattaSheet}
              className="context-menu-item"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                width: '100%',
                padding: '7px 10px',
                background: 'transparent',
                border: 'none',
                borderRadius: '8px',
                color: 'var(--text-primary, #1e293b)',
                fontSize: '15px',
                fontWeight: 600,
                cursor: 'pointer',
                textAlign: 'left'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#f1f5f9')}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
            >
              <FileText size={14} color="#2563eb" />
              <span>Patta varag'ini ochish</span>
            </button>

            {/* 2. Open Hisob Sheet (For models) */}
            {!isSystemSheet(contextMenu.sheetName) && (
              <button
                onClick={handleOpenHisobSheet}
                className="context-menu-item"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  width: '100%',
                  padding: '7px 10px',
                  background: 'transparent',
                  border: 'none',
                  borderRadius: '8px',
                  color: 'var(--text-primary, #1e293b)',
                  fontSize: '15px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  textAlign: 'left'
                }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#ede9fe')}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
              >
                <Table size={14} color="#6366f1" />
                <span style={{ color: '#4f46e5' }}>Hisob-kitob varag'ini ochish</span>
              </button>
            )}

            {/* 3. Add New Model */}
            <button
              onClick={() => {
                openModal({ type: 'new_model' });
                setIsOpen(false);
                setContextMenu(null);
              }}
              className="context-menu-item"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                width: '100%',
                padding: '7px 10px',
                background: 'transparent',
                border: 'none',
                borderRadius: '8px',
                color: 'var(--text-primary, #1e293b)',
                fontSize: '15px',
                fontWeight: 500,
                cursor: 'pointer',
                textAlign: 'left'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#f1f5f9')}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
            >
              <Plus size={14} color="#059669" />
              <span>Yangi model qo'shish</span>
            </button>

            {/* 4. Rename Model (Model sheets only) */}
            {!isSystemSheet(contextMenu.sheetName) && (
              <button
                onClick={handleRenameSheet}
                className="context-menu-item"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  width: '100%',
                  padding: '7px 10px',
                  background: 'transparent',
                  border: 'none',
                  borderRadius: '8px',
                  color: 'var(--text-primary, #1e293b)',
                  fontSize: '15px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  textAlign: 'left'
                }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#f1f5f9')}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
              >
                <Edit3 size={14} color="#f59e0b" />
                <span>Nomini o'zgartirish...</span>
              </button>
            )}

            {/* 5. Duplicate / Clone Model */}
            {!isSystemSheet(contextMenu.sheetName) && (
              <button
                onClick={handleDuplicateModel}
                className="context-menu-item"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  width: '100%',
                  padding: '7px 10px',
                  background: 'transparent',
                  border: 'none',
                  borderRadius: '8px',
                  color: 'var(--text-primary, #1e293b)',
                  fontSize: '15px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  textAlign: 'left'
                }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#f1f5f9')}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
              >
                <Copy size={14} color="#6366f1" />
                <span>Nusxa olish (Dublikat)</span>
              </button>
            )}

            <div style={{ height: '1px', background: 'var(--border-subtle, #f1f5f9)', margin: '4px 0' }} />

            {/* 6. Delete Sheet (Models only) */}
            {!isSystemSheet(contextMenu.sheetName) && (
              <button
                onClick={handleDeleteSheet}
                className="context-menu-item"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  width: '100%',
                  padding: '7px 10px',
                  background: 'transparent',
                  border: 'none',
                  borderRadius: '8px',
                  color: '#ef4444',
                  fontSize: '15px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  textAlign: 'left'
                }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#fee2e2')}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
              >
                <Trash2 size={14} color="#ef4444" />
                <span>O'chirish</span>
              </button>
            )}
          </div>,
          document.body
        )}

        {/* In-App Rename Modal */}
        {renameTargetModel && typeof document !== 'undefined' && createPortal(
          <div
            onClick={() => setRenameTargetModel(null)}
            style={{
              position: 'fixed',
              inset: 0,
              backgroundColor: 'rgba(0, 0, 0, 0.45)',
              backdropFilter: 'blur(2px)',
              zIndex: 99999,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              animation: 'fadeIn 0.15s ease'
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: '380px',
                backgroundColor: 'var(--bg-surface, #ffffff)',
                borderRadius: '16px',
                boxShadow: '0 20px 40px rgba(0, 0, 0, 0.3)',
                border: '1px solid var(--border-subtle, #e5e7eb)',
                overflow: 'hidden',
                animation: 'scaleUp 0.15s cubic-bezier(0.16, 1, 0.3, 1)'
              }}
            >
              <div style={{
                padding: '14px 18px',
                borderBottom: '1px solid var(--border-subtle, #e5e7eb)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: 'var(--bg-surface-subtle, #f8fafc)'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Edit3 size={16} color="#047857" />
                  <span style={{ fontWeight: 700, fontSize: '17px', color: 'var(--text-primary, #111827)' }}>
                    Model nomini o'zgartirish
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setRenameTargetModel(null)}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted, #64748b)' }}
                >
                  <X size={16} />
                </button>
              </div>

              <form onSubmit={submitRename} style={{ padding: '18px' }}>
                <label style={{ display: 'block', fontSize: '15px', fontWeight: 600, color: 'var(--text-secondary, #475569)', marginBottom: '6px' }}>
                  Yangi model nomi:
                </label>
                <input
                  type="text"
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  placeholder="Masalan: M-12 yoki Ko'ylak-2026"
                  className="soft-input"
                  style={{ width: '100%', height: '36px', fontSize: '15px', padding: '0 12px', marginBottom: '16px' }}
                />

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                  <button
                    type="button"
                    onClick={() => setRenameTargetModel(null)}
                    className="soft-btn"
                    style={{ padding: '6px 14px', fontSize: '15px' }}
                  >
                    Bekor qilish
                  </button>
                  <button
                    type="submit"
                    className="soft-btn soft-btn-primary"
                    style={{ padding: '6px 18px', fontSize: '15px', fontWeight: 700 }}
                  >
                    Saqlash
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body
        )}

        {/* Operation Rates Modal */}
        {showRatesModal && (
          <OperationRatesModal onClose={() => setShowRatesModal(false)} />
        )}
      </aside>
    </>
  );
};
