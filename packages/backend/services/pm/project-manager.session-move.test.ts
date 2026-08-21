import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryOne = vi.fn();
const execute = vi.fn();

vi.mock('../../db/pg-repo.js', () => ({
  query: vi.fn(),
  queryOne,
  execute,
  transaction: vi.fn(),
  withClient: vi.fn(),
}));

const { moveSessionToProject, SessionRuntimeRebindRequiredError } = await import('./project-manager.js');

describe('moveSessionToProject runtime boundary', () => {
  beforeEach(() => {
    queryOne.mockReset();
    execute.mockReset();
  });

  it.each([
    { claude_session_id: 'claude-native-id', pi_session_file: null, has_runtime_snapshot: false },
    { claude_session_id: null, pi_session_file: '/workspace/a/.pi/sessions/source.jsonl', has_runtime_snapshot: false },
    { claude_session_id: null, pi_session_file: null, has_runtime_snapshot: true },
  ])('rejects a cross-project move when native runtime state is pinned: %o', async (runtime) => {
    queryOne.mockResolvedValueOnce({ project_id: 'project-a', ...runtime });

    await expect(moveSessionToProject('session-1', 'project-b')).rejects.toBeInstanceOf(SessionRuntimeRebindRequiredError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('allows an unstarted session to move and updates cwd to the target project root', async () => {
    queryOne
      .mockResolvedValueOnce({
        project_id: 'project-a',
        claude_session_id: null,
        pi_session_file: null,
        has_runtime_snapshot: false,
      })
      .mockResolvedValueOnce({ id: 'project-b', root_path: '/workspace/projects/project-b' });
    execute.mockResolvedValueOnce({ changes: 1 });

    await expect(moveSessionToProject('session-1', 'project-b')).resolves.toBe(true);
    expect(execute).toHaveBeenCalledWith(
      'UPDATE sessions SET project_id = $1, cwd = COALESCE($2, cwd) WHERE id = $3',
      ['project-b', '/workspace/projects/project-b', 'session-1'],
    );
  });

  it('does not reject a no-op assignment to the session current project', async () => {
    queryOne
      .mockResolvedValueOnce({
        project_id: 'project-a',
        claude_session_id: null,
        pi_session_file: '/workspace/a/.pi/sessions/source.jsonl',
        has_runtime_snapshot: true,
      })
      .mockResolvedValueOnce({ id: 'project-a', root_path: '/workspace/projects/project-a' });
    execute.mockResolvedValueOnce({ changes: 1 });

    await expect(moveSessionToProject('session-1', 'project-a')).resolves.toBe(true);
  });

  it('returns false without writing when the session does not exist', async () => {
    queryOne.mockResolvedValueOnce(undefined);

    await expect(moveSessionToProject('missing-session', 'project-b')).resolves.toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
});
