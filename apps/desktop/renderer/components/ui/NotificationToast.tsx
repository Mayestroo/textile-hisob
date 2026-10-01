import React from 'react';
import { useWorkbookStore } from '../../store/workbookStore';
import { CheckCircle2, AlertCircle, AlertTriangle, Info, X } from 'lucide-react';

export const NotificationToast: React.FC = () => {
  const notifications = useWorkbookStore((s) => s.notifications);
  const removeNotification = useWorkbookStore((s) => s.removeNotification);

  if (notifications.length === 0) return null;

  return (
    <div className="toast-container">
      {notifications.map((n) => {
        return (
          <div key={n.id} className={`toast-item ${n.type}`}>
            <div style={{ flexShrink: 0, marginTop: '2px' }}>
              {n.type === 'success' && <CheckCircle2 size={18} color="var(--status-success)" />}
              {n.type === 'error' && <AlertCircle size={18} color="var(--status-error)" />}
              {n.type === 'warning' && <AlertTriangle size={18} color="var(--status-warning)" />}
              {n.type === 'info' && <Info size={18} color="var(--status-info)" />}
            </div>

            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: '13px', color: 'var(--text-primary)', marginBottom: '2px' }}>{n.title}</div>
              <div style={{ color: 'var(--text-secondary)', fontSize: '12px', lineHeight: '1.4' }}>{n.message}</div>
            </div>

            <button
              onClick={() => removeNotification(n.id)}
              style={{
                border: 'none',
                background: 'var(--bg-surface-subtle)',
                borderRadius: 'var(--radius-full)',
                cursor: 'pointer',
                color: 'var(--text-muted)',
                width: '22px',
                height: '22px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all 0.15s'
              }}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
};
