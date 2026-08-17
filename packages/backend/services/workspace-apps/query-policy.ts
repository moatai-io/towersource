/**
 * Owns: fail-closed policy for Workspace Apps SQL snippets. Public API: assertWorkspaceAppReadQueryAllowed().
 * See README.md.
 */

import type { WorkspaceAppDefinition } from './app-definition-schema.js';

const FORBIDDEN_SQL_RE = /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|copy|call|do|vacuum|analyze|refresh|listen|notify|execute|prepare|deallocate|set|reset)\b/i;

export function normalizeReadOnlySql(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, '').trim();
  if (!trimmed) throw new Error('query sql is empty');
  if (trimmed.includes(';')) throw new Error('multiple SQL statements are not allowed');
  if (!/^select\b/i.test(trimmed) && !/^with\b/i.test(trimmed)) throw new Error('only SELECT/WITH read queries are allowed');
  if (FORBIDDEN_SQL_RE.test(trimmed)) throw new Error('query contains a forbidden SQL keyword');
  return trimmed;
}

export function findWorkspaceAppReadQuery(definition: WorkspaceAppDefinition, queryId: string): { id: string; label: string; sql: string; mode: 'read' } {
  const query = (definition.queries || []).find((candidate) => candidate.id === queryId);
  if (!query) throw new Error('query not found in workspace app definition');
  if (query.mode !== 'read') throw new Error('only read queries are supported');
  return { ...query, sql: normalizeReadOnlySql(query.sql) };
}

export function assertWorkspaceAppReadQueryAllowed(definition: WorkspaceAppDefinition, queryId: string): void {
  findWorkspaceAppReadQuery(definition, queryId);
}
