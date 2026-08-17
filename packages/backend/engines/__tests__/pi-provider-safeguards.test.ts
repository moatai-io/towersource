import { describe, expect, it } from 'vitest';
import { inspectResponsesFileRepresentations, sanitizeLiteLLMResponsesCommentaryMessages, sanitizeLiteLLMResponsesOrphanFunctionOutputs } from '../pi/provider-safeguards.js';

describe('Responses file representation admission', () => {
  const dataImage = (bytes: number) => `data:image/png;base64,${Buffer.alloc(bytes).toString('base64')}`;

  it('counts accumulated inline images and decoded bytes recursively', () => {
    const result = inspectResponsesFileRepresentations({ input: [
      { type: 'message', content: [{ type: 'input_image', image_url: dataImage(10) }] },
      { type: 'function_call_output', output: [{ type: 'input_image', image_url: dataImage(20) }] },
    ] });
    expect(result).toMatchObject({ imageItems: 2, imageBytes: 30, rejected: false });
  });

  it('rejects an accumulated provider request beyond the image count budget', () => {
    const input = Array.from({ length: 25 }, () => ({ type: 'input_image', image_url: dataImage(1) }));
    expect(inspectResponsesFileRepresentations({ input })).toMatchObject({ imageItems: 25, rejected: true });
  });
});

describe('Pi provider safeguards — LiteLLM Responses tool output repair', () => {
  it('removes function_call_output items whose call_id has no preceding function_call', () => {
    const body: any = {
      input: [
        { role: 'user', content: 'hello' },
        { type: 'function_call_output', call_id: 'call_orphan', output: 'stale result' },
        { type: 'function_call', call_id: 'call_ok', name: 'read', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_ok', output: 'ok' },
      ],
    };

    const result = sanitizeLiteLLMResponsesOrphanFunctionOutputs(body);

    expect(result).toMatchObject({
      mutated: true,
      removedCallIds: ['call_orphan'],
    });
    expect(body.input).toEqual([
      { role: 'user', content: 'hello' },
      { type: 'function_call', call_id: 'call_ok', name: 'read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_ok', output: 'ok' },
    ]);
  });

  it('removes out-of-order outputs even when a matching function_call appears later', () => {
    const body: any = {
      input: [
        { type: 'function_call_output', call_id: 'call_late', output: 'too early' },
        { type: 'function_call', call_id: 'call_late', name: 'bash', arguments: '{}' },
      ],
    };

    const result = sanitizeLiteLLMResponsesOrphanFunctionOutputs(body);

    expect(result.mutated).toBe(true);
    expect(result.removedCallIds).toEqual(['call_late']);
    expect(body.input).toEqual([
      { type: 'function_call', call_id: 'call_late', name: 'bash', arguments: '{}' },
    ]);
  });

  it('keeps valid replayed function call/output pairs unchanged', () => {
    const body: any = {
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'grep', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
      ],
    };

    const result = sanitizeLiteLLMResponsesOrphanFunctionOutputs(body);

    expect(result).toEqual({ mutated: false });
    expect(body.input).toHaveLength(2);
  });

  it('does not mutate previous_response_id chains because prior calls may live provider-side', () => {
    const body: any = {
      previous_response_id: 'resp_123',
      input: [
        { type: 'function_call_output', call_id: 'call_provider_side', output: 'ok' },
      ],
    };

    const result = sanitizeLiteLLMResponsesOrphanFunctionOutputs(body);

    expect(result).toEqual({ mutated: false });
    expect(body.input).toHaveLength(1);
  });
});

describe('Pi provider safeguards — LiteLLM Responses commentary replay preservation', () => {
  it('keeps replayed assistant commentary messages in Responses input', () => {
    const body: any = {
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
        {
          type: 'message',
          role: 'assistant',
          phase: 'commentary',
          id: 'msg_commentary',
          content: [{ type: 'output_text', text: 'Need inspect files.', annotations: [] }],
          status: 'completed',
        },
        {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          id: 'msg_final',
          content: [{ type: 'output_text', text: '최종 답변입니다.', annotations: [] }],
          status: 'completed',
        },
      ],
    };

    const result = sanitizeLiteLLMResponsesCommentaryMessages(body);

    expect(result).toEqual({ mutated: false });
    expect(body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
      {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        id: 'msg_commentary',
        content: [{ type: 'output_text', text: 'Need inspect files.', annotations: [] }],
        status: 'completed',
      },
      {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        id: 'msg_final',
        content: [{ type: 'output_text', text: '최종 답변입니다.', annotations: [] }],
        status: 'completed',
      },
    ]);
  });

  it('keeps assistant messages without commentary phase', () => {
    const body: any = {
      input: [
        { type: 'message', role: 'assistant', id: 'msg_legacy', content: [] },
        { type: 'message', role: 'assistant', phase: 'final_answer', id: 'msg_final', content: [] },
      ],
    };

    const result = sanitizeLiteLLMResponsesCommentaryMessages(body);

    expect(result).toEqual({ mutated: false });
    expect(body.input).toHaveLength(2);
  });
});
