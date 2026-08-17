export type WorkspaceMetricTone = 'primary' | 'warn' | 'success' | 'neutral';

export interface WorkspaceAppMetric {
  id: string;
  label: string;
  value: string;
  delta: string;
  tone: WorkspaceMetricTone;
}

export interface WorkspaceAppMenuItem {
  id: string;
  label: string;
  live?: boolean;
}

export interface WorkspaceAppTableColumn {
  key: string;
  label: string;
  kind?: 'text' | 'status' | 'money' | 'date';
}

export interface WorkspaceAppQuery {
  id: string;
  label: string;
  sql: string;
  mode: 'read';
}

export interface WorkspaceAppRecord {
  id: string;
  label: string;
  table?: string;
  primaryKey?: string;
}

export interface WorkspaceAppField {
  id: string;
  label: string;
  type: 'text' | 'status' | 'money' | 'date' | 'number' | 'select';
  required?: boolean;
  options?: string[];
  sourceColumn?: string;
}

export interface WorkspaceAppAction {
  id: string;
  label: string;
  type: 'create' | 'update' | 'change-status' | 'export';
  field?: string;
}

export interface WorkspaceAppTableView {
  id: string;
  title: string;
  subtitle: string;
  statusLabel: string;
  queryId?: string;
  columns: WorkspaceAppTableColumn[];
  rows: Array<Record<string, string>>;
}

export interface WorkspaceAppBuilderStep {
  id: string;
  label: string;
}

export interface WorkspaceAppBuilderDraftChange {
  path: string;
  before: string;
  after: string;
  risk: 'low' | 'medium' | 'high';
}

export interface WorkspaceAppBuilderDraftPreview {
  title: string;
  summary: string;
  changes: WorkspaceAppBuilderDraftChange[];
}

export interface WorkspaceAppDefinition {
  id: string;
  sourcePath?: string;
  name: string;
  eyebrow: string;
  title: string;
  description: string;
  primaryActionLabel: string;
  secondaryActionLabel: string;
  menuTitle: string;
  source?: {
    provider: 'sqlite' | 'neon' | 'sample';
    databasePath?: string;
    connectionId?: string;
    schema?: string;
  };
  menu: WorkspaceAppMenuItem[];
  metrics: WorkspaceAppMetric[];
  record?: WorkspaceAppRecord;
  fields?: WorkspaceAppField[];
  actions?: WorkspaceAppAction[];
  queries?: WorkspaceAppQuery[];
  tableView: WorkspaceAppTableView;
  builder: {
    title: string;
    description: string;
    steps: WorkspaceAppBuilderStep[];
    draftPreview?: WorkspaceAppBuilderDraftPreview;
  };
}
