import { describe, it, expect } from 'vitest';

/**
 * Phase 0D — process.cwd() dependency detection.
 * Locks down path assumptions that will break if cwd changes.
 */

describe('path dependency detection', () => {
  it('SESSION_BACKUP_DIR이 data/session-backups로 끝난다', async () => {
    // Read the source to verify the path pattern (don't import claude-sdk which has side effects)
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'ai', 'claude-sdk.ts'),
      'utf-8',
    );
    // Verify it uses process.cwd() — this is a known issue to fix during migration
    expect(source).toContain("process.cwd()");
    expect(source).toContain("session-backups");
  });
});
