/**
 * Owns: Workspace Apps definition validation. Public API: WorkspaceAppDefinitionSchema.
 * See README.md.
 */

import { z } from 'zod';

const idSchema = z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/);

export const WorkspaceAppMetricSchema = z.object({
  id: idSchema,
  label: z.string().min(1).max(120),
  value: z.string().min(1).max(120),
  delta: z.string().max(160).default(''),
  tone: z.enum(['primary', 'warn', 'success', 'neutral']).default('neutral'),
});

export const WorkspaceAppMenuItemSchema = z.object({
  id: idSchema,
  label: z.string().min(1).max(120),
  live: z.boolean().optional(),
});

export const WorkspaceAppTableColumnSchema = z.object({
  key: z.string().min(1).max(80).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  label: z.string().min(1).max(120),
  kind: z.enum(['text', 'status', 'money', 'date']).optional(),
});

export const WorkspaceAppQuerySchema = z.object({
  id: idSchema,
  label: z.string().min(1).max(160),
  sql: z.string().min(1).max(20_000),
  mode: z.enum(['read']).default('read'),
});

export const WorkspaceAppRecordSchema = z.object({
  id: idSchema,
  label: z.string().min(1).max(120),
  table: z.string().min(1).max(120).regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  primaryKey: z.string().min(1).max(80).regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default('id'),
});

export const WorkspaceAppFieldSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  label: z.string().min(1).max(120),
  type: z.enum(['text', 'status', 'money', 'date', 'number', 'select']).default('text'),
  required: z.boolean().default(false),
  options: z.array(z.string().min(1).max(80)).max(30).default([]),
  sourceColumn: z.string().min(1).max(80).regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
});

export const WorkspaceAppActionSchema = z.object({
  id: idSchema,
  label: z.string().min(1).max(120),
  type: z.enum(['create', 'update', 'change-status', 'export']),
  field: z.string().min(1).max(80).regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
});

export const WorkspaceAppTableViewSchema = z.object({
  id: idSchema,
  title: z.string().min(1).max(160),
  subtitle: z.string().max(240).default(''),
  statusLabel: z.string().max(80).default('Preview-ready'),
  queryId: idSchema.optional(),
  columns: z.array(WorkspaceAppTableColumnSchema).min(1).max(24),
  rows: z.array(z.record(z.string(), z.string())).max(200).default([]),
});

export const WorkspaceAppBuilderStepSchema = z.object({
  id: idSchema,
  label: z.string().min(1).max(160),
});

export const WorkspaceAppBuilderDraftChangeSchema = z.object({
  path: z.string().min(1).max(160),
  before: z.string().max(500).default(''),
  after: z.string().max(500).default(''),
  risk: z.enum(['low', 'medium', 'high']).default('low'),
});

export const WorkspaceAppBuilderDraftPreviewSchema = z.object({
  title: z.string().min(1).max(160),
  summary: z.string().max(500).default(''),
  changes: z.array(WorkspaceAppBuilderDraftChangeSchema).max(12).default([]),
});

export const WorkspaceAppDefinitionSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(120),
  eyebrow: z.string().max(160).default('Workspace Apps'),
  title: z.string().min(1).max(160),
  description: z.string().max(1000).default(''),
  primaryActionLabel: z.string().max(80).default('앱 수정 요청'),
  secondaryActionLabel: z.string().max(80).default('Definition 보기'),
  menuTitle: z.string().max(80).default('업무 메뉴'),
  source: z.object({
    provider: z.enum(['sqlite', 'neon', 'sample']).default('sample'),
    databasePath: z.string().max(240).optional(),
    connectionId: z.string().max(120).optional(),
    schema: z.string().max(80).default('public'),
  }).optional(),
  menu: z.array(WorkspaceAppMenuItemSchema).min(1).max(30),
  metrics: z.array(WorkspaceAppMetricSchema).max(12).default([]),
  record: WorkspaceAppRecordSchema.optional(),
  fields: z.array(WorkspaceAppFieldSchema).max(80).default([]),
  actions: z.array(WorkspaceAppActionSchema).max(20).default([]),
  queries: z.array(WorkspaceAppQuerySchema).max(30).default([]),
  tableView: WorkspaceAppTableViewSchema,
  builder: z.object({
    title: z.string().min(1).max(120).default('Admin builder'),
    description: z.string().max(500).default(''),
    steps: z.array(WorkspaceAppBuilderStepSchema).max(12).default([]),
    draftPreview: WorkspaceAppBuilderDraftPreviewSchema.optional(),
  }).default({ title: 'Admin builder', description: '', steps: [] }),
});

export type WorkspaceAppBuilderDraftChange = z.infer<typeof WorkspaceAppBuilderDraftChangeSchema>;
export type WorkspaceAppBuilderDraftPreview = z.infer<typeof WorkspaceAppBuilderDraftPreviewSchema>;

export type WorkspaceAppDefinition = z.infer<typeof WorkspaceAppDefinitionSchema> & {
  sourcePath?: string;
};
