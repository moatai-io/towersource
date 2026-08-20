import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const frontendDir = import.meta.dirname;
const backendRoot = path.resolve(frontendDir, '../../../../backend');
const builderPanel = fs.readFileSync(path.join(frontendDir, 'WorkspaceAppBuilderPanel.tsx'), 'utf8');
const types = fs.readFileSync(path.join(frontendDir, 'workspace-app-definition.ts'), 'utf8');
const sampleDefinition = fs.readFileSync(path.join(frontendDir, 'sample-definition.ts'), 'utf8');
const schema = fs.readFileSync(path.join(backendRoot, 'services/workspace-apps/app-definition-schema.ts'), 'utf8');
const route = fs.readFileSync(path.join(backendRoot, 'routes/workspace-apps-api.ts'), 'utf8');

describe('Workspace Apps builder draft preview contract', () => {
  it('models draft preview metadata without adding a write/publish API', () => {
    expect(schema).toContain('WorkspaceAppBuilderDraftPreviewSchema');
    expect(schema).toContain('WorkspaceAppBuilderDraftChangeSchema');
    expect(types).toContain('WorkspaceAppBuilderDraftPreview');
    expect(types).toContain("risk: 'low' | 'medium' | 'high'");
    expect(route).not.toContain("router.put('/:appId");
    expect(route).not.toContain("router.patch('/:appId");
    expect(route).not.toContain("router.post('/:appId/publish");
  });

  it('renders preview-only diff cards and keeps publish disabled', () => {
    expect(builderPanel).toContain('draftPreview');
    expect(builderPanel).toContain("t('workspaceApps.builder.notApplied')");
    expect(builderPanel).toContain("t('workspaceApps.builder.current')");
    expect(builderPanel).toContain("t('workspaceApps.builder.changed')");
    expect(builderPanel).toContain('disabled');
    expect(builderPanel).toContain("t('workspaceApps.builder.publish')");
  });

  it('ships a sales-ops draft preview example in sample fallback metadata', () => {
    expect(sampleDefinition).toContain('draftPreview');
    expect(sampleDefinition).toContain('변경안 미리보기');
    expect(sampleDefinition).toContain('tableView.title');
    expect(sampleDefinition).toContain('source.provider');
  });
});
