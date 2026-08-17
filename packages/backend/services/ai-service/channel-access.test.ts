import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/pg-repo.js', () => ({
  execute: vi.fn(),
  queryOne: vi.fn(),
}));

const { assertPublicSiteAccess, buildPublicAccessConfig, channelAccessFromConfig } = await import('./channel-access.js');

describe('AI Service Channel access mode', () => {
  it('defaults legacy channels to unlisted', () => {
    expect(channelAccessFromConfig(null)).toMatchObject({ mode: 'unlisted', hasPassword: false, ui: { showInfoPanel: true, showTools: true, showMaterials: true, showTiming: true } });
    expect(channelAccessFromConfig({})).toMatchObject({ mode: 'unlisted', hasPassword: false });
  });

  it('allows metadata to expose gate state without allowing serving', () => {
    expect(assertPublicSiteAccess({ config: { publicAccess: { mode: 'password' } }, allowMetadata: true })).toMatchObject({ mode: 'password' });
    expect(assertPublicSiteAccess({ config: { publicAccess: { mode: 'login_required' } }, allowMetadata: true })).toMatchObject({ mode: 'login_required' });
    expect(assertPublicSiteAccess({ config: { publicAccess: { mode: 'disabled' } }, allowMetadata: true })).toMatchObject({ mode: 'disabled' });
  });

  it('blocks serving for disabled and login-required public websites', () => {
    expect(() => assertPublicSiteAccess({ config: { publicAccess: { mode: 'disabled' } } })).toThrow('disabled');
    expect(() => assertPublicSiteAccess({ config: { publicAccess: { mode: 'login_required' } } })).toThrow('Login required');
  });

  it('stores password mode as salt and hash without preserving plaintext', () => {
    const config = buildPublicAccessConfig({ mode: 'password', password: 'secret-passphrase' });
    expect(config.mode).toBe('password');
    expect(config.passwordSalt).toEqual(expect.any(String));
    expect(config.passwordHash).toEqual(expect.any(String));
    expect(JSON.stringify(config)).not.toContain('secret-passphrase');
    expect(assertPublicSiteAccess({ config: { publicAccess: config }, password: 'secret-passphrase' })).toMatchObject({ mode: 'password', hasPassword: true });
    expect(() => assertPublicSiteAccess({ config: { publicAccess: config }, password: 'wrong' })).toThrow('password required');
  });

  it('keeps an existing password hash when password mode is saved without a new password', () => {
    const first = buildPublicAccessConfig({ mode: 'password', password: 'old-passphrase' });
    const next = buildPublicAccessConfig({ mode: 'password', existing: { publicAccess: first } });
    expect(next).toEqual(first);
  });

  it('preserves and updates public UI visibility flags', () => {
    const config = buildPublicAccessConfig({ mode: 'unlisted', ui: { showTools: false, showTiming: false } });
    expect(channelAccessFromConfig({ publicAccess: config })).toMatchObject({ ui: { showInfoPanel: true, showTools: false, showMaterials: true, showTiming: false } });
    const next = buildPublicAccessConfig({ mode: 'public', existing: { publicAccess: config }, ui: { showMaterials: false } });
    expect(channelAccessFromConfig({ publicAccess: next })).toMatchObject({ mode: 'public', ui: { showTools: false, showMaterials: false, showTiming: false } });
  });
});
