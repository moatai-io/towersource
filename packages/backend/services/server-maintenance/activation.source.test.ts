import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
describe('maintenance activation boundaries', () => {
  it('defaults monitoring on, deletion off with explicit separate opt-in', () => {
    expect(source).toContain("TOWER_DISK_MONITOR_ENABLED !== '0'");
    expect(source).toContain("TOWER_BACKUP_RETENTION_ENABLED === '1'");
    expect(source).toContain('if (backupEnabled && !backupError && now - state.lastBackup');
  });
  it('keeps backup configuration independent of disk checks and persists notices', () => {
    expect(source).toContain('if (diskEnabled)');
    expect(source).toContain('state.backupNotice !== notice');
    expect(source).toContain("path.join(config.dataDir, 'server-maintenance')");
    expect(source).not.toContain("TOWER_SERVER_MAINTENANCE_ENABLED !== '1'");
  });
});
