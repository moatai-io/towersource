/**
 * Owns: metadata-validated Workspace Apps write actions for project-local SQLite. Public API: executeWorkspaceAppAction().
 * See README.md.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import { z } from 'zod';
import type { WorkspaceAppDefinition } from './app-definition-schema.js';
import { resolveWorkspaceAppSqliteDatabasePath } from './sqlite-connection.js';

const execFileAsync = promisify(execFile);
const ACTION_RECEIPTS_DIR = '.workspace-apps/actions';
const MAX_ACTION_RECEIPT_BYTES = 128 * 1024;

export const WorkspaceAppActionPayloadSchema = z.object({
  values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  recordId: z.union([z.string(), z.number()]).optional(),
});

export type WorkspaceAppActionPayload = z.infer<typeof WorkspaceAppActionPayloadSchema>;

export const WorkspaceAppActionReceiptSchema = z.object({
  id: z.string().uuid(),
  appId: z.string().min(1).max(80),
  actionId: z.string().min(1).max(80),
  actionType: z.enum(['create', 'update', 'change-status', 'export']),
  projectId: z.string().min(1).max(120),
  actorUserId: z.number().int().positive(),
  provider: z.literal('sqlite'),
  table: z.string().min(1).max(120),
  recordId: z.string().max(120).optional(),
  changedFields: z.array(z.string().min(1).max(80)).max(80),
  executedAt: z.string().datetime(),
  status: z.literal('applied'),
});

export type WorkspaceAppActionReceipt = z.infer<typeof WorkspaceAppActionReceiptSchema>;

function assertIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`invalid workspace app ${label}`);
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${assertIdentifier(value, 'identifier').replaceAll('"', '""')}"`;
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function ensureInsideProject(projectRoot: string, targetPath: string): string {
  const rootReal = fs.realpathSync(projectRoot);
  const resolved = path.resolve(rootReal, targetPath);
  const parent = path.dirname(resolved);
  fs.mkdirSync(parent, { recursive: true });
  const parentReal = fs.realpathSync(parent);
  if (!(parentReal === rootReal || parentReal.startsWith(rootReal + path.sep))) {
    throw new Error('workspace app action receipt path escapes project root');
  }
  return resolved;
}

function actionReceiptPath(projectRoot: string, appId: string, receiptId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(appId)) throw new Error('invalid workspace app id');
  return ensureInsideProject(projectRoot, path.join(ACTION_RECEIPTS_DIR, appId, `${receiptId}.json`));
}

function normalizeValue(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function validateFieldValue(input: {
  field: NonNullable<WorkspaceAppDefinition['fields']>[number];
  rawValue: string | number | boolean | null | undefined;
}): string {
  const value = normalizeValue(input.rawValue);
  if (input.field.required && value.trim() === '') throw new Error(`${input.field.label} is required`);
  if ((input.field.type === 'status' || input.field.type === 'select') && input.field.options?.length && value) {
    if (!input.field.options.includes(value)) throw new Error(`${input.field.label} has an unsupported option`);
  }
  if (input.field.type === 'number' && value && Number.isNaN(Number(value))) throw new Error(`${input.field.label} must be a number`);
  return value;
}

function fieldColumn(field: NonNullable<WorkspaceAppDefinition['fields']>[number]): string {
  return assertIdentifier(field.sourceColumn ?? field.id, 'field column');
}

function buildFieldMap(definition: WorkspaceAppDefinition): Map<string, NonNullable<WorkspaceAppDefinition['fields']>[number]> {
  return new Map((definition.fields ?? []).map((field) => [field.id, field]));
}

function actionById(definition: WorkspaceAppDefinition, actionId: string) {
  const action = (definition.actions ?? []).find((candidate) => candidate.id === actionId);
  if (!action) throw new Error('workspace app action is not registered');
  return action;
}

function assertSqliteDefinition(definition: WorkspaceAppDefinition): { table: string; primaryKey: string; databasePath: string } {
  if (definition.source?.provider !== 'sqlite') throw new Error('workspace app action only supports SQLite in this beta');
  if (!definition.source.databasePath) throw new Error('workspace app has no SQLite databasePath configured');
  if (!definition.record?.table) throw new Error('workspace app record table is not configured');
  return {
    table: assertIdentifier(definition.record.table, 'record table'),
    primaryKey: assertIdentifier(definition.record.primaryKey ?? 'id', 'record primary key'),
    databasePath: definition.source.databasePath,
  };
}

function buildWriteSql(input: {
  definition: WorkspaceAppDefinition;
  actionId: string;
  payload: WorkspaceAppActionPayload;
}): { sql: string; action: NonNullable<WorkspaceAppDefinition['actions']>[number]; recordId?: string; changedFields: string[]; table: string } {
  const action = actionById(input.definition, input.actionId);
  if (action.type === 'export') throw new Error('workspace app export action is handled on the frontend for now');
  const { table, primaryKey } = assertSqliteDefinition(input.definition);
  const fields = buildFieldMap(input.definition);
  if (!fields.size) throw new Error('workspace app fields are not configured');

  const values = input.payload.values ?? {};
  const allowedEntries = Object.entries(values)
    .map(([fieldId, rawValue]) => {
      const field = fields.get(fieldId);
      if (!field) throw new Error(`workspace app field is not registered: ${fieldId}`);
      return { field, value: validateFieldValue({ field, rawValue }) };
    })
    .filter(({ field }) => field.id !== primaryKey && fieldColumn(field) !== primaryKey);

  if (action.type === 'change-status') {
    const statusField = action.field ? fields.get(action.field) : (input.definition.fields ?? []).find((field) => field.type === 'status' || field.type === 'select');
    if (!statusField) throw new Error('workspace app status field is not configured');
    const rawValue = values[statusField.id];
    const value = validateFieldValue({ field: statusField, rawValue });
    const recordId = input.payload.recordId === undefined ? '' : String(input.payload.recordId);
    if (!recordId) throw new Error('workspace app recordId is required');
    const sql = `UPDATE ${quoteIdentifier(table)} SET ${quoteIdentifier(fieldColumn(statusField))} = ${sqlLiteral(value)} WHERE ${quoteIdentifier(primaryKey)} = ${sqlLiteral(recordId)};`;
    return { sql, action, recordId, changedFields: [statusField.id], table };
  }

  if (action.type === 'create') {
    const requiredMissing = (input.definition.fields ?? []).filter((field) => field.required && !Object.prototype.hasOwnProperty.call(values, field.id));
    if (requiredMissing.length) throw new Error(`${requiredMissing[0].label} is required`);
    if (!allowedEntries.length) throw new Error('workspace app create action has no values');
    const columns = allowedEntries.map(({ field }) => quoteIdentifier(fieldColumn(field))).join(', ');
    const literals = allowedEntries.map(({ value }) => sqlLiteral(value)).join(', ');
    const sql = `INSERT INTO ${quoteIdentifier(table)} (${columns}) VALUES (${literals});`;
    return { sql, action, changedFields: allowedEntries.map(({ field }) => field.id), table };
  }

  if (action.type === 'update') {
    const recordId = input.payload.recordId === undefined ? '' : String(input.payload.recordId);
    if (!recordId) throw new Error('workspace app recordId is required');
    if (!allowedEntries.length) throw new Error('workspace app update action has no values');
    const assignments = allowedEntries.map(({ field, value }) => `${quoteIdentifier(fieldColumn(field))} = ${sqlLiteral(value)}`).join(', ');
    const sql = `UPDATE ${quoteIdentifier(table)} SET ${assignments} WHERE ${quoteIdentifier(primaryKey)} = ${sqlLiteral(recordId)};`;
    return { sql, action, recordId, changedFields: allowedEntries.map(({ field }) => field.id), table };
  }

  throw new Error('unsupported workspace app action type');
}

function saveActionReceipt(input: {
  projectRoot: string;
  projectId: string;
  definition: WorkspaceAppDefinition;
  actionId: string;
  actionType: WorkspaceAppActionReceipt['actionType'];
  actorUserId: number;
  table: string;
  recordId?: string;
  changedFields: string[];
  now?: Date;
}): WorkspaceAppActionReceipt {
  const receipt = WorkspaceAppActionReceiptSchema.parse({
    id: randomUUID(),
    appId: input.definition.id,
    actionId: input.actionId,
    actionType: input.actionType,
    projectId: input.projectId,
    actorUserId: input.actorUserId,
    provider: 'sqlite',
    table: input.table,
    recordId: input.recordId,
    changedFields: input.changedFields,
    executedAt: (input.now ?? new Date()).toISOString(),
    status: 'applied',
  });
  const payload = `${JSON.stringify(receipt, null, 2)}\n`;
  if (Buffer.byteLength(payload, 'utf8') > MAX_ACTION_RECEIPT_BYTES) throw new Error('workspace app action receipt is too large');
  fs.writeFileSync(actionReceiptPath(input.projectRoot, input.definition.id, receipt.id), payload, { encoding: 'utf8', flag: 'wx', mode: 0o640 });
  return receipt;
}

export async function executeWorkspaceAppAction(input: {
  projectRoot: string;
  projectId: string;
  definition: WorkspaceAppDefinition;
  actionId: string;
  actorUserId: number;
  payload: WorkspaceAppActionPayload;
  statementTimeoutMs?: number;
  now?: Date;
}): Promise<WorkspaceAppActionReceipt> {
  const parsedPayload = WorkspaceAppActionPayloadSchema.parse(input.payload);
  const { databasePath } = assertSqliteDefinition(input.definition);
  const dbPath = resolveWorkspaceAppSqliteDatabasePath({ projectRoot: input.projectRoot, databasePath });
  const { sql, action, recordId, changedFields, table } = buildWriteSql({ definition: input.definition, actionId: input.actionId, payload: parsedPayload });
  const statementTimeoutMs = Math.max(250, Math.min(input.statementTimeoutMs ?? 5_000, 15_000));
  await execFileAsync('sqlite3', ['-nofollow', dbPath, `BEGIN IMMEDIATE; ${sql} COMMIT;`], {
    timeout: statementTimeoutMs,
    maxBuffer: 512 * 1024,
  });
  return saveActionReceipt({
    projectRoot: input.projectRoot,
    projectId: input.projectId,
    definition: input.definition,
    actionId: action.id,
    actionType: action.type,
    actorUserId: input.actorUserId,
    table,
    recordId,
    changedFields,
    now: input.now,
  });
}
