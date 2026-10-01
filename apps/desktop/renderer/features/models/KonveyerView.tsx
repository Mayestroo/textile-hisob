import React, { useState, useMemo, useCallback } from 'react';
import { 
  Factory, 
  Search, 
  Download, 
  Layers, 
  Shirt, 
  Clock, 
  TrendingUp,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  LayoutGrid,
  ListFilter,
  Trash2,
  Edit2
} from 'lucide-react';
import { useWorkbookStore } from '../../store/workbookStore';
import { CustomSelect } from '../../components/ui/CustomSelect';
import { formatMoney, formatTicketDateTime } from '../../utils/formatters';

export const KonveyerView: React.FC = () => {
  const submittedTickets = useWorkbookStore((s) => s.submittedTickets);
  const models = useWorkbookStore((s) => s.models);
  const workers = useWorkbookStore((s) => s.workers);
  const selectedArchiveFilename = useWorkbookStore((s) => s.selectedArchiveFilename);
  const deleteSubmittedTicket = useWorkbookStore((s) => s.deleteSubmittedTicket);
  const confirmAction = useWorkbookStore((s) => s.confirmAction);
  const openModal = useWorkbookStore((s) => s.openModal);
  const isArchiveMode = !!selectedArchiveFilename;

  const [activeTab, setActiveTab] = useState<'matrix' | 'details'>('matrix');
  const [searchQuery, setSearchQuery] = useState('');
  const [onlyActiveModels, setOnlyActiveModels] = useState<boolean>(false);
  const [expandedKonveyer, setExpandedKonveyer] = useState<string | null>(null);

  // Detail filters
  const [selectedKonveyer, setSelectedKonveyer] = useState<string>('all');
  const [selectedModel, setSelectedModel] = useState<string>('all');
  const [selectedParty, setSelectedParty] = useState<string>('all');

  // Map of workerId -> workerName
  const workerMap = useMemo(() => {
    const map = new Map<number, string>();
    for (const w of workers) {
      map.set(w.id, w.name);
    }
    return map;
  }, [workers]);

  // Map of modelId -> ModelConfig
  const modelMap = useMemo(() => {
    const map = new Map<string, typeof models[0]>();
    for (const m of models) {
      map.set(m.id, m);
    }
    return map;
  }, [models]);

  // Precomputed map of modelId -> Map<opName, rate>
  const modelOpRatesMap = useMemo(() => {
    const map = new Map<string, Map<string, number>>();
    for (const m of models) {
      const opMap = new Map<string, number>();
      for (const op of m.operations) {
        opMap.set(op.name, op.rate);
      }
      map.set(m.id, opMap);
    }
    return map;
  }, [models]);

  // Calculate ticket earnings
  const calculateTicketAmount = useCallback((ticket: typeof submittedTickets[0]) => {
    const opRateMap = modelOpRatesMap.get(ticket.modelId);
    if (!opRateMap) return 0;

    let total = 0;
    for (const entry of ticket.entries || []) {
      const rate = entry.rateSnapshot !== undefined && entry.rateSnapshot > 0
        ? entry.rateSnapshot
        : (opRateMap?.get(entry.opName) || 0);
      total += rate * ticket.qty;
    }
    return total;
  }, [modelOpRatesMap]);

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
      modelBreakdown: Record<string, { qty: number; pattaCount: number; amount: number }>;
      totalQty: number;
      totalPattas: number;
      totalAmount: number;
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

      if (!data[k].modelBreakdown[t.modelId]) {
        data[k].modelBreakdown[t.modelId] = { qty: 0, pattaCount: 0, amount: 0 };
      }

      const amt = calculateTicketAmount(t);
      data[k].modelBreakdown[t.modelId].qty += t.qty;
      data[k].modelBreakdown[t.modelId].pattaCount += 1;
      data[k].modelBreakdown[t.modelId].amount += amt;

      data[k].totalQty += t.qty;
      data[k].totalPattas += 1;
      data[k].totalAmount += amt;
      data[k].tickets.push(t);
    }

    return data;
  }, [allKonveyerKeys, submittedTickets, models, calculateTicketAmount]);

  // Model column totals across all konveyers
  const modelTotals = useMemo(() => {
    const totals: Record<string, { totalQty: number; totalPattas: number; totalAmount: number }> = {};
    for (const m of models) {
      totals[m.id] = { totalQty: 0, totalPattas: 0, totalAmount: 0 };
    }

    for (const row of Object.values(matrixData)) {
      for (const m of models) {
        const item = row.modelBreakdown[m.id] || { qty: 0, pattaCount: 0, amount: 0 };
        totals[m.id].totalQty += item.qty;
        totals[m.id].totalPattas += item.pattaCount;
        totals[m.id].totalAmount += item.amount;
      }
    }
    return totals;
  }, [matrixData, models]);

  // Displayed models (can filter out models with 0 work if toggle is on)
  const displayedModels = useMemo(() => {
    if (!onlyActiveModels) return models;
    return models.filter((m) => (modelTotals[m.id]?.totalQty || 0) > 0);
  }, [models, onlyActiveModels, modelTotals]);

  // Grand totals
  const grandTotals = useMemo(() => {
    let totalQty = 0;
    let totalPattas = 0;
    let totalAmount = 0;

    for (const row of Object.values(matrixData)) {
      totalQty += row.totalQty;
      totalPattas += row.totalPattas;
      totalAmount += row.totalAmount;
    }

    return {
      activeKonveyersCount: allKonveyerKeys.length,
      totalQty,
      totalPattas,
      totalAmount
    };
  }, [matrixData, allKonveyerKeys]);

  // Filtered rows for matrix search
  const filteredKonveyerKeys = useMemo(() => {
    if (!searchQuery.trim()) return allKonveyerKeys;
    const q = searchQuery.toLowerCase().trim();
    return allKonveyerKeys.filter((k) => {
      if (k.toLowerCase().includes(q)) return true;
      const row = matrixData[k];
      if (!row) return false;
      return displayedModels.some((m) => {
        const qty = row.modelBreakdown[m.id]?.qty || 0;
        return qty > 0 && (m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
      });
    });
  }, [allKonveyerKeys, searchQuery, matrixData, displayedModels]);

  // Filtered tickets for detailed table view
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

  const filteredTickets = useMemo(() => {
    // Har bir pattaga uning bazaga kiritilgan ketma-ket tartib raqami (1, 2, ... N) biriktiriladi
    const ticketsWithSeq = (submittedTickets || []).map((t, idx) => ({
      ...t,
      globalSeq: idx + 1
    }));

    // Eng so'nggi kiritilgan patta doim yuqorida turishi uchun teskari tartib
    const list = [...ticketsWithSeq].reverse();
    list.sort((a, b) => {
      const tA = parseInt(a.id?.match(/^sub_(\d+)/)?.[1] || '0', 10);
      const tB = parseInt(b.id?.match(/^sub_(\d+)/)?.[1] || '0', 10);
      if (tA && tB && tA !== tB) return tB - tA;
      return b.globalSeq - a.globalSeq;
    });

    return list.filter((t) => {
      const kVal = (t.konveyer || 'Noma\'lum').trim();
      if (selectedKonveyer !== 'all' && kVal !== selectedKonveyer) return false;
      if (selectedModel !== 'all' && t.modelId !== selectedModel) return false;
      if (selectedParty !== 'all' && t.partyNumber !== selectedParty) return false;

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const model = modelMap.get(t.modelId);
        const modelName = (model?.name || t.modelId).toLowerCase();
        const party = String(t.partyNumber).toLowerCase();
        const patta = String(t.pattaNumber).toLowerCase();
        const konv = kVal.toLowerCase();
        const size = (t.size || '').toLowerCase();
        const color = (t.color || '').toLowerCase();

        return (
          modelName.includes(q) ||
          party.includes(q) ||
          patta.includes(q) ||
          konv.includes(q) ||
          size.includes(q) ||
          color.includes(q)
        );
      }

      return true;
    });
  }, [submittedTickets, selectedKonveyer, selectedModel, selectedParty, searchQuery, modelMap]);

  const toCsvCell = (value: unknown) => {
    const text = String(value ?? '');
    const safeText = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safeText.replace(/"/g, '""')}"`;
  };

  // Export Matrix to CSV
  const handleExportMatrixCSV = () => {
    const modelHeaders = displayedModels.map((m) =>
      toCsvCell(m.name.replace(/^(Модел-\s*|Модель-\s*|Model-\s*)+/i, '').trim())
    );
    const headers = ['№', 'Konveyer', ...modelHeaders, 'Jami Ish (dona)', 'Jami Patta'];

    const rows = filteredKonveyerKeys.map((k, idx) => {
      const row = matrixData[k];
      const modelCells = displayedModels.map((m) => row?.modelBreakdown[m.id]?.qty || 0);
      return [
        idx + 1,
        toCsvCell(k ? (k === 'Noma\'lum' ? k : `${k}-Konveyer`) : 'Noma\'lum'),
        ...modelCells,
        row?.totalQty || 0,
        row?.totalPattas || 0
      ];
    });

    // Grand total row
    const totalModelCells = displayedModels.map((m) => modelTotals[m.id]?.totalQty || 0);
    const grandRow = [
      '',
      toCsvCell('ЖАМИ (ИТОГО)'),
      ...totalModelCells,
      grandTotals.totalQty,
      grandTotals.totalPattas
    ];

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map((r) => r.join(',')), grandRow.join(',')].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Konveyerlar_modellar_matritsasi_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', backgroundColor: 'var(--bg-app)', height: '100%', overflow: 'hidden' }}>
      {/* Top Header & Metrics Bar */}
      <div style={{ 
        padding: '16px 20px 12px 20px', 
        backgroundColor: 'var(--bg-surface)', 
        borderBottom: '1px solid var(--border-default)',
        boxShadow: 'var(--shadow-xs)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px', flexWrap: 'wrap', gap: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ 
              width: '40px', 
              height: '40px', 
              borderRadius: '10px', 
              backgroundColor: 'rgba(124, 58, 237, 0.12)', 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'center',
              border: '1px solid rgba(124, 58, 237, 0.25)'
            }}>
              <Factory size={22} color="#7c3aed" />
            </div>
            <div>
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.3px' }}>
                Konveyerlar va Modellar Nazorati
              </h2>
              <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-muted)' }}>
                Har bir konveyer qaysi modeldan nechta ish bajarganligi statistikasi
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {/* View Mode Toggle */}
            <div style={{ display: 'flex', backgroundColor: 'var(--bg-surface-subtle)', padding: '3px', borderRadius: '8px', border: '1px solid var(--border-subtle)' }}>
              <button
                onClick={() => setActiveTab('matrix')}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '5px 12px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  fontWeight: 700,
                  border: 'none',
                  cursor: 'pointer',
                  backgroundColor: activeTab === 'matrix' ? 'var(--primary)' : 'transparent',
                  color: activeTab === 'matrix' ? '#ffffff' : 'var(--text-secondary)',
                  boxShadow: activeTab === 'matrix' ? 'var(--shadow-xs)' : 'none',
                  transition: 'all 0.15s ease'
                }}
              >
                <LayoutGrid size={14} />
                <span>Modellar Matritsasi</span>
              </button>
              <button
                onClick={() => setActiveTab('details')}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '5px 12px',
                  borderRadius: '6px',
                  fontSize: '12px',
                  fontWeight: 700,
                  border: 'none',
                  cursor: 'pointer',
                  backgroundColor: activeTab === 'details' ? 'var(--primary)' : 'transparent',
                  color: activeTab === 'details' ? '#ffffff' : 'var(--text-secondary)',
                  boxShadow: activeTab === 'details' ? 'var(--shadow-xs)' : 'none',
                  transition: 'all 0.15s ease'
                }}
              >
                <ListFilter size={14} />
                <span>Pattalar Ro'yxati</span>
              </button>
            </div>

            {/* Export CSV */}
            <button
              onClick={handleExportMatrixCSV}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '7px 14px',
                backgroundColor: 'var(--bg-surface)',
                border: '1px solid var(--border-default)',
                borderRadius: '8px',
                fontSize: '12.5px',
                fontWeight: 600,
                color: 'var(--text-primary)',
                cursor: 'pointer',
                transition: 'all 0.15s ease'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-surface-subtle)')}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'var(--bg-surface)')}
            >
              <Download size={14} color="var(--text-muted)" />
              <span>Excel (CSV) Eksport</span>
            </button>
          </div>
        </div>

        {/* KPI Mini Cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
          <div style={{ backgroundColor: 'rgba(147, 51, 234, 0.12)', borderRadius: '8px', padding: '10px 14px', border: '1px solid rgba(147, 51, 234, 0.25)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '11.5px', fontWeight: 600, color: '#a855f7', textTransform: 'uppercase' }}>Faol Konveyerlar</span>
              <Factory size={16} color="#a855f7" />
            </div>
            <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', marginTop: '4px' }}>
              {grandTotals.activeKonveyersCount} ta
            </div>
          </div>

          <div style={{ backgroundColor: 'var(--primary-light)', borderRadius: '8px', padding: '10px 14px', border: '1px solid rgba(16, 185, 129, 0.25)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '11.5px', fontWeight: 600, color: 'var(--primary)', textTransform: 'uppercase' }}>Jami Tikilgan Ish</span>
              <Shirt size={16} color="var(--primary)" />
            </div>
            <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', marginTop: '4px' }}>
              {formatMoney(grandTotals.totalQty)} dona
            </div>
          </div>

          <div style={{ backgroundColor: 'rgba(245, 158, 11, 0.12)', borderRadius: '8px', padding: '10px 14px', border: '1px solid rgba(245, 158, 11, 0.25)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '11.5px', fontWeight: 600, color: '#f59e0b', textTransform: 'uppercase' }}>Kiritilgan Pattalar</span>
              <Layers size={16} color="#f59e0b" />
            </div>
            <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', marginTop: '4px' }}>
              {grandTotals.totalPattas} ta patta
            </div>
          </div>

          <div style={{ backgroundColor: 'rgba(34, 197, 94, 0.12)', borderRadius: '8px', padding: '10px 14px', border: '1px solid rgba(34, 197, 94, 0.25)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: '11.5px', fontWeight: 600, color: '#22c55e', textTransform: 'uppercase' }}>Jami Ish Haqi</span>
              <TrendingUp size={16} color="#22c55e" />
            </div>
            <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', marginTop: '4px' }}>
              {formatMoney(grandTotals.totalAmount)} so'm
            </div>
          </div>
        </div>
      </div>

      {/* Controls Bar */}
      <div style={{ 
        padding: '10px 20px', 
        backgroundColor: 'var(--bg-surface)', 
        borderBottom: '1px solid var(--border-default)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        flexWrap: 'wrap'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, minWidth: '280px' }}>
          {/* Search */}
          <div style={{ position: 'relative', width: '280px' }}>
            <Search size={14} color="#94a3b8" style={{ position: 'absolute', left: '10px', top: '9px' }} />
            <input
              type="text"
              placeholder={activeTab === 'matrix' ? "Konveyer yoki model qidirish..." : "Qidiruv (Partiya, Patta, Model...)"}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="soft-input"
              style={{
                width: '100%',
                paddingLeft: '32px',
                height: '32px',
                fontSize: '12.5px',
                borderRadius: '6px'
              }}
            />
          </div>

          {activeTab === 'matrix' ? (
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', fontWeight: 600, color: 'var(--text-secondary)', cursor: 'pointer', userSelect: 'none' }}>
              <input
                type="checkbox"
                checked={onlyActiveModels}
                onChange={(e) => setOnlyActiveModels(e.target.checked)}
                style={{ cursor: 'pointer', accentColor: 'var(--primary)' }}
              />
              Faqat ishlangan modellarni ko'rsatish ({displayedModels.length}/{models.length})
            </label>
          ) : (
            <>
              {/* Konveyer Dropdown */}
              <CustomSelect
                value={selectedKonveyer}
                onChange={setSelectedKonveyer}
                minWidth="160px"
                options={[
                  { value: 'all', label: 'Barcha konveyerlar' },
                  ...allKonveyerKeys.map((k) => ({ value: k, label: k === 'Noma\'lum' ? k : `${k}-Konveyer` }))
                ]}
              />

              {/* Model Dropdown */}
              <CustomSelect
                value={selectedModel}
                onChange={setSelectedModel}
                minWidth="160px"
                options={[
                  { value: 'all', label: 'Barcha modellar' },
                  ...models.map((m) => ({ value: m.id, label: m.name }))
                ]}
              />

              {/* Party Dropdown */}
              <CustomSelect
                value={selectedParty}
                onChange={setSelectedParty}
                minWidth="140px"
                options={[
                  { value: 'all', label: 'Barcha partiyalar' },
                  ...uniqueParties.map((p) => ({ value: p, label: `${p}-partiya` }))
                ]}
              />
            </>
          )}

          {(searchQuery || (activeTab === 'details' && (selectedKonveyer !== 'all' || selectedModel !== 'all' || selectedParty !== 'all'))) && (
            <button
              onClick={() => {
                setSearchQuery('');
                setSelectedKonveyer('all');
                setSelectedModel('all');
                setSelectedParty('all');
              }}
              style={{
                border: 'none',
                background: 'transparent',
                color: '#ef4444',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                fontSize: '12px',
                fontWeight: 600
              }}
            >
              <RotateCcw size={13} />
              Tozalash
            </button>
          )}
        </div>

        <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', fontWeight: 600 }}>
          {activeTab === 'matrix' ? (
            <span>Jami konveyerlar: <strong style={{ color: 'var(--text-primary)' }}>{filteredKonveyerKeys.length} ta</strong></span>
          ) : (
            <span>Topildi: <strong style={{ color: 'var(--text-primary)' }}>{filteredTickets.length}</strong> ta patta</span>
          )}
        </div>
      </div>

      {/* Main Content Area */}
      <div style={{ flex: 1, overflow: 'auto', backgroundColor: 'var(--bg-surface)' }}>
        {activeTab === 'matrix' ? (
          /* ========================================================= */
          /* PIVOT MATRIX VIEW: Rows = Konveyer, Header = Models       */
          /* ========================================================= */
          filteredKonveyerKeys.length === 0 ? (
            <div style={{ 
              height: '100%', 
              display: 'flex', 
              flexDirection: 'column', 
              alignItems: 'center', 
              justifyContent: 'center',
              padding: '40px 20px',
              color: 'var(--text-muted)'
            }}>
              <Factory size={48} color="var(--border-strong)" style={{ marginBottom: '12px' }} />
              <h3 style={{ margin: '0 0 6px 0', fontSize: '16px', fontWeight: 700, color: 'var(--text-secondary)' }}>
                Hali hech qanday konveyerga patta topshirilmadi
              </h3>
              <p style={{ margin: 0, fontSize: '13px', maxWidth: '420px', textAlign: 'center' }}>
                Patta varag'ida konveyer raqami kiritilib "Jo'natish" tugmasi bosilganda, har bir konveyer qaysi modeldan nechta ish bajargani shu yerda avtomatik ko'rinadi.
              </p>
            </div>
          ) : (
            <table
              className="excel-table"
              style={{
                width: '100%',
                borderCollapse: 'separate',
                borderSpacing: 0,
                minWidth: `${220 + displayedModels.length * 130 + 170}px`
              }}
            >
              <thead>
                <tr style={{ height: '38px', backgroundColor: 'var(--bg-surface-subtle)' }}>
                  {/* Sticky Column: № */}
                  <th style={{ 
                    width: '45px', 
                    textAlign: 'center', 
                    position: 'sticky', 
                    top: 0, 
                    left: 0, 
                    zIndex: 30, 
                    backgroundColor: 'var(--bg-surface-subtle)',
                    borderRight: '1px solid var(--border-default)'
                  }}>
                    №
                  </th>

                  {/* Sticky Column: Konveyer */}
                  <th style={{ 
                    width: '150px', 
                    textAlign: 'left', 
                    paddingLeft: '14px', 
                    position: 'sticky', 
                    top: 0, 
                    left: '45px', 
                    zIndex: 30, 
                    backgroundColor: 'var(--bg-surface-subtle)',
                    borderRight: '2px solid var(--border-default)'
                  }}>
                    Konveyer
                  </th>

                  {/* Dynamic Model Header Columns */}
                  {displayedModels.map((m) => {
                    const cleanName = m.name.replace(/^(Модел-\s*|Модель-\s*|Model-\s*)+/i, '').trim();
                    const hasWork = (modelTotals[m.id]?.totalQty || 0) > 0;
                    return (
                      <th 
                        key={m.id} 
                        style={{ 
                          minWidth: '130px', 
                          textAlign: 'center', 
                          position: 'sticky', 
                          top: 0, 
                          zIndex: 20, 
                          backgroundColor: 'var(--bg-surface-subtle)',
                          padding: '6px 8px'
                        }}
                        title={`${m.name} (${modelTotals[m.id]?.totalQty || 0} dona)`}
                      >
                        <div style={{ fontSize: '12.5px', fontWeight: 700, color: hasWork ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                          {cleanName}
                        </div>
                        {hasWork && (
                          <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--primary)', marginTop: '2px' }}>
                            {formatMoney(modelTotals[m.id]?.totalQty || 0)} dona
                          </div>
                        )}
                      </th>
                    );
                  })}

                  {/* Total Work Column */}
                  <th style={{ 
                    width: '130px', 
                    textAlign: 'right', 
                    paddingRight: '14px', 
                    position: 'sticky', 
                    top: 0, 
                    right: '85px', 
                    zIndex: 30, 
                    backgroundColor: 'var(--primary-light)',
                    color: 'var(--primary)',
                    fontWeight: 800,
                    borderLeft: '2px solid var(--border-default)'
                  }}>
                    Jami Ish (dona)
                  </th>

                  {/* Total Pattas Column */}
                  <th style={{ 
                    width: '85px', 
                    textAlign: 'center', 
                    position: 'sticky', 
                    top: 0, 
                    right: 0, 
                    zIndex: 30, 
                    backgroundColor: 'var(--primary-light)',
                    color: 'var(--primary)',
                    fontWeight: 800
                  }}>
                    Jami Patta
                  </th>
                </tr>
              </thead>

              <tbody>
                {filteredKonveyerKeys.map((k, idx) => {
                  const row = matrixData[k];
                  const isExpanded = expandedKonveyer === k;

                  return (
                    <React.Fragment key={k}>
                      <tr 
                        style={{ 
                          height: '40px', 
                          backgroundColor: isExpanded ? 'var(--bg-surface-subtle)' : 'var(--bg-surface)',
                          cursor: 'pointer',
                          transition: 'background-color 0.1s'
                        }}
                        onClick={() => setExpandedKonveyer(isExpanded ? null : k)}
                        onMouseEnter={(e) => {
                          if (!isExpanded) e.currentTarget.style.backgroundColor = 'var(--bg-surface-subtle)';
                        }}
                        onMouseLeave={(e) => {
                          if (!isExpanded) e.currentTarget.style.backgroundColor = 'var(--bg-surface)';
                        }}
                      >
                        {/* Row Index */}
                        <td style={{ 
                          textAlign: 'center', 
                          color: 'var(--text-muted)', 
                          fontSize: '12px', 
                          fontWeight: 600,
                          position: 'sticky',
                          left: 0,
                          backgroundColor: isExpanded ? 'var(--bg-surface-subtle)' : 'var(--bg-surface)',
                          zIndex: 10,
                          borderRight: '1px solid var(--border-default)'
                        }}>
                          {idx + 1}
                        </td>

                        {/* Konveyer Name */}
                        <td style={{ 
                          paddingLeft: '14px', 
                          position: 'sticky',
                          left: '45px',
                          backgroundColor: isExpanded ? 'var(--bg-surface-subtle)' : 'var(--bg-surface)',
                          zIndex: 10,
                          borderRight: '2px solid var(--border-default)'
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            {isExpanded ? (
                              <ChevronDown size={15} color="#7c3aed" />
                            ) : (
                              <ChevronRight size={15} color="var(--text-muted)" />
                            )}
                            <span style={{
                              display: 'inline-block',
                              padding: '3px 10px',
                              borderRadius: '12px',
                              fontSize: '12px',
                              fontWeight: 800,
                              backgroundColor: k !== 'Noma\'lum' ? 'rgba(124, 58, 237, 0.12)' : 'var(--bg-surface-subtle)',
                              color: k !== 'Noma\'lum' ? '#7c3aed' : 'var(--text-muted)',
                              border: k !== 'Noma\'lum' ? '1px solid rgba(124, 58, 237, 0.3)' : '1px solid var(--border-subtle)'
                            }}>
                              {k !== 'Noma\'lum' ? `${k}-Konveyer` : 'Noma\'lum'}
                            </span>
                          </div>
                        </td>

                        {/* Quantity per Model */}
                        {displayedModels.map((m) => {
                          const breakdown = row?.modelBreakdown[m.id];
                          const qty = breakdown?.qty || 0;
                          const pattaCount = breakdown?.pattaCount || 0;

                          return (
                            <td 
                              key={m.id} 
                              style={{ 
                                textAlign: 'center', 
                                padding: '6px 8px'
                              }}
                            >
                              {qty > 0 ? (
                                <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center' }}>
                                  <span style={{ 
                                    fontSize: '13px', 
                                    fontWeight: 800, 
                                    color: 'var(--text-primary)'
                                  }}>
                                    {formatMoney(qty)} dona
                                  </span>
                                  <span style={{ fontSize: '10.5px', color: 'var(--text-muted)', fontWeight: 600 }}>
                                    ({pattaCount} ta patta)
                                  </span>
                                </div>
                              ) : (
                                <span style={{ color: 'var(--border-strong)', fontSize: '13px' }}>—</span>
                              )}
                            </td>
                          );
                        })}

                        {/* Row Total Ish Soni */}
                        <td style={{ 
                          textAlign: 'right', 
                          paddingRight: '14px', 
                          position: 'sticky',
                          right: '85px',
                          backgroundColor: isExpanded ? 'var(--bg-surface-subtle)' : 'var(--bg-surface)',
                          zIndex: 10,
                          fontWeight: 800, 
                          color: 'var(--primary)', 
                          fontSize: '13.5px',
                          borderLeft: '2px solid var(--border-default)'
                        }}>
                          {formatMoney(row?.totalQty || 0)} dona
                        </td>

                        {/* Row Total Pattas */}
                        <td style={{ 
                          textAlign: 'center', 
                          position: 'sticky',
                          right: 0,
                          backgroundColor: isExpanded ? 'var(--bg-surface-subtle)' : 'var(--bg-surface)',
                          zIndex: 10,
                          fontWeight: 700,
                          color: '#f59e0b',
                          fontSize: '12.5px'
                        }}>
                          {row?.totalPattas || 0} ta
                        </td>
                      </tr>

                      {/* Expanded Conveyor Details Accordion */}
                      {isExpanded && row && (
                        <tr>
                          <td 
                            colSpan={displayedModels.length + 4} 
                            style={{ 
                              padding: '12px 16px 16px 20px', 
                              backgroundColor: 'var(--bg-surface-subtle)',
                              borderBottom: '2px solid var(--border-default)'
                            }}
                          >
                            <div style={{ 
                              backgroundColor: 'var(--bg-surface)', 
                              borderRadius: '8px', 
                              padding: '12px 16px', 
                              border: '1px solid var(--border-subtle)',
                              boxShadow: 'var(--shadow-xs)'
                            }}>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                                <span style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>
                                  📋 {k !== 'Noma\'lum' ? `${k}-Konveyer` : 'Noma\'lum konveyer'} topshirgan pattalar tafsiloti:
                                </span>
                                <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 600 }}>
                                  Jami: {row.totalQty.toLocaleString()} dona ({row.totalPattas} ta patta)
                                </span>
                              </div>

                              <div style={{ overflowX: 'auto' }}>
                                <table className="excel-table" style={{ width: '100%', fontSize: '12px' }}>
                                  <thead>
                                    <tr style={{ height: '30px', backgroundColor: 'var(--bg-surface-subtle)' }}>
                                      <th style={{ width: '50px', textAlign: 'center' }}>№</th>
                                      <th style={{ width: '135px', textAlign: 'center' }}>Vaqt</th>
                                      <th style={{ textAlign: 'left', paddingLeft: '10px' }}>Model</th>
                                      <th style={{ width: '90px', textAlign: 'center' }}>Partiya</th>
                                      <th style={{ width: '90px', textAlign: 'center' }}>Patta №</th>
                                      <th style={{ width: '90px', textAlign: 'center' }}>Razmer</th>
                                      <th style={{ width: '90px', textAlign: 'center' }}>Rang</th>
                                      <th style={{ width: '110px', textAlign: 'right', paddingRight: '12px' }}>Ish Soni</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {row.tickets.map((t, tIdx) => {
                                      const m = modelMap.get(t.modelId);
                                      return (
                                        <tr key={t.id || tIdx} style={{ height: '30px' }}>
                                          <td style={{ textAlign: 'center', color: 'var(--text-muted)' }}>{tIdx + 1}</td>
                                          <td style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '11.5px', whiteSpace: 'nowrap' }}>{formatTicketDateTime(t)}</td>
                                          <td style={{ paddingLeft: '10px', fontWeight: 600 }}>{m?.name || t.modelId}</td>
                                          <td style={{ textAlign: 'center', fontWeight: 700 }}>{t.partyNumber}</td>
                                          <td style={{ textAlign: 'center', fontWeight: 700, color: '#fbbf24' }}>#{t.pattaNumber}</td>
                                          <td style={{ textAlign: 'center' }}>{t.size || '—'}</td>
                                          <td style={{ textAlign: 'center' }}>{t.color || '—'}</td>
                                          <td style={{ textAlign: 'right', paddingRight: '12px', fontWeight: 700, color: 'var(--primary)' }}>
                                            {formatMoney(t.qty)} dona
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}

                {/* Grand Total Row */}
                <tr style={{ 
                  height: '42px', 
                  backgroundColor: 'var(--primary-light)', 
                  fontWeight: 800,
                  position: 'sticky',
                  bottom: 0,
                  zIndex: 25,
                  boxShadow: '0 -2px 6px rgba(0,0,0,0.06)'
                }}>
                  <td style={{ 
                    textAlign: 'center', 
                    color: 'var(--primary)', 
                    fontSize: '13px',
                    position: 'sticky',
                    left: 0,
                    backgroundColor: 'var(--primary-light)',
                    zIndex: 35,
                    borderRight: '1px solid var(--border-default)'
                  }}>
                    ЖАМИ
                  </td>

                  <td style={{ 
                    paddingLeft: '14px', 
                    fontSize: '13px', 
                    color: 'var(--primary)',
                    position: 'sticky',
                    left: '45px',
                    backgroundColor: 'var(--primary-light)',
                    zIndex: 35,
                    borderRight: '2px solid var(--border-default)'
                  }}>
                    {filteredKonveyerKeys.length} ta konveyer
                  </td>

                  {/* Column Totals for Each Model */}
                  {displayedModels.map((m) => {
                    const totalQty = modelTotals[m.id]?.totalQty || 0;
                    return (
                      <td key={m.id} style={{ textAlign: 'center', padding: '6px 8px', color: 'var(--primary)', fontSize: '13px' }}>
                        {totalQty > 0 ? (
                          <span>{formatMoney(totalQty)} dona</span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)' }}>0</span>
                        )}
                      </td>
                    );
                  })}

                  {/* Grand Total Quantity */}
                  <td style={{ 
                    textAlign: 'right', 
                    paddingRight: '14px', 
                    fontSize: '14px', 
                    color: 'var(--primary)',
                    position: 'sticky',
                    right: '85px',
                    backgroundColor: 'var(--primary-light)',
                    zIndex: 35,
                    borderLeft: '2px solid var(--border-default)'
                  }}>
                    {formatMoney(grandTotals.totalQty)} dona
                  </td>

                  {/* Grand Total Pattas */}
                  <td style={{ 
                    textAlign: 'center', 
                    fontSize: '13px', 
                    color: '#f59e0b',
                    position: 'sticky',
                    right: 0,
                    backgroundColor: 'var(--primary-light)',
                    zIndex: 35
                  }}>
                    {grandTotals.totalPattas} ta
                  </td>
                </tr>
              </tbody>
            </table>
          )
        ) : (
          /* ========================================================= */
          /* FLAT TICKETS LOG VIEW: Individual tickets history         */
          /* ========================================================= */
          filteredTickets.length === 0 ? (
            <div style={{ 
              height: '100%', 
              display: 'flex', 
              flexDirection: 'column', 
              alignItems: 'center', 
              justifyContent: 'center',
              padding: '40px 20px',
              color: 'var(--text-muted)'
            }}>
              <Factory size={48} color="var(--border-strong)" style={{ marginBottom: '12px' }} />
              <h3 style={{ margin: '0 0 6px 0', fontSize: '16px', fontWeight: 700, color: 'var(--text-secondary)' }}>
                Hech qanday patta topilmadi
              </h3>
            </div>
          ) : (
            <table
              className="excel-table"
              style={{
                width: '100%',
                borderCollapse: 'separate',
                borderSpacing: 0
              }}
            >
              <thead>
                <tr style={{ height: '32px', backgroundColor: 'var(--bg-surface-subtle)' }}>
                  <th style={{ width: '45px', textAlign: 'center', position: 'sticky', top: 0, zIndex: 20, backgroundColor: 'var(--bg-surface-subtle)' }}>№</th>
                  <th style={{ width: '135px', textAlign: 'center', position: 'sticky', top: 0, zIndex: 20, backgroundColor: 'var(--bg-surface-subtle)' }}>Vaqt</th>
                  <th style={{ width: '130px', textAlign: 'center', position: 'sticky', top: 0, zIndex: 20, backgroundColor: 'var(--bg-surface-subtle)' }}>Konveyer</th>
                  <th style={{ width: '160px', paddingLeft: '14px', position: 'sticky', top: 0, zIndex: 20, backgroundColor: 'var(--bg-surface-subtle)' }}>Model</th>
                  <th style={{ width: '90px', textAlign: 'center', position: 'sticky', top: 0, zIndex: 20, backgroundColor: 'var(--bg-surface-subtle)' }}>Partiya</th>
                  <th style={{ width: '85px', textAlign: 'center', position: 'sticky', top: 0, zIndex: 20, backgroundColor: 'var(--bg-surface-subtle)' }}>Patta №</th>
                  <th style={{ width: '85px', textAlign: 'center', position: 'sticky', top: 0, zIndex: 20, backgroundColor: 'var(--bg-surface-subtle)' }}>Razmer</th>
                  <th style={{ width: '100px', textAlign: 'center', position: 'sticky', top: 0, zIndex: 20, backgroundColor: 'var(--bg-surface-subtle)' }}>Rang</th>
                  <th style={{ width: '110px', textAlign: 'right', paddingRight: '14px', position: 'sticky', top: 0, zIndex: 20, backgroundColor: 'var(--bg-surface-subtle)' }}>Ish Soni</th>
                  <th style={{ minWidth: '220px', paddingLeft: '14px', position: 'sticky', top: 0, zIndex: 20, backgroundColor: 'var(--bg-surface-subtle)' }}>Bajarilgan Operatsiyalar</th>
                  <th style={{ width: '130px', textAlign: 'right', paddingRight: '16px', position: 'sticky', top: 0, zIndex: 20, backgroundColor: 'var(--bg-surface-subtle)' }}>Jami Summa</th>
                  {!isArchiveMode && (
                    <th style={{ width: '95px', textAlign: 'center', position: 'sticky', top: 0, zIndex: 20, backgroundColor: 'var(--bg-surface-subtle)' }}>Amallar</th>
                  )}
                </tr>
              </thead>

              <tbody>
                {filteredTickets.map((t) => {
                  const model = modelMap.get(t.modelId);
                  const amount = calculateTicketAmount(t);

                  return (
                    <tr 
                      key={t.id} 
                      style={{ 
                        height: '34px', 
                        backgroundColor: 'var(--bg-surface)'
                      }}
                    >
                      <td style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px', fontWeight: 600 }}>
                        {t.globalSeq}
                      </td>
                      <td style={{ textAlign: 'center', fontSize: '11.5px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                          <Clock size={11} />
                          {formatTicketDateTime(t)}
                        </span>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <span style={{
                          display: 'inline-block',
                          padding: '2px 10px',
                          borderRadius: '12px',
                          fontSize: '11.5px',
                          fontWeight: 700,
                          backgroundColor: t.konveyer ? 'rgba(139, 92, 246, 0.15)' : 'var(--bg-surface-subtle)',
                          color: t.konveyer ? '#a78bfa' : 'var(--text-muted)',
                          border: t.konveyer ? '1px solid rgba(139, 92, 246, 0.35)' : '1px solid var(--border-subtle)'
                        }}>
                          {t.konveyer ? `${t.konveyer}-Konveyer` : 'Noma\'lum'}
                        </span>
                      </td>
                      <td style={{ paddingLeft: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>
                        {model?.name || t.modelId}
                      </td>
                      <td style={{ textAlign: 'center', fontWeight: 700, color: 'var(--text-primary)' }}>
                        {t.partyNumber}
                      </td>
                      <td style={{ textAlign: 'center', fontWeight: 800, color: '#fbbf24' }}>
                        #{t.pattaNumber}
                      </td>
                      <td style={{ textAlign: 'center', fontWeight: 600 }}>
                        {t.size ? (
                          <span style={{ background: 'var(--bg-surface-subtle)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)', padding: '2px 8px', borderRadius: '4px', fontSize: '11.5px', fontWeight: 700 }}>
                            {t.size}
                          </span>
                        ) : '—'}
                      </td>
                      <td style={{ textAlign: 'center', fontSize: '12px', color: 'var(--text-secondary)' }}>
                        {t.color || '—'}
                      </td>
                      <td style={{ textAlign: 'right', paddingRight: '14px', fontWeight: 800, color: 'var(--primary)', fontSize: '13px' }}>
                        {formatMoney(t.qty)}
                      </td>
                      <td style={{ paddingLeft: '14px', fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
                          {(t.entries || []).map((entry, eIdx) => {
                            const wName = workerMap.get(entry.workerId) || `#${entry.workerId}`;
                            return (
                              <span 
                                key={eIdx}
                                style={{ 
                                  background: 'var(--bg-surface-subtle)', 
                                  border: '1px solid var(--border-subtle)', 
                                  borderRadius: '4px', 
                                  padding: '2px 8px', 
                                  fontSize: '11px', 
                                  color: 'var(--text-primary)',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '5px'
                                }}
                              >
                                <strong style={{ color: '#818cf8', fontWeight: 700 }}>{entry.opName}:</strong>
                                <span style={{
                                  backgroundColor: 'rgba(59, 130, 246, 0.12)',
                                  color: '#2563eb',
                                  fontWeight: 800,
                                  padding: '1px 5px',
                                  borderRadius: '3px',
                                  fontSize: '10.5px'
                                }}>
                                  #{entry.workerId}
                                </span>
                                <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{wName}</span>
                              </span>
                            );
                          })}
                        </div>
                      </td>
                      <td style={{ textAlign: 'right', paddingRight: '16px', fontWeight: 800, color: 'var(--text-primary)', fontSize: '13px' }}>
                        {formatMoney(amount)}
                      </td>
                      {!isArchiveMode && (
                        <td style={{ textAlign: 'center' }}>
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', justifyContent: 'center' }}>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                openModal({ type: 'edit_ticket', data: t });
                              }}
                              className="soft-btn"
                              style={{ 
                                padding: '4px 8px', 
                                borderRadius: '6px',
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                cursor: 'pointer',
                                border: '1px solid rgba(59, 130, 246, 0.3)',
                                backgroundColor: 'rgba(59, 130, 246, 0.08)',
                                color: '#3b82f6',
                                transition: 'all 0.15s ease'
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.backgroundColor = 'rgba(59, 130, 246, 0.18)';
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.backgroundColor = 'rgba(59, 130, 246, 0.08)';
                              }}
                              title="Pattani tahrirlash (ishchi ID sini almashtirish)"
                            >
                              <Edit2 size={13} />
                            </button>

                            <button
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
                              className="soft-btn soft-btn-danger"
                              style={{ 
                                padding: '4px 8px', 
                                borderRadius: '6px',
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                cursor: 'pointer',
                                border: '1px solid rgba(239, 68, 68, 0.25)',
                                backgroundColor: 'rgba(239, 68, 68, 0.08)',
                                color: '#ef4444',
                                transition: 'all 0.15s ease'
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.18)';
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.08)';
                              }}
                              title="Pattani o'chirish va hisobdan qaytarish"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        )}
      </div>
    </div>
  );
};
