import { describe, expect, it, vi } from 'vitest';
const deps = vi.hoisted(() => ({ pool: vi.fn(), db: vi.fn(), harness: vi.fn() }));
vi.mock('../config.js', () => ({ config: { agentFirstEnabled: true } }));
vi.mock('../db/pg.js', () => ({ getPgPool: deps.pool }));
vi.mock('../db/pg-repo.js', () => ({ queryOne: deps.db, execute: deps.db, transaction: deps.db, withClient: deps.db }));
vi.mock('../services/pm/project-manager.js', () => ({ createProject: vi.fn(), getProject: vi.fn() }));
vi.mock('../services/pm/project-agent-instruction.js', () => ({ ensureProjectAgentInstruction: vi.fn() }));
vi.mock('../services/session/session-manager.js', () => ({ createSession: vi.fn(), getSession: vi.fn() }));
vi.mock('../services/agents/primary-agent-staffing.js', () => ({ validatePrimaryAgentHarnessBinding: deps.harness }));
vi.mock('../services/agents/primary-agent-bootstrap.js', () => ({ buildPrimaryAgentBootstrapPayload: vi.fn() }));
import router from './primary-agent-api.js';
const payload = {
  name: 'Researcher', face: 'R', tagline: 'Research', role: 'Research', promise: 'Citations', instruction: 'Find evidence', firstMission: 'Research',
  sourceProjectId: 'source', authorityPolicy: { superuser: true }, capabilityRequirements: { required: [] },
  harnessBinding: { harnessId: 'research', harnessVersion: 1, runtimeProfileId: 'research', runtimeProfileVersion: 1 },
  idempotencyKey: 'synthetic-key', approvedCardHash: 'a'.repeat(64), approvalIntentId: 'synthetic-intent',
};
describe('HTTP staffing reserved authority boundary', () => {
  it.each(['/preview-intents', '/'])('rejects platform key through actual %s route and shared services', async routePath => {
    const layer = router.stack.find((item: any) => item.route?.path === routePath);
    const handler = layer!.route!.stack[0].handle as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler({ user: { userId: 7, role: 'admin' }, body: payload }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('AGENT_EXECUTION_AUTHORITY_RESERVED') }));
    expect(deps.db).not.toHaveBeenCalled();
    expect(deps.pool).not.toHaveBeenCalled();
  });
});
