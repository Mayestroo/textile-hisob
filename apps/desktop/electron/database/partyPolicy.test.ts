import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// @ts-ignore
const policy = require('../../../../packages/domain/partyPolicy.cjs');
const crypto = require('crypto');
// @ts-ignore
const databaseManager = require('./databaseManager.cjs');

describe('data-driven party collision policy', () => {
  let userDataPath: string;
  const companyId = 'company-policy-test';

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

  function insertParty(db: any, id: string, number: string, modelId: string, status = 'ACTIVE') {
    db.prepare(`
      INSERT INTO parties (
        id, company_id, party_number, physical_party_number, model_id,
        status, is_closed, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, companyId, number, number, modelId, status, status === 'CLOSED' ? 1 : 0,
      new Date().toISOString(), new Date().toISOString());
  }

  function authorizePair(db: any, number: string, ids: string[]) {
    const collisionGroupId = crypto.randomUUID();
    const insert = db.prepare(`
      INSERT INTO legacy_party_collision_exceptions (
        exception_id, company_id, party_number, party_id, collision_group_id,
        approved_by, approved_at, reason, status
      ) VALUES (?, ?, ?, ?, ?, 'test-approval', ?, 'persisted migration fixture', 'ACTIVE')
    `);
    for (const id of ids) {
      insert.run(crypto.randomUUID(), companyId, number, id, collisionGroupId, new Date().toISOString());
    }
  }

  it('permits only the two persisted members of the same approved collision group', () => {
    const group = 'collision-group';
    const first = { id: 'party-a', company_id: companyId, party_number: '7', status: 'ACTIVE', collision_group_id: group };
    const candidate = { id: 'party-b', company_id: companyId, party_number: '7', status: 'ACTIVE', collision_group_id: group };
    expect(policy.isAllowedGrandfatheredPair([first], candidate)).toBe(true);
    expect(policy.isAllowedGrandfatheredPair([first], { ...candidate, collision_group_id: 'other-group' })).toBe(false);
    expect(policy.isAllowedGrandfatheredPair([{ ...first, collision_group_id: null }], candidate)).toBe(false);
  });

  it('allows a recorded pair but rejects a third active row and an unregistered collision', () => {
    const db = openDb();
    authorizePair(db, '7', ['party-a', 'party-b']);
    insertParty(db, 'party-a', '7', 'model-a');
    insertParty(db, 'party-b', '7', 'model-b');

    expect(() => insertParty(db, 'party-c', '7', 'model-c')).toThrow(/ACTIVE_PARTY_EXISTS/);
    insertParty(db, 'party-d', '8', 'model-d');
    expect(() => insertParty(db, 'party-e', '8', 'model-e')).toThrow(/ACTIVE_PARTY_EXISTS/);
  });

  it('reserves globally unique party numbers across models without changing party identity', () => {
    const db = openDb();
    insertParty(db, 'party-a', '9', 'model-a');
    expect(() => insertParty(db, 'party-b', '9', 'model-b')).toThrow(/ACTIVE_PARTY_EXISTS/);
    expect(() => db.prepare('UPDATE parties SET id = ? WHERE id = ?').run('party-new', 'party-a'))
      .toThrow(/IMMUTABLE_PARTY_IDENTITY/);
  });
});
