import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const frontendSrc = path.resolve(import.meta.dirname, '../..');
const backendRoot = path.resolve(import.meta.dirname, '../../../../backend');
const route = fs.readFileSync(path.join(backendRoot, 'routes/workspace-apps-api.ts'), 'utf8');
const policy = fs.readFileSync(path.join(backendRoot, 'services/workspace-apps/query-policy.ts'), 'utf8');
const neon = fs.readFileSync(path.join(backendRoot, 'services/workspace-apps/neon-connection.ts'), 'utf8');
const sqlite = fs.readFileSync(path.join(backendRoot, 'services/workspace-apps/sqlite-connection.ts'), 'utf8');
const schema = fs.readFileSync(path.join(backendRoot, 'services/workspace-apps/app-definition-schema.ts'), 'utf8');
const client = fs.readFileSync(path.join(frontendSrc, 'features/workspace-apps/workspace-app-api.ts'), 'utf8');
const home = fs.readFileSync(path.join(frontendSrc, 'features/workspace-apps/WorkspaceAppsHome.tsx'), 'utf8');

describe('Workspace Apps read-only query contract', () => {
  it('runs only registered read queries and keeps Neon behind Credential Vault project policy', () => {
    expect(route).toContain("router.post('/:appId/query'");
    expect(route).toContain('findWorkspaceAppReadQuery(definition, queryId)');
    expect(route).toContain('resolveProjectCredentialSecretValue');
    expect(route).toContain("provider: 'neon'");
    expect(route).toContain("targetType: 'workspace_apps_query'");
    expect(route).not.toContain('console.log(resolved.value)');
  });

  it('has fail-closed SQL, SQLite path guards, and transaction guards before touching live data', () => {
    expect(schema).toContain('WorkspaceAppQuerySchema');
    expect(schema).toContain("provider: z.enum(['sqlite', 'neon', 'sample']).default('sample')");
    expect(schema).toContain('databasePath: z.string().max(240).optional()');
    expect(schema).toContain("mode: z.enum(['read']).default('read')");
    expect(policy).toContain('FORBIDDEN_SQL_RE');
    expect(policy).toContain('multiple SQL statements are not allowed');
    expect(policy).toContain('only SELECT/WITH read queries are allowed');
    expect(route).toContain("definition.source?.provider === 'sqlite'");
    expect(route).toContain('runWorkspaceAppSqliteReadOnlyQuery');
    expect(sqlite).toContain('resolveWorkspaceAppSqliteDatabasePath');
    expect(sqlite).toContain("['-readonly', '-nofollow', '-json', dbPath, wrappedSql]");
    expect(sqlite).toContain('databasePath escapes the project root');
    expect(neon).toContain('BEGIN READ ONLY');
    expect(neon).toContain('default_transaction_read_only = on');
    expect(neon).toContain('statement_timeout');
    expect(neon).toContain('LIMIT ${rowLimit}');
  });

  it('lets the frontend request live rows while preserving fallback rows', () => {
    expect(client).toContain('fetchWorkspaceAppQueryRows');
    expect(client).toContain("/api/workspace-apps/${encodeURIComponent(input.appId)}/query");
    expect(home).toContain('fetchWorkspaceAppQueryRows({ projectId, appId: definition.id, queryId: definition.tableView.queryId })');
    expect(home).toContain('setLiveRows(result?.rows?.length ? result.rows : null)');
    expect(home).toContain('const baseRows = liveRows ? liveRows : visibleDefinition.tableView.rows');
    expect(home).toContain('const filteredRows = normalizedSearch');
    expect(home).toContain('if (menuHasLiveTable) return { ...visibleDefinition.tableView, rows: filteredRows }');
  });
});
