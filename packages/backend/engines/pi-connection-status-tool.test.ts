import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnectionStatusTool } from './pi-connection-status-tool.js';
import { diagnoseProjectConnectionStatus } from '../services/credential-vault/connection-reliability.js';

vi.mock('../services/credential-vault/connection-reliability.js', () => ({ diagnoseProjectConnectionStatus: vi.fn() }));

function text(output: any): string { return output.content?.[0]?.text || ''; }

describe('connection_status tool', () => {
  beforeEach(() => vi.mocked(diagnoseProjectConnectionStatus).mockReset());

  it('closes user and Project identity and returns complete secret-free Agent inventory diagnostics', async () => {
    vi.mocked(diagnoseProjectConnectionStatus).mockResolvedValue({
      inventoryComplete: true,
      coverage: 'team-shared-and-agent-dedicated',
      connections: [{ connectionId: 'neon-api-key', displayName: 'Neon API Key', capability: 'neon', status: 'unverified', stoppedAt: 'provider_health', reasonCode: 'ProviderAuthUnverified', summary: '저장·연결·Runtime 주입 확인', nextAction: 'test', stages: [] }],
    });
    const tool: any = createConnectionStatusTool({ userId: 7, projectId: 'project-a' });
    const output = await tool.execute('call', {});
    expect(diagnoseProjectConnectionStatus).toHaveBeenCalledWith({ userId: 7, projectId: 'project-a' });
    expect(text(output)).toContain('"inventoryComplete": true');
    expect(text(output)).toContain('team-shared-and-agent-dedicated');
    expect(text(output)).toContain('provider_health');
    expect(text(output)).not.toMatch(/secret|token|envName|value/i);
  });

  it('warns the model that lookup absence is not proof of save failure', () => {
    const tool: any = createConnectionStatusTool({ userId: 7, projectId: 'project-a' });
    expect(tool.promptSnippet).toContain('not proof that saving failed');
    expect(tool.promptSnippet).toContain('verify Runtime materialization before suggesting re-entry');
  });

  it('is unavailable without closed-over Project identity', () => {
    expect(createConnectionStatusTool({ userId: 7 })).toBeNull();
  });
});
