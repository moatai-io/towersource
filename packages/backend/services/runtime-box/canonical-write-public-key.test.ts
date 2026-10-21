import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { loadCanonicalWritePublicKey } from './canonical-write-public-key.js';
let root: string; let file: string;
const keys = generateKeyPairSync('ed25519');
beforeEach(() => { root=fs.mkdtempSync(path.join(os.tmpdir(),'write-public-key-')); file=path.join(root,'public.pem'); fs.writeFileSync(file,keys.publicKey.export({format:'pem',type:'spki'}),{mode:0o600}); });
afterEach(() => fs.rmSync(root,{recursive:true,force:true}));
it('keeps absent configuration disabled', () => { expect(loadCanonicalWritePublicKey(undefined)).toBeUndefined(); });
it('loads only an Ed25519 public key', () => { expect(loadCanonicalWritePublicKey(file)?.asymmetricKeyType).toBe('ed25519'); });
it.each(['','relative.pem'])('rejects invalid explicit configuration %j', value => { expect(() => loadCanonicalWritePublicKey(value)).toThrow(); });
it('rejects private keys without returning or logging their values', () => { fs.writeFileSync(file,keys.privateKey.export({format:'pem',type:'pkcs8'})); expect(() => loadCanonicalWritePublicKey(file)).toThrow('CANONICAL_WRITE_KEY_INVALID'); });
it('rejects writable key, links, and hard links', () => {
 fs.chmodSync(file,0o666); expect(() => loadCanonicalWritePublicKey(file)).toThrow(); fs.chmodSync(file,0o600);
 const alias=path.join(root,'alias'); fs.symlinkSync(file,alias); expect(() => loadCanonicalWritePublicKey(alias)).toThrow(); fs.unlinkSync(alias);
 fs.linkSync(file,alias); expect(() => loadCanonicalWritePublicKey(file)).toThrow();
});
it('rejects symlinked ancestors and non-Ed25519 keys', () => {
 const real=path.join(root,'real'); fs.mkdirSync(real); fs.renameSync(file,path.join(real,'key')); fs.symlinkSync(real,path.join(root,'alias'));
 expect(() => loadCanonicalWritePublicKey(path.join(root,'alias/key'))).toThrow();
 const rsa=generateKeyPairSync('rsa',{modulusLength:2048}); fs.writeFileSync(file,rsa.publicKey.export({format:'pem',type:'spki'})); expect(() => loadCanonicalWritePublicKey(file)).toThrow();
});
it('reports bounded generic errors for missing or oversized files', () => {
 expect(() => loadCanonicalWritePublicKey(path.join(root,'missing'))).toThrow('CANONICAL_WRITE_KEY_INVALID');
 fs.writeFileSync(file,'x'.repeat(17000)); expect(() => loadCanonicalWritePublicKey(file)).toThrow('CANONICAL_WRITE_KEY_INVALID');
});
