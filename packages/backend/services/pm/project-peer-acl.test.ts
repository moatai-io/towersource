import { describe, expect, it } from 'vitest';
import { freshProjectPeerAcl, migrationProjectPeerAcl } from './project-peer-acl.js';
describe('Project peer ACL ownership', () => {
  it('keeps fresh root private and supports read-only platform executors', () => {
    const acl = freshProjectPeerAcl(1001, 30033, 'r-x');
    expect(acl).toContain('u:30033:r-x'); expect(acl).toContain('d:u:30033:r-x');
    expect(acl).toContain('g::---'); expect(acl).toContain('o::---');
  });
  it('grants peer writing without resetting unrelated principals during migration', () => {
    expect(migrationProjectPeerAcl(1001, 30033, false, false)).toEqual(['u:1001:rw-', 'u:30033:rw-', 'm::rwx']);
    expect(migrationProjectPeerAcl(1001, 30033, true, false)).toContain('d:u:1001:rwx');
    expect(migrationProjectPeerAcl(1001, 30033, false, true)).toContain('u:30033:rwx');
  });
  it.each([[0, 30033], [1001, 1001], [1001, -1]])('rejects invalid identities %j', (a, b) => {
    expect(() => freshProjectPeerAcl(a, b, 'rwx')).toThrow('IDENTITIES_INVALID');
    expect(() => migrationProjectPeerAcl(a, b, true, false)).toThrow('IDENTITIES_INVALID');
  });
});
