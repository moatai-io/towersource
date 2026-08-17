import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './ChallengeTimelinePanel.tsx'), 'utf8');
const urlSync = fs.readFileSync(path.resolve(import.meta.dirname, '../../hooks/useUrlSync.ts'), 'utf8');

describe('Workstream URL and browser history', () => {
  it('restores the work view and selected Workstream from query parameters', () => {
    expect(urlSync).toContain("'work',");
    expect(source).toContain("params.get('workstream')");
    expect(source).toContain("params.get('workProject') || 'all'");
    expect(source).toContain('React.useState<string | null>(initialLocation.workstreamKey)');
    expect(source).toContain('React.useState(initialLocation.projectId)');
  });

  it('pushes detail navigation and preserves it across the global URL mirror', () => {
    expect(source).toContain("writeWorkstreamLocation(key, nextProjectId, 'push')");
    expect(source).toContain("url.searchParams.set('view', 'work')");
    expect(source).toContain("url.searchParams.set('workstream', workstreamKey)");
    expect(urlSync).toContain("currentParams.get('workstream')");
    expect(urlSync).toContain("targetUrl.searchParams.set('workstream', workstreamKey)");
  });

  it('restores detail or activity list on browser back and removes its listener', () => {
    expect(source).toContain("window.addEventListener('popstate', restoreWorkstreamLocation)");
    expect(source).toContain("window.removeEventListener('popstate', restoreWorkstreamLocation)");
    expect(source).toContain('window.history.back()');
    expect(source).toContain("writeWorkstreamLocation(null, 'all', 'replace')");
  });
});
