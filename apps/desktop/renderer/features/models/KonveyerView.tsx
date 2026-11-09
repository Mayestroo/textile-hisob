import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { 
  Factory, 
  Search, 
  ArrowDownToLine,
  Layers, 
  Shirt, 
  TrendingUp, 
  RotateCcw, 
  ChevronRight, 
  ChevronLeft,
  ChevronDown,
  Trash2, 
  Edit2,
  AlertTriangle
} from 'lucide-react';
import { useWorkbookStore } from '../../store/workbookStore';
import { useAuthStore } from '../../store/authStore';
import { displayedMoney, payrollDisplay } from '../../engine/payrollDisplay';
import { CustomSelect } from '../../components/ui/CustomSelect';
import { formatDateIso, formatMoney, formatTicketDateTime, sortTicketsNewestFirst } from '../../utils/formatters';

const CONVEYOR_BADGE_STYLES = [
  { bg: '#ede9fe', color: '#6b21a8' }, // 1-konveyer: purple
  { bg: '#dbeafe', color: '#1d4ed8' }, // 2-konveyer: blue
  { bg: '#cffafe', color: '#0e7490' }, // 3-konveyer: cyan
  { bg: '#fef3c7', color: '#b45309' }, // 4-konveyer: amber
  { bg: '#fce7f3', color: '#be185d' }, // 5-konveyer: pink
];

const getConveyorBadgeStyle = (kVal?: string) => {
  const norm = (kVal || '').trim();
  if (!norm || norm === "Noma'lum" || norm.toLowerCase() === "noma'lum") {
    return { bg: '#fef3c7', color: '#b45309', label: "Noma'lum" };
  }
  const match = norm.match(/^(\d+)/);
  if (match) {
    const num = parseInt(match[1], 10);
    const style = CONVEYOR_BADGE_STYLES[(num - 1) % CONVEYOR_BADGE_STYLES.length];
    return { bg: style.bg, color: style.color, label: `${num}-konveyer` };
  }
  return { bg: '#e2e8f0', color: '#475569', label: norm };
};

const CONVEYOR_COLORS = [
  '#7c3aed', // Purple
  '#3b82f6', // Blue
  '#06b6d4', // Cyan
  '#f59e0b', // Amber
  '#ec4899', // Pink
  '#10b981', // Emerald
  '#8b5cf6', // Violet
];

const MODEL_COLORS = [
  '#059669', // Emerald dark
  '#34d399', // Emerald medium
  '#6ee7b7', // Emerald light
  '#a7f3d0', // Mint pale
  '#cbd5e1', // Slate / Others
];

export const KonveyerView: React.FC = () => {
  const submittedTickets = useWorkbookStore((s) => s.submittedTickets);
  const models = useWorkbookStore((s) => s.models);
  const workers = useWorkbookStore((s) => s.workers);
  const payrollValuation = useWorkbookStore((s) => s.payrollValuation);
  const currentPeriod = useWorkbookStore((s) => s.currentPeriod);
  const licenseStatus = useWorkbookStore((s) => s.licenseStatus);
  const licenseCompanyId = licenseStatus?.companyId;
  const authCompanyId = useAuthStore((s) => s.companyId);
  const authUserId = useAuthStore((s) => s.user?.uid || '');
  const authRole = useAuthStore((s) => s.role || '');
  const companyId = licenseCompanyId || authCompanyId;

  const displayWorkers = useMemo(() => [
    ...workers,
    ...payrollValuation.workers
      .filter((item) => !workers.some((worker) => worker.id === Number(item.workerId)))
      .map((item) => ({
        id: Number(item.workerId),
        name: item.name || `Ishchi #${item.workerId}`,
        staj: Number(item.staj || 0),
        avans: Number(item.avans || 0),
        jarima: Number(item.jarima || 0)
      }))
  ], [workers, payrollValuation]);

  const display = useMemo(() => 
    payrollDisplay(models, displayWorkers, payrollValuation, companyId || undefined, currentPeriod.id),
    [models, displayWorkers, payrollValuation, companyId, currentPeriod.id]
  );

  const selectedArchiveFilename = useWorkbookStore((s) => s.selectedArchiveFilename);
  const deleteSubmittedTicket = useWorkbookStore((s) => s.deleteSubmittedTicket);
  const confirmAction = useWorkbookStore((s) => s.confirmAction);
  const openModal = useWorkbookStore((s) => s.openModal);
  const setActiveSheet = useWorkbookStore((s) => s.setActiveSheet);
  const isArchiveMode = !!selectedArchiveFilename;

  const filterScope = JSON.stringify([
    companyId || '',
    currentPeriod.id,
    selectedArchiveFilename || '',
    licenseStatus?.activationId || '',
    licenseStatus?.machineId || '',
    licenseStatus?.role || '',
    authCompanyId || '',
    authUserId,
    authRole
  ]);
  const filterStorageKey = `konveyer:filters:${filterScope}`;

  const readFilters = (key: string) => {
    try {
      const raw = window.sessionStorage.getItem(key);
      if (!raw) return { search: '', tab: 'matrix' as const, onlyActiveModels: true, konveyer: 'all', model: 'all', party: 'all', date: 'all', patta: 'all', color: 'all', size: 'all' };
      const value = JSON.parse(raw);
      return {
        search: typeof value.search === 'string' ? value.search : '',
        tab: value.tab === 'details' ? 'details' as const : 'matrix' as const,
        onlyActiveModels: value.onlyActiveModels !== false,
        konveyer: typeof value.konveyer === 'string' ? value.konveyer : 'all',
        model: typeof value.model === 'string' ? value.model : 'all',
        party: typeof value.party === 'string' ? value.party : 'all',
        date: typeof value.date === 'string' ? value.date : 'all',
        patta: typeof value.patta === 'string' ? value.patta : 'all',
        color: typeof value.color === 'string' ? value.color : 'all',
        size: typeof value.size === 'string' ? value.size : 'all',
      };
    } catch {
      return { search: '', tab: 'matrix' as const, onlyActiveModels: true, konveyer: 'all', model: 'all', party: 'all', date: 'all', patta: 'all', color: 'all', size: 'all' };
    }
  };

  const [savedFilters, setSavedFilters] = useState(() => ({ scope: filterScope, ...readFilters(filterStorageKey) }));
  const scopedFilters = savedFilters.scope === filterScope ? savedFilters : { scope: filterScope, ...readFilters(filterStorageKey) };
  const searchQuery = scopedFilters.search;
  const setSearchQuery = (search: string) => updateFilters({ search });
  const updateFilters = (patch: Partial<Omit<typeof scopedFilters, 'scope'>>) => setSavedFilters((previous) => ({
    ...(previous.scope === filterScope ? previous : scopedFilters), ...patch, scope: filterScope
  }));

  useEffect(() => {
    if (savedFilters.scope !== filterScope) setSavedFilters({ scope: filterScope, ...readFilters(filterStorageKey) });
  }, [filterScope, filterStorageKey, savedFilters.scope]);

  useEffect(() => {
    if (savedFilters.scope !== filterScope) return;
    try {
      const { scope: _scope, ...value } = savedFilters;
      if (
        value.search ||
        value.tab !== 'matrix' ||
        !value.onlyActiveModels ||
        value.konveyer !== 'all' ||
        value.model !== 'all' ||
        value.party !== 'all' ||
        value.date !== 'all' ||
        value.patta !== 'all' ||
        value.color !== 'all' ||
        value.size !== 'all'
      ) {
        window.sessionStorage.setItem(filterStorageKey, JSON.stringify(value));
      } else {
        window.sessionStorage.removeItem(filterStorageKey);
      }
    } catch { /* Filtering remains available when session storage is unavailable. */ }
  }, [filterScope, filterStorageKey, savedFilters]);

  const activeTab = scopedFilters.tab;
  const setActiveTab = (tab: 'matrix' | 'details') => updateFilters({ tab });
  const onlyActiveModels = scopedFilters.onlyActiveModels;
  const setOnlyActiveModels = (value: boolean) => updateFilters({ onlyActiveModels: value });

  // State for expanding inactive models below matrix table
  const [showInactive, setShowInactive] = useState(false);

  // Detail filters
  const selectedKonveyer = scopedFilters.konveyer;
  const setSelectedKonveyer = (konveyer: string) => updateFilters({ konveyer });
  const selectedModel = scopedFilters.model;
  const setSelectedModel = (model: string) => updateFilters({ model });
  const selectedParty = scopedFilters.party;
  const setSelectedParty = (party: string) => updateFilters({ party });
  const selectedDate = scopedFilters.date;
  const setSelectedDate = (date: string) => updateFilters({ date });
  const selectedPatta = scopedFilters.patta;
  const setSelectedPatta = (patta: string) => updateFilters({ patta });
  const selectedColor = scopedFilters.color;
  const setSelectedColor = (color: string) => updateFilters({ color });
  const selectedSize = scopedFilters.size;
  const setSelectedSize = (size: string) => updateFilters({ size });

  // Bottom submitted tickets card state
  const [bottomConveyorPill, setBottomConveyorPill] = useState<string>('all');
  const [bottomModelFilter, setBottomModelFilter] = useState<string>('all');
  const [ticketsPage, setTicketsPage] = useState<number>(1);
  const TICKETS_PER_PAGE = 10;

  // Reset page when filters change
  useEffect(() => {
    setTicketsPage(1);
  }, [bottomConveyorPill, bottomModelFilter]);

  // Worker & model lookups
  const workerMap = useMemo(() => {
    const map = new Map<number, string>();
    for (const w of workers) {
      map.set(w.id, w.name);
    }
    return map;
  }, [workers]);

  const modelMap = useMemo(() => {
    const map = new Map<string, typeof models[0]>();
    for (const m of models) {
      map.set(m.id, m);
    }
    return map;
  }, [models]);

  // Wage calculation
  const calculateTicketAmount = useCallback((ticket: typeof submittedTickets[0]) => {
    if (!display.ready || ticket.periodId !== currentPeriod.id) return null;
    let total = 0;
    for (const entry of ticket.entries || []) {
      const rate = display.operationRates[ticket.modelId]?.[entry.opName];
      if (rate === null || rate === undefined || !display.masterReport.workers.some((w) => w.workerId === entry.workerId)) return null;
      total += rate * ticket.qty;
    }
    return total;
  }, [display, currentPeriod.id]);



  const periodGrossKnown = display.ready && submittedTickets.every((ticket) =>
    ticket.periodId !== currentPeriod.id || (ticket.entries || []).every((entry) =>
      display.masterReport.workers.some((worker) => worker.workerId === entry.workerId)))
    && display.masterReport.workers.every((worker) =>
    display.displayModels.every((model) => model.operations.every((op) =>
      display.cellAmounts[display.key(model.id, worker.workerId, op.name)] !== null)));

  // Extract unique konveyers from submitted tickets
  const uniqueKonveyers = useMemo(() => {
    const set = new Set<string>();
    for (const t of submittedTickets || []) {
      const k = (t.konveyer || '').trim();
      if (k) set.add(k);
    }
    return Array.from(set).sort((a, b) => {
      const numA = parseInt(a, 10);
      const numB = parseInt(b, 10);
      if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
      return a.localeCompare(b);
    });
  }, [submittedTickets]);

  const hasUnknownKonveyer = useMemo(() => {
    return (submittedTickets || []).some((t) => !(t.konveyer || '').trim());
  }, [submittedTickets]);

  const allKonveyerKeys = useMemo(() => {
    const list = [...uniqueKonveyers];
    if (hasUnknownKonveyer) list.push('Noma\'lum');
    return list;
  }, [uniqueKonveyers, hasUnknownKonveyer]);

  // Matrix data: konveyerKey -> modelId -> { qty, pattaCount, amount }
  const matrixData = useMemo(() => {
    const data: Record<string, {
      konveyer: string;
      modelBreakdown: Record<string, { qty: number; pattaCount: number; amount: number | null }>;
      totalQty: number;
      totalPattas: number;
      totalAmount: number | null;
      tickets: typeof submittedTickets;
    }> = {};

    for (const k of allKonveyerKeys) {
      data[k] = {
        konveyer: k,
        modelBreakdown: {},
        totalQty: 0,
        totalPattas: 0,
        totalAmount: 0,
        tickets: []
      };
      for (const m of models) {
        data[k].modelBreakdown[m.id] = { qty: 0, pattaCount: 0, amount: 0 };
      }
    }

    for (const t of submittedTickets || []) {
      const k = (t.konveyer || '').trim() || 'Noma\'lum';
      if (!data[k]) {
        data[k] = {
          konveyer: k,
          modelBreakdown: {},
          totalQty: 0,
          totalPattas: 0,
          totalAmount: 0,
          tickets: []
        };
        for (const m of models) {
          data[k].modelBreakdown[m.id] = { qty: 0, pattaCount: 0, amount: 0 };
        }
      }

      const targetModel = models.find((m) => m.id === t.modelId || m.name === t.modelId);
      const mId = targetModel ? targetModel.id : t.modelId;

      if (!data[k].modelBreakdown[mId]) {
        data[k].modelBreakdown[mId] = { qty: 0, pattaCount: 0, amount: 0 };
      }

      const amt = calculateTicketAmount(t);
      data[k].modelBreakdown[mId].qty += t.qty;
      data[k].modelBreakdown[mId].pattaCount += 1;
      const existingModelAmount = data[k].modelBreakdown[mId].amount;
      data[k].modelBreakdown[mId].amount = existingModelAmount === null || amt === null ? null : existingModelAmount + amt;

      data[k].totalQty += t.qty;
      data[k].totalPattas += 1;
      data[k].totalAmount = data[k].totalAmount === null || amt === null ? null : data[k].totalAmount + amt;
      data[k].tickets.push(t);
    }

    return data;
  }, [allKonveyerKeys, submittedTickets, models, calculateTicketAmount]);

  // Model column totals across all konveyers
  const modelTotals = useMemo(() => {
    const totals: Record<string, { totalQty: number; totalPattas: number; totalAmount: number | null }> = {};
    for (const m of models) {
      totals[m.id] = { totalQty: 0, totalPattas: 0, totalAmount: 0 };
    }

    for (const row of Object.values(matrixData)) {
      for (const m of models) {
        const item = row.modelBreakdown[m.id] || { qty: 0, pattaCount: 0, amount: 0 };
        totals[m.id].totalQty += item.qty;
        totals[m.id].totalPattas += item.pattaCount;
        const currentAmount = totals[m.id].totalAmount;
        totals[m.id].totalAmount = currentAmount === null || item.amount === null ? null : currentAmount + item.amount;
      }
    }
    return totals;
  }, [matrixData, models]);

  // Grand totals across all konveyers and models
  const grandTotals = useMemo(() => {
    let totalQty = 0;
    let totalPattas = 0;
    let totalAmount: number | null = 0;

    for (const row of Object.values(matrixData)) {
      totalQty += row.totalQty;
      totalPattas += row.totalPattas;
      totalAmount = totalAmount === null || row.totalAmount === null ? null : totalAmount + row.totalAmount;
    }

    return {
      activeKonveyersCount: allKonveyerKeys.length,
      totalQty,
      totalPattas,
      totalAmount
    };
  }, [matrixData, allKonveyerKeys]);

  // Active vs Inactive models list sorted descending by work quantity
  const { activeModels, inactiveModels } = useMemo(() => {
    const active: typeof models = [];
    const inactive: typeof models = [];

    for (const m of models) {
      const qty = modelTotals[m.id]?.totalQty || 0;
      if (qty > 0) {
        active.push(m);
      } else {
        inactive.push(m);
      }
    }

    active.sort((a, b) => (modelTotals[b.id]?.totalQty || 0) - (modelTotals[a.id]?.totalQty || 0));
    inactive.sort((a, b) => (a?.name || '').localeCompare(b?.name || ''));

    return { activeModels: active, inactiveModels: inactive };
  }, [models, modelTotals]);

  // Filtered models for matrix table based on search & toggle
  const displayedModels = useMemo(() => {
    let list = onlyActiveModels ? (showInactive ? [...activeModels, ...inactiveModels] : activeModels) : models;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter((m) => {
        const matchesName = m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
        const matchesKonveyer = allKonveyerKeys.some((k) => {
          const qty = matrixData[k]?.modelBreakdown[m.id]?.qty || 0;
          return qty > 0 && k.toLowerCase().includes(q);
        });
        return matchesName || matchesKonveyer;
      });
    }

    return list;
  }, [onlyActiveModels, showInactive, activeModels, inactiveModels, models, searchQuery, allKonveyerKeys, matrixData]);

  // Unique dates for details tab
  const uniqueDates = useMemo(() => {
    const set = new Set<string>();
    for (const t of submittedTickets || []) {
      const dtStr = formatTicketDateTime(t);
      const datePart = dtStr.includes(' ') ? dtStr.split(' ')[0] : dtStr;
      if (datePart && datePart !== '—') set.add(datePart);
    }
    return Array.from(set).sort((a, b) => {
      const [d1, m1, y1] = a.split('.').map(Number);
      const [d2, m2, y2] = b.split('.').map(Number);
      const timeA = new Date(y1, (m1 || 1) - 1, d1 || 1).getTime();
      const timeB = new Date(y2, (m2 || 1) - 1, d2 || 1).getTime();
      return timeB - timeA;
    });
  }, [submittedTickets]);

  // Unique parties for details tab
  const uniqueParties = useMemo(() => {
    const set = new Set<string>();
    for (const t of submittedTickets || []) {
      if (t.partyNumber) set.add(t.partyNumber);
    }
    return Array.from(set).sort((a, b) => {
      const numA = parseInt(a, 10);
      const numB = parseInt(b, 10);
      if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
      return a.localeCompare(b);
    });
  }, [submittedTickets]);

  // Unique patta numbers for details tab
  const uniquePattas = useMemo(() => {
    const set = new Set<number>();
    for (const t of submittedTickets || []) {
      if (typeof t.pattaNumber === 'number' && t.pattaNumber > 0) {
        set.add(t.pattaNumber);
      }
    }
    return Array.from(set).sort((a, b) => a - b);
  }, [submittedTickets]);

  // Unique colors for details tab
  const uniqueColors = useMemo(() => {
    const set = new Set<string>();
    for (const t of submittedTickets || []) {
      const c = (t.color || '').trim();
      if (c) set.add(c);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [submittedTickets]);

  // Unique sizes for details tab
  const uniqueSizes = useMemo(() => {
    const set = new Set<string>();
    for (const t of submittedTickets || []) {
      const s = (t.size || '').trim();
      if (s) set.add(s);
    }
    return Array.from(set).sort((a, b) => {
      const numA = parseFloat(a);
      const numB = parseFloat(b);
      if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
      return a.localeCompare(b);
    });
  }, [submittedTickets]);

  // Filtered tickets for detailed table view
  const filteredTickets = useMemo(() => {
    const list = (submittedTickets || []).filter((t) => {
      const kVal = (t.konveyer || 'Noma\'lum').trim();
      if (selectedKonveyer !== 'all' && kVal !== selectedKonveyer) return false;
      if (selectedModel !== 'all' && t.modelId !== selectedModel) return false;
      if (selectedParty !== 'all' && t.partyNumber !== selectedParty) return false;

      // Vaqt filter (sana bo'yicha)
      if (selectedDate !== 'all') {
        const dtStr = formatTicketDateTime(t);
        const datePart = dtStr.includes(' ') ? dtStr.split(' ')[0] : dtStr;
        if (datePart !== selectedDate) return false;
      }

      // Patta raqami bo'yicha filter
      if (selectedPatta !== 'all') {
        if (String(t.pattaNumber) !== selectedPatta) return false;
      }

      // Rang bo'yicha filter
      if (selectedColor !== 'all') {
        if ((t.color || '').trim() !== selectedColor) return false;
      }

      // Razmer bo'yicha filter
      if (selectedSize !== 'all') {
        if ((t.size || '').trim() !== selectedSize) return false;
      }

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const model = modelMap.get(t.modelId);
        const modelName = (model?.name || t.modelId).toLowerCase();
        const party = String(t.partyNumber).toLowerCase();
        const patta = String(t.pattaNumber).toLowerCase();
        const konv = kVal.toLowerCase();
        const size = (t.size || '').toLowerCase();
        const color = (t.color || '').toLowerCase();
        const dtStr = formatTicketDateTime(t).toLowerCase();

        return (
          modelName.includes(q) ||
          party.includes(q) ||
          patta.includes(q) ||
          konv.includes(q) ||
          size.includes(q) ||
          color.includes(q) ||
          dtStr.includes(q)
        );
      }

      return true;
    });
    return sortTicketsNewestFirst(list).map((ticket, index) => ({ ...ticket, globalSeq: index + 1 }));
  }, [
    submittedTickets,
    selectedKonveyer,
    selectedModel,
    selectedParty,
    selectedDate,
    selectedPatta,
    selectedColor,
    selectedSize,
    searchQuery,
    modelMap
  ]);

  // Details view expanded tickets and display limit
  const [expandedTicketIds, setExpandedTicketIds] = useState<Set<string>>(() => new Set());
  const [detailsDisplayLimit, setDetailsDisplayLimit] = useState<number>(25);

  const toggleTicketExpand = (id: string) => {
    setExpandedTicketIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Reset pagination when filter criteria change
  useEffect(() => {
    setDetailsDisplayLimit(25);
  }, [
    selectedKonveyer,
    selectedModel,
    selectedParty,
    selectedDate,
    selectedPatta,
    selectedColor,
    selectedSize,
    searchQuery
  ]);

  const unpricedModel = useMemo(() => {
    const unpricedTicket = (filteredTickets || []).find((t) => {
      const m = modelMap.get(t.modelId);
      const amount = calculateTicketAmount(t);
      return (amount === 0 || amount === null) && m;
    });
    return unpricedTicket ? modelMap.get(unpricedTicket.modelId) : null;
  }, [filteredTickets, modelMap, calculateTicketAmount]);

  const visibleDetailsTickets = useMemo(() => {
    return filteredTickets.slice(0, detailsDisplayLimit);
  }, [filteredTickets, detailsDisplayLimit]);

  // Bottom Submitted Tickets Filtered & Paginated
  const bottomTicketsList = useMemo(() => {
    let list = submittedTickets || [];
    if (bottomConveyorPill !== 'all') {
      list = list.filter((t) => (t.konveyer || 'Noma\'lum').trim() === bottomConveyorPill);
    }
    if (bottomModelFilter !== 'all') {
      list = list.filter((t) => t.modelId === bottomModelFilter);
    }
    return sortTicketsNewestFirst(list);
  }, [submittedTickets, bottomConveyorPill, bottomModelFilter]);

  const totalBottomTickets = bottomTicketsList.length;
  const totalTicketsPages = Math.max(1, Math.ceil(totalBottomTickets / TICKETS_PER_PAGE));
  const currentTicketsPage = Math.min(ticketsPage, totalTicketsPages);
  const pagedBottomTickets = useMemo(() => {
    const start = (currentTicketsPage - 1) * TICKETS_PER_PAGE;
    return bottomTicketsList.slice(start, start + TICKETS_PER_PAGE);
  }, [bottomTicketsList, currentTicketsPage]);

  // Analytics: Konveyer Shares
  const conveyorShares = useMemo(() => {
    const total = grandTotals.totalQty;
    return allKonveyerKeys.map((k, idx) => {
      const qty = matrixData[k]?.totalQty || 0;
      const share = total > 0 ? (qty / total) * 100 : 0;
      return {
        key: k,
        label: k !== 'Noma\'lum' ? `${k}-konveyer` : 'Noma\'lum',
        qty,
        share,
        color: CONVEYOR_COLORS[idx % CONVEYOR_COLORS.length]
      };
    });
  }, [allKonveyerKeys, matrixData, grandTotals.totalQty]);

  // Analytics: Model Shares
  const modelShares = useMemo(() => {
    const total = grandTotals.totalQty;
    const items = activeModels.slice(0, 4).map((m, idx) => {
      const qty = modelTotals[m.id]?.totalQty || 0;
      const share = total > 0 ? (qty / total) * 100 : 0;
      const cleanName = (m?.name || m?.id || '').replace(/^(Модел-\s*|Модель-\s*|Model-\s*)+/i, '').trim();
      return {
        id: m.id,
        name: cleanName,
        qty,
        share,
        color: MODEL_COLORS[idx % MODEL_COLORS.length]
      };
    });

    const otherModels = activeModels.slice(4);
    if (otherModels.length > 0) {
      const otherQty = otherModels.reduce((sum, m) => sum + (modelTotals[m.id]?.totalQty || 0), 0);
      const otherShare = total > 0 ? (otherQty / total) * 100 : 0;
      const otherNames = otherModels.map((m) => (m?.name || m?.id || '').replace(/^(Модел-\s*|Модель-\s*|Model-\s*)+/i, '').trim()).join(' va ');
      items.push({
        id: 'others',
        name: otherNames.length > 25 ? `${otherNames.slice(0, 22)}...` : otherNames,
        qty: otherQty,
        share: otherShare,
        color: MODEL_COLORS[4]
      });
    }

    return items;
  }, [activeModels, modelTotals, grandTotals.totalQty]);

  // Helper for CSV cell escaping
  const toCsvCell = (value: unknown) => {
    const text = String(value ?? '');
    const safeText = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safeText.replace(/"/g, '""')}"`;
  };

  // Export Matrix to CSV
  const handleExportMatrixCSV = () => {
    const conveyorHeaders = allKonveyerKeys.map((k) =>
      toCsvCell(k !== 'Noma\'lum' ? `${k}-konveyer` : 'Noma\'lum')
    );
    const headers = ['№', 'Model', ...conveyorHeaders, 'Jami Ish (dona)', 'Jami Patta'];

    const rows = displayedModels.map((m, idx) => {
      const cleanName = (m?.name || m?.id || '').replace(/^(Модел-\s*|Модель-\s*|Model-\s*)+/i, '').trim();
      const conveyorCells = allKonveyerKeys.map((k) => matrixData[k]?.modelBreakdown[m.id]?.qty || 0);
      const totalQty = modelTotals[m.id]?.totalQty || 0;
      const totalPattas = modelTotals[m.id]?.totalPattas || 0;
      return [
        idx + 1,
        toCsvCell(cleanName),
        ...conveyorCells,
        totalQty,
        totalPattas
      ];
    });

    // Grand total row
    const conveyorTotalCells = allKonveyerKeys.map((k) => matrixData[k]?.totalQty || 0);
    const grandRow = [
      '',
      toCsvCell(`Jami · ${activeModels.length} model`),
      ...conveyorTotalCells,
      grandTotals.totalQty,
      grandTotals.totalPattas
    ];

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map((r) => r.join(',')), grandRow.join(',')].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Konveyerlar_va_modellar_${formatDateIso()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Export Details to CSV
  const handleExportDetailsCSV = () => {
    const headers = [
      '№',
      'Vaqt',
      'Konveyer',
      'Model',
      'Partiya',
      'Patta №',
      'Razmer',
      'Rang',
      'Ish Soni',
      'Bajarilgan Operatsiyalar',
      'Jami Summa (so\'m)'
    ];

    const rows = filteredTickets.map((t) => {
      const model = modelMap.get(t.modelId);
      const amount = calculateTicketAmount(t);
      const opDetails = (t.entries || [])
        .map((e) => `${e.opName} (#${e.workerId} ${workerMap.get(e.workerId) || ''})`)
        .join('; ');

      return [
        t.globalSeq,
        toCsvCell(formatTicketDateTime(t)),
        toCsvCell(t.konveyer || 'Noma\'lum'),
        toCsvCell(model?.name || t.modelId),
        toCsvCell(t.partyNumber || ''),
        toCsvCell(t.pattaNumber || ''),
        toCsvCell(t.size || ''),
        toCsvCell(t.color || ''),
        t.qty,
        toCsvCell(opDetails),
        amount !== null ? amount : 0
      ];
    });

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map((r) => r.join(',')), ''].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Pattalar_royxati_${formatDateIso()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="phase-b-konveyer">
      {/* 1. Page Header */}
      <div className="konveyer-header">
        <div>
          <h1 className="konveyer-title">Konveyerlar va modellar</h1>
          <p className="konveyer-subtitle">Har bir konveyer qaysi modeldan nechta ish bajargani</p>
        </div>

        <div className="konveyer-header-actions">
          {/* Pill segmented switch */}
          <div className="konveyer-view-switch">
            <button
              type="button"
              className={`konveyer-view-btn ${activeTab === 'matrix' ? 'active' : ''}`}
              onClick={() => setActiveTab('matrix')}
            >
              Modellar matritsasi
            </button>
            <button
              type="button"
              className={`konveyer-view-btn ${activeTab === 'details' ? 'active' : ''}`}
              onClick={() => setActiveTab('details')}
            >
              Pattalar ro'yxati
            </button>
          </div>

          {/* Export CSV button */}
          <button
            type="button"
            className="konveyer-export-btn"
            onClick={activeTab === 'matrix' ? handleExportMatrixCSV : handleExportDetailsCSV}
          >
            <ArrowDownToLine size={16} strokeWidth={2.2} />
            <span>Excel (CSV)</span>
          </button>
        </div>
      </div>

      {/* 2. Top KPI Cards */}
      <div className="konveyer-kpi-grid">
        {/* Card 1: Faol konveyerlar */}
        <div className="konveyer-kpi-card">
          <div className="konveyer-kpi-icon-box" style={{ background: '#ede9fe', color: '#7c3aed' }}>
            <Factory size={22} />
          </div>
          <div>
            <div className="konveyer-kpi-label">Faol konveyerlar</div>
            <div className="konveyer-kpi-val" style={{ color: '#0f172a' }}>
              {grandTotals.activeKonveyersCount}
              <span className="konveyer-kpi-unit">ta</span>
            </div>
          </div>
        </div>

        {/* Card 2: Jami tikilgan ish */}
        <div className="konveyer-kpi-card">
          <div className="konveyer-kpi-icon-box" style={{ background: '#dbeafe', color: '#2563eb' }}>
            <Shirt size={22} />
          </div>
          <div>
            <div className="konveyer-kpi-label">Jami tikilgan ish</div>
            <div className="konveyer-kpi-val" style={{ color: '#1d4ed8' }}>
              {formatMoney(grandTotals.totalQty)}
              <span className="konveyer-kpi-unit">dona</span>
            </div>
          </div>
        </div>

        {/* Card 3: Kiritilgan pattalar */}
        <div className="konveyer-kpi-card">
          <div className="konveyer-kpi-icon-box" style={{ background: '#fef3c7', color: '#d97706' }}>
            <Layers size={22} />
          </div>
          <div>
            <div className="konveyer-kpi-label">Kiritilgan pattalar</div>
            <div className="konveyer-kpi-val" style={{ color: '#b45309' }}>
              {grandTotals.totalPattas}
              <span className="konveyer-kpi-unit">ta</span>
            </div>
          </div>
        </div>

        {/* Card 4: Davr bo‘yicha jami ish haqi */}
        <div className="konveyer-kpi-card">
          <div className="konveyer-kpi-icon-box" style={{ background: '#d1fae5', color: '#059669' }}>
            <TrendingUp size={22} />
          </div>
          <div>
            <div className="konveyer-kpi-label">Jami ish haqi</div>
            <div className="konveyer-kpi-val" style={{ color: '#059669' }}>
              {periodGrossKnown 
                ? displayedMoney(display.masterReport.totalUmumiy, display.ready, display.incomplete) 
                : (grandTotals.totalAmount !== null ? formatMoney(grandTotals.totalAmount) : '0')}
              <span className="konveyer-kpi-unit">so'm</span>
            </div>
          </div>
        </div>
      </div>

      {/* 3. Toolbar */}
      <div className="konveyer-toolbar">
        <div className="konveyer-toolbar-left">
          {/* Search box */}
          <div className="konveyer-search-box">
            <Search size={15} color="#94a3b8" style={{ position: 'absolute', left: '12px', top: '11px' }} />
            <input
              type="text"
              className="konveyer-search-input"
              placeholder={activeTab === 'matrix' ? "Konveyer yoki model qidirish" : "Partiya, patta yoki model"}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          {activeTab === 'matrix' ? (
            /* Toggle switch: Faqat ishlangan modellar */
            <label className="konveyer-toggle-label" onClick={() => setOnlyActiveModels(!onlyActiveModels)}>
              <div className={`konveyer-toggle-switch ${onlyActiveModels ? 'checked' : ''}`}>
                <div className="konveyer-toggle-thumb" />
              </div>
              <span>Faqat ishlangan modellar</span>
              <span style={{ fontSize: '13.5px', color: '#64748b', fontWeight: 500, marginLeft: '6px' }}>
                {activeModels.length} / {models.length}
              </span>
            </label>
          ) : (
            /* Filters for details view */
            <>
              {/* 1. Vaqt filter (Sana bo'yicha) */}
              <CustomSelect
                value={selectedDate}
                onChange={setSelectedDate}
                minWidth="120px"
                buttonStyle={{ height: '38px', borderRadius: '12px', fontSize: '13.5px', fontWeight: 600, borderColor: '#d4dde8', padding: '0 8px 0 10px' }}
                options={[
                  { value: 'all', label: 'Barcha vaqtlar' },
                  ...uniqueDates.map((d) => ({ value: d, label: d }))
                ]}
              />
              {/* 2. Konveyer filter */}
              <CustomSelect
                value={selectedKonveyer}
                onChange={setSelectedKonveyer}
                minWidth="140px"
                buttonStyle={{ height: '38px', borderRadius: '12px', fontSize: '13.5px', fontWeight: 600, borderColor: '#d4dde8', padding: '0 8px 0 10px' }}
                options={[
                  { value: 'all', label: 'Barcha konveyerlar' },
                  ...allKonveyerKeys.map((k) => ({ value: k, label: k === 'Noma\'lum' ? k : `${k}-konveyer` }))
                ]}
              />
              {/* 3. Model filter */}
              <CustomSelect
                value={selectedModel}
                onChange={setSelectedModel}
                minWidth="130px"
                buttonStyle={{ height: '38px', borderRadius: '12px', fontSize: '13.5px', fontWeight: 600, borderColor: '#d4dde8', padding: '0 8px 0 10px' }}
                options={[
                  { value: 'all', label: 'Barcha modellar' },
                  ...models.map((m) => ({ value: m.id, label: m.name }))
                ]}
              />
              {/* 4. Partiya filter */}
              <CustomSelect
                value={selectedParty}
                onChange={setSelectedParty}
                minWidth="125px"
                buttonStyle={{ height: '38px', borderRadius: '12px', fontSize: '13.5px', fontWeight: 600, borderColor: '#d4dde8', padding: '0 8px 0 10px' }}
                options={[
                  { value: 'all', label: 'Barcha partiyalar' },
                  ...uniqueParties.map((p) => ({ value: p, label: `${p}-partiya` }))
                ]}
              />
              {/* 5. Patta filter */}
              <CustomSelect
                value={selectedPatta}
                onChange={setSelectedPatta}
                minWidth="115px"
                buttonStyle={{ height: '38px', borderRadius: '12px', fontSize: '13.5px', fontWeight: 600, borderColor: '#d4dde8', padding: '0 8px 0 10px' }}
                options={[
                  { value: 'all', label: 'Barcha pattalar' },
                  ...uniquePattas.map((p) => ({ value: String(p), label: `${p}-patta` }))
                ]}
              />
              {/* 6. Rang filter */}
              <CustomSelect
                value={selectedColor}
                onChange={setSelectedColor}
                minWidth="110px"
                buttonStyle={{ height: '38px', borderRadius: '12px', fontSize: '13.5px', fontWeight: 600, borderColor: '#d4dde8', padding: '0 8px 0 10px' }}
                options={[
                  { value: 'all', label: 'Barcha ranglar' },
                  ...uniqueColors.map((c) => ({ value: c, label: c }))
                ]}
              />
              {/* 7. Razmer filter */}
              <CustomSelect
                value={selectedSize}
                onChange={setSelectedSize}
                minWidth="120px"
                buttonStyle={{ height: '38px', borderRadius: '12px', fontSize: '13.5px', fontWeight: 600, borderColor: '#d4dde8', padding: '0 8px 0 10px' }}
                options={[
                  { value: 'all', label: 'Barcha razmerlar' },
                  ...uniqueSizes.map((s) => ({ value: s, label: s }))
                ]}
              />
            </>
          )}

          {(searchQuery || (activeTab === 'details' && (
            selectedKonveyer !== 'all' ||
            selectedModel !== 'all' ||
            selectedParty !== 'all' ||
            selectedDate !== 'all' ||
            selectedPatta !== 'all' ||
            selectedColor !== 'all' ||
            selectedSize !== 'all'
          ))) && (
            <button
              onClick={() => {
                setSearchQuery('');
                setSelectedKonveyer('all');
                setSelectedModel('all');
                setSelectedParty('all');
                setSelectedDate('all');
                setSelectedPatta('all');
                setSelectedColor('all');
                setSelectedSize('all');
              }}
              style={{
                border: 'none',
                background: 'transparent',
                color: '#ef4444',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '13.5px',
                fontWeight: 600
              }}
            >
              <RotateCcw size={14} />
              Tozalash
            </button>
          )}
        </div>

        <div className="konveyer-total-count">
          {activeTab === 'matrix' ? (
            <span>Jami konveyerlar: <strong>{allKonveyerKeys.length} ta</strong></span>
          ) : (
            <span>Topildi: <strong>{filteredTickets.length} ta patta</strong></span>
          )}
        </div>
      </div>

      {/* 4. Main Matrix View vs Details View */}
      {activeTab === 'matrix' ? (
        <>
          {/* Main Matrix Table Card (Transposed: Rows = Models, Columns = Conveyors) */}
          <div className="konveyer-matrix-card" style={{ flexShrink: 0, width: '100%', minHeight: '120px' }}>
            <div style={{ overflowX: 'auto', width: '100%' }}>
              <table className="konveyer-matrix-table" style={{ width: '100%', minWidth: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ width: '48px', textAlign: 'center' }}>№</th>
                    <th style={{ minWidth: '320px', textAlign: 'left', paddingLeft: '16px' }}>MODEL</th>
                    {allKonveyerKeys.map((k, kIdx) => {
                      const badge = CONVEYOR_BADGE_STYLES[kIdx % CONVEYOR_BADGE_STYLES.length];
                      return (
                        <th key={k} style={{ minWidth: '150px', textAlign: 'center' }}>
                          <span
                            className="konveyer-hdr-badge"
                            style={{ backgroundColor: badge.bg, color: badge.color }}
                          >
                            {k !== 'Noma\'lum' ? `${k}-konveyer` : 'Noma\'lum'}
                          </span>
                        </th>
                      );
                    })}
                    <th className="konveyer-hdr-total" style={{ minWidth: '140px', textAlign: 'right', paddingRight: '16px' }}>
                      JAMI ISH, DONA
                    </th>
                    <th className="konveyer-hdr-total" style={{ minWidth: '110px', textAlign: 'right', paddingRight: '20px' }}>
                      JAMI PATTA
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {displayedModels.length === 0 ? (
                    <tr>
                      <td colSpan={allKonveyerKeys.length + 4} style={{ textAlign: 'center', padding: '40px 20px', color: '#64748b' }}>
                        Hech qanday model topilmadi
                      </td>
                    </tr>
                  ) : (
                    displayedModels.map((m, idx) => {
                      const cleanName = (m?.name || m?.id || '').replace(/^(Модел-\s*|Модель-\s*|Model-\s*)+/i, '').trim();
                      const totalQty = modelTotals[m.id]?.totalQty || 0;
                      const totalPattas = modelTotals[m.id]?.totalPattas || 0;
                      const pct = grandTotals.totalQty > 0 ? ((totalQty / grandTotals.totalQty) * 100).toFixed(1) : '0.0';

                      return (
                        <tr key={m.id}>
                          {/* № */}
                          <td style={{ textAlign: 'center', color: '#64748b', fontSize: '15.5px', fontWeight: 600 }}>
                            {idx + 1}
                          </td>

                          {/* MODEL with title, percentage, and full-width progress bar */}
                          <td className="konveyer-model-cell">
                            <div className="konveyer-model-header-row">
                              <span className="konveyer-model-name">{cleanName}</span>
                              <span className="konveyer-model-pct">{pct}%</span>
                            </div>
                            <div className="konveyer-model-track">
                              <div className="konveyer-model-fill" style={{ width: `${Math.min(100, Number(pct))}%` }} />
                            </div>
                          </td>

                          {/* Dynamic Conveyor Columns */}
                          {allKonveyerKeys.map((k) => {
                            const breakdown = matrixData[k]?.modelBreakdown[m.id];
                            const cellQty = breakdown?.qty || 0;
                            const cellPattas = breakdown?.pattaCount || 0;

                            if (cellQty > 0) {
                              return (
                                <td key={k} className="konveyer-cell-active" style={{ textAlign: 'center' }}>
                                  <div className="konveyer-cell-qty">{formatMoney(cellQty)}</div>
                                  <div className="konveyer-cell-pattas">{cellPattas} ta patta</div>
                                </td>
                              );
                            }

                            return (
                              <td key={k} style={{ textAlign: 'center' }}>
                                <span className="konveyer-cell-dash">—</span>
                              </td>
                            );
                          })}

                          {/* JAMI ISH, DONA (Soft green background) */}
                          <td className="konveyer-col-total-bg">
                            <div className="konveyer-val-total-qty">
                              {totalQty > 0 ? formatMoney(totalQty) : '0'}
                            </div>
                          </td>

                          {/* JAMI PATTA (Soft green background + Bold orange text) */}
                          <td className="konveyer-col-total-bg">
                            <div className="konveyer-val-total-patta">
                              {totalPattas}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}

                  {/* Mint Footer Summary Row */}
                  <tr className="konveyer-matrix-footer">
                    <td colSpan={2} style={{ paddingLeft: '16px', fontSize: '16px', fontWeight: 800 }}>
                      Jami · {activeModels.length} model
                    </td>

                    {/* Column totals for each conveyor */}
                    {allKonveyerKeys.map((k) => {
                      const row = matrixData[k];
                      return (
                        <td key={k} style={{ textAlign: 'center', fontSize: '16px', fontWeight: 700 }}>
                          {formatMoney(row?.totalQty || 0)} · {row?.totalPattas || 0} patta
                        </td>
                      );
                    })}

                    {/* Grand Total Quantity */}
                    <td style={{ textAlign: 'right', paddingRight: '16px', fontSize: '17.5px', fontWeight: 800 }}>
                      {formatMoney(grandTotals.totalQty)}
                    </td>

                    {/* Grand Total Pattas */}
                    <td style={{ textAlign: 'right', paddingRight: '20px', fontSize: '17.5px', fontWeight: 800 }}>
                      {grandTotals.totalPattas}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Inactive models note with green link */}
          {onlyActiveModels && inactiveModels.length > 0 && (
            <div className="konveyer-inactive-note">
              <span>{inactiveModels.length} ta modelda ish yo'q.</span>
              <button className="konveyer-inactive-link" onClick={() => setShowInactive(!showInactive)}>
                {showInactive ? "Yashirish" : "Ko'rsatish"}
              </button>
            </div>
          )}

          {/* 5. Bottom 2-Column Grid Layout */}
          <div className="konveyer-bottom-grid">
            {/* Left Column: Topshirilgan pattalar */}
            <div className="konveyer-tickets-card">
              <div className="konveyer-tickets-header">
                <h3 className="konveyer-tickets-title">Topshirilgan pattalar</h3>

                {/* Filter Pills */}
                <div className="konveyer-pills-row">
                  <button
                    type="button"
                    className={`konveyer-pill-filter ${bottomConveyorPill === 'all' ? 'active' : ''}`}
                    onClick={() => setBottomConveyorPill('all')}
                  >
                    Hammasi - {grandTotals.totalPattas}
                  </button>

                  {allKonveyerKeys.map((k) => (
                    <button
                      key={k}
                      type="button"
                      className={`konveyer-pill-filter ${bottomConveyorPill === k ? 'active' : ''}`}
                      onClick={() => setBottomConveyorPill(k)}
                    >
                      {k !== 'Noma\'lum' ? `${k}-konveyer` : 'Noma\'lum'} - {matrixData[k]?.totalPattas || 0}
                    </button>
                  ))}

                  {/* Model filter dropdown */}
                  <CustomSelect
                    value={bottomModelFilter}
                    onChange={setBottomModelFilter}
                    size="sm"
                    variant="pill"
                    align="right"
                    minWidth="140px"
                    buttonStyle={{ fontSize: '14.5px' }}
                    options={[
                      { value: 'all', label: 'Model: Hammasi' },
                      ...models.map((m) => ({
                        value: m.id,
                        label: `Model: ${m.name.replace(/^(Модел-\s*|Модель-\s*|Model-\s*)+/i, '').trim()}`
                      }))
                    ]}
                  />
                </div>
              </div>

              {/* Table of tickets */}
              <div style={{ overflowX: 'auto', flex: 1 }}>
                <table className="konveyer-tickets-table">
                  <thead>
                    <tr>
                      <th style={{ width: '50px', textAlign: 'center' }}>№</th>
                      <th style={{ width: '180px', textAlign: 'left', paddingLeft: '14px' }}>VAQT</th>
                      <th style={{ textAlign: 'center' }}>MODEL</th>
                      <th style={{ width: '140px', textAlign: 'center' }}>KONVEYER</th>
                    </tr>
                  </thead>

                  <tbody>
                    {pagedBottomTickets.length === 0 ? (
                      <tr>
                        <td colSpan={4} style={{ textAlign: 'center', padding: '30px', color: '#64748b', fontSize: '15.5px' }}>
                          Hech qanday patta topilmadi
                        </td>
                      </tr>
                    ) : (
                      pagedBottomTickets.map((t, idx) => {
                        const m = modelMap.get(t.modelId);
                        const cleanName = (m?.name || t.modelId).replace(/^(Модел-\s*|Модель-\s*|Model-\s*)+/i, '').trim();
                        const rowNum = (currentTicketsPage - 1) * TICKETS_PER_PAGE + idx + 1;
                        const kVal = (t.konveyer || '').trim();
                        const kIdx = allKonveyerKeys.indexOf(kVal);
                        const badge = kIdx >= 0
                          ? CONVEYOR_BADGE_STYLES[kIdx % CONVEYOR_BADGE_STYLES.length]
                          : { bg: '#ede9fe', color: '#6b21a8' };
                        const dtStr = formatTicketDateTime(t);
                        const [datePart, timePart] = dtStr.includes(' ') ? dtStr.split(' ') : [dtStr, ''];

                        return (
                          <tr key={t.id || idx}>
                            <td style={{ textAlign: 'center', fontSize: '14px', color: '#64748b', fontWeight: 500 }}>
                              {rowNum}
                            </td>
                            <td style={{ paddingLeft: '14px', whiteSpace: 'nowrap', fontSize: '14.5px' }}>
                              <span style={{ fontWeight: 700, color: '#0f172a' }}>{datePart}</span>
                              {timePart && (
                                <span style={{ color: '#64748b', fontWeight: 500, marginLeft: '6px' }}>
                                  {timePart}
                                </span>
                              )}
                            </td>
                            <td style={{ textAlign: 'center' }}>
                              <span className="konveyer-ticket-badge-model">
                                {cleanName}
                              </span>
                            </td>
                            <td style={{ textAlign: 'center' }}>
                              <span
                                className="konveyer-ticket-badge-konveyer"
                                style={{ backgroundColor: badge.bg, color: badge.color }}
                              >
                                {kVal ? (kVal !== 'Noma\'lum' ? `${kVal}-konveyer` : 'Noma\'lum') : 'Noma\'lum'}
                              </span>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination controls */}
              <div className="konveyer-pagination-row">
                <span style={{ fontSize: '15px', color: '#64748b', fontWeight: 500 }}>
                  {totalBottomTickets > 0 ? (
                    `${(currentTicketsPage - 1) * TICKETS_PER_PAGE + 1}–${Math.min(currentTicketsPage * TICKETS_PER_PAGE, totalBottomTickets)} / ${totalBottomTickets} ta patta`
                  ) : (
                    '0 ta patta'
                  )}
                </span>

                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <button
                    type="button"
                    className="konveyer-page-btn"
                    disabled={currentTicketsPage <= 1}
                    onClick={() => setTicketsPage((p) => Math.max(1, p - 1))}
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <button
                    type="button"
                    className="konveyer-page-btn"
                    disabled={currentTicketsPage >= totalTicketsPages}
                    onClick={() => setTicketsPage((p) => Math.min(totalTicketsPages, p + 1))}
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              </div>
            </div>

            {/* Right Column: Single Unified Analytics Card */}
            <div className="konveyer-analytics-card">
              {/* Section 1: Konveyerlar ulushi */}
              <div className="konveyer-analytics-section">
                <h4 className="konveyer-analytics-title">Konveyerlar ulushi</h4>
                <p className="konveyer-analytics-subtitle">Jami ish sonidagi ulush</p>

                {/* Stacked multi-segment bar */}
                <div className="konveyer-stacked-bar">
                  {conveyorShares.map((cs) => (
                    <div
                      key={cs.key}
                      className="konveyer-stacked-segment"
                      style={{ width: `${cs.share}%`, backgroundColor: cs.color }}
                      title={`${cs.label}: ${cs.share.toFixed(1)}%`}
                    />
                  ))}
                </div>

                {/* Legend list */}
                <div className="konveyer-legend-list">
                  {conveyorShares.map((cs) => (
                    <div key={cs.key} className="konveyer-legend-item">
                      <div className="konveyer-legend-name">
                        <span className="konveyer-legend-dot" style={{ backgroundColor: cs.color }} />
                        <span>{cs.label} · {formatMoney(cs.qty)} dona</span>
                      </div>
                      <span className="konveyer-legend-badge">
                        {cs.share.toFixed(1)}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Section 2: Model ulushi */}
              <div className="konveyer-analytics-section" style={{ marginTop: '22px' }}>
                <h4 className="konveyer-analytics-title" style={{ marginBottom: '10px' }}>Model ulushi</h4>

                {/* Legend list */}
                <div className="konveyer-legend-list">
                  {modelShares.map((ms) => (
                    <div key={ms.id} className="konveyer-legend-item">
                      <div className="konveyer-legend-name">
                        <span className="konveyer-legend-dot" style={{ backgroundColor: ms.color }} />
                        <span style={{ maxWidth: '170px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={ms.name}>
                          {ms.name}
                        </span>
                      </div>
                      <span className="konveyer-legend-badge">
                        {ms.share.toFixed(1)}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </>
      ) : (
        /* Detailed tickets log view (when activeTab === 'details') */
        <div className="konveyer-details-wrapper" style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: '16px' }}>
          {/* Warning alert banner if unpriced model exists */}
          {unpricedModel && (
            <div className="konveyer-details-warning-banner">
              <div className="konveyer-warning-content">
                <AlertTriangle size={18} color="#d97706" style={{ flexShrink: 0 }} />
                <span>
                  Jami summa 0. <strong>{unpricedModel.name}</strong> modelining narxi kiritilmagan, shu sabab operatsiyalar summasi hisoblanmagan.
                </span>
              </div>
              <button
                type="button"
                className="konveyer-warning-action"
                onClick={() => setActiveSheet(unpricedModel.id)}
              >
                <span>Narxni kiritish</span>
                <span aria-hidden="true">→</span>
              </button>
            </div>
          )}

          {/* Table Card */}
          <div className="konveyer-details-card">
            {filteredTickets.length === 0 ? (
              <div style={{ padding: '60px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#64748b' }}>
                <Factory size={48} color="#cbd5e1" style={{ marginBottom: '12px' }} />
                <h3 style={{ margin: '0 0 6px 0', fontSize: '18px', fontWeight: 700, color: '#334155' }}>
                  Hech qanday patta topilmadi
                </h3>
                <p style={{ margin: 0, fontSize: '14px', color: '#64748b' }}>
                  Qidiruv yoki filtrlarni o'zgartirib ko'ring
                </p>
              </div>
            ) : (
              <>
                <div style={{ overflowX: 'auto', width: '100%' }}>
                  <table className="konveyer-details-table">
                    <thead>
                      <tr>
                        <th style={{ width: '48px', textAlign: 'center' }}>№</th>
                        <th style={{ width: '130px', textAlign: 'left' }}>VAQT</th>
                        <th style={{ width: '130px', textAlign: 'left' }}>KONVEYER</th>
                        <th style={{ minWidth: '170px', textAlign: 'left' }}>MODEL · PARTIYA</th>
                        <th style={{ width: '90px', textAlign: 'center' }}>PATTA №</th>
                        <th style={{ width: '140px', textAlign: 'left' }}>RAZMER · RANG</th>
                        <th style={{ width: '100px', textAlign: 'right' }}>ISH SONI</th>
                        <th style={{ width: '190px', textAlign: 'center' }}>OPERATSIYALAR</th>
                        <th style={{ width: '130px', textAlign: 'right' }}>JAMI SUMMA</th>
                        {!isArchiveMode && (
                          <th style={{ width: '100px', textAlign: 'center' }}>AMALLAR</th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {visibleDetailsTickets.map((t) => {
                        const model = modelMap.get(t.modelId);
                        const amount = calculateTicketAmount(t);
                        const isExpanded = expandedTicketIds.has(t.id);
                        const badge = getConveyorBadgeStyle(t.konveyer);
                        const dtStr = formatTicketDateTime(t);
                        const [datePart, timePart] = dtStr.includes(' ') ? dtStr.split(' ') : [dtStr, ''];

                        return (
                          <React.Fragment key={t.id}>
                            <tr className="konveyer-details-main-row">
                              <td style={{ textAlign: 'center', color: '#64748b', fontSize: '14.5px', fontWeight: 500 }}>
                                {t.globalSeq}
                              </td>
                              <td style={{ textAlign: 'left' }}>
                                <div style={{ display: 'flex', flexDirection: 'column' }}>
                                  <span style={{ fontSize: '14px', fontWeight: 700, color: '#0f172a', lineHeight: 1.25 }}>
                                    {datePart}
                                  </span>
                                  {timePart && (
                                    <span style={{ fontSize: '13px', fontWeight: 500, color: '#64748b', lineHeight: 1.25, marginTop: '2px' }}>
                                      {timePart}
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td style={{ textAlign: 'left' }}>
                                <span
                                  className="konveyer-details-conveyor-badge"
                                  style={{ backgroundColor: badge.bg, color: badge.color }}
                                >
                                  {badge.label}
                                </span>
                              </td>
                              <td style={{ textAlign: 'left' }}>
                                <div style={{ display: 'flex', flexDirection: 'column' }}>
                                  <span style={{ fontSize: '14.5px', fontWeight: 700, color: '#0f172a', lineHeight: 1.25 }}>
                                    {model?.name || t.modelId}
                                  </span>
                                  <span style={{ fontSize: '13px', fontWeight: 500, color: '#64748b', lineHeight: 1.25, marginTop: '2px' }}>
                                    Partiya {t.partyNumber || 1}
                                  </span>
                                </div>
                              </td>
                              <td style={{ textAlign: 'center', fontWeight: 700, color: '#0f172a', fontSize: '14.5px' }}>
                                {t.pattaNumber}
                              </td>
                              <td style={{ textAlign: 'left' }}>
                                {t.size ? <span className="konveyer-details-size-badge">{t.size}</span> : null}
                                <span style={{ fontSize: '14px', fontWeight: 500, color: '#0f172a' }}>
                                  {t.color || '—'}
                                </span>
                              </td>
                              <td style={{ textAlign: 'right', fontWeight: 700, color: '#0f172a', fontSize: '15px' }}>
                                {formatMoney(t.qty)}
                              </td>
                              <td style={{ textAlign: 'center' }}>
                                <button
                                  type="button"
                                  className={`konveyer-op-toggle-btn ${isExpanded ? 'expanded' : 'collapsed'}`}
                                  onClick={() => toggleTicketExpand(t.id)}
                                >
                                  {isExpanded ? (
                                    <ChevronDown size={14} strokeWidth={2.5} />
                                  ) : (
                                    <ChevronRight size={14} strokeWidth={2.5} />
                                  )}
                                  <span>{t.entries?.length || 0} ta operatsiya</span>
                                </button>
                              </td>
                              <td style={{ textAlign: 'right', fontWeight: 700, color: amount && amount > 0 ? '#0f172a' : '#94a3b8', fontSize: '14.5px' }}>
                                {amount && amount > 0 ? `${formatMoney(amount)} so'm` : '—'}
                              </td>
                              {!isArchiveMode && (
                                <td style={{ textAlign: 'center' }}>
                                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', justifyContent: 'center' }}>
                                    <button
                                      type="button"
                                      className="konveyer-details-action-btn edit"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        openModal({ type: 'edit_ticket', data: t });
                                      }}
                                      title="Pattani tahrirlash"
                                    >
                                      <Edit2 size={14} />
                                    </button>

                                    <button
                                      type="button"
                                      className="konveyer-details-action-btn delete"
                                      onClick={async (e) => {
                                        e.stopPropagation();
                                        const ok = await confirmAction({
                                          title: "Pattani o'chirish",
                                          message: `Haqiqatan ham ushbu pattani (#${t.pattaNumber}, Partiya ${t.partyNumber}) o'chirmoqchimisiz?\n\nModel va ishchilar hisobidan tozalansin hamda Patta-hisobda kiritilmagan holatga qaytarilsin.`,
                                          confirmText: "Ha, o'chirilsin",
                                          isDanger: true
                                        });
                                        if (ok) {
                                          await deleteSubmittedTicket(t.id);
                                        }
                                      }}
                                      title="Pattani o'chirish"
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  </div>
                                </td>
                              )}
                            </tr>

                            {/* Expanded Drawer */}
                            {isExpanded && (
                              <tr>
                                <td colSpan={isArchiveMode ? 9 : 10} style={{ padding: 0, borderBottom: '1px solid #f1f5f9' }}>
                                  <div className="konveyer-expanded-drawer">
                                    <div className="konveyer-expanded-header">
                                      BAJARILGAN OPERATSIYALAR · {t.entries?.length || 0} TA
                                    </div>
                                    <div className="konveyer-expanded-grid">
                                      {(t.entries || []).map((entry, eIdx) => {
                                        const wName = workerMap.get(entry.workerId) || `Ishchi #${entry.workerId}`;
                                        return (
                                          <div key={eIdx} className="konveyer-op-card">
                                            <div className="konveyer-op-info">
                                              <span className="konveyer-op-name" title={entry.opName}>
                                                {entry.opName}
                                              </span>
                                              <span className="konveyer-op-worker" title={wName}>
                                                {wName}
                                              </span>
                                            </div>
                                            <span className="konveyer-op-badge">
                                              #{entry.workerId}
                                            </span>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Footer */}
                <div className="konveyer-details-footer">
                  <div style={{ fontSize: '13.5px', color: '#64748b', fontWeight: 500 }}>
                    Ko'rsatilmoqda: <strong style={{ color: '#0f172a', fontWeight: 700 }}>{visibleDetailsTickets.length} / {filteredTickets.length}</strong> ta patta
                  </div>

                  {visibleDetailsTickets.length < filteredTickets.length && (
                    <button
                      type="button"
                      className="konveyer-load-more-btn"
                      onClick={() => setDetailsDisplayLimit((prev) => prev + 25)}
                    >
                      <span>Yana yuklash</span>
                      <span aria-hidden="true">↓</span>
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
