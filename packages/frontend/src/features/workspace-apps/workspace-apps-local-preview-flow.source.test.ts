import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const frontendDir = import.meta.dirname;
const home = fs.readFileSync(path.join(frontendDir, 'WorkspaceAppsHome.tsx'), 'utf8');
const builderPanel = fs.readFileSync(path.join(frontendDir, 'WorkspaceAppBuilderPanel.tsx'), 'utf8');
const definitionViewer = fs.readFileSync(path.join(frontendDir, 'WorkspaceAppDefinitionViewer.tsx'), 'utf8');
const draftPreview = fs.readFileSync(path.join(frontendDir, 'workspace-app-draft-preview.ts'), 'utf8');

describe('Workspace Apps local preview flow contract', () => {
  it('lets the home surface apply draft preview without replacing the source definition', () => {
    expect(home).toContain('draftPreviewActive');
    expect(home).toContain('applyWorkspaceAppDraftPreview(definition, draftPreviewActive)');
    expect(home).toContain("workspaceApps.home.previewActive");
    expect(home).toContain('setDraftPreviewActive((active) => !active)');
    expect(home).toContain('definition={definition}');
  });

  it('keeps draft preview display-only and limited to safe presentation fields', () => {
    expect(draftPreview).toContain("if (change.path === 'title')");
    expect(draftPreview).toContain("if (change.path === 'description')");
    expect(draftPreview).toContain("if (change.path === 'tableView.title')");
    expect(draftPreview).toContain("/^tableView\\.columns\\[(\\d+)\\]\\.label$/");
    expect(draftPreview).not.toContain('fetch(');
    expect(draftPreview).not.toContain('localStorage');
  });

  it('shows the validated definition in a viewer and keeps publish disabled', () => {
    expect(home).toContain('setDefinitionViewerOpen(true)');
    expect(home).toContain('WorkspaceAppDefinitionViewer');
    expect(definitionViewer).toContain("workspaceApps.definition.title");
    expect(definitionViewer).toContain('JSON.stringify(definition, null, 2)');
    expect(definitionViewer).toContain("workspaceApps.definition.description");
    expect(builderPanel).toContain("workspaceApps.builder.enablePreview");
    expect(builderPanel).toContain("workspaceApps.builder.disablePreview");
    expect(builderPanel).toContain('disabled');
  });
});
