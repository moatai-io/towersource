import { expect, it } from 'vitest';
import { validateWorkstationCommandIdentity } from './workstation-command-identity.js';
const policy = { projectId: 'project-a', uid: 31001, gid: 31001, home: '/workstation/home', projectRoot: '/workstation/project' };
const input = { projectId: 'project-a', controllerUid: 31002, launcher: { uid: 31001, gid: 31001, groups: [31001] } };
it('accepts an already separated nonprivileged launcher', () => {
  expect(() => validateWorkstationCommandIdentity(policy, input)).not.toThrow();
});
it.each([0, -1, 1.5, NaN, 0xffffffff])('rejects invalid or root command uid %s', uid => {
  expect(() => validateWorkstationCommandIdentity({ ...policy, uid }, input)).toThrow('POLICY_INVALID');
});
it('rejects the same controller and command uid', () => {
  expect(() => validateWorkstationCommandIdentity(policy, { ...input, controllerUid: policy.uid })).toThrow('NOT_SEPARATED');
});
it('does not let a request select another project policy', () => {
  expect(() => validateWorkstationCommandIdentity(policy, { ...input, projectId: 'other' })).toThrow('PROJECT_MISMATCH');
});
it('rejects a privileged launcher instead of dropping uid implicitly', () => {
  expect(() => validateWorkstationCommandIdentity(policy, { ...input, launcher: { uid: 0, gid: 0, groups: [] } })).toThrow('IDENTITY_MISMATCH');
});
it('rejects inherited access to controller or shared privileged groups', () => {
  expect(() => validateWorkstationCommandIdentity(policy, { ...input, launcher: { ...input.launcher, groups: [31001, 31002] } })).toThrow('SUPPLEMENTARY_GROUPS_DENIED');
});
it.each(['/', 'relative', '/home/../control', '/home\ninvalid'])('rejects ambiguous policy path %s', home => {
  expect(() => validateWorkstationCommandIdentity({ ...policy, home }, input)).toThrow('POLICY_INVALID');
});
