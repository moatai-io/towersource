# 클라이언트 연결 규칙과 웹 의존성 지도

상태: 공통 연결 규칙의 초기 정리 완료. 네이티브 앱이나 전체 원격 서버 접속을 구현한 상태는 아니다.
추적: TOW-136.

## 남은 호출의 분류와 종료 기준

추가 조사 시점에 `/api/` 문자열이 있는 비테스트 TS/TSX 파일은 146개였다(components 107, features 17, utils 7, stores 7, hooks 5, 기타 3). 이 수치는 이미 이관한 호출·주석·데이터도 포함하며, 미이관 요청 수나 결함 수가 아니다. 고정된 전체 이관 목표로 사용하지 않는다.

| 분류 | 대표 경로 | 처리 기준 |
|---|---|---|
| 일반 Tower API | admin, settings, sharing, automation 화면과 일부 store | 해당 기능 수정 시 주소 생성만 점진 이관한다. 권한·메서드·본문·오류 처리를 유지하고 기본/설정 서버를 검사한다. |
| 파일·미리보기의 잔여 요청 | PptxPreview, ShareModal, ShortFileLinkRedirect, SelectionToolbar | 제공 주소 외에도 변환·공유·짧은 링크의 동작이 있다. 개별 소유 계약과 함께 이관하고 token을 임의로 추가하지 않는다. |
| 같은 파일에 타 작업 존재 | ContextPanel.tsx | KeepDashboard 미커밋 변경이 있어 파일 제공 URL 3곳의 이관을 보류했다. 타 작업 정리 후 재검토한다. |
| 인증·계정 | LoginPage, 계정 전환·복구 경로 | 단순 문자열 치환 대상이 아니다. 토큰 쓰기·삭제·캐시·탭 간 전환과 응답 경합을 함께 검증한다. |
| 웹 생명주기 | app-version.ts의 client-reset, 서비스 워커·업데이트 | 현재 origin과 웹 자산 수명에 의미가 있으므로 무조건 API base를 적용하지 않는다. 앱 버전 협상은 별도 설계다. |
| 외부 서비스 | 공급자 음성 WebSocket, 외부 링크·OAuth 목적지 | Tower URL 모듈에 넣지 않는다. 공급자 인증과 외부 이동 정책을 유지한다. |

기초 정리의 종료 기준은 공통 규칙·핵심 소비 경로·회귀 검증·잔여 책임 경계가 명확한 상태다. 모든 `/api` 문자열 제거, 전체 별도 서버 운영, 네이티브 앱 구현은 종료 기준이 아니다. 현재 ContextPanel 보류 외에는 새 기능 요구 없이 전체 이관을 이어갈 의무를 만들지 않는다. 새 배포 후 웹 로그인·첨부·PDF·표 미리보기·다운로드 실사용은 자동 테스트와 구분해 확인한다.

## 이번 작업의 목표와 완료 기준

기존 웹 동작을 유지하면서 반복되는 서버 주소 해석을 모으고, 로그인·파일·업데이트의 웹 의존성을 다음 작업자가 찾을 수 있게 정리한다. 모든 호출의 일괄 이관이나 앱 출시 준비는 완료 기준에 포함하지 않는다. 아래 후속 후보는 별도 위임 없이 자동 실행할 작업 목록이 아니다.

## 공통 규칙

- `connection.ts`는 Tower HTTP 경로와 WebSocket 주소를 생성한다. 다운로드·미리보기 경로에도 사용할 수 있지만 모든 파일 소비자가 이관된 것은 아니다.
- `VITE_API_URL`이 비어 있으면 HTTP 경로는 기존 상대 경로를 유지하고 WebSocket은 브라우저 origin을 따른다.
- 설정값은 명시적인 HTTP(S) 절대 URL이어야 한다. 자격 증명·query·fragment·공백·역슬래시를 거부한다. URL 파서의 암묵적인 공백 제거와 역슬래시 변환에 의존하지 않는다.
- 마지막 슬래시는 정규화하고 설정된 경로 접두사는 보존한다. 이것이 서버의 하위 경로 배포 지원을 보장하지는 않는다.
- 호출자는 Tower 소유의 `/` 시작 경로를 전달한다. 외부 URL·프로토콜 상대 경로·공백 및 제어 문자·역슬래시·점 경로 순회를 거부한다. 경로 값과 query 값은 호출자가 각각 인코딩한다. 외부 공급자 URL은 이 모듈을 거치지 않는다.
- `readBrowserAuthToken`은 기존 localStorage 토큰을 매번 읽는다. 보안 저장소나 범용 인증 어댑터가 아니며 로그인 쓰기·만료·폐기·백엔드 권한 검사를 변경하지 않는다.
- 서버 주소는 빌드 설정이다. 런타임 서버 선택 API를 제공하지 않는다. 서버를 바꾸려면 토큰·스토어·캐시·초안·구독의 조직 격리를 먼저 설계해야 한다.

## 적용한 경로

| 대상 | 적용 내용 | 유지한 동작 |
|---|---|---|
| `../../hooks/useChatRuntime.ts` | 채팅 WebSocket 서버 주소 | 기존 query-token 인증과 재연결 로직 |
| `../../utils/auth.ts` | JWT UI 힌트용 토큰 읽기 | 서버의 최종 권한 검사 |
| `../../lib/push-notifications.ts` | 구독 HTTP 주소와 토큰 읽기 | Web Push 방식 |
| `../../components/layout/NotificationBell.tsx` 및 알림 설정 | 알림 HTTP 주소 | 읽음 처리와 UI |
| 세션 디렉터리·휴지통 | 기존 API base 소비 경로 | 기존 요청·응답 형태 |
| `../secretariat/secretariat-api.ts` 및 비서 채팅 | HTTP 주소 | 취소 신호와 오류 처리 |

OpenAI 실시간 음성 WebSocket은 외부 공급자 연결이므로 변경하지 않는다. 전역 fetch 패치나 모든 요청에 대한 자동 Authorization 삽입도 하지 않는다.

## 남아 있는 웹 의존성 지도

전체 파일 목록이나 호출 개수를 고정한 목록이 아니라, 책임 경계와 대표 진입점을 기록한다.

| 경계 | 대표 진입점 | 현재 의존성과 주의점 |
|---|---|---|
| 시작·사용자 확인 | `../../hooks/useAppBootstrap.ts` | 브라우저 저장소와 같은 origin API 요청. 오래된 응답이 새 계정을 덮지 않도록 한 보호를 유지해야 한다. |
| 로그인·계정 전환 | `../../components/auth/`, `../../utils/account-transition.ts`, `../../utils/account-transition.README.md` | 토큰 쓰기·제거, 탭 간 변경, 페이지 재시작이 서로 연결된다. 읽기 함수만 교체해서 네이티브 인증이 완성되지는 않는다. 기존 계정 전환 계약이 이 영역의 정본이다. |
| 세션·프로젝트 상태 | `../../stores/session-store.ts`, `../../stores/project-store.ts`, `../../stores/model-store.ts` | 세션 hydration·구독·AI 응답 읽음, 프로젝트 핀 저장은 공통 주소 모듈로 이관했다. 모델 선택은 `../../stores/engine-pick.ts`의 모델 PATCH·엔진 전환 POST를 이관했다. 모델 스토어 자체에는 직접 HTTP 요청이 없다. 사용자별 상태와 다른 직접 호출은 남아 있으며 주소 이관과 조직별 상태 격리는 서로 다른 작업이다. |
| 업로드 | `../../utils/upload-with-progress.ts` | XMLHttpRequest·진행률·AbortSignal·중복 방지 요청 키. fetch로 일괄 변환하면 동작을 잃을 수 있다. |
| PDF·파일 열기 | `../../utils/pdf-open.ts`, `../../stores/file-store.ts` | 브라우저 새 탭·파일 제공 URL·일부 query-token. 주소 생성과 OS 파일 열기는 분리해서 다뤄야 한다. query-token을 로그나 외부 링크로 넘기지 않아야 한다. |
| 업데이트·캐시 | `../../hooks/useAppUpdateCoordinator.ts`, `../../utils/app-version.ts`, `../../../public/sw.js` | 서비스 워커와 웹 자산 업데이트. 네이티브 앱 버전과 서버 버전 협상은 별도 문제다. |
| 푸시·백그라운드 | `../../lib/push-notifications.ts`, `../../../public/push-handlers.js` | 브라우저 Web Push. 네이티브 WebView의 푸시 지원이나 백그라운드 실행을 가정하지 않는다. |

직접 호출을 다시 조사할 때의 읽기 전용 명령:

```sh
rg -n '/api/|VITE_API_URL|new WebSocket' packages/frontend/src --glob '*.{ts,tsx}' --glob '!*.test.*'
rg -n 'localStorage|sessionStorage|XMLHttpRequest|window.open' packages/frontend/src --glob '*.{ts,tsx}' --glob '!*.test.*'
```

문자열 검색은 조사 출발점이다. 결과 전체가 결함인 것은 아니며, 외부 공급자 연결과 사용자 파일 내용을 임의로 이관하지 않는다.

## 후속 작업을 다시 시작할 때

1. 실제 원격 클라이언트 요구가 생기면 시작·인증·일반 HTTP·파일·복귀 경로 중 하나를 정해 세로로 이관하고, 기본 웹 origin과 별도 서버 origin을 각각 행동 테스트한다. 서버 CORS와 허용 origin도 함께 확인한다.
2. 서버 선택이나 네이티브 인증을 도입할 때는 계정 전환 정본을 먼저 읽고 토큰 쓰기·삭제·캐시·구독까지 한 경계로 설계한다.
3. 푸시·OAuth 복귀·앱 버전 호환·Capacitor/Tauri 패키징은 별도 제품 요구와 승인이 생겼을 때 다룬다.

## 검증과 한계

- `connection.test.ts`: 기본 origin, 설정 서버·접두사, WS 프로토콜 변환, 잘못된 설정·경로 거부, 최신 토큰 읽기.
- `../secretariat/secretariat-api.test.ts`: 요청 동작과 설정된 서버 주소.
- 기존 채팅 런타임·알림·비서 회귀 테스트: 이관한 소비 경로의 기존 동작 보호.
- 기존 계정 전환·업로드 테스트: 이번 정리에서 변경하지 않은 인접 경계의 회귀 확인.

로컬 테스트와 타입 검사는 merge·배포·실기기·OAuth·CORS 통합 검증과 구분한다. 이번 변경에는 배포나 네이티브 빌드가 없다. 공통 모듈이 존재한다는 사실만으로 전체 앱의 원격 접속이 지원된다고 안내하지 않는다.

## 추가 이관: 상태 관리 요청

`session-store.ts`, `project-store.ts`, `engine-pick.ts`의 6개 HTTP 요청은 `towerHttpUrl`로 주소만 생성한다. 메서드·본문·헤더·오류 처리·계정 경합 방지는 유지한다. `store-requests.test.ts`에서 기본 웹 주소와 설정 서버, 구독·읽음·핀·모델·엔진 변경 및 실패 응답을 검증한다. HTTP 주소 생성은 브라우저 전역 없이도 동작하며, WebSocket의 기본 origin 해석만 브라우저를 요구한다.

이 이관은 앱 패키징·전체 원격 접속 지원·네이티브 인증을 추가하지 않는다.

## 파일 경로 추가 이관

현재 목적은 앱 구현이 아니라 웹과 향후 앱이 공유할 연결 규칙 정리다. `../../components/chat/InputBox.tsx`의 업로드 주소와 `../../utils/pdf-open.ts`의 PDF 제공 주소를 공통 모듈로 이관했다. 업로드 유틸리티 자체는 전달받은 URL을 그대로 사용하는 XHR 전송 계층으로 유지한다. 진행률·응답 검증·오류·abort 이벤트 처리와 PDF 새 탭 열기를 변경하지 않는다. 파일 경로·토큰·revision은 URLSearchParams로 인코딩한다. 기존 query-token 방식은 유지되며 일반 외부 링크 생성 API로 사용하지 않는다.

`pdf-open.test.ts`와 `upload-with-progress.test.ts`는 기본/설정 서버, 파일 query 인코딩·토큰 생략, 새 탭 옵션, XHR 목적지와 인증 헤더를 확인한다. FileViewerPage·ViewerPane·FileTree 등 자체 URL 생성 경로는 아직 남아 있다. 실제 CORS·실기기·모든 미리보기 지원을 검증한 것은 아니다.

## 파일 제공 화면 추가 이관

FileViewerPage·OfficePreviewToolbar·FileTree·SqlitePreview·XlsxPreview·FileTabBar·ViewerPane의 파일 제공 URL을 공통 모듈에 연결했다. query 순서·token 생략 조건·cache revision·download 플래그·fetch 헤더·외부 URL 분기는 유지한다. 기존 웹 동작을 유지하며 네이티브 기능은 추가하지 않는다. `file-consumers.test.ts`는 화면 연결을 검사하는 소스 기반 보조 테스트이며 행동 테스트나 브라우저 검증을 대신하지 않는다.

## 커밋 준비 검증

ContextPanel의 파일 주소 이관은 같은 파일의 독립적인 대시보드 변경과 섞이지 않도록 이번 범위에서 제외하고 해당 이관만 원복했다. 대시보드 변경은 보존한다. ContextPanel은 후속 이관 대상으로 남긴다. 실제 채팅 첨부 endpoint는 `/api/session-attachments/:sessionId`이며 InputBox 연결 소스 검사도 추가했다. 이전 `/api/files/upload` 기반 유틸리티 테스트는 전송 계층 테스트이며 실제 endpoint 연결 검증을 대신하지 않는다. 세션 hydration 소스 검사는 HEAD에 이미 존재하는 in-flight 생성 세션 보존 조건에 맞췄고 관련 행동 테스트도 실행했다.

검증은 다른 세션 변경이 있는 전체 작업 트리에서 수행했으며 커밋 상태만 분리한 검증은 아니다. 브라우저 실사용 확인은 미실행이다.

## 시작 요청 추가 이관

`useAppBootstrap.ts`의 인증 상태·인증 확인·브랜딩 상태와 배경 URL·핀·Git 로그·설정·프롬프트 주소를 공통 모듈로 이관했다. 401 재시도 간격·네트워크 오류 시 토큰 유지·현재 credential 확인·Abort/응답 경합 보호와 요청 본문은 변경하지 않는다. `useAppBootstrap.connection.test.tsx`는 기본/설정 서버에서 인증 확인 헤더와 브랜딩 시작 요청을 실제 hook 실행으로 검증한다. 브랜딩 배경 주소는 기존처럼 모듈 초기화 시 빌드 설정으로 생성하며 런타임 서버 전환은 지원하지 않는다. 전체 별도 서버 운영이나 브라우저 로그인 검증을 완료했다는 의미는 아니다.

## ContextPanel 통합 마무리

사용자 승인으로 KeepDashboard 연결과 파일 주소 이관을 함께 검토했다. ContextPanel의 파일 제공 URL 3곳을 공통 모듈에 연결하고 화면 소스 검사에 추가했다. 위의 ContextPanel 보류 기록은 당시 상태이며 이번 통합으로 해소한다. KeepDashboard 컴포넌트·테스트를 함께 포함하고 DashboardRegistrationForm의 별도 변경은 포함하지 않는다. 관련 40개 테스트·타입 검사 통과, 브라우저 실사용 미검증.
