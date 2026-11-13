import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const manager = require('../core/databaseManager.cjs');
const { executeSubmitTicketCommand } = require('../commands/commandPipeline.cjs');
const { executeWorkbookCommand } = require('../commands/workbookCommandPipeline.cjs');
const { dispatchOutbox } = require('../../sync/outboxDispatcher.cjs');
const { executeWorkbookOperation } = require('../../../../server/modules/sync/workbookOperations.cjs');
const { processSingleOperation } = require('../../../../server/modules/sync/handlers/operations.cjs');
const { applyChangesBatch } = require('../../sync/changeFeedApplier.cjs');
const { loadWorkbookProjectionFromSqlite } = require('../readers/projectionReader.cjs');
const { recoverCapturedTicketProvenanceTickets } = require('../outbox/outboxManager.cjs');
const companyId = 'batch02-period';
const now = '2026-09-15T12:00:00.000Z';
const closePayload = { periodId: 'period-a', endDate: '2026-09-30',
  nextPeriod: { id: 'period-b', name: 'Next', startDate: '2026-10-01' } };

describe('local period completion from active facts (isolated SQLite)', () => {
  let directory: string;
  let db: any;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'novda-batch02-period-'));
    db = manager.getCompanyDatabase(directory, companyId);
    db.prepare(`INSERT INTO models (id, company_id, name, operations_json, created_at, updated_at)
      VALUES ('model-a', ?, 'Model', '[{"name":"Sew","rate":1}]', ?, ?)`).run(companyId, now, now);
    db.prepare(`INSERT INTO workers (id, company_id, name, created_at, updated_at)
      VALUES (1, ?, 'Worker', ?, ?)`).run(companyId, now, now);
    db.prepare(`INSERT INTO periods (id, company_id, name, start_date, created_at)
      VALUES ('period-a', ?, 'Current', '2026-09-01', ?)`).run(companyId, now);
    db.prepare(`INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id,
      patta_count, sizes_json, archived_patta_numbers_json, created_at, updated_at)
      VALUES ('party-a', ?, '1', '1', 'model-a', 1, '{"M":1}', '[]', ?, ?)`).run(companyId, now, now);
  });
  afterEach(() => {
    manager.closeAllCompanyDatabases();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  function submit(number: number, periodId: string | null = 'period-a') {
    const ticketId = `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
    expect(executeSubmitTicketCommand(directory, companyId, {
      commandId: `submit-${number}`, operationId: `submit-${number}`, companyId, ticketId,
      modelId: 'model-a', partyNumber: '1', partyRecordId: 'party-a', periodId,
      pattaNumber: number, qty: 10, submittedAt: now, entries: [{ workerId: 1, opName: 'Sew', rateSnapshot: 1 }]
    }).committed).toBe(true);
    return ticketId;
  }
  async function sync() {
    const result = await dispatchOutbox(db, companyId, { pushOperations: async (ops: any[]) => ({
      results: ops.map(op => ({ operationId: op.operationId, status: 'APPLIED',
        serverRevision: op.commandType === 'DeleteTicket' ? 2 : 1, periodId: 'period-a', committedAt: now }))
    }) });
    expect(result.synced).toBeGreaterThan(0);
  }
  function remove(ticketId: string) {
    return executeWorkbookCommand(directory, companyId, {
      commandType: 'DeleteTicket', commandId: `delete-${ticketId}`, operationId: `delete-${ticketId}`,
      companyId, entityId: ticketId, payload: { ticketId }
    });
  }
  function close() {
    const history = db.prepare('SELECT id, status FROM tickets ORDER BY patta_number').all();
    expect(executeWorkbookCommand(directory, companyId, {
      commandType: 'ClosePeriod', commandId: 'close', operationId: 'close', companyId,
      entityId: 'period-a', payload: closePayload, localArchive: { submittedTickets: history }
    }).committed).toBe(true);
    return JSON.parse(db.prepare('SELECT archive_json FROM period_archives WHERE company_id = ? AND period_id = ?')
      .get(companyId, 'period-a').archive_json);
  }
  function party() {
    return db.prepare('SELECT status, is_closed, archived_patta_numbers_json FROM parties WHERE id = ?').get('party-a');
  }
  it('submit -> accepted -> delete -> accepted -> close retains VOIDED history without fulfilling the party', async () => {
    const id = submit(1);
    await sync(); remove(id); await sync();
    expect(db.prepare('SELECT status FROM tickets WHERE id = ?').get(id).status).toBe('VOIDED');
    const archive = close();
    expect(party()).toEqual({ status: 'ACTIVE', is_closed: 0, archived_patta_numbers_json: '[]' });
    expect(archive).toMatchObject({ completedPartiesCount: 0, rolledOverPartiesCount: 1,
      submittedTickets: [{ id, status: 'VOIDED' }] });
    expect(db.prepare('SELECT status, is_closed FROM tickets WHERE id = ?').get(id)).toEqual({ status: 'VOIDED', is_closed: 1 });
  });
  it('rolls over only accepted valid numbers plus prior history in a mixed valid/VOIDED party', async () => {
    db.prepare(`UPDATE parties SET patta_count = 3, sizes_json = '{"M":3}', archived_patta_numbers_json = '[1]'`).run();
    submit(2); const deleted = submit(3); await sync(); remove(deleted); await sync();
    const archive = close();
    expect(party()).toEqual({ status: 'ACTIVE', is_closed: 0, archived_patta_numbers_json: '[1,2]' });
    expect(archive).toMatchObject({ completedPartiesCount: 0, rolledOverPartiesCount: 1 });
    expect(archive.submittedTickets.map((t: any) => t.status)).toEqual(['CONFIRMED', 'VOIDED']);
  });
  it('preserves optimistic PENDING_SYNC completion and the historical null-period date fallback', () => {
    submit(1, null);
    const archive = close();
    expect(party().status).toBe('CLOSED');
    expect(archive.completedPartiesCount).toBe(1);
  });
  it('closes September, carries unentered work, then accepts October entry through outbox and real server handler', async () => {
    const archive = close();
    expect(archive).toMatchObject({ rolledOverPartiesCount: 1, completedPartiesCount: 0 });
    expect(party()).toEqual({ status: 'ACTIVE', is_closed: 0, archived_patta_numbers_json: '[]' });
    const ticketId = '00000000-0000-4000-8000-000000000888';
    const command = { commandId: 'oct-entry', operationId: 'oct-entry', companyId, ticketId,
      modelId: 'model-a', partyNumber: '1', partyRecordId: 'party-a', periodId: 'period-b',
      pattaNumber: 1, qty: 10, effectiveDate: '2026-10-15', submittedAt: '2026-10-15T12:00:00.000Z',
      entries: [{ workerId: 1, opName: 'Sew', rateSnapshot: 5 }] };
    expect(executeSubmitTicketCommand(directory, companyId, command).committed).toBe(true);
    const original = db.prepare("SELECT payload_json, payload_hash FROM local_outbox WHERE operation_id = 'oct-entry'").get();
    const entryRates: unknown[] = [];
    let authoritative: any;
    const accepted = new Map<string, any>();
    const pool = { connect: async () => ({ release: () => undefined, query: async (sql: string, args: any[] = []) => {
      if (sql.includes('FROM operations_dedup') && sql.includes('FOR UPDATE')) return { rows: accepted.has(args[1]) ? [accepted.get(args[1])] : [] };
      if (sql.includes('FROM periods') && sql.includes('is_closed = 0')) return { rows: [{ id: 'period-b', start_date: '2026-10-01', end_date: null }] };
      if (sql.includes('FROM models WHERE')) return { rows: [{ id: 'model-a', status: 'ACTIVE', operations_json: [{ name: 'Sew', rate: 9 }] }] };
      if (sql.includes('FROM workers WHERE')) return { rows: [{ id: 1, status: 'ACTIVE' }] };
       if (sql.includes('FROM parties p')) return { rows: [{ id: 'party-a', party_number: '1', model_id: 'model-a', ish_soni_per_patta: '10', patta_start_number: null, patta_end_number: null }] };
      if (sql.includes('INSERT INTO ticket_entries')) entryRates.push(args[6]);
      if (sql.includes('INSERT INTO change_log')) {
        authoritative = JSON.parse(args[4]);
        return { rows: [{ change_id: 17, committed_at: command.submittedAt }] };
      }
      if (sql.includes('INSERT INTO operations_dedup')) accepted.set(args[1], {
        payload_hash: args[5], command_type: args[2], entity_type: args[3], entity_id: args[4],
        result_json: args[6], server_revision: args[7], accepted_at: args[8]
      });
      return { rows: [] };
    } }) } as any;
    const client = { pushOperations: async (ops: any[]) => ({ results: await Promise.all(ops.map(async op =>
      op.commandType === 'SubmitTicket'
        ? processSingleOperation(pool, { auth: { companyId, deviceId: 'fixture' } }, op)
        : { operationId: op.operationId, status: 'APPLIED', serverRevision: 2, committedAt: now })) }) };
    expect(await dispatchOutbox(db, companyId, client)).toMatchObject({ synced: 2, deadLetter: 0 });
    expect(entryRates).toEqual([5]);
    expect(authoritative).toMatchObject({ periodId: 'period-b', entries: [{ rateSnapshot: 5 }] });
    expect(db.prepare('SELECT period_id, status FROM tickets WHERE id = ?').get(ticketId))
      .toEqual({ period_id: 'period-b', status: 'CONFIRMED' });
    expect(db.prepare("SELECT payload_json, payload_hash FROM local_outbox WHERE operation_id = 'oct-entry'").get()).toEqual(original);
    expect(loadWorkbookProjectionFromSqlite(db, companyId).submittedTickets.some((t: any) => t.id === ticketId)).toBe(true);
    applyChangesBatch(db, companyId, [{ changeId: '17', companyId, entityType: 'ticket', entityId: ticketId,
      entityRevision: 1, changeType: 'INSERT', payload: authoritative }], '17');
    expect(db.prepare('SELECT period_id, status FROM tickets WHERE id = ?').get(ticketId))
      .toEqual({ period_id: 'period-b', status: 'CONFIRMED' });
    const replay = await processSingleOperation(pool, { auth: { companyId, deviceId: 'fixture' } }, {
      operationId: command.operationId, companyId, commandType: 'SubmitTicket', entityType: 'ticket', entityId: ticketId,
      payload: JSON.parse(original.payload_json), payloadHash: original.payload_hash
    });
    expect(replay).toMatchObject({ status: 'APPLIED', isReplay: true, periodId: 'period-b' });
    expect(entryRates).toEqual([5]);
  });
  it('accepts legacy null-period ACK/feed by date while leaving the immutable command null', async () => {
    const id = submit(1, null);
    const before = db.prepare("SELECT payload_json, payload_hash FROM local_outbox WHERE operation_id = 'submit-1'").get();
    expect(await dispatchOutbox(db, companyId, { pushOperations: async () => ({ results: [
      { operationId: 'submit-1', status: 'APPLIED', periodId: 'period-a', serverRevision: 1 }
    ] }) })).toMatchObject({ synced: 1, conflict: 0 });
    expect(db.prepare('SELECT period_id, status FROM tickets WHERE id = ?').get(id))
      .toEqual({ period_id: 'period-a', status: 'CONFIRMED' });
    expect(db.prepare("SELECT payload_json, payload_hash FROM local_outbox WHERE operation_id = 'submit-1'").get()).toEqual(before);
    applyChangesBatch(db, companyId, [{ changeId: '1', companyId, entityType: 'ticket', entityId: id,
      entityRevision: 2, changeType: 'UPDATE', payload: { periodId: 'period-a', status: 'CONFIRMED' } }], '1');
    expect(db.prepare('SELECT period_id, status FROM tickets WHERE id = ?').get(id))
      .toEqual({ period_id: 'period-a', status: 'CONFIRMED' });
  });
  it('accepts authoritative INSERT feed for a pending legacy null-period fact before ACK', async () => {
    const id = submit(1, null);
    const original = db.prepare("SELECT payload_json, payload_hash FROM local_outbox WHERE operation_id = 'submit-1'").get();
    applyChangesBatch(db, companyId, [{ changeId: '1', companyId, entityType: 'ticket', entityId: id,
      entityRevision: 1, changeType: 'INSERT', payload: { ...JSON.parse(original.payload_json), periodId: 'period-a', status: 'CONFIRMED' } }], '1');
    expect(db.prepare('SELECT period_id, status FROM tickets WHERE id = ?').get(id))
      .toEqual({ period_id: 'period-a', status: 'CONFIRMED' });
    expect(db.prepare("SELECT payload_json, payload_hash FROM local_outbox WHERE operation_id = 'submit-1'").get()).toEqual(original);
    expect(await dispatchOutbox(db, companyId, { pushOperations: async () => ({ results: [
      { operationId: 'submit-1', status: 'APPLIED', periodId: 'period-a', serverRevision: 1 }
    ] }) })).toMatchObject({ synced: 1, conflict: 0 });
  });
  it('recovers only unchanged batch05B provenance dead letters while their captured period is still open', () => {
    const id = submit(1);
    const original = db.prepare("SELECT payload_json, payload_hash FROM local_outbox WHERE operation_id = 'submit-1'").get();
    db.prepare(`UPDATE local_outbox SET status = 'DEAD_LETTER', last_error = ? WHERE operation_id = 'submit-1'`)
      .run(JSON.stringify({ code: 'TICKET_RATE_PROVENANCE_REQUIRED' }));
    expect(recoverCapturedTicketProvenanceTickets(db, companyId)).toBe(1);
    expect(db.prepare("SELECT status, payload_json, payload_hash FROM local_outbox WHERE operation_id = 'submit-1'").get())
      .toEqual({ status: 'PENDING', ...original });
    db.prepare(`UPDATE local_outbox SET status = 'DEAD_LETTER', last_error = ? WHERE operation_id = 'submit-1'`)
      .run(JSON.stringify({ code: 'TICKET_RATE_PROVENANCE_REQUIRED' }));
    db.prepare('UPDATE ticket_entries SET rate_snapshot = 9 WHERE ticket_id = ?').run(id);
    expect(recoverCapturedTicketProvenanceTickets(db, companyId)).toBe(0);
    db.prepare('UPDATE ticket_entries SET rate_snapshot = 1 WHERE ticket_id = ?').run(id);
    close();
    expect(recoverCapturedTicketProvenanceTickets(db, companyId)).toBe(0);
  });
  it('excludes pending deletion and rejected/dead facts, not just VOIDED', async () => {
    db.prepare(`UPDATE parties SET patta_count = 3, sizes_json = '{"M":3}'`).run();
    const pendingDelete = submit(1); await sync(); remove(pendingDelete);
    const rejected = submit(2); const conflicted = submit(3);
    db.prepare(`UPDATE tickets SET status = 'DEAD_LETTER' WHERE id = ?`).run(rejected);
    db.prepare(`UPDATE tickets SET status = 'CONFLICT' WHERE id = ?`).run(conflicted);
    close();
    expect(party()).toEqual({ status: 'ACTIVE', is_closed: 0, archived_patta_numbers_json: '[]' });
  });
  it('discard of a rejected local submission remains historical, never completed', () => {
    const id = submit(1);
    db.prepare(`UPDATE local_outbox SET status = 'DEAD_LETTER' WHERE operation_id = 'submit-1'`).run();
    expect(remove(id).localOnly).toBe(true);
    const archive = close();
    expect(party().status).toBe('ACTIVE');
    expect(archive.submittedTickets).toEqual([{ id, status: 'VOIDED' }]);
  });
  it.each(['REJECTED', 'CONFLICT'])('does not fulfill a still-PENDING_SYNC fact whose submission received %s', async status => {
    const id = submit(1);
    await dispatchOutbox(db, companyId, { pushOperations: async () => ({ results: [
      { operationId: 'submit-1', status, error: { code: 'SIMULATED_REJECTION' } }
    ] }) });
    // Dispatcher records submission failure on the outbox, not the ticket fact.
    expect(db.prepare('SELECT status FROM tickets WHERE id = ?').get(id).status).toBe('PENDING_SYNC');
    const archive = close();
    expect(party()).toEqual({ status: 'ACTIVE', is_closed: 0, archived_patta_numbers_json: '[]' });
    expect(archive.completedPartiesCount).toBe(0);
  });
});

// Executes the real server handler with strict query-contract doubles, never a PG connection.
describe('server ClosePeriod completion/query contract (NOT PostgreSQL runtime verification)', () => {
  it.each([
    { mixed: false, complete: false }, { mixed: true, complete: false }, { mixed: true, complete: true }
  ])('uses accepted facts only and retains all statuses in archive (%j)', async ({ mixed, complete }) => {
    const facts = [
      { id: 'void', party_record_id: 'party-a', patta_number: 1, status: 'VOIDED' },
      { id: 'pending', party_record_id: 'party-a', patta_number: 2, status: 'PENDING_SYNC' },
      { id: 'dead', party_record_id: 'party-a', patta_number: 3, status: 'DEAD_LETTER' },
      ...(mixed ? [{ id: 'valid', party_record_id: 'party-a', patta_number: complete ? 1 : 4, status: 'CONFIRMED' }] : [])
    ];
    const queries: Array<{ sql: string; values: any[] }> = [];
    let archive: any;
    let completedQuery = false;
    let partyClosed = false;
    let rollover: number[] | undefined;
    const client = { query: async (raw: string, values: any[] = []) => {
      const sql = raw.replace(/\s+/g, ' ').trim();
      queries.push({ sql, values });
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.startsWith('SELECT id, name, start_date')) return { rows: [{
        id: 'period-a', name: 'Current', start_date: '2026-09-01', is_closed: 0, server_revision: 1
      }] };
      if (sql.startsWith('SELECT id FROM periods')) return { rows: [] };
      if (sql.startsWith('SELECT id, sizes_json')) return { rows: [{
        id: 'party-a', sizes_json: { M: mixed && !complete ? 4 : 1 }, archived_patta_numbers_json: []
      }] };
      if (sql.startsWith('SELECT party_record_id, patta_number FROM tickets')) {
        expect(values).toEqual([companyId, 'period-a', '2026-09-01', '2026-09-30']);
        expect(sql).toContain('company_id = $1');
        expect(sql).toContain('is_closed = 0');
        expect(sql).toMatch(/status = 'CONFIRMED'/);
        completedQuery = true;
        return { rows: facts.filter(t => t.status === 'CONFIRMED') };
      }
      if (sql.startsWith('SELECT id, model_id, period_id')) {
        expect(sql).not.toMatch(/status\s*(=|IN)/);
        return { rows: facts.map(t => ({ ...t, model_id: 'model-a', qty: 10, submitted_at: now })) };
      }
      if (/^SELECT (id, name, hisob_sheet_name|w.id|p.id|c.available_sizes_json|ticket_id, op_name)/.test(sql)) return { rows: [] };
      if (sql.startsWith('INSERT INTO period_archives')) {
        archive = JSON.parse(values[2]); return { rows: [] };
      }
      if (sql.startsWith('UPDATE parties SET archived_patta_numbers_json')) {
        expect(values.slice(2)).toEqual([companyId, 'party-a']);
        rollover = JSON.parse(values[0]); return { rows: [{ server_revision: 2 }] };
      }
      if (sql.startsWith("UPDATE parties SET status = 'CLOSED'")) {
        expect(values[0]).toEqual(expect.any(String));
        expect(JSON.parse(values[1])).toEqual(complete ? [1] : []);
        expect(values.slice(2)).toEqual([companyId, 'party-a', 'period-a']);
        partyClosed = true; return { rows: [{ server_revision: 2 }] };
      }
      if (sql.startsWith('UPDATE tickets SET is_closed')) {
        expect(sql).not.toMatch(/status\s*(=|IN)/);
        expect(values[0]).toBe(companyId);
        return { rows: facts.map(t => ({ id: t.id, server_revision: 2 })) };
      }
      if (sql.startsWith('UPDATE periods') || sql.startsWith('INSERT INTO periods')) return { rows: [] };
      if (sql.startsWith('INSERT INTO change_log')) return { rows: [{ change_id: queries.length, committed_at: now }] };
      throw new Error(`Unexpected server query: ${sql}`);
    } };
    const result = await executeWorkbookOperation(client, companyId, 'close-server', 'ClosePeriod', closePayload, '{}', { baseRevision: 1 });
    expect(result.entityId).toBe('period-a');
    expect(completedQuery).toBe(true);
    expect(partyClosed).toBe(complete);
    expect(rollover).toEqual(complete ? undefined : mixed ? [4] : []);
    expect(archive).toMatchObject({ completedPartiesCount: complete ? 1 : 0, rolledOverPartiesCount: complete ? 0 : 1 });
    expect(archive.submittedTickets.map((t: any) => [t.id, t.status])).toEqual(facts.map(t => [t.id, t.status]));
    expect(queries.some(q => q.sql.startsWith('DELETE FROM tickets'))).toBe(false);
  });
});
