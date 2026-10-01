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

  // If already contains date (e.g. "13.09.2026 17:03" or "13.09.2026, 17:03")
  if (timeStr && timeStr.includes('.')) {
    return timeStr.replace(',', '');
  }

  // Attempt recovery from ticket id (format: sub_1726574580000_...)
  if (idStr) {
    const match = idStr.match(/^sub_(\d{12,})/);
    if (match) {
      const ts = parseInt(match[1], 10);
      if (!isNaN(ts)) {
        const d = new Date(ts);
        const day = padZero(d.getDate());
        const month = padZero(d.getMonth() + 1);
        const year = d.getFullYear();
        const fallbackTime = `${padZero(d.getHours())}:${padZero(d.getMinutes())}`;
        return `${day}.${month}.${year} ${timeStr || fallbackTime}`;
      }
    }
  }

  return timeStr || '—';
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

