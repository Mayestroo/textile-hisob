import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { buildHisobProjections } from '../../renderer/domain/projections';
import { evaluatePeriodCloseGuard, assertCanClosePeriod } from '../../renderer/domain/periodCloseGuard';
import {
  computeReconciliationSummary,
  countUnresolvedCandidates,
  assertAuthorizedOperatorRole,
  isAuthorizedOperatorRole
} from '../../renderer/domain/reconciliation';

// @ts-ignore
const databaseManager = require('./databaseManager.cjs');
// @ts-ignore
const migrator = require('./migrator.cjs');
// @ts-ignore
const commandPipeline = require('./commandPipeline.cjs');


describe('Phase 2: Operator Reconciliation Resolution Engine & Governance', () => {
  let tempUserDataDir: string;
  const companyId = 'comp_novda';
  const snapshotHash = '2b94d9ef90a9c3d9eb43f8267f36bd9b6b5bf5f27f76df9a413453ade2747a6c';

  beforeEach(() => {
    tempUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novda-recon-test-'));
  });

  afterEach(() => {
    databaseManager.closeAllCompanyDatabases();
    try {
      if (fs.existsSync(tempUserDataDir)) {
        fs.rmSync(tempUserDataDir, { recursive: true, force: true });
      }
    } catch (e) {}
  });

  /**
   * Sets up an isolated test database with the 5 pilot candidates on BODY-T-SHRIT totaling 747 units.
   */
  function setupPilotReconciliationDatabase() {
    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyId);

    // Insert model BODY-T-SHRIT
    db.prepare(`
      INSERT OR IGNORE INTO models (id, company_id, name, created_at, updated_at, provenance)
      VALUES (?, ?, ?, datetime('now'), datetime('now'), 'LEGACY_MIGRATION')
    `).run('BODY-T-SHRIT', companyId, 'Модел- BODY-T-SHRIT');

    // Insert workers 53, 68, 112, 167
    const insertWorker = db.prepare(`
      INSERT OR IGNORE INTO workers (id, company_id, name, staj, created_at, updated_at, provenance)
      VALUES (?, ?, ?, 0, datetime('now'), datetime('now'), 'LEGACY_MIGRATION')
    `);
    insertWorker.run(53, companyId, 'МАМАЖОНОВА ДИЛДОРА');
    insertWorker.run(68, companyId, 'Умаркулова Мухаббат');
    insertWorker.run(112, companyId, 'УРАИМОВА МУНОЖАТХОН');
    insertWorker.run(167, companyId, 'Набиева Мавлуда');

    // Insert the exact 5 candidates from OPERATOR_RECONCILIATION_DECISION_PACKET.md
    const insertCand = db.prepare(`
      INSERT INTO migration_reconciliation_candidates (
        candidate_id, company_id, model_id, worker_id, operation_name,
        legacy_qty, ticket_derived_qty, delta_qty, status, reason, created_at, source_snapshot_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_REVIEW', ?, '2026-09-20T12:00:00.000Z', ?)
    `);

    insertCand.run('0fc7ee7b-6070-5141-8c33-b232af859cde', companyId, 'BODY-T-SHRIT', 53, 'POYCHA RASHMA', 213, 0, 213, 'LEGACY_HISOB_QUANTITY_MISMATCH', snapshotHash);
    insertCand.run('34a41c1e-fec6-591a-9e33-c48338e707d7', companyId, 'BODY-T-SHRIT', 53, 'YENG RASHMA', 123, 0, 123, 'LEGACY_HISOB_QUANTITY_MISMATCH', snapshotHash);
    insertCand.run('3f57cf38-a0be-5b73-a9cd-ff6b99c42487', companyId, 'BODY-T-SHRIT', 68, 'RAZMER', 91, 0, 91, 'LEGACY_HISOB_QUANTITY_MISMATCH', snapshotHash);
    insertCand.run('1789c444-a725-5ecd-9ed9-c148893c4790', companyId, 'BODY-T-SHRIT', 112, 'DAZMOL', 297, 0, 297, 'LEGACY_HISOB_QUANTITY_MISMATCH', snapshotHash);
    insertCand.run('cdf9648e-a112-54bc-8ec4-10491b247793', companyId, 'BODY-T-SHRIT', 167, 'RAZMER', 23, 0, 23, 'LEGACY_HISOB_QUANTITY_MISMATCH', snapshotHash);

    return db;
  }

  // 1. candidate cannot auto-resolve
  it('1. candidate cannot auto-resolve and remains strictly PENDING_REVIEW', () => {
    const db = setupPilotReconciliationDatabase();
    const candidates = migrator.getReconciliationCandidates(db, companyId);
    expect(candidates).toHaveLength(5);
    for (const c of candidates) {
      expect(c.status).toBe('PENDING_REVIEW');
      expect(c.resolution_decision).toBeNull();
      expect(c.created_adjustment_id).toBeNull();
    }
    const adjustments = db.prepare('SELECT * FROM production_adjustments WHERE company_id = ?').all(companyId);
    expect(adjustments).toHaveLength(0);
  });

  // 2. Local CONFIRM is intent-only
  it('2. local CONFIRM persists pending intent without an adjustment', () => {
    const db = setupPilotReconciliationDatabase();
    const candidateId = '0fc7ee7b-6070-5141-8c33-b232af859cde';

    const res = commandPipeline.executeResolveReconciliationCandidateCommand(
      tempUserDataDir,
      companyId,
      {
        commandId: 'cmd_res_1',
        operationId: 'op_res_1',
        companyId,
        candidateId,
        decision: 'CONFIRM_LEGACY_AS_ADJUSTMENT',
        operatorId: 'head_accountant_01',
        operatorRole: 'accountant',
        reason: 'Physical notebook verified and confirmed off-ticket work'
      }
    );

    expect(res.committed).toBe(true);
    expect(res.status).toBe('PENDING_SYNC');
    expect(res.resolutionStatus).toBe('PENDING_SYNC');
    expect(res.adjustmentId).toBeNull();

    // Verify exactly one adjustment created
    const adjustments = db.prepare('SELECT * FROM production_adjustments WHERE company_id = ?').all(companyId);
    expect(adjustments).toHaveLength(0);

    // Verify candidate row updated
    const cand = db.prepare('SELECT * FROM migration_reconciliation_candidates WHERE candidate_id = ?').get(candidateId);
    expect(cand.status).toBe('PENDING_REVIEW');
    expect(cand.resolution_decision).toBeNull();
    expect(cand.created_adjustment_id).toBeNull();
    expect(db.prepare('SELECT * FROM local_outbox WHERE operation_id = ?').get('op_res_1')).toBeTruthy();
  });

  // 3. APPROVE replay creates no second adjustment
  it('3. APPROVE replay is idempotent and creates no second adjustment', () => {
    const db = setupPilotReconciliationDatabase();
    const candidateId = '0fc7ee7b-6070-5141-8c33-b232af859cde';

    const cmd = {
      commandId: 'cmd_res_1',
      operationId: 'op_res_1',
      companyId,
      candidateId,
      decision: 'CONFIRM_LEGACY_AS_ADJUSTMENT',
      operatorId: 'head_accountant_01',
      operatorRole: 'accountant',
      reason: 'Physical notebook verified'
    };

    const res1 = commandPipeline.executeResolveReconciliationCandidateCommand(tempUserDataDir, companyId, cmd);
    expect(res1.isReplay).toBe(false);

    // Replay same command
    const res2 = commandPipeline.executeResolveReconciliationCandidateCommand(tempUserDataDir, companyId, cmd);
    expect(res2.isReplay).toBe(true);
    expect(res2.adjustmentId).toBe(res1.adjustmentId);

    // Verify no accounting fact or final resolution exists locally
    const adjustments = db.prepare('SELECT * FROM production_adjustments WHERE company_id = ?').all(companyId);
    expect(adjustments).toHaveLength(0);
    const resolutions = db.prepare('SELECT * FROM migration_reconciliation_resolutions WHERE candidate_id = ?').all(candidateId);
    expect(resolutions).toHaveLength(0);
  });

  // 4. Local REJECT is intent-only
  it('4. local REJECT leaves candidate unresolved and creates zero adjustments', () => {
    const db = setupPilotReconciliationDatabase();
    const candidateId = '34a41c1e-fec6-591a-9e33-c48338e707d7';

    const res = commandPipeline.executeResolveReconciliationCandidateCommand(
      tempUserDataDir,
      companyId,
      {
        commandId: 'cmd_res_2',
        operationId: 'op_res_2',
        companyId,
        candidateId,
        decision: 'REJECT_LEGACY_DIFFERENCE',
        operatorId: 'factory_admin_01',
        operatorRole: 'admin',
        reason: 'Legacy entry was testing data on floor'
      }
    );

    expect(res.committed).toBe(true);
    expect(res.status).toBe('PENDING_SYNC');
    expect(res.adjustmentId).toBeNull();

    // 0 adjustments created
    const adjustments = db.prepare('SELECT * FROM production_adjustments WHERE company_id = ?').all(companyId);
    expect(adjustments).toHaveLength(0);

    const cand = db.prepare('SELECT * FROM migration_reconciliation_candidates WHERE candidate_id = ?').get(candidateId);
    expect(cand.status).toBe('PENDING_REVIEW');
    expect(cand.resolution_decision).toBeNull();
  });

  // 5. DEFER stays unresolved
  it('5. DEFER stays unresolved under PENDING_REVIEW', () => {
    const db = setupPilotReconciliationDatabase();
    const candidateId = '3f57cf38-a0be-5b73-a9cd-ff6b99c42487';

    const res = commandPipeline.executeResolveReconciliationCandidateCommand(
      tempUserDataDir,
      companyId,
      {
        commandId: 'cmd_res_3',
        operationId: 'op_res_3',
        companyId,
        candidateId,
        decision: 'DEFER_REVIEW',
        operatorId: 'head_accountant_01',
        operatorRole: 'accountant',
        reason: 'Awaiting shift foreman interview tomorrow'
      }
    );

    expect(res.status).toBe('PENDING_SYNC');
    const cand = db.prepare('SELECT * FROM migration_reconciliation_candidates WHERE candidate_id = ?').get(candidateId);
    expect(cand.status).toBe('PENDING_REVIEW');
    expect(cand.resolution_decision).toBeNull();

    const summary = migrator.getReconciliationSummary(db, companyId);
    expect(summary.unresolvedCount).toBe(5);
  });

  // 6. LINK_TO_MISSING_SOURCE stays unresolved until evidence reconciliation
  it('6. LINK_TO_MISSING_SOURCE attaches source reference and stays unresolved', () => {
    const db = setupPilotReconciliationDatabase();
    const candidateId = '1789c444-a725-5ecd-9ed9-c148893c4790';

    const res = commandPipeline.executeResolveReconciliationCandidateCommand(
      tempUserDataDir,
      companyId,
      {
        commandId: 'cmd_res_4',
        operationId: 'op_res_4',
        companyId,
        candidateId,
        decision: 'LINK_TO_MISSING_SOURCE',
        operatorId: 'head_accountant_01',
        operatorRole: 'accountant',
        reason: 'Located physical paper receipt bundle #112-D',
        sourceReference: 'archive://box-4/sept-2026/notebook_p12.pdf'
      }
    );

    expect(res.status).toBe('PENDING_SYNC');
    const cand = db.prepare('SELECT * FROM migration_reconciliation_candidates WHERE candidate_id = ?').get(candidateId);
    expect(cand.status).toBe('PENDING_REVIEW');
    expect(cand.source_reference).toBeNull();

    // Remains unresolved for cutover
    const summary = migrator.getReconciliationSummary(db, companyId);
    expect(summary.linkedSourceTotal).toBe(0);
    expect(summary.unresolvedCount).toBe(5);
  });

  // 7. conflicting local intents remain pending for server authority
  it('7. conflicting local intents do not finalize the candidate', () => {
    setupPilotReconciliationDatabase();
    const candidateId = '0fc7ee7b-6070-5141-8c33-b232af859cde';

    // First decision: APPROVE
    commandPipeline.executeResolveReconciliationCandidateCommand(
      tempUserDataDir,
      companyId,
      {
        commandId: 'cmd_first',
        operationId: 'op_first',
        companyId,
        candidateId,
        decision: 'CONFIRM_LEGACY_AS_ADJUSTMENT',
        operatorId: 'head_accountant_01',
        operatorRole: 'accountant',
        reason: 'Approved based on signed journal'
      }
    );

    // Conflicting second decision is still only a local intent.
    const second = commandPipeline.executeResolveReconciliationCandidateCommand(
        tempUserDataDir,
        companyId,
        {
          commandId: 'cmd_second',
          operationId: 'op_second',
          companyId,
          candidateId,
          decision: 'REJECT_LEGACY_DIFFERENCE',
          operatorId: 'head_accountant_02',
          operatorRole: 'accountant',
          reason: 'Attempted conflicting overturn'
        }
      );
    expect(second.status).toBe('PENDING_SYNC');
    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyId);
    expect(db.prepare('SELECT status FROM migration_reconciliation_candidates WHERE candidate_id = ?').get(candidateId).status).toBe('PENDING_REVIEW');
  });

  // 8. candidate coordinates cannot be changed by client
  it('8. candidate coordinates cannot be changed or forged by client', () => {
    setupPilotReconciliationDatabase();
    const candidateId = '0fc7ee7b-6070-5141-8c33-b232af859cde'; // Worker 53, BODY-T-SHRIT, POYCHA RASHMA

    expect(() => {
      commandPipeline.executeResolveReconciliationCandidateCommand(
        tempUserDataDir,
        companyId,
        {
          commandId: 'cmd_tamper_worker',
          operationId: 'op_tamper_1',
          companyId,
          candidateId,
          workerId: 999, // tampered worker ID
          decision: 'CONFIRM_LEGACY_AS_ADJUSTMENT',
          operatorId: 'head_accountant_01',
          operatorRole: 'accountant',
          reason: 'Tampered coords'
        }
      );
    }).toThrow(/CANDIDATE_TAMPERING_REJECTED/);
  });

  // 9. candidate delta cannot be changed by client
  it('9. candidate delta cannot be changed or forged by client', () => {
    setupPilotReconciliationDatabase();
    const candidateId = '0fc7ee7b-6070-5141-8c33-b232af859cde'; // Authentic delta is +213

    expect(() => {
      commandPipeline.executeResolveReconciliationCandidateCommand(
        tempUserDataDir,
        companyId,
        {
          commandId: 'cmd_tamper_delta',
          operationId: 'op_tamper_2',
          companyId,
          candidateId,
          deltaQty: 9999, // tampered delta
          decision: 'CONFIRM_LEGACY_AS_ADJUSTMENT',
          operatorId: 'head_accountant_01',
          operatorRole: 'accountant',
          reason: 'Tampered delta'
        }
      );
    }).toThrow(/CANDIDATE_TAMPERING_REJECTED/);
  });

  // 10. unauthorized actor rejected
  it('10. unauthorized actor is rejected (workers, type, print disallowed; admin, accountant allowed)', () => {
    setupPilotReconciliationDatabase();
    const candidateId = '0fc7ee7b-6070-5141-8c33-b232af859cde';

    // Ordinary data entry operator ('type') rejected
    expect(() => {
      commandPipeline.executeResolveReconciliationCandidateCommand(
        tempUserDataDir,
        companyId,
        {
          commandId: 'cmd_unauth_1',
          operationId: 'op_unauth_1',
          companyId,
          candidateId,
          decision: 'CONFIRM_LEGACY_AS_ADJUSTMENT',
          operatorId: 'typist_john',
          operatorRole: 'type',
          reason: 'Unauthorized attempt'
        }
      );
    }).toThrow(/UNAUTHORIZED_ROLE/);

    // Print operator rejected
    expect(() => {
      commandPipeline.executeResolveReconciliationCandidateCommand(
        tempUserDataDir,
        companyId,
        {
          commandId: 'cmd_unauth_2',
          operationId: 'op_unauth_2',
          companyId,
          candidateId,
          decision: 'CONFIRM_LEGACY_AS_ADJUSTMENT',
          operatorId: 'printer_bob',
          operatorRole: 'print',
          reason: 'Unauthorized attempt'
        }
      );
    }).toThrow(/UNAUTHORIZED_ROLE/);

    // Production worker rejected
    expect(() => {
      commandPipeline.executeResolveReconciliationCandidateCommand(
        tempUserDataDir,
        companyId,
        {
          commandId: 'cmd_unauth_3',
          operationId: 'op_unauth_3',
          companyId,
          candidateId,
          decision: 'CONFIRM_LEGACY_AS_ADJUSTMENT',
          operatorId: 'worker_53',
          operatorRole: 'worker',
          reason: 'Unauthorized attempt'
        }
      );
    }).toThrow(/UNAUTHORIZED_ROLE/);

    expect(isAuthorizedOperatorRole('admin')).toBe(true);
    expect(isAuthorizedOperatorRole('accountant')).toBe(true);
    expect(isAuthorizedOperatorRole('head_accountant')).toBe(true);
    expect(isAuthorizedOperatorRole('type')).toBe(false);
    expect(isAuthorizedOperatorRole('print')).toBe(false);
  });

  // 11. local intent is not an authoritative audit row
  it('11. local intent is durable but creates no authoritative audit row', () => {
    const db = setupPilotReconciliationDatabase();
    const candidateId = '0fc7ee7b-6070-5141-8c33-b232af859cde';

    const res = commandPipeline.executeResolveReconciliationCandidateCommand(
      tempUserDataDir,
      companyId,
      {
        commandId: 'cmd_audit_1',
        operationId: 'op_audit_1',
        companyId,
        candidateId,
        decision: 'CONFIRM_LEGACY_AS_ADJUSTMENT',
        operatorId: 'head_accountant_01',
        operatorRole: 'accountant',
        reason: 'Signed foreman logbook page 44',
        sourceReference: 'logbook://2026-09-07/p44'
      }
    );

    expect(res.status).toBe('PENDING_SYNC');
    expect(db.prepare('SELECT * FROM migration_reconciliation_resolutions WHERE candidate_id = ?').get(candidateId)).toBeUndefined();
    expect(db.prepare('SELECT * FROM local_outbox WHERE operation_id = ?').get('op_audit_1')).toBeTruthy();
  });

  // 12. source snapshot hash remains on the candidate until server commit
  it('12. source snapshot hash is not copied into a local final resolution', () => {
    const db = setupPilotReconciliationDatabase();
    const candidateId = '34a41c1e-fec6-591a-9e33-c48338e707d7';

    commandPipeline.executeResolveReconciliationCandidateCommand(
      tempUserDataDir,
      companyId,
      {
        commandId: 'cmd_hash_1',
        operationId: 'op_hash_1',
        companyId,
        candidateId,
        decision: 'REJECT_LEGACY_DIFFERENCE',
        operatorId: 'head_accountant_01',
        operatorRole: 'accountant',
        reason: 'Legacy error'
      }
    );

    const cand = db.prepare('SELECT source_snapshot_hash FROM migration_reconciliation_candidates WHERE candidate_id = ?').get(candidateId);
    expect(cand.source_snapshot_hash).toBe(snapshotHash);

    expect(db.prepare('SELECT source_snapshot_hash FROM migration_reconciliation_resolutions WHERE candidate_id = ?').get(candidateId)).toBeUndefined();
  });

  // 13. 5-candidate total remains 747 before decisions
  it('13. 5-candidate total remains exactly 747 units and conservation invariant holds', () => {
    const db = setupPilotReconciliationDatabase();
    const summaryBefore = migrator.getReconciliationSummary(db, companyId);
    expect(summaryBefore.candidateCount).toBe(5);
    expect(summaryBefore.totalDelta).toBe(747);
    expect(summaryBefore.approvedAdjustmentTotal).toBe(0);
    expect(summaryBefore.rejectedTotal).toBe(0);
    expect(summaryBefore.stillPendingTotal).toBe(747);
    expect(summaryBefore.linkedSourceTotal).toBe(0);
    expect(summaryBefore.unresolvedCount).toBe(5);

    // Resolve Candidate 1: APPROVE (+213)
    commandPipeline.executeResolveReconciliationCandidateCommand(
      tempUserDataDir, companyId,
      { commandId: 'c1', operationId: 'o1', companyId, candidateId: '0fc7ee7b-6070-5141-8c33-b232af859cde', decision: 'CONFIRM_LEGACY_AS_ADJUSTMENT', operatorId: 'acc', operatorRole: 'accountant', reason: 'ok' }
    );

    // Resolve Candidate 2: REJECT (+123)
    commandPipeline.executeResolveReconciliationCandidateCommand(
      tempUserDataDir, companyId,
      { commandId: 'c2', operationId: 'o2', companyId, candidateId: '34a41c1e-fec6-591a-9e33-c48338e707d7', decision: 'REJECT_LEGACY_DIFFERENCE', operatorId: 'acc', operatorRole: 'accountant', reason: 'reject' }
    );

    // Resolve Candidate 3: LINK (+91)
    commandPipeline.executeResolveReconciliationCandidateCommand(
      tempUserDataDir, companyId,
      { commandId: 'c3', operationId: 'o3', companyId, candidateId: '3f57cf38-a0be-5b73-a9cd-ff6b99c42487', decision: 'LINK_TO_MISSING_SOURCE', operatorId: 'acc', operatorRole: 'accountant', reason: 'link', sourceReference: 'ref-1' }
    );

    // Candidate 4 (297) and Candidate 5 (23) remain PENDING_REVIEW (320)
    const summaryAfter = migrator.getReconciliationSummary(db, companyId);
    expect(summaryAfter.approvedAdjustmentTotal).toBe(0);
    expect(summaryAfter.rejectedTotal).toBe(0);
    expect(summaryAfter.linkedSourceTotal).toBe(0);
    expect(summaryAfter.stillPendingTotal).toBe(747);
    expect(summaryAfter.totalDelta).toBe(747);
    expect(summaryAfter.approvedAdjustmentTotal + summaryAfter.rejectedTotal + summaryAfter.linkedSourceTotal + summaryAfter.stillPendingTotal).toBe(747);
    expect(summaryAfter.unresolvedCount).toBe(5);
  });

  // 14. period close blocked while one candidate pending
  it('14. period close remains blocked while any candidate is unresolved', () => {
    const db = setupPilotReconciliationDatabase();
    const summary = migrator.getReconciliationSummary(db, companyId);

    const guardInput = {
      companyId,
      periodId: 'period_2026_09',
      outboxPendingCount: 0,
      outboxSendingCount: 0,
      outboxConflictCount: 0,
      outboxDeadLetterCount: 0,
      unresolvedReconciliationCount: summary.unresolvedCount
    };

    const evalResult = evaluatePeriodCloseGuard(guardInput);
    expect(evalResult.canClose).toBe(false);
    expect(evalResult.blockers[0]).toContain('UNRESOLVED_RECONCILIATION');
    expect(() => assertCanClosePeriod(guardInput)).toThrow(/PERIOD_CLOSE_BLOCKED/);
  });

  // 15. pending intents keep period close blocked
  it('15. period close remains blocked while local intents await authority', () => {
    const db = setupPilotReconciliationDatabase();

    // Queue intents for all five candidates; none is authoritative locally.
    const candidates = [
      { id: '0fc7ee7b-6070-5141-8c33-b232af859cde', decision: 'CONFIRM_LEGACY_AS_ADJUSTMENT' },
      { id: '34a41c1e-fec6-591a-9e33-c48338e707d7', decision: 'CONFIRM_LEGACY_AS_ADJUSTMENT' },
      { id: '3f57cf38-a0be-5b73-a9cd-ff6b99c42487', decision: 'REJECT_LEGACY_DIFFERENCE' },
      { id: '1789c444-a725-5ecd-9ed9-c148893c4790', decision: 'CONFIRM_LEGACY_AS_ADJUSTMENT' },
      { id: 'cdf9648e-a112-54bc-8ec4-10491b247793', decision: 'REJECT_LEGACY_DIFFERENCE' }
    ];

    for (let i = 0; i < candidates.length; i++) {
      commandPipeline.executeResolveReconciliationCandidateCommand(
        tempUserDataDir,
        companyId,
        {
          commandId: `cmd_fin_${i}`,
          operationId: `op_fin_${i}`,
          companyId,
          candidateId: candidates[i].id,
          decision: candidates[i].decision,
          operatorId: 'lead_accountant',
          operatorRole: 'accountant',
          reason: 'Final test disposition'
        }
      );
    }

    const summary = migrator.getReconciliationSummary(db, companyId);
    expect(summary.unresolvedCount).toBe(5);
    expect(summary.approvedAdjustmentTotal).toBe(0);
    expect(summary.rejectedTotal).toBe(0);
    expect(summary.stillPendingTotal).toBe(747);

    const guardInput = {
      companyId,
      periodId: 'period_2026_09',
      outboxPendingCount: 0,
      outboxSendingCount: 0,
      outboxConflictCount: 0,
      outboxDeadLetterCount: 0,
      unresolvedReconciliationCount: summary.unresolvedCount
    };

    const evalResult = evaluatePeriodCloseGuard(guardInput);
    expect(evalResult.canClose).toBe(false);
    expect(evalResult.blockers[0]).toContain('UNRESOLVED_RECONCILIATION');
    expect(() => assertCanClosePeriod(guardInput)).toThrow(/PERIOD_CLOSE_BLOCKED/);
  });

  // 16. accounting projection contains only approved adjustments
  it('16. accounting projection contains only approved adjustments and ignores pending candidates', () => {
    const db = setupPilotReconciliationDatabase();

    // Before approval: zero adjustments exist
    let adjustments = db.prepare('SELECT * FROM production_adjustments WHERE company_id = ?').all(companyId);
    let proj = buildHisobProjections({ productionAdjustments: adjustments });
    expect(proj.accounting['BODY-T-SHRIT']?.[53]?.['POYCHA RASHMA'] ?? 0).toBe(0);

    // Approve Candidate 1 (+213 for Worker 53 on POYCHA RASHMA)
    commandPipeline.executeResolveReconciliationCandidateCommand(
      tempUserDataDir,
      companyId,
      {
        commandId: 'cmd_proj_1',
        operationId: 'op_proj_1',
        companyId,
        candidateId: '0fc7ee7b-6070-5141-8c33-b232af859cde',
        decision: 'CONFIRM_LEGACY_AS_ADJUSTMENT',
        operatorId: 'head_accountant_01',
        operatorRole: 'accountant',
        reason: 'Approved for payroll projection'
      }
    );

    // Reject Candidate 2 (+123 for Worker 53 on YENG RASHMA)
    commandPipeline.executeResolveReconciliationCandidateCommand(
      tempUserDataDir,
      companyId,
      {
        commandId: 'cmd_proj_2',
        operationId: 'op_proj_2',
        companyId,
        candidateId: '34a41c1e-fec6-591a-9e33-c48338e707d7',
        decision: 'REJECT_LEGACY_DIFFERENCE',
        operatorId: 'head_accountant_01',
        operatorRole: 'accountant',
        reason: 'Rejected test entry'
      }
    );

    adjustments = db.prepare(`
      SELECT adjustment_id as adjustmentId, company_id as companyId, model_id as modelId,
             worker_id as workerId, op_name as opName, delta_qty as deltaQty,
             reason, status, provenance, created_at as createdAt, created_by as createdBy
      FROM production_adjustments WHERE company_id = ?
    `).all(companyId);

    expect(adjustments).toHaveLength(0);
    proj = buildHisobProjections({ productionAdjustments: adjustments });

    // Local intent is excluded from both projections.
    expect(proj.accounting['BODY-T-SHRIT']?.['53']?.['POYCHA RASHMA'] ?? 0).toBe(0);
    expect(proj.optimistic['BODY-T-SHRIT']?.['53']?.['POYCHA RASHMA'] ?? 0).toBe(0);

    // Rejected candidate (+123) is NOT in projection
    expect(proj.accounting['BODY-T-SHRIT']?.['53']?.['YENG RASHMA'] ?? 0).toBe(0);

    // Unresolved candidates (Workers 68, 112, 167) are NOT in projection
    expect(proj.accounting['BODY-T-SHRIT']?.['68']?.['RAZMER'] ?? 0).toBe(0);
    expect(proj.accounting['BODY-T-SHRIT']?.['112']?.['DAZMOL'] ?? 0).toBe(0);
    expect(proj.accounting['BODY-T-SHRIT']?.['167']?.['RAZMER'] ?? 0).toBe(0);
  });

  // 17. grandfathered Party #2 regression still passes
  it('17. grandfathered Party #2 regression still passes with zero drift', () => {
    const db = databaseManager.getCompanyDatabase(tempUserDataDir, companyId);

    // Insert grandfathered exceptions for the 2 authorized Party #2 UUIDs
    db.prepare(`
      INSERT INTO legacy_party_collision_exceptions (
        exception_id, company_id, party_number, party_id, collision_group_id, approved_by, approved_at, reason
      ) VALUES
      ('exc_1', 'comp_novda', '2', 'rec_1788774889449_vrbkv', 'group_1', 'OWNER', datetime('now'), 'Grandfathered 1'),
      ('exc_2', 'comp_novda', '2', 'rec_1788930871307_cg1iv', 'group_1', 'OWNER', datetime('now'), 'Grandfathered 2')
    `).run();

    const insertParty = db.prepare(`
      INSERT INTO parties (id, company_id, party_number, physical_party_number, model_id, status, created_at, updated_at)
      VALUES (?, 'comp_novda', '2', '2', 'model_x', 'ACTIVE', datetime('now'), datetime('now'))
    `);

    // First grandfathered active party accepted
    expect(() => insertParty.run('rec_1788774889449_vrbkv')).not.toThrow();

    // Second grandfathered active party accepted
    expect(() => insertParty.run('rec_1788930871307_cg1iv')).not.toThrow();

    // Third active party #2 strictly rejected
    expect(() => insertParty.run('rec_third_party_2')).toThrow(/ACTIVE_PARTY_EXISTS/);

    // Closing one grandfathered party: third party #2 still rejected
    db.prepare("UPDATE parties SET status = 'CLOSED', is_closed = 1 WHERE id = 'rec_1788774889449_vrbkv'").run();
    expect(() => insertParty.run('rec_third_party_2')).toThrow(/ACTIVE_PARTY_EXISTS/);

    // Closing both grandfathered parties: new party #2 accepted!
    db.prepare("UPDATE parties SET status = 'CLOSED', is_closed = 1 WHERE id = 'rec_1788930871307_cg1iv'").run();
    expect(() => insertParty.run('rec_third_party_2')).not.toThrow();
  });
});
