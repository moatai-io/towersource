import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveWorkspaceAppDraft } from './app-draft-store.js';
import { applyWorkspaceAppDraftPublish, previewWorkspaceAppDraftPublish } from './app-publish-preview.js';
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
  sourcePath: 'apps/sales-ops/app.yaml',
  source: { provider: 'sqlite', databasePath: 'apps/sales-ops/data.sqlite', schema: 'public' },
  menu: [{ id: 'dashboard', label: '대시보드' }],
  metrics: [],
  queries: [],
  tableView: { id: 'main', title: '거래처 운영 현황', subtitle: '', statusLabel: '', columns: [{ key: 'name', label: '거래처' }], rows: [] },
  builder: { title: 'Admin builder', description: '', steps: [] },
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-workspace-publish-preview-'));
  fs.mkdirSync(path.join(root, 'apps', 'sales-ops'), { recursive: true });
  fs.writeFileSync(path.join(root, 'apps', 'sales-ops', 'app.yaml'), `id: sales-ops
name: Sales Ops
title: 영업 운영 현황
tableView:
  id: main
  title: 거래처 운영 현황
  columns:
    - key: name
      label: 거래처
`, 'utf8');
});

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('Workspace Apps publish preview', () => {
  it('builds a before/after preview and hashes without writing app.yaml', () => {
    const draft = saveWorkspaceAppDraft({
      projectRoot: root,
      projectId: 'project-1',
      definition,
      actorUserId: 42,
      draftPreview: {
        title: '변경안',
        summary: 'preview only',
        changes: [
          { path: 'tableView.title', before: '거래처 운영 현황', after: '거래처 파이프라인 현황', risk: 'low' },
          { path: 'tableView.columns[0].label', before: '거래처', after: '거래처명', risk: 'low' },
        ],
      },
    });
    const before = fs.readFileSync(path.join(root, 'apps', 'sales-ops', 'app.yaml'), 'utf8');
    const preview = previewWorkspaceAppDraftPublish({ projectRoot: root, definition, draft });
    expect(preview).toMatchObject({ appId: 'sales-ops', draftId: draft.id, sourcePath: 'apps/sales-ops/app.yaml' });
    expect(preview.beforeHash).toHaveLength(64);
    expect(preview.afterHash).toHaveLength(64);
    expect(preview.previewHash).toHaveLength(64);
    expect(preview.afterText).toContain('거래처 파이프라인 현황');
    expect(preview.afterText).toContain('거래처명');
    expect(fs.readFileSync(path.join(root, 'apps', 'sales-ops', 'app.yaml'), 'utf8')).toBe(before);
  });

  it('applies publish only with confirmation and matching hashes', () => {
    const draft = saveWorkspaceAppDraft({
      projectRoot: root,
      projectId: 'project-1',
      definition,
      actorUserId: 42,
      draftPreview: { title: '변경안', summary: '', changes: [{ path: 'tableView.title', before: '거래처 운영 현황', after: '거래처 파이프라인 현황', risk: 'low' }] },
    });
    const preview = previewWorkspaceAppDraftPublish({ projectRoot: root, definition, draft });
    expect(() => applyWorkspaceAppDraftPublish({
      projectRoot: root,
      definition,
      draft,
      actorUserId: 42,
      confirmed: false,
      expectedBeforeHash: preview.beforeHash,
      previewHash: preview.previewHash,
    })).toThrow('requires explicit confirmation');

    const result = applyWorkspaceAppDraftPublish({
      projectRoot: root,
      definition,
      draft,
      actorUserId: 42,
      confirmed: true,
      expectedBeforeHash: preview.beforeHash,
      previewHash: preview.previewHash,
      now: new Date('2026-08-12T00:00:00.000Z'),
    });
    expect(result).toMatchObject({ appId: 'sales-ops', draftId: draft.id, status: 'published', actorUserId: 42 });
    expect(fs.readFileSync(path.join(root, 'apps', 'sales-ops', 'app.yaml'), 'utf8')).toContain('거래처 파이프라인 현황');
    expect(fs.existsSync(path.join(root, '.workspace-apps', 'publishes', 'sales-ops', `${result.id}.json`))).toBe(true);
  });

  it('rejects stale before hashes before writing', () => {
    const draft = saveWorkspaceAppDraft({
      projectRoot: root,
      projectId: 'project-1',
      definition,
      actorUserId: 42,
      draftPreview: { title: '변경안', summary: '', changes: [{ path: 'tableView.title', before: '거래처 운영 현황', after: '거래처 파이프라인 현황', risk: 'low' }] },
    });
    const preview = previewWorkspaceAppDraftPublish({ projectRoot: root, definition, draft });
    fs.appendFileSync(path.join(root, 'apps', 'sales-ops', 'app.yaml'), '\n# changed elsewhere\n');
    expect(() => applyWorkspaceAppDraftPublish({
      projectRoot: root,
      definition,
      draft,
      actorUserId: 42,
      confirmed: true,
      expectedBeforeHash: preview.beforeHash,
      previewHash: preview.previewHash,
    })).toThrow('stale');
  });

  it('rejects source paths outside the apps app definition boundary', () => {
    const draft = saveWorkspaceAppDraft({
      projectRoot: root,
      projectId: 'project-1',
      definition,
      actorUserId: 42,
      draftPreview: { title: '변경안', summary: '', changes: [] },
    });
    expect(() => previewWorkspaceAppDraftPublish({
      projectRoot: root,
      definition: { ...definition, sourcePath: '../outside.yaml' },
      draft,
    })).toThrow('sourcePath escapes');
  });
});
