import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listProjectRuntimeCredentialEnvNames } from '../credential-vault/credential-vault-service.js';
import { resolveRemoteWorkbenchCredentialEnv } from './workbench-remote-credential-resolution.js';
import { createHostCredentialBashOperations } from './workbench-host-credential-operations.js';

vi.mock('../credential-vault/credential-vault-service.js', () => ({ listProjectRuntimeCredentialEnvNames: vi.fn() }));
vi.mock('./workbench-remote-credential-resolution.js', () => ({ resolveRemoteWorkbenchCredentialEnv: vi.fn() }));

const base = {
  exec: vi.fn(async (_command: string, _cwd: string, options: any) => {
    options.onData(Buffer.from(`token=${options.env.OPENAI_API_KEY ?? 'missing'}`));
    return { exitCode: 0 };
  }),
};

describe('native host bash Project Credential operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    base.exec.mockReset().mockImplementation(async (_command: string, _cwd: string, options: any) => {
      options.onData(Buffer.from(`token=${options.env.OPENAI_API_KEY ?? 'missing'}`));
      return { exitCode: 0 };
    });
    vi.mocked(listProjectRuntimeCredentialEnvNames).mockResolvedValue(['NAVER_CLIENT_ID', 'OPENAI_API_KEY']);
    vi.mocked(resolveRemoteWorkbenchCredentialEnv).mockImplementation(async ({ request }: any) => ({
      request: { ...request, env: { ...(request.env ?? {}), OPENAI_API_KEY: 'host-run-secret' } },
      environmentKeys: ['OPENAI_API_KEY'],
      injected: [{ credentialId: 'openai', envName: 'OPENAI_API_KEY' }], materializedFiles: [], skipped: [],
      suppressed: false,
    }));
  });

  it('keeps canonical Project root separate from command cwd', async () => {
    const base = { exec: vi.fn(async () => ({ exitCode: 0 })) };
    const operations = createHostCredentialBashOperations({ projectId: 'project-a', userId: 7, projectRoot: '/project', base });
    await operations.exec('python ../.tower/skill-assets/probe.py', '/project/work', { onData: () => {}, env: {} });
    expect(resolveRemoteWorkbenchCredentialEnv).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: '/project', request: expect.objectContaining({ cwd: '/project/work' }) }));
  });
  it('does not resolve credentials for an already cancelled command', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(createHostCredentialBashOperations({ projectId: 'project-a', userId: 7, base }).exec('sleep 30', '/project', { onData: () => {}, signal: controller.signal })).rejects.toThrow('aborted');
    expect(listProjectRuntimeCredentialEnvNames).not.toHaveBeenCalled();
    expect(resolveRemoteWorkbenchCredentialEnv).not.toHaveBeenCalled();
    expect(base.exec).not.toHaveBeenCalled();
  });

  it('does not start execution after cancellation during credential resolution', async () => {
    const controller = new AbortController();
    const resolver = vi.mocked(resolveRemoteWorkbenchCredentialEnv).getMockImplementation()!;
    vi.mocked(resolveRemoteWorkbenchCredentialEnv).mockImplementationOnce(async input => {
      const result = await resolver(input);
      controller.abort();
      return result;
    });
    await expect(createHostCredentialBashOperations({ projectId: 'project-a', userId: 7, base }).exec('sleep 30', '/project', { onData: () => {}, signal: controller.signal })).rejects.toThrow('aborted');
    expect(base.exec).not.toHaveBeenCalled();
  });

  it('cleans materialized files if cancelled while preparing them', async () => {
    const controller = new AbortController();
    const payload = Buffer.from(JSON.stringify({ envName: 'CONFIG_PATH', fileName: 'config.json', mode: '0600', credentialType: 'json', value: 'synthetic-fixture' })).toString('base64');
    vi.mocked(resolveRemoteWorkbenchCredentialEnv).mockImplementationOnce(async ({ request }: any) => ({
      request: { ...request, env: { TOWER_REMOTE_FILE_CREDENTIAL_0: payload } },
      injected: [], materializedFiles: [], environmentKeys: [], skipped: [], suppressed: false,
    }));
    const writeFile = fs.writeFile.bind(fs);
    let created = '';
    const spy = vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => {
      await writeFile(...args);
      created = String(args[0]);
      controller.abort();
    });
    try {
      await expect(createHostCredentialBashOperations({ projectId: 'project-a', userId: 7, base }).exec('sleep 30', '/project', { onData: () => {}, signal: controller.signal })).rejects.toThrow('aborted');
      expect(created).not.toBe('');
      expect(base.exec).not.toHaveBeenCalled();
      await expect(fs.access(created)).rejects.toThrow();
      await expect(fs.access(path.dirname(path.dirname(created)))).rejects.toThrow();
    } finally { spy.mockRestore(); }
  });

  it('forwards timeout and the same cancellation signal through credential decoration', async () => {
    const controller = new AbortController();
    base.exec.mockRejectedValueOnce(new Error('aborted'));
    const operations = createHostCredentialBashOperations({ projectId: 'project-a', userId: 7, base });
    await expect(operations.exec('sleep 30', '/project', {
      onData: () => {}, env: {}, timeout: 12, signal: controller.signal,
    })).rejects.toThrow('aborted');
    expect(base.exec).toHaveBeenCalledWith('sleep 30', '/project', expect.objectContaining({
      timeout: 12, signal: controller.signal,
    }));
  });

  it('uses the shared Project command resolver and injects only into the child process', async () => {
    const output: string[] = [];
    const operations = createHostCredentialBashOperations({ projectId: 'project-a', userId: 7, base });
    await operations.exec('openai models list', '/project', { onData: data => output.push(data.toString()), env: { CALLER: 'kept' } });

    expect(resolveRemoteWorkbenchCredentialEnv).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-a', userId: 7,
      request: expect.objectContaining({ command: 'openai models list', env: { CALLER: 'kept' } }),
    }));
    expect(base.exec).toHaveBeenCalledWith('openai models list', '/project', expect.objectContaining({
      env: expect.objectContaining({ CALLER: 'kept', OPENAI_API_KEY: 'host-run-secret' }),
    }));
    expect(process.env.OPENAI_API_KEY).not.toBe('host-run-secret');
  });

  it('redacts injected Credential values from host command output', async () => {
    const output: string[] = [];
    const operations = createHostCredentialBashOperations({ projectId: 'project-a', userId: 7, base });
    await operations.exec('openai models list', '/project', { onData: data => output.push(data.toString()), env: {} });
    expect(output.join('')).toContain('Credential env: injected OPENAI_API_KEY<-openai');
    expect(output.join('')).toContain('token=[REDACTED]');
    expect(output.join('')).not.toContain('host-run-secret');
  });

  it('materializes file Credentials for the command and removes them afterward', async () => {
    const payload = Buffer.from(JSON.stringify({
      envName: 'CONFIG_PATH', fileName: 'config.json', mode: '0600', credentialType: 'json', value: 'file-secret',
    }), 'utf8').toString('base64');
    vi.mocked(resolveRemoteWorkbenchCredentialEnv).mockImplementation(async ({ request }: any) => ({
      request: { ...request, env: { ...(request.env ?? {}), TOWER_REMOTE_FILE_CREDENTIAL_0: payload } },
      environmentKeys: ['TOWER_REMOTE_FILE_CREDENTIAL_0'], injected: [], materializedFiles: [{ credentialId: 'config', envName: 'CONFIG_PATH' }], skipped: [], suppressed: false,
    }));
    let materializedPath = '';
    base.exec.mockImplementationOnce(async (_command: string, _cwd: string, options: any) => {
      materializedPath = options.env.CONFIG_PATH;
      expect(await fs.readFile(materializedPath, 'utf8')).toBe('file-secret');
      expect((await fs.stat(materializedPath)).mode & 0o777).toBe(0o600);
      expect(options.env.TOWER_REMOTE_FILE_CREDENTIAL_0).toBeUndefined();
      return { exitCode: 0 };
    });
    const operations = createHostCredentialBashOperations({ projectId: 'project-a', userId: 7, base });
    await operations.exec('python use_config.py --config $CONFIG_PATH', '/project', { onData: () => {}, env: {} });
    await expect(fs.access(materializedPath)).rejects.toThrow();
  });

  it('materializes an OpenSSH-compatible private key for Operator commands and removes it afterward', async () => {
    const payload = Buffer.from(JSON.stringify({
      envName: 'SSH_KEY_FILE', fileName: 'id_ssh', mode: '0600', credentialType: 'ssh_private_key', value: 'private-key-without-newline',
    }), 'utf8').toString('base64');
    vi.mocked(resolveRemoteWorkbenchCredentialEnv).mockImplementation(async ({ request }: any) => ({
      request: { ...request, env: { ...(request.env ?? {}), TOWER_REMOTE_FILE_CREDENTIAL_0: payload } },
      environmentKeys: ['TOWER_REMOTE_FILE_CREDENTIAL_0'], injected: [], materializedFiles: [{ credentialId: 'ssh-key', envName: 'SSH_KEY_FILE' }], skipped: [], suppressed: false,
    }));
    let materializedPath = '';
    base.exec.mockImplementationOnce(async (_command: string, _cwd: string, options: any) => {
      materializedPath = options.env.SSH_KEY_FILE;
      expect(await fs.readFile(materializedPath, 'utf8')).toBe('private-key-without-newline\n');
      expect((await fs.stat(materializedPath)).mode & 0o777).toBe(0o600);
      expect(options.env.TOWER_REMOTE_FILE_CREDENTIAL_0).toBeUndefined();
      return { exitCode: 0 };
    });
    const operations = createHostCredentialBashOperations({ projectId: 'project-a', userId: 7, base });
    await operations.exec('ssh -i "$SSH_KEY_FILE" host', '/project', { onData: () => {}, env: {} });
    await expect(fs.access(materializedPath)).rejects.toThrow();
  });

  it.each([false, true])('isolates identical filenames and cleans up after failure=%s', async (fail) => {
    const envelopes = Object.fromEntries(['FIRST_KEY_FILE', 'SECOND_KEY_FILE'].map((envName, index) => [
      `TOWER_REMOTE_FILE_CREDENTIAL_${index}`,
      Buffer.from(JSON.stringify({ envName, fileName: 'id_ssh', mode: '0600', credentialType: 'ssh_private_key', value: `synthetic-key-${index}` })).toString('base64'),
    ]));
    vi.mocked(resolveRemoteWorkbenchCredentialEnv).mockImplementation(async ({ request }: any) => ({
      request: { ...request, env: envelopes }, environmentKeys: Object.keys(envelopes),
      injected: [], materializedFiles: [], skipped: [], suppressed: false,
    }));
    const paths: string[] = [];
    base.exec.mockImplementationOnce(async (_command: string, _cwd: string, options: any) => {
      paths.push(options.env.FIRST_KEY_FILE, options.env.SECOND_KEY_FILE);
      expect(paths[0]).not.toBe(paths[1]);
      for (const [index, target] of paths.entries()) {
        expect(await fs.readFile(target, 'utf8')).toBe(`synthetic-key-${index}\n`);
        expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
      }
      if (fail) throw new Error('synthetic execution failure');
      return { exitCode: 0 };
    });
    const operations = createHostCredentialBashOperations({ projectId: 'project-a', userId: 7, base });
    const execution = operations.exec('synthetic probe', '/project', { onData: () => {}, env: {} });
    if (fail) await expect(execution).rejects.toThrow('synthetic execution failure');
    else await execution;
    expect(paths).toHaveLength(2);
    for (const target of paths) await expect(fs.access(target)).rejects.toThrow();
  });

  it('preserves password bytes and isolates concurrent runs, then retries after failure', async () => {
    const envelope = Buffer.from(JSON.stringify({ envName: 'PASSWORD_FILE', fileName: 'id_ssh', mode: '0600', credentialType: 'ssh_password', value: ' synthetic password ' })).toString('base64');
    vi.mocked(resolveRemoteWorkbenchCredentialEnv).mockImplementation(async ({ request }: any) => ({
      request: { ...request, env: { TOWER_REMOTE_FILE_CREDENTIAL_0: envelope } }, environmentKeys: ['TOWER_REMOTE_FILE_CREDENTIAL_0'], injected: [], materializedFiles: [], skipped: [], suppressed: false,
    }));
    const paths: string[] = [];
    base.exec.mockImplementation(async (command: string, _cwd: string, options: any) => {
      const target = options.env.PASSWORD_FILE;
      paths.push(target);
      expect(await fs.readFile(target, 'utf8')).toBe(' synthetic password ');
      await new Promise(resolve => setTimeout(resolve, 10));
      if (command === 'fail') throw new Error('synthetic failure');
      return { exitCode: 0 };
    });
    const operations = createHostCredentialBashOperations({ projectId: 'project-a', userId: 7, base });
    const run = (command: string) => operations.exec(command, '/project', { onData: () => {}, env: {} });
    await Promise.all([run('one'), run('two')]);
    await expect(run('fail')).rejects.toThrow('synthetic failure');
    await run('retry');
    expect(new Set(paths).size).toBe(4);
    for (const target of paths) await expect(fs.access(target)).rejects.toThrow();
  });

  it.each([['member', 7], ['operator', 8], ['admin', 9]])('runs %s with the same Agent GWS credential and cleans it', async (_role, userId) => {
    const source = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-host-gws-synthetic-'));
    let home = '';
    try {
      await fs.mkdir(path.join(source, 'gws'));
      const synthetic = JSON.stringify({ type: 'authorized_user', refresh_token: 'synthetic-agent-account' });
      await fs.writeFile(path.join(source, 'gws', 'credentials.json'), synthetic);
      const encoded = execFileSync('tar', ['-czf', '-', '-C', source, 'gws']).toString('base64');
      vi.mocked(resolveRemoteWorkbenchCredentialEnv).mockImplementation(async ({ request }: any) => ({
        request: { ...request, env: { TOWER_REMOTE_GWS_CONFIG_B64: encoded, TOWER_REMOTE_GWS_USER_ID: String(userId) } },
        environmentKeys: [], injected: [], materializedFiles: [], skipped: [], suppressed: false,
      }));
      base.exec.mockImplementationOnce(async (_command: string, _cwd: string, options: any) => {
        home = options.env.HOME;
        expect(options.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE).toBe(path.join(options.env.GWS_CONFIG_HOME, 'credentials.json'));
        expect(await fs.readFile(options.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE, 'utf8')).toBe(synthetic);
        expect(options.env.TOWER_REMOTE_GWS_USER_ID).toBeUndefined();
        expect(options.env.TOWER_REMOTE_GWS_CONFIG_B64).toBeUndefined();
        await expect(fs.access(path.join(options.env.GWS_CONFIG_HOME, 'users'))).rejects.toThrow();
        options.onData(Buffer.from(synthetic));
        return { exitCode: 0 };
      });
      const output: string[] = [];
      await createHostCredentialBashOperations({ projectId: 'project-a', userId: Number(userId), base }).exec('gws auth status', '/project', { onData: data => output.push(data.toString()), env: {} });
      expect(output.join('')).not.toContain('synthetic-agent-account');
      expect(output.join('')).toContain('[REDACTED]');
      await expect(fs.access(home)).rejects.toThrow();
    } finally { await fs.rm(source, { recursive: true, force: true }); }
  });

  it('never executes host bash with a legacy personal GWS bundle', async () => {
    const source = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-host-gws-personal-synthetic-'));
    try {
      await fs.mkdir(path.join(source, 'gws', 'users', '7'), { recursive: true });
      await fs.writeFile(path.join(source, 'gws', 'users', '7', 'credentials.json'), '{}');
      const encoded = execFileSync('tar', ['-czf', '-', '-C', source, 'gws']).toString('base64');
      vi.mocked(resolveRemoteWorkbenchCredentialEnv).mockImplementation(async ({ request }: any) => ({
        request: { ...request, env: { TOWER_REMOTE_GWS_CONFIG_B64: encoded, TOWER_REMOTE_GWS_USER_ID: '7' } },
        environmentKeys: [], injected: [], materializedFiles: [], skipped: [], suppressed: false,
      }));
      await expect(createHostCredentialBashOperations({ projectId: 'project-a', userId: 7, base }).exec('gws auth status', '/project', { onData: () => {}, env: {} })).rejects.toThrow('AGENT_GWS_ACCOUNT_MIGRATION_REQUIRED');
      expect(base.exec).not.toHaveBeenCalled();
    } finally { await fs.rm(source, { recursive: true, force: true }); }
  });

  it('removes inherited Vault-managed env before suppression and resolution', async () => {
    vi.mocked(resolveRemoteWorkbenchCredentialEnv).mockImplementation(async ({ request }: any) => ({
      request: { ...request, env: { ...(request.env ?? {}) } }, environmentKeys: [], injected: [], materializedFiles: [], skipped: [], suppressed: true, suppressReason: 'full environment print command',
    }));
    const operations = createHostCredentialBashOperations({ projectId: 'project-a', userId: 7, base });
    await operations.exec('printenv', '/project', { onData: () => {}, env: { NAVER_CLIENT_ID: 'inherited-secret', SAFE: 'kept' } });
    expect(resolveRemoteWorkbenchCredentialEnv).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ env: { SAFE: 'kept' } }),
    }));
    expect(base.exec).toHaveBeenCalledWith('printenv', '/project', expect.objectContaining({ env: { SAFE: 'kept' } }));
  });

  it('preserves suppression decisions from the shared resolver', async () => {
    vi.mocked(resolveRemoteWorkbenchCredentialEnv).mockImplementation(async ({ request }: any) => ({
      request: { ...request, env: { ...(request.env ?? {}) } }, environmentKeys: [], injected: [], materializedFiles: [], skipped: [], suppressed: true, suppressReason: 'full environment print command',
    }));
    const operations = createHostCredentialBashOperations({ projectId: 'project-a', userId: 7, base });
    await operations.exec('printenv', '/project', { onData: () => {}, env: { CALLER: 'kept' } });
    expect(base.exec).toHaveBeenCalledWith('printenv', '/project', expect.objectContaining({ env: { CALLER: 'kept' } }));
  });

  it('reports suppression without exposing Credential values', async () => {
    vi.mocked(resolveRemoteWorkbenchCredentialEnv).mockImplementation(async ({ request }: any) => ({
      request: { ...request, env: { ...(request.env ?? {}) } }, environmentKeys: [], injected: [], materializedFiles: [], skipped: [], suppressed: true, suppressReason: 'full environment print command',
    }));
    const output: string[] = [];
    const operations = createHostCredentialBashOperations({ projectId: 'project-a', userId: 7, base });
    await operations.exec('printenv', '/project', { onData: data => output.push(data.toString()), env: {} });
    expect(output.join('')).toContain('Credential env: suppressed (full environment print command)');
  });
});
