import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = fs.readFileSync(new URL('./reconcile-primary-worker-assignment.ts', import.meta.url), 'utf8');
describe('same-VM optional assignment storage gate wiring', () => {
  it('preserves legacy main behavior and validates opted-in live service identity before mutation', () => {
    const main = source.slice(source.indexOf('async function main()'));
    expect(main).not.toContain('assertSharedStorageSmokeIdentity');
    expect(main).not.toContain('PRIMARY_WORKER_STATIC_FILE_SCOPE_REQUIRED');
    expect(main.indexOf("storageVerification.status === 'required'")).toBeLessThan(main.indexOf('queueMissingAssignments()'));
    expect(main).toContain('verifyBackendProcessIdentity(storageVerification.backendPid, storageVerification.identity)');
  });
  it('runs filesystem checks in the identity child but retains transport and installation in parent', () => {
    expect(source).toContain("if (storageVerification.status !== 'required') return;");
    expect(source).toContain('await runBackendStorageSmoke({');
    expect(source).toContain('root, identity: storageVerification.identity,');
    expect(source).toContain('PRIMARY_WORKER_UPLOAD_SMOKE_FAILED_');
    expect(source).toContain("method: 'PUT'");
    expect(source).toContain("sharedStorageVerification: result.ok && storageVerification.status === 'required' ? 'verified' : 'unverified'");
    expect(source).toContain('fileAuthorityReady: !signedGrantMode');
  });
});
