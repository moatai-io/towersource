/** Customer-local append adapter. Caller supplies exact reviewed host/UID/path.
 * No SSH execution here; bind this entrypoint through a reviewed fixed command.
 */
import * as fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { atomicReplace, exclusiveWrite, managedValues, privateDirectory, readPrivate, refuse,
  sha, trustedAncestors, withFileLock } from './provision-files.js';

const requestSchema = z.object({ version: z.literal(1), planHash: z.string().regex(/^[a-f0-9]{64}$/),
  host: z.string().min(1), uid: z.number().int().nonnegative(), envPath: z.string(),
  preimage: z.string().regex(/^[a-f0-9]{64}$/), origin: z.string().url(),
  token: z.string().length(43).regex(/^[A-Za-z0-9_-]+$/),
}).strict();
export interface CustomerSnapshot { host: string; uid: number; envPath: string; hash: string; empty: boolean; matches: boolean }
export interface CustomerTransport {
  inspect(token?: string, origin?: string): Promise<CustomerSnapshot>;
  // Transport MUST carry these bytes in stdin only; never argv, shell, logs, receipt.
  appendStdin(input: Buffer): Promise<void>;
}
export function localCustomerAdapter(binding: {
  host: string; uid: number; envPath: string; backupDir: string;
  observeIdentity: () => { host: string; uid: number };
  // Production must use trustedAncestors plus ACL review. Injectable for temp tests.
  checkAncestors?: (dir: string) => void;
}): CustomerTransport {
  const check = () => {
    const actual = binding.observeIdentity();
    if (actual.host !== binding.host || actual.uid !== binding.uid || actual.uid !== process.geteuid!()) refuse();
    privateDirectory(binding.backupDir);
    (binding.checkAncestors ?? trustedAncestors)(path.dirname(binding.envPath));
    (binding.checkAncestors ?? trustedAncestors)(binding.backupDir);
    return readPrivate(binding.envPath, binding.uid);
  };
  const inspect = async (token?: string, origin?: string): Promise<CustomerSnapshot> => {
    const bytes = check(); const values = managedValues(bytes);
    return { host: binding.host, uid: binding.uid, envPath: binding.envPath, hash: sha(bytes), empty: values.size === 0,
      matches: values.size === 3 && !!token && values.get('TOWER_FEEDBACK_CLIENT_TOKEN') === token
        && values.get('TOWER_FEEDBACK_CLIENT_ENABLED') === 'true' && values.get('TOWER_FEEDBACK_INTAKE_ORIGIN') === origin };
  };
  return { inspect, async appendStdin(input) {
    try {
      if (input.length > 4096) refuse();
      const r = requestSchema.parse(JSON.parse(input.toString('utf8')));
      if (r.host !== binding.host || r.uid !== binding.uid || r.envPath !== binding.envPath) refuse();
      const url = new URL(r.origin);
      if (url.protocol !== 'https:' || url.origin !== r.origin || url.username || url.password) refuse();
      check();
      await withFileLock(path.join(binding.backupDir, 'customer-append.lock'), async () => {
        const current = await inspect(r.token, r.origin);
        if (current.matches) return; // lost ACK: no rewrite, backup, rotation or second append
        if (!current.empty || current.hash !== r.preimage) refuse();
        const bytes = check(); if (sha(bytes) !== r.preimage) refuse();
        const backup = path.join(binding.backupDir, `${r.planHash}.env-before`);
        if (fs.existsSync(backup)) { if (sha(readPrivate(backup)) !== r.preimage) refuse(); }
        else exclusiveWrite(backup, bytes);
        const suffix = `${bytes.length && bytes.at(-1) !== 10 ? '\n' : ''}TOWER_FEEDBACK_CLIENT_TOKEN=${r.token}\nTOWER_FEEDBACK_CLIENT_ENABLED=true\nTOWER_FEEDBACK_INTAKE_ORIGIN=${r.origin}\n`;
        atomicReplace(binding.envPath, Buffer.concat([bytes, Buffer.from(suffix)]), () => {
          if (sha(check()) !== r.preimage) refuse();
        });
        if (!(await inspect(r.token, r.origin)).matches) refuse();
      });
    } catch { refuse(); }
  } };
}

/** Fixed SSH transport contract only: never interpolate env path, host, token or
 * script fragments into a remote shell command. The runner is injected; the
 * receiver must itself be installed/bound to the approved customer identity.
 * No ambient agent forwarding, passwords, or accept-new host-key behavior.
 */
export function feedbackSshSpec(host: string, knownHosts: string) {
  if (!/^[a-z_][a-z0-9_-]*@[a-z0-9][a-z0-9.-]*$/.test(host)
    || !path.isAbsolute(knownHosts) || /[\s\0]/.test(knownHosts)) refuse();
  return { executable: 'ssh', argv: ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', `UserKnownHostsFile=${knownHosts}`,
    '--', host, '/usr/local/libexec/tower-feedback-customer-append'],
    input: 'bounded-json-stdin-only', output: 'fixed-status-only', hostBinding: host } as const;
}
