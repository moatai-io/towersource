import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configuredWebhookBindings,
  configuredWebhookDispatchBindings,
  configuredWebhookIngressBindings,
} from './runtime.js';

const keys = [
  'TOWER_WEBHOOK_CONNECTORS_ENABLED', 'TOWER_LINEAR_WEBHOOK_CONNECTOR_ID',
  'TOWER_LINEAR_WEBHOOK_TOWER_PROJECT_ID', 'TOWER_LINEAR_WEBHOOK_RUN_AS_USER_ID',
  'TOWER_LINEAR_WEBHOOK_TEAM_KEYS', 'TOWER_LINEAR_WEBHOOK_LINEAR_PROJECT_IDS',
  'TOWER_LINEAR_WEBHOOK_SIGNING_CREDENTIAL_ID', 'TOWER_LINEAR_WEBHOOK_API_CREDENTIAL_ID',
];
afterEach(() => { for (const key of keys) delete process.env[key]; });
beforeEach(() => { for (const key of keys) delete process.env[key]; });

function enable() {
  Object.assign(process.env, {
    TOWER_WEBHOOK_CONNECTORS_ENABLED: 'true',
    TOWER_LINEAR_WEBHOOK_CONNECTOR_ID: 'linear-main',
    TOWER_LINEAR_WEBHOOK_TOWER_PROJECT_ID: 'tower-project',
    TOWER_LINEAR_WEBHOOK_RUN_AS_USER_ID: '7',
    TOWER_LINEAR_WEBHOOK_TEAM_KEYS: 'TOW',
    TOWER_LINEAR_WEBHOOK_LINEAR_PROJECT_IDS: 'linear-project',
    TOWER_LINEAR_WEBHOOK_SIGNING_CREDENTIAL_ID: 'linear-signing',
    TOWER_LINEAR_WEBHOOK_API_CREDENTIAL_ID: 'linear-api',
  });
}

function resolver() {
  return vi.fn(async ({ credentialId }: { credentialId: string }) => ({
    credentialId,
    provider: 'linear',
    kind: 'api_key',
    secretName: 'redacted',
    value: credentialId === 'linear-signing' ? 'synthetic-signing-secret' : 'synthetic-api-key',
  }));
}

describe('Webhook Connector runtime registry', () => {
  it('is disabled by default without resolving Vault credentials', async () => {
    const resolveCredential = resolver();
    await expect(configuredWebhookBindings(resolveCredential)).resolves.toEqual({ ingress: [], dispatch: [] });
    expect(resolveCredential).not.toHaveBeenCalled();
  });

  it('fails closed when enabled without exact non-secret bindings', async () => {
    process.env.TOWER_WEBHOOK_CONNECTORS_ENABLED = 'true';
    await expect(configuredWebhookBindings(resolver())).rejects.toThrow('required configuration is incomplete');
  });

  it('resolves exact Credential IDs through the project Vault boundary', async () => {
    enable();
    const resolveCredential = resolver();
    const result = await configuredWebhookBindings(resolveCredential);
    expect(result.ingress).toMatchObject([{ connectorId: 'linear-main', verifier: { provider: 'linear' } }]);
    expect(result.dispatch).toMatchObject([{ connectorId: 'linear-main', projectId: 'tower-project', runAsUserId: 7,
      resolver: { provider: 'linear' } }]);
    expect(resolveCredential).toHaveBeenCalledTimes(2);
    expect(resolveCredential).toHaveBeenCalledWith({ projectId: 'tower-project', userId: 7,
      credentialId: 'linear-signing', kind: 'api_key', provider: 'linear', targetType: 'webhook_ingress_signature_verification' });
    expect(resolveCredential).toHaveBeenCalledWith({ projectId: 'tower-project', userId: 7,
      credentialId: 'linear-api', kind: 'api_key', provider: 'linear', targetType: 'webhook_dispatch_provider_read' });
    expect(result.ingress[0]).not.toHaveProperty('runAsUserId');
    expect(result.ingress[0]).not.toHaveProperty('resolver');
  });

  it('lets Ingress resolve only the signing Credential and Dispatcher only the API Credential', async () => {
    enable();
    const ingressResolver = resolver();
    await configuredWebhookIngressBindings(ingressResolver);
    expect(ingressResolver).toHaveBeenCalledTimes(1);
    expect(ingressResolver.mock.calls[0][0].credentialId).toBe('linear-signing');

    const dispatchResolver = resolver();
    await configuredWebhookDispatchBindings(dispatchResolver);
    expect(dispatchResolver).toHaveBeenCalledTimes(1);
    expect(dispatchResolver.mock.calls[0][0].credentialId).toBe('linear-api');
  });

  it('fails closed when an exact Credential cannot be resolved', async () => {
    enable();
    const missing = vi.fn(async () => null);
    await expect(configuredWebhookIngressBindings(missing)).rejects.toThrow('credential is unavailable');
    await expect(configuredWebhookDispatchBindings(missing)).rejects.toThrow('credential is unavailable');
  });
});
