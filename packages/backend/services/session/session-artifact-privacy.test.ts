import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../db/pg-repo.js', () => ({ queryOne: vi.fn() }));
import { queryOne } from '../../db/pg-repo.js';
import { assertSessionAllowsSharedArtifactWrite } from './session-artifact-privacy.js';
describe('shared Agent files regardless of conversation privacy', () => {
  beforeEach(() => vi.resetAllMocks());
  it.each(['private', 'project', null])('allows existing visibility %s', async visibility => {
    vi.mocked(queryOne).mockResolvedValue({ visibility });
    await expect(assertSessionAllowsSharedArtifactWrite('s')).resolves.toBeUndefined();
  });
  it('denies missing conversation', async () => {
    vi.mocked(queryOne).mockResolvedValue(null);
    await expect(assertSessionAllowsSharedArtifactWrite('s')).rejects.toThrow('Session not found');
  });
  it('leaves non-session file authority unchanged', async () => {
    await expect(assertSessionAllowsSharedArtifactWrite()).resolves.toBeUndefined();
  });
});
