// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { getVisibleChatMessages, mergeConsecutiveAssistant } from '../../features/agent-card/agent-message-policy';
import type { ChatMessage } from '../../stores/chat-store';

describe('mergeConsecutiveAssistant', () => {
  it('does not merge compact agent_report records into the launch-card assistant message', () => {
    const launch: ChatMessage = {
      id: 'launch-1',
      role: 'assistant',
      timestamp: 1,
      content: [
        {
          type: 'tool_use',
          toolUse: {
            id: 'tool-agent-1',
            name: 'mcp__agent-worker__persistent_agent_create',
            input: { name: 'QA worker', role: 'Review' },
            result: '- backingSessionId: 5f8bc275-283f-4218-8ccc-f6593d69e0cc',
          },
        },
      ],
    };
    const report: ChatMessage = {
      id: 'report-1',
      role: 'assistant',
      timestamp: 2,
      metadata: {
        sourceType: 'agent_report',
        agentReport: { fromName: 'QA worker', mode: 'inject' },
      },
      content: [
        {
          type: 'agent_run',
          workerName: 'QA worker',
          mode: 'inject',
          status: 'completed',
          summary: '검수 완료',
        } as any,
      ],
    };

    const merged = mergeConsecutiveAssistant([launch, report]);

    expect(merged).toHaveLength(2);
    expect(merged[0].id).toBe('launch-1');
    expect(merged[0].content.some((b) => b.type === 'tool_use')).toBe(true);
    expect(merged[0].content.some((b) => b.type === 'agent_run')).toBe(false);
    expect(merged[1].id).toBe('report-1');
  });

  it('filters compact agent_report records from the chat transcript before rendering', () => {
    const visible = getVisibleChatMessages([
      {
        id: 'launch-1',
        role: 'assistant',
        timestamp: 1,
        content: [{ type: 'text', text: 'visible launch card placeholder' }],
      },
      {
        id: 'report-1',
        role: 'assistant',
        timestamp: 2,
        metadata: { sourceType: 'agent_report', agentReport: { fromName: 'QA worker' } },
        content: [{ type: 'agent_run', summary: '검수 완료' } as any],
      },
    ]);

    expect(visible.map((m) => m.id)).toEqual(['launch-1']);
  });
});
