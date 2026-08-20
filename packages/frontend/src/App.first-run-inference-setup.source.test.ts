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

  it('continues into first teammate creation only after the creator listener is ready', () => {
    const gate = app.slice(app.indexOf('if (firstRunInferenceSetup && token)'), app.indexOf('\n\n  return (', app.indexOf('if (firstRunInferenceSetup && token)')));
    const listenerIndex = app.indexOf("window.addEventListener('tower-start-agent-academy', handler)");
    const handoffEffectIndex = app.indexOf('if (!openFirstTeammateAfterSetup) return;');
    expect(gate).toContain("localStorage.removeItem('tower:firstRunInferenceSetup')");
    expect(gate).toContain('setOpenFirstTeammateAfterSetup(true)');
    expect(handoffEffectIndex).toBeGreaterThan(listenerIndex);
    expect(app.slice(handoffEffectIndex, handoffEffectIndex + 500)).toContain("new CustomEvent('tower-start-agent-academy')");
  });

  it('does not count a file-only Project as an AI teammate', () => {
    expect(aiTeam).toContain('project.agent?.explicit === true');
  });
});
