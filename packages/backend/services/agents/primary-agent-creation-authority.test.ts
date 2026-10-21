import { describe, expect, it, vi } from 'vitest';
const deps = vi.hoisted(() => ({ pool: vi.fn(), transaction: vi.fn(), queryOne: vi.fn(), execute: vi.fn(), project: vi.fn() }));
vi.mock('../../db/pg.js', () => ({ getPgPool: deps.pool }));
vi.mock('../../db/pg-repo.js', () => ({ queryOne: deps.queryOne, execute: deps.execute, transaction: deps.transaction, withClient: vi.fn() }));
vi.mock('../pm/project-manager.js', () => ({ createProject: deps.project, getProject: vi.fn() }));
vi.mock('../pm/project-agent-instruction.js', () => ({ ensureProjectAgentInstruction: vi.fn() }));
vi.mock('../session/session-manager.js', () => ({ createSession: vi.fn(), getSession: vi.fn() }));
vi.mock('./primary-agent-staffing.js', () => ({ validatePrimaryAgentHarnessBinding: vi.fn() }));
import { createPrimaryAgentCommand } from './primary-agent-creation.js';
describe('direct creation command platform authority boundary', () => {
  it.each([true, 'true', 1])('rejects privileged payload %j before lock, intent, DB or Project creation', async superuser => {
    await expect(createPrimaryAgentCommand({ actorUserId: 7, authorityPolicy: { superuser } } as any)).rejects.toThrow('AGENT_EXECUTION_AUTHORITY_RESERVED');
    expect(deps.pool).not.toHaveBeenCalled();
    expect(deps.transaction).not.toHaveBeenCalled();
    expect(deps.queryOne).not.toHaveBeenCalled();
    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.project).not.toHaveBeenCalled();
  });
});
