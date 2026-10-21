import { describe, expect, it } from 'vitest';
import { replacementAccessAcl } from './canonical-replacement-acl.js';
describe('group access preservation without chown', () => {
  const acl = 'user::rw-\nuser:1001:rw-\ngroup::rw-\nmask::rw-\nother::r--\n';
  it('leaves same-group ACL exactly unchanged', () => expect(replacementAccessAcl(acl, 10, 10)).toBe(acl));
  it('keeps old group grant as a named group and prevents widening new group', () => {
    const result = replacementAccessAcl(acl, 10, 20);
    expect(result).toContain('group:10:rw-'); expect(result).toContain('group::r--');
    expect(result).toContain('user:1001:rw-'); expect(result).toContain('mask::rw-');
  });
  it('retains previously named new-group grant and never raises private mask', () => {
    const input = 'user::rw-\ngroup::rwx\ngroup:20:rwx\nmask::---\nother::---\n';
    const result = replacementAccessAcl(input, 10, 20);
    expect(result).toContain('group::---'); expect(result).toContain('mask::---');
    expect(result).toContain('group:10:rwx'); expect(result).not.toContain('group:20:');
  });
  it('fails closed instead of merging two different original entries', () => {
    expect(() => replacementAccessAcl(acl + 'group:10:r--\n', 10, 20)).toThrow('GROUP_AMBIGUOUS');
  });
});


describe('former owner access on replacement', () => {
  it('retains former owner write without activating masked users or groups', () => {
    const result = replacementAccessAcl('user::rw-\nuser:55:rwx\ngroup::rwx\nmask::---\nother::---\n', 10, 10, 77, 88);
    expect(result).toContain('user:77:rw-');
    expect(result).toContain('user:55:---');
    expect(result).toContain('group::---');
    expect(result).toContain('mask::rw-');
  });
  it('keeps same-owner private ACL unchanged', () => {
    const acl = 'user::rw-\ngroup::---\nother::---\n';
    expect(replacementAccessAcl(acl, 10, 10, 77, 77)).toBe(acl);
  });
});
