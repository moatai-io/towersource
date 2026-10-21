import { describe, it, expect } from 'vitest';
import { speechChunks, stableSpeechPrefix } from './answer-speech-stream';
describe('stream narration boundaries', () => {
 it('commits the first complete sentence while keeping unfinished text', () => { expect(stableSpeechPrefix('네. 먼저 현재 상태를 확인하고 필요한 수정 사항을 차근차근 설명하겠습니다. 아직 작성', false)).toBe('네. 먼저 현재 상태를 확인하고 필요한 수정 사항을 차근차근 설명하겠습니다.'); });
 it('holds decimal points and incomplete code fences', () => { expect(stableSpeechPrefix('3.14', false)).toBe(''); expect(stableSpeechPrefix('```\n예시입니다.', false)).toBe(''); });
 it('flushes the final incomplete sentence', () => { expect(stableSpeechPrefix('마지막 말', true)).toBe('마지막 말'); });
 it('starts with a short first sentence', () => { expect(speechChunks('네. 다음 문장입니다.', true)[0]).toBe('네.'); });
 it('bounds following chunks', () => { expect(speechChunks('가'.repeat(2000), true).every(c => c.length <= 400)).toBe(true); });
});

it('allows a short first sentence immediately', () => { expect(stableSpeechPrefix('네.', false)).toBe('네.'); });
