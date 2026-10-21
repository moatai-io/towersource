/**
 * Owns: Run-scoped Project Credential materialization for trusted native host bash.
 * Public API: createHostCredentialBashOperations.
 *
 * The Project/user/command resolver is shared with Remote Workers. This adapter only
 * materializes Worker envelopes on the host, redacts resolved values from output,
 * and removes temporary files after the child process exits.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BashOperations } from '@earendil-works/pi-coding-agent';
import { listProjectRuntimeCredentialEnvNames } from '../credential-vault/credential-vault-service.js';
import { resolveRemoteWorkbenchCredentialEnv } from './workbench-remote-credential-resolution.js';
import { materializeAgentGwsBundle } from './agent-gws-credential-selection.js';

interface FileCredentialEnvelope {
  envName: string;
  fileName: string;
  mode: string;
  credentialType: string;
  value: string;
}

function safeFileName(value: string): string {
  if (!value || value === '.' || value === '..' || path.basename(value) !== value || /[\\/\0]/.test(value)) {
    throw new Error('host file Credential filename is invalid');
  }
  return value;
}

function redactBuffer(data: Buffer, secrets: string[]): Buffer {
  let text = data.toString('utf8');
  for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]');
  return Buffer.from(text, 'utf8');
}

async function materializeHostCredentialEnvelopes(env: NodeJS.ProcessEnv): Promise<{
  env: NodeJS.ProcessEnv;
  secrets: string[];
  cleanup(): Promise<void>;
}> {
  const output = { ...env };
  const roots: string[] = [];
  const secrets: string[] = [];
  const createRoot = async (prefix: string) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `tower-host-${prefix}-`));
    roots.push(root);
    return root;
  };
  try {
    const fileEntries = Object.entries(output).filter(([key]) => /^TOWER_REMOTE_FILE_CREDENTIAL_\d+$/.test(key));
    if (fileEntries.length > 0) {
      const root = await createRoot('file');
      for (const [key, encoded] of fileEntries.sort(([a], [b]) => a.localeCompare(b))) {
        delete output[key];
        const payload = JSON.parse(Buffer.from(String(encoded), 'base64').toString('utf8')) as FileCredentialEnvelope;
        if (!payload || !/^[A-Z][A-Z0-9_]{0,63}$/.test(payload.envName) || !/^0?[0-7]{3}$/.test(payload.mode) || typeof payload.value !== 'string') {
          throw new Error('host file Credential payload is invalid');
        }
        // Different Credentials may legitimately share a basename (for example id_ssh).
        const fileName = safeFileName(payload.fileName);
        const credentialRoot = await fs.mkdtemp(path.join(root, 'credential-'));
        const target = path.join(credentialRoot, fileName);
        const fileValue = payload.credentialType === 'ssh_private_key' && !payload.value.endsWith('\n')
          ? `${payload.value}\n`
          : payload.value;
        await fs.writeFile(target, fileValue, { mode: Number.parseInt(payload.mode, 8), flag: 'wx' });
        output[payload.envName] = target;
        secrets.push(payload.value, fileValue);
      }
    }

    const higgsfield = output.TOWER_REMOTE_HIGGSFIELD_CREDENTIALS_JSON;
    delete output.TOWER_REMOTE_HIGGSFIELD_CREDENTIALS_JSON;
    if (higgsfield) {
      const root = await createRoot('higgsfield');
      const configDir = path.join(root, '.config', 'higgsfield');
      const credentialFile = path.join(configDir, 'credentials.json');
      await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(credentialFile, higgsfield, { mode: 0o600 });
      output.HOME = root;
      output.XDG_CONFIG_HOME = path.join(root, '.config');
      output.HIGGSFIELD_CLI_CREDENTIALS_FILE = credentialFile;
      secrets.push(higgsfield);
    }

    const gws = output.TOWER_REMOTE_GWS_CONFIG_B64;
    delete output.TOWER_REMOTE_GWS_CONFIG_B64;
    delete output.TOWER_REMOTE_GWS_USER_ID;
    if (gws) {
      const root = await createRoot('gws');
      const configRoot = path.join(root, '.config');
      await fs.mkdir(configRoot, { recursive: true, mode: 0o700 });
      const agentCredential = await materializeAgentGwsBundle(gws, configRoot);
      const gwsDir = path.dirname(agentCredential);
      output.HOME = root;
      output.XDG_CONFIG_HOME = configRoot;
      output.GWS_CONFIG_HOME = gwsDir;
      output.GOOGLE_WORKSPACE_CLI_CONFIG_DIR = gwsDir;
      output.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE = agentCredential;
      secrets.push(gws);
      const credentialFiles = [agentCredential];
      for (const credentialFile of credentialFiles) {
        const value = await fs.readFile(credentialFile, 'utf8').catch(() => '');
        if (value) secrets.push(value);
      }
    }

    return {
      env: output,
      secrets,
      cleanup: async () => { await Promise.allSettled(roots.map(root => fs.rm(root, { recursive: true, force: true }))); },
    };
  } catch (error) {
    await Promise.allSettled(roots.map(root => fs.rm(root, { recursive: true, force: true })));
    throw error;
  }
}

function credentialSummary(resolved: Awaited<ReturnType<typeof resolveRemoteWorkbenchCredentialEnv>>): string {
  const injected = resolved.injected.map(item => `${item.envName}<-${item.credentialId}`);
  if (resolved.request.env?.TOWER_REMOTE_GWS_CONFIG_B64) injected.push('GWS_CONFIG_HOME<-selected-gws');
  if (resolved.request.env?.TOWER_REMOTE_HIGGSFIELD_CREDENTIALS_JSON) injected.push('HIGGSFIELD_CLI_CREDENTIALS_FILE<-higgsfield-cli-oauth');
  const materialized = resolved.materializedFiles.map(item => `${item.envName}<-${item.credentialId}`);
  const parts = [
    injected.length > 0 ? `injected ${injected.join(', ')}` : '',
    materialized.length > 0 ? `materialized files ${materialized.join(', ')}` : '',
    resolved.suppressed ? `suppressed${resolved.suppressReason ? ` (${resolved.suppressReason})` : ''}` : '',
  ].filter(Boolean);
  return `--- Runtime Context ---\nCredential env: ${parts.join('; ') || 'none'}\n--- Output ---\n`;
}

export function createHostCredentialBashOperations(input: {
  projectId: string;
  userId: number;
  projectRoot?: string;
  base: BashOperations;
}): BashOperations {
  return {
    exec: async (command, cwd, options) => {
      const assertNotAborted = () => { if (options.signal?.aborted) throw new Error('aborted'); };
      assertNotAborted();
      const inheritedEnv = Object.fromEntries(Object.entries(options.env ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      for (const envName of await listProjectRuntimeCredentialEnvNames(input.projectId)) delete inheritedEnv[envName];
      assertNotAborted();
      const resolved = await resolveRemoteWorkbenchCredentialEnv({
        projectId: input.projectId,
        userId: input.userId,
        projectRoot: input.projectRoot ?? cwd,
        request: { command, cwd, env: inheritedEnv },
      });
      assertNotAborted();
      const materialized = await materializeHostCredentialEnvelopes(resolved.request.env ?? {});
      const secretValues = [
        ...materialized.secrets,
        ...Object.entries(resolved.request.env ?? {})
          .filter(([key]) => !Object.prototype.hasOwnProperty.call(options.env ?? {}, key) && !key.startsWith('TOWER_REMOTE_'))
          .map(([, value]) => value),
      ];
      try {
        assertNotAborted();
        options.onData(Buffer.from(credentialSummary(resolved), 'utf8'));
        return await input.base.exec(command, cwd, {
          ...options,
          env: materialized.env,
          onData: data => options.onData(redactBuffer(data, secretValues)),
        });
      } finally {
        await materialized.cleanup();
      }
    },
  };
}
