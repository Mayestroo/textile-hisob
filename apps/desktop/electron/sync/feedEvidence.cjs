'use strict';

const MAX_CURSOR = 9223372036854775807n;
const KNOWN_TYPES = new Set(['ticket', 'production_adjustment', 'model', 'worker', 'period',
  'party', 'batch_settings', 'party_series', 'patta_batch', 'period_archive', 'party_history']);
const CHANGE_TYPES = new Set(['INSERT', 'UPDATE', 'DELETE']);
const proofKey = (companyId, periodId) => `feed_proof:${companyId}:${periodId}`;
function cursor(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  if (!/^\d{1,19}$/.test(text)) return null;
  const n = BigInt(text);
  return n <= MAX_CURSOR ? n : null;
}
function put(db, key, value) {
  if (db.prepare('SELECT value FROM local_meta WHERE key=?').get(key)?.value === value) return;
  db.prepare(`INSERT INTO local_meta(key,value,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(key, value, new Date().toISOString());
}
function markFeedUnavailable(db) { put(db, 'feed_contact_state', 'UNKNOWN'); }

function recordSnapshotBaseline(db, companyId, baseline, localCursor) {
  if (!baseline || baseline.protocolVersion !== 1 || baseline.companyId !== companyId
    || cursor(baseline.headCursor) === null || cursor(baseline.headCursor) !== cursor(localCursor)) return;
  put(db, 'feed_baseline', JSON.stringify({ companyId, cursor: String(cursor(localCursor)) }));
  recordAppliedHead(db, companyId, String(cursor(localCursor)));
}
function recordAppliedHead(db, companyId, head) {
  const baseline = db.prepare("SELECT value FROM local_meta WHERE key='feed_baseline'").get();
  if (!baseline || cursor(head) === null) return;
  let base;
  try { base = JSON.parse(baseline.value); } catch { return; }
  if (base.companyId !== companyId || cursor(base.cursor) === null || cursor(base.cursor) > cursor(head)) return;
  // Keep a period/revision-specific proof; never transfer a proof to a newly
  // selected period or a period subsequently changed outside the applied feed.
  for (const period of db.prepare(`SELECT id, server_revision FROM periods WHERE company_id=?`).all(companyId)) {
    put(db, proofKey(companyId, period.id), JSON.stringify({ companyId, periodId: period.id,
      periodRevision: period.server_revision, baselineCursor: base.cursor, throughCursor: head }));
  }
  put(db, 'feed_contact_state', 'VERIFIED');
}
function verifyPage(response, companyId, localCursor) {
  if (response?.feedProtocolVersion !== 1) return null; // legacy servers remain unverified
  const from = cursor(response.fromCursor);
  const head = cursor(response.headCursor);
  const next = cursor(response.nextCursor);
  const current = cursor(localCursor);
  if (response.companyId !== companyId || from === null || head === null || next === null || current === null
    || from !== current || head < from || next < from || next > head
    || typeof response.hasMore !== 'boolean' || !Array.isArray(response.items))
    throw new Error('FEED_PROOF_INVALID');
  let previous = from;
  for (const item of response.items) {
    const id = cursor(item?.changeId);
    if (item?.companyId !== companyId || id === null || id <= previous || id > head
      || !KNOWN_TYPES.has(item.entityType) || !CHANGE_TYPES.has(item.changeType)
      || !item.payload || typeof item.payload !== 'object'
      || (item.payload.companyId !== undefined && item.payload.companyId !== companyId)
      || !Number.isSafeInteger(Number(item.entityRevision)) || Number(item.entityRevision) < 1)
      throw new Error('FEED_PROOF_INVALID');
    previous = id;
  }
  if (response.hasMore ? (!response.items.length || next !== previous || previous >= head)
    : next !== head) throw new Error('FEED_PROOF_INVALID');
  return { head: String(head), terminal: !response.hasMore };
}
function readFeedEvidence(db, companyId, periodId, periodRevision, localCursor) {
  if (db.prepare("SELECT value FROM local_meta WHERE key='_bootstrap_complete'").get()?.value !== '1') return null;
  const state = db.prepare("SELECT value FROM local_meta WHERE key='feed_contact_state'").get()?.value;
  const baselineRow = db.prepare("SELECT value FROM local_meta WHERE key='feed_baseline'").get();
  const proofRow = db.prepare('SELECT value FROM local_meta WHERE key=?').get(proofKey(companyId, periodId));
  if (!baselineRow || !proofRow) return null;
  try {
    const baseline = JSON.parse(baselineRow.value);
    const proof = JSON.parse(proofRow.value);
    if (baseline.companyId !== companyId || proof.companyId !== companyId || proof.periodId !== periodId
      || proof.periodRevision !== periodRevision || proof.baselineCursor !== baseline.cursor
      || cursor(proof.throughCursor) === null || cursor(proof.throughCursor) !== cursor(localCursor)
      || cursor(proof.baselineCursor) === null || cursor(proof.baselineCursor) > cursor(proof.throughCursor)) return null;
    return { asOfCursor: proof.throughCursor, verified: state === 'VERIFIED' };
  } catch { return null; }
}
module.exports = { cursor, markFeedUnavailable, recordSnapshotBaseline, recordAppliedHead,
  verifyPage, readFeedEvidence };
