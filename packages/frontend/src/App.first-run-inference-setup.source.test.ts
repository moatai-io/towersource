import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const app = fs.readFileSync(path.resolve(__dirname, 'App.tsx'), 'utf8');
const bootstrap = fs.readFileSync(path.resolve(__dirname, 'hooks/useAppBootstrap.ts'), 'utf8');
const setup = fs.readFileSync(path.resolve(__dirname, 'components/onboarding/FirstRunInferenceSetup.tsx'), 'utf8');
const aiTeam = fs.readFileSync(path.resolve(__dirname, 'components/agents/AITeamHome.tsx'), 'utf8');
const onboardingEn = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'locales/en/onboarding.json'), 'utf8'));
const onboardingKo = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'locales/ko/onboarding.json'), 'utf8'));

describe('OSS first-run inference setup', () => {
  it('routes only first-admin creation through the provider setup gate', () => {
    expect(app).toContain("localStorage.setItem('tower:firstRunInferenceSetup', 'pending')");
    expect(app).toContain('setFirstRunInferenceSetup(true)');
    expect(app).toContain('if (firstRunInferenceSetup && token && !firstRunInferenceSetupResolved)');
    expect(bootstrap).toContain("data.inferenceReadiness?.status === 'ready'");
    expect(app).toContain("localStorage.removeItem('tower:firstRunInferenceSetup')");
  });

  it('does not expose a server-provisioned LiteLLM key to the first admin', () => {
    expect(bootstrap).toContain("data.inferenceReadiness?.status === 'ready'");
    expect(bootstrap).not.toContain('data.inferenceReadiness.apiKey');
    expect(setup).not.toContain('litellm');
  });

  it('uses the authenticated encrypted provider setup API and clears the browser secret', () => {
    expect(setup).toContain('/admin/inference-setup/apply');
    expect(setup).toContain('Authorization: `Bearer ${token}`');
    expect(setup).toContain("setDraft((current) => ({ ...current, apiKey: '' }))");
    expect(setup).not.toContain('localStorage.setItem');
  });

  it('makes clear that Firecrawl is optional during the required AI connection', () => {
    expect(setup).toContain("t('provider.optionalWebSearch')");
    expect(onboardingEn.provider.optionalWebSearch).toContain('enough to get started');
    expect(onboardingEn.provider.optionalWebSearch).toContain('Firecrawl is optional');
    expect(onboardingKo.provider.optionalWebSearch).toContain('AI 연결만으로 시작');
    expect(onboardingKo.provider.optionalWebSearch).toContain('Firecrawl은 선택 사항');
  });

  it('creates and opens the first default teammate without a reload', () => {
    const gate = app.slice(app.indexOf('if (firstRunInferenceSetup && token)'), app.indexOf('\n\n  return (', app.indexOf('if (firstRunInferenceSetup && token)')));
    expect(setup).toContain("modelId: 'openrouter/auto'");
    expect(setup).not.toContain('openai-responses-compatible');
    expect(setup).toContain('/primary-agent-commands/bootstrap');
    expect(setup).toContain("face: 'character:core-talent'");
    expect(setup).not.toContain('onChange={(event) => setDraft({ ...draft, modelId: event.target.value })}');
    expect(gate).toContain("localStorage.removeItem('tower:firstRunInferenceSetup')");
    expect(gate).toContain('setDefaults({ session: model, ai_reply: model, ai_task: model })');
    expect(gate).toContain('useProjectStore.getState().addProject(project)');
    expect(gate).toContain('useSessionStore.getState().addSession(session)');
    expect(gate).toContain('useFileStore.getState().openChatTab(session.id)');
    expect(onboardingEn.provider.next).toContain('create and open your first AI teammate');
    expect(onboardingKo.provider.next).toContain('첫 AI 동료를 만들고 바로 엽니다');
  });

  it('includes active non-system Projects in the Agent directory while excluding system workspaces', () => {
    expect(aiTeam).toContain('const teammates = projects.filter((project) => !project.systemKey && !project.archived);');
    expect(aiTeam).toContain("t('legacyTeammate')");
  });
});
