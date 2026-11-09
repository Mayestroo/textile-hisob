'use strict';
// Stage B real PostgreSQL migration + canonical party mutation, bounded to the documented own container.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const root = path.resolve(__dirname, '../../..');
const container = 'hisob_test_display_05d2b2';
const identity = 'f8070090fa5aaedf8aa34a983c8606be4b8954d4d0aa7f7993352caf29a0c9d3';
const name = `hisob_test_model_sizes_b_${crypto.randomBytes(5).toString('hex')}`;
const password = crypto.randomBytes(32).toString('hex');
const safeEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, APPDATA: process.env.APPDATA };
delete process.env.DATABASE_URL;
delete process.env.NOVDA_PG_URL;
delete process.env.NOVDA_LOCAL_TEST_PG_URL;
const { applyMigrations } = require(path.join(root, 'ops/deploy/migrateProduction.cjs'));
const { canonicalStringify, computePayloadHash } = require(path.join(root, 'apps/server/modules/sync/canonicalPayload.cjs'));
const { processSingleOperation } = require(path.join(root, 'apps/server/modules/sync/handlers/operations.cjs'));
const { readPeriodArchiveSource } = require(path.join(root, 'apps/server/modules/sync/workbookOperations.cjs'));
const { readCompanySnapshot } = require(path.join(root, 'apps/server/modules/sync/bootstrapSnapshot.cjs'));

function docker(args, input) {
  const result = spawnSync('docker', args, { input, encoding: 'utf8', env: safeEnv, timeout: 30000 });
  assert.equal(result.status, 0, `owned-container command failed: ${args[0]}`);
  return result.stdout.trim();
}
function guard(url) {
  const result = spawnSync(process.execPath, [path.join(root, '.opencode/deep-audit/output/local-test-db/assert-local-pg.cjs')],
    { env: { NOVDA_LOCAL_TEST_PG_URL: url }, encoding: 'utf8' });
  assert.equal(result.status, 0, 'local PostgreSQL boundary check failed');
}
function operation(commandType, entityType, entityId, payload, baseRevision) {
  const value = JSON.parse(canonicalStringify(payload));
  return { operationId: value.operationId, companyId: value.companyId, commandType, entityType, entityId, baseRevision,
    payloadHash: computePayloadHash(canonicalStringify(value)), payload: value };
}
async function main() {
  assert.equal(docker(['inspect', '--format', '{{.Id}}', container]), identity, 'owned-container identity mismatch');
  const status = docker(['inspect', '--format', '{{.State.Status}}', container]);
  if (status === 'exited') docker(['start', container]);
  assert.equal(docker(['inspect', '--format', '{{.Id}}', container]), identity);
  const binding = docker(['port', container, '5432/tcp']);
  assert.match(binding, /^127\.0\.0\.1:\d+$/);
  const url = `postgresql://${name}:${password}@${binding}/${name}`;
  let client;
  try {
    guard(url);
    docker(['exec', '-i', '-u', 'postgres', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'hisob_test_display', '-d', 'hisob_test_display', '-q'],
      `CREATE ROLE ${name} LOGIN PASSWORD '${password}';\nCREATE DATABASE ${name} OWNER ${name};\n`);
    guard(url);
    client = new Pool({ connectionString: url });
    await applyMigrations(client);
    const companyId = `company_${name}`;
    const modelId = `model_${name}`;
    await client.query(`INSERT INTO models(id,company_id,name,status) VALUES($1,$2,'Stage B model','ACTIVE')`, [modelId, companyId]);
    const req = { auth: { companyId, deviceId: 'synthetic-stage-b-device' } };
    const partyId = `party_${name}`;
    const base = { partyRecordId: partyId, partyNumber: '81', modelId, modelName: 'Stage B model', color: 'Qora',
      pattaCount: 2, cumulativePattaCount: 2, ishSoniPerPatta: 25, totalIshSoni: 50, ishSoni: 50,
      cumulativeIshSoni: 50, sizes: { XXL: 1, M: 1 }, sizeOrder: ['XXL', 'M'], printedAt: '2026-11-07T00:00:00.000Z' };
    const create = { ...base, commandId: `cmd_create_${name}`, operationId: `op_create_${name}`, companyId };
    const created = await processSingleOperation(client, req, operation('CreateParty', 'party', partyId, create, 0));
    assert.equal(created.status, 'APPLIED', JSON.stringify(created));
    const afterCreate = await client.query('SELECT sizes_json,size_order_json FROM parties WHERE company_id=$1 AND id=$2', [companyId, partyId]);
    assert.deepEqual(afterCreate.rows[0], { sizes_json: { XXL: 1, M: 1 }, size_order_json: ['XXL', 'M'] });
    const oldUpdate = { ...base, commandId: `cmd_update_${name}`, operationId: `op_update_${name}`, companyId, ishSoni: 52, totalIshSoni: 52 };
    delete oldUpdate.sizeOrder;
    const updated = await processSingleOperation(client, req, operation('UpdateParty', 'party', partyId, oldUpdate, 1));
    assert.equal(updated.status, 'APPLIED', JSON.stringify(updated));
    const close = { commandId: `cmd_close_${name}`, operationId: `op_close_${name}`, companyId, partyRecordId: partyId };
    const closed = await processSingleOperation(client, req, operation('CloseParty', 'party', partyId, close, 2));
    assert.equal(closed.status, 'APPLIED', JSON.stringify(closed));
    const stored = await client.query('SELECT status,ish_soni,sizes_json,size_order_json FROM parties WHERE company_id=$1 AND id=$2', [companyId, partyId]);
    assert.deepEqual(stored.rows[0], { status: 'CLOSED', ish_soni: '52', sizes_json: { XXL: 1, M: 1 }, size_order_json: ['XXL', 'M'] });
    const snapshot = await readCompanySnapshot(client, companyId);
    assert.deepEqual(snapshot.snapshot.parties[0].sizeOrder, ['XXL', 'M']);
    const archive = await readPeriodArchiveSource(client, companyId, {
      id: 'stage-b-period', name: 'Stage B', start_date: '2026-11-01', end_date: '2026-11-30', archive_filename: null
    });
    assert.deepEqual(archive.printedPartyHistory[0].sizeOrder, ['XXL', 'M']);
    assert.deepEqual(archive.printedPartyHistory[0].sizes, { XXL: 1, M: 1 });
    console.log('MODEL_SIZES_STAGE_B_PG_PASS: migrations, canonical create/update/close, bootstrap and archive roundtrip retained [XXL,M]');
  } finally {
    if (client) await client.end();
    assert.equal(docker(['inspect', '--format', '{{.Id}}', container]), identity);
    docker(['stop', container]);
  }
}
main().catch((error) => { console.error(String(error.stack || error).replaceAll(password, '[redacted]')); process.exitCode = 1; });
