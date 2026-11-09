import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const Fastify = require('fastify');
const manager = require('../database/databaseManager.cjs');
const { insertOutboxOperation, getOperation } = require('../database/outboxManager.cjs');
const { computePayloadHash, canonicalStringify } = require('../database/canonicalPayload.cjs');
const { executeSubmitTicketCommand } = require('../database/commandPipeline.cjs');
const { createOperationsHandler } = require('../../../server/modules/sync/handlers/operations.cjs');
const { SyncClient } = require('./syncClient.cjs');
const { dispatchOutbox } = require('./outboxDispatcher.cjs');
const { executeReconnectProtocol } = require('./reconnectManager.cjs');
const company = 'batch04_retry_fixture';
const ticket = '00000000-0000-4000-8000-000000000405';

describe('HTTP retry through real SyncClient and isolated SQLite outbox', () => {
  let directory: string;
  let db: any;
  let app: any;
  let commits: string[];
  let accepted: Map<string, any>;
  let serverFacts: Map<string, any>;
  let fail: string | null;
  let client: any;

  beforeEach(async () => {
    const fixtureRoot = path.join(process.cwd(), '.opencode', 'deep-audit', 'output', 'test-tmp');
    fs.mkdirSync(fixtureRoot, { recursive: true });
    directory = fs.mkdtempSync(path.join(fixtureRoot, 'offline-reconnect-'));
    db = manager.getCompanyDatabase(directory, company);
    commits = [];
    accepted = new Map();
    serverFacts = new Map();
    fail = null;
    const pool = { connect: async () => {
      let staged: any = {};
      let opId: string;
      return { release: () => {}, query: async (sql: string, params: any[] = []) => {
        if (sql === 'BEGIN') staged = {};
        if (sql.includes('FROM operations_dedup') && sql.includes('FOR UPDATE')) opId = params[1];
        if (opId === fail && sql.includes('INSERT INTO change_log')) throw Object.assign(new Error('database unavailable'), { code: '40P01' });
        if (sql === 'ROLLBACK') { staged = {}; return { rows: [] }; }
        if (sql === 'COMMIT') {
          if (staged.changed) commits.push(opId);
          if (staged.row) accepted.set(opId, staged.row);
          if (staged.ticket) serverFacts.set(staged.ticket.id, staged.ticket);
          return { rows: [] };
        }
        if (sql.includes('FROM operations_dedup') && sql.includes('FOR UPDATE')) return { rows: accepted.has(opId) ? [accepted.get(opId)] : [] };
        if (sql.includes('FROM model_id_aliases') || sql.includes('FROM party_id_aliases')) return { rows: [] };
        if (sql.includes('FROM activation_companies')) return { rows: [] };
        if (sql.includes('FROM periods') && sql.includes('is_closed = 0')) {
          return { rows: [{ id: 'offline-period', start_date: '2026-09-01', end_date: null }] };
        }
        if (sql.includes('FROM models') && sql.includes('operations_json')) {
          return { rows: [{ id: 'offline-model', operations_json: '[{"name":"Sew"}]', status: 'ACTIVE' }] };
        }
        if (sql.includes('FROM workers') && sql.includes('status')) return { rows: [{ id: 71, status: 'ACTIVE' }] };
        if (sql.includes('SELECT id FROM tickets')) return { rows: serverFacts.has(params[1]) ? [{ id: params[1] }] : [] };
        if (sql.includes('FROM tickets') && sql.includes('FOR UPDATE')) return { rows: opId === 'invalid' ? [] : [{ id: ticket, status: 'CONFIRMED', is_closed: 0 }] };
        if (sql.includes('UPDATE tickets SET status')) return { rows: [{ server_revision: 2 }] };
        if (sql.includes('INSERT INTO tickets')) staged.ticket = { id: params[0], companyId: params[1], status: 'CONFIRMED' };
        if (sql.includes('INSERT INTO change_log')) { staged.changed = true; return { rows: [{ change_id: commits.length + 1 }] }; }
        if (sql.includes('INSERT INTO operations_dedup')) staged.row = { payload_hash: params[5], command_type: params[2], entity_type: params[3], entity_id: params[4],
          result_json: params[6], server_revision: params[7], accepted_at: params[8] };
        return { rows: [] };
      } };
    } };
    app = Fastify();
    app.decorateRequest('auth', null);
    app.addHook('preHandler', async (request: any) => { request.auth = { companyId: company, deviceId: 'fixture' }; });
    app.post('/api/sync/operations', createOperationsHandler(pool));
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: any) => {
      if (url.endsWith('/status')) throw new Error('status endpoint unavailable');
      const response = await app.inject({ method: options.method, url: '/api/sync/operations', payload: JSON.parse(options.body) });
      return new Response(response.payload, { status: response.statusCode });
    }));
    client = new SyncClient({ baseUrl: 'https://fixture.invalid', maxOperationBatchBytes: 8000 });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
    manager.closeAllCompanyDatabases();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function add(id: string, sequence: number, dependency: string | null = null, command = 'DeleteTicket') {
    const payload = { commandId: `cmd_${id}`, operationId: id, companyId: company, ticketId: ticket };
    const payloadJson = canonicalStringify(payload);
    insertOutboxOperation(db, { operation_id: id, company_id: company, command_type: command, entity_type: 'ticket', entity_id: ticket,
      payload_json: payloadJson, payload_hash: computePayloadHash(payloadJson), base_revision: 1,
      causal_sequence: sequence, depends_on_operation_id: dependency, status: 'PENDING', created_at: `2026-09-01T00:00:0${sequence}.000Z` });
  }
  function identity(id: string) {
    const row = getOperation(db, company, id);
    return [row.operation_id, row.command_type, row.entity_type, row.entity_id, row.payload_json, row.payload_hash, row.base_revision];
  }

  it('requeues 503 with unchanged identity and blocked child, then acknowledges exact retry', async () => {
    add('parent', 0); add('child', 1, 'parent');
    db.prepare(`INSERT INTO models (id, company_id, name, operations_json, created_at, updated_at)
      VALUES ('model-fixture', ?, 'Fixture', '[]', '2026-09-01', '2026-09-01')`).run(company);
    db.prepare(`INSERT INTO tickets (id, company_id, model_id, party_number, patta_number, qty, status, server_revision, submitted_at, created_at)
      VALUES (?, ?, 'model-fixture', '1', 1, 1, 'PENDING_DELETE', 1, '2026-09-01', '2026-09-01')`).run(ticket, company);
    const original = identity('parent');
    fail = 'parent';
    expect(await dispatchOutbox(db, company, client)).toMatchObject({ attempted: 1, transientErrors: 1, deadLetter: 0 });
    expect(getOperation(db, company, 'parent').status).toBe('PENDING');
    expect(getOperation(db, company, 'child').status).toBe('PENDING');
    expect(identity('parent')).toEqual(original);
    expect(db.prepare('SELECT status FROM tickets WHERE id = ?').get(ticket).status).toBe('PENDING_DELETE');
    fail = null;
    expect(await dispatchOutbox(db, company, client)).toMatchObject({ attempted: 1, synced: 1 });
    expect(getOperation(db, company, 'parent').status).toBe('SYNCED');
    expect(db.prepare('SELECT status FROM tickets WHERE id = ?').get(ticket).status).toBe('VOIDED');
    expect(await dispatchOutbox(db, company, client)).toMatchObject({ attempted: 1, synced: 1 });
    expect(commits).toEqual(['parent', 'child']);
  });

  it('mixed A/B/C batch requeues already committed A, then dedup replay prevents double mutation', async () => {
    add('A', 0); add('B', 1); add('C', 2);
    fail = 'B';
    expect(await dispatchOutbox(db, company, client)).toMatchObject({ attempted: 3, transientErrors: 3, deadLetter: 0 });
    expect(commits).toEqual(['A']);
    expect(['A', 'B', 'C'].map(id => getOperation(db, company, id).status)).toEqual(['PENDING', 'PENDING', 'PENDING']);
    fail = null;
    expect(await dispatchOutbox(db, company, client)).toMatchObject({ synced: 3 });
    expect(commits).toEqual(['A', 'B', 'C']);
  });

  it('failure after a successful SyncClient size split requeues the entire attempted outbox', async () => {
    add('splitA', 0); add('splitB', 1);
    client.maxOperationBatchBytes = 600;
    fail = 'splitB';
    const fetch = globalThis.fetch as any;
    expect(await dispatchOutbox(db, company, client)).toMatchObject({ attempted: 2, transientErrors: 2 });
    expect(fetch.mock.calls.length).toBe(2);
    expect(commits).toEqual(['splitA']);
    fail = null;
    expect(await dispatchOutbox(db, company, client)).toMatchObject({ synced: 2 });
    expect(commits).toEqual(['splitA', 'splitB']);
  });

  it('terminal rejection and conflict retain distinct outbox statuses', async () => {
    add('invalid', 0); add('conflicted', 1); add('valid', 2);
    accepted.set('conflicted', { payload_hash: '0'.repeat(64), command_type: 'DeleteTicket',
      entity_type: 'ticket', entity_id: ticket, result_json: {}, server_revision: 2 });
    const result = await dispatchOutbox(db, company, client);
    expect(result).toMatchObject({ deadLetter: 1, conflict: 1, synced: 1 });
    expect(getOperation(db, company, 'invalid').status).toBe('DEAD_LETTER');
    expect(getOperation(db, company, 'conflicted').status).toBe('CONFLICT');
    expect(getOperation(db, company, 'valid').status).toBe('SYNCED');
  });

  it('reopens an authorized offline ticket and reconnects through lost-ACK dedup to SYNCED', async () => {
    const ticketId = '00000000-0000-4000-8000-000000000406';
    const operationId = 'op_offline_restart_acceptance';
    db.prepare(`INSERT INTO models (id, company_id, name, operations_json, created_at, updated_at)
      VALUES ('offline-model', ?, 'Offline model', '[{"name":"Sew"}]', '2026-09-01', '2026-09-01')`).run(company);
    db.prepare(`INSERT INTO workers (id, company_id, name, status, created_at, updated_at)
      VALUES (71, ?, 'Fixture worker', 'ACTIVE', '2026-09-01', '2026-09-01')`).run(company);
    db.prepare(`INSERT INTO periods (id, company_id, name, start_date, is_closed, status, created_at)
      VALUES ('offline-period', ?, 'Offline period', '2026-09-01', 0, 'OPEN', '2026-09-01')`).run(company);

    const command = {
      commandId: 'cmd_offline_restart_acceptance', operationId, companyId: company, ticketId,
      modelId: 'offline-model', periodId: 'offline-period', effectiveDate: '2026-09-01',
      submittedAt: '2026-09-01T12:00:00.000Z', partyNumber: '1', pattaNumber: 1, qty: 1,
      strictParty: false, strictPatta: false,
      entries: [{ opName: 'Sew', workerId: 71, rateSnapshot: 0 }]
    };
    expect(executeSubmitTicketCommand(directory, company, command).committed).toBe(true);
    const originalRow = getOperation(db, company, operationId);
    const originalIdentity = [originalRow.operation_id, originalRow.command_type, originalRow.entity_id,
      originalRow.payload_json, originalRow.payload_hash];
    expect(originalRow.command_type).toBe('SubmitTicket');
    expect(originalRow.status).toBe('PENDING');

    manager.closeAllCompanyDatabases();
    db = manager.getCompanyDatabase(directory, company);
    expect(getOperation(db, company, operationId)).toMatchObject({
      operation_id: operationId, payload_json: originalRow.payload_json, payload_hash: originalRow.payload_hash, status: 'PENDING'
    });
    let loseNextAck = true;
    let firstServerResponse: any;
    vi.mocked(globalThis.fetch as any).mockImplementation(async (url: string, options: any) => {
      if (url.endsWith('/status')) throw new Error('status endpoint unavailable');
      if (url.includes('/api/sync/changes')) {
        return new Response(JSON.stringify({ success: true, items: [], nextCursor: '0', hasMore: false }), { status: 200 });
      }
      const response = await app.inject({ method: options.method, url: '/api/sync/operations', payload: JSON.parse(options.body) });
      if (loseNextAck && response.statusCode === 200) firstServerResponse = JSON.parse(response.payload);
      if (loseNextAck && response.statusCode === 200) {
        loseNextAck = false;
        throw new Error('simulated lost acknowledgement after server commit');
      }
      return new Response(response.payload, { status: response.statusCode });
    });

    const lostAckReconnect = await executeReconnectProtocol(db, company, client);
    expect(lostAckReconnect.pushed).toMatchObject({ attempted: 1, transientErrors: 1 });
    expect(getOperation(db, company, operationId).status).toBe('PENDING');
    expect(firstServerResponse.results[0]).toMatchObject({ status: 'APPLIED' });
    expect(commits).toEqual([operationId]);
    expect(accepted.size).toBe(1);
    expect(serverFacts.size).toBe(1);

    const retryReconnect = await executeReconnectProtocol(db, company, client);
    expect(retryReconnect.pushed).toMatchObject({ attempted: 1, synced: 1 });
    const finalRow = getOperation(db, company, operationId);
    expect(finalRow.status).toBe('SYNCED');
    expect([finalRow.operation_id, finalRow.command_type, finalRow.entity_id, finalRow.payload_json, finalRow.payload_hash])
      .toEqual(originalIdentity);
    expect(commits).toEqual([operationId]);
    expect(accepted.size).toBe(1);
    expect(serverFacts.size).toBe(1);
  });
});
