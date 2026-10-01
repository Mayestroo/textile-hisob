/**
 * Permission Guard Component
 * Phase 4 — RBAC
 *
 * Faqat tegishli ruxsatga (permission) ega foydalanuvchiga
 * komponentni ko'rsatadi, aks holda fallback (yoki hech narsa) qaytaradi.
 */

import React from 'react';
import { useCan } from '../../hooks/useCan';
import type { Permission } from '../../types/sync';

interface PermissionGuardProps {
  permission: Permission;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

export const PermissionGuard: React.FC<PermissionGuardProps> = ({
  permission,
  children,
  fallback = null
}) => {
  const hasPermission = useCan(permission);

  if (hasPermission) {
    return <>{children}</>;
  }

  return fallback ? <>{fallback}</> : null;
};
