'use strict';

/**
 * Party Sequence Lease Manager for Electron Main.
 * Phase 2 — Step 4: Authoritative Distributed Synchronization & Leases
 *
 * Enforces:
 * - Server Authority for Range Allocation: Server assigns non-overlapping [rangeStart, rangeEnd].
 * - Offline Consumption Independence: Client exclusively owns the granted range and can consume
 *   all values offline regardless of local system clock.
 * - Non-Recycling on Revocation / Exhaustion: Numbers are strictly monotonic and never reused.
 */

function getActiveLease(db, companyId) {
  const row = db.prepare(`
    SELECT lease_id, company_id, range_start, range_end, next_available, status
    FROM local_party_leases
    WHERE company_id = ? AND status = 'ACTIVE' AND next_available <= range_end
    ORDER BY range_start DESC
    LIMIT 1
  `).get(companyId);

  return row || null;
}

/**
 * Requests a new party sequence lease from the server and stores it in local SQLite.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} companyId
 * @param {import('./syncClient.cjs').SyncClient} syncClient
 * @param {number} [blockSize=50]
 * @returns {Promise<object>} StoredLease
 */
async function acquireAndStoreLease(db, companyId, syncClient, blockSize = 50) {
  const response = await syncClient.acquirePartyLease(blockSize);
  const lease = response?.lease;

  if (!lease || !lease.leaseId) {
    const err = new Error('Invalid lease response from server');
    err.code = 'INVALID_LEASE_RESPONSE';
    throw err;
  }

  db.prepare(`
    INSERT INTO local_party_leases (
      lease_id, company_id, range_start, range_end, next_available, status
    ) VALUES (?, ?, ?, ?, ?, 'ACTIVE')
    ON CONFLICT(lease_id) DO UPDATE SET
      status = excluded.status,
      next_available = excluded.next_available
  `).run(
    lease.leaseId,
    companyId,
    lease.rangeStart,
    lease.rangeEnd,
    lease.nextValue || lease.rangeStart
  );

  return getActiveLease(db, companyId);
}

/**
 * Atomically consumes the next sequence number from an active local lease.
 * This runs completely offline without server round-trip.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} companyId
 * @returns {number} Consumed party sequence number
 */
function consumeNextPartyNumber(db, companyId) {
  return db.transaction(() => {
    const active = getActiveLease(db, companyId);
    if (!active) {
      const err = new Error('No active party sequence lease available. Online lease acquisition required.');
      err.code = 'LEASE_EXHAUSTED';
      throw err;
    }

    const assignedNumber = active.next_available;
    const nextVal = assignedNumber + 1;
    const newStatus = nextVal > active.range_end ? 'EXHAUSTED' : 'ACTIVE';

    db.prepare(`
      UPDATE local_party_leases
      SET next_available = ?, status = ?
      WHERE lease_id = ?
    `).run(nextVal, newStatus, active.lease_id);

    return assignedNumber;
  })();
}

module.exports = {
  getActiveLease,
  acquireAndStoreLease,
  consumeNextPartyNumber
};
