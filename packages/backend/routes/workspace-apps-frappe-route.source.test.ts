import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const route = fs.readFileSync(path.join(import.meta.dirname, 'workspace-apps-api.ts'), 'utf8');
const connector = fs.readFileSync(path.resolve(import.meta.dirname, '../services/workspace-apps/frappe-connector.ts'), 'utf8');

describe('Workspace Apps Frappe connector route contract', () => {
  it('exposes only real Frappe read routes under project credential gate', () => {
    expect(route).toContain("router.get('/connectors/frappe/connections/:connectionId/readiness'");
    expect(route).toContain("router.get('/connectors/frappe/connections/:connectionId/doctypes'");
    expect(route).toContain("router.get('/connectors/frappe/connections/:connectionId/doctypes/:doctype'");
    expect(route).toContain("router.get('/connectors/frappe/connections/:connectionId/doctypes/:doctype/records'");
    expect(route).toContain("router.get('/connectors/frappe/connections/:connectionId/doctypes/:doctype/records/:recordId'");
    expect(route).not.toMatch(/router\.(post|put|patch|delete)\('\/connectors\/frappe\/connections/);
    expect(route).toContain('resolveProjectCredentialSecretValue');
    expect(route).toContain("provider: 'frappe'");
    expect(route).toContain("targetType: 'workspace_apps_frappe_connector'");
    expect(route).toContain('parseFrappeCredentialValue(resolved.value)');
    expect(route).toContain('summarizeFrappeConnectionReadiness(connection)');
    expect(route).toContain('listFrappeDocTypes({ ...connection');
    expect(route).toContain('requireFrappeCredentialMaterializationUserId');
  });

  it('keeps real Frappe endpoints read-only and separate from mock write actions', () => {
    const realRouteBlock = route.slice(
      route.indexOf("router.get('/connectors/frappe/connections/:connectionId/doctypes/:doctype'"),
      route.indexOf("router.get('/connectors/frappe/mock/objects'"),
    );
    expect(realRouteBlock).toContain('canReadProjectApps');
    expect(realRouteBlock).not.toContain('canManageProjectApps');
    expect(realRouteBlock).not.toContain('createMockFrappeRecord');
    expect(realRouteBlock).not.toContain('updateMockFrappeRecord');
    expect(realRouteBlock).not.toContain('transitionMockFrappeRecord');
    expect(connector).toContain('summarizeFrappeConnectionReadiness');
    expect(connector).toContain('siteHost');
    expect(connector).toContain('hasApiKey');
    expect(connector).toContain('hasApiSecret');
    expect(connector).toContain('listFrappeDocTypes');
    expect(connector).toContain('describeFrappeDocType');
    expect(connector).toContain('listFrappeRecords');
    expect(connector).toContain('readFrappeRecord');
    expect(connector).not.toMatch(/export async function (create|update|delete|transition)Frappe/);
  });
});
