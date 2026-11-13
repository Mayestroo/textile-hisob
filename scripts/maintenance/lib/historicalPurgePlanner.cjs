'use strict';

const crypto = require('node:crypto');

const TARGET_TENANT_ID = 'comp_novda';
const CUTOFF_DATE = '2026-10-08';
const CUTOFF_UTC = '2026-10-07T19:00:00.000Z';
const BUSINESS_TIMEZONE = 'Asia/Tashkent';
const REQUIRED_EXECUTE_SCHEMA_VERSION = 30;
const SENTABR_PERIOD_ID = 'period_1788768267439';
const OKTABR_PERIOD_ID = 'period_1791365073978';
const NOYABR_PERIOD_ID = 'period_1793856846035';

const PRESERVED_COMPANY_TABLES = Object.freeze([
  'activation_companies',
  'activation_company_admins',
  'activation_policy_events',
  'activation_requests',
  'baseline_import_runs',
  'company_batch_settings',
  'company_patta_sequences',
  'migration_baseline_decisions',
  'migration_baseline_exclusions',
  'migration_party_resolutions',
  'migration_reconciliation_candidates',
  'migration_reconciliation_resolutions',
  'model_id_aliases',
  'models',
  'operator_login_attempts',
  'operator_sessions',
  'party_sequence_leases',
  'patta_batch_settings',
  'server_devices',
  'server_operators',
  'worker_binding_limits',
  'worker_credentials',
  'worker_onboarding_contacts',
  'worker_telegram_binding_events',
  'worker_telegram_bindings',
  'workers'
]);

const PRESERVED_GLOBAL_TABLES = Object.freeze([
  'activation_events',
  'activation_request_limits',
  'schema_migrations'
]);

const HISTORICAL_SENTABR_COMMAND_TYPES = Object.freeze([
  'SubmitTicket',
  'UpdateTicket',
  'DeleteTicket',
  'CreatePeriod',
  'UpdatePeriod',
  'ClosePeriod',
  'CreateParty',
  'UpdateParty',
  'CloseParty',
  'CompletePattaBatch',
  'CompletePartySeries',
  'ArchivePartyHistory',
  'UpdateBatchSettings'
]);

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function computeManifestSha256(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('INVALID_MANIFEST_OBJECT');
  }
  const copy = { ...manifest };
  delete copy.generatedAt;
  delete copy.manifestSha256;
  return sha256Hex(stableStringify(copy));
}

function assertDisposablePostgresTarget(pgUrl, options = {}) {
  if (!pgUrl || typeof pgUrl !== 'string') {
    throw new Error('DISPOSABLE_TARGET_REQUIRED: explicit disposable PostgreSQL URL is required');
  }
  const env = options.env || process.env;
  if (env.DATABASE_URL && pgUrl === env.DATABASE_URL && !options.allowMatchingEnvUrl) {
    throw new Error('PRODUCTION_TARGET_REJECTED: DATABASE_URL is forbidden for purge operations');
  }
  if (/prod/i.test(pgUrl) && !options.allowProdSubstringInTestName) {
    // Reject obvious production host/db names unless explicitly local hisob_test_*
    const prelim = new URL(pgUrl);
    if (!/^hisob_test_[a-z0-9_]+$/.test(decodeURIComponent(prelim.pathname.slice(1)))) {
      throw new Error('PRODUCTION_TARGET_REJECTED: URL appears to reference non-disposable target');
    }
  }

  let parsed;
  try {
    parsed = new URL(pgUrl);
  } catch {
    throw new Error('DISPOSABLE_TARGET_INVALID: invalid PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`DISPOSABLE_TARGET_INVALID: unsupported protocol "${parsed.protocol}"`);
  }
  const host = parsed.hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    throw new Error(`PRODUCTION_TARGET_REJECTED: non-loopback host "${host}" is forbidden`);
  }
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!/^hisob_test_[a-z0-9_]+$/.test(dbName)) {
    throw new Error(`PRODUCTION_TARGET_REJECTED: database "${dbName}" does not match disposable pattern /^hisob_test_[a-z0-9_]+$/`);
  }
  if (options.requireExecuteConfirmation) {
    const confirmed = options.confirmDisposableTarget === true || env.NOVDA_DISPOSABLE_PG === '1';
    if (!confirmed) {
      throw new Error('DISPOSABLE_CONFIRMATION_REQUIRED: pass --confirm-disposable-target or NOVDA_DISPOSABLE_PG=1');
    }
  }
  return {
    host,
    port: parsed.port ? Number(parsed.port) : 5432,
    database: dbName
  };
}

async function verifyDisposableServerIdentity(client) {
  const res = await client.query(`
    SELECT
      current_database() AS db_name,
      inet_server_addr()::text AS server_addr,
      current_setting('server_version_num')::int AS server_version_num
  `);
  const row = res.rows[0] || {};
  if (!/^hisob_test_[a-z0-9_]+$/.test(String(row.db_name || ''))) {
    throw new Error(`PRODUCTION_TARGET_REJECTED: server current_database()="${row.db_name}" is not disposable`);
  }
  const addr = String(row.server_addr || '');
  const isLocalOrDockerBridge = !addr
    || addr.startsWith('127.')
    || addr === '::1'
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(addr)
    || addr.startsWith('10.')
    || addr.startsWith('192.168.');
  if (!isLocalOrDockerBridge) {
    throw new Error(`PRODUCTION_TARGET_REJECTED: non-local server_addr="${addr}"`);
  }
  if (Number(row.server_version_num) < 160000) {
    throw new Error(`UNSUPPORTED_POSTGRES_VERSION: expected PG16+, got ${row.server_version_num}`);
  }
  return row;
}

async function collectTableInventory(client, companyId) {
  const tablesRes = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  const companyColsRes = await client.query(`
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'company_id'
  `);
  const companyScopedTables = new Set(companyColsRes.rows.map((r) => r.table_name));
  const counts = {};
  for (const { table_name: tableName } of tablesRes.rows) {
    if (companyScopedTables.has(tableName)) {
      const r = await client.query(
        `SELECT COUNT(*)::int AS total_rows,
                COUNT(*) FILTER (WHERE company_id = $1)::int AS tenant_rows
         FROM "${tableName}"`,
        [companyId]
      );
      counts[tableName] = {
        total: r.rows[0].total_rows,
        tenant: r.rows[0].tenant_rows,
        companyScoped: true
      };
    } else {
      const r = await client.query(`SELECT COUNT(*)::int AS total_rows FROM "${tableName}"`);
      counts[tableName] = {
        total: r.rows[0].total_rows,
        tenant: null,
        companyScoped: false
      };
    }
  }
  return counts;
}

async function collectForeignKeysAndTriggers(client) {
  const fkRes = await client.query(`
    SELECT
      tc.constraint_name,
      tc.table_name,
      kcu.column_name,
      ccu.table_name AS referenced_table,
      ccu.column_name AS referenced_column,
      rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
    ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position
  `);
  const trgRes = await client.query(`
    SELECT event_object_table AS table_name, trigger_name, action_timing, event_manipulation
    FROM information_schema.triggers
    WHERE trigger_schema = 'public'
    ORDER BY event_object_table, trigger_name, event_manipulation
  `);
  return { foreignKeys: fkRes.rows, triggers: trgRes.rows };
}

async function buildHistoricalPurgeManifest(client, options = {}) {
  const companyId = options.tenantId || TARGET_TENANT_ID;
  const cutoffDate = options.cutoffDate || CUTOFF_DATE;
  const cutoffUtc = options.cutoffUtc || CUTOFF_UTC;
  if (companyId !== TARGET_TENANT_ID) {
    throw new Error(`INVALID_TENANT_ID: expected ${TARGET_TENANT_ID}, got ${companyId}`);
  }
  if (cutoffDate !== CUTOFF_DATE || cutoffUtc !== CUTOFF_UTC) {
    throw new Error(`INVALID_CUTOFF: expected ${CUTOFF_DATE}/${CUTOFF_UTC}`);
  }

  const serverIdentity = await verifyDisposableServerIdentity(client);
  const migRes = await client.query(`SELECT version, name FROM schema_migrations ORDER BY version ASC`);
  const schemaVersion = Number(migRes.rows[migRes.rows.length - 1]?.version || 0);
  const beforeCounts = await collectTableInventory(client, companyId);
  const schemaMeta = await collectForeignKeysAndTriggers(client);

  // 1. Periods + archives
  const periodsRes = await client.query(`
    SELECT p.id, p.name, p.start_date::text AS start_date, p.end_date::text AS end_date,
           p.is_closed, p.status, p.closed_at,
           pa.sha256 AS archive_sha256, pa.archived_at,
           (SELECT COUNT(*)::int FROM tickets t
            WHERE t.company_id = p.company_id AND t.period_id = p.id
              AND (t.submitted_at AT TIME ZONE '${BUSINESS_TIMEZONE}')::date < $2::date) AS pre_cutoff_tickets,
           (SELECT COUNT(*)::int FROM tickets t
            WHERE t.company_id = p.company_id AND t.period_id = p.id
              AND (t.submitted_at AT TIME ZONE '${BUSINESS_TIMEZONE}')::date >= $2::date) AS post_cutoff_tickets,
           (SELECT COUNT(*)::int FROM worker_adjustments wa
            WHERE wa.company_id = p.company_id AND wa.period_id = p.id) AS worker_adjustments_count,
           COALESCE((SELECT SUM(wa.amount)::numeric::text FROM worker_adjustments wa
            WHERE wa.company_id = p.company_id AND wa.period_id = p.id), '0') AS worker_adjustments_sum
    FROM periods p
    LEFT JOIN period_archives pa ON pa.company_id = p.company_id AND pa.period_id = p.id
    WHERE p.company_id = $1
    ORDER BY p.start_date ASC, p.id ASC
  `, [companyId, cutoffDate]);

  const spanningPeriodIds = new Set();
  const cleanPreCutoffPeriodIds = new Set();
  const preservedPeriodIds = new Set();
  const periodClassifications = [];

  for (const row of periodsRes.rows) {
    const startBefore = row.start_date < cutoffDate;
    const endBefore = Boolean(row.end_date) && row.end_date < cutoffDate;
    const hasPostWork = Number(row.post_cutoff_tickets) > 0;
    const isSpanning = startBefore && !endBefore;

    if (isSpanning) {
      spanningPeriodIds.add(row.id);
      periodClassifications.push({
        id: row.id,
        name: row.name,
        startDate: row.start_date,
        endDate: row.end_date,
        isClosed: Boolean(row.is_closed),
        archiveSha256: row.archive_sha256 || null,
        preCutoffTickets: Number(row.pre_cutoff_tickets),
        postCutoffTickets: Number(row.post_cutoff_tickets),
        classification: 'BLOCKED',
        reason: 'SPANNING_PERIOD_AND_FROZEN_ARCHIVE_CANNOT_BE_SAFELY_SEPARATED'
      });
    } else if (endBefore && !hasPostWork) {
      cleanPreCutoffPeriodIds.add(row.id);
      periodClassifications.push({
        id: row.id,
        name: row.name,
        startDate: row.start_date,
        endDate: row.end_date,
        isClosed: Boolean(row.is_closed),
        archiveSha256: row.archive_sha256 || null,
        preCutoffTickets: Number(row.pre_cutoff_tickets),
        postCutoffTickets: Number(row.post_cutoff_tickets),
        workerAdjustmentsCount: Number(row.worker_adjustments_count),
        workerAdjustmentsSum: row.worker_adjustments_sum,
        classification: 'BLOCKED',
        rehearsalSentabrScopeClassification: 'DELETE',
        reason: 'PRE_CUTOFF_PERIOD_PENDING_CARRY_FORWARD_FINANCIAL_SIGNOFF'
      });
    } else {
      preservedPeriodIds.add(row.id);
      periodClassifications.push({
        id: row.id,
        name: row.name,
        startDate: row.start_date,
        endDate: row.end_date,
        isClosed: Boolean(row.is_closed),
        archiveSha256: row.archive_sha256 || null,
        preCutoffTickets: Number(row.pre_cutoff_tickets),
        postCutoffTickets: Number(row.post_cutoff_tickets),
        classification: 'PRESERVE',
        reason: 'POST_CUTOFF_PERIOD'
      });
    }
  }

  // 2. Tickets classification
  const ticketsRes = await client.query(`
    SELECT id, period_id, party_record_id, party_number, patta_number, status, qty::numeric::text AS qty,
           (submitted_at AT TIME ZONE '${BUSINESS_TIMEZONE}')::date::text AS business_date,
           submitted_at, created_at,
           (submitted_at AT TIME ZONE '${BUSINESS_TIMEZONE}')::date < $2::date AS is_pre_cutoff_submitted,
           (created_at AT TIME ZONE '${BUSINESS_TIMEZONE}')::date >= $2::date AS is_post_cutoff_created
    FROM tickets
    WHERE company_id = $1
    ORDER BY submitted_at ASC, id ASC
  `, [companyId, cutoffDate]);

  const deletableTicketIds = [];
  const blockedTicketIds = [];
  const preserveTicketIds = [];
  const dateAnomalyTicketIds = [];
  const oct8Tickets = [];
  const blockedTicketParties = new Set();
  const postTicketParties = new Set();

  for (const t of ticketsRes.rows) {
    if (t.is_pre_cutoff_submitted && t.is_post_cutoff_created) {
      dateAnomalyTicketIds.push({
        id: t.id,
        periodId: t.period_id,
        partyRecordId: t.party_record_id,
        status: t.status,
        qty: t.qty,
        businessDate: t.business_date,
        submittedAt: t.submitted_at instanceof Date ? t.submitted_at.toISOString() : String(t.submitted_at),
        createdAt: t.created_at instanceof Date ? t.created_at.toISOString() : String(t.created_at)
      });
    }
    if (!t.is_pre_cutoff_submitted) {
      preserveTicketIds.push(t.id);
      if (t.party_record_id) postTicketParties.add(t.party_record_id);
      if (t.business_date === cutoffDate) {
        oct8Tickets.push({
          id: t.id,
          status: t.status,
          qty: Number(t.qty),
          partyNumber: t.party_number,
          partyRecordId: t.party_record_id,
          pattaNumber: t.patta_number,
          periodId: t.period_id,
          submittedAtUtc: t.submitted_at instanceof Date ? t.submitted_at.toISOString() : String(t.submitted_at)
        });
      }
      continue;
    }
    if (t.period_id && spanningPeriodIds.has(t.period_id)) {
      blockedTicketIds.push(t.id);
      if (t.party_record_id) blockedTicketParties.add(t.party_record_id);
      continue;
    }
    deletableTicketIds.push(t.id);
  }

  const entriesCountRes = await client.query(`
    SELECT
      COUNT(*) FILTER (WHERE ticket_id = ANY($2::varchar[]))::int AS deletable_entries,
      COUNT(*) FILTER (WHERE ticket_id = ANY($3::varchar[]))::int AS blocked_entries,
      COUNT(*) FILTER (WHERE ticket_id = ANY($4::varchar[]))::int AS preserved_entries,
      COUNT(*) FILTER (WHERE ticket_id = ANY($5::varchar[]))::int AS oct8_entries,
      COALESCE(SUM(qty) FILTER (WHERE ticket_id = ANY($5::varchar[])), 0)::numeric::text AS oct8_entry_qty
    FROM ticket_entries
    WHERE company_id = $1
  `, [
    companyId,
    deletableTicketIds,
    blockedTicketIds,
    preserveTicketIds,
    oct8Tickets.map((t) => t.id)
  ]);
  const entryCounts = entriesCountRes.rows[0];

  // 3. Parties + collision exceptions + protected ranges + aliases classification
  const collisionRes = await client.query(`
    SELECT exception_id, party_id, collision_group_id
    FROM legacy_party_collision_exceptions
    WHERE company_id = $1
  `, [companyId]);
  const peersByParty = new Map();
  for (const row of collisionRes.rows) {
    const groupMembers = collisionRes.rows
      .filter((r) => r.collision_group_id === row.collision_group_id)
      .map((r) => r.party_id);
    peersByParty.set(row.party_id, groupMembers);
  }

  const partiesRes = await client.query(`
    SELECT id, party_number, status, month_closed_period_id,
           printed_at, closed_at, ended_at, created_at,
           ((COALESCE(ended_at, closed_at, printed_at, created_at) AT TIME ZONE '${BUSINESS_TIMEZONE}')::date < $2::date) AS pre_cutoff_closed_time
    FROM parties
    WHERE company_id = $1
    ORDER BY created_at ASC, id ASC
  `, [companyId, cutoffDate]);

  const initialPartyClass = new Map();
  for (const p of partiesRes.rows) {
    if (postTicketParties.has(p.id) || p.status !== 'CLOSED' || !p.pre_cutoff_closed_time
      || (p.month_closed_period_id && preservedPeriodIds.has(p.month_closed_period_id))) {
      initialPartyClass.set(p.id, 'PRESERVE');
    } else if (blockedTicketParties.has(p.id) || (p.month_closed_period_id && spanningPeriodIds.has(p.month_closed_period_id))) {
      initialPartyClass.set(p.id, 'BLOCKED');
    } else {
      initialPartyClass.set(p.id, 'DELETE');
    }
  }
  // Collision group integrity: preserve/block entire pair together
  for (const [partyId, members] of peersByParty.entries()) {
    const cls = initialPartyClass.get(partyId);
    if (cls === 'PRESERVE' || cls === 'BLOCKED') {
      for (const peer of members) {
        if (initialPartyClass.get(peer) !== 'PRESERVE') {
          initialPartyClass.set(peer, cls);
        }
      }
    }
  }

  const deletablePartyIds = [];
  const blockedPartyIds = [];
  const preservedPartyIds = [];
  for (const [id, cls] of initialPartyClass.entries()) {
    if (cls === 'DELETE') deletablePartyIds.push(id);
    else if (cls === 'BLOCKED') blockedPartyIds.push(id);
    else preservedPartyIds.push(id);
  }

  const partyAliasRes = await client.query(`
    SELECT legacy_party_id, canonical_party_id
    FROM party_id_aliases
    WHERE company_id = $1
  `, [companyId]);
  const deletablePartySet = new Set(deletablePartyIds);
  const deletablePartyAliases = partyAliasRes.rows.filter((r) => deletablePartySet.has(r.canonical_party_id));
  const preservedPartyAliases = partyAliasRes.rows.filter((r) => !deletablePartySet.has(r.canonical_party_id));

  const deletableCollisionExceptions = collisionRes.rows.filter((r) => deletablePartySet.has(r.party_id));
  const protectedRangesRes = await client.query(`SELECT party_record_id FROM protected_party_patta_ranges WHERE company_id = $1`, [companyId]);
  const deletableProtectedRanges = protectedRangesRes.rows.filter((r) => deletablePartySet.has(r.party_record_id));

  // 4. Production adjustments & Worker adjustments
  const prodAdjRes = await client.query(`
    SELECT adjustment_id, attribution_status, status, created_at,
           (created_at < $2::timestamptz) AS created_pre_cutoff
    FROM production_adjustments
    WHERE company_id = $1
    ORDER BY created_at ASC, adjustment_id ASC
  `, [companyId, cutoffUtc]);
  const prodAdjPreCutoff = prodAdjRes.rows.filter((r) => r.created_pre_cutoff).map((r) => r.adjustment_id);
  const prodAdjPostCutoff = prodAdjRes.rows.filter((r) => !r.created_pre_cutoff).map((r) => r.adjustment_id);
  const prodAdjUnresolved = prodAdjRes.rows.filter((r) => r.attribution_status === 'UNRESOLVED').map((r) => r.adjustment_id);

  const workerAdjRes = await client.query(`
    SELECT id, worker_id, period_id, type, amount::numeric::text AS amount, provenance, status, created_at,
           (created_at < $2::timestamptz) AS created_pre_cutoff
    FROM worker_adjustments
    WHERE company_id = $1
    ORDER BY created_at ASC, id ASC
  `, [companyId, cutoffUtc]);
  const sentabrWorkerAdjs = workerAdjRes.rows.filter((r) => cleanPreCutoffPeriodIds.has(r.period_id));
  const oktabrWorkerAdjs = workerAdjRes.rows.filter((r) => spanningPeriodIds.has(r.period_id));
  const otherWorkerAdjs = workerAdjRes.rows.filter((r) => !cleanPreCutoffPeriodIds.has(r.period_id) && !spanningPeriodIds.has(r.period_id));

  const workerMasterTotalsRes = await client.query(`
    SELECT
      COUNT(*)::int AS worker_count,
      COALESCE(SUM(staj), 0)::numeric::text AS staj_sum,
      COALESCE(SUM(legacy_avans), 0)::numeric::text AS legacy_avans_sum,
      COALESCE(SUM(legacy_jarima), 0)::numeric::text AS legacy_jarima_sum
    FROM workers
    WHERE company_id = $1
  `, [companyId]);
  const workerMasterTotals = workerMasterTotalsRes.rows[0];

  // 5. Operations dedup & Change log (cleanly partition Sentabr/pre-cutoff operations vs blocked/preserved)
  const opsRes = await client.query(`
    SELECT operation_id, command_type, entity_type, entity_id, accepted_at,
           accepted_at < $2::timestamptz AS pre_accepted
    FROM operations_dedup
    WHERE company_id = $1
    ORDER BY accepted_at ASC, operation_id ASC
  `, [companyId, cutoffUtc]);
  const deletableTicketSet = new Set(deletableTicketIds);
  const deletableOps = [];
  const blockedOrPreservedOps = [];
  for (const op of opsRes.rows) {
    const isDeletedTicketOp = op.entity_type === 'ticket' && deletableTicketSet.has(op.entity_id);
    const isDeletedPartyOp = (op.entity_type === 'party' || op.entity_type === 'party_history')
      && deletablePartySet.has(op.entity_id);
    const isCleanPeriodOp = op.entity_type === 'period' && cleanPreCutoffPeriodIds.has(op.entity_id);
    const isCleanPreCutoffTransientOp = op.pre_accepted && [
      'CompletePattaBatch',
      'CompletePartySeries',
      'ArchivePartyHistory',
      'UpdateBatchSettings',
      'DeleteTicket'
    ].includes(op.command_type) && !blockedTicketIds.includes(op.entity_id);
    if (isDeletedTicketOp || isDeletedPartyOp || isCleanPeriodOp || isCleanPreCutoffTransientOp) {
      deletableOps.push(op);
    } else {
      blockedOrPreservedOps.push(op);
    }
  }
  const deletableOpIds = deletableOps.map((o) => o.operation_id);

  const changeLogCountRes = await client.query(`
    SELECT
      COALESCE(MAX(change_id), 0)::text AS max_change_id,
      COUNT(*) FILTER (WHERE operation_id = ANY($2::varchar[]))::int AS matching_deletable_ops,
      COUNT(*) FILTER (WHERE committed_at < $3::timestamptz AND NOT (operation_id = ANY($2::varchar[])))::int AS retained_pre_cutoff_changes
    FROM change_log
    WHERE company_id = $1
  `, [companyId, deletableOpIds, cutoffUtc]);
  const changeLogStats = changeLogCountRes.rows[0];

  // 6. Baseline decisions check
  const baselineRes = await client.query(`
    SELECT baseline_decision_id, decision, source_snapshot_hash,
           scope_json->'evidence'->'baselineTicketIds' AS baseline_ticket_ids
    FROM migration_baseline_decisions
    WHERE company_id = $1
  `, [companyId]);
  const baselineTicketIds = Array.isArray(baselineRes.rows[0]?.baseline_ticket_ids)
    ? baselineRes.rows[0].baseline_ticket_ids
    : [];
  const baselineTicketsInDeletable = baselineTicketIds.filter((id) => deletableTicketSet.has(id));

  // 7. Workers opening balances & Sentabr carry-forward liabilities summary
  const sentabrSum = sentabrWorkerAdjs.reduce((acc, row) => acc + Number(row.amount), 0);

  const blockers = [];
  if (schemaVersion < REQUIRED_EXECUTE_SCHEMA_VERSION) {
    blockers.push({
      code: 'SCHEMA_MIGRATION_V30_REQUIRED',
      severity: 'BLOCKER',
      detail: `Database schema version is v${schemaVersion}; v${REQUIRED_EXECUTE_SCHEMA_VERSION} purge-fence migration is required before purge execution`
    });
  }
  if (spanningPeriodIds.size > 0) {
    blockers.push({
      code: 'SPANNING_PERIOD_AND_FROZEN_ARCHIVE',
      severity: 'BLOCKER',
      affectedIds: [...spanningPeriodIds],
      dateAnomalyTickets: dateAnomalyTicketIds,
      blockedPartyIds,
      detail: 'period_1791365073978 (2026-Oktabr oyligi, 2026-10-05..2026-11-04) spans the 2026-10-08 cutoff and freezes VOIDED ticket 06733af8-9231-4cbc-b888-d6189f7a03e4 + party 53fcade9-1e06-41f1-ac7a-dc5febd5f483 inside an immutable period_archives JSON payload'
    });
  }
  if (prodAdjUnresolved.length > 0) {
    blockers.push({
      code: 'UNRESOLVED_PRODUCTION_ADJUSTMENTS_NO_ACCOUNTING_DATE',
      severity: 'BLOCKER',
      count: prodAdjUnresolved.length,
      createdPreCutoffCount: prodAdjPreCutoff.length,
      createdPostCutoffCount: prodAdjPostCutoff.length,
      detail: `${prodAdjUnresolved.length} production_adjustments rows have attribution_status='UNRESOLVED' and no accounting date; deleting or zeroing them would silently alter retained Oktabr/Noyabr payroll`
    });
  }
  blockers.push({
    code: 'UNAPPROVED_CARRY_FORWARD_AND_OPENING_BALANCES',
    severity: 'BLOCKER',
    sentabrPeriodId: SENTABR_PERIOD_ID,
    sentabrWorkerAdjustmentsCount: sentabrWorkerAdjs.length,
    sentabrWorkerAdjustmentsSum: sentabrSum,
    masterOpeningBalances: workerMasterTotals,
    detail: 'Sentabr period adjustments (63 rows, sum=2453011) and master worker balances (staj=5740000, legacy_avans=2020000, legacy_jarima=550000) require explicit financial signoff before full purge execution'
  });

  const manifestCore = {
    status: blockers.length ? 'BLOCKED' : 'READY',
    tenantId: companyId,
    businessTimezone: BUSINESS_TIMEZONE,
    exclusiveCutoff: {
      sqlDate: cutoffDate,
      utcInstant: cutoffUtc,
      operator: '<'
    },
    schemaVersion,
    requiredExecuteSchemaVersion: REQUIRED_EXECUTE_SCHEMA_VERSION,
    serverIdentity: {
      database: serverIdentity.db_name,
      serverVersionNum: Number(serverIdentity.server_version_num),
      migrationCount: migRes.rows.length
    },
    october8Protection: {
      protectedTicketCount: oct8Tickets.length,
      protectedTicketQtySum: oct8Tickets.reduce((s, t) => s + t.qty, 0),
      protectedEntryCount: Number(entryCounts.oct8_entries),
      protectedEntryQtySum: Number(entryCounts.oct8_entry_qty),
      protectedTicketIds: oct8Tickets.map((t) => t.id),
      minSubmittedAtUtc: oct8Tickets.length ? oct8Tickets[0].submittedAtUtc : null,
      maxSubmittedAtUtc: oct8Tickets.length ? oct8Tickets[oct8Tickets.length - 1].submittedAtUtc : null,
      protectedPostCutoffTicketsTotal: preserveTicketIds.length,
      protectedPostCutoffEntriesTotal: Number(entryCounts.preserved_entries),
      protectedPartiesCount: preservedPartyIds.length
    },
    classifications: {
      periods: periodClassifications,
      tickets: {
        DELETE_SENTABR_CLEAN: deletableTicketIds,
        BLOCKED_SPANNING_ARCHIVE: blockedTicketIds,
        PRESERVE_POST_CUTOFF: preserveTicketIds.length,
        baselineTicketsInDeletable
      },
      ticketEntries: {
        DELETE_SENTABR_CLEAN_COUNT: Number(entryCounts.deletable_entries),
        BLOCKED_SPANNING_ARCHIVE_COUNT: Number(entryCounts.blocked_entries),
        PRESERVE_POST_CUTOFF_COUNT: Number(entryCounts.preserved_entries)
      },
      parties: {
        DELETE_PRE_CUTOFF_CLOSED: deletablePartyIds,
        DELETE_COLLISION_EXCEPTIONS: deletableCollisionExceptions.map((r) => r.exception_id),
        DELETE_PROTECTED_RANGES: deletableProtectedRanges.map((r) => r.party_record_id),
        DELETE_PARTY_ALIASES_COUNT: deletablePartyAliases.length,
        BLOCKED: blockedPartyIds,
        PRESERVE_COUNT: preservedPartyIds.length,
        PRESERVED_PARTY_ALIASES_COUNT: preservedPartyAliases.length
      },
      productionAdjustments: {
        BLOCKED_ALL_UNRESOLVED: prodAdjRes.rows.length,
        createdPreCutoffCount: prodAdjPreCutoff.length,
        createdPostCutoffCount: prodAdjPostCutoff.length,
        sampleIdsPreCutoff: prodAdjPreCutoff.slice(0, 10)
      },
      workerAdjustments: {
        BLOCKED_PENDING_FINANCIAL_SIGNOFF_REHEARSAL_DELETE: sentabrWorkerAdjs.map((r) => r.id),
        sentabrCount: sentabrWorkerAdjs.length,
        sentabrSum,
        PRESERVE_OKTABR_IDS: oktabrWorkerAdjs.map((r) => r.id),
        otherCount: otherWorkerAdjs.length
      },
      operationsAndChangeLog: {
        REHEARSAL_DELETE_AND_TOMBSTONE_OPERATION_IDS: deletableOpIds,
        deletableOperationsCount: deletableOpIds.length,
        retainedOperationsCount: blockedOrPreservedOps.length,
        deletableChangeLogCount: Number(changeLogStats.matching_deletable_ops),
        retainedPreCutoffChangesCount: Number(changeLogStats.retained_pre_cutoff_changes),
        currentMaxChangeId: changeLogStats.max_change_id,
        preservedBaselineDecisionIds: baselineRes.rows.map((r) => r.baseline_decision_id)
      },
      tablePolicies: {
        preservedCompanyTables: PRESERVED_COMPANY_TABLES,
        preservedGlobalTables: PRESERVED_GLOBAL_TABLES,
        rebuildTargets: ['sqlite_client_snapshots', 'local_outbox_quarantine', 'worker_projections', 'change_feed_watermark']
      }
    },
    rowCounts: {
      before: beforeCounts,
      rehearsalSentabrProposedDelete: {
        periods: cleanPreCutoffPeriodIds.size,
        period_archives: cleanPreCutoffPeriodIds.size,
        worker_adjustments: sentabrWorkerAdjs.length,
        tickets: deletableTicketIds.length,
        ticket_entries: Number(entryCounts.deletable_entries),
        parties: deletablePartyIds.length,
        legacy_party_collision_exceptions: deletableCollisionExceptions.length,
        protected_party_patta_ranges: deletableProtectedRanges.length,
        party_id_aliases: deletablePartyAliases.length,
        operations_dedup: deletableOpIds.length,
        change_log: Number(changeLogStats.matching_deletable_ops)
      },
      rehearsalExpectedRemaining: {
        periods: beforeCounts.periods.tenant - cleanPreCutoffPeriodIds.size,
        period_archives: beforeCounts.period_archives.tenant - cleanPreCutoffPeriodIds.size,
        worker_adjustments: beforeCounts.worker_adjustments.tenant - sentabrWorkerAdjs.length,
        tickets: beforeCounts.tickets.tenant - deletableTicketIds.length,
        ticket_entries: beforeCounts.ticket_entries.tenant - Number(entryCounts.deletable_entries),
        parties: beforeCounts.parties.tenant - deletablePartyIds.length,
        legacy_party_collision_exceptions: beforeCounts.legacy_party_collision_exceptions.tenant - deletableCollisionExceptions.length,
        protected_party_patta_ranges: beforeCounts.protected_party_patta_ranges.tenant - deletableProtectedRanges.length,
        party_id_aliases: beforeCounts.party_id_aliases.tenant - deletablePartyAliases.length,
        production_adjustments: beforeCounts.production_adjustments.tenant,
        workers: beforeCounts.workers.tenant,
        models: beforeCounts.models.tenant
      }
    },
    schemaInventory: {
      tableCount: Object.keys(beforeCounts).length,
      foreignKeyCount: schemaMeta.foreignKeys.length,
      triggerCount: schemaMeta.triggers.length,
      foreignKeys: schemaMeta.foreignKeys,
      triggers: schemaMeta.triggers
    },
    blockers
  };

  const manifestSha256 = computeManifestSha256(manifestCore);
  return {
    ...manifestCore,
    manifestSha256,
    generatedAt: new Date().toISOString()
  };
}

async function executeDisposableHistoricalPurge(client, options = {}) {
  const companyId = options.tenantId || TARGET_TENANT_ID;
  const manifest = options.manifest;
  const expectedManifestSha256 = options.manifestSha256;
  const rehearsalScope = options.disposableRehearsalScope || 'strict';

  await verifyDisposableServerIdentity(client);

  const migRes = await client.query(`SELECT MAX(version)::int AS v FROM schema_migrations`);
  const schemaVersion = Number(migRes.rows[0]?.v || 0);
  if (schemaVersion !== REQUIRED_EXECUTE_SCHEMA_VERSION) {
    throw new Error(`SCHEMA_VERSION_MISMATCH: expected v${REQUIRED_EXECUTE_SCHEMA_VERSION}, got v${schemaVersion}`);
  }

  if (!manifest || !expectedManifestSha256) {
    throw new Error('APPROVED_MANIFEST_REQUIRED: manifest and manifestSha256 are required');
  }
  const actualSha = computeManifestSha256(manifest);
  if (actualSha !== expectedManifestSha256 || actualSha !== manifest.manifestSha256) {
    throw new Error(`MANIFEST_SHA256_MISMATCH: expected=${expectedManifestSha256}, computed=${actualSha}`);
  }
  if (manifest.tenantId !== companyId) {
    throw new Error(`MANIFEST_TENANT_MISMATCH: expected=${companyId}, got=${manifest.tenantId}`);
  }
  if (manifest.exclusiveCutoff?.sqlDate !== CUTOFF_DATE || manifest.exclusiveCutoff?.utcInstant !== CUTOFF_UTC) {
    throw new Error('MANIFEST_CUTOFF_MISMATCH');
  }

  if (rehearsalScope !== 'sentabr-approved-only') {
    throw new Error(`BLOCKED_BY_DESIGN: full production/direct purge is blocked (${manifest.blockers.map((b) => b.code).join(', ')}); pass explicit disposable rehearsal scope "sentabr-approved-only" only on disposable databases`);
  }

  const cls = manifest.classifications;
  const deletableTicketIds = cls.tickets.DELETE_SENTABR_CLEAN || [];
  const deletablePartyIds = cls.parties.DELETE_PRE_CUTOFF_CLOSED || [];
  const deletableWorkerAdjIds = cls.workerAdjustments.BLOCKED_PENDING_FINANCIAL_SIGNOFF_REHEARSAL_DELETE || [];
  const deletablePeriodIds = cls.periods
    .filter((p) => p.rehearsalSentabrScopeClassification === 'DELETE')
    .map((p) => p.id);
  const deletableOpIds = cls.operationsAndChangeLog.REHEARSAL_DELETE_AND_TOMBSTONE_OPERATION_IDS || [];

  // Re-verify remaining deletable rows inside the write transaction for true idempotency
  const existingPreRes = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM tickets WHERE company_id = $1::varchar AND id = ANY($2::varchar[])) AS rem_tickets,
      (SELECT COUNT(*)::int FROM parties WHERE company_id = $1::varchar AND id = ANY($3::varchar[])) AS rem_parties,
      (SELECT COUNT(*)::int FROM periods WHERE company_id = $1::varchar AND id = ANY($4::varchar[])) AS rem_periods,
      (SELECT COUNT(*)::int FROM worker_adjustments WHERE company_id = $1::varchar AND id = ANY($5::varchar[])) AS rem_worker_adjs,
      (SELECT COUNT(*)::int FROM operations_dedup WHERE company_id = $1::varchar AND operation_id = ANY($6::varchar[])) AS rem_ops,
      (SELECT COALESCE(MAX(purge_generation), 0)::int FROM historical_purge_eras WHERE company_id = $1::varchar) AS current_gen
  `, [companyId, deletableTicketIds, deletablePartyIds, deletablePeriodIds, deletableWorkerAdjIds, deletableOpIds]);
  const rem = existingPreRes.rows[0];
  if (rem.rem_tickets === 0 && rem.rem_parties === 0 && rem.rem_periods === 0 && rem.rem_worker_adjs === 0 && rem.rem_ops === 0) {
    return {
      status: 'NOOP_ALREADY_PURGED',
      companyId,
      purgeGeneration: rem.current_gen,
      deleted: {
        ticket_entries: 0,
        tickets: 0,
        worker_adjustments: 0,
        period_archives: 0,
        periods: 0,
        legacy_party_collision_exceptions: 0,
        protected_party_patta_ranges: 0,
        party_id_aliases: 0,
        parties: 0,
        change_log: 0,
        operations_dedup: 0
      }
    };
  }

  // Acquire company lock consistent with runtime sync writers
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1::text || ':sync-change-lock'))`, [companyId]);

  const nextGeneration = Number(rem.current_gen) + 1;
  const purgeId = `purge_${companyId}_${CUTOFF_DATE}_gen${nextGeneration}_${sha256Hex(expectedManifestSha256).slice(0, 12)}`;

  // Guard: refuse to delete any Oct 8+ ticket even if manually injected into manifest
  const safetyRes = await client.query(`
    SELECT COUNT(*)::int AS violation_cnt
    FROM tickets
    WHERE company_id = $1::varchar
      AND id = ANY($2::varchar[])
      AND (submitted_at AT TIME ZONE '${BUSINESS_TIMEZONE}')::date >= $3::date
  `, [companyId, deletableTicketIds, CUTOFF_DATE]);
  if (Number(safetyRes.rows[0].violation_cnt) > 0) {
    throw new Error('SAFETY_VIOLATION_POST_CUTOFF_TICKET_IN_DELETE_LIST');
  }

  // Capture aliases for tombstoning BEFORE deleting aliases
  const deletedAliasesRes = await client.query(`
    SELECT legacy_party_id
    FROM party_id_aliases
    WHERE company_id = $1::varchar AND canonical_party_id = ANY($2::varchar[])
  `, [companyId, deletablePartyIds]);
  const partyTombstoneIds = [...new Set([
    ...deletablePartyIds,
    ...deletedAliasesRes.rows.map((r) => r.legacy_party_id)
  ])];

  // Insert anti-resurrection tombstones FIRST (ON CONFLICT DO NOTHING)
  if (deletableTicketIds.length) {
    await client.query(`
      INSERT INTO purged_entity_tombstones (company_id, entity_type, entity_id, purge_generation, authoritative_at, cutoff_date)
      SELECT $1::varchar, 'ticket', t.id, $2::bigint, t.submitted_at, $3::date
      FROM tickets t
      WHERE t.company_id = $1::varchar AND t.id = ANY($4::varchar[])
      ON CONFLICT (company_id, entity_type, entity_id) DO NOTHING
    `, [companyId, nextGeneration, CUTOFF_DATE, deletableTicketIds]);
  }
  if (partyTombstoneIds.length) {
    await client.query(`
      INSERT INTO purged_entity_tombstones (company_id, entity_type, entity_id, purge_generation, authoritative_at, cutoff_date)
      SELECT $1::varchar, 'party', pid, $2::bigint, NULL::timestamptz, $3::date
      FROM UNNEST($4::varchar[]) AS pid
      ON CONFLICT (company_id, entity_type, entity_id) DO NOTHING
    `, [companyId, nextGeneration, CUTOFF_DATE, partyTombstoneIds]);
  }
  if (deletablePeriodIds.length) {
    await client.query(`
      INSERT INTO purged_entity_tombstones (company_id, entity_type, entity_id, purge_generation, authoritative_at, cutoff_date)
      SELECT $1::varchar, 'period', p.id, $2::bigint, p.closed_at, $3::date
      FROM periods p
      WHERE p.company_id = $1::varchar AND p.id = ANY($4::varchar[])
      ON CONFLICT (company_id, entity_type, entity_id) DO NOTHING
    `, [companyId, nextGeneration, CUTOFF_DATE, deletablePeriodIds]);
  }
  if (deletableOpIds.length) {
    await client.query(`
      INSERT INTO purged_operation_tombstones (company_id, operation_id, purge_generation, command_type, entity_type, entity_id, authoritative_at)
      SELECT $1::varchar, od.operation_id, $2::bigint, od.command_type, od.entity_type, od.entity_id, od.accepted_at
      FROM operations_dedup od
      WHERE od.company_id = $1::varchar AND od.operation_id = ANY($3::varchar[])
      ON CONFLICT (company_id, operation_id) DO NOTHING
    `, [companyId, nextGeneration, deletableOpIds]);
  }

  // Strict child-to-parent DELETE without disabling FKs or using TRUNCATE CASCADE
  const delEntries = await client.query(
    `DELETE FROM ticket_entries WHERE company_id = $1::varchar AND ticket_id = ANY($2::varchar[])`,
    [companyId, deletableTicketIds]
  );
  const delTickets = await client.query(
    `DELETE FROM tickets WHERE company_id = $1::varchar AND id = ANY($2::varchar[])`,
    [companyId, deletableTicketIds]
  );
  const delWorkerAdjs = await client.query(
    `DELETE FROM worker_adjustments WHERE company_id = $1::varchar AND id = ANY($2::varchar[])`,
    [companyId, deletableWorkerAdjIds]
  );
  const delArchives = await client.query(
    `DELETE FROM period_archives WHERE company_id = $1::varchar AND period_id = ANY($2::varchar[])`,
    [companyId, deletablePeriodIds]
  );
  const delExceptions = await client.query(
    `DELETE FROM legacy_party_collision_exceptions WHERE company_id = $1::varchar AND party_id = ANY($2::varchar[])`,
    [companyId, deletablePartyIds]
  );
  const delProtectedRanges = await client.query(
    `DELETE FROM protected_party_patta_ranges WHERE company_id = $1::varchar AND party_record_id = ANY($2::varchar[])`,
    [companyId, deletablePartyIds]
  );
  const delPartyAliases = await client.query(
    `DELETE FROM party_id_aliases WHERE company_id = $1::varchar AND canonical_party_id = ANY($2::varchar[])`,
    [companyId, deletablePartyIds]
  );
  const delParties = await client.query(
    `DELETE FROM parties WHERE company_id = $1::varchar AND id = ANY($2::varchar[])`,
    [companyId, deletablePartyIds]
  );
  const delPeriods = await client.query(
    `DELETE FROM periods WHERE company_id = $1::varchar AND id = ANY($2::varchar[])`,
    [companyId, deletablePeriodIds]
  );
  const delChangeLog = await client.query(
    `DELETE FROM change_log WHERE company_id = $1::varchar AND operation_id = ANY($2::varchar[])`,
    [companyId, deletableOpIds]
  );
  const delOpsDedup = await client.query(
    `DELETE FROM operations_dedup WHERE company_id = $1::varchar AND operation_id = ANY($2::varchar[])`,
    [companyId, deletableOpIds]
  );

  // Advance authoritative change feed watermark via an auditable purge_era marker
  const markerRes = await client.query(`
    INSERT INTO change_log (
      company_id, entity_type, entity_id, entity_revision,
      operation_id, change_type, payload_json, committed_at
    ) VALUES ($1::varchar, 'purge_era', $2::varchar, $3::bigint, $2::varchar, 'INSERT', $4::jsonb, NOW())
    RETURNING change_id::text AS change_id
  `, [
    companyId,
    purgeId,
    nextGeneration,
    JSON.stringify({
      purgeId,
      purgeGeneration: nextGeneration,
      cutoffDate: CUTOFF_DATE,
      cutoffUtc: CUTOFF_UTC,
      manifestSha256: expectedManifestSha256,
      scope: rehearsalScope
    })
  ]);
  const minValidCursor = markerRes.rows[0].change_id;

  const summary = {
    scope: rehearsalScope,
    deleted: {
      ticket_entries: delEntries.rowCount,
      tickets: delTickets.rowCount,
      worker_adjustments: delWorkerAdjs.rowCount,
      period_archives: delArchives.rowCount,
      periods: delPeriods.rowCount,
      legacy_party_collision_exceptions: delExceptions.rowCount,
      protected_party_patta_ranges: delProtectedRanges.rowCount,
      party_id_aliases: delPartyAliases.rowCount,
      parties: delParties.rowCount,
      change_log: delChangeLog.rowCount,
      operations_dedup: delOpsDedup.rowCount
    },
    tombstonesInserted: {
      entities: deletableTicketIds.length + partyTombstoneIds.length + deletablePeriodIds.length,
      operations: deletableOpIds.length
    },
    minValidCursor
  };

  if (options.injectFailureBeforeCommit) {
    throw new Error('PURGE_INJECTED_FAILURE_BEFORE_COMMIT');
  }

  await client.query(`
    INSERT INTO historical_purge_eras (
      purge_id, company_id, purge_generation, cutoff_date, cutoff_utc, timezone,
      min_valid_cursor, manifest_sha256, executor_mode, status, baseline_purged, summary_json
    ) VALUES ($1::varchar, $2::varchar, $3::bigint, $4::date, $5::timestamptz, $6::varchar, $7::bigint, $8::char(64), $9::varchar, 'COMMITTED', TRUE, $10::jsonb)
  `, [
    purgeId,
    companyId,
    nextGeneration,
    CUTOFF_DATE,
    CUTOFF_UTC,
    BUSINESS_TIMEZONE,
    minValidCursor,
    expectedManifestSha256,
    `DISPOSABLE_REHEARSAL:${rehearsalScope}`,
    JSON.stringify(summary)
  ]);

  // Verify post-purge October 8+ preservation before COMMIT
  const verifyOct8 = await client.query(`
    SELECT
      COUNT(*) FILTER (WHERE (submitted_at AT TIME ZONE '${BUSINESS_TIMEZONE}')::date >= $2::date)::int AS post_tickets,
      COUNT(*) FILTER (WHERE (submitted_at AT TIME ZONE '${BUSINESS_TIMEZONE}')::date = $2::date)::int AS oct8_tickets,
      COALESCE(SUM(qty) FILTER (WHERE (submitted_at AT TIME ZONE '${BUSINESS_TIMEZONE}')::date = $2::date), 0)::numeric::text AS oct8_qty
    FROM tickets
    WHERE company_id = $1::varchar
  `, [companyId, CUTOFF_DATE]);
  const v = verifyOct8.rows[0];
  if (v.post_tickets !== manifest.october8Protection.protectedPostCutoffTicketsTotal
    || v.oct8_tickets !== manifest.october8Protection.protectedTicketCount
    || Number(v.oct8_qty) !== manifest.october8Protection.protectedTicketQtySum) {
    throw new Error(`POST_CUTOFF_PRESERVATION_CHECK_FAILED: ${JSON.stringify(v)}`);
  }

  return {
    status: 'EXECUTED_DISPOSABLE_REHEARSAL',
    purgeId,
    companyId,
    purgeGeneration: nextGeneration,
    minValidCursor,
    manifestSha256: expectedManifestSha256,
    ...summary
  };
}

module.exports = {
  TARGET_TENANT_ID,
  CUTOFF_DATE,
  CUTOFF_UTC,
  BUSINESS_TIMEZONE,
  REQUIRED_EXECUTE_SCHEMA_VERSION,
  HISTORICAL_SENTABR_COMMAND_TYPES,
  stableStringify,
  computeManifestSha256,
  assertDisposablePostgresTarget,
  verifyDisposableServerIdentity,
  buildHistoricalPurgeManifest,
  executeDisposableHistoricalPurge
};
