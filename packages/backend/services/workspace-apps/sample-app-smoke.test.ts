import path from 'path';
import { describe, expect, it } from 'vitest';
import { loadWorkspaceAppDefinitions } from './app-definition-loader.js';
import { findWorkspaceAppReadQuery } from './query-policy.js';
import { runWorkspaceAppSqliteReadOnlyQuery } from './sqlite-connection.js';

describe('Workspace Apps checked-in sales-ops sample', () => {
  it('loads app.yaml and reads project-local SQLite rows', async () => {
    const projectRoot = path.resolve(process.cwd());
    const definition = loadWorkspaceAppDefinitions(projectRoot).find((app) => app.id === 'sales-ops');
    expect(definition).toEqual(expect.objectContaining({
      sourcePath: 'apps/sales-ops/app.yaml',
      source: expect.objectContaining({ provider: 'sqlite', databasePath: 'apps/sales-ops/data.sqlite' }),
      tableView: expect.objectContaining({ queryId: 'accounts' }),
    }));
    const query = findWorkspaceAppReadQuery(definition!, 'accounts');
    const result = await runWorkspaceAppSqliteReadOnlyQuery({
      projectRoot,
      databasePath: definition!.source!.databasePath!,
      sql: query.sql,
    });
    expect(result.rows.map((row) => row.name)).toEqual(['DemoOrg', 'Moat Builders', 'Northstar Labs', 'Studio Orbit']);
  });
});
