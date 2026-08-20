import i18n from '../i18n';

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

function tourText(key: string): string {
  return i18n.t(`tour.${key}`, { ns: 'layout' });
}

function beginnerTour(): TourDefinition {
  return {
    id: 'beginner',
    title: tourText('title'),
    steps: [
      { id: 'menu', target: '[data-tour-id="app-menu"]', title: tourText('menuTitle'), description: tourText('menuDescription'), placement: 'bottom' },
      { id: 'nav', target: '[data-tour-id="main-nav"]', title: tourText('navTitle'), description: tourText('navDescription'), placement: 'bottom' },
      { id: 'sidebar', target: '[data-tour-id="sidebar"]', title: tourText('sidebarTitle'), description: tourText('sidebarDescription'), placement: 'right' },
      { id: 'chat-input', target: '[data-tour-id="chat-input"]', title: tourText('chatTitle'), description: tourText('chatDescription'), placement: 'top' },
      { id: 'workspace-tabs', target: '[data-tour-id="file-tabbar"]', title: tourText('tabsTitle'), description: tourText('tabsDescription'), placement: 'bottom' },
      { id: 'agent-create', target: '[data-tour-id="agent-create"]', title: tourText('agentTitle'), description: tourText('agentDescription'), placement: 'bottom', scene: 'ai-team-home' },
    ],
  };
}

export const tourRegistry: Record<string, () => TourDefinition> = {
  beginner: beginnerTour,
};

export function getTourDefinition(tourId: string): TourDefinition | null {
  return tourRegistry[tourId]?.() ?? null;
}
