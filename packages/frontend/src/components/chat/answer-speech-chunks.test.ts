import { describe, it, expect } from 'vitest';
import { splitSpeechText } from './answer-speech-chunks';
describe('bounded speech chunks', () => {
 it('preserves long Korean answers exactly without exceeding the limit', () => {
  const text = '첫 문단입니다. 다음 문장을 읽습니다.\n'.repeat(400);
  const chunks = splitSpeechText(text);
  expect(chunks.join('')).toBe(text);
  expect(chunks.every(c => c.length <= 600)).toBe(true);
  expect(chunks.length).toBeGreaterThan(1);
 });
 it('handles no punctuation and avoids splitting surrogate pairs', () => {
  const text = '가'.repeat(599) + '😀' + '나'.repeat(700);
  const chunks = splitSpeechText(text);
  expect(chunks.join('')).toBe(text);
  expect(chunks.every(c => !/[\uD800-\uDBFF]$/.test(c))).toBe(true);
 });
 it('does not create empty requests', () => { expect(splitSpeechText('')).toEqual([]); });
});
