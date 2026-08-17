import { describe, expect, it } from 'vitest';
import { ContentAccumulator, agentMessageToTowerBlocks, sanitizePiVisibleBlocks } from '../pi/message-adapter.js';
import { handlePiMessageUpdate } from '../pi/message-update-handler.js';

describe('Pi message_update handler', () => {
  it('drops thinking deltas from user-visible content', () => {
    const accumulator = new ContentAccumulator();

    expect(handlePiMessageUpdate({
      event: { assistantMessageEvent: { type: 'text_delta', delta: 'hello' } },
      accumulator,
    }).content).toEqual([{ type: 'text', text: 'hello' }]);

    expect(handlePiMessageUpdate({
      event: { assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' } },
      accumulator,
    }).content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('buffers Responses text_delta until text_end phase is known', () => {
    const accumulator = new ContentAccumulator();
    const commentarySig = JSON.stringify({ v: 1, id: 'msg_commentary', phase: 'commentary' });
    const finalSig = JSON.stringify({ v: 1, id: 'msg_final', phase: 'final_answer' });

    expect(handlePiMessageUpdate({
      event: {
        assistantMessageEvent: {
          type: 'text_delta',
          delta: 'Need query.',
          partial: { api: 'openai-responses', provider: 'litellm-responses', content: [{ type: 'text', text: 'Need query.' }] },
        },
      },
      accumulator,
    }).content).toEqual([]);

    expect(handlePiMessageUpdate({
      event: {
        assistantMessageEvent: {
          type: 'text_end',
          partial: { api: 'openai-responses', provider: 'litellm-responses', content: [{ type: 'text', text: 'Need query.', textSignature: commentarySig }] },
        },
      },
      accumulator,
    }).content).toEqual([]);

    expect(handlePiMessageUpdate({
      event: {
        assistantMessageEvent: {
          type: 'text_end',
          partial: { api: 'openai-responses', provider: 'litellm-responses', content: [{ type: 'text', text: '최종 답변입니다.', textSignature: finalSig }] },
        },
      },
      accumulator,
    }).content).toEqual([{ type: 'text', text: '최종 답변입니다.' }]);
  });

  it('does not optimistically stream LiteLLM Responses text_delta before phase is known', () => {
    const accumulator = new ContentAccumulator();

    expect(handlePiMessageUpdate({
      event: {
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: '안녕하세요. ',
          partial: { api: 'openai-responses', provider: 'litellm-responses', content: [{ type: 'text', text: '안녕하세요. ' }] },
        },
      },
      accumulator,
    }).content).toEqual([]);
  });

  it('streams direct Azure/OpenAI Responses text_delta without phase metadata', () => {
    const accumulator = new ContentAccumulator();

    expect(handlePiMessageUpdate({
      event: {
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: '안녕하세요. ',
          partial: { api: 'openai-responses', provider: 'azure-openai-responses-eastus2', content: [{ type: 'text', text: '안녕하세요. ' }] },
        },
      },
      accumulator,
    }).content).toEqual([{ type: 'text', text: '안녕하세요. ' }]);
  });

  it('does not stream signed commentary even if provider metadata is missing', () => {
    const accumulator = new ContentAccumulator();
    const commentarySig = JSON.stringify({ v: 1, phase: 'commentary' });

    expect(handlePiMessageUpdate({
      event: {
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'Need inspect current file.',
          partial: { content: [{ type: 'text', text: 'Need inspect current file.', textSignature: commentarySig }] },
        },
      },
      accumulator,
    }).content).toEqual([]);
  });

  it('drops unconfirmed Responses preamble when a tool call arrives before text_end', () => {
    const accumulator = new ContentAccumulator();

    expect(handlePiMessageUpdate({
      event: {
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'Need final status and maybe local origin sync? yes. Also note not deployed to demo? Script not in demo until next deploy...',
          partial: {
            api: 'openai-responses',
            provider: 'litellm-responses',
            content: [{ type: 'text', text: 'Need final status and maybe local origin sync? yes. Also note not deployed to demo? Script not in demo until next deploy...' }],
          },
        },
      },
      accumulator,
    }).content).toEqual([]);

    expect(handlePiMessageUpdate({
      event: {
        assistantMessageEvent: {
          type: 'toolcall_end',
          toolCall: { id: 't1', name: 'bash', arguments: { command: 'git status --short' } },
        },
      },
      accumulator,
    }).content).toEqual([
      { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'git status --short' } },
    ]);
  });

  it('keeps confirmed final_answer text before a later tool call', () => {
    const accumulator = new ContentAccumulator();
    const finalSig = JSON.stringify({ v: 1, phase: 'final_answer' });

    expect(handlePiMessageUpdate({
      event: {
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: '검증을 위해 상태를 확인하겠습니다.',
          partial: { api: 'openai-responses', provider: 'litellm-responses', content: [{ type: 'text', text: '검증을 위해 상태를 확인하겠습니다.' }] },
        },
      },
      accumulator,
    }).content).toEqual([]);

    expect(handlePiMessageUpdate({
      event: {
        assistantMessageEvent: {
          type: 'text_end',
          partial: { api: 'openai-responses', provider: 'litellm-responses', content: [{ type: 'text', text: '검증을 위해 상태를 확인하겠습니다.', textSignature: finalSig }] },
        },
      },
      accumulator,
    }).content).toEqual([{ type: 'text', text: '검증을 위해 상태를 확인하겠습니다.' }]);

    expect(handlePiMessageUpdate({
      event: {
        assistantMessageEvent: {
          type: 'toolcall_end',
          toolCall: { id: 't1', name: 'bash', arguments: { command: 'npm test' } },
        },
      },
      accumulator,
    }).content).toEqual([
      { type: 'text', text: '검증을 위해 상태를 확인하겠습니다.' },
      { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'npm test' } },
    ]);
  });

  it('streams Responses text_delta when provider exposes final_answer phase early', () => {
    const accumulator = new ContentAccumulator();
    const finalSig = JSON.stringify({ v: 1, id: 'msg_final', phase: 'final_answer' });

    expect(handlePiMessageUpdate({
      event: {
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: '안녕',
          partial: { api: 'openai-responses', provider: 'litellm-responses', content: [{ type: 'text', text: '안녕', textSignature: finalSig }] },
        },
      },
      accumulator,
    }).content).toEqual([{ type: 'text', text: '안녕' }]);
  });

  it('keeps user-facing Responses commentary as progress while hiding scratchpad-shaped commentary', () => {
    const commentarySig = JSON.stringify({ v: 1, phase: 'commentary' });
    const finalSig = JSON.stringify({ v: 1, phase: 'final_answer' });

    expect(agentMessageToTowerBlocks({ content: [
      { type: 'thinking', thinking: '', thinkingSignature: '{encrypted}' },
      { type: 'text', text: 'Need query.', textSignature: commentarySig },
      { type: 'text', text: 'Worker 서비스를 확인하겠습니다.', textSignature: commentarySig },
      { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.txt' } },
      { type: 'text', text: '최종 답변입니다.', textSignature: finalSig },
    ] })).toEqual([
      { type: 'commentary', text: 'Worker 서비스를 확인하겠습니다.', phase: 'commentary', visibility: 'progress' },
      { type: 'tool_use', id: 't1', name: 'read', input: { path: 'a.txt', file_path: 'a.txt' } },
      { type: 'text', text: '최종 답변입니다.' },
    ]);
  });

  it('does not reintroduce scratchpad-shaped internal commentary at message_end', () => {
    const commentarySig = JSON.stringify({ v: 1, phase: 'commentary' });
    const text = 'Need implement design. Only MessageBubble. Need maybe tests adjust "Done" still. Let\'s edit collapsed and expanded maybe. Need helper status etc. Use exact replace collapsed block maybe large.';

    expect(agentMessageToTowerBlocks({ content: [
      {
        type: 'text',
        text,
        textSignature: commentarySig,
      },
      { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'git status --short' } },
    ] })).toEqual([
      { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'git status --short' } },
    ]);
  });

  it('preserves literal think tags in structured Responses final text', () => {
    const finalSig = JSON.stringify({ v: 1, phase: 'final_answer' });

    expect(agentMessageToTowerBlocks({ content: [
      { type: 'text', text: 'literal `<think>...</think>` 설명입니다. <think>이 문자열도 예시입니다</think> 결론입니다.', textSignature: finalSig },
    ] })).toEqual([
      { type: 'text', text: 'literal `<think>...</think>` 설명입니다. <think>이 문자열도 예시입니다</think> 결론입니다.' },
    ]);
  });

  it('strips legacy raw inline thinking only when Responses phase metadata is absent', () => {
    expect(agentMessageToTowerBlocks({ content: [
      { type: 'text', text: '앞 문장 <think>secret reasoning</think> 뒤 문장' },
    ] })).toEqual([
      { type: 'text', text: '앞 문장  뒤 문장' },
    ]);
  });

  it('dedupes repeated final text blocks split by thinking', () => {
    expect(sanitizePiVisibleBlocks([
      { type: 'text', text: '방금 케이스는 실제 버그가 맞습니다.\n로그상 순서가 이렇습니다.' },
      { type: 'thinking', text: '' },
      { type: 'text', text: '방금 케이스는 실제 버그가 맞습니다.\n로그상 순서가 이렇습니다. 추가 설명입니다.' },
    ])).toEqual([
      { type: 'text', text: '방금 케이스는 실제 버그가 맞습니다.\n로그상 순서가 이렇습니다. 추가 설명입니다.' },
    ]);
  });

  it('adds tool_use blocks and marks toolcall_end as immediate', () => {
    const accumulator = new ContentAccumulator();
    const result = handlePiMessageUpdate({
      event: {
        assistantMessageEvent: {
          type: 'toolcall_end',
          toolCall: { id: 't1', name: 'read', arguments: { path: 'a.txt' } },
        },
      },
      accumulator,
    });

    expect(result.immediate).toBe(true);
    expect(result.content).toEqual([{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'a.txt', file_path: 'a.txt' } }]);
  });

  it('detects edited files from write/edit/notebook tool calls', () => {
    for (const [name, args, filePath] of [
      ['write', { path: 'a.txt' }, 'a.txt'],
      ['Edit', { file_path: 'b.txt' }, 'b.txt'],
      ['notebook_edit', { notebook_path: 'c.ipynb' }, 'c.ipynb'],
    ] as const) {
      const accumulator = new ContentAccumulator();
      const result = handlePiMessageUpdate({
        event: { assistantMessageEvent: { type: 'toolcall_end', toolCall: { id: 't1', name, arguments: args } } },
        accumulator,
      });
      expect(result.editedFile).toEqual({ filePath, toolName: name });
    }
  });

  it('returns stop reason and immediate flush for done/error events', () => {
    const accumulator = new ContentAccumulator();
    const result = handlePiMessageUpdate({
      event: { assistantMessageEvent: { type: 'error', reason: 'error' } },
      accumulator,
    });

    expect(result.stopReason).toBe('error');
    expect(result.immediate).toBe(true);
  });
});
