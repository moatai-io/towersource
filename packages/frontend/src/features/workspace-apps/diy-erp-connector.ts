export type BusinessFieldKind = 'text' | 'select' | 'status' | 'money' | 'date' | 'relation' | 'boolean' | 'child-table';

export interface BusinessObjectSummary {
  id: string;
  label: string;
  backend: 'frappe';
  doctype: string;
  description: string;
  deskUrl?: string;
}

export interface BusinessFieldSchema {
  id: string;
  label: string;
  kind: BusinessFieldKind;
  required?: boolean;
  options?: string[];
  relationTo?: string;
  sourceFieldtype?: string;
}

export interface BusinessTransition {
  id: string;
  label: string;
  targetStatus?: string;
}

export interface BusinessObjectSchema {
  object: BusinessObjectSummary;
  fields: BusinessFieldSchema[];
  titleField: string;
  statusField?: string;
  transitions: BusinessTransition[];
}

export interface RecordQuery {
  search?: string;
  limit?: number;
}

export type RecordValues = Record<string, string | number | boolean | null>;

export interface RecordList {
  objectId: string;
  rows: Array<Record<string, string>>;
}

export interface RecordDetail {
  objectId: string;
  recordId: string;
  values: Record<string, string>;
  deskUrl?: string;
}

export interface ActionReceipt {
  id: string;
  objectId: string;
  action: 'create' | 'update' | 'transition';
  recordId: string;
  changedFields: string[];
  backend: 'frappe';
  status: 'applied';
  executedAt: string;
}

export interface ReportSummary {
  id: string;
  label: string;
  objectId?: string;
}

export interface ExportReceipt {
  id: string;
  objectId: string;
  format: 'csv' | 'xlsx' | 'pdf';
  status: 'ready';
  generatedAt: string;
}

export interface DiyErpConnector {
  listObjects(): Promise<BusinessObjectSummary[]>;
  describeObject(objectId: string): Promise<BusinessObjectSchema>;
  listRecords(objectId: string, query: RecordQuery): Promise<RecordList>;
  readRecord(objectId: string, recordId: string): Promise<RecordDetail>;
  createRecord(objectId: string, values: RecordValues): Promise<ActionReceipt>;
  updateRecord(objectId: string, recordId: string, values: RecordValues): Promise<ActionReceipt>;
  transitionRecord(objectId: string, recordId: string, transitionId: string): Promise<ActionReceipt>;
  listReports(objectId?: string): Promise<ReportSummary[]>;
  exportRecords(objectId: string, query: RecordQuery, format: 'csv' | 'xlsx' | 'pdf'): Promise<ExportReceipt>;
}

/**
 * Frappe fieldtype mapping used by the connector pilot:
 * - Data -> text
 * - Select -> select/status
 * - Currency -> money
 * - Date -> date
 * - Link -> relation
 * - Check -> boolean
 * - Table -> child-table placeholder
 */
export function mapFrappeFieldtype(fieldtype: string, options?: string): BusinessFieldKind {
  if (fieldtype === 'Data') return 'text';
  if (fieldtype === 'Select') return options?.includes('\n') ? 'status' : 'select';
  if (fieldtype === 'Currency') return 'money';
  if (fieldtype === 'Date') return 'date';
  if (fieldtype === 'Link') return 'relation';
  if (fieldtype === 'Check') return 'boolean';
  if (fieldtype === 'Table') return 'child-table';
  return 'text';
}
