import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listWorkspaceAppDrafts, readWorkspaceAppDraft, saveWorkspaceAppDraft } from './app-draft-store.js';
import type { WorkspaceAppDefinition } from './app-definition-schema.js';

let root = '';

const definition: WorkspaceAppDefinition = {
  id: 'sales-ops',
  name: 'Sales Ops',
  eyebrow: 'Workspace Apps',
  title: '영업 운영 현황',
  description: '',
  primaryActionLabel: '앱 수정 요청',
  secondaryActionLabel: 'Definition 보기',
  menuTitle: '업무 메뉴',
  source: { provider: 'sqlite', databasePath: 'apps/sales-ops/data.sqlite', schema: 'public' },
  sourcePath: 'apps/sales-ops/app.yaml',
  menu: [{ id: 'dashboard', label: '대시보드' }],
  metrics: [],
  queries: [],
  tableView: { id: 'main', title: 'Main', subtitle: '', statusLabel: '', columns: [{ key: 'name', label: 'Name' }], rows: [] },
  builder: { title: 'Admin builder', description: '', steps: [] },
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-workspace-app-drafts-'));
});

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('Workspace Apps draft store', () => {
  it('stores a validated draft record without changing app.yaml', () => {
    fs.mkdirSync(path.join(root, 'apps', 'sales-ops'), { recursive: true });
    fs.writeFileSync(path.join(root, 'apps', 'sales-ops', 'app.yaml'), 'original app yaml', 'utf8');

    const draft = saveWorkspaceAppDraft({
      projectRoot: root,
      projectId: 'project-1',
      definition,
      actorUserId: 42,
      draftPreview: {
        title: '변경안',
        summary: 'preview only',
        changes: [{ path: 'tableView.title', before: 'Main', after: 'New Main', risk: 'low' }],
      },
    });

    expect(draft).toMatchObject({ appId: 'sales-ops', projectId: 'project-1', actorUserId: 42, status: 'draft' });
    const savedPath = path.join(root, '.workspace-apps', 'drafts', 'sales-ops', `${draft.id}.json`);
    expect(JSON.parse(fs.readFileSync(savedPath, 'utf8'))).toMatchObject({ id: draft.id, baseSourcePath: 'apps/sales-ops/app.yaml' });
    expect(fs.readFileSync(path.join(root, 'apps', 'sales-ops', 'app.yaml'), 'utf8')).toBe('original app yaml');
  });

  it('lists drafts newest-first and reads one draft by id', () => {
    const first = saveWorkspaceAppDraft({
      projectRoot: root,
      projectId: 'project-1',
      definition,
      actorUserId: 42,
      now: new Date('2026-08-12T00:00:00.000Z'),
      draftPreview: { title: 'First', summary: '', changes: [] },
    });
    const second = saveWorkspaceAppDraft({
      projectRoot: root,
      projectId: 'project-1',
      definition,
      actorUserId: 42,
      now: new Date('2026-08-12T00:01:00.000Z'),
      draftPreview: { title: 'Second', summary: '', changes: [] },
    });

    expect(listWorkspaceAppDrafts({ projectRoot: root, appId: 'sales-ops' }).map((draft) => draft.id)).toEqual([second.id, first.id]);
    expect(readWorkspaceAppDraft({ projectRoot: root, appId: 'sales-ops', draftId: first.id })).toMatchObject({ id: first.id, draftPreview: { title: 'First' } });
    expect(readWorkspaceAppDraft({ projectRoot: root, appId: 'sales-ops', draftId: '00000000-0000-0000-0000-000000000000' })).toBeNull();
  });
});
