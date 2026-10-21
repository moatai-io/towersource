import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'node:child_process';
import { decodeAgentGwsBundle } from './agent-gws-credential-selection.js';
import { afterEach, describe, expect, it } from 'vitest';
import { isSimpleFileInspectionCommand, shouldSuppressCredentialEnv } from '../execution/command-classifier.js';
import type { RuntimeContext } from './types.js';
import {
  clampRuntimeBoxExecTimeoutMs,
  commandIsGwsAuthLogin,
  commandRequestsFinanceGwsProfile,
  commandRequestsGwsConnectionId,
  commandRequestsPersonalGwsProfile,
  isDockerContainerNameConflict,
  isDockerImageMissingError,
  parseRuntimeBoxUserSpec,
  recentWorkspaceOwnershipNormalizeScript,
  runtimeBoxAgentGwsCredentialPermissionsScript,
  runtimeBoxGwsShimScript,
  resolveProjectRuntimeProfile,
  runtimeBoxImageForProfile,
  runtimeBoxImageNeedsRecreate,
  runtimeBoxProjectRootNeedsSync,
  runtimeBoxRootUserArgs,
  runtimeBoxShellCommandForExec,
  shouldRunRuntimeBoxCommandAsRoot,
  summarizeCredentialEnvForRuntimeContext,
  validateWorkbenchToolMutationCandidate,
  withRuntimeBoxTowerIdentityEnv,
} from './runtime-box-manager.js';
import {
  RUNTIME_BOX_EXEC_TIMEOUT_DEFAULT_SEC,
  RUNTIME_BOX_EXEC_TIMEOUT_MAX_SEC,
} from './types.js';

describe('validateWorkbenchToolMutationCandidate', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function fixture(): { storeRoot: string; projectStore: string } {
    const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-workbench-mutation-path-'));
    tempDirs.push(storeRoot);
    const projectStore = path.join(storeRoot, 'projects', 'project-a');
    fs.mkdirSync(projectStore, { recursive: true });
    return { storeRoot, projectStore };
  }

  it('accepts only project-owned RW staging and RO revision directories', async () => {
    const { storeRoot, projectStore } = fixture();
    const staging = path.join(projectStore, 'staging', 'command-1');
    const revision = path.join(projectStore, 'revisions', '000001');
    fs.mkdirSync(staging, { recursive: true });
    fs.mkdirSync(revision, { recursive: true });
    await expect(validateWorkbenchToolMutationCandidate({ projectId: 'project-a', candidateHostPath: staging, candidateMountMode: 'rw', storeRoot })).resolves.toBe(staging);
    await expect(validateWorkbenchToolMutationCandidate({ projectId: 'project-a', candidateHostPath: revision, candidateMountMode: 'ro', storeRoot })).resolves.toBe(revision);
    await expect(validateWorkbenchToolMutationCandidate({ projectId: 'project-a', candidateHostPath: revision, candidateMountMode: 'rw', storeRoot })).rejects.toThrow('not owned');
    await expect(validateWorkbenchToolMutationCandidate({ projectId: 'project-a', candidateHostPath: staging, candidateMountMode: 'ro', storeRoot })).rejects.toThrow('not owned');
  });

  it('rejects another project, unsafe command ids, and non-six-digit revisions', async () => {
    const { storeRoot, projectStore } = fixture();
    const other = path.join(storeRoot, 'projects', 'project-b', 'staging', 'command-1');
    const unsafe = path.join(projectStore, 'staging', 'bad command');
    const revision = path.join(projectStore, 'revisions', '1');
    for (const candidate of [other, unsafe, revision]) fs.mkdirSync(candidate, { recursive: true });
    await expect(validateWorkbenchToolMutationCandidate({ projectId: 'project-a', candidateHostPath: other, candidateMountMode: 'rw', storeRoot })).rejects.toThrow('not owned');
    await expect(validateWorkbenchToolMutationCandidate({ projectId: 'project-a', candidateHostPath: unsafe, candidateMountMode: 'rw', storeRoot })).rejects.toThrow('not owned');
    await expect(validateWorkbenchToolMutationCandidate({ projectId: 'project-a', candidateHostPath: revision, candidateMountMode: 'ro', storeRoot })).rejects.toThrow('not owned');
  });

  it('rejects missing, symlinked, and symlink-ancestor candidates', async () => {
    const { storeRoot, projectStore } = fixture();
    const real = path.join(projectStore, 'real');
    const directLink = path.join(projectStore, 'staging', 'command-link');
    fs.mkdirSync(real, { recursive: true });
    fs.mkdirSync(path.dirname(directLink), { recursive: true });
    fs.symlinkSync(real, directLink, 'dir');
    await expect(validateWorkbenchToolMutationCandidate({ projectId: 'project-a', candidateHostPath: directLink, candidateMountMode: 'rw', storeRoot })).rejects.toThrow(/real directory|symlink/);

    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-workbench-mutation-external-'));
    tempDirs.push(external);
    fs.rmSync(path.join(projectStore, 'staging'), { recursive: true, force: true });
    fs.symlinkSync(external, path.join(projectStore, 'staging'), 'dir');
    const escaped = path.join(projectStore, 'staging', 'command-escape');
    fs.mkdirSync(path.join(external, 'command-escape'));
    await expect(validateWorkbenchToolMutationCandidate({ projectId: 'project-a', candidateHostPath: escaped, candidateMountMode: 'rw', storeRoot })).rejects.toThrow(/symlink|escaped/);

    await expect(validateWorkbenchToolMutationCandidate({ projectId: 'project-a', candidateHostPath: path.join(projectStore, 'revisions', '000999'), candidateMountMode: 'ro', storeRoot })).rejects.toThrow('unavailable');
  });
});

describe('isDockerImageMissingError', () => {
  it('classifies only Docker image availability failures for self-heal', () => {
    expect(isDockerImageMissingError('No such image: sha256:abc')).toBe(true);
    expect(isDockerImageMissingError('Unable to find image locally')).toBe(true);
    expect(isDockerImageMissingError('permission denied on docker.sock')).toBe(false);
  });
});

describe('runtimeBoxImageNeedsRecreate', () => {
  it('recreates only a container that records a different immutable image reference', () => {
    const oldRef = `sha256:${'a'.repeat(64)}`;
    const newRef = `sha256:${'b'.repeat(64)}`;
    expect(runtimeBoxImageNeedsRecreate(oldRef, newRef)).toBe(true);
    expect(runtimeBoxImageNeedsRecreate(newRef, newRef)).toBe(false);
    expect(runtimeBoxImageNeedsRecreate(null, newRef)).toBe(true);
    expect(runtimeBoxImageNeedsRecreate(oldRef, 'tower-runtime-box:node22-python313')).toBe(false);
  });
});

describe('summarizeCredentialEnvForRuntimeContext', () => {
  it('deduplicates credentials that are injected then skipped by a later profile', () => {
    const result = summarizeCredentialEnvForRuntimeContext({
      injected: [
        { credentialId: 'litellm-veritas', envName: 'LITELLM_API_KEY' },
        { credentialId: 'gemini-default', envName: 'GEMINI_API_KEY' },
      ],
      skippedExisting: [
        { credentialId: 'litellm-veritas', envName: 'LITELLM_API_KEY' },
      ],
    });

    expect(result.injected).toEqual([
      { credential_id: 'gemini-default', env_name: 'GEMINI_API_KEY' },
      { credential_id: 'litellm-veritas', env_name: 'LITELLM_API_KEY' },
    ]);
    expect(result.materialized_files).toEqual([]);
    expect(result.skipped_existing).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('keeps genuinely skipped caller-provided env entries visible', () => {
    const result = summarizeCredentialEnvForRuntimeContext({
      injected: [],
      skippedExisting: [
        { credentialId: 'gemini-default', envName: 'GEMINI_API_KEY' },
      ],
    });

    expect(result.injected).toEqual([]);
    expect(result.materialized_files).toEqual([]);
    expect(result.skipped_existing).toEqual([
      { credential_id: 'gemini-default', env_name: 'GEMINI_API_KEY' },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it('includes materialized file credentials and skip reasons without secret values', () => {
    const result = summarizeCredentialEnvForRuntimeContext({
      injected: [],
      materializedFiles: [
        { credentialId: 'n8n-ops-ssh-private-key', envName: 'N8N_OPS_SSH_KEY_FILE', credentialType: 'ssh_private_key' },
      ],
      skippedExisting: [],
      skipped: [
        { credentialId: 'n8n-ops-ssh-private-key', envName: 'N8N_OPS_SSH_PRIVATE_KEY', reason: 'file credential is materialized as path env; raw env not injected' },
      ],
    });

    expect(result.injected).toEqual([]);
    expect(result.materialized_files).toEqual([
      { credential_id: 'n8n-ops-ssh-private-key', env_name: 'N8N_OPS_SSH_KEY_FILE', kind: 'file', credential_type: 'ssh_private_key' },
    ]);
    expect(result.skipped_existing).toEqual([]);
    expect(result.skipped).toEqual([
      { credential_id: 'n8n-ops-ssh-private-key', env_name: 'N8N_OPS_SSH_PRIVATE_KEY', reason: 'file credential is materialized as path env; raw env not injected' },
    ]);
  });
});

describe('clampRuntimeBoxExecTimeoutMs', () => {
  it('defaults to 60 seconds and allows up to 15 minutes for long finite jobs', () => {
    expect(RUNTIME_BOX_EXEC_TIMEOUT_DEFAULT_SEC).toBe(60);
    expect(RUNTIME_BOX_EXEC_TIMEOUT_MAX_SEC).toBe(15 * 60);
    expect(clampRuntimeBoxExecTimeoutMs()).toBe(60_000);
    expect(clampRuntimeBoxExecTimeoutMs(900)).toBe(900_000);
    expect(clampRuntimeBoxExecTimeoutMs(999)).toBe(900_000);
    expect(clampRuntimeBoxExecTimeoutMs(0)).toBe(1_000);
  });
});

describe('GWS command classification', () => {
  it('detects personal GWS profile requests without matching unrelated text', () => {
    expect(commandRequestsPersonalGwsProfile('GWS_PROFILE=personal gws auth status')).toBe(true);
    expect(commandRequestsPersonalGwsProfile('export TOWER_GWS_PROFILE="personal"; gws gmail users messages list')).toBe(true);
    expect(commandRequestsPersonalGwsProfile('echo GWS_PROFILE=personalized && gws auth status')).toBe(false);
    expect(commandRequestsPersonalGwsProfile('gws gmail users messages list')).toBe(false);
  });

  it('keeps personal profile selection explicit instead of treating plain gws as personal', () => {
    expect(commandRequestsPersonalGwsProfile('GWS_PROFILE=personal gws gmail users getProfile --params \'{"userId":"me"}\'')).toBe(true);
    expect(commandRequestsPersonalGwsProfile('gws drive files list --params \'{"pageSize":10}\'')).toBe(false);
  });

  it('detects finance GWS profile requests without matching fallback profile names', () => {
    expect(commandRequestsFinanceGwsProfile('GWS_PROFILE=finance gws gmail users getProfile --params \'{"userId":"me"}\'')).toBe(true);
    expect(commandRequestsFinanceGwsProfile('export TOWER_GWS_PROFILE="finance"; gws gmail users messages list')).toBe(true);
    expect(commandRequestsFinanceGwsProfile('GWS_PROFILE=finance-gmail gws auth status')).toBe(false);
    expect(commandRequestsFinanceGwsProfile('gws gmail users messages list')).toBe(false);
  });

  it('extracts an explicitly selected Agent GWS Connection without accepting unsafe ids', () => {
    expect(commandRequestsGwsConnectionId('GWS_CONNECTION_ID=gws-moat-work gws auth status')).toBe('gws-moat-work');
    expect(commandRequestsGwsConnectionId('export TOWER_GWS_CONNECTION_ID="gws-publishing.test"; gws drive files list')).toBe('gws-publishing.test');
    expect(commandRequestsGwsConnectionId('GWS_CONNECTION_ID=$(cat /tmp/id) gws auth status')).toBeNull();
    expect(commandRequestsGwsConnectionId('gws auth status')).toBeNull();
  });

  it('detects gws auth login commands that need OAuth client materialization', () => {
    expect(commandIsGwsAuthLogin('gws auth login -s gmail --readonly')).toBe(true);
    expect(commandIsGwsAuthLogin('GWS_PROFILE=personal gws auth login')).toBe(true);
    expect(commandIsGwsAuthLogin('gws auth status')).toBe(false);
  });
});

describe('runtimeBoxAgentGwsCredentialPermissionsScript', () => {
  it('applies Agent runtime ownership to root credentials without requester paths or copying', () => {
    const script = runtimeBoxAgentGwsCredentialPermissionsScript('/tmp/gws-config', '1000:1000');
    expect(script).toContain('/tmp/gws-config');
    expect(script).toContain('chmod 0600');
    expect(script).toContain("chown -R '1000:1000'");
    expect(script).not.toContain('/users/');
    expect(script).not.toContain('cp ');
  });
});

describe('local GWS root account materialization primitives', () => {
  it('validates a real archive with the shared selector and applies root-only file permissions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-local-gws-synthetic-'));
    try {
      const source = path.join(root, 'source');
      const dest = path.join(root, 'destination');
      fs.mkdirSync(path.join(source, 'gws'), { recursive: true });
      fs.mkdirSync(dest);
      const credential = JSON.stringify({ type: 'authorized_user', refresh_token: 'synthetic-local-agent' });
      fs.writeFileSync(path.join(source, 'gws', 'credentials.json'), credential);
      fs.writeFileSync(path.join(source, 'gws', 'client_secret.json'), '{}');
      const encoded = execFileSync('tar', ['-czf', '-', '-C', source, 'gws']).toString('base64');
      for (const file of decodeAgentGwsBundle(encoded)) fs.writeFileSync(path.join(dest, file.name), file.content);
      execFileSync('sh', ['-c', runtimeBoxAgentGwsCredentialPermissionsScript(dest)]);
      expect(fs.readFileSync(path.join(dest, 'credentials.json'), 'utf8')).toBe(credential);
      expect(fs.readdirSync(dest).sort()).toEqual(['credentials.json']);
      for (const name of fs.readdirSync(dest)) expect(fs.statSync(path.join(dest, name)).mode & 0o777).toBe(0o600);
      expect(fs.statSync(dest).mode & 0o777).toBe(0o700);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('runtimeBoxGwsShimScript', () => {
  it('supports both known gws package entrypoints and fails loudly otherwise', () => {
    const script = runtimeBoxGwsShimScript();

    expect(script).toContain('exec /usr/bin/gws');
    expect(script).toContain('run-gws.js');
    expect(script).toContain('binary.js');
    expect(script).toContain('index.mjs');
    expect(script).toContain('no supported entrypoint');
    expect(script).not.toContain('command -v gws');
  });
});

describe('withRuntimeBoxTowerIdentityEnv', () => {
  it('injects current Tower requester identity for audit, not GWS account selection', () => {
    expect(withRuntimeBoxTowerIdentityEnv({}, 17)).toEqual({ TOWER_USER_ID: '17' });
  });

  it('overwrites caller-provided TOWER_USER_ID to prevent requester identity spoofing', () => {
    expect(withRuntimeBoxTowerIdentityEnv({ TOWER_USER_ID: '1', KEEP: 'ok' }, 17)).toEqual({
      TOWER_USER_ID: '17',
      KEEP: 'ok',
    });
  });
});

describe('resolveProjectRuntimeProfile', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function tempProject(profileJson?: unknown) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-profile-'));
    tempDirs.push(dir);
    if (profileJson !== undefined) {
      fs.mkdirSync(path.join(dir, '.runtime-box'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.runtime-box', 'profile.json'), JSON.stringify(profileJson), 'utf-8');
    }
    return dir;
  }

  it('reads a project-declared operator-tools profile', async () => {
    await expect(resolveProjectRuntimeProfile(tempProject({ profile: 'operator-tools' }))).resolves.toBe('operator-tools');
  });

  it('falls back to the default profile for missing or unsupported declarations', async () => {
    await expect(resolveProjectRuntimeProfile(tempProject())).resolves.toBe('node22-python313');
    await expect(resolveProjectRuntimeProfile(tempProject({ profile: 'unknown' }))).resolves.toBe('node22-python313');
  });
});

describe('isDockerContainerNameConflict', () => {
  it('matches only the deterministic conflict for the requested Runtime Box name', () => {
    const stderr = 'docker: Error response from daemon: Conflict. The container name "/tower-box-31" is already in use.';
    expect(isDockerContainerNameConflict(stderr, 'tower-box-31')).toBe(true);
    expect(isDockerContainerNameConflict(stderr, 'tower-box-62')).toBe(false);
    expect(isDockerContainerNameConflict('permission denied', 'tower-box-31')).toBe(false);
  });
});

describe('runtimeBoxImageForProfile', () => {
  it('maps operator-tools to the reproducible operator image', () => {
    const previous = process.env.RUNTIME_BOX_OPERATOR_IMAGE;
    delete process.env.RUNTIME_BOX_OPERATOR_IMAGE;
    try {
      expect(runtimeBoxImageForProfile('operator-tools')).toBe('tower-runtime-box:operator-tools');
    } finally {
      if (previous === undefined) delete process.env.RUNTIME_BOX_OPERATOR_IMAGE;
      else process.env.RUNTIME_BOX_OPERATOR_IMAGE = previous;
    }
  });

  it('allows the operator image to be overridden by env', () => {
    const previous = process.env.RUNTIME_BOX_OPERATOR_IMAGE;
    process.env.RUNTIME_BOX_OPERATOR_IMAGE = 'tower-runtime-box:operator-tools-custom';
    try {
      expect(runtimeBoxImageForProfile('operator-tools')).toBe('tower-runtime-box:operator-tools-custom');
    } finally {
      if (previous === undefined) delete process.env.RUNTIME_BOX_OPERATOR_IMAGE;
      else process.env.RUNTIME_BOX_OPERATOR_IMAGE = previous;
    }
  });

  it('keeps the default configured image for normal profiles', () => {
    expect(runtimeBoxImageForProfile('node22-python313')).toBeTruthy();
    expect(runtimeBoxImageForProfile('python313')).toBe(runtimeBoxImageForProfile('node22-python313'));
    expect(runtimeBoxImageForProfile('node22')).toBe(runtimeBoxImageForProfile('node22-python313'));
  });
});

describe('runtimeBoxProjectRootNeedsSync', () => {
  it('detects stale Runtime Box mounts left behind after a project rename', () => {
    expect(runtimeBoxProjectRootNeedsSync(
      '/home/tower/workspace/projects/veritas',
      '/home/tower/workspace/projects/example-ai',
    )).toBe(true);
  });

  it('treats equivalent absolute project roots as already synced', () => {
    expect(runtimeBoxProjectRootNeedsSync(
      '/home/tower/workspace/projects/example-ai',
      '/home/tower/workspace/projects/example-ai',
    )).toBe(false);
  });
});

describe('runtime box root ownership policy', () => {
  it('parses numeric host owner specs and runs root commands with the project gid', () => {
    expect(parseRuntimeBoxUserSpec('1001:1001')).toEqual({ uid: '1001', gid: '1001' });
    expect(parseRuntimeBoxUserSpec('bad')).toBeUndefined();
    expect(runtimeBoxRootUserArgs('1001:1001')).toEqual(['--user', '0:1001']);
    expect(runtimeBoxRootUserArgs(undefined)).toEqual([]);
  });

  it('prepends a cooperative umask only for root commands', () => {
    expect(runtimeBoxShellCommandForExec('apt-get update', true)).toBe('umask 0002\napt-get update');
    expect(runtimeBoxShellCommandForExec('python test.py', false)).toBe('python test.py');
  });

  it('normalizes recently changed workspace files by mtime or ctime without world-writable chmod', () => {
    const script = recentWorkspaceOwnershipNormalizeScript();
    expect(script).toContain('-newer "$1"');
    expect(script).toContain('-cnewer "$1"');
    expect(script).toContain('chown -h "$2"');
    expect(script).toContain('chmod u+rwX,g+rwX');
    expect(script).not.toContain('777');
  });
});

describe('shouldRunRuntimeBoxCommandAsRoot', () => {
  it('runs OS package manager commands as container root', () => {
    expect(shouldRunRuntimeBoxCommandAsRoot('apt-get update && apt-get install -y poppler-utils')).toBe(true);
    expect(shouldRunRuntimeBoxCommandAsRoot('sudo apt install -y tesseract-ocr')).toBe(true);
    expect(shouldRunRuntimeBoxCommandAsRoot('dpkg -i custom.deb')).toBe(true);
    expect(shouldRunRuntimeBoxCommandAsRoot('add-apt-repository ppa:example/tool')).toBe(true);
  });

  it('keeps normal project commands on the project uid/gid', () => {
    expect(shouldRunRuntimeBoxCommandAsRoot('python convert_pdfs.py')).toBe(false);
    expect(shouldRunRuntimeBoxCommandAsRoot('pdftoppm -png input.pdf analysis/page')).toBe(false);
    expect(shouldRunRuntimeBoxCommandAsRoot('npm install')).toBe(false);
    expect(shouldRunRuntimeBoxCommandAsRoot('pip install -r requirements.txt')).toBe(false);
    expect(shouldRunRuntimeBoxCommandAsRoot('python scripts/adapt-get-report.py')).toBe(false);
  });
});

describe('RuntimeContext readiness shape', () => {
  it('allows Tower-like tooling readiness and harness-preferred guidance', () => {
    const ctx: RuntimeContext = {
      runtime: 'project-runtime-box',
      project_id: 'p1',
      project_name: 'p1',
      cwd: '/workspace',
      mount: 'project rw',
      services_running: [],
      box_limits: { memory_mb: 3072, cpu: 1, idle_stop_minutes: 20 },
      readiness: {
        baseline: 'tower-like-tooling',
        summary: 'browser/pdf/docs/media/presentation/dev utilities available',
        doctor_command: 'runtime-box-doctor; runtime-skill-doctor',
        capabilities: ['chromium-headless', 'pdf-tools'],
        harness_preferred: ['pdf_view for ordinary visual PDF reading'],
      },
    };

    expect(ctx.readiness?.baseline).toBe('tower-like-tooling');
    expect(ctx.readiness?.doctor_command).toContain('runtime-box-doctor');
    expect(ctx.readiness?.doctor_command).toContain('runtime-skill-doctor');
    expect(ctx.readiness?.harness_preferred[0]).toContain('pdf_view');
  });

  it('advertises the high-quality HTML render preset when present', () => {
    const ctx: RuntimeContext = {
      runtime: 'project-runtime-box',
      project_id: 'p1',
      project_name: 'p1',
      cwd: '/workspace',
      mount: 'project rw',
      services_running: [],
      box_limits: { memory_mb: 3072, cpu: 1, idle_stop_minutes: 20 },
      readiness: {
        baseline: 'tower-like-tooling',
        summary: 'browser/pdf/docs/media/presentation/dev utilities available',
        doctor_command: 'runtime-box-doctor; runtime-skill-doctor',
        capabilities: ['chromium-headless', 'tower-html-render', 'pdf-tools'],
        harness_preferred: ['pdf_view for ordinary visual PDF reading'],
      },
    };

    expect(ctx.readiness?.capabilities).toContain('tower-html-render');
  });
});

describe('shouldSuppressCredentialEnv', () => {
  it('identifies short file-inspection commands for hints and credential-free execution', () => {
    expect(isSimpleFileInspectionCommand('pwd; ls -la; grep -R foo src')).toBe(true);
    expect(isSimpleFileInspectionCommand('git status --short')).toBe(true);
    expect(isSimpleFileInspectionCommand('npm test')).toBe(false);
    expect(isSimpleFileInspectionCommand('python scripts/report.py')).toBe(false);
  });

  it('suppresses credentials for simple file inspection commands', () => {
    const result = shouldSuppressCredentialEnv('pwd; find . -maxdepth 2 -type f; git status --short');
    expect(result.suppress).toBe(true);
    expect(result.reason).toBe('project file inspection command');
  });

  it('suppresses credentials for env-printing and external package install commands', () => {
    expect(shouldSuppressCredentialEnv('env').suppress).toBe(true);
    expect(shouldSuppressCredentialEnv('printenv | grep API').suppress).toBe(true);
    expect(shouldSuppressCredentialEnv('npm install').suppress).toBe(true);
    expect(shouldSuppressCredentialEnv('uv add pytest').suppress).toBe(true);
    expect(shouldSuppressCredentialEnv('pip install -r requirements.txt').suppress).toBe(true);
  });

  it('keeps credentials available for normal project tests and builds', () => {
    expect(shouldSuppressCredentialEnv('npm test').suppress).toBe(false);
    expect(shouldSuppressCredentialEnv('uv run pytest tests/test_llm.py').suppress).toBe(false);
    expect(shouldSuppressCredentialEnv('python scripts/run_report.py').suppress).toBe(false);
  });
});
