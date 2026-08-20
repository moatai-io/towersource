import { describe, expect, it } from 'vitest';
import { getAllowedDevHosts, isAllowedDevHost } from './dev-hosts';

describe('dev host allowlist', () => {
  it('includes public-safe explicit defaults', () => {
    expect(getAllowedDevHosts()).toEqual(expect.arrayContaining(['app.localhost']));
  });

  it('extends defaults from VITE_TOWER_DEV_HOSTS-style CSV values', () => {
    expect(getAllowedDevHosts('internal-dev.example.com, local.example.test')).toEqual(
      expect.arrayContaining(['app.localhost', 'internal-dev.example.com', 'local.example.test']),
    );
  });

  it('allows all hosts in Vite dev mode and only configured hosts in built bundles', () => {
    expect(isAllowedDevHost('random.example.com', { dev: true })).toBe(true);
    expect(isAllowedDevHost('random.example.com', { dev: false })).toBe(false);
    expect(isAllowedDevHost('desk-dev.example.com', { dev: false })).toBe(true);
    expect(isAllowedDevHost('internal-dev.example.com', { dev: false, extraHosts: 'internal-dev.example.com' })).toBe(true);
  });
});
