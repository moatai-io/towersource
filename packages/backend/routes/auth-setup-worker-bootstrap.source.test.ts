import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const api = fs.readFileSync(path.resolve(import.meta.dirname, './api.ts'), 'utf8');
const bootstrap = fs.readFileSync(path.resolve(import.meta.dirname, '../../../scripts/oss/bootstrap-local-worker.sh'), 'utf8');

describe('first administrator OSS Worker bootstrap trigger', () => {
  it('limits the trigger to standalone Agent-first installations', () => {
    expect(api).toContain("process.env.TOWER_ROLE !== 'standalone'");
    expect(api).toContain("process.env.TOWER_AGENT_FIRST_ENABLED !== 'true'");
  });

  it('writes a data-directory request after the first administrator is persisted', () => {
    const createIndex = api.indexOf("await createUser(username, password, 'admin'");
    const requestIndex = api.indexOf('await requestOssWorkerBootstrapAfterFirstAdmin()', createIndex);
    expect(requestIndex).toBeGreaterThan(createIndex);
    expect(api).toContain("path.join(dataDir, 'workers', 'bootstrap.request')");
    expect(api).toContain("await fs.promises.writeFile(requestPath, `${new Date().toISOString()}\\n`, { mode: 0o600 })");
  });

  it('does not block administrator creation if signaling fails', () => {
    expect(api).toContain("console.warn('[auth] Failed to request OSS local Worker bootstrap after first admin creation'");
    expect(api.indexOf('const token = generateToken', api.indexOf('requestOssWorkerBootstrapAfterFirstAdmin'))).toBeGreaterThan(-1);
  });

  it('clears the request and stops fallback retries when activation is complete', () => {
    expect(bootstrap).toContain('rm -f "$REQUEST_FILE"');
    expect(bootstrap).toContain('systemctl stop tower-oss-worker-bootstrap.timer');
    expect(bootstrap).toMatch(/if \[\[ -f "\$STATE_FILE" \]\];[\s\S]*rm -f "\$REQUEST_FILE"[\s\S]*systemctl stop tower-oss-worker-bootstrap.timer[\s\S]*exit 0/);
  });
});
