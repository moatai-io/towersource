/**
 * Owns: Frappe read connector helpers for DIY ERP Connector pilot. Public API: field mapping, URL helpers, and read adapter functions.
 * See README.md.
 */

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

interface FrappeDocTypeListItem {
  name?: string;
  module?: string;
  description?: string;
  istable?: 0 | 1 | boolean;
  issingle?: 0 | 1 | boolean;
}

export interface FrappeConnectionInput {
  siteUrl: string;
  /** Browser-facing Frappe Desk base URL. Defaults to siteUrl when omitted. */
  deskUrlBase?: string;
  apiKey?: string;
  apiSecret?: string;
  fetchImpl?: typeof fetch;
}

export interface FrappeConnectionReadiness {
  ready: boolean;
  provider: 'frappe';
  siteHost: string;
  deskHost?: string;
  hasApiKey: boolean;
  hasApiSecret: boolean;
}

export function summarizeFrappeConnectionReadiness(input: FrappeConnectionInput): FrappeConnectionReadiness {
  const normalized = normalizeFrappeSiteUrl(input.siteUrl);
  const siteHost = new URL(normalized).host;
  const deskHost = input.deskUrlBase ? new URL(normalizeFrappeDeskUrlBase(input.deskUrlBase)).host : undefined;
  return {
    ready: Boolean(input.apiKey && input.apiSecret),
    provider: 'frappe',
    siteHost,
    ...(deskHost ? { deskHost } : {}),
    hasApiKey: Boolean(input.apiKey),
    hasApiSecret: Boolean(input.apiSecret),
  };
}

export function parseFrappeCredentialValue(value: string): FrappeConnectionInput {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Frappe credential is empty');
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const siteUrl = typeof parsed.siteUrl === 'string' ? parsed.siteUrl : typeof parsed.FRAPPE_SITE_URL === 'string' ? parsed.FRAPPE_SITE_URL : '';
    const deskUrlBase = typeof parsed.deskUrlBase === 'string' ? parsed.deskUrlBase : typeof parsed.FRAPPE_DESK_URL_BASE === 'string' ? parsed.FRAPPE_DESK_URL_BASE : undefined;
    const apiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey : typeof parsed.FRAPPE_API_KEY === 'string' ? parsed.FRAPPE_API_KEY : undefined;
    const apiSecret = typeof parsed.apiSecret === 'string' ? parsed.apiSecret : typeof parsed.FRAPPE_API_SECRET === 'string' ? parsed.FRAPPE_API_SECRET : undefined;
    return { siteUrl: normalizeFrappeSiteUrl(siteUrl), deskUrlBase: deskUrlBase ? normalizeFrappeDeskUrlBase(deskUrlBase) : undefined, apiKey, apiSecret };
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error('Frappe credential must be a JSON object with siteUrl/apiKey/apiSecret');
    }
    throw err;
  }
}

interface FrappeFieldMeta {
  fieldname?: string;
  label?: string;
  fieldtype?: string;
  reqd?: 0 | 1 | boolean;
  options?: string;
  hidden?: 0 | 1 | boolean;
}

interface FrappeDocTypeMeta {
  name?: string;
  doctype?: string;
  fields?: FrappeFieldMeta[];
  title_field?: string;
}

export function mapFrappeFieldtype(fieldtype: string | undefined, options?: string): BusinessFieldKind {
  if (fieldtype === 'Data' || fieldtype === 'Small Text' || fieldtype === 'Text' || fieldtype === 'Long Text') return 'text';
  if (fieldtype === 'Select') return options?.includes('\n') ? 'status' : 'select';
  if (fieldtype === 'Currency' || fieldtype === 'Float' || fieldtype === 'Int') return fieldtype === 'Currency' ? 'money' : 'text';
  if (fieldtype === 'Date' || fieldtype === 'Datetime') return 'date';
  if (fieldtype === 'Link' || fieldtype === 'Dynamic Link') return 'relation';
  if (fieldtype === 'Check') return 'boolean';
  if (fieldtype === 'Table' || fieldtype === 'Table MultiSelect') return 'child-table';
  return 'text';
}

export function normalizeFrappeSiteUrl(siteUrl: string): string {
  const trimmed = siteUrl.trim();
  if (!trimmed) throw new Error('Frappe site URL is required');
  const url = new URL(trimmed);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('Frappe site URL must use https outside localhost');
  }
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

export function normalizeFrappeDeskUrlBase(deskUrlBase: string): string {
  const trimmed = deskUrlBase.trim();
  if (!trimmed) throw new Error('Frappe Desk URL base is required');
  const url = new URL(trimmed);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Frappe Desk URL base must use http or https');
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

export function buildFrappeDeskUrl(siteUrl: string, doctype: string, recordId?: string, deskUrlBase?: string): string {
  const base = deskUrlBase ? normalizeFrappeDeskUrlBase(deskUrlBase) : normalizeFrappeSiteUrl(siteUrl);
  const slug = doctype.toLowerCase().replace(/\s+/g, '-');
  return recordId ? `${base}/app/${encodeURIComponent(slug)}/${encodeURIComponent(recordId)}` : `${base}/app/${encodeURIComponent(slug)}`;
}

function authHeaders(input: FrappeConnectionInput): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (input.apiKey && input.apiSecret) headers.Authorization = `token ${input.apiKey}:${input.apiSecret}`;
  return headers;
}

async function frappeJson<T>(input: FrappeConnectionInput, path: string, params?: Record<string, string>): Promise<T> {
  const base = normalizeFrappeSiteUrl(input.siteUrl);
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
  const res = await (input.fetchImpl ?? fetch)(url.toString(), { headers: authHeaders(input) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any)?.exception || (data as any)?.message || `Frappe request failed: ${res.status}`);
  return data as T;
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function fieldOptions(field: FrappeFieldMeta): string[] | undefined {
  if (!field.options || field.fieldtype !== 'Select') return undefined;
  return field.options.split('\n').map((option) => option.trim()).filter(Boolean);
}

function frappeObjectIdFromDoctype(doctype: string): string {
  return doctype.toLowerCase().replace(/\s+/g, '-');
}

export async function listFrappeDocTypes(input: FrappeConnectionInput & {
  query?: RecordQuery;
}): Promise<BusinessObjectSummary[]> {
  const fields = ['name', 'module', 'description', 'istable', 'issingle'];
  const data = await frappeJson<{ data?: FrappeDocTypeListItem[] }>(input, '/api/resource/DocType', {
    fields: JSON.stringify(fields),
    filters: JSON.stringify([['DocType', 'istable', '=', 0], ['DocType', 'issingle', '=', 0]]),
    order_by: 'modified desc',
    limit_page_length: String(Math.max(1, Math.min(input.query?.limit ?? 80, 200))),
  });
  const normalized = input.query?.search?.trim().toLowerCase() ?? '';
  return (data.data ?? [])
    .filter((item) => item.name && !item.istable && !item.issingle)
    .filter((item) => !normalized || [item.name, item.module, item.description].some((value) => String(value ?? '').toLowerCase().includes(normalized)))
    .map((item) => ({
      id: frappeObjectIdFromDoctype(item.name!),
      label: item.name!,
      backend: 'frappe' as const,
      doctype: item.name!,
      description: item.description || (item.module ? `${item.module} module DocType` : 'Frappe DocType'),
      deskUrl: buildFrappeDeskUrl(input.siteUrl, item.name!, undefined, input.deskUrlBase),
    }));
}

export function mapFrappeDocTypeMeta(input: {
  siteUrl: string;
  deskUrlBase?: string;
  doctype: string;
  meta: FrappeDocTypeMeta;
}): BusinessObjectSchema {
  const fields = (input.meta.fields ?? [])
    .filter((field) => field.fieldname && !field.hidden)
    .map((field): BusinessFieldSchema => ({
      id: field.fieldname!,
      label: field.label || field.fieldname!,
      kind: mapFrappeFieldtype(field.fieldtype, field.options),
      required: field.reqd === true || field.reqd === 1,
      options: fieldOptions(field),
      relationTo: field.fieldtype === 'Link' ? field.options : undefined,
      sourceFieldtype: field.fieldtype,
    }));
  const titleField = input.meta.title_field || fields.find((field) => field.kind === 'text')?.id || 'name';
  const statusField = fields.find((field) => field.id === 'status')?.id;
  return {
    object: {
      id: frappeObjectIdFromDoctype(input.doctype),
      label: input.meta.name || input.doctype,
      backend: 'frappe',
      doctype: input.doctype,
      description: `${input.doctype} DocType from Frappe`,
      deskUrl: buildFrappeDeskUrl(input.siteUrl, input.doctype, undefined, input.deskUrlBase),
    },
    fields,
    titleField,
    statusField,
    transitions: [],
  };
}

export async function describeFrappeDocType(input: FrappeConnectionInput & { doctype: string }): Promise<BusinessObjectSchema> {
  const data = await frappeJson<{ docs?: FrappeDocTypeMeta[]; message?: FrappeDocTypeMeta }>(
    input,
    '/api/method/frappe.desk.form.load.getdoctype',
    { doctype: input.doctype },
  );
  const meta = data.docs?.find((doc) => doc.name === input.doctype || doc.doctype === 'DocType') ?? data.message;
  if (!meta) throw new Error('Frappe DocType metadata not found');
  return mapFrappeDocTypeMeta({ siteUrl: input.siteUrl, deskUrlBase: input.deskUrlBase, doctype: input.doctype, meta });
}

export async function listFrappeRecords(input: FrappeConnectionInput & {
  objectId: string;
  doctype: string;
  fields: string[];
  query?: RecordQuery;
}): Promise<RecordList> {
  const fields = Array.from(new Set(['name', ...input.fields])).slice(0, 20);
  const data = await frappeJson<{ data?: Array<Record<string, unknown>> }>(input, `/api/resource/${encodeURIComponent(input.doctype)}`, {
    fields: JSON.stringify(fields),
    limit_page_length: String(Math.max(1, Math.min(input.query?.limit ?? 100, 200))),
  });
  const rows = (data.data ?? []).map((row) => Object.fromEntries(fields.map((field) => [field, stringifyCell(row[field])])));
  const normalized = input.query?.search?.trim().toLowerCase() ?? '';
  return {
    objectId: input.objectId,
    rows: normalized ? rows.filter((row) => Object.values(row).some((value) => value.toLowerCase().includes(normalized))) : rows,
  };
}

export async function readFrappeRecord(input: FrappeConnectionInput & {
  objectId: string;
  doctype: string;
  recordId: string;
}): Promise<RecordDetail> {
  const data = await frappeJson<{ data?: Record<string, unknown> }>(input, `/api/resource/${encodeURIComponent(input.doctype)}/${encodeURIComponent(input.recordId)}`);
  const source = data.data ?? {};
  return {
    objectId: input.objectId,
    recordId: input.recordId,
    values: Object.fromEntries(Object.entries(source).map(([key, value]) => [key, stringifyCell(value)])),
    deskUrl: buildFrappeDeskUrl(input.siteUrl, input.doctype, input.recordId, input.deskUrlBase),
  };
}
