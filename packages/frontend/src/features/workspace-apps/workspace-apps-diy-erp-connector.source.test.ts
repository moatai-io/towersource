import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const frontendDir = import.meta.dirname;
const connectorTypes = fs.readFileSync(path.join(frontendDir, 'diy-erp-connector.ts'), 'utf8');
const mockConnector = fs.readFileSync(path.join(frontendDir, 'mock-frappe-connector.ts'), 'utf8');
const pilot = fs.readFileSync(path.join(frontendDir, 'FrappeConnectorPilot.tsx'), 'utf8');
const client = fs.readFileSync(path.join(frontendDir, 'workspace-app-api.ts'), 'utf8');
const home = fs.readFileSync(path.join(frontendDir, 'WorkspaceAppsHome.tsx'), 'utf8');
const backendRoute = fs.readFileSync(path.resolve(frontendDir, '../../../../backend/routes/workspace-apps-api.ts'), 'utf8');
const backendFrappe = fs.readFileSync(path.resolve(frontendDir, '../../../../backend/services/workspace-apps/frappe-connector.ts'), 'utf8');

describe('DIY ERP Connector pilot', () => {
  it('defines the connector contract without making Tower an ERP engine', () => {
    expect(connectorTypes).toContain('export interface DiyErpConnector');
    expect(connectorTypes).toContain('listObjects(): Promise<BusinessObjectSummary[]>');
    expect(connectorTypes).toContain('transitionRecord(objectId: string, recordId: string, transitionId: string)');
    expect(connectorTypes).toContain('exportRecords(objectId: string, query: RecordQuery, format: \'csv\' | \'xlsx\' | \'pdf\')');
  });

  it('documents Frappe fieldtype mapping for the first golden-path connector', () => {
    expect(connectorTypes).toContain('Data -> text');
    expect(connectorTypes).toContain('Select -> select/status');
    expect(connectorTypes).toContain('Currency -> money');
    expect(connectorTypes).toContain('Date -> date');
    expect(connectorTypes).toContain('Link -> relation');
    expect(connectorTypes).toContain('Check -> boolean');
    expect(connectorTypes).toContain('Table -> child-table placeholder');
  });

  it('ships a mock Frappe connector pilot that can run without a Frappe server', () => {
    expect(mockConnector).toContain('createMockFrappeConnector');
    expect(mockConnector).toContain("doctype: 'Customer'");
    expect(mockConnector).toContain("doctype: 'Sales Invoice'");
    expect(pilot).toContain('DIY ERP Connector');
    expect(pilot).toContain('ERPNext/Frappe 원본 열기');
    expect(pilot).toContain('관리자 설정 · ERP 연결');
    expect(pilot).toContain('ERP 구조 지도');
    expect(pilot).toContain('템플릿 작업창');
    expect(pilot).toContain('TemplatePlanPreview');
    expect(pilot).toContain('buildTemplatePlanPreview');
    expect(pilot).toContain('handleTemplatePlanPrompt');
    expect(pilot).toContain('승인 전');
    expect(pilot).toContain('예상 변경');
    expect(pilot).toContain('확인할 위험');
    expect(pilot).toContain("const defaultFrappeBusinessDoctypes = ['Customer', 'Sales Invoice', 'Item', 'Supplier', 'Lead']");
    expect(pilot).toContain('realObjectsForDoctype(appliedDoctype)');
    expect(pilot).toContain('handleLoadDoctypeCandidates');
    expect(pilot).toContain('ERP 구조 읽기');
    expect(pilot).toContain('applyFrappeObject(candidate)');
    expect(pilot).toContain("React.useState<FrappePilotSourceMode>('real-readonly')");
    expect(pilot).toContain("type FrappePilotSourceMode = 'mock' | 'real-readonly'");
    expect(pilot).toContain('Mock Frappe');
    expect(pilot).toContain('Real read-only');
    expect(pilot).toContain('fetchMockFrappeObjects(projectId)');
    expect(pilot).toContain('fetchFrappeConnectionReadiness');
    expect(pilot).toContain('fetchFrappeObjectSchema');
    expect(pilot).toContain('fetchFrappeRecords');
    expect(pilot).toContain('fetchFrappeRecord');
    expect(pilot).toContain('handleReadinessCheck');
    expect(pilot).toContain('점검');
    expect(pilot).toContain('appliedConnectionId');
    expect(pilot).toContain('connectionState');
    expect(pilot).toContain('selectedDeskUrl ?? schema?.object.deskUrl');
    expect(pilot).toContain('Connection ID와 DocType을 모두 입력한 뒤 조회하세요');
    expect(pilot).toContain('Frappe 연결 준비 방법');
    expect(pilot).toContain('원본 처리 안내');
    expect(pilot).toContain('이 연결은 현재 읽기 전용입니다.');
    expect(pilot).toContain('provider <code');
    expect(pilot).toContain('frappe-main');
    expect(pilot).toContain('<FRAPPE_API_KEY>');
    expect(pilot).toContain('<FRAPPE_API_SECRET>');
    expect(pilot).toContain('read-only 사용자');
    expect(pilot).toContain('canWriteThroughConnector');
    expect(client).toContain('fetchMockFrappeObjects');
    expect(client).toContain('fetchFrappeObjects');
    expect(client).toContain('/doctypes?');
    expect(client).toContain('fetchFrappeConnectionReadiness');
    expect(client).toContain('fetchFrappeObjectSchema');
    expect(client).toContain('/api/workspace-apps/connectors/frappe/mock/objects');
    expect(client).toContain('/api/workspace-apps/connectors/frappe/connections/');
    expect(client).toContain('/readiness?');
    expect(backendRoute).toContain("router.get('/connectors/frappe/mock/objects'");
    expect(backendRoute).toContain("router.get('/connectors/frappe/connections/:connectionId/doctypes'");
    expect(backendRoute).toContain("router.get('/connectors/frappe/connections/:connectionId/doctypes/:doctype'");
    expect(home).toContain("workspaceAppsMode === 'frappe-connector-pilot'");
    expect(home).toContain('<FrappeConnectorPilot />');
  });

  it('adds backend Frappe read adapter helpers for the next real-connection slice', () => {
    expect(backendFrappe).toContain('normalizeFrappeSiteUrl');
    expect(backendFrappe).toContain('parseFrappeCredentialValue');
    expect(backendFrappe).toContain('describeFrappeDocType');
    expect(backendFrappe).toContain('listFrappeRecords');
    expect(backendFrappe).toContain('readFrappeRecord');
    expect(backendFrappe).toContain('/api/method/frappe.desk.form.load.getdoctype');
    expect(backendFrappe).toContain('/api/resource/');
  });
});
