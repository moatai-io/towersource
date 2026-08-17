import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const frontendDir = import.meta.dirname;
const backendRoot = path.resolve(frontendDir, '../../../../backend');
const route = fs.readFileSync(path.join(backendRoot, 'routes/workspace-apps-api.ts'), 'utf8');
const draftStore = fs.readFileSync(path.join(backendRoot, 'services/workspace-apps/app-draft-store.ts'), 'utf8');
const client = fs.readFileSync(path.join(frontendDir, 'workspace-app-api.ts'), 'utf8');
const home = fs.readFileSync(path.join(frontendDir, 'WorkspaceAppsHome.tsx'), 'utf8');
const builderPanel = fs.readFileSync(path.join(frontendDir, 'WorkspaceAppBuilderPanel.tsx'), 'utf8');

describe('Workspace Apps draft save contract', () => {
  it('adds draft save/list/read endpoints but no publish endpoint', () => {
    expect(route).toContain("router.get('/:appId/drafts'");
    expect(route).toContain("router.get('/:appId/drafts/:draftId'");
    expect(route).toContain("router.post('/:appId/drafts'");
    expect(route).toContain('canManageProjectApps');
    expect(route).toContain("role === 'viewer' || role === 'guest'");
    expect(route).toContain('WorkspaceAppBuilderDraftPreviewSchema.parse');
    expect(route).toContain('listWorkspaceAppDrafts');
    expect(route).toContain('readWorkspaceAppDraft');
    expect(route).toContain('saveWorkspaceAppDraft');
    expect(route).not.toContain("router.post('/:appId/publish");
    expect(route).not.toContain('writeFileSync(path.join(project.rootPath, definition.sourcePath');
  });

  it('stores draft records under .workspace-apps/drafts without touching app.yaml', () => {
    expect(draftStore).toContain("const DRAFTS_DIR = '.workspace-apps/drafts'");
    expect(draftStore).toContain('WorkspaceAppDraftRecordSchema');
    expect(draftStore).toContain('listWorkspaceAppDrafts');
    expect(draftStore).toContain('readWorkspaceAppDraft');
    expect(draftStore).toContain("status: z.literal('draft')");
    expect(draftStore).toContain("flag: 'wx'");
    expect(draftStore).not.toContain('app.yaml');
  });

  it('connects frontend draft save while keeping publish disabled', () => {
    expect(client).toContain('fetchWorkspaceAppDrafts');
    expect(client).toContain('fetchWorkspaceAppDraft');
    expect(client).toContain('createWorkspaceAppDraft');
    expect(client).toContain("/api/workspace-apps/${encodeURIComponent(input.appId)}/drafts");
    expect(home).toContain('fetchWorkspaceAppDrafts({ projectId, appId: definition.id, limit: 5 })');
    expect(home).toContain('handleSaveDraft');
    expect(home).toContain('createWorkspaceAppDraft({ projectId, appId: definition.id, draftPreview: definition.builder.draftPreview })');
    expect(builderPanel).toContain('저장된 변경안');
    expect(builderPanel).toContain('변경안 저장');
    expect(builderPanel).toContain('확인하고 화면에 반영');
  });
});
