import React, { useState, useEffect } from 'react';
import { useWorkbookStore } from '../../../store/workbookStore';
import { X, PlusCircle, ArrowRight } from 'lucide-react';

export const NewOperationModal: React.FC = () => {
  const modalType = useWorkbookStore((s) => s.modalState.type);
  const targetModelId = useWorkbookStore((s) => s.modalState.modelId);
  const closeModal = useWorkbookStore((s) => s.closeModal);
  const syncNewOperation = useWorkbookStore((s) => s.syncNewOperation);
  const models = useWorkbookStore((s) => s.models);
  const activeSheet = useWorkbookStore((s) => s.activeSheet);
  
  const initialModelId = targetModelId || (activeSheet.endsWith('-hisob') ? activeSheet.replace('-hisob', '') : activeSheet !== 'Umumiy' ? activeSheet : 'Basiman');
  const [modelId, setModelId] = useState(initialModelId);
  const [opName, setOpName] = useState('');
  const [rate, setRate] = useState('');

  useEffect(() => {
    if (modalType === 'new_operation') {
      const targetId = targetModelId || (activeSheet.endsWith('-hisob') ? activeSheet.replace('-hisob', '') : activeSheet !== 'Umumiy' ? activeSheet : 'Basiman');
      setModelId(targetId);
      setOpName('');
      setRate('');
    }
  }, [modalType, targetModelId, activeSheet]);

  if (modalType !== 'new_operation') return null;

  const currentModel = models.find((m) => m.id === modelId) || models[0];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = opName.trim();
    if (!cleanName) return;
    if (currentModel.operations.some((o) => o.name.toLowerCase() === cleanName.toLowerCase())) {
      alert(`"${cleanName}" operatsiyasi allaqachon mavjud!`);
      return;
    }
    const rateNum = Number(rate);
    syncNewOperation(modelId, cleanName, isNaN(rateNum) ? 0 : rateNum);
    closeModal();
  };

  return (
    <div className="modal-overlay" onClick={closeModal}>
      <div className="modal-card" style={{ maxWidth: '480px' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--primary)' }}>
            <PlusCircle size={18} />
            <span style={{ fontWeight: 800 }}>Yangi Operatsiya Qo'shish</span>
          </div>
          <button
            onClick={closeModal}
            className="soft-btn soft-btn-secondary"
            style={{ width: '32px', height: '32px', padding: 0, borderRadius: 'var(--radius-full)' }}
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {/* Target Model Banner */}
            <div style={{
              background: 'var(--primary-light)',
              border: '1px solid rgba(16, 185, 129, 0.25)',
              padding: '12px 14px',
              borderRadius: 'var(--radius-md)',
              fontSize: '12.5px'
            }}>
              <div style={{ fontWeight: 700, color: 'var(--primary)', marginBottom: '6px' }}>
                Operatsiya qo'shiladigan varaqlar:
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600, color: 'var(--text-primary)' }}>
                <span style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', padding: '3px 10px', borderRadius: 'var(--radius-full)', fontSize: '11.5px' }}>
                  📋 Patta: {currentModel.name}
                </span>
                <ArrowRight size={14} color="var(--primary)" />
                <span style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', padding: '3px 10px', borderRadius: 'var(--radius-full)', fontSize: '11.5px' }}>
                  📊 Hisob: {currentModel.hisobSheetName}
                </span>
              </div>
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: '6px', fontWeight: 700, fontSize: '12px', color: 'var(--text-secondary)' }}>
                Modelni tanlang:
              </label>
              <select
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                className="soft-input"
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.hisobSheetName})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: '6px', fontWeight: 700, fontSize: '12px', color: 'var(--text-secondary)' }}>
                Operatsiya nomi:
              </label>
              <input
                type="text"
                value={opName}
                onChange={(e) => setOpName(e.target.value)}
                placeholder="Masalan: Рибана кесиш, Елка қўшиш..."
                autoFocus
                required
                className="soft-input"
                style={{ fontWeight: 600 }}
              />
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: '6px', fontWeight: 700, fontSize: '12px', color: 'var(--text-secondary)' }}>
                Dona narxi (so'm):
              </label>
              <input
                type="number"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                placeholder="Masalan: 40, 150, 200..."
                required
                className="soft-input"
                style={{ fontWeight: 700 }}
              />
            </div>
          </div>

          <div className="modal-footer">
            <button
              type="button"
              onClick={closeModal}
              className="soft-btn soft-btn-secondary"
            >
              Bekor qilish
            </button>
            <button
              type="submit"
              className="soft-btn soft-btn-primary"
            >
              <span>Qo'shish (Sync)</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
