import React, { useMemo, useState } from 'react';
import { ArrowDownToLine, Search, X } from 'lucide-react';
import { useWorkbookStore } from '../../store/workbookStore';
import { useAuthStore } from '../../store/authStore';
import { ROLE_LABELS_UZ } from '../../types/sync';
import { formatDateIso, formatTicketDateTime } from '../../utils/formatters';

export type ActionFilterType = 'all' | 'print' | 'edit' | 'delete';

export interface AuditActionItem {
  id: string;
  vaqt: string;
  formattedDate: string;
  rawTimestamp: number;
  foydalanuvchi: string;
  amal: string;
  actionType: 'print' | 'edit' | 'delete';
  obyekt: string;
}

export const AmallarJurnaliView: React.FC = () => {
  const printedPartyHistory = useWorkbookStore((s) => s.printedPartyHistory) || [];
  const models = useWorkbookStore((s) => s.models) || [];
  const authUser = useAuthStore((s) => s.user);
  const authRole = useAuthStore((s) => s.role);

  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<ActionFilterType>('all');

  const defaultUserName = authUser?.displayName || (authRole ? ROLE_LABELS_UZ[authRole] : null) || 'Administrator';

  // Build model name lookup map
  const modelMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of models) {
      map.set(m.id, m.name);
    }
    return map;
  }, [models]);

  // Read recorded actions from localStorage (e.g., ticket edits, deletions, custom actions)
  const storedActions = useMemo(() => {
    try {
      const raw = localStorage.getItem('hisob:audit-log');
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      return [];
    } catch {
      return [];
    }
  }, []);

  // Aggregate all actions
  const allActions = useMemo(() => {
    const list: AuditActionItem[] = [];

    // 1. Printed parties (Chop etish amallari)
    for (const p of printedPartyHistory) {
      const mName = p.modelName || modelMap.get(p.modelId) || p.modelId || 'Model';
      const partyNum = p.partyNumber || '';
      const printedAt = p.printedAt || '';
      const formattedDate = formatTicketDateTime(printedAt);

      // Parse timestamp for sorting
      let timestamp = 0;
      if (printedAt) {
        const d = new Date(printedAt);
        timestamp = isNaN(d.getTime()) ? 0 : d.getTime();
      }

      list.push({
        id: `party_print_${p.id || partyNum}_${printedAt}`,
        vaqt: printedAt,
        formattedDate: formattedDate !== '—' ? formattedDate : '—',
        rawTimestamp: timestamp,
        foydalanuvchi: defaultUserName,
        amal: 'Partiya chop etildi',
        actionType: 'print',
        obyekt: `${mName} · Partiya ${partyNum}`
      });
    }

    // 2. Stored custom/audit actions
    for (const a of storedActions) {
      let timestamp = 0;
      if (a.vaqt) {
        const d = new Date(a.vaqt);
        timestamp = isNaN(d.getTime()) ? 0 : d.getTime();
      }
      list.push({
        id: a.id || `stored_${Math.random()}`,
        vaqt: a.vaqt || '',
        formattedDate: a.vaqt ? formatTicketDateTime(a.vaqt) : '—',
        rawTimestamp: timestamp,
        foydalanuvchi: a.foydalanuvchi || defaultUserName,
        amal: a.amal || 'Amal bajarildi',
        actionType: a.actionType || 'edit',
        obyekt: a.obyekt || '—'
      });
    }

    // Sort newest first
    return list.sort((a, b) => b.rawTimestamp - a.rawTimestamp);
  }, [printedPartyHistory, modelMap, defaultUserName, storedActions]);

  // Filter actions by category and search
  const filteredActions = useMemo(() => {
    return allActions.filter((item) => {
      // Filter category
      if (activeFilter !== 'all' && item.actionType !== activeFilter) {
        return false;
      }

      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchesUser = item.foydalanuvchi.toLowerCase().includes(q);
        const matchesObject = item.obyekt.toLowerCase().includes(q);
        const matchesAction = item.amal.toLowerCase().includes(q);
        const matchesDate = item.formattedDate.toLowerCase().includes(q);
        return matchesUser || matchesObject || matchesAction || matchesDate;
      }

      return true;
    });
  }, [allActions, activeFilter, searchQuery]);

  // Export to Excel CSV
  const handleExportExcel = () => {
    const headers = ['Vaqt', 'Foydalanuvchi', 'Amal', 'Obyekt'];
    const rows = filteredActions.map((item) => [
      `"${item.formattedDate.replace(/"/g, '""')}"`,
      `"${item.foydalanuvchi.replace(/"/g, '""')}"`,
      `"${item.amal.replace(/"/g, '""')}"`,
      `"${item.obyekt.replace(/"/g, '""')}"`
    ]);

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map((r) => r.join(',')), ''].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Amallar_jurnali_${formatDateIso()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="amallar-view-container">
      {/* 1. Header */}
      <div className="amallar-header">
        <div>
          <h1 className="amallar-title">Amallar jurnali</h1>
          <p className="amallar-subtitle">Kim, qachon nimani qilgan</p>
        </div>

        {/* Excel export button */}
        <button type="button" className="amallar-export-btn" onClick={handleExportExcel}>
          <ArrowDownToLine size={15} strokeWidth={2.2} />
          <span>Excel</span>
        </button>
      </div>

      {/* 2. Toolbar */}
      <div className="amallar-toolbar">
        {/* Search input */}
        <div className="amallar-search-box">
          <Search size={16} className="amallar-search-icon" />
          <input
            type="text"
            className="amallar-search-input"
            placeholder="Foydalanuvchi yoki obyekt"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              type="button"
              className="amallar-search-clear"
              onClick={() => setSearchQuery('')}
              title="Tozalash"
            >
              <X size={15} />
            </button>
          )}
        </div>

        {/* Filter Pills */}
        <div className="amallar-filter-pills">
          <button
            type="button"
            className={`amallar-pill-btn ${activeFilter === 'all' ? 'active' : ''}`}
            onClick={() => setActiveFilter('all')}
          >
            Hammasi
          </button>
          <button
            type="button"
            className={`amallar-pill-btn ${activeFilter === 'print' ? 'active' : ''}`}
            onClick={() => setActiveFilter('print')}
          >
            Chop etish
          </button>
          <button
            type="button"
            className={`amallar-pill-btn ${activeFilter === 'edit' ? 'active' : ''}`}
            onClick={() => setActiveFilter('edit')}
          >
            Tahrirlash
          </button>
          <button
            type="button"
            className={`amallar-pill-btn ${activeFilter === 'delete' ? 'active' : ''}`}
            onClick={() => setActiveFilter('delete')}
          >
            O'chirish
          </button>
        </div>
      </div>

      {/* 3. Table Card */}
      <div className="amallar-table-card">
        <div className="amallar-table-scroll">
          <table className="amallar-table">
            <colgroup>
              <col style={{ width: '23%' }} />
              <col style={{ width: '21%' }} />
              <col style={{ width: '21%' }} />
              <col style={{ width: '35%' }} />
            </colgroup>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', paddingLeft: '20px' }}>VAQT</th>
                <th style={{ textAlign: 'left', paddingLeft: '16px' }}>FOYDALANUVCHI</th>
                <th style={{ textAlign: 'left', paddingLeft: '16px' }}>AMAL</th>
                <th style={{ textAlign: 'left', paddingLeft: '16px', paddingRight: '20px' }}>OBYEKT</th>
              </tr>
            </thead>
            <tbody>
              {filteredActions.length > 0 ? (
                filteredActions.map((item) => (
                  <tr key={item.id} className="amallar-row">
                    <td style={{ textAlign: 'left', paddingLeft: '20px', color: '#64748b', fontSize: '15px', fontWeight: 400 }}>
                      {item.formattedDate}
                    </td>
                    <td style={{ textAlign: 'left', paddingLeft: '16px', color: '#0f172a', fontSize: '15px', fontWeight: 600 }}>
                      {item.foydalanuvchi}
                    </td>
                    <td style={{ textAlign: 'left', paddingLeft: '16px' }}>
                      <span className={`amallar-badge amallar-badge-${item.actionType}`}>
                        {item.amal}
                      </span>
                    </td>
                    <td style={{ textAlign: 'left', paddingLeft: '16px', paddingRight: '20px', color: '#334155', fontSize: '15px', fontWeight: 400 }}>
                      {item.obyekt}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4} className="amallar-empty-state">
                    Hozircha amallar jurnali bo'sh yoki qidiruv bo'yicha ma'lumot topilmadi.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 4. Footer Note */}
      <div className="amallar-footer-note">
        Vaqtlar partiyalar chop etilgan sanadan olingan, foydalanuvchi nomi taxminiy.
      </div>
    </div>
  );
};
