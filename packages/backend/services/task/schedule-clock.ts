/** Host-independent schedule clock. DST gaps skip; repeated wall times fire once per local day. */
export interface ScheduleClockConfig {
  type: 'daily' | 'weekdays' | 'weekly' | 'interval';
  hour?: number; minute?: number; day?: number; hours?: number; minutes?: number;
}
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  let value = formatters.get(timezone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
    });
    if (formatters.size >= 64) formatters.clear();
    formatters.set(timezone, value);
  }
  return value;
}
export function validateScheduleTimezone(timezone: string): void { formatter(timezone); }
export function scheduleLocalParts(date: Date, timezone: string) {
  const p = Object.fromEntries(formatter(timezone).formatToParts(date).map(part => [part.type, part.value]));
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour), minute: Number(p.minute), weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}

export function calculateZonedNextRun(cron: ScheduleClockConfig, from = new Date(), timezone = 'Asia/Seoul'): Date {
  validateScheduleTimezone(timezone);
  if (!Number.isFinite(from.getTime())) throw new Error('Invalid schedule reference date');
  if (cron.type === 'interval') {
    const minutes = cron.minutes ?? (cron.hours ?? 1) * 60;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) throw new Error('Invalid schedule interval');
    return new Date(from.getTime() + minutes * 60_000);
  }
  const hour = cron.hour ?? 9;
  const minute = cron.minute ?? 0;
  if (!['daily', 'weekdays', 'weekly'].includes(cron.type) || !Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error('Invalid schedule time');
  const targetDay = cron.day ?? 1;
  if (cron.type === 'weekly' && (!Number.isInteger(targetDay) || targetDay < 0 || targetDay > 6)) throw new Error('Invalid schedule weekday');
  const start = scheduleLocalParts(from, timezone);
  // Search UTC minutes rather than guessing offsets. This handles half-hour zones,
  // DST gaps and folds without a host TZ dependency. A weekly DST gap can require
  // the following week, hence a bounded 15-day horizon.
  for (let ms = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000, stop = ms + 15 * 86400_000; ms < stop; ms += 60_000) {
    const p = scheduleLocalParts(new Date(ms), timezone);
    if (p.hour !== hour || p.minute !== minute) continue;
    if (p.year === start.year && p.month === start.month && p.day === start.day && start.hour * 60 + start.minute >= hour * 60 + minute) continue;
    if (cron.type === 'weekdays' && (p.weekday === 0 || p.weekday === 6)) continue;
    if (cron.type === 'weekly' && p.weekday !== targetDay) continue;
    return new Date(ms);
  }
  throw new Error('No schedule occurrence within 15 days');
}

export function applyScheduleActiveHours(next: Date, activeHours: unknown, timezone = 'Asia/Seoul'): Date {
  if (!activeHours || typeof activeHours !== 'object') return next;
  const { startHour, endHour } = activeHours as { startHour?: number; endHour?: number };
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour) || startHour! < 0 || endHour! > 24 || startHour! >= endHour!) return next;
  const hour = scheduleLocalParts(next, timezone).hour;
  if (hour >= startHour! && hour < endHour!) return next;
  return calculateZonedNextRun({ type: 'daily', hour: startHour!, minute: 0 }, next, timezone);
}
