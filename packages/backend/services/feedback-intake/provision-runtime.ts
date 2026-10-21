/** Shared bounded IO/config contracts for operator launcher and customer receiver. */
import { hostname } from 'node:os';
import * as fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { readPrivate, refuse, sha, trustedAncestors } from './provision-files.js';

export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const safePath = z.string().regex(/^\/[A-Za-z0-9_./-]+$/).refine(p => path.normalize(p) === p && p !== '/');
export const hostSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,120}$/);
export const receiverBindingSchema = z.object({ version: z.literal(1), revision: z.string().regex(/^[a-f0-9]{40}$/),
  manifestPath: safePath, host: hostSchema, uid: z.number().int().nonnegative(),
  envPath: safePath, backupDir: safePath, planHash: hashSchema, preimage: hashSchema,
  origin: z.string().url(),
}).strict();
export type ReceiverBinding = z.infer<typeof receiverBindingSchema>;
export const snapshotSchema = z.object({ host: hostSchema, uid: z.number().int().nonnegative(),
  envPath: safePath, hash: hashSchema, empty: z.boolean(), matches: z.boolean() }).strict();
export const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('inspect'), bindingHash: hashSchema,
    token: z.string().length(43).regex(/^[A-Za-z0-9_-]+$/).optional() }).strict(),
  z.object({ action: z.literal('append'), bindingHash: hashSchema, planHash: hashSchema,
    host: hostSchema, uid: z.number().int().nonnegative(), envPath: safePath,
    preimage: hashSchema, origin: z.string().url(),
    token: z.string().length(43).regex(/^[A-Za-z0-9_-]+$/) }).strict(),
]);
export const responseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('inspected'), bindingHash: hashSchema, snapshot: snapshotSchema }).strict(),
  z.object({ status: z.literal('appended'), bindingHash: hashSchema }).strict(),
]);
export interface LocalChecks { ancestors: (directory: string) => void; host?: typeof verifyLocalHost }
export const productionChecks: LocalChecks = { ancestors: trustedAncestors, host: verifyLocalHost };
export function readConfig(file: string, checks = productionChecks): Buffer {
  checks.ancestors(path.dirname(file));return readPrivate(file);
}
export function verifyManifest(file: string, revision: string, checks = productionChecks): void {
  checks.ancestors(path.dirname(file));
  if (fs.realpathSync(file) !== file) refuse();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || ![0,process.geteuid!()].includes(s.uid) || (s.mode & 0o022) || s.size > 65536) refuse();
    const bytes=Buffer.alloc(65537);const length=fs.readSync(fd,bytes,0,bytes.length,0);
    if(length>65536 || JSON.parse(bytes.subarray(0,length).toString()).sourceRev !== revision) refuse();
  } finally { fs.closeSync(fd); }
}
export function verifySelfLocation(manifestPath: string, moduleUrl: string): void {
  // Nix release layout: share/tower/release-manifest.json and lib/tower/dist/backend/...
  // Production CLI entrypoints must execute the compiled file from this very closure.
  const root=path.resolve(path.dirname(manifestPath),'../..');
  const expected=path.join(root,'lib/tower/dist/backend/packages/backend/services/feedback-intake');
  if (path.dirname(new URL(moduleUrl).pathname) !== expected) refuse();
}
export function verifyLocalHost(host: string, uid?: number): void {
  if (hostname() !== host || (uid !== undefined && process.geteuid!() !== uid)) refuse();
}
export async function boundedInput(stream: NodeJS.ReadableStream, max=8192): Promise<Buffer> {
  let length=0;const chunks:Buffer[]=[];
  for await (const chunk of stream) { const b=Buffer.from(chunk);length+=b.length;if(length>max)refuse();chunks.push(b); }
  return Buffer.concat(chunks);
}
export type CommandRunner = (executable: string, argv: readonly string[], stdin: Buffer) => Promise<Buffer>;
// Fixed minimal environment: no HOME/PG*/NODE_OPTIONS/SSH_AUTH_SOCK/provider env inheritance.
export const subprocessRunner: CommandRunner = async (executable,argv,stdin) => new Promise((resolve,reject)=>{
  const child=spawn(executable,[...argv],{shell:false,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:['pipe','pipe','pipe']});
  const chunks:Buffer[]=[];let size=0;let failed=false;
  const timer=setTimeout(()=>{failed=true;child.kill('SIGKILL');},20000);
  child.stdout.on('data',(b:Buffer)=>{size+=b.length;if(size>8192){failed=true;child.kill('SIGKILL');}else chunks.push(b);});
  // Never accumulate or reflect provider/SSH/receiver stderr, which can contain secrets.
  child.stderr.on('data',()=>{});
  child.stdin.on('error',()=>{failed=true;});
  child.on('error',()=>{clearTimeout(timer);reject(new Error('feedback_provision_transport_failed'));});
  child.on('close',code=>{clearTimeout(timer);if(failed||code!==0)reject(new Error('feedback_provision_transport_failed'));else resolve(Buffer.concat(chunks));});
  child.stdin.end(stdin);
});
export function bindHash(raw: Buffer): string { return sha(raw); }
