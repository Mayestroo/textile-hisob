import React, { useState } from 'react';
import { useWorkbookStore } from '../../../store/workbookStore';
import { X, Plus, Layers, Copy, FileText } from 'lucide-react';

export const NewModelModal: React.FC = () => {
  const modalType = useWorkbookStore((s) => s.modalState.type);
  const closeModal = useWorkbookStore((s) => s.closeModal);
  const addModel = useWorkbookStore((s) => s.addModel);
  const models = useWorkbookStore((s) => s.models);
  const [modelName, setModelName] = useState('');
  const [templateType, setTemplateType] = useState<'standard' | 'clone' | 'blank'>('standard');
  const [cloneFromId, setCloneFromId] = useState(models[0]?.id || 'Basiman');
  const [party, setParty] = useState('Мато Партия- 6632');
  const [color, setColor] = useState('Кора');
  const [size, setSize] = useState('XL');

  if (modalType !== 'new_model') return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!modelName.trim()) return;

    addModel(modelName.trim(), {
      templateType,
      cloneFromId,
      party,
      color,
      size
    });

    setModelName('');
    closeModal();
  };

  return (
    <div className="modal-overlay" onClick={closeModal}>
      <div className="modal-card" style={{ maxWidth: '540px', width: '95%' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--primary)' }}>
            <Layers size={20} />
            <span style={{ fontSize: '16px', fontWeight: 800 }}>Yangi Model & Varaqlar Qo'shish</span>
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
            {/* Info Banner */}
            <div style={{
              background: 'var(--primary-light)',
              border: '1px solid rgba(16, 185, 129, 0.25)',
              padding: '12px 16px',
              borderRadius: 'var(--radius-md)',
              fontSize: '12.5px',
              color: 'var(--text-secondary)'
            }}>
              <div style={{ fontWeight: 700, color: 'var(--primary)', marginBottom: '4px' }}>
                Avtomatik 2 ta yangi varaq ochiladi:
              </div>
              <div>
                1. <strong>[Model]</strong> — Patta (Kiritish varag'i)<br />
                2. <strong>[Model]-hisob</strong> — 199 ta ishchilik hisob-kitob varag'i va <strong>Umumiy</strong> hisobotga avtomatik bog'lanadi.
              </div>
            </div>

            {/* Model Name */}
            <div>
              <label style={{ display: 'block', marginBottom: '6px', fontWeight: 700, fontSize: '12px', color: 'var(--text-secondary)' }}>
                Yangi Model Nomi:
              </label>
              <input
                type="text"
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                placeholder="Masalan: Hudi-oversize, Polo-yangi, Barisha-2026..."
                autoFocus
                required
                className="soft-input"
                style={{ fontWeight: 700 }}
              />
            </div>

            {/* Template Selection */}
            <div>
              <label style={{ display: 'block', marginBottom: '6px', fontWeight: 700, fontSize: '12px', color: 'var(--text-secondary)' }}>
                Tayyor Shablonni Tanlang:
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div
                  onClick={() => setTemplateType('standard')}
                  style={{
                    border: templateType === 'standard' ? '2px solid var(--primary)' : '1px solid var(--border-subtle)',
                    background: templateType === 'standard' ? 'var(--primary-light)' : 'var(--bg-surface)',
                    padding: '12px',
                    borderRadius: 'var(--radius-md)',
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    transition: 'all 0.15s'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700, fontSize: '12.5px', color: templateType === 'standard' ? 'var(--primary)' : 'var(--text-primary)' }}>
                    <FileText size={15} />
                    <span>Standart Shablon</span>
                  </div>
                  <span style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
                    Barcha 19 ta operatsiyalar bilan tayyor
                  </span>
                </div>

                <div
                  onClick={() => setTemplateType('clone')}
                  style={{
                    border: templateType === 'clone' ? '2px solid #6366f1' : '1px solid var(--border-subtle)',
                    background: templateType === 'clone' ? '#eef2ff' : 'var(--bg-surface)',
                    padding: '12px',
                    borderRadius: 'var(--radius-md)',
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    transition: 'all 0.15s'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700, fontSize: '12.5px', color: templateType === 'clone' ? '#4f46e5' : 'var(--text-primary)' }}>
                    <Copy size={15} />
                    <span>Nusxa Olish</span>
                  </div>
                  <span style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
                    Mavjud modeldan operatsiyalarni ko'chirish
                  </span>
                </div>
              </div>
            </div>

            {templateType === 'clone' && (
              <div>
                <label style={{ display: 'block', marginBottom: '6px', fontWeight: 700, fontSize: '12px', color: 'var(--text-secondary)' }}>
                  Qaysi modeldan nusxalansin?
                </label>
                <select
                  value={cloneFromId}
                  onChange={(e) => setCloneFromId(e.target.value)}
                  className="soft-input"
                >
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.operations.length} ta operatsiya)
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Default Patta Info */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '4px', fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)' }}>
                  Dastlabki Partiya:
                </label>
                <input
                  type="text"
                  value={party}
                  onChange={(e) => setParty(e.target.value)}
                  className="soft-input"
                  style={{ height: '32px', fontSize: '12px' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', marginBottom: '4px', fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)' }}>
                  Rang:
                </label>
                <input
                  type="text"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="soft-input"
                  style={{ height: '32px', fontSize: '12px' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', marginBottom: '4px', fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)' }}>
                  Razmer:
                </label>
                <input
                  type="text"
                  value={size}
                  onChange={(e) => setSize(e.target.value)}
                  className="soft-input"
                  style={{ height: '32px', fontSize: '12px' }}
                />
              </div>
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
              <Plus size={14} />
              <span>Modelni Yaratish</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
