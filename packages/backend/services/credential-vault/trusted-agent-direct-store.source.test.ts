import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tool = readFileSync(new URL('../../engines/pi-credential-vault-store-tool.ts', import.meta.url), 'utf8');
const assembly = readFileSync(new URL('../../engines/pi/tool-assembly.ts', import.meta.url), 'utf8');
const gate = readFileSync(new URL('../authority/execution-gate-shadow.ts', import.meta.url), 'utf8');
const prompt = readFileSync(new URL('../system-prompt.ts', import.meta.url), 'utf8');

describe('trusted Agent direct Credential storage contract', () => {
  it('assembles the direct store tool only through the trusted legacy-default surface', () => {
    expect(assembly).toContain("import { createCredentialVaultStoreTool } from '../pi-credential-vault-store-tool.js'");
    expect(assembly).toContain('createCredentialVaultStoreTool({');
    expect(assembly).toContain('channelSafeToolsOnly: opts.channelSafeToolsOnly');
    expect(tool).toContain('if (!ctx.userId || !ctx.projectId || ctx.channelSafeToolsOnly) return undefined');
  });

  it('requires explicit user intent and defaults to current-Agent scope', () => {
    expect(tool).toContain('only when the user explicitly asked to register or rotate');
    expect(tool).toContain("const scope = params.scope ?? 'project'");
    expect(tool).toContain("source: 'trusted_agent_chat'");
    expect(prompt).toContain('store it directly without asking the user to re-enter it');
  });

  it('classifies direct storage as Credential administration and never returns the input value', () => {
    expect(gate).toContain("name === 'credential_vault_store'");
    expect(gate).toContain("actionClass: 'credential-admin'");
    expect(tool).not.toMatch(/text:\s*[^\n]*params\.value/);
    expect(tool).toContain('The secret value is not included in this result.');
  });
});
