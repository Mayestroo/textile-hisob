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

/**
 * Format date to standard localized string: DD.MM.YYYY, HH:mm
 */
export function formatDateTime(date: Date = new Date()): string {
  const day = padZero(date.getDate());
  const month = padZero(date.getMonth() + 1);
  const year = date.getFullYear();
  const hours = padZero(date.getHours());
  const minutes = padZero(date.getMinutes());
  return `${day}.${month}.${year}, ${hours}:${minutes}`;
}

/**
 * Format ticket date to standard DD.MM.YYYY HH:mm (e.g. 13.09.2026 17:03)
 */
export function formatTicketTimestamp(date: Date = new Date()): string {
  const day = padZero(date.getDate());
  const month = padZero(date.getMonth() + 1);
  const year = date.getFullYear();
  const hours = padZero(date.getHours());
  const minutes = padZero(date.getMinutes());
  return `${day}.${month}.${year} ${hours}:${minutes}`;
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

  // Keep already-human-readable local timestamps as-is.
  if (/^\d{2}\.\d{2}\.\d{4}(?:,?\s+\d{2}:\d{2}(?::\d{2})?)?$/.test(timeStr)) {
    return timeStr.replace(',', '');
  }

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
    const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hours), Number(minutes), Number(seconds));
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
  return date.toISOString().slice(0, 10);
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
    const parts = dateInput.slice(0, 10).split('-');
    if (parts.length === 3) {
      d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    } else {
      d = new Date(dateInput);
    }
  } else {
    d = dateInput;
  }
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${UZBEK_MONTHS[d.getMonth()]} oyligi`;
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
