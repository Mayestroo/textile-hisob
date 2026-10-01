'use strict'; // Test fixture module; keep it out of Vitest's test-file discovery.

function getBootstrapFixture(companyId) {
  const now = '2026-09-01T00:00:00.000Z';
  const model = {
    id: 'model-1', companyId, name: 'Model 1', operations: [{ name: 'Sew', rate: 5 }],
    hisobSheetName: 'Model 1-hisob', title: 'Model- 1', party: '', color: '', size: '',
    pattaOpsOrder: [], status: 'ACTIVE', serverRevision: 1, createdAt: now, updatedAt: now
  };
  const worker = {
    id: 1, companyId, name: 'Worker 1', status: 'ACTIVE', staj: 0, role: null,
    legacyAvans: 0, legacyJarima: 0, serverRevision: 1, createdAt: now, updatedAt: now
  };
  const period = {
    id: 'period-1', companyId, name: 'September', startDate: '2026-09-01', endDate: null,
    isClosed: false, closedAt: null, notes: null, archiveFilename: null, status: 'OPEN',
    serverRevision: 1, createdAt: now, updatedAt: now
  };
  const party = {
    id: 'party-1', companyId, partyNumber: '1', physicalPartyNumber: '1', modelId: model.id,
    modelName: model.name, color: null, pattaCount: 0, cumulativePattaCount: 0,
    ishSoniPerPatta: null, totalIshSoni: null, ishSoni: 0, cumulativeIshSoni: 0,
    sizes: {}, printedAt: null, isClosed: false, closedAt: null, archivedPattaNumbers: [],
    status: 'ACTIVE', isArchived: false, serverRevision: 1, createdAt: now, updatedAt: now
  };
  const snapshot = {
    schemaVersion: 1,
    company: { companyId },
    models: [model], workers: [worker], periods: [period], parties: [party],
    legacyPartyCollisionExceptions: [],
    workerAdjustments: [], tickets: [], productionAdjustments: [],
    batchSettings: { company: null, models: [] },
    periodArchives: []
  };
  return {
    success: true,
    snapshot,
    cursor: '42',
    counts: {
      models: 1, workers: 1, periods: 1, parties: 1, workerAdjustments: 0,
      legacyPartyCollisionExceptions: 0,
      tickets: 0, ticketEntries: 0, productionAdjustments: 0, periodArchives: 0
    }
  };
}

module.exports = { getBootstrapFixture };
