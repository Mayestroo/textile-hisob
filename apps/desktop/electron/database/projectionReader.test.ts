import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { buildHisobProjections, getAccountingQuantity, getOptimisticQuantity, TicketFact } from '../../renderer/domain/projections';

// @ts-ignore
const databaseManager = require('./databaseManager.cjs');
// @ts-ignore
const migrator = require('./migrator.cjs');
// @ts-ignore
const projectionReader = require('./projectionReader.cjs');

describe('SQLite Projection Reader Adapter (Narrow Read Seam)', () => {
  let tempUserDataDir: string;
  const companyId = 'test_projection_reader_co';

  beforeEach(() => {
    tempUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'step2-reader-test-'));
  });

  afterEach(() => {
    databaseManager.closeAllCompanyDatabases();
    try {
      if (fs.existsSync(tempUserDataDir)) {
        fs.rmSync(tempUserDataDir, { recursive: true, force: true });
      }
    } catch (e) {}
  });

  it('reads canonical ticket facts from Step 1 SQLite database and computes matching projections', () => {
    const novdaDir = path.join(tempUserDataDir, 'NovdaData');
    fs.mkdirSync(novdaDir, { recursive: true });

    const legacyPayload = {
      companyId,
      models: [
        {
          id: 'model_hoodie',
          name: 'Hoodie Zimniy',
          operations: [
            { id: 'op_1', name: 'Bichish', rate: 1500 },
            { id: 'op_2', name: 'Tikish', rate: 4000 }
          ],
          hisobQuantities: {
            '1': { 'Bichish': 150 },
            '2': { 'Tikish': 150 }
          }
        }
      ],
      workers: [
        { id: 1, name: 'Anvar', role: 'Bichuvchi' },
        { id: 2, name: 'Botir', role: 'Tikuvchi' }
      ],
      submittedTickets: [
        {
          id: 'sub_ticket_1',
          modelId: 'model_hoodie',
          qty: 150,
          partyNumber: '1',
          pattaNumber: 1,
          entries: [
            { workerId: 1, opName: 'Bichish', rateSnapshot: 1500 },
            { workerId: 2, opName: 'Tikish', rateSnapshot: 4000 }
          ]
        }
      ],
      printedPartyHistory: [
        {
          id: 'legacy-hoodie-party-1',
          modelId: 'model_hoodie',
          partyNumber: '1',
          pattaCount: 1,
          ishSoni: 150,
          printedAt: '2026-03-01T09:00:00.000Z'
        }
      ]
    };

    const sourcePath = path.join(novdaDir, `hisob_database_${companyId}.json`);
    fs.writeFileSync(sourcePath, JSON.stringify(legacyPayload, null, 2), 'utf8');

    // Run migration
    const migRes = migrator.migrateLegacyData(tempUserDataDir, companyId, { explicitSourcePath: sourcePath });
    expect(migRes.success).toBe(true);

    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyId);

    // Read normalized ticket facts
    const facts: TicketFact[] = projectionReader.loadTicketFactsFromSqlite(db, companyId);
    expect(facts.length).toBe(1);
    expect(facts[0].ticketId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(facts[0].status).toBe('CONFIRMED');
    expect(facts[0].entries.length).toBe(2);

    // Execute pure projection engine
    const projections = buildHisobProjections({ tickets: facts });
    const canonicalModelId = facts[0].modelId;

    expect(getAccountingQuantity(projections, canonicalModelId, 1, 'Bichish')).toBe(150);
    expect(getAccountingQuantity(projections, canonicalModelId, 2, 'Tikish')).toBe(150);
    expect(getOptimisticQuantity(projections, canonicalModelId, 1, 'Bichish')).toBe(150);
    expect(getOptimisticQuantity(projections, canonicalModelId, 2, 'Tikish')).toBe(150);
  });

  it('handles empty production adjustments gracefully when table does not exist', () => {
    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyId);
    const adjustments = projectionReader.loadProductionAdjustmentFactsFromSqlite(db, companyId);
    expect(adjustments).toEqual([]);
  });

  it('loads a read-only, company-scoped legacy-shaped workbook projection', () => {
    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyId);
    const otherCompanyId = 'other_projection_reader_co';
    const now = '2026-09-23T10:00:00.000Z';
    const ticketId = '11111111-1111-4111-8111-111111111111';

    db.prepare(`
      INSERT INTO models (
        id, company_id, name, hisob_sheet_name, title, party, color, size,
        operations_json, patta_ops_order_json, created_at, updated_at, provenance
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'model-a', companyId, 'Model A', 'Model A-hisob', 'Model- A', '', 'Black', 'M',
      JSON.stringify([{ id: 'op-1', name: 'Sew', rate: 2 }]), JSON.stringify(['Sew']), now, now, 'TEST'
    );
    db.prepare(`
      INSERT INTO workers (
        id, company_id, name, staj, role, status, legacy_avans, legacy_jarima,
        created_at, updated_at, provenance
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, companyId, 'Worker A', 3, 'Sewing', 'ACTIVE', 10, 2, now, now, 'TEST');
    db.prepare(`
      INSERT INTO workers (
        id, company_id, name, staj, role, status, legacy_avans, legacy_jarima,
        created_at, updated_at, provenance
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(2, otherCompanyId, 'Other Worker', 3, 'Sewing', 'ACTIVE', 99, 88, now, now, 'TEST');
    db.prepare(`
      INSERT INTO worker_adjustments (
        id, company_id, worker_id, period_id, type, amount, description, provenance, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('adjust-avans-a', companyId, 1, 'period-a', 'AVANS', 25, 'Canonical avans', 'TEST', 'POSTED', now);
    db.prepare(`
      INSERT INTO worker_adjustments (
        id, company_id, worker_id, period_id, type, amount, description, provenance, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('adjust-jarima-a', companyId, 1, 'period-a', 'JARIMA', 7, 'Canonical jarima', 'TEST', 'POSTED', now);
    db.prepare(`
      INSERT INTO worker_adjustments (
        id, company_id, worker_id, period_id, type, amount, description, provenance, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('adjust-avans-other', otherCompanyId, 2, 'period-other', 'AVANS', 1000, 'Other company', 'TEST', 'POSTED', now);
    db.prepare(`
      INSERT INTO parties (
        id, company_id, party_number, physical_party_number, model_id, model_name,
        color, patta_count, cumulative_patta_count, ish_soni, cumulative_ish_soni,
        sizes_json, printed_at, is_closed, status, created_at, updated_at, provenance
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'party-a', companyId, '1', '1', 'model-a', 'Model A', 'Black', 1, 1, 5, 5,
      JSON.stringify({ M: '1' }), now, 0, 'ACTIVE', now, now, 'TEST'
    );
    db.prepare(`
      INSERT INTO tickets (
        id, company_id, model_id, party_number, party_record_id, patta_number,
        qty, size, color, konveyer, status, is_closed, submitted_at, created_at, provenance
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ticketId, companyId, 'model-a', '1', 'party-a', 1, 5, 'M', 'Black', 'K1', 'CONFIRMED', 0, now, now, 'TEST');
    db.prepare(`
      INSERT INTO ticket_entries (
        id, ticket_id, company_id, op_name, worker_id, worker_name_snapshot,
        rate_snapshot, brak, qty, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('entry-a', ticketId, companyId, 'Sew', 1, 'Worker A', 2, null, 5, now);

    const pendingDeleteTicketId = '11111111-1111-4111-8111-111111111112';
    db.prepare(`INSERT INTO tickets (
      id, company_id, model_id, party_number, party_record_id, patta_number,
      qty, size, color, konveyer, status, is_closed, submitted_at, created_at, provenance
    ) VALUES (?, ?, 'model-a', '1', 'party-a', 2, 20, 'M', 'Black', 'K1', 'PENDING_DELETE', 0, ?, ?, 'TEST')`)
      .run(pendingDeleteTicketId, companyId, now, now);

    db.prepare(`
      INSERT INTO models (
        id, company_id, name, operations_json, patta_ops_order_json,
        created_at, updated_at, provenance
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('model-other', otherCompanyId, 'Other', '[]', '[]', now, now, 'TEST');

    const before = db.prepare('SELECT COUNT(*) AS count FROM tickets WHERE company_id = ?').get(companyId);
    const projection = projectionReader.loadWorkbookProjectionFromSqlite(db, companyId);
    const after = db.prepare('SELECT COUNT(*) AS count FROM tickets WHERE company_id = ?').get(companyId);

    expect(projection.companyId).toBe(companyId);
    expect(projection.models).toHaveLength(1);
    expect(projection.models[0]).toEqual(expect.objectContaining({ id: 'model-a' }));
    expect(projection.models[0].hisobQuantities).toEqual({ '1': { Sew: 5 } });
    expect(projection.nextPartyNumber).toBe(2);
    expect(projection.workers).toEqual([expect.objectContaining({ id: 1, name: 'Worker A', avans: 25, jarima: 7 })]);
    expect(projection.printedPartyHistory).toEqual([expect.objectContaining({ id: 'party-a', partyNumber: '1' })]);
    expect(projection.submittedTickets).toEqual([
      expect.objectContaining({ id: ticketId, partyRecordId: 'party-a', qty: 5, status: 'CONFIRMED' })
    ]);
    expect(projection.submittedTickets).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: pendingDeleteTicketId })
    ]));
    expect(projection.projections.accounting['model-a']['1'].Sew).toBe(5);
    expect(before).toEqual(after);
  });
});
