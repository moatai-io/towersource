import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { githubConfig } from './config.js';

const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
let root: string; let filename: string;
const base = { TOWER_FEEDBACK_INTAKE_ENABLED: 'true', TOWER_FEEDBACK_DELIVERY_ENABLED: 'true',
  TOWER_FEEDBACK_GITHUB_APP_ID: '123', TOWER_FEEDBACK_GITHUB_INSTALLATION_ID: '456',
  TOWER_FEEDBACK_GITHUB_REPOSITORY_ID: '789', TOWER_FEEDBACK_GITHUB_REPOSITORY: 'example-org/tower-issues' };
const env = (extra: NodeJS.ProcessEnv = {}) => ({ ...base, TOWER_FEEDBACK_GITHUB_KEY_FILE: filename, ...extra });
beforeEach(() => {
  mkdirSync('work', { recursive: true });
  root = mkdtempSync(path.resolve('work/feedback-key-test-')); chmodSync(root, 0o700);
  filename = path.join(root, 'synthetic.pem'); writeFileSync(filename, pem, { mode: 0o600 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const rejected = (settings = env()) => expect(() => githubConfig(settings)).toThrow('feedback_github_not_configured');
describe('central-only GitHub key file contract', () => {
  it.each([0o400, 0o600])('accepts a private regular file with mode %s', mode => {
    chmodSync(filename, mode);
    expect(githubConfig(env()).privateKey === pem).toBe(true);
  });
  it('file takes precedence over an invalid inline value', () => {
    expect(githubConfig(env({ TOWER_FEEDBACK_GITHUB_PRIVATE_KEY: 'invalid-inline' })).privateKey === pem).toBe(true);
  });
  it('keeps inline PEM compatibility when the file variable is absent', () => {
    expect(githubConfig({ ...base, TOWER_FEEDBACK_GITHUB_PRIVATE_KEY: pem }).privateKey === pem).toBe(true);
  });
  it.each(['', 'relative.pem', '/no-such-feedback-key.pem'])('never falls back for an invalid explicit file setting (%s)', file => {
    rejected(env({ TOWER_FEEDBACK_GITHUB_KEY_FILE: file, TOWER_FEEDBACK_GITHUB_PRIVATE_KEY: pem }));
  });
  it.each([
    { TOWER_FEEDBACK_INTAKE_ENABLED: 'false' }, { TOWER_FEEDBACK_DELIVERY_ENABLED: 'false' },
    { TOWER_CANDIDATE_PASSIVE_MODE: 'true' }, { TOWER_FEEDBACK_CLIENT_ENABLED: 'true' },
  ])('rejects file configuration outside an active central delivery backend', extra => rejected(env(extra)));
  it.each([0o644, 0o640, 0o660, 0o700, 0o4600])('rejects non-private/special file mode %s', mode => {
    chmodSync(filename, mode); rejected();
  });
  it('rejects a parent directory accessible by other users', () => { chmodSync(root, 0o750); rejected(); });
  it('rejects symlink and hardlink files', () => {
    const alias = path.join(root, 'alias'); symlinkSync(filename, alias);
    rejected(env({ TOWER_FEEDBACK_GITHUB_KEY_FILE: alias }));
    linkSync(filename, path.join(root, 'hardlink')); rejected();
  });
  it('rejects a symlink in a parent path', () => {
    const folder = path.join(root, 'private'); mkdirSync(folder, { mode: 0o700 });
    writeFileSync(path.join(folder, 'key'), pem, { mode: 0o600 });
    symlinkSync(folder, path.join(root, 'alias'));
    rejected(env({ TOWER_FEEDBACK_GITHUB_KEY_FILE: path.join(root, 'alias/key') }));
  });
  it.each(['', 'invalid PEM', 'x'.repeat(32769)])('rejects invalid/empty/oversized key material without exposing it', content => {
    writeFileSync(filename, content);
    try { githubConfig(env()); throw new Error('expected failure'); }
    catch (error) { expect((error as Error).message).toBe('feedback_github_not_configured'); }
  });
  it('rejects directories without trying to read them', () => rejected(env({ TOWER_FEEDBACK_GITHUB_KEY_FILE: root })));
});
