// Work hours are kept as minutes past midnight in Lagos time. WAT is UTC+1 all
// year (Nigeria has no daylight saving), so a fixed offset is exact.
export const WORK_HOURS_TIMEZONE = 'Africa/Lagos';
const WAT_OFFSET_MINUTES = 60;
const MINUTES_PER_DAY = 24 * 60;

export interface WorkHours {
  startMinute: number;
  endMinute: number;
  start: string;
  end: string;
  timezone: string;
  open: boolean;
}

export function minuteOfDayInLagos(at: Date = new Date()): number {
  return (at.getUTCHours() * 60 + at.getUTCMinutes() + WAT_OFFSET_MINUTES) % MINUTES_PER_DAY;
}

/** "HH:mm" in 24-hour time. */
export function formatMinuteOfDay(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** "7:00 AM" — for messages shown to drivers. */
export function formatMinuteOfDay12h(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  const suffix = h < 12 ? 'AM' : 'PM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/**
 * Start equal to end means no restriction. An end earlier than the start is an
 * overnight shift (e.g. 22:00–06:00).
 */
export function isWithinWorkHours(startMinute: number, endMinute: number, at: Date = new Date()): boolean {
  if (startMinute === endMinute) return true;
  const now = minuteOfDayInLagos(at);
  return startMinute < endMinute
    ? now >= startMinute && now < endMinute
    : now >= startMinute || now < endMinute;
}

export function workHours(startMinute: number, endMinute: number, at: Date = new Date()): WorkHours {
  return {
    startMinute,
    endMinute,
    start: formatMinuteOfDay(startMinute),
    end: formatMinuteOfDay(endMinute),
    timezone: WORK_HOURS_TIMEZONE,
    open: isWithinWorkHours(startMinute, endMinute, at),
  };
}
