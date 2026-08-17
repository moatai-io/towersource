import { describe, it, expect } from 'vitest';
import {
  normalizeBaseUrl,
  buildHealthUrl,
  buildWsUrl,
  extractJwtSecret,
  getPm2ProcessStatus,
  healthLooksOk,
} from '../scripts/deploy-verify-lib.mjs';

describe('deploy verify helpers', () => {
  it('normalizes base url and builds health url', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:32364/')).toBe('http://127.0.0.1:32364');
    expect(buildHealthUrl('http://127.0.0.1:32364/')).toBe('http://127.0.0.1:32364/api/health');
  });

  it('builds websocket url with encoded token', () => {
    const url = buildWsUrl('https://tower.tower.example.com/', 'a+b=c');
    expect(url).toBe('wss://tower.tower.example.com/ws?token=a%2Bb%3Dc');
  });

  it('extracts JWT secret from env text', () => {
    const env = 'FOO=1\nJWT_SECRET=super-secret\nBAR=2\n';
    expect(extractJwtSecret(env)).toBe('super-secret');
  });

  it('reads pm2 online status for a target process', () => {
    const pm2List = [
      { name: 'tower', pm2_env: { status: 'online' } },
      { name: 'tower-prod', pm2_env: { status: 'stopped' } },
    ];

    expect(getPm2ProcessStatus(pm2List, 'tower')).toBe('online');
    expect(getPm2ProcessStatus(pm2List, 'tower-prod')).toBe('stopped');
    expect(getPm2ProcessStatus(pm2List, 'missing')).toBeNull();
  });

  it('accepts only ok health payload', () => {
    expect(healthLooksOk({ status: 'ok' })).toBe(true);
    expect(healthLooksOk({ status: 'error' })).toBe(false);
    expect(healthLooksOk(null)).toBe(false);
  });
});
