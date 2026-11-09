import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const databaseManager = require('./databaseManager.cjs');
const commandPipeline = require('./commandPipeline.cjs');
const outboxManager = require('./outboxManager.cjs');
const { rebuildCompanyProjections } = require('./projectionReader.cjs');
const { runCrashTest } = require('../tests/harness/runStep3CrashHarness.cjs');
const { canonicalStringify, computePayloadHash } = require('./canonicalPayload.cjs');

describe('Phase 2 Step 3: Local Transactional Command Pipeline & Durable Outbox (Correction Pass)', () => {
  let tempUserDataDir: string;
  const companyA = 'company_alpha';
  const companyB = 'company_beta';

  beforeEach(() => {
    tempUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novda-step3-test-'));
  });

  afterEach(() => {
    databaseManager.closeAllCompanyDatabases();
    try {
      fs.rmSync(tempUserDataDir, { recursive: true, force: true });
    } catch {}
  });

  function seedCompany(companyId: string) {
    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyId);
    db.prepare(`
      INSERT OR IGNORE INTO models (id, company_id, name, operations_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run('model_101', companyId, 'Kofta', JSON.stringify([
      { name: 'Bichish', rate: 1200 },
      { name: 'Tikish', rate: 3500 },
      { name: 'Tugma', rate: 500 },
      { name: 'Dazmol', rate: 800 }
    ]));
    db.prepare(`
      INSERT OR IGNORE INTO workers (id, company_id, name, created_at, updated_at)
      VALUES (?, ?, ?, datetime('now'), datetime('now'))
    `).run(1, companyId, 'Ali Karimov');
    db.prepare(`
      INSERT OR IGNORE INTO workers (id, company_id, name, created_at, updated_at)
      VALUES (?, ?, ?, datetime('now'), datetime('now'))
    `).run(2, companyId, 'Vali Toshev');
    const insertParty = db.prepare(`
      INSERT OR IGNORE INTO parties (
        id, company_id, party_number, physical_party_number, model_id, model_name,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'model_101', 'Kofta', 'ACTIVE', datetime('now'), datetime('now'))
    `);
    for (const partyNumber of ['1', 'Party-A', 'Party-B', 'Party-P', 'BK-Party', '12']) {
      insertParty.run(`party_${partyNumber}`, companyId, partyNumber, partyNumber);
    }
  }

  // =========================================================================
  // SECTION A: TICKET REPLAY & PAYLOAD INTEGRITY (Items 1-5)
  // =========================================================================

  it('captures period and rate 5 in immutable offline intent despite tariff 9 and rollover', () => {
    seedCompany(companyA);
    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
    db.prepare(`INSERT INTO periods (id, company_id, name, start_date, is_closed, status, created_at)
      VALUES ('period-old', ?, 'Old', '2026-09-01', 0, 'OPEN', datetime('now'))`).run(companyA);
    const cmd = {
      commandId: 'cmd-capture', operationId: 'op-capture', companyId: companyA,
      ticketId: '00000000-0000-4000-8000-000000000071', modelId: 'model_101',
      periodId: 'period-old', effectiveDate: '2026-09-20', submittedAt: '2026-09-20T10:00:00.000Z',
      partyNumber: '1', pattaNumber: 1, qty: 3,
      entries: [{ opName: 'Bichish', workerId: 1, rateSnapshot: 5 }, { opName: 'Tikish', workerId: 2, rateSnapshot: 0 }]
    };
    commandPipeline.executeSubmitTicketCommand(tempUserDataDir, companyA, cmd);
    const original = db.prepare('SELECT payload_json, payload_hash FROM local_outbox WHERE operation_id = ?').get(cmd.operationId);
    db.prepare('UPDATE models SET operations_json = ? WHERE id = ?').run(JSON.stringify([
      { name: 'Bichish', rate: 9 }, { name: 'Tikish', rate: 9 }
    ]), 'model_101');
    db.prepare("UPDATE periods SET end_date = '2026-09-30', is_closed = 1, status = 'CLOSED' WHERE id = 'period-old'").run();
    db.prepare(`INSERT INTO periods (id, company_id, name, start_date, is_closed, status, created_at)
      VALUES ('period-new', ?, 'New', '2026-10-01', 0, 'OPEN', datetime('now'))`).run(companyA);
    expect(db.prepare('SELECT period_id FROM tickets WHERE id = ?').get(cmd.ticketId).period_id).toBe('period-old');
    expect(db.prepare('SELECT rate_snapshot FROM ticket_entries WHERE ticket_id = ? ORDER BY op_name').all(cmd.ticketId).map((e: any) => e.rate_snapshot)).toEqual([5, 0]);
    expect(db.prepare('SELECT payload_json, payload_hash FROM local_outbox WHERE operation_id = ?').get(cmd.operationId)).toEqual(original);
    expect(JSON.parse(original.payload_json).entries.map((e: any) => e.rateSnapshot)).toEqual([5, 0]);
    expect(commandPipeline.executeSubmitTicketCommand(tempUserDataDir, companyA, cmd).isReplay).toBe(true);
    expect(db.prepare('SELECT payload_json, payload_hash FROM local_outbox WHERE operation_id = ?').get(cmd.operationId)).toEqual(original);
  });

  it('refuses an unrelated period at local capture instead of recording a false origin', () => {
    seedCompany(companyA);
    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
    db.prepare(`INSERT INTO periods (id, company_id, name, start_date, end_date, is_closed, status, created_at)
      VALUES ('period-future', ?, 'Future', '2026-10-01', NULL, 0, 'OPEN', datetime('now'))`).run(companyA);
    expect(() => commandPipeline.executeSubmitTicketCommand(tempUserDataDir, companyA, {
      commandId: 'cmd-bad-period', operationId: 'op-bad-period', companyId: companyA,
      ticketId: '00000000-0000-4000-8000-000000000072', modelId: 'model_101',
      periodId: 'period-future', effectiveDate: '2026-09-20', partyNumber: '1', pattaNumber: 1,
      qty: 1, entries: [{ opName: 'Bichish', workerId: 1, rateSnapshot: null }]
    })).toThrowError(expect.objectContaining({ code: 'PERIOD_SCOPE_MISMATCH' }));
    expect(db.prepare('SELECT COUNT(*) AS n FROM local_outbox').get().n).toBe(0);
  });

  it('keeps an old command with omitted period null in immutable payload until authoritative ACK', () => {
    seedCompany(companyA);
    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
    db.prepare(`INSERT INTO periods (id, company_id, name, start_date, is_closed, created_at)
      VALUES ('period-current', ?, 'Current', '2026-09-01', 0, datetime('now'))`).run(companyA);
    expect(commandPipeline.executeSubmitTicketCommand(tempUserDataDir, companyA, {
      commandId: 'cmd-legacy', operationId: 'op-legacy', companyId: companyA,
      ticketId: '00000000-0000-4000-8000-000000000073', modelId: 'model_101',
      effectiveDate: '2026-09-20', partyNumber: '1', pattaNumber: 1, qty: 1,
      entries: [{ opName: 'Bichish', workerId: 1 }]
    }).committed).toBe(true);
    expect(db.prepare('SELECT period_id FROM tickets').get().period_id).toBeNull();
    expect(JSON.parse(db.prepare("SELECT payload_json FROM local_outbox WHERE operation_id = 'op-legacy'").get().payload_json).periodId).toBeNull();
  });

  it('1. exact ticket replay succeeds with isReplay=true and zero duplicate mutations', () => {
    seedCompany(companyA);
    const cmd = {
      commandId: 'cmd_rep_exact',
      operationId: 'op_rep_exact',
      companyId: companyA,
      ticketId: '00000000-0000-4000-8000-000000000001',
      modelId: 'model_101',
      partyNumber: '1',
      partyRecordId: 'party_1',
      pattaNumber: 1,
      qty: 50,
      entries: [{ workerId: 1, opName: 'Bichish', rateSnapshot: 1200 }]
    };

    const res1 = commandPipeline.executeSubmitTicketCommand(tempUserDataDir, companyA, cmd);
    expect(res1.committed).toBe(true);
    expect(res1.isReplay).toBeUndefined();

    // Replay identical command
    const res2 = commandPipeline.executeSubmitTicketCommand(tempUserDataDir, companyA, cmd);
    expect(res2.committed).toBe(true);
    expect(res2.isReplay).toBe(true);
    expect(res2.entityId).toBe('00000000-0000-4000-8000-000000000001');

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
    const ticketCount = db.prepare('SELECT count(*) as c FROM tickets WHERE id = ?').get('00000000-0000-4000-8000-000000000001').c;
    const outboxCount = db.prepare('SELECT count(*) as c FROM local_outbox WHERE operation_id = ?').get('op_rep_exact').c;
    expect(ticketCount).toBe(1);
    expect(outboxCount).toBe(1);
  });

  it('preserves the per-ticket free-mode choice in the canonical outbox payload', () => {
    seedCompany(companyA);
    const ticketId = '00000000-0000-4000-8000-000000000099';
    commandPipeline.executeSubmitTicketCommand(tempUserDataDir, companyA, {
      commandId: 'cmd_free_ticket', operationId: 'op_free_ticket', companyId: companyA,
      ticketId, modelId: 'model_101', partyNumber: "No'malum Partiya", partyRecordId: null,
      pattaNumber: 0, strictParty: false, strictPatta: false, qty: 10,
      entries: [{ workerId: 1, opName: 'Bichish' }]
    });

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
    const operation = db.prepare('SELECT payload_json FROM local_outbox WHERE operation_id = ?').get('op_free_ticket');
    expect(JSON.parse(operation.payload_json)).toMatchObject({
      partyNumber: "No'malum Partiya", partyRecordId: null, pattaNumber: 0,
      strictParty: false, strictPatta: false
    });
  });

  it('2. qty-changed same operationId throws IDEMPOTENCY_CONFLICT with zero mutation', () => {
    seedCompany(companyA);
    const cmdOriginal = {
      commandId: 'cmd_idemp_qty',
      operationId: 'op_idemp_qty',
      companyId: companyA,
      ticketId: '00000000-0000-4000-8000-000000000002',
      modelId: 'model_101',
      partyNumber: '1',
      partyRecordId: 'party_1',
      pattaNumber: 1,
      qty: 50,
      entries: [{ workerId: 1, opName: 'Bichish' }]
    };
    commandPipeline.executeSubmitTicketCommand(tempUserDataDir, companyA, cmdOriginal);

    const cmdChanged = {
      ...cmdOriginal,
      qty: 60 // changed qty with same operationId
    };

    expect(() => {
      commandPipeline.executeSubmitTicketCommand(tempUserDataDir, companyA, cmdChanged);
    }).toThrow(/IDEMPOTENCY_CONFLICT/);

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
    const ticket = db.prepare('SELECT qty FROM tickets WHERE id = ?').get('00000000-0000-4000-8000-000000000002');
    expect(ticket.qty).toBe(50); // unchanged
  });

  it('3. entries-changed same operationId throws IDEMPOTENCY_CONFLICT with zero mutation', () => {
    seedCompany(companyA);
    const cmdOriginal = {
      commandId: 'cmd_idemp_entries',
      operationId: 'op_idemp_entries',
      companyId: companyA,
      ticketId: '00000000-0000-4000-8000-000000000003',
      modelId: 'model_101',
      partyNumber: '1',
      partyRecordId: 'party_1',
      pattaNumber: 2,
      qty: 30,
      entries: [{ workerId: 1, opName: 'Bichish' }]
    };
    commandPipeline.executeSubmitTicketCommand(tempUserDataDir, companyA, cmdOriginal);

    const cmdChanged = {
      ...cmdOriginal,
      entries: [
        { workerId: 1, opName: 'Bichish' },
        { workerId: 2, opName: 'Tikish' } // added entry
      ]
    };

    expect(() => {
      commandPipeline.executeSubmitTicketCommand(tempUserDataDir, companyA, cmdChanged);
    }).toThrow(/IDEMPOTENCY_CONFLICT/);

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
    const entries = db.prepare('SELECT * FROM ticket_entries WHERE ticket_id = ?').all('00000000-0000-4000-8000-000000000003');
    expect(entries.length).toBe(1);
  });

  it('4. partyNumber-changed same operationId throws IDEMPOTENCY_CONFLICT with zero mutation', () => {
    seedCompany(companyA);
    const cmdOriginal = {
      commandId: 'cmd_idemp_party',
      operationId: 'op_idemp_party',
      companyId: companyA,
      ticketId: '00000000-0000-4000-8000-000000000004',
      modelId: 'model_101',
      partyNumber: 'Party-A',
      partyRecordId: 'party_Party-A',
      pattaNumber: 1,
      qty: 25,
      entries: [{ workerId: 1, opName: 'Bichish' }]
    };
    commandPipeline.executeSubmitTicketCommand(tempUserDataDir, companyA, cmdOriginal);

    const cmdChanged = {
      ...cmdOriginal,
      partyNumber: 'Party-B' // changed partyNumber
    };

    expect(() => {
      commandPipeline.executeSubmitTicketCommand(tempUserDataDir, companyA, cmdChanged);
    }).toThrow(/IDEMPOTENCY_CONFLICT/);
  });

  it('5. pattaNumber-changed same operationId throws IDEMPOTENCY_CONFLICT with zero mutation', () => {
    seedCompany(companyA);
    const cmdOriginal = {
      commandId: 'cmd_idemp_patta',
      operationId: 'op_idemp_patta',
      companyId: companyA,
      ticketId: '00000000-0000-4000-8000-000000000005',
      modelId: 'model_101',
      partyNumber: 'Party-P',
      partyRecordId: 'party_Party-P',
      pattaNumber: 1,
      qty: 20,
      entries: [{ workerId: 1, opName: 'Bichish' }]
    };
    commandPipeline.executeSubmitTicketCommand(tempUserDataDir, companyA, cmdOriginal);

    const cmdChanged = {
      ...cmdOriginal,
      pattaNumber: 2 // changed pattaNumber
    };

    expect(() => {
      commandPipeline.executeSubmitTicketCommand(tempUserDataDir, companyA, cmdChanged);
    }).toThrow(/IDEMPOTENCY_CONFLICT/);
  });

  it('duplicate ticketId with different operationId throws DUPLICATE_TICKET_ID', () => {
    seedCompany(companyA);
    const cmd1 = {
      commandId: 'cmd_dup_t1',
      operationId: 'op_dup_t1',
      companyId: companyA,
      ticketId: '00000000-0000-4000-8000-000000000006',
      modelId: 'model_101',
      partyNumber: '1',
      partyRecordId: 'party_1',
      pattaNumber: 10,
      qty: 15,
      entries: [{ workerId: 1, opName: 'Bichish' }]
    };
    commandPipeline.executeSubmitTicketCommand(tempUserDataDir, companyA, cmd1);

    const cmd2 = {
      commandId: 'cmd_dup_t2',
      operationId: 'op_dup_t2', // different operationId
      companyId: companyA,
      ticketId: '00000000-0000-4000-8000-000000000006', // same ticketId
      modelId: 'model_101',
      partyNumber: '1',
      partyRecordId: 'party_1',
      pattaNumber: 11,
      qty: 25,
      entries: [{ workerId: 1, opName: 'Bichish' }]
    };

    expect(() => {
      commandPipeline.executeSubmitTicketCommand(tempUserDataDir, companyA, cmd2);
    }).toThrow(/DUPLICATE_TICKET_ID/);
  });

  it('different ticketIds with the same display tuple remain distinct facts', () => {
    seedCompany(companyA);
    const cmd1 = {
      commandId: 'cmd_dup_bk1',
      operationId: 'op_dup_bk1',
      companyId: companyA,
      ticketId: '00000000-0000-4000-8000-000000000007',
      modelId: 'model_101',
      partyNumber: 'BK-Party',
      partyRecordId: 'party_BK-Party',
      pattaNumber: 7,
      qty: 30,
      entries: [{ workerId: 1, opName: 'Bichish' }]
    };
    commandPipeline.executeSubmitTicketCommand(tempUserDataDir, companyA, cmd1);

    const cmd2 = {
      commandId: 'cmd_dup_bk2',
      operationId: 'op_dup_bk2',
      companyId: companyA,
      ticketId: '00000000-0000-4000-8000-000000000008', // different ticketId
      modelId: 'model_101',
      partyNumber: 'BK-Party', // same party
      partyRecordId: 'party_BK-Party',
      pattaNumber: 7, // same patta
      qty: 30,
      entries: [{ workerId: 1, opName: 'Bichish' }]
    };

    const result = commandPipeline.executeSubmitTicketCommand(tempUserDataDir, companyA, cmd2);
    expect(result.committed).toBe(true);

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
    expect(db.prepare('SELECT count(*) as c FROM tickets WHERE company_id = ?').get(companyA).c).toBe(2);
  });

  // =========================================================================
  // SECTION B: ADJUSTMENT REPLAY & PAYLOAD INTEGRITY (Items 6-10)
  // =========================================================================

  it('freezes linked original period and saved 5/0/null rates across rollover, edits and reversal', () => {
    seedCompany(companyA);
    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
    const now = '2026-10-05T10:00:00.000Z';
    db.prepare(`INSERT INTO periods (id, company_id, name, start_date, end_date, is_closed, status, created_at)
      VALUES ('old-period', ?, 'September', '2026-09-01', '2026-09-30', 1, 'CLOSED', ?),
             ('new-period', ?, 'October', '2026-10-01', NULL, 0, 'OPEN', ?)`).run(companyA, now, companyA, now);
    const ticketId = '00000000-0000-4000-8000-000000000099';
    db.prepare(`INSERT INTO tickets (id, company_id, model_id, period_id, party_number, patta_number,
      qty, status, submitted_at, created_at) VALUES (?, ?, 'model_101', 'old-period', '1', 1, 3,
      'CONFIRMED', ?, ?)`).run(ticketId, companyA, now, now);
    for (const [id, rate] of [['entry-five', 5], ['entry-zero', 0], ['entry-unknown', null]] as const) {
      db.prepare(`INSERT INTO ticket_entries (id, ticket_id, company_id, op_name, worker_id, rate_snapshot, qty, created_at)
        VALUES (?, ?, ?, 'Bichish', 1, ?, 1, ?)`).run(id, ticketId, companyA, rate, now);
    }
    db.prepare(`INSERT INTO tickets (id, company_id, model_id, party_number, patta_number, qty, status, submitted_at, created_at)
      VALUES ('ticket-unentered', ?, 'model_101', '1', 2, 1, 'UNENTERED', ?, ?)`).run(companyA, now, now);
    db.prepare(`INSERT INTO ticket_entries (id, ticket_id, company_id, op_name, worker_id, rate_snapshot, qty, created_at)
      VALUES ('entry-unentered', 'ticket-unentered', ?, 'Bichish', 1, 9, 1, ?)`).run(companyA, now);
    db.prepare(`UPDATE models SET operations_json = ? WHERE id = 'model_101'`)
      .run(JSON.stringify([{ name: 'Bichish', rate: 9 }]));
    const { loadAdjustmentSources } = require('./projectionReader.cjs');
    const choices = loadAdjustmentSources(db, companyA, 'model_101', 1, 'Bichish');
    expect(choices.map((choice: any) => [choice.originalEntryId, choice.originalPeriodId, choice.originalRateSnapshot]))
      .toEqual([['entry-five', 'old-period', 5], ['entry-unknown', 'old-period', null], ['entry-zero', 'old-period', 0]]);
    expect(loadAdjustmentSources(db, companyA, 'model_101', 2, 'Bichish')).toEqual([]);
    expect(loadAdjustmentSources(db, companyA, 'model_101', 1, 'Tikish')).toEqual([]);
    expect(loadAdjustmentSources(db, companyB, 'model_101', 1, 'Bichish')).toEqual([]);
    const base = { companyId: companyA, modelId: 'model_101', workerId: 1, opName: 'Bichish',
      deltaQty: 2, reason: 'Correction', createdBy: 'supervisor', effectiveDate: '2026-10-05' };
    for (const [id, rate] of [['entry-five', 5], ['entry-zero', 0], ['entry-unknown', null]] as const) {
      const command = { ...base, commandId: `cmd-${id}`, operationId: `op-${id}`, adjustmentId: `adj-${id}`,
        originalTicketId: ticketId, originalEntryId: id };
      commandPipeline.executeRecordAdjustmentCommand(tempUserDataDir, companyA, command);
      const row = db.prepare(`SELECT original_period_id, original_rate_snapshot, attribution_status FROM production_adjustments
        WHERE adjustment_id = ?`).get(command.adjustmentId);
      expect(row).toEqual({ original_period_id: 'old-period', original_rate_snapshot: rate,
        attribution_status: 'RESOLVED' });
      expect(commandPipeline.executeRecordAdjustmentCommand(tempUserDataDir, companyA, command).isReplay).toBe(true);
      expect(() => commandPipeline.executeRecordAdjustmentCommand(tempUserDataDir, companyA,
        { ...command, originalEntryId: 'different-entry' })).toThrow(/IDEMPOTENCY_CONFLICT/);
    }
    const noPeriodTicket = '00000000-0000-4000-8000-000000000098';
    db.prepare(`INSERT INTO tickets (id, company_id, model_id, party_number, patta_number, qty, status, submitted_at, created_at)
      VALUES (?, ?, 'model_101', '1', 3, 1, 'CONFIRMED', ?, ?)`).run(noPeriodTicket, companyA, now, now);
    db.prepare(`INSERT INTO ticket_entries (id, ticket_id, company_id, op_name, worker_id, rate_snapshot, qty, created_at)
      VALUES ('entry-no-period', ?, ?, 'Bichish', 1, NULL, 1, ?)`).run(noPeriodTicket, companyA, now);
    commandPipeline.executeRecordAdjustmentCommand(tempUserDataDir, companyA, { ...base,
      commandId: 'cmd-no-period', operationId: 'op-no-period', adjustmentId: 'adj-no-period',
      originalTicketId: noPeriodTicket, originalEntryId: 'entry-no-period' });
    expect(db.prepare(`SELECT original_period_id, original_rate_snapshot, attribution_status FROM production_adjustments
      WHERE adjustment_id = 'adj-no-period'`).get()).toEqual({
      original_period_id: null, original_rate_snapshot: null, attribution_status: 'UNRESOLVED'
    });
    db.prepare(`UPDATE ticket_entries SET rate_snapshot = 9 WHERE id = 'entry-five'`).run();
    commandPipeline.executeReverseAdjustmentCommand(tempUserDataDir, companyA, {
      commandId: 'cmd-rev-linked', operationId: 'op-rev-linked', originalAdjustmentId: 'adj-entry-five',
      reversalAdjustmentId: 'rev-linked', companyId: companyA, createdBy: 'supervisor', effectiveDate: '2026-10-05'
    });
    expect(db.prepare(`SELECT original_ticket_id, original_entry_id, original_period_id, original_rate_snapshot,
      attribution_status, delta_qty FROM production_adjustments WHERE adjustment_id = 'rev-linked'`).get())
      .toEqual({ original_ticket_id: ticketId, original_entry_id: 'entry-five', original_period_id: 'old-period',
        original_rate_snapshot: 5, attribution_status: 'RESOLVED', delta_qty: -2 });
    const invalid = { ...base, commandId: 'cmd-invalid', operationId: 'op-invalid', adjustmentId: 'adj-invalid',
      originalTicketId: ticketId, originalEntryId: 'entry-zero' };
    for (const change of [{ workerId: 2 }, { opName: 'Tikish' }, { originalEntryId: 'missing' },
      { originalPeriodId: 'new-period' }, { originalRateSnapshot: 9 }, { originalEntryId: undefined }]) {
      expect(() => commandPipeline.executeRecordAdjustmentCommand(tempUserDataDir, companyA,
        { ...invalid, ...change })).toThrow();
    }
    commandPipeline.executeRecordAdjustmentCommand(tempUserDataDir, companyA,
      { ...base, commandId: 'cmd-legacy-adj', operationId: 'op-legacy-adj', adjustmentId: 'adj-legacy' });
    expect(db.prepare(`SELECT attribution_status, original_period_id FROM production_adjustments
      WHERE adjustment_id = 'adj-legacy'`).get()).toEqual({ attribution_status: 'UNRESOLVED', original_period_id: null });
  });

  it('rejects all snake-case attribution aliases before fact/outbox writes, permitting a corrected same-ID retry', () => {
    seedCompany(companyA);
    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
    const command = { commandId: 'alias-cmd', operationId: 'alias-op', companyId: companyA,
      adjustmentId: 'alias-adj', modelId: 'model_101', workerId: 1, opName: 'Bichish',
      deltaQty: 2, reason: 'Correction', createdBy: 'operator' };
    const reversal = { commandId: 'alias-rev-cmd', operationId: 'alias-rev-op', companyId: companyA,
      originalAdjustmentId: 'alias-adj', reversalAdjustmentId: 'alias-rev', createdBy: 'operator' };
    const aliases = ['original_ticket_id', 'original_entry_id', 'original_period_id',
      'original_rate_snapshot', 'attribution_status'];
    for (const alias of aliases) {
      expect(() => commandPipeline.executeRecordAdjustmentCommand(tempUserDataDir, companyA,
        { ...command, [alias]: alias === 'original_rate_snapshot' ? 0 : 'malformed' })).toThrow(/attribution/i);
      expect(() => commandPipeline.executeReverseAdjustmentCommand(tempUserDataDir, companyA,
        { ...reversal, [alias]: null })).toThrow(/attribution/i);
    }
    expect(db.prepare("SELECT count(*) AS n FROM production_adjustments WHERE adjustment_id IN ('alias-adj', 'alias-rev')").get().n).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM local_outbox WHERE operation_id IN ('alias-op', 'alias-rev-op')").get().n).toBe(0);
    expect(commandPipeline.executeRecordAdjustmentCommand(tempUserDataDir, companyA, command).committed).toBe(true);
    expect(commandPipeline.executeRecordAdjustmentCommand(tempUserDataDir, companyA, command).isReplay).toBe(true);
    expect(db.prepare("SELECT attribution_status FROM production_adjustments WHERE adjustment_id = 'alias-adj'").get().attribution_status).toBe('UNRESOLVED');
    expect(commandPipeline.executeReverseAdjustmentCommand(tempUserDataDir, companyA, reversal).committed).toBe(true);
    expect(db.prepare("SELECT count(*) AS n FROM local_outbox WHERE operation_id IN ('alias-op', 'alias-rev-op')").get().n).toBe(2);
  });

  it('6. exact adjustment replay succeeds with isReplay=true', () => {
    seedCompany(companyA);
    const cmd = {
      commandId: 'cmd_adj_exact',
      operationId: 'op_adj_exact',
      companyId: companyA,
      adjustmentId: 'adj_exact_1',
      modelId: 'model_101',
      workerId: 1,
      opName: 'Bichish',
      deltaQty: 10,
      reason: 'Physical recount adjustment',
      createdBy: 'supervisor'
    };

    const res1 = commandPipeline.executeRecordAdjustmentCommand(tempUserDataDir, companyA, cmd);
    expect(res1.committed).toBe(true);
    expect(res1.isReplay).toBeUndefined();

    const res2 = commandPipeline.executeRecordAdjustmentCommand(tempUserDataDir, companyA, cmd);
    expect(res2.committed).toBe(true);
    expect(res2.isReplay).toBe(true);

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
    const count = db.prepare('SELECT count(*) as c FROM production_adjustments WHERE adjustment_id = ?').get('adj_exact_1').c;
    expect(count).toBe(1);
  });

  it('7. changed adjustment deltaQty throws IDEMPOTENCY_CONFLICT', () => {
    seedCompany(companyA);
    const cmdOriginal = {
      commandId: 'cmd_adj_delta',
      operationId: 'op_adj_delta',
      companyId: companyA,
      adjustmentId: 'adj_delta_1',
      modelId: 'model_101',
      workerId: 1,
      opName: 'Bichish',
      deltaQty: 10,
      reason: 'Recount',
      createdBy: 'supervisor'
    };
    commandPipeline.executeRecordAdjustmentCommand(tempUserDataDir, companyA, cmdOriginal);

    const cmdChanged = { ...cmdOriginal, deltaQty: 15 };
    expect(() => {
      commandPipeline.executeRecordAdjustmentCommand(tempUserDataDir, companyA, cmdChanged);
    }).toThrow(/IDEMPOTENCY_CONFLICT/);
  });

  it('8. changed adjustment reason throws IDEMPOTENCY_CONFLICT', () => {
    seedCompany(companyA);
    const cmdOriginal = {
      commandId: 'cmd_adj_rsn',
      operationId: 'op_adj_rsn',
      companyId: companyA,
      adjustmentId: 'adj_rsn_1',
      modelId: 'model_101',
      workerId: 1,
      opName: 'Bichish',
      deltaQty: 5,
      reason: 'Reason 1',
      createdBy: 'supervisor'
    };
    commandPipeline.executeRecordAdjustmentCommand(tempUserDataDir, companyA, cmdOriginal);

    const cmdChanged = { ...cmdOriginal, reason: 'Reason 2' };
    expect(() => {
      commandPipeline.executeRecordAdjustmentCommand(tempUserDataDir, companyA, cmdChanged);
    }).toThrow(/IDEMPOTENCY_CONFLICT/);
  });

  it('9. changed adjustment workerId throws IDEMPOTENCY_CONFLICT', () => {
    seedCompany(companyA);
    const cmdOriginal = {
      commandId: 'cmd_adj_wrk',
      operationId: 'op_adj_wrk',
      companyId: companyA,
      adjustmentId: 'adj_wrk_1',
      modelId: 'model_101',
      workerId: 1,
      opName: 'Bichish',
      deltaQty: 5,
      reason: 'Recount',
      createdBy: 'supervisor'
    };
    commandPipeline.executeRecordAdjustmentCommand(tempUserDataDir, companyA, cmdOriginal);

    const cmdChanged = { ...cmdOriginal, workerId: 2 };
    expect(() => {
      commandPipeline.executeRecordAdjustmentCommand(tempUserDataDir, companyA, cmdChanged);
    }).toThrow(/IDEMPOTENCY_CONFLICT/);
  });

  it('10. changed adjustment opName throws IDEMPOTENCY_CONFLICT', () => {
    seedCompany(companyA);
    const cmdOriginal = {
      commandId: 'cmd_adj_op',
      operationId: 'op_adj_op',
      companyId: companyA,
      adjustmentId: 'adj_op_1',
      modelId: 'model_101',
      workerId: 1,
      opName: 'Bichish',
      deltaQty: 5,
      reason: 'Recount',
      createdBy: 'supervisor'
    };
    commandPipeline.executeRecordAdjustmentCommand(tempUserDataDir, companyA, cmdOriginal);

    const cmdChanged = { ...cmdOriginal, opName: 'Tikish' };
    expect(() => {
      commandPipeline.executeRecordAdjustmentCommand(tempUserDataDir, companyA, cmdChanged);
    }).toThrow(/IDEMPOTENCY_CONFLICT/);
  });

  it('different operationId with same adjustmentId throws DUPLICATE_ADJUSTMENT_ID', () => {
    seedCompany(companyA);
    const cmd1 = {
      commandId: 'cmd_adj_dup1',
      operationId: 'op_adj_dup1',
      companyId: companyA,
      adjustmentId: 'adj_shared_id',
      modelId: 'model_101',
      workerId: 1,
      opName: 'Bichish',
      deltaQty: 5,
      reason: 'First',
      createdBy: 'supervisor'
    };
    commandPipeline.executeRecordAdjustmentCommand(tempUserDataDir, companyA, cmd1);

    const cmd2 = {
      commandId: 'cmd_adj_dup2',
      operationId: 'op_adj_dup2', // different op
      companyId: companyA,
      adjustmentId: 'adj_shared_id', // same adjustmentId
      modelId: 'model_101',
      workerId: 1,
      opName: 'Bichish',
      deltaQty: 10,
      reason: 'Second',
      createdBy: 'supervisor'
    };

    expect(() => {
      commandPipeline.executeRecordAdjustmentCommand(tempUserDataDir, companyA, cmd2);
    }).toThrow(/DUPLICATE_ADJUSTMENT_ID/);
  });

  // =========================================================================
  // SECTION C: REVERSAL REPLAY & PAYLOAD INTEGRITY (Items 11-12)
  // =========================================================================

  it('11. exact reversal replay succeeds with isReplay=true', () => {
    seedCompany(companyA);
    commandPipeline.executeRecordAdjustmentCommand(tempUserDataDir, companyA, {
      commandId: 'cmd_for_rev_11',
      operationId: 'op_for_rev_11',
      companyId: companyA,
      adjustmentId: 'adj_target_11',
      modelId: 'model_101',
      workerId: 1,
      opName: 'Bichish',
      deltaQty: 20,
      reason: 'Target for reversal',
      createdBy: 'supervisor'
    });

    const revCmd = {
      commandId: 'cmd_rev_exact',
      operationId: 'op_rev_exact',
      companyId: companyA,
      originalAdjustmentId: 'adj_target_11',
      reversalAdjustmentId: 'rev_adj_11',
      reason: 'Exact reversal test',
      createdBy: 'supervisor'
    };

    const res1 = commandPipeline.executeReverseAdjustmentCommand(tempUserDataDir, companyA, revCmd);
    expect(res1.committed).toBe(true);
    expect(res1.isReplay).toBeUndefined();

    const res2 = commandPipeline.executeReverseAdjustmentCommand(tempUserDataDir, companyA, revCmd);
    expect(res2.committed).toBe(true);
    expect(res2.isReplay).toBe(true);
    expect(res2.entityId).toBe('rev_adj_11');
  });

  it('stores the original server revision in the reversal outbox base_revision', () => {
    seedCompany(companyA);
    commandPipeline.executeRecordAdjustmentCommand(tempUserDataDir, companyA, {
      commandId: 'cmd_for_rev_revision',
      operationId: 'op_for_rev_revision',
      companyId: companyA,
      adjustmentId: 'adj_target_revision',
      modelId: 'model_101',
      workerId: 1,
      opName: 'Bichish',
      deltaQty: 20,
      reason: 'Target for revision test',
      createdBy: 'supervisor'
    });

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
    db.prepare('UPDATE production_adjustments SET server_revision = ? WHERE adjustment_id = ?').run(7, 'adj_target_revision');

    commandPipeline.executeReverseAdjustmentCommand(tempUserDataDir, companyA, {
      commandId: 'cmd_rev_revision',
      operationId: 'op_rev_revision',
      companyId: companyA,
      originalAdjustmentId: 'adj_target_revision',
      reversalAdjustmentId: 'rev_adj_revision',
      createdBy: 'supervisor'
    });

    const original = db.prepare('SELECT server_revision FROM production_adjustments WHERE adjustment_id = ?').get('adj_target_revision');
    const outbox = outboxManager.getOperation(db, companyA, 'op_rev_revision');

    expect(original.server_revision).toBe(7);
    expect(outbox.base_revision).toBe(original.server_revision);
  });

  it('12. changed reversal target originalAdjustmentId throws IDEMPOTENCY_CONFLICT', () => {
    seedCompany(companyA);
    commandPipeline.executeRecordAdjustmentCommand(tempUserDataDir, companyA, {
      commandId: 'cmd_target_a',
      operationId: 'op_target_a',
      companyId: companyA,
      adjustmentId: 'adj_target_a',
      modelId: 'model_101',
      workerId: 1,
      opName: 'Bichish',
      deltaQty: 10,
      reason: 'Target A',
      createdBy: 'supervisor'
    });
    commandPipeline.executeRecordAdjustmentCommand(tempUserDataDir, companyA, {
      commandId: 'cmd_target_b',
      operationId: 'op_target_b',
      companyId: companyA,
      adjustmentId: 'adj_target_b',
      modelId: 'model_101',
      workerId: 1,
      opName: 'Bichish',
      deltaQty: 15,
      reason: 'Target B',
      createdBy: 'supervisor'
    });

    const revCmdOriginal = {
      commandId: 'cmd_rev_mismatch',
      operationId: 'op_rev_mismatch',
      companyId: companyA,
      originalAdjustmentId: 'adj_target_a',
      reversalAdjustmentId: 'rev_adj_mismatch',
      reason: 'Reversing target A',
      createdBy: 'supervisor'
    };
    commandPipeline.executeReverseAdjustmentCommand(tempUserDataDir, companyA, revCmdOriginal);

    const revCmdChanged = {
      ...revCmdOriginal,
      originalAdjustmentId: 'adj_target_b' // changed target
    };

    expect(() => {
      commandPipeline.executeReverseAdjustmentCommand(tempUserDataDir, companyA, revCmdChanged);
    }).toThrow(/IDEMPOTENCY_CONFLICT/);
  });

  it('different operationId attempting second approved reversal throws DUPLICATE_REVERSAL', () => {
    seedCompany(companyA);
    commandPipeline.executeRecordAdjustmentCommand(tempUserDataDir, companyA, {
      commandId: 'cmd_dup_rev_target',
      operationId: 'op_dup_rev_target',
      companyId: companyA,
      adjustmentId: 'adj_rev_target_once',
      modelId: 'model_101',
      workerId: 1,
      opName: 'Bichish',
      deltaQty: 30,
      reason: 'Target for duplicate reversal',
      createdBy: 'supervisor'
    });

    // Reversal 1: approved
    commandPipeline.executeReverseAdjustmentCommand(tempUserDataDir, companyA, {
      commandId: 'cmd_rev_1st',
      operationId: 'op_rev_1st',
      companyId: companyA,
      originalAdjustmentId: 'adj_rev_target_once',
      reversalAdjustmentId: 'rev_first_ok',
      createdBy: 'supervisor'
    });

    // Reversal 2: different operationId targeting same original adjustment
    expect(() => {
      commandPipeline.executeReverseAdjustmentCommand(tempUserDataDir, companyA, {
        commandId: 'cmd_rev_2nd',
        operationId: 'op_rev_2nd',
        companyId: companyA,
        originalAdjustmentId: 'adj_rev_target_once',
        reversalAdjustmentId: 'rev_second_rejected',
        createdBy: 'supervisor'
      });
    }).toThrow(/DUPLICATE_REVERSAL/);
  });

  it('reversal period guard uses the normalized persisted createdAt when effectiveDate is omitted', () => {
    seedCompany(companyA);
    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
    db.prepare(`
      INSERT INTO periods (id, company_id, name, start_date, end_date, is_closed, status, created_at)
      VALUES (?, ?, ?, ?, ?, 1, 'CLOSED', ?)
    `).run('closed_sep_2026', companyA, 'September 2026', '2026-09-01', '2026-09-30', '2026-10-01T00:00:00.000Z');

    commandPipeline.executeRecordAdjustmentCommand(tempUserDataDir, companyA, {
      commandId: 'cmd_rev_period_target',
      operationId: 'op_rev_period_target',
      companyId: companyA,
      adjustmentId: 'adj_rev_period_target',
      modelId: 'model_101',
      workerId: 1,
      opName: 'Bichish',
      deltaQty: 10,
      reason: 'Target for period guard',
      createdBy: 'supervisor',
      effectiveDate: '2026-10-01'
    });

    expect(() => commandPipeline.executeReverseAdjustmentCommand(tempUserDataDir, companyA, {
      commandId: 'cmd_rev_period_guard',
      operationId: 'op_rev_period_guard',
      companyId: companyA,
      originalAdjustmentId: 'adj_rev_period_target',
      reversalAdjustmentId: 'rev_period_guard',
      createdBy: 'supervisor',
      createdAt: '2026-09-20T12:00:00.000Z'
    })).toThrow(/Business date 2026-09-20 belongs to closed period/);
  });

  // =========================================================================
  // SECTION D: CAUSAL DEPENDENCY VALIDATION (Items 13-15)
  // =========================================================================

  it('13. self causal dependency rejected with SELF_CAUSAL_DEPENDENCY', () => {
    seedCompany(companyA);
    const cmd = {
      commandId: 'cmd_self_causal',
      operationId: 'op_self_causal',
      companyId: companyA,
      ticketId: '00000000-0000-4000-8000-000000000009',
      modelId: 'model_101',
      partyNumber: '1',
      partyRecordId: 'party_1',
      pattaNumber: 1,
      qty: 10,
      entries: [{ workerId: 1, opName: 'Bichish' }],
      dependsOnOperationId: 'op_self_causal', // SELF DEPENDENCY
      causalSequence: 1
    };

    expect(() => {
      commandPipeline.executeSubmitTicketCommand(tempUserDataDir, companyA, cmd);
    }).toThrow(/SELF_CAUSAL_DEPENDENCY/);
  });

  it('14. negative causal sequence rejected with INVALID_CAUSAL_SEQUENCE', () => {
    seedCompany(companyA);
    const cmd = {
      commandId: 'cmd_neg_seq',
      operationId: 'op_neg_seq',
      companyId: companyA,
      ticketId: '00000000-0000-4000-8000-000000000010',
      modelId: 'model_101',
      partyNumber: '1',
      partyRecordId: 'party_1',
      pattaNumber: 2,
      qty: 10,
      entries: [{ workerId: 1, opName: 'Bichish' }],
      causalSequence: -1
    };

    expect(() => {
      commandPipeline.executeSubmitTicketCommand(tempUserDataDir, companyA, cmd);
    }).toThrow(/INVALID_CAUSAL_SEQUENCE/);
  });

  it('15. fractional causal sequence rejected with INVALID_CAUSAL_SEQUENCE', () => {
    seedCompany(companyA);
    const cmd = {
      commandId: 'cmd_frac_seq',
      operationId: 'op_frac_seq',
      companyId: companyA,
      ticketId: '00000000-0000-4000-8000-000000000011',
      modelId: 'model_101',
      partyNumber: '1',
      partyRecordId: 'party_1',
      pattaNumber: 3,
      qty: 10,
      entries: [{ workerId: 1, opName: 'Bichish' }],
      causalSequence: 1.5
    };

    expect(() => {
      commandPipeline.executeSubmitTicketCommand(tempUserDataDir, companyA, cmd);
    }).toThrow(/INVALID_CAUSAL_SEQUENCE/);
  });

  // =========================================================================
  // SECTION E: ATTEMPT & RETRY COUNTER SEMANTICS (Items 16-17)
  // =========================================================================

  it('16. first send sets attempt_count=1 and retry_count=0', () => {
    seedCompany(companyA);
    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);

    const payloadJson = canonicalStringify({ test: 'counter_1' });
    const payloadHash = computePayloadHash(payloadJson);
    outboxManager.insertOutboxOperation(db, {
      operation_id: 'op_counter_1',
      company_id: companyA,
      command_type: 'SubmitTicket',
      entity_type: 'ticket',
      entity_id: 't_cnt_1',
      payload_json: payloadJson,
      payload_hash: payloadHash,
      status: 'PENDING'
    });

    const initial = outboxManager.getOperation(db, companyA, 'op_counter_1');
    expect(initial.attempt_count).toBe(0);
    expect(initial.retry_count).toBe(0);

    // First transition to SENDING
    outboxManager.updateOperationStatus(db, companyA, 'op_counter_1', 'SENDING');
    const firstSend = outboxManager.getOperation(db, companyA, 'op_counter_1');
    expect(firstSend.status).toBe('SENDING');
    expect(firstSend.attempt_count).toBe(1);
    expect(firstSend.retry_count).toBe(0);
  });

  it('17. retry send sets attempt_count=2 and retry_count=1', () => {
    seedCompany(companyA);
    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);

    const payloadJson = canonicalStringify({ test: 'counter_2' });
    const payloadHash = computePayloadHash(payloadJson);
    outboxManager.insertOutboxOperation(db, {
      operation_id: 'op_counter_2',
      company_id: companyA,
      command_type: 'SubmitTicket',
      entity_type: 'ticket',
      entity_id: 't_cnt_2',
      payload_json: payloadJson,
      payload_hash: payloadHash,
      status: 'PENDING'
    });

    // 1st attempt: PENDING -> SENDING
    outboxManager.updateOperationStatus(db, companyA, 'op_counter_2', 'SENDING');
    // Transient failure: SENDING -> PENDING
    outboxManager.updateOperationStatus(db, companyA, 'op_counter_2', 'PENDING', 'Network timeout');

    const failed = outboxManager.getOperation(db, companyA, 'op_counter_2');
    expect(failed.status).toBe('PENDING');
    expect(failed.attempt_count).toBe(1);
    expect(failed.retry_count).toBe(0);

    // 2nd attempt (first retry): PENDING -> SENDING
    outboxManager.updateOperationStatus(db, companyA, 'op_counter_2', 'SENDING');
    const retry1 = outboxManager.getOperation(db, companyA, 'op_counter_2');
    expect(retry1.status).toBe('SENDING');
    expect(retry1.attempt_count).toBe(2);
    expect(retry1.retry_count).toBe(1);

    // 3rd attempt: PENDING -> SENDING
    outboxManager.updateOperationStatus(db, companyA, 'op_counter_2', 'PENDING', 'Server error');
    outboxManager.updateOperationStatus(db, companyA, 'op_counter_2', 'SENDING');
    const retry2 = outboxManager.getOperation(db, companyA, 'op_counter_2');
    expect(retry2.status).toBe('SENDING');
    expect(retry2.attempt_count).toBe(3);
    expect(retry2.retry_count).toBe(2);
  });

  // =========================================================================
  // SECTION F: MODEL OPERATION VALIDATION (Item 18)
  // =========================================================================

  it('18. invalid model operation name rejected with UNKNOWN_OPERATION', () => {
    seedCompany(companyA);
    const cmd = {
      commandId: 'cmd_unknown_op',
      operationId: 'op_unknown_op',
      companyId: companyA,
      ticketId: '00000000-0000-4000-8000-000000000012',
      modelId: 'model_101', // model_101 only has Bichish, Tikish, Tugma, Dazmol
      partyNumber: '1',
      partyRecordId: 'party_1',
      pattaNumber: 1,
      qty: 25,
      entries: [
        { workerId: 1, opName: 'Uchish' } // Non-existent operation in model schema!
      ]
    };

    expect(() => {
      commandPipeline.executeSubmitTicketCommand(tempUserDataDir, companyA, cmd);
    }).toThrow(/UNKNOWN_OPERATION/);

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
    expect(db.prepare('SELECT id FROM tickets WHERE id = ?').get('00000000-0000-4000-8000-000000000012')).toBeUndefined();
  });

  // =========================================================================
  // SECTION G: PRODUCTION-PATH FAILURE INJECTION (Items 19-20)
  // =========================================================================

  it('19. production-path rollback after fact insert leaves zero ticket, zero entries, zero outbox', () => {
    seedCompany(companyA);
    const cmd = {
      commandId: 'cmd_fail_fact',
      operationId: 'op_fail_fact',
      companyId: companyA,
      ticketId: '00000000-0000-4000-8000-000000000013',
      modelId: 'model_101',
      partyNumber: '1',
      partyRecordId: 'party_1',
      pattaNumber: 50,
      qty: 30,
      entries: [{ workerId: 1, opName: 'Bichish' }]
    };

    expect(() => {
      commandPipeline.executeSubmitTicketCommand(tempUserDataDir, companyA, cmd, {
        testHooks: {
          afterFactInsert: () => {
            throw new Error('INJECTED_FAILURE_AFTER_FACT_INSERT');
          }
        }
      });
    }).toThrow('INJECTED_FAILURE_AFTER_FACT_INSERT');

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
    expect(db.prepare('SELECT id FROM tickets WHERE id = ?').get('00000000-0000-4000-8000-000000000013')).toBeUndefined();
    expect(db.prepare('SELECT id FROM ticket_entries WHERE ticket_id = ?').all('00000000-0000-4000-8000-000000000013').length).toBe(0);
    expect(db.prepare('SELECT operation_id FROM local_outbox WHERE operation_id = ?').get('op_fail_fact')).toBeUndefined();
  });

  it('20. production-path rollback after outbox insert leaves zero ticket, zero entries, zero outbox', () => {
    seedCompany(companyA);
    const cmd = {
      commandId: 'cmd_fail_outbox',
      operationId: 'op_fail_outbox',
      companyId: companyA,
      ticketId: '00000000-0000-4000-8000-000000000014',
      modelId: 'model_101',
      partyNumber: '1',
      partyRecordId: 'party_1',
      pattaNumber: 51,
      qty: 35,
      entries: [{ workerId: 1, opName: 'Bichish' }]
    };

    expect(() => {
      commandPipeline.executeSubmitTicketCommand(tempUserDataDir, companyA, cmd, {
        testHooks: {
          afterOutboxInsert: () => {
            throw new Error('INJECTED_FAILURE_AFTER_OUTBOX_INSERT');
          }
        }
      });
    }).toThrow('INJECTED_FAILURE_AFTER_OUTBOX_INSERT');

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
    expect(db.prepare('SELECT id FROM tickets WHERE id = ?').get('00000000-0000-4000-8000-000000000014')).toBeUndefined();
    expect(db.prepare('SELECT id FROM ticket_entries WHERE ticket_id = ?').all('00000000-0000-4000-8000-000000000014').length).toBe(0);
    expect(db.prepare('SELECT operation_id FROM local_outbox WHERE operation_id = ?').get('op_fail_outbox')).toBeUndefined();
  });

  it('production-path rollback on adjustment command after outbox insert leaves zero fact and outbox', () => {
    seedCompany(companyA);
    const cmd = {
      commandId: 'cmd_fail_adj',
      operationId: 'op_fail_adj',
      companyId: companyA,
      adjustmentId: 'adj_fail_1',
      modelId: 'model_101',
      workerId: 1,
      opName: 'Bichish',
      deltaQty: 8,
      reason: 'Failure test',
      createdBy: 'tester'
    };

    expect(() => {
      commandPipeline.executeRecordAdjustmentCommand(tempUserDataDir, companyA, cmd, {
        testHooks: {
          afterOutboxInsert: () => {
            throw new Error('INJECTED_ADJ_FAILURE');
          }
        }
      });
    }).toThrow('INJECTED_ADJ_FAILURE');

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
    expect(db.prepare('SELECT adjustment_id FROM production_adjustments WHERE adjustment_id = ?').get('adj_fail_1')).toBeUndefined();
    expect(db.prepare('SELECT operation_id FROM local_outbox WHERE operation_id = ?').get('op_fail_adj')).toBeUndefined();
  });

  // =========================================================================
  // SECTION H: REAL HARD PROCESS CRASH HARNESS (Items 21-22)
  // =========================================================================

  it('21. hard kill (taskkill /F) before commit leaves no fact, no outbox, and PRAGMA integrity_check ok', async () => {
    const crashCompany = 'crash_uncommitted_corp';
    const cmd = {
      commandId: 'cmd_hk_uncomm',
      operationId: 'op_hk_uncomm',
      companyId: crashCompany,
      ticketId: '00000000-0000-4000-8000-000000000015',
      modelId: 'model_hk_1',
      partyNumber: '1',
      partyRecordId: 'party_hk_1',
      pattaNumber: 1,
      qty: 40,
      entries: [{ workerId: 1, opName: 'Bichish', rateSnapshot: 1200 }]
    };

    const res = await runCrashTest(tempUserDataDir, crashCompany, 'uncommitted', cmd);
    expect(res.exited).toBe(true);

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, crashCompany);
    try {
      const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get('00000000-0000-4000-8000-000000000015');
      const entries = db.prepare('SELECT * FROM ticket_entries WHERE ticket_id = ?').all('00000000-0000-4000-8000-000000000015');
      const outbox = db.prepare('SELECT * FROM local_outbox WHERE operation_id = ?').get('op_hk_uncomm');
      const integrity = db.pragma('integrity_check', { simple: true });

      expect(ticket).toBeUndefined();
      expect(entries.length).toBe(0);
      expect(outbox).toBeUndefined();
      expect(integrity).toBe('ok');
    } finally {
      databaseManager.closeCompanyDatabase(crashCompany);
    }
  }, 15000);

  it('22. hard kill (taskkill /F) after commit preserves both fact and outbox, and PRAGMA integrity_check ok', async () => {
    const crashCompany = 'crash_committed_corp';
    const cmd = {
      commandId: 'cmd_hk_comm',
      operationId: 'op_hk_comm',
      companyId: crashCompany,
      ticketId: '00000000-0000-4000-8000-000000000016',
      modelId: 'model_hk_2',
      partyNumber: '1',
      partyRecordId: 'party_hk_1',
      pattaNumber: 2,
      qty: 75,
      entries: [{ workerId: 1, opName: 'Bichish', rateSnapshot: 1200 }]
    };

    const res = await runCrashTest(tempUserDataDir, crashCompany, 'committed', cmd);
    expect(res.exited).toBe(true);

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, crashCompany);
    try {
      const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get('00000000-0000-4000-8000-000000000016');
      const entries = db.prepare('SELECT * FROM ticket_entries WHERE ticket_id = ?').all('00000000-0000-4000-8000-000000000016');
      const outbox = db.prepare('SELECT * FROM local_outbox WHERE operation_id = ?').get('op_hk_comm');
      const integrity = db.pragma('integrity_check', { simple: true });

      expect(ticket).toBeDefined();
      expect(ticket.qty).toBe(75);
      expect(entries.length).toBe(1);
      expect(outbox).toBeDefined();
      expect(outbox.payload_hash).toBeTruthy();
      expect(outbox.payload_hash.length).toBe(64);
      expect(outbox.payload_hash).toBe(computePayloadHash(outbox.payload_json));
      expect(integrity).toBe('ok');
    } finally {
      databaseManager.closeCompanyDatabase(crashCompany);
    }
  }, 15000);

  // =========================================================================
  // SECTION I: PROJECTION PURITY, VALIDATION & ISOLATION
  // =========================================================================

  it('PENDING_SYNC ticket is included in optimistic floor but strictly excluded from authoritative accounting', () => {
    seedCompany(companyA);
    const cmd = {
      commandId: 'cmd_proj_floor',
      operationId: 'op_proj_floor',
      companyId: companyA,
      ticketId: '00000000-0000-4000-8000-000000000017',
      modelId: 'model_101',
      partyNumber: '12',
      partyRecordId: 'party_12',
      pattaNumber: 1,
      qty: 45,
      entries: [{ workerId: 1, opName: 'Bichish' }]
    };

    const res = commandPipeline.executeSubmitTicketCommand(tempUserDataDir, companyA, cmd);
    expect(res.committed).toBe(true);

    const proj = rebuildCompanyProjections(tempUserDataDir, companyA);
    expect(proj.optimistic['model_101']['1']['Bichish']).toBe(45);
    expect(proj.accounting['model_101']['1']['Bichish']).toBe(0);

    const bd = proj.breakdown['model_101']['1']['Bichish'];
    expect(bd.pendingQty).toBe(45);
    expect(bd.confirmedQty).toBe(0);
    expect(bd.totalQty).toBe(45);
    expect(bd.accountingQty).toBe(0);
  });

  it('negative delta supported on RecordProductionAdjustment and reflects in projections', () => {
    seedCompany(companyA);
    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
    db.prepare(`INSERT INTO periods (id, company_id, name, start_date, is_closed, status, created_at)
      VALUES ('period-negative', ?, 'Negative', '2020-01-01', 0, 'OPEN', datetime('now'))`).run(companyA);
    db.prepare(`INSERT INTO tickets (id, company_id, model_id, period_id, party_number, patta_number,
      qty, status, submitted_at, created_at)
      VALUES ('ticket-negative', ?, 'model_101', 'period-negative', '1', 1,
        10, 'CONFIRMED', datetime('now'), datetime('now'))`).run(companyA);
    db.prepare(`INSERT INTO ticket_entries (id, ticket_id, company_id, op_name, worker_id, qty, created_at)
      VALUES ('entry-negative', 'ticket-negative', ?, 'Tikish', 2, 10, datetime('now'))`).run(companyA);
    const cmd = {
      commandId: 'cmd_adj_neg',
      operationId: 'op_adj_neg',
      companyId: companyA,
      adjustmentId: 'adj_neg_1',
      modelId: 'model_101',
      workerId: 2,
      opName: 'Tikish',
      deltaQty: -7,
      originalTicketId: 'ticket-negative',
      originalEntryId: 'entry-negative',
      reason: 'Defective bundle retraction',
      createdBy: 'qa_lead'
    };

    commandPipeline.executeRecordAdjustmentCommand(tempUserDataDir, companyA, cmd);

    const fact = db.prepare('SELECT * FROM production_adjustments WHERE adjustment_id = ?').get('adj_neg_1');
    expect(fact.delta_qty).toBe(-7);
    expect(fact.original_period_id).toBe('period-negative');

    const proj = rebuildCompanyProjections(tempUserDataDir, companyA);
    expect(proj.optimistic['model_101']['2']['Tikish']).toBe(3); // 10 confirmed - 7 correction
    expect(proj.accounting['model_101']['2']['Tikish']).toBe(3);
  });

  it('outbox company isolation: operations never leak between companies', () => {
    seedCompany(companyA);
    seedCompany(companyB);

    const cmdA = {
      commandId: 'cmd_iso_a',
      operationId: 'op_iso_a',
      companyId: companyA,
      ticketId: '00000000-0000-4000-8000-000000000018',
      modelId: 'model_101',
      partyNumber: '1',
      partyRecordId: 'party_1',
      pattaNumber: 1,
      qty: 20,
      entries: [{ workerId: 1, opName: 'Bichish' }]
    };
    commandPipeline.executeSubmitTicketCommand(tempUserDataDir, companyA, cmdA);

    const dbA = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
    const dbB = databaseManager.getCompanyDatabase(tempUserDataDir, companyB);

    expect(outboxManager.getOperation(dbA, companyA, 'op_iso_a')).toBeDefined();
    expect(outboxManager.getOperation(dbB, companyB, 'op_iso_a')).toBeNull();
    expect(outboxManager.listPendingOperations(dbB, companyB).length).toBe(0);
  });

  it('outbox status transition validation enforces legal state machine and rejects illegal jumps', () => {
    seedCompany(companyA);
    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);

    const payloadJson = canonicalStringify({ test: 'stat_1' });
    const payloadHash = computePayloadHash(payloadJson);
    outboxManager.insertOutboxOperation(db, {
      operation_id: 'op_stat_1',
      company_id: companyA,
      command_type: 'SubmitTicket',
      entity_type: 'ticket',
      entity_id: 'tick_dummy',
      payload_json: payloadJson,
      payload_hash: payloadHash,
      status: 'PENDING'
    });

    const s1 = outboxManager.updateOperationStatus(db, companyA, 'op_stat_1', 'SENDING');
    expect(s1.status).toBe('SENDING');
    expect(s1.attempt_count).toBe(1);
    expect(s1.retry_count).toBe(0);

    const s2 = outboxManager.updateOperationStatus(db, companyA, 'op_stat_1', 'SYNCED');
    expect(s2.status).toBe('SYNCED');

    expect(() => {
      outboxManager.updateOperationStatus(db, companyA, 'op_stat_1', 'PENDING');
    }).toThrow(/INVALID_OUTBOX_TRANSITION/);
  });

  it('projection rebuild is deterministic and repeatable across multiple commands', () => {
    seedCompany(companyA);

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
    db.prepare(`INSERT INTO periods (id, company_id, name, start_date, is_closed, status, created_at)
      VALUES ('period-deterministic', ?, 'Deterministic', '2020-01-01', 0, 'OPEN', datetime('now'))`).run(companyA);
    db.prepare(`
      INSERT INTO tickets (id, company_id, model_id, period_id, party_number, party_record_id, patta_number, qty, status, submitted_at, created_at)
      VALUES ('20000000-0000-4000-8000-000000000001', ?, 'model_101', 'period-deterministic', '1', 'party_1', 1, 100, 'CONFIRMED', datetime('now'), datetime('now'))
    `).run(companyA);
    db.prepare(`
      INSERT INTO ticket_entries (id, ticket_id, company_id, op_name, worker_id, qty, created_at)
      VALUES ('e_conf', '20000000-0000-4000-8000-000000000001', '${companyA}', 'Bichish', 1, 100, datetime('now'))
    `).run();

    commandPipeline.executeSubmitTicketCommand(tempUserDataDir, companyA, {
      commandId: 'cmd_det_1',
      operationId: 'op_det_1',
      companyId: companyA,
      ticketId: '00000000-0000-4000-8000-000000000019',
      modelId: 'model_101',
      partyNumber: '1',
      partyRecordId: 'party_1',
      pattaNumber: 2,
      qty: 40,
      entries: [{ workerId: 1, opName: 'Bichish' }]
    });

    commandPipeline.executeRecordAdjustmentCommand(tempUserDataDir, companyA, {
      commandId: 'cmd_det_2',
      operationId: 'op_det_2',
      companyId: companyA,
      adjustmentId: 'adj_det',
      modelId: 'model_101',
      workerId: 1,
      opName: 'Bichish',
      deltaQty: 10,
      originalTicketId: '20000000-0000-4000-8000-000000000001',
      originalEntryId: 'e_conf',
      reason: 'Adjustment',
      createdBy: 'admin'
    });

    const run1 = rebuildCompanyProjections(tempUserDataDir, companyA);
    const run2 = rebuildCompanyProjections(tempUserDataDir, companyA);

    expect(db.prepare('SELECT original_period_id FROM production_adjustments WHERE adjustment_id = ?')
      .get('adj_det').original_period_id).toBe('period-deterministic');
    expect(run1.optimistic['model_101']['1']['Bichish']).toBe(150);
    expect(run1.accounting['model_101']['1']['Bichish']).toBe(110);
    expect(run1).toEqual(run2);
  });

  // =========================================================================
  // SECTION J: OUTBOX STORAGE BOUNDARY & SQLITE INVARIANT ENFORCEMENT (13 TESTS)
  // =========================================================================

  describe('Outbox Storage Boundary & SQLite Invariants', () => {
    it('1. valid canonical payload + matching 64-char SHA-256 => insert succeeds', () => {
      seedCompany(companyA);
      const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
      const payload = { modelId: 'model_101', qty: 50 };
      const payloadJson = canonicalStringify(payload);
      const payloadHash = computePayloadHash(payloadJson);

      outboxManager.insertOutboxOperation(db, {
        operation_id: 'op_storage_valid',
        company_id: companyA,
        command_type: 'SubmitTicket',
        entity_type: 'ticket',
        entity_id: 't_valid_1',
        payload_json: payloadJson,
        payload_hash: payloadHash,
        status: 'PENDING'
      });

      const row = outboxManager.getOperation(db, companyA, 'op_storage_valid');
      expect(row).toBeDefined();
      expect(row.payload_hash).toBe(payloadHash);
    });

    it('2. missing payload_hash => rejected', () => {
      seedCompany(companyA);
      const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
      const payloadJson = canonicalStringify({ modelId: 'model_101' });

      expect(() => {
        outboxManager.insertOutboxOperation(db, {
          operation_id: 'op_missing_hash',
          company_id: companyA,
          command_type: 'SubmitTicket',
          entity_type: 'ticket',
          entity_id: 't_m_1',
          payload_json: payloadJson
        });
      }).toThrow(/INVALID_PAYLOAD_HASH/);
    });

    it('3. null payload_hash => rejected', () => {
      seedCompany(companyA);
      const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
      const payloadJson = canonicalStringify({ modelId: 'model_101' });

      expect(() => {
        outboxManager.insertOutboxOperation(db, {
          operation_id: 'op_null_hash',
          company_id: companyA,
          command_type: 'SubmitTicket',
          entity_type: 'ticket',
          entity_id: 't_n_1',
          payload_json: payloadJson,
          payload_hash: null
        });
      }).toThrow(/INVALID_PAYLOAD_HASH/);
    });

    it('4. empty payload_hash => rejected', () => {
      seedCompany(companyA);
      const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
      const payloadJson = canonicalStringify({ modelId: 'model_101' });

      expect(() => {
        outboxManager.insertOutboxOperation(db, {
          operation_id: 'op_empty_hash',
          company_id: companyA,
          command_type: 'SubmitTicket',
          entity_type: 'ticket',
          entity_id: 't_e_1',
          payload_json: payloadJson,
          payload_hash: ''
        });
      }).toThrow(/INVALID_PAYLOAD_HASH/);
    });

    it('5. invalid length => rejected', () => {
      seedCompany(companyA);
      const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
      const payloadJson = canonicalStringify({ modelId: 'model_101' });

      expect(() => {
        outboxManager.insertOutboxOperation(db, {
          operation_id: 'op_short_hash',
          company_id: companyA,
          command_type: 'SubmitTicket',
          entity_type: 'ticket',
          entity_id: 't_s_1',
          payload_json: payloadJson,
          payload_hash: 'a'.repeat(63)
        });
      }).toThrow(/INVALID_PAYLOAD_HASH/);

      expect(() => {
        outboxManager.insertOutboxOperation(db, {
          operation_id: 'op_long_hash',
          company_id: companyA,
          command_type: 'SubmitTicket',
          entity_type: 'ticket',
          entity_id: 't_l_1',
          payload_json: payloadJson,
          payload_hash: 'a'.repeat(65)
        });
      }).toThrow(/INVALID_PAYLOAD_HASH/);
    });

    it('6. non-hex hash => rejected', () => {
      seedCompany(companyA);
      const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
      const payloadJson = canonicalStringify({ modelId: 'model_101' });

      expect(() => {
        outboxManager.insertOutboxOperation(db, {
          operation_id: 'op_nonhex_hash',
          company_id: companyA,
          command_type: 'SubmitTicket',
          entity_type: 'ticket',
          entity_id: 't_nh_1',
          payload_json: payloadJson,
          payload_hash: 'z'.repeat(64)
        });
      }).toThrow(/INVALID_PAYLOAD_HASH/);
    });

    it('7. uppercase hash => rejected if lowercase is canonical rule', () => {
      seedCompany(companyA);
      const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
      const payloadJson = canonicalStringify({ modelId: 'model_101' });
      const validLower = computePayloadHash(payloadJson);
      const upperHash = validLower.toUpperCase();

      expect(() => {
        outboxManager.insertOutboxOperation(db, {
          operation_id: 'op_upper_hash',
          company_id: companyA,
          command_type: 'SubmitTicket',
          entity_type: 'ticket',
          entity_id: 't_u_1',
          payload_json: payloadJson,
          payload_hash: upperHash
        });
      }).toThrow(/INVALID_PAYLOAD_HASH/);
    });

    it('8. valid-looking hash but wrong for payload_json => PAYLOAD_HASH_MISMATCH', () => {
      seedCompany(companyA);
      const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
      const payloadA = canonicalStringify({ data: 'A' });
      const payloadB = canonicalStringify({ data: 'B' });
      const hashB = computePayloadHash(payloadB);

      expect(() => {
        outboxManager.insertOutboxOperation(db, {
          operation_id: 'op_mismatch_hash',
          company_id: companyA,
          command_type: 'SubmitTicket',
          entity_type: 'ticket',
          entity_id: 't_mismatch_1',
          payload_json: payloadA,
          payload_hash: hashB
        });
      }).toThrow(/PAYLOAD_HASH_MISMATCH/);
    });

    it('9. malformed payload_json => rejected', () => {
      seedCompany(companyA);
      const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
      const validHash = 'a'.repeat(64);

      expect(() => {
        outboxManager.insertOutboxOperation(db, {
          operation_id: 'op_malformed_json',
          company_id: companyA,
          command_type: 'SubmitTicket',
          entity_type: 'ticket',
          entity_id: 't_malformed_1',
          payload_json: 'malformed { json',
          payload_hash: validHash
        });
      }).toThrow(/MALFORMED_PAYLOAD_JSON/);
    });

    it('10. direct SQL insert with NULL hash => SQLite constraint/trigger rejects', () => {
      seedCompany(companyA);
      const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);

      expect(() => {
        db.prepare(`
          INSERT INTO local_outbox (
            operation_id, company_id, command_type, entity_type, entity_id,
            base_revision, payload_json, payload_hash, status, created_at, updated_at
          ) VALUES (
            'op_direct_null', '${companyA}', 'SubmitTicket', 'ticket', 't_sql_1',
            0, '{}', NULL, 'PENDING', datetime('now'), datetime('now')
          )
        `).run();
      }).toThrow(/INVALID_PAYLOAD_HASH/);
    });

    it('11. direct SQL insert with invalid hash => SQLite constraint/trigger rejects', () => {
      seedCompany(companyA);
      const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);

      expect(() => {
        db.prepare(`
          INSERT INTO local_outbox (
            operation_id, company_id, command_type, entity_type, entity_id,
            base_revision, payload_json, payload_hash, status, created_at, updated_at
          ) VALUES (
            'op_direct_inv', '${companyA}', 'SubmitTicket', 'ticket', 't_sql_2',
            0, '{}', 'not_a_valid_hash', 'PENDING', datetime('now'), datetime('now')
          )
        `).run();
      }).toThrow(/INVALID_PAYLOAD_HASH/);

      expect(() => {
        db.prepare(`
          INSERT INTO local_outbox (
            operation_id, company_id, command_type, entity_type, entity_id,
            base_revision, payload_json, payload_hash, status, created_at, updated_at
          ) VALUES (
            'op_direct_upper', '${companyA}', 'SubmitTicket', 'ticket', 't_sql_3',
            0, '{}', '${'A'.repeat(64)}', 'PENDING', datetime('now'), datetime('now')
          )
        `).run();
      }).toThrow(/INVALID_PAYLOAD_HASH/);
    });

    it('12. direct SQL UPDATE setting hash NULL => rejected', () => {
      seedCompany(companyA);
      const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
      const validHash = 'b'.repeat(64);
      db.prepare(`
        INSERT INTO local_outbox (
          operation_id, company_id, command_type, entity_type, entity_id,
          base_revision, payload_json, payload_hash, status, created_at, updated_at
        ) VALUES (
          'op_for_update_null', '${companyA}', 'SubmitTicket', 'ticket', 't_sql_4',
          0, '{}', ?, 'PENDING', datetime('now'), datetime('now')
        )
      `).run(validHash);

      expect(() => {
        db.prepare(`
          UPDATE local_outbox SET payload_hash = NULL WHERE operation_id = 'op_for_update_null'
        `).run();
      }).toThrow(/INVALID_PAYLOAD_HASH|IMMUTABLE_OUTBOX_OPERATION/);
    });

    it('13. direct SQL UPDATE setting invalid hash => rejected', () => {
      seedCompany(companyA);
      const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
      const validHash = 'c'.repeat(64);
      db.prepare(`
        INSERT INTO local_outbox (
          operation_id, company_id, command_type, entity_type, entity_id,
          base_revision, payload_json, payload_hash, status, created_at, updated_at
        ) VALUES (
          'op_for_update_bad', '${companyA}', 'SubmitTicket', 'ticket', 't_sql_5',
          0, '{}', ?, 'PENDING', datetime('now'), datetime('now')
        )
      `).run(validHash);

      expect(() => {
        db.prepare(`
          UPDATE local_outbox SET payload_hash = 'bad_hash' WHERE operation_id = 'op_for_update_bad'
        `).run();
      }).toThrow(/INVALID_PAYLOAD_HASH|IMMUTABLE_OUTBOX_OPERATION/);

      expect(() => {
        db.prepare(`
          UPDATE local_outbox SET payload_hash = '${'C'.repeat(64)}' WHERE operation_id = 'op_for_update_bad'
        `).run();
      }).toThrow(/INVALID_PAYLOAD_HASH|IMMUTABLE_OUTBOX_OPERATION/);
    });
  });

  // =========================================================================
  // SECTION F: OUTBOX SEMANTIC IMMUTABILITY & MIGRATION 005 (Items F.1 - F.16)
  // =========================================================================

  describe('SECTION F: OUTBOX SEMANTIC IMMUTABILITY & MIGRATION 005', () => {
    function insertBaseOutboxRow(db: any, opId = 'op_immut_base', overrides: any = {}) {
      const payloadA = canonicalStringify({ ticketId: 'tick_1', qty: 100 });
      const hashA = computePayloadHash(payloadA);
      const row = {
        operation_id: opId,
        company_id: companyA,
        command_type: 'SubmitTicket',
        entity_type: 'ticket',
        entity_id: 'tick_1',
        base_revision: 0,
        payload_json: payloadA,
        payload_hash: hashA,
        depends_on_operation_id: null,
        causal_sequence: 1,
        created_at: '2026-03-01T10:00:00.000Z',
        status: 'PENDING',
        attempt_count: 0,
        retry_count: 0,
        last_error: null,
        error_message: null,
        updated_at: '2026-03-01T10:00:00.000Z',
        ...overrides
      };

      db.prepare(`
        INSERT INTO local_outbox (
          operation_id, company_id, command_type, entity_type, entity_id,
          base_revision, payload_json, payload_hash, depends_on_operation_id, causal_sequence,
          created_at, status, attempt_count, retry_count, last_error, error_message, updated_at
        ) VALUES (
          @operation_id, @company_id, @command_type, @entity_type, @entity_id,
          @base_revision, @payload_json, @payload_hash, @depends_on_operation_id, @causal_sequence,
          @created_at, @status, @attempt_count, @retry_count, @last_error, @error_message, @updated_at
        )
      `).run(row);
      return row;
    }

    // -------------------------------------------------------------------------
    // Section 13: Direct SQL updates to immutable fields
    // -------------------------------------------------------------------------

    it('F.1. direct SQL update of operation_id fails with IMMUTABLE_OUTBOX_OPERATION', () => {
      seedCompany(companyA);
      const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
      insertBaseOutboxRow(db, 'op_f1');

      expect(() => {
        db.prepare("UPDATE local_outbox SET operation_id = 'op_f1_mod' WHERE operation_id = 'op_f1'").run();
      }).toThrow(/IMMUTABLE_OUTBOX_OPERATION/);
    });

    it('F.2. direct SQL update of company_id fails with IMMUTABLE_OUTBOX_OPERATION', () => {
      seedCompany(companyA);
      const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
      insertBaseOutboxRow(db, 'op_f2');

      expect(() => {
        db.prepare("UPDATE local_outbox SET company_id = 'company_other' WHERE operation_id = 'op_f2'").run();
      }).toThrow(/IMMUTABLE_OUTBOX_OPERATION/);
    });

    it('F.3. direct SQL update of command_type fails with IMMUTABLE_OUTBOX_OPERATION', () => {
      seedCompany(companyA);
      const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
      insertBaseOutboxRow(db, 'op_f3');

      expect(() => {
        db.prepare("UPDATE local_outbox SET command_type = 'CancelTicket' WHERE operation_id = 'op_f3'").run();
      }).toThrow(/IMMUTABLE_OUTBOX_OPERATION/);
    });

    it('F.4. direct SQL update of entity_type fails with IMMUTABLE_OUTBOX_OPERATION', () => {
      seedCompany(companyA);
      const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
      insertBaseOutboxRow(db, 'op_f4');

      expect(() => {
        db.prepare("UPDATE local_outbox SET entity_type = 'model' WHERE operation_id = 'op_f4'").run();
      }).toThrow(/IMMUTABLE_OUTBOX_OPERATION/);
    });

    it('F.5. direct SQL update of entity_id fails with IMMUTABLE_OUTBOX_OPERATION', () => {
      seedCompany(companyA);
      const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
      insertBaseOutboxRow(db, 'op_f5');

      expect(() => {
        db.prepare("UPDATE local_outbox SET entity_id = 'tick_other' WHERE operation_id = 'op_f5'").run();
      }).toThrow(/IMMUTABLE_OUTBOX_OPERATION/);
    });

    it('F.6. direct SQL update of base_revision fails with IMMUTABLE_OUTBOX_OPERATION', () => {
      seedCompany(companyA);
      const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
      insertBaseOutboxRow(db, 'op_f6');

      expect(() => {
        db.prepare("UPDATE local_outbox SET base_revision = 5 WHERE operation_id = 'op_f6'").run();
      }).toThrow(/IMMUTABLE_OUTBOX_OPERATION/);
    });

    it('F.7. direct SQL update of payload_json fails with IMMUTABLE_OUTBOX_OPERATION', () => {
      seedCompany(companyA);
      const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
      insertBaseOutboxRow(db, 'op_f7');

      expect(() => {
        db.prepare("UPDATE local_outbox SET payload_json = '{\"different\": true}' WHERE operation_id = 'op_f7'").run();
      }).toThrow(/IMMUTABLE_OUTBOX_OPERATION/);
    });

    it('F.8. direct SQL update of payload_hash to another valid SHA-256 fails with IMMUTABLE_OUTBOX_OPERATION', () => {
      seedCompany(companyA);
      const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
      insertBaseOutboxRow(db, 'op_f8');

      const anotherValidHash = computePayloadHash(canonicalStringify({ other: 'payload' }));
      expect(() => {
        db.prepare("UPDATE local_outbox SET payload_hash = ? WHERE operation_id = 'op_f8'").run(anotherValidHash);
      }).toThrow(/IMMUTABLE_OUTBOX_OPERATION/);
    });

    it('F.9. direct SQL update of depends_on_operation_id fails with IMMUTABLE_OUTBOX_OPERATION', () => {
      seedCompany(companyA);
      const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);

      // Case 9a: NULL to non-NULL
      insertBaseOutboxRow(db, 'op_f9a', { depends_on_operation_id: null });
      expect(() => {
        db.prepare("UPDATE local_outbox SET depends_on_operation_id = 'op_parent' WHERE operation_id = 'op_f9a'").run();
      }).toThrow(/IMMUTABLE_OUTBOX_OPERATION/);

      // Case 9b: non-NULL to different non-NULL
      insertBaseOutboxRow(db, 'op_f9b', { depends_on_operation_id: 'op_parent1' });
      expect(() => {
        db.prepare("UPDATE local_outbox SET depends_on_operation_id = 'op_parent2' WHERE operation_id = 'op_f9b'").run();
      }).toThrow(/IMMUTABLE_OUTBOX_OPERATION/);

      // Case 9c: non-NULL to NULL
      insertBaseOutboxRow(db, 'op_f9c', { depends_on_operation_id: 'op_parent1' });
      expect(() => {
        db.prepare("UPDATE local_outbox SET depends_on_operation_id = NULL WHERE operation_id = 'op_f9c'").run();
      }).toThrow(/IMMUTABLE_OUTBOX_OPERATION/);
    });

    it('F.10. direct SQL update of causal_sequence fails with IMMUTABLE_OUTBOX_OPERATION', () => {
      seedCompany(companyA);
      const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
      insertBaseOutboxRow(db, 'op_f10');

      expect(() => {
        db.prepare("UPDATE local_outbox SET causal_sequence = 99 WHERE operation_id = 'op_f10'").run();
      }).toThrow(/IMMUTABLE_OUTBOX_OPERATION/);
    });

    it('F.11. direct SQL update of created_at fails with IMMUTABLE_OUTBOX_OPERATION', () => {
      seedCompany(companyA);
      const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
      insertBaseOutboxRow(db, 'op_f11');

      expect(() => {
        db.prepare("UPDATE local_outbox SET created_at = '2099-01-01T00:00:00.000Z' WHERE operation_id = 'op_f11'").run();
      }).toThrow(/IMMUTABLE_OUTBOX_OPERATION/);
    });

    // -------------------------------------------------------------------------
    // Section 14: Payload consistency immutability tests
    // -------------------------------------------------------------------------

    it('F.12. Test A: changing payload_json only fails with IMMUTABLE_OUTBOX_OPERATION', () => {
      seedCompany(companyA);
      const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
      insertBaseOutboxRow(db, 'op_f12');

      const payloadB = canonicalStringify({ ticketId: 'tick_1', qty: 999 });
      expect(() => {
        db.prepare("UPDATE local_outbox SET payload_json = ? WHERE operation_id = 'op_f12'").run(payloadB);
      }).toThrow(/IMMUTABLE_OUTBOX_OPERATION/);
    });

    it('F.13. Test B: changing payload_hash only to valid hash B fails with IMMUTABLE_OUTBOX_OPERATION', () => {
      seedCompany(companyA);
      const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
      insertBaseOutboxRow(db, 'op_f13');

      const payloadB = canonicalStringify({ ticketId: 'tick_1', qty: 999 });
      const hashB = computePayloadHash(payloadB);
      expect(() => {
        db.prepare("UPDATE local_outbox SET payload_hash = ? WHERE operation_id = 'op_f13'").run(hashB);
      }).toThrow(/IMMUTABLE_OUTBOX_OPERATION/);
    });

    it('F.14. Test C: changing payload_json to B AND payload_hash to SHA256(B) fails with IMMUTABLE_OUTBOX_OPERATION', () => {
      seedCompany(companyA);
      const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
      insertBaseOutboxRow(db, 'op_f14');

      const payloadB = canonicalStringify({ ticketId: 'tick_1', qty: 999 });
      const hashB = computePayloadHash(payloadB);
      expect(() => {
        db.prepare("UPDATE local_outbox SET payload_json = ?, payload_hash = ? WHERE operation_id = 'op_f14'").run(payloadB, hashB);
      }).toThrow(/IMMUTABLE_OUTBOX_OPERATION/);
    });

    // -------------------------------------------------------------------------
    // Section 15: Mutable field tests & outbox state machine
    // -------------------------------------------------------------------------

    it('F.15. direct SQL updates to mutable fields succeed', () => {
      seedCompany(companyA);
      const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);
      insertBaseOutboxRow(db, 'op_f15');

      db.prepare(`
        UPDATE local_outbox
        SET status = 'SENDING',
            attempt_count = 1,
            retry_count = 0,
            last_error = 'temporary error',
            error_message = 'temporary error message',
            updated_at = '2026-03-01T10:05:00.000Z'
        WHERE operation_id = 'op_f15'
      `).run();

      const row = db.prepare('SELECT * FROM local_outbox WHERE operation_id = ?').get('op_f15');
      expect(row.status).toBe('SENDING');
      expect(row.attempt_count).toBe(1);
      expect(row.retry_count).toBe(0);
      expect(row.last_error).toBe('temporary error');
      expect(row.error_message).toBe('temporary error message');
      expect(row.updated_at).toBe('2026-03-01T10:05:00.000Z');
    });

    it('F.16. outbox lifecycle state machine transitions succeed via outboxManager.updateOperationStatus', () => {
      seedCompany(companyA);
      const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyA);

      // PENDING -> SENDING -> SYNCED
      insertBaseOutboxRow(db, 'op_flow_synced');
      let op = outboxManager.updateOperationStatus(db, companyA, 'op_flow_synced', 'SENDING');
      expect(op.status).toBe('SENDING');
      expect(op.attempt_count).toBe(1);
      op = outboxManager.updateOperationStatus(db, companyA, 'op_flow_synced', 'SYNCED');
      expect(op.status).toBe('SYNCED');

      // PENDING -> SENDING -> PENDING (transient failure retry)
      insertBaseOutboxRow(db, 'op_flow_retry');
      outboxManager.updateOperationStatus(db, companyA, 'op_flow_retry', 'SENDING');
      op = outboxManager.updateOperationStatus(db, companyA, 'op_flow_retry', 'PENDING', 'network timeout');
      expect(op.status).toBe('PENDING');
      expect(op.last_error).toBe('network timeout');

      // PENDING -> SENDING -> CONFLICT -> PENDING
      insertBaseOutboxRow(db, 'op_flow_conflict');
      outboxManager.updateOperationStatus(db, companyA, 'op_flow_conflict', 'SENDING');
      op = outboxManager.updateOperationStatus(db, companyA, 'op_flow_conflict', 'CONFLICT', 'version conflict');
      expect(op.status).toBe('CONFLICT');
      op = outboxManager.updateOperationStatus(db, companyA, 'op_flow_conflict', 'PENDING');
      expect(op.status).toBe('PENDING');

      // PENDING -> SENDING -> DEAD_LETTER
      insertBaseOutboxRow(db, 'op_flow_dead');
      outboxManager.updateOperationStatus(db, companyA, 'op_flow_dead', 'SENDING');
      op = outboxManager.updateOperationStatus(db, companyA, 'op_flow_dead', 'DEAD_LETTER', 'poison pill');
      expect(op.status).toBe('DEAD_LETTER');
    });
  });
});
