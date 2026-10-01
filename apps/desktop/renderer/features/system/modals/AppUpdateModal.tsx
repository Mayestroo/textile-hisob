import React, { useState } from 'react';
import { useWorkbookStore } from '../../../store/workbookStore';
import { startDownloadAndInstall, CURRENT_APP_VERSION } from '../../../services/updateService';
import { UpdateProgress } from '../../../types/update';
import { 
  Sparkles, 
  Download, 
  X, 
  CheckCircle2, 
  AlertCircle, 
  RefreshCw,
  ArrowRight,
} from 'lucide-react';

export const AppUpdateModal: React.FC = () => {
  const modalType = useWorkbookStore((s) => s.modalState.type);
  const closeModal = useWorkbookStore((s) => s.closeModal);
  const availableUpdate = useWorkbookStore((s) => s.availableUpdate);
  const addNotification = useWorkbookStore((s) => s.addNotification);

  const [isDownloading, setIsDownloading] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDone, setIsDone] = useState(false);

  if (modalType !== 'app_update') return null;

  const handleStartUpdate = async () => {
    if (!availableUpdate) return;
    setError(null);
    setIsDownloading(true);
    setProgress({ percent: 0, downloadedBytes: 0, totalBytes: 0 });

    try {
      const res = await startDownloadAndInstall(availableUpdate, (p) => {
        setProgress(p);
      });

      if (res.success) {
        setIsDone(true);
        addNotification('success', 'Yangilanish', 'Dastur qayta ishga tushirilmoqda...');
      } else {
        setError(res.error || 'Yuklab olishda xatolik yuz berdi');
        setIsDownloading(false);
      }
    } catch (err: any) {
      console.error('Update download/install error:', err);
      setError(err?.message || 'Yuklab olishda kutilmagan xatolik yuz berdi');
      setIsDownloading(false);
    }
  };

  const formatMb = (bytes: number) => {
    return (bytes / (1024 * 1024)).toFixed(1);
  };

  return (
    <div
      className="modal-overlay"
      style={{
        backgroundColor: 'rgba(15, 23, 42, 0.78)',
        zIndex: 99999
      }}
      onClick={isDownloading ? undefined : closeModal}
    >
      <div
        className="modal-card"
        style={{
          maxWidth: '520px',
          borderRadius: 'var(--radius-xl)',
          overflow: 'hidden',
          boxShadow: '0 20px 40px rgba(0, 0, 0, 0.4)'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header with Gradient */}
        <div
          style={{
            background: 'linear-gradient(135deg, #059669 0%, #10b981 50%, #047857 100%)',
            padding: '24px',
            color: '#ffffff',
            position: 'relative',
            textAlign: 'center'
          }}
        >
          {!isDownloading && (
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

          <div
            style={{
              width: '56px',
              height: '56px',
              borderRadius: 'var(--radius-full)',
              background: 'rgba(255, 255, 255, 0.2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 12px auto',
              border: '2px solid rgba(255, 255, 255, 0.4)',
              boxShadow: '0 8px 16px rgba(0,0,0,0.15)'
            }}
          >
            <Sparkles size={28} color="#ffffff" />
          </div>

          <h2 style={{ fontSize: '20px', fontWeight: 800, margin: '0 0 6px 0', letterSpacing: '-0.01em' }}>
            Dastur Yangilanishi
          </h2>
          <p style={{ margin: 0, fontSize: '13px', opacity: 0.9 }}>
            Yangi imkoniyatlar va yaxshilanishlar tayyor
          </p>
        </div>

        {/* Content Body */}
        <div style={{ padding: '24px' }}>
          {availableUpdate ? (
            <div>
              {/* Version Comparison Card */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  background: 'var(--bg-surface-subtle)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-lg)',
                  padding: '12px 18px',
                  marginBottom: '18px'
                }}
              >
                <div>
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 600 }}>
                    Joriy versiya
                  </div>
                  <div style={{ fontSize: '14.5px', fontWeight: 700, color: 'var(--text-primary)' }}>
                    v{CURRENT_APP_VERSION}
                  </div>
                </div>

                <div style={{ color: '#10b981', display: 'flex', alignItems: 'center' }}>
                  <ArrowRight size={20} />
                </div>

                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '11px', color: '#10b981', fontWeight: 600 }}>
                    Yangi versiya
                  </div>
                  <div style={{ fontSize: '16px', fontWeight: 800, color: '#10b981' }}>
                    v{availableUpdate.version}
                  </div>
                </div>
              </div>

              {/* Release Notes */}
              {availableUpdate.releaseNotes && (
                <div style={{ marginBottom: '20px' }}>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                    YANGILANISH TAFSILOTLARI:
                  </div>
                  <div
                    style={{
                      background: 'var(--bg-surface-subtle)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 'var(--radius-md)',
                      padding: '12px 14px',
                      fontSize: '13px',
                      color: 'var(--text-primary)',
                      whiteSpace: 'pre-line',
                      maxHeight: '140px',
                      overflowY: 'auto',
                      lineHeight: '1.45'
                    }}
                  >
                    {availableUpdate.releaseNotes}
                  </div>
                </div>
              )}

              {/* Error Message */}
              {error && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    padding: '10px 14px',
                    background: 'rgba(239, 68, 68, 0.12)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    borderRadius: 'var(--radius-md)',
                    color: '#ef4444',
                    fontSize: '13px',
                    marginBottom: '16px'
                  }}
                >
                  <AlertCircle size={18} style={{ flexShrink: 0 }} />
                  <span>{error}</span>
                </div>
              )}

              {/* Progress Bar (when downloading) */}
              {isDownloading && (
                <div style={{ marginBottom: '20px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12.5px', marginBottom: '6px', fontWeight: 600 }}>
                    <span style={{ color: 'var(--text-primary)' }}>
                      {isDone ? 'O\'rnatishga tayyor...' : 'Yuklanmoqda...'}
                    </span>
                    <span style={{ color: '#10b981' }}>
                      {progress?.percent || 0}%
                    </span>
                  </div>

                  <div
                    style={{
                      width: '100%',
                      height: '10px',
                      backgroundColor: 'var(--bg-surface-subtle)',
                      borderRadius: 'var(--radius-full)',
                      overflow: 'hidden',
                      border: '1px solid var(--border-subtle)'
                    }}
                  >
                    <div
                      style={{
                        width: `${progress?.percent || 0}%`,
                        height: '100%',
                        background: 'linear-gradient(90deg, #10b981, #059669)',
                        transition: 'width 0.2s ease'
                      }}
                    />
                  </div>

                  {progress && progress.totalBytes > 0 && (
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', textAlign: 'right', marginTop: '4px' }}>
                      {formatMb(progress.downloadedBytes)} MB / {formatMb(progress.totalBytes)} MB
                    </div>
                  )}
                </div>
              )}

              {/* Action Buttons */}
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                {!isDownloading && (
                  <button
                    onClick={closeModal}
                    className="soft-btn soft-btn-secondary"
                    style={{ padding: '9px 18px', borderRadius: 'var(--radius-md)' }}
                  >
                    Keyinroq
                  </button>
                )}

                <button
                  onClick={handleStartUpdate}
                  disabled={isDownloading}
                  className="soft-btn soft-btn-primary"
                  style={{
                    padding: '9px 24px',
                    borderRadius: 'var(--radius-md)',
                    background: '#10b981',
                    borderColor: '#059669',
                    color: '#ffffff',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    fontWeight: 700,
                    cursor: isDownloading ? 'wait' : 'pointer'
                  }}
                >
                  {isDownloading ? (
                    <>
                      <RefreshCw size={16} className="animate-spin" />
                      <span>{isDone ? 'O\'rnatilmoqda...' : 'Yuklanmoqda...'}</span>
                    </>
                  ) : (
                    <>
                      <Download size={16} />
                      <span>Hozir Yangilash</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '16px 0' }}>
              <div
                style={{
                  width: '48px',
                  height: '48px',
                  borderRadius: 'var(--radius-full)',
                  background: 'rgba(16, 185, 129, 0.15)',
                  color: '#10b981',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: '0 auto 12px auto'
                }}
              >
                <CheckCircle2 size={26} />
              </div>
              <h3 style={{ fontSize: '16px', fontWeight: 700, margin: '0 0 6px 0', color: 'var(--text-primary)' }}>
                Sizda eng so'nggi versiya o'rnatilgan
              </h3>
              <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: '0 0 16px 0' }}>
                Joriy versiya: <strong>v{CURRENT_APP_VERSION}</strong>. Yangilanishlar mavjud emas.
              </p>
              <button
                onClick={closeModal}
                className="soft-btn soft-btn-secondary"
                style={{ padding: '8px 20px', borderRadius: 'var(--radius-md)' }}
              >
                Yopish
              </button>
            </div>
          )}

        </div>
      </div>
    </div>
  );
};
