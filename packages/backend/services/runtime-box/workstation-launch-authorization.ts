/** Prototype launch authorization boundary, not wired to a listening service.
 * Sign exact wire bytes (including credentials); never log or persist payloads.
 * Launcher holds an Ed25519 public key only. A fresh instance id invalidates old requests.
 */
import { KeyObject, sign, verify } from 'node:crypto';
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_TTL_MS = 60_000;
export interface LaunchEnvelope {
  version: 1;
  instanceId: string;
  requestId: string;
  projectId: string;
  issuedAt: number;
  expiresAt: number;
  payload: string;
}
function checkedEnvelope(wire: string, now: number): LaunchEnvelope {
  if (typeof wire !== 'string' || Buffer.byteLength(wire) > MAX_PAYLOAD_BYTES) throw new Error('LAUNCH_ENVELOPE_INVALID');
  let value: LaunchEnvelope;
  try { value = JSON.parse(wire); } catch { throw new Error('LAUNCH_ENVELOPE_INVALID'); }
  if (!value || value.version !== 1
    || ![value.instanceId, value.requestId, value.projectId].every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id))
    || typeof value.payload !== 'string'
    || !Number.isSafeInteger(now) || !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt)
    || value.issuedAt > now + 5_000 || value.expiresAt <= now
    || value.expiresAt <= value.issuedAt || value.expiresAt - value.issuedAt > MAX_TTL_MS) {
    throw new Error('LAUNCH_ENVELOPE_INVALID');
  }
  return value;
}
export function signWorkstationLaunch(envelope: LaunchEnvelope, privateKey: KeyObject): { wire: string; signature: string } {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') throw new Error('LAUNCH_SIGNING_KEY_INVALID');
  const wire = JSON.stringify(envelope);
  checkedEnvelope(wire, envelope.issuedAt);
  return { wire, signature: sign(null, Buffer.from(wire), privateKey).toString('base64url') };
}
export function createWorkstationLaunchVerifier(input: {
  publicKey: KeyObject; instanceId: string; projectId: string; capacity?: number;
}) {
  if (input.publicKey.type !== 'public' || input.publicKey.asymmetricKeyType !== 'ed25519') throw new Error('LAUNCH_PUBLIC_KEY_INVALID');
  const capacity = input.capacity ?? 4096;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100_000) throw new Error('LAUNCH_CAPACITY_INVALID');
  const consumed = new Map<string, number>();
  return (request: { wire: string; signature: string }, now = Date.now()): LaunchEnvelope => {
    if (typeof request.wire !== 'string' || Buffer.byteLength(request.wire) > MAX_PAYLOAD_BYTES
      || typeof request.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(request.signature)
      || !verify(null, Buffer.from(request.wire), input.publicKey, Buffer.from(request.signature, 'base64url'))) {
      throw new Error('LAUNCH_SIGNATURE_INVALID');
    }
    const envelope = checkedEnvelope(request.wire, now);
    if (envelope.instanceId !== input.instanceId || envelope.projectId !== input.projectId) throw new Error('LAUNCH_SCOPE_MISMATCH');
    for (const [id, expiry] of consumed) if (expiry <= now) consumed.delete(id);
    if (consumed.has(envelope.requestId)) throw new Error('LAUNCH_ALREADY_CONSUMED');
    if (consumed.size >= capacity) throw new Error('LAUNCH_CAPACITY_EXCEEDED');
    // Synchronous claim before any async dispatch. Failed launches need a NEW authorization.
    consumed.set(envelope.requestId, envelope.expiresAt);
    return envelope;
  };
}
