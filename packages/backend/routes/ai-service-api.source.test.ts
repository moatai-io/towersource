import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const route = fs.readFileSync(path.resolve(import.meta.dirname, './ai-service-api.ts'), 'utf8');
const api = fs.readFileSync(path.resolve(import.meta.dirname, './api.ts'), 'utf8');

describe('AI service authenticated API', () => {
  it('mounts public credential serving above auth and management routes behind auth', () => {
    expect(api.indexOf("router.use('/ai-service-public', aiServicePublicRouter)")).toBeLessThan(api.indexOf('router.use(authMiddleware)'));
    expect(api.indexOf('router.use(authMiddleware)')).toBeLessThan(api.indexOf("router.use('/ai-services', aiServiceRouter)"));
    expect(api).toContain("if (config.aiServicesEnabled) router.use('/ai-service-public', aiServicePublicRouter)");
    expect(api).toContain("if (config.aiServicesEnabled) router.use('/ai-services', aiServiceRouter)");
    expect(api).toContain("if (config.towerRole === 'full') router.use('/harnesses', harnessRouter)");
    expect(api).toContain('aiServicesEnabled: config.aiServicesEnabled');
    expect(api).toContain("harnessAdministrationEnabled: config.towerRole === 'full'");
  });

  it('exposes only the safe external-deployment Harness option without mounting Harness administration', () => {
    expect(route).toContain("router.get('/harness-options'");
    expect(route).toContain("item.id==='quick-web-research'");
    expect(route).toContain('listPublishedHarnesses');
  });

  it('checks Project or service access before writes', () => {
    expect(route).toContain('isProjectMember');
    expect(route).toContain('assertAIServiceAccess');
    expect(route).toContain("router.patch('/:id'");
    expect(route).toContain("router.delete('/:id'");
    expect(route).toContain('updateAIService');
    expect(route).toContain('retireAIService');
    expect(route).toContain('deployServiceNow');
    expect(route).toContain("/:id/deploy-now");
  });

  it('separates review, approval, activation and emergency controls', () => {
    for (const routePath of ['/submit', '/approve', '/activate', '/pause', '/rollback', '/revoke']) expect(route).toContain(routePath);
  });

  it('can explicitly recapture the current Primary Agent identity for a new immutable deployment version', () => {
    expect(route).toContain('refreshIdentityFromSourceAgent');
    expect(route).toContain('delete experience.identity');
    expect(route.indexOf('delete experience.identity')).toBeLessThan(route.lastIndexOf('canonicalizeServiceExperienceSnapshot'));
  });

  it('runs isolated Preview conversations through the pinned Harness runtime', () => {
    expect(route).toContain('/preview/conversations');
    expect(route).toContain('tenantKey:`preview:${a.userId}`');
    expect(route).toContain('runAIServicePreview');
    expect(route).toContain('canonicalizeServiceExperienceSnapshot');
    expect(route).not.toContain("mode:'record-only'");
  });

  it('serves authenticated Channels through the active pinned runtime boundary', () => {
    expect(route).toContain('/:id/channels/:channelId/conversations');
    expect(route).toContain('createAIServiceChannelConversation');
    expect(route).toContain('runAIServiceChannelTurn');
    expect(route).toContain('internalAuthenticatedChannelIdentity(req)');
    expect(route).toContain('tenantKey:identity.tenantKey');
    expect(route).toContain('userKey:identity.userKey');
  });

  it('labels body-derived Channel identity as internal-only before public credential routes', () => {
    expect(route).toContain('Internal dogfood bridge only');
    expect(route).toContain('server-issued Channel credential');
    expect(route).toContain("source:'authenticated-internal-body'");
  });

  it('issues and revokes server-signed Channel credentials only through authenticated service access and records usage', () => {
    expect(route).toContain('/:id/channels/:channelId/credentials');
    expect(route).toContain('issueChannelCredential');
    expect(route).toContain('/:id/channels/:channelId/credentials/revoke');
    expect(route).toContain('revokeChannelCredential');
    expect(route).toContain('activation-readiness');
    expect(route).toContain('getAIServiceActivationReadiness');
    expect(route).toContain("/:id/channels/:channelId/usage");
    expect(route).toContain("/:id/channels/:channelId/quota");
    expect(route).toContain("/:id/channels/:channelId/access");
    expect(route).toContain('getChannelUsageSummary');
    expect(route).toContain('updateChannelQuotaConfig');
    expect(route).toContain('updateChannelAccessConfig');
    expect(route).toContain('req.body?.ui');
    expect(route).toContain('await assertAIServiceAccess(req.params.id,a.userId,a.role)');
    expect(route).toContain('AI service Channel not found');
    expect(route).toContain("c.status='enabled'");
    expect(route).toContain('s.current_deployment_id=c.active_deployment_id');
    expect(route.indexOf('const channel=await queryOne')).toBeLessThan(route.indexOf('const issued=issueChannelCredential'));
    expect(route).toContain('recordChannelUsageEvent');
    expect(route).toContain("eventType:'credential_issued'");
    expect(route).toContain('channel_quota_updated');
    expect(route).toContain('channel_access_updated');
    expect(route).toContain('channelServingLinks');
    expect(route).toContain('conversationUrl');
    expect(route).toContain('messageUrlTemplate');
    expect(route).toContain('chatUrlTemplate');
    expect(route).toContain('/ai-service-chat/');
  });
});
