/**
 * AuthGate Component
 * Phase 4 — RBAC & License Access Gate
 *
 * Ilova ochilganda foydalanuvchining litsenziya va rol holatini tekshiradi:
 *  - Agar qurilma tasdiq kutilayotgan bo'lsa -> PendingApproval ko'rsatadi
 *  - Agar faol litsenziya yoki trial bo'lsa -> asosiy dastur (children) ochiladi
 */

import React, { useEffect } from 'react';
import { useAuthStore } from '../../store/authStore';
import { useWorkbookStore } from '../../store/workbookStore';
import { useStoreBridge } from '../../store';
import { PendingApproval } from './PendingApproval';

export const AuthGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Bridge legacy & atomic stores and start remote listeners from app mount
  useStoreBridge();

  const authStatus = useAuthStore((s) => s.status);
  const licenseStatus = useWorkbookStore((s) => s.licenseStatus);
  const companyId = useAuthStore((s) => s.companyId) || licenseStatus?.companyId;
  const isBlocked = licenseStatus?.isBlocked || authStatus === 'suspended';

  useEffect(() => {
    // Check license on initial app boot
    useWorkbookStore.getState().checkLicense();
  }, []);

  if (isBlocked) {
    return <PendingApproval isBlocked={true} />;
  }

  // Do not flash the pending-approval screen while the persisted activation is loading.
  if (!licenseStatus) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>
        Litsenziya holati tekshirilmoqda...
      </div>
    );
  }

  // Agar litsenziya kutilayotgan, unauthenticated yoki korxona biriktirilmagan bo'lsa -> PendingApproval
  if (authStatus === 'pending_approval' || authStatus === 'unauthenticated' || !companyId) {
    return <PendingApproval />;
  }

  // Boshqa barcha holatlarda asosiy dastur ochiladi
  return <>{children}</>;
};
