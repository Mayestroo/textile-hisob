/* A financial write is one intent, including its original revision and dedup IDs. */
((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NovdaFinancialIntent = api;
})(typeof window === 'undefined' ? globalThis : window, () => {
  const prefix = 'novda-admin-financial-intent-v1:';
  function create(storage, locks) {
    if (!storage || !['getItem', 'setItem', 'removeItem'].every(method => typeof storage[method] === 'function'))
      throw new Error('FINANCIAL_INTENT_STORAGE_UNAVAILABLE');
    const key = (scope) => {
      if (!/^\d{1,24}$/.test(String(scope.actor || '')) || !scope.companyId || !['quick-adjustment', 'company-advance'].includes(scope.kind))
        throw new Error('FINANCIAL_INTENT_SCOPE_INVALID');
      return prefix + JSON.stringify([String(scope.actor), scope.companyId]);
    };
    async function run(scope, action) {
      if (typeof locks?.request !== 'function') throw new Error('FINANCIAL_INTENT_COORDINATION_UNAVAILABLE');
      return locks.request(key(scope), { mode: 'exclusive' }, action);
    }
    function pending(scope) {
      const raw = storage.getItem(key(scope));
      if (!raw) return null;
      try {
        const record = JSON.parse(raw);
        if (record.version !== 1 || record.actor !== String(scope.actor) || record.companyId !== scope.companyId
          || !['quick-adjustment', 'company-advance'].includes(record.kind) || !record.draft
          || (record.resolved !== true && (!record.body || !record.body.adjustment
            || !record.body.operationId || !record.body.commandId || !record.body.adjustment.adjustmentId)))
          throw new Error('invalid record');
        return record;
      } catch { throw new Error('FINANCIAL_INTENT_RECOVERY_REQUIRED'); }
    }
    async function prepare(scope, draft, build) {
      const existing = pending(scope);
      if (existing) {
        if (existing.resolved) {
          if (JSON.stringify(existing.draft) === JSON.stringify(draft)) throw new Error('FINANCIAL_INTENT_ALREADY_COMPLETED');
        } else {
          if (existing.kind !== scope.kind) throw new Error('FINANCIAL_INTENT_PENDING');
          if (JSON.stringify(existing.draft) !== JSON.stringify(draft)) throw new Error('FINANCIAL_INTENT_PENDING');
          return existing;
        }
      }
      const body = await build();
      const record = { version: 1, actor: String(scope.actor), companyId: scope.companyId, kind: scope.kind,
        draft, body, uncertain: false, attempts: 0 };
      storage.setItem(key(scope), JSON.stringify(record)); // Fail closed if the intent cannot survive a reload.
      if (storage.getItem(key(scope)) !== JSON.stringify(record)) throw new Error('FINANCIAL_INTENT_STORAGE_UNAVAILABLE');
      return record;
    }
    function attempt(scope, operationId) {
      const record = pending(scope);
      if (!record || record.resolved || record.body.operationId !== operationId) throw new Error('FINANCIAL_INTENT_CHANGED');
      const updated = { ...record, attempts: record.attempts + 1 };
      storage.setItem(key(scope), JSON.stringify(updated));
      if (storage.getItem(key(scope)) !== JSON.stringify(updated)) throw new Error('FINANCIAL_INTENT_STORAGE_UNAVAILABLE');
      return updated;
    }
    function uncertain(scope, operationId) {
      const record = pending(scope);
      if (record?.body?.operationId === operationId) storage.setItem(key(scope), JSON.stringify({ ...record, uncertain: true }));
    }
    function complete(scope, operationId) {
      const record = pending(scope);
      if (!record || record.resolved || record.body.operationId !== operationId) throw new Error('FINANCIAL_INTENT_CHANGED');
      // Keep a small resolved marker so a stale tab cannot silently issue a second identical write.
      storage.setItem(key(scope), JSON.stringify({ version: 1, actor: record.actor, companyId: record.companyId,
        kind: record.kind, draft: record.draft, resolved: true, operationId }));
    }
    function acknowledge(scope, draft, body) {
      const record = pending(scope);
      if (!record?.resolved || JSON.stringify(record.draft) !== JSON.stringify(draft))
        throw new Error('FINANCIAL_INTENT_CHANGED');
      if (!body?.operationId || !body?.commandId || !body?.adjustment?.adjustmentId)
        throw new Error('FINANCIAL_INTENT_INVALID');
      // Replace the marker only after building the new body; a failed build must keep the marker.
      const next = { version: 1, actor: record.actor, companyId: record.companyId, kind: scope.kind,
        draft, body, uncertain: false, attempts: 0 };
      storage.setItem(key(scope), JSON.stringify(next));
      if (storage.getItem(key(scope)) !== JSON.stringify(next)) throw new Error('FINANCIAL_INTENT_STORAGE_UNAVAILABLE');
      return next;
    }
    function reject(scope, operationId, status) {
      const record = pending(scope);
      // A prior lost response can have committed before a later rejection. Keep its original intent.
      if (record?.body?.operationId === operationId && record.attempts === 1 && !record.uncertain
        && [400, 404, 409, 422].includes(status)) {
        storage.removeItem(key(scope));
        if (storage.getItem(key(scope)) !== null) throw new Error('FINANCIAL_INTENT_STORAGE_UNAVAILABLE');
      }
    }
    return { pending, prepare, attempt, uncertain, complete, acknowledge, reject, run };
  }
  return { create };
});
