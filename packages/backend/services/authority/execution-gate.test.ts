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
    expect(result.reason).toContain('does not have access');
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

  it('allows trusted Project members to reveal attached values and denies restricted/deployed profiles', () => {
    const member = evaluateExecutionGate({ ...memberCtx, actionClass: 'secret-read' });
    expect(member.decision).toBe('allow');

    const owner = evaluateExecutionGate({
      ...memberCtx,
      projectRole: 'owner',
      actionClass: 'secret-read',
      policy: { secretValueVisibility: 'owner_admin' },
    });
    expect(owner.decision).toBe('allow');

    const restricted = evaluateExecutionGate({
      ...memberCtx,
      actionClass: 'secret-read',
      policy: { trustLevel: 'restricted', secretValueVisibility: 'project_members' },
    });
    expect(restricted.decision).toBe('deny');

    const admin = evaluateExecutionGate({
      ...memberCtx,
      userRole: 'admin',
      projectMember: true,
      projectRole: null,
      actionClass: 'secret-read',
      policy: { secretValueVisibility: 'admin_only' },
    });
    expect(admin.decision).toBe('allow');
  });

  it('lets an invited operator manage connections and explicitly enabled host actions', () => {
    const credentialAdmin = evaluateExecutionGate({
      ...memberCtx,
      userRole: 'operator',
      projectMember: true,
      projectRole: null,
      actionClass: 'credential-admin',
    });
    expect(credentialAdmin.decision).toBe('allow');
    expect(credentialAdmin.requiredCapability).toBe('credential:admin');

    const hostAdmin = evaluateExecutionGate({
      ...memberCtx,
      userRole: 'operator',
      projectMember: false,
      projectRole: null,
      actionClass: 'host-admin',
      explicitConfirmation: true,
      policy: { allowHostAdmin: true },
    });
    expect(hostAdmin.decision).toBe('allow');
    expect(hostAdmin.requiredCapability).toBe('system:admin');
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

  it('denies uninvited admins even when deployment is confirmed', () => {
    const result = evaluateExecutionGate({
      userId: 1,
      userRole: 'admin',
      projectMember: false,
      projectRole: null,
      actionClass: 'deploy',
      explicitConfirmation: true,
    });
    expect(result.decision).toBe('deny');
  });

  it.each(['admin', 'operator'])('requires membership for %s attached-credential execution while retaining management authority', (role) => {
    expect(evaluateExecutionGate({ userId: 1, userRole: role, projectMember: false, actionClass: 'credential-admin' }).decision).toBe('deny');
    expect(evaluateExecutionGate({ userId: 1, userRole: role, projectMember: false, actionClass: 'secret-read' }).decision).toBe('deny');
  });

  it('returns canonical policy and capability metadata', () => {
    const result = evaluateExecutionGate({ ...memberCtx, actionClass: 'credential-use', credentialAvailable: true });
    expect(result.policyId).toBe('tower.control-plane.authorization.v1');
    expect(result.requiredCapability).toBe('credential:execute');
  });

  it('classifies high impact actions', () => {
    expect(isHighImpactExecutionAction('read')).toBe(false);
    expect(isHighImpactExecutionAction('credential-use')).toBe(false);
    expect(isHighImpactExecutionAction('deploy')).toBe(true);
    expect(isHighImpactExecutionAction('secret-read')).toBe(true);
  });
});


describe('Agent capability ceiling in the execution gate', () => {
  const context = { userId: 7, projectId: 'agent-a', projectMember: true, projectWritable: true };
  const cases = [
    ['cross-project', 'allowCrossProject'], ['self-hosted-server', 'allowCustomerVmOps'],
    ['container', 'allowContainerOps'], ['deploy', 'allowDeploy'],
  ] as const;

  it.each(cases)('%s requires Agent policy, not elevated requester role', (actionClass, flag) => {
    for (const userRole of ['member', 'operator', 'admin']) {
      const input = { ...context, userRole, actionClass, explicitConfirmation: true, credentialAvailable: true };
      expect(evaluateExecutionGate(input).decision).toBe('deny');
      expect(evaluateExecutionGate({ ...input, policy: { [flag]: true } }).decision).toBe('allow');
      expect(evaluateExecutionGate({ ...input, policy: { trustLevel: 'ops', [flag]: false } }).decision).toBe('deny');
    }
  });

  it.each(['member', 'operator', 'admin'])('keeps restricted Agent read-only for %s', userRole => {
    const input = { ...context, userRole, policy: { trustLevel: 'restricted' as const, allowHostAdmin: true, allowDeploy: true } };
    expect(evaluateExecutionGate({ ...input, actionClass: 'read' }).decision).toBe('allow');
    for (const actionClass of ['write', 'credential-use', 'secret-read', 'deploy', 'host-admin'] as const) {
      expect(evaluateExecutionGate({ ...input, actionClass, explicitConfirmation: true }).decision).toBe('deny');
    }
  });

  it.each(['viewer', 'guest', 'unknown'])('does not let %s mutate or execute with project membership', userRole => {
    for (const actionClass of ['write', 'install-tool', 'credential-use', 'secret-read', 'cross-project'] as const) {
      expect(evaluateExecutionGate({ ...context, userRole, actionClass, policy: { trustLevel: 'ops' } }).decision).toBe('deny');
    }
  });

  it('respects explicit read-only project sharing', () => {
    expect(evaluateExecutionGate({ ...context, userRole: 'member', projectWritable: false, actionClass: 'write' }).decision).toBe('deny');
    expect(evaluateExecutionGate({ ...context, userRole: 'member', projectWritable: false, actionClass: 'read' }).decision).toBe('allow');
  });

  it('requires identity even for platform administrators', () => {
    for (const userId of [undefined, 0, -1, 1.2]) {
      expect(evaluateExecutionGate({ ...context, userId, userRole: 'admin', actionClass: 'read' }).decision).toBe('deny');
    }
  });

  it('requires both explicit host capability and platform entrance authorization', () => {
    const input = { ...context, actionClass: 'host-admin' as const, explicitConfirmation: true };
    expect(evaluateExecutionGate({ ...input, userRole: 'admin' }).decision).toBe('deny');
    expect(evaluateExecutionGate({ ...input, userRole: 'operator', policy: { allowHostAdmin: true } }).decision).toBe('allow');
    expect(evaluateExecutionGate({ ...input, userRole: 'admin', policy: { allowHostAdmin: true } }).decision).toBe('allow');
    expect(evaluateExecutionGate({ ...input, userRole: 'admin', policy: { allowHostAdmin: true }, explicitConfirmation: false }).decision).toBe('needs_confirmation');
  });

  it('does not reinterpret explicit admin-only reveal as shared credential management', () => {
    expect(evaluateExecutionGate({ ...context, userRole: 'operator', actionClass: 'secret-read', policy: { secretValueVisibility: 'admin_only' } }).decision).toBe('deny');
    expect(evaluateExecutionGate({ ...context, userRole: 'admin', actionClass: 'secret-read', auditAvailable: false }).decision).toBe('deny');
  });
});
