import { describe, expect, it } from 'vitest';

const { readCompanySnapshot } = require('./bootstrapSnapshot.cjs');

describe('company bootstrap projection', () => {
  it('preserves imported production-adjustment provenance for client projections', async () => {
    const provenance = 'REMOTE_BOOTSTRAP';
    const client = {
      query: async (sql: string) => {
        if (/FROM production_adjustments/i.test(sql)) {
          expect(sql).toMatch(/original_adjustment_id, provenance/i);
          return {
            rows: [{
              adjustment_id: 'adjustment-a', company_id: 'comp_novda', model_id: 'model-a',
              worker_id: 1, op_name: 'Sew', delta_qty: '4', reason: 'Imported',
              status: 'APPROVED', server_revision: 1, created_at: '2026-10-01T00:00:00.000Z',
              created_by: 'operator', original_adjustment_id: null, provenance
            }]
          };
        }
        return { rows: [] };
      }
    };

    const { snapshot } = await readCompanySnapshot(client, 'comp_novda');
    expect(snapshot.productionAdjustments).toEqual([expect.objectContaining({
      adjustmentId: 'adjustment-a', provenance
    })]);
  });

  it('returns the authoritative next patta number independently of closed history', async () => {
    const client = {
      query: async (sql: string) => {
        if (/FROM company_patta_sequences/i.test(sql)) return { rows: [{ next_patta_number: '13' }] };
        return { rows: [] };
      }
    };

    const result = await readCompanySnapshot(client, 'comp_novda');
    expect(result.nextPattaNumber).toBe(13);
  });

  it('includes active persisted Party collision provenance in the bootstrap snapshot', async () => {
    const client = {
      query: async (sql: string) => {
        if (/FROM legacy_party_collision_exceptions/i.test(sql)) {
          expect(sql).toMatch(/status = 'ACTIVE'/i);
          return {
            rows: [
              {
                exception_id: 'exception-a', company_id: 'comp_novda', party_number: '2', party_id: 'party-a',
                collision_group_id: 'collision-2', approved_by: 'OWNER_BUSINESS_DECISION',
                approved_at: '2026-10-01T00:00:00.000Z', reason: 'Preserve historical pair',
                status: 'ACTIVE', created_at: '2026-10-01T00:00:00.000Z'
              },
              {
                exception_id: 'exception-b', company_id: 'comp_novda', party_number: '2', party_id: 'party-b',
                collision_group_id: 'collision-2', approved_by: 'OWNER_BUSINESS_DECISION',
                approved_at: '2026-10-01T00:00:00.000Z', reason: 'Preserve historical pair',
                status: 'ACTIVE', created_at: '2026-10-01T00:00:00.000Z'
              }
            ]
          };
        }
        return { rows: [] };
      }
    };

    const result = await readCompanySnapshot(client, 'comp_novda');
    expect(result.snapshot.legacyPartyCollisionExceptions).toHaveLength(2);
    expect(result.snapshot.legacyPartyCollisionExceptions[0]).toMatchObject({
      exceptionId: 'exception-a', partyNumber: '2', partyId: 'party-a', collisionGroupId: 'collision-2'
    });
    expect(result.counts.legacyPartyCollisionExceptions).toBe(2);
  });
});
