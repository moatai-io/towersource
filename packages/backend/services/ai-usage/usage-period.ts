/** Calendar boundaries shared by personal usage and project activity metrics. */
export function utcUsageWindow(days: number, now = new Date()) {
  if (!Number.isInteger(days) || days < 1 || days > 180 || !Number.isFinite(now.getTime())) {
    throw new RangeError('Invalid usage calendar window');
  }
  const dayMs = 86_400_000;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = today - (days - 1) * dayMs;
  return {
    start: new Date(start).toISOString(),
    end: new Date(today + dayMs).toISOString(),
    dates: Array.from({ length: days }, (_, i) => new Date(start + i * dayMs).toISOString().slice(0, 10)),
  };
}

/** Derive totals from the rendered axis, never from off-axis rows or top-N totals. */
export function usageSeries(dates: string[], rows: Array<{ date: string; turns: string | number }>) {
  const byDate = new Map<string, number>();
  for (const row of rows) byDate.set(row.date, (byDate.get(row.date) || 0) + Number(row.turns || 0));
  const values = dates.map((date) => byDate.get(date) || 0);
  return {
    values,
    total: values.reduce((sum, value) => sum + value, 0),
    activeDays: values.filter((value) => value > 0).length,
  };
}
