/**
 * Pending Device Approval Screen
 * Phase 4 — Telegram Device Approval Flow
 */

import React, { useState } from 'react';
import { Clock, RefreshCw, Copy, Check, Building2, ShieldAlert } from 'lucide-react';
import { useAuthStore, applyRolePermissions } from '../../store/authStore';
import { useWorkbookStore } from '../../store/workbookStore';

interface PendingApprovalProps {
  isBlocked?: boolean;
}

export const PendingApproval: React.FC<PendingApprovalProps> = ({ isBlocked: propBlocked }) => {
  const licenseStatus = useWorkbookStore((s) => s.licenseStatus);
  const authCompanyId = useAuthStore((s) => s.companyId);
  const authDeviceId = useAuthStore((s) => s.deviceId);
  const openModal = useWorkbookStore((s) => s.openModal);

  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);

  const companyId = authCompanyId || licenseStatus?.companyId;
  const deviceId = licenseStatus?.machineId || authDeviceId || 'DEVICE-HWID-PENDING';

  const isBlocked = propBlocked || licenseStatus?.isBlocked;
  const isActivated = licenseStatus?.isActivated;
  const isMissingCompany = !isBlocked && isActivated && !companyId;

  const handleCopy = () => {
    navigator.clipboard.writeText(deviceId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCheckStatus = async () => {
    setChecking(true);
    try {
      await useWorkbookStore.getState().checkLicense();
    } catch (err: any) {
      console.error('Failed to check device status:', err);
      useWorkbookStore.getState().addNotification(
        'error',
        'Status tekshirishda xatolik',
        err?.message || 'Tarmoqqa yoki serverga ulanib bo‘lmadi'
      );
    } finally {
      setTimeout(() => setChecking(false), 800);
    }
  };

  return (
    <div
      style={{
        flex: 1,
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        backgroundColor: 'var(--bg-app)',
        color: 'var(--text-primary)'
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '520px',
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          padding: '32px',
          boxShadow: 'var(--shadow-lg)',
          textAlign: 'center'
        }}
      >
        <div
          style={{
            width: '64px',
            height: '64px',
            borderRadius: 'var(--radius-full)',
            backgroundColor: isBlocked
              ? 'rgba(239, 68, 68, 0.15)'
              : isMissingCompany
              ? 'rgba(59, 130, 246, 0.15)'
              : 'rgba(245, 158, 11, 0.15)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 20px',
            border: `1.5px solid ${
              isBlocked
                ? 'rgba(239, 68, 68, 0.35)'
                : isMissingCompany
                ? 'rgba(59, 130, 246, 0.35)'
                : 'rgba(245, 158, 11, 0.35)'
            }`
          }}
        >
          {isBlocked ? (
            <ShieldAlert size={32} color="#ef4444" />
          ) : isMissingCompany ? (
            <Building2 size={32} color="#3b82f6" />
          ) : (
            <Clock size={30} color="#f59e0b" />
          )}
        </div>

        <h1 style={{ fontSize: '20px', fontWeight: 800, marginBottom: '10px' }}>
          {isBlocked
            ? "Qurilma Bloklangan"
            : isMissingCompany
            ? "Korxona (Sex) Biriktirilmagan"
            : "Tasdiq Kutilmoqda..."}
        </h1>

        <p style={{ fontSize: '13.5px', color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: '22px' }}>
          {isBlocked ? (
            <>
              {licenseStatus?.message || "Ushbu qurilma administrator tomonidan bloklangan. Dasturdan foydalanish uchun adminga murojaat qiling."}
            </>
          ) : isMissingCompany ? (
            <>
              Ushbu qurilmaga rol berilgan, lekin ma'lumotlar aralashib ketmasligi uchun <strong>korxona (sex) biriktirish majburiydir</strong>. Boshqaruvchi Telegram bot orqali korxona biriktirgach, dastur avtomatik ishga tushadi.
            </>
          ) : (
            <>
              Ushbu kompyuter uchun so'rov adminga yuborildi. Boshqaruvchi <strong>Telegram bot</strong> orqali rolni (Admin / Type / Print) va korxonani tasdiqlagach, dastur avtomatik faollashadi.
            </>
          )}
        </p>

        {/* Device ID / HWID box */}
        <div
          style={{
            backgroundColor: 'var(--bg-surface-subtle)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            padding: '12px 14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '24px'
          }}
        >
          <div style={{ textAlign: 'left' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>
              Qurilma identifikatori (HWID):
            </div>
            <code style={{ fontSize: '13px', fontWeight: 700, color: 'var(--primary)' }}>
              {deviceId}
            </code>
          </div>

          <button
            onClick={handleCopy}
            className="soft-btn soft-btn-secondary"
            style={{ padding: '6px 10px', fontSize: '11.5px', borderRadius: 'var(--radius-sm)' }}
            title="Nusxalash"
          >
            {copied ? <Check size={14} color="#10b981" /> : <Copy size={14} />}
            <span>{copied ? 'Nusxalandi' : 'Nusxa'}</span>
          </button>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <button
            onClick={handleCheckStatus}
            disabled={checking}
            className="soft-btn soft-btn-primary"
            style={{
              padding: '10px 16px',
              fontSize: '13px',
              borderRadius: 'var(--radius-full)',
              justifyContent: 'center',
              width: '100%'
            }}
          >
            <RefreshCw size={15} className={checking ? 'spin-animation' : ''} />
            <span>{checking ? 'Tekshirilmoqda...' : 'Holatni tekshirish'}</span>
          </button>

          <button
            onClick={() => openModal({ type: 'license_activation' })}
            className="soft-btn soft-btn-secondary"
            style={{
              padding: '8px 16px',
              fontSize: '12.5px',
              borderRadius: 'var(--radius-full)',
              justifyContent: 'center',
              width: '100%'
            }}
          >
            <Clock size={14} />
            <span>Aktivatsiya so'rovi holati</span>
          </button>

          {import.meta.env.DEV && (
            <div style={{ marginTop: '6px', borderTop: '1px dashed var(--border-subtle)', paddingTop: '10px' }}>
              <button
                type="button"
                onClick={() => {
                  const perms = applyRolePermissions('admin');
                  useAuthStore.getState().setAuth({
                    status: 'active',
                    role: 'admin',
                    companyId: 'comp_novda',
                    permissions: perms,
                    user: {
                      uid: 'dev_admin',
                      email: 'dev@novda.uz',
                      displayName: 'Dev Administrator',
                      role: 'admin',
                      permissions: perms,
                      companyId: 'comp_novda',
                      deviceId: deviceId,
                      status: 'active',
                      lastSeen: new Date().toISOString(),
                      createdAt: new Date().toISOString()
                    }
                  });
                  useWorkbookStore.setState({
                    licenseStatus: {
                      isActivated: true,
                      machineId: deviceId,
                      role: 'admin',
                      companyId: 'comp_novda',
                      companyName: 'Novda (Dev)',
                      isLifetime: true
                    }
                  });
                }}
                className="soft-btn"
                style={{
                  width: '100%',
                  padding: '9px 16px',
                  fontSize: '12.5px',
                  fontWeight: 700,
                  backgroundColor: 'rgba(245, 158, 11, 0.12)',
                  color: '#d97706',
                  border: '1px solid rgba(245, 158, 11, 0.35)',
                  borderRadius: 'var(--radius-full)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px'
                }}
              >
                <span>⚡ Dev Rejimida Kirish (Admin)</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
