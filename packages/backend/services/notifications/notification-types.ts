/**
 * Owns: Notification event/channel type vocabulary for Tower.
 * Public API: normalizeNotificationType, DEFAULT_NOTIFICATION_EVENTS.
 * See: workspace/decisions/2026-06-05-notification-center-browser-pwa-plan.md.
 */

export type NotificationChannel = 'in_app' | 'toast' | 'web_push';
export type NotificationPriority = 'low' | 'normal' | 'high' | 'urgent';

/**
 * UI expression level. Low events should generally be inline/silent and should
 * not become persistent notification-center entries unless undo/history matters.
 */
export type NotificationUiLevel = 'low' | 'medium' | 'high';

export const PRIORITY_RANK: Record<NotificationPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
};

export const LEGACY_NOTIFICATION_TYPE_MAP: Record<string, string> = {
  mention: 'message.mention',
  task_done: 'task.completed',
  task_failed: 'task.failed',
  session_done: 'session.completed',
  proactive: 'proactive.message',
};

export function normalizeNotificationType(type: string): string {
  return LEGACY_NOTIFICATION_TYPE_MAP[type] ?? type;
}

export interface DefaultNotificationEventPreference {
  eventType: string;
  label: string;
  description: string;
  inApp: boolean;
  toast: boolean;
  webPush: boolean;
  minPriority: NotificationPriority;
}

export const DEFAULT_NOTIFICATION_EVENTS: DefaultNotificationEventPreference[] = [
  {
    eventType: 'message.mention',
    label: '멘션',
    description: '채널에서 나를 직접 언급했을 때',
    inApp: true,
    toast: true,
    webPush: true,
    minPriority: 'normal',
  },
  {
    eventType: 'message.room',
    label: '일반 채널 메시지',
    description: '참여 중인 채널에 새 메시지가 왔을 때',
    inApp: false,
    toast: false,
    webPush: false,
    minPriority: 'normal',
  },
  {
    eventType: 'session.completed',
    label: 'AI 세션 완료',
    description: 'AI가 세션 응답 생성을 마쳤을 때',
    inApp: true,
    toast: true,
    webPush: true,
    minPriority: 'normal',
  },
  {
    eventType: 'spawn.completed',
    label: '병렬 세션 완료',
    description: 'spawn된 자식 세션이 완료됐을 때',
    inApp: false,
    toast: false,
    webPush: false,
    minPriority: 'normal',
  },
  {
    eventType: 'task.completed',
    label: '태스크 성공',
    description: '내가 시작한 일회성 태스크가 성공했을 때',
    inApp: true,
    toast: false,
    webPush: true,
    minPriority: 'normal',
  },
  {
    eventType: 'task.failed',
    label: '태스크 실패',
    description: '태스크 실행이 실패했을 때',
    inApp: true,
    toast: false,
    webPush: true,
    minPriority: 'normal',
  },
  {
    eventType: 'automation.completed',
    label: '예약/자동화 성공',
    description: '반복 예약 작업이 성공했을 때',
    inApp: true,
    toast: false,
    webPush: false,
    minPriority: 'normal',
  },
  {
    eventType: 'automation.failed',
    label: '예약/자동화 실패',
    description: '반복 예약 작업이 실패했을 때',
    inApp: true,
    toast: false,
    webPush: true,
    minPriority: 'normal',
  },
  {
    eventType: 'proactive.message',
    label: 'AI 선제 메시지',
    description: 'AI가 먼저 관찰/제안을 보냈을 때',
    inApp: true,
    toast: false,
    webPush: false,
    minPriority: 'normal',
  },
  {
    eventType: 'system.announcement',
    label: '시스템 공지',
    description: 'Tower 운영 공지와 시스템 알림',
    inApp: false,
    toast: false,
    webPush: false,
    minPriority: 'normal',
  },
];
