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
    expect(source).toContain("confirmLabel: '에이전트 폐기'");
    expect(source).toContain('대화와 프로젝트 파일은 그대로 보존됩니다.');
    expect(source).toContain('관리자가 복구하거나 별도 관리 화면에서 영구 삭제할 수 있습니다.');
  });
});
