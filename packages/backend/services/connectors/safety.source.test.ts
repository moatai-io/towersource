import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const ingress = readFileSync(new URL('./router.ts', import.meta.url), 'utf8');
const dispatcher = readFileSync(new URL('./dispatcher.ts', import.meta.url), 'utf8');
const runtime = readFileSync(new URL('./runtime.ts', import.meta.url), 'utf8');
const index = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');

describe('Webhook Connector process boundary', () => {
  it('mounts raw-body ingress before the global JSON parser', () => {
    const mount = index.indexOf("app.use('/api/webhooks', webhookIngressRouter())");
    expect(mount).toBeGreaterThan(0);
    expect(mount).toBeLessThan(index.indexOf("app.use(express.json({ limit: '10mb' }))"));
  });
  it('keeps Provider read, Tower authority, and Task execution out of public Ingress', () => {
    expect(ingress).not.toMatch(/getProject|getUserRole|canCreateInProject|createTask|spawnTask|fetchLinearIssue|LINEAR_API_KEY/);
    expect(ingress).toContain('durably enqueue, and acknowledge only');
  });
  it('puts Project run-as authority and Task creation only in the internal Dispatcher', () => {
    expect(dispatcher).toContain('getUserRole(binding.runAsUserId)');
    expect(dispatcher).toContain('canCreateInProject(project.id, binding.runAsUserId, runAsRole)');
    expect(dispatcher).toContain('createTask');
    expect(dispatcher).toContain('WebhookEventStore');
  });
  it('resolves exact Vault Credentials while preserving Ingress and Dispatcher capability separation', () => {
    expect(runtime).toContain("process.env.TOWER_WEBHOOK_CONNECTORS_ENABLED !== 'true'");
    expect(runtime).toContain('resolveProjectCredentialSecretValue');
    expect(runtime).toContain("'webhook_ingress_signature_verification'");
    expect(runtime).toContain("'webhook_dispatch_provider_read'");
    expect(runtime).not.toMatch(/process\.env\.LINEAR_(?:WEBHOOK_SECRET|API_KEY)/);
    expect(index).toContain('await startConfiguredWebhookDispatcher()');
    expect(index).toContain('function beginShutdown(');
    expect(index).toContain("process.on('SIGINT', () => beginShutdown('SIGINT'))");
    expect(index).toContain("process.on('SIGTERM', () => beginShutdown('SIGTERM'))");
    expect(index.match(/stopConfiguredWebhookDispatcher\(\)/g)).toHaveLength(1);
  });
});
