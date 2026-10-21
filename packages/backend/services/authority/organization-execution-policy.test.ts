import { expect, it } from 'vitest';
import { authorizeTowerAction } from './authorization-policy.js';

const decide = (role: string, granted = false, writable = true) => authorizeTowerAction({
  role, resource: 'worker', action: 'execute',
  facts: { projectMember: true, projectWritable: writable,
    executionScope: 'organization', ...({ organizationExecutionGranted: granted } as object) },
});
it('rejects retired organization scope even for administrators', () => {
  expect(decide('admin').allowed).toBe(false);
});
it.each(['member', 'operator'])('rejects obsolete admission flags for %s', role => {
  expect(decide(role).allowed).toBe(false);
  expect(decide(role, true).allowed).toBe(false);
});
it.each(['viewer', 'guest', 'unknown'])('does not turn a grant into role elevation for %s', role => {
  expect(decide(role, true).allowed).toBe(false);
});
it.each(['admin', 'member', 'operator'])('retains current writable Agent membership for %s', role => {
  expect(decide(role, true, false).allowed).toBe(false);
  expect(authorizeTowerAction({ role, resource: 'worker', action: 'execute',
    facts: { executionScope: 'organization', ...({ organizationExecutionGranted: true } as object) } }).allowed).toBe(false);
});
it('does not change ordinary Project execution or grant system administration', () => {
  expect(authorizeTowerAction({ role: 'member', resource: 'worker', action: 'execute', facts: { projectMember: true } }).allowed).toBe(true);
  expect(authorizeTowerAction({ role: 'member', resource: 'system', action: 'admin', facts: { ...({ organizationExecutionGranted: true } as object) } }).allowed).toBe(false);
});
it('rejects unknown runtime scope instead of treating it as Project execution', () => {
  expect(authorizeTowerAction({ role: 'admin', resource: 'worker', action: 'execute', facts: {
    projectMember: true, executionScope: 'organizaton' as any,
  } }).allowed).toBe(false);
});
