import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import { getElectronApi } from '../../store/runtimeMode';
import { useWorkbookStore } from '../../store/workbookStore';
import { OperatorLoginForm } from '../review/OperatorLoginForm';

/** Local outbox evidence held on this PC. */
type LocalReviewRow = {
  operation_id: string;
  command_type?: string;
  payload_hash: string;
  status: string;
  last_error?: string | null;
  error_message?: string | null;
  created_at: string;
  updated_at?: string | null;
  depends_on_operation_id?: string | null;
  payload?: Record<string, any> | null;
  cancellation_status?: string | null;
  cancellation_result?: { code?: string; message?: string } | null;
};

/** Company-wide evidence recorded on the server (any PC). */
type ServerReviewRow = {
  operationId: string;
  commandType: string;
  ticketId: string;
  payloadHash: string;
  payload: Record<string, any>;
  reason: string;
  recordedAt: string;
  issuedQty: number | null;
  modelName: string | null;
  corrected?: boolean;
};

type ReviewItem = {
  operationId: string;
  commandType: string;
  payloadHash: string;
  payload: Record<string, any>;
  rawReason: string;
  createdAt: string;
  issuedQty: number | null;
  modelName: string | null;
  local: LocalReviewRow | null;
  onServer: boolean;
  corrected: boolean;
};

const RECENT_CANCELLED_MS = 3 * 24 * 60 * 60 * 1000;
const OPERATOR_REQUIRED_CODES = ['ALLOCATION_REVIEW_UNAUTHORIZED', 'OPERATOR_AUTH_REQUIRED', 'OPERATOR_REAUTH_REQUIRED'];

/** IPC failures carry the message as a string; HTTP bodies nest it. */
function errorText(result: any, fallback: string): string {
  if (typeof result?.error === 'string' && result.error.trim()) return result.error;
  return result?.error?.message || fallback;
}

type ServerAccess = 'idle' | 'ok' | 'operator_required' | 'unsupported' | 'error';

function parseReason(row: LocalReviewRow): string {
  const raw = row.last_error || row.error_message || '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return String(parsed.message || parsed.code || raw);
  } catch { /* plain text */ }
  return raw;
}

/** Explains the server's English review reason in the operator's language. */
export function describeReviewReason(rawReason: string, qty: unknown, issuedQty: number | null): string {
  const text = rawReason || '';
  if (/does not match authoritative issuance/i.test(text)) {
    return issuedQty
      ? `Ish soni chiqarilgan miqdorga mos emas: kiritilgan ${qty ?? '?'} dona, partiyada har bir patta ${issuedQty} dona.`
      : `Ish soni (${qty ?? '?'} dona) partiyaning chiqarilgan miqdoriga mos emas.`;
  }
  if (/no (trustworthy|reliable) per-patta/i.test(text)) return 'Partiyada patta bo‘yicha ishonchli chiqarilgan miqdor yo‘q.';
  if (/no verifiable open accounting period|no verifiable free-mode/i.test(text)) return 'Ticket uchun ochiq hisob davri aniqlanmadi.';
  if (/no canonical printed-party link/i.test(text)) return 'Ticket pechat qilingan partiyaga bog‘lanmagan.';
  return text || 'Server sabab tafsilotini yubormagan.';
}

export const AllocationReviewPanel: React.FC<{ companyId: string; canCancel?: boolean; variant?: 'inline' | 'page' }> = ({ companyId, canCancel = false, variant = 'inline' }) => {
  const models = useWorkbookStore((s) => s.models);
  const printedPartyHistory = useWorkbookStore((s) => s.printedPartyHistory);
  const [localRows, setLocalRows] = useState<LocalReviewRow[]>([]);
  const [serverRows, setServerRows] = useState<ServerReviewRow[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [history, setHistory] = useState<Record<string, any[]>>({});
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [serverAccess, setServerAccess] = useState<ServerAccess>('idle');
  const [serverError, setServerError] = useState('');

  const refresh = useCallback(async () => {
    const api = getElectronApi() as any;
    if (!api?.AllocationReviewList) return;
    setLoading(true);
    try {
      const result = await api.AllocationReviewList({ companyId });
      if (!result?.success) throw new Error(errorText(result, 'Ko‘rib chiqish ro‘yxati yuklanmadi'));
      const now = Date.now();
      const local: LocalReviewRow[] = (result.conflicts || []).filter((row: LocalReviewRow) => row.status !== 'SUPERSEDED'
        || now - Date.parse(row.updated_at || row.created_at) < RECENT_CANCELLED_MS);
      setLocalRows(local);
      let server: ServerReviewRow[] = [];
      if (canCancel && typeof api.AllocationReviewServerList === 'function') {
        const serverResult = await api.AllocationReviewServerList({ companyId });
        if (serverResult?.success) {
          server = serverResult.reviews || [];
          setServerAccess(serverResult.unsupported ? 'unsupported' : 'ok');
          setServerError('');
        } else {
          // Never hide this: an empty list here would look like "nothing to review".
          setServerAccess(OPERATOR_REQUIRED_CODES.includes(serverResult?.code) ? 'operator_required' : 'error');
          setServerError(errorText(serverResult, 'Serverdan ro‘yxat olinmadi'));
        }
      }
      setServerRows(server);
      if (canCancel && typeof api.AllocationReviewHistory === 'function') {
        const ids = [...new Set([...local.map((row) => row.operation_id), ...server.map((row) => row.operationId)])];
        const entries = await Promise.all(ids.map(async (operationId) => {
          try { const r = await api.AllocationReviewHistory({ companyId, operationId }); return [operationId, r?.history || []] as const; }
          catch { return [operationId, []] as const; }
        }));
        setHistory(Object.fromEntries(entries));
      }
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Ko‘rib chiqish ro‘yxati yuklanmadi');
    } finally { setLoading(false); }
  }, [companyId, canCancel]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const items = useMemo<ReviewItem[]>(() => {
    const byId = new Map<string, ReviewItem>();
    for (const row of serverRows) {
      byId.set(row.operationId, {
        operationId: row.operationId, commandType: row.commandType, payloadHash: row.payloadHash,
        payload: row.payload || {}, rawReason: row.reason, createdAt: row.recordedAt,
        issuedQty: row.issuedQty, modelName: row.modelName, local: null, onServer: true, corrected: Boolean(row.corrected)
      });
    }
    for (const row of localRows) {
      const existing = byId.get(row.operation_id);
      const payload = row.payload || existing?.payload || {};
      byId.set(row.operation_id, {
        operationId: row.operation_id,
        commandType: row.command_type || existing?.commandType || 'SubmitTicket',
        payloadHash: row.payload_hash,
        payload,
        rawReason: existing?.rawReason || parseReason(row),
        createdAt: row.created_at,
        issuedQty: existing?.issuedQty ?? null,
        modelName: existing?.modelName ?? null,
        local: row,
        onServer: Boolean(existing),
        corrected: Boolean(existing?.corrected)
      });
    }
    return [...byId.values()].map((item) => {
      if (item.issuedQty) return item;
      const party = (printedPartyHistory || []).find((h) => h.id === item.payload.partyRecordId);
      const issued = Number(party?.ishSoniPerPatta);
      return { ...item, issuedQty: Number.isSafeInteger(issued) && issued > 0 ? issued : null };
    }).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }, [serverRows, localRows, printedPartyHistory]);

  const retryAfterIssuance = async (operationId: string) => {
    const api = getElectronApi() as any;
    setLoading(true); setNotice(''); setError('');
    try {
      const result = await api?.AllocationReviewRetry?.({ companyId, operationId });
      if (!result?.success) throw new Error(errorText(result, 'Qayta yuborish uchun chiqarish hali tasdiqlanmagan'));
      const dispatch = await api?.SyncDispatch?.(companyId);
      await refresh();
      setNotice(dispatch?.success === false
        ? 'Buyruq navbatga qaytdi. Server tasdig‘i kelmaguncha holat ochiq qoladi.'
        : 'Buyruq qayta yuborildi. Yechim faqat server tasdig‘idan keyin ko‘rinadi.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Qayta yuborish amalga oshmadi');
    } finally { setLoading(false); }
  };

  const confirmCancel = async (item: ReviewItem) => {
    const reason = cancelReason.trim();
    if (!reason) { setError('Bekor qilish sababini yozing.'); return; }
    const api = getElectronApi() as any;
    setLoading(true); setNotice(''); setError('');
    try {
      // Work held on this PC keeps its durable cancellation intent; work held
      // on another PC is cancelled from the server's own evidence.
      const result = item.local?.status === 'CONFLICT'
        ? await api?.AllocationReviewCancel?.({ companyId, operationId: item.operationId, reason })
        : await api?.AllocationReviewServerCancel?.({ companyId, operationId: item.operationId, payloadHash: item.payloadHash,
          payload: item.payload, commandType: item.commandType, reason });
      if (!result?.success) {
        if (OPERATOR_REQUIRED_CODES.includes(result?.code)) setServerAccess('operator_required');
        throw new Error(errorText(result, 'Bekor qilish so‘rovi yuborilmadi'));
      }
      if (result.status === 'CANCELLED') {
        setNotice(item.local
          ? 'Server bekor qilishni tasdiqladi. Patta endi to‘g‘ri miqdor bilan qayta kiritilishi mumkin.'
          : 'Server bekor qilishni tasdiqladi. Yozuvni kiritgan kompyuter keyingi sinxronda uni avtomatik o‘chiradi; keyin patta to‘g‘ri miqdor bilan qayta kiritiladi.');
      } else {
        setNotice('Bekor qilish so‘rovi qurilmada saqlandi; server tasdig‘ini kutmoqda.');
      }
      setCancelingId(null); setCancelReason('');
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Bekor qilish amalga oshmadi'); }
    finally { setLoading(false); }
  };

  const signOut = async () => {
    const api = getElectronApi() as any;
    try { await api?.OperatorRevoke?.(companyId); } catch { /* local session is cleared by main on success only */ }
    setServerAccess('operator_required');
    setServerRows([]);
  };

  const accessBlock = canCancel ? (
    serverAccess === 'operator_required'
      ? <OperatorLoginForm companyId={companyId} onSignedIn={() => { setNotice('Operator sifatida kirildi.'); void refresh(); }} />
      : serverAccess === 'error'
        ? <p role="alert" style={{ margin: '12px 20px', color: '#b91c1c' }}>Serverdan boshqa kompyuterlardagi yozuvlar olinmadi: {serverError}. Faqat shu kompyuterdagi yozuvlar ko‘rsatilmoqda.</p>
        : serverAccess === 'unsupported'
          ? <p role="note" style={{ margin: '12px 20px', color: '#92400e' }}>Server eski versiyada: boshqa kompyuterlardagi yozuvlarni ko‘rsatib bo‘lmaydi. Serverni yangilang.</p>
          : serverAccess === 'ok' && variant === 'page'
            ? <div style={{ margin: '8px 20px 0', fontSize: 13, color: 'var(--text-muted, #64748b)' }}>
                Operator sifatida kirilgan. <button type="button" onClick={() => void signOut()} style={{ marginLeft: 6 }}>Chiqish</button>
              </div>
            : null
  ) : null;

  if (items.length === 0 && !error && !notice) {
    if (variant !== 'page') return accessBlock;
    return <>
      {accessBlock}
      {serverAccess !== 'operator_required' && <section aria-label="Taqsimot nizolarini ko‘rib chiqish" style={{ margin: '12px 20px', padding: 24, border: '1px dashed var(--border-subtle, #cbd5e1)', borderRadius: 10, textAlign: 'center', color: 'var(--text-muted, #64748b)' }}>
        {loading ? 'Yuklanmoqda…' : 'Ko‘rib chiqish talab qiladigan patta yo‘q.'}
      </section>}
    </>;
  }
  const openCount = items.filter((item) => item.local?.status !== 'SUPERSEDED').length;

  return <>{accessBlock}<section aria-label="Taqsimot nizolarini ko‘rib chiqish" style={{ margin: '12px 16px', padding: 16, border: '1px solid #f0c36d', borderRadius: 10, background: '#fffbeb' }}>
    <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <AlertTriangle size={18} aria-hidden="true" />
      <strong>Patta taqsimoti — ko‘rib chiqish talab qilinadi{openCount ? ` (${openCount})` : ''}</strong>
      <button type="button" onClick={() => void refresh()} disabled={loading} style={{ marginLeft: 'auto' }} aria-label="Holatni yangilash"><RefreshCw size={16} /></button>
    </header>
    <p style={{ margin: '6px 0 0', fontSize: 13, color: '#92400e' }}>
      {canCancel
        ? 'Server bu pattalarni qabul qilmadi. Tekshirib, «Bekor qilish» tugmasini bosing — keyin patta to‘g‘ri ma’lumot bilan qayta kiritiladi.'
        : 'Server bu pattalarni qabul qilmadi. Pattani «Patta» oynasida to‘g‘ri miqdor bilan qayta jo‘natsangiz, eski yozuv almashtiriladi. Server yozuvini faqat admin yoki hisobchi bekor qila oladi.'}
    </p>
    {error && <p role="alert" style={{ color: '#b91c1c' }}>{error}</p>}
    {notice && <p role="status" style={{ color: '#047857' }}>{notice}</p>}
    {items.map((item) => {
      const p = item.payload;
      const row = item.local;
      const cancelled = row?.status === 'SUPERSEDED';
      const pendingCancel = row?.cancellation_status === 'PENDING';
      const model = models.find((m) => m.id === p.modelId);
      const entries: any[] = Array.isArray(p.entries) ? p.entries : [];
      const qtyMismatch = item.issuedQty !== null && Number(p.qty) !== item.issuedQty;
      return <article key={item.operationId} style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid #f0c36d', opacity: cancelled ? 0.65 : 1 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'baseline' }}>
          <b style={{ fontSize: 15 }}>{model?.name || item.modelName || 'Model'} · Partiya {p.partyNumber ?? '?'} · Patta {p.pattaNumber ?? '?'}{p.size ? ` · ${p.size}` : ''}</b>
          <span style={{ fontSize: 13, color: '#78350f' }}>
            {cancelled ? 'Bekor qilingan' : pendingCancel ? 'Bekor qilish server tasdig‘ini kutmoqda' : 'Ko‘rib chiqilmoqda'}
            {item.onServer && !row ? ' · boshqa kompyuterdan' : ''}
          </span>
        </div>
        <div style={{ marginTop: 4 }}>
          <b>Ish soni:</b> <span style={{ color: qtyMismatch ? '#b91c1c' : undefined, fontWeight: qtyMismatch ? 700 : undefined }}>{p.qty ?? '?'} dona</span>
          {item.issuedQty !== null && <> · <b>Chiqarilgan:</b> {item.issuedQty} dona</>}
          {item.commandType === 'UpdateTicket' && <> · <i>(tahrirlash)</i></>}
        </div>
        <div><b>Sabab:</b> {describeReviewReason(item.rawReason, p.qty, item.issuedQty)}</div>
        {item.corrected && !cancelled && <div style={{ color: '#047857', fontWeight: 600 }}>
          Bu patta to‘g‘ri ma’lumot bilan qayta kiritilgan va server qabul qilgan — eski yozuvni bekor qilish mumkin.
        </div>}
        {row?.cancellation_status === 'REJECTED' && <p role="alert">Bekor qilish rad etildi ({row.cancellation_result?.code || 'SERVER_REJECTED'}): {row.cancellation_result?.message || 'Server sababni qaytarmadi'}. Asl ish ko‘rib chiqishda qoladi; zarur bo‘lsa vakolatli tuzatish yo‘lini tanlang.</p>}
        {entries.length > 0 && <table style={{ marginTop: 6, borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr><th style={{ textAlign: 'left', paddingRight: 16 }}>Operatsiya</th><th style={{ textAlign: 'left', paddingRight: 16 }}>Ishchi</th><th style={{ textAlign: 'right' }}>Dona</th></tr></thead>
          <tbody>{entries.map((e, index) => <tr key={`${e.opName}-${e.workerId}-${index}`}>
            <td style={{ paddingRight: 16 }}>{e.opName || '—'}</td>
            <td style={{ paddingRight: 16 }}>{e.workerNameSnapshot ? `${e.workerNameSnapshot} (${e.workerId})` : e.workerId ?? '—'}</td>
            <td style={{ textAlign: 'right' }}>{e.qty ?? p.qty ?? '—'}</td>
          </tr>)}</tbody>
        </table>}
        <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {row?.status === 'CONFLICT' && row.depends_on_operation_id && <button type="button" disabled={loading} onClick={() => void retryAfterIssuance(item.operationId)}>
            Asl chiqarish serverda qabul qilingan bo‘lsa, qayta yuborish
          </button>}
          {canCancel && !cancelled && !row?.cancellation_status && cancelingId !== item.operationId
            && <button type="button" disabled={loading} onClick={() => { setCancelingId(item.operationId); setCancelReason(''); setError(''); }}>
              Bekor qilish
            </button>}
        </div>
        {cancelingId === item.operationId && <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <textarea aria-label="Bekor qilish sababi" placeholder="Sabab, masalan: ish soni xato kiritilgan (409 o‘rniga 410)"
            value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} rows={2} style={{ minWidth: 320, flex: 1 }} autoFocus />
          <button type="button" disabled={loading || !cancelReason.trim()} onClick={() => void confirmCancel(item)}>Tasdiqlash</button>
          <button type="button" disabled={loading} onClick={() => { setCancelingId(null); setCancelReason(''); }} aria-label="Yopish"><X size={14} /></button>
        </div>}
        <details style={{ marginTop: 6 }}><summary>Texnik tafsilotlar</summary>
          <div style={{ fontSize: 12 }}><b>Amaliyot:</b> {item.operationId} · <b>Ro‘yxat vaqti:</b> {item.createdAt}</div>
          {row?.depends_on_operation_id && <div style={{ fontSize: 12 }}><b>Bloklangan ota-amaliyot:</b> {row.depends_on_operation_id}</div>}
          <div style={{ fontSize: 12 }}><b>Server sababi:</b> {item.rawReason}</div>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 11 }}>{JSON.stringify({ payload: p, payloadHash: item.payloadHash }, null, 2)}</pre>
        </details>
        {(history[item.operationId] || []).length > 0 && <details>
          <summary>Yechimlar tarixi ({history[item.operationId].length})</summary>
          {history[item.operationId].map((entry, index) => <p key={`${entry.resolutionOperationId}-${index}`}>
            {entry.action === 'CANCEL' ? 'Bekor qilindi' : entry.action} · {entry.reviewerId} · {entry.createdAt} · {entry.reason}
          </p>)}
        </details>}
      </article>;
    })}
  </section></>;
};
