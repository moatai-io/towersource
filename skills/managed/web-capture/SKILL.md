---
name: web-capture
description: >
  AI browser automation — capture web pages, take screenshots, click, fill forms, run JS.
  Use when the user needs to see what a page looks like, capture visual state, or interact with a site programmatically.
  Trigger: "사이트 읽어와", "스크린샷", "화면 캡처", "화면 봐봐", "페이지 확인해봐",
  "클릭해봐", "로그인해봐", "어떻게 생겼어", "브라우저로 열어", "웹페이지 확인",
  "사이트 열어", "페이지 내용", "browse", "screenshot", "web capture", "캡처".
  NOT for: user direct interaction or shared remote desktop control. Neko/browser-live is retired; use Tower OAuth Connections or a purpose-built user-facing flow instead.
requires:
  runtime: runtime-box
  cli: [playwright-core, chromium]
  network: required
---

# Web Capture — AI Browser Automation

AI가 Runtime Box 안의 Playwright/system Chromium으로 웹페이지를 캡처·확인하는 스킬.
**프로젝트 격리 우선** — host 전역 브라우저 daemon이 아니라 프로젝트 Runtime Box에서 실행한다.

## ⚡ 실행 경계

Tower 세션에서는 먼저 제공된 first-party web capture/browser 도구를 사용한다. Project Runtime Box/customer member 세션에서 host `~/.claude/scripts/...`를 직접 읽거나 실행하지 않는다.

## Runtime Box Playwright 사용법

Project Runtime Box 안에서 `playwright-core + /usr/bin/chromium` 조합을 사용한다. Playwright browser bundle을 새로 다운로드하지 않는다.

```js
const { chromium } = require('playwright-core');
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
```

### 페이지 읽기 (가장 흔한 패턴)
```js
await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
const text = await page.locator('body').innerText();
console.log(text.slice(0, 6000));
```

### 스크린샷
```js
await page.screenshot({ path: 'sources/web-capture/screenshot.png', fullPage: true });
```
→ 저장 후 Read 도구로 이미지를 사용자에게 보여줄 수 있다.

### DOM/인터랙션
```js
await page.click('text=Sign in');
await page.fill('input[name="q"]', '검색어');
await page.keyboard.press('Enter');
```

### JavaScript 실행
```js
const title = await page.evaluate(() => document.title);
```

### PDF 저장
```js
await page.pdf({ path: 'sources/web-capture/page.pdf', printBackground: true });
```

## Output path

Do not write user-visible artifacts to `/tmp` or a fixed project-specific path.
If the current project has a visible scaffold, follow the project `AGENTS.md` first.
Use `sources/` for raw screenshots/PDF/DOM captures, `work/` for in-progress review notes, and `records/` for audit/smoke logs.
If the project has an existing stronger convention, follow that project convention instead.

## 우선순위 원칙

```
1순위: WebFetch                         — 정적 HTML, 빠르고 저렴
2순위: Runtime Box Playwright           — WebFetch 실패 시 또는 아래 케이스
```

**Runtime Box Playwright로 전환해야 하는 경우:**

| 상황 | 이유 |
|------|------|
| WebFetch 결과가 비어있거나 깨짐 | SPA/JS 렌더링 필요 |
| 봇 차단 / 캡차 응답 | 실제 브라우저로 우회 |
| 로그인이 필요한 페이지 | 현재 Chrome 세션 재사용 |
| 스크린샷 / 시각 확인 요청 | WebFetch는 이미지 불가 |
| 클릭, 폼 입력, 스크롤 등 인터랙션 | WebFetch는 읽기 전용 |

## 비용 순서 (저렴 → 고가)

```
WebFetch/text  <  Playwright DOM query  <  screenshot/PDF
```

**기본 원칙**: 항상 텍스트 추출로 시작. 시각 확인이 꼭 필요할 때만 screenshot/PDF를 만든다.

## 실전 예시

### 뉴스 사이트 헤드라인 읽기
```js
await page.goto('https://www.mk.co.kr/news/', { waitUntil: 'domcontentloaded' });
console.log(await page.locator('body').innerText());
```

### UI/레이아웃 검토
```js
await page.goto('https://myapp.com', { waitUntil: 'networkidle' });
await page.screenshot({ path: 'work/web-capture-review/review.png', fullPage: true });
```

### 검색창에 입력하고 결과 보기
```js
await page.goto('https://search.naver.com', { waitUntil: 'domcontentloaded' });
await page.fill('input#query', '검색어');
await page.keyboard.press('Enter');
await page.waitForLoadState('domcontentloaded');
console.log(await page.locator('body').innerText());
```

### 로그인이 필요한 페이지
Runtime Box Playwright는 기본적으로 깨끗한 브라우저 컨텍스트에서 시작한다. 사용자 계정 세션이 필요한 경우에는 Tower가 제공하는 first-party authenticated browser/live 경로를 쓰고, 비밀번호·계정 설정 변경 금지 규칙을 그대로 따른다.

## ⛔ 절대 금지 — 비밀번호/계정 수정

> **이 규칙은 어떤 상황에서도 예외 없이 적용된다.**

| 허용 | 금지 |
|------|------|
| 로그인 폼에 비밀번호 **입력** | 비밀번호 **변경/리셋** 버튼 클릭 |
| 로그인 페이지 탐색 | "Reset password", "Change password" 폼 제출 |
| 현재 로그인 상태 확인 | 계정 ID/이메일 수정 |
| | 관리자 패널에서 타 유저 비밀번호 리셋 |

**이유**: 브라우저 자동화는 현재 로그인된 세션을 사용하므로, 의도치 않게 실제 계정 정보를 변경할 수 있다.

## 주의사항

- **로그인이 필요한 페이지**: Runtime Box 기본 브라우저에는 host Chrome 쿠키가 없다. 사용자 세션이 필요한 작업은 first-party authenticated browser/live 경로를 사용한다.
- **스크린샷 남용 금지**: 텍스트로 해결 가능하면 DOM text 우선
- **DOM query vs screenshot**: 클릭/인터랙션 필요 → selector/locator 사용, 읽기만 → body text
- **여러 페이지 탐색**: 같은 browser context 안에서 page.goto → 작업 → page.goto 순서로 재현 가능하게 남긴다.
