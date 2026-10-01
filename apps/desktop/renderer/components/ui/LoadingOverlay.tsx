import React from 'react';
import { useWorkbookStore } from '../../store/workbookStore';
import { Loader2 } from 'lucide-react';

export const LoadingOverlay: React.FC = () => {
  const loadingMessage = useWorkbookStore((s) => s.loadingMessage);

  if (!loadingMessage) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(15, 23, 42, 0.45)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        zIndex: 999999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'overlayFadeIn 0.15s ease-out'
      }}
    >
      <div
        style={{
          backgroundColor: '#ffffff',
          padding: '28px 40px',
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-xl)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '16px',
          minWidth: '300px',
          border: '1px solid rgba(255, 255, 255, 0.8)',
          animation: 'modalScaleUp 0.25s cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      >
        <div style={{
          width: '56px',
          height: '56px',
          borderRadius: 'var(--radius-full)',
          background: 'var(--primary-light)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}>
          <Loader2
            size={32}
            color="var(--primary)"
            style={{
              animation: 'spin 0.9s linear infinite'
            }}
          />
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>
            {loadingMessage}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
            Iltimos, kuting...
          </div>
        </div>
      </div>
    </div>
  );
};
