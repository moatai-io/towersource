import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './Sidebar.tsx'), 'utf8');

describe('Agent teammate session list limit', () => {
  it('defaults teammate conversations to 20 and offers persistent 20/50 choices', () => {
    expect(source).toContain("const SESSION_INITIAL_EXPANDED_LIMIT = 20");
    expect(source).toContain("sidebar-agent-session-preview-limit:v1");
    expect(source).toContain("? Math.min(groupSessions.length, agentSessionPreviewLimit)");
    expect(source).toContain("t('showOnlyCount', { count: 20 })");
    expect(source).toContain("t('showOnlyCount', { count: 50 })");
  });

  it('keeps the existing incremental show-more path', () => {
    expect(source).toContain('showMoreSessions(groupSessions.length, previewCount)');
    expect(source).toContain("t('showMoreSessions', { count: nextBatchCount, remaining: remainingCount })");
    expect(source).toContain('const SESSION_LOAD_BATCH = 50');
  });
});
