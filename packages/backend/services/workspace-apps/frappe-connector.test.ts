import { describe, expect, it } from 'vitest';
import { buildFrappeDeskUrl, describeFrappeDocType, listFrappeDocTypes, listFrappeRecords, mapFrappeDocTypeMeta, mapFrappeFieldtype, normalizeFrappeDeskUrlBase, normalizeFrappeSiteUrl, parseFrappeCredentialValue, readFrappeRecord, summarizeFrappeConnectionReadiness } from './frappe-connector.js';

describe('Frappe connector helpers', () => {
  it('normalizes safe Frappe URLs and builds Desk deep links', () => {
    expect(normalizeFrappeSiteUrl('https://erp.example.com///')).toBe('https://erp.example.com');
    expect(normalizeFrappeSiteUrl('http://localhost:8000')).toBe('http://localhost:8000');
    expect(() => normalizeFrappeSiteUrl('http://erp.example.com')).toThrow('https');
    expect(normalizeFrappeDeskUrlBase('http://desk-dev.tower.example.com:8080///')).toBe('http://desk-dev.tower.example.com:8080');
    expect(buildFrappeDeskUrl('https://erp.example.com', 'Sales Invoice', 'SINV-0001')).toBe('https://erp.example.com/app/sales-invoice/SINV-0001');
    expect(buildFrappeDeskUrl('http://127.0.0.1:8080', 'Customer', 'CUST-001', 'http://desk-dev.tower.example.com:8080')).toBe('http://desk-dev.tower.example.com:8080/app/customer/CUST-001');
  });

  it('parses JSON Frappe credentials without logging secret fields', () => {
    expect(parseFrappeCredentialValue(JSON.stringify({ siteUrl: 'https://erp.example.com', deskUrlBase: 'http://desk-dev.tower.example.com:8080', apiKey: 'key', apiSecret: 'secret' }))).toEqual({
      siteUrl: 'https://erp.example.com',
      deskUrlBase: 'http://desk-dev.tower.example.com:8080',
      apiKey: 'key',
      apiSecret: 'secret',
    });
    expect(parseFrappeCredentialValue(JSON.stringify({ FRAPPE_SITE_URL: 'https://erp.example.com', FRAPPE_API_KEY: 'key' })).apiKey).toBe('key');
    expect(() => parseFrappeCredentialValue('not-json')).toThrow('JSON object');
  });

  it('summarizes Frappe connection readiness without returning secret values', () => {
    expect(summarizeFrappeConnectionReadiness({ siteUrl: 'https://erp.example.com', deskUrlBase: 'http://desk-dev.tower.example.com:8080', apiKey: 'key', apiSecret: 'secret' })).toEqual({
      ready: true,
      provider: 'frappe',
      siteHost: 'erp.example.com',
      deskHost: 'desk-dev.tower.example.com:8080',
      hasApiKey: true,
      hasApiSecret: true,
    });
    expect(summarizeFrappeConnectionReadiness({ siteUrl: 'https://erp.example.com', apiKey: 'key' })).toMatchObject({
      ready: false,
      siteHost: 'erp.example.com',
      hasApiKey: true,
      hasApiSecret: false,
    });
  });

  it('maps Frappe fieldtypes into Tower business field kinds', () => {
    expect(mapFrappeFieldtype('Data')).toBe('text');
    expect(mapFrappeFieldtype('Select', 'Draft\nSubmitted')).toBe('status');
    expect(mapFrappeFieldtype('Currency')).toBe('money');
    expect(mapFrappeFieldtype('Date')).toBe('date');
    expect(mapFrappeFieldtype('Link')).toBe('relation');
    expect(mapFrappeFieldtype('Check')).toBe('boolean');
    expect(mapFrappeFieldtype('Table')).toBe('child-table');
  });

  it('maps DocType metadata to a BusinessObjectSchema', () => {
    const schema = mapFrappeDocTypeMeta({
      siteUrl: 'https://erp.example.com',
      doctype: 'Customer',
      meta: {
        name: 'Customer',
        title_field: 'customer_name',
        fields: [
          { fieldname: 'customer_name', label: 'Customer Name', fieldtype: 'Data', reqd: 1 },
          { fieldname: 'status', label: 'Status', fieldtype: 'Select', options: 'Lead\nActive' },
          { fieldname: 'territory', label: 'Territory', fieldtype: 'Link', options: 'Territory' },
          { fieldname: 'contacts', label: 'Contacts', fieldtype: 'Table' },
        ],
      },
    });
    expect(schema.object.doctype).toBe('Customer');
    expect(schema.titleField).toBe('customer_name');
    expect(schema.statusField).toBe('status');
    expect(schema.fields.map((field) => [field.id, field.kind])).toEqual([
      ['customer_name', 'text'],
      ['status', 'status'],
      ['territory', 'relation'],
      ['contacts', 'child-table'],
    ]);
  });

  it('wraps Frappe read API calls without requiring a real server', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      if (url.includes('getdoctype')) {
        return new Response(JSON.stringify({ docs: [{ name: 'Customer', title_field: 'customer_name', fields: [{ fieldname: 'customer_name', label: 'Customer Name', fieldtype: 'Data' }] }] }), { status: 200 });
      }
      if (url.includes('/api/resource/Customer/CUST-001')) {
        return new Response(JSON.stringify({ data: { name: 'CUST-001', customer_name: 'DemoOrg' } }), { status: 200 });
      }
      if (url.includes('/api/resource/DocType')) {
        return new Response(JSON.stringify({ data: [
          { name: 'Customer', module: 'Selling', description: 'Customer master', istable: 0, issingle: 0 },
          { name: 'Sales Invoice', module: 'Accounts', istable: 0, issingle: 0 },
          { name: 'Sales Invoice Item', module: 'Accounts', istable: 1, issingle: 0 },
        ] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ name: 'CUST-001', customer_name: 'DemoOrg' }] }), { status: 200 });
    };

    const described = await describeFrappeDocType({ siteUrl: 'https://erp.example.com', doctype: 'Customer', fetchImpl });
    const doctypes = await listFrappeDocTypes({ siteUrl: 'https://erp.example.com', query: { search: 'invoice' }, fetchImpl });
    const list = await listFrappeRecords({ siteUrl: 'https://erp.example.com', objectId: 'customer', doctype: 'Customer', fields: ['customer_name'], fetchImpl });
    const detail = await readFrappeRecord({ siteUrl: 'https://erp.example.com', objectId: 'customer', doctype: 'Customer', recordId: 'CUST-001', fetchImpl });
    expect(described.fields[0].id).toBe('customer_name');
    expect(doctypes.map((object) => object.doctype)).toEqual(['Sales Invoice']);
    expect(list.rows[0]).toEqual({ name: 'CUST-001', customer_name: 'DemoOrg' });
    expect(detail.values.customer_name).toBe('DemoOrg');
    expect(calls.some((url) => url.includes('/api/resource/DocType'))).toBe(true);
    expect(calls.some((url) => url.includes('/api/resource/Customer'))).toBe(true);
  });
});
