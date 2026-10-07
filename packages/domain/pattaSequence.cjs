'use strict';

function partyRange(row) {
  const start = Number(row?.pattaStartNumber ?? row?.patta_start_number);
  const end = Number(row?.pattaEndNumber ?? row?.patta_end_number);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return null;
  const archivedValue = row?.isArchived ?? row?.is_archived;
  const archived = archivedValue === true || archivedValue === 1;
  const closedValue = row?.isClosed ?? row?.is_closed;
  const closed = row?.status === 'CLOSED' || closedValue === true || closedValue === 1;
  return { start, end, archived, closed };
}

function findAvailablePattaStart({ nextPattaNumber, pattaCount, parties = [] }) {
  const highWater = Number(nextPattaNumber);
  const count = Number(pattaCount);
  if (!Number.isSafeInteger(highWater) || highWater < 1) throw new Error('PATTA_SEQUENCE_INVALID');
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('INVALID_PATTA_COUNT');

  const ranges = parties.map(partyRange).filter(Boolean);
  const occupied = ranges
    .filter((range) => !range.archived && !range.closed)
    .sort((left, right) => left.start - right.start);

  const released = ranges
    .filter((range) => range.archived && range.start < highWater)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  for (const range of released) {
    let candidate = range.start;
    const releasedEnd = Math.min(range.end, highWater - 1);
    while (candidate + count - 1 <= releasedEnd) {
      const conflict = occupied.find((item) => item.start <= candidate + count - 1 && item.end >= candidate);
      if (!conflict) return candidate;
      candidate = conflict.end + 1;
    }
  }

  let candidate = highWater;
  while (candidate + count - 1 <= Number.MAX_SAFE_INTEGER) {
    const conflict = occupied.find((item) => item.start <= candidate + count - 1 && item.end >= candidate);
    if (!conflict) return candidate;
    candidate = conflict.end + 1;
  }
  throw new Error('INVALID_PATTA_COUNT');
}

module.exports = { findAvailablePattaStart };
