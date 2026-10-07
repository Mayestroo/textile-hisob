import { describe, expect, it } from 'vitest';

const { findAvailablePattaStart } = require('../../../../packages/domain/pattaSequence.cjs');

describe('patta number reuse', () => {
  it('reuses released archived ranges without overlapping active parties', () => {
    const start = findAvailablePattaStart({
      nextPattaNumber: 13,
      pattaCount: 3,
      parties: [
        { patta_start_number: 1, patta_end_number: 12, is_archived: true, status: 'CLOSED' },
        { patta_start_number: 1, patta_end_number: 4, is_archived: false, status: 'ACTIVE' },
        { patta_start_number: 7, patta_end_number: 8, is_archived: false, status: 'ACTIVE' }
      ]
    });

    expect(start).toBe(9);
  });

  it('uses the sequence high-water mark when a released range cannot fit the batch', () => {
    expect(findAvailablePattaStart({
      nextPattaNumber: 13,
      pattaCount: 3,
      parties: [
        { patta_start_number: 1, patta_end_number: 12, is_archived: true, status: 'CLOSED' },
        { patta_start_number: 1, patta_end_number: 10, is_archived: false, status: 'ACTIVE' }
      ]
    })).toBe(13);
  });
});
