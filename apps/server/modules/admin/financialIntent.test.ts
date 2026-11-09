import { describe, expect, it } from 'vitest';

const { create } = require('../../static/admin-webapp/financial-intent.js');
const scope = { actor: '123456789', companyId: 'synthetic-a', kind: 'quick-adjustment' };
const draft = { workerId: 8, periodId: 'R', type: 'JARIMA', amountDelta: 3, description: 'fixture' };
const body = (id: string) => ({ operationId: id, commandId: `command-${id}`, baseRevision: 1,
  adjustment: { adjustmentId: `adjustment-${id}`, periodId: 'R', amountDelta: 3 } });

function storage() {
  const contents = new Map<string, string>();
  return { contents, getItem: (key: string) => contents.get(key) ?? null,
    setItem: (key: string, value: string) => { contents.set(key, value); },
    removeItem: (key: string) => { contents.delete(key); } };
}

describe('durable financial intent fencing', () => {
  it('retains unknown outcomes across instances, fences stale completion, and requires explicit acknowledgement for the same draft', async () => {
    const shared = storage();
    const intents = create(shared);
    const first = await intents.prepare(scope, draft, async () => body('one'));
    intents.attempt(scope, first.body.operationId);
    intents.uncertain(scope, first.body.operationId);
    const reopened = create(shared);
    const replay = await reopened.prepare(scope, draft, async () => { throw new Error('must not rebuild'); });
    expect(replay.body).toEqual(first.body);
    expect(() => reopened.reject(scope, first.body.operationId, 409)).not.toThrow();
    expect(reopened.pending(scope)?.body).toEqual(first.body);
    reopened.complete(scope, first.body.operationId);
    await expect(reopened.prepare(scope, draft, async () => body('unexpected'))).rejects.toThrow('FINANCIAL_INTENT_ALREADY_COMPLETED');
    expect(() => reopened.acknowledge(scope, draft, null)).toThrow('FINANCIAL_INTENT_INVALID');
    expect(reopened.pending(scope)?.resolved).toBe(true);
    const next = reopened.acknowledge(scope, draft, body('two'));
    expect(() => intents.complete(scope, first.body.operationId)).toThrow('FINANCIAL_INTENT_CHANGED');
    expect(reopened.pending(scope)?.body).toEqual(next.body);
    expect(shared.contents.size).toBe(1);
    expect(reopened.pending({ ...scope, actor: '987654321' })).toBeNull();
    expect(reopened.pending({ ...scope, companyId: 'synthetic-b' })).toBeNull();
  });

  it('fails closed on durable storage or cross-tab coordination failure', async () => {
    const unavailable = { getItem() { throw new Error('storage disabled'); }, setItem() { throw new Error('storage disabled'); }, removeItem() { throw new Error('storage disabled'); } };
    await expect(create(unavailable).prepare(scope, draft, async () => body('one'))).rejects.toThrow('storage disabled');
    await expect(create(storage()).run(scope, async () => body('one'))).rejects.toThrow('FINANCIAL_INTENT_COORDINATION_UNAVAILABLE');
  });
});
