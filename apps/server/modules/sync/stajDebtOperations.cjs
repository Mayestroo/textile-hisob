'use strict';

const crypto = require('node:crypto');
const { planStajAllocation, toMinorUnits, fromMinorUnits } = require('../../../../packages/domain/stajDebtLedger.cjs');
const { appendChange } = require('./workbookOperations.cjs');
const { loadPayroll } = require('../workers/payrollValuation.cjs');

function error(code, message, statusCode = 409) {
  const value = Object.assign(new Error(message), { code, statusCode });
  value[Symbol.for('hisob.sync.applicationError')] = true;
  return value;
}

function requireReviewer(req, companyId) {
  const operator = req.auth?.operator;
  if (!operator || !operator.isActive || operator.companyId !== companyId
      || !['admin', 'accountant'].includes(String(operator.role).toLowerCase())) {
    throw error('STAJ_DEBT_UNAUTHORIZED', 'Active company accountant/admin operator session required', 403);
  }
  return operator;
}

async function executeStajDebtCommand(client, companyId, operationId, commandType, payload, req) {
  const actor = requireReviewer(req, companyId);
  const now = new Date().toISOString();
  let eventPayload;

  if (commandType === 'RegisterStajDebt') {
    const worker = await client.query('SELECT id FROM workers WHERE company_id=$1 AND id=$2 FOR SHARE', [companyId, payload.workerId]);
    if (!worker.rows.length) throw error('WORKER_NOT_FOUND', 'Worker does not exist in authenticated company', 404);
    await client.query(`INSERT INTO staj_debt_claims
      (company_id,debt_id,worker_id,original_amount,evidence_reference,evidence_sha256,verification_note,verified_by,registered_operation_id,created_at)
      VALUES($1,$2,$3,$4::numeric,$5,$6,$7,$8,$9,$10)`,
    [companyId,payload.debtId,payload.workerId,payload.amount,payload.evidenceReference,payload.evidenceSha256,
      payload.verificationNote,actor.operatorId,operationId,now]);
    eventPayload = { eventType: 'CLAIM_REGISTERED', debtId: payload.debtId, workerId: payload.workerId,
      amount: payload.amount, evidenceReference: payload.evidenceReference, evidenceSha256: payload.evidenceSha256,
      verificationNote: payload.verificationNote, verifiedBy: actor.operatorId };
  } else if (commandType === 'AllocateStajDebt') {
    const claimResult = await client.query(`SELECT debt_id,worker_id,original_amount::text AS original_amount
      FROM staj_debt_claims WHERE company_id=$1 AND debt_id=$2 FOR UPDATE`, [companyId,payload.debtId]);
    const claim = claimResult.rows[0];
    if (!claim) throw error('STAJ_DEBT_NOT_FOUND', 'Verified debt claim was not found', 404);
    const periodResult = await client.query(`SELECT id FROM periods WHERE company_id=$1 AND id=$2 AND is_closed=0 FOR UPDATE`,
      [companyId,payload.periodId]);
    if (!periodResult.rows.length) throw error('PERIOD_NOT_OPEN', 'Debt allocation requires an open company period');
    const prior = await client.query(`SELECT event_id,operation_id,event_type,amount::text,period_id,actor_id,reason
      FROM staj_debt_events WHERE company_id=$1 AND debt_id=$2
        AND event_type IN ('DEDUCTION','DEFICIT_REVIEW') ORDER BY created_at,event_id`, [companyId,payload.debtId]);
    if (prior.rows.length) throw error('STAJ_DEBT_ALREADY_ATTEMPTED', 'This debt already has a one-time deduction attempt; remaining balance requires explicit review');
    const workerResult = await client.query('SELECT id AS worker_id,name AS worker_name,staj FROM workers WHERE company_id=$1 AND id=$2',
      [companyId,claim.worker_id]);
    const payroll = await loadPayroll(client, companyId, payload.periodId, workerResult.rows[0]);
    const payrollWorker = payroll.workers.find(row => Number(row.workerId) === Number(claim.worker_id));
    if (!payrollWorker || payrollWorker.accountingReasons.some(reason => reason.startsWith('UNKNOWN_')
      || reason === 'CLOSED_TARIFF_UNAVAILABLE' || reason === 'LEGACY_STAJ_REQUIRES_RECONCILIATION')) {
      throw error('STAJ_PAYABLE_EARNINGS_UNVERIFIED', 'Exact payable earnings are incomplete; debt cannot be allocated');
    }
    // The source payroll is server-read in this transaction; convert its value
    // at the currency's 0.01 precision before invoking the exact integer planner.
    const availableEarnings = Math.max(0, Number(payrollWorker.net) || 0).toFixed(2);
    const plan = planStajAllocation({ companyId, workerId: claim.worker_id, periodId: payload.periodId,
      claimId: payload.debtId, claimAmount: claim.original_amount, availableEarnings, operationId });
    const amountMinor = toMinorUnits(plan.allocation.amount);
    let deductionEventId = null;
    let reviewEventId = null;
    if (amountMinor > 0n) {
      deductionEventId = crypto.randomUUID();
      await client.query(`INSERT INTO staj_debt_events
        (event_id,company_id,debt_id,operation_id,event_type,amount,period_id,actor_id,reason,created_at)
        VALUES($1,$2,$3,$4,'DEDUCTION',$5::numeric,$6,$7,$8,$9)`,
      [deductionEventId,companyId,payload.debtId,operationId,plan.allocation.amount,payload.periodId,actor.operatorId,
        'STAJ-001 one-time allocation',now]);
    }
    const deficitMinor = toMinorUnits(plan.allocation.deficit);
    if (deficitMinor > 0n) {
      reviewEventId = crypto.randomUUID();
      await client.query(`INSERT INTO staj_debt_events
        (event_id,company_id,debt_id,operation_id,event_type,amount,actor_id,reason,created_at)
        VALUES($1,$2,$3,$4,'DEFICIT_REVIEW',$5::numeric,$6,$7,$8)`,
      [reviewEventId,companyId,payload.debtId,operationId,plan.allocation.deficit,actor.operatorId,
        'Unpaid debt remainder requires explicit manager review; no next-period auto-deduction',now]);
    }
    eventPayload = { eventType: 'DEDUCTION_ATTEMPT', debtId: payload.debtId, workerId: Number(claim.worker_id),
      periodId: payload.periodId, deductedAmount: plan.allocation.amount, deficit: plan.allocation.deficit,
      state: plan.allocation.status, deductionEventId, reviewEventId, actorId: actor.operatorId };
  } else if (commandType === 'ReverseStajDebtAllocation') {
    const claim = await client.query('SELECT debt_id FROM staj_debt_claims WHERE company_id=$1 AND debt_id=$2 FOR UPDATE',
      [companyId,payload.debtId]);
    if (!claim.rows.length) throw error('STAJ_DEBT_NOT_FOUND', 'Verified debt claim was not found', 404);
    const source = await client.query(`SELECT event_id,amount::text AS amount FROM staj_debt_events
      WHERE company_id=$1 AND debt_id=$2 AND event_id=$3 AND event_type='DEDUCTION' FOR UPDATE`,
    [companyId,payload.debtId,payload.deductionEventId]);
    if (!source.rows.length) throw error('STAJ_DEDUCTION_NOT_FOUND', 'Original deduction event was not found', 404);
    await client.query(`INSERT INTO staj_debt_events
      (event_id,company_id,debt_id,operation_id,event_type,amount,reverses_event_id,actor_id,reason,created_at)
      VALUES($1,$2,$3,$4,'REVERSAL',$5::numeric,$6,$7,$8,$9)`,
    [crypto.randomUUID(),companyId,payload.debtId,operationId,source.rows[0].amount,payload.deductionEventId,
      actor.operatorId,payload.reason,now]);
    const reversalId = (await client.query(`SELECT event_id FROM staj_debt_events WHERE company_id=$1 AND operation_id=$2 AND event_type='REVERSAL'`,
      [companyId,operationId])).rows[0].event_id;
    eventPayload = { eventType: 'DEDUCTION_REVERSED', debtId: payload.debtId,
      reversalEventId: reversalId, deductionEventId: payload.deductionEventId,
      amount: source.rows[0].amount, actorId: actor.operatorId, reason: payload.reason };
  } else throw error('UNKNOWN_COMMAND', `Unsupported STAJ debt command: ${commandType}`, 400);

  const revisionResult = await client.query(`SELECT COUNT(*)::integer + 1 AS revision FROM change_log
    WHERE company_id=$1 AND entity_type='staj_debt' AND entity_id=$2`, [companyId,payload.debtId]);
  const serverRevision = revisionResult.rows[0].revision;
  const change = await appendChange(client, companyId, 'staj_debt', payload.debtId, serverRevision, operationId,
    'INSERT', eventPayload, now);
  return { serverRevision, entityId: payload.debtId, changeId: change.rows[0].change_id, committedAt: change.rows[0].committed_at };
}

async function getDebtHistory(pool, companyId, debtId) {
  const claims = await pool.query(`SELECT debt_id AS "debtId",worker_id AS "workerId",original_amount::text AS "originalAmount",
      evidence_reference AS "evidenceReference",evidence_sha256 AS "evidenceSha256",verification_note AS "verificationNote",
      verified_by AS "verifiedBy",created_at AS "createdAt"
    FROM staj_debt_claims WHERE company_id=$1 AND debt_id=$2`, [companyId,debtId]);
  if (!claims.rows.length) throw error('STAJ_DEBT_NOT_FOUND', 'Verified debt claim was not found', 404);
  const events = await pool.query(`SELECT event_id AS "eventId",operation_id AS "operationId",event_type AS "eventType",
      amount::text,period_id AS "periodId",reverses_event_id AS "reversesEventId",actor_id AS "actorId",reason,created_at AS "createdAt"
    FROM staj_debt_events WHERE company_id=$1 AND debt_id=$2 ORDER BY created_at,event_id`, [companyId,debtId]);
  const totals = await pool.query(`SELECT c.original_amount::text AS original,
      COALESCE(SUM(CASE WHEN e.event_type='DEDUCTION' THEN e.amount WHEN e.event_type='REVERSAL' THEN -e.amount ELSE 0 END),0)::text AS allocated,
      COALESCE(SUM(e.amount) FILTER (WHERE e.event_type='DEFICIT_REVIEW'),0)::text AS review
    FROM staj_debt_claims c LEFT JOIN staj_debt_events e ON e.company_id=c.company_id AND e.debt_id=c.debt_id
    WHERE c.company_id=$1 AND c.debt_id=$2 GROUP BY c.original_amount`, [companyId,debtId]);
  const totalsRow = totals.rows[0];
  const original = toMinorUnits(totalsRow.original), allocated = toMinorUnits(totalsRow.allocated), review = toMinorUnits(totalsRow.review);
  return { claim: claims.rows[0], events: events.rows,
    remainingBalance: fromMinorUnits(original - allocated), reviewRequired: review > 0n,
    reviewBalance: fromMinorUnits(review) };
}

async function listDebtReviews(pool, companyId) {
  const result = await pool.query(`SELECT c.debt_id AS "debtId",c.worker_id AS "workerId",e.amount::text AS amount,
      e.period_id AS "periodId",e.operation_id AS "operationId",e.reason,e.created_at AS "createdAt"
    FROM staj_debt_events e JOIN staj_debt_claims c ON c.company_id=e.company_id AND c.debt_id=e.debt_id
    WHERE e.company_id=$1 AND e.event_type='DEFICIT_REVIEW'
      AND NOT EXISTS (SELECT 1 FROM staj_debt_events r WHERE r.company_id=e.company_id AND r.debt_id=e.debt_id
        AND r.event_type='REVERSAL' AND r.reverses_event_id=e.event_id)
    ORDER BY e.created_at,e.event_id`, [companyId]);
  return result.rows;
}

module.exports = { executeStajDebtCommand, getDebtHistory, listDebtReviews, requireReviewer };
