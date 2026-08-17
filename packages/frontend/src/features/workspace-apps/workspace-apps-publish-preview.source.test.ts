import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const frontendDir = import.meta.dirname;
const backendRoot = path.resolve(frontendDir, '../../../../backend');
const route = fs.readFileSync(path.join(backendRoot, 'routes/workspace-apps-api.ts'), 'utf8');
const service = fs.readFileSync(path.join(backendRoot, 'services/workspace-apps/app-publish-preview.ts'), 'utf8');
const client = fs.readFileSync(path.join(frontendDir, 'workspace-app-api.ts'), 'utf8');
const home = fs.readFileSync(path.join(frontendDir, 'WorkspaceAppsHome.tsx'), 'utf8');
const builderPanel = fs.readFileSync(path.join(frontendDir, 'WorkspaceAppBuilderPanel.tsx'), 'utf8');

describe('Workspace Apps publish preview contract', () => {
  it('keeps publish-preview as a separate intent before confirmed publish', () => {
    expect(route).toContain("router.post('/:appId/drafts/:draftId/publish-preview'");
    expect(route).toContain('canManageProjectApps');
    expect(route).toContain('previewWorkspaceAppDraftPublish');
    expect(route).toContain("router.post('/:appId/drafts/:draftId/publish'");
    expect(route).not.toContain("router.post('/:appId/publish");
  });

  it('computes preview hashes and before/after text before source writes', () => {
    expect(service).toContain('beforeHash');
    expect(service).toContain('afterHash');
    expect(service).toContain('previewHash');
    expect(service).toContain('beforeText');
    expect(service).toContain('afterText');
    expect(service).toContain('resolveSourceFile');
    expect(service).toContain('workspace app sourcePath must be apps/<app>/app.yaml|app.yml|app.json');
    expect(service).toContain('previewWorkspaceAppDraftPublish');
  });

  it('connects frontend publish preview before confirmed publish', () => {
    expect(client).toContain('createWorkspaceAppPublishPreview');
    expect(client).toContain('/publish-preview');
    expect(home).toContain('handlePreviewPublish');
    expect(home).toContain('createWorkspaceAppPublishPreview({ projectId, appId: definition.id, draftId })');
    expect(builderPanel).toContain('반영 전 확인');
    expect(builderPanel).toContain('반영 전 확인 완료');
    expect(builderPanel).toContain('확인하고 화면에 반영');
    expect(builderPanel).toContain('disabled');
  });
});
