import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const setup = fs.readFileSync(path.resolve(import.meta.dirname, './AgentGoogleConnectionSetup.tsx'), 'utf8');
const preview = fs.readFileSync(path.resolve(import.meta.dirname, './AgentDraftPreview.tsx'), 'utf8');

describe('Primary Agent Google setup during creation', () => {
  it('offers no connection, one organization account, or a dedicated Agent account', () => {
    expect(setup).toContain('연결하지 않음');
    expect(setup).toContain('조직 계정 사용');
    expect(setup).toContain('이 Agent 전용 Google 계정 연결');
    expect(setup).toContain("metadata?.connection_type === 'organization'");
    expect(setup).toContain("credential?.kind === 'gws'");
    expect(setup).toContain("credential?.provider === 'google'");
  });

  it('allows the selected organization Connection only after the new Project exists', () => {
    expect(preview.indexOf("fetch('/api/primary-agent-commands/bootstrap'")).toBeLessThan(preview.indexOf('allowOrganizationGoogleConnection(project.id'));
    expect(setup).toContain("body: JSON.stringify({ mode: 'allow'");
    expect(setup).toContain("granted_via: 'agent_creation'");
  });

  it('starts the Agent-bound OAuth flow with the newly created Project id', () => {
    expect(preview).toContain("googleSetup.mode === 'dedicated'");
    expect(preview).toContain('startDedicatedGoogleOAuth(project.id)');
    expect(setup).toContain('/api/auth/google/agent?projectId=');
  });

  it('does not expose Credential internals in visible account labels', () => {
    expect(setup).toContain('connection.googleAccount || connection.displayName');
    expect(setup).not.toContain('secret_name');
    expect(setup).not.toContain('default_env_name');
  });
});
