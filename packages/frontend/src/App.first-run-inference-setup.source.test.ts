import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const app = fs.readFileSync(path.resolve(__dirname, 'App.tsx'), 'utf8');
const setup = fs.readFileSync(path.resolve(__dirname, 'components/onboarding/FirstRunInferenceSetup.tsx'), 'utf8');
const aiTeam = fs.readFileSync(path.resolve(__dirname, 'components/agents/AITeamHome.tsx'), 'utf8');

describe('OSS first-run inference setup', () => {
  it('routes only first-admin creation through the provider setup gate', () => {
    expect(app).toContain("localStorage.setItem('tower:firstRunInferenceSetup', 'pending')");
    expect(app).toContain('setFirstRunInferenceSetup(true)');
    expect(app).toContain('if (firstRunInferenceSetup && token)');
  });

  it('uses the authenticated encrypted provider setup API and clears the browser secret', () => {
    expect(setup).toContain('/admin/inference-setup/apply');
    expect(setup).toContain('Authorization: `Bearer ${token}`');
    expect(setup).toContain("setDraft((current) => ({ ...current, apiKey: '' }))");
    expect(setup).not.toContain('localStorage.setItem');
  });

  it('creates and opens the first default teammate without a reload', () => {
    const gate = app.slice(app.indexOf('if (firstRunInferenceSetup && token)'), app.indexOf('\n\n  return (', app.indexOf('if (firstRunInferenceSetup && token)')));
    expect(setup).toContain("modelId: 'openrouter/auto'");
    expect(setup).toContain('/primary-agent-commands/bootstrap');
    expect(setup).toContain("face: 'character:core-talent'");
    expect(setup).not.toContain('onChange={(event) => setDraft({ ...draft, modelId: event.target.value })}');
    expect(gate).toContain("localStorage.removeItem('tower:firstRunInferenceSetup')");
    expect(gate).toContain('setDefaults({ session: model, ai_reply: model, ai_task: model })');
    expect(gate).toContain('useProjectStore.getState().addProject(project)');
    expect(gate).toContain('useSessionStore.getState().addSession(session)');
    expect(gate).toContain('useFileStore.getState().openChatTab(session.id)');
  });

  it('does not count a file-only Project as an AI teammate', () => {
    expect(aiTeam).toContain('project.agent?.explicit === true');
  });
});
