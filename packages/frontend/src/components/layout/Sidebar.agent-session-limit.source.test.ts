import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './Sidebar.tsx'), 'utf8');

describe('Agent teammate session list limit', () => {
  it('shows 50 teammate conversations by default without a 20/50 preference menu', () => {
    expect(source).toContain('const SESSION_INITIAL_EXPANDED_LIMIT = 50');
    expect(source).not.toContain('sidebar-agent-session-preview-limit:v1');
    expect(source).not.toContain("t('showOnlyCount', { count: 20 })");
    expect(source).not.toContain("t('showOnlyCount', { count: 50 })");
  });

  it('keeps the existing incremental 50-item show-more path', () => {
    expect(source).toContain('showMoreSessions(groupSessions.length, previewCount)');
    expect(source).toContain("t('showMoreSessions', { count: nextBatchCount, remaining: remainingCount })");
    expect(source).toContain('const SESSION_LOAD_BATCH = 50');
  });
});
