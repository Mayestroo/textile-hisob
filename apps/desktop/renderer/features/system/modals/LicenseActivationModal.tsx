import React, { useState } from 'react';
import { useWorkbookStore } from '../../../store/workbookStore';
import { ShieldCheck, ShieldAlert, Copy, Check, Send, X, Clock, AlertTriangle, Ban, RefreshCw } from 'lucide-react';
import { useTrialCountdown } from '../../../hooks/useTrialCountdown';

export const LicenseActivationModal: React.FC = () => {
  const licenseStatus = useWorkbookStore((s) => s.licenseStatus);
  const modalType = useWorkbookStore((s) => s.modalState.type);
  const closeModal = useWorkbookStore((s) => s.closeModal);
  const countdown = useTrialCountdown(licenseStatus);
  const [copied, setCopied] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [isRequesting, setIsRequesting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  if (!licenseStatus) return null;

  const isActivated = licenseStatus.isActivated;
  const isTrial = licenseStatus.isTrial;
  const isTrialExpired = licenseStatus.isTrialExpired;
  const isBlocked = licenseStatus.isBlocked;
  const isManuallyOpened = modalType === 'license_activation';

  if (isActivated && !isTrialExpired && !isBlocked && !isManuallyOpened) return null;

  const machineId = licenseStatus.machineId || 'UNKNOWN';
  const canClose = (isActivated && !isTrialExpired && !isBlocked) || (isTrial && !isBlocked);

  const handleCopy = () => {
    navigator.clipboard.writeText(machineId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const handleCheckStatus = async () => {
    setIsChecking(true);
    setErrorMsg('');
    setSuccessMsg('');
    try {
      await useWorkbookStore.getState().checkLicense();
      setSuccessMsg('Aktivatsiya holati yangilandi.');
    } catch (error: any) {
      setErrorMsg(error?.message || 'Server bilan bog\'lanib bo\'lmadi.');
    } finally {
      setIsChecking(false);
    }
  };

  const handleResubmit = async () => {
    const eAPI = (window as any).electronAPI;
    if (!eAPI?.requestActivation) {
      setErrorMsg('Qayta so\'rov faqat ish stoli dasturida mavjud.');
      return;
    }
    setIsRequesting(true);
    setErrorMsg('');
    setSuccessMsg('');
    try {
      const result = await eAPI.requestActivation();
      if (!result?.success) throw new Error(result?.error || 'Yangi so\'rov yuborilmadi.');
      await useWorkbookStore.getState().checkLicense();
      setSuccessMsg('Yangi aktivatsiya so\'rovi administratorga yuborildi.');
    } catch (error: any) {
      setErrorMsg(error?.message || 'Yangi so\'rov yuborilmadi.');
    } finally {
      setIsRequesting(false);
    }
  };

  return (
    <div
      className="modal-overlay"
      style={{
        backgroundColor: canClose ? 'rgba(15, 23, 42, 0.65)' : 'rgba(10, 15, 30, 0.95)'
      }}
      onClick={canClose ? closeModal : undefined}
    >
      <div
        className="modal-card"
        style={{
          maxWidth: '560px',
          borderRadius: 'var(--radius-xl)'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div
          style={{
            background: isBlocked
              ? 'linear-gradient(135deg, #7f1d1d 0%, #450a0a 100%)'
              : isActivated && !isTrial
              ? 'linear-gradient(135deg, #065f46 0%, #047857 100%)'
              : isTrial
              ? 'linear-gradient(135deg, #1e3a8a 0%, #0f172a 100%)'
              : 'linear-gradient(135deg, #991b1b 0%, #450a0a 100%)',
            padding: '24px',
            color: '#ffffff',
            position: 'relative'
          }}
        >
          {canClose && (
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
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            <div
              style={{
                width: '52px',
                height: '52px',
                borderRadius: 'var(--radius-lg)',
                background: 'rgba(255, 255, 255, 0.2)',
                backdropFilter: 'blur(8px)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0
              }}
            >
              {isBlocked ? (
                <Ban size={28} color="#fca5a5" />
              ) : isActivated && !isTrial ? (
                <ShieldCheck size={28} color="#6ee7b7" />
              ) : isTrial ? (
                <Clock size={28} color="#7dd3fc" />
              ) : (
                <ShieldAlert size={28} color="#fca5a5" />
              )}
            </div>

            <div>
              <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 800, letterSpacing: '-0.3px' }}>
                {isBlocked
                  ? 'Qurilma Bloklangan'
                  : isActivated && !isTrial
                  ? 'Litsenziya Faollashtirilgan'
                  : isTrialExpired
                  ? 'Sinov Muddati Tugadi'
                  : isTrial
                  ? 'Sinov Muddati (Trial)'
                  : 'Dastur Aktivatsiyasi'}
              </h2>
              <p style={{ margin: '4px 0 0 0', fontSize: '12.5px', opacity: 0.9 }}>
                {isBlocked
                  ? 'Ushbu qurilma administrator tomonidan bloklangan'
                  : isActivated && !isTrial
                  ? licenseStatus.isLifetime
                    ? 'Cheksiz (Lifetime) litsenziya faol'
                    : `Amal qilish muddati: ${licenseStatus.expiry}`
                   : isTrialExpired
                   ? 'Administrator tasdig\'ini kuting'
                   : isTrial
                   ? `Qolgan vaqt: ${countdown ? `${countdown.formattedText} (${countdown.formattedClock})` : (licenseStatus.remainingText || '24 soat')}`
                   : licenseStatus.activationRequestStatus === 'REJECTED'
                   ? 'So\'rov rad etildi — tuzatib, qayta yuborishingiz mumkin'
                   : 'Aktivatsiya so\'rovi avtomatik yuboriladi'}
              </p>
            </div>
          </div>
        </div>

        {/* Modal Body */}
        <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
          {/* Machine ID Box */}
          <div
            style={{
              background: 'var(--bg-surface-subtle)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)',
              padding: '14px 16px'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <span style={{ fontSize: '11.5px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
                Sizning Qurilma ID raqamingiz:
              </span>
              <button
                type="button"
                onClick={handleCopy}
                className="soft-btn soft-btn-secondary"
                style={{ padding: '4px 10px', fontSize: '11.5px', borderRadius: 'var(--radius-full)' }}
              >
                {copied ? <Check size={12} color="var(--primary)" /> : <Copy size={12} />}
                <span>{copied ? 'Nusxalandi!' : 'Nusxa olish'}</span>
              </button>
            </div>

            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '13px',
                fontWeight: 700,
                color: 'var(--text-primary)',
                wordBreak: 'break-all',
                background: 'var(--bg-surface)',
                padding: '10px 14px',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-subtle)'
              }}
            >
              {machineId}
            </div>
          </div>

          {/* Messages */}
          {errorMsg && (
            <div style={{
              background: '#fef2f2',
              border: '1px solid #fee2e2',
              color: '#dc2626',
              padding: '10px 14px',
              borderRadius: 'var(--radius-md)',
              fontSize: '12.5px',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: '8px'
            }}>
              <AlertTriangle size={16} />
              <span>{errorMsg}</span>
            </div>
          )}

          {successMsg && (
            <div style={{
              background: '#ecfdf5',
              border: '1px solid #a7f3d0',
              color: '#059669',
              padding: '10px 14px',
              borderRadius: 'var(--radius-md)',
              fontSize: '12.5px',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: '8px'
            }}>
              <Check size={16} />
              <span>{successMsg}</span>
            </div>
          )}

          {/* Current License Details if active */}
          {isActivated && !isTrial && (
            <div
              style={{
                background: 'rgba(16, 185, 129, 0.08)',
                border: '1px solid rgba(52, 211, 153, 0.3)',
                borderRadius: 'var(--radius-lg)',
                padding: '12px 16px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontSize: '12.5px'
              }}
            >
              <div>
                <span style={{ color: 'var(--text-secondary)' }}>Joriy Faol Rol: </span>
                <span style={{ fontWeight: 700, color: '#34d399', textTransform: 'uppercase' }}>
                  {licenseStatus.role || 'admin'}
                </span>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11.5px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                  Litsenziya faol
                </div>
              </div>
            </div>
          )}

          {!isActivated && !isTrial && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                Qurilma so'rovi  serveriga yuboriladi. Administrator Telegram orqali korxona va rolni tasdiqlagach,
                imzolangan aktivatsiya shu dasturga avtomatik keladi.
                {licenseStatus.message ? <div style={{ marginTop: '6px', fontWeight: 700 }}>{licenseStatus.message}</div> : null}
              </div>
              <button
                type="button"
                onClick={handleCheckStatus}
                disabled={isChecking || isRequesting}
                className="soft-btn soft-btn-primary"
                style={{ height: '40px', fontSize: '13px', justifyContent: 'center' }}
              >
                <RefreshCw size={15} className={isChecking ? 'spin-animation' : ''} />
                <span>{isChecking ? 'Tekshirilmoqda...' : 'Holatni tekshirish'}</span>
              </button>
              {licenseStatus.activationRequestStatus === 'REJECTED' && (
                <button
                  type="button"
                  onClick={handleResubmit}
                  disabled={isChecking || isRequesting}
                  className="soft-btn soft-btn-secondary"
                  style={{ height: '38px', fontSize: '12.5px', justifyContent: 'center' }}
                >
                  <Send size={14} />
                  <span>{isRequesting ? 'Yuborilmoqda...' : 'Yangi so\'rov yuborish'}</span>
                </button>
              )}
            </div>
          )}

          {/* Telegram Contact Banner */}
          <div
            style={{
              background: '#f0f9ff',
              border: '1px solid #bae6fd',
              borderRadius: 'var(--radius-lg)',
              padding: '12px 16px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
              flexWrap: 'wrap'
            }}
          >
            <div>
              <div style={{ fontWeight: 700, fontSize: '12.5px', color: '#0369a1' }}>
                 Aktivatsiya tasdig\'i:
              </div>
              <div style={{ fontSize: '11.5px', color: '#0284c7', marginTop: '2px' }}>
                 Qurilma ID administrator so\'rovida ko\'rinadi
              </div>
            </div>

            <a
              href="https://t.me/mayestr0"
              target="_blank"
              rel="noopener noreferrer"
              className="soft-btn soft-btn-primary"
              style={{
                background: 'linear-gradient(135deg, #0284c7 0%, #0369a1 100%)',
                padding: '6px 14px',
                fontSize: '12px',
                textDecoration: 'none',
                borderRadius: 'var(--radius-full)'
              }}
            >
              <Send size={13} />
               <span>Telegram</span>
            </a>
          </div>
        </div>

        {canClose && (
          <div className="modal-footer">
            <button
              onClick={closeModal}
              className="soft-btn soft-btn-primary"
              style={{ borderRadius: 'var(--radius-full)', padding: '6px 20px' }}
            >
              Yopish
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
