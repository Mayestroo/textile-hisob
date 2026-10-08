import { describe, expect, it } from 'vitest';
import { isTicketDateWithinPeriod, normalizeTicketDateForPeriod } from './ticketPeriodScope';

describe('ticket period date scope', () => {
  const period = { id: 'period-current', startDate: '2026-09-01', endDate: '2026-09-30', isClosed: false };

  it('accepts ticket dates within the active period, including its boundary dates', () => {
    expect(isTicketDateWithinPeriod('2026-09-01', period)).toBe(true);
    expect(isTicketDateWithinPeriod('2026-09-30', period)).toBe(true);
  });

  it('rejects dates outside the active period and normalizes stale drafts to a valid date', () => {
    expect(isTicketDateWithinPeriod('2026-08-31', period)).toBe(false);
    expect(isTicketDateWithinPeriod('2026-10-01', period)).toBe(false);
    expect(normalizeTicketDateForPeriod('2026-08-31', period, '2026-09-12')).toBe('2026-09-12');
    expect(normalizeTicketDateForPeriod('2026-08-31', period, '2026-10-08')).toBe('2026-09-30');
  });

  it('does not modify a date that is already in scope', () => {
    expect(normalizeTicketDateForPeriod('2026-09-15', period, '2026-10-08')).toBe('2026-09-15');
  });
});
