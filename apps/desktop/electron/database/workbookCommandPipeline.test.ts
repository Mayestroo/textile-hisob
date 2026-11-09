import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const databaseManager = require('./databaseManager.cjs');
const workbookCommandPipeline = require('./workbookCommandPipeline.cjs');
const outboxDispatcher = require('../sync/outboxDispatcher.cjs');
const outboxManager = require('./outboxManager.cjs');
const projectionReader = require('./projectionReader.cjs');
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

  it('durably saves independent model size definitions through SQLite command, reopen, and legacy omitted-field replay', () => {
    const db = seedModel('model_a');
    seedModel('model_b');
    const execute = (operationId: string, configs: any[]) => workbookCommandPipeline.executeWorkbookCommand(userData, companyId, {
      commandType: 'UpdateBatchSettings', commandId: `cmd_${operationId}`, operationId, companyId, entityId: companyId,
      payload: { availableSizes: ['M', 'L'], configs }
    });
    const config = (modelId: string, names: string[], counts: Record<string, string>) => ({
      modelId, partyNumber: '', isCustomParty: false, totalIshSoni: '', color: 'Qora', sizeNames: names, sizes: counts
    });
    execute('op_size_defs', [config('model_a', ['M', 'XXL'], { M: '1', XXL: '2' }), config('model_b', ['M', 'L'], { L: '1' })]);
    databaseManager.closeAllCompanyDatabases();
    const reopened = databaseManager.getCompanyDatabase(userData, companyId);
    expect(reopened.prepare('SELECT size_names_json, sizes_json FROM patta_batch_settings WHERE model_id = ?').get('model_a'))
      .toEqual({ size_names_json: '["M","XXL"]', sizes_json: '{"M":"1","XXL":"2"}' });
    expect(reopened.prepare('SELECT size_names_json, sizes_json FROM patta_batch_settings WHERE model_id = ?').get('model_b'))
      .toEqual({ size_names_json: '["M","L"]', sizes_json: '{"L":"1"}' });
    // A payload from an older client omits the new field; it must retain A's explicit definition.
    const oldConfig = { ...config('model_a', [], { XXL: '2' }) };
    delete (oldConfig as any).sizeNames;
    execute('op_size_old_client', [oldConfig]);
    expect(JSON.parse(reopened.prepare('SELECT size_names_json FROM patta_batch_settings WHERE model_id = ?').get('model_a').size_names_json))
      .toEqual(['M', 'XXL']);
    execute('op_size_empty', [config('model_a', [], {})]);
    databaseManager.closeAllCompanyDatabases();
    const emptyReopened = databaseManager.getCompanyDatabase(userData, companyId);
    expect(emptyReopened.prepare('SELECT size_names_json FROM patta_batch_settings WHERE model_id = ?').get('model_a').size_names_json)
      .toBe('[]');
    expect(workbookCommandPipeline.normalizeCommand({
      commandType: 'UpdateBatchSettings', commandId: 'cmd_empty', operationId: 'op_empty', companyId, entityId: companyId,
      payload: { configs: [config('model_a', [], {})] }
    }, companyId).payload.configs[0].sizeNames).toEqual([]);
    void db;
  });

  it('persists new-party size order immutably through update, close, and SQLite reopen', () => {
    seedModel('ordered_model');
    const submit = (commandType: string, operationId: string, entityId: string, payload: Record<string, any>) =>
      workbookCommandPipeline.executeWorkbookCommand(userData, companyId, {
        commandType, commandId: `cmd_${operationId}`, operationId, companyId, entityId, payload
      });
    const party = {
      partyRecordId: 'ordered_party', partyNumber: '8', modelId: 'ordered_model', modelName: 'Ordered', color: 'Qora',
      pattaCount: 2, cumulativePattaCount: 2, ishSoniPerPatta: 25, totalIshSoni: 50,
      ishSoni: 50, cumulativeIshSoni: 50, sizes: { XXL: '1', M: '1' }, sizeOrder: ['XXL', 'M'], printedAt: '2026-11-07T00:00:00.000Z'
    };
    submit('CreateParty', 'op_order_create', 'ordered_party', party);
    databaseManager.closeAllCompanyDatabases();
    let db = databaseManager.getCompanyDatabase(userData, companyId);
    expect(db.prepare('SELECT sizes_json, size_order_json FROM parties WHERE id = ?').get('ordered_party'))
      .toEqual({ sizes_json: '{"XXL":1,"M":1}', size_order_json: '["XXL","M"]' });
    // Old UpdateParty clients omit order. Quantity correction must not alter the print-time definition.
    const { sizeOrder: _omitted, ...oldUpdate } = { ...party, ishSoni: 52, totalIshSoni: 52 };
    submit('UpdateParty', 'op_order_update', 'ordered_party', oldUpdate);
    submit('CloseParty', 'op_order_close', 'ordered_party', { partyRecordId: 'ordered_party' });
    databaseManager.closeAllCompanyDatabases();
    db = databaseManager.getCompanyDatabase(userData, companyId);
    expect(projectionReader.loadWorkbookProjectionFromSqlite(db, companyId).printedPartyHistory.find((item: any) => item.id === 'ordered_party').sizeOrder)
      .toEqual(['XXL', 'M']);
    expect(db.prepare('SELECT status, ish_soni, sizes_json, size_order_json FROM parties WHERE id = ?').get('ordered_party'))
      .toEqual({ status: 'CLOSED', ish_soni: 52, sizes_json: '{"XXL":1,"M":1}', size_order_json: '["XXL","M"]' });
  });

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

  it('supersedes an older batch-settings revision conflict after a newer full snapshot is accepted', async () => {
    const db = seedModel();
    const stalePayload = {
      companyId,
      operationId: 'op_batch_settings_old',
      commandId: 'cmd_batch_settings_old',
      availableSizes: ['M', 'L'],
      configs: [{ modelId: 'model_one', partyNumber: '', isCustomParty: false, totalIshSoni: '', color: 'Qora', sizes: { M: '', L: '' } }]
    };
    const acceptedPayload = {
      ...stalePayload,
      operationId: 'op_batch_settings_new',
      commandId: 'cmd_batch_settings_new',
      configs: [{ ...stalePayload.configs[0], partyNumber: '17' }]
    };
    const insertOperation = (operationId: string, baseRevision: number, payload: Record<string, any>, status: string, error?: string) => {
      const payloadJson = canonicalStringify(payload);
      outboxManager.insertOutboxOperation(db, {
        operation_id: operationId,
        company_id: companyId,
        command_type: 'UpdateBatchSettings',
        entity_type: 'batch_settings',
        entity_id: companyId,
        base_revision: baseRevision,
        payload_json: payloadJson,
        payload_hash: computePayloadHash(payloadJson),
        status,
        last_error: error,
        error_message: error,
        causal_sequence: 0
      });
    };

    db.transaction(() => {
      insertOperation('op_batch_settings_old', 336, stalePayload, 'CONFLICT', JSON.stringify({
        code: 'REVISION_CONFLICT', message: 'Batch settings revision conflict; expected 337, supplied 336'
      }));
      insertOperation('op_batch_settings_new', 337, acceptedPayload, 'PENDING');
    })();

    const result = await outboxDispatcher.dispatchOutbox(db, companyId, {
      pushOperations: async (operations: any[]) => ({
        results: operations.map((operation) => ({
          operationId: operation.operationId,
          status: 'APPLIED',
          serverRevision: 338,
          committedAt: new Date().toISOString()
        }))
      })
    });

    expect(result).toMatchObject({ attempted: 1, synced: 1, conflict: 0, deadLetter: 0 });
    expect(db.prepare('SELECT status FROM local_outbox WHERE operation_id = ?').get('op_batch_settings_new'))
      .toEqual({ status: 'SYNCED' });
    expect(db.prepare('SELECT status, last_error FROM local_outbox WHERE operation_id = ?').get('op_batch_settings_old'))
      .toEqual({ status: 'SUPERSEDED', last_error: 'SUPERSEDED_BY_NEWER_BATCH_SETTINGS' });
    expect(outboxManager.getOutboxDiagnostics(db, companyId).conflictCount).toBe(0);
  });

  it('reports pending, conflict, and dead-letter outbox counts separately', () => {
    const db = seedModel();
    const statuses = ['PENDING', 'SENDING', 'CONFLICT', 'DEAD_LETTER'];
    statuses.forEach((status, index) => {
      const operationId = `op_diagnostic_${index}`;
      const payloadJson = canonicalStringify({ operationId, companyId });
      const createdAt = new Date(Date.now() + index).toISOString();
      outboxManager.insertOutboxOperation(db, {
        operation_id: operationId, company_id: companyId,
        command_type: 'UpsertModel', entity_type: 'model', entity_id: `model_${index}`,
        base_revision: 0, payload_json: payloadJson, payload_hash: computePayloadHash(payloadJson),
        status, created_at: createdAt
      });
    });

    expect(outboxManager.getOutboxDiagnostics(db, companyId)).toMatchObject({
      pendingCount: 1,
      sendingCount: 1,
      conflictCount: 1,
      deadLetterCount: 1
    });
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
    const dependentPayload = { operationId: 'op_rejected_submit_edit', ticketId, entries: [] };
    outboxManager.insertOutboxOperation(db, {
      operation_id: dependentPayload.operationId,
      company_id: companyId,
      command_type: 'UpdateTicket',
      entity_type: 'ticket',
      entity_id: ticketId,
      base_revision: 0,
      payload_json: canonicalStringify(dependentPayload),
      payload_hash: computePayloadHash(canonicalStringify(dependentPayload)),
      depends_on_operation_id: 'op_rejected_submit',
      causal_sequence: 1,
      status: 'PENDING'
    });

    const result = workbookCommandPipeline.executeWorkbookCommand(userData, companyId, {
      commandType: 'DeleteTicket', commandId: 'cmd_delete_local_only_ticket', operationId: 'op_delete_local_only_ticket',
      companyId, entityId: ticketId, payload: { ticketId }
    });

    expect(result).toMatchObject({ committed: true, entityId: ticketId, status: 'DELETED_LOCALLY', localOnly: true });
    expect(db.prepare('SELECT status FROM tickets WHERE id = ?').get(ticketId).status).toBe('VOIDED');
    expect(db.prepare('SELECT status, last_error FROM local_outbox WHERE operation_id = ?').get('op_rejected_submit'))
      .toEqual({ status: 'SUPERSEDED', last_error: 'SUPERSEDED_AFTER_LOCAL_TICKET_DISCARD' });
    expect(db.prepare('SELECT status FROM local_outbox WHERE operation_id = ?').get('op_rejected_submit_edit'))
      .toEqual({ status: 'SUPERSEDED' });
    expect(db.prepare('SELECT status FROM local_outbox WHERE operation_id = ?').get('op_delete_local_only_ticket').status)
      .toBe('SUPERSEDED');
    expect(require('./outboxManager.cjs').getOutboxDiagnostics(db, companyId).deadLetterCount).toBe(0);
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
    ) VALUES ('entry_before_edit', ?, ?, 'Cut', 1, 'Worker A', 5, 5, ?)`)
      .run(ticketId, companyId, now);

    const result = workbookCommandPipeline.executeWorkbookCommand(userData, companyId, {
      commandType: 'UpdateTicket', commandId: 'cmd_update_ticket', operationId: 'op_update_ticket',
      companyId, entityId: ticketId, baseRevision: 2,
      payload: { ticketId, entries: [{ opName: 'Cut', workerId: 2, workerNameSnapshot: 'Worker B', rateSnapshot: 3 }] }
    });

    expect(result).toMatchObject({ committed: true, entityId: ticketId, status: 'PENDING_SYNC' });
    expect(db.prepare('SELECT op_name, worker_id, worker_name_snapshot FROM ticket_entries WHERE ticket_id = ?')
      .all(ticketId)).toEqual([{ op_name: 'Cut', worker_id: 2, worker_name_snapshot: 'Worker B' }]);
    expect(db.prepare('SELECT id, rate_snapshot FROM ticket_entries WHERE ticket_id = ?').get(ticketId))
      .toEqual({ id: 'entry_before_edit', rate_snapshot: 5 });
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

  it('retains zero and unknown rates across local reorder and worker edits without accepting new tariff claims', () => {
    const db = seedModel();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO workers (id, company_id, name, created_at, updated_at) VALUES (1, ?, 'A', ?, ?), (2, ?, 'B', ?, ?)`)
      .run(companyId, now, now, companyId, now, now);
    const ticketId = '11111111-1111-4111-8111-111111111119';
    db.prepare(`INSERT INTO tickets (id, company_id, model_id, party_number, patta_number, qty,
      status, submitted_at, created_at, server_revision) VALUES (?, ?, 'model_one', '1', 1, 3,
      'CONFIRMED', ?, ?, 1)`).run(ticketId, companyId, now, now);
    const insert = db.prepare(`INSERT INTO ticket_entries (id, ticket_id, company_id, op_name, worker_id,
      rate_snapshot, qty, created_at) VALUES (?, ?, ?, ?, 1, ?, 3, ?)`);
    insert.run('old-zero', ticketId, companyId, 'Zero', 0, now);
    insert.run('old-unknown', ticketId, companyId, 'Unknown', null, now);
    workbookCommandPipeline.executeWorkbookCommand(userData, companyId, {
      commandType: 'UpdateTicket', commandId: 'cmd_reorder', operationId: 'op_reorder',
      companyId, entityId: ticketId, baseRevision: 1,
      payload: { ticketId, entries: [
        { opName: 'Unknown', workerId: 2, rateSnapshot: 9 },
        { opName: 'Zero', workerId: 2, rateSnapshot: 9 },
        { opName: 'New', workerId: 2, rateSnapshot: 9 }
      ] }
    });
    expect(db.prepare('SELECT id, op_name, rate_snapshot FROM ticket_entries WHERE ticket_id = ? ORDER BY op_name')
      .all(ticketId)).toEqual([
        { id: `${ticketId}_edit_op_reorder_entry_3`, op_name: 'New', rate_snapshot: null },
        { id: 'old-unknown', op_name: 'Unknown', rate_snapshot: null },
        { id: 'old-zero', op_name: 'Zero', rate_snapshot: 0 }
      ]);
  });

  it('never recycles removed work identities over successive local edits, including a re-added operation', () => {
    const db = seedModel();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO workers (id, company_id, name, created_at, updated_at) VALUES (1, ?, 'A', ?, ?)`)
      .run(companyId, now, now);
    const ticketId = '11111111-1111-4111-8111-111111111121';
    db.prepare(`INSERT INTO tickets (id, company_id, model_id, party_number, patta_number, qty,
      status, submitted_at, created_at, server_revision) VALUES (?, ?, 'model_one', '1', 1, 3,
      'CONFIRMED', ?, ?, 1)`).run(ticketId, companyId, now, now);
    const insert = db.prepare(`INSERT INTO ticket_entries (id, ticket_id, company_id, op_name, worker_id,
      rate_snapshot, qty, created_at) VALUES (?, ?, ?, ?, 1, ?, 3, ?)`);
    insert.run(`${ticketId}_entry_1`, ticketId, companyId, 'Cut', 5, now);
    insert.run(`${ticketId}_entry_2`, ticketId, companyId, 'Sew', 7, now);
    const edit = (operationId: string, baseRevision: number, entries: Array<{ opName: string; entryId?: string }>) =>
      workbookCommandPipeline.executeWorkbookCommand(userData, companyId, {
        commandType: 'UpdateTicket', commandId: `cmd_${operationId}`, operationId,
        companyId, entityId: ticketId, baseRevision,
        payload: { ticketId, entries: entries.map((entry) => ({ ...entry, workerId: 1, rateSnapshot: 999 })) }
      });
    edit('remove_sew', 1, [{ opName: 'Cut' }]);
    edit('add_pack', 2, [{ opName: 'Pack' }, { opName: 'Cut' }]);
    const packId = `${ticketId}_edit_add_pack_entry_1`;
    expect(db.prepare('SELECT id, rate_snapshot FROM ticket_entries WHERE op_name = ?').get('Pack'))
      .toEqual({ id: packId, rate_snapshot: null });
    edit('replace_pack', 3, [{ opName: 'Cut' }]);
    edit('readd_sew', 4, [{ opName: 'Sew' }, { opName: 'Cut' }, { opName: 'Pack' }]);
    expect(db.prepare('SELECT id, op_name, rate_snapshot FROM ticket_entries WHERE ticket_id = ? ORDER BY op_name').all(ticketId))
      .toEqual([
        { id: `${ticketId}_entry_1`, op_name: 'Cut', rate_snapshot: 5 },
        { id: `${ticketId}_edit_readd_sew_entry_3`, op_name: 'Pack', rate_snapshot: null },
        { id: `${ticketId}_edit_readd_sew_entry_1`, op_name: 'Sew', rate_snapshot: null }
      ]);
    expect(db.prepare('SELECT local_archive_json FROM local_outbox WHERE operation_id = ?').get('remove_sew'))
      .toMatchObject({ local_archive_json: expect.stringContaining(`${ticketId}_entry_2`) });
  });

  it('rejects ambiguous historical operation matches without deleting existing entries', () => {
    const db = seedModel();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO workers (id, company_id, name, created_at, updated_at) VALUES (1, ?, 'A', ?, ?)`)
      .run(companyId, now, now);
    const ticketId = '11111111-1111-4111-8111-111111111120';
    db.prepare(`INSERT INTO tickets (id, company_id, model_id, party_number, patta_number, qty,
      status, submitted_at, created_at, server_revision) VALUES (?, ?, 'model_one', '1', 1, 3,
      'CONFIRMED', ?, ?, 1)`).run(ticketId, companyId, now, now);
    const insert = db.prepare(`INSERT INTO ticket_entries (id, ticket_id, company_id, op_name, worker_id,
      rate_snapshot, qty, created_at) VALUES (?, ?, ?, 'Cut', 1, ?, 3, ?)`);
    insert.run('old-one', ticketId, companyId, 5, now);
    insert.run('old-two', ticketId, companyId, 9, now);
    expect(() => workbookCommandPipeline.executeWorkbookCommand(userData, companyId, {
      commandType: 'UpdateTicket', commandId: 'cmd_ambiguous', operationId: 'op_ambiguous',
      companyId, entityId: ticketId, baseRevision: 1,
      payload: { ticketId, entries: [{ opName: 'Cut', workerId: 2, rateSnapshot: 5 }] }
    })).toThrow(/Cannot identify original work/);
    expect(db.prepare('SELECT id, rate_snapshot FROM ticket_entries WHERE ticket_id = ? ORDER BY id').all(ticketId))
      .toEqual([{ id: 'old-one', rate_snapshot: 5 }, { id: 'old-two', rate_snapshot: 9 }]);
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
        batchSettingsBaseRevision: 0,
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
        batchSettingsBaseRevision: 1,
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

  it('accepts a period archive larger than the ticket-edit rollback limit', () => {
    const db = seedModel();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO periods (id, company_id, name, start_date, created_at)
      VALUES ('period_large_archive', ?, 'Current', '2026-09-01', ?)`).run(companyId, now);
    const localArchive = {
      period: { id: 'period_large_archive', name: 'Current', startDate: '2026-09-01' },
      submittedTickets: [],
      details: 'x'.repeat(100 * 1024)
    };

    const result = workbookCommandPipeline.executeWorkbookCommand(userData, companyId, {
      commandType: 'ClosePeriod',
      commandId: 'cmd_period_large_archive',
      operationId: 'op_period_large_archive',
      companyId,
      entityId: 'period_large_archive',
      payload: {
        periodId: 'period_large_archive',
        endDate: '2026-09-30',
        nextPeriod: { id: 'period_after_large_archive', name: 'Next', startDate: '2026-10-01' },
        archiveFilename: 'archive_period_large.json'
      },
      localArchive
    });

    expect(result).toMatchObject({ committed: true, status: 'PENDING_SYNC' });
    expect(db.prepare('SELECT length(local_archive_json) AS length FROM local_outbox WHERE operation_id = ?')
      .get('op_period_large_archive').length).toBeGreaterThan(64 * 1024);
    expect(db.prepare('SELECT length(archive_json) AS length FROM period_archives WHERE company_id = ? AND period_id = ?')
      .get(companyId, 'period_large_archive').length).toBeGreaterThan(64 * 1024);
  });

  it('keeps the 64 KiB rollback snapshot limit for ticket edits', () => {
    const ticketId = '11111111-1111-4111-8111-111111111111';
    expect(() => workbookCommandPipeline.executeWorkbookCommand(userData, companyId, {
      commandType: 'UpdateTicket',
      commandId: 'cmd_large_ticket_archive',
      operationId: 'op_large_ticket_archive',
      companyId,
      entityId: ticketId,
      payload: { ticketId, entries: [{ opName: 'Cut', workerId: 1 }] },
      localArchive: { entries: [], details: 'x'.repeat(70 * 1024) }
    })).toThrow(/TICKET_EDIT_ARCHIVE_TOO_LARGE/);
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
    expect(db.prepare('SELECT status, archived_patta_numbers_json FROM parties WHERE id = ?').get('party_complete'))
      .toEqual({ status: 'CLOSED', archived_patta_numbers_json: '[1,2]' });
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
      INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id,
        patta_count, cumulative_patta_count, patta_start_number, patta_end_number, status, created_at, updated_at)
      VALUES ('party_archive', ?, '81', '81', 'model_one', 3, 3, 1, 3, 'ACTIVE', ?, ?)
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
    expect(projection.reusablePattaRanges).toEqual([{ start: 1, end: 3 }]);
  });

  it('reuses archived patta ranges and keeps the remaining allocated ranges unique', () => {
    const db = seedModel();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO parties (
      id, company_id, party_number, physical_party_number, model_id, patta_count,
      cumulative_patta_count, patta_start_number, patta_end_number, status, created_at, updated_at
    ) VALUES ('party_releasable', ?, '81', '81', 'model_one', 3, 3, 1, 3, 'ACTIVE', ?, ?)`)
      .run(companyId, now, now);
    db.prepare(`INSERT INTO company_patta_sequences(company_id, next_patta_number, updated_at)
      VALUES (?, 4, ?) ON CONFLICT(company_id) DO UPDATE SET next_patta_number = 4, updated_at = excluded.updated_at`)
      .run(companyId, now);
    workbookCommandPipeline.executeWorkbookCommand(userData, companyId, {
      commandType: 'ArchivePartyHistory', commandId: 'cmd_release_range', operationId: 'op_release_range',
      companyId, entityId: companyId, payload: { partyRecordIds: ['party_releasable'] }
    });

    const createBatch = (batchId: string, firstPartyId: string, secondPartyId: string) =>
      workbookCommandPipeline.executeWorkbookCommand(userData, companyId, {
        commandType: 'CompletePattaBatch', commandId: `cmd_${batchId}`, operationId: `op_${batchId}`,
        companyId, entityId: batchId,
        payload: {
          batchId,
          batchSettingsBaseRevision: 0,
          parties: [
            { id: firstPartyId, partyNumber: '82', modelId: 'model_one', modelName: 'Model One', color: 'Qora', pattaCount: 2, ishSoni: 10, totalIshSoni: 10, sizes: { M: 2 }, printedAt: now },
            { id: secondPartyId, partyNumber: '83', modelId: 'model_one', modelName: 'Model One', color: 'Qora', pattaCount: 2, ishSoni: 10, totalIshSoni: 10, sizes: { M: 2 }, printedAt: now }
          ],
          availableSizes: ['M'],
          configs: [{ modelId: 'model_one', partyNumber: '', isCustomParty: false, totalIshSoni: '', color: 'Qora', sizes: { M: '' } }]
        }
      });

    const result = createBatch('batch_after_archive', 'party_reused', 'party_after_free_range');
    const ranges = db.prepare(`SELECT id, patta_start_number, patta_end_number FROM parties
      WHERE company_id = ? AND id IN ('party_reused', 'party_after_free_range') ORDER BY id`).all(companyId);

    expect(result).toMatchObject({ committed: true, status: 'PENDING_SYNC' });
    expect(ranges).toEqual([
      { id: 'party_after_free_range', patta_start_number: 4, patta_end_number: 5 },
      { id: 'party_reused', patta_start_number: 1, patta_end_number: 2 }
    ]);
    expect(db.prepare('SELECT next_patta_number FROM company_patta_sequences WHERE company_id = ?').get(companyId).next_patta_number)
      .toBe(6);
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
    expect(apply('CreateParty', 'op_party_for_series', 'party', 'party_for_series', {
      partyRecordId: 'party_for_series', partyNumber: '42', modelId: 'model_one', modelName: 'Model One',
      pattaCount: 1, cumulativePattaCount: 2, ishSoniPerPatta: 10, totalIshSoni: 10, ishSoni: 10,
      cumulativeIshSoni: 20, sizes: { M: 1 }, printedAt: '2026-09-23T10:00:00.000Z'
    }).committed).toBe(true);
    db.prepare(`INSERT INTO company_patta_sequences(company_id, next_patta_number, updated_at)
      VALUES (?, 566, ?) ON CONFLICT(company_id) DO UPDATE SET next_patta_number = 566, updated_at = excluded.updated_at`)
      .run(companyId, now);
    expect(apply('CompletePartySeries', 'op_series', 'party_series', 'period_current', { periodId: 'period_current', endDate: '2026-09-30' }).committed).toBe(true);
    expect(db.prepare('SELECT next_patta_number FROM company_patta_sequences WHERE company_id = ?').get(companyId).next_patta_number).toBe(1);
    expect(apply('CompletePattaBatch', 'op_new_series_batch', 'patta_batch', 'batch_new_series', {
      batchId: 'batch_new_series',
      batchSettingsBaseRevision: 1,
      parties: [{ id: 'party_new_series', partyNumber: '1', modelId: 'model_one', modelName: 'Model One',
        pattaCount: 12, ishSoniPerPatta: 10, totalIshSoni: 120, ishSoni: 120, sizes: { M: '12' }, printedAt: now }],
      availableSizes: ['M'],
      configs: [{ modelId: 'model_one', partyNumber: '', isCustomParty: false, totalIshSoni: '', color: 'Qora', sizes: { M: '' } }]
    }).committed).toBe(true);
    expect(db.prepare('SELECT patta_start_number, patta_end_number FROM parties WHERE company_id = ? AND id = ?')
      .get(companyId, 'party_new_series')).toEqual({ patta_start_number: 1, patta_end_number: 12 });
    expect(apply('DeactivateWorker', 'op_worker_deactivate', 'worker', '81', { workerId: 81 }).committed).toBe(true);
    expect(apply('DeactivateModel', 'op_model_deactivate', 'model', 'model_one', { modelId: 'model_one' }).committed).toBe(true);

    expect(db.prepare('SELECT status FROM models WHERE company_id = ? AND id = ?').get(companyId, 'model_one').status).toBe('INACTIVE');
    expect(db.prepare('SELECT status FROM workers WHERE company_id = ? AND id = 81').get(companyId).status).toBe('INACTIVE');
    expect(db.prepare('SELECT is_closed, status FROM periods WHERE company_id = ? AND id = ?').get(companyId, 'period_current'))
      .toMatchObject({ is_closed: 0, status: 'OPEN' });
    expect(db.prepare('SELECT status, is_archived FROM parties WHERE company_id = ? AND id = ?').get(companyId, 'party_current'))
      .toMatchObject({ status: 'CLOSED', is_archived: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM local_outbox WHERE company_id = ?').get(companyId).count).toBe(11);
  });

  it('keeps month and finish proofs provisional until exact accepted feed facts; reopens with frozen P hash intact', () => {
    const db = seedModel();
    const now = '2026-09-20T00:00:00.000Z';
    db.prepare(`INSERT INTO periods(id,company_id,name,start_date,is_closed,status,created_at)
      VALUES('P',?,'P','2026-09-01',0,'OPEN',?)`).run(companyId, now);
    db.prepare(`INSERT INTO parties(id,company_id,party_number,physical_party_number,model_id,patta_count,
      sizes_json,patta_start_number,patta_end_number,status,printed_at,created_at,updated_at)
      VALUES('A',?,'1','1','model_one',2,'{"M":2}',1,2,'ACTIVE',?,?,?)`).run(companyId, now, now, now);
    db.prepare(`INSERT INTO parties(id,company_id,party_number,physical_party_number,model_id,patta_count,
      sizes_json,patta_start_number,patta_end_number,status,printed_at,created_at,updated_at)
      VALUES('B',?,'2','2','model_one',1,'{"M":1}',3,3,'ACTIVE',?,?,?)`).run(companyId, now, now, now);
    for (const [id, party, number, qty] of [['A1', 'A', 1, 10], ['B1', 'B', 3, 7]] as const) {
      db.prepare(`INSERT INTO tickets(id,company_id,model_id,period_id,party_number,party_record_id,
        patta_number,qty,status,submitted_at,created_at) VALUES(?,?,'model_one','P',?, ?, ?,?,'CONFIRMED',?,?)`)
        .run(id, companyId, party === 'A' ? '1' : '2', party, number, qty, now, now);
    }
    const archive = { period: { id: 'P' }, submittedTickets: [{ id: 'A1', qty: 10 }, { id: 'B1', qty: 7 }],
      gross: 119, tariff: 7 };
    const execute = (type: string, id: string, entityType: string, entityId: string, payload: any, localArchive?: any) =>
      workbookCommandPipeline.executeWorkbookCommand(userData, companyId, {
        commandType: type, commandId: id, operationId: id, companyId, entityType, entityId, payload, localArchive
      });
    execute('ClosePeriod', 'closeP', 'period', 'P', { periodId: 'P', endDate: '2026-09-30',
      nextPeriod: { id: 'Q', name: 'Q', startDate: '2026-10-01' } }, archive);
    expect(db.prepare(`SELECT close_operation_id FROM periods WHERE id='P'`).get().close_operation_id).toBeNull();
    expect(db.prepare(`SELECT month_closed_period_id FROM parties WHERE id='B'`).get().month_closed_period_id).toBeNull();
    const savedP = db.prepare(`SELECT archive_json, sha256 FROM period_archives WHERE period_id='P'`).get();
    expect(JSON.parse(savedP.archive_json).gross).toBe(119);
    expect(JSON.parse(savedP.archive_json)).not.toHaveProperty('before');
    expect(JSON.parse(db.prepare(`SELECT local_archive_json FROM local_outbox WHERE operation_id='closeP'`).get().local_archive_json))
      .toMatchObject({ kind: 'period-close-effects', effects: { completedPartyIds: ['B'] } });

    const { applyChangesBatch } = require('../sync/changeFeedApplier.cjs');
    const event = (entityType: string, entityId: string, entityRevision: number, payload: any, changeId: string) =>
      ({ entityType, entityId, entityRevision, payload, changeId, changeType: 'UPDATE', operationId: payload.endedOperationId || 'closeP' });
    applyChangesBatch(db, companyId, [
      event('period', 'P', 1, { periodId: 'P', status: 'CLOSED', endDate: '2026-09-30',
        closedAt: now, closeOperationId: 'closeP' }, '1'),
      event('party', 'B', 1, { partyRecordId: 'B', status: 'CLOSED', isClosed: true,
        closedAt: now, monthClosedPeriodId: 'P', archivedPattaNumbers: [3] }, '2'),
      event('party', 'A', 1, { partyRecordId: 'A', archivedPattaNumbers: [1] }, '3')
    ], '3');
    expect(db.prepare(`SELECT month_closed_period_id FROM parties WHERE id='B'`).get().month_closed_period_id).toBe('P');
    expect(db.prepare(`SELECT status, archived_patta_numbers_json FROM parties WHERE id='A'`).get())
      .toEqual({ status: 'ACTIVE', archived_patta_numbers_json: '[1]' });
    execute('CompletePartySeries', 'finishQ', 'party_series', 'Q', { periodId: 'Q', endDate: '2026-10-31' });
    const intent = JSON.parse(db.prepare(`SELECT payload_json FROM local_outbox WHERE operation_id='finishQ'`).get().payload_json);
    expect(intent.finishScopeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(db.prepare(`SELECT ended_at FROM parties WHERE id='B'`).get().ended_at).toBeNull();
    applyChangesBatch(db, companyId, [
      event('party', 'A', 2, { partyRecordId: 'A', status: 'CLOSED', isClosed: true, closedAt: now,
        endedAt: now, endedOperationId: 'finishQ' }, '4'),
      event('party', 'B', 2, { partyRecordId: 'B', status: 'CLOSED', isClosed: true, closedAt: now,
        endedAt: now, endedOperationId: 'finishQ', monthClosedPeriodId: 'P' }, '5')
    ], '5');
    expect(db.prepare(`SELECT ended_operation_id, month_closed_period_id FROM parties WHERE id='B'`).get())
      .toEqual({ ended_operation_id: 'finishQ', month_closed_period_id: 'P' });
    expect(db.prepare(`SELECT archive_json, sha256 FROM period_archives WHERE period_id='P'`).get()).toEqual(savedP);
    databaseManager.closeAllCompanyDatabases();
    const reopened = databaseManager.getCompanyDatabase(userData, companyId);
    expect(reopened.prepare(`SELECT ended_operation_id FROM parties WHERE id='A'`).get().ended_operation_id).toBe('finishQ');
    expect(reopened.prepare(`SELECT archive_json, sha256 FROM period_archives WHERE period_id='P'`).get()).toEqual(savedP);
  });

  it('replaces only its own provisional P archive with a verified accepted archive once', async () => {
    const db = seedModel();
    db.prepare(`INSERT INTO periods(id,company_id,name,start_date,is_closed,status,closed_at,close_operation_id,created_at)
      VALUES('P',?,'P','2026-09-01',1,'CLOSED','2026-09-30T00:00:00.000Z','closeP','2026-09-01')`).run(companyId);
    const local = { period: { id: 'P' }, gross: 100 };
    const server = { period: { id: 'P' }, gross: 119, tariff: 7 };
    const localHash = computePayloadHash(canonicalStringify(local));
    const serverHash = computePayloadHash(canonicalStringify(server));
    db.prepare(`INSERT INTO period_archives(company_id,period_id,archive_json,sha256,archived_at) VALUES(?,'P',?,?,?)`)
      .run(companyId, JSON.stringify(local), localHash, '2026-09-30');
    const { insertOutboxOperation } = outboxManager;
    insertOutboxOperation(db, { operation_id: 'closeP', company_id: companyId, command_type: 'ClosePeriod',
      entity_type: 'period', entity_id: 'P', base_revision: 0, payload_json: '{}', payload_hash: computePayloadHash('{}'),
      status: 'SYNCED', created_at: '2026-09-30', local_archive_json: JSON.stringify({ version: 1,
        kind: 'period-close-effects', operationId: 'closeP', periodArchive: local,
        effects: { provisionalArchiveSha256: localHash } }) });
    const { reconcileLifecycleArchives } = require('../sync/lifecycleArchiveReconcile.cjs');
    const client = { getPeriodArchive: async () => ({ archive_json: server, sha256: serverHash, archived_at: '2026-09-30' }) };
    expect(await reconcileLifecycleArchives(db, companyId, client)).toEqual({ reconciled: 1, incomplete: 0 });
    expect(db.prepare(`SELECT archive_json,sha256 FROM period_archives WHERE period_id='P'`).get())
      .toEqual({ archive_json: JSON.stringify(server), sha256: serverHash });
    expect(await reconcileLifecycleArchives(db, companyId, { getPeriodArchive: async () => { throw Error('must not reread'); } }))
      .toEqual({ reconciled: 0, incomplete: 0 });
    expect(db.prepare(`SELECT archive_json,sha256 FROM period_archives WHERE period_id='P'`).get().sha256).toBe(serverHash);
  });

  it('rejected series scope restores only its own provisional reservation/sequence and retains exact intent', async () => {
    const db = seedModel();
    const now = '2026-09-01T00:00:00.000Z';
    db.prepare(`INSERT INTO periods(id,company_id,name,start_date,status,created_at)
      VALUES('P',?,'P','2026-09-01','OPEN',?)`).run(companyId, now);
    db.prepare(`INSERT INTO parties(id,company_id,party_number,physical_party_number,model_id,patta_count,
      sizes_json,status,created_at,updated_at)
      VALUES('A',?,'1','1','model_one',1,'{"M":1}','ACTIVE',?,?)`).run(companyId, now, now);
    db.prepare(`INSERT INTO company_patta_sequences(company_id,next_patta_number,updated_at) VALUES(?,9,?)`)
      .run(companyId, now);
    db.prepare(`INSERT INTO local_meta(key,value,updated_at) VALUES('patta_lifecycle_v1','1',?)`).run(now);
    workbookCommandPipeline.executeWorkbookCommand(userData, companyId, {
      commandType: 'CompletePartySeries', commandId: 'finishP', operationId: 'finishP',
      companyId, entityType: 'party_series', entityId: 'P', payload: { periodId: 'P', endDate: '2026-09-30' }
    });
    expect(db.prepare(`SELECT status, ended_at FROM parties WHERE id='A'`).get())
      .toEqual({ status: 'CLOSED', ended_at: null });
    expect(db.prepare(`SELECT next_patta_number FROM company_patta_sequences WHERE company_id=?`).get(companyId).next_patta_number).toBe(1);
    const outbox = db.prepare(`SELECT payload_json,local_archive_json FROM local_outbox WHERE operation_id='finishP'`).get();
    expect(JSON.parse(outbox.local_archive_json).effects.partyIds).toEqual(['A']);
    expect(await outboxDispatcher.dispatchOutbox(db, companyId, {
      pushOperations: async () => ({ results: [{ operationId: 'finishP', status: 'CONFLICT', error: { code: 'FINISH_SCOPE_CHANGED' } }] })
    })).toMatchObject({ conflict: 1 });
    expect(db.prepare(`SELECT status, ended_at FROM parties WHERE id='A'`).get())
      .toEqual({ status: 'ACTIVE', ended_at: null });
    expect(db.prepare(`SELECT next_patta_number FROM company_patta_sequences WHERE company_id=?`).get(companyId).next_patta_number).toBe(9);
    expect(db.prepare(`SELECT status,payload_json FROM local_outbox WHERE operation_id='finishP'`).get())
      .toMatchObject({ status: 'CONFLICT', payload_json: outbox.payload_json });
  });

  it('persists four distinct period-scoped worker adjustments atomically and rejects duplicate or closed-period writes', () => {
    const db = seedModel();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO periods(id,company_id,name,start_date,is_closed,status,server_revision,created_at,updated_at)
      VALUES ('period-money',?,'Money','2026-09-01',0,'OPEN',1,?,?)`).run(companyId, now, now);
    db.prepare(`INSERT INTO workers(id,company_id,name,staj,role,status,server_revision,created_at,updated_at)
      VALUES (81,?,'Worker',25000,'Sewing','ACTIVE',1,?,?)`).run(companyId, now, now);
    const command = (operationId: string, balanceAdjustments: any[], baseRevision = 1) => ({
      commandType: 'UpsertWorker', commandId: `cmd_${operationId}`, operationId, companyId,
      entityId: '81', baseRevision,
      payload: { workerId: 81, name: 'Worker', staj: 25000, role: 'Sewing', status: 'ACTIVE', balanceAdjustments }
    });
    const balances = [
      { adjustmentId: 'av-81', type: 'AVANS', amountDelta: 200000, periodId: 'period-money' },
      { adjustmentId: 'ja-81', type: 'JARIMA', amountDelta: 50000, periodId: 'period-money' },
      { adjustmentId: 'ok-81', type: 'OKLAD', amountDelta: 2000000, periodId: 'period-money' },
      { adjustmentId: 'mg-81', type: 'MAGAZIN', amountDelta: 100000, periodId: 'period-money' }
    ];
    expect(workbookCommandPipeline.executeWorkbookCommand(userData, companyId, command('op_money_four', balances)))
      .toMatchObject({ committed: true, status: 'PENDING_SYNC' });
    expect(db.prepare(`SELECT type,amount,period_id,status FROM worker_adjustments
      WHERE company_id=? AND worker_id=81 ORDER BY type`).all(companyId)).toEqual([
      { type: 'AVANS', amount: 200000, period_id: 'period-money', status: 'POSTED' },
      { type: 'JARIMA', amount: 50000, period_id: 'period-money', status: 'POSTED' },
      { type: 'MAGAZIN', amount: 100000, period_id: 'period-money', status: 'POSTED' },
      { type: 'OKLAD', amount: 2000000, period_id: 'period-money', status: 'POSTED' }
    ]);
    expect(db.prepare(`SELECT json_extract(payload_json,'$.balanceAdjustments') AS balances FROM local_outbox
      WHERE company_id=? AND operation_id='op_money_four'`).get(companyId).balances).toBeTruthy();

    expect(() => workbookCommandPipeline.executeWorkbookCommand(userData, companyId,
      command('op_money_duplicate_kind', [balances[0], { ...balances[1], adjustmentId: 'av-duplicate', type: 'AVANS' }], 2)))
      .toThrow(/DUPLICATE_WORKER_ADJUSTMENT/);
    expect(() => workbookCommandPipeline.executeWorkbookCommand(userData, companyId,
      command('op_money_duplicate_id', [balances[0], { ...balances[1], adjustmentId: 'av-81' }], 2)))
      .toThrow(/DUPLICATE_WORKER_ADJUSTMENT/);
    expect(() => workbookCommandPipeline.executeWorkbookCommand(userData, companyId,
      command('op_money_unsafe', [{ ...balances[2], adjustmentId: 'ok-unsafe', amountDelta: 1.5 }], 2)))
      .toThrow(/INVALID_NUMBER/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM local_outbox WHERE company_id=? AND operation_id LIKE 'op_money_duplicate_%'").get(companyId).n).toBe(0);

    db.prepare("UPDATE periods SET is_closed=1,status='CLOSED' WHERE company_id=? AND id='period-money'").run(companyId);
    expect(() => workbookCommandPipeline.executeWorkbookCommand(userData, companyId,
      command('op_money_closed', [{ ...balances[2], adjustmentId: 'ok-closed' }], 2))).toThrow(/PERIOD_NOT_FOUND/);
    expect(db.prepare("SELECT name,server_revision FROM workers WHERE company_id=? AND id=81").get(companyId))
      .toMatchObject({ name: 'Worker', server_revision: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM worker_adjustments WHERE company_id=? AND worker_id=81").get(companyId).n).toBe(4);
    expect(db.prepare("SELECT COUNT(*) AS n FROM local_outbox WHERE company_id=? AND operation_id='op_money_closed'").get(companyId).n).toBe(0);
  });
});
