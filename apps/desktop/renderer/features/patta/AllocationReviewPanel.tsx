import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { getElectronApi } from '../../store/runtimeMode';

type ReviewConflict = {
  operation_id: string;
  payload_hash: string;
  status: string;
  last_error?: string | null;
  error_message?: string | null;
  created_at: string;
  depends_on_operation_id?: string | null;
  payload?: Record<string, any> | null;
  cancellation_status?: string | null;
  cancellation_result?: { code?: string; message?: string } | null;
};

/** Read-only view of immutable local evidence; only server receipts can resolve it. */
export const AllocationReviewPanel: React.FC<{ companyId: string; canCancel?: boolean }> = ({ companyId, canCancel = false }) => {
  const [conflicts, setConflicts] = useState<ReviewConflict[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [history, setHistory] = useState<Record<string, any[]>>({});
  const refresh = useCallback(async () => {
    const api = getElectronApi() as any;
    if (!api?.AllocationReviewList) return;
    setLoading(true);
    try {
      const result = await api.AllocationReviewList({ companyId });
      if (!result?.success) throw new Error(result?.error?.message || 'Ko‘rib chiqish ro‘yxati yuklanmadi');
      setConflicts(result.conflicts || []);
      const apiHistory = await Promise.all((result.conflicts || []).map(async (row: ReviewConflict) => {
        try { const r = await api.AllocationReviewHistory?.({ companyId, operationId: row.operation_id }); return [row.operation_id, r?.history || []] as const; }
        catch { return [row.operation_id, []] as const; }
      }));
      setHistory(Object.fromEntries(apiHistory));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Ko‘rib chiqish ro‘yxati yuklanmadi');
    } finally { setLoading(false); }
  }, [companyId]);
  const retryAfterIssuance = async (operationId: string) => {
    const api = getElectronApi() as any;
    setLoading(true); setNotice(''); setError('');
    try {
      const result = await api?.AllocationReviewRetry?.({ companyId, operationId });
      if (!result?.success) throw new Error(result?.error?.message || 'Qayta yuborish uchun chiqarish hali tasdiqlanmagan');
      const dispatch = await api?.SyncDispatch?.(companyId);
      await refresh();
      setNotice(dispatch?.success === false
        ? 'Buyruq navbatga qaytdi. Server tasdig‘i kelmaguncha holat ochiq qoladi.'
        : 'Buyruq qayta yuborildi. Yechim faqat server tasdig‘idan keyin ko‘rinadi.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Qayta yuborish amalga oshmadi');
    } finally { setLoading(false); }
  };
  const cancelAllocation = async (operationId: string) => {
    const reason = window.prompt('Bekor qilish sababini kiriting:');
    if (!reason?.trim()) return;
    setLoading(true); setNotice(''); setError('');
    try {
      const result = await (getElectronApi() as any)?.AllocationReviewCancel?.({ companyId, operationId, reason: reason.trim() });
      if (!result?.success) throw new Error(result?.error?.message || 'Bekor qilish so‘rovi yuborilmadi');
      if (result.status === 'CANCELLED') setNotice('Server bekor qilishni tasdiqladi. Asl buyruq qayta qabul qilinmaydi.');
      else setNotice('Bekor qilish so‘rovi qurilmada saqlandi; server tasdig‘ini kutmoqda.');
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Bekor qilish amalga oshmadi'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, [refresh]);

  if (conflicts.length === 0 && !error) return null;
  return <section aria-label="Taqsimot nizolarini ko‘rib chiqish" style={{ margin: '12px 16px', padding: 16, border: '1px solid #f0c36d', borderRadius: 10, background: '#fffbeb' }}>
    <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <AlertTriangle size={18} aria-hidden="true" />
      <strong>Patta taqsimoti — ko‘rib chiqish talab qilinadi</strong>
      <button type="button" onClick={() => void refresh()} disabled={loading} style={{ marginLeft: 'auto' }} aria-label="Holatni yangilash"><RefreshCw size={16} /></button>
    </header>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {conflicts.map((row) => {
      const p = row.payload || {};
      const reason = row.last_error || row.error_message || 'Server sabab tafsilotini yubormagan';
      return <article key={row.operation_id} style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid #f0c36d' }}>
        <div><b>Holat:</b> {row.status === 'SUPERSEDED' ? 'Server tomonidan bekor qilindi' : row.cancellation_status === 'PENDING' ? 'Bekor qilish server tasdig‘ini kutmoqda' : 'Ko‘rib chiqilmoqda'} · <b>Sinxronlash:</b> {row.status === 'SUPERSEDED' ? 'Bekor qilish tasdiqlangan' : 'Server rad etdi, mahalliy dalil saqlangan'}</div>
        {row.cancellation_status === 'REJECTED' && <p role="alert">Bekor qilish rad etildi ({row.cancellation_result?.code || 'SERVER_REJECTED'}): {row.cancellation_result?.message || 'Server sababni qaytarmadi'}. Asl ish ko‘rib chiqishda qoladi; zarur bo‘lsa vakolatli tuzatish yo‘lini tanlang.</p>}
        <div><b>Kompaniya:</b> {companyId} · <b>Partiya:</b> {p.partyNumber ?? 'noma’lum'} · <b>Patta:</b> {p.pattaNumber ?? 'noma’lum'}</div>
        <div><b>Amaliyot:</b> {row.operation_id} · <b>Ro‘yxat vaqti:</b> {row.created_at}</div>
        <div><b>Ishchi:</b> {(p.entries || []).map((e: any) => e.workerId ?? e.workerName ?? 'noma’lum').join(', ') || 'noma’lum'} · <b>Miqdor:</b> {p.qty ?? 'noma’lum'}</div>
        <div><b>Sabab:</b> {reason}</div>
        {row.depends_on_operation_id && <div><b>Bloklangan ota-amaliyot:</b> {row.depends_on_operation_id}</div>}
        <details><summary>Asl buyruq dalili</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify({ payload: p, payloadHash: row.payload_hash }, null, 2)}</pre></details>
        <p role="note">Server tasdiqlangan chiqarilgan patta dalili topilmadi yoki mos kelmadi. Bu ekranda miqdorni o‘zgartirish yoki nizoni tasdiqlash mumkin emas. Dalil yetarli bo‘lmasa, nizo ochiq qoladi.</p>
        {row.status === 'CONFLICT' && row.depends_on_operation_id && <button type="button" disabled={loading} onClick={() => void retryAfterIssuance(row.operation_id)}>
          Asl chiqarish serverda qabul qilingan bo‘lsa, qayta yuborish
        </button>}
        {row.status === 'CONFLICT' && !row.cancellation_status && canCancel && <button type="button" disabled={loading} onClick={() => void cancelAllocation(row.operation_id)} style={{ marginLeft: 8 }}>
          Bekor qilish
        </button>}
        {(history[row.operation_id] || []).length > 0 && <details>
          <summary>Yechimlar tarixi ({history[row.operation_id].length})</summary>
          {history[row.operation_id].map((item, index) => <p key={`${item.resolutionOperationId}-${index}`}>
            {item.action === 'CANCEL' ? 'Bekor qilindi' : item.action} · {item.reviewerId} · {item.createdAt} · {item.reason}
          </p>)}
        </details>}
      </article>;
    })}
  </section>;
};
