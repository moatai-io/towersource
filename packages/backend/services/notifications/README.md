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

## 세션 답변 완료 Web Push

`session.completed`는 설정의 AI 답변 완료 항목을 기본 켜짐으로 제공하며,
이벤트의 in-app·toast·Web Push 채널을 기본 활성화한다. 전역 브라우저 알림은 여전히
명시적 opt-in이며, 저장된 이벤트 끄기와 프로젝트 음소거를 존중한다. 설정의
AI 답변 완료 그룹을 켜면 Web Push도 켜진다.

`packages/frontend/public/push-handlers.js`는 수신 기기의 창 목록에서 대상 `/s/<key>`를
포커스·visible 상태로 보고 있으면 세션 완료 푸시를 생략한다. 다른 세션, 숨긴 탭,
다른 view/system 화면, 닫힌 창에서는 표시한다. 다른 종류의 푸시는 이 필터를 적용하지 않는다.
URL 별칭(UUID/short code)이 다르면 보수적으로 알림을 표시한다.

검증: `packages/frontend/src/components/notifications/session-completion-push.test.ts`에서
실제 Service Worker 스크립트를 실행해 표시·생략 조건과 기본 정책을 검증한다.
운영 배포, 브라우저 권한·VAPID 구성, 실기기 수신은 별도 검증이 필요하다.

## User-facing settings groups

The shared desktop/mobile settings UI exposes only answers/work results (including
legacy `task.*`, child-session and proactive events) and scheduled results.
Removed channel, mention, and announcement controls are not offered by the current
product. Hidden legacy preferences stay in the save payload unchanged; enabling
browser push no longer opts mentions in. Backend event support is retained for
compatibility. Scheduled success and failure share one switch. Input-request events
are not part of this hub's event vocabulary, so this UI must not advertise a push
switch for them. Question sounds remain separately handled by answer-sound.

Regression: `notification-surfaces.source.test.ts` protects current group mapping.

Session toast notifications offer a session-navigation action. Web Push adds an
optional OS action (browser support varies); clicking the notification itself remains
the portable navigation mechanism. Tests do not establish OS rendering or live clicks.

Session toast actions dispatch the existing session-selection event instead of reloading
the document. Push clicks message an existing same-origin Tower window to select the
session through `useSessionEventNavigation`; when no window exists they open the deep
link normally. Other notification destinations keep normal navigation.

For iOS Home Screen PWA push (iOS 16.4+), request Notification permission directly
inside the user's toggle gesture, before VAPID network lookup. Enabling push includes
session completion and scheduled results without clearing unrelated event settings.
Settings explain Home Screen installation and OS-controlled sound. Physical iPhone
subscription, closed-app delivery, and click navigation require live-device validation.

Settings distinguish account-wide push preference from this browser's local subscription.
Local registration is not proof of server/provider acceptance: test delivery still matters.
Connecting a device preserves all event selections. Saves are serialized, controls wait for
server confirmation, and failure keeps the previous values without success messaging.
Unsupported browsers, denied permission, absent VAPID config and configuration lookup
failure have separate guidance. Test success describes provider acceptance, not receipt.
