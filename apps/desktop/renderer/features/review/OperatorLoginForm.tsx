import React, { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { getElectronApi } from '../../store/runtimeMode';

/**
 * Signs an admin/accountant server operator in on this device. Reviewing and
 * cancelling held allocations is authorized by this operator session, not by
 * the desktop role alone. The session lasts 8 hours on this device.
 */
export const OperatorLoginForm: React.FC<{ companyId: string; onSignedIn: () => void; reason?: string }> = ({ companyId, onSignedIn, reason }) => {
  const [operatorId, setOperatorId] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const api = getElectronApi() as any;
    if (typeof api?.OperatorLogin !== 'function') { setError('Bu versiyada operator kirishi mavjud emas.'); return; }
    setBusy(true); setError('');
    try {
      const result = await api.OperatorLogin(companyId, operatorId.trim(), password);
      if (!result?.success) {
        const code = result?.code || '';
        setError(code === 'OPERATOR_LOGIN_THROTTLED'
          ? 'Juda ko‘p noto‘g‘ri urinish. Birozdan keyin qayta urinib ko‘ring.'
          : code === 'OPERATOR_AUTH_REJECTED'
            ? 'Login yoki parol noto‘g‘ri, yoki operator bu kompaniyaga tegishli emas.'
            : (typeof result?.error === 'string' ? result.error : 'Kirish amalga oshmadi.'));
        return;
      }
      setPassword('');
      onSignedIn();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Kirish amalga oshmadi.');
    } finally { setBusy(false); }
  };

  return (
    <form onSubmit={(e) => void submit(e)} aria-label="Operator sifatida kirish"
      style={{ margin: '12px 20px', padding: 16, border: '1px solid #93c5fd', borderRadius: 10, background: '#eff6ff', color: '#1e3a8a' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <KeyRound size={18} aria-hidden="true" />
        <strong>Admin / hisobchi sifatida kiring</strong>
      </div>
      <p style={{ margin: '6px 0 10px', fontSize: 13 }}>
        {reason || 'Boshqa kompyuterlardagi pattalarni ko‘rish va bekor qilish uchun server operatori login va paroli kerak. Sessiya shu kompyuterda 8 soat amal qiladi.'}
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input aria-label="Operator login" placeholder="Login" value={operatorId} autoComplete="username"
          onChange={(e) => setOperatorId(e.target.value)} disabled={busy} style={{ minWidth: 180 }} />
        <input aria-label="Operator paroli" placeholder="Parol" type="password" value={password} autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)} disabled={busy} style={{ minWidth: 180 }} />
        <button type="submit" disabled={busy || !operatorId.trim() || !password}>{busy ? 'Tekshirilmoqda…' : 'Kirish'}</button>
      </div>
      {error && <p role="alert" style={{ color: '#b91c1c', margin: '8px 0 0' }}>{error}</p>}
    </form>
  );
};
