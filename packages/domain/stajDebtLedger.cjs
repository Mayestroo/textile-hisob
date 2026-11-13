'use strict';

// Exact minor-unit helpers for STAJ debt claims. Values are decimal UZS strings
// at persistence boundaries; legacy worker.staj is never a verified claim.
function toMinorUnits(value) {
  const text = String(value ?? '').trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new Error('INVALID_MONEY_AMOUNT');
  const amount = BigInt(match[2]) * 100n + BigInt((match[3] || '').padEnd(2, '0'));
  return match[1] ? -amount : amount;
}

function fromMinorUnits(value) {
  const amount = BigInt(value);
  const sign = amount < 0n ? '-' : '';
  const absolute = amount < 0n ? -amount : amount;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

function planStajAllocation({ companyId, workerId, periodId, claimId, claimAmount, availableEarnings, operationId, priorAllocations = [] }) {
  for (const [key, value] of Object.entries({ companyId, periodId, claimId, operationId })) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`INVALID_${key.toUpperCase()}`);
  }
  if (!Number.isSafeInteger(Number(workerId)) || Number(workerId) <= 0) throw new Error('INVALID_WORKER_ID');
  const claim = toMinorUnits(claimAmount);
  const earnings = toMinorUnits(availableEarnings);
  if (claim <= 0n || earnings < 0n) throw new Error('INVALID_STAJ_ALLOCATION_AMOUNT');
  const matching = priorAllocations.filter(row => row.companyId === companyId && row.claimId === claimId);
  const replay = matching.find(row => row.operationId === operationId);
  if (replay) return { replay: true, allocation: replay };
  if (matching.some(row => row.workerId !== Number(workerId))) throw new Error('STAJ_CLAIM_WORKER_CONFLICT');
  if (matching.some(row => row.status !== 'REVERSED')) throw new Error('STAJ_CLAIM_ALREADY_ALLOCATED');
  const amount = claim < earnings ? claim : earnings;
  return { replay: false, allocation: { companyId, workerId: Number(workerId), periodId, claimId, operationId,
    amount: fromMinorUnits(amount), deficit: fromMinorUnits(claim - amount), status: amount === claim ? 'SETTLED' : 'REVIEW_REQUIRED' } };
}

function classifyLegacyStaj(value) {
  const amount = toMinorUnits(value);
  return { amount: fromMinorUnits(amount), classification: amount === 0n ? 'NO_RECORDED_LEGACY_VALUE' : 'RECONCILIATION_REQUIRED',
    deductionEligible: false, reason: amount === 0n ? 'NO_LEGACY_AMOUNT' : 'LEGACY_STAJ_NOT_INDEPENDENTLY_VERIFIED' };
}

module.exports = { toMinorUnits, fromMinorUnits, planStajAllocation, classifyLegacyStaj };
