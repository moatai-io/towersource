import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./PublishPanel.tsx', import.meta.url), 'utf8');

describe('PublishPanel polling boundary', () => {
  it('loads the complete data set on open and after manual actions', () => {
    expect(source).toContain('if (open) fetchData();');
    expect(source).toContain("fetch(`${API_BASE}/info`, { headers })");
    expect(source).toContain("fetch(`${API_BASE}/sites/tags`, { headers })");
    expect(source).toContain("fetch('/api/shares/external', { headers })");
  });

  it('polls only live status while the panel and document are visible', () => {
    const poll = source.slice(source.indexOf('// Refresh live status only'), source.indexOf('// Merge gateway deploys'));
    expect(poll).toContain('if (!open) return;');
    expect(poll).toContain("document.visibilityState === 'visible'");
    expect(poll).toContain('fetchData(true)');
    expect(poll).toContain('clearInterval(interval)');
    const statusOnly = source.slice(source.indexOf('if (statusOnly) {'), source.indexOf('const [statusRes, infoRes'));
    expect(statusOnly).toContain('fetch(`${API_BASE}/status`, { headers })');
    expect(statusOnly).not.toContain('/info');
    expect(statusOnly).not.toContain('/sites/tags');
    expect(statusOnly).not.toContain('/shares/external');
  });
});
