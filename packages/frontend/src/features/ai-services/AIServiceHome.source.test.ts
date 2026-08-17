import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './AIServiceHome.tsx'), 'utf8');
const store = fs.readFileSync(path.resolve(import.meta.dirname, './ai-services-store.ts'), 'utf8');

describe('AI Service first-class operations home', () => {
  it('keeps the selected deployment detail in one fluid column inside the split management view', () => {
    expect(source).toContain('grid min-w-0 grid-cols-1 gap-4');
    expect(source).not.toContain('lg:grid-cols-[minmax(0,1fr)_220px_180px]');
    expect(source).not.toContain('lg:col-span-3');
    expect(source).toContain('grid max-w-md grid-cols-3 gap-3 text-left');
  });

  it('provides operator-facing access filters and emergency controls', () => {
    expect(source).toContain("['active', '운영 중']");
    expect(source).toContain("['draft', '배포 준비']");
    expect(source).toContain("['review', '검토 중']");
    expect(source).toContain("['paused', '접근 중지']");
    expect(source).toContain('외부 접근 중지');
    expect(source).toContain('에이전트 삭제');
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
    expect(source).toContain('완전한 Harness runtime profile binding');
    expect(source).not.toContain('<HarnessChoice');
    expect(source).not.toContain('API serving channel');
    expect(source).toContain('배포할 AI 팀원');
    expect(source).toContain('기존 AI 팀원 외부 배포');
    expect(source).toContain('/deploy-now`');
  });

  it('shows the published Harness capability surface and actual tool bindings', () => {
    expect(source).toContain("'web.search': { tool: 'WebSearch'");
    expect(source).toContain("'web.fetch': { tool: 'WebFetch'");
    expect(source).toContain('Registry 발행본');
  });

  it('routes missing tools into a separate Harness draft instead of an inline grant', () => {
    expect(source).toContain('새 실행 도구 체계 만들기');
    expect(source).toContain('HarnessDraftHandoff');
    expect(source).toContain("fetch('/api/harnesses/drafts'");
    expect(source).toContain('/validate`');
    expect(source).toContain('/publish`');
    expect(source).toContain('검증하고 발행');
  });

  it('shows a single three-step journey instead of technical readiness cards', () => {
    expect(source).toContain('1. AI 팀원 선택');
    expect(source).toContain('2. 답변 자료 확인');
    expect(source).toContain('3. 이용 범위 설정 후 테스트');
    expect(source).not.toContain('외부 배포 준비도');
  });

  it('captures selected Project documents as immutable deployment materials', () => {
    expect(source).toContain('답변에 사용할 자료');
    expect(source).toContain('원본 파일이 바뀌어도 새로 배포하기 전에는 외부 응답이 달라지지 않습니다');
    expect(source).toContain('Finder에서 자료 선택');
    expect(source).toContain('KnowledgeFilePicker');
    expect(source).toContain('/api/files/tree?path=');
    expect(source).toContain('예상 {estimatedTokens.toLocaleString()} tokens');
    expect(source).toContain('KNOWLEDGE_PROMPT_TOKEN_LIMIT');
    expect(source).toContain('고급 · 경로 직접 입력');
    expect(source).toContain('knowledgePaths.split');
    expect(source).toContain("kind: 'knowledge'");
    expect(source).toContain('refs: selectedKnowledgePaths.map((path) => ({ path }))');
    expect(source).toContain("kind: 'none'");
    expect(source).toContain("userFacingLabel: '연결된 배포 자료 없음'");
    expect(source).toContain('Project 경계·symlink·파일 형식·크기');
    expect(source).not.toContain('Knowledge Snapshot');
  });

  it('shows a human-readable capability and approval policy prototype', () => {
    expect(source).toContain('자료와 시스템');
    expect(source).toContain('가능한 일');
    expect(source).toContain('확인이 필요한 일');
    expect(source).toContain('자료를 찾아 답변');
    expect(source).toContain('업무 데이터 조회');
    expect(source).toContain('실행안 제안');
    expect(source).toContain('실제 업무 실행');
    expect(source).toContain('권한 설계 미리보기');
    expect(source).toContain('매번 승인');
    expect(source).toContain('정책 안에서 자동');
    expect(source).toContain('실행 허용 안 함');
    expect(source).toContain('외부 배포 승인 요약');
    expect(source).toContain('자유 SQL');
  });

  it('uses a one-click deploy flow and hides review/approval from the primary UI', () => {
    expect(source).toContain('DeploymentFlowPanel');
    expect(source).toContain('아직 외부 배포되지 않았습니다');
    expect(source).toContain('버튼 한 번이면 필요한 준비를 자동으로 끝내고 테스트 링크를 만듭니다');
    expect(source).toContain("mutating ? '외부 배포 중…' : service.status === 'paused' ? '다시 운영하기' : '에이전트 외부 배포'");
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
    expect(source).toContain('외부 접근 중지');
    expect(source).toContain('외부 접근 재개');
    expect(source).toContain('접근 차단');
    expect(source).toContain("channelAccessMode(channel) === 'disabled' ? '접근 중지'");
  });

  it('shows Channel usage, quota status and editable limits from the service row', () => {
    expect(source).toContain('ChannelUsagePanel');
    expect(source).toContain('사용량 · 로그');
    expect(source).toContain('최근 이용 현황과 사용 한도');
    expect(source).toContain('고급 이용 한도 설정');
    expect(source).toContain('사용 한도 저장');
    expect(source).toContain('tenantDailyLimit');
    expect(source).toContain('tokenLimit');
    expect(source).toContain('토큰 사용량');
    expect(source).toContain('전체 토큰 한도');
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
    expect(source).toContain('현재 고객 답변 확인');
    expect(source).toContain('테스트 질문 보내기');
    expect(source).toContain('/preview/conversations`');
    expect(source).toContain('/preview/conversations/${encodeURIComponent(conversation.id)}/messages`');
    expect(source).toContain('테스트는 끝났지만 답변이 비어 있습니다');
    expect(source).toContain('테스트 실패 · 공유 전에 확인 필요');
    expect(source).toContain('정상 답변');
  });

  it('prioritizes a deployed website link while keeping API details under advanced settings', () => {
    expect(source).toContain('ChannelCredentialPanel');
    expect(source).toContain('외부 배포 · 테스트');
    expect(source).toContain('버튼 하나로 에이전트를 외부 배포하고, 바로 열어 테스트한 뒤 링크를 공유하세요');
    expect(source).toContain('외부 접속 링크');
    expect(source).toContain('외부 배포됨 · 자동 생성');
    expect(source).toContain('링크 복사');
    expect(source).toContain('공유하기');
    expect(source).toContain('navigator.share');
    expect(source).toContain('sharePublicLink');
    expect(source).toContain("err.name === 'AbortError'");
    expect(source).toContain("linkCopied ? '복사됨' : '링크 복사'");
    expect(source).toContain('aria-label="공유 링크를 클립보드에 복사"');
    expect(source).toContain('grid grid-cols-2 gap-2 sm:flex sm:flex-wrap');
    expect(source).toContain('에이전트 열기');
    expect(source).not.toContain('웹사이트 열기');
    expect(source).toContain('고급 설정 · API/token 보기');
    expect(source).toContain('/credentials/revoke');
    expect(source).toContain('Conversation API URL');
    expect(source).toContain('Message API URL template');
    expect(source).toContain('Token 복사');
    expect(source).toContain('API URL 복사');
    expect(source).toContain('Bearer token · 한 번만 표시');
  });

  it('lets admins manage Channel access mode before exposing details', () => {
    expect(source).toContain('ACCESS_MODE_LABELS');
    expect(source).toContain('누가 사용할 수 있나요?');
    expect(source).toContain('공개 범위');
    expect(source).toContain('링크 공유 · 링크를 아는 사람만');
    expect(source).toContain('완전 공개 · 누구나 접속');
    expect(source).toContain('비밀번호 보호 · 비밀번호를 아는 사람만');
    expect(source).toContain('로그인 필요 · 준비 중');
    expect(source).toContain('일시 중지 · 아무도 접속 못함');
    expect(source).toContain('비밀번호 만들기');
    expect(source).toContain('makeSharePassword');
    expect(source).toContain('저장 후 다시 볼 수 없으니');
    expect(source).toContain('정보 패널 표시');
    expect(source).toContain('도구 표시');
    expect(source).toContain('공개 자료 표시');
    expect(source).toContain('응답 시간 표시');
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
    expect(source).toContain('수정');
    expect(source).toContain('외부 접근 중지');
    expect(source).toContain('외부 접근 재개');
    expect(source).toContain('에이전트 삭제');
    expect(source).toContain('이름');
    expect(source).toContain('설명');
    expect(source).toContain('saveEdit');
    expect(source).toContain('deleteService');
    expect(source).toContain("title: '외부 배포 에이전트 삭제'");
    expect(source).toContain("danger: true");
    expect(source).toContain('기존 배포 세션과 대화 기록은 보존됩니다');
    expect(store).toContain("method: 'PATCH'");
    expect(store).toContain("method: 'DELETE'");
  });

  it('covers loading, error and empty states', () => {
    expect(source).toContain('외부 배포 목록을 불러오는 중');
    expect(source).toContain('다시 시도');
    expect(source).toContain('첫 에이전트를 외부 배포해 보세요');
  });

  it('configures a deployment-pinned customer request CTA without exposing delivery as complete', () => {
    expect(source).toContain('RequestActionDraft');
    expect(source).toContain('requestActionDraft');
    expect(source).toContain('requestActionsSnapshot');
    expect(source).toContain('고객 요청 버튼');
    expect(source).toContain('담당 메일');
    expect(source).toContain('우리 고객사에 요청 보내기');
    expect(source).toContain("destination: { type: 'email', to: draft.recipientEmail.trim() }");
    expect(source).toContain('requestActions: requestActionsSnapshot(requestAction)');
    expect(source).toContain('수신 주소는 고객 화면에 노출되지 않습니다');
    expect(source).toContain('발송 완료로 표시되지 않습니다');
  });

  it('prepares immutable Knowledge changes as a new deployment version and preserves rollback', () => {
    expect(source).toContain('DeploymentVersionPanel');
    expect(source).toContain('새 버전 준비');
    expect(source).toContain('Knowledge 구성');
    expect(source).toContain('추가 {added.length}');
    expect(source).toContain('제외 {removed.length}');
    expect(source).toContain('만들고 활성화');
    expect(source).toContain('로 되돌리기');
    expect(source).toContain('createDeployment(service.id');
    expect(source).toContain('rollbackDeployment(service.id');
    expect(store).toContain('/deployments`');
    expect(store).toContain('/rollback');
  });

  it('uses a list-to-detail structure for many deployed agents', () => {
    expect(source).toContain('selectedServiceId');
    expect(source).toContain('ServiceListItem');
    expect(source).toContain('배포된 에이전트');
    expect(source).toContain('베이스 팀원');
    expect(source).toContain('현재 배포');
    expect(source).toContain('고정된 Knowledge');
    expect(source).toContain('ConversationHistoryPanel');
    expect(source).toContain('과거 대화');
    expect(source).toContain('getConversations');
  });

  it('uses agent external deployment as the product term instead of website deployment', () => {
    expect(source).toContain('에이전트 외부 배포');
    expect(source).toContain('새 외부 배포');
    expect(source).toContain('외부 배포 이름');
    expect(source).not.toContain('웹사이트 배포');
    expect(source).not.toContain('웹사이트로 배포');
    expect(source).not.toContain('AI 서비스 상태 필터');
  });
});
