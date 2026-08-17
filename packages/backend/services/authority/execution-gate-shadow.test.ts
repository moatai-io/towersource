import { describe, expect, it, vi } from 'vitest';
import {
  classifyShellCommand,
  classifyToolExecutionAction,
  observeExecutionGateShadow,
  shouldHardStopExecutionGateShadow,
  wrapToolsWithExecutionGateShadow,
} from './execution-gate-shadow.js';

describe('execution gate shadow classifier', () => {
  it('classifies ordinary shell reads and writes', () => {
    expect(classifyShellCommand('ls /workspace').actionClass).toBe('read');
    expect(classifyShellCommand('echo hi > notes.txt').actionClass).toBe('write');
  });

  it('classifies installs, self-hosted server, deploy, container, and secret-read shell commands', () => {
    expect(classifyShellCommand('npm install').actionClass).toBe('install-tool');
    expect(classifyShellCommand('ssh admin@10.0.0.1 "pm2 list"').actionClass).toBe('self-hosted-server');
    expect(classifyShellCommand('bash scripts/fleet/fleet-release.sh patch').actionClass).toBe('deploy');
    expect(classifyShellCommand('docker ps').actionClass).toBe('container');
    expect(classifyShellCommand('printenv').actionClass).toBe('secret-read');
  });

  it('adds operation kind for observe-only ops commands', () => {
    expect(classifyShellCommand('pm2 status tower-prod').target?.operation).toBe('status');
    expect(classifyShellCommand('bash ~/tower/scripts/fleet/fleet-status.sh --json').target?.operation).toBe('status');
    expect(classifyShellCommand('docker logs app --tail 20').target?.operation).toBe('logs');
    expect(classifyShellCommand('docker restart app').target?.operation).toBe('restart');
  });

  it('redacts secret-looking command summaries before shadow logging', () => {
    const openAiLikeToken = 'sk-' + 'test1234567890abcdef';
    const githubLikeToken = 'ghp_' + '1234567890abcdef';
    const classified = classifyShellCommand(`curl -H "Authorization: Bearer ${openAiLikeToken}" https://example.com?token=${githubLikeToken}`);
    expect(classified.target?.summary).toContain('Bearer [REDACTED]');
    expect(classified.target?.summary).not.toContain(openAiLikeToken);
    expect(classified.target?.summary).not.toContain(githubLikeToken);
  });

  it('classifies known observe-only fleet scripts separately from mutating variants', () => {
    const status = classifyShellCommand('bash ~/tower/scripts/fleet/check-ai-capabilities.sh demo-server');
    expect(status.actionClass).toBe('self-hosted-server');
    expect(status.target?.operation).toBe('inspect');

    const diff = classifyShellCommand('scripts/skills/deploy-managed-skills.sh --diff demo-server | head -c 12000');
    expect(diff.actionClass).toBe('self-hosted-server');
    expect(diff.target?.operation).toBe('inspect');

    const dirtyCheck = classifyShellCommand('bash ~/tower/scripts/fleet/fleet-remote-dirty-guard.sh demo-server');
    expect(dirtyCheck.actionClass).toBe('self-hosted-server');
    expect(dirtyCheck.target?.operation).toBe('inspect');

    const dirtyApply = classifyShellCommand('bash ~/tower/scripts/fleet/fleet-remote-dirty-guard.sh demo-server --apply');
    expect(dirtyApply.actionClass).toBe('self-hosted-server');
    expect(dirtyApply.target?.operation).toBe('sync');
  });

  it('classifies project_shell through command content', () => {
    const cls = classifyToolExecutionAction('project_shell', { cmd: 'npm run build' });
    expect(cls.actionClass).toBe('read');
  });

  it('classifies known tool names without command content', () => {
    expect(classifyToolExecutionAction('read', { path: 'a.md' }).actionClass).toBe('read');
    expect(classifyToolExecutionAction('write', { path: 'a.md' }).actionClass).toBe('write');
    expect(classifyToolExecutionAction('publish_site', { sourceDir: 'dist' }).actionClass).toBe('deploy');
  });

  it('explicitly classifies Workbench inspect, durable preview, and apply', () => {
    const inspect = classifyToolExecutionAction('workbench_tool_inspect', {});
    const preview = classifyToolExecutionAction('workbench_tool_preview_change', {});
    const apply = classifyToolExecutionAction('workbench_tool_apply_change', { confirmed: true });
    expect(inspect).toMatchObject({ actionClass: 'read', target: { operation: 'inspect' } });
    expect(preview).toMatchObject({ actionClass: 'write', target: { operation: 'write' } });
    expect(apply).toMatchObject({ actionClass: 'install-tool', target: { operation: 'write' }, explicitConfirmation: true });
  });

  it('logs shadow observations for non-read/high-impact results without blocking', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const wrapped = wrapToolsWithExecutionGateShadow([
      {
        name: 'project_shell',
        execute: async (_id: string, params: any) => ({ content: [{ type: 'text', text: params.cmd }] }),
      },
    ], {
      userId: 1,
      userRole: 'member',
      projectId: 'p1',
      projectMember: true,
      projectRole: 'member',
      policy: { trustLevel: 'ops' },
      sessionId: '1234567890',
    });

    const result = await wrapped[0].execute('t1', { cmd: 'ssh host "uptime"' });
    expect(result.content[0].text).toContain('ssh host');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[ExecutionGate:shadow]'));
    spy.mockRestore();
  });

  it('shadow observation allows observe-only ops status/log commands under ops policy', () => {
    const observed = observeExecutionGateShadow({
      userId: 1,
      userRole: 'member',
      projectId: 'p1',
      projectMember: true,
      projectRole: 'member',
      policy: { trustLevel: 'ops' },
    }, 'project_shell', { cmd: 'docker logs app --tail 20' });

    expect(observed.classification.actionClass).toBe('container');
    expect(observed.classification.target?.operation).toBe('logs');
    expect(observed.result.decision).toBe('allow');
  });

  it('shadow observation still returns needs_confirmation for high-impact mutations', () => {
    const observed = observeExecutionGateShadow({
      userId: 1,
      userRole: 'member',
      projectId: 'p1',
      projectMember: true,
      projectRole: 'member',
      policy: { trustLevel: 'ops' },
    }, 'project_shell', { cmd: 'docker restart app' });

    expect(observed.classification.actionClass).toBe('container');
    expect(observed.classification.target?.operation).toBe('restart');
    expect(observed.result.decision).toBe('needs_confirmation');
  });

  it('marks direct tower-prod pm2 lifecycle commands as hard-stops but not log greps', () => {
    const direct = observeExecutionGateShadow({
      userId: 1,
      userRole: 'admin',
      projectId: 'p1',
      projectMember: true,
      projectRole: 'member',
      policy: { trustLevel: 'ops' },
    }, 'bash', { command: 'pm2 restart tower-prod --update-env && sleep 4' });

    expect(direct.classification.actionClass).toBe('deploy');
    expect(direct.classification.hardStopInShadow).toBe(true);
    expect(direct.result.decision).toBe('needs_confirmation');
    expect(shouldHardStopExecutionGateShadow(direct.classification, direct.result)).toBe(true);

    const grep = classifyShellCommand("grep -E 'pm2 restart tower-prod' /home/tower/.pm2/logs/tower-prod-out.log");
    expect(grep.actionClass).toBe('deploy');
    expect(grep.hardStopInShadow).toBe(false);
  });

  it('blocks wrapped direct tower-prod pm2 lifecycle commands before execution', async () => {
    const execute = vi.fn(async () => ({ content: [{ type: 'text', text: 'should not run' }] }));
    const wrapped = wrapToolsWithExecutionGateShadow([
      { name: 'bash', execute },
    ], {
      userId: 1,
      userRole: 'admin',
      projectId: 'p1',
      projectMember: true,
      projectRole: 'member',
      policy: { trustLevel: 'ops' },
      sessionId: '1234567890',
    });

    await expect(wrapped[0].execute({ command: 'pm2 restart tower-prod --update-env' })).rejects.toThrow('ExecutionGate blocked');
    expect(execute).not.toHaveBeenCalled();
  });
});
