/** Auto-detect xKey and yKey from data if not provided */
export function inferKeys(data: Record<string, any>[]): { xKey: string; yKeys: string[] } {
  if (!data.length) return { xKey: '', yKeys: [] };
  const first = data[0];
  let xKey = '';
  const yKeys: string[] = [];

  for (const [key, val] of Object.entries(first)) {
    if (!xKey && typeof val === 'string') {
      xKey = key;
    } else if (typeof val === 'number') {
      yKeys.push(key);
    }
  }
  if (!xKey) xKey = Object.keys(first)[0];
  if (!yKeys.length) {
    const remaining = Object.keys(first).filter(k => k !== xKey);
    yKeys.push(...remaining.slice(0, 1));
  }
  return { xKey, yKeys };
}

/** Format large numbers with K/M suffix */
export function fmtNumber(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}
