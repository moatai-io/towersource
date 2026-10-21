import { describe, it, expect } from 'vitest';
import { activeSentence } from './answer-speech-highlight';
describe('speech sentence alignment', () => {
  const text = '첫 문장. 다음 문장.';
  const alignment = { characters: [...text], character_start_times_seconds: [...text].map((_, i) => i), character_end_times_seconds: [...text].map((_, i) => i + 1) };
  it('selects the sentence containing the current timestamp', () => {
    expect(activeSentence(alignment, 2.5)).toBe('첫 문장.');
    expect(activeSentence(alignment, 8.5)).toBe('다음 문장.');
  });
  it('does not invent a position outside the audio timing', () => {
    expect(activeSentence(alignment, 99)).toBeNull();
  });
});
