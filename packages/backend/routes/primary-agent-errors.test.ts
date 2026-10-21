import { describe, expect, it, vi } from 'vitest';
const deps = vi.hoisted(() => ({ harness: vi.fn(), bootstrap: vi.fn(), intent: vi.fn() }));
vi.mock('../config.js', () => ({ config: { agentFirstEnabled: true } }));
vi.mock('../services/agents/primary-agent-bootstrap.js', () => ({ buildPrimaryAgentBootstrapPayload: deps.bootstrap }));
vi.mock('../services/agents/primary-agent-staffing.js', () => ({ validatePrimaryAgentHarnessBinding: deps.harness }));
vi.mock('../services/agents/primary-agent-creation-intent.js', () => ({ createPrimaryAgentCreationIntent: deps.intent }));
vi.mock('../services/agents/primary-agent-creation.js', () => ({ createPrimaryAgentCommand: vi.fn() }));
import router from './primary-agent-api.js';

const body = { sourceProjectId: 'source', name: 'Test', face: 'T', expectedExpertise: 'Research' };
const handler = router.stack.find((layer: any) => layer.route?.path === '/bootstrap')!.route!.stack[0].handle as any;
async function request() {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  await handler({ user: { userId: 6, role: 'member' }, body }, res);
  return res;
}
describe('bootstrap creation error stages', () => {
  it('distinguishes inaccessible source projects before reserving a creation command', async () => {
    deps.bootstrap.mockResolvedValueOnce({ payload: { harnessBinding: {}, capabilityRequirements: { required: [] } } });
    deps.harness.mockResolvedValueOnce({});
    deps.intent.mockRejectedValueOnce(new Error('Primary Agent creation requires an accessible source Project'));
    const res = await request();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SOURCE_PROJECT_ACCESS_DENIED' }));
  });
  it('distinguishes unavailable default Harness before issuing an intent', async () => {
    deps.bootstrap.mockResolvedValueOnce({ payload: { harnessBinding: {}, capabilityRequirements: { required: [] } } });
    deps.harness.mockRejectedValueOnce(new Error('Published Harness binding not found or unavailable to the AI talent team Project'));
    const res = await request();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'DEFAULT_HARNESS_UNAVAILABLE' }));
  });
});
