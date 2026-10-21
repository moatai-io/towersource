import { describe, it, expect } from 'vitest';
import { pasteCutPaths } from './fileClipboard';
describe('cut paste', () => {
  it('retains failed paths without retrying successful moves', async () => {
    const result = await pasteCutPaths(['/p/a', '/p/b'], '/p/d', async (from) => { if (from.endsWith('b')) throw new Error('collision'); });
    expect(result.moved).toEqual([{ from: '/p/a', to: '/p/d/a' }]);
    expect(result.failed).toEqual(['/p/b']);
  });
  it('rejects self-descendants and skips same-directory moves', async () => {
    let calls = 0;
    expect((await pasteCutPaths(['/p/a'], '/p/a/sub', async () => { calls++; })).failed).toEqual(['/p/a']);
    expect((await pasteCutPaths(['/p/a'], '/p', async () => { calls++; })).failed).toEqual([]);
    expect(calls).toBe(0);
  });
  it('compacts parent-child selections', async () => {
    const result = await pasteCutPaths(['/p/a', '/p/a/b'], '/p/d', async () => {});
    expect(result.moved).toHaveLength(1);
  });
});
