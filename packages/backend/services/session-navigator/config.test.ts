import { describe, expect, it } from 'vitest';
import { isJevSessionNavigatorEnabled, JEV_SESSION_NAVIGATOR_ENV } from './config.js';

describe('Jev Session Navigator research alpha gate', () => {
  it('is disabled by default on every VM role', () => {
    expect(isJevSessionNavigatorEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isJevSessionNavigatorEnabled({ TOWER_ROLE: 'full' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isJevSessionNavigatorEnabled({ TOWER_ROLE: 'managed' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isJevSessionNavigatorEnabled({ TOWER_ROLE: 'standalone' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('requires one exact explicit opt-in', () => {
    expect(JEV_SESSION_NAVIGATOR_ENV).toBe('TOWER_JEV_SESSION_NAVIGATOR_ENABLED');
    expect(isJevSessionNavigatorEnabled({ TOWER_JEV_SESSION_NAVIGATOR_ENABLED: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isJevSessionNavigatorEnabled({ TOWER_JEV_SESSION_NAVIGATOR_ENABLED: '1' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isJevSessionNavigatorEnabled({ TOWER_JEV_SESSION_NAVIGATOR_ENABLED: 'TRUE' } as NodeJS.ProcessEnv)).toBe(false);
  });
});
