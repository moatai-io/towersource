# Notifications module

## Responsibility

사용자별 알림 정책을 해석하고, 알림 이벤트가 어떤 채널로 전달될지 결정한다. 2026-06-26 기준 Web Push 발송까지 연결되어 있으며, 브라우저/PWA 채널은 기본 off다. 사용자가 설정에서 명시적으로 켜고 브라우저 권한을 허용한 뒤에만 멘션·승인·실패·긴 작업 완료 같은 중요 이벤트에 사용한다.

## Public API

- `notification-types.ts`
  - `normalizeNotificationType()` — legacy 타입을 dot notation 타입으로 정규화한다.
  - `DEFAULT_NOTIFICATION_EVENTS` — 이벤트별 기본 채널 정책.
- `notification-preferences.ts`
  - `getNotificationPreferences()` — 설정 UI용 전역/이벤트/프로젝트 설정 조회.
  - `updateNotificationPreferences()` — 설정 UI 저장.
  - `resolveNotificationPolicy()` — `notification-hub`가 알림 생성 전에 호출하는 정책 resolver.

## 들어오기 전 알아야 할 것

- 알림 저장/실시간 브로드캐스트의 기존 진입점은 `../notification-hub.ts`다.
- 실제 DB insert는 `../room/room-manager.ts`의 `createNotification()` / `createNotificationsBatch()`가 맡고 있다.
- Web Push sender, push subscription, Service Worker push/click handler는 이미 추가되어 있다. VAPID 키가 없으면 UI에서 비활성화된다.

## 관련 결정문서

- `~/workspace/decisions/2026-06-05-notification-center-browser-pwa-plan.md`
- `~/workspace/decisions/2026-06-26-browser-os-notification-opt-in.md`
