export type TourPlacement = 'top' | 'right' | 'bottom' | 'left';

export type TourScene = 'default' | 'ai-team-home';

export interface TourStep {
  id: string;
  target: string;
  title: string;
  description: string;
  placement?: TourPlacement;
  scene?: TourScene;
}

export interface TourDefinition {
  id: string;
  title: string;
  steps: TourStep[];
}

export const tourRegistry: Record<string, TourDefinition> = {
  beginner: {
    id: 'beginner',
    title: 'Tower 화면 둘러보기',
    steps: [
      {
        id: 'menu',
        target: '[data-tour-id="app-menu"]',
        title: '언제든 다시 보는 타워 가이드',
        description: '이 가이드는 왼쪽 위 메뉴의 ‘타워 가이드’에서 언제든 다시 시작할 수 있습니다. 도움말, 스킬, 설정도 같은 메뉴에 있습니다.',
        placement: 'bottom',
      },
      {
        id: 'nav',
        target: '[data-tour-id="main-nav"]',
        title: 'AI 팀과 채널을 오가는 상단 메뉴',
        description: '‘AI 팀’에서는 팀원별 업무를 이어가고, ‘채널’에서는 사람과 AI가 함께 협업합니다. 개인 자료와 운영 기능은 왼쪽 위 메뉴에서 찾을 수 있습니다.',
        placement: 'bottom',
      },
      {
        id: 'sidebar',
        target: '[data-tour-id="sidebar"]',
        title: 'Work, AI Team, AI 팀원',
        description: 'Work에서 모든 AI와 이어온 최근 업무를 찾고, AI Team에서 팀원과 역할, 팀 현황을 봅니다. AI 팀원을 고르면 그 팀원의 홈과 대화로 들어갈 수 있습니다.',
        placement: 'right',
      },
      {
        id: 'chat-input',
        target: '[data-tour-id="chat-input"]',
        title: '결과와 목적을 자연어로 맡기기',
        description: '실제 팀원에게 말하듯 원하는 결과와 쓰임을 함께 말하세요. 필요한 결정이 있으면 AI가 선택지를 질문하고, 답변은 대화에 기록됩니다.',
        placement: 'top',
      },
      {
        id: 'workspace-tabs',
        target: '[data-tour-id="file-tabbar"]',
        title: '대화, 팀원 홈, 결과물을 한곳에서',
        description: '대화와 팀원 홈, 문서·PDF 같은 결과물이 탭으로 열립니다. 자주 쓰는 탭은 더블클릭하거나 우클릭해 고정할 수 있습니다.',
        placement: 'bottom',
      },
      {
        id: 'agent-create',
        target: '[data-tour-id="agent-create"]',
        title: '필요할 때 새 AI 팀원 합류시키기',
        description: 'AI 팀 홈에서 ‘새 AI 팀원’을 누르고 이름과 기대하는 전문성부터 정하세요. 세부 역할과 업무 방식은 합류 후 실제 일을 함께하며 맞춰갑니다.',
        placement: 'bottom',
        scene: 'ai-team-home',
      },
    ],
  },
};

export function getTourDefinition(tourId: string): TourDefinition | null {
  return tourRegistry[tourId] ?? null;
}
