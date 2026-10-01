import React, { useState } from 'react';
import { useWorkbookStore } from '../../../store/workbookStore';
import { X, AlertTriangle, Trash2 } from 'lucide-react';

export const DeleteOperationModal: React.FC = () => {
  const modalType = useWorkbookStore((s) => s.modalState.type);
  const targetModelId = useWorkbookStore((s) => s.modalState.modelId);
  const targetOpName = useWorkbookStore((s) => s.modalState.opName);
  const closeModal = useWorkbookStore((s) => s.closeModal);
  const syncDeleteOperation = useWorkbookStore((s) => s.syncDeleteOperation);
  const models = useWorkbookStore((s) => s.models);

  const [modelId, setModelId] = useState(targetModelId || 'Basiman');
  const currentModel = models.find((m) => m.id === modelId) || models[0];
  const [selectedOp, setSelectedOp] = useState(targetOpName || currentModel?.operations[0]?.name || '');

  React.useEffect(() => {
    if (modalType === 'delete_operation') {
      const activeMid = targetModelId || 'Basiman';
      setModelId(activeMid);
      const m = models.find((mod) => mod.id === activeMid) || models[0];
      setSelectedOp(targetOpName || m?.operations[0]?.name || '');
    }
  }, [modalType, targetModelId, targetOpName, models]);

  if (modalType !== 'delete_operation') return null;

  const handleDelete = () => {
    if (!selectedOp) return;
    syncDeleteOperation(modelId, selectedOp);
    closeModal();
  };

  return (
    <div className="modal-overlay" onClick={closeModal}>
      <div className="modal-card" style={{ maxWidth: '480px' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#dc2626' }}>
            <AlertTriangle size={18} />
            <span style={{ fontWeight: 800 }}>Operatsiyani O'chirish</span>
          </div>
          <button
            onClick={closeModal}
            className="soft-btn soft-btn-secondary"
            style={{ width: '32px', height: '32px', padding: 0, borderRadius: 'var(--radius-full)' }}
          >
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div>
            <label style={{ display: 'block', marginBottom: '6px', fontWeight: 700, fontSize: '12px', color: 'var(--text-secondary)' }}>
              Model:
            </label>
            <select
              value={modelId}
              onChange={(e) => {
                setModelId(e.target.value);
                const m = models.find((mod) => mod.id === e.target.value);
                if (m && m.operations.length > 0) {
                  setSelectedOp(m.operations[0].name);
                }
              }}
              className="soft-input"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.title})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label style={{ display: 'block', marginBottom: '6px', fontWeight: 700, fontSize: '12px', color: 'var(--text-secondary)' }}>
              O'chiriladigan operatsiyani tanlang:
            </label>
            <select
              value={selectedOp}
              onChange={(e) => setSelectedOp(e.target.value)}
              className="soft-input"
            >
              {currentModel?.operations.map((op) => (
                <option key={op.id} value={op.name}>
                  {op.name} ({op.rate} so'm)
                </option>
              ))}
            </select>
          </div>

          <div style={{
            fontSize: '12.5px',
            color: '#991b1b',
            background: '#fef2f2',
            border: '1px solid #fee2e2',
            padding: '12px 16px',
            borderRadius: 'var(--radius-md)',
            lineHeight: '1.4'
          }}>
            <strong>Ogohlantirish:</strong> Ushbu operatsiya patta va hisob-kitob varag'idan o'chiriladi va barcha ishchilarning formulalari avtomatik qayta hisoblanadi.
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
            type="button"
            onClick={handleDelete}
            className="soft-btn soft-btn-danger"
          >
            <Trash2 size={13} />
            <span>O'chirish</span>
          </button>
        </div>
      </div>
    </div>
  );
};
