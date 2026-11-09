import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readPattaJournalFacts } from './pattaJournalReader.cjs';
import { canonicalStringify, computePayloadHash } from './canonicalPayload.cjs';

describe('PattaJournalReader', () => {
  let db: any;
  const companyId = 'test_comp';

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE parties (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        party_number TEXT NOT NULL,
        model_id TEXT NOT NULL,
        model_name TEXT,
        color TEXT,
        patta_count INTEGER NOT NULL DEFAULT 0,
        cumulative_patta_count INTEGER NOT NULL DEFAULT 0,
        patta_start_number INTEGER,
        patta_end_number INTEGER,
        ish_soni_per_patta INTEGER,
        total_ish_soni INTEGER,
        ish_soni INTEGER NOT NULL DEFAULT 0,
        cumulative_ish_soni INTEGER NOT NULL DEFAULT 0,
        sizes_json TEXT,
        size_order_json TEXT,
        printed_at TEXT,
        is_closed INTEGER NOT NULL DEFAULT 0,
        closed_at TEXT,
        ended_at TEXT,
        ended_operation_id TEXT,
        month_closed_period_id TEXT,
        archived_patta_numbers_json TEXT,
        is_archived INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        server_revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE model_id_aliases (
        company_id TEXT NOT NULL,
        legacy_model_id TEXT NOT NULL,
        canonical_model_id TEXT NOT NULL
      );

      CREATE TABLE protected_party_patta_ranges (
        company_id TEXT NOT NULL,
        party_record_id TEXT NOT NULL,
        patta_start_number INTEGER NOT NULL,
        patta_end_number INTEGER NOT NULL
      );

      CREATE TABLE periods (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        name TEXT NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT,
        is_closed INTEGER NOT NULL DEFAULT 0,
        closed_at TEXT,
        close_operation_id TEXT,
        notes TEXT,
        archive_filename TEXT,
        status TEXT NOT NULL DEFAULT 'OPEN',
        server_revision INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE tickets (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        party_number TEXT,
        party_record_id TEXT,
        patta_number INTEGER NOT NULL,
        period_id TEXT,
        status TEXT NOT NULL DEFAULT 'CONFIRMED',
        qty INTEGER NOT NULL DEFAULT 0,
        size TEXT,
        color TEXT,
        is_closed INTEGER NOT NULL DEFAULT 0,
        submitted_at TEXT NOT NULL,
        server_revision INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE period_archives (
        company_id TEXT NOT NULL,
        period_id TEXT NOT NULL,
        archive_json TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        archived_at TEXT NOT NULL,
        PRIMARY KEY (company_id, period_id)
      );

      CREATE TABLE local_outbox (
        operation_id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        command_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload_json TEXT,
        local_archive_json TEXT,
        status TEXT NOT NULL
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  it('reads open parties, tickets, and periods correctly', () => {
    db.prepare(`INSERT INTO parties (id, company_id, party_number, model_id, patta_count, status)
      VALUES ('p1', ?, '1', 'm1', 2, 'ACTIVE')`).run(companyId);
    db.prepare(`INSERT INTO periods (id, company_id, name, start_date)
      VALUES ('per1', ?, 'Current Month', '2026-11-01')`).run(companyId);
    db.prepare(`INSERT INTO tickets (id, company_id, model_id, party_record_id, patta_number, period_id, qty, submitted_at)
      VALUES ('t1', ?, 'm1', 'p1', 1, 'per1', 10, '2026-11-05')`).run(companyId);

    const facts = readPattaJournalFacts(db, companyId);
    expect(facts.parties).toHaveLength(1);
    expect(facts.parties[0].id).toBe('p1');
    expect(facts.periods).toHaveLength(1);
    expect(facts.tickets).toHaveLength(1);
    expect(facts.tickets[0].id).toBe('t1');
    expect(facts.tickets[0].qty).toBe(10);
    expect(facts.pendingEffects.hasPendingFinish).toBe(false);
  });

  it('deduplicates ticket IDs between live table and verified archive', () => {
    const archiveData = {
      submittedTickets: [
        { id: 't1', modelId: 'm1', partyRecordId: 'p1', pattaNumber: 1, periodId: 'P', qty: 10, status: 'CONFIRMED' }
      ]
    };
    const sha = computePayloadHash(canonicalStringify(archiveData));
    db.prepare(`INSERT INTO period_archives (company_id, period_id, archive_json, sha256, archived_at)
      VALUES (?, 'P', ?, ?, '2026-11-01')`).run(companyId, JSON.stringify(archiveData), sha);

    // Same ticket also in live tickets table
    db.prepare(`INSERT INTO tickets (id, company_id, model_id, party_record_id, patta_number, period_id, qty, submitted_at)
      VALUES ('t1', ?, 'm1', 'p1', 1, 'P', 10, '2026-11-01')`).run(companyId);

    const facts = readPattaJournalFacts(db, companyId);
    // Must be exactly one ticket in output, no duplicates!
    expect(facts.tickets).toHaveLength(1);
    expect(facts.tickets[0].id).toBe('t1');
  });

  it('reads hidden parties and ended facts accurately', () => {
    db.prepare(`INSERT INTO parties (id, company_id, party_number, model_id, patta_count, is_archived, ended_at, ended_operation_id, status)
      VALUES ('pHidden', ?, '99', 'm1', 1, 1, '2026-11-09T00:00:00Z', 'op_fin', 'CLOSED')`).run(companyId);

    const facts = readPattaJournalFacts(db, companyId);
    expect(facts.parties).toHaveLength(1);
    expect(facts.parties[0].id).toBe('pHidden');
    expect(facts.parties[0].isArchived).toBe(true);
    expect(facts.parties[0].endedAt).toBe('2026-11-09T00:00:00Z');
    expect(facts.parties[0].endedOperationId).toBe('op_fin');
  });
});

