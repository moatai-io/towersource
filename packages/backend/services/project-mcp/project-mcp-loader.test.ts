import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { rankProjectMcpCatalogTools } from './project-mcp-loader.js';

const loaderSource = fs.readFileSync(path.resolve(import.meta.dirname, './project-mcp-loader.ts'), 'utf8');
const assemblySource = fs.readFileSync(path.resolve(import.meta.dirname, '../../engines/pi/tool-assembly.ts'), 'utf8');
const executionGateSource = fs.readFileSync(path.resolve(import.meta.dirname, '../authority/execution-gate-shadow.ts'), 'utf8');

describe('project MCP deferred tool gateway', () => {
  it('ranks exact and descriptive catalog matches without projecting schemas eagerly', () => {
    const tools = [
      { id: 'agent_store__apt_sale_transactions', name: 'apt_sale_transactions', description: '아파트 매매 실거래가 조회' },
      { id: 'agent_store__nts_check_business_status', name: 'nts_check_business_status', description: '사업자 운영 상태 확인' },
      { id: 'agent_store__get_today_briefing', name: 'get_today_briefing', description: '한국은행 경제 브리핑' },
    ];

    expect(rankProjectMcpCatalogTools(tools, '아파트 실거래')[0]?.id).toBe('agent_store__apt_sale_transactions');
    expect(rankProjectMcpCatalogTools(tools, 'nts_check_business_status')[0]?.id).toBe('agent_store__nts_check_business_status');
    expect(rankProjectMcpCatalogTools(tools, '일반 글쓰기')).toEqual([]);
  });

  it('keeps Agent Store available behind two bounded gateway tools', () => {
    expect(loaderSource).toContain("name: 'mcp_search_tools'");
    expect(loaderSource).toContain("name: 'mcp_call_tool'");
    expect(loaderSource).toContain('discoveredToolIds.has(input.toolId)');
    expect(loaderSource).toContain('mcpArgumentsValidator.validate(tool.inputSchema, args)');
    expect(loaderSource).toContain('cataloged ${server.name}: ${Math.min(listed.tools?.length ?? 0, MAX_TOOLS_PER_SERVER)} tools (deferred)');
    expect(executionGateSource).toContain("name === 'mcp_search_tools'");
    expect(executionGateSource).toContain("name === 'mcp_call_tool'");
    expect(executionGateSource).toContain("actionClass: 'write', target: { type: 'project-mcp'");
  });

  it('does not append every project MCP tool schema during Pi tool assembly', () => {
    expect(assemblySource).toContain('createProjectMcpGatewayTools({');
    expect(assemblySource).toContain('Project MCP deferred gateway mounted');
    expect(assemblySource).not.toContain('await loadProjectMcpTools({');
    expect(assemblySource).not.toContain('Project MCP tools mounted:');
  });
});

describe('Agent OAuth transport integration', () => {
  it('installs the SDK auth provider and SSRF-safe fetch on streamable HTTP transport', () => {
    expect(loaderSource).toContain('fetch: projectMcpFetch');
    expect(loaderSource).toContain('await createProjectMcpOAuthProvider(opts.projectId, server.name, server.url, opts.userId)');
    expect(loaderSource).toContain('await assertRuntimeServerAllowed(opts, tool.server.manifest)');
  });
});
