import { describe, expect, it } from 'vitest';
import { formatDateIso, formatDateOnly, formatDateTime, formatTicketDateTime, formatTicketTimestamp, sortTicketsNewestFirst } from './formatters';

describe('ticket date and ordering formatters', () => {
  it('formats ISO timestamps into a readable local date and time', () => {
    const formatted = formatTicketDateTime({ submittedAt: '2026-10-02T10:40:40.104Z' });

    expect(formatted).toBe('02.10.2026 15:40');
    expect(formatted).not.toContain('T');
    expect(formatted).not.toContain('Z');
    expect(formatted).not.toContain('-');
  });

  it('uses the same date/time format in shared display helpers', () => {
    const date = new Date('2026-10-02T10:40:59.000Z');
    expect(formatDateOnly(date)).toBe('02.10.2026');
    expect(formatDateTime(date)).toBe('02.10.2026 15:40');
    expect(formatTicketTimestamp(date)).toBe('02.10.2026 15:40');
  });

  it('preserves an existing readable timestamp and recovers old timestamp IDs', () => {
    expect(formatTicketDateTime({ submittedAt: '02.10.2026 15:40:59' })).toBe('02.10.2026 15:40');
    expect(formatTicketDateTime({ id: 'sub_1790937640104_abc', submittedAt: '15:40' }))
      .toMatch(/^\d{2}\.\d{2}\.2026 \d{2}:\d{2}$/);
  });

  it('sorts canonical and legacy tickets newest first by actual submission time', () => {
    const tickets = [
      { id: '00000000-0000-4000-8000-000000000001', submittedAt: '2026-10-02T10:39:00.000Z' },
      { id: '00000000-0000-4000-8000-000000000002', submittedAt: '2026-10-02T10:41:00.000Z' },
      { id: 'sub_1790937640000_legacy', submittedAt: '15:40' }
    ];

    expect(sortTicketsNewestFirst(tickets).map((ticket) => ticket.id)).toEqual([
      '00000000-0000-4000-8000-000000000002',
      'sub_1790937640000_legacy',
      '00000000-0000-4000-8000-000000000001',
    ]);
  });

  it('uses the Tashkent calendar day for dates near UTC midnight', () => {
    const date = new Date('2026-10-02T20:30:00.000Z');
    expect(formatDateOnly(date)).toBe('03.10.2026');
    expect(formatDateIso(date)).toBe('2026-10-03');
    expect(formatTicketDateTime('2026-10-02T15:40:00')).toBe('02.10.2026 15:40');
  });
});
