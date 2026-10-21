import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const panel = fs.readFileSync(path.join(process.cwd(), 'packages/frontend/src/components/admin/AdminPanel.tsx'), 'utf8');
const ko = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'packages/frontend/src/locales/ko/admin.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'packages/frontend/src/locales/en/admin.json'), 'utf8'));

describe('Admin Gateway Profile card', () => {
  it('loads the secret-free profile alongside the VM Vault overview without blocking existing Connections', () => {
    expect(panel).toContain('/credential-vault/admin/gateway-profile');
    expect(panel).toContain('setGatewayProfiles');
    expect(panel).toContain("setGatewayLoadError(t('credentialConnections.gateway.loadFailed'))");
    expect(panel).not.toContain("if (!gatewayResponse.ok) throw");
    expect(panel).not.toMatch(/gatewayProfiles[^\n]{0,120}(secret|apiKey|credentialId)/i);
  });

  it('requires the existing confirmation flow before bounded verification', () => {
    expect(panel).toContain("title: t('credentialConnections.gateway.verifyTitle')");
    expect(panel).toContain("body: JSON.stringify({ confirmed: true, profileId: profile.id })");
    expect(panel).toContain('/credential-vault/admin/gateway-profile/verify');
  });

  it('shows profile state, separate execution policy and verification evidence', () => {
    for (const token of ['profile.status', 'profile.credential.configured', 'profile.lastVerifiedAt', 'profile.catalog.map', 'api.enabled', 'gateway.canaryNotice']) expect(panel).toContain(token);
    expect(panel).toContain('/credential-vault/admin/gateway-profile/catalog/');
    expect(panel).toContain('updateGatewayApiPolicy');
  });

  it('ships complete Korean and English gateway labels', () => {
    for (const locale of [ko, en]) {
      const gateway = locale.credentialConnections.gateway;
      for (const key of ['title', 'description', 'verifyAction', 'verifyDescription', 'canaryNotice', 'policy', 'policyAllowed', 'policyDenied', 'status_ready', 'readiness_unverified']) expect(gateway[key]).toBeTruthy();
    }
  });
});
