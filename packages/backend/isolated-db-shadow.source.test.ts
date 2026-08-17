import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(process.cwd(), 'packages/backend/isolated-db-shadow.ts'), 'utf8');

function staticImports(): string[] {
  return [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

describe('isolated DB migration probe source boundary', () => {
  it('validates the pure contract before dynamically importing pg', () => {
    const guardIndex = source.indexOf('resolveIsolatedDbShadowConfig(env)');
    const pgIndex = source.indexOf("await import('pg')");
    expect(guardIndex).toBeGreaterThan(0);
    expect(pgIndex).toBeGreaterThan(guardIndex);
    expect(staticImports()).not.toContain('pg');
  });

  it('does not import or start Tower application authority', () => {
    for (const forbidden of [
      './index.js', './config.js', './db/pg.js', './routes/api.js', './routes/ws-handler.js', './engines/index.js',
    ]) expect(staticImports()).not.toContain(forbidden);
    for (const forbidden of [
      'listen(', 'setupWebSocket', 'startUnifiedScheduler', 'serverSideResumeInterrupted',
      'initWorkspaceRepo', 'seedDefaultProjects', 'ensureTowerChannel', 'initNotificationHub',
    ]) expect(source).not.toContain(forbidden);
  });

  it('requires marker-bound runtime DB identity before applying SQL', () => {
    const identityIndex = source.indexOf("current_setting('tower.shadow_marker'");
    const createLedgerIndex = source.indexOf('CREATE TABLE IF NOT EXISTS _migrations');
    expect(identityIndex).toBeGreaterThan(0);
    expect(createLedgerIndex).toBeGreaterThan(identityIndex);
    expect(source).toContain('row.database !== config.databaseName');
    expect(source).toContain('row.role !== config.databaseUser');
    expect(source).toContain('row.marker !== config.marker');
  });

  it('uses one transaction per migration and verifies the complete ledger', () => {
    expect(source).toContain("await client.query('BEGIN')");
    expect(source).toContain("await client.query('ROLLBACK')");
    expect(source).toContain("await client.query('COMMIT')");
    expect(source).toContain('Migration ledger is incomplete');
    expect(source).toContain("authority: 'migration-only'");
  });
});
