import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issueWorkbenchAuthorizationReceipt, verifyWorkbenchAuthorizationReceipt } from './workbench-authorization-receipt.js';

const secret = 'worker-transport-secret';
const expected = {
  actorUserId: 7,
  projectId: 'project-a',
  sessionId: '00000000-0000-4000-8000-000000000007',
  jobId: 42,
  environmentKeys: ['API_TOKEN'],
};

function issue(overrides: Partial<typeof expected> = {}, now = new Date('2026-08-27T00:00:00.000Z')) {
  return issueWorkbenchAuthorizationReceipt({ secret, ...expected, ...overrides, now });
}

describe('Workbench authorization receipt', () => {
  it('binds one signed receipt to actor, Project, Session, Job, capability, and Credential scope', () => {
    const claims = verifyWorkbenchAuthorizationReceipt({
      receipt: issue(),
      secret,
      expected,
      now: new Date('2026-08-27T00:00:30.000Z'),
    });
    expect(claims).toMatchObject({
      policyId: 'tower.control-plane.authorization.v1',
      capability: 'worker:execute',
      actorUserId: 7,
      projectId: 'project-a',
      jobId: 42,
      environmentKeys: ['API_TOKEN'],
    });
    expect(claims.receiptId).toBeTruthy();
  });

  it('fails closed on tampering, expiry, and scope changes', () => {
    const receipt = issue();
    const cases = [
      { receipt: `${receipt.slice(0, -1)}x`, expected, now: new Date('2026-08-27T00:00:30.000Z') },
      { receipt, expected, now: new Date('2026-08-27T00:01:01.000Z') },
      { receipt, expected: { ...expected, projectId: 'project-b' }, now: new Date('2026-08-27T00:00:30.000Z') },
      { receipt, expected: { ...expected, actorUserId: 8 }, now: new Date('2026-08-27T00:00:30.000Z') },
      { receipt, expected: { ...expected, environmentKeys: ['OTHER_TOKEN'] }, now: new Date('2026-08-27T00:00:30.000Z') },
    ];
    for (const testCase of cases) {
      expect(() => verifyWorkbenchAuthorizationReceipt({ secret, ...testCase })).toThrow(/authorization receipt/i);
    }
  });
});

function resign(changes: Record<string, unknown>) {
  const claims = JSON.parse(Buffer.from(issue().split('.')[0], 'base64url').toString('utf8'));
  const payload = Buffer.from(JSON.stringify({ ...claims, ...changes })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}
it.each([
  { expiresAt: 'invalid' }, { issuedAt: 'invalid' }, { expiresAt: null },
  { issuedAt: 123 }, { receiptId: {} }, { receiptId: ' ' },
  { issuedAt: '2026-08-27T00:00:40.000Z', expiresAt: '2026-08-27T00:00:35.000Z' },
])('rejects authenticated but malformed temporal/identity claims %j', changes => {
  expect(() => verifyWorkbenchAuthorizationReceipt({ receipt: resign(changes), secret, expected,
    now: new Date('2026-08-27T00:00:30.000Z') })).toThrow('authorization receipt');
});
it('rejects invalid verifier clock', () => {
  expect(() => verifyWorkbenchAuthorizationReceipt({ receipt: issue(), secret, expected, now: new Date(NaN) })).toThrow('authorization receipt');
});
it('rejects empty verification key', () => {
  expect(() => verifyWorkbenchAuthorizationReceipt({ receipt: issue(), secret: '', expected })).toThrow('authorization receipt');
});
