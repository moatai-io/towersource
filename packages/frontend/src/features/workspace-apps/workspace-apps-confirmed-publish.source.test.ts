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

describe('Workspace Apps confirmed publish contract', () => {
  it('adds confirmed publish behind hash and confirmation checks', () => {
    expect(route).toContain("router.post('/:appId/drafts/:draftId/publish'");
    expect(route).toContain('confirmed = req.body?.confirmed === true');
    expect(route).toContain('expectedBeforeHash');
    expect(route).toContain('previewHash');
    expect(route).toContain('applyWorkspaceAppDraftPublish');
    expect(route).toContain('canManageProjectApps');
  });

  it('uses atomic source write only after recomputing preview hashes', () => {
    expect(service).toContain('applyWorkspaceAppDraftPublish');
    expect(service).toContain('requires explicit confirmation');
    expect(service).toContain('workspace app publish preview is stale');
    expect(service).toContain('workspace app publish hash mismatch');
    expect(service).toContain('atomicWriteFile');
    expect(service).toContain('fs.renameSync(tmpPath, targetPath)');
    expect(service).toContain("'.workspace-apps', 'publishes'");
  });

  it('requires Tower confirmation before the frontend calls publish', () => {
    expect(client).toContain('publishWorkspaceAppDraft');
    expect(client).toContain('/publish');
    expect(client).toContain('confirmed: input.confirmed');
    expect(home).toContain('useConfirm');
    expect(home).toContain('await confirm({');
    expect(home).not.toContain('window.confirm');
    expect(home).toContain('expectedBeforeHash: publishPreview.beforeHash');
    expect(home).toContain('previewHash: publishPreview.previewHash');
    expect(builderPanel).toContain("workspaceApps.builder.publish");
    expect(builderPanel).toContain("workspaceApps.builder.publishedId");
  });
});
