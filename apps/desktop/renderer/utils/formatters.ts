/**
 * Format numbers as formatted currency string (e.g. 1 500 000)
 */
export function formatMoney(val: number | undefined | null): string {
  if (val === undefined || val === null || isNaN(val) || val === 0) return '0';
  return new Intl.NumberFormat('ru-RU').format(Math.round(val));
}

/**
 * Format general numbers with space grouping
 */
export function formatNumber(val: number | undefined | null): string {
  if (val === undefined || val === null || isNaN(val) || val === 0) return '';
  return new Intl.NumberFormat('ru-RU').format(val);
}

/**
 * Two-digit zero pad helper
 */
export function padZero(n: number): string {
  return String(n).padStart(2, '0');
}

const DISPLAY_TIME_ZONE = 'Asia/Tashkent';

function datePartsInTashkent(date: Date) {
  const values = new Intl.DateTimeFormat('en-GB', {
    timeZone: DISPLAY_TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  return Object.fromEntries(values.map((part) => [part.type, part.value]));
}

/** Format a date as DD.MM.YYYY in Asia/Tashkent (UTC+5). */
export function formatDateOnly(date: Date = new Date()): string {
  const parts = datePartsInTashkent(date);
  return `${parts.day}.${parts.month}.${parts.year}`;
}

/** Format a date and time as DD.MM.YYYY HH:mm in Asia/Tashkent (UTC+5). */
export function formatDateTime(date: Date = new Date()): string {
  const parts = datePartsInTashkent(date);
  return `${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute}`;
}

/**
 * Format ticket date to standard DD.MM.YYYY HH:mm (e.g. 13.09.2026 17:03)
 */
export function formatTicketTimestamp(date: Date = new Date()): string {
  return formatDateTime(date);
}

/**
 * Format ticket date and time for display: DD.MM.YYYY HH:mm
 * Handles existing tickets (extracts date from sub_<timestamp>_... if only time was stored)
 */
export function formatTicketDateTime(
  ticketOrTime?: { id?: string; submittedAt?: string } | string,
  ticketId?: string
): string {
  if (!ticketOrTime) return '—';

  const timeStr = typeof ticketOrTime === 'string' ? ticketOrTime : ticketOrTime.submittedAt || '';
  const idStr = typeof ticketOrTime === 'string' ? ticketId : ticketOrTime.id;

  const parsed = parseTicketDateTime(timeStr);
  if (parsed) {
    return formatTicketTimestamp(parsed);
  }

  // Attempt recovery from ticket id (format: sub_1726574580000_...)
  if (idStr) {
    const match = idStr.match(/^sub_(\d{12,})/);
    if (match) {
      const ts = parseInt(match[1], 10);
      if (!isNaN(ts)) {
        return formatTicketTimestamp(new Date(ts));
      }
    }
  }

  return timeStr || '—';
}

function parseTicketDateTime(value: string): Date | null {
  if (!value) return null;
  const localized = value.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:,?\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (localized) {
    const [, day, month, year, hours = '0', minutes = '0', seconds = '0'] = localized;
    // Human-formatted application timestamps always represent Tashkent wall time.
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hours) - 5, Number(minutes), Number(seconds)));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const unzonedIso = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/);
  if (unzonedIso) {
    const [, year, month, day, hours = '0', minutes = '0', seconds = '0', milliseconds = '0'] = unzonedIso;
    const date = new Date(Date.UTC(
      Number(year), Number(month) - 1, Number(day), Number(hours) - 5,
      Number(minutes), Number(seconds), Number(milliseconds.padEnd(3, '0'))
    ));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp);
}

function ticketTimestamp(ticket: { id?: string; submittedAt?: string }): number {
  const parsed = parseTicketDateTime(ticket.submittedAt || '');
  if (parsed) return parsed.getTime();
  const legacyId = ticket.id?.match(/^sub_(\d{12,})/);
  if (legacyId) {
    const timestamp = Number(legacyId[1]);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return Number.NEGATIVE_INFINITY;
}

export function sortTicketsNewestFirst<T extends { id?: string; submittedAt?: string }>(tickets: T[]): T[] {
  return tickets
    .map((ticket, index) => ({ ticket, index, timestamp: ticketTimestamp(ticket) }))
    .sort((left, right) => right.timestamp - left.timestamp || right.index - left.index)
    .map(({ ticket }) => ticket);
}

/**
 * Format date to YYYY-MM-DD
 */
export function formatDateIso(date: Date = new Date()): string {
  const parts = datePartsInTashkent(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function formatTashkentTimestampForFilename(date: Date = new Date()): string {
  const parts = datePartsInTashkent(date);
  return `${parts.year}-${parts.month}-${parts.day}_${parts.hour}-${parts.minute}-${parts.second}`;
}

const UZBEK_MONTHS = [
  'Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun',
  'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'
];

/**
 * Returns formatted Uzbek month name, e.g. "2026-Sentabr oyligi"
 */
export function getUzbekMonthName(dateInput?: string | Date): string {
  let d: Date;
  if (!dateInput) {
    d = new Date();
  } else if (typeof dateInput === 'string') {
    d = parseTicketDateTime(dateInput) || new Date(dateInput);
  } else {
    d = dateInput;
  }
  if (isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: DISPLAY_TIME_ZONE,
    year: 'numeric',
    month: 'numeric'
  }).formatToParts(d);
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  return `${year}-${UZBEK_MONTHS[month - 1]} oyligi`;
}

/**
 * Formats YYYY-MM-DD to DD.MM.YYYY
 */
export function formatUzbekDate(dateStr?: string): string {
  if (!dateStr) return '';
  const parts = dateStr.slice(0, 10).split('-');
  if (parts.length === 3) {
    return `${parts[2]}.${parts[1]}.${parts[0]}`;
  }
  return dateStr;
}
