import React from 'react';
import { useWorkbookStore } from '../../../store/workbookStore';
import { X, Code2, Send, Globe, Bot, Smartphone, Cpu, CheckCircle2, Sparkles } from 'lucide-react';

export const DeveloperModal: React.FC = () => {
  const modalType = useWorkbookStore((s) => s.modalState.type);
  const closeModal = useWorkbookStore((s) => s.closeModal);

  if (modalType !== 'developer_info') return null;

  return (
    <div
      className="modal-overlay"
      style={{
        backgroundColor: 'rgba(15, 23, 42, 0.75)'
      }}
      onClick={closeModal}
    >
      <div
        className="modal-card"
        style={{
          maxWidth: '560px',
          borderRadius: 'var(--radius-xl)'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            background: 'linear-gradient(135deg, #0284c7 0%, #0369a1 50%, #0f172a 100%)',
            padding: '24px',
            color: '#ffffff',
            position: 'relative',
            textAlign: 'center'
          }}
        >
          <button
            onClick={closeModal}
            className="soft-btn soft-btn-secondary"
            style={{
              position: 'absolute',
              top: '16px',
              right: '16px',
              width: '32px',
              height: '32px',
              padding: 0,
              borderRadius: 'var(--radius-full)',
              background: 'rgba(255, 255, 255, 0.2)',
              color: '#ffffff',
              border: 'none'
            }}
          >
            <X size={16} />
          </button>

          <div
            style={{
              width: '56px',
              height: '56px',
              borderRadius: 'var(--radius-lg)',
              background: 'rgba(255, 255, 255, 0.15)',
              border: '1px solid rgba(255, 255, 255, 0.3)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 12px auto',
              boxShadow: '0 8px 20px rgba(0, 0, 0, 0.2)'
            }}
          >
            <Code2 size={28} color="#ffffff" />
          </div>

          <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 800, letterSpacing: '-0.3px' }}>
            Dasturchi & IT Xizmatlari
          </h2>
          <p style={{ margin: '6px 0 0 0', fontSize: '13px', color: 'rgba(255, 255, 255, 0.85)' }}>
            Biznesingizni zamonaviy texnologiyalar bilan avtomatlashtiring
          </p>
        </div>

        {/* Body */}
        <div style={{ padding: '24px' }}>
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '16px', lineHeight: '1.5', textAlign: 'center' }}>
            Sizning biznesingiz, ishlab chiqarish yoki savdo jarayonlaringiz uchun <strong>istalgan murakkablikdagi</strong> dasturlarni yuqori sifat va kafolat bilan tayyorlab beramiz:
          </div>

          {/* Services Grid */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: '12px',
              marginBottom: '20px'
            }}
          >
            {/* Service 1 */}
            <div
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                padding: '12px',
                display: 'flex',
                alignItems: 'flex-start',
                gap: '10px'
              }}
            >
              <div style={{ background: '#e0f2fe', color: '#0284c7', padding: '8px', borderRadius: 'var(--radius-sm)' }}>
                <Globe size={18} />
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--text-primary)' }}>Veb-saytlar</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>Landing page, do'kon va portallar</div>
              </div>
            </div>

            {/* Service 2 */}
            <div
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                padding: '12px',
                display: 'flex',
                alignItems: 'flex-start',
                gap: '10px'
              }}
            >
              <div style={{ background: '#f0fdf4', color: '#16a34a', padding: '8px', borderRadius: 'var(--radius-sm)' }}>
                <Bot size={18} />
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--text-primary)' }}>Telegram Botlar</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>Savdo, buyurtma va to'lov tizimlari</div>
              </div>
            </div>

            {/* Service 3 */}
            <div
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                padding: '12px',
                display: 'flex',
                alignItems: 'flex-start',
                gap: '10px'
              }}
            >
              <div style={{ background: '#faf5ff', color: '#9333ea', padding: '8px', borderRadius: 'var(--radius-sm)' }}>
                <Smartphone size={18} />
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--text-primary)' }}>Mobil Ilovalar</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>Android va iOS uchun dasturlar</div>
              </div>
            </div>

            {/* Service 4 */}
            <div
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                padding: '12px',
                display: 'flex',
                alignItems: 'flex-start',
                gap: '10px'
              }}
            >
              <div style={{ background: '#fffbeb', color: '#d97706', padding: '8px', borderRadius: 'var(--radius-sm)' }}>
                <Cpu size={18} />
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--text-primary)' }}>Hisob & ERP</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>Maxsus boshqaruv tizimlari</div>
              </div>
            </div>
          </div>

          {/* Advantages */}
          <div
            style={{
              background: 'var(--primary-light)',
              border: '1px solid rgba(16, 185, 129, 0.25)',
              borderRadius: 'var(--radius-md)',
              padding: '12px 16px',
              marginBottom: '20px'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--primary)', fontWeight: 700, fontSize: '12.5px', marginBottom: '6px' }}>
              <Sparkles size={15} />
              <span>Nega aynan biz?</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', color: '#065f46' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <CheckCircle2 size={13} color="var(--primary)" />
                <span>Qulay, tushunarli va zamonaviy interfeys</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <CheckCircle2 size={13} color="var(--primary)" />
                <span>Tezkor ishlash va ma'lumotlar xavfsizligi</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <CheckCircle2 size={13} color="var(--primary)" />
                <span>Doimiy texnik qo'llab-quvvatlash</span>
              </div>
            </div>
          </div>

          {/* Telegram Action Button */}
          <div style={{ textAlign: 'center' }}>
            <a
              href="https://t.me/mayestr0"
              target="_blank"
              rel="noopener noreferrer"
              className="soft-btn soft-btn-primary"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '10px',
                background: 'linear-gradient(135deg, #0284c7 0%, #0369a1 100%)',
                padding: '12px 20px',
                borderRadius: 'var(--radius-full)',
                fontSize: '14px',
                textDecoration: 'none',
                width: '100%'
              }}
            >
              <Send size={16} />
              <span>Telegram orqali bog'lanish (@mayestr0)</span>
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};
