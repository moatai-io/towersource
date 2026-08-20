import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(new URL('./Sidebar.tsx', import.meta.url), 'utf8');

describe('project retirement UI source contract', () => {
  it('uses the explicit retirement API and reports failures', () => {
    const start = source.indexOf('const handleDelete = async () =>');
    const end = source.indexOf('\n\n\n  return (', start);
    const handler = source.slice(start, end);
    expect(handler).toContain("fetch(`/api/projects/${project.id}/retire`, { method: 'POST'");
    expect(handler).toContain('if (!res.ok)');
    expect(handler).toContain("emitProductNotice({ code: 'sidebar.project.delete.failed', technicalDetail: data.error, context: { status: res.status } })");
    expect(handler).toContain("emitProductNotice({ code: 'sidebar.project.delete.failed', technicalDetail: error })");
  });

  it('explains that conversations and files are preserved', () => {
    expect(source).toContain("confirmLabel: t('archiveAgentConfirm')");
    expect(source).toContain("t('archiveAgentDetail')");
    expect(source).toContain("t('archiveAgentMessage', { detail })");
  });
});
