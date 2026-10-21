import { Router } from 'express';
import { getPgPool } from '../../db/pg.js';
import { resolveProjectCredentialSecretValue } from '../credential-vault/credential-vault-service.js';
import type { WebhookDispatchBinding, WebhookIngressBinding, WebhookRoute } from './contract.js';
import { createWebhookIngressRouter } from './router.js';
import { startWebhookDispatcher } from './dispatcher.js';
import { createLinearWebhookResolver, createLinearWebhookVerifier } from './providers/linear/adapter.js';

function csv(value: string | undefined): string[] { return (value || '').split(',').map(item => item.trim()).filter(Boolean); }

interface ConnectorConfig {
  enabled: boolean;
  connectorId: string;
  projectId: string;
  runAsUserId: number;
  signingCredentialId: string;
  apiCredentialId: string;
  allowedTeamKeys: string[];
  allowedLinearProjectIds: string[];
  routeLabels: Record<WebhookRoute, string>;
  approvalLabel: string;
}
interface Bindings { ingress: WebhookIngressBinding[]; dispatch: WebhookDispatchBinding[]; }
type ResolveCredential = typeof resolveProjectCredentialSecretValue;

function configuredWebhookConnector(): ConnectorConfig {
  if (process.env.TOWER_WEBHOOK_CONNECTORS_ENABLED !== 'true') return {
    enabled: false, connectorId: '', projectId: '', runAsUserId: 0, signingCredentialId: '', apiCredentialId: '',
    allowedTeamKeys: [], allowedLinearProjectIds: [], routeLabels: { research: '', draft: '', implement: '' }, approvalLabel: '',
  };
  const config: ConnectorConfig = {
    enabled: true,
    connectorId: process.env.TOWER_LINEAR_WEBHOOK_CONNECTOR_ID || 'linear-default',
    projectId: process.env.TOWER_LINEAR_WEBHOOK_TOWER_PROJECT_ID || '',
    runAsUserId: Number(process.env.TOWER_LINEAR_WEBHOOK_RUN_AS_USER_ID || ''),
    signingCredentialId: process.env.TOWER_LINEAR_WEBHOOK_SIGNING_CREDENTIAL_ID || '',
    apiCredentialId: process.env.TOWER_LINEAR_WEBHOOK_API_CREDENTIAL_ID || '',
    allowedTeamKeys: csv(process.env.TOWER_LINEAR_WEBHOOK_TEAM_KEYS),
    allowedLinearProjectIds: csv(process.env.TOWER_LINEAR_WEBHOOK_LINEAR_PROJECT_IDS),
    routeLabels: {
      research: process.env.TOWER_WEBHOOK_RESEARCH_LABEL || 'agent:research',
      draft: process.env.TOWER_WEBHOOK_DRAFT_LABEL || 'agent:draft',
      implement: process.env.TOWER_WEBHOOK_IMPLEMENT_LABEL || 'agent:implement',
    },
    approvalLabel: process.env.TOWER_WEBHOOK_APPROVAL_LABEL || 'approval-required',
  };
  if (!config.projectId || !Number.isSafeInteger(config.runAsUserId) || config.runAsUserId <= 0
      || !config.signingCredentialId || !config.apiCredentialId || config.allowedTeamKeys.length === 0
      || config.allowedLinearProjectIds.length === 0) {
    throw new Error('Linear Webhook Connector is enabled but required configuration is incomplete');
  }
  return config;
}

async function credentialValue(config: ConnectorConfig, credentialId: string, targetType: string, resolveCredential: ResolveCredential): Promise<string> {
  const resolved = await resolveCredential({
    projectId: config.projectId,
    userId: config.runAsUserId,
    credentialId,
    kind: 'api_key',
    provider: 'linear',
    targetType,
  });
  if (!resolved?.value) throw new Error(`Linear Webhook Connector credential is unavailable for ${targetType}`);
  return resolved.value;
}

export async function configuredWebhookIngressBindings(resolveCredential: ResolveCredential = resolveProjectCredentialSecretValue): Promise<WebhookIngressBinding[]> {
  const config = configuredWebhookConnector();
  if (!config.enabled) return [];
  const secret = await credentialValue(config, config.signingCredentialId, 'webhook_ingress_signature_verification', resolveCredential);
  return [{ connectorId: config.connectorId, verifier: createLinearWebhookVerifier(secret) }];
}

export async function configuredWebhookDispatchBindings(resolveCredential: ResolveCredential = resolveProjectCredentialSecretValue): Promise<WebhookDispatchBinding[]> {
  const config = configuredWebhookConnector();
  if (!config.enabled) return [];
  const apiKey = await credentialValue(config, config.apiCredentialId, 'webhook_dispatch_provider_read', resolveCredential);
  return [{
    connectorId: config.connectorId,
    projectId: config.projectId,
    runAsUserId: config.runAsUserId,
    resolver: createLinearWebhookResolver({ apiKey, policy: {
      allowedTeamKeys: config.allowedTeamKeys,
      allowedLinearProjectIds: config.allowedLinearProjectIds,
      routeLabels: config.routeLabels,
      approvalLabel: config.approvalLabel,
    } }),
  }];
}

export async function configuredWebhookBindings(resolveCredential: ResolveCredential = resolveProjectCredentialSecretValue): Promise<Bindings> {
  const [ingress, dispatch] = await Promise.all([
    configuredWebhookIngressBindings(resolveCredential),
    configuredWebhookDispatchBindings(resolveCredential),
  ]);
  return { ingress, dispatch };
}

export function webhookIngressRouter(): Router {
  const outer = Router();
  let initialized: Promise<Router> | undefined;
  outer.use((req, res, next) => {
    initialized ??= configuredWebhookIngressBindings().then(bindings => {
      if (bindings.length === 0) return Router().use((_req, response) => { response.status(404).json({ error: 'webhook_connectors_disabled' }); });
      const byKey = new Map(bindings.map(binding => [`${binding.verifier.provider}:${binding.connectorId}`, binding]));
      return createWebhookIngressRouter(getPgPool(), (provider, connectorId) => byKey.get(`${provider}:${connectorId}`) || null);
    });
    initialized.then(router => router(req, res, next)).catch(next);
  });
  return outer;
}

let stopDispatcher: (() => void) | undefined;
export async function startConfiguredWebhookDispatcher(): Promise<void> {
  if (stopDispatcher) return;
  const bindings = await configuredWebhookDispatchBindings();
  if (bindings.length === 0) return;
  const byId = new Map(bindings.map(binding => [binding.connectorId, binding]));
  stopDispatcher = startWebhookDispatcher({ pool: getPgPool(), resolveBinding: id => byId.get(id) || null });
}
export function stopConfiguredWebhookDispatcher(): void { stopDispatcher?.(); stopDispatcher = undefined; }
