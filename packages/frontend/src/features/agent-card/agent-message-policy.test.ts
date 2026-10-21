import { describe, expect, it } from 'vitest';
import { mergeConsecutiveAssistant } from './agent-message-policy';
import type { ChatMessage } from '../../stores/chat-store';

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: partial.id || 'message-id',
    role: partial.role || 'assistant',
    content: partial.content || [],
    timestamp: partial.timestamp || Date.now(),
    ...partial,
  } as ChatMessage;
}

describe('agent message policy', () => {
  it('keeps a model recovery notice separate from the reply to the same user turn', () => {
    const notice = msg({
      id: 'model-recovery',
      metadata: { modelRecovery: { from: 'litellm-responses/smart', to: 'preset/core' } },
      content: [{ type: 'text', text: 'Core로 전환했습니다.' }],
    });
    const answer = msg({
      id: 'answer',
      completedAt: 1000,
      content: [{ type: 'text', text: '안녕하세요! 무엇을 도와드릴까요?' }],
    });

    const merged = mergeConsecutiveAssistant([notice, answer]);

    expect(merged).toHaveLength(2);
    expect(merged[0].id).toBe('model-recovery');
    expect(merged[1].id).toBe('answer');
    expect(merged[1].content).toEqual(answer.content);
  });

  it('does not swallow a recovery notice into the preceding assistant reply', () => {
    const preceding = msg({ id: 'earlier-answer', content: [{ type: 'text', text: '이전 답변' }] });
    const notice = msg({
      id: 'model-recovery',
      metadata: { modelRecovery: { from: 'litellm-responses/smart', to: 'preset/core' } },
      content: [{ type: 'text', text: 'Core로 전환했습니다.' }],
    });
    expect(mergeConsecutiveAssistant([preceding, notice]).map((item) => item.id)).toEqual(['earlier-answer', 'model-recovery']);
  });

  it('replaces a non-terminal text-only assistant row when a terminal continuation arrives', () => {
    const merged = mergeConsecutiveAssistant([
      msg({
        id: 'partial',
        content: [{ type: 'text', text: '맞습니다. 같이 해결해야 합니다.' }],
      }),
      msg({
        id: 'terminal',
        content: [{ type: 'text', text: '저장과 배치 처리 정책을 함께 바꾸겠습니다.' }],
        completedAt: 1000,
      }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].content).toEqual([{ type: 'text', text: '저장과 배치 처리 정책을 함께 바꾸겠습니다.' }]);
    expect(merged[0].completedAt).toBe(1000);
  });

  it('keeps non-terminal tool rows when terminal final text arrives', () => {
    const merged = mergeConsecutiveAssistant([
      msg({
        id: 'tool-boundary',
        content: [{ type: 'tool_use', toolUse: { id: 'call-1', name: 'read', input: {} } }],
      }),
      msg({
        id: 'terminal',
        content: [{ type: 'text', text: '확인 결과 문제가 없습니다.' }],
        completedAt: 1000,
      }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].content.map((block) => block.type)).toEqual(['tool_use', 'text']);
  });
});
