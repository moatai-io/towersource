import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(process.cwd(), 'scripts/deploy-verify.mjs'), 'utf8');

describe('deploy verification runtime credential source', () => {
  it('tries both PM2 and checkout runtime credentials during authority transitions', () => {
    expect(source).toContain('async function readPm2Runtime(target)');
    expect(source).toContain("execFileAsync('pm2', ['jlist'])");
    expect(source).toContain('proc?.pm2_env?.JWT_SECRET');
    expect(source).toContain('proc?.pm2_env?.DATABASE_URL');
    expect(source).toContain('async function waitForWsConnectedWithCandidates');
    expect(source).toContain("WebSocket closed before connected message");
    expect(source).toContain('const deadline = Date.now() + timeoutSec * 1000');
    expect(source).toContain('const pm2Runtime = await readPm2Runtime(args.target)');
    expect(source).toContain('const checkoutRuntime = await readCheckoutRuntime(args.projectRoot)');
    expect(source).toContain('waitForWsConnectedWithCandidates(args.baseUrl, tokens');
    expect(source).toContain('await waitForHealth(args.baseUrl, null');
  });

  it('mints verification JWTs for an active database user instead of hard-coding user 1', () => {
    expect(source).toContain('async function readRepresentativeUser(databaseUrls)');
    expect(source).toContain("COALESCE(disabled, 0) = 0");
    expect(source).toContain("COALESCE(approval_status, 'active') = 'active'");
    expect(source).toContain("role NOT IN ('admin', 'operator')");
    expect(source).toContain('userId: Number(user.id)');
    expect(source).toContain('username: user.username');
    expect(source).not.toContain("jwt.sign({ userId: 1");
  });
});
