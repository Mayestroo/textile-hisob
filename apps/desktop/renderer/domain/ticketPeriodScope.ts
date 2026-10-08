export interface TicketPeriodDateRange {
  startDate?: string;
  endDate?: string;
  isClosed?: boolean;
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function isTicketDateWithinPeriod(date: string, period?: TicketPeriodDateRange | null): boolean {
  if (!isCalendarDate(date)) return false;
  if (!period || period.isClosed) return true;
  if (isCalendarDate(period.startDate) && date < period.startDate) return false;
  if (isCalendarDate(period.endDate) && date > period.endDate) return false;
  return true;
}

export function normalizeTicketDateForPeriod(
  date: string | undefined,
  period: TicketPeriodDateRange | null | undefined,
  today: string
): string {
  const candidate = isCalendarDate(date) ? date : today;
  if (!period || period.isClosed || isTicketDateWithinPeriod(candidate, period)) return candidate;

  let normalized = isCalendarDate(today) ? today : candidate;
  if (isCalendarDate(period.startDate) && normalized < period.startDate) normalized = period.startDate;
  if (isCalendarDate(period.endDate) && normalized > period.endDate) normalized = period.endDate;
  return normalized;
}
