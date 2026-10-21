import { beforeEach, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../db/pg-repo.js', () => ({ query: db.query }));
import { diagnoseUnresolvedCredentialRequirements } from './credential-vault-service.js';
beforeEach(() => vi.clearAllMocks());
it('distinguishes legacy quarantine, unsupported kind, and failed eligible selection without secrets', async () => {
  db.query.mockResolvedValue([
    { default_env_name: 'LEGACY_TOKEN', kind: 'api_key', metadata: { legacy_personal_owner_user_id: 42 } },
    { default_env_name: 'DB_PASSWORD', kind: 'password', metadata: {} },
    { default_env_name: 'API_TOKEN', kind: 'api_key', metadata: {} },
  ]);
  expect(await diagnoseUnresolvedCredentialRequirements('agent-a', ['LEGACY_TOKEN', 'DB_PASSWORD', 'API_TOKEN', 'ABSENT_TOKEN'])).toEqual([
    { envName: 'LEGACY_TOKEN', reason: 'LegacyPersonalCredentialBlocked' },
    { envName: 'DB_PASSWORD', reason: 'UnsupportedCredentialKind' },
    { envName: 'API_TOKEN', reason: 'SelectionOrMaterializationFailed' },
    { envName: 'ABSENT_TOKEN', reason: 'NoAccessibleMatchingCredential' },
  ]);
  const [sql, args] = db.query.mock.calls[0];
  expect(sql).toContain("c.scope = 'project' AND c.project_id = $1");
  expect(sql).not.toContain('secret_name');
  expect(args[0]).toBe('agent-a');
});
it('prefers an eligible record over a same-env legacy record', async () => {
  db.query.mockResolvedValue([
    { default_env_name: 'API_TOKEN', kind: 'api_key', metadata: { legacy_personal_owner_user_id: 42 } },
    { default_env_name: 'API_TOKEN', kind: 'api_key', metadata: {} },
  ]);
  expect(await diagnoseUnresolvedCredentialRequirements('agent-a', ['API_TOKEN'])).toEqual([{ envName: 'API_TOKEN', reason: 'SelectionOrMaterializationFailed' }]);
});
it('does not query inventory when every requirement is satisfied', async () => {
  expect(await diagnoseUnresolvedCredentialRequirements('agent-a', [])).toEqual([]);
  expect(db.query).not.toHaveBeenCalled();
});
