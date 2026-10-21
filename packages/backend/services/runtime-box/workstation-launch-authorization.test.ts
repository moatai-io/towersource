import { generateKeyPairSync } from 'node:crypto';
import { expect, it } from 'vitest';
import { createWorkstationLaunchVerifier, signWorkstationLaunch, type LaunchEnvelope } from './workstation-launch-authorization.js';
const keys = generateKeyPairSync('ed25519');
const envelope: LaunchEnvelope = { version: 1, instanceId: 'instance-a', requestId: 'request-a', projectId: 'project-a', issuedAt: 10000, expiresAt: 20000, payload: JSON.stringify({ command: 'pwd', cwd: '/project', credentials: { DEMO: 'synthetic-only' }, timeoutSec: 10 }) };
const verifier = (capacity = 10) => createWorkstationLaunchVerifier({ publicKey: keys.publicKey, instanceId: 'instance-a', projectId: 'project-a', capacity });
it('accepts exact bytes with a public key and consumes authorization once', () => {
  const check = verifier(); const signed = signWorkstationLaunch(envelope, keys.privateKey);
  expect(check(signed, 11000)).toEqual(envelope);
  expect(() => check(signed, 11000)).toThrow('ALREADY_CONSUMED');
});
it.each(['command', 'cwd', 'credentials', 'timeoutSec'])('rejects %s changes', field => {
  const signed = signWorkstationLaunch(envelope, keys.privateKey);
  const payload = { ...JSON.parse(envelope.payload), [field]: 'modified' };
  const wire = JSON.stringify({ ...envelope, payload: JSON.stringify(payload) });
  expect(() => verifier()({ ...signed, wire }, 11000)).toThrow('SIGNATURE_INVALID');
});
it('rejects a different signer', () => {
  const attacker = generateKeyPairSync('ed25519');
  expect(() => verifier()(signWorkstationLaunch(envelope, attacker.privateKey), 11000)).toThrow('SIGNATURE_INVALID');
});
it.each([{ instanceId: 'old-instance' }, { projectId: 'project-b' }])('rejects another instance or Project', changes => {
  expect(() => verifier()(signWorkstationLaunch({ ...envelope, ...changes }, keys.privateKey), 11000)).toThrow('SCOPE_MISMATCH');
});
it('fails closed at replay cache capacity without evicting active ids', () => {
  const check = verifier(1);
  const signed = signWorkstationLaunch(envelope, keys.privateKey);
  check(signed, 11000);
  expect(() => check(signWorkstationLaunch({ ...envelope, requestId: 'b' }, keys.privateKey), 11000)).toThrow('CAPACITY_EXCEEDED');
  expect(() => check(signed, 11000)).toThrow('ALREADY_CONSUMED');
  expect(check(signWorkstationLaunch({ ...envelope, requestId: 'c', issuedAt: 20000, expiresAt: 30000 }, keys.privateKey), 21000).requestId).toBe('c');
});
it('rejects expiry and invalid clock', () => {
  const signed = signWorkstationLaunch(envelope, keys.privateKey);
  expect(() => verifier()(signed, 20000)).toThrow('ENVELOPE_INVALID');
  expect(() => verifier()(signed, NaN)).toThrow('ENVELOPE_INVALID');
});
it('does not allow a private key in the launcher verifier', () => {
  expect(() => createWorkstationLaunchVerifier({ publicKey: keys.privateKey, instanceId: 'a', projectId: 'a' })).toThrow('PUBLIC_KEY_INVALID');
});
