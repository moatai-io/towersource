/**
 * credential-health.test.ts — Owns: tests for readCredentialHealth.
 *
 * Uses real fs (tmpdir) — no mocking. Each test seeds a fresh .credentials.json
 * in a unique tmpdir and asserts the parsed status. Clock is injected via opts.now
 * for deterministic threshold tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { readCredentialHealth } from './credential-health.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-05-26T00:00:00Z');

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cred-health-test-'));
}

async function writeCreds(dir: string, content: unknown | string): Promise<void> {
  await fs.writeFile(
    path.join(dir, '.credentials.json'),
    typeof content === 'string' ? content : JSON.stringify(content),
    'utf8'
  );
}

describe('readCredentialHealth', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await makeTmpDir(); });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  describe('file-level failures', () => {
    it('returns "missing" when credentials.json does not exist', async () => {
      const result = await readCredentialHealth(tmpDir, { now: NOW });
      expect(result.status).toBe('missing');
      expect(result.reason).toContain('not found');
      expect(result.expiresAt).toBeNull();
      expect(result.daysUntilExpiry).toBeNull();
      expect(result.configDir).toBe(tmpDir);
    });

    it('returns "malformed" for invalid JSON', async () => {
      await writeCreds(tmpDir, '{not valid json');
      const result = await readCredentialHealth(tmpDir, { now: NOW });
      expect(result.status).toBe('malformed');
      expect(result.reason).toContain('invalid JSON');
    });

    it('returns "malformed" when claudeAiOauth is missing', async () => {
      await writeCreds(tmpDir, { otherField: 'x' });
      const result = await readCredentialHealth(tmpDir, { now: NOW });
      expect(result.status).toBe('malformed');
      expect(result.reason).toContain('claudeAiOauth');
    });

    it('returns "malformed" when expiresAt is missing', async () => {
      await writeCreds(tmpDir, { claudeAiOauth: { accessToken: 'x', refreshToken: 'y' } });
      const result = await readCredentialHealth(tmpDir, { now: NOW });
      expect(result.status).toBe('malformed');
      expect(result.reason).toContain('expiresAt');
    });

    it('returns "malformed" when expiresAt is a string (not number)', async () => {
      await writeCreds(tmpDir, {
        claudeAiOauth: { accessToken: 'x', refreshToken: 'y', expiresAt: '1779701318534' },
      });
      const result = await readCredentialHealth(tmpDir, { now: NOW });
      expect(result.status).toBe('malformed');
    });
  });

  describe('status classification', () => {
    it('returns "critical" when token is expired (days ago)', async () => {
      await writeCreds(tmpDir, {
        claudeAiOauth: {
          accessToken: 'a',
          refreshToken: 'r',
          expiresAt: NOW.getTime() - 3 * MS_PER_DAY,
          subscriptionType: 'max',
          rateLimitTier: 'default_claude_max_5x',
        },
      });
      const result = await readCredentialHealth(tmpDir, { now: NOW });
      expect(result.status).toBe('critical');
      expect(result.reason).toMatch(/expired 3 days ago/);
      expect(result.subscriptionType).toBe('max');
      expect(result.rateLimitTier).toBe('default_claude_max_5x');
      expect(result.daysUntilExpiry).toBeCloseTo(-3, 1);
    });

    it('returns "critical" with hours format when just expired (< 1d ago)', async () => {
      await writeCreds(tmpDir, {
        claudeAiOauth: {
          accessToken: 'a',
          refreshToken: 'r',
          expiresAt: NOW.getTime() - 30 * 60 * 1000, // 30 min ago
        },
      });
      const result = await readCredentialHealth(tmpDir, { now: NOW });
      expect(result.status).toBe('critical');
      expect(result.reason).toMatch(/h ago/);
    });

    it('returns "warning" when expiring within 7 days', async () => {
      await writeCreds(tmpDir, {
        claudeAiOauth: {
          accessToken: 'a',
          refreshToken: 'r',
          expiresAt: NOW.getTime() + 3 * MS_PER_DAY,
        },
      });
      const result = await readCredentialHealth(tmpDir, { now: NOW });
      expect(result.status).toBe('warning');
      expect(result.reason).toMatch(/expiring in 3d/);
      expect(result.daysUntilExpiry).toBeCloseTo(3, 1);
    });

    it('returns "warning" when refreshToken is empty string (pre-2026 v1)', async () => {
      await writeCreds(tmpDir, {
        claudeAiOauth: {
          accessToken: 'a',
          refreshToken: '', // v1 token, no refresh
          expiresAt: NOW.getTime() + 30 * MS_PER_DAY,
          subscriptionType: 'max',
        },
      });
      const result = await readCredentialHealth(tmpDir, { now: NOW });
      expect(result.status).toBe('warning');
      expect(result.reason).toContain('no refresh token');
      expect(result.hasRefreshToken).toBe(false);
    });

    it('returns "warning" when refreshToken is undefined', async () => {
      await writeCreds(tmpDir, {
        claudeAiOauth: {
          accessToken: 'a',
          // no refreshToken
          expiresAt: NOW.getTime() + 30 * MS_PER_DAY,
        },
      });
      const result = await readCredentialHealth(tmpDir, { now: NOW });
      expect(result.status).toBe('warning');
      expect(result.hasRefreshToken).toBe(false);
    });

    it('returns "healthy" when token is fresh with refresh', async () => {
      await writeCreds(tmpDir, {
        claudeAiOauth: {
          accessToken: 'a',
          refreshToken: 'r',
          expiresAt: NOW.getTime() + 60 * MS_PER_DAY,
          subscriptionType: 'max',
          rateLimitTier: 'default_claude_max_20x',
        },
      });
      const result = await readCredentialHealth(tmpDir, { now: NOW });
      expect(result.status).toBe('healthy');
      expect(result.hasRefreshToken).toBe(true);
      expect(result.daysUntilExpiry).toBeCloseTo(60, 0);
      expect(result.reason).toContain('default_claude_max_20x');
      expect(result.reason).toContain('60d');
    });

    it('boundary: exactly 7 days from now → warning (< threshold)', async () => {
      await writeCreds(tmpDir, {
        claudeAiOauth: {
          accessToken: 'a',
          refreshToken: 'r',
          // 6.9 days (just under 7d threshold) — should be warning
          expiresAt: NOW.getTime() + 6.9 * MS_PER_DAY,
        },
      });
      const result = await readCredentialHealth(tmpDir, { now: NOW });
      expect(result.status).toBe('warning');
    });

    it('boundary: 7.1 days from now → healthy', async () => {
      await writeCreds(tmpDir, {
        claudeAiOauth: {
          accessToken: 'a',
          refreshToken: 'r',
          expiresAt: NOW.getTime() + 7.1 * MS_PER_DAY,
        },
      });
      const result = await readCredentialHealth(tmpDir, { now: NOW });
      expect(result.status).toBe('healthy');
    });
  });

  describe('returned metadata', () => {
    it('always echoes configDir', async () => {
      const result = await readCredentialHealth('/nonexistent/path/that/does-not-exist', { now: NOW });
      expect(result.configDir).toBe('/nonexistent/path/that/does-not-exist');
    });

    it('lastUsedAt is always null in PR-1 (reserved for PR-3)', async () => {
      await writeCreds(tmpDir, {
        claudeAiOauth: {
          accessToken: 'a', refreshToken: 'r',
          expiresAt: NOW.getTime() + 60 * MS_PER_DAY,
        },
      });
      const result = await readCredentialHealth(tmpDir, { now: NOW });
      expect(result.lastUsedAt).toBeNull();
    });

    it('uses real Date.now() when opts.now is omitted', async () => {
      await writeCreds(tmpDir, {
        claudeAiOauth: {
          accessToken: 'a', refreshToken: 'r',
          expiresAt: Date.now() + 100 * MS_PER_DAY,
        },
      });
      const result = await readCredentialHealth(tmpDir);
      expect(result.status).toBe('healthy');
      expect(result.daysUntilExpiry).toBeGreaterThan(99);
      expect(result.daysUntilExpiry).toBeLessThanOrEqual(100);
    });
  });
});
