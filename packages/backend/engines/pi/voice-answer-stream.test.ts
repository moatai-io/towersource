import { describe, expect, it } from 'vitest';
import { confirmedVoiceAnswerSnapshot as snapshot } from './voice-answer-stream.js';
const block = (text: string, phase?: string) => ({ type: 'text', text, ...(phase ? { textSignature: JSON.stringify({ phase }) } : {}) });
const delta = (content: unknown[], type = 'text_delta') => ({ type: 'message_update', assistantMessageEvent: { type, partial: { role: 'assistant', content } } });
describe('actual Pi SDK semantic evidence', () => {
  it('streams only explicit final_answer and excludes commentary/unknown/thinking', () => {
    expect(snapshot(delta([block('계획입니다.', 'commentary'), block('추측입니다.'), { type: 'thinking', thinking: 'private' }, block('정답입니다.', 'final_answer')]))).toBe('정답입니다.');
    expect(snapshot(delta([block('도구를 실행하겠습니다.')]))).toBeUndefined();
    expect(snapshot(delta([block('계획', 'commentary')]))).toBeUndefined();
  });
  it('waits for delayed phase at text_end, without assuming UI text is final', () => {
    expect(snapshot(delta([block('정답입니다.')]))).toBeUndefined();
    expect(snapshot(delta([block('정답입니다.', 'final_answer')], 'text_end'))).toBe('정답입니다.');
  });
  it('blocks tool-bearing and failed messages and strips hidden reasoning', () => {
    expect(snapshot(delta([block('답변', 'final_answer'), { type: 'toolCall', name: 'search' }]))).toBeUndefined();
    expect(snapshot({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', content: [block('실패', 'final_answer')] } })).toBeUndefined();
    expect(snapshot(delta([block('앞<think>비공개</think>뒤', 'final_answer')]))).toBe('앞뒤');
  });
  it('supports message_end confirmation, never arbitrary user/tool events', () => {
    expect(snapshot({ type: 'message_end', message: { role: 'assistant', content: [block('답', 'final_answer')] } })).toBe('답');
    expect(snapshot({ type: 'message_end', message: { role: 'user', content: [block('공격', 'final_answer')] } })).toBeUndefined();
  });
});
