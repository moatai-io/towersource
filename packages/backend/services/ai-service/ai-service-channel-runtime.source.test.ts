import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './ai-service-channel-runtime.ts'), 'utf8');

describe('AI Service Channel serving source contract', () => {
  it('does not mint activation evaluation evidence from serving traffic', () => {
    expect(source).toContain("recordEvaluation: false");
    expect(source).toContain("runtimeMode: 'channel'");
    expect(source).not.toContain('recordPassedRuntimeEvaluation');
  });

  it('checks activation readiness before persisting the user message', () => {
    const readiness = source.indexOf('await assertAIServiceActivationReady');
    const appendUser = source.indexOf("role: 'user'");
    expect(readiness).toBeGreaterThan(-1);
    expect(appendUser).toBeGreaterThan(-1);
    expect(readiness).toBeLessThan(appendUser);
  });

  it('keeps serving conversations pinned to tenant, user and their immutable Deployment while the Channel stays active', () => {
    expect(source).toContain('x.tenant_key=$4 AND x.user_key=$5');
    expect(source).toContain("conversation.deployment_status === 'active' || conversation.deployment_status === 'superseded'");
    expect(source).toContain('conversation.active_deployment_id !== conversation.current_deployment_id');
    expect(source).toContain("conversation.channel_status !== 'enabled'");
    expect(source).not.toContain('conversation.active_deployment_id !== conversation.deployment_id');
  });
});
