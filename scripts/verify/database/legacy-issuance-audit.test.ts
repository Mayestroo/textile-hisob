import { describe, expect, it } from 'vitest';
const { classifyCandidate } = require('./legacy-issuance-audit.cjs');

const base = { companyId: 'c1', ticketId: 't1', partyRecordId: 'p1', pattaNumber: 4 };
const proof = { companyId: 'c1', partyRecordId: 'p1', ticketId: 't1', pattaNumber: 4,
  operationId: 'op-i', payloadHash: 'a'.repeat(64), receiptReference: 'receipt-i', receiptPayloadHash: 'a'.repeat(64) };

describe('legacy issuance evidence classification', () => {
  it('verifies only one exact immutable tenant-scoped receipt-bound issuance', () => {
    expect(classifyCandidate({ ...base, issuanceEvidence: [proof] }).classification).toBe('VERIFIED');
  });
  it('leaves candidates without issuance evidence missing', () => {
    expect(classifyCandidate({ ...base, issuanceEvidence: [] }).classification).toBe('MISSING_EVIDENCE');
  });
  it('marks cross-tenant evidence ambiguous', () => {
    const result = classifyCandidate({ ...base, issuanceEvidence: [{ ...proof, companyId: 'c2' }] });
    expect(result.classification).toBe('AMBIGUOUS');
    expect(result.reasons).toContain('CROSS_TENANT_EVIDENCE');
  });
  it('marks patta/party identity mismatch ambiguous', () => {
    const result = classifyCandidate({ ...base, issuanceEvidence: [{ ...proof, pattaNumber: 5 }] });
    expect(result.classification).toBe('AMBIGUOUS');
    expect(result.reasons).toContain('ISSUANCE_IDENTITY_MISMATCH');
  });
  it('marks duplicate references ambiguous rather than choosing one', () => {
    expect(classifyCandidate({ ...base, issuanceEvidence: [proof, proof] }).classification).toBe('AMBIGUOUS');
  });
  it('is replay-stable for the same sole authoritative receipt', () => {
    const first = classifyCandidate({ ...base, issuanceEvidence: [proof] });
    const replay = classifyCandidate({ ...base, issuanceEvidence: [proof] });
    expect(replay).toEqual(first);
  });
});
