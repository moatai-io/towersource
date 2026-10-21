import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const assembly = readFileSync(new URL('./tool-assembly.ts', import.meta.url), 'utf8');
const opts = readFileSync(new URL('../types.ts', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../../db/migrations/234_session_mcp_selection.sql', import.meta.url), 'utf8');

describe('Pi session MCP selection integration contract', () => {
  it('passes a fresh session policy checker into the deferred MCP gateway', () => {
    const gateway = assembly.slice(assembly.indexOf('const projectMcpTools = createProjectMcpGatewayTools({'), assembly.indexOf('const builtinToolNames'));
    expect(gateway).toContain('isServerAllowed: createSessionMcpServerChecker({');
    expect(gateway).toContain('sessionId,');
    expect(gateway).toContain('projectId: opts.projectId,');
    expect(gateway).toContain('mcpExcludedServerNames: opts.mcpExcludedServerNames,');
    expect(opts).toContain('mcpExcludedServerNames?: string[];');
  });
  it('gives existing/new sessions an empty exclusion list without enabling new services', () => {
    expect(migration).toContain("mcp_excluded_server_names JSONB NOT NULL DEFAULT '[]'::jsonb");
    expect(migration).toContain("jsonb_typeof(mcp_excluded_server_names) = 'array'");
    expect(migration).not.toMatch(/DELETE FROM|DROP TABLE|UPDATE projects/i);
  });
});
