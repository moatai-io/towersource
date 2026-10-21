/** Public query surface deliberately excludes caller-selected team/key identity. */
export function validRouterUsageQuery(query: Record<string, unknown>): boolean {
  const allowed = new Set(['scope', 'period', 'days']);
  if (Object.keys(query).some((key) => !allowed.has(key))) return false;
  if (query.scope !== undefined && (typeof query.scope !== 'string' || !['key', 'team'].includes(query.scope))) return false;
  if (query.period !== undefined && (typeof query.period !== 'string' || !['lifetime', 'calendar_month'].includes(query.period))) return false;
  if (query.days !== undefined && (typeof query.days !== 'string' || !/^\d+$/.test(query.days) || Number(query.days) < 1 || Number(query.days) > 180)) return false;
  return true;
}
