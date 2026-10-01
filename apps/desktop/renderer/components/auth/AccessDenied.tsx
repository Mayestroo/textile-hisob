/**
 * Access Denied Component
 * Phase 4 — RBAC Ruxsat Cheklovi
 */

import React from 'react';
import { ShieldAlert, ArrowLeft } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { useWorkbookStore } from '../../store/workbookStore';
import { ROLE_LABELS_UZ } from '../../types/sync';

interface AccessDeniedProps {
  requiredPermission?: string;
  message?: string;
}

export const AccessDenied: React.FC<AccessDeniedProps> = ({
  requiredPermission,
  message = "Ushbu bo'limga kirish uchun sizning rolingizda yetarli ruxsat yo'q."
}) => {
  const role = useAuthStore((s) => s.role);
  const setActiveSheet = useWorkbookStore((s) => s.setActiveSheet);

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '32px',
        textAlign: 'center',
        background: 'var(--bg-app)',
        color: 'var(--text-primary)'
      }}
    >
      <div
        style={{
          width: '64px',
          height: '64px',
          borderRadius: 'var(--radius-full)',
          background: 'rgba(239, 68, 68, 0.15)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: '18px',
          border: '1.5px solid rgba(239, 68, 68, 0.3)'
        }}
      >
        <ShieldAlert size={32} color="#ef4444" />
      </div>

      <h2 style={{ fontSize: '20px', fontWeight: 800, marginBottom: '8px', color: 'var(--text-primary)' }}>
        Ruxsat Cheklangan
      </h2>

      <p style={{ fontSize: '14px', color: 'var(--text-muted)', maxWidth: '460px', lineHeight: 1.5, marginBottom: '16px' }}>
        {message}
      </p>

      <div
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-md)',
          padding: '12px 18px',
          marginBottom: '20px',
          fontSize: '12.5px'
        }}
      >
        <span>Sizning joriy rolingiz: </span>
        <strong style={{ color: 'var(--primary)' }}>
          {role ? ROLE_LABELS_UZ[role] : 'Noma\'lum'}
        </strong>
        {requiredPermission && (
          <div style={{ marginTop: '4px', fontSize: '11px', color: 'var(--text-muted)' }}>
            Talab qilingan huquq: <code>{requiredPermission}</code>
          </div>
        )}
      </div>

      <button
        onClick={() => setActiveSheet(role === 'print' ? 'Patta' : 'Umumiy')}
        className="soft-btn soft-btn-primary"
        style={{ padding: '8px 18px', borderRadius: 'var(--radius-full)', fontSize: '13px' }}
      >
        <ArrowLeft size={15} />
        <span>Ruxsat etilgan sahifaga qaytish</span>
      </button>
    </div>
  );
};
