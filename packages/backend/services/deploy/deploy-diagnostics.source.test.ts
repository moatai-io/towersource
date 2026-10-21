import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = (path: string) => readFileSync(path, 'utf8');
describe('publishing diagnostics integration', () => {
  it('classifies local copy and manifest errors at the owning operations', () => {
    const text = source('packages/backend/services/deploy/deploy-engine.ts');
    expect(text).toContain("atDeployStage('copy', () => publishStaticLocally");
    expect(text).toContain("atDeployStage('manifest', () => updateManifestAfterDeploy");
    expect(text).toContain("atDeployStage('prepare', () => resolveDeploySlug");
  });
  it('maps thrown failures at API and tool boundaries', () => {
    expect(source('packages/backend/routes/api.ts')).toContain('res.status(500).json(deployErrorResponse(err))');
    const tool = source('packages/backend/engines/pi-publish-tool.ts');
    expect(tool).toContain('const diagnostic = deployErrorResponse(err)');
    expect(tool).toContain('published; URL verification failed. Do not automatically republish.');
  });
});
