import { describe, expect, it } from 'vitest';
import { processSingleOperation } from './modules/sync/handlers/operations.cjs';
import { canonicalStringify, computePayloadHash } from './modules/sync/canonicalPayload.cjs';

function makePool(queryLog: string[]) {
  return {
    connect: async () => ({
      query: async (sql: string) => {
        queryLog.push(String(sql));
        if (String(sql).includes('operations_dedup')) return { rows: [] };
        return { rows: [] };
      },
      release: () => undefined
    })
  } as any;
}

describe('reconciliation authority boundary', () => {
  it('rejects a spoofed client role before any reconciliation mutation', async () => {
    const queries: string[] = [];
    const payload = {
      commandId: 'cmd_spoof_role',
      operationId: 'op_spoof_role',
      companyId: 'company-auth-test',
      candidateId: 'candidate-1',
      decision: 'CONFIRM_LEGACY_AS_ADJUSTMENT',
      operatorId: 'attacker',
      operatorRole: 'admin',
      reason: 'spoofed role'
    };

    const result = await processSingleOperation(
      makePool(queries),
      {
        auth: {
          companyId: 'company-auth-test',
          deviceId: 'device-1'
        }
      },
      {
        operationId: payload.operationId,
        companyId: payload.companyId,
        commandType: 'ResolveMigrationReconciliationCandidate',
        entityType: 'reconciliation_candidate',
        entityId: payload.candidateId,
        payload,
        payloadHash: computePayloadHash(canonicalStringify(payload))
      }
    );

    expect(result.status).toBe('REJECTED');
    expect(result.error.code).toBe('RECONCILIATION_RBAC_BLOCKED');
    expect(queries.some((query) => /^\s*(INSERT|UPDATE|DELETE)/i.test(query))).toBe(false);
  });

  it('does not treat company and device authentication as trusted operator identity', async () => {
    const queries: string[] = [];
    const payload = {
      operationId: 'op_device_only',
      companyId: 'company-auth-test',
      candidateId: 'candidate-1',
      decision: 'REJECT_LEGACY_DIFFERENCE',
      operatorId: 'claimed-accountant',
      operatorRole: 'accountant',
      reason: 'device-only request'
    };

    const result = await processSingleOperation(
      makePool(queries),
      { auth: { companyId: payload.companyId, deviceId: 'device-1' } },
      {
        operationId: payload.operationId,
        companyId: payload.companyId,
        commandType: 'ResolveMigrationReconciliationCandidate',
        entityType: 'reconciliation_candidate',
        entityId: payload.candidateId,
        payload,
        payloadHash: computePayloadHash(canonicalStringify(payload))
      }
    );

    expect(result.error.code).toBe('RECONCILIATION_RBAC_BLOCKED');
    expect(queries.filter((query) => /migration_reconciliation|production_adjustments/i.test(query))).toHaveLength(0);
  });

  it('uses the authenticated operator context and never trusts a client operator claim', async () => {
    const queries: string[] = [];
    const payload = {
      commandId: 'cmd_operator_claim',
      operationId: 'op_operator_claim',
      companyId: 'company-auth-test',
      candidateId: 'candidate-1',
      decision: 'DEFER_REVIEW',
      operatorId: 'attacker',
      operatorRole: 'admin',
      reason: 'spoofed operator'
    };

    const result = await processSingleOperation(
      makePool(queries),
      {
        auth: {
          companyId: 'company-auth-test',
          deviceId: 'device-1',
          operator: {
            operatorId: 'trusted-operator',
            companyId: 'company-auth-test',
            deviceId: 'device-1',
            role: 'admin',
            isActive: true
          }
        }
      },
      {
        operationId: payload.operationId,
        companyId: payload.companyId,
        commandType: 'ResolveMigrationReconciliationCandidate',
        entityType: 'reconciliation_candidate',
        entityId: payload.candidateId,
        payload,
        payloadHash: computePayloadHash(canonicalStringify(payload))
      }
    );

    expect(result.status).toBe('REJECTED');
    expect(result.error.code).toBe('OPERATOR_INTENT_MISMATCH');
    expect(queries.some((query) => /^\s*(INSERT|UPDATE|DELETE)/i.test(query))).toBe(false);
  });

  it('permits a trusted reconciliation context to reach the transactional reference check', async () => {
    const queries: string[] = [];
    const payload = {
      commandId: 'cmd_trusted_operator',
      operationId: 'op_trusted_operator',
      companyId: 'company-auth-test',
      candidateId: 'candidate-1',
      decision: 'DEFER_REVIEW',
      reason: 'trusted review'
    };

    const result = await processSingleOperation(
      makePool(queries),
      {
        auth: {
          companyId: 'company-auth-test',
          deviceId: 'device-1',
          operator: {
            operatorId: 'trusted-operator',
            companyId: 'company-auth-test',
            deviceId: 'device-1',
            role: 'accountant',
            isActive: true
          }
        }
      },
      {
        operationId: payload.operationId,
        companyId: payload.companyId,
        commandType: 'ResolveMigrationReconciliationCandidate',
        entityType: 'reconciliation_candidate',
        entityId: payload.candidateId,
        payload,
        payloadHash: computePayloadHash(canonicalStringify(payload))
      }
    );

    expect(result.error.code).toBe('CANDIDATE_NOT_FOUND');
    expect(queries.some((query) => /migration_reconciliation_candidates/i.test(query))).toBe(true);
    expect(queries.some((query) => /^\s*(INSERT|UPDATE|DELETE)/i.test(query))).toBe(false);
  });
});
