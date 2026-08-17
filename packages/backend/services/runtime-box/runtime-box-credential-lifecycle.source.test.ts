import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, 'runtime-box-manager.ts'), 'utf8');
const execEntrySource = source.slice(source.indexOf('export async function execInBox'), source.indexOf('async function execInBoxWithActivityLock'));
const execSource = source.slice(source.indexOf('async function execInBoxWithActivityLock'));

describe('Runtime Box command-scoped credential lifecycle contract', () => {
  it('resolves current Vault policy after ensuring the box is running and before each docker exec', () => {
    const ensureRunning = execEntrySource.indexOf('await ensureRunning(req.boxId, req.userId)');
    const resolveVault = execSource.indexOf('await resolveRuntimeBoxApiKeyEnv({');
    const dockerExec = execSource.indexOf('await execDockerCommand(runningBox, finalReq, cwd)');

    expect(ensureRunning).toBeGreaterThanOrEqual(0);
    expect(resolveVault).toBeGreaterThanOrEqual(0);
    expect(dockerExec).toBeGreaterThan(resolveVault);
    expect(execEntrySource).not.toContain('startDockerContainer(');
    expect(execSource.slice(0, dockerExec)).not.toContain('startDockerContainer(');
  });

  it('applies credential suppression to the legacy GitHub identity bridge too', () => {
    expect(execSource).toContain('const githubReq = credentialSuppression.suppress\n        ? req\n        : await withProjectGitHubIdentityEnv(runningBox, req);');
  });

  it('cleans the command credential root even when resolution, materialization, or execution fails', () => {
    const lifecycleStart = execSource.indexOf('const execution = await (async () => {');
    const lifecycleEnd = execSource.indexOf('const { execResult, prepared, vaultEnv', lifecycleStart);
    const lifecycle = execSource.slice(lifecycleStart, lifecycleEnd);

    expect(lifecycle).toContain('try {');
    expect(lifecycle).toContain('} finally {');
    expect(lifecycle).toContain('await preparedCleanup?.();');
    expect(lifecycle).toContain('await dockerExecShell(containerRef, `rm -rf ${shellQuote(credentialRoot)}`, 10_000);');
    expect(lifecycle.indexOf('await resolveRuntimeBoxApiKeyEnv({')).toBeLessThan(lifecycle.indexOf('} finally {'));
  });
});
