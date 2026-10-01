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
});
