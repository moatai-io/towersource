import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./PublishPanel.tsx', import.meta.url), 'utf8');

describe('PublishPanel project-scoped sharing contract', () => {
  it('explains project-scoped discovery and link sharing through locale keys', () => {
    expect(source).toContain("i18n.t('publish.hubScopeDescription')");
    expect(source).toContain("i18n.t('publish.linkSharingHint')");
    expect(source).toContain("i18n.t('publish.linkSharing')");
  });

  it('localizes the hub summary, sections, errors, and copy actions', () => {
    expect(source).toContain("aria-label={i18n.t('publish.hubTitle')}");
    expect(source).toContain("i18n.t('publish.localPublishing')");
    expect(source).toContain("emptyText={i18n.t('publish.emptySites')}");
    expect(source).toContain("title={i18n.t('publish.copyUrl')}");
    expect(source).toContain("i18n.t('publish.loadFailed')");
  });

  it('does not expose legacy access-tier filtering or editing controls', () => {
    expect(source).not.toContain('ALL_ACCESS_TIERS');
    expect(source).not.toContain('toggleAccessFilter');
    expect(source).not.toContain('onChangeAccess');
    expect(source).not.toContain('접근 권한 일괄 변경');
  });
});
