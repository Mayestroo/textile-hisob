'use strict';

const crypto = require('crypto');
const { canonicalStringify, computePayloadHash } = require('./canonicalPayload.cjs');
const { createCanonicalEntityUuid } = require('./identifierPolicy.cjs');

/**
 * Migration definitions for Novda  Local SQLite Database.
 * Each migration is strictly ordered, transactional, and idempotent.
 */
const MIGRATIONS = [
  {
    version: 1,
    name: '001_initial_sync_foundation',
    up: (db) => {
      // 1. Schema metadata table (Authoritative source for applied migrations)
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_meta (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL,
          checksum TEXT NOT NULL
        );
      `);

      // 2. Local metadata table (key-value configuration per company)
      db.exec(`
        CREATE TABLE IF NOT EXISTS local_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);

      // 3. Migration run tracking table
      db.exec(`
        CREATE TABLE IF NOT EXISTS migration_runs (
          migration_run_id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL,
          source_path TEXT NOT NULL,
          source_sha256 TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          status TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          model_count INTEGER NOT NULL DEFAULT 0,
          worker_count INTEGER NOT NULL DEFAULT 0,
          ticket_count INTEGER NOT NULL DEFAULT 0,
          party_count INTEGER NOT NULL DEFAULT 0,
          quarantine_count INTEGER NOT NULL DEFAULT 0,
          warning_count INTEGER NOT NULL DEFAULT 0,
          error_count INTEGER NOT NULL DEFAULT 0,
          warnings_json TEXT,
          errors_json TEXT,
          parity_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_migration_runs_company ON migration_runs(company_id);
        CREATE INDEX IF NOT EXISTS idx_migration_runs_sha ON migration_runs(source_sha256);
      `);

      // 4. Migration Collision Quarantine: Parties (Architecture Sec 7)
      db.exec(`
        CREATE TABLE IF NOT EXISTS migration_quarantine_parties (
          quarantine_id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL,
          original_party_number TEXT NOT NULL,
          model_id TEXT NOT NULL,
          ticket_count INTEGER NOT NULL DEFAULT 0,
          printed_at TEXT NOT NULL,
          legacy_record_id TEXT NOT NULL,
          resolution_status TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
          resolved_party_id TEXT,
          resolution_notes TEXT,
          quarantined_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_quar_parties_comp ON migration_quarantine_parties(company_id);
        CREATE INDEX IF NOT EXISTS idx_quar_parties_status ON migration_quarantine_parties(resolution_status);
      `);

      // 5. Migration Staging Quarantine: Tickets with broken foreign keys (e.g. missing model)
      db.exec(`
        CREATE TABLE IF NOT EXISTS migration_quarantine_tickets (
          quarantine_id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL,
          legacy_ticket_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          party_number TEXT,
          patta_number INTEGER,
          qty REAL,
          reason TEXT NOT NULL,
          raw_legacy_json TEXT NOT NULL,
          quarantined_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_quar_tickets_comp ON migration_quarantine_tickets(company_id);
      `);

      // 6. Migration Staging Quarantine: Ticket entries with broken foreign keys (e.g. missing worker)
      db.exec(`
        CREATE TABLE IF NOT EXISTS migration_quarantine_ticket_entries (
          quarantine_id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL,
          legacy_ticket_id TEXT NOT NULL,
          op_name TEXT NOT NULL,
          worker_id INTEGER NOT NULL,
          reason TEXT NOT NULL,
          raw_legacy_json TEXT NOT NULL,
          quarantined_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_quar_entries_comp ON migration_quarantine_ticket_entries(company_id);
      `);

      // 7. Migration Reconciliation Candidates (Mandatory Amendment 2: Unexplained hisob differences)
      db.exec(`
        CREATE TABLE IF NOT EXISTS migration_reconciliation_candidates (
          candidate_id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          worker_id INTEGER NOT NULL,
          operation_name TEXT NOT NULL,
          legacy_qty REAL NOT NULL,
          ticket_derived_qty REAL NOT NULL,
          delta_qty REAL NOT NULL,
          status TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
          reason TEXT NOT NULL,
          notes TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_reconcile_cand_model ON migration_reconciliation_candidates(model_id, worker_id);
        CREATE INDEX IF NOT EXISTS idx_reconcile_cand_status ON migration_reconciliation_candidates(status);
      `);

      // 8. Canonical Models Table
      db.exec(`
        CREATE TABLE IF NOT EXISTS models (
          id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL,
          name TEXT NOT NULL,
          hisob_sheet_name TEXT,
          title TEXT,
          party TEXT,
          color TEXT,
          size TEXT,
          operations_json TEXT NOT NULL DEFAULT '[]',
          patta_ops_order_json TEXT NOT NULL DEFAULT '[]',
          legacy_hisob_quantities_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          provenance TEXT NOT NULL DEFAULT 'LEGACY_MIGRATION'
        );
        CREATE INDEX IF NOT EXISTS idx_models_comp ON models(company_id);
      `);

      // 9. Canonical Workers Table (Mandatory Amendment 1: staj is worker attribute, NOT adjustment fact)
      db.exec(`
        CREATE TABLE IF NOT EXISTS workers (
          id INTEGER PRIMARY KEY,
          company_id TEXT NOT NULL,
          name TEXT NOT NULL,
          staj REAL NOT NULL DEFAULT 0,
          role TEXT,
          status TEXT NOT NULL DEFAULT 'ACTIVE',
          legacy_avans REAL NOT NULL DEFAULT 0,
          legacy_jarima REAL NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          provenance TEXT NOT NULL DEFAULT 'LEGACY_MIGRATION'
        );
        CREATE INDEX IF NOT EXISTS idx_workers_comp ON workers(company_id);
        CREATE INDEX IF NOT EXISTS idx_workers_status ON workers(status);
      `);

      // 10. Canonical Parties Table
      db.exec(`
        CREATE TABLE IF NOT EXISTS parties (
          id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL,
          party_number TEXT NOT NULL,
          physical_party_number TEXT NOT NULL,
          model_id TEXT NOT NULL,
          model_name TEXT,
          color TEXT,
          patta_count INTEGER NOT NULL DEFAULT 0,
          cumulative_patta_count INTEGER NOT NULL DEFAULT 0,
          ish_soni_per_patta REAL,
          total_ish_soni REAL,
          ish_soni REAL NOT NULL DEFAULT 0,
          cumulative_ish_soni REAL NOT NULL DEFAULT 0,
          sizes_json TEXT,
          printed_at TEXT,
          is_closed INTEGER NOT NULL DEFAULT 0,
          closed_at TEXT,
          archived_patta_numbers_json TEXT,
          status TEXT NOT NULL DEFAULT 'ACTIVE',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          provenance TEXT NOT NULL DEFAULT 'LEGACY_MIGRATION'
        );
        CREATE INDEX IF NOT EXISTS idx_parties_comp ON parties(company_id);
        CREATE INDEX IF NOT EXISTS idx_parties_model ON parties(model_id);
        CREATE INDEX IF NOT EXISTS idx_parties_num ON parties(company_id, party_number);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_parties_active_unique ON parties(company_id, party_number) WHERE status != 'CLOSED';
      `);

      // 11. Canonical Tickets Table (FK to models)
      db.exec(`
        CREATE TABLE IF NOT EXISTS tickets (
          id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL,
          model_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
          party_number TEXT NOT NULL,
          party_record_id TEXT,
          patta_number INTEGER NOT NULL,
          qty REAL NOT NULL,
          size TEXT,
          color TEXT,
          konveyer TEXT,
          status TEXT NOT NULL DEFAULT 'CONFIRMED',
          is_closed INTEGER NOT NULL DEFAULT 0,
          submitted_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          provenance TEXT NOT NULL DEFAULT 'LEGACY_MIGRATION',
          raw_legacy_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_tickets_comp ON tickets(company_id);
        CREATE INDEX IF NOT EXISTS idx_tickets_model ON tickets(model_id);
        CREATE INDEX IF NOT EXISTS idx_tickets_party ON tickets(party_number);
        CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
        CREATE INDEX IF NOT EXISTS idx_tickets_sub_at ON tickets(submitted_at);
      `);

      // 12. Canonical Ticket Entries Table (FK to tickets and workers)
      db.exec(`
        CREATE TABLE IF NOT EXISTS ticket_entries (
          id TEXT PRIMARY KEY,
          ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
          company_id TEXT NOT NULL,
          op_name TEXT NOT NULL,
          worker_id INTEGER NOT NULL REFERENCES workers(id) ON DELETE RESTRICT,
          worker_name_snapshot TEXT,
          rate_snapshot REAL,
          brak TEXT,
          qty REAL NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_entries_ticket ON ticket_entries(ticket_id);
        CREATE INDEX IF NOT EXISTS idx_entries_worker ON ticket_entries(worker_id);
        CREATE INDEX IF NOT EXISTS idx_entries_worker_op ON ticket_entries(worker_id, op_name);
      `);

      // 13. Canonical Worker Adjustments Table (Strictly for accounting facts: AVANS, JARIMA)
      db.exec(`
        CREATE TABLE IF NOT EXISTS worker_adjustments (
          id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL,
          worker_id INTEGER NOT NULL REFERENCES workers(id) ON DELETE RESTRICT,
          period_id TEXT,
          type TEXT NOT NULL,
          amount REAL NOT NULL,
          description TEXT,
          provenance TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'POSTED',
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_adj_worker ON worker_adjustments(worker_id);
        CREATE INDEX IF NOT EXISTS idx_adj_type ON worker_adjustments(type);
      `);

      // 14. Canonical Periods Table
      db.exec(`
        CREATE TABLE IF NOT EXISTS periods (
          id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL,
          name TEXT NOT NULL,
          start_date TEXT NOT NULL,
          end_date TEXT,
          is_closed INTEGER NOT NULL DEFAULT 0,
          closed_at TEXT,
          notes TEXT,
          archive_filename TEXT,
          status TEXT NOT NULL DEFAULT 'OPEN',
          created_at TEXT NOT NULL,
          provenance TEXT NOT NULL DEFAULT 'LEGACY_MIGRATION'
        );
        CREATE INDEX IF NOT EXISTS idx_periods_comp ON periods(company_id);
      `);

      // 15. [RESERVED FOR STEP 3] Local Outbox Table (Schema reserved only, sync not active in Step 1)
      db.exec(`
        CREATE TABLE IF NOT EXISTS local_outbox (
          operation_id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL,
          command_type TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          base_revision INTEGER NOT NULL DEFAULT 0,
          payload_json TEXT NOT NULL,
          depends_on_operation_id TEXT,
          causal_sequence INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'PENDING',
          retry_count INTEGER NOT NULL DEFAULT 0,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_outbox_comp_status ON local_outbox(company_id, status);
        CREATE INDEX IF NOT EXISTS idx_outbox_causal ON local_outbox(causal_sequence);
      `);

      // 16. [RESERVED FOR STEP 4] Local Party Leases Table (Schema reserved only, lease logic not active in Step 1)
      db.exec(`
        CREATE TABLE IF NOT EXISTS local_party_leases (
          lease_id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL,
          range_start INTEGER NOT NULL,
          range_end INTEGER NOT NULL,
          next_available INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'ACTIVE'
        );
        CREATE INDEX IF NOT EXISTS idx_leases_comp ON local_party_leases(company_id);
      `);
    }
  },
  {
    version: 2,
    name: '002_step3_pipeline_and_adjustments',
    up: (db) => {
      // 1. Canonical Production Adjustments Table
      db.exec(`
        CREATE TABLE IF NOT EXISTS production_adjustments (
          adjustment_id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL,
          model_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
          worker_id INTEGER NOT NULL REFERENCES workers(id) ON DELETE RESTRICT,
          op_name TEXT NOT NULL,
          delta_qty REAL NOT NULL,
          reason TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'APPROVED',
          server_revision INTEGER NOT NULL DEFAULT 1,
          provenance TEXT NOT NULL DEFAULT 'MANUAL_CORRECTION',
          created_at TEXT NOT NULL,
          created_by TEXT NOT NULL,
          original_adjustment_id TEXT REFERENCES production_adjustments(adjustment_id)
        );
        CREATE INDEX IF NOT EXISTS idx_prod_adj_comp ON production_adjustments(company_id);
        CREATE INDEX IF NOT EXISTS idx_prod_adj_model ON production_adjustments(model_id);
        CREATE INDEX IF NOT EXISTS idx_prod_adj_worker ON production_adjustments(worker_id);
        CREATE INDEX IF NOT EXISTS idx_prod_adj_status ON production_adjustments(status);
        CREATE INDEX IF NOT EXISTS idx_prod_adj_orig ON production_adjustments(original_adjustment_id);
      `);

      // 2. Add attempt_count and last_error to local_outbox if missing
      const outboxCols = db.prepare(`PRAGMA table_info(local_outbox)`).all().map((c) => c.name);
      if (!outboxCols.includes('attempt_count')) {
        db.exec(`ALTER TABLE local_outbox ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;`);
      }
      if (!outboxCols.includes('last_error')) {
        db.exec(`ALTER TABLE local_outbox ADD COLUMN last_error TEXT;`);
      }

      // 3. Unique index for ticket business key (company_id, model_id, party_number, patta_number)
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_business_key ON tickets(company_id, model_id, party_number, patta_number);
      `);

      // 4. Unique index for local_outbox company-scoped operation
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_company_op ON local_outbox(company_id, operation_id);
      `);
    }
  },
  {
    version: 3,
    name: '003_outbox_payload_hash',
    up: (db) => {
      // 1. Add payload_hash column to local_outbox if missing
      const outboxCols = db.prepare(`PRAGMA table_info(local_outbox)`).all().map((c) => c.name);
      if (!outboxCols.includes('payload_hash')) {
        db.exec(`ALTER TABLE local_outbox ADD COLUMN payload_hash TEXT;`);
      }

      // 2. Backfill existing development outbox rows deterministically
      const rows = db.prepare(`SELECT operation_id, payload_json FROM local_outbox WHERE payload_hash IS NULL`).all();
      const updateStmt = db.prepare(`UPDATE local_outbox SET payload_hash = ? WHERE operation_id = ?`);

      for (const row of rows) {
        let hash;
        try {
          const parsed = JSON.parse(row.payload_json);
          const canonical = canonicalStringify(parsed);
          hash = computePayloadHash(canonical);
        } catch (err) {
          throw new Error(`[Migration 003] Cannot backfill payload_hash for operation "${row.operation_id}": ${err.message}`);
        }
        updateStmt.run(hash, row.operation_id);
      }

      // 3. Index on payload_hash for fast company-scoped replay lookup
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_outbox_payload_hash ON local_outbox(company_id, payload_hash);
      `);
    }
  },
  {
    version: 4,
    name: '004_outbox_payload_hash_constraints',
    up: (db) => {
      // 1. Scan all existing local_outbox rows
      const rows = db.prepare(`SELECT operation_id, payload_json, payload_hash FROM local_outbox`).all();
      const updateStmt = db.prepare(`UPDATE local_outbox SET payload_hash = ? WHERE operation_id = ?`);

      for (const row of rows) {
        // payload_json must parse
        let parsed;
        try {
          if (typeof row.payload_json !== 'string') {
            throw new Error('payload_json is not a string');
          }
          parsed = JSON.parse(row.payload_json);
        } catch (parseErr) {
          throw new Error(`[Migration 004] Malformed payload_json for operation "${row.operation_id}": ${parseErr.message}`);
        }

        // Canonicalize payload & recompute canonical SHA-256
        let canonical;
        try {
          canonical = canonicalStringify(parsed);
        } catch (canonErr) {
          throw new Error(`[Migration 004] Cannot canonicalize payload_json for operation "${row.operation_id}": ${canonErr.message}`);
        }

        const canonicalHash = computePayloadHash(canonical);

        // If an existing non-empty payload_hash differs from the canonical payload hash: FAIL MIGRATION
        if (row.payload_hash !== null && row.payload_hash !== undefined && String(row.payload_hash).trim() !== '') {
          if (row.payload_hash !== canonicalHash) {
            throw new Error(
              `[Migration 004] Conflicting payload_hash for operation "${row.operation_id}": existing "${row.payload_hash}" does not match canonical "${canonicalHash}"`
            );
          }
        } else {
          // If payload_hash is NULL/empty/invalid but payload_json is valid: backfill correct canonical hash
          updateStmt.run(canonicalHash, row.operation_id);
        }
      }

      // 2. Install SQLite BEFORE INSERT and BEFORE UPDATE triggers to enforce payload_hash constraints
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_local_outbox_validate_payload_hash_insert
        BEFORE INSERT ON local_outbox
        FOR EACH ROW
        WHEN NEW.payload_hash IS NULL
          OR length(NEW.payload_hash) != 64
          OR NEW.payload_hash GLOB '*[^0-9a-f]*'
        BEGIN
          SELECT RAISE(ABORT, 'INVALID_PAYLOAD_HASH');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_local_outbox_validate_payload_hash_update
        BEFORE UPDATE OF payload_hash ON local_outbox
        FOR EACH ROW
        WHEN NEW.payload_hash IS NULL
          OR length(NEW.payload_hash) != 64
          OR NEW.payload_hash GLOB '*[^0-9a-f]*'
        BEGIN
          SELECT RAISE(ABORT, 'INVALID_PAYLOAD_HASH');
        END;
      `);
    }
  },
  {
    version: 5,
    name: '005_outbox_semantic_immutability',
    up: (db) => {
      // Install SQLite BEFORE UPDATE trigger to enforce semantic immutability of local_outbox
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_local_outbox_semantic_immutability
        BEFORE UPDATE ON local_outbox
        FOR EACH ROW
        WHEN
            NEW.operation_id IS NOT OLD.operation_id
         OR NEW.company_id IS NOT OLD.company_id
         OR NEW.command_type IS NOT OLD.command_type
         OR NEW.entity_type IS NOT OLD.entity_type
         OR NEW.entity_id IS NOT OLD.entity_id
         OR NEW.base_revision IS NOT OLD.base_revision
         OR NEW.payload_json IS NOT OLD.payload_json
         OR NEW.payload_hash IS NOT OLD.payload_hash
         OR NEW.depends_on_operation_id IS NOT OLD.depends_on_operation_id
         OR NEW.causal_sequence IS NOT OLD.causal_sequence
         OR NEW.created_at IS NOT OLD.created_at
        BEGIN
          SELECT RAISE(ABORT, 'IMMUTABLE_OUTBOX_OPERATION');
        END;
      `);
    }
  },
  {
    version: 6,
    name: '006_active_party_uniqueness_and_ticket_identity',
    up: (db) => {
      // 1. Ensure canonical parties table exists with active unique index
      db.exec(`
        CREATE TABLE IF NOT EXISTS parties (
          id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL,
          party_number TEXT NOT NULL,
          physical_party_number TEXT NOT NULL,
          model_id TEXT NOT NULL,
          model_name TEXT,
          color TEXT,
          patta_count INTEGER NOT NULL DEFAULT 0,
          cumulative_patta_count INTEGER NOT NULL DEFAULT 0,
          ish_soni_per_patta REAL,
          total_ish_soni REAL,
          ish_soni REAL NOT NULL DEFAULT 0,
          cumulative_ish_soni REAL NOT NULL DEFAULT 0,
          sizes_json TEXT,
          printed_at TEXT,
          is_closed INTEGER NOT NULL DEFAULT 0,
          closed_at TEXT,
          archived_patta_numbers_json TEXT,
          status TEXT NOT NULL DEFAULT 'ACTIVE',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          provenance TEXT NOT NULL DEFAULT 'LEGACY_MIGRATION'
        );
        CREATE INDEX IF NOT EXISTS idx_parties_comp ON parties(company_id);
        CREATE INDEX IF NOT EXISTS idx_parties_model ON parties(model_id);
        CREATE INDEX IF NOT EXISTS idx_parties_num ON parties(company_id, party_number);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_parties_active_unique ON parties(company_id, party_number) WHERE status != 'CLOSED';
      `);

      // 2. Drop obsolete unique index idx_tickets_business_key (Approach A: Canonical UUID Ticket Identity)
      db.exec(`DROP INDEX IF EXISTS idx_tickets_business_key;`);

      // 3. Add non-unique index on tickets for party_record_id lookups
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tickets_party_record ON tickets(company_id, party_record_id);`);

      // 4. Create dedicated operator resolution audit table for historical collisions
      db.exec(`
        CREATE TABLE IF NOT EXISTS migration_party_resolutions (
          resolution_id TEXT PRIMARY KEY,
          quarantine_id TEXT NOT NULL,
          company_id TEXT NOT NULL,
          party_id TEXT NOT NULL,
          decision TEXT NOT NULL,
          operator_id TEXT NOT NULL,
          decided_at TEXT NOT NULL,
          source_snapshot_hash TEXT NOT NULL,
          reason TEXT NOT NULL,
          original_is_closed INTEGER NOT NULL DEFAULT 0,
          original_closed_at TEXT,
          resolution_provenance TEXT NOT NULL DEFAULT 'OPERATOR_MIGRATION_DECISION',
          resolution_notes TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_party_res_quar ON migration_party_resolutions(quarantine_id);
        CREATE INDEX IF NOT EXISTS idx_party_res_party ON migration_party_resolutions(company_id, party_id);
      `);

      // 5. Enhance migration_quarantine_parties table if columns missing
      const quarCols = db.prepare(`PRAGMA table_info(migration_quarantine_parties)`).all().map((c) => c.name);
      if (!quarCols.includes('original_is_closed')) {
        db.exec(`ALTER TABLE migration_quarantine_parties ADD COLUMN original_is_closed INTEGER NOT NULL DEFAULT 0;`);
      }
      if (!quarCols.includes('original_closed_at')) {
        db.exec(`ALTER TABLE migration_quarantine_parties ADD COLUMN original_closed_at TEXT;`);
      }
      if (!quarCols.includes('collision_type')) {
        db.exec(`ALTER TABLE migration_quarantine_parties ADD COLUMN collision_type TEXT NOT NULL DEFAULT 'LEGACY_SIMULTANEOUS_ACTIVE_COLLISION';`);
      }
      if (!quarCols.includes('raw_source_json')) {
        db.exec(`ALTER TABLE migration_quarantine_parties ADD COLUMN raw_source_json TEXT;`);
      }
      if (!quarCols.includes('resolution_decision')) {
        db.exec(`ALTER TABLE migration_quarantine_parties ADD COLUMN resolution_decision TEXT;`);
      }
      if (!quarCols.includes('resolution_operator_id')) {
        db.exec(`ALTER TABLE migration_quarantine_parties ADD COLUMN resolution_operator_id TEXT;`);
      }
      if (!quarCols.includes('resolved_at')) {
        db.exec(`ALTER TABLE migration_quarantine_parties ADD COLUMN resolved_at TEXT;`);
      }
    }
  },
  {
    version: 7,
    name: '007_grandfathered_active_party_exception',
    up: (db) => {
      // 1. Create legacy_party_collision_exceptions table
      db.exec(`
        CREATE TABLE IF NOT EXISTS legacy_party_collision_exceptions (
          exception_id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL,
          party_number TEXT NOT NULL,
          party_id TEXT NOT NULL,
          collision_group_id TEXT NOT NULL,
          approved_by TEXT NOT NULL,
          approved_at TEXT NOT NULL,
          reason TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'ACTIVE',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (company_id, party_id)
        );
        CREATE INDEX IF NOT EXISTS idx_legacy_exceptions_comp_num ON legacy_party_collision_exceptions(company_id, party_number, status);
      `);

      // 2. Drop the plain partial unique index (which rejected legitimate grandfathered pairs)
      db.exec(`DROP INDEX IF EXISTS idx_parties_active_unique;`);

      // 3. Install SQLite active uniqueness triggers
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_parties_active_unique_insert
        BEFORE INSERT ON parties
        FOR EACH ROW
        WHEN NEW.status != 'CLOSED'
        BEGIN
          SELECT CASE
            -- If NEW.id is NOT an approved grandfather exception, but another active party exists:
            WHEN (
              NOT EXISTS (
                SELECT 1 FROM legacy_party_collision_exceptions
                WHERE company_id = NEW.company_id AND party_id = NEW.id AND party_number = NEW.party_number
              )
              AND EXISTS (
                SELECT 1 FROM parties
                WHERE company_id = NEW.company_id
                  AND party_number = NEW.party_number
                  AND status != 'CLOSED'
                  AND id != NEW.id
              )
            )
            THEN RAISE(ABORT, 'ACTIVE_PARTY_EXISTS: Active party already exists for this party number')

            -- If NEW.id IS grandfathered, but there are already 2 active parties:
            WHEN (
              EXISTS (
                SELECT 1 FROM legacy_party_collision_exceptions
                WHERE company_id = NEW.company_id AND party_id = NEW.id AND party_number = NEW.party_number
              )
              AND (
                SELECT COUNT(*) FROM parties
                WHERE company_id = NEW.company_id
                  AND party_number = NEW.party_number
                  AND status != 'CLOSED'
                  AND id != NEW.id
              ) >= 2
            )
            THEN RAISE(ABORT, 'ACTIVE_PARTY_EXISTS: Grandfathered collision limit exceeded')
          END;
        END;

        CREATE TRIGGER IF NOT EXISTS trg_parties_active_unique_update
        BEFORE UPDATE OF status, party_number ON parties
        FOR EACH ROW
        WHEN NEW.status != 'CLOSED'
        BEGIN
          SELECT CASE
            -- Reopening or changing to active when another active party exists:
            WHEN (OLD.status = 'CLOSED' OR OLD.party_number != NEW.party_number) AND EXISTS (
              SELECT 1 FROM parties
              WHERE company_id = NEW.company_id
                AND party_number = NEW.party_number
                AND status != 'CLOSED'
                AND id != NEW.id
            )
            THEN RAISE(ABORT, 'ACTIVE_PARTY_EXISTS: Cannot reopen party; another active party already exists')
          END;
        END;
      `);
    }
  },
  {
    version: 8,
    name: '008_reconciliation_resolution_audit',
    up: (db) => {
      // 1. Add audit columns to migration_reconciliation_candidates if not present
      const candCols = db.prepare(`PRAGMA table_info(migration_reconciliation_candidates)`).all().map((c) => c.name);
      if (!candCols.includes('source_snapshot_hash')) {
        db.exec(`ALTER TABLE migration_reconciliation_candidates ADD COLUMN source_snapshot_hash TEXT;`);
      }
      if (!candCols.includes('resolution_decision')) {
        db.exec(`ALTER TABLE migration_reconciliation_candidates ADD COLUMN resolution_decision TEXT;`);
      }
      if (!candCols.includes('resolution_operator_id')) {
        db.exec(`ALTER TABLE migration_reconciliation_candidates ADD COLUMN resolution_operator_id TEXT;`);
      }
      if (!candCols.includes('resolved_at')) {
        db.exec(`ALTER TABLE migration_reconciliation_candidates ADD COLUMN resolved_at TEXT;`);
      }
      if (!candCols.includes('created_adjustment_id')) {
        db.exec(`ALTER TABLE migration_reconciliation_candidates ADD COLUMN created_adjustment_id TEXT;`);
      }
      if (!candCols.includes('source_reference')) {
        db.exec(`ALTER TABLE migration_reconciliation_candidates ADD COLUMN source_reference TEXT;`);
      }

      // 2. Create migration_reconciliation_resolutions audit table
      db.exec(`
        CREATE TABLE IF NOT EXISTS migration_reconciliation_resolutions (
          resolution_id TEXT PRIMARY KEY,
          candidate_id TEXT NOT NULL REFERENCES migration_reconciliation_candidates(candidate_id),
          company_id TEXT NOT NULL,
          decision TEXT NOT NULL,
          operator_id TEXT NOT NULL,
          operator_role TEXT NOT NULL,
          reason TEXT NOT NULL,
          decided_at TEXT NOT NULL,
          source_snapshot_hash TEXT NOT NULL,
          legacy_qty REAL NOT NULL,
          derived_qty REAL NOT NULL,
          delta_qty REAL NOT NULL,
          created_adjustment_id TEXT REFERENCES production_adjustments(adjustment_id),
          source_reference TEXT,
          resolution_provenance TEXT NOT NULL DEFAULT 'OPERATOR_RECONCILIATION_RESOLUTION',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_reconcile_res_cand ON migration_reconciliation_resolutions(candidate_id);
        CREATE INDEX IF NOT EXISTS idx_reconcile_res_comp ON migration_reconciliation_resolutions(company_id);
      `);

      // 3. Immutability triggers on migration_reconciliation_resolutions
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_reconciliation_resolutions_immutable_update
        BEFORE UPDATE ON migration_reconciliation_resolutions
        FOR EACH ROW
        BEGIN
          SELECT RAISE(ABORT, 'IMMUTABLE_AUDIT_RECORD: migration_reconciliation_resolutions records cannot be modified');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_reconciliation_resolutions_immutable_delete
        BEFORE DELETE ON migration_reconciliation_resolutions
        FOR EACH ROW
        BEGIN
          SELECT RAISE(ABORT, 'IMMUTABLE_AUDIT_RECORD: migration_reconciliation_resolutions records cannot be deleted');
        END;
      `);
    }
  },
  {
    version: 9,
    name: '009_ticket_uuid_party_fk',
    up: (db) => {
      const invalid = db.prepare(`
        SELECT t.id, t.company_id, t.party_record_id
        FROM tickets t LEFT JOIN parties p ON p.id = t.party_record_id AND p.company_id = t.company_id
        WHERE t.id NOT GLOB '????????-????-[1-5]???-[89abAB]???-????????????'
           OR t.party_record_id IS NULL OR trim(t.party_record_id) = '' OR p.id IS NULL
        ORDER BY t.company_id, t.id LIMIT 20
      `).all();
      if (invalid.length) {
        const err = new Error(`[Migration 009] TICKET_IDENTITY_MIGRATION_BLOCKED: invalid ticket/party links: ${invalid.map((r) => `${r.company_id}/${r.id}`).join(', ')}`);
        err.code = 'TICKET_IDENTITY_MIGRATION_BLOCKED';
        err.records = invalid;
        throw err;
      }
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_parties_company_id ON parties(company_id, id);
        CREATE TABLE tickets_v9 (
          id TEXT PRIMARY KEY,
          company_id TEXT NOT NULL,
          model_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
          party_number TEXT NOT NULL,
          party_record_id TEXT NOT NULL,
          patta_number INTEGER NOT NULL, qty REAL NOT NULL, size TEXT, color TEXT, konveyer TEXT,
          status TEXT NOT NULL DEFAULT 'CONFIRMED', is_closed INTEGER NOT NULL DEFAULT 0,
          submitted_at TEXT NOT NULL, created_at TEXT NOT NULL,
          provenance TEXT NOT NULL DEFAULT 'LEGACY_MIGRATION', raw_legacy_json TEXT,
          FOREIGN KEY (company_id, party_record_id) REFERENCES parties(company_id, id) ON DELETE RESTRICT
        );
        INSERT INTO tickets_v9 SELECT * FROM tickets;
        CREATE TABLE ticket_entries_v9 (
          id TEXT PRIMARY KEY,
          ticket_id TEXT NOT NULL REFERENCES tickets_v9(id) ON DELETE CASCADE,
          company_id TEXT NOT NULL, op_name TEXT NOT NULL,
          worker_id INTEGER NOT NULL REFERENCES workers(id) ON DELETE RESTRICT,
          worker_name_snapshot TEXT, rate_snapshot REAL, brak TEXT, qty REAL NOT NULL, created_at TEXT NOT NULL
        );
        INSERT INTO ticket_entries_v9 SELECT * FROM ticket_entries;
        DROP TABLE ticket_entries;
        DROP TABLE tickets;
        ALTER TABLE tickets_v9 RENAME TO tickets;
        ALTER TABLE ticket_entries_v9 RENAME TO ticket_entries;
        CREATE INDEX idx_tickets_comp ON tickets(company_id);
        CREATE INDEX idx_tickets_model ON tickets(model_id);
        CREATE INDEX idx_tickets_party ON tickets(party_number);
        CREATE INDEX idx_tickets_party_record ON tickets(company_id, party_record_id);
        CREATE INDEX idx_tickets_status ON tickets(status);
        CREATE INDEX idx_tickets_sub_at ON tickets(submitted_at);
        CREATE INDEX idx_entries_ticket ON ticket_entries(ticket_id);
        CREATE INDEX idx_entries_worker ON ticket_entries(worker_id);
        CREATE INDEX idx_entries_worker_op ON ticket_entries(worker_id, op_name);
      `);
    }
  },
  {
    version: 10,
    name: '010_exact_party_2_policy',
    up: (db) => {
      const duplicateGroups = db.prepare(`
        SELECT company_id, party_number
        FROM parties
        WHERE status != 'CLOSED'
        GROUP BY company_id, party_number
        HAVING COUNT(*) > 1
        ORDER BY company_id, party_number
      `).all();

      for (const group of duplicateGroups) {
        const rows = db.prepare(`
          SELECT id, company_id, party_number, status
          FROM parties
          WHERE company_id = ? AND party_number = ? AND status != 'CLOSED'
          ORDER BY id
        `).all(group.company_id, group.party_number);

        if (rows.length !== 2) {
          const error = new Error(
            `[Migration 010] ACTIVE_PARTY_MIGRATION_BLOCKED: unexpected non-closed duplicate for ${group.company_id}/${group.party_number}`
          );
          error.code = 'ACTIVE_PARTY_MIGRATION_BLOCKED';
          error.records = rows;
          throw error;
        }
        const collisionGroupId = crypto.randomUUID();
        const now = new Date().toISOString();
        const insertException = db.prepare(`
          INSERT INTO legacy_party_collision_exceptions (
            exception_id, company_id, party_number, party_id, collision_group_id,
            approved_by, approved_at, reason, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
          ON CONFLICT(company_id, party_id) DO NOTHING
        `);
        for (const row of rows) {
          insertException.run(crypto.randomUUID(), row.company_id, row.party_number, row.id,
            collisionGroupId, 'schema-migration', now,
            'Pre-existing active-party collision preserved during migration');
        }
      }

      db.exec(`
        DROP TRIGGER IF EXISTS trg_parties_active_unique_insert;
        DROP TRIGGER IF EXISTS trg_parties_active_unique_update;
        DROP TRIGGER IF EXISTS trg_parties_identity_immutable_update;

        CREATE TRIGGER trg_parties_identity_immutable_update
        BEFORE UPDATE ON parties
        FOR EACH ROW
        WHEN NEW.id IS NOT OLD.id OR NEW.company_id IS NOT OLD.company_id
        BEGIN
          SELECT RAISE(ABORT, 'IMMUTABLE_PARTY_IDENTITY: parties.id and parties.company_id cannot be modified');
        END;

        CREATE TRIGGER trg_parties_exact_party_2_insert
        BEFORE INSERT ON parties
        FOR EACH ROW
        WHEN NEW.status != 'CLOSED' AND EXISTS (
          SELECT 1 FROM parties p WHERE p.company_id = NEW.company_id
            AND p.party_number = NEW.party_number AND p.status != 'CLOSED' AND p.id != NEW.id
        )
        BEGIN
          SELECT CASE
            WHEN NOT EXISTS (
              SELECT 1 FROM legacy_party_collision_exceptions e
              WHERE e.company_id = NEW.company_id AND e.party_id = NEW.id
                AND e.party_number = NEW.party_number AND e.status = 'ACTIVE'
                AND e.collision_group_id IN (
                  SELECT e2.collision_group_id FROM legacy_party_collision_exceptions e2
                  WHERE e2.company_id = NEW.company_id AND e2.party_number = NEW.party_number
                    AND e2.status = 'ACTIVE'
                  GROUP BY e2.collision_group_id HAVING COUNT(*) = 2
                )
            )
            THEN RAISE(ABORT, 'ACTIVE_PARTY_EXISTS: Active party already exists for this party number')
          END;
        END;

        CREATE TRIGGER trg_parties_exact_party_2_update
        BEFORE UPDATE OF id, company_id, status, party_number ON parties
        FOR EACH ROW
        WHEN NEW.status != 'CLOSED'
          OR NEW.id IS NOT OLD.id
          OR NEW.company_id IS NOT OLD.company_id
        BEGIN
          SELECT CASE
            WHEN NEW.id IS NOT OLD.id OR NEW.company_id IS NOT OLD.company_id
            THEN RAISE(ABORT, 'IMMUTABLE_PARTY_IDENTITY: parties.id and parties.company_id cannot be modified')
          END;

          SELECT CASE
            WHEN NEW.status != 'CLOSED' AND EXISTS (
              SELECT 1 FROM parties p WHERE p.company_id = NEW.company_id
                AND p.party_number = NEW.party_number AND p.status != 'CLOSED' AND p.id != NEW.id
            ) AND NOT EXISTS (
              SELECT 1 FROM legacy_party_collision_exceptions e
              WHERE e.company_id = NEW.company_id AND e.party_id = NEW.id
                AND e.party_number = NEW.party_number AND e.status = 'ACTIVE'
                AND e.collision_group_id IN (
                  SELECT e2.collision_group_id FROM legacy_party_collision_exceptions e2
                  WHERE e2.company_id = NEW.company_id AND e2.party_number = NEW.party_number
                    AND e2.status = 'ACTIVE'
                  GROUP BY e2.collision_group_id HAVING COUNT(*) = 2
                )
            )
            THEN RAISE(ABORT, 'ACTIVE_PARTY_EXISTS: Cannot reopen party; another active party already exists')
          END;
        END;
      `);
    }
  },
  {
    version: 11,
    name: '011_synchronized_workbook_mutations',
    up: (db) => {
      const addColumnIfMissing = (table, column, definition) => {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
        if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      };

      addColumnIfMissing('models', 'status', "TEXT NOT NULL DEFAULT 'ACTIVE'");
      addColumnIfMissing('models', 'server_revision', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing('workers', 'server_revision', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing('periods', 'server_revision', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing('periods', 'updated_at', "TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing('parties', 'server_revision', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing('parties', 'is_archived', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing('tickets', 'period_id', 'TEXT');
      addColumnIfMissing('tickets', 'server_revision', 'INTEGER NOT NULL DEFAULT 0');

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_models_company_status ON models(company_id, status);
        CREATE INDEX IF NOT EXISTS idx_workers_company_status ON workers(company_id, status);
        CREATE INDEX IF NOT EXISTS idx_periods_company_open ON periods(company_id, is_closed, start_date);
        CREATE INDEX IF NOT EXISTS idx_tickets_company_period ON tickets(company_id, period_id, submitted_at);

        CREATE TABLE IF NOT EXISTS company_batch_settings (
          company_id TEXT PRIMARY KEY,
          available_sizes_json TEXT NOT NULL DEFAULT '[]',
          server_revision INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS patta_batch_settings (
          company_id TEXT NOT NULL,
          model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
          party_number TEXT NOT NULL DEFAULT '',
          is_custom_party INTEGER NOT NULL DEFAULT 0 CHECK (is_custom_party IN (0, 1)),
          total_ish_soni TEXT NOT NULL DEFAULT '',
          color TEXT,
          sizes_json TEXT NOT NULL DEFAULT '{}',
          server_revision INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (company_id, model_id)
        );

        CREATE TABLE IF NOT EXISTS period_archives (
          company_id TEXT NOT NULL,
          period_id TEXT NOT NULL REFERENCES periods(id) ON DELETE RESTRICT,
          archive_json TEXT NOT NULL,
          sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
          archived_at TEXT NOT NULL,
          PRIMARY KEY (company_id, period_id)
        );

        CREATE TABLE IF NOT EXISTS local_ticket_forms (
          company_id TEXT NOT NULL,
          model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
          form_json TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (company_id, model_id)
        );
      `);
    }
  },
  {
    version: 12,
    name: '012_party_two_company_scope',
    up: (db) => {
      const duplicateGroups = db.prepare(`
        SELECT company_id, party_number
        FROM parties
        WHERE status != 'CLOSED'
        GROUP BY company_id, party_number
        HAVING COUNT(*) > 1
        ORDER BY company_id, party_number
      `).all();

      const insertException = db.prepare(`
        INSERT INTO legacy_party_collision_exceptions (
          exception_id, company_id, party_number, party_id, collision_group_id,
          approved_by, approved_at, reason, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
        ON CONFLICT(company_id, party_id) DO NOTHING
      `);
      for (const group of duplicateGroups) {
        const rows = db.prepare(`
          SELECT id, company_id, party_number, status
          FROM parties
          WHERE company_id = ? AND party_number = ? AND status != 'CLOSED'
          ORDER BY id
        `).all(group.company_id, group.party_number);
        if (rows.length !== 2) {
          const error = new Error(
            `[Migration 012] ACTIVE_PARTY_MIGRATION_BLOCKED: expected exactly two pre-existing duplicate rows for ${group.company_id}/${group.party_number}`
          );
          error.code = 'ACTIVE_PARTY_MIGRATION_BLOCKED';
          error.records = rows;
          throw error;
        }
        const collisionGroupId = crypto.randomUUID();
        const now = new Date().toISOString();
        for (const row of rows) {
          insertException.run(
            crypto.randomUUID(), row.company_id, row.party_number, row.id,
            collisionGroupId, 'schema-migration', now,
            'Pre-existing active-party collision preserved during migration'
          );
        }
      }

      db.exec(`
        DROP TRIGGER IF EXISTS trg_parties_exact_party_2_insert;
        DROP TRIGGER IF EXISTS trg_parties_exact_party_2_update;
        DROP TRIGGER IF EXISTS trg_parties_identity_immutable_update;

        CREATE TRIGGER trg_parties_identity_immutable_update
        BEFORE UPDATE ON parties
        FOR EACH ROW
        WHEN NEW.id IS NOT OLD.id OR NEW.company_id IS NOT OLD.company_id
        BEGIN
          SELECT RAISE(ABORT, 'IMMUTABLE_PARTY_IDENTITY: parties.id and parties.company_id cannot be modified');
        END;

        CREATE TRIGGER trg_parties_exact_party_2_insert
        BEFORE INSERT ON parties
        FOR EACH ROW
        WHEN NEW.status != 'CLOSED' AND EXISTS (
          SELECT 1 FROM parties
          WHERE company_id = NEW.company_id
            AND party_number = NEW.party_number
            AND status != 'CLOSED'
            AND id != NEW.id
        )
        BEGIN
          SELECT CASE
            WHEN NOT EXISTS (
              SELECT 1 FROM legacy_party_collision_exceptions e
              WHERE e.company_id = NEW.company_id AND e.party_id = NEW.id
                AND e.party_number = NEW.party_number AND e.status = 'ACTIVE'
                AND e.collision_group_id IN (
                  SELECT e2.collision_group_id FROM legacy_party_collision_exceptions e2
                  WHERE e2.company_id = NEW.company_id AND e2.party_number = NEW.party_number
                    AND e2.status = 'ACTIVE'
                  GROUP BY e2.collision_group_id
                  HAVING COUNT(*) = 2
                )
            )
            THEN RAISE(ABORT, 'ACTIVE_PARTY_EXISTS: Active party already exists for this party number')
          END;
        END;

        CREATE TRIGGER trg_parties_exact_party_2_update
        BEFORE UPDATE OF id, company_id, status, party_number ON parties
        FOR EACH ROW
        WHEN NEW.status != 'CLOSED'
          OR NEW.id IS NOT OLD.id
          OR NEW.company_id IS NOT OLD.company_id
        BEGIN
          SELECT CASE
            WHEN NEW.id IS NOT OLD.id OR NEW.company_id IS NOT OLD.company_id
            THEN RAISE(ABORT, 'IMMUTABLE_PARTY_IDENTITY: parties.id and parties.company_id cannot be modified')
          END;

          SELECT CASE WHEN NEW.status != 'CLOSED' AND EXISTS (
            SELECT 1 FROM parties p
            WHERE p.company_id = NEW.company_id AND p.party_number = NEW.party_number
              AND p.status != 'CLOSED' AND p.id != NEW.id
          ) AND NOT EXISTS (
            SELECT 1 FROM legacy_party_collision_exceptions e
            WHERE e.company_id = NEW.company_id AND e.party_id = NEW.id
              AND e.party_number = NEW.party_number AND e.status = 'ACTIVE'
              AND e.collision_group_id IN (
                SELECT e2.collision_group_id FROM legacy_party_collision_exceptions e2
                WHERE e2.company_id = NEW.company_id AND e2.party_number = NEW.party_number
                  AND e2.status = 'ACTIVE'
                GROUP BY e2.collision_group_id HAVING COUNT(*) = 2
              )
          ) THEN RAISE(ABORT, 'ACTIVE_PARTY_EXISTS: Cannot reopen party; another active party already exists') END;
        END;
      `);
    }
  },
  {
    version: 13,
    name: '013_patta_work_quantity_semantics',
    up: (db) => {
      const parties = db.prepare(`
        SELECT company_id, id, patta_count, ish_soni_per_patta,
          total_ish_soni, ish_soni, sizes_json, provenance
        FROM parties
        ORDER BY created_at ASC, id ASC
      `).all();
      const hasValidSizeDistribution = (sizesJson, pattaCount) => {
        if (sizesJson === null || sizesJson === undefined || String(sizesJson).trim() === '') return true;

        let sizes;
        try {
          sizes = JSON.parse(sizesJson);
        } catch (error) {
          return false;
        }
        if (sizes === null || typeof sizes !== 'object' || Array.isArray(sizes)) return false;
        if (Object.keys(sizes).length === 0) return true;

        let sizeCountTotal = 0;
        for (const value of Object.values(sizes)) {
          let sizeCount = value;
          if (typeof value === 'string') {
            const trimmedValue = value.trim();
            if (trimmedValue === '') {
              sizeCount = 0;
            } else {
              if (!/^\d+$/.test(trimmedValue)) return false;
              sizeCount = Number(trimmedValue);
            }
          }
          if (!Number.isSafeInteger(sizeCount) || sizeCount < 0) return false;
          sizeCountTotal += sizeCount;
          if (!Number.isSafeInteger(sizeCountTotal)) return false;
        }
        return sizeCountTotal === pattaCount;
      };
      const invalidParties = parties.filter((party) => {
        const hasStoredPattaCount = party.patta_count !== null
          && party.patta_count !== undefined
          && !(typeof party.patta_count === 'string' && party.patta_count.trim() === '');
        const pattaCount = Number(party.patta_count);
        if (!hasStoredPattaCount || !Number.isSafeInteger(pattaCount) || pattaCount < 0) return true;

        if (pattaCount === 0) {
          const zeroWorkFields = [
            party.ish_soni_per_patta,
            party.total_ish_soni,
            party.ish_soni
          ];
          const hasOnlyZeroWork = zeroWorkFields.every((value) =>
            value === null || value === undefined || value === 0
          );
          return !hasOnlyZeroWork || !hasValidSizeDistribution(party.sizes_json, 0);
        }

        const normalizedSource = party.provenance === 'LOCAL_COMMAND'
          && party.ish_soni_per_patta !== null
          && party.ish_soni_per_patta !== undefined;
        const perPatta = Number(normalizedSource
          ? party.ish_soni_per_patta
          : party.ish_soni_per_patta ?? party.total_ish_soni ?? party.ish_soni);
        const validQuantity = Number.isSafeInteger(perPatta)
          && perPatta > 0
          && (normalizedSource || perPatta % pattaCount === 0);
        return !validQuantity || !hasValidSizeDistribution(party.sizes_json, pattaCount);
      });

      if (invalidParties.length > 0) {
        const error = new Error(
          `[Migration 013] PATTA_WORK_QUANTITY_MIGRATION_BLOCKED: invalid party work quantity data for parties: ${invalidParties.map((party) => party.id).join(', ')}`
        );
        error.code = 'PATTA_WORK_QUANTITY_MIGRATION_BLOCKED';
        error.records = invalidParties;
        throw error;
      }

      const updateParty = db.prepare(`
        UPDATE parties
        SET ish_soni_per_patta = ?, total_ish_soni = ?, ish_soni = ?, cumulative_ish_soni = ?
        WHERE company_id = ? AND id = ?
      `);
      const partiesToConvert = parties.filter((party) => Number(party.patta_count) > 0);
      let cumulativeTotal = 0;
      for (const party of partiesToConvert) {
        const normalizedSource = party.provenance === 'LOCAL_COMMAND'
          && party.ish_soni_per_patta !== null
          && party.ish_soni_per_patta !== undefined;
        const sourceQuantity = Number(normalizedSource
          ? party.ish_soni_per_patta
          : party.ish_soni_per_patta ?? party.total_ish_soni ?? party.ish_soni);
        const partyTotal = normalizedSource
          ? sourceQuantity * Number(party.patta_count)
          : sourceQuantity;
        const perPatta = normalizedSource
          ? sourceQuantity
          : sourceQuantity / Number(party.patta_count);
        cumulativeTotal += partyTotal;
        updateParty.run(
          perPatta,
          partyTotal,
          partyTotal,
          cumulativeTotal,
          party.company_id,
          party.id
        );
      }
    }
  },
  {
    version: 14,
    name: '014_canonical_ids_global_patta_sequence_and_cleanup',
    up: (db) => {
      const columns = (table) => new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((row) => row.name));
      const partyColumns = columns('parties');
      if (!partyColumns.has('patta_start_number')) db.exec('ALTER TABLE parties ADD COLUMN patta_start_number INTEGER');
      if (!partyColumns.has('patta_end_number')) db.exec('ALTER TABLE parties ADD COLUMN patta_end_number INTEGER');
      db.exec(`
        CREATE TABLE IF NOT EXISTS model_id_aliases (
          company_id TEXT NOT NULL,
          legacy_model_id TEXT NOT NULL,
          canonical_model_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (company_id, legacy_model_id),
          UNIQUE (company_id, canonical_model_id)
        );
        CREATE TABLE IF NOT EXISTS party_id_aliases (
          company_id TEXT NOT NULL,
          legacy_party_id TEXT NOT NULL,
          canonical_party_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (company_id, legacy_party_id),
          UNIQUE (company_id, canonical_party_id)
        );
        CREATE TABLE IF NOT EXISTS company_patta_sequences (
          company_id TEXT PRIMARY KEY,
          next_patta_number INTEGER NOT NULL CHECK (next_patta_number > 0),
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS protected_party_patta_ranges (
          company_id TEXT NOT NULL,
          party_record_id TEXT NOT NULL,
          patta_start_number INTEGER NOT NULL,
          patta_end_number INTEGER NOT NULL,
          PRIMARY KEY (company_id, party_record_id),
          CHECK (patta_start_number > 0 AND patta_end_number >= patta_start_number)
        );
      `);

      db.pragma('defer_foreign_keys = ON');
      const now = new Date().toISOString();
      const protectedIds = new Set(db.prepare(`
        SELECT p.id FROM parties p
        JOIN legacy_party_collision_exceptions e
          ON e.company_id = p.company_id AND e.party_id = p.id
         AND e.party_number = p.party_number AND e.status = 'ACTIVE'
        WHERE p.status != 'CLOSED'
      `).all().map((row) => row.id));

      const companyIds = db.prepare('SELECT DISTINCT company_id FROM parties ORDER BY company_id').all().map((row) => row.company_id);
      const updateRange = db.prepare(`
        UPDATE parties SET patta_start_number = ?, patta_end_number = ?, cumulative_patta_count = ?
        WHERE company_id = ? AND id = ?
      `);
      const insertSequence = db.prepare(`
        INSERT INTO company_patta_sequences(company_id, next_patta_number, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(company_id) DO UPDATE SET next_patta_number = excluded.next_patta_number, updated_at = excluded.updated_at
      `);

      for (const companyId of companyIds) {
        const rows = db.prepare(`
          SELECT id, patta_count, status, is_archived, printed_at, created_at
          FROM parties WHERE company_id = ?
          ORDER BY COALESCE(printed_at, created_at), id
        `).all(companyId);
        let nextNumber = 1;
        for (const row of rows) {
          if (row.status === 'CLOSED' || Number(row.is_archived) === 1) continue;
          const count = Number(row.patta_count);
          if (!Number.isSafeInteger(count) || count < 0) {
            const error = new Error(`PATTA_SEQUENCE_MIGRATION_BLOCKED: invalid patta_count for party ${row.id}`);
            error.code = 'PATTA_SEQUENCE_MIGRATION_BLOCKED';
            throw error;
          }
          if (count === 0) continue;
          const start = nextNumber;
          const end = start + count - 1;
          if (!Number.isSafeInteger(end)) throw new Error('PATTA_SEQUENCE_MIGRATION_BLOCKED: sequence exceeds safe integer range');
          if (!protectedIds.has(row.id)) {
            updateRange.run(start, end, end, companyId, row.id);
          } else if (protectedIds.has(row.id)) {
            db.prepare(`
              INSERT INTO protected_party_patta_ranges(company_id, party_record_id, patta_start_number, patta_end_number)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(company_id, party_record_id) DO UPDATE SET
                patta_start_number = excluded.patta_start_number,
                patta_end_number = excluded.patta_end_number
            `).run(companyId, row.id, start, end);
          }
          nextNumber = end + 1;
        }
        insertSequence.run(companyId, nextNumber, now);
      }

      const modelRows = db.prepare('SELECT id, company_id FROM models ORDER BY company_id, id').all();
      const modelIdMap = new Map();
      for (const row of modelRows) {
        const nextId = createCanonicalEntityUuid('model', row.company_id, row.id);
        modelIdMap.set(`${row.company_id}\u0000${row.id}`, nextId);
        db.prepare(`INSERT INTO model_id_aliases(company_id, legacy_model_id, canonical_model_id, created_at) VALUES (?, ?, ?, ?)`)
          .run(row.company_id, row.id, nextId, now);
      }

      const partyRows = db.prepare(`
        SELECT id, company_id FROM parties
        WHERE status != 'CLOSED' AND is_archived = 0
        ORDER BY company_id, id
      `).all();
      const partyIdMap = new Map();
      for (const row of partyRows) {
        if (protectedIds.has(row.id)) continue;
        const nextId = createCanonicalEntityUuid('party', row.company_id, row.id);
        partyIdMap.set(`${row.company_id}\u0000${row.id}`, nextId);
        db.prepare(`INSERT INTO party_id_aliases(company_id, legacy_party_id, canonical_party_id, created_at) VALUES (?, ?, ?, ?)`)
          .run(row.company_id, row.id, nextId, now);
      }

      const updateCompanyScopedIds = (table, column, idMap) => {
        if (!columns(table).has(column)) return;
        const rows = db.prepare(`SELECT rowid, company_id, "${column}" AS value FROM "${table}"`).all();
        const update = db.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE rowid = ?`);
        for (const row of rows) {
          const nextId = idMap.get(`${row.company_id}\u0000${row.value}`);
          if (nextId) update.run(nextId, row.rowid);
        }
      };
      const updateModelIds = (table) => updateCompanyScopedIds(table, 'model_id', modelIdMap);
      for (const table of [
        'tickets', 'production_adjustments', 'patta_batch_settings', 'local_ticket_forms',
        'migration_quarantine_parties', 'migration_quarantine_tickets',
        'migration_reconciliation_candidates'
      ]) updateModelIds(table);

      for (const [key, newId] of modelIdMap) {
        const separator = key.indexOf('\u0000');
        const companyId = key.slice(0, separator);
        const oldId = key.slice(separator + 1);
        db.prepare('UPDATE parties SET model_id = ? WHERE company_id = ? AND model_id = ? AND id NOT IN (SELECT party_id FROM legacy_party_collision_exceptions WHERE company_id = ? AND status = \'ACTIVE\')')
          .run(newId, companyId, oldId, companyId);
        db.prepare('UPDATE models SET id = ? WHERE company_id = ? AND id = ?').run(newId, companyId, oldId);
      }

      const partyTriggers = db.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'parties'
      `).all();
      for (const trigger of partyTriggers) {
        if (trigger.name === 'trg_parties_identity_immutable_update'
          || trigger.name === 'trg_parties_identity_immutable'
          || trigger.name === 'trg_parties_exact_party_2_update') {
          db.exec(`DROP TRIGGER IF EXISTS "${trigger.name}"`);
        }
      }

      const updatePartyReference = (table, column) => {
        if (!columns(table).has(column)) return;
        const rows = db.prepare(`SELECT rowid, company_id, "${column}" AS value FROM "${table}"`).all();
        const update = db.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE rowid = ?`);
        for (const row of rows) {
          const nextId = partyIdMap.get(`${row.company_id}\u0000${row.value}`);
          if (nextId) update.run(nextId, row.rowid);
        }
      };
      updatePartyReference('tickets', 'party_record_id');
      updatePartyReference('migration_party_resolutions', 'party_id');
      updatePartyReference('migration_quarantine_parties', 'resolved_party_id');
      for (const [key, newId] of partyIdMap) {
        const separator = key.indexOf('\u0000');
        const companyId = key.slice(0, separator);
        const oldId = key.slice(separator + 1);
        db.prepare('UPDATE parties SET id = ? WHERE company_id = ? AND id = ?').run(newId, companyId, oldId);
      }

      const blockedPartyDeletion = db.prepare(`
        SELECT p.id,
          (SELECT COUNT(*) FROM tickets t WHERE t.company_id = p.company_id AND t.party_record_id = p.id) AS ticket_count
        FROM parties p WHERE p.status = 'CLOSED' OR p.is_archived = 1
      `).all().filter((row) => Number(row.ticket_count) > 0);
      if (blockedPartyDeletion.length) {
        const error = new Error(`CLOSED_PARTY_PURGE_BLOCKED: linked tickets exist for ${blockedPartyDeletion.map((row) => row.id).join(', ')}`);
        error.code = 'CLOSED_PARTY_PURGE_BLOCKED';
        error.records = blockedPartyDeletion;
        throw error;
      }
      db.prepare(`DELETE FROM parties WHERE status = 'CLOSED' OR is_archived = 1`).run();

      const blockedPeriodDeletion = db.prepare(`
        SELECT p.id,
          (SELECT COUNT(*) FROM tickets t WHERE t.company_id = p.company_id AND t.period_id = p.id) AS ticket_count,
          (SELECT COUNT(*) FROM period_archives a WHERE a.company_id = p.company_id AND a.period_id = p.id) AS archive_count,
          (SELECT COUNT(*) FROM worker_adjustments w WHERE w.company_id = p.company_id AND w.period_id = p.id) AS adjustment_count
        FROM periods p WHERE p.is_closed = 1 OR p.status = 'CLOSED'
      `).all().filter((row) => Number(row.ticket_count) + Number(row.archive_count) + Number(row.adjustment_count) > 0);
      if (blockedPeriodDeletion.length) {
        const error = new Error(`CLOSED_PERIOD_PURGE_BLOCKED: linked records exist for ${blockedPeriodDeletion.map((row) => row.id).join(', ')}`);
        error.code = 'CLOSED_PERIOD_PURGE_BLOCKED';
        error.records = blockedPeriodDeletion;
        throw error;
      }
      db.prepare(`DELETE FROM periods WHERE is_closed = 1 OR status = 'CLOSED'`).run();

      if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_outbox_comp_status'`).get()) {
        db.exec('REINDEX idx_outbox_comp_status');
      }

      db.exec(`
        CREATE TRIGGER trg_parties_identity_immutable_update
        BEFORE UPDATE ON parties FOR EACH ROW
        WHEN NEW.id IS NOT OLD.id OR NEW.company_id IS NOT OLD.company_id
        BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_PARTY_IDENTITY: parties.id and parties.company_id cannot be modified'); END;

        CREATE TRIGGER trg_parties_exact_party_2_update
        BEFORE UPDATE OF id, company_id, status, party_number ON parties
        FOR EACH ROW
        WHEN NEW.status != 'CLOSED' OR NEW.id IS NOT OLD.id OR NEW.company_id IS NOT OLD.company_id
        BEGIN
          SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.company_id IS NOT OLD.company_id
            THEN RAISE(ABORT, 'IMMUTABLE_PARTY_IDENTITY: parties.id and parties.company_id cannot be modified') END;
          SELECT CASE WHEN NEW.status != 'CLOSED' AND EXISTS (
            SELECT 1 FROM parties p WHERE p.company_id = NEW.company_id
              AND p.party_number = NEW.party_number AND p.status != 'CLOSED' AND p.id != NEW.id
          ) AND NOT EXISTS (
            SELECT 1 FROM legacy_party_collision_exceptions e
            WHERE e.company_id = NEW.company_id AND e.party_id = NEW.id
              AND e.party_number = NEW.party_number AND e.status = 'ACTIVE'
              AND e.collision_group_id IN (
                SELECT e2.collision_group_id FROM legacy_party_collision_exceptions e2
                WHERE e2.company_id = NEW.company_id AND e2.party_number = NEW.party_number
                  AND e2.status = 'ACTIVE'
                GROUP BY e2.collision_group_id HAVING COUNT(*) = 2
              )
          ) THEN RAISE(ABORT, 'ACTIVE_PARTY_EXISTS: Cannot reopen party; another active party already exists') END;
        END;
      `);
    }
  },
  {
    version: 15,
    name: '015_party_id_aliases_for_inflight_sync',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS party_id_aliases (
          company_id TEXT NOT NULL,
          legacy_party_id TEXT NOT NULL,
          canonical_party_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (company_id, legacy_party_id),
          UNIQUE (company_id, canonical_party_id)
        );
      `);
    }
  },
  {
    version: 16,
    name: '016_refresh_model_snapshots_after_sync_validation_fix',
    up: (db) => {
      const modelsToRefresh = db.prepare(`
        SELECT DISTINCT m.*
        FROM models m
        JOIN model_id_aliases a ON a.company_id = m.company_id AND a.canonical_model_id = m.id
        JOIN local_outbox failed ON failed.company_id = a.company_id
          AND failed.entity_id = a.legacy_model_id
          AND failed.command_type = 'UpsertModel'
          AND failed.entity_type = 'model'
          AND failed.status = 'DEAD_LETTER'
        WHERE NOT EXISTS (
          SELECT 1 FROM local_outbox pending
          WHERE pending.company_id = m.company_id AND pending.entity_id = m.id
            AND pending.command_type = 'UpsertModel' AND pending.status IN ('PENDING', 'SENDING')
        )
        ORDER BY m.company_id, m.id
      `).all();
      const insertRefresh = db.prepare(`
        INSERT INTO local_outbox (
          operation_id, company_id, command_type, entity_type, entity_id, base_revision,
          payload_json, depends_on_operation_id, causal_sequence, status, retry_count,
          created_at, updated_at, attempt_count, payload_hash
        ) VALUES (?, ?, 'UpsertModel', 'model', ?, ?, ?, NULL, 0, 'PENDING', 0, ?, ?, 0, ?)
      `);
      for (const model of modelsToRefresh) {
        let operations = [];
        let pattaOpsOrder = [];
        try { operations = JSON.parse(model.operations_json || '[]'); } catch {}
        try { pattaOpsOrder = JSON.parse(model.patta_ops_order_json || '[]'); } catch {}
        const operationId = crypto.randomUUID();
        const payloadJson = canonicalStringify({
          commandId: crypto.randomUUID(), operationId, companyId: model.company_id, modelId: model.id,
          name: model.name,
          ...(model.hisob_sheet_name ? { hisobSheetName: model.hisob_sheet_name } : {}),
          ...(model.title ? { title: model.title } : {}),
          party: model.party || '',
          ...(model.color ? { color: model.color } : {}),
          ...(model.size ? { size: model.size } : {}),
          operations,
          pattaOpsOrder
        });
        const now = new Date().toISOString();
        insertRefresh.run(operationId, model.company_id, model.id, Number(model.server_revision || 0),
          payloadJson, now, now, computePayloadHash(payloadJson));
      }
    }
  }
];


/**
 * Calculates a deterministic checksum for a migration definition.
 *
 * @param {object} migration
 * @returns {string} SHA-256 hex digest
 */
function getMigrationChecksum(migration) {
  const content = `${migration.version}:${migration.name}`;
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

module.exports = {
  MIGRATIONS,
  getMigrationChecksum
};
