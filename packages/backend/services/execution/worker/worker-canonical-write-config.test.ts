import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { buildWorkerCanonicalWriteAuthority } from './worker-canonical-write-config.js';
const keys = generateKeyPairSync('ed25519');
let base: string; let project: string; let config: { backendUrl: string; verificationKeyFile: string; replayRoot: string };
beforeEach(() => {
 base = fs.mkdtempSync(path.join(os.tmpdir(), 'write-config-')); project = path.join(base,'project'); fs.mkdirSync(project);
 const replayRoot = path.join(base,'replay'); fs.mkdirSync(replayRoot,{mode:0o700});
 const verificationKeyFile = path.join(base,'public.pem'); fs.writeFileSync(verificationKeyFile,keys.publicKey.export({type:'spki',format:'pem'}),{mode:0o600});
 config = {backendUrl:'http://127.0.0.1:9000',verificationKeyFile,replayRoot};
});
afterEach(() => fs.rmSync(base,{recursive:true,force:true}));
const build = (value: typeof config | undefined = config, roots = [project], identity = 'synthetic-worker-jwt') => buildWorkerCanonicalWriteAuthority(value, roots, identity);
it('is disabled without explicit config and does not require identity', () => { expect(buildWorkerCanonicalWriteAuthority(undefined, [], '')).toBeUndefined(); });
it('builds all three dependencies without network or a private signing key', async () => {
 const result = build()!; expect(result.verificationKey.type).toBe('public');
 expect(typeof result.authorize).toBe('function');
 const nonce = '11111111-1111-4111-8111-111111111111';
 expect(await result.consume(nonce,Date.now()+5000)).toBe(true); expect(await result.consume(nonce,Date.now()+5000)).toBe(false);
});
it('refuses missing Worker identity', () => { expect(() => build(config,[project],'')).toThrow(); });
it('refuses a private key even though Node can derive a public key from it', () => {
 fs.writeFileSync(config.verificationKeyFile, keys.privateKey.export({type:'pkcs8',format:'pem'}));
 expect(() => build()).toThrow();
});
it.each(['replayRoot','verificationKeyFile'] as const)('refuses %s within a writable Project', field => {
 const target = path.join(project,field);
 if(field==='replayRoot') fs.mkdirSync(target,{mode:0o700}); else fs.copyFileSync(config.verificationKeyFile,target);
 expect(() => build({...config,[field]:target})).toThrow();
});
it('refuses writable or symlinked verification key', () => {
 fs.chmodSync(config.verificationKeyFile,0o666); expect(() => build()).toThrow();
 fs.chmodSync(config.verificationKeyFile,0o600); const link = path.join(base,'alias.pem'); fs.symlinkSync(config.verificationKeyFile,link);
 expect(() => build({...config,verificationKeyFile:link})).toThrow();
});
it('rejects Project nesting inside the replay store', () => { const nested = path.join(config.replayRoot,'project'); fs.mkdirSync(nested); expect(() => build(config,[nested])).toThrow(); });
