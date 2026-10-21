export type DiskLevel = 'normal' | 'warning' | 'critical';
export function diskLevel(availableBytes: number): DiskLevel {
  if (availableBytes < 20 * 2 ** 30) return 'critical';
  if (availableBytes < 50 * 2 ** 30) return 'warning';
  return 'normal';
}
export function shouldNotify(level: DiskLevel, previous: DiskLevel, now: number, lastSent: number): boolean {
  return level !== previous || (level !== 'normal' && now - lastSent >= 86400_000);
}
