import { describe, expect, it } from 'vitest';
import { findWorkspaceAppReadQuery, normalizeReadOnlySql } from './query-policy.js';
import type { WorkspaceAppDefinition } from './app-definition-schema.js';

const definition = {
  id: 'sales-ops',
  name: 'Sales Ops',
  title: '업무 앱',
  menu: [{ id: 'dashboard', label: '대시보드' }],
  metrics: [],
  queries: [
    { id: 'customers', label: 'Customers', sql: 'SELECT name, amount FROM customers ORDER BY name;', mode: 'read' as const },
  ],
  tableView: { id: 'main', title: 'Main', subtitle: '', statusLabel: '', columns: [{ key: 'name', label: 'Name' }], rows: [] },
  builder: { title: 'Admin builder', description: '', steps: [] },
} satisfies WorkspaceAppDefinition;

describe('Workspace Apps query policy', () => {
  it('allows one registered read-only SELECT query and strips a trailing semicolon', () => {
    expect(findWorkspaceAppReadQuery(definition, 'customers').sql).toBe('SELECT name, amount FROM customers ORDER BY name');
  });

  it('rejects multiple statements and write-like SQL', () => {
    expect(() => normalizeReadOnlySql('SELECT 1; SELECT 2')).toThrow('multiple SQL statements');
    expect(() => normalizeReadOnlySql('DELETE FROM customers')).toThrow('only SELECT/WITH read queries');
    expect(() => normalizeReadOnlySql('SELECT * FROM customers; DROP TABLE customers')).toThrow('multiple SQL statements');
    expect(() => normalizeReadOnlySql('WITH x AS (UPDATE customers SET name = name RETURNING *) SELECT * FROM x')).toThrow('forbidden SQL keyword');
  });
});
