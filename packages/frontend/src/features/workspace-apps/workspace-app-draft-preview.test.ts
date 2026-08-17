import { describe, expect, it } from 'vitest';
import { applyWorkspaceAppDraftPreview } from './workspace-app-draft-preview';
import type { WorkspaceAppDefinition } from './workspace-app-definition';

const definition: WorkspaceAppDefinition = {
  id: 'sales-ops',
  name: 'Sales Ops',
  eyebrow: 'Workspace Apps',
  title: '영업 운영 현황',
  description: '원본 설명',
  primaryActionLabel: '앱 수정 요청',
  secondaryActionLabel: 'Definition 보기',
  menuTitle: '업무 메뉴',
  source: { provider: 'sqlite', databasePath: 'apps/sales-ops/data.sqlite' },
  menu: [{ id: 'dashboard', label: '대시보드' }],
  metrics: [],
  tableView: {
    id: 'customer-ops',
    title: '거래처 운영 현황',
    subtitle: '원본 subtitle',
    statusLabel: 'SQLite read-only',
    columns: [
      { key: 'name', label: '거래처', kind: 'text' },
      { key: 'owner', label: '담당', kind: 'text' },
    ],
    rows: [{ name: 'DemoOrg', owner: 'Julius' }],
  },
  builder: {
    title: 'Admin builder',
    description: 'Preview only',
    steps: [],
    draftPreview: {
      title: '변경안',
      summary: 'preview',
      changes: [
        { path: 'tableView.title', before: '거래처 운영 현황', after: '거래처 파이프라인 현황', risk: 'low' },
        { path: 'tableView.columns[0].label', before: '거래처', after: '거래처명', risk: 'low' },
      ],
    },
  },
};

describe('applyWorkspaceAppDraftPreview', () => {
  it('does not mutate or apply changes when preview is disabled', () => {
    expect(applyWorkspaceAppDraftPreview(definition, false)).toBe(definition);
  });

  it('applies supported display-only draft changes without changing rows or source', () => {
    const preview = applyWorkspaceAppDraftPreview(definition, true);
    expect(preview).not.toBe(definition);
    expect(preview.tableView.title).toBe('거래처 파이프라인 현황');
    expect(preview.tableView.columns[0].label).toBe('거래처명');
    expect(preview.tableView.rows).toBe(definition.tableView.rows);
    expect(preview.source).toBe(definition.source);
  });
});
