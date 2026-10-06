import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  TrendingUp,
  Layers,
  Tag,
  FileText,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Trash2,
  CheckCircle2,
  Check,
  Search,
  CheckCheck,
  Calendar,
  Archive,
  ArrowLeft,
  XCircle,
  Globe
} from 'lucide-react';
import { useWorkbookStore, DEFAULT_BATCH_SIZES } from '../../store/workbookStore';
import { PrintedPartyRecord, SubmittedTicketRecord } from '../../types/workbook';
import { buildPartyTicketsList, getPartyHealth } from '../../domain/partyAnalytics';
import { selectPartyHistoryForView, selectPartySeriesTab } from '../../domain/partyHistoryVisibility';
import { confirmAndArchivePartyHistoryRecord } from './pattaHistoryActions';
import { formatTicketDateTime, formatUzbekDate } from '../../utils/formatters';
import { getElectronApi, resolveElectronRuntimeMode } from '../../store/runtimeMode';

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

  const deletePrintedPartyRecord = useWorkbookStore((s) => s.deletePrintedPartyRecord);
  const deleteSubmittedTicket = useWorkbookStore((s) => s.deleteSubmittedTicket);
  const confirmPartyActualQuantities = useWorkbookStore((s) => s.confirmPartyActualQuantities);
  const confirmAction = useWorkbookStore((s) => s.confirmAction);
  const addNotification = useWorkbookStore((s) => s.addNotification);

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'mismatch' | 'complete' | 'in_progress'>('all');
  const [seriesTab, setSeriesTab] = useState<'active' | 'closed'>('active');
  
  // Phase 2: Pagination for large party history
  const [currentPage, setCurrentPage] = useState(1);
  const ITEMS_PER_PAGE = 50;
  const [totalItems, setTotalItems] = useState(0);
  
  const [expandedPartyIds, setExpandedPartyIds] = useState<Set<string>>(new Set());
  const [expandedModelIds, setExpandedModelIds] = useState<Set<string>>(new Set());
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

      // 1. Read all archive files
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
                  // In all-time view, clear archivedPattaNumbers so all original tickets (1..N) exist
                  partyMap.set(p.id, { ...p, archivedPattaNumbers: [] });
                }
              }
              for (const t of (res.data.submittedTickets || [])) {
                if (t.id) {
                  ticketMap.set(t.id, t);
                }
              }
            }
          } catch (e) {
            console.warn('Error reading archive in handleSelectAllTime', file.filename, e);
          }
        }
      }

      // 2. Merge live parties (new parties not yet in any archive)
      for (const p of (livePrintedPartyHistory || [])) {
        if (!partyMap.has(p.id)) {
          partyMap.set(p.id, { ...p, archivedPattaNumbers: [] });
        }
      }

      // 3. Merge live submitted tickets
      for (const t of (liveSubmittedTickets || [])) {
        if (t.id) {
          ticketMap.set(t.id, t);
        }
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
      if (next.has(partyId)) {
        next.delete(partyId);
      } else {
        next.add(partyId);
      }
      return next;
    });
  };

  const toggleModelAccordion = (modelId: string) => {
    setExpandedModelIds((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) {
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
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
          statusLabel: 'Tayyor'
        };
      }

      const tickets = buildPartyTicketsList(record, submittedTickets, activeSizes, isArchiveMode, isArchiveMode);
      if (isArchiveMode && tickets.length === 0) {
        // In closed months, parties with 0 submitted tickets are not shown
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
        group.statusLabel = '⚠️ Tafovut / Xatolik';
      } else if (group.isComplete) {
        group.statusLabel = '✅ To\'liq topshirilgan';
      } else {
        group.statusLabel = '⏳ Jarayonda';
      }
    });

    let groups = Object.values(grouped).filter((g) => g.parties.length > 0);

    // Apply Search Filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      groups = groups.filter((g) =>
        g.modelName.toLowerCase().includes(q) ||
        g.parties.some((p) => String(p.partyNumber).includes(q) || (p.color && p.color.toLowerCase().includes(q)))
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

  // Phase 2: Pagination - flatten all parties from all groups
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

  // Group paginated parties by model for display
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

  // Update total items for pagination controls
  useEffect(() => {
    setTotalItems(allPartiesFlat.length);
  }, [allPartiesFlat.length]);

  // Reset page when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, statusFilter, isArchiveMode]);

  // Overall KPIs
  const visiblePartyIds = useMemo(() => new Set(visiblePartyHistory.map((party) => party.id)), [visiblePartyHistory]);
  const totalActualSubmittedIshCount = submittedTickets
    ?.filter((ticket) => ticket.partyRecordId && visiblePartyIds.has(ticket.partyRecordId))
    .reduce((acc, ticket) => acc + (ticket.qty || 0), 0) || 0;

  // Total submitted and unsubmitted tickets & parties
  const { totalPartiesCount, totalPattasCount, totalExpectedIshCount, totalSubmittedPattasCount, totalUnsubmittedPattasCount, totalUnsubmittedIshCount } = useMemo(() => {
    let totalP = 0;
    let expectedIsh = 0;
    let sub = 0;
    let unsub = 0;
    let partyCount = 0;
    let unsubIsh = 0;

    for (const p of visiblePartyHistory || []) {
      const tickets = buildPartyTicketsList(p, submittedTickets, activeSizes, isArchiveMode, isArchiveMode);
      if (isArchiveMode && tickets.length === 0) {
        continue;
      }

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

  // Combine closed periods for selection
  const closedPeriodsList = useMemo(() => {
    const map = new Map<string, { filename: string; name: string; startDate: string; endDate?: string }>();

    // Add from periods store
    for (const p of periods || []) {
      if (p.isClosed) {
        const fn = p.archiveFilename || `archive_${p.id}.json`;
        map.set(fn, {
          filename: fn,
          name: p.name,
          startDate: p.startDate,
          endDate: p.endDate
        });
      }
    }

    // Add from disk files
    for (const a of archiveFiles) {
      if (!map.has(a.filename)) {
        map.set(a.filename, a);
      }
    }

    return Array.from(map.values());
  }, [periods, archiveFiles]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--bg-app)' }}>
      {/* Top Header & Control Bar */}
      <div style={{
        padding: '16px 20px 12px',
        background: 'var(--bg-surface)',
        borderBottom: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{
              width: '38px',
              height: '38px',
              borderRadius: 'var(--radius-md)',
              background: isAllTimeMode ? 'rgba(99, 102, 241, 0.15)' : isArchiveMode ? 'rgba(99, 102, 241, 0.15)' : 'var(--primary-light)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              {isAllTimeMode ? <Globe size={20} color="#6366f1" /> : isArchiveMode ? <Archive size={20} color="#818cf8" /> : <TrendingUp size={20} color="var(--primary)" />}
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <h1 style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>
                  Patta-hisob • Partiyalar va Pattalar Nazorati
                </h1>
                {isAllTimeMode ? (
                  <span style={{
                    fontSize: '11px',
                    fontWeight: 700,
                    background: 'rgba(99, 102, 241, 0.2)',
                    color: '#6366f1',
                    padding: '2px 8px',
                    borderRadius: 'var(--radius-full)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px'
                  }}>
                    <Globe size={11} /> Butun davr
                  </span>
                ) : isArchiveMode ? (
                  <span style={{
                    fontSize: '11px',
                    fontWeight: 700,
                    background: 'rgba(99, 102, 241, 0.2)',
                    color: '#818cf8',
                    padding: '2px 8px',
                    borderRadius: 'var(--radius-full)'
                  }}>
                    📁 Arxiv Ko'rinishi
                  </span>
                ) : (
                  <span style={{
                    fontSize: '11px',
                    fontWeight: 700,
                    background: 'var(--primary-light)',
                    color: 'var(--primary)',
                    padding: '2px 8px',
                    borderRadius: 'var(--radius-full)'
                  }}>
                    🟢 Faol Oy
                  </span>
                )}
              </div>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
                {isAllTimeMode
                  ? 'Barcha yopilgan oylar va joriy oydagi partiyalar va kiritilgan pattalarning to\'liq monitoringi'
                  : isArchiveMode
                  ? `Yopilgan oy arxivi: ${activePeriodName} (${formatUzbekDate(selectedArchiveData?.period?.startDate) || '—'} — ${formatUzbekDate(selectedArchiveData?.period?.endDate) || '—'})`
                  : 'Chop etilgan partiyalar, topshirilgan va qolgan kiritilmagan pattalar monitoringi'}
              </p>
            </div>
          </div>

          {/* Right Controls: Period Selector & Actions */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            {/* Modern Custom Period Dropdown */}
            <div ref={periodDropdownRef} style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => setIsPeriodDropdownOpen((prev) => !prev)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  background: isAllTimeMode ? 'rgba(99, 102, 241, 0.12)' : isArchiveMode ? 'rgba(99, 102, 241, 0.1)' : 'var(--bg-surface-subtle)',
                  border: isAllTimeMode ? '1.5px solid #6366f1' : isArchiveMode ? '1.5px solid #818cf8' : '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-full)',
                  padding: '5px 14px',
                  fontSize: '12.5px',
                  color: 'var(--text-primary)',
                  cursor: 'pointer',
                  boxShadow: isPeriodDropdownOpen ? '0 0 0 3px var(--primary-light)' : 'var(--shadow-xs)',
                  transition: 'all 0.2s ease'
                }}
              >
                {isAllTimeMode ? (
                  <Globe size={14} color="#6366f1" />
                ) : (
                  <Calendar size={14} color={isArchiveMode ? '#818cf8' : 'var(--primary)'} />
                )}
                <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>Davr:</span>
                <span style={{
                  color: isAllTimeMode ? '#6366f1' : isArchiveMode ? '#818cf8' : 'var(--primary)',
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}>
                  {isLoadingAllTime ? (
                    <span>Yuklanmoqda...</span>
                  ) : isAllTimeMode ? (
                    <>
                      <span>🌐</span>
                      <span>Butun davr bo'yicha</span>
                    </>
                  ) : isArchiveMode ? (
                    <>
                      <span>📁</span>
                      <span>{activePeriodName}</span>
                    </>
                  ) : (
                    <>
                      <span style={{
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        backgroundColor: '#10b981',
                        display: 'inline-block',
                        boxShadow: '0 0 6px #10b981'
                      }} />
                      <span>Joriy oy ({currentPeriod?.name || 'Faol'})</span>
                    </>
                  )}
                </span>
                <ChevronDown
                  size={14}
                  color="var(--text-secondary)"
                  style={{
                    transform: isPeriodDropdownOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                    transition: 'transform 0.2s ease',
                    marginLeft: '2px'
                  }}
                />
              </button>

              {/* Floating Custom Dropdown Menu */}
              {isPeriodDropdownOpen && (
                <div
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 8px)',
                    right: 0,
                    width: '320px',
                    maxHeight: '380px',
                    overflowY: 'auto',
                    backgroundColor: 'var(--bg-surface)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: '16px',
                    boxShadow: '0 16px 36px -8px rgba(0, 0, 0, 0.28), 0 6px 12px -4px rgba(0, 0, 0, 0.12)',
                    zIndex: 100,
                    padding: '8px'
                  }}
                >
                  <div style={{
                    padding: '6px 10px 8px',
                    fontSize: '11px',
                    fontWeight: 700,
                    color: 'var(--text-muted)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px'
                  }}>
                    Oylik davrini tanlang
                  </div>

                  {/* Option 1: All Time (Butun davr bo'yicha) */}
                  <div
                    onClick={() => {
                      handleSelectAllTime();
                      setIsPeriodDropdownOpen(false);
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '10px 12px',
                      borderRadius: '10px',
                      cursor: 'pointer',
                      backgroundColor: isAllTimeMode ? 'rgba(99, 102, 241, 0.15)' : 'transparent',
                      transition: 'background-color 0.15s',
                      marginBottom: '4px'
                    }}
                    onMouseEnter={(e) => {
                      if (!isAllTimeMode) e.currentTarget.style.backgroundColor = 'var(--bg-surface-subtle)';
                    }}
                    onMouseLeave={(e) => {
                      if (!isAllTimeMode) e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <div style={{
                        width: '28px',
                        height: '28px',
                        borderRadius: '50%',
                        backgroundColor: 'rgba(99, 102, 241, 0.15)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}>
                        <Globe size={15} color="#6366f1" />
                      </div>
                      <div>
                        <div style={{ fontSize: '13px', fontWeight: 700, color: isAllTimeMode ? '#6366f1' : 'var(--text-primary)' }}>
                          Butun davr bo'yicha
                        </div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          Barcha oylar va arxivlar jamlanmasi
                        </div>
                      </div>
                    </div>
                    {isAllTimeMode && (
                      <div style={{
                        width: '22px',
                        height: '22px',
                        borderRadius: '50%',
                        backgroundColor: '#6366f1',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}>
                        <Check size={13} color="#ffffff" strokeWidth={3} />
                      </div>
                    )}
                  </div>

                  {/* Option 2: Current Active Period */}
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
                      padding: '10px 12px',
                      borderRadius: '10px',
                      cursor: 'pointer',
                      backgroundColor: (!isArchiveMode && !isAllTimeMode) ? 'var(--primary-light)' : 'transparent',
                      transition: 'background-color 0.15s',
                      marginBottom: '4px'
                    }}
                    onMouseEnter={(e) => {
                      if (isArchiveMode || isAllTimeMode) e.currentTarget.style.backgroundColor = 'var(--bg-surface-subtle)';
                    }}
                    onMouseLeave={(e) => {
                      if (isArchiveMode || isAllTimeMode) e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <div style={{
                        width: '28px',
                        height: '28px',
                        borderRadius: '50%',
                        backgroundColor: 'rgba(16, 185, 129, 0.15)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}>
                        <span style={{
                          width: '10px',
                          height: '10px',
                          borderRadius: '50%',
                          backgroundColor: '#10b981',
                          boxShadow: '0 0 6px #10b981'
                        }} />
                      </div>
                      <div>
                        <div style={{ fontSize: '13px', fontWeight: 700, color: (!isArchiveMode && !isAllTimeMode) ? 'var(--primary)' : 'var(--text-primary)' }}>
                          Joriy oy (Faol)
                        </div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          {currentPeriod?.name || 'Joriy davr'}
                        </div>
                      </div>
                    </div>
                    {(!isArchiveMode && !isAllTimeMode) && (
                      <div style={{
                        width: '22px',
                        height: '22px',
                        borderRadius: '50%',
                        backgroundColor: 'var(--primary)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}>
                        <Check size={13} color="#ffffff" strokeWidth={3} />
                      </div>
                    )}
                  </div>

                  {/* Separator if archives exist */}
                  {closedPeriodsList.length > 0 && (
                    <div style={{
                      height: '1px',
                      backgroundColor: 'var(--border-subtle)',
                      margin: '6px 4px 8px'
                    }} />
                  )}

                  {closedPeriodsList.length > 0 && (
                    <div style={{
                      padding: '4px 10px 6px',
                      fontSize: '11px',
                      fontWeight: 700,
                      color: 'var(--text-muted)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.5px'
                    }}>
                      Yopilgan oylar arxivi ({closedPeriodsList.length})
                    </div>
                  )}

                  {/* Closed Periods */}
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
                          padding: '9px 12px',
                          borderRadius: '10px',
                          cursor: 'pointer',
                          backgroundColor: isSelected ? 'rgba(99, 102, 241, 0.15)' : 'transparent',
                          transition: 'background-color 0.15s',
                          marginBottom: '3px'
                        }}
                        onMouseEnter={(e) => {
                          if (!isSelected) e.currentTarget.style.backgroundColor = 'var(--bg-surface-subtle)';
                        }}
                        onMouseLeave={(e) => {
                          if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent';
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <div style={{
                            width: '28px',
                            height: '28px',
                            borderRadius: '8px',
                            backgroundColor: isSelected ? 'rgba(99, 102, 241, 0.2)' : 'var(--bg-surface-subtle)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                          }}>
                            <Archive size={14} color={isSelected ? '#818cf8' : 'var(--text-secondary)'} />
                          </div>
                          <div>
                            <div style={{ fontSize: '12.5px', fontWeight: 600, color: isSelected ? '#818cf8' : 'var(--text-primary)' }}>
                              {cp.name}
                            </div>
                            <div style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>
                              {formatUzbekDate(cp.startDate)} — {formatUzbekDate(cp.endDate) || '—'}
                            </div>
                          </div>
                        </div>
                        {isSelected && (
                          <div style={{
                            width: '20px',
                            height: '20px',
                            borderRadius: '50%',
                            backgroundColor: '#818cf8',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                          }}>
                            <Check size={12} color="#ffffff" strokeWidth={3} />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Switch to live period if in archive or all-time mode */}
            {isAllTimeMode ? (
              <button
                onClick={() => setIsAllTimeMode(false)}
                className="soft-btn soft-btn-primary"
                style={{ fontSize: '12px', padding: '6px 14px', gap: '6px' }}
                title="Joriy faol oylikka qaytish"
              >
                <ArrowLeft size={14} />
                <span>Joriy oyga qaytish</span>
              </button>
            ) : isArchiveMode ? (
              <button
                onClick={() => loadArchivedPeriod(null)}
                className="soft-btn soft-btn-primary"
                style={{ fontSize: '12px', padding: '6px 14px', gap: '6px' }}
                title="Joriy faol oylikka qaytish"
              >
                <ArrowLeft size={14} />
                <span>Joriy oyga qaytish</span>
              </button>
            ) : null}
          </div>
        </div>

        {/* All-Time Mode Alert Banner */}
        {isAllTimeMode && (
          <div style={{
            padding: '10px 16px',
            background: 'rgba(99, 102, 241, 0.1)',
            border: '1px solid rgba(99, 102, 241, 0.25)',
            borderRadius: 'var(--radius-lg)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: '12.5px',
            color: 'var(--text-primary)'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Globe size={16} color="#6366f1" />
              <span>
                Siz <strong>Butun davr bo'yicha (Barcha oylar)</strong> partiyalar va kiritilgan pattalarning to'liq monitoringini ko'rmoqdasiz.
              </span>
            </div>
            <button
              onClick={() => setIsAllTimeMode(false)}
              className="soft-btn soft-btn-secondary"
              style={{ fontSize: '11.5px', padding: '4px 10px', height: '26px' }}
            >
              Joriy oyga qaytish
            </button>
          </div>
        )}

        {/* Archive Mode Alert Banner */}
        {isArchiveMode && (
          <div style={{
            padding: '10px 16px',
            background: 'rgba(99, 102, 241, 0.1)',
            border: '1px solid rgba(99, 102, 241, 0.25)',
            borderRadius: 'var(--radius-lg)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: '12.5px',
            color: 'var(--text-primary)'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Archive size={16} color="#818cf8" />
              <span>
                Siz <strong>{activePeriodName}</strong> yopilgan oyining arxivlangan partiyalar hisobotini ko'rmoqdasiz. Bu davrdagi barcha statistika va pattalar saqlab qolingan.
              </span>
            </div>
            <button
              onClick={() => loadArchivedPeriod(null)}
              className="soft-btn soft-btn-secondary"
              style={{ fontSize: '11.5px', padding: '4px 10px', height: '26px' }}
            >
              Chiqish
            </button>
          </div>
        )}

        {/* KPI Cards Row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '10px' }}>
          {/* 1. Jami Partiyalar */}
          <div className="kpi-card" style={{ borderLeft: '4px solid #10b981' }}>
            <div className="kpi-icon-container" style={{ background: 'rgba(16, 185, 129, 0.15)' }}>
              <Layers size={17} color="var(--primary)" />
            </div>
            <div>
              <div className="kpi-label">Jami Partiyalar</div>
              <div className="kpi-value" style={{ color: 'var(--primary)' }}>
                {totalPartiesCount} <span style={{ fontSize: '12px', fontWeight: 500 }}>ta</span>
              </div>
            </div>
          </div>

          {/* 2. Jami Pattalar */}
          <div className="kpi-card" style={{ borderLeft: '4px solid #6366f1' }}>
            <div className="kpi-icon-container" style={{ background: 'rgba(99, 102, 241, 0.15)' }}>
              <Tag size={17} color="#818cf8" />
            </div>
            <div>
              <div className="kpi-label">Jami Pattalar</div>
              <div className="kpi-value" style={{ color: '#818cf8' }}>
                {totalPattasCount} <span style={{ fontSize: '12px', fontWeight: 500 }}>ta</span>
              </div>
            </div>
          </div>

          {/* 3. Kiritilgan Pattalar */}
          <div className="kpi-card" style={{ borderLeft: '4px solid #10b981' }}>
            <div className="kpi-icon-container" style={{ background: 'rgba(16, 185, 129, 0.15)' }}>
              <CheckCircle2 size={17} color="#10b981" />
            </div>
            <div>
              <div className="kpi-label">Kiritilgan Pattalar</div>
              <div className="kpi-value" style={{ color: '#10b981' }}>
                {totalSubmittedPattasCount} <span style={{ fontSize: '12px', fontWeight: 500 }}>ta</span>
              </div>
            </div>
          </div>

          {/* 4. Kiritilmagan Pattalar */}
          <div className="kpi-card" style={{ borderLeft: `4px solid ${totalUnsubmittedPattasCount > 0 ? '#ef4444' : 'var(--border-subtle)'}` }}>
            <div className="kpi-icon-container" style={{ background: totalUnsubmittedPattasCount > 0 ? 'rgba(239, 68, 68, 0.15)' : 'var(--bg-surface-subtle)' }}>
              <XCircle size={17} color={totalUnsubmittedPattasCount > 0 ? '#ef4444' : 'var(--text-muted)'} />
            </div>
            <div>
              <div className="kpi-label">Kiritilmagan Pattalar</div>
              <div className="kpi-value" style={{ color: totalUnsubmittedPattasCount > 0 ? '#ef4444' : 'var(--text-muted)' }}>
                {totalUnsubmittedPattasCount} <span style={{ fontSize: '12px', fontWeight: 500 }}>ta</span>
              </div>
            </div>
          </div>

          {/* 5. Rejadagi Ish Soni */}
          <div className="kpi-card" style={{ borderLeft: '4px solid #f59e0b' }}>
            <div className="kpi-icon-container" style={{ background: 'rgba(245, 158, 11, 0.15)' }}>
              <FileText size={17} color="#fbbf24" />
            </div>
            <div>
              <div className="kpi-label">Rejadagi Ish</div>
              <div className="kpi-value" style={{ color: '#fbbf24', fontSize: '16px' }}>
                {totalExpectedIshCount.toLocaleString()} <span style={{ fontSize: '11px', fontWeight: 500 }}>dona</span>
              </div>
            </div>
          </div>

          {/* 6. Haqiqatda Kiritilgan */}
          <div className="kpi-card" style={{ borderLeft: '4px solid #06b6d4' }}>
            <div className="kpi-icon-container" style={{ background: 'rgba(6, 182, 212, 0.15)' }}>
              <CheckCheck size={17} color="#38bdf8" />
            </div>
            <div>
              <div className="kpi-label">Kiritilgan Ish</div>
              <div className="kpi-value" style={{ color: '#38bdf8', fontSize: '16px' }}>
                {totalActualSubmittedIshCount.toLocaleString()} <span style={{ fontSize: '11px', fontWeight: 500 }}>dona</span>
              </div>
            </div>
          </div>

          {/* 7. Kiritilmagan Ish */}
          <div className="kpi-card" style={{ borderLeft: `4px solid ${totalUnsubmittedIshCount > 0 ? '#ef4444' : 'var(--border-subtle)'}` }}>
            <div className="kpi-icon-container" style={{ background: totalUnsubmittedIshCount > 0 ? 'rgba(239, 68, 68, 0.15)' : 'var(--bg-surface-subtle)' }}>
              <XCircle size={17} color={totalUnsubmittedIshCount > 0 ? '#ef4444' : 'var(--text-muted)'} />
            </div>
            <div>
              <div className="kpi-label">Kiritilmagan Ish</div>
              <div className="kpi-value" style={{ color: totalUnsubmittedIshCount > 0 ? '#ef4444' : 'var(--text-muted)', fontSize: '16px' }}>
                {totalUnsubmittedIshCount.toLocaleString()} <span style={{ fontSize: '11px', fontWeight: 500 }}>dona</span>
              </div>
            </div>
          </div>
        </div>

        {!isArchiveMode && !isAllTimeMode && (
          <div role="tablist" aria-label="Partiyalar holati" style={{ display: 'flex', gap: '8px', marginTop: '14px', borderBottom: '1px solid var(--border-subtle)' }}>
            {([
              { id: 'active', label: 'Patta hisob', count: (printedPartyHistory || []).filter((party) => !party.isClosed).length },
              { id: 'closed', label: 'Yopilgan · Yakunlangan', count: (printedPartyHistory || []).filter((party) => party.isClosed).length }
            ] as const).map((tab) => {
              const selected = seriesTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => {
                    setSeriesTab(tab.id);
                    setCurrentPage(1);
                    setStatusFilter('all');
                  }}
                  style={{
                    padding: '10px 14px',
                    border: 'none',
                    borderBottom: selected ? '2px solid var(--primary)' : '2px solid transparent',
                    background: 'transparent',
                    color: selected ? 'var(--primary)' : 'var(--text-secondary)',
                    fontSize: '12.5px',
                    fontWeight: selected ? 700 : 600,
                    cursor: 'pointer'
                  }}
                >
                  {tab.label} <span style={{ opacity: 0.75 }}>({tab.count})</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Filter Bar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: '240px' }}>
            <div style={{ position: 'relative', width: '100%', maxWidth: '320px' }}>
              <Search size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <input
                type="text"
                placeholder="Model yoki partiya raqami bo'yicha qidirish..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="soft-input"
                style={{ paddingLeft: '32px', height: '32px', fontSize: '12.5px', width: '100%' }}
              />
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <button
              onClick={() => setStatusFilter('all')}
              className={`soft-btn ${statusFilter === 'all' ? 'soft-btn-primary' : 'soft-btn-secondary'}`}
              style={{ fontSize: '11.5px', padding: '5px 12px' }}
            >
              Barchasi ({visiblePartyHistory?.length || 0})
            </button>
            <button
              onClick={() => setStatusFilter('mismatch')}
              className={`soft-btn ${statusFilter === 'mismatch' ? 'soft-btn-danger' : 'soft-btn-secondary'}`}
              style={{ fontSize: '11.5px', padding: '5px 12px' }}
            >
              ⚠️ Tafovut / Kamomat
            </button>
            <button
              onClick={() => setStatusFilter('in_progress')}
              className={`soft-btn ${statusFilter === 'in_progress' ? 'soft-btn-primary' : 'soft-btn-secondary'}`}
              style={{ fontSize: '11.5px', padding: '5px 12px' }}
            >
              ⏳ Jarayonda
            </button>
            <button
              onClick={() => setStatusFilter('complete')}
              className={`soft-btn ${statusFilter === 'complete' ? 'soft-btn-primary' : 'soft-btn-secondary'}`}
              style={{ fontSize: '11.5px', padding: '5px 12px' }}
            >
              ✅ To'liq
            </button>
          </div>
        </div>
      </div>

      {/* Main Content Area (Accordion per Model) */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
        {duplicatePartyNumbers.size > 0 && !isArchiveMode && (
          <div style={{
            marginBottom: '16px',
            padding: '12px 18px',
            backgroundColor: 'rgba(239, 68, 68, 0.12)',
            border: '1.5px solid rgba(239, 68, 68, 0.35)',
            borderRadius: 'var(--radius-lg)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '20px' }}>⚠️</span>
              <div>
                <strong style={{ color: '#ef4444', fontSize: '13px' }}>
                  Diqqat: Partiya {Array.from(duplicatePartyNumbers).map(n => `«${n}»`).join(', ')} raqami bir nechta modelda takrorlangan (dublikat)!
                </strong>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                  Agar biror partiya bekor qilingan yoki xato yaratilgan bo'lsa, uni pastdagi jadvaldan qizil axlat qutisi (🗑️) orqali o'chirib tashlashingiz mumkin.
                </div>
              </div>
            </div>
          </div>
        )}

        {(!modelHistoryGroups || modelHistoryGroups.length === 0) ? (
          <div
            style={{
              padding: '60px 20px',
              textAlign: 'center',
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-xl)',
              color: 'var(--text-muted)',
              fontSize: '13.5px'
            }}
          >
            <Layers size={36} color="var(--text-muted)" style={{ margin: '0 auto 12px', display: 'block', opacity: 0.5 }} />
            <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
              {isArchiveMode
                ? 'Ushbu arxivda chop etilgan partiyalar topilmadi'
                : !isAllTimeMode && seriesTab === 'closed'
                ? 'Yakunlangan partiyalar tarixi hozircha bo‘sh'
                : !isAllTimeMode
                ? 'Hozircha faol partiyalar mavjud emas'
                : 'Ushbu davrda partiyalar topilmadi'}
            </div>
            <div>
              {isArchiveMode
                ? 'Arxivlangan oylikda partiya ma\'lumotlari yo\'q.'
                : !isAllTimeMode && seriesTab === 'closed'
                ? 'Partiyalar “Partiyani yakunlash” bilan yopilgach, ularning tarixi shu tabda qoladi.'
                : 'Oldingi oydagi barcha partiyalar to\'liq kiritilib arxivga o\'tgan bo\'lishi mumkin. «Patta» varag\'ida yangi partiyalarni chop eting.'}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {paginatedGroups.map(({ group, parties }) => {
              const isModelExpanded = expandedModelIds.has(group.modelId);

              return (
                  <div
                    key={group.modelId}
                    style={{
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 'var(--radius-xl)',
                      overflow: 'hidden',
                      backgroundColor: 'var(--bg-surface)',
                      boxShadow: 'var(--shadow-xs)'
                    }}
                  >
                    {/* Model Header */}
                    <div
                      onClick={() => toggleModelAccordion(group.modelId)}
                      style={{
                        background: 'var(--bg-surface-subtle)',
                        borderBottom: isModelExpanded ? '1px solid var(--border-subtle)' : 'none',
                        padding: '12px 18px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        cursor: 'pointer',
                        userSelect: 'none',
                        flexWrap: 'wrap',
                        gap: '10px'
                      }}
                    >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      {isModelExpanded ? <ChevronDown size={18} color="var(--primary)" /> : <ChevronRight size={18} color="var(--text-secondary)" />}
                      <span style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>
                        Модел- {group.modelName.replace(/^(Модел-\s*|Модель-\s*|Model-\s*)+/i, '').trim()}
                      </span>
                      <span
                        style={{
                          fontSize: '11px',
                          background: 'var(--primary-light)',
                          color: 'var(--primary)',
                          padding: '2px 10px',
                          borderRadius: 'var(--radius-full)',
                          fontWeight: 700
                        }}
                      >
                        {group.totalParties} ta partiya
                      </span>
                    </div>

                    {/* Stats: Kiritilgan, Kiritilmagan, Jami patta, Kiritilgan ish, Kiritilmagan ish, Jami ish */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '14px', fontSize: '12.5px', flexWrap: 'wrap' }}>
                      <span style={{ color: '#10b981' }}>
                        Kiritilgan: <strong>{group.submittedPattas} ta</strong>
                      </span>
                      <span
                        style={{
                          color: group.unsubmittedPattas > 0 ? '#ef4444' : 'var(--text-muted)',
                          fontWeight: group.unsubmittedPattas > 0 ? 800 : 500,
                          background: group.unsubmittedPattas > 0 ? 'rgba(239, 68, 68, 0.12)' : 'transparent',
                          padding: group.unsubmittedPattas > 0 ? '2px 8px' : '0',
                          borderRadius: 'var(--radius-full)'
                        }}
                      >
                        Kiritilmagan: <strong>{group.unsubmittedPattas} ta</strong>
                      </span>
                      <span>Jami patta: <strong>{group.totalPattas} ta</strong></span>
                      <span style={{ color: '#10b981' }}>
                        Kiritilgan ish: <strong>{group.submittedIshSoni.toLocaleString()} dona</strong>
                      </span>
                      <span
                        style={{
                          color: group.unsubmittedIshSoni > 0 ? '#ef4444' : 'var(--text-muted)',
                          fontWeight: group.unsubmittedIshSoni > 0 ? 800 : 500,
                          background: group.unsubmittedIshSoni > 0 ? 'rgba(239, 68, 68, 0.12)' : 'transparent',
                          padding: group.unsubmittedIshSoni > 0 ? '2px 8px' : '0',
                          borderRadius: 'var(--radius-full)'
                        }}
                      >
                        Kiritilmagan ish: <strong>{group.unsubmittedIshSoni.toLocaleString()} dona</strong>
                      </span>
                      <span>Jami ish: <strong>{group.totalIshSoni.toLocaleString()} dona</strong></span>
                      <span
                        style={{
                          fontSize: '11.5px',
                          fontWeight: 700,
                          color: group.hasMismatch ? '#f87171' : (group.isComplete ? '#34d399' : '#818cf8'),
                          background: group.hasMismatch ? 'rgba(239, 68, 68, 0.15)' : (group.isComplete ? 'rgba(16, 185, 129, 0.15)' : 'rgba(99, 102, 241, 0.15)'),
                          padding: '3px 12px',
                          borderRadius: 'var(--radius-full)'
                        }}
                      >
                        {group.statusLabel}
                      </span>
                    </div>
                  </div>

                  {/* Parties Table */}
                  {isModelExpanded && (
                    <div style={{ overflowX: 'auto' }}>
                      <table className="excel-table" style={{ width: '100%' }}>
                        <thead>
                          <tr style={{ height: '34px', background: 'var(--bg-surface-subtle)' }}>
                            <th className="col-header" style={{ textAlign: 'left', paddingLeft: '16px' }}>Partiya</th>
                            <th className="col-header" style={{ textAlign: 'left' }}>Rang</th>
                            <th className="col-header" style={{ textAlign: 'right' }}>Patta soni</th>
                            <th className="col-header" style={{ textAlign: 'right', color: '#10b981' }}>Kiritilgan</th>
                            <th className="col-header" style={{ textAlign: 'right', color: '#ef4444' }}>Kiritilmagan</th>
                            <th className="col-header" style={{ textAlign: 'right', color: '#818cf8' }}>Jami Patta</th>
                            <th className="col-header" style={{ textAlign: 'right' }}>Rejadagi Ish</th>
                            <th className="col-header" style={{ textAlign: 'right', color: '#fbbf24' }}>Kiritilgan Ish</th>
                            <th className="col-header" style={{ textAlign: 'right', color: '#ef4444' }}>Kiritilmagan Ish</th>
                            <th className="col-header" style={{ textAlign: 'left' }}>Nazorat / Holati</th>
                            <th className="col-header" style={{ textAlign: 'left' }}>Chop etilgan vaqt</th>
                            {!isArchiveMode && !isAllTimeMode && (
                              <th className="col-header" style={{ textAlign: 'center', width: '50px' }}>O'chirish</th>
                            )}
                          </tr>
                        </thead>
                        <tbody>
                          {parties.map((item, idx) => {
                            const row = item.party;
                            const isExpanded = expandedPartyIds.has(row.id);
                            const partyTickets = buildPartyTicketsList(row, submittedTickets, activeSizes, isArchiveMode, isArchiveMode);
                            const partyHealth = getPartyHealth(partyTickets);

                            const partyPattaCount = partyTickets.length;
                            const partySubmitted = partyTickets.filter((t) => t.isSubmitted).length;
                            const partyUnsubmitted = Math.max(0, partyPattaCount - partySubmitted);
                            const totalIsh = partyTickets.reduce((sum, t) => sum + t.expectedQty, 0);
                            const partyActualIsh = partyTickets.filter((t) => t.isSubmitted).reduce((sum, t) => sum + t.enteredQty, 0);
                            const actualSubmittedSum = partyTickets.filter((t) => t.isSubmitted).reduce((s, t) => s + t.enteredQty, 0);

                            return (
                              <React.Fragment key={row.id}>
                                <tr
                                  onClick={() => toggleAccordion(row.id)}
                                  style={{
                                    height: '38px',
                                    background: partyHealth.isError 
                                      ? (isExpanded ? 'rgba(239, 68, 68, 0.12)' : 'rgba(239, 68, 68, 0.05)')
                                      : (isExpanded ? 'var(--primary-light)' : (idx % 2 === 0 ? 'var(--bg-surface)' : 'var(--bg-surface-subtle)')),
                                    cursor: 'pointer',
                                    transition: 'background-color 0.15s'
                                  }}
                                >
                                  {/* Col 1: Partiya */}
                                  <td style={{ paddingLeft: '16px', fontWeight: 700 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                      {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                      <span style={{
                                        background: partyHealth.isError ? 'rgba(239, 68, 68, 0.18)' : 'var(--primary-light)',
                                        color: partyHealth.isError ? '#f87171' : 'var(--primary)',
                                        padding: '2px 8px',
                                        borderRadius: 'var(--radius-full)',
                                        fontSize: '11.5px'
                                      }}>
                                        Partiya {row.partyNumber}
                                      </span>
                                      {duplicatePartyNumbers.has(String(row.partyNumber).trim()) && !row.isClosed && (
                                        <span style={{
                                          background: 'rgba(239, 68, 68, 0.18)',
                                          color: '#ef4444',
                                          padding: '2px 8px',
                                          borderRadius: 'var(--radius-full)',
                                          fontSize: '10.5px',
                                          fontWeight: 800,
                                          border: '1px solid rgba(239, 68, 68, 0.4)'
                                        }}
                                        title="Ushbu partiya raqami boshqa modelda ham mavjud (dublikat)!"
                                        >
                                          ⚠️ Dublikat
                                        </span>
                                      )}
                                      {row.isClosed && (
                                        <span style={{
                                          background: 'rgba(100, 116, 139, 0.15)',
                                          color: '#64748b',
                                          padding: '1px 6px',
                                          borderRadius: 'var(--radius-full)',
                                          fontSize: '10.5px',
                                          fontWeight: 600
                                        }}>
                                          Yakunlangan
                                        </span>
                                      )}
                                    </div>
                                  </td>

                                  {/* Col 2: Rang */}
                                  <td style={{ color: 'var(--text-secondary)' }}>{row.color}</td>

                                  {/* Col 3: Patta soni */}
                                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{partyPattaCount} ta</td>

                                  {/* Col 4: Kiritilgan */}
                                  <td style={{ textAlign: 'right', fontWeight: 700, color: '#10b981' }}>
                                    {partySubmitted} ta
                                  </td>

                                  {/* Col 5: Kiritilmagan */}
                                  <td style={{ textAlign: 'right', fontWeight: 700 }}>
                                    <span style={{
                                      color: partyUnsubmitted > 0 ? '#ef4444' : 'var(--text-muted)',
                                      background: partyUnsubmitted > 0 ? 'rgba(239, 68, 68, 0.12)' : 'transparent',
                                      padding: partyUnsubmitted > 0 ? '2px 7px' : '0',
                                      borderRadius: 'var(--radius-full)'
                                    }}>
                                      {partyUnsubmitted} ta
                                    </span>
                                  </td>

                                  {/* Col 6: Jami Patta */}
                                  <td style={{ textAlign: 'right', fontWeight: 700, color: '#818cf8' }}>
                                    {partyPattaCount} ta
                                  </td>

                                  {/* Col 7: Rejadagi Ish */}
                                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--primary)' }}>
                                    {totalIsh > 0 ? `${totalIsh.toLocaleString()} dona` : '—'}
                                  </td>

                                  {/* Col 8: Kiritilgan Ish */}
                                  <td style={{ textAlign: 'right', fontWeight: 700, color: '#fbbf24' }}>
                                    {partyActualIsh > 0 ? `${partyActualIsh.toLocaleString()} dona` : '—'}
                                  </td>

                                  {/* Col 9: Kiritilmagan Ish */}
                                  <td style={{ textAlign: 'right', fontWeight: 700 }}>
                                    <span style={{
                                      color: (totalIsh - partyActualIsh) > 0 ? '#ef4444' : 'var(--text-muted)',
                                      background: (totalIsh - partyActualIsh) > 0 ? 'rgba(239, 68, 68, 0.12)' : 'transparent',
                                      padding: (totalIsh - partyActualIsh) > 0 ? '2px 7px' : '0',
                                      borderRadius: 'var(--radius-full)'
                                    }}>
                                      {(totalIsh - partyActualIsh) > 0 ? `${Math.max(0, totalIsh - partyActualIsh).toLocaleString()} dona` : '0 dona'}
                                    </span>
                                  </td>

                                  {/* Col 10: Nazorat / Holati */}
                                  <td>
                                    <span style={{
                                      fontSize: '11px',
                                      fontWeight: 700,
                                      color: partyHealth.isError ? '#f87171' : (partyHealth.status === 'complete' ? '#34d399' : '#818cf8'),
                                      background: partyHealth.isError ? 'rgba(239, 68, 68, 0.15)' : (partyHealth.status === 'complete' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(99, 102, 241, 0.15)'),
                                      padding: '3px 8px',
                                      borderRadius: 'var(--radius-full)'
                                    }}>
                                      {partyHealth.label}
                                    </span>
                                  </td>

                                  {/* Col 10: Chop etilgan vaqt */}
                                  <td style={{ color: 'var(--text-muted)', fontSize: '11.5px' }}>{formatTicketDateTime(row.printedAt)}</td>

                                  {/* Col 11: O'chirish (only in active live mode) */}
                                  {!isArchiveMode && !isAllTimeMode && (
                                    <td style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                                      <button
                                        onClick={async () => {
                                          await confirmAndArchivePartyHistoryRecord(row, confirmAction, deletePrintedPartyRecord);
                                        }}
                                        className="soft-btn soft-btn-danger"
                                        style={{ padding: '4px 6px', borderRadius: 'var(--radius-full)' }}
                                        title="Ushbu partiyani o'chirish"
                                      >
                                        <Trash2 size={13} />
                                      </button>
                                    </td>
                                  )}
                                </tr>

                                {/* Inspection Checklist Sub-Row */}
                                {isExpanded && (
                                  <tr style={{ background: 'var(--bg-surface-subtle)' }}>
                                    <td colSpan={(isArchiveMode || isAllTimeMode) ? 11 : 12} style={{ padding: '14px 18px' }}>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                                          <div style={{
                                            background: 'var(--bg-surface)',
                                            border: partyHealth.isError ? '1.5px solid rgba(239, 68, 68, 0.4)' : '1px solid var(--border-subtle)',
                                            borderRadius: 'var(--radius-md)',
                                            padding: '12px 16px',
                                            boxShadow: 'var(--shadow-sm)'
                                          }}>
                                              <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
                                                <span>🎫 <strong>Модел- {row.modelName.replace(/^(Модел-\s*|Модель-\s*|Model-\s*)+/i, '').trim()}</strong> (Partiya {row.partyNumber}) — Pattalar nazorati</span>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 600 }}>
                                                    Reja: {totalIsh.toLocaleString()} dona | Kiritilgan: {actualSubmittedSum.toLocaleString()} dona | Kiritilmagan: {Math.max(0, totalIsh - actualSubmittedSum).toLocaleString()} dona ({partySubmitted}/{row.pattaCount} ta kiritilgan)
                                                  </span>
                                                  {!isArchiveMode && !isAllTimeMode && partyHealth.hasMismatch && (
                                                    <button
                                                      onClick={async (e) => {
                                                        e.stopPropagation();
                                                        const ok = await confirmAction({
                                                          title: "Haqiqiy sonni tasdiqlash",
                                                          message: `Partiya ${row.partyNumber} sonini haqiqiy ${actualSubmittedSum.toLocaleString()} dona deb tasdiqlansinmi?`,
                                                          confirmText: "Tasdiqlash",
                                                          isDanger: false
                                                        });
                                                         if (ok) await confirmPartyActualQuantities(row.id);
                                                      }}
                                                      className="soft-btn soft-btn-primary"
                                                      style={{ padding: '4px 12px', fontSize: '11.5px', borderRadius: 'var(--radius-full)' }}
                                                    >
                                                      <Check size={13} />
                                                      <span>Haqiqiy sonni tasdiqlash</span>
                                                    </button>
                                                  )}
                                                </div>
                                              </div>

                                              {/* Individual Tickets Table */}
                                              <div style={{ overflowX: 'auto' }}>
                                                <table className="excel-table" style={{ width: '100%', fontSize: '12px' }}>
                                                  <thead>
                                                    <tr style={{ background: 'var(--bg-surface-subtle)' }}>
                                                      <th className="col-header" style={{ textAlign: 'center', width: '70px' }}>Patta №</th>
                                                      <th className="col-header" style={{ textAlign: 'center', width: '80px' }}>Razmer</th>
                                                      <th className="col-header" style={{ textAlign: 'right' }}>Kutilgan son</th>
                                                      <th className="col-header" style={{ textAlign: 'right' }}>Kiritilgan son</th>
                                                      <th className="col-header" style={{ textAlign: 'right' }}>Farq / Kamomat</th>
                                                      <th className="col-header" style={{ textAlign: 'center', width: '130px' }}>Holati</th>
                                                      <th className="col-header" style={{ textAlign: 'left' }}>Topshirilgan vaqt</th>
                                                      {!isArchiveMode && !isAllTimeMode && <th className="col-header" style={{ textAlign: 'center', width: '50px' }}>Amal</th>}
                                                    </tr>
                                                  </thead>
                                                  <tbody>
                                                    {partyTickets.map((t) => {
                                                      const isDiff = t.isSubmitted && t.enteredQty !== t.expectedQty;

                                                      return (
                                                        <tr
                                                          key={t.pattaNumber}
                                                          style={{
                                                            height: '32px',
                                                            background: !t.isSubmitted 
                                                              ? 'transparent' 
                                                              : (isDiff ? 'rgba(239, 68, 68, 0.08)' : 'rgba(16, 185, 129, 0.04)')
                                                          }}
                                                        >
                                                          <td style={{ textAlign: 'center', fontWeight: 700 }}>
                                                            <span style={{
                                                              background: t.isSubmitted ? 'var(--primary-light)' : 'var(--bg-surface-subtle)',
                                                              color: t.isSubmitted ? 'var(--primary)' : 'var(--text-muted)',
                                                              padding: '2px 8px',
                                                              borderRadius: 'var(--radius-full)'
                                                            }}>
                                                              № {t.actualPattaNumber || t.pattaNumber}
                                                            </span>
                                                          </td>
                                                          <td style={{ textAlign: 'center', fontWeight: 600 }}>{t.size}</td>
                                                          <td style={{ textAlign: 'right', fontWeight: 600 }}>{t.expectedQty} ta</td>
                                                          <td style={{ textAlign: 'right', fontWeight: 700, color: t.isSubmitted ? 'var(--primary)' : 'var(--text-muted)' }}>
                                                            {t.isSubmitted ? `${t.enteredQty} ta` : '—'}
                                                          </td>
                                                          <td style={{ textAlign: 'right', fontWeight: 700 }}>
                                                            {t.isSubmitted ? (
                                                              t.enteredQty === t.expectedQty ? (
                                                                <span style={{ color: '#10b981' }}>0</span>
                                                              ) : t.enteredQty > t.expectedQty ? (
                                                                <span style={{ color: '#3b82f6' }}>+{t.enteredQty - t.expectedQty}</span>
                                                              ) : (
                                                                <span style={{ color: '#ef4444' }}>-{t.expectedQty - t.enteredQty}</span>
                                                              )
                                                            ) : (
                                                              <span style={{ color: 'var(--text-muted)' }}>Kiritilmagan</span>
                                                            )}
                                                          </td>
                                                          <td style={{ textAlign: 'center' }}>
                                                            {t.isSubmitted ? (
                                                              <span style={{
                                                                fontSize: '10.5px',
                                                                fontWeight: 700,
                                                                color: isDiff ? '#f87171' : '#34d399',
                                                                background: isDiff ? 'rgba(239, 68, 68, 0.15)' : 'rgba(16, 185, 129, 0.15)',
                                                                padding: '2px 8px',
                                                                borderRadius: 'var(--radius-full)'
                                                              }}>
                                                                {isDiff ? 'Tafovut' : 'Topshirildi'}
                                                              </span>
                                                            ) : (
                                                              <span style={{
                                                                fontSize: '10.5px',
                                                                fontWeight: 600,
                                                                color: '#f59e0b',
                                                                background: 'rgba(245, 158, 11, 0.15)',
                                                                padding: '2px 8px',
                                                                borderRadius: 'var(--radius-full)'
                                                              }}>
                                                                Kutilmoqda
                                                              </span>
                                                            )}
                                                          </td>
                                                          <td style={{ color: 'var(--text-muted)', fontSize: '11px', whiteSpace: 'nowrap' }}>
                                                            {formatTicketDateTime(t)}
                                                          </td>
                                                          {!isArchiveMode && !isAllTimeMode && (
                                                            <td style={{ textAlign: 'center' }}>
                                                              {t.isSubmitted && t.id ? (
                                                                <button
                                                                  onClick={async (e) => {
                                                                    e.stopPropagation();
                                                                    const ok = await confirmAction({
                                                                      title: "Pattani bekor qilish",
                                                                      message: `Ushbu Patta ${t.actualPattaNumber || t.pattaNumber} ga kiritilgan hisobotni bekor qilmoqchimisiz?`,
                                                                      confirmText: "Bekor qilish",
                                                                      isDanger: true
                                                                    });
                                                                    if (ok) {
                                                                      deleteSubmittedTicket(t.id!);
                                                                    }
                                                                  }}
                                                                  className="soft-btn soft-btn-danger"
                                                                  style={{ padding: '3px 6px', borderRadius: 'var(--radius-full)' }}
                                                                  title="Ushbu pattani o'chirish / qayta kiritish uchun bo'shatish"
                                                                >
                                                                  <Trash2 size={12} />
                                                                </button>
                                                              ) : null}
                                                            </td>
                                                          )}
                                                        </tr>
                                                      );
                                                    })}
                                                  </tbody>
                                                </table>
                                              </div>
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
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Phase 2: Pagination Controls */}
      {totalPages > 1 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            padding: '16px',
            background: 'var(--bg-surface)',
            borderTop: '1px solid var(--border-subtle)',
            marginTop: '8px'
          }}
        >
          <button
            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
            disabled={currentPage === 1}
            className="soft-btn soft-btn-secondary"
            style={{ padding: '6px 12px', borderRadius: 'var(--radius-full)' }}
            title="Oldingi sahifa"
          >
            <ChevronLeft size={16} />
          </button>
          
          <span style={{ 
            fontSize: '13px', 
            fontWeight: 600, 
            color: 'var(--text-primary)',
            minWidth: '120px',
            textAlign: 'center'
          }}>
            Sahifa {currentPage} / {totalPages} ({totalItems} ta partiya)
          </span>
          
          <button
            onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
            disabled={currentPage >= totalPages}
            className="soft-btn soft-btn-secondary"
            style={{ padding: '6px 12px', borderRadius: 'var(--radius-full)' }}
            title="Keyingi sahifa"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}
    </div>
  );
};
