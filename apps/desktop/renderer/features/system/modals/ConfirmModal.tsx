import React, { useEffect, useRef } from 'react';
import { useWorkbookStore } from '../../../store/workbookStore';
import { Trash2, HelpCircle, X } from 'lucide-react';

export const ConfirmModal: React.FC = () => {
  const confirmState = useWorkbookStore((s) => s.confirmState);
  const closeConfirm = useWorkbookStore((s) => s.closeConfirm);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirmState) {
      // Focus confirm button when modal opens
      setTimeout(() => {
        confirmBtnRef.current?.focus();
      }, 50);

      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeConfirm(false);
        } else if (e.key === 'Enter') {
          // If active element is not a button, trigger confirm
          if (document.activeElement?.tagName !== 'BUTTON') {
            e.preventDefault();
            closeConfirm(true);
          }
        }
      };

      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [confirmState, closeConfirm]);

  if (!confirmState) return null;

  const isDanger = confirmState.isDanger !== false;
  const title = confirmState.title || (isDanger ? "O'chirishni tasdiqlash" : "Tasdiqlash");
  const confirmText = confirmState.confirmText || (isDanger ? "Ha, o'chirilsin" : "Tasdiqlash");
  const cancelText = confirmState.cancelText || "Bekor qilish";

  return (
    <div
      onClick={() => closeConfirm(false)}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(15, 23, 42, 0.55)',
        backdropFilter: 'blur(3px)',
        zIndex: 99999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
        animation: 'fadeIn 0.15s ease'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: '430px',
          backgroundColor: 'var(--bg-surface)',
          borderRadius: 'var(--radius-xl)',
          boxShadow: '0 25px 60px -15px rgba(0, 0, 0, 0.45), 0 0 1px rgba(0, 0, 0, 0.2)',
          border: '1px solid var(--border-subtle)',
          overflow: 'hidden',
          animation: 'scaleUp 0.15s cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '14px 18px',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: isDanger ? '#fee2e2' : 'var(--primary-light)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {isDanger ? (
              <Trash2 size={18} color="#ef4444" strokeWidth={2.2} />
            ) : (
              <HelpCircle size={18} color="var(--primary)" strokeWidth={2.2} />
            )}
            <span
              style={{
                fontWeight: 800,
                fontSize: '14.5px',
                color: isDanger ? '#b91c1c' : 'var(--primary-dark)',
                letterSpacing: '-0.2px'
              }}
            >
              {title}
            </span>
          </div>
          <button
            type="button"
            onClick={() => closeConfirm(false)}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: isDanger ? '#b91c1c' : 'var(--text-secondary)',
              padding: '4px',
              borderRadius: 'var(--radius-sm)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
            title="Bekor qilish (Esc)"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '20px 20px 16px' }}>
          <p
            style={{
              margin: '0 0 20px',
              fontSize: '13.5px',
              color: 'var(--text-primary)',
              lineHeight: 1.55,
              whiteSpace: 'pre-line'
            }}
          >
            {confirmState.message}
          </p>

          {/* Action buttons */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
            <button
              type="button"
              onClick={() => closeConfirm(false)}
              className="soft-btn soft-btn-secondary"
              style={{
                padding: '8px 16px',
                fontSize: '13px',
                fontWeight: 600,
                borderRadius: 'var(--radius-md)'
              }}
            >
              {cancelText}
            </button>
            <button
              ref={confirmBtnRef}
              type="button"
              onClick={() => closeConfirm(true)}
              className="soft-btn"
              style={{
                padding: '8px 18px',
                fontSize: '13px',
                fontWeight: 700,
                borderRadius: 'var(--radius-md)',
                background: isDanger ? '#ef4444' : 'var(--primary)',
                color: '#ffffff',
                border: 'none',
                boxShadow: isDanger
                  ? '0 2px 8px rgba(239, 68, 68, 0.35)'
                  : '0 2px 8px rgba(16, 185, 129, 0.35)'
              }}
            >
              {confirmText}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
