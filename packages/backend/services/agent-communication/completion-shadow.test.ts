import { describe, expect, it, vi } from 'vitest';
import { recordCompletionReportShadow } from './completion-shadow.js';

const input = {
  spawnId: 'spawn-1',
  senderSessionId: 'child-session',
  recipientSessionId: 'parent-session',
  senderUserId: 7,
  projectId: 'project-1',
  senderName: 'QA worker',
  text: '검증 완료',
  deliveryMode: 'inject-and-wake' as const,
  workerId: 'worker-1',
  agentRunId: 'run-1',
  detailArtifactPaths: ['/workspace/final/report.md'],
};

describe('Completion report inbox shadow', () => {
  it('records child completion as a durable report with stable callback identity', async () => {
    const accept = vi.fn().mockResolvedValue({ messageId: 'report-1' });

    await recordCompletionReportShadow(input, accept);

    expect(accept).toHaveBeenCalledWith(expect.objectContaining({
      senderSessionId: 'child-session', recipientSessionId: 'parent-session', kind: 'report',
      deliveryPolicy: 'wake', correlationId: 'spawn-1', causationId: 'spawn-1',
      rootConversationId: 'spawn-1', operationId: 'spawn-1', workerId: 'worker-1', agentRunId: 'run-1',
      body: {
        text: '검증 완료', senderName: 'QA worker', sourceType: 'spawn_completion',
        detailArtifactPaths: ['/workspace/final/report.md'],
      },
    }));
  });

  it('maps inject-only completion to inject delivery policy', async () => {
    const accept = vi.fn().mockResolvedValue({ messageId: 'report-2' });
    await recordCompletionReportShadow({ ...input, deliveryMode: 'inject-only' }, accept);
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({ deliveryPolicy: 'inject' }));
  });

  it('does not break legacy callback delivery when the shadow store is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const accept = vi.fn().mockRejectedValue(new Error('shadow unavailable'));

    await expect(recordCompletionReportShadow(input, accept)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('completion shadow write failed'), expect.any(Error));
    warn.mockRestore();
  });
});
