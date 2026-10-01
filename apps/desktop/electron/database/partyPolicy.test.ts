import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// @ts-ignore
const policy = require('../../../../packages/domain/partyPolicy.cjs');
const migrator = require('./migrator.cjs');
// @ts-ignore
const databaseManager = require('./databaseManager.cjs');

describe('exact Party #2 policy', () => {
  let userDataPath: string;
  const companyId = policy.EXACT_PARTY_TWO_COMPANY_ID;
  const exactA = 'rec_1788774889449_vrbkv';
  const exactB = 'rec_1788930871307_cg1iv';

  beforeEach(() => {
    userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'party-policy-'));
  });

  afterEach(() => {
    databaseManager.closeAllCompanyDatabases();
    fs.rmSync(userDataPath, { recursive: true, force: true });
  });

  function openDb() {
    return databaseManager.getCompanyDatabase(userDataPath, companyId);
  }

  function insertParty(db: any, id: string, partyNumber: string, modelId: string, status = 'ACTIVE', partyCompanyId = companyId) {
    db.prepare(`
      INSERT INTO parties (
        id, company_id, party_number, physical_party_number, model_id,
        status, is_closed, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, partyCompanyId, partyNumber, partyNumber, modelId, status, status === 'CLOSED' ? 1 : 0, new Date().toISOString(), new Date().toISOString());
  }

  it('exposes exactly the two opaque historical IDs', () => {
    expect(policy.EXACT_PARTY_TWO_IDS).toEqual([exactA, exactB]);
    expect(policy.EXACT_PARTY_TWO_IDS).toHaveLength(2);
    expect(policy.isExactPartyTwoId(exactA)).toBe(true);
    expect(policy.isExactPartyTwoId(exactB)).toBe(true);
    expect(policy.isExactPartyTwoId('uuid-party-2-c')).toBe(false);
    expect(policy.isExactPartyTwoId(`${exactA} `)).toBe(false);
  });

  it('allows only two independently persisted exact non-CLOSED rows', () => {
    const activeA = { id: exactA, company_id: companyId, party_number: '2', status: 'ACTIVE' };
    const activeB = { id: exactB, company_id: companyId, party_number: '2', status: 'CLOSE_PENDING' };

    expect(policy.isAllowedGrandfatheredPair([activeA], activeB)).toBe(true);
    expect(policy.isAllowedGrandfatheredPair([activeA], {
      id: 'fake-party', company_id: companyId, party_number: '2', status: 'ACTIVE'
    })).toBe(false);
    expect(policy.isAllowedGrandfatheredPair([activeA], {
      id: exactB, company_id: 'other-company', party_number: '2', status: 'ACTIVE'
    })).toBe(false);
    expect(policy.isAllowedGrandfatheredPair([activeA], {
      id: exactB, company_id: companyId, party_number: '3', status: 'ACTIVE'
    })).toBe(false);
    expect(policy.isAllowedGrandfatheredPair([{ ...activeA, status: 'CLOSED' }], activeB)).toBe(false);
    expect(policy.isAllowedGrandfatheredPair([activeA], {
      id: exactB, company_id: 'another-company', party_number: '2', status: 'ACTIVE'
    })).toBe(false);
  });

  it('permits the exact active pair and rejects a third or fake claim', () => {
    const db = openDb();
    insertParty(db, exactA, '2', 'model-a');

    insertParty(db, exactB, '2', 'model-b', 'CLOSE_PENDING');
    expect(() => insertParty(db, 'third-party-2', '2', 'model-c')).toThrow(/ACTIVE_PARTY_EXISTS/);

    db.prepare(`
      INSERT INTO legacy_party_collision_exceptions (
        exception_id, company_id, party_number, party_id, collision_group_id,
        approved_by, approved_at, reason, status
      ) VALUES (?, ?, '2', ?, 'fake-group', 'fake-operator', ?, 'fake claim', 'ACTIVE')
    `).run('fake-exception', companyId, 'fake-party-2', new Date().toISOString());
    expect(() => insertParty(db, 'fake-party-2', '2', 'model-c')).toThrow(/ACTIVE_PARTY_EXISTS/);
  });

  it('does not transfer the approved pair exception to another company', () => {
    const db = openDb();
    insertParty(db, exactA, '2', 'model-a', 'ACTIVE', 'another-company');
    expect(() => insertParty(db, exactB, '2', 'model-b', 'ACTIVE', 'another-company'))
      .toThrow(/ACTIVE_PARTY_EXISTS/);
  });

  it('rejects a generic grandfather resolution for a non-canonical identity', () => {
    const db = openDb();
    expect(() => migrator.recordPartyResolution(db, {
      quarantineId: 'quarantine-fake',
      companyId: 'another-company',
      partyId: 'fake-party-two',
      decision: 'GRANDFATHER_EXISTING_ACTIVE_COLLISION_UNTIL_CLOSED',
      operatorId: 'operator-test',
      decidedAt: '2026-09-01T00:00:00.000Z',
      sourceSnapshotHash: 'a'.repeat(64),
      reason: 'synthetic test'
    })).toThrowError(expect.objectContaining({ code: 'EXACT_PARTY_2_GRANDFATHER_POLICY_REQUIRED' }));
    expect(db.prepare('SELECT COUNT(*) AS count FROM migration_party_resolutions').get().count).toBe(0);
  });

  it('reserves CLOSE_PENDING and releases Party #2 only after both exact rows are CLOSED', () => {
    const db = openDb();
    insertParty(db, exactA, '2', 'model-a');
    insertParty(db, exactB, '2', 'model-b', 'CLOSE_PENDING');

    expect(() => insertParty(db, 'normal-while-pending', '2', 'model-c')).toThrow(/ACTIVE_PARTY_EXISTS/);

    db.prepare(`UPDATE parties SET status = 'CLOSED', is_closed = 1 WHERE id = ?`).run(exactB);
    expect(() => insertParty(db, 'normal-with-exact-a-active', '2', 'model-c')).toThrow(/ACTIVE_PARTY_EXISTS/);

    db.prepare(`UPDATE parties SET status = 'CLOSED', is_closed = 1 WHERE id = ?`).run(exactA);
    insertParty(db, 'normal-after-both-closed', '2', 'model-c');

    const rows = db.prepare(`SELECT id, status FROM parties WHERE company_id = ? AND party_number = '2' ORDER BY id`).all(companyId);
    expect(rows).toEqual([
      { id: 'normal-after-both-closed', status: 'ACTIVE' },
      { id: exactA, status: 'CLOSED' },
      { id: exactB, status: 'CLOSED' }
    ]);
  });

  it('applies normal uniqueness across model and unrelated lifecycle metadata', () => {
    const db = openDb();
    insertParty(db, 'normal-model-a', '7', 'model-a', 'ACTIVE');
    expect(() => insertParty(db, 'normal-model-b', '7', 'model-b', 'ACTIVE')).toThrow(/ACTIVE_PARTY_EXISTS/);

    const persisted = { id: 'normal-model-a', company_id: companyId, party_number: '7', status: 'ACTIVE', period_id: 'period-2', device_id: 'device-2', operator_id: 'operator-2' };
    expect(policy.isAllowedGrandfatheredPair([persisted], {
      id: 'normal-model-b', company_id: companyId, party_number: '7', status: 'ACTIVE', period_id: 'period-3', device_id: 'device-3', operator_id: 'operator-3'
    })).toBe(false);
  });

  it('rejects direct party identity and company-scope updates', () => {
    const db = openDb();
    insertParty(db, 'immutable-party', '8', 'model-a');

    expect(() => db.prepare(`UPDATE parties SET id = ? WHERE id = ?`).run('transferred-party', 'immutable-party'))
      .toThrow(/IMMUTABLE_PARTY_IDENTITY/);
    expect(() => db.prepare(`UPDATE parties SET company_id = ? WHERE id = ?`).run('other-company', 'immutable-party'))
      .toThrow(/IMMUTABLE_PARTY_IDENTITY/);

    expect(db.prepare(`SELECT id, company_id, party_number, status FROM parties WHERE id = ?`).get('immutable-party'))
      .toEqual({ id: 'immutable-party', company_id: companyId, party_number: '8', status: 'ACTIVE' });
  });

  it('preserves reopen transitions and reserves every non-CLOSED status', () => {
    const db = openDb();
    insertParty(db, 'lifecycle-party', '9', 'model-a', 'CLOSED');

    db.prepare(`UPDATE parties SET status = 'ACTIVE', is_closed = 0 WHERE id = ?`).run('lifecycle-party');
    db.prepare(`UPDATE parties SET status = 'CLOSE_PENDING' WHERE id = ?`).run('lifecycle-party');

    expect(() => insertParty(db, 'arbitrary-status-party', '9', 'model-b', 'ON_HOLD'))
      .toThrow(/ACTIVE_PARTY_EXISTS/);

    db.prepare(`UPDATE parties SET status = 'CLOSED', is_closed = 1 WHERE id = ?`).run('lifecycle-party');
    insertParty(db, 'reused-party', '9', 'model-c', 'ON_HOLD');
    expect(db.prepare(`SELECT status FROM parties WHERE id = ?`).get('reused-party').status).toBe('ON_HOLD');
  });
});
