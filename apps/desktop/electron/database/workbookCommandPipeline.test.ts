import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const databaseManager = require('./databaseManager.cjs');
const workbookCommandPipeline = require('./workbookCommandPipeline.cjs');
const outboxDispatcher = require('../sync/outboxDispatcher.cjs');
const { canonicalStringify, computePayloadHash } = require('./canonicalPayload.cjs');

describe(' workbook local command pipeline', () => {
  let userData: string;
  const companyId = 'company_workbook_test';

  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'novda-workbook-command-'));
  });

  afterEach(() => {
    databaseManager.closeAllCompanyDatabases();
    fs.rmSync(userData, { recursive: true, force: true });
  });

  function modelCommand(overrides: Record<string, any> = {}) {
    return {
      commandType: 'UpsertModel',
      commandId: 'cmd_model_create_1',
      operationId: 'op_model_create_1',
      companyId,
      entityId: 'model_one',
      payload: {
        id: 'model_one',
        name: 'Model One',
        hisobSheetName: 'Model One-hisob',
        title: 'Model One',
        party: '',
        color: 'Qora',
        size: 'XL',
        operations: [{ id: 'op_cut', name: 'Cut', rate: 5 }],
        pattaOpsOrder: ['Cut'],
        ...overrides
      }
    };
  }

  function seedModel(modelId = 'model_one') {
    const db = databaseManager.getCompanyDatabase(userData, companyId);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT OR IGNORE INTO models (id, company_id, name, operations_json, created_at, updated_at)
      VALUES (?, ?, ?, '[]', ?, ?)
    `).run(modelId, companyId, modelId, now, now);
    return db;
  }

  it('commits the model fact and hashed outbox operation atomically and replays idempotently', () => {
    const command = modelCommand();

    const first = workbookCommandPipeline.executeWorkbookCommand(userData, companyId, command);
    const replay = workbookCommandPipeline.executeWorkbookCommand(userData, companyId, command);
    const db = databaseManager.getCompanyDatabase(userData, companyId);
    const model = db.prepare(`
      SELECT id, name, status, server_revision FROM models WHERE company_id = ? AND id = ?
    `).get(companyId, 'model_one');
    const operation = db.prepare(`
      SELECT command_type, entity_type, entity_id, payload_json, payload_hash, status
      FROM local_outbox WHERE company_id = ? AND operation_id = ?
    `).get(companyId, 'op_model_create_1');

    expect(first).toMatchObject({ committed: true, status: 'PENDING_SYNC', entityId: 'model_one' });
    expect(replay).toMatchObject({ committed: true, isReplay: true });
    expect(model).toEqual({ id: 'model_one', name: 'Model One', status: 'ACTIVE', server_revision: 0 });
    expect(operation).toMatchObject({
      command_type: 'UpsertModel',
      entity_type: 'model',
      entity_id: 'model_one',
      status: 'PENDING'
    });
    expect(operation.payload_hash).toBe(computePayloadHash(canonicalStringify(JSON.parse(operation.payload_json))));
    expect(db.prepare('SELECT COUNT(*) AS count FROM local_outbox WHERE company_id = ?').get(companyId).count).toBe(1);
  });

  it('queues a canonical ticket deletion and marks the local ticket voided', () => {
    const db = seedModel();
    const now = new Date().toISOString();
    const ticketId = '11111111-1111-4111-8111-111111111111';
    db.prepare(`INSERT INTO tickets (
      id, company_id, model_id, party_number, party_record_id, patta_number, qty, status, submitted_at, created_at
    ) VALUES (?, ?, 'model_one', '1', NULL, 1, 5, 'CONFIRMED', ?, ?)`).run(ticketId, companyId, now, now);

    const result = workbookCommandPipeline.executeWorkbookCommand(userData, companyId, {
      commandType: 'DeleteTicket', commandId: 'cmd_delete_ticket', operationId: 'op_delete_ticket',
      companyId, entityId: ticketId, payload: { ticketId }
    });

    expect(result).toMatchObject({ committed: true, entityId: ticketId });
    expect(db.prepare('SELECT status FROM tickets WHERE id = ?').get(ticketId).status).toBe('PENDING_DELETE');
    expect(db.prepare('SELECT command_type, entity_type, entity_id FROM local_outbox WHERE operation_id = ?')
      .get('op_delete_ticket')).toEqual({ command_type: 'DeleteTicket', entity_type: 'ticket', entity_id: ticketId });
  });

  it('deletes a rejected local-only ticket without sending an impossible server delete', () => {
    const db = seedModel();
    const now = new Date().toISOString();
    const ticketId = '11111111-1111-4111-8111-111111111112';
    db.prepare(`INSERT INTO tickets (
      id, company_id, model_id, party_number, party_record_id, patta_number, qty, status, submitted_at, created_at
    ) VALUES (?, ?, 'model_one', ?, NULL, 0, 1, 'CONFIRMED', ?, ?)`).run(ticketId, companyId, "No'malum Partiya", now, now);
    const submitPayload = { ticketId, companyId };
    const submitPayloadJson = canonicalStringify(submitPayload);
    db.prepare(`INSERT INTO local_outbox (
      operation_id, company_id, command_type, entity_type, entity_id, base_revision,
      payload_json, payload_hash, status, created_at, updated_at, last_error, error_message
    ) VALUES ('op_rejected_submit', ?, 'SubmitTicket', 'ticket', ?, 0, ?, ?, 'DEAD_LETTER', ?, ?, ?, ?)`)
      .run(companyId, ticketId, submitPayloadJson, computePayloadHash(submitPayloadJson), now, now,
        JSON.stringify({ code: 'PARTY_RECORD_REQUIRED' }), JSON.stringify({ code: 'PARTY_RECORD_REQUIRED' }));

    const result = workbookCommandPipeline.executeWorkbookCommand(userData, companyId, {
      commandType: 'DeleteTicket', commandId: 'cmd_delete_local_only_ticket', operationId: 'op_delete_local_only_ticket',
      companyId, entityId: ticketId, payload: { ticketId }
    });

    expect(result).toMatchObject({ committed: true, entityId: ticketId, status: 'DELETED_LOCALLY', localOnly: true });
    expect(db.prepare('SELECT status FROM tickets WHERE id = ?').get(ticketId).status).toBe('VOIDED');
    expect(db.prepare('SELECT status FROM local_outbox WHERE operation_id = ?').get('op_delete_local_only_ticket').status)
      .toBe('SUPERSEDED');
    expect(db.prepare(`SELECT COUNT(*) AS count FROM local_outbox WHERE entity_id = ?
      AND command_type = 'DeleteTicket' AND status = 'PENDING'`).get(ticketId).count).toBe(0);
    expect(require('./projectionReader.cjs').loadWorkbookProjectionFromSqlite(db, companyId).submittedTickets)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: ticketId })]));
  });

  it('updates ticket entries locally and restores the previous assignments if the server rejects the edit', async () => {
    const db = seedModel();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO workers (id, company_id, name, created_at, updated_at)
      VALUES (1, ?, 'Worker A', ?, ?)`).run(companyId, now, now);
    db.prepare(`INSERT INTO workers (id, company_id, name, created_at, updated_at)
      VALUES (2, ?, 'Worker B', ?, ?)`).run(companyId, now, now);
    const ticketId = '11111111-1111-4111-8111-111111111113';
    db.prepare(`INSERT INTO tickets (
      id, company_id, model_id, party_number, party_record_id, patta_number, qty,
      status, submitted_at, created_at, server_revision
    ) VALUES (?, ?, 'model_one', '1', NULL, 1, 5, 'CONFIRMED', ?, ?, 2)`)
      .run(ticketId, companyId, now, now);
    db.prepare(`INSERT INTO ticket_entries (
      id, ticket_id, company_id, op_name, worker_id, worker_name_snapshot, rate_snapshot, qty, created_at
    ) VALUES ('entry_before_edit', ?, ?, 'Cut', 1, 'Worker A', 3, 5, ?)`)
      .run(ticketId, companyId, now);

    const result = workbookCommandPipeline.executeWorkbookCommand(userData, companyId, {
      commandType: 'UpdateTicket', commandId: 'cmd_update_ticket', operationId: 'op_update_ticket',
      companyId, entityId: ticketId, baseRevision: 2,
      payload: { ticketId, entries: [{ opName: 'Cut', workerId: 2, workerNameSnapshot: 'Worker B', rateSnapshot: 3 }] }
    });

    expect(result).toMatchObject({ committed: true, entityId: ticketId, status: 'PENDING_SYNC' });
    expect(db.prepare('SELECT op_name, worker_id, worker_name_snapshot FROM ticket_entries WHERE ticket_id = ?')
      .all(ticketId)).toEqual([{ op_name: 'Cut', worker_id: 2, worker_name_snapshot: 'Worker B' }]);
    const outbox = db.prepare(`SELECT command_type, base_revision, local_archive_json FROM local_outbox WHERE operation_id = ?`)
      .get('op_update_ticket');
    expect(outbox.command_type).toBe('UpdateTicket');
    expect(outbox.base_revision).toBe(2);
    expect(JSON.parse(outbox.local_archive_json).entries).toEqual([
      expect.objectContaining({ id: 'entry_before_edit', worker_id: 1, worker_name_snapshot: 'Worker A' })
    ]);

    await outboxDispatcher.dispatchOutbox(db, companyId, {
      pushOperations: async (operations: any[]) => ({
        results: operations.map((operation) => ({
          operationId: operation.operationId,
          status: 'REJECTED',
          error: { code: 'TICKET_PERIOD_CLOSED', message: 'Ticket period is closed' }
        }))
      })
    }, { baseUserDataPath: userData });
    expect(db.prepare('SELECT op_name, worker_id FROM ticket_entries WHERE ticket_id = ?').all(ticketId))
      .toEqual([{ op_name: 'Cut', worker_id: 1 }]);
    expect(db.prepare('SELECT status FROM local_outbox WHERE operation_id = ?').get('op_update_ticket').status)
      .toBe('DEAD_LETTER');
  });

  it('rejects a changed replay and cross-company command without changing local facts', () => {
    const original = modelCommand();
    workbookCommandPipeline.executeWorkbookCommand(userData, companyId, original);

    expect(() => workbookCommandPipeline.executeWorkbookCommand(userData, companyId, {
      ...original,
      payload: { ...original.payload, color: 'Ko\'k' }
    })).toThrow(/IDEMPOTENCY_CONFLICT/);
    expect(() => workbookCommandPipeline.executeWorkbookCommand(userData, companyId, {
      ...modelCommand({ id: 'model_other' }),
      companyId: 'company_other',
      entityId: 'model_other',
      operationId: 'op_other',
      commandId: 'cmd_other'
    })).toThrow(/CROSS_COMPANY_REJECTED/);

    const db = databaseManager.getCompanyDatabase(userData, companyId);
    expect(db.prepare('SELECT color FROM models WHERE id = ?').get('model_one').color).toBe('Qora');
    expect(db.prepare('SELECT COUNT(*) AS count FROM local_outbox WHERE company_id = ?').get(companyId).count).toBe(1);
  });

  it('renames a model operation while preserving its canonical ticket and adjustment facts', () => {
    const db = seedModel();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO workers (id, company_id, name, created_at, updated_at) VALUES (91, ?, 'Worker', ?, ?)`)
      .run(companyId, now, now);
    db.prepare(`INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, created_at, updated_at)
      VALUES ('party_rename', ?, '90', '90', 'model_one', ?, ?)`)
      .run(companyId, now, now);
    const ticketId = '00000000-0000-4000-8000-000000000901';
    db.prepare(`INSERT INTO tickets (id, company_id, model_id, party_number, party_record_id, patta_number, qty, submitted_at, created_at)
      VALUES (?, ?, 'model_one', '90', 'party_rename', 1, 10, ?, ?)`)
      .run(ticketId, companyId, now, now);
    db.prepare(`INSERT INTO ticket_entries (id, ticket_id, company_id, op_name, worker_id, qty, created_at)
      VALUES ('entry_rename', ?, ?, 'Cut', 91, 10, ?)`)
      .run(ticketId, companyId, now);
    db.prepare(`INSERT INTO production_adjustments (
      adjustment_id, company_id, model_id, worker_id, op_name, delta_qty, reason, created_at, created_by
    ) VALUES ('adjust_rename', ?, 'model_one', 91, 'Cut', 2, 'Test', ?, 'test')`)
      .run(companyId, now);

    db.prepare('UPDATE models SET operations_json = ? WHERE company_id = ? AND id = ?')
      .run(JSON.stringify([{ id: 'op_cut', name: 'Cut', rate: 5 }]), companyId, 'model_one');
    const existing = JSON.parse(db.prepare('SELECT operations_json FROM models WHERE company_id = ? AND id = ?').get(companyId, 'model_one').operations_json);
    workbookCommandPipeline.executeWorkbookCommand(userData, companyId, {
      commandType: 'UpsertModel', commandId: 'cmd_model_rename_op', operationId: 'op_model_rename_op',
      companyId, entityId: 'model_one',
      payload: {
        id: 'model_one', name: 'Model One', operations: [{ ...existing[0], name: 'Sew' }], pattaOpsOrder: ['Sew'],
        operationRenames: [{ fromName: 'Cut', toName: 'Sew' }]
      }
    });

    expect(db.prepare('SELECT op_name FROM ticket_entries WHERE id = ?').get('entry_rename').op_name).toBe('Sew');
    expect(db.prepare('SELECT op_name FROM production_adjustments WHERE adjustment_id = ?').get('adjust_rename').op_name).toBe('Sew');
    expect(db.prepare('SELECT rate_snapshot FROM ticket_entries WHERE id = ?').get('entry_rename').rate_snapshot).toBeNull();
  });

  it('rolls back the canonical row if outbox creation fails', () => {
    const command = modelCommand();
    expect(() => workbookCommandPipeline.executeWorkbookCommand(userData, companyId, command, {
      testHooks: { afterFactWrite() { throw new Error('INJECTED_WORKBOOK_ROLLBACK'); } }
    })).toThrow('INJECTED_WORKBOOK_ROLLBACK');

    const db = databaseManager.getCompanyDatabase(userData, companyId);
    expect(db.prepare('SELECT COUNT(*) AS count FROM models WHERE company_id = ?').get(companyId).count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM local_outbox WHERE company_id = ?').get(companyId).count).toBe(0);
  });

  it('queues a worker create with a temporary request key and no client worker ID', () => {
    const db = databaseManager.getCompanyDatabase(userData, companyId);
    const command = {
      commandType: 'CreateWorker',
      commandId: 'cmd_worker_create_1',
      operationId: '00000000-0000-4000-8000-000000000071',
      companyId,
      entityId: 'pending-worker:00000000-0000-4000-8000-000000000072',
      payload: {
        requestId: '00000000-0000-4000-8000-000000000072',
        name: 'Ali',
        staj: 4,
        role: 'Bichuvchi',
        balanceAdjustments: [
          { adjustmentId: '00000000-0000-4000-8000-000000000073', type: 'AVANS', amountDelta: 500, periodId: 'period_worker' },
          { adjustmentId: '00000000-0000-4000-8000-000000000074', type: 'JARIMA', amountDelta: 25, periodId: 'period_worker' }
        ]
      }
    };

    const result = workbookCommandPipeline.executeWorkbookCommand(userData, companyId, command);

    expect(result).toMatchObject({ committed: true, status: 'PENDING_SYNC', entityId: command.entityId });
    expect(db.prepare('SELECT COUNT(*) AS count FROM workers WHERE company_id = ?').get(companyId).count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM worker_adjustments WHERE company_id = ?').get(companyId).count).toBe(0);
    const queued = db.prepare('SELECT entity_type, entity_id, payload_json FROM local_outbox WHERE operation_id = ?').get(command.operationId);
    expect(queued.entity_type).toBe('worker_create_request');
    expect(queued.entity_id).toBe(command.entityId);
    expect(JSON.parse(queued.payload_json)).not.toHaveProperty('workerId');
    expect(JSON.parse(queued.payload_json)).not.toHaveProperty('deletedWorkerIds');
    expect(db.prepare('SELECT COUNT(*) AS count FROM local_outbox WHERE operation_id = ?').get(command.operationId).count).toBe(1);
  });

  it('commits a completed multi-party batch and settings in one idempotent command', () => {
    const db = seedModel();
    const command = {
      commandType: 'CompletePattaBatch',
      commandId: 'cmd_batch_1',
      operationId: 'op_batch_1',
      companyId,
      entityId: 'batch_1',
      payload: {
        batchId: 'batch_1',
        parties: [
          { id: 'party_21', partyNumber: '21', modelId: 'model_one', modelName: 'Model One', color: 'Qora', pattaCount: 2, ishSoni: 100, totalIshSoni: 100, sizes: { M: 2 }, printedAt: '2026-09-23T10:00:00.000Z' },
          { id: 'party_22', partyNumber: '22', modelId: 'model_one', modelName: 'Model One', color: 'Ko\'k', pattaCount: 1, ishSoni: 80, totalIshSoni: 80, sizes: { L: 1 }, printedAt: '2026-09-23T10:00:00.000Z' }
        ],
        availableSizes: ['M', 'L'],
        configs: [{ modelId: 'model_one', partyNumber: '', isCustomParty: false, totalIshSoni: '', color: 'Qora', sizes: { M: '', L: '' } }]
      }
    };

    const result = workbookCommandPipeline.executeWorkbookCommand(userData, companyId, command);
    const replay = workbookCommandPipeline.executeWorkbookCommand(userData, companyId, command);
    const parties = db.prepare('SELECT id, party_number, patta_count, patta_start_number, patta_end_number, status FROM parties WHERE company_id = ? ORDER BY id').all(companyId);

    expect(result).toMatchObject({ committed: true, status: 'PENDING_SYNC' });
    expect(replay.isReplay).toBe(true);
    expect(parties).toEqual([
      { id: 'party_21', party_number: '21', patta_count: 2, patta_start_number: 1, patta_end_number: 2, status: 'ACTIVE' },
      { id: 'party_22', party_number: '22', patta_count: 1, patta_start_number: 3, patta_end_number: 3, status: 'ACTIVE' }
    ]);
    expect(JSON.parse(db.prepare('SELECT available_sizes_json FROM company_batch_settings WHERE company_id = ?').get(companyId).available_sizes_json))
      .toEqual(['M', 'L']);
    expect(db.prepare('SELECT COUNT(*) AS count FROM local_outbox WHERE company_id = ?').get(companyId).count).toBe(1);

    db.prepare(`INSERT INTO models (id, company_id, name, operations_json, created_at, updated_at)
      VALUES ('model_two', ?, 'Model Two', '[]', datetime('now'), datetime('now'))`).run(companyId);
    const nextBatch = {
      ...command,
      commandId: 'cmd_batch_2',
      operationId: 'op_batch_2',
      entityId: 'batch_2',
      payload: {
        ...command.payload,
        batchId: 'batch_2',
        parties: [{ id: 'party_23', partyNumber: '23', modelId: 'model_two', modelName: 'Model Two',
          pattaCount: 2, ishSoniPerPatta: 65, totalIshSoni: 130, ishSoni: 130,
          sizes: { M: 2 }, printedAt: '2026-09-24T10:00:00.000Z' }],
        configs: [{ modelId: 'model_two', partyNumber: '', isCustomParty: false, totalIshSoni: '', color: 'Qora', sizes: { M: '', L: '' } }]
      }
    };
    workbookCommandPipeline.executeWorkbookCommand(userData, companyId, nextBatch);
    expect(db.prepare(`SELECT model_id, patta_start_number, patta_end_number FROM parties WHERE id = 'party_23'`).get())
      .toEqual({ model_id: 'model_two', patta_start_number: 4, patta_end_number: 5 });
  });

  it('rolls back a partially applied batch and archive when period closure fails', () => {
    const db = seedModel();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO periods (id, company_id, name, start_date, created_at) VALUES ('period_current', ?, 'Current', '2026-09-01', ?)`)
      .run(companyId, now);
    db.prepare(`
      INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, status, created_at, updated_at)
      VALUES ('party_current', ?, '1', '1', 'model_one', 'ACTIVE', ?, ?)
    `).run(companyId, now, now);

    const command = {
      commandType: 'ClosePeriod',
      commandId: 'cmd_period_close_1',
      operationId: 'op_period_close_1',
      companyId,
      entityId: 'period_current',
      payload: {
        periodId: 'period_current',
        endDate: '2026-09-30',
        nextPeriod: { id: 'period_next', name: 'October', startDate: '2026-10-01' },
        archiveFilename: 'archive_period_current.json'
      },
      localArchive: { period: { id: 'period_current', name: 'Current', startDate: '2026-09-01' }, submittedTickets: [] }
    };

    expect(() => workbookCommandPipeline.executeWorkbookCommand(userData, companyId, command, {
      testHooks: { afterFactWrite() { throw new Error('INJECTED_PERIOD_ROLLBACK'); } }
    })).toThrow('INJECTED_PERIOD_ROLLBACK');
    expect(db.prepare('SELECT is_closed FROM periods WHERE id = ?').get('period_current').is_closed).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM periods WHERE id = ?').get('period_next').count).toBe(0);
    expect(db.prepare('SELECT status FROM parties WHERE id = ?').get('party_current').status).toBe('ACTIVE');
    expect(db.prepare('SELECT COUNT(*) AS count FROM period_archives WHERE company_id = ?').get(companyId).count).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM local_outbox WHERE company_id = ?').get(companyId).count).toBe(0);
  });

  it('derives completed and rolled-over parties from local canonical tickets during period closure', () => {
    const db = seedModel();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO periods (id, company_id, name, start_date, created_at) VALUES ('period_current', ?, 'Current', '2026-09-01', ?)`)
      .run(companyId, now);
    db.prepare(`INSERT INTO parties (
      id, company_id, party_number, physical_party_number, model_id, patta_count, sizes_json, archived_patta_numbers_json, created_at, updated_at
    ) VALUES
      ('party_complete', ?, '1', '1', 'model_one', 2, '{"M":2}', '[1]', ?, ?),
      ('party_rollover', ?, '2', '2', 'model_one', 3, '{"M":3}', '[]', ?, ?)`)
      .run(companyId, now, now, companyId, now, now);
    const insertTicket = db.prepare(`INSERT INTO tickets (
      id, company_id, model_id, period_id, party_number, party_record_id, patta_number, qty, submitted_at, created_at
    ) VALUES (?, ?, 'model_one', 'period_current', ?, ?, ?, 10, '2026-09-15T10:00:00.000Z', ?)`);
    insertTicket.run('00000000-0000-4000-8000-000000000921', companyId, '1', 'party_complete', 2, now);
    insertTicket.run('00000000-0000-4000-8000-000000000922', companyId, '2', 'party_rollover', 1, now);

    const result = workbookCommandPipeline.executeWorkbookCommand(userData, companyId, {
      commandType: 'ClosePeriod', commandId: 'cmd_period_derived', operationId: 'op_period_derived',
      companyId, entityId: 'period_current',
      payload: {
        periodId: 'period_current', endDate: '2026-09-30',
        nextPeriod: { id: 'period_next', name: 'October', startDate: '2026-10-01' }
      },
      localArchive: { completedPartiesCount: 99, rolledOverPartiesCount: 99, submittedTickets: [] }
    });

    expect(result.committed).toBe(true);
    expect(db.prepare('SELECT status FROM parties WHERE id = ?').get('party_complete').status).toBe('CLOSED');
    expect(db.prepare('SELECT status, archived_patta_numbers_json FROM parties WHERE id = ?').get('party_rollover'))
      .toEqual({ status: 'ACTIVE', archived_patta_numbers_json: '[1]' });
    expect(db.prepare('SELECT is_closed FROM tickets WHERE party_record_id = ?').get('party_complete').is_closed).toBe(1);
    const archive = JSON.parse(db.prepare('SELECT archive_json FROM period_archives WHERE company_id = ? AND period_id = ?').get(companyId, 'period_current').archive_json);
    expect(archive).toMatchObject({ completedPartiesCount: 1, rolledOverPartiesCount: 1 });
    const operation = JSON.parse(db.prepare('SELECT payload_json FROM local_outbox WHERE operation_id = ?').get('op_period_derived').payload_json);
    expect(operation).not.toHaveProperty('completedPartyIds');
    expect(operation).not.toHaveProperty('rolledOverParties');
  });

  it('persists bounded ticket drafts locally in SQLite without adding an outbox operation', () => {
    const db = seedModel();
    const result = workbookCommandPipeline.saveTicketDraft(userData, companyId, companyId, 'model_one', {
      date: '2026-09-23', party: '21', color: 'Qora', size: 'M', qty: '12', patta: '2',
      entries: { Cut: '71' }
    });

    expect(result.success).toBe(true);
    expect(JSON.parse(db.prepare('SELECT form_json FROM local_ticket_forms WHERE company_id = ? AND model_id = ?').get(companyId, 'model_one').form_json))
      .toMatchObject({ date: '2026-09-23', party: '21', entries: { Cut: '71' } });
    expect(db.prepare('SELECT COUNT(*) AS count FROM local_outbox WHERE company_id = ?').get(companyId).count).toBe(0);
    expect(() => workbookCommandPipeline.saveTicketDraft(userData, 'company_other', companyId, 'model_one', {}))
      .toThrow(/CROSS_COMPANY_REJECTED/);
  });

  it('archives party history without physically deleting canonical party facts', () => {
    const db = seedModel();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, status, created_at, updated_at)
      VALUES ('party_archive', ?, '81', '81', 'model_one', 'ACTIVE', ?, ?)
    `).run(companyId, now, now);
    const command = {
      commandType: 'ArchivePartyHistory',
      commandId: 'cmd_archive_party',
      operationId: 'op_archive_party',
      companyId,
      entityId: companyId,
      payload: { partyRecordIds: ['party_archive'] }
    };

    const result = workbookCommandPipeline.executeWorkbookCommand(userData, companyId, command);
    const archived = db.prepare('SELECT status, is_closed, is_archived FROM parties WHERE company_id = ? AND id = ?')
      .get(companyId, 'party_archive');
    const projection = require('./projectionReader.cjs').loadWorkbookProjectionFromSqlite(db, companyId);

    expect(result.committed).toBe(true);
    expect(archived).toEqual({ status: 'CLOSED', is_closed: 1, is_archived: 1 });
    expect(projection.printedPartyHistory).toEqual([]);
  });

  it('routes period, party, settings, series, and deactivation writes through the same durable outbox', () => {
    const db = seedModel();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO workers (id, company_id, name, created_at, updated_at) VALUES (81, ?, 'Worker', ?, ?)`)
      .run(companyId, now, now);
    const apply = (commandType: string, operationId: string, entityType: string, entityId: string, payload: Record<string, any>) =>
      workbookCommandPipeline.executeWorkbookCommand(userData, companyId, {
        commandType, commandId: `cmd_${operationId}`, operationId, companyId, entityType, entityId, payload
      });

    expect(apply('CreatePeriod', 'op_period_create', 'period', 'period_current', {
      periodId: 'period_current', name: 'Current', startDate: '2026-09-01'
    }).committed).toBe(true);
    expect(apply('UpdatePeriod', 'op_period_update', 'period', 'period_current', {
      periodId: 'period_current', name: 'Current revised', startDate: '2026-09-01'
    }).committed).toBe(true);
    expect(apply('CreateParty', 'op_party_create', 'party', 'party_current', {
      partyRecordId: 'party_current', partyNumber: '41', modelId: 'model_one', modelName: 'Model One',
      pattaCount: 1, cumulativePattaCount: 1, ishSoniPerPatta: 10, totalIshSoni: 10, ishSoni: 10,
      cumulativeIshSoni: 10, sizes: { M: 1 }, printedAt: '2026-09-23T10:00:00.000Z'
    }).committed).toBe(true);
    expect(apply('UpdateParty', 'op_party_update', 'party', 'party_current', {
      partyRecordId: 'party_current', partyNumber: '41', modelId: 'model_one', modelName: 'Model One',
      pattaCount: 1, cumulativePattaCount: 1, ishSoniPerPatta: 12, totalIshSoni: 12, ishSoni: 12,
      cumulativeIshSoni: 12, sizes: { M: 1 }, printedAt: '2026-09-23T10:00:00.000Z'
    }).committed).toBe(true);
    expect(apply('UpdateBatchSettings', 'op_batch_settings', 'batch_settings', companyId, {
      availableSizes: ['M', 'L'], configs: [{ modelId: 'model_one', partyNumber: '41', isCustomParty: false, totalIshSoni: '10', color: 'Qora', sizes: { M: '2', L: '' } }]
    }).committed).toBe(true);
    expect(apply('CloseParty', 'op_party_close', 'party', 'party_current', { partyRecordId: 'party_current' }).committed).toBe(true);
    expect(apply('CompletePartySeries', 'op_series', 'party_series', 'period_current', { periodId: 'period_current', endDate: '2026-09-30' }).committed).toBe(true);
    expect(apply('DeactivateWorker', 'op_worker_deactivate', 'worker', '81', { workerId: 81 }).committed).toBe(true);
    expect(apply('DeactivateModel', 'op_model_deactivate', 'model', 'model_one', { modelId: 'model_one' }).committed).toBe(true);

    expect(db.prepare('SELECT status FROM models WHERE company_id = ? AND id = ?').get(companyId, 'model_one').status).toBe('INACTIVE');
    expect(db.prepare('SELECT status FROM workers WHERE company_id = ? AND id = 81').get(companyId).status).toBe('INACTIVE');
    expect(db.prepare('SELECT is_closed, status FROM periods WHERE company_id = ? AND id = ?').get(companyId, 'period_current'))
      .toMatchObject({ is_closed: 0, status: 'OPEN' });
    expect(db.prepare('SELECT status, is_archived FROM parties WHERE company_id = ? AND id = ?').get(companyId, 'party_current'))
      .toMatchObject({ status: 'CLOSED', is_archived: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM local_outbox WHERE company_id = ?').get(companyId).count).toBe(9);
  });
});
