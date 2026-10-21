import { describe, expect, it } from 'vitest';
import { sandboxIdentityFiles } from './worker-sandbox-identity.js';

describe('sandbox identity database', () => {
  it('represents a numeric service uid with one account and files-only user lookup', () => {
    const [passwd, group, nss] = sandboxIdentityFiles('/workspace/home', { uid: 30033, gid: 30033, username: 'worker' });
    expect(passwd).toBe('worker:x:30033:30033:Worker:/workspace/home:/bin/sh\n');
    expect(group).toBe('worker:x:30033:\n');
    expect(nss).toContain('passwd: files\n');
    expect(nss).toContain('hosts: files dns\n');
  });
  it('does not interpolate malformed account names', () => {
    expect(sandboxIdentityFiles('/workspace', { uid: 33, gid: 33, username: 'bad\nroot:x:0:0' })[0]).toMatch(/^worker-33:x:33:33:/);
  });
  it.each(['/home/a\nroot', '/home/a:b', '/home/a\0', 'relative'])('rejects invalid home %j', home => {
    expect(() => sandboxIdentityFiles(home, { uid: 33, gid: 33, username: 'worker' })).toThrow('WORKER_SANDBOX_IDENTITY_INVALID');
  });
  it('rejects invalid numeric identities', () => {
    expect(() => sandboxIdentityFiles('/workspace', { uid: -1, gid: 33, username: 'worker' })).toThrow();
  });
});
