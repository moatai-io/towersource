export type ChangelogLanguage = 'en' | 'ko';

export interface LocalizedChangelogText {
  en: string;
  ko: string;
}

export interface ChangelogEntry {
  version: string;
  date: string;
  title: LocalizedChangelogText;
  items: { emoji: string; text: LocalizedChangelogText }[];
}

export function changelogLanguage(language?: string): ChangelogLanguage {
  return language?.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '1.0.0',
    date: '2026-04',
    title: { en: 'Tower 1.0 — Ready to ship ✨', ko: 'Tower 1.0 — 진짜 배포 ✨' },
    items: [
      { emoji: '🏷️', text: { en: 'Semantic Versioning with version, git SHA, and build time exposed through `/api/health`', ko: 'Semantic Versioning 도입 — `/api/health`에 버전·gitSha·빌드 시각 노출' } },
      { emoji: '📜', text: { en: 'Conventional Commits and automatic changelog generation through `npm run release`', ko: 'Conventional Commits → 자동 CHANGELOG (`npm run release`)' } },
      { emoji: '🧩', text: { en: 'Level-one session backlinks for finding other sessions that edited the same file', ko: '세션 백링크 레벨 1 — 같은 파일을 편집한 다른 세션을 우클릭으로 탐색' } },
      { emoji: '🔁', text: { en: 'PM2 development server and a 4 a.m. restart to prevent zombie processes', ko: 'Dev 서버 PM2 + 새벽 4시 자동 재시작으로 좀비 프로세스 예방' } },
      { emoji: '🚚', text: { en: 'Self-hosted deployment profiles for standalone, managed, and full installations', ko: '자체 호스팅 서버 프로필 배포 체계 (standalone / managed / full) 정착' } },
    ],
  },
  {
    version: '0.2.0',
    date: '2026-04',
    title: { en: 'Smarter and faster ⚡', ko: '더 똑똑하고, 더 빠르게 ⚡' },
    items: [
      { emoji: '🧠', text: { en: 'Claude account rotation with project-level credential isolation', ko: 'Claude 계정 로테이션 — 프로젝트별 자격 격리로 안정적 AI 운영' } },
      { emoji: '💭', text: { en: 'ThinkingBlock for following AI reasoning progress in real time', ko: 'ThinkingBlock — AI 사고 과정을 실시간으로 확인' } },
      { emoji: '📨', text: { en: 'Persistent Inbox and channel AI sessions so conversation context survives', ko: 'Inbox 패널 & 채널 AI 세션 영속화 — 대화 맥락이 끊기지 않음' } },
      { emoji: '🎛️', text: { en: 'Progressive Disclosure UI across header tabs, app menus, and sidebar filters', ko: 'Progressive Disclosure UI — 헤더 탭, 앱 메뉴, 사이드바 필터 개편' } },
      { emoji: '📄', text: { en: 'In-viewer previews for Office documents including DOCX and PDF', ko: 'Office 문서 미리보기 — DOCX, PDF 등 파일 뷰어에서 바로 확인' } },
      { emoji: '🚀', text: { en: 'Faster virtual scrolling, pagination, and session switching', ko: '성능 대폭 개선 — 가상화 스크롤, 페이지네이션, 세션 전환 속도 향상' } },
      { emoji: '🔔', text: { en: 'Telegram and Kakao notification connections', ko: 'Telegram & Kakao 알림 연동' } },
      { emoji: '🛡️', text: { en: 'Stronger API access control, WebSocket authentication, and ToolGuard protection', ko: '보안 강화 — API 접근제어, WebSocket 인증, ToolGuard 적용' } },
      { emoji: '📖', text: { en: 'Help and onboarding with eight in-app guides and a Welcome Bot', ko: 'Help 시스템 & 온보딩 — 앱 내 가이드 8종 + 신규 사용자 Welcome Bot' } },
    ],
  },
  {
    version: '0.1.0',
    date: '2026-04',
    title: { en: 'Tower launches 🎉', ko: 'Tower 첫 출시 🎉' },
    items: [
      { emoji: '💬', text: { en: 'One-to-one AI conversation sessions', ko: 'AI와 1:1 대화 세션 (Sessions)' } },
      { emoji: '📢', text: { en: 'Team channels and `@ai` / `@task` commands', ko: '팀 채널 & @ai/@task 명령어 (Channels)' } },
      { emoji: '📊', text: { en: 'Eighteen dynamic visual types including charts, diagrams, and tables', ko: 'Dynamic Visual — 차트·다이어그램·테이블 등 18종 렌더링' } },
      { emoji: '📁', text: { en: 'File browser and project management', ko: '파일 브라우저 & 프로젝트 관리' } },
      { emoji: '🔌', text: { en: 'Slack, Notion, Gmail, and n8n MCP connections', ko: 'Slack·Notion·Gmail·n8n MCP 연동' } },
    ],
  },
];
