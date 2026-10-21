import { describe, expect, it, vi } from 'vitest';
import { VoiceSentenceAssembler, VoiceSentenceBufferLimitError, voiceSentenceStream } from './voice-worker-sentence-stream.js';

describe('worker sentence assembler without a wire protocol', () => {
  it('assembles Korean sentences in order across arbitrary deltas', () => {
    const a = new VoiceSentenceAssembler();
    expect(a.push('첫 문장입')).toEqual([]);
    expect(a.push('니다.')).toEqual(['첫 문장입니다.']);
    expect(a.push(' 두 번째 문장입니다. 다음')).toEqual(['두 번째 문장입니다.']);
    expect(a.finish()).toEqual(['다음']);
  });
  it('does not split decimals or inline code across chunks', () => {
    const a = new VoiceSentenceAssembler();
    expect(a.push('값은 3.')).toEqual([]);
    expect(a.push('14입니다. `a.b')).toEqual(['값은 3.14입니다.']);
    expect(a.push('`를 확인합니다. 다음')).toEqual(['a.b를 확인합니다.']);
    expect(a.finish()).toEqual(['다음']);
  });
  it('holds unclosed fences and bounds pathological unfinished sentences', () => {
    const a = new VoiceSentenceAssembler();
    expect(a.push('```ts\nconst x = 3.14;\n')).toEqual([]);
    expect(() => a.finish()).toThrow('inside code markup');
    const limited = new VoiceSentenceAssembler(8);
    expect(() => limited.push('123456789')).toThrow(VoiceSentenceBufferLimitError);
  });
  it('keeps an IDN URL and query punctuation intact across chunks', () => {
    const a = new VoiceSentenceAssembler();
    expect(a.push('https://예시.')).toEqual([]);
    expect(a.push('한국/path?q=1.')).toEqual([]);
    expect(a.push('2를 보세요. 다음')).toEqual(['https://예시.한국/path?q=1.2를 보세요.']);
    expect(a.finish()).toEqual(['다음']);
  });
  it('does not treat heading/list newline alone as a completed meaningful sentence', () => {
    const a = new VoiceSentenceAssembler();
    expect(a.push('## 준비 방법\n- 첫 단계\n')).toEqual([]);
    expect(a.push('자료를 확인합니다.')).toEqual(['준비 방법\n첫 단계\n자료를 확인합니다.']);
  });
  it('clears the partial tail on cancellation instead of flushing it', () => {
    const a = new VoiceSentenceAssembler(); a.push('취소된 미완성 문장'); a.clear();
    expect(a.finish()).toEqual([]);
  });
});

describe('pull-based sentence flow', () => {
  it('does not pull a second delta until consumer requests the next sentence', async () => {
    const next = vi.fn().mockResolvedValueOnce({ value: '첫 문장. ', done: false })
      .mockResolvedValueOnce({ value: '둘째 문장. ', done: false }).mockResolvedValue({ done: true });
    const stop = vi.fn(async () => ({ done: true as const, value: undefined }));
    const stream = voiceSentenceStream({ deltas: { [Symbol.asyncIterator]: () => ({ next, return: stop }) },
      signal: new AbortController().signal, isCurrent: () => true });
    expect((await stream.next()).value).toBe('첫 문장.');
    expect(next).toHaveBeenCalledTimes(1);
    expect((await stream.next()).value).toBe('둘째 문장.');
    expect(next).toHaveBeenCalledTimes(2);
    expect((await stream.next()).done).toBe(true);
  });
  it('gates already buffered later sentences after a revision change', async () => {
    let current = true;
    const stream = voiceSentenceStream({ deltas: (async function* () { yield '첫 문장. 두 번째. '; })(),
      signal: new AbortController().signal, isCurrent: () => current });
    expect((await stream.next()).value).toBe('첫 문장.');
    current = false;
    await expect(stream.next()).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('aborts a producer that ignores cancellation instead of hanging its consumer', async () => {
    const abort = new AbortController();
    const stream = voiceSentenceStream({ deltas: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) },
      signal: abort.signal, isCurrent: () => true });
    const next = stream.next(); abort.abort();
    await expect(next).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('does not speak unfinished text on transport failure', async () => {
    const stream = voiceSentenceStream({ deltas: (async function* () {
      yield '전송 중인 미완성'; throw new Error('transport failed');
    })(), signal: new AbortController().signal, isCurrent: () => true });
    await expect(stream.next()).rejects.toThrow('transport failed');
  });
});
