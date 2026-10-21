import { describe, expect, it } from 'vitest';
import { clearCredentialIfCurrent, isCurrentCredential } from './account-transition';
function store(token: string) {
  const values = new Map([['token', token], ['username', 'user'], ['userId', '1'], ['userRole', 'member'], ['draft:old-user', 'private draft']]);
  return { getItem: (key: string) => values.get(key) ?? null, removeItem: (key: string) => { values.delete(key); } };
}
describe('account transition credential ownership', () => {
  it('does not let an old 401 clear a new account', () => {
    const storage = store('new');
    expect(clearCredentialIfCurrent('old', storage)).toBe(false);
    expect(storage.getItem('token')).toBe('new');
  });
  it('clears identity mirrors without deleting account-owned drafts', () => {
    const storage = store('old');
    expect(clearCredentialIfCurrent('old', storage)).toBe(true);
    for (const key of ['token', 'username', 'userId', 'userRole']) expect(storage.getItem(key)).toBeNull();
    expect(storage.getItem('draft:old-user')).toBe('private draft');
  });
  it('rejects responses for a previous credential', () => {
    expect(isCurrentCredential('old', store('new'))).toBe(false);
    expect(isCurrentCredential('new', store('new'))).toBe(true);
  });
});
