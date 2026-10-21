import { describe, it, expect, vi } from 'vitest';
import { rememberOpening, readOpeningContext } from './opening-context.js';
describe('server-owned opening context', () => {
  it('hands off welcome and evidence only to the same user/project with fresh authority', async () => {
    let allowed = true;
    const identity = { userId: 42, projectId: 'p', sessionId: 'handoff-test' };
    rememberOpening({ ...identity, text: '보고서 작성은 완료 기록. 가격 설명은 과거 미결정.', validate: async () => allowed });
    expect(await readOpeningContext({ ...identity, userId: 43 })).toBe('');
    expect(await readOpeningContext({ ...identity, projectId: 'other' })).toBe('');
    expect(await readOpeningContext(identity)).toContain('보고서 작성은 완료 기록');
    allowed = false;
    expect(await readOpeningContext(identity)).toBe('');
    allowed = true;
    expect(await readOpeningContext(identity)).toBe('');
  });
  it('fails closed when authority lookup fails', async () => {
    const identity = { userId: 42, projectId: 'p', sessionId: 'error-test' };
    rememberOpening({ ...identity, text: 'private', validate: async () => { throw Error('unavailable'); } });
    expect(await readOpeningContext(identity)).toBe('');
  });
});

it('does not hold the conversation indefinitely for a slow authority lookup', async () => {
  vi.useFakeTimers();
  try {
    const user = { userId: 42, projectId: 'p', sessionId: 'slow' };
    rememberOpening({ ...user, text: 'private', validate: () => new Promise(() => {}) });
    const pending = readOpeningContext(user);
    await vi.advanceTimersByTimeAsync(501);
    expect(await pending).toBe('');
  } finally { vi.useRealTimers(); }
});
