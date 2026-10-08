import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const databaseManager = require('../database/databaseManager.cjs');
const { applyChangesBatch, getLocalCursor } = require('./changeFeedApplier.cjs');

describe(' workbook change-feed application', () => {
  let userData: string;
  const companyId = 'company_change_feed';

  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'novda-change-feed-'));
  });

  afterEach(() => {
    databaseManager.closeAllCompanyDatabases();
    fs.rmSync(userData, { recursive: true, force: true });
  });

  it('applies model, worker, period, party, ticket, and batch settings idempotently with one cursor commit', () => {
    const db = databaseManager.getCompanyDatabase(userData, companyId);
    const items: any[] = [
      {
        changeId: '1', companyId, entityType: 'model', entityId: 'model-a', entityRevision: 1, changeType: 'INSERT',
        payload: { modelId: 'model-a', name: 'Model A', operations: [{ id: 'op-cut', name: 'Cut', rate: 5 }], pattaOpsOrder: ['Cut'] }
      },
      {
        changeId: '2', companyId, entityType: 'period', entityId: 'period-a', entityRevision: 1, changeType: 'INSERT',
        payload: { periodId: 'period-a', name: 'September', startDate: '2026-09-01', isClosed: false }
      },
      {
        changeId: '3', companyId, entityType: 'worker', entityId: '71', entityRevision: 1, changeType: 'INSERT',
        payload: { workerId: 71, name: 'Worker A', staj: 2, role: 'Sewing', status: 'ACTIVE', balanceAdjustments: [
          { adjustmentId: 'adjustment-a', type: 'AVANS', amountDelta: 25, periodId: 'period-a', description: 'Opening' }
        ] }
      },
      {
        changeId: '4', companyId, entityType: 'party', entityId: 'party-a', entityRevision: 1, changeType: 'INSERT',
        payload: { partyRecordId: 'party-a', partyNumber: '12', modelId: 'model-a', modelName: 'Model A', color: 'Qora',
          pattaCount: 1, cumulativePattaCount: 1, ishSoniPerPatta: 10, totalIshSoni: 10, ishSoni: 10,
          cumulativeIshSoni: 10, sizes: { M: 1 }, printedAt: '2026-09-23T10:00:00.000Z' }
      },
      {
        changeId: '5', companyId, entityType: 'ticket', entityId: '00000000-0000-4000-8000-000000000501',
        entityRevision: 1, changeType: 'INSERT',
        payload: { ticketId: '00000000-0000-4000-8000-000000000501', modelId: 'model-a', periodId: 'period-a',
          partyNumber: '12', partyRecordId: 'party-a', pattaNumber: 1, qty: 10, submittedAt: '2026-09-23T10:00:00.000Z',
          entries: [{ opName: 'Cut', workerId: 71, workerNameSnapshot: 'Worker A', rateSnapshot: 5 }] }
      },
      {
        changeId: '6', companyId, entityType: 'batch_settings', entityId: companyId, entityRevision: 1, changeType: 'UPDATE',
        payload: { companyId, availableSizes: ['M', 'L'], configs: [{ modelId: 'model-a', partyNumber: '12', isCustomParty: true,
          totalIshSoni: '10', color: 'Qora', sizes: { M: '1', L: '' } }] }
      },
      { changeId: '7', companyId, entityType: 'patta_batch', entityId: 'batch-a', entityRevision: 1, changeType: 'INSERT', payload: { batchId: 'batch-a' } },
      { changeId: '8', companyId, entityType: 'period_archive', entityId: 'period-a', entityRevision: 1, changeType: 'INSERT', payload: { periodId: 'period-a', sha256: 'a'.repeat(64) } },
      { changeId: '9', companyId, entityType: 'model', entityId: 'model-a', entityRevision: 2, changeType: 'UPDATE',
        payload: { modelId: 'model-a', name: 'Model A', operations: [{ id: 'op-cut', name: 'Sew', rate: 5 }], pattaOpsOrder: ['Sew'], operationRenames: [{ fromName: 'Cut', toName: 'Sew' }] } }
    ];

    items.push({
      changeId: '10', companyId, entityType: 'ticket', entityId: '00000000-0000-4000-8000-000000000501',
      entityRevision: 2, changeType: 'UPDATE', payload: {
        ticketId: '00000000-0000-4000-8000-000000000501', status: 'VOIDED',
        entries: [{ entryId: 'edited-entry', opName: 'Sew', workerId: 71, workerNameSnapshot: 'Worker A', rateSnapshot: 8, qty: 10 }]
      }
    });
    const applied = applyChangesBatch(db, companyId, items, '10');
    expect(applied).toEqual({ appliedCount: 10, nextCursor: 10 });
    expect(getLocalCursor(db)).toBe(10);
    expect(db.prepare('SELECT name FROM models WHERE company_id = ? AND id = ?').get(companyId, 'model-a').name).toBe('Model A');
    expect(db.prepare('SELECT SUM(amount) AS amount FROM worker_adjustments WHERE company_id = ? AND worker_id = 71').get(companyId).amount).toBe(25);
    expect(db.prepare('SELECT period_id FROM tickets WHERE company_id = ?').get(companyId).period_id).toBe('period-a');
    expect(db.prepare('SELECT status FROM tickets WHERE company_id = ?').get(companyId).status).toBe('VOIDED');
    expect(db.prepare('SELECT op_name FROM ticket_entries WHERE company_id = ?').get(companyId).op_name).toBe('Sew');
    expect(db.prepare('SELECT id, rate_snapshot FROM ticket_entries WHERE company_id = ?').get(companyId))
      .toEqual({ id: 'edited-entry', rate_snapshot: 8 });
    expect(db.prepare('SELECT available_sizes_json FROM company_batch_settings WHERE company_id = ?').get(companyId).available_sizes_json).toBe('["M","L"]');

    const replay = applyChangesBatch(db, companyId, items, '10');
    expect(replay.appliedCount).toBe(10);
    expect(db.prepare('SELECT COUNT(*) AS count FROM tickets WHERE company_id = ?').get(companyId).count).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM worker_adjustments WHERE company_id = ?').get(companyId).count).toBe(1);
  });

  it('replaces a stale local ticket period with the server-authoritative period on replay', () => {
    const db = databaseManager.getCompanyDatabase(userData, companyId);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO models (id, company_id, name, operations_json, created_at, updated_at)
      VALUES ('model-period-replay', ?, 'Model', '[]', ?, ?)`).run(companyId, now, now);
    db.prepare(`INSERT INTO periods (id, company_id, name, start_date, is_closed, status, created_at)
      VALUES ('period-local-old', ?, 'Old', '2026-08-01', 1, 'CLOSED', ?),
             ('period-server-current', ?, 'Current', '2026-09-01', 0, 'OPEN', ?)`)
      .run(companyId, now, companyId, now);
    const ticketId = '00000000-0000-4000-8000-000000001401';
    db.prepare(`INSERT INTO tickets (
      id, company_id, model_id, period_id, party_number, patta_number, qty, status, submitted_at, created_at
    ) VALUES (?, ?, 'model-period-replay', 'period-local-old', '1', 1, 1, 'PENDING_SYNC', ?, ?)`)
      .run(ticketId, companyId, now, now);

    applyChangesBatch(db, companyId, [{
      changeId: '1', companyId, entityType: 'ticket', entityId: ticketId, entityRevision: 1,
      changeType: 'INSERT', payload: {
        ticketId, modelId: 'model-period-replay', periodId: 'period-server-current', partyNumber: '1',
        pattaNumber: 1, qty: 1, submittedAt: now, entries: []
      }
    }], '1');

    expect(db.prepare('SELECT period_id, status FROM tickets WHERE company_id = ? AND id = ?')
      .get(companyId, ticketId)).toEqual({ period_id: 'period-server-current', status: 'CONFIRMED' });
  });

  it('archives parties by flag while retaining the canonical fact row', () => {
    const db = databaseManager.getCompanyDatabase(userData, companyId);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO models (id, company_id, name, operations_json, created_at, updated_at)
      VALUES ('model-a', ?, 'Model A', '[]', ?, ?)`)
      .run(companyId, now, now);
    db.prepare(`INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, status, created_at, updated_at)
      VALUES ('party-a', ?, '12', '12', 'model-a', 'ACTIVE', ?, ?)`)
      .run(companyId, now, now);

    applyChangesBatch(db, companyId, [{
      changeId: '1', companyId, entityType: 'party', entityId: 'party-a', entityRevision: 2, changeType: 'UPDATE',
      payload: { partyRecordId: 'party-a', status: 'CLOSED', isClosed: true, isArchived: true, closedAt: now }
    }], '1');

    expect(db.prepare('SELECT status, is_closed, is_archived FROM parties WHERE company_id = ? AND id = ?').get(companyId, 'party-a'))
      .toEqual({ status: 'CLOSED', is_closed: 1, is_archived: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM parties WHERE company_id = ? AND is_archived = 0').get(companyId).count).toBe(0);
  });

  it('resets the local patta sequence when a completed series is received', () => {
    const db = databaseManager.getCompanyDatabase(userData, companyId);
    db.prepare(`INSERT INTO company_patta_sequences(company_id, next_patta_number, updated_at)
      VALUES (?, 578, ?)`).run(companyId, new Date().toISOString());

    const result = applyChangesBatch(db, companyId, [{
      changeId: '1', companyId, entityType: 'party_series', entityId: 'period-a',
      entityRevision: 1, changeType: 'UPDATE',
      payload: { periodId: 'period-a', partiesClosed: 2, ticketsClosed: 12, pattaSequenceReset: true, nextPattaNumber: 1 }
    }], '1');

    expect(result.appliedCount).toBe(1);
    expect(db.prepare('SELECT next_patta_number FROM company_patta_sequences WHERE company_id = ?').get(companyId))
      .toEqual({ next_patta_number: 1 });
  });

  it('reconciles a stale local sequence to the VPS high-water mark even when no changes are pending', () => {
    const db = databaseManager.getCompanyDatabase(userData, companyId);
    db.prepare(`INSERT INTO company_patta_sequences(company_id, next_patta_number, updated_at)
      VALUES (?, 578, ?)`).run(companyId, new Date().toISOString());

    const result = applyChangesBatch(db, companyId, [], '0', { nextPattaNumber: 13 });

    expect(result.appliedCount).toBe(0);
    expect(db.prepare('SELECT next_patta_number FROM company_patta_sequences WHERE company_id = ?').get(companyId))
      .toEqual({ next_patta_number: 13 });
  });

  it('applies the party, batch-settings, and patta-batch feed sequence after cursor 628', () => {
    const db = databaseManager.getCompanyDatabase(userData, companyId);
    const now = new Date().toISOString();
    const modelIds = Array.from({ length: 20 }, (_, index) => `model-${index + 1}`);
    const insertModel = db.prepare(`INSERT INTO models (id, company_id, name, operations_json, created_at, updated_at)
      VALUES (?, ?, ?, '[]', ?, ?)`);
    for (const [index, modelId] of modelIds.entries()) {
      insertModel.run(modelId, companyId, `Model ${index + 1}`, now, now);
    }

    const items: any[] = [
      {
        changeId: '629', companyId, entityType: 'party', entityId: 'party-series-1',
        entityRevision: 1, changeType: 'INSERT',
        payload: {
          partyRecordId: 'party-series-1', partyNumber: '1', physicalPartyNumber: '1', modelId: modelIds[0],
          modelName: 'Model 1', color: 'Qora', pattaCount: 12, cumulativePattaCount: 12,
          pattaStartNumber: 1, pattaEndNumber: 12, ishSoniPerPatta: 1, totalIshSoni: 12,
          ishSoni: 0, cumulativeIshSoni: 0, sizes: { M: 12 }, printedAt: now
        }
      },
      {
        changeId: '630', companyId, entityType: 'batch_settings', entityId: companyId,
        entityRevision: 337, changeType: 'UPDATE',
        payload: {
          companyId,
          availableSizes: ['S', 'M'],
          serverRevision: 337,
          configs: modelIds.map((modelId, index) => ({
            modelId,
            partyNumber: String(index + 1),
            isCustomParty: false,
            totalIshSoni: '12',
            color: 'Qora',
            sizes: { S: '', M: '12' }
          }))
        }
      },
      {
        changeId: '631', companyId, entityType: 'patta_batch', entityId: 'batch-series-1',
        entityRevision: 1, changeType: 'INSERT',
        payload: { batchId: 'batch-series-1', parties: ['party-series-1'] }
      }
    ];

    const applied = applyChangesBatch(db, companyId, items, '631', { nextPattaNumber: 13 });

    expect(applied).toEqual({ appliedCount: 3, nextCursor: 631 });
    expect(db.prepare('SELECT status, patta_end_number FROM parties WHERE company_id = ? AND id = ?')
      .get(companyId, 'party-series-1')).toEqual({ status: 'ACTIVE', patta_end_number: 12 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM patta_batch_settings WHERE company_id = ?')
      .get(companyId)).toEqual({ count: 20 });
    expect(db.prepare('SELECT next_patta_number FROM company_patta_sequences WHERE company_id = ?')
      .get(companyId)).toEqual({ next_patta_number: 13 });
  });

  it('resolves an in-flight old model ID to its canonical UUID without creating a duplicate model', () => {
    const db = databaseManager.getCompanyDatabase(userData, companyId);
    const now = new Date().toISOString();
    const canonicalId = '00000000-0000-4000-8000-000000000111';
    db.prepare(`INSERT INTO models (id, company_id, name, operations_json, created_at, updated_at)
      VALUES (?, ?, 'Model A', '[]', ?, ?)`).run(canonicalId, companyId, now, now);
    db.prepare(`INSERT INTO model_id_aliases(company_id, legacy_model_id, canonical_model_id, created_at)
      VALUES (?, ?, ?, ?)`).run(companyId, 'Model A', canonicalId, now);

    applyChangesBatch(db, companyId, [{
      changeId: '10', companyId, entityType: 'model', entityId: 'Model A',
      entityRevision: 2, changeType: 'UPDATE',
      payload: { modelId: 'Model A', name: 'Model A', operations: [{ id: 'op-1', name: 'Sew', rate: 4 }], pattaOpsOrder: ['Sew'] }
    }], '10');

    expect(db.prepare('SELECT id, server_revision FROM models WHERE company_id = ?').all(companyId))
      .toEqual([{ id: canonicalId, server_revision: 2 }]);
  });

  it('applies a full quantity correction to a closed party without reopening or unarchiving it', () => {
    const db = databaseManager.getCompanyDatabase(userData, companyId);
    const now = '2026-09-24T10:00:00.000Z';
    const closedAt = '2026-09-20T08:00:00.000Z';
    const archivedNumbers = [2, 4];
    db.prepare(`INSERT INTO models (id, company_id, name, operations_json, created_at, updated_at)
      VALUES ('model-a', ?, 'Model A', '[]', ?, ?)`)
      .run(companyId, now, now);
    db.prepare(`INSERT INTO parties (
      id, company_id, party_number, physical_party_number, model_id, model_name, patta_count,
      cumulative_patta_count, ish_soni_per_patta, total_ish_soni, ish_soni, cumulative_ish_soni,
      is_closed, closed_at, archived_patta_numbers_json, status, created_at, updated_at, server_revision, is_archived
    ) VALUES ('party-a', ?, '12', '12', 'model-a', 'Model A', 9, 9, 12, 108, 108, 108,
      1, ?, ?, 'CLOSED', ?, ?, 4, 1)`)
      .run(companyId, closedAt, JSON.stringify(archivedNumbers), now, now);

    applyChangesBatch(db, companyId, [{
      changeId: '1', companyId, entityType: 'party', entityId: 'party-a', entityRevision: 5, changeType: 'UPDATE',
      payload: {
        partyRecordId: 'party-a', partyNumber: '12', physicalPartyNumber: '12', modelId: 'model-a', modelName: 'Model A',
        pattaCount: 9, cumulativePattaCount: 9, ishSoniPerPatta: 108, totalIshSoni: 972, ishSoni: 972,
        cumulativeIshSoni: 972, sizes: { M: 9 }, printedAt: now, status: 'CLOSED', isClosed: true,
        closedAt: now, archivedPattaNumbers: [1, 2, 3, 4]
      }
    }], '1');

    expect(db.prepare(`SELECT patta_count, ish_soni_per_patta, total_ish_soni, ish_soni, cumulative_ish_soni,
      status, is_closed, closed_at, archived_patta_numbers_json, is_archived, server_revision
      FROM parties WHERE company_id = ? AND id = ?`).get(companyId, 'party-a'))
      .toEqual({
        patta_count: 9,
        ish_soni_per_patta: 108,
        total_ish_soni: 972,
        ish_soni: 972,
        cumulative_ish_soni: 972,
        status: 'CLOSED',
        is_closed: 1,
        closed_at: closedAt,
        archived_patta_numbers_json: JSON.stringify(archivedNumbers),
        is_archived: 1,
        server_revision: 5
      });
  });

  it('applies a full party feed update to an existing active row', () => {
    const db = databaseManager.getCompanyDatabase(userData, companyId);
    const now = '2026-10-07T05:00:00.000Z';
    db.prepare(`INSERT INTO models (id, company_id, name, operations_json, created_at, updated_at)
      VALUES ('model-a', ?, 'Model A', '[]', ?, ?)`).run(companyId, now, now);
    db.prepare(`INSERT INTO parties (
      id, company_id, party_number, physical_party_number, model_id, status, created_at, updated_at
    ) VALUES ('party-a', ?, '1', '1', 'model-a', 'ACTIVE', ?, ?)`).run(companyId, now, now);

    const result = applyChangesBatch(db, companyId, [{
      changeId: '629', companyId, entityType: 'party', entityId: 'party-a', entityRevision: 2, changeType: 'UPDATE',
      payload: {
        partyRecordId: 'party-a', partyNumber: '1', physicalPartyNumber: '1', modelId: 'model-a',
        modelName: 'Model A', color: 'Qora', pattaCount: 12, cumulativePattaCount: 12,
        pattaStartNumber: 1, pattaEndNumber: 12, ishSoniPerPatta: 1, totalIshSoni: 12,
        ishSoni: 0, cumulativeIshSoni: 0, sizes: { M: 12 }, printedAt: now,
        status: 'ACTIVE', isClosed: false, isArchived: false, closedAt: null, archivedPattaNumbers: []
      }
    }], '629');

    expect(result).toEqual({ appliedCount: 1, nextCursor: 629 });
    expect(db.prepare(`SELECT status, is_closed, is_archived, server_revision, patta_end_number
      FROM parties WHERE company_id = ? AND id = 'party-a'`).get(companyId))
      .toEqual({ status: 'ACTIVE', is_closed: 0, is_archived: 0, server_revision: 2, patta_end_number: 12 });
  });

  it('round-trips PostgreSQL BIGINT cursors above JavaScript safe-integer precision exactly', () => {
    const db = databaseManager.getCompanyDatabase(userData, companyId);
    const cursor = '9223372036854775000';
    db.prepare(`INSERT INTO local_meta (key, value, updated_at) VALUES ('sync_cursor', ?, datetime('now'))`)
      .run(cursor);

    expect(getLocalCursor(db)).toBe(cursor);
  });
});
