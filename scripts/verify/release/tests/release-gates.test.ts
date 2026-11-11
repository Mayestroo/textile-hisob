import { describe, expect, it } from 'vitest';
const { CRITERIA, evaluateRelease } = require('../release-gates.cjs');
const evidence = () => Object.keys(CRITERIA).map(id => ({ id, status: 'PASS', sourceFingerprint: 'current', artifacts: [{ path: 'receipt', sha256: 'proof' }] }));
describe('objective fail-closed release criteria', () => {
  it('requires every gate, even when all automated tests are green', () => {
    expect(evaluateRelease([], 'current').verdict).toBe('NOT READY');
    const records = evidence(); records.find(record => record.id === 'installerUpgradeRollback')!.status = 'BLOCKED';
    expect(evaluateRelease(records, 'current', () => true).verdict).toBe('NOT READY');
  });
  it('rejects stale code evidence, changed or absent artifacts, duplicate and unknown gates', () => {
    expect(evaluateRelease(evidence(), 'new-source', () => true).gates.every((gate: any) => gate.reason === 'STALE_SOURCE_EVIDENCE')).toBe(true);
    expect(evaluateRelease(evidence(), 'current', () => false).verdict).toBe('NOT READY');
    const records = evidence(); records[0].artifacts = [];
    expect(evaluateRelease(records, 'current', () => true).verdict).toBe('NOT READY');
    expect(() => evaluateRelease([...evidence(), evidence()[0]], 'current')).toThrow('DUPLICATE_RELEASE_GATE');
    expect(() => evaluateRelease([{ id: 'pretend' }], 'current')).toThrow('UNKNOWN_RELEASE_GATE');
  });
  it('passes only complete, current, artifact-backed evidence', () => {
    expect(evaluateRelease(evidence(), 'current', () => true).verdict).toBe('READY');
  });
});
