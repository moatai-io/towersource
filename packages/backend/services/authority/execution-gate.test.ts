import { describe, expect, it } from 'vitest';
import { evaluateExecutionGate, isHighImpactExecutionAction } from './execution-gate.js';

describe('project execution gate', () => {
  const memberCtx = {
    userId: 7,
    userRole: 'member',
    projectId: 'project-1',
    projectMember: true,
    projectRole: 'member',
    executionSurface: 'project-runbox' as const,
  };

  it('allows ordinary project members to execute project-packaged read/write/install actions', () => {
    expect(evaluateExecutionGate({ ...memberCtx, actionClass: 'read' }).decision).toBe('allow');
    expect(evaluateExecutionGate({ ...memberCtx, actionClass: 'write' }).decision).toBe('allow');
    expect(evaluateExecutionGate({ ...memberCtx, actionClass: 'install-tool' }).decision).toBe('allow');
  });

  it('denies non-members even for normal actions', () => {
    const result = evaluateExecutionGate({
      ...memberCtx,
      projectMember: false,
      projectRole: null,
      actionClass: 'read',
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('not a member');
  });

  it('treats credential use as allowed when the project execution context has the credential', () => {
    const result = evaluateExecutionGate({
      ...memberCtx,
      actionClass: 'credential-use',
      credentialAvailable: true,
      credentialClass: 'self-hosted-server-ssh',
      policy: { allowDirectCredentials: true },
    });
    expect(result.decision).toBe('allow');
  });

  it('returns needs_setup when a required credential or tool is missing', () => {
    const noCredential = evaluateExecutionGate({
      ...memberCtx,
      actionClass: 'credential-use',
      credentialAvailable: false,
    });
    expect(noCredential.decision).toBe('needs_setup');
    expect(noCredential.requirements).toContain('credential_grant_or_direct_credential');

    const noTool = evaluateExecutionGate({
      ...memberCtx,
      actionClass: 'write',
      toolAvailable: false,
    });
    expect(noTool.decision).toBe('needs_setup');
    expect(noTool.requirements).toContain('install_or_select_runbox_profile');
  });

  it('keeps secret value visibility admin/owner-only by default', () => {
    const member = evaluateExecutionGate({ ...memberCtx, actionClass: 'secret-read' });
    expect(member.decision).toBe('deny');

    const owner = evaluateExecutionGate({
      ...memberCtx,
      projectRole: 'owner',
      actionClass: 'secret-read',
      policy: { secretValueVisibility: 'owner_admin' },
    });
    expect(owner.decision).toBe('allow');

    const admin = evaluateExecutionGate({
      ...memberCtx,
      userRole: 'admin',
      projectMember: false,
      projectRole: null,
      actionClass: 'secret-read',
    });
    expect(admin.decision).toBe('allow');
  });

  it('allows ops projects to cross project boundaries', () => {
    const result = evaluateExecutionGate({
      ...memberCtx,
      actionClass: 'cross-project',
      policy: { trustLevel: 'ops' },
    });
    expect(result.decision).toBe('allow');
  });

  it('requires setup and confirmation for self-hosted server mutation operations', () => {
    const missingCredential = evaluateExecutionGate({
      ...memberCtx,
      actionClass: 'self-hosted-server',
      policy: { trustLevel: 'ops' },
      credentialAvailable: false,
    });
    expect(missingCredential.decision).toBe('needs_setup');

    const needsConfirmation = evaluateExecutionGate({
      ...memberCtx,
      actionClass: 'self-hosted-server',
      policy: { trustLevel: 'ops' },
      credentialAvailable: true,
      explicitConfirmation: false,
    });
    expect(needsConfirmation.decision).toBe('needs_confirmation');

    const allowed = evaluateExecutionGate({
      ...memberCtx,
      actionClass: 'self-hosted-server',
      policy: { trustLevel: 'ops' },
      credentialAvailable: true,
      explicitConfirmation: true,
    });
    expect(allowed.decision).toBe('allow');
    expect(allowed.auditRequired).toBe(true);
  });

  it('allows observe-only self-hosted server and container operations under ops policy without confirmation', () => {
    const vmStatus = evaluateExecutionGate({
      ...memberCtx,
      actionClass: 'self-hosted-server',
      policy: { trustLevel: 'ops' },
      target: { type: 'self-hosted-server', summary: 'fleet-status.sh', operation: 'status' },
    });
    expect(vmStatus.decision).toBe('allow');

    const containerLogs = evaluateExecutionGate({
      ...memberCtx,
      actionClass: 'container',
      policy: { trustLevel: 'ops' },
      target: { type: 'container', summary: 'docker logs app', operation: 'logs' },
    });
    expect(containerLogs.decision).toBe('allow');
  });

  it('requires confirmation for deploy even in ops projects', () => {
    const result = evaluateExecutionGate({
      ...memberCtx,
      actionClass: 'deploy',
      policy: { trustLevel: 'ops' },
    });
    expect(result.decision).toBe('needs_confirmation');
    expect(result.requirements).toContain('preflight_checks');
  });

  it('lets admins participate without project membership but still preserves high-impact confirmation', () => {
    const result = evaluateExecutionGate({
      userId: 1,
      userRole: 'admin',
      projectMember: false,
      projectRole: null,
      actionClass: 'deploy',
      explicitConfirmation: true,
    });
    expect(result.decision).toBe('allow');
  });

  it('classifies high impact actions', () => {
    expect(isHighImpactExecutionAction('read')).toBe(false);
    expect(isHighImpactExecutionAction('credential-use')).toBe(false);
    expect(isHighImpactExecutionAction('deploy')).toBe(true);
    expect(isHighImpactExecutionAction('secret-read')).toBe(true);
  });
});
