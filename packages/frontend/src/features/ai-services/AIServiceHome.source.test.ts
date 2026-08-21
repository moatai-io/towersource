import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './AIServiceHome.tsx'), 'utf8');
const store = fs.readFileSync(path.resolve(import.meta.dirname, './ai-services-store.ts'), 'utf8');

describe('AI Service first-class operations home', () => {
  it('opens the create dialog with an Agent Home project preselected', () => {
    expect(source).toContain("sessionStorage.getItem('tower-ai-service-create-project-id')");
    expect(source).toContain("sessionStorage.removeItem('tower-ai-service-create-project-id')");
    expect(source).toContain('setProjectId(requestedProjectId)');
    expect(source).toContain('setCreateOpen(true)');
    expect(source).toContain("if (projectId && !nextProjects.some((item: { id?: string }) => item.id === projectId)) setProjectId('')");
  });

  it('keeps the selected deployment detail in one fluid column inside the split management view', () => {
    expect(source).toContain('grid min-w-0 grid-cols-1 gap-4');
    expect(source).not.toContain('lg:grid-cols-[minmax(0,1fr)_220px_180px]');
    expect(source).not.toContain('lg:col-span-3');
    expect(source).toContain('grid max-w-md grid-cols-3 gap-3 text-left');
  });

  it('provides operator-facing access filters and emergency controls', () => {
    expect(source).toContain("const FILTER_IDS = ['all', 'active', 'draft', 'review', 'paused']");
    expect(source).toContain('aiServices.home.filters.${id}');
    expect(source).toContain("i18n.t('aiServices.home.ui.accessStopped')");
    expect(source).toContain("i18n.t('aiServices.home.ui.deleteAgent')");
    expect(source).not.toContain('>회수<');
  });

  it('uses the isolated AI services API adapter', () => {
    expect(store).toContain("api('/api/ai-services')");
    expect(store).toContain('/pause');
    expect(store).toContain('/pause');
  });

  it('externally deploys a Harness-bound agent from an existing Primary AI teammate without exposing Harness choices', () => {
    expect(source).toContain("fetch('/api/ai-services'");
    expect(source).toContain("fetch('/api/ai-services/harness-options'");
    expect(source).not.toContain('fetch(`/api/harnesses${projectId');
    expect(source).toContain('harnessId: effective.id');
    expect(source).toContain('runtimeProfileId: effective.runtimeProfileId');
    expect(source).toContain('item.runtime_profile_id');
    expect(source).toContain("aiServices.home.runtimeBindingRequired");
    expect(source).not.toContain('<HarnessChoice');
    expect(source).not.toContain('API serving channel');
    expect(source).toContain("i18n.t('aiServices.home.ui.selectTeammate')");
    expect(source).toContain("aiServices.home.copy.createTitle");
    expect(source).toContain('/deploy-now`');
  });

  it('shows the published Harness capability surface and actual tool bindings', () => {
    expect(source).toContain("'web.search': { tool: 'WebSearch'");
    expect(source).toContain("'web.fetch': { tool: 'WebFetch'");
    expect(source).toContain("aiServices.home.ui.currentCapability");
  });

  it('routes missing tools into a separate Harness draft instead of an inline grant', () => {
    expect(source).toContain("aiServices.home.copy.newToolSystemTitle");
    expect(source).toContain('HarnessDraftHandoff');
    expect(source).toContain("fetch('/api/harnesses/drafts'");
    expect(source).toContain('/validate`');
    expect(source).toContain('/publish`');
    expect(source).toContain("aiServices.home.ui.validatePublish");
  });

  it('shows a single three-step journey instead of technical readiness cards', () => {
    expect(source).toContain("aiServices.home.copy.stepOne");
    expect(source).toContain("aiServices.home.copy.stepTwo");
    expect(source).toContain("aiServices.home.copy.stepThree");
    expect(source).not.toContain('외부 배포 준비도');
  });

  it('captures selected Project documents as immutable deployment materials', () => {
    expect(source).toContain("i18n.t('aiServices.home.ui.answerMaterials')");
    expect(source).toContain("aiServices.home.copy.materialsDescription");
    expect(source).toContain("i18n.t('aiServices.home.ui.selectInFinder')");
    expect(source).toContain('KnowledgeFilePicker');
    expect(source).toContain('/api/files/tree?path=');
    expect(source).toContain("aiServices.home.ui.knowledgeConfig");
    expect(source).toContain('KNOWLEDGE_PROMPT_TOKEN_LIMIT');
    expect(source).toContain("i18n.t('aiServices.home.ui.advancedPath')");
    expect(source).toContain('knowledgePaths.split');
    expect(source).toContain("kind: 'knowledge'");
    expect(source).toContain('refs: selectedKnowledgePaths.map((path) => ({ path }))');
    expect(source).toContain("kind: 'none'");
    expect(source).toContain("aiServices.home.noDeploymentMaterials");
    expect(source).toContain("aiServices.home.copy.materialsSafety");
    expect(source).not.toContain('Knowledge Snapshot');
  });

  it('shows profile version drift and lets a new deployment recapture the current Primary Agent identity', () => {
    expect(source).toContain('sourceAgentProfileVersion');
    expect(source).toContain('ownerAgentProfileVersion');
    expect(source).toContain('refreshIdentityFromSourceAgent');
    expect(source).toContain('최신 상담 지침을 새 버전에 반영');
    expect(store).toContain('refreshIdentityFromSourceAgent?: boolean');
  });

  it('shows only capabilities that the deployment flow can actually configure', () => {
    expect(source).toContain("i18n.t('aiServices.home.ui.materialsSystems')");
    expect(source).toContain("i18n.t('aiServices.home.ui.answerFromMaterials')");
    expect(source).toContain("i18n.t('aiServices.home.ui.deploymentSummary')");
    expect(source).toContain("i18n.t('aiServices.home.ui.impossibleActions')");
    expect(source).not.toContain("i18n.t('aiServices.home.copy.externalApi')");
    expect(source).not.toContain("i18n.t('aiServices.home.ui.capabilityDataTitle')");
    expect(source).not.toContain("i18n.t('aiServices.home.ui.capabilityProposeTitle')");
    expect(source).not.toContain("i18n.t('aiServices.home.ui.capabilityExecuteTitle')");
    expect(source).not.toContain('capabilityPreview');
    expect(source).not.toContain('actionApproval');
  });

  it('uses a one-click deploy flow and hides review/approval from the primary UI', () => {
    expect(source).toContain('DeploymentFlowPanel');
    expect(source).toContain("aiServices.home.copy.notPublishedHint");
    expect(source).toContain("aiServices.home.copy.notPublishedHint");
    expect(source).toContain("aiServices.home.ui.deploying");
    expect(source).not.toContain('내부 배포 상세 보기');
    expect(source).not.toContain('검토 요청');
    expect(source).not.toContain('검토·승인');
    expect(store).toContain('deployNow');
    expect(store).toContain('/deploy-now');
  });

  it('hides internal deployment evidence from the primary UI', () => {
    expect(source).not.toContain('내부 체크');
    expect(source).not.toContain('not run');
    expect(source).not.toContain('내부 배포 상세 보기');
    expect(store).toContain('latestEvaluation');
    expect(store).toContain('latest_evaluation');
  });

  it('derives externally accessible state from both deployment and Channel access mode', () => {
    expect(source).toContain("function isExternallyAccessible(service: AIServiceSummary, channel?: ChannelSummary)");
    expect(source).toContain("channelAccessMode(channel) !== 'disabled'");
    expect(source).toContain("i18n.t('aiServices.home.ui.accessStopped')");
    expect(source).toContain("i18n.t('aiServices.home.ui.resumeAccess')");
    expect(source).toContain("i18n.t('aiServices.home.ui.accessStopped')");
    expect(source).toContain("aiServices.home.ui.accessStopped");
  });

  it('shows Channel usage, quota status and editable limits from the service row', () => {
    expect(source).toContain('ChannelUsagePanel');
    expect(source).toContain("i18n.t('aiServices.home.ui.usageLogs')");
    expect(source).toContain("i18n.t('aiServices.home.ui.usageDescription')");
    expect(source).toContain("i18n.t('aiServices.home.ui.advancedQuota')");
    expect(source).toContain("aiServices.home.ui.saveQuota");
    expect(source).toContain('tenantDailyLimit');
    expect(source).toContain('tokenLimit');
    expect(source).toContain("i18n.t('aiServices.home.ui.tokenUsage')");
    expect(source).toContain("i18n.t('aiServices.home.ui.totalTokenLimit')");
    expect(source).toContain('quota.channelRemaining');
    expect(store).toContain('AIServiceChannelUsageSummary');
    expect(store).toContain('getChannelUsage');
    expect(store).toContain('updateChannelQuota');
    expect(store).toContain('createWebLinkChannel');
    expect(source).not.toContain('Channel 생성');
    expect(store).toContain('/channels/${encodeURIComponent(channelId)}/usage');
    expect(store).toContain('/channels/${encodeURIComponent(channelId)}/quota');
  });

  it('lets the operator send one honest test question to the current deployment before sharing', () => {
    expect(source).toContain('previewAnswerText');
    expect(source).toContain("aiServices.home.copy.currentAnswerCheck");
    expect(source).toContain("aiServices.home.ui.sendTest");
    expect(source).toContain('/preview/conversations`');
    expect(source).toContain('/preview/conversations/${encodeURIComponent(conversation.id)}/messages`');
    expect(source).toContain("aiServices.home.emptyTestAnswer");
    expect(source).toContain("aiServices.home.copy.testFailure");
    expect(source).toContain("i18n.t('aiServices.home.ui.validAnswer')");
  });

  it('prioritizes a deployed website link while keeping API details under advanced settings', () => {
    expect(source).toContain('ChannelCredentialPanel');
    expect(source).toContain("i18n.t('aiServices.home.ui.externalDeployTest')");
    expect(source).toContain("aiServices.home.copy.deployTestDescription");
    expect(source).toContain("aiServices.home.copy.externalLink");
    expect(source).toContain("aiServices.home.copy.publishedAuto");
    expect(source).toContain("aiServices.home.ui.copyLink");
    expect(source).toContain("i18n.t('aiServices.home.ui.share')");
    expect(source).toContain('navigator.share');
    expect(source).toContain('sharePublicLink');
    expect(source).toContain("err.name === 'AbortError'");
    expect(source).toContain("aiServices.home.ui.copyLink");
    expect(source).toContain("aria-label={i18n.t('aiServices.home.copy.copyShareLink')}");
    expect(source).toContain('grid grid-cols-2 gap-2 sm:flex sm:flex-wrap');
    expect(source).toContain("i18n.t('aiServices.home.ui.openAgent')");
    expect(source).not.toContain('웹사이트 열기');
    expect(source).toContain("i18n.t('aiServices.home.ui.openAdvanced')");
    expect(source).toContain('/credentials/revoke');
    expect(source).toContain('Conversation API URL');
    expect(source).toContain('Message API URL template');
    expect(source).toContain("i18n.t('aiServices.home.ui.copyToken')");
    expect(source).toContain("i18n.t('aiServices.home.ui.copyApi')");
    expect(source).toContain("aiServices.home.copy.tokenWarning");
  });

  it('lets admins manage Channel access mode before exposing details', () => {
    expect(source).toContain('function accessModeLabel');
    expect(source).toContain("i18n.t('aiServices.home.ui.whoCanUse')");
    expect(source).toContain("aiServices.home.ui.accessMethod");
    expect(source).toContain('function accessModeLabel');
    expect(source).toContain('aiServices.home.accessMode.${mode}');
    expect(source).toContain("(['unlisted', 'password', 'disabled', 'public'] as const)");
    expect(source).toContain("accessMode === 'login_required' && <option value=\"login_required\" disabled>");
    expect(source).toContain("accessMode === 'login_required' ||");
    expect(source).toContain("i18n.t('aiServices.home.ui.createPassword')");
    expect(source).toContain('makeSharePassword');
    expect(source).toContain("aiServices.home.copy.passwordGuidance");
    expect(source).toContain("i18n.t('aiServices.home.ui.showInfoPanel')");
    expect(source).toContain("i18n.t('aiServices.home.ui.showTools')");
    expect(source).toContain("i18n.t('aiServices.home.ui.showMaterials')");
    expect(source).toContain("i18n.t('aiServices.home.ui.showTiming')");
    expect(source).toContain('channelPublicUi');
    expect(store).toContain('AIServiceChannelAccessMode');
    expect(store).toContain('AIServicePublicUiConfig');
    expect(store).toContain('updateChannelAccess');
    expect(store).toContain('updateService');
    expect(store).toContain('retire');
    expect(store).toContain('ui?: AIServicePublicUiConfig');
    expect(store).toContain('/channels/${encodeURIComponent(channelId)}/access');
  });

  it('supports editing, stopping access, resuming access, and deleting deployed agents from the detail', () => {
    expect(source).toContain("aiServices.home.ui.edit");
    expect(source).toContain("i18n.t('aiServices.home.ui.accessStopped')");
    expect(source).toContain("i18n.t('aiServices.home.ui.resumeAccess')");
    expect(source).toContain("i18n.t('aiServices.home.ui.deleteAgent')");
    expect(source).toContain("i18n.t('aiServices.home.ui.name')");
    expect(source).toContain("i18n.t('aiServices.home.ui.description')");
    expect(source).toContain('saveEdit');
    expect(source).toContain('deleteService');
    expect(source).toContain("aiServices.home.ui.deleteAgent");
    expect(source).toContain("danger: true");
    expect(source).toContain("aiServices.home.copy.managementDescription");
    expect(store).toContain("method: 'PATCH'");
    expect(store).toContain("method: 'DELETE'");
  });

  it('covers loading, error and empty states', () => {
    expect(source).toContain("aiServices.home.copy.loadingDeployments");
    expect(source).toContain("i18n.t('aiServices.home.ui.retry')");
    expect(source).toContain("i18n.t('aiServices.home.copy.emptyFirst')");
  });

  it('configures a deployment-pinned customer request CTA without exposing delivery as complete', () => {
    expect(source).toContain('RequestActionDraft');
    expect(source).toContain('requestActionDraft');
    expect(source).toContain('requestActionsSnapshot');
    expect(source).toContain("i18n.t('aiServices.home.ui.customerRequestButton')");
    expect(source).toContain("i18n.t('aiServices.home.ui.recipientEmail')");
    expect(source).toContain("aiServices.home.requestAction.label");
    expect(source).toContain("destination: { type: 'email', to: draft.recipientEmail.trim() }");
    expect(source).toContain('requestActions: requestActionsSnapshot(requestAction)');
    expect(source).toContain("aiServices.home.ui.requestActionPrivacy");
    expect(source).toContain("aiServices.home.ui.requestActionPrivacy");
  });

  it('prepares immutable Knowledge changes as a new deployment version and preserves rollback', () => {
    expect(source).toContain('DeploymentVersionPanel');
    expect(source).toContain("i18n.t('aiServices.home.ui.prepareNewVersion')");
    expect(source).toContain("aiServices.home.ui.knowledgeConfig");
    expect(source).toContain("i18n.t('aiServices.home.ui.added')");
    expect(source).toContain("i18n.t('aiServices.home.ui.removed')");
    expect(source).toContain("i18n.t('aiServices.home.ui.createActivateVersion'");
    expect(source).toContain("i18n.t('aiServices.home.ui.rollbackVersion'");
    expect(source).toContain('createDeployment(service.id');
    expect(source).toContain('rollbackDeployment(service.id');
    expect(store).toContain('/deployments`');
    expect(store).toContain('/rollback');
  });

  it('uses a list-to-detail structure for many deployed agents', () => {
    expect(source).toContain('selectedServiceId');
    expect(source).toContain('ServiceListItem');
    expect(source).toContain("aiServices.home.ui.externalDeployment");
    expect(source).toContain("i18n.t('aiServices.home.primaryAiTeammate')");
    expect(source).toContain('service.currentDeployment');
    expect(source).toContain('deploymentKnowledgeRefs(service)');
    expect(source).toContain('ConversationHistoryPanel');
    expect(source).toContain("aiServices.home.ui.pastConversations");
    expect(source).toContain('getConversations');
  });

  it('uses agent external deployment as the product term instead of website deployment', () => {
    expect(source).toContain("aiServices.home.ui.externalDeployment");
    expect(source).toContain("i18n.t('aiServices.home.ui.newDeployment')");
    expect(source).toContain("i18n.t('aiServices.home.ui.deploymentName')");
    expect(source).not.toContain('웹사이트 배포');
    expect(source).not.toContain('웹사이트로 배포');
    expect(source).not.toContain('AI 서비스 상태 필터');
  });
});
