export type ComposerActionIntent = 'continue' | 'replan';

export interface ComposerAction {
  id: string;
  contextRevision: number;
  label: string;
  message: string;
  intent: ComposerActionIntent;
  risk: 'read_only' | 'reversible';
  origin: 'tower_rule';
  autoEligible: boolean;
  rationaleCode: string;
}

export interface ComposerActionResponse {
  contextRevision: number;
  mode: 'guide';
  source: 'tower_rule';
  recommendedActionId: string | null;
  actions: ComposerAction[];
  autoMode: { available: false; status: 'coming_soon' };
}

function localized(language: string) {
  const ko = language.toLowerCase().startsWith('ko');
  return {
    continue: ko ? '계속 진행' : 'Continue',
    replan: ko ? '내용 정리' : 'Prepare handoff',
    replanMessage: ko
      ? '현재 대화와 작업 상태를 다음 세션이나 다른 에이전트가 바로 이어받을 수 있는 handoff 자료로 정리해줘. 결정, 완료한 일, 남은 일, 주의사항, 관련 파일과 추천 스킬을 포함해줘'
      : 'Prepare a concise handoff from this conversation so another session or agent can continue immediately. Include decisions, completed work, remaining work, cautions, relevant files, and recommended skills',
  };
}

export function buildComposerActions(input: {
  latestAssistantText: string;
  contextRevision: number;
  language?: string;
}): ComposerActionResponse {
  const copy = localized(input.language || 'en');
  const actions: ComposerAction[] = [
    { id: 'continue', contextRevision: input.contextRevision, label: copy.continue, message: copy.continue, intent: 'continue', risk: 'reversible', origin: 'tower_rule', autoEligible: false, rationaleCode: 'human_choice' },
    { id: 'replan', contextRevision: input.contextRevision, label: copy.replan, message: copy.replanMessage, intent: 'replan', risk: 'reversible', origin: 'tower_rule', autoEligible: false, rationaleCode: 'human_choice' },
  ];
  return {
    contextRevision: input.contextRevision,
    mode: 'guide',
    source: 'tower_rule',
    recommendedActionId: null,
    actions,
    autoMode: { available: false, status: 'coming_soon' },
  };
}
