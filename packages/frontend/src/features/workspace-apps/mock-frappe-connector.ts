import { mapFrappeFieldtype, type ActionReceipt, type BusinessObjectSchema, type BusinessObjectSummary, type DiyErpConnector, type ExportReceipt, type RecordDetail, type RecordList, type RecordQuery, type RecordValues, type ReportSummary } from './diy-erp-connector';

const FRAPPE_DESK_BASE = 'https://frappe.example.test/app';

const objects: BusinessObjectSummary[] = [
  {
    id: 'customer',
    label: '고객사',
    backend: 'frappe',
    doctype: 'Customer',
    description: 'Frappe Customer DocType을 Tower 업무 탭에서 간단히 다루는 mock connector입니다.',
    deskUrl: `${FRAPPE_DESK_BASE}/customer`,
  },
  {
    id: 'invoice',
    label: '청구',
    backend: 'frappe',
    doctype: 'Sales Invoice',
    description: 'Frappe/ERPNext Sales Invoice 흐름을 Tower front door로 보여주는 mock connector입니다.',
    deskUrl: `${FRAPPE_DESK_BASE}/sales-invoice`,
  },
];

const schemas: Record<string, BusinessObjectSchema> = {
  customer: {
    object: objects[0],
    titleField: 'customer_name',
    statusField: 'status',
    fields: [
      { id: 'customer_name', label: '고객사', kind: mapFrappeFieldtype('Data'), required: true, sourceFieldtype: 'Data' },
      { id: 'territory', label: '권역', kind: mapFrappeFieldtype('Link'), relationTo: 'Territory', sourceFieldtype: 'Link' },
      { id: 'status', label: '상태', kind: mapFrappeFieldtype('Select', 'Lead\nActive\nDormant'), options: ['Lead', 'Active', 'Dormant'], sourceFieldtype: 'Select' },
      { id: 'credit_limit', label: '여신 한도', kind: mapFrappeFieldtype('Currency'), sourceFieldtype: 'Currency' },
      { id: 'disabled', label: '비활성', kind: mapFrappeFieldtype('Check'), sourceFieldtype: 'Check' },
    ],
    transitions: [
      { id: 'activate', label: '활성화', targetStatus: 'Active' },
      { id: 'mark-dormant', label: '휴면 처리', targetStatus: 'Dormant' },
    ],
  },
  invoice: {
    object: objects[1],
    titleField: 'name',
    statusField: 'status',
    fields: [
      { id: 'name', label: '청구번호', kind: mapFrappeFieldtype('Data'), required: true, sourceFieldtype: 'Data' },
      { id: 'customer', label: '고객사', kind: mapFrappeFieldtype('Link'), relationTo: 'Customer', required: true, sourceFieldtype: 'Link' },
      { id: 'posting_date', label: '발행일', kind: mapFrappeFieldtype('Date'), sourceFieldtype: 'Date' },
      { id: 'grand_total', label: '청구금액', kind: mapFrappeFieldtype('Currency'), sourceFieldtype: 'Currency' },
      { id: 'status', label: '상태', kind: mapFrappeFieldtype('Select', 'Draft\nUnpaid\nPaid\nOverdue'), options: ['Draft', 'Unpaid', 'Paid', 'Overdue'], sourceFieldtype: 'Select' },
      { id: 'items', label: '품목', kind: mapFrappeFieldtype('Table'), sourceFieldtype: 'Table' },
    ],
    transitions: [
      { id: 'submit', label: '발행', targetStatus: 'Unpaid' },
      { id: 'mark-paid', label: '입금 처리', targetStatus: 'Paid' },
      { id: 'mark-overdue', label: '연체 표시', targetStatus: 'Overdue' },
    ],
  },
};

const initialRows: Record<string, Array<Record<string, string>>> = {
  customer: [
    { id: 'CUST-001', customer_name: 'DemoOrg', territory: 'Korea', status: 'Active', credit_limit: '₩30,000,000', disabled: 'false' },
    { id: 'CUST-002', customer_name: 'Northstar Labs', territory: 'US', status: 'Lead', credit_limit: '₩12,000,000', disabled: 'false' },
    { id: 'CUST-003', customer_name: 'Studio Orbit', territory: 'Korea', status: 'Dormant', credit_limit: '₩5,000,000', disabled: 'false' },
  ],
  invoice: [
    { id: 'SINV-0001', name: 'SINV-0001', customer: 'DemoOrg', posting_date: '2026-08-01', grand_total: '₩8,800,000', status: 'Unpaid', items: '3 rows' },
    { id: 'SINV-0002', name: 'SINV-0002', customer: 'Northstar Labs', posting_date: '2026-08-05', grand_total: '₩5,100,000', status: 'Overdue', items: '2 rows' },
  ],
};

function nowReceipt(input: Omit<ActionReceipt, 'id' | 'backend' | 'status' | 'executedAt'>): ActionReceipt {
  return {
    id: `mock-${Math.random().toString(16).slice(2, 10)}`,
    backend: 'frappe',
    status: 'applied',
    executedAt: new Date().toISOString(),
    ...input,
  };
}

export function createMockFrappeConnector(): DiyErpConnector {
  const rows: Record<string, Array<Record<string, string>>> = JSON.parse(JSON.stringify(initialRows));

  function schema(objectId: string) {
    const found = schemas[objectId];
    if (!found) throw new Error(`unknown mock Frappe object: ${objectId}`);
    return found;
  }

  return {
    async listObjects() {
      return objects;
    },
    async describeObject(objectId) {
      return schema(objectId);
    },
    async listRecords(objectId: string, query: RecordQuery): Promise<RecordList> {
      const sourceRows = rows[objectId] ?? [];
      const normalized = query.search?.trim().toLowerCase() ?? '';
      const filtered = normalized
        ? sourceRows.filter((row) => Object.values(row).some((value) => String(value).toLowerCase().includes(normalized)))
        : sourceRows;
      return { objectId, rows: filtered.slice(0, query.limit ?? 100) };
    },
    async readRecord(objectId, recordId): Promise<RecordDetail> {
      const row = (rows[objectId] ?? []).find((candidate) => candidate.id === recordId);
      if (!row) throw new Error('record not found');
      return { objectId, recordId, values: row, deskUrl: `${schema(objectId).object.deskUrl}/${recordId}` };
    },
    async createRecord(objectId, values: RecordValues): Promise<ActionReceipt> {
      const newId = `${schema(objectId).object.doctype.toUpperCase().replaceAll(' ', '-')}-${String((rows[objectId]?.length ?? 0) + 1).padStart(4, '0')}`;
      const record = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value == null ? '' : String(value)]));
      rows[objectId] = [{ id: newId, ...record }, ...(rows[objectId] ?? [])];
      return nowReceipt({ objectId, action: 'create', recordId: newId, changedFields: Object.keys(record) });
    },
    async updateRecord(objectId, recordId, values): Promise<ActionReceipt> {
      const row = (rows[objectId] ?? []).find((candidate) => candidate.id === recordId);
      if (!row) throw new Error('record not found');
      for (const [key, value] of Object.entries(values)) row[key] = value == null ? '' : String(value);
      return nowReceipt({ objectId, action: 'update', recordId, changedFields: Object.keys(values) });
    },
    async transitionRecord(objectId, recordId, transitionId): Promise<ActionReceipt> {
      const objectSchema = schema(objectId);
      const transition = objectSchema.transitions.find((candidate) => candidate.id === transitionId);
      if (!transition?.targetStatus || !objectSchema.statusField) throw new Error('transition not available');
      const row = (rows[objectId] ?? []).find((candidate) => candidate.id === recordId);
      if (!row) throw new Error('record not found');
      row[objectSchema.statusField] = transition.targetStatus;
      return nowReceipt({ objectId, action: 'transition', recordId, changedFields: [objectSchema.statusField] });
    },
    async listReports(objectId): Promise<ReportSummary[]> {
      return [
        { id: 'receivables', label: '미수 현황', objectId: objectId ?? 'invoice' },
        { id: 'customer-activity', label: '고객사 활동', objectId: objectId ?? 'customer' },
      ];
    },
    async exportRecords(objectId, _query, format): Promise<ExportReceipt> {
      return { id: `export-${Math.random().toString(16).slice(2, 10)}`, objectId, format, status: 'ready', generatedAt: new Date().toISOString() };
    },
  };
}
