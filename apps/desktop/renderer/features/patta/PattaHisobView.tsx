import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Layers,
  Tag,
  FileText,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Trash2,
  Check,
  Search,
  Archive,
  Globe,
  Pencil
} from 'lucide-react';
import { useWorkbookStore, DEFAULT_BATCH_SIZES } from '../../store/workbookStore';
import { PrintedPartyRecord, SubmittedTicketRecord } from '../../types/workbook';
import { buildPartyTicketsList, getPartyHealth } from '../../domain/partyAnalytics';
import { selectPartyHistoryForView, selectPartySeriesTab } from '../../domain/partyHistoryVisibility';
import { confirmAndArchivePartyHistoryRecord } from './pattaHistoryActions';
import { formatTicketDateTime, formatUzbekDate } from '../../utils/formatters';
import { getElectronApi, resolveElectronRuntimeMode } from '../../store/runtimeMode';
import { useAuthStore } from '../../store/authStore';

export const PattaHisobView: React.FC = () => {
  const availableSizes = useWorkbookStore((s) => s.availableSizes);
  const livePrintedPartyHistory = useWorkbookStore((s) => s.printedPartyHistory);
  const liveSubmittedTickets = useWorkbookStore((s) => s.submittedTickets);
  const currentPeriod = useWorkbookStore((s) => s.currentPeriod);
  const periods = useWorkbookStore((s) => s.periods);
  const selectedArchiveFilename = useWorkbookStore((s) => s.selectedArchiveFilename);
  const selectedArchiveData = useWorkbookStore((s) => s.selectedArchiveData);
  const loadArchivedPeriod = useWorkbookStore((s) => s.loadArchivedPeriod);
  const licenseStatus = useWorkbookStore((s) => s.licenseStatus);
  const companyId = licenseStatus?.companyId || 'company_main';
  const authUserId = useAuthStore((s) => s.user?.uid || '');
  const authRole = useAuthStore((s) => s.role || '');

  const deletePrintedPartyRecord = useWorkbookStore((s) => s.deletePrintedPartyRecord);
  const deleteSubmittedTicket = useWorkbookStore((s) => s.deleteSubmittedTicket);
  const confirmPartyActualQuantities = useWorkbookStore((s) => s.confirmPartyActualQuantities);
  const confirmAction = useWorkbookStore((s) => s.confirmAction);
  const addNotification = useWorkbookStore((s) => s.addNotification);

  const actorScope = JSON.stringify([licenseStatus?.activationId || '', licenseStatus?.machineId || '', licenseStatus?.role || '', authUserId, authRole]);
  const filterScope = JSON.stringify([companyId, selectedArchiveFilename || currentPeriod?.id || '', actorScope]);
  const filterStorageKey = `patta-journal:filters:${filterScope}`;
  const readJournalFilters = (key: string) => {
    try {
      const raw = window.sessionStorage.getItem(key);
      if (!raw) return { search: '', status: 'all' as const, series: 'active' as const };
      const value = JSON.parse(raw);
      return {
        search: typeof value.search === 'string' ? value.search : '',
        status: ['all', 'mismatch', 'complete', 'in_progress'].includes(value.status) ? value.status : 'all',
        series: value.series === 'closed' ? 'closed' : 'active'
      } as { search: string; status: 'all' | 'mismatch' | 'complete' | 'in_progress'; series: 'active' | 'closed' };
    } catch { return { search: '', status: 'all' as const, series: 'active' as const }; }
  };
  const [savedJournalFilters, setSavedJournalFilters] = useState(() => ({ scope: filterScope, ...readJournalFilters(filterStorageKey) }));
  const journalFilters = savedJournalFilters.scope === filterScope ? savedJournalFilters : { scope: filterScope, ...readJournalFilters(filterStorageKey) };
  const searchQuery = journalFilters.search;
  const statusFilter = journalFilters.status;
  const seriesTab = journalFilters.series;
  const updateJournalFilters = (patch: Partial<typeof journalFilters>) => setSavedJournalFilters(() => ({
    ...journalFilters, ...patch, scope: filterScope
  }));
  useEffect(() => {
    if (savedJournalFilters.scope !== filterScope) setSavedJournalFilters({ scope: filterScope, ...readJournalFilters(filterStorageKey) });
  }, [filterScope, filterStorageKey, savedJournalFilters.scope]);
  useEffect(() => {
    if (savedJournalFilters.scope !== filterScope) return;
    try {
      const { search, status, series } = savedJournalFilters;
      const value = { search, status, series };
      if (search || status !== 'all' || series !== 'active') window.sessionStorage.setItem(filterStorageKey, JSON.stringify(value));
      else window.sessionStorage.removeItem(filterStorageKey);
    } catch { /* Session storage fallback */ }
  }, [filterScope, filterStorageKey, savedJournalFilters]);

  // Pagination for large party history
  const [currentPage, setCurrentPage] = useState(1);
  const ITEMS_PER_PAGE = 50;
  const [, setTotalItems] = useState(0);

  const [expandedPartyIds, setExpandedPartyIds] = useState<Set<string>>(() => new Set(['p-las-9']));
  const [expandedModelIds, setExpandedModelIds] = useState<Set<string>>(() => new Set(['m-lasina']));
  const [archiveFiles, setArchiveFiles] = useState<Array<{ filename: string; name: string; startDate: string; endDate?: string }>>([]);
  const [isPeriodDropdownOpen, setIsPeriodDropdownOpen] = useState(false);
  const periodDropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click or ESC
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (periodDropdownRef.current && !periodDropdownRef.current.contains(e.target as Node)) {
        setIsPeriodDropdownOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsPeriodDropdownOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  // Fetch file-based archives from Electron
  useEffect(() => {
    const fetchArchiveList = async () => {
      const eAPI = getElectronApi();
      const runtime = await resolveElectronRuntimeMode(eAPI);
      if (runtime.mode === 'sync') {
        setArchiveFiles(periods.filter((period) => period.isClosed).map((period) => ({
          filename: period.archiveFilename || period.id,
          name: period.name,
          startDate: period.startDate,
          endDate: period.endDate
        })));
        return;
      }
      if (eAPI && (eAPI.archivesListMeta || eAPI.archivesList)) {
        try {
          const res = eAPI.archivesListMeta ? await eAPI.archivesListMeta(companyId) : await eAPI.archivesList(companyId);
          if (res.success && res.archives) {
            const list = res.archives.map((a: any) => ({
              filename: a.filename,
              name: a.period?.name || a.filename,
              startDate: a.period?.startDate || '',
              endDate: a.period?.endDate || ''
            }));
            setArchiveFiles(list);
          } else {
            setArchiveFiles([]);
          }
        } catch (e) {
          console.warn('Failed to fetch archives in PattaHisobView', e);
          setArchiveFiles([]);
        }
      }
    };
    fetchArchiveList();
  }, [selectedArchiveFilename, companyId, periods]);

  // All-time mode state & handler
  const [isAllTimeMode, setIsAllTimeMode] = useState(false);
  const [allTimeData, setAllTimeData] = useState<{
    printedPartyHistory: PrintedPartyRecord[];
    submittedTickets: SubmittedTicketRecord[];
  } | null>(null);
  const [isLoadingAllTime, setIsLoadingAllTime] = useState(false);

  const handleSelectAllTime = async () => {
    const runtime = await resolveElectronRuntimeMode(getElectronApi());
    if (runtime.mode === 'sync' && !runtime.success) {
      addNotification('error', runtime.code || '_RUNTIME_NOT_READY', runtime.error || 'Runtime readiness failed.');
      return;
    }
    setIsAllTimeMode(true);
    loadArchivedPeriod(null);
    setIsLoadingAllTime(true);

    try {
      const partyMap = new Map<string, PrintedPartyRecord>();
      const ticketMap = new Map<string, SubmittedTicketRecord>();
      const eAPI = getElectronApi();
      let filesToRead = runtime.mode === 'sync'
        ? periods.filter((period) => period.isClosed).map((period) => ({
          filename: period.archiveFilename || period.id,
          name: period.name,
          startDate: period.startDate,
          endDate: period.endDate
        }))
        : archiveFiles;

      if (runtime.mode !== 'sync' && eAPI && eAPI.archivesList && filesToRead.length === 0) {
        try {
          const aRes = await eAPI.archivesList(companyId);
          if (aRes.success && aRes.archives) {
            filesToRead = aRes.archives.map((a: any) => ({
              filename: a.filename,
              name: a.period?.name || a.filename,
              startDate: a.period?.startDate || '',
              endDate: a.period?.endDate || ''
            }));
            setArchiveFiles(filesToRead);
          }
        } catch (err) {
          console.warn('Failed to fetch archives list in handleSelectAllTime', err);
        }
      }

      // Read all archive files
      if (runtime.mode === 'sync' && eAPI?.PeriodArchiveRead && filesToRead.length > 0) {
        for (const file of filesToRead) {
          try {
            const result = await eAPI.PeriodArchiveRead({ companyId, filename: file.filename });
            if (result?.success && result.data) {
              for (const party of (result.data.printedPartyHistory || [])) {
                if (!partyMap.has(party.id)) partyMap.set(party.id, { ...party, archivedPattaNumbers: [] });
              }
              for (const ticket of (result.data.submittedTickets || [])) {
                if (ticket.id) ticketMap.set(ticket.id, ticket);
              }
            } else if (result?.code !== 'PERIOD_ARCHIVE_NOT_FOUND') {
              addNotification('warning', 'Arxiv o‘qilmadi', result?.error || `${file.name} arxivi yuklanmadi.`);
            }
          } catch (error) {
            addNotification('warning', 'Arxiv o‘qilmadi', error instanceof Error ? error.message : `${file.name} arxivi yuklanmadi.`);
          }
        }
      } else if (runtime.mode !== 'sync' && eAPI && eAPI.archiveRead && filesToRead.length > 0) {
        for (const file of filesToRead) {
          try {
            const res = await eAPI.archiveRead(file.filename, companyId);
            if (res.success && res.data) {
              for (const p of (res.data.printedPartyHistory || [])) {
                if (!partyMap.has(p.id)) {
                  partyMap.set(p.id, { ...p, archivedPattaNumbers: [] });
                }
              }
              for (const t of (res.data.submittedTickets || [])) {
                if (t.id) ticketMap.set(t.id, t);
              }
            }
          } catch (e) {
            console.warn('Error reading archive in handleSelectAllTime', file.filename, e);
          }
        }
      }

      // Merge live data
      for (const p of (livePrintedPartyHistory || [])) {
        if (!partyMap.has(p.id)) partyMap.set(p.id, { ...p, archivedPattaNumbers: [] });
      }
      for (const t of (liveSubmittedTickets || [])) {
        if (t.id) ticketMap.set(t.id, t);
      }

      setAllTimeData({
        printedPartyHistory: Array.from(partyMap.values()),
        submittedTickets: Array.from(ticketMap.values())
      });
      addNotification('info', 'Butun davr yuklandi', 'Barcha oylar va joriy oy ma\'lumotlari jamlandi.');
    } catch (err) {
      console.error('Failed to load all time data', err);
      addNotification('error', 'Xatolik', 'Butun davr ma\'lumotlarini yuklashda xatolik yuz berdi.');
    } finally {
      setIsLoadingAllTime(false);
    }
  };

  // Determine active data source (live vs archived vs all-time)
  const isArchiveMode = !!selectedArchiveData && !isAllTimeMode;
  const sourcePrintedPartyHistory: PrintedPartyRecord[] = isAllTimeMode
    ? (allTimeData?.printedPartyHistory || livePrintedPartyHistory || [])
    : isArchiveMode
    ? (selectedArchiveData?.printedPartyHistory || [])
    : (livePrintedPartyHistory || []);
  const partyHistoryViewMode = isAllTimeMode ? 'all-time' : isArchiveMode ? 'archive' : 'live';
  const printedPartyHistory = selectPartyHistoryForView(sourcePrintedPartyHistory, partyHistoryViewMode);
  const visiblePartyHistory = selectPartySeriesTab(printedPartyHistory, seriesTab, partyHistoryViewMode);

  const submittedTickets: SubmittedTicketRecord[] = isAllTimeMode
    ? (allTimeData?.submittedTickets || liveSubmittedTickets || [])
    : isArchiveMode
    ? (selectedArchiveData?.submittedTickets || [])
    : (liveSubmittedTickets || []);

  const activePeriodName = isAllTimeMode
    ? "Butun davr bo'yicha (Barcha oylar)"
    : isArchiveMode
    ? selectedArchiveData?.period?.name
    : currentPeriod?.name;

  const activeSizes = availableSizes && availableSizes.length > 0 ? availableSizes : DEFAULT_BATCH_SIZES;

  const toggleAccordion = (partyId: string) => {
    setExpandedPartyIds((prev) => {
      const next = new Set(prev);
      if (next.has(partyId)) next.delete(partyId);
      else next.add(partyId);
      return next;
    });
  };

  const toggleModelAccordion = (modelId: string) => {
    setExpandedModelIds((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  };

  // Detect any duplicate party numbers among active parties
  const duplicatePartyNumbers = useMemo(() => {
    const activeParties = (visiblePartyHistory || []).filter((h) => !h.isClosed);
    const counts = new Map<string, number>();
    for (const p of activeParties) {
      const num = String(p.partyNumber || '').trim();
      if (num) {
        counts.set(num, (counts.get(num) || 0) + 1);
      }
    }
    const dupes = new Set<string>();
    for (const [num, count] of counts.entries()) {
      if (count > 1) {
        dupes.add(num);
      }
    }
    return dupes;
  }, [visiblePartyHistory]);

  // Group party history by Model
  const modelHistoryGroups = useMemo(() => {
    if (!visiblePartyHistory || visiblePartyHistory.length === 0) return [];

    const grouped: Record<string, {
      modelId: string;
      modelName: string;
      parties: PrintedPartyRecord[];
      totalParties: number;
      totalPattas: number;
      submittedPattas: number;
      unsubmittedPattas: number;
      totalIshSoni: number;
      submittedIshSoni: number;
      unsubmittedIshSoni: number;
      hasMismatch: boolean;
      isComplete: boolean;
      statusLabel: string;
    }> = {};

    for (const record of visiblePartyHistory) {
      const mId = record.modelId;
      if (!grouped[mId]) {
        grouped[mId] = {
          modelId: mId,
          modelName: record.modelName,
          parties: [],
          totalParties: 0,
          totalPattas: 0,
          submittedPattas: 0,
          unsubmittedPattas: 0,
          totalIshSoni: 0,
          submittedIshSoni: 0,
          unsubmittedIshSoni: 0,
          hasMismatch: false,
          isComplete: true,
          statusLabel: 'Jarayonda'
        };
      }

      const tickets = buildPartyTicketsList(record, submittedTickets, activeSizes, true, isArchiveMode);
      if (isArchiveMode && tickets.length === 0) {
        continue;
      }

      grouped[mId].parties.push(record);
      grouped[mId].totalParties += 1;

      const pCount = tickets.length;
      grouped[mId].totalPattas += pCount;

      const ishCount = tickets.reduce((sum, t) => sum + t.expectedQty, 0);
      grouped[mId].totalIshSoni += ishCount;

      const partySubmittedCount = tickets.filter((t) => t.isSubmitted).length;
      const partyUnsubmittedCount = Math.max(0, pCount - partySubmittedCount);

      grouped[mId].submittedPattas += partySubmittedCount;
      grouped[mId].unsubmittedPattas += partyUnsubmittedCount;

      const partySubmittedIsh = tickets.filter((t) => t.isSubmitted).reduce((sum, t) => sum + t.enteredQty, 0);
      grouped[mId].submittedIshSoni += partySubmittedIsh;

      const partyUnsubmittedIsh = tickets.filter((t) => !t.isSubmitted).reduce((sum, t) => sum + t.expectedQty, 0);
      grouped[mId].unsubmittedIshSoni += partyUnsubmittedIsh;

      const health = getPartyHealth(tickets);
      if (health.hasMismatch || health.isError) {
        grouped[mId].hasMismatch = true;
      }
      if (health.status !== 'complete') {
        grouped[mId].isComplete = false;
      }
    }

    // Determine status labels
    Object.values(grouped).forEach((group) => {
      if (group.hasMismatch) {
        group.statusLabel = 'Tafovut / Kamomat';
      } else if (group.isComplete && group.totalPattas > 0) {
        group.statusLabel = 'To\'liq topshirilgan';
      } else {
        group.statusLabel = 'Jarayonda';
      }
    });

    let groups = Object.values(grouped).filter((g) => g.parties.length > 0);

    // Apply Search Filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      groups = groups.filter((g) =>
        g.modelName.toLowerCase().includes(q) ||
        g.parties.some((p) => String(p.partyNumber).toLowerCase().includes(q) || (p.color && p.color.toLowerCase().includes(q)) ||
          submittedTickets.some((ticket) => ticket.modelId === p.modelId && ticket.partyNumber === p.partyNumber &&
            (String(ticket.pattaNumber).includes(q) || ticket.konveyer?.toLowerCase().includes(q) || ticket.id.toLowerCase().includes(q))))
      );
    }

    // Apply Status Filter
    if (statusFilter === 'mismatch') {
      groups = groups.filter((g) => g.hasMismatch);
    } else if (statusFilter === 'complete') {
      groups = groups.filter((g) => g.isComplete && !g.hasMismatch);
    } else if (statusFilter === 'in_progress') {
      groups = groups.filter((g) => !g.isComplete && !g.hasMismatch);
    }

    return groups;
  }, [visiblePartyHistory, submittedTickets, activeSizes, searchQuery, statusFilter, isArchiveMode]);

  // Flatten all parties for pagination
  const allPartiesFlat = useMemo(() => {
    const flat: Array<{ party: PrintedPartyRecord; group: typeof modelHistoryGroups[0] }> = [];
    for (const group of modelHistoryGroups) {
      for (const party of group.parties) {
        flat.push({ party, group });
      }
    }
    return flat;
  }, [modelHistoryGroups]);

  const totalPages = Math.ceil(allPartiesFlat.length / ITEMS_PER_PAGE) || 1;
  const paginatedParties = useMemo(() => {
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    return allPartiesFlat.slice(start, start + ITEMS_PER_PAGE);
  }, [allPartiesFlat, currentPage]);

  const paginatedGroups = useMemo(() => {
    const groupsMap = new Map<string, { group: typeof modelHistoryGroups[0]; parties: Array<{ party: PrintedPartyRecord; group: typeof modelHistoryGroups[0] }> }>();
    for (const item of paginatedParties) {
      const key = item.group.modelId;
      if (!groupsMap.has(key)) {
        groupsMap.set(key, { group: item.group, parties: [] });
      }
      groupsMap.get(key)!.parties.push(item);
    }
    return Array.from(groupsMap.values());
  }, [paginatedParties]);

  useEffect(() => {
    setTotalItems(allPartiesFlat.length);
  }, [allPartiesFlat.length]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, statusFilter, isArchiveMode]);

  // Overall KPIs
  const visiblePartyIds = useMemo(() => new Set(visiblePartyHistory.map((party) => party.id)), [visiblePartyHistory]);
  const totalActualSubmittedIshCount = submittedTickets
    ?.filter((ticket) => ticket.partyRecordId && visiblePartyIds.has(ticket.partyRecordId))
    .reduce((acc, ticket) => acc + (ticket.qty || 0), 0) || 0;

  const { totalPartiesCount, totalPattasCount, totalExpectedIshCount, totalSubmittedPattasCount, totalUnsubmittedPattasCount, totalUnsubmittedIshCount } = useMemo(() => {
    let totalP = 0;
    let expectedIsh = 0;
    let sub = 0;
    let unsub = 0;
    let partyCount = 0;
    let unsubIsh = 0;

    for (const p of visiblePartyHistory || []) {
      const tickets = buildPartyTicketsList(p, submittedTickets, activeSizes, true, isArchiveMode);
      if (isArchiveMode && tickets.length === 0) continue;

      partyCount += 1;
      const count = tickets.length;
      totalP += count;
      expectedIsh += tickets.reduce((s, t) => s + t.expectedQty, 0);

      const s = tickets.filter((t) => t.isSubmitted).length;
      sub += s;
      unsub += Math.max(0, count - s);

      const partyUnsubIsh = tickets.filter((t) => !t.isSubmitted).reduce((s, t) => s + t.expectedQty, 0);
      unsubIsh += partyUnsubIsh;
    }
    return {
      totalPartiesCount: partyCount,
      totalPattasCount: totalP,
      totalExpectedIshCount: expectedIsh,
      totalSubmittedPattasCount: sub,
      totalUnsubmittedPattasCount: unsub,
      totalUnsubmittedIshCount: unsubIsh
    };
  }, [visiblePartyHistory, submittedTickets, activeSizes, isArchiveMode]);

  const ticketProgress = totalPattasCount > 0 ? Math.min(100, (totalSubmittedPattasCount / totalPattasCount) * 100) : 0;
  const workProgress = totalExpectedIshCount > 0 ? Math.min(100, (totalActualSubmittedIshCount / totalExpectedIshCount) * 100) : 0;

  // Closed periods list for selection
  const closedPeriodsList = useMemo(() => {
    const map = new Map<string, { filename: string; name: string; startDate: string; endDate?: string }>();
    for (const p of periods || []) {
      if (p.isClosed) {
        const fn = p.archiveFilename || `archive_${p.id}.json`;
        map.set(fn, { filename: fn, name: p.name, startDate: p.startDate, endDate: p.endDate });
      }
    }
    for (const a of archiveFiles) {
      if (!map.has(a.filename)) {
        map.set(a.filename, a);
      }
    }
    return Array.from(map.values());
  }, [periods, archiveFiles]);

  return (
    <div className="phase-b-view phase-b-patta-journal" style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div className="patta-hisob-scroll">
        {/* Top Header */}
        <div className="patta-hisob-header">
          <div className="patta-hisob-header-left">
            <div className="patta-hisob-title-row">
              <h1 className="patta-hisob-title">Patta-hisob</h1>
              {isAllTimeMode ? (
                <span className="patta-hisob-badge" style={{ background: '#ede9fe', color: '#7c3aed', border: '1px solid #ddd6fe' }}>
                  <Globe size={11} /> Butun davr
                </span>
              ) : isArchiveMode ? (
                <span className="patta-hisob-badge" style={{ background: '#ede9fe', color: '#7c3aed', border: '1px solid #ddd6fe' }}>
                  📁 Arxiv
                </span>
              ) : (
                <span className="patta-hisob-badge active">
                  <span className="patta-hisob-badge-dot" />
                  Faol oy
                </span>
              )}
            </div>
            <p className="patta-hisob-subtitle">
              {isAllTimeMode
                ? 'Barcha yopilgan oylar va joriy oydagi partiyalar va kiritilgan pattalarning to\'liq monitoringi'
                : isArchiveMode
                ? `Yopilgan oy arxivi: ${activePeriodName} (${formatUzbekDate(selectedArchiveData?.period?.startDate) || '—'} — ${formatUzbekDate(selectedArchiveData?.period?.endDate) || '—'})`
                : 'Chop etilgan partiyalar va kiritilmagan pattalar monitoringi'}
            </p>
          </div>

          {/* Right: Period Dropdown */}
          <div className="patta-hisob-header-right" ref={periodDropdownRef} style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => setIsPeriodDropdownOpen((prev) => !prev)}
              className="patta-hisob-period-btn"
            >
              <span className="patta-hisob-period-label">Davr:</span>
              <span className="patta-hisob-period-val">
                {isLoadingAllTime ? 'Yuklanmoqda...' : isAllTimeMode ? 'Butun davr' : isArchiveMode ? activePeriodName : `Joriy oy (${currentPeriod?.name || '2026-Oktabr'})`}
              </span>
              <ChevronDown
                size={14}
                color="#64748b"
                style={{
                  transform: isPeriodDropdownOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                  transition: 'transform 0.2s ease',
                  marginLeft: '4px'
                }}
              />
            </button>

            {/* Dropdown Menu */}
            {isPeriodDropdownOpen && (
              <div
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 6px)',
                  right: 0,
                  width: '300px',
                  maxHeight: '360px',
                  overflowY: 'auto',
                  backgroundColor: '#ffffff',
                  border: '1px solid #e2e8f0',
                  borderRadius: '12px',
                  boxShadow: '0 12px 28px -6px rgba(0, 0, 0, 0.15)',
                  zIndex: 100,
                  padding: '6px'
                }}
              >
                {/* All time option */}
                <div
                  onClick={() => {
                    handleSelectAllTime();
                    setIsPeriodDropdownOpen(false);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    backgroundColor: isAllTimeMode ? '#f5f3ff' : 'transparent',
                    marginBottom: '3px'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Globe size={14} color="#7c3aed" />
                    <div>
                      <div style={{ fontSize: '12.5px', fontWeight: 700, color: isAllTimeMode ? '#7c3aed' : '#0f172a' }}>
                        Butun davr bo'yicha
                      </div>
                      <div style={{ fontSize: '10.5px', color: '#64748b' }}>Barcha oylar jamlanmasi</div>
                    </div>
                  </div>
                  {isAllTimeMode && <Check size={13} color="#7c3aed" />}
                </div>

                {/* Current Active Period */}
                <div
                  onClick={() => {
                    setIsAllTimeMode(false);
                    loadArchivedPeriod(null);
                    setIsPeriodDropdownOpen(false);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    backgroundColor: (!isArchiveMode && !isAllTimeMode) ? '#ecfdf5' : 'transparent',
                    marginBottom: '3px'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#10b981' }} />
                    <div>
                      <div style={{ fontSize: '12.5px', fontWeight: 700, color: (!isArchiveMode && !isAllTimeMode) ? '#059669' : '#0f172a' }}>
                        Joriy oy (Faol)
                      </div>
                      <div style={{ fontSize: '10.5px', color: '#64748b' }}>{currentPeriod?.name || 'Joriy davr'}</div>
                    </div>
                  </div>
                  {(!isArchiveMode && !isAllTimeMode) && <Check size={13} color="#059669" />}
                </div>

                {/* Archives List */}
                {closedPeriodsList.length > 0 && (
                  <div style={{ borderTop: '1px solid #f1f5f9', margin: '4px 0', padding: '4px 10px 2px', fontSize: '10px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase' }}>
                    Yopilgan oylar arxivi ({closedPeriodsList.length})
                  </div>
                )}
                {closedPeriodsList.map((cp) => {
                  const isSelected = selectedArchiveFilename === cp.filename;
                  return (
                    <div
                      key={cp.filename}
                      onClick={() => {
                        setIsAllTimeMode(false);
                        loadArchivedPeriod(cp.filename);
                        setIsPeriodDropdownOpen(false);
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '8px 12px',
                        borderRadius: '8px',
                        cursor: 'pointer',
                        backgroundColor: isSelected ? '#f5f3ff' : 'transparent',
                        marginBottom: '2px'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <Archive size={13} color={isSelected ? '#7c3aed' : '#94a3b8'} />
                        <div>
                          <div style={{ fontSize: '12px', fontWeight: 600, color: isSelected ? '#7c3aed' : '#334155' }}>
                            {cp.name}
                          </div>
                          <div style={{ fontSize: '10px', color: '#94a3b8' }}>
                            {formatUzbekDate(cp.startDate)} — {formatUzbekDate(cp.endDate) || '—'}
                          </div>
                        </div>
                      </div>
                      {isSelected && <Check size={13} color="#7c3aed" />}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Informative Banners for Special Modes */}
        {isAllTimeMode && (
          <div style={{ padding: '8px 14px', background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', fontSize: '12px' }}>
            <span>🌐 Siz <strong>Butun davr bo'yicha</strong> barcha oylar monitoringini ko'rmoqdasiz.</span>
            <button onClick={() => setIsAllTimeMode(false)} style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '6px', padding: '3px 10px', fontSize: '11px', cursor: 'pointer' }}>
              Joriy oyga qaytish
            </button>
          </div>
        )}
        {isArchiveMode && (
          <div style={{ padding: '8px 14px', background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', fontSize: '12px' }}>
            <span>📁 Siz <strong>{activePeriodName}</strong> yopilgan oyining arxivlangan partiyalar hisobotini ko'rmoqdasiz.</span>
            <button onClick={() => loadArchivedPeriod(null)} style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '6px', padding: '3px 10px', fontSize: '11px', cursor: 'pointer' }}>
              Chiqish
            </button>
          </div>
        )}
        {duplicatePartyNumbers.size > 0 && !isArchiveMode && (
          <div style={{ padding: '8px 14px', background: '#fef2f2', border: '1px solid #fee2e2', borderRadius: '10px', display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px', fontSize: '12px', color: '#b91c1c' }}>
            <span>⚠️ Diqqat: Partiya {Array.from(duplicatePartyNumbers).map(n => `«${n}»`).join(', ')} raqami takrorlangan (dublikat)!</span>
          </div>
        )}

        {/* Top 3 KPI Cards */}
        <div className="patta-hisob-kpis journal-kpis">
          {/* Card 1: Partiyalar */}
          <div className="patta-hisob-kpi-card journal-kpi">
            <div className="patta-hisob-kpi-icon emerald">
              <Layers size={22} strokeWidth={2.2} />
            </div>
            <div className="patta-hisob-kpi-content">
              <div className="patta-hisob-kpi-label journal-kpi-label">Partiyalar</div>
              <div className="patta-hisob-kpi-val emerald journal-kpi-value">
                {totalPartiesCount} <span className="patta-hisob-kpi-unit">ta</span>
              </div>
              <div className="patta-hisob-kpi-sub journal-kpi-sub">
                {modelHistoryGroups.length} ta modelda
              </div>
            </div>
          </div>

          {/* Card 2: Kiritilgan pattalar */}
          <div className="patta-hisob-kpi-card journal-kpi">
            <div className="patta-hisob-kpi-icon purple">
              <Tag size={22} strokeWidth={2.2} />
            </div>
            <div className="patta-hisob-kpi-content">
              <div className="patta-hisob-kpi-label journal-kpi-label">Kiritilgan pattalar</div>
              <div className="patta-hisob-kpi-val purple journal-kpi-value">
                {totalSubmittedPattasCount} <span className="patta-hisob-kpi-unit">/ {totalPattasCount} ta</span>
              </div>
              <div className="patta-hisob-kpi-progress journal-progress">
                <div className="patta-hisob-kpi-progress-bar purple" style={{ width: `${ticketProgress}%` }} />
              </div>
              <div className="patta-hisob-kpi-sub journal-kpi-sub">
                {Math.round(ticketProgress)}% kiritilgan · {totalUnsubmittedPattasCount} ta qoldi
              </div>
            </div>
          </div>

          {/* Card 3: Kiritilgan ish */}
          <div className="patta-hisob-kpi-card journal-kpi">
            <div className="patta-hisob-kpi-icon amber">
              <FileText size={22} strokeWidth={2.2} />
            </div>
            <div className="patta-hisob-kpi-content">
              <div className="patta-hisob-kpi-label journal-kpi-label">Kiritilgan ish</div>
              <div className="patta-hisob-kpi-val amber journal-kpi-value">
                {totalActualSubmittedIshCount.toLocaleString('ru-RU')} <span className="patta-hisob-kpi-unit">/ {totalExpectedIshCount.toLocaleString('ru-RU')} dona</span>
              </div>
              <div className="patta-hisob-kpi-progress journal-progress">
                <div className="patta-hisob-kpi-progress-bar amber" style={{ width: `${workProgress}%` }} />
              </div>
              <div className="patta-hisob-kpi-sub journal-kpi-sub">
                {Math.round(workProgress)}% kiritilgan · {totalUnsubmittedIshCount.toLocaleString('ru-RU')} dona qoldi
              </div>
            </div>
          </div>
        </div>

        {/* Tabs Row */}
        <div className="patta-hisob-tabs-row journal-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={seriesTab === 'active'}
            onClick={() => updateJournalFilters({ series: 'active' })}
            className={`patta-hisob-tab journal-tab ${seriesTab === 'active' ? 'active selected' : ''}`}
          >
            Patta hisob · {(printedPartyHistory || []).filter((p) => !p.isClosed).length}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={seriesTab === 'closed'}
            onClick={() => updateJournalFilters({ series: 'closed' })}
            className={`patta-hisob-tab journal-tab ${seriesTab === 'closed' ? 'active selected' : ''}`}
          >
            Yopilgan · Yakunlangan · {(printedPartyHistory || []).filter((p) => p.isClosed).length}
          </button>
        </div>

        {/* Filters & Search Row */}
        <div className="patta-hisob-filter-bar journal-filters">
          <div className="patta-hisob-search-box">
            <Search size={16} className="patta-hisob-search-icon" />
            <input
              type="text"
              placeholder="Model yoki partiya raqami bo'yicha..."
              value={searchQuery}
              onChange={(e) => updateJournalFilters({ search: e.target.value })}
              className="patta-hisob-search-input soft-input"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => updateJournalFilters({ search: '' })}
                className="patta-hisob-search-clear"
                title="Tozalash"
              >
                ×
              </button>
            )}
          </div>

          <div className="patta-hisob-filter-pills journal-filter-pills">
            <button
              type="button"
              onClick={() => updateJournalFilters({ status: 'all' })}
              className={`patta-hisob-filter-pill soft-btn ${statusFilter === 'all' ? 'active soft-btn-primary' : 'soft-btn-secondary'}`}
            >
              Barchasi · {visiblePartyHistory?.length || 0}
            </button>
            <button
              type="button"
              onClick={() => updateJournalFilters({ status: 'mismatch' })}
              className={`patta-hisob-filter-pill soft-btn ${statusFilter === 'mismatch' ? 'active soft-btn-primary' : 'soft-btn-secondary'}`}
            >
              Tafovut / Kamomat
            </button>
            <button
              type="button"
              onClick={() => updateJournalFilters({ status: 'in_progress' })}
              className={`patta-hisob-filter-pill soft-btn ${statusFilter === 'in_progress' ? 'active soft-btn-primary' : 'soft-btn-secondary'}`}
            >
              Jarayonda
            </button>
            <button
              type="button"
              onClick={() => updateJournalFilters({ status: 'complete' })}
              className={`patta-hisob-filter-pill soft-btn ${statusFilter === 'complete' ? 'active soft-btn-primary' : 'soft-btn-secondary'}`}
            >
              To'liq
            </button>
          </div>
        </div>

        {/* Main Table Card (3-Level Hierarchical Accordion) */}
        {(!modelHistoryGroups || modelHistoryGroups.length === 0) ? (
          <div style={{ padding: '60px 20px', textAlign: 'center', backgroundColor: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '16px', color: '#64748b', fontSize: '13.5px' }}>
            <Layers size={36} color="#94a3b8" style={{ margin: '0 auto 12px', display: 'block', opacity: 0.5 }} />
            <div style={{ fontWeight: 700, color: '#0f172a', marginBottom: '4px' }}>
              {isArchiveMode
                ? 'Ushbu arxivda chop etilgan partiyalar topilmadi'
                : seriesTab === 'closed'
                ? 'Yakunlangan partiyalar tarixi hozircha bo‘sh'
                : 'Hozircha faol partiyalar mavjud emas'}
            </div>
            <div>«Patta» varag'ida yangi partiyalarni chop etishingiz mumkin.</div>
          </div>
        ) : (
          <div className="patta-hisob-table-card journal-model-list">
            {/* Level 1: Model Header Columns */}
            <div className="patta-hisob-model-cols journal-model-columns" aria-hidden="true">
              <div className="col-model">MODEL</div>
              <div className="col-partiya">PARTIYA</div>
              <div className="col-patta">PATTA · KIRITILGAN / JAMI</div>
              <div className="col-ish">ISH · KIRITILGAN / JAMI, DONA</div>
              <div className="col-holat">HOLAT</div>
            </div>

            {/* Level 1: Model Rows */}
            {paginatedGroups.map(({ group, parties }) => {
              const isModelExpanded = expandedModelIds.has(group.modelId);
              const pattaPct = group.totalPattas > 0 ? (group.submittedPattas / group.totalPattas) * 100 : 0;
              const ishPct = group.totalIshSoni > 0 ? (group.submittedIshSoni / group.totalIshSoni) * 100 : 0;
              const remainingPattas = Math.max(0, group.totalPattas - group.submittedPattas);
              const remainingIshSoni = Math.max(0, group.totalIshSoni - group.submittedIshSoni);

              return (
                <div key={group.modelId} className="patta-hisob-model-group journal-model-card">
                  <button
                    type="button"
                    className={`patta-hisob-model-row journal-model-row ${isModelExpanded ? 'expanded' : ''}`}
                    aria-expanded={isModelExpanded}
                    onClick={() => toggleModelAccordion(group.modelId)}
                  >
                    <div className="col-model journal-model-name">
                      <span className="chevron-icon">
                        {isModelExpanded ? <ChevronDown size={16} color="#059669" /> : <ChevronRight size={16} color="#64748b" />}
                      </span>
                      <span className="model-name journal-model-title">
                        {group.modelName.replace(/^(Модел-\s*|Модель-\s*|Model-\s*)+/i, '').trim()}
                      </span>
                    </div>

                    <div className="col-partiya journal-model-count">
                      {group.totalParties} ta
                    </div>

                    <div className="col-patta journal-model-metric">
                      <div className="progress-num">
                        <span className="metric-submitted">{group.submittedPattas}</span>
                        <span className="metric-total"> / {group.totalPattas}</span>
                      </div>
                      <div className="mini-progress-track journal-progress">
                        <div className="mini-progress-fill purple" style={{ width: `${pattaPct}%` }} />
                      </div>
                      <div className="metric-remaining">
                        {remainingPattas} ta qoldi
                      </div>
                    </div>

                    <div className="col-ish journal-model-metric">
                      <div className="progress-num">
                        <span className="metric-submitted">{group.submittedIshSoni.toLocaleString('ru-RU')}</span>
                        <span className="metric-total"> / {group.totalIshSoni.toLocaleString('ru-RU')}</span>
                      </div>
                      <div className="mini-progress-track journal-progress">
                        <div className="mini-progress-fill amber" style={{ width: `${ishPct}%` }} />
                      </div>
                      <div className="metric-remaining">
                        {remainingIshSoni.toLocaleString('ru-RU')} ta qoldi
                      </div>
                    </div>

                    <div className="col-holat">
                      {group.hasMismatch ? (
                        <span className="status-badge mismatch journal-status mismatch">Tafovut / Kamomat</span>
                      ) : group.isComplete ? (
                        <span className="status-badge complete journal-status complete">To'liq</span>
                      ) : (
                        <span className="status-badge in-progress journal-status">Jarayonda</span>
                      )}
                    </div>
                  </button>

                  {/* Level 2: Expanded Model Body -> Partiyalar List */}
                  {isModelExpanded && (
                    <div className="patta-hisob-partiyalar-container journal-party-wrap">
                      <div className="patta-hisob-partiyalar-card">
                        <table className="excel-table journal-party-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                          <tr className="patta-hisob-partiya-cols" style={{ display: 'grid' }}>
                            <th className="pcol-partiya" style={{ textAlign: 'left', border: 0 }}>PARTIYA</th>
                            <th className="pcol-rang" style={{ textAlign: 'left', border: 0 }}>RANG</th>
                            <th className="pcol-patta" style={{ textAlign: 'left', border: 0 }}>PATTA (KIRITILGAN / JAMI)</th>
                            <th className="pcol-reja" style={{ textAlign: 'left', border: 0 }}>REJADAGI ISH</th>
                            <th className="pcol-kiritilgan" style={{ textAlign: 'left', border: 0 }}>KIRITILGAN ISH</th>
                            <th className="pcol-holat" style={{ textAlign: 'center', border: 0 }}>HOLAT</th>
                            <th className="pcol-vaqt" style={{ textAlign: 'left', border: 0 }}>CHOP ETILGAN</th>
                            <th className="pcol-amal" style={{ textAlign: 'center', border: 0 }}>AMAL</th>
                          </tr>
                        </thead>
                        <tbody>
                          {parties.map((item) => {
                            const row = item.party;
                            const isPartyExpanded = expandedPartyIds.has(row.id);
                            const partyTickets = buildPartyTicketsList(row, submittedTickets, activeSizes, true, isArchiveMode);
                            const partyHealth = getPartyHealth(partyTickets);

                            const partyPattaCount = partyTickets.length;
                            const partySubmitted = partyTickets.filter((t) => t.isSubmitted).length;
                            const totalIsh = partyTickets.reduce((sum, t) => sum + t.expectedQty, 0);
                            const partyActualIsh = partyTickets.filter((t) => t.isSubmitted).reduce((sum, t) => sum + t.enteredQty, 0);
                            const remainingIsh = Math.max(0, totalIsh - partyActualIsh);

                            return (
                              <React.Fragment key={row.id}>
                                <tr
                                  className={`patta-hisob-partiya-row ${isPartyExpanded ? 'expanded' : ''}`}
                                  style={{ display: 'grid' }}
                                  onClick={() => toggleAccordion(row.id)}
                                >
                                  <td className="pcol-partiya" style={{ border: 0 }}>
                                    <span className="party-chevron">
                                      {isPartyExpanded ? <ChevronDown size={15} color="#059669" /> : <ChevronRight size={15} color="#94a3b8" />}
                                    </span>
                                    <span className="party-title">Partiya {row.partyNumber}</span>
                                    {duplicatePartyNumbers.has(String(row.partyNumber).trim()) && !row.isClosed && (
                                      <span style={{ fontSize: '10px', background: '#fee2e2', color: '#ef4444', padding: '1px 5px', borderRadius: '4px', fontWeight: 700 }}>
                                        Dublikat
                                      </span>
                                    )}
                                  </td>

                                  <td className="pcol-rang" style={{ border: 0 }}>
                                    {row.color || '—'}
                                  </td>

                                  <td className="pcol-patta" style={{ border: 0 }}>
                                    {partySubmitted} / {partyPattaCount}
                                  </td>

                                  <td className="pcol-reja" style={{ border: 0 }}>
                                    {totalIsh > 0 ? `${totalIsh.toLocaleString('ru-RU')} dona` : '—'}
                                  </td>

                                  <td className="pcol-kiritilgan" style={{ border: 0 }}>
                                    {partyActualIsh > 0 ? `${partyActualIsh.toLocaleString('ru-RU')} dona` : '—'}
                                  </td>

                                  <td className="pcol-holat" style={{ border: 0 }}>
                                    {partyHealth.isError || partyHealth.hasMismatch ? (
                                      <span className="party-badge mismatch">{partyHealth.label}</span>
                                    ) : partyHealth.status === 'complete' ? (
                                      <span className="party-badge complete">Topshirildi</span>
                                    ) : (
                                      <span className="party-badge pending">Kutilmoqda · {partySubmitted}/{partyPattaCount}</span>
                                    )}
                                  </td>

                                  <td className="pcol-vaqt" style={{ border: 0 }}>
                                    {formatTicketDateTime(row.printedAt)}
                                  </td>

                                  <td className="pcol-amal" style={{ border: 0 }} onClick={(e) => e.stopPropagation()}>
                                    {!isArchiveMode && !isAllTimeMode && (
                                      <button
                                        type="button"
                                        onClick={async () => {
                                          await confirmAndArchivePartyHistoryRecord(row, confirmAction, deletePrintedPartyRecord);
                                        }}
                                        className="party-del-btn"
                                        title="Partiyani o'chirish"
                                      >
                                        <Trash2 size={14} />
                                      </button>
                                    )}
                                  </td>
                                </tr>

                                {/* Level 3: Expanded Partiya Body -> Pattalar Nazorati */}
                                {isPartyExpanded && (
                                  <tr className="patta-hisob-tickets-row" style={{ display: 'block', width: '100%', height: 'auto' }}>
                                    <td colSpan={8} style={{ border: 0, padding: 0, display: 'block', width: '100%', height: 'auto', boxSizing: 'border-box' }}>
                                      <div className="patta-hisob-tickets-card">
                                        <div className="patta-hisob-tickets-header">
                                          <div className="tickets-header-left">
                                            Partiya {row.partyNumber} · Pattalar nazorati
                                          </div>
                                          <div className="tickets-header-right">
                                            <span className="stat-pill">Reja: {totalIsh.toLocaleString('ru-RU')} dona</span>
                                            <span className="stat-pill">Kiritilgan: {partyActualIsh.toLocaleString('ru-RU')} dona</span>
                                            <span className="stat-pill highlight">Qoldi: {remainingIsh.toLocaleString('ru-RU')} dona</span>

                                            {!isArchiveMode && !isAllTimeMode && partyHealth.hasMismatch && (
                                              <button
                                                type="button"
                                                onClick={async (e) => {
                                                  e.stopPropagation();
                                                  const ok = await confirmAction({
                                                    title: "Haqiqiy sonni tasdiqlash",
                                                    message: `Partiya ${row.partyNumber} sonini haqiqiy ${partyActualIsh.toLocaleString('ru-RU')} dona deb tasdiqlansinmi?`,
                                                    confirmText: "Tasdiqlash",
                                                    isDanger: false
                                                  });
                                                  if (ok) await confirmPartyActualQuantities(row.id);
                                                }}
                                                style={{
                                                  padding: '3px 10px',
                                                  fontSize: '11px',
                                                  borderRadius: '6px',
                                                  background: '#059669',
                                                  color: '#ffffff',
                                                  border: 0,
                                                  cursor: 'pointer',
                                                  fontWeight: 600,
                                                  display: 'inline-flex',
                                                  alignItems: 'center',
                                                  gap: '4px'
                                                }}
                                              >
                                                <Check size={12} />
                                                Haqiqiy sonni tasdiqlash
                                              </button>
                                            )}
                                          </div>
                                        </div>

                                        <table className="patta-hisob-tickets-table">
                                          <thead>
                                            <tr>
                                              <th style={{ textAlign: 'left', width: '12%' }}>PATTA №</th>
                                              <th style={{ textAlign: 'left', width: '10%' }}>RAZMER</th>
                                              <th style={{ textAlign: 'center', width: '14%' }}>KUTILGAN, DONA</th>
                                              <th style={{ textAlign: 'center', width: '14%' }}>KIRITILGAN, DONA</th>
                                              <th style={{ textAlign: 'center', width: '10%' }}>TAFOVUT</th>
                                              <th style={{ textAlign: 'center', width: '14%' }}>HOLAT</th>
                                              <th style={{ textAlign: 'center', width: '16%' }}>KIRITILGAN VAQTI</th>
                                              <th style={{ textAlign: 'center', width: '10%' }}>AMAL</th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {partyTickets.map((t) => {
                                              const isDiff = t.isSubmitted && t.enteredQty !== t.expectedQty;
                                              const diff = t.isSubmitted ? t.enteredQty - t.expectedQty : 0;

                                              return (
                                                <tr key={t.pattaNumber}>
                                                  <td style={{ textAlign: 'left' }}>
                                                    <span className="ticket-num-badge">№ {t.actualPattaNumber || t.pattaNumber}</span>
                                                  </td>
                                                  <td style={{ textAlign: 'left', fontWeight: 600 }}>{t.size}</td>
                                                  <td style={{ textAlign: 'center' }}>{t.expectedQty}</td>
                                                  <td style={{ textAlign: 'center' }}>
                                                    {t.isSubmitted ? t.enteredQty : '—'}
                                                  </td>
                                                  <td style={{ textAlign: 'center' }}>
                                                    {t.isSubmitted ? (
                                                      diff === 0 ? '0' : diff > 0 ? `+${diff}` : `${diff}`
                                                    ) : '—'}
                                                  </td>
                                                  <td style={{ textAlign: 'center' }}>
                                                    {t.isSubmitted ? (
                                                      isDiff ? (
                                                        <span className="ticket-badge mismatch">Tafovut</span>
                                                      ) : (
                                                        <span className="ticket-badge complete">Topshirildi</span>
                                                      )
                                                    ) : (
                                                      <span className="ticket-badge pending">Kutilmoqda</span>
                                                    )}
                                                  </td>
                                                  <td style={{ textAlign: 'center', color: '#64748b' }}>
                                                    {t.isSubmitted ? formatTicketDateTime(t) : '—'}
                                                  </td>
                                                  <td style={{ textAlign: 'center' }}>
                                                    <div className="ticket-action-btns">
                                                      <button
                                                        type="button"
                                                        onClick={() => {
                                                          if (t.isSubmitted && t.id) {
                                                            const rawTicket = submittedTickets.find((item) => item.id === t.id);
                                                            useWorkbookStore.getState().openModal({
                                                              type: 'edit_ticket',
                                                              data: rawTicket || t
                                                            } as any);
                                                          }
                                                        }}
                                                        className="ticket-act-btn edit"
                                                        title="Tahrirlash"
                                                      >
                                                        <Pencil size={11} />
                                                      </button>
                                                      {!isArchiveMode && !isAllTimeMode && (
                                                        <button
                                                          type="button"
                                                          onClick={async () => {
                                                            if (t.isSubmitted && t.id) {
                                                              const ok = await confirmAction({
                                                                title: "Pattani bekor qilish",
                                                                message: `Ushbu Patta ${t.actualPattaNumber || t.pattaNumber} ga kiritilgan hisobotni bekor qilmoqchimisiz?`,
                                                                confirmText: "Bekor qilish",
                                                                isDanger: true
                                                              });
                                                              if (ok) {
                                                                deleteSubmittedTicket(t.id!);
                                                              }
                                                            } else {
                                                              addNotification(
                                                                'info',
                                                                'Ma\'lumot',
                                                                `Patta ${t.actualPattaNumber || t.pattaNumber} hali kiritilmagan`
                                                              );
                                                            }
                                                          }}
                                                          className="ticket-act-btn del"
                                                          title="O'chirish"
                                                        >
                                                          <Trash2 size={11} />
                                                        </button>
                                                      )}
                                                    </div>
                                                  </td>
                                                </tr>
                                              );
                                            })}
                                          </tbody>
                                        </table>
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
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination Controls */}
        {totalPages > 1 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              padding: '16px',
              marginTop: '12px'
            }}
          >
            <button
              type="button"
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              style={{
                background: '#ffffff',
                border: '1px solid #e2e8f0',
                borderRadius: '8px',
                padding: '6px 12px',
                cursor: currentPage === 1 ? 'not-allowed' : 'pointer',
                opacity: currentPage === 1 ? 0.5 : 1
              }}
              title="Oldingi sahifa"
            >
              <ChevronLeft size={16} />
            </button>

            <span style={{ fontSize: '12.5px', fontWeight: 600, color: '#475569', minWidth: '120px', textAlign: 'center' }}>
              Sahifa {currentPage} / {totalPages}
            </span>

            <button
              type="button"
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage >= totalPages}
              style={{
                background: '#ffffff',
                border: '1px solid #e2e8f0',
                borderRadius: '8px',
                padding: '6px 12px',
                cursor: currentPage >= totalPages ? 'not-allowed' : 'pointer',
                opacity: currentPage >= totalPages ? 0.5 : 1
              }}
              title="Keyingi sahifa"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
