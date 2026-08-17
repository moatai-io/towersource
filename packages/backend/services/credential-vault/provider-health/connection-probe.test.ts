import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execInBox, getOrCreateBox } from '../../runtime-box/runtime-box-manager.js';
import { probeConnection } from './connection-probe.js';

vi.mock('../../runtime-box/runtime-box-manager.js', () => ({
  getOrCreateBox: vi.fn(),
  execInBox: vi.fn(),
}));

describe('Connection health probe', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getOrCreateBox).mockResolvedValue({ id: 17 } as any);
  });

  it('runs GWS auth and a minimal read-only API with one explicitly selected credential', async () => {
    vi.mocked(execInBox).mockResolvedValue({ exit_code: 0, stdout: 'TOWER_GWS_AUTH=0\nTOWER_GWS_READ=0\n', stderr: '' } as any);
    const result = await probeConnection({
      connection: { id: 'gws-work', source: 'credential', provider: 'google', connectionType: 'gws' },
      projectId: 'project-a',
      userId: 7,
    });
    expect(execInBox).toHaveBeenCalledWith(expect.objectContaining({
      boxId: 17,
      userId: 7,
      timeout_sec: 30,
      cmd: expect.stringContaining("GWS_CONNECTION_ID='gws-work' gws auth status >/dev/null 2>&1"),
    }));
    expect(vi.mocked(execInBox).mock.calls[0][0].cmd).toContain("gws gmail users getProfile");
    expect(result).toMatchObject({
      depth: 'provider_read_only',
      materialization: { status: 'verified' },
      providerHealth: { status: 'ready', reasonCode: 'Ready' },
    });
  });

  it('classifies an invalid GWS login without exposing command output', async () => {
    vi.mocked(execInBox).mockResolvedValue({ exit_code: 0, stdout: 'TOWER_GWS_AUTH=1\nTOWER_GWS_READ=1\n', stderr: 'secret-looking-provider-output' } as any);
    const result = await probeConnection({
      connection: { id: 'gws-work', source: 'credential', provider: 'google', connectionType: 'gws' },
      projectId: 'project-a',
      userId: 7,
    });
    expect(result.providerHealth).toEqual({ status: 'reauth_required', reasonCode: 'ReauthRequired' });
    expect(JSON.stringify(result)).not.toContain('secret-looking-provider-output');
  });

  it('returns an honest unsupported result for providers without a safe adapter', async () => {
    const result = await probeConnection({
      connection: { id: 'neon-api-key', source: 'credential', provider: 'neon', connectionType: 'api_key' },
      projectId: 'project-a',
      userId: 7,
    });
    expect(result).toMatchObject({ depth: 'unsupported', providerHealth: { status: 'unsupported' } });
    expect(execInBox).not.toHaveBeenCalled();
  });
});
