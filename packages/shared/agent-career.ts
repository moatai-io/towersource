export type AgentCareerLevel = 'intern' | 'practitioner' | 'manager' | 'partner';

export interface AgentCareerMetrics {
  completedWorkstreams: number;
  successfulSkillInvocations: number;
}

export interface AgentCareerStage {
  level: AgentCareerLevel;
  title: string;
  requiredCareerPoints: number;
}

// 완료한 업무 하나는 10점, 성공한 Skill 활용 한 번은 1점이다.
// 따라서 Skill을 직접 만들지 않아도 업무 완료만으로 모든 직급에 도달할 수 있고,
// 반복 가능한 Skill 활용은 성장을 보조한다.
export const DEFAULT_AGENT_CAREER_STAGES: readonly AgentCareerStage[] = [
  { level: 'intern', title: '인턴', requiredCareerPoints: 0 },
  { level: 'practitioner', title: '실무자', requiredCareerPoints: 30 },
  { level: 'manager', title: '매니저', requiredCareerPoints: 100 },
  { level: 'partner', title: '파트너', requiredCareerPoints: 250 },
] as const;

const AGENT_CAREER_LEVEL_ORDER: readonly AgentCareerLevel[] = ['intern', 'practitioner', 'manager', 'partner'];

export function agentCareerPoints(metrics: AgentCareerMetrics): number {
  return Math.max(0, metrics.completedWorkstreams) * 10 + Math.max(0, metrics.successfulSkillInvocations);
}

export function deriveAgentCareerLevel(metrics: AgentCareerMetrics): AgentCareerLevel {
  const points = agentCareerPoints(metrics);
  return [...DEFAULT_AGENT_CAREER_STAGES].reverse().find((stage) => points >= stage.requiredCareerPoints)?.level || 'intern';
}

export function highestAgentCareerLevel(...levels: AgentCareerLevel[]): AgentCareerLevel {
  return levels.reduce((highest, level) => AGENT_CAREER_LEVEL_ORDER.indexOf(level) > AGENT_CAREER_LEVEL_ORDER.indexOf(highest) ? level : highest, 'intern');
}

export function nextAgentCareerStage(current: AgentCareerLevel): AgentCareerStage | null {
  const index = DEFAULT_AGENT_CAREER_STAGES.findIndex((stage) => stage.level === current);
  return index >= 0 ? DEFAULT_AGENT_CAREER_STAGES[index + 1] || null : DEFAULT_AGENT_CAREER_STAGES[1];
}

export function agentCareerProgress(current: AgentCareerLevel, metrics: AgentCareerMetrics) {
  const stage = nextAgentCareerStage(current);
  if (!stage) return { stage: null, eligible: false, requirements: [] };
  const points = agentCareerPoints(metrics);
  const requirements = [{ metric: 'careerPoints' as const, label: '성장 점수', value: points, target: stage.requiredCareerPoints, met: points >= stage.requiredCareerPoints }];
  return { stage, eligible: requirements.every((item) => item.met), requirements };
}
