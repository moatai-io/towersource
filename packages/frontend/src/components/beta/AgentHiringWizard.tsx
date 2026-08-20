import React from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../stores/settings-store';
import { useFileStore } from '../../stores/file-store';
import { useAgentDraftStore, type AgentDraftArtifact } from '../../stores/agent-draft-store';

type AgentTemplateId = 'tower-dev' | 'company-profile' | 'proposal' | 'onboarding' | 'cs' | 'rfp' | 'research' | 'ops' | 'blank';
type SetupMode = 'chat' | 'upload' | 'later';

interface ProjectLike { id: string; name: string }
interface WorkExample {
  id: AgentTemplateId;
  emoji: string;
  title: string;
  shortTitle: string;
  levelTitle: string;
  promotionGoal: string;
  description: string;
  defaultAgentId: string;
  role: string;
  instructionBullets: string[];
  sourceHints: string[];
  preferredSkills: string[];
  sampleTask: string;
}

type AgentAcademyDraft = AgentDraftArtifact;

// These are optional starting examples, not a catalog of fixed jobs or identities.
const WORK_EXAMPLES: WorkExample[] = [
  { id: 'tower-dev', emoji: '🧑‍💻', title: 'Product & Code Work', shortTitle: '제품·코드 작업', levelTitle: 'Starting point', promotionGoal: '첫 변경안을 검증 가능한 형태로 완성하기', description: 'Tower 코드베이스를 읽고 버그 재현, RFC 작성, UI 실험, 테스트/빌드 검증까지 이어갑니다.', defaultAgentId: 'tower-dev-workcell', role: 'Tower 제품과 코드베이스를 이해하고 작은 제품 실험·버그 수정·RFC 초안·검증 로그를 연결하는 개발 Agent Workcell', instructionBullets: ['관련 결정문서와 AGENTS.md를 먼저 확인한다.', '수정 범위와 영향 범위를 짧게 밝힌다.', '코드 변경 후 typecheck/build/test 중 적절한 검증을 실행한다.', '프로덕션 restart/deploy는 사용자 요청 전 실행하지 않는다.'], sourceHints: ['/home/tower/tower/AGENTS.md', '/home/tower/tower/packages/frontend/src/', '/home/tower/tower/packages/backend/', '/home/tower/workspace/decisions/'], preferredSkills: ['plan-refine', 'strategy-copilot', 'frontend-design'], sampleTask: 'Agent-first Tower 전환을 위해 Beta 탭의 Agent Builder UX를 개선하고 검증해줘.' },
  { id: 'company-profile', emoji: '📄', title: 'Company Materials', shortTitle: '소개 자료 개선', levelTitle: 'Starting point', promotionGoal: '검토 가능한 핵심 메시지 초안 만들기', description: '회사소개서, 제안서, 영업 메시지, PDF/DOCX 산출물을 계속 축적하고 개선합니다.', defaultAgentId: 'company-profile-workcell', role: '회사소개서·제안서·영업 메시지·제품 소개 자료를 만들고 좋은 문장과 근거를 축적하는 Agent Workcell', instructionBullets: ['읽는 사람이 지금 왜 봐야 하는지부터 정리한다.', '좋은 value proposition은 messaging bank 후보로 제안한다.', '회사 정체성은 essence.md를 기준으로 삼는다.', '과장된 약속보다 실제 제품 장면과 증거를 우선한다.'], sourceHints: ['AGENTS.md', '/home/tower/workspace/docs/moatai/essence.md', '/home/tower/workspace/docs/moatai/messaging-bank.md', 'work/strategy-copilot/', 'final/'], preferredSkills: ['marketing-coach', 'great-copy', 'html-slide', 'strategy-copilot'], sampleTask: 'Tower를 처음 보는 B2B 고객이 바로 이해할 수 있는 회사소개서 첫 장 메시지를 만들어줘.' },
  { id: 'proposal', emoji: '💼', title: 'Customer Proposal Prep', shortTitle: '고객 제안 준비', levelTitle: 'Starting point', promotionGoal: '제안서 구조와 후속 질문 초안 만들기', description: '기존 제안서와 회사소개서를 참고해 제안서 초안, 후속메일, 고객 질문을 만듭니다.', defaultAgentId: 'proposal-workcell', role: '고객 미팅, 회사 자료, 기존 제안서를 바탕으로 제안서 초안·후속메일·누락 질문을 만드는 Agent Workcell', instructionBullets: ['고객 pain과 업무 병목을 먼저 정리한다.', '기존 proof와 표현을 재사용한다.', '가격·계약·외부 발송은 사용자 승인 전 확정하지 않는다.'], sourceHints: ['docs/moatai/', 'final/', 'work/strategy-copilot/', 'records/meeting-notes/'], preferredSkills: ['strategy-copilot', 'marketing-coach', 'great-copy'], sampleTask: '최근 고객 미팅 메모를 바탕으로 제안서 목차와 후속메일 초안을 만들어줘.' },
  { id: 'onboarding', emoji: '🧭', title: 'Knowledge Guidance', shortTitle: '지식 안내', levelTitle: 'Starting point', promotionGoal: '처음 참여하는 사람을 위한 안내 초안 만들기', description: '회사 문서와 매뉴얼을 읽고 신입 질문에 답하는 업무 선임을 만듭니다.', defaultAgentId: 'onboarding-workcell', role: '회사 문서, 매뉴얼, 결정 기록을 바탕으로 신입/신규 참여자의 질문에 답하는 Agent Workcell', instructionBullets: ['AGENTS.md와 결정문서를 기준으로 삼는다.', '모르는 것은 추측하지 않는다.', '반복 질문은 FAQ 후보로 정리한다.'], sourceHints: ['AGENTS.md', '.project/decisions/', 'docs/', 'records/'], preferredSkills: ['agents-md', 'explain-craft', 'wiki-compile'], sampleTask: '이 프로젝트에 처음 들어온 사람이 알아야 할 핵심 규칙과 첫 3일 체크리스트를 만들어줘.' },
  { id: 'cs', emoji: '🎧', title: 'Inquiry Response Prep', shortTitle: '문의 답변 준비', levelTitle: 'Starting point', promotionGoal: '답변 초안과 내부 확인 항목을 구분하기', description: 'FAQ와 정책 문서를 참고해 상담 답변 초안과 예외 처리 기준을 만듭니다.', defaultAgentId: 'cs-assistant-workcell', role: 'FAQ, 정책 문서, 상담 사례를 바탕으로 상담 답변 초안과 처리 기준을 제안하는 Agent Workcell', instructionBullets: ['고객 답변과 내부 판단 메모를 분리한다.', '정책 근거가 부족하면 확인 질문을 남긴다.', '민감 이슈는 사람 검토 필요로 표시한다.'], sourceHints: ['sources/faq/', 'docs/policies/', 'records/customer-support/'], preferredSkills: ['explain-craft', 'plan-refine'], sampleTask: '이 고객 문의에 대한 답변 초안과 내부 확인이 필요한 항목을 나눠서 정리해줘.' },
  { id: 'rfp', emoji: '📑', title: 'Document Requirement Review', shortTitle: '문서 요건 분석', levelTitle: 'Starting point', promotionGoal: '요건·누락 자료·리스크 초안 정리하기', description: '입찰 문서를 읽고 요건, 누락자료, 제안서 구조를 정리합니다.', defaultAgentId: 'rfp-response-workcell', role: 'RFP/입찰 문서를 분석해 제출 요건, 누락 자료, 제안서 구조, 리스크를 정리하는 Agent Workcell', instructionBullets: ['요건/제출물/마감/평가 기준을 분리한다.', '없는 내용은 표시한다.', '법적/가격/계약 조건은 최종 확정하지 않는다.'], sourceHints: ['sources/rfp/', 'final/proposals/', 'docs/company/', 'records/references/'], preferredSkills: ['plan-refine', 'strategy-copilot', 'excel-data-insight'], sampleTask: '이 RFP에서 제출 요건, 누락 자료, 제안서 목차, 주요 리스크를 정리해줘.' },
  { id: 'research', emoji: '🔎', title: 'Research & Evidence', shortTitle: '조사·근거 정리', levelTitle: 'Starting point', promotionGoal: '출처와 가설을 구분한 조사 초안 만들기', description: '웹·문서·회의 기록을 모아 경쟁사, 시장, 고객 pain, GTM 가설을 근거와 함께 정리합니다.', defaultAgentId: 'research-workcell', role: '시장/경쟁사/고객 자료를 수집·요약하고 전략 질문에 답할 evidence ledger를 만드는 Agent Workcell', instructionBullets: ['주장과 근거를 분리한다.', '불확실한 정보는 가설로 표시한다.', '출처와 최신성 한계를 명시한다.'], sourceHints: ['sources/research/', 'records/interviews/', 'work/strategy-copilot/', 'docs/'], preferredSkills: ['strategy-copilot', 'business-analyst', 'naver-search'], sampleTask: '이 시장에서 우리가 먼저 검증해야 할 고객 pain과 경쟁 대안을 정리해줘.' },
  { id: 'ops', emoji: '🗂️', title: 'Progress Coordination', shortTitle: '진행 상황 정리', levelTitle: 'Starting point', promotionGoal: '현재 상태와 다음 액션을 검토 가능한 형태로 정리하기', description: '프로젝트 진행상황, 결정, 다음 액션, 리스크를 정리하고 반복 운영 루틴을 제안합니다.', defaultAgentId: 'ops-pm-workcell', role: '프로젝트의 진행상황, 결정, 리스크, 다음 액션을 정리하고 운영 루틴을 개선하는 Agent Workcell', instructionBullets: ['상태와 다음 액션을 evidence-checkable하게 정리한다.', '결정과 단순 메모를 구분한다.', '반복 업무는 automation 또는 skill 후보로 제안한다.'], sourceHints: ['.project/progress.md', '.project/decisions/', 'records/', 'work/'], preferredSkills: ['handoff', 'agents-md', 'plan-premortem'], sampleTask: '이 프로젝트의 현재 진행상황, 막힌 점, 다음 3개 액션을 정리해줘.' },
  { id: 'blank', emoji: '✨', title: 'New AI Teammate', shortTitle: '직접 설명하기', levelTitle: 'Starting point', promotionGoal: '첫 업무와 완료 기준을 함께 정하기', description: '원하는 도움, 참고할 자료, 첫 업무를 직접 설명해 초안을 만듭니다.', defaultAgentId: 'custom-workcell', role: '사용자가 지정한 업무를 반복 수행하고 개선하는 Agent Workcell', instructionBullets: ['사용자가 지정한 업무 범위 안에서만 실행한다.', '반복 절차는 progress/decision/skill 후보로 제안한다.', '외부 발송·삭제·배포는 먼저 확인한다.'], sourceHints: ['AGENTS.md', 'work/', 'sources/', 'final/'], preferredSkills: [], sampleTask: '이 Agent가 맡을 첫 번째 업무를 설명해줘.' },
];

function authHeaders() { const token = localStorage.getItem('token'); return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }; }
async function apiJson<T>(url: string, opts?: RequestInit): Promise<T> { const res = await fetch(url, { ...opts, headers: { ...authHeaders(), ...(opts?.headers || {}) } }); const data = await res.json().catch(() => ({})); if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`); return data as T; }
function slugifyAgentId(value: string) { return value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-').slice(0, 64) || 'custom-workcell'; }
function inferWorkExample(text: string): WorkExample { if (/(tower|frontend|backend|typescript|react|vite|api|bug|버그|코드|개발)/i.test(text)) return WORK_EXAMPLES[0]; if (/(회사소개|소개서|브로슈어|브랜드|소개)/i.test(text)) return WORK_EXAMPLES[1]; if (/(proposal|제안서|영업|sales|고객사)/i.test(text)) return WORK_EXAMPLES[2]; if (/(rfp|입찰|제안요청|공고|tender|요건|제출)/i.test(text)) return WORK_EXAMPLES[5]; if (/(faq|cs|상담|문의|고객센터|환불|정책)/i.test(text)) return WORK_EXAMPLES[4]; if (/(온보딩|매뉴얼|manual|handbook|가이드|교육|신입)/i.test(text)) return WORK_EXAMPLES[3]; if (/(시장|경쟁|리서치|research|뉴스|trend|트렌드|고객 인터뷰)/i.test(text)) return WORK_EXAMPLES[6]; if (/(progress|pm|운영|프로젝트|회의록|결정|todo|액션)/i.test(text)) return WORK_EXAMPLES[7]; return WORK_EXAMPLES.find((t) => t.id === 'blank')!; }
function workExampleFromAcademyId(id: string): WorkExample { const map: Record<string, AgentTemplateId> = { dev: 'tower-dev', 'company-profile': 'company-profile', cs: 'cs', rfp: 'rfp', ops: 'ops', custom: 'blank' }; return WORK_EXAMPLES.find((t) => t.id === (map[id] || id)) || WORK_EXAMPLES.find((t) => t.id === 'blank')!; }
function buildInstruction(example: WorkExample, workScope: string, extra: string, sources: string) { const sourceLines = sources.split('\n').map((l) => l.trim()).filter(Boolean); return [`주로 도울 일: ${workScope.trim() || example.role}`, '', '시작 운영 원칙:', ...example.instructionBullets.map((x) => `- ${x}`), '', sourceLines.length ? '우선 참고할 자료 범위:' : '', ...sourceLines.map((x) => `- ${x}`), '', example.preferredSkills.length ? '필요할 때 참고할 스킬 예시:' : '', ...example.preferredSkills.map((x) => `- ${x}`), '', extra.trim() ? '사용자가 덧붙인 설정:' : '', extra.trim()].filter((x) => x !== '').join('\n'); }
function buildAgentDraftArtifact(draft: AgentAcademyDraft | null, fallback: { face: string; agentName: string; levelTitle: string; role: string; sources: string; firstTask: string; promotionGoal: string }): AgentDraftArtifact {
  return {
    status: 'draft',
    face: draft?.face || fallback.face,
    name: draft?.name || fallback.agentName,
    levelTitle: draft?.levelTitle || fallback.levelTitle,
    role: draft?.role || fallback.role,
    capabilities: draft?.capabilities?.length ? draft.capabilities : ['원하는 도움을 작업 범위로 정리합니다.', '첫 업무와 완료 기준을 제안합니다.', '실제 사용을 바탕으로 운영 기준을 다듬습니다.'],
    sourceHints: draft?.sourceHints?.length ? draft.sourceHints : fallback.sources.split('\n').map((s) => s.trim()).filter(Boolean),
    firstTask: draft?.firstTask || fallback.firstTask,
    promotionGoal: draft?.promotionGoal || fallback.promotionGoal,
    assumptions: draft?.assumptions || [],
  };
}

export function AgentHiringWizard({ projects, projectId, setProjectId }: { projects: ProjectLike[]; projectId: string; setProjectId: (id: string) => void }) {
  const { t } = useTranslation('common');
  const setAgentsPanelOpen = useSettingsStore((s) => s.setAgentsPanelOpen);
  const setCapabilityProjectId = useSettingsStore((s) => s.setCapabilityProjectId);
  const openTab = useFileStore((s) => s.openTab);
  const setDraft = useAgentDraftStore((s) => s.setDraft);
  const updateDraft = useAgentDraftStore((s) => s.updateDraft);
  const storeDraft = useAgentDraftStore((s) => s.currentDraft);
  const [templateId, setTemplateId] = React.useState<AgentTemplateId>('blank');
  const template = React.useMemo(() => WORK_EXAMPLES.find((x) => x.id === templateId) || WORK_EXAMPLES.find((x) => x.id === 'blank')!, [templateId]);
  const [agentId, setAgentId] = React.useState(template.defaultAgentId);
  const [agentName, setAgentName] = React.useState(template.title);
  const [face, setFace] = React.useState(template.emoji);
  const [role, setRole] = React.useState(template.role);
  const [sources, setSources] = React.useState(template.sourceHints.join('\n'));
  const [extraInstruction, setExtraInstruction] = React.useState('');
  const [setupMode, setSetupMode] = React.useState<SetupMode>('chat');
  const [foundryInput, setFoundryInput] = React.useState('');
  const [materialInput, setMaterialInput] = React.useState('');
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [drafting, setDrafting] = React.useState(false);
  const [academyDraft, setAcademyDraft] = React.useState<AgentAcademyDraft | null>(null);
  const [created, setCreated] = React.useState<{ id: string; displayName: string; command: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const applyTemplate = React.useCallback((next: WorkExample, reason?: string) => {
    const nextSources = next.sourceHints.join('\n');
    setTemplateId(next.id); setAgentId(next.defaultAgentId); setAgentName(next.title); setFace(next.emoji); setRole(next.role); setSources(nextSources); setAcademyDraft(null); setCreated(null);
    setDraft(buildAgentDraftArtifact(null, { face: next.emoji, agentName: next.title, levelTitle: next.levelTitle, role: next.role, sources: nextSources, firstTask: next.sampleTask, promotionGoal: next.promotionGoal }));
    if (reason) setExtraInstruction(`업무 예시에서 시작한 초안입니다.\n- 참고한 예시: ${reason}\n- 이 예시를 고정 역할로 취급하지 말고 사용자의 실제 요청에 맞춰 작업 범위를 조정합니다.`);
    else setExtraInstruction('');
  }, [setDraft]);

  const changeFace = React.useCallback((emoji: string) => {
    setFace(emoji);
    updateDraft({ face: emoji });
    setCreated(null);
  }, [updateDraft]);

  const changeAgentName = React.useCallback((value: string) => {
    setAgentName(value);
    updateDraft({ name: value });
    setCreated(null);
  }, [updateDraft]);

  React.useEffect(() => {
    if (!storeDraft) return;
    if (storeDraft.face && storeDraft.face !== face) setFace(storeDraft.face);
    if (storeDraft.name && storeDraft.name !== agentName) setAgentName(storeDraft.name);
    if (storeDraft.role && storeDraft.role !== role) setRole(storeDraft.role);
  }, [agentName, face, role, storeDraft]);

  const suggestDraft = async () => {
    const text = [foundryInput, materialInput].filter(Boolean).join('\n');
    setDrafting(true); setError(null);
    try {
      const draft = await apiJson<AgentAcademyDraft>('/api/agents/academy/draft', { method: 'POST', body: JSON.stringify({ intent: foundryInput, material: materialInput }) });
      const next = workExampleFromAcademyId(draft.templateId || 'blank');
      setTemplateId(next.id);
      setAgentId(slugifyAgentId(draft.name.replace(/Agent$/i, 'workcell')));
      changeAgentName(draft.name);
      changeFace(draft.face || next.emoji);
      setRole(draft.role || next.role);
      setSources((draft.sourceHints || next.sourceHints).join('\n'));
      setAcademyDraft(draft);
      setDraft(draft);
      setCreated(null);
      setExtraInstruction(`사용자 설명에서 만든 작업 범위 초안:\n- 원하는 도움: ${text || next.description}\n- 예상 작업:\n${draft.capabilities.map((item) => `  - ${item}`).join('\n')}\n- 첫 업무 예시: ${draft.firstTask}`);
      openDraftInViewer(draft);
    } catch (err: any) {
      const inferred = inferWorkExample(text || template.description);
      applyTemplate(inferred, text || inferred.description);
      setError(err?.message || t('agentAcademy.error.draftFallback'));
    } finally {
      setDrafting(false);
    }
  };

  const currentFirstTask = academyDraft?.firstTask || storeDraft?.firstTask || template.sampleTask;
  const currentPromotionGoal = academyDraft?.promotionGoal || storeDraft?.promotionGoal || template.promotionGoal;
  const currentCapabilities = academyDraft?.capabilities?.length ? academyDraft.capabilities : storeDraft?.capabilities;

  const openDraftInViewer = React.useCallback((draftOverride?: AgentAcademyDraft | null) => {
    const draft = draftOverride ?? storeDraft ?? academyDraft;
    const artifact = buildAgentDraftArtifact(draft, {
      face,
      agentName,
      levelTitle: template.levelTitle,
      role,
      sources,
      firstTask: template.sampleTask,
      promotionGoal: template.promotionGoal,
    });
    const safeName = slugifyAgentId(draft?.name || agentName || 'agent-draft');
    openTab(`agent-drafts/${safeName}.agent-draft.json`, JSON.stringify(artifact, null, 2), 'agent-draft', undefined, { split: 'right' });
    setDraft(artifact);
  }, [academyDraft, agentName, face, openTab, role, setDraft, sources, storeDraft, template.levelTitle, template.promotionGoal, template.sampleTask]);

  const createAgent = async () => {
    if (!projectId) { setError(t('agentAcademy.error.selectWorkspace')); return; }
    const cleanId = slugifyAgentId(agentId);
    setCreating(true); setError(null); setCreated(null);
    try {
      await apiJson('/api/agents', { method: 'POST', body: JSON.stringify({ projectId, definition: { id: cleanId, displayName: `${face} ${agentName.trim() || template.title}`, role: role.trim() || template.role, instruction: buildInstruction(template, role, extraInstruction, sources), goal: `${role.trim() || template.role} 첫 업무를 완료하고, 실제 사용을 통해 작업 범위와 운영 기준을 계속 다듬는다.`, engine: 'pi', visibility: 'sidebar', permissions: { cwdBinding: 'project', canModifyAgentsMd: 'propose-only', canRegisterSkills: 'propose-only', canPublishExternal: false, sourceHints: sources.split('\n').map((l) => l.trim()).filter(Boolean), level: 0, levelTitle: 'Starting point', promotionGoal: currentPromotionGoal, face }, report: { style: 'concise', sampleTask: currentFirstTask, preferredSkills: template.preferredSkills, setupMode, startingExampleId: template.id === 'blank' ? undefined : template.id } } }) });
      setCreated({ id: cleanId, displayName: `${face} ${agentName.trim() || template.title}`, command: `/agent ${cleanId} ${currentFirstTask}` });
    } catch (err: any) { setError(err?.message || t('agentAcademy.error.create')); } finally { setCreating(false); }
  };
  const startChat = () => { if (!created || !projectId) return; setCapabilityProjectId(projectId); window.dispatchEvent(new CustomEvent('tower-run-agent-command', { detail: { command: created.command } })); };
  const openAdvanced = () => { if (!created || !projectId) return; setCapabilityProjectId(projectId); window.dispatchEvent(new CustomEvent('tower-select-agent-definition', { detail: { projectId, agentId: created.id } })); setAgentsPanelOpen(true); };

  return <section className="min-h-[72vh] rounded-3xl border border-primary-500/25 bg-gradient-to-br from-primary-500/10 via-surface-900/95 to-surface-950 p-5 md:p-7">
    <div className="mb-6"><div className="inline-flex rounded-full border border-primary-500/30 bg-primary-500/10 px-3 py-1 text-xs font-semibold text-primary-300">Agent Academy · Beta</div><h2 className="mt-3 text-3xl font-black tracking-tight text-surface-100">{t('agentAcademy.title')}</h2><p className="mt-2 max-w-4xl text-sm leading-6 text-surface-300">{t('agentAcademy.description')}</p></div>
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="rounded-3xl border border-surface-700/70 bg-surface-900/70 p-4 md:p-5 space-y-4">
        <div className="flex items-start gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary-500/20 text-xl">🏗️</div><div className="rounded-2xl rounded-tl-sm bg-surface-950/80 px-4 py-3 text-sm leading-6 text-surface-200">{t('agentAcademy.introBefore')} <b>{t('agentAcademy.ongoingRole')}</b>{t('agentAcademy.introAfter')}</div></div>
        <label className="block text-xs font-semibold text-surface-400 space-y-2">{t('agentAcademy.rolePrompt')}<textarea value={foundryInput} onChange={(e) => setFoundryInput(e.target.value)} rows={4} className="w-full rounded-2xl bg-surface-950 border border-surface-700 px-4 py-3 text-sm leading-6 text-gray-100 outline-none focus:border-primary-500" /></label>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-3">{(['chat', 'upload', 'later'] as SetupMode[]).map((m) => <button key={m} type="button" onClick={() => setSetupMode(m)} className={`rounded-2xl border px-4 py-3 text-left text-xs ${setupMode === m ? 'border-primary-400 bg-primary-500/15 text-primary-300' : 'border-surface-700 bg-surface-950 text-surface-400 hover:border-surface-500'}`}><b>{m === 'chat' ? t('agentAcademy.mode.chatTitle') : m === 'upload' ? t('agentAcademy.mode.uploadTitle') : t('agentAcademy.mode.laterTitle')}</b><br />{m === 'chat' ? t('agentAcademy.mode.chatDescription') : m === 'upload' ? t('agentAcademy.mode.uploadDescription') : t('agentAcademy.mode.laterDescription')}</button>)}</div>
        {setupMode === 'upload' && <label className="block rounded-2xl border border-dashed border-surface-700 bg-surface-950/50 p-4 text-xs font-semibold text-surface-400 space-y-2">{t('agentAcademy.materialQuestion')} <span className="font-normal text-surface-600">{t('agentAcademy.materialHint')}</span><textarea value={materialInput} onChange={(e) => setMaterialInput(e.target.value)} rows={3} placeholder={t('agentAcademy.materialPlaceholder')} className="w-full rounded-xl bg-surface-950 border border-surface-700 px-3 py-3 font-mono text-xs text-gray-100" /></label>}
        <div><div className="mb-1 text-xs font-semibold text-surface-400">{t('agentAcademy.workExamples')}</div><p className="mb-2 text-xs leading-5 text-surface-600">{t('agentAcademy.workExamplesHint')}</p><div className="flex flex-wrap gap-2">{WORK_EXAMPLES.filter((t) => t.id !== 'blank').map((t) => <button key={t.id} type="button" onClick={() => applyTemplate(t, t.description)} className={`rounded-full border px-3 py-1.5 text-xs ${templateId === t.id ? 'border-primary-400 bg-primary-500/15 text-primary-300' : 'border-surface-700 bg-surface-950 text-surface-400 hover:border-surface-500'}`}>{t.emoji} {t.shortTitle}</button>)}</div></div>
        <div className="flex flex-wrap gap-3"><button type="button" onClick={suggestDraft} disabled={drafting} className="rounded-xl bg-primary-500 px-4 py-2 text-sm font-bold text-white hover:bg-primary-400 disabled:opacity-60">{drafting ? t('agentAcademy.drafting') : t('agentAcademy.suggestDraft')}</button><button type="button" onClick={() => openDraftInViewer()} className="rounded-xl border border-primary-500/40 bg-primary-500/10 px-4 py-2 text-sm font-semibold text-primary-300 hover:bg-primary-500/15">{t('agentAcademy.openViewer')}</button><button type="button" onClick={() => setAdvancedOpen(!advancedOpen)} className="rounded-xl border border-surface-700 bg-surface-950 px-4 py-2 text-sm font-semibold text-surface-300 hover:border-surface-500">{advancedOpen ? t('agentAcademy.hideAdvanced') : t('agentAcademy.advanced')}</button></div>
        {advancedOpen && <div className="rounded-2xl border border-surface-700 bg-surface-950/60 p-4 space-y-3"><div className="grid grid-cols-1 gap-3 md:grid-cols-2"><label className="text-xs font-semibold text-surface-400 space-y-1">{t('agentAcademy.name')}<input value={agentName} onChange={(e) => changeAgentName(e.target.value)} className="w-full rounded-lg bg-surface-950 border border-surface-700 px-3 py-2 text-sm text-gray-100" /></label><label className="text-xs font-semibold text-surface-400 space-y-1">{t('agentAcademy.workspace')}<select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="w-full rounded-lg bg-surface-950 border border-surface-700 px-3 py-2 text-sm text-gray-100"><option value="">{t('agentAcademy.selectWorkspace')}</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label></div><label className="block text-xs font-semibold text-surface-400 space-y-1">Agent ID<input value={agentId} onChange={(e) => setAgentId(slugifyAgentId(e.target.value))} className="w-full rounded-lg bg-surface-950 border border-surface-700 px-3 py-2 font-mono text-sm text-gray-100" /></label><label className="block text-xs font-semibold text-surface-400 space-y-1">{t('agentAcademy.sourceScope')}<textarea value={sources} onChange={(e) => setSources(e.target.value)} rows={3} className="w-full rounded-xl bg-surface-950 border border-surface-700 px-3 py-3 font-mono text-xs text-gray-100" /></label></div>}
      </div>
      <aside className="rounded-3xl border border-surface-700/70 bg-surface-950/75 p-5 space-y-5">
        <div className="flex items-start justify-between gap-3"><div><div className="text-xs font-semibold uppercase tracking-wider text-surface-500">Agent Draft</div><h3 className="mt-2 text-2xl font-black text-surface-100">{agentName}</h3><div className="mt-1 text-sm font-semibold text-primary-300">{storeDraft?.levelTitle || template.levelTitle}</div></div><div className="flex h-20 w-20 items-center justify-center rounded-3xl border border-primary-500/30 bg-primary-500/10 text-5xl">{face}</div></div>
        <div><div className="mb-2 text-xs font-bold text-surface-500">{t('agentAcademy.chooseFace')}</div><div className="flex flex-wrap gap-2">{['🧑‍💻','📄','💼','🎧','📑','🔎','🗂️','🧭','✨','🤖'].map((emoji) => <button key={emoji} type="button" onClick={() => changeFace(emoji)} className={`flex h-9 w-9 items-center justify-center rounded-xl border text-xl ${face === emoji ? 'border-primary-400 bg-primary-500/20' : 'border-surface-700 bg-surface-900 hover:border-surface-500'}`}>{emoji}</button>)}</div></div>
        <div className="rounded-2xl border border-surface-800 bg-surface-900/70 p-4"><div className="text-xs font-bold text-surface-500">{t('agentAcademy.workScope')}</div><p className="mt-2 text-sm leading-6 text-surface-300">{role}</p></div>
        {currentCapabilities?.length ? <div className="rounded-2xl border border-surface-800 bg-surface-900/70 p-4"><div className="text-xs font-bold text-surface-500">{t('agentAcademy.capabilities')}</div><ul className="mt-2 space-y-1 text-sm leading-6 text-surface-300">{currentCapabilities.map((item) => <li key={item}>• {item}</li>)}</ul></div> : null}
        <div className="rounded-2xl border border-amber-500/25 bg-amber-500/10 p-4 text-sm text-amber-100"><div className="text-xs font-bold uppercase tracking-wider text-amber-200/80">{t('agentAcademy.firstSuccess')}</div><div className="mt-1 font-semibold">{currentPromotionGoal}</div>{currentFirstTask ? <div className="mt-3 border-t border-amber-300/20 pt-3 text-xs leading-5 text-amber-100/90"><b>{t('agentAcademy.firstTask')}</b><br />{currentFirstTask}</div> : null}</div>
        <div className="space-y-2"><button onClick={createAgent} disabled={creating || !projectId} className="w-full rounded-xl bg-emerald-500 px-4 py-3 text-sm font-black text-white hover:bg-emerald-400 disabled:opacity-50">{creating ? t('agentAcademy.preparing') : t('agentAcademy.start')}</button>{created && <button onClick={startChat} className="w-full rounded-xl bg-primary-500 px-4 py-3 text-sm font-black text-white hover:bg-primary-400">{t('agentAcademy.startChat')}</button>}{created && <button onClick={openAdvanced} className="w-full rounded-xl border border-surface-700 px-4 py-2 text-sm font-semibold text-surface-300 hover:border-surface-500">{t('agentAcademy.openManagement')}</button>}{error && <div className="text-sm text-red-300">{error}</div>}</div>
      </aside>
    </div>
  </section>;
}

export default AgentHiringWizard;
