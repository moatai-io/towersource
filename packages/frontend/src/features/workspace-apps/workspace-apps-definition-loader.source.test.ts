import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const frontendSrc = path.resolve(import.meta.dirname, '../..');
const backendRoot = path.resolve(import.meta.dirname, '../../../../backend');
const api = fs.readFileSync(path.join(backendRoot, 'routes/api.ts'), 'utf8');
const workspaceAppsRoute = fs.readFileSync(path.join(backendRoot, 'routes/workspace-apps-api.ts'), 'utf8');
const loader = fs.readFileSync(path.join(backendRoot, 'services/workspace-apps/app-definition-loader.ts'), 'utf8');
const schema = fs.readFileSync(path.join(backendRoot, 'services/workspace-apps/app-definition-schema.ts'), 'utf8');
const home = fs.readFileSync(path.join(frontendSrc, 'features/workspace-apps/WorkspaceAppsHome.tsx'), 'utf8');
const client = fs.readFileSync(path.join(frontendSrc, 'features/workspace-apps/workspace-app-api.ts'), 'utf8');

describe('Workspace Apps definition loader contract', () => {
  it('mounts a private beta API behind the same server gate', () => {
    expect(api).toContain("import workspaceAppsRouter from './workspace-apps-api.js'");
    expect(api).toContain("if (config.workspaceAppsEnabled) router.use('/workspace-apps', workspaceAppsRouter);");
    expect(workspaceAppsRoute).toContain('if (!config.workspaceAppsEnabled) return res.status(404)');
    expect(workspaceAppsRoute).toContain('loadWorkspaceAppDefinitions(project.rootPath)');
  });

  it('validates only project-local app definition files without connecting to Neon', () => {
    expect(loader).toContain("const APPS_DIR = 'apps'");
    expect(loader).toContain("DEFINITION_FILE_NAMES = new Set(['app.yaml', 'app.yml', 'app.json'])");
    expect(loader).toContain('WorkspaceAppDefinitionSchema.parse');
    expect(loader).not.toContain('DATABASE_URL');
    expect(schema).toContain("provider: z.enum(['sqlite', 'neon', 'sample']).default('sample')");
    expect(schema).toContain('databasePath: z.string().max(240).optional()');
  });

  it('fetches workspace definitions and falls back to the sample definition', () => {
    expect(client).toContain('fetchWorkspaceAppDefinitions');
    expect(client).toContain('/api/workspace-apps?');
    expect(home).toContain('fetchWorkspaceAppDefinitions(projectId)');
    expect(home).toContain('setDefinitions([sampleWorkspaceAppDefinition])');
    expect(home).toContain('업무 화면');
  });
});
