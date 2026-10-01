/**
 * Role Badge Component
 * Phase 4 — RBAC Visual Indicator
 */

import React from 'react';
import { useAuthStore } from '../../store/authStore';
import { ROLE_LABELS_UZ } from '../../types/sync';
import { ShieldCheck, Keyboard, Printer } from 'lucide-react';

export const RoleBadge: React.FC<{ style?: React.CSSProperties; compact?: boolean }> = ({
  style,
  compact = false
}) => {
  const role = useAuthStore((s) => s.role);

  if (!role) return null;

  const roleConfigs = {
    admin: {
      label: ROLE_LABELS_UZ.admin,
      shortLabel: 'Admin',
      icon: <ShieldCheck size={13} />,
      bg: 'rgba(99, 102, 241, 0.15)',
      color: '#818cf8',
      border: '1px solid rgba(99, 102, 241, 0.3)'
    },
    type: {
      label: ROLE_LABELS_UZ.type,
      shortLabel: 'Type',
      icon: <Keyboard size={13} />,
      bg: 'rgba(14, 165, 233, 0.15)',
      color: '#38bdf8',
      border: '1px solid rgba(14, 165, 233, 0.3)'
    },
    print: {
      label: ROLE_LABELS_UZ.print,
      shortLabel: 'Print',
      icon: <Printer size={13} />,
      bg: 'rgba(16, 185, 129, 0.15)',
      color: '#34d399',
      border: '1px solid rgba(16, 185, 129, 0.3)'
    }
  };

  const config = roleConfigs[role] || roleConfigs.admin;

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        padding: compact ? '2px 6px' : '4px 10px',
        borderRadius: 'var(--radius-full)',
        fontSize: '11.5px',
        fontWeight: 600,
        backgroundColor: config.bg,
        color: config.color,
        border: config.border,
        backdropFilter: 'blur(8px)',
        transition: 'all 0.2s',
        userSelect: 'none',
        ...style
      }}
      title={`Joriy rol: ${config.label}`}
    >
      {config.icon}
      <span>{compact ? config.shortLabel : config.label}</span>
    </span>
  );
};
