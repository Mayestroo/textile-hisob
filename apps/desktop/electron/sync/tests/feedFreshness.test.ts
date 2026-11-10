import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { payrollDisplay } from '../../../renderer/engine/payrollDisplay';

const manager = require('../../database/core/databaseManager.cjs');
const Database = require('better-sqlite3');
const { getBootstrapFixture } = require('../../tests/fixtures/bootstrap.fixture.cjs');
const { applyBootstrapSnapshot } = require('../bootstrapApplier.cjs');
const { applyChangesBatch, getLocalCursor } = require('../changeFeedApplier.cjs');
const { executePullOnlyProtocol } = require('../reconnectManager.cjs');
const { SyncClient } = require('../syncClient.cjs');
const { loadPayrollValuationFromSqlite } = require('../../database/readers/payrollReader.cjs');
const { readWorkbookPayrollProjection } = require('../../database/readers/workbookPayrollRead.cjs');
const { verifyPage } = require('../feedEvidence.cjs');
const { createChangeFeedHandler } = require('../../../../server/modules/sync/handlers/changeFeed.cjs');
const { canonicalStringify, computePayloadHash } = require('../../database/core/canonicalPayload.cjs');
const { insertOutboxOperation } = require('../../database/outbox/outboxManager.cjs');
const company = 'hisob_test_feed';
const now = '2026-09-15T00:00:00.000Z';
describe('coherent as-of payroll scope on own SQLite and loopback HTTP', () => {
  const directories: string[] = [];
  const rawDatabases: any[] = [];
  afterEach(() => { manager.closeAllCompanyDatabases(); for (const db of rawDatabases.splice(0)) if (db.open) db.close();
    for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
  function fixture(withBaseline = true, requestedTenant?: string) {
    const tenant = requestedTenant || `${company}_${Math.random().toString(36).slice(2, 9)}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hisob-feed-proof-')); directories.push(dir);
    const db = manager.getCompanyDatabase(dir, tenant);
    const response = getBootstrapFixture(tenant);
    response.snapshot.models[0].operations[0].rate = 7;
    if (withBaseline) response.feedBaseline = { protocolVersion: 1, companyId: tenant, headCursor: '42' };
    const bootstrapResult = applyBootstrapSnapshot(db, tenant, response);
    if (bootstrapResult.status !== 'APPLIED') throw new Error(`Fixture bootstrap did not apply for ${tenant}`);
    const read = () => loadPayrollValuationFromSqlite(db, tenant, 'period-1');
    const ticketId = `ticket-${Math.random().toString(36).slice(2)}`;
    const entry = { changeId: '44', companyId: tenant, entityType: 'ticket', entityId: ticketId,
      entityRevision: 1, changeType: 'INSERT', payload: { modelId: 'model-1', periodId: 'period-1',
        partyNumber: '1', pattaNumber: 1, qty: 15, submittedAt: now,
        entries: [{ opName: 'Sew', workerId: 1, rateSnapshot: null }] } };
    const page = (items: any[], fromCursor: string, headCursor = '44', hasMore = false) => ({
      success: true, companyId: tenant, feedProtocolVersion: 1, fromCursor, headCursor,
      nextCursor: hasMore ? items[items.length - 1]?.changeId : headCursor, hasMore, items, nextPattaNumber: 1
    });
    return { dir, db, read, entry, page, tenant };
  }
  it('persists snapshot baseline + terminal scoped feed with global-ID gap; restart and bridge read 105 once', async () => {
    const { dir, db, read, entry, page, tenant } = fixture();
    expect(read()).toMatchObject({ syncStatus: 'CURRENT', feedEvidence: { asOfCursor: '42' }, workers: [{ gross: 0 }] });
    const server = http.createServer((req, res) => {
      const cursor = new URL(req.url!, 'http://127.0.0.1').searchParams.get('cursor')!;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(page(cursor === '42' ? [entry] : [], cursor)));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const client = new SyncClient({ baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, allowHttp: true });
      expect(await executePullOnlyProtocol(db, tenant, client, { maxPages: 1 }))
        .toMatchObject({ pulledCount: 1, proofChanged: true, finalCursor: 44 });
      expect(read()).toMatchObject({ workers: [{ gross: 105, syncStatus: 'CURRENT' }],
        feedEvidence: { asOfCursor: '44', status: 'APPLIED_AS_OF' } });
      const projection = readWorkbookPayrollProjection(db, tenant);
      expect(projection.payrollValuation.workers[0].gross).toBe(105);
      const display = payrollDisplay(projection.models, projection.workers, projection.payrollValuation,
        tenant, 'period-1');
      expect(display.masterReport.totalUmumiy).toBe(105);
      expect(display.label).toContain('cursor 44');
      expect(db.pragma('database_list')).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'main', file: expect.stringContaining('hisob.sqlite') })]));
      expect(db.prepare('SELECT id FROM periods WHERE company_id=?').all(tenant)).toEqual([{ id: 'period-1' }]);
      const sqlitePath = db.name;
      manager.closeAllCompanyDatabases();
      const reopened = new Database(sqlitePath);
      rawDatabases.push(reopened);
      expect(loadPayrollValuationFromSqlite(reopened, tenant, 'period-1'))
        .toMatchObject({ workers: [{ gross: 105 }], feedEvidence: { asOfCursor: '44' } });
      expect((await executePullOnlyProtocol(reopened, tenant, client, { maxPages: 1 })).pulledCount).toBe(0);
      expect(reopened.prepare("SELECT COUNT(*) AS n FROM ticket_entries WHERE company_id=?").get(tenant).n).toBe(1);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('rejects wrong tenant, mismatched from/head, unknown entity, out-of-order and rollback without proof', () => {
    const { db, read, entry, page, tenant } = fixture();
    const bad = [
      page([{ ...entry, companyId: 'foreign' }], '42'),
      page([{ ...entry, payload: { ...entry.payload, companyId: 'foreign' } }], '42'),
      page([entry], '41'),
      page([entry], '42', '43'),
      page([{ ...entry, entityType: 'unknown' }], '42'),
      page([{ ...entry, changeType: 'NOOP' }], '42'),
      page([entry, { ...entry, changeId: '43' }], '42'),
      { ...page([entry], '42'), nextCursor: '43' }
    ];
    for (const response of bad) {
      expect(() => applyChangesBatch(db, tenant, response.items, response.nextCursor, { feedResponse: response }))
        .toThrow('FEED_PROOF_INVALID');
      expect(getLocalCursor(db)).toBe(42);
      expect(read().workers[0].gross).toBe(0);
    }
    const response = page([entry], '42');
    expect(() => applyChangesBatch(db, tenant, response.items, response.nextCursor,
      { feedResponse: response, testHookBeforeCommit: () => { throw new Error('rollback'); } })).toThrow('rollback');
    expect(getLocalCursor(db)).toBe(42);
    expect(read().workers[0].gross).toBe(0);
  });
  it('ignores an in-flight response after its company/period context is invalidated', async () => {
    const { db, read, entry, page, tenant } = fixture();
    const response = page([entry], '42');
    let current = true;
    await expect(executePullOnlyProtocol(db, tenant, { pullChanges: async () => {
      current = false; return response;
    } }, { maxPages: 1, isContextCurrent: () => current })).rejects.toThrow('SYNC_CONTEXT_CHANGED');
    expect(getLocalCursor(db)).toBe(42);
    expect(read()).toMatchObject({ workers: [{ gross: 0, syncStatus: 'CURRENT' }],
      feedEvidence: { asOfCursor: '42' } });
  });
  it('uses actual server feed handler -> local HTTP SyncClient with company-gap cursor semantics', async () => {
    const event = { change_id: '44', company_id: company, entity_type: 'ticket', entity_id: 'server-ticket',
      entity_revision: 1, operation_id: 'op', change_type: 'INSERT', payload_json: { qty: 15 }, committed_at: now };
    const foreignGap = { ...event, change_id: '43', company_id: 'other-company' };
    const calls: string[] = [];
    const pgClient = { query: async (sql: string, params?: any[]) => {
      calls.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
      if (sql.includes('pg_advisory_lock') || sql.includes('pg_advisory_unlock')) return { rows: [{ pg_advisory_unlock: true }] };
      if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('ROLLBACK')) return { rows: [] };
      if (sql.includes('MAX(change_id)')) return { rows: [{ cursor: '44' }] };
      if (sql.includes('FROM change_log')) return { rows: [event, foreignGap]
        .filter(row => row.company_id === params?.[0] && BigInt(row.change_id) > BigInt(params?.[1])
          && BigInt(row.change_id) <= BigInt(params?.[2])).slice(0, Number(params?.[3])) };
      if (sql.includes('company_patta_sequences')) return { rows: [{ next_patta_number: 1 }] };
      throw new Error('Unexpected local fixture query');
    }, release: () => {} };
    const handler = createChangeFeedHandler({ connect: async () => pgClient });
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://127.0.0.1');
      const reply: any = { statusCode: 200, headers: {}, code(value: number) { this.statusCode = value; return this; },
        header(key: string, value: string) { this.headers[key] = value; return this; },
        send(value: any) { res.writeHead(this.statusCode, this.headers); res.end(JSON.stringify(value)); return value; } };
      await handler({ auth: { companyId: company }, query: Object.fromEntries(url.searchParams) }, reply);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const client = new SyncClient({ baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, allowHttp: true });
      const page = await client.pullChanges('42', 100);
      expect(page).toMatchObject({ companyId: company, feedProtocolVersion: 1, fromCursor: '42',
        headCursor: '44', nextCursor: '44', hasMore: false });
      expect(page.items.map((item: any) => [item.changeId, item.companyId])).toEqual([['44', company]]);
      expect(calls[0]).toContain('pg_advisory_lock');
      expect(calls[1]).toBe('BEGIN ISOLATION LEVEL');
      expect(calls[calls.length - 1]).toContain('pg_advisory_unlock');
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('keeps legacy responses, partial pages, failed pull and period-revision changes provisional', async () => {
    const { db, read, entry, page, tenant } = fixture(false);
    expect(read().syncStatus).toBe('UNKNOWN');
    const legacy = { items: [entry], nextCursor: '44', hasMore: false, nextPattaNumber: 1 };
    await executePullOnlyProtocol(db, tenant, { pullChanges: async () => legacy }, { maxPages: 1 });
    expect(read()).toMatchObject({ workers: [{ gross: 105 }], syncStatus: 'UNKNOWN' });
    const fresh = fixture();
    const start = String(getLocalCursor(fresh.db));
    const first = { ...fresh.entry, changeId: String(Number(start) + 1) };
    const head = String(Number(start) + 2);
    const partial = fresh.page([first], start, head, true);
    expect(fresh.db.prepare('SELECT company_id,id FROM periods WHERE company_id=?').all(fresh.tenant)).toContainEqual({ company_id: fresh.tenant, id: 'period-1' });
    expect(verifyPage(partial, fresh.tenant, getLocalCursor(fresh.db))).toEqual({ head, terminal: false });
    await executePullOnlyProtocol(fresh.db, fresh.tenant, { pullChanges: async () => partial }, { maxPages: 1 });
    expect(fresh.read()).toMatchObject({ workers: [{ gross: 105 }], syncStatus: 'UNKNOWN' });
    await expect(executePullOnlyProtocol(fresh.db, fresh.tenant, { pullChanges: async () => { throw new Error('503'); } }))
      .rejects.toThrow('503');
    expect(fresh.read()).toMatchObject({ workers: [{ gross: 105 }], syncStatus: 'UNKNOWN' });
    const terminal = fresh.page([], String(Number(start) + 1), head);
    applyChangesBatch(fresh.db, fresh.tenant, terminal.items, terminal.nextCursor, { feedResponse: terminal });
    expect(fresh.read()).toMatchObject({ syncStatus: 'CURRENT', feedEvidence: { asOfCursor: head } });
    await executePullOnlyProtocol(fresh.db, fresh.tenant, { pullChanges: async cursor => ({
      items: [], nextCursor: cursor, hasMore: false, nextPattaNumber: 1
    }) }, { maxPages: 1 });
    expect(fresh.read().syncStatus).toBe('UNKNOWN');
    fresh.db.prepare("UPDATE periods SET server_revision=2 WHERE id='period-1'").run();
    expect(fresh.read().syncStatus).toBe('UNKNOWN');
    expect(fresh.read().workers[0].gross).toBe(105);
  });
  it('retains current-feed as-of while pending edits and unknown tariffs remain incomplete', () => {
    const { db, read, entry, page, tenant } = fixture();
    const response = page([entry], '42');
    applyChangesBatch(db, tenant, response.items, response.nextCursor, { feedResponse: response });
    expect(read()).toMatchObject({ workers: [{ gross: 105, syncStatus: 'CURRENT' }], accountingStatus: 'COMPLETE' });
    db.prepare(`UPDATE ticket_entries SET qty=16 WHERE ticket_id=? AND company_id=?`).run(entry.entityId, tenant);
    const payload = canonicalStringify({ operationId: 'pending-edit', ticketId: entry.entityId });
    insertOutboxOperation(db, { operation_id: 'pending-edit', company_id: tenant, command_type: 'UpdateTicket',
      entity_type: 'ticket', entity_id: entry.entityId, base_revision: 1, causal_sequence: 1,
      payload_json: payload, payload_hash: computePayloadHash(payload) });
    expect(read()).toMatchObject({ workers: [{ gross: 112, syncStatus: 'UNSYNCED' }], accountingStatus: 'INCOMPLETE' });
    db.prepare(`DELETE FROM local_outbox WHERE company_id=? AND operation_id='pending-edit'`).run(tenant);
    db.prepare('UPDATE models SET operations_json=? WHERE company_id=? AND id=?')
      .run(JSON.stringify([{ name: 'Sew', rate: 8 }]), tenant, 'model-1');
    const modelPayload = canonicalStringify({ operationId: 'pending-model', modelId: 'model-1' });
    insertOutboxOperation(db, { operation_id: 'pending-model', company_id: tenant, command_type: 'UpsertModel',
      entity_type: 'model', entity_id: 'model-1', payload_json: modelPayload,
      payload_hash: computePayloadHash(modelPayload) });
    expect(read()).toMatchObject({ workers: [{ gross: 128, syncStatus: 'UNSYNCED' }], accountingStatus: 'INCOMPLETE' });
    db.prepare(`DELETE FROM local_outbox WHERE company_id=? AND operation_id='pending-model'`).run(tenant);
    db.prepare('UPDATE models SET operations_json=? WHERE company_id=? AND id=?')
      .run(JSON.stringify([{ name: 'Sew', rate: null }]), tenant, 'model-1');
    expect(read()).toMatchObject({ syncStatus: 'CURRENT', accountingStatus: 'INCOMPLETE',
      accountingReasons: expect.arrayContaining(['UNKNOWN_HISTORICAL_RATE']) });
  });
});
