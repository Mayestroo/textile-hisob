import { describe, it, expect } from 'vitest';
import {
  buildHisobProjections,
  getOptimisticQuantity,
  getAccountingQuantity,
  getOperationBreakdown,
  normalizeLegacyTicket,
  ProjectionValidationError,
  TicketFact
} from './projections';
import {
  createProductionAdjustmentDraft,
  createReversalAdjustment,
  convertCandidateToAdjustmentFact,
  ProductionAdjustmentFact
} from './productionAdjustment';

// Helpers to construct clean mock facts
function makeTicket(
  ticketId: string,
  modelId: string,
  workerId: number | string,
  opName: string,
  qty: number,
  status: TicketFact['status'] = 'CONFIRMED'
): TicketFact {
  return {
    ticketId,
    modelId,
    qty,
    status,
    entries: [{ workerId, opName, rateSnapshot: 500 }]
  };
}

function makeAdjustment(
  adjustmentId: string,
  modelId: string,
  workerId: number | string,
  opName: string,
  deltaQty: number,
  status: ProductionAdjustmentFact['status'] = 'APPROVED',
  originalAdjustmentId?: string
): ProductionAdjustmentFact {
  return {
    adjustmentId,
    companyId: 'test-co',
    modelId,
    workerId,
    opName,
    deltaQty,
    reason: 'Test adjustment',
    status,
    provenance: 'TEST',
    createdAt: '2026-09-19T12:00:00.000Z',
    createdBy: 'test-admin',
    originalAdjustmentId
  };
}

describe('Pure Dual Projections Engine (Phase 2 — Step 2)', () => {
  // Test 1 & 2: CONFIRMED ticket appears in optimistic & accounting
  it('1. CONFIRMED ticket appears in optimistic projection', () => {
    const ticket = makeTicket('t-1', 'm-1', 101, 'tikish', 50, 'CONFIRMED');
    const res = buildHisobProjections({ tickets: [ticket] });
    expect(getOptimisticQuantity(res, 'm-1', 101, 'tikish')).toBe(50);
  });

  it('2. CONFIRMED ticket appears in accounting projection', () => {
    const ticket = makeTicket('t-1', 'm-1', 101, 'tikish', 50, 'CONFIRMED');
    const res = buildHisobProjections({ tickets: [ticket] });
    expect(getAccountingQuantity(res, 'm-1', 101, 'tikish')).toBe(50);
  });

  // Test 3 & 4: PENDING_SYNC appears in optimistic, absent from accounting
  it('3. PENDING_SYNC appears in optimistic projection', () => {
    const ticket = makeTicket('t-pending', 'm-1', 101, 'bichish', 40, 'PENDING_SYNC');
    const res = buildHisobProjections({ tickets: [ticket] });
    expect(getOptimisticQuantity(res, 'm-1', 101, 'bichish')).toBe(40);
  });

  it('4. PENDING_SYNC is absent from accounting projection', () => {
    const ticket = makeTicket('t-pending', 'm-1', 101, 'bichish', 40, 'PENDING_SYNC');
    const res = buildHisobProjections({ tickets: [ticket] });
    expect(getAccountingQuantity(res, 'm-1', 101, 'bichish')).toBe(0);
    expect(res.accounting['m-1']?.[101]?.['bichish']).toBe(0);
  });

  // Test 5, 6, 7: CONFLICT, REJECTED, VOIDED absent from both
  it('5. CONFLICT absent from both optimistic and accounting projections', () => {
    const ticket = makeTicket('t-conflict', 'm-1', 101, 'dazmol', 25, 'CONFLICT');
    const res = buildHisobProjections({ tickets: [ticket] });
    expect(getOptimisticQuantity(res, 'm-1', 101, 'dazmol')).toBe(0);
    expect(getAccountingQuantity(res, 'm-1', 101, 'dazmol')).toBe(0);
    expect(res.optimistic['m-1']).toBeUndefined();
    expect(res.accounting['m-1']).toBeUndefined();
  });

  it('6. REJECTED absent from both optimistic and accounting projections', () => {
    const ticket = makeTicket('t-rejected', 'm-1', 101, 'dazmol', 25, 'REJECTED');
    const res = buildHisobProjections({ tickets: [ticket] });
    expect(getOptimisticQuantity(res, 'm-1', 101, 'dazmol')).toBe(0);
    expect(getAccountingQuantity(res, 'm-1', 101, 'dazmol')).toBe(0);
  });

  it('7. VOIDED absent from both optimistic and accounting projections', () => {
    const ticket = makeTicket('t-voided', 'm-1', 101, 'dazmol', 25, 'VOIDED');
    const res = buildHisobProjections({ tickets: [ticket] });
    expect(getOptimisticQuantity(res, 'm-1', 101, 'dazmol')).toBe(0);
    expect(getAccountingQuantity(res, 'm-1', 101, 'dazmol')).toBe(0);
  });

  // Test 8, 9, 10: APPROVED vs PENDING_REVIEW adjustments
  it('8. APPROVED adjustment appears in optimistic projection', () => {
    const adj = makeAdjustment('adj-1', 'm-1', 102, 'tugma', 15, 'APPROVED');
    const res = buildHisobProjections({ productionAdjustments: [adj] });
    expect(getOptimisticQuantity(res, 'm-1', 102, 'tugma')).toBe(15);
  });

  it('9. APPROVED adjustment appears in accounting projection', () => {
    const adj = makeAdjustment('adj-1', 'm-1', 102, 'tugma', 15, 'APPROVED');
    const res = buildHisobProjections({ productionAdjustments: [adj] });
    expect(getAccountingQuantity(res, 'm-1', 102, 'tugma')).toBe(15);
  });

  it('10. PENDING_REVIEW adjustment absent from both projections', () => {
    const adj = makeAdjustment('adj-pending', 'm-1', 102, 'tugma', 15, 'PENDING_REVIEW');
    const res = buildHisobProjections({ productionAdjustments: [adj] });
    expect(getOptimisticQuantity(res, 'm-1', 102, 'tugma')).toBe(0);
    expect(getAccountingQuantity(res, 'm-1', 102, 'tugma')).toBe(0);
  });

  // Test 11: Reversal nets correctly
  it('11. reversed adjustment nets correctly', () => {
    // Paradigm A: Immutable reversal fact with inverse delta
    const orig = makeAdjustment('adj-orig', 'm-1', 103, 'petlya', 20, 'APPROVED');
    const rev = createReversalAdjustment(orig, { createdBy: 'supervisor' });
    expect(rev.deltaQty).toBe(-20);
    expect(rev.originalAdjustmentId).toBe('adj-orig');

    const resA = buildHisobProjections({ productionAdjustments: [orig, rev] });
    expect(getOptimisticQuantity(resA, 'm-1', 103, 'petlya')).toBe(0);
    expect(getAccountingQuantity(resA, 'm-1', 103, 'petlya')).toBe(0);

    // Paradigm B: Status update to REVERSED excludes fact
    const reversedOrig: ProductionAdjustmentFact = { ...orig, status: 'REVERSED' };
    const resB = buildHisobProjections({ productionAdjustments: [reversedOrig] });
    expect(getOptimisticQuantity(resB, 'm-1', 103, 'petlya')).toBe(0);
    expect(getAccountingQuantity(resB, 'm-1', 103, 'petlya')).toBe(0);
  });

  // Test 12 & 13: Positive and negative deltas
  it('12. positive delta adds correctly', () => {
    const ticket = makeTicket('t-1', 'm-1', 101, 'tikish', 100, 'CONFIRMED');
    const adj = makeAdjustment('adj-pos', 'm-1', 101, 'tikish', 12, 'APPROVED');
    const res = buildHisobProjections({ tickets: [ticket], productionAdjustments: [adj] });
    expect(getOptimisticQuantity(res, 'm-1', 101, 'tikish')).toBe(112);
    expect(getAccountingQuantity(res, 'm-1', 101, 'tikish')).toBe(112);
  });

  it('13. negative delta subtracts correctly without mutating history', () => {
    const ticket = makeTicket('t-1', 'm-1', 101, 'tikish', 100, 'CONFIRMED');
    const adj = makeAdjustment('adj-neg', 'm-1', 101, 'tikish', -7, 'APPROVED');
    const res = buildHisobProjections({ tickets: [ticket], productionAdjustments: [adj] });
    expect(getOptimisticQuantity(res, 'm-1', 101, 'tikish')).toBe(93);
    expect(getAccountingQuantity(res, 'm-1', 101, 'tikish')).toBe(93);
  });

  // Test 14: Same worker/op across multiple tickets sums correctly
  it('14. same worker/op across multiple tickets sums correctly', () => {
    const t1 = makeTicket('t-1', 'm-1', 101, 'tikish', 30, 'CONFIRMED');
    const t2 = makeTicket('t-2', 'm-1', 101, 'tikish', 45, 'CONFIRMED');
    const t3 = makeTicket('t-3', 'm-1', 101, 'tikish', 25, 'PENDING_SYNC');
    const res = buildHisobProjections({ tickets: [t1, t2, t3] });

    expect(getOptimisticQuantity(res, 'm-1', 101, 'tikish')).toBe(100);
    expect(getAccountingQuantity(res, 'm-1', 101, 'tikish')).toBe(75);
  });

  // Test 15: Multiple workers isolated
  it('15. multiple workers isolated', () => {
    const t1 = makeTicket('t-1', 'm-1', 101, 'tikish', 50, 'CONFIRMED');
    const t2 = makeTicket('t-2', 'm-1', 102, 'tikish', 80, 'CONFIRMED');
    const res = buildHisobProjections({ tickets: [t1, t2] });

    expect(getAccountingQuantity(res, 'm-1', 101, 'tikish')).toBe(50);
    expect(getAccountingQuantity(res, 'm-1', 102, 'tikish')).toBe(80);
  });

  // Test 16: Multiple models isolated
  it('16. multiple models isolated', () => {
    const t1 = makeTicket('t-1', 'm-A', 101, 'tikish', 50, 'CONFIRMED');
    const t2 = makeTicket('t-2', 'm-B', 101, 'tikish', 70, 'CONFIRMED');
    const res = buildHisobProjections({ tickets: [t1, t2] });

    expect(getAccountingQuantity(res, 'm-A', 101, 'tikish')).toBe(50);
    expect(getAccountingQuantity(res, 'm-B', 101, 'tikish')).toBe(70);
  });

  // Test 17: Multiple operations isolated
  it('17. multiple operations isolated', () => {
    const t1 = makeTicket('t-1', 'm-1', 101, 'bichish', 50, 'CONFIRMED');
    const t2 = makeTicket('t-2', 'm-1', 101, 'tikish', 60, 'CONFIRMED');
    const res = buildHisobProjections({ tickets: [t1, t2] });

    expect(getAccountingQuantity(res, 'm-1', 101, 'bichish')).toBe(50);
    expect(getAccountingQuantity(res, 'm-1', 101, 'tikish')).toBe(60);
  });

  // Test 18 & 19: pendingQty and confirmedQty breakdowns
  it('18. pendingQty breakdown correct', () => {
    const t1 = makeTicket('t-1', 'm-1', 101, 'tikish', 60, 'CONFIRMED');
    const t2 = makeTicket('t-2', 'm-1', 101, 'tikish', 35, 'PENDING_SYNC');
    const adj = makeAdjustment('adj-1', 'm-1', 101, 'tikish', 5, 'APPROVED');

    const res = buildHisobProjections({ tickets: [t1, t2], productionAdjustments: [adj] });
    const b = getOperationBreakdown(res, 'm-1', 101, 'tikish');

    expect(b.pendingQty).toBe(35);
    expect(b.totalQty).toBe(100);
  });

  it('19. confirmedQty breakdown correct', () => {
    const t1 = makeTicket('t-1', 'm-1', 101, 'tikish', 60, 'CONFIRMED');
    const t2 = makeTicket('t-2', 'm-1', 101, 'tikish', 35, 'PENDING_SYNC');
    const adj = makeAdjustment('adj-1', 'm-1', 101, 'tikish', 5, 'APPROVED');

    const res = buildHisobProjections({ tickets: [t1, t2], productionAdjustments: [adj] });
    const b = getOperationBreakdown(res, 'm-1', 101, 'tikish');

    expect(b.confirmedQty).toBe(60);
    expect(b.adjustmentQty).toBe(5);
    expect(b.accountingQty).toBe(65);
  });

  // Test 20: Migration reconciliation candidate not consumed
  it('20. migration reconciliation candidate not consumed automatically', () => {
    // Candidate artifact from Step 1
    const candidate = {
      candidateId: 'reconcile_cand_1',
      companyId: 'test-co',
      modelId: 'm-1',
      workerId: 101,
      operationName: 'tikish',
      legacyQty: 150,
      ticketDerivedQty: 100,
      deltaQty: 50,
      status: 'PENDING_REVIEW',
      reason: 'Legacy mismatch'
    };

    const ticket = makeTicket('t-1', 'm-1', 101, 'tikish', 100, 'CONFIRMED');

    // Build projection with only tickets (candidate is NOT in productionAdjustments)
    const res = buildHisobProjections({ tickets: [ticket] });
    expect(getAccountingQuantity(res, 'm-1', 101, 'tikish')).toBe(100);
    expect(getOptimisticQuantity(res, 'm-1', 101, 'tikish')).toBe(100);

    // Only after explicit administrative approval does it convert to an adjustment fact
    const approvedAdj = convertCandidateToAdjustmentFact(candidate, {
      approvedBy: 'super-admin',
      notes: 'Verified historical shift log'
    });
    expect(approvedAdj.status).toBe('APPROVED');
    expect(approvedAdj.deltaQty).toBe(50);

    const resAfterApproval = buildHisobProjections({
      tickets: [ticket],
      productionAdjustments: [approvedAdj]
    });
    expect(getAccountingQuantity(resAfterApproval, 'm-1', 101, 'tikish')).toBe(150);
  });

  // Test 21: Input ordering does not affect output
  it('21. input ordering does not affect output (deterministic permutations)', () => {
    const t1 = makeTicket('t-1', 'm-1', 101, 'op-A', 10, 'CONFIRMED');
    const t2 = makeTicket('t-2', 'm-1', 102, 'op-B', 20, 'PENDING_SYNC');
    const t3 = makeTicket('t-3', 'm-2', 101, 'op-A', 30, 'CONFIRMED');
    const adj1 = makeAdjustment('adj-1', 'm-1', 101, 'op-A', 5, 'APPROVED');
    const adj2 = makeAdjustment('adj-2', 'm-2', 101, 'op-A', -4, 'APPROVED');

    const run1 = buildHisobProjections({
      tickets: [t1, t2, t3],
      productionAdjustments: [adj1, adj2]
    });

    const run2 = buildHisobProjections({
      tickets: [t3, t1, t2],
      productionAdjustments: [adj2, adj1]
    });

    const run3 = buildHisobProjections({
      tickets: [t2, t3, t1],
      productionAdjustments: [adj1, adj2]
    });

    expect(JSON.stringify(run1)).toBe(JSON.stringify(run2));
    expect(JSON.stringify(run2)).toBe(JSON.stringify(run3));
  });

  // Test 22 & 23: Duplicate ticket and adjustment ID rejection
  it('22. duplicate ticket ID rejected with ProjectionValidationError', () => {
    const t1 = makeTicket('t-dup', 'm-1', 101, 'tikish', 10, 'CONFIRMED');
    const t2 = makeTicket('t-dup', 'm-1', 101, 'tikish', 10, 'CONFIRMED');

    expect(() => buildHisobProjections({ tickets: [t1, t2] })).toThrowError(
      ProjectionValidationError
    );
    try {
      buildHisobProjections({ tickets: [t1, t2] });
    } catch (e: any) {
      expect(e.code).toBe('DUPLICATE_TICKET_ID');
    }
  });

  it('23. duplicate adjustment ID rejected with ProjectionValidationError', () => {
    const a1 = makeAdjustment('adj-dup', 'm-1', 101, 'tikish', 5, 'APPROVED');
    const a2 = makeAdjustment('adj-dup', 'm-1', 101, 'tikish', 10, 'APPROVED');

    expect(() => buildHisobProjections({ productionAdjustments: [a1, a2] })).toThrowError(
      ProjectionValidationError
    );
    try {
      buildHisobProjections({ productionAdjustments: [a1, a2] });
    } catch (e: any) {
      expect(e.code).toBe('DUPLICATE_ADJUSTMENT_ID');
    }
  });

  // Test 24, 25, 26, 27: Numeric validation rules
  it('24. NaN quantity rejected', () => {
    const badTicket = makeTicket('t-nan', 'm-1', 101, 'tikish', NaN, 'CONFIRMED');
    expect(() => buildHisobProjections({ tickets: [badTicket] })).toThrowError(
      ProjectionValidationError
    );

    const badAdj = makeAdjustment('adj-nan', 'm-1', 101, 'tikish', NaN, 'APPROVED');
    expect(() => buildHisobProjections({ productionAdjustments: [badAdj] })).toThrowError(
      ProjectionValidationError
    );
  });

  it('25. Infinity rejected', () => {
    const badTicket = makeTicket('t-inf', 'm-1', 101, 'tikish', Infinity, 'CONFIRMED');
    expect(() => buildHisobProjections({ tickets: [badTicket] })).toThrowError(
      ProjectionValidationError
    );

    const badAdj = makeAdjustment('adj-inf', 'm-1', 101, 'tikish', -Infinity, 'APPROVED');
    expect(() => buildHisobProjections({ productionAdjustments: [badAdj] })).toThrowError(
      ProjectionValidationError
    );
  });

  it('26. invalid ticket negative qty rejected', () => {
    const negTicket = makeTicket('t-neg', 'm-1', 101, 'tikish', -15, 'CONFIRMED');
    expect(() => buildHisobProjections({ tickets: [negTicket] })).toThrowError(
      ProjectionValidationError
    );
    try {
      buildHisobProjections({ tickets: [negTicket] });
    } catch (e: any) {
      expect(e.code).toBe('INVALID_NEGATIVE_TICKET_QUANTITY');
    }
  });

  it('27. negative adjustment allowed for downward corrections', () => {
    const adjNeg = makeAdjustment('adj-valid-neg', 'm-1', 101, 'tikish', -25, 'APPROVED');
    expect(() => buildHisobProjections({ productionAdjustments: [adjNeg] })).not.toThrow();
    const res = buildHisobProjections({ productionAdjustments: [adjNeg] });
    expect(getAccountingQuantity(res, 'm-1', 101, 'tikish')).toBe(-25);
  });

  // Test 28: Empty input produces empty deterministic projection
  it('28. empty input produces empty deterministic projection', () => {
    const res = buildHisobProjections({});
    expect(res).toEqual({
      optimistic: {},
      accounting: {},
      breakdown: {}
    });
  });

  // Test 29: 10k facts deterministic rebuild
  it('29. 10k facts deterministic rebuild', () => {
    const count = 10000;
    const tickets: TicketFact[] = [];
    for (let i = 0; i < count; i++) {
      const modelIdx = i % 5;
      const workerId = 100 + (i % 20);
      const status: TicketFact['status'] = i % 10 === 0 ? 'PENDING_SYNC' : 'CONFIRMED';
      tickets.push({
        ticketId: `t-${i}`,
        modelId: `m-${modelIdx}`,
        qty: 1,
        status,
        entries: [{ workerId, opName: 'tikish' }]
      });
    }

    const t0 = performance.now();
    const res1 = buildHisobProjections({ tickets });
    const duration = performance.now() - t0;

    // Shuffled copy
    const shuffled = [...tickets].sort(() => 0.5 - Math.random());
    const res2 = buildHisobProjections({ tickets: shuffled });

    expect(JSON.stringify(res1)).toBe(JSON.stringify(res2));
    expect(duration).toBeLessThan(1500); // 10k facts must rebuild rapidly in pure JS
  });

  // Test 30: Real migrated Step 1 fixture produces expected accounting projection
  it('30. real migrated Step 1 fixture produces expected accounting projection', () => {
    // Simulated realistic legacy dataset with tickets and legacy hisob quantities
    const legacyTickets = [
      {
        id: 'legacy_t1',
        modelId: 'model_polo',
        qty: 120,
        partyNumber: '1',
        pattaNumber: 1,
        entries: [
          { workerId: 101, opName: 'Bichish', rateSnapshot: 300 },
          { workerId: 102, opName: 'Tikish', rateSnapshot: 500 }
        ]
      },
      {
        id: 'legacy_t2',
        modelId: 'model_polo',
        qty: 80,
        partyNumber: '1',
        pattaNumber: 2,
        entries: [
          { workerId: 101, opName: 'Bichish', rateSnapshot: 300 },
          { workerId: 103, opName: 'Tikish', rateSnapshot: 500 }
        ]
      }
    ];

    const normalizedTickets = legacyTickets.map((t) => normalizeLegacyTicket(t, 'CONFIRMED'));
    const res = buildHisobProjections({ tickets: normalizedTickets });

    // In model_polo:
    // worker 101, Bichish: 120 + 80 = 200
    // worker 102, Tikish: 120
    // worker 103, Tikish: 80
    expect(getAccountingQuantity(res, 'model_polo', 101, 'Bichish')).toBe(200);
    expect(getAccountingQuantity(res, 'model_polo', 102, 'Tikish')).toBe(120);
    expect(getAccountingQuantity(res, 'model_polo', 103, 'Tikish')).toBe(80);

    // Verify optimistic equals accounting since there are zero pending tickets
    expect(getOptimisticQuantity(res, 'model_polo', 101, 'Bichish')).toBe(200);
    expect(getOptimisticQuantity(res, 'model_polo', 102, 'Tikish')).toBe(120);
    expect(getOptimisticQuantity(res, 'model_polo', 103, 'Tikish')).toBe(80);
  });

  it('supports creating and validating draft adjustments', () => {
    const draft = createProductionAdjustmentDraft({
      companyId: 'co-1',
      modelId: 'm-1',
      workerId: 105,
      opName: 'tikish',
      deltaQty: 25,
      reason: 'Physical recount adjustment',
      createdBy: 'supervisor-1'
    });

    expect(draft.status).toBe('PENDING_REVIEW');
    expect(draft.deltaQty).toBe(25);
    expect(draft.provenance).toBe('MANUAL_CORRECTION');
  });
});

describe('Property & Randomized Permutation Testing', () => {
  it('guarantees AccountingQty <= OptimisticQty when pending quantities are non-negative', () => {
    // Generate 500 random tickets and 30 approved adjustments
    const tickets: TicketFact[] = [];
    const adjustments: ProductionAdjustmentFact[] = [];

    const models = ['modA', 'modB', 'modC'];
    const operations = ['op1', 'op2', 'op3'];
    const statuses: TicketFact['status'][] = [
      'CONFIRMED',
      'PENDING_SYNC',
      'CONFIRMED',
      'CONFIRMED',
      'CONFLICT'
    ];

    for (let i = 0; i < 500; i++) {
      tickets.push({
        ticketId: `prop_t_${i}`,
        modelId: models[i % models.length],
        qty: Math.floor(Math.random() * 100) + 1,
        status: statuses[i % statuses.length],
        entries: [
          {
            workerId: 100 + (i % 10),
            opName: operations[i % operations.length]
          }
        ]
      });
    }

    for (let j = 0; j < 30; j++) {
      adjustments.push(
        makeAdjustment(
          `prop_adj_${j}`,
          models[j % models.length],
          100 + (j % 10),
          operations[j % operations.length],
          Math.floor(Math.random() * 20) - 5, // some positive, some negative
          'APPROVED'
        )
      );
    }

    const baseline = buildHisobProjections({ tickets, productionAdjustments: adjustments });

    // Verify invariant on all resulting cells:
    // AccountingQty = Confirmed + Adjustment
    // OptimisticQty = Confirmed + Pending + Adjustment
    // Since Pending >= 0 (ticket qty >= 0 and pending tickets add >= 0),
    // OptimisticQty - AccountingQty = PendingQty >= 0, so AccountingQty <= OptimisticQty
    for (const [, workers] of Object.entries(baseline.breakdown)) {
      for (const [, ops] of Object.entries(workers)) {
        for (const [, b] of Object.entries(ops)) {
          expect(b.pendingQty).toBeGreaterThanOrEqual(0);
          expect(b.accountingQty).toBeLessThanOrEqual(b.totalQty + 1e-9);
        }
      }
    }

    // Permute and shuffle 10 times to assert 100% order independence
    for (let shuffleIter = 0; shuffleIter < 10; shuffleIter++) {
      const shuffledTickets = [...tickets].sort(() => Math.random() - 0.5);
      const shuffledAdjustments = [...adjustments].sort(() => Math.random() - 0.5);

      const run = buildHisobProjections({
        tickets: shuffledTickets,
        productionAdjustments: shuffledAdjustments
      });

      expect(JSON.stringify(run)).toBe(JSON.stringify(baseline));
    }
  });
});

describe('Performance Sanity Benchmark', () => {
  it('benchmarks rebuild over 10,000 and 50,000 facts', () => {
    const buildBatch = (size: number) => {
      const tickets: TicketFact[] = [];
      for (let i = 0; i < size; i++) {
        tickets.push({
          ticketId: `bench_t_${i}`,
          modelId: `m_${i % 10}`,
          qty: (i % 50) + 1,
          status: i % 5 === 0 ? 'PENDING_SYNC' : 'CONFIRMED',
          entries: [
            {
              workerId: 100 + (i % 50),
              opName: `op_${i % 8}`
            }
          ]
        });
      }
      return tickets;
    };

    // 10,000 facts
    const batch10k = buildBatch(10000);
    const start10k = performance.now();
    const res10k = buildHisobProjections({ tickets: batch10k });
    const time10k = performance.now() - start10k;

    expect(Object.keys(res10k.optimistic).length).toBe(10);
    // Performance assertion: 10,000 facts in under 2000ms
    expect(time10k).toBeLessThan(2000);

    // 50,000 facts
    const batch50k = buildBatch(50000);
    const start50k = performance.now();
    const res50k = buildHisobProjections({ tickets: batch50k });
    const time50k = performance.now() - start50k;

    expect(Object.keys(res50k.optimistic).length).toBe(10);
    // Performance assertion: 50,000 facts in under 6000ms
    expect(time50k).toBeLessThan(6000);

    console.log(`[Performance Sanity] 10,000 facts rebuilt in ${time10k.toFixed(2)}ms`);
    console.log(`[Performance Sanity] 50,000 facts rebuilt in ${time50k.toFixed(2)}ms`);
  });
});

describe('Phase 2 Step 2 Narrow Correction Pass — Focused Domain Tests', () => {
  // 1. qty 0 rejected
  it('1. qty 0 rejected', () => {
    const ticket = makeTicket('t-zero', 'm-1', 101, 'tikish', 0);
    expect(() => buildHisobProjections({ tickets: [ticket] })).toThrowError(ProjectionValidationError);
    try {
      buildHisobProjections({ tickets: [ticket] });
    } catch (e: any) {
      expect(e.code).toBe('INVALID_TICKET_QUANTITY');
    }
  });

  // 2. fractional qty rejected
  it('2. fractional qty rejected', () => {
    const t1 = makeTicket('t-frac1', 'm-1', 101, 'tikish', 1.5);
    const t2 = makeTicket('t-frac2', 'm-1', 101, 'tikish', 2.25);
    expect(() => buildHisobProjections({ tickets: [t1] })).toThrowError(ProjectionValidationError);
    expect(() => buildHisobProjections({ tickets: [t2] })).toThrowError(ProjectionValidationError);
    try {
      buildHisobProjections({ tickets: [t1] });
    } catch (e: any) {
      expect(e.code).toBe('INVALID_TICKET_QUANTITY');
    }
  });

  // 3. unsafe integer qty rejected
  it('3. unsafe integer qty rejected', () => {
    const unsafeTicket = makeTicket('t-unsafe', 'm-1', 101, 'tikish', Number.MAX_SAFE_INTEGER + 1);
    expect(() => buildHisobProjections({ tickets: [unsafeTicket] })).toThrowError(ProjectionValidationError);
    try {
      buildHisobProjections({ tickets: [unsafeTicket] });
    } catch (e: any) {
      expect(e.code).toBe('INVALID_TICKET_QUANTITY');
    }
  });

  // 4. positive safe integer accepted (and numeric strings / negative / NaN / Infinity rejected)
  it('4. positive safe integer accepted', () => {
    const normalTicket = makeTicket('t-normal', 'm-1', 101, 'tikish', 100);
    const maxSafeTicket = makeTicket('t-max', 'm-1', 101, 'tikish', Number.MAX_SAFE_INTEGER);
    expect(() => buildHisobProjections({ tickets: [normalTicket, maxSafeTicket] })).not.toThrow();
    const res = buildHisobProjections({ tickets: [normalTicket] });
    expect(getAccountingQuantity(res, 'm-1', 101, 'tikish')).toBe(100);

    // Negative integer rejected
    const negTicket = makeTicket('t-neg', 'm-1', 101, 'tikish', -1);
    expect(() => buildHisobProjections({ tickets: [negTicket] })).toThrowError(ProjectionValidationError);

    // Numeric string rejected
    const strTicket = makeTicket('t-str', 'm-1', 101, 'tikish', '100' as any);
    expect(() => buildHisobProjections({ tickets: [strTicket] })).toThrowError(ProjectionValidationError);
  });

  // 5. valid reversal fact nets original to zero
  it('5. valid reversal fact nets original to zero', () => {
    const orig = makeAdjustment('adj-orig', 'm-1', 101, 'tikish', 30, 'APPROVED');
    const rev = createReversalAdjustment(orig, { createdBy: 'supervisor' });
    expect(rev.deltaQty).toBe(-30);
    expect(rev.originalAdjustmentId).toBe('adj-orig');
    expect(rev.provenance).toBe('REVERSAL');
    expect(rev.status).toBe('APPROVED');

    const res = buildHisobProjections({ productionAdjustments: [orig, rev] });
    expect(getAccountingQuantity(res, 'm-1', 101, 'tikish')).toBe(0);
    expect(getOptimisticQuantity(res, 'm-1', 101, 'tikish')).toBe(0);
  });

  // 6. missing original rejected
  it('6. missing original rejected', () => {
    const orphanRev = makeAdjustment('rev-1', 'm-1', 101, 'tikish', -30, 'APPROVED', 'non-existent-orig');
    orphanRev.provenance = 'REVERSAL';
    expect(() => buildHisobProjections({ productionAdjustments: [orphanRev] })).toThrowError(ProjectionValidationError);
    try {
      buildHisobProjections({ productionAdjustments: [orphanRev] });
    } catch (e: any) {
      expect(e.code).toBe('REVERSAL_ORIGINAL_NOT_FOUND');
    }
  });

  // 7. duplicate reversal rejected
  it('7. duplicate reversal rejected', () => {
    const orig = makeAdjustment('adj-orig', 'm-1', 101, 'tikish', 30, 'APPROVED');
    const rev1 = makeAdjustment('rev-1', 'm-1', 101, 'tikish', -30, 'APPROVED', 'adj-orig');
    rev1.provenance = 'REVERSAL';
    const rev2 = makeAdjustment('rev-2', 'm-1', 101, 'tikish', -30, 'APPROVED', 'adj-orig');
    rev2.provenance = 'REVERSAL';

    expect(() => buildHisobProjections({ productionAdjustments: [orig, rev1, rev2] })).toThrowError(ProjectionValidationError);
    try {
      buildHisobProjections({ productionAdjustments: [orig, rev1, rev2] });
    } catch (e: any) {
      expect(e.code).toBe('DUPLICATE_REVERSAL');
    }
  });

  // 8. reversal-of-reversal rejected
  it('8. reversal-of-reversal rejected', () => {
    const orig = makeAdjustment('adj-orig', 'm-1', 101, 'tikish', 30, 'APPROVED');
    const rev1 = makeAdjustment('rev-1', 'm-1', 101, 'tikish', -30, 'APPROVED', 'adj-orig');
    rev1.provenance = 'REVERSAL';
    const rev2 = makeAdjustment('rev-2', 'm-1', 101, 'tikish', 30, 'APPROVED', 'rev-1');
    rev2.provenance = 'REVERSAL';

    expect(() => buildHisobProjections({ productionAdjustments: [orig, rev1, rev2] })).toThrowError(ProjectionValidationError);
    try {
      buildHisobProjections({ productionAdjustments: [orig, rev1, rev2] });
    } catch (e: any) {
      expect(e.code).toBe('REVERSAL_OF_REVERSAL');
    }

    // Factory helper also rejects reversing a reversal
    expect(() => createReversalAdjustment(rev1, { createdBy: 'supervisor' })).toThrow(TypeError);
  });

  // 9. wrong company rejected
  it('9. wrong company rejected', () => {
    const orig = makeAdjustment('adj-orig', 'm-1', 101, 'tikish', 30, 'APPROVED');
    orig.companyId = 'company-A';
    const rev = makeAdjustment('rev-1', 'm-1', 101, 'tikish', -30, 'APPROVED', 'adj-orig');
    rev.provenance = 'REVERSAL';
    rev.companyId = 'company-B';

    expect(() => buildHisobProjections({ productionAdjustments: [orig, rev] })).toThrowError(ProjectionValidationError);
    try {
      buildHisobProjections({ productionAdjustments: [orig, rev] });
    } catch (e: any) {
      expect(e.code).toBe('REVERSAL_ENTITY_MISMATCH');
    }
  });

  // 10. wrong model rejected
  it('10. wrong model rejected', () => {
    const orig = makeAdjustment('adj-orig', 'm-1', 101, 'tikish', 30, 'APPROVED');
    const rev = makeAdjustment('rev-1', 'm-2', 101, 'tikish', -30, 'APPROVED', 'adj-orig');
    rev.provenance = 'REVERSAL';

    expect(() => buildHisobProjections({ productionAdjustments: [orig, rev] })).toThrowError(ProjectionValidationError);
    try {
      buildHisobProjections({ productionAdjustments: [orig, rev] });
    } catch (e: any) {
      expect(e.code).toBe('REVERSAL_ENTITY_MISMATCH');
    }
  });

  // 11. wrong worker rejected
  it('11. wrong worker rejected', () => {
    const orig = makeAdjustment('adj-orig', 'm-1', 101, 'tikish', 30, 'APPROVED');
    const rev = makeAdjustment('rev-1', 'm-1', 102, 'tikish', -30, 'APPROVED', 'adj-orig');
    rev.provenance = 'REVERSAL';

    expect(() => buildHisobProjections({ productionAdjustments: [orig, rev] })).toThrowError(ProjectionValidationError);
    try {
      buildHisobProjections({ productionAdjustments: [orig, rev] });
    } catch (e: any) {
      expect(e.code).toBe('REVERSAL_ENTITY_MISMATCH');
    }
  });

  // 12. wrong operation rejected
  it('12. wrong operation rejected', () => {
    const orig = makeAdjustment('adj-orig', 'm-1', 101, 'tikish', 30, 'APPROVED');
    const rev = makeAdjustment('rev-1', 'm-1', 101, 'dazmol', -30, 'APPROVED', 'adj-orig');
    rev.provenance = 'REVERSAL';

    expect(() => buildHisobProjections({ productionAdjustments: [orig, rev] })).toThrowError(ProjectionValidationError);
    try {
      buildHisobProjections({ productionAdjustments: [orig, rev] });
    } catch (e: any) {
      expect(e.code).toBe('REVERSAL_ENTITY_MISMATCH');
    }
  });

  // 13. wrong inverse delta rejected
  it('13. wrong inverse delta rejected', () => {
    const orig = makeAdjustment('adj-orig', 'm-1', 101, 'tikish', 30, 'APPROVED');
    const revWrong = makeAdjustment('rev-1', 'm-1', 101, 'tikish', -29, 'APPROVED', 'adj-orig');
    revWrong.provenance = 'REVERSAL';

    expect(() => buildHisobProjections({ productionAdjustments: [orig, revWrong] })).toThrowError(ProjectionValidationError);
    try {
      buildHisobProjections({ productionAdjustments: [orig, revWrong] });
    } catch (e: any) {
      expect(e.code).toBe('INVALID_REVERSAL_DELTA');
    }

    // Normalized float equality passes for floating values
    const origFloat = makeAdjustment('adj-f', 'm-1', 101, 'tikish', 0.1 + 0.2, 'APPROVED');
    const revFloat = makeAdjustment('rev-f', 'm-1', 101, 'tikish', -0.3, 'APPROVED', 'adj-f');
    revFloat.provenance = 'REVERSAL';
    expect(() => buildHisobProjections({ productionAdjustments: [origFloat, revFloat] })).not.toThrow();
  });

  // 14. original REVERSED + reversal fact follows documented compatibility policy
  it('14. original REVERSED + reversal fact follows documented compatibility policy', () => {
    const orig = makeAdjustment('adj-orig', 'm-1', 101, 'tikish', 30, 'REVERSED');
    const rev = makeAdjustment('rev-1', 'm-1', 101, 'tikish', -30, 'APPROVED', 'adj-orig');
    rev.provenance = 'REVERSAL';

    // Original status REVERSED contributes 0. Reversal delta is ignored to prevent double subtraction.
    const res = buildHisobProjections({ productionAdjustments: [orig, rev] });
    expect(getAccountingQuantity(res, 'm-1', 101, 'tikish')).toBe(0);
    expect(getOptimisticQuantity(res, 'm-1', 101, 'tikish')).toBe(0);
  });

  // 15. malformed reversal cannot bypass validation because original is REVERSED
  it('15. malformed reversal cannot bypass validation because original is REVERSED', () => {
    const orig = makeAdjustment('adj-orig', 'm-1', 101, 'tikish', 30, 'REVERSED');

    // Case A: Wrong inverse delta
    const badDeltaRev = makeAdjustment('rev-bad-delta', 'm-1', 101, 'tikish', -999, 'APPROVED', 'adj-orig');
    badDeltaRev.provenance = 'REVERSAL';
    expect(() => buildHisobProjections({ productionAdjustments: [orig, badDeltaRev] })).toThrowError(ProjectionValidationError);
    try {
      buildHisobProjections({ productionAdjustments: [orig, badDeltaRev] });
    } catch (e: any) {
      expect(e.code).toBe('INVALID_REVERSAL_DELTA');
    }

    // Case B: Wrong workerId
    const badWorkerRev = makeAdjustment('rev-bad-worker', 'm-1', 999, 'tikish', -30, 'APPROVED', 'adj-orig');
    badWorkerRev.provenance = 'REVERSAL';
    expect(() => buildHisobProjections({ productionAdjustments: [orig, badWorkerRev] })).toThrowError(ProjectionValidationError);
    try {
      buildHisobProjections({ productionAdjustments: [orig, badWorkerRev] });
    } catch (e: any) {
      expect(e.code).toBe('REVERSAL_ENTITY_MISMATCH');
    }
  });

  // 16. self-referencing reversal rejected
  it('16. self-referencing reversal rejected', () => {
    const selfRefAdj: ProductionAdjustmentFact = {
      adjustmentId: 'adj-1',
      companyId: 'test-co',
      modelId: 'm-1',
      workerId: 101,
      opName: 'tikish',
      deltaQty: -10,
      reason: 'Self-referencing reversal',
      status: 'APPROVED',
      provenance: 'REVERSAL',
      createdAt: '2026-09-19T12:00:00.000Z',
      createdBy: 'admin',
      originalAdjustmentId: 'adj-1'
    };

    expect(() => buildHisobProjections({ productionAdjustments: [selfRefAdj] })).toThrowError(ProjectionValidationError);
    try {
      buildHisobProjections({ productionAdjustments: [selfRefAdj] });
    } catch (e: any) {
      expect(e).toBeInstanceOf(ProjectionValidationError);
      expect(e.code).toBe('INVALID_REVERSAL_REFERENCE');
    }
  });

  // 17. createReversalAdjustment: original.status = APPROVED => reversal successfully created
  it('17. createReversalAdjustment: original.status = APPROVED => reversal successfully created', () => {
    const orig = makeAdjustment('adj-orig', 'm-1', 101, 'tikish', 30, 'APPROVED');
    const origSnapshot = JSON.parse(JSON.stringify(orig));
    Object.freeze(orig);

    const rev = createReversalAdjustment(orig, { createdBy: 'supervisor' });
    expect(rev.adjustmentId).toBeDefined();
    expect(rev.originalAdjustmentId).toBe('adj-orig');
    expect(rev.deltaQty).toBe(-30);
    expect(rev.status).toBe('APPROVED');
    expect(rev.provenance).toBe('REVERSAL');
    expect(rev.companyId).toBe('test-co');
    expect(rev.modelId).toBe('m-1');
    expect(rev.workerId).toBe(101);
    expect(rev.opName).toBe('tikish');

    // Confirm original object remains unchanged
    expect(orig).toEqual(origSnapshot);
    expect(orig.status).toBe('APPROVED');
  });

  // 18. createReversalAdjustment: original.status = PENDING_REVIEW => rejected
  it('18. createReversalAdjustment: original.status = PENDING_REVIEW => rejected', () => {
    const orig = makeAdjustment('adj-pending', 'm-1', 101, 'tikish', 30, 'PENDING_REVIEW');
    const origSnapshot = JSON.parse(JSON.stringify(orig));
    Object.freeze(orig);

    expect(() => createReversalAdjustment(orig, { createdBy: 'supervisor' })).toThrowError(
      /Cannot reverse adjustment "adj-pending" with status "PENDING_REVIEW". Only APPROVED adjustments can be reversed./
    );

    // Confirm original object remains unchanged
    expect(orig).toEqual(origSnapshot);
    expect(orig.status).toBe('PENDING_REVIEW');
  });

  // 19. createReversalAdjustment: original.status = REVERSED => rejected
  it('19. createReversalAdjustment: original.status = REVERSED => rejected', () => {
    const orig = makeAdjustment('adj-reversed', 'm-1', 101, 'tikish', 30, 'REVERSED');
    const origSnapshot = JSON.parse(JSON.stringify(orig));
    Object.freeze(orig);

    expect(() => createReversalAdjustment(orig, { createdBy: 'supervisor' })).toThrowError(
      /Cannot reverse adjustment "adj-reversed" with status "REVERSED". Only APPROVED adjustments can be reversed./
    );

    // Confirm original object remains unchanged
    expect(orig).toEqual(origSnapshot);
    expect(orig.status).toBe('REVERSED');
  });

  // 20. createReversalAdjustment: original is already a reversal => rejected
  it('20. createReversalAdjustment: original is already a reversal => rejected', () => {
    const origRev = makeAdjustment('rev-1', 'm-1', 101, 'tikish', -30, 'APPROVED', 'adj-orig');
    origRev.provenance = 'REVERSAL';
    const origSnapshot = JSON.parse(JSON.stringify(origRev));
    Object.freeze(origRev);

    expect(() => createReversalAdjustment(origRev, { createdBy: 'supervisor' })).toThrowError(
      /Cannot reverse an adjustment that is already a reversal: "rev-1"/
    );

    // Confirm original object remains unchanged
    expect(origRev).toEqual(origSnapshot);
    expect(origRev.status).toBe('APPROVED');
  });
});


