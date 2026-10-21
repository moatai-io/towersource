import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ queryOne: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ queryOne: m.queryOne }));
import { createSessionMcpServerChecker, getSessionMcpSelection, setSessionMcpSelection } from './session-mcp-selection.js';

beforeEach(() => vi.resetAllMocks());
describe('session MCP opt-outs', () => {
  it('defaults legacy/null selection to allow all authorized MCPs', async () => {
    m.queryOne.mockResolvedValue({ id: 's', project_id: 'p', engine: 'pi', mcp_excluded_server_names: null });
    expect(await getSessionMcpSelection('s')).toEqual({ sessionId: 's', projectId: 'p', supported: true, excludedServerNames: [] });
    expect(await createSessionMcpServerChecker({ sessionId: 's', projectId: 'p' })('drive')).toBe(true);
  });
  it('persists a normalized replacement guarded by current project identity', async () => {
    m.queryOne.mockResolvedValue({ id: 's', project_id: 'p', engine: 'pi', mcp_excluded_server_names: ['drive'] });
    expect((await setSessionMcpSelection('s', 'p', ['drive', 'drive']))?.excludedServerNames).toEqual(['drive']);
    expect(m.queryOne).toHaveBeenCalledWith(expect.stringContaining('project_id IS NOT DISTINCT FROM $2'), ['s', 'p', '["drive"]']);
  });
  it('rechecks stored selection on each use, including previously discovered tools', async () => {
    const check = createSessionMcpServerChecker({ sessionId: 's', projectId: 'p' });
    m.queryOne.mockResolvedValueOnce({ id: 's', project_id: 'p', engine: 'pi', mcp_excluded_server_names: [] })
      .mockResolvedValueOnce({ id: 's', project_id: 'p', engine: 'pi', mcp_excluded_server_names: ['drive'] });
    expect(await check('drive')).toBe(true);
    expect(await check('drive')).toBe(false);
    expect(m.queryOne).toHaveBeenCalledTimes(2);
  });
  it('fails closed for missing/moved session or invalid stored policy', async () => {
    const check = createSessionMcpServerChecker({ sessionId: 's', projectId: 'p' });
    m.queryOne.mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: 's', project_id: 'other', engine: 'pi', mcp_excluded_server_names: [] })
      .mockResolvedValueOnce({ id: 's', project_id: 'p', engine: 'pi', mcp_excluded_server_names: 'bad' });
    expect(await check('drive')).toBe(false);
    expect(await check('drive')).toBe(false);
    await expect(check('drive')).rejects.toThrow('Invalid stored MCP selection');
  });
  it('does not allow on storage failure or reuse a previously allowed policy', async () => {
    const check = createSessionMcpServerChecker({ sessionId: 's', projectId: 'p' });
    m.queryOne.mockResolvedValueOnce({ id: 's', project_id: 'p', engine: 'pi', mcp_excluded_server_names: [] })
      .mockRejectedValueOnce(new Error('storage unavailable'));
    expect(await check('drive')).toBe(true);
    await expect(check('drive')).rejects.toThrow('storage unavailable');
  });
  it('stops MCP exposure when the session switches away from Pi', async () => {
    m.queryOne.mockResolvedValue({ id: 's', project_id: 'p', engine: 'claude', mcp_excluded_server_names: [] });
    expect(await createSessionMcpServerChecker({ sessionId: 's', projectId: 'p' })('drive')).toBe(false);
    expect((await getSessionMcpSelection('s'))?.supported).toBe(false);
  });
  it('never falls back to global project policy when project context is absent', async () => {
    expect(await createSessionMcpServerChecker({ sessionId: 's' })('drive')).toBe(false);
    expect(m.queryOne).not.toHaveBeenCalled();
  });
  it('optional RunOpts exclusion can only tighten persisted policy', async () => {
    m.queryOne.mockResolvedValue({ id: 's', project_id: 'p', engine: 'pi', mcp_excluded_server_names: ['slack'] });
    const check = createSessionMcpServerChecker({ sessionId: 's', projectId: 'p', mcpExcludedServerNames: ['drive'] });
    expect(await check('drive')).toBe(false);
    expect(await check('slack')).toBe(false);
  });
  it('guards persisted updates against a simultaneous engine switch', async () => {
    m.queryOne.mockResolvedValue(undefined);
    expect(await setSessionMcpSelection('s', 'p', [])).toBeUndefined();
    expect(m.queryOne).toHaveBeenCalledWith(expect.stringContaining("AND engine = 'pi'"), ['s', 'p', '[]']);
  });
  it('rejects unbounded or malformed exclusions before writing', async () => {
    await expect(setSessionMcpSelection('s', 'p', ['../../escape'])).rejects.toThrow();
    await expect(setSessionMcpSelection('s', 'p', Array(65).fill('drive'))).rejects.toThrow();
    expect(m.queryOne).not.toHaveBeenCalled();
  });
});
