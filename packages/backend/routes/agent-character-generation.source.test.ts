import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const api = fs.readFileSync(path.resolve(import.meta.dirname, './api.ts'), 'utf8');
const draft = fs.readFileSync(path.resolve(import.meta.dirname, '../../frontend/src/components/files/AgentDraftPreview.tsx'), 'utf8');
const home = fs.readFileSync(path.resolve(import.meta.dirname, '../../frontend/src/components/files/ProjectHome.tsx'), 'utf8');

describe('agent character generation route', () => {
  it('requires an accessible Project and passes its id to Vault resolution', () => {
    expect(api).toContain("const projectId = String(req.body?.projectId || '')");
    expect(api).toContain('isProjectMember(projectId, userId)');
    expect(api).toContain('generateAgentCharacter({ projectId, userId');
    expect(draft).toContain('projectId: sourceProjectId');
    expect(home).toContain('projectId: project.id');
  });

  it('reports secret-free project readiness before exposing custom generation', () => {
    expect(api).toContain("router.get('/agent-characters/readiness'");
    expect(api).toContain("hasProjectApiKeyCredential({ projectId, envName: 'OPENAI_IMAGE_API_KEY' })");
    expect(draft).toContain("fetch(`/api/agent-characters/readiness?projectId=");
    expect(draft).toContain('characterGenerationReady ?');
    expect(draft).toContain("t('agentCreation.customCharacterConnectionRequired')");
  });

  it('never returns raw provider authentication errors or key fragments', () => {
    const route = api.slice(api.indexOf("router.post('/agent-characters/generate'"), api.indexOf("router.patch('/projects/:id/agent-profile'"));
    expect(route).not.toContain('err?.message');
    expect(route).not.toContain('OPENAI_API_KEY 사용 권한');
    expect(route).toContain('OpenAI Image 연결 상태');
  });
});
