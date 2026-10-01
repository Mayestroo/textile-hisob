import React, { useState } from 'react';
import { useWorkbookStore } from '../../../store/workbookStore';
import { X, Users, UserPlus, Trash2, Search, Edit3, Check, Award, Download } from 'lucide-react';
import { formatMoney } from '../../../engine/formulaEngine';

export const WorkerManagerModal: React.FC = () => {
  const modalType = useWorkbookStore((s) => s.modalState.type);
  const closeModal = useWorkbookStore((s) => s.closeModal);
  const workers = useWorkbookStore((s) => s.workers);
  const addWorker = useWorkbookStore((s) => s.addWorker);
  const updateWorker = useWorkbookStore((s) => s.updateWorker);
  const deleteWorker = useWorkbookStore((s) => s.deleteWorker);
  const confirmAction = useWorkbookStore((s) => s.confirmAction);
  const addNotification = useWorkbookStore((s) => s.addNotification);
  const exportWorkersExcel = useWorkbookStore((s) => s.exportWorkersExcel);
  const [newWorkerName, setNewWorkerName] = useState('');
  const [newWorkerStaj, setNewWorkerStaj] = useState('');
  const [search, setSearch] = useState('');
  const [editingWorkerId, setEditingWorkerId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');
  const [editingStaj, setEditingStaj] = useState('');

  if (modalType !== 'worker_manager') return null;

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newWorkerName.trim()) return;
    const clean = newWorkerStaj.replace(/\D/g, '');
    const stajNum = clean ? parseInt(clean, 10) : 0;
    const added = await addWorker(newWorkerName.trim(), { staj: stajNum });
    if (added) {
      setNewWorkerName('');
      setNewWorkerStaj('');
    }
  };

  const startEditing = (workerId: number, currentName: string, currentStaj: number = 0) => {
    setEditingWorkerId(workerId);
    setEditingName(currentName);
    setEditingStaj(currentStaj > 0 ? String(currentStaj) : '');
  };

  const saveEditing = async (workerId: number) => {
    if (editingName.trim()) {
      const clean = editingStaj.replace(/\D/g, '');
      const stajNum = clean ? parseInt(clean, 10) : 0;
      const updated = await updateWorker(workerId, {
        name: editingName.trim(),
        staj: stajNum
      }, { immediate: true });
      if (updated === false) return;
      addNotification('success', 'Yangilandi', `Ishchi #${workerId} ma'lumotlari (F.I.O va Staj) yangilandi.`);
    }
    setEditingWorkerId(null);
    setEditingName('');
    setEditingStaj('');
  };

  const handleDelete = async (workerId: number, name: string) => {
    const ok = await confirmAction({
      title: "Ishchini o'chirish",
      message: `Haqiqatan ham "${name}" (ID: ${workerId}) ishchisini ro'yxatdan o'chirmoqchimisiz?`,
      confirmText: "Ha, o'chirilsin",
      isDanger: true
    });
    if (ok) {
      await deleteWorker(workerId);
    }
  };

  const filtered = workers.filter((w) =>
    w.name.toLowerCase().includes(search.toLowerCase()) || String(w.id).includes(search)
  );

  const stajWorkersCount = workers.filter((w) => (w.staj || 0) > 0).length;

  return (
    <div className="modal-overlay" onClick={closeModal}>
      <div className="modal-card" style={{ maxWidth: '720px', width: '95%' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--primary)' }}>
            <Users size={20} />
            <span style={{ fontSize: '16px', fontWeight: 800 }}>
              Markaziy Ishchilar & Staj Ro'yxati ({workers.length} ta)
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              type="button"
              onClick={exportWorkersExcel}
              className="soft-btn soft-btn-primary"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 14px',
                fontSize: '12.5px',
                fontWeight: 600,
                borderRadius: 'var(--radius-full)'
              }}
              title="Ishchilar ro'yxatini Excel (.xlsx) faylida yuklab olish"
            >
              <Download size={14} />
              <span>Excel yuklab olish</span>
            </button>
            <button
              onClick={closeModal}
              className="soft-btn soft-btn-secondary"
              style={{ width: '32px', height: '32px', padding: 0, borderRadius: 'var(--radius-full)' }}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="modal-body">
          {/* Info Banner */}
          <div style={{
            fontSize: '12.5px',
            color: 'var(--text-secondary)',
            background: 'var(--primary-light)',
            padding: '12px 16px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid rgba(16, 185, 129, 0.2)'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700, color: 'var(--primary)', marginBottom: '4px' }}>
              <Award size={15} />
              <span>Doimiy Staj boshqaruvi:</span>
            </div>
            <div>Ishchilarning <strong>Staj</strong> summasi shu yerda belgilanadi va har oy yangi oylik ochilganda ham avtomatik saqlanib qoladi. <em>Umumiy</em> jadvalidagi Staj ustunida avtomatik hisoblanadi.</div>
          </div>

          {/* Add Worker Form */}
          <form onSubmit={handleAdd} style={{ display: 'flex', gap: '10px', marginTop: '2px' }}>
            <input
              type="text"
              placeholder="Yangi ishchi F.I.O..."
              value={newWorkerName}
              onChange={(e) => setNewWorkerName(e.target.value)}
              className="soft-input"
              style={{ flex: 2 }}
            />
            <input
              type="text"
              inputMode="numeric"
              placeholder="Staj (masalan 140 000)..."
              value={newWorkerStaj}
              onChange={(e) => {
                const clean = e.target.value.replace(/\D/g, '');
                setNewWorkerStaj(clean ? formatMoney(Number(clean)) : '');
              }}
              className="soft-input"
              style={{ flex: 1 }}
            />
            <button
              type="submit"
              className="soft-btn soft-btn-primary"
              style={{ padding: '0 18px', whiteSpace: 'nowrap' }}
            >
              <UserPlus size={15} />
              <span>Qo'shish</span>
            </button>
          </form>

          {/* Search */}
          <div style={{ position: 'relative' }}>
            <Search size={15} color="var(--text-muted)" style={{ position: 'absolute', left: '12px', top: '12px' }} />
            <input
              type="text"
              placeholder="Qidirish (ID yoki ism bo'yicha)..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="soft-input"
              style={{ paddingLeft: '34px' }}
            />
          </div>

          {/* Worker List Table */}
          <div style={{
            maxHeight: '380px',
            overflowY: 'auto',
            overflowX: 'hidden',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-lg)'
          }}>
            <table className="excel-table" style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
              <thead>
                <tr style={{ height: '36px' }}>
                  <th className="col-header" style={{ width: '60px', position: 'sticky', top: 0, zIndex: 10, background: 'var(--bg-surface-subtle)' }}>№ ID</th>
                  <th className="col-header" style={{ textAlign: 'left', paddingLeft: '14px', position: 'sticky', top: 0, zIndex: 10, background: 'var(--bg-surface-subtle)' }}>Ishchi F.I.O</th>
                  <th className="col-header" style={{ textAlign: 'right', width: '150px', paddingRight: '14px', position: 'sticky', top: 0, zIndex: 10, background: 'var(--bg-surface-subtle)' }}>Doimiy Staj</th>
                  <th className="col-header" style={{ textAlign: 'center', width: '120px', position: 'sticky', top: 0, zIndex: 10, background: 'var(--bg-surface-subtle)' }}>Amallar</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={4} style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)' }}>
                      Ishchi topilmadi
                    </td>
                  </tr>
                ) : (
                  filtered.map((w) => {
                    const isEditing = editingWorkerId === w.id;
                    const hasStaj = (w.staj || 0) > 0;

                    return (
                      <tr
                        key={w.id}
                        style={{
                          height: '36px',
                          backgroundColor: isEditing ? 'rgba(234, 179, 8, 0.15)' : hasStaj ? 'rgba(147, 51, 234, 0.12)' : 'var(--bg-surface)'
                        }}
                      >
                        <td style={{ textAlign: 'center', fontWeight: 700, color: 'var(--primary)' }}>
                          <span style={{
                            background: 'var(--bg-surface-subtle)',
                            padding: '2px 8px',
                            borderRadius: 'var(--radius-full)',
                            fontSize: '11.5px'
                          }}>
                            {w.id}
                          </span>
                        </td>

                        <td style={{ padding: '4px 14px' }}>
                          {isEditing ? (
                            <input
                              type="text"
                              value={editingName}
                              onChange={(e) => setEditingName(e.target.value)}
                              autoFocus
                              className="soft-input"
                              style={{ height: '28px', fontWeight: 600 }}
                            />
                          ) : (
                            <span 
                              onClick={() => startEditing(w.id, w.name, w.staj)}
                              style={{ cursor: 'pointer', fontWeight: 600, color: 'var(--text-primary)' }}
                              title="Tahrirlash uchun bosing"
                            >
                              {w.name}
                            </span>
                          )}
                        </td>

                        {/* Staj Column */}
                        <td style={{ padding: '4px 14px', textAlign: 'right' }}>
                          {isEditing ? (
                            <input
                              type="text"
                              inputMode="numeric"
                              placeholder="Staj..."
                              value={editingStaj}
                              onChange={(e) => {
                                const clean = e.target.value.replace(/\D/g, '');
                                setNewWorkerStaj(clean ? formatMoney(Number(clean)) : '');
                                setEditingStaj(clean ? formatMoney(Number(clean)) : '');
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') saveEditing(w.id);
                                if (e.key === 'Escape') setEditingWorkerId(null);
                              }}
                              className="soft-input"
                              style={{ height: '28px', textAlign: 'right', fontWeight: 700, color: '#7c3aed' }}
                            />
                          ) : (
                            <span
                              onClick={() => startEditing(w.id, w.name, w.staj)}
                              style={{
                                cursor: 'pointer',
                                fontWeight: hasStaj ? 700 : 400,
                                color: hasStaj ? '#7c3aed' : 'var(--text-muted)'
                              }}
                              title="Stajni o'zgartirish uchun bosing"
                            >
                              {hasStaj ? `${formatMoney(w.staj)} so'm` : '—'}
                            </span>
                          )}
                        </td>

                        <td style={{ textAlign: 'center' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                            {isEditing ? (
                              <>
                                <button
                                  onClick={() => saveEditing(w.id)}
                                  className="soft-btn soft-btn-primary"
                                  style={{ padding: '3px 8px', fontSize: '11px', borderRadius: 'var(--radius-full)' }}
                                  title="Saqlash"
                                >
                                  <Check size={12} />
                                  <span>Saqlash</span>
                                </button>
                                <button
                                  onClick={() => setEditingWorkerId(null)}
                                  className="soft-btn soft-btn-secondary"
                                  style={{ padding: '3px 8px', fontSize: '11px', borderRadius: 'var(--radius-full)' }}
                                >
                                  Bekor
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  onClick={() => startEditing(w.id, w.name, w.staj)}
                                  className="soft-btn soft-btn-secondary"
                                  style={{ padding: '3px 8px', fontSize: '11px', borderRadius: 'var(--radius-full)', color: '#4f46e5' }}
                                  title="Tahrirlash"
                                >
                                  <Edit3 size={12} />
                                  <span>Tahrir</span>
                                </button>

                                <button
                                  onClick={() => handleDelete(w.id, w.name)}
                                  className="soft-btn soft-btn-danger"
                                  style={{ padding: '4px', borderRadius: 'var(--radius-full)' }}
                                  title="O'chirish"
                                >
                                  <Trash2 size={13} />
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
            Jami: <strong>{workers.length} nafar</strong> (shundan <strong>{stajWorkersCount} nafari</strong> stajli)
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              type="button"
              onClick={exportWorkersExcel}
              className="soft-btn soft-btn-secondary"
              style={{
                borderRadius: 'var(--radius-full)',
                padding: '6px 14px',
                color: '#10b981',
                borderColor: 'rgba(16, 185, 129, 0.4)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '12.5px'
              }}
              title="Ishchilar ro'yxatini Excel (.xlsx) faylida yuklab olish"
            >
              <Download size={14} />
              <span>Excel (.xlsx)</span>
            </button>
            <button
              onClick={closeModal}
              className="soft-btn soft-btn-primary"
              style={{ borderRadius: 'var(--radius-full)', padding: '6px 20px' }}
            >
              Yopish
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
