import { beforeEach, expect, it, vi } from 'vitest';
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../db/pg.js', () => ({ getPgPool: () => ({ query }) }));
vi.mock('../../config.js', () => ({ config: { sandbox: {} } }));
import { getSecretForLegacyGwsBinding } from './secret-store.js';
beforeEach(() => vi.resetAllMocks());
it('returns null only for absence of an opt-in binding', async () => { query.mockResolvedValue({ rows: [] }); expect(await getSecretForLegacyGwsBinding('synthetic-gws', 7)).toBeNull(); });
it('fails closed for a present but unauthorized binding', async () => { query.mockResolvedValue({ rows: [{ allowed: false, value_encrypted: null }] }); await expect(getSecretForLegacyGwsBinding('synthetic-gws', 7)).rejects.toThrow('unavailable'); });
it('queries exact secret, frozen audience, live grants and account status without fallback', async () => {
 query.mockResolvedValue({ rows: [] }); await getSecretForLegacyGwsBinding('synthetic-gws', 7);
 const [sql, params] = query.mock.calls[0];
 expect(params).toEqual(['synthetic-gws', 7]);
 for (const clause of ['s.id = b.secret_id', 'b.enabled = true', '$2 = ANY(b.allowed_user_ids)', 'u.disabled = 0', 'secret_grants', 'c.secret_name = s.name', "c.kind = 'gws'"]) expect(sql).toContain(clause);
 expect(sql).not.toContain("s.scope = 'global'");
});
