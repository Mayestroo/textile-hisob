import { describe, expect, it } from 'vitest';
import { classifyArchiveTicket, validatePeriodArchive } from '../archive/periodArchiveValidator.cjs';
import { canonicalStringify, computePayloadHash } from '../core/canonicalPayload.cjs';

const companyId = 'archive-owner';
const ticket = { id: 'historical-ticket', modelId: 'original-model', partyNumber: '7', pattaNumber: 10,
  qty: 3, submittedAt: '2026-09-01T08:00:00.000Z', status: 'CONFIRMED',
  entries: [{ opName: 'Sew', workerId: 1, rateSnapshot: 5 }, { opName: 'Cut', workerId: 2, rateSnapshot: null }] };
const canonical = { id: ticket.id, company_id: companyId, period_id: 'P', model_id: ticket.modelId,
  party_number: '7', party_record_id: null, patta_number: 10, qty: 3, submitted_at: ticket.submittedAt,
  is_closed: 1, status: 'CONFIRMED', historicalEntries: [
    { op_name: 'Cut', worker_id: 2, rate_snapshot: null, brak: null },
    { op_name: 'Sew', worker_id: 1, rate_snapshot: 5, brak: null }
  ] };

describe('legacy archive identity without a printed party', () => {
  it('retains a corroborated VOIDED ticket as historical cancellation, never as payable work', () => {
    const archived = { ...ticket, status: 'VOIDED' };
    expect(classifyArchiveTicket(archived, companyId, 'P', { ...canonical, status: 'VOIDED' }))
      .toMatchObject({ status: 'VOIDED', statusSource: 'archive-explicit', periodId: 'P' });
  });
  it('binds only corroborated closed canonical work without modifying the snapshot or digest', () => {
    const archive = { period: { id: 'P' }, submittedTickets: [ticket], printedPartyHistory: [] };
    const serialized = canonicalStringify(archive);
    const sha = computePayloadHash(serialized);
    expect(validatePeriodArchive(archive, sha, companyId, 'P', {
      binding: 'retained-local-owner', canonicalTickets: [canonical]
    })).toBeNull();
    expect(classifyArchiveTicket(ticket, companyId, 'P', canonical)).toMatchObject({
      periodId: 'P', periodMembershipSource: 'canonical-ticket-exact-match', status: 'CONFIRMED'
    });
    expect(canonicalStringify(archive)).toBe(serialized);
    expect(ticket).not.toHaveProperty('partyRecordId');
    expect(ticket.entries[1].rateSnapshot).toBeNull();
    expect(validatePeriodArchive(archive, '0'.repeat(64), companyId, 'P', {
      binding: 'retained-local-owner', canonicalTickets: [canonical]
    })).toBe('ARCHIVE_DIGEST_MISMATCH');
  });

  it.each([
    { company_id: 'foreign' }, { period_id: 'other-period' }, { party_record_id: 'guessed-party' },
    { model_id: 'other-model' }, { is_closed: 0 }, { status: 'VOIDED' }, { submitted_at: '2026-09-02T08:00:00Z' },
    { qty: 4 }, { patta_number: 11 }, { historicalEntries: [] },
    { historicalEntries: [{ op_name: 'Sew', worker_id: 1, rate_snapshot: 0, brak: null }] }
  ])('fails closed when canonical corroboration differs: %j', (change) => {
    expect(classifyArchiveTicket(ticket, companyId, 'P', { ...canonical, ...change }).problem)
      .toBe('ARCHIVE_TICKET_PERIOD_UNKNOWN');
  });

  it('rejects absent model/time/entries and duplicate conflicting facts rather than guessing identity', () => {
    for (const change of [{ modelId: undefined }, { submittedAt: undefined }, { entries: [] },
      { entries: [...ticket.entries, ticket.entries[0]] }, { partyRecordId: 'unproven' }]) {
      expect(classifyArchiveTicket({ ...ticket, ...change }, companyId, 'P', canonical).problem)
        .toBe('ARCHIVE_TICKET_PERIOD_UNKNOWN');
    }
    const archive = { period: { id: 'P' }, submittedTickets: [ticket, { ...ticket, color: 'changed' }], printedPartyHistory: [] };
    expect(validatePeriodArchive(archive, computePayloadHash(canonicalStringify(archive)), companyId, 'P', {
      binding: 'retained-local-owner', canonicalTickets: [canonical]
    })).toBe('ARCHIVE_TICKET_DUPLICATE_CONFLICT');
  });
});
