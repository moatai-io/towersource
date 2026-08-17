import { describe, expect, it } from 'vitest';
import { __sessionMemoryCardTest } from './session-memory-card.js';

describe('session-memory-card helpers', () => {
  it('parses plain or fenced JSON objects', () => {
    expect(__sessionMemoryCardTest.parseJsonObject('{"outcome":"ok"}')).toEqual({ outcome: 'ok' });
    expect(__sessionMemoryCardTest.parseJsonObject('```json\n{"outcome":"ok"}\n```')).toEqual({ outcome: 'ok' });
  });

  it('normalizes arrays to non-empty strings with cap', () => {
    expect(__sessionMemoryCardTest.asStringArray([' a ', '', 3, 'b', 'c', 'd', 'e', 'f'])).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('filters routine operational memories', () => {
    expect(__sessionMemoryCardTest.dropRoutineOperational([
      '푸시는 요청이 없어 하지 않음',
      '범위 밖 dirty 파일은 건드리지 않음',
      '사용자는 PDF 분석 경로가 왜 실패하는지 혼란스러워했고 Runtime Box 중심으로 풀기로 함',
    ])).toEqual(['사용자는 PDF 분석 경로가 왜 실패하는지 혼란스러워했고 Runtime Box 중심으로 풀기로 함']);
  });

  it('deduplicates file basenames and removes directory noise', () => {
    expect(__sessionMemoryCardTest.uniqueBasenames([
      '/home/tower/tower/packages/backend/src',
      '/home/tower/tower/packages/backend/services/ai/memory-context.ts',
      'packages/backend/services/ai/memory-context.ts',
      '/home/tower/tower/packages/backend/services/ai/session-memory-card.ts',
    ])).toEqual(['memory-context.ts', 'session-memory-card.ts']);
  });
});
