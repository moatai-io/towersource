# PRD: Tower npm Workspaces 전환

> **상태: 완료된 마이그레이션의 역사 기록**
>
> 이 문서는 현재 설치 또는 아키텍처 가이드가 아닙니다. 당시의 전환 계획과 위험 분석을 보존하기 위해 남겨두었습니다. 현재 구조는 루트 `package.json`과 `packages/backend`, `packages/frontend`, `packages/shared`를 기준으로 확인하세요. 제품 구조는 [`docs/tower-guide/architecture.md`](./tower-guide/architecture.md), 설치 방법은 [`INSTALL.md`](../INSTALL.md)를 사용하십시오.
>
> 이 문서의 `better-sqlite3`와 SQLite 관련 내용은 전환 당시의 기록입니다. Tower의 현재 서버 데이터베이스 계약은 PostgreSQL입니다.

**작성일**: 2026-03-11
**상태**: Draft → Reviewed → 구현 완료 (historical)
**작성자**: admin + Claude
**리뷰**: Tech Lead 분석 완료 (2026-03-11)

---

## 1. 배경 (Why)

Tower는 현재 **단일 package.json**에 frontend(React), backend(Express), shared types, skills가 모두 섞여 있다.

### 현재 문제점

| 문제 | 구체적 증상 |
|------|------------|
| **의존성 혼재** | `react`와 `better-sqlite3`가 같은 dependencies에 공존. backend에 react가, frontend에 sqlite가 설치됨 |
| **타입 복붙** | 8개 타입이 frontend/backend에 각각 따로 정의되어 있으며, 그 중 4개는 필드가 서로 다름 |
| **빌드 비효율** | frontend만 고쳐도 전체 의존성 트리를 공유. 패키지별 독립 빌드 불가 |
| **Skills 불필요한 결합** | 프롬프트 파일(markdown)이 서버 코드와 같은 패키지에 묶여 있음 |

### 전환해도 안전한 근거 (코드베이스 조사 결과)

- frontend ↔ backend 간 **코드 import가 0건** (전수 검사 완료)
- 통신은 100% HTTP/WebSocket — 이미 논리적으로 분리됨
- `@backend/*` path alias가 tsconfig에 정의되어 있으나 **실제 사용처 0건** → 삭제 가능
- 런타임 공유 유틸리티 0건 — 프론트/백 간 겹치는 함수 export 없음

---

## 2. 목표 (What)

**한 Git 레포를 유지하면서**, npm workspaces로 패키지 경계를 명확히 한다.

### 목표 구조

```
tower/
├── package.json              ← workspaces 선언 (루트)
├── tsconfig.base.json        ← 공통 TS 설정
├── vitest.config.ts          ← 루트에서 전체 테스트 실행
├── packages/
│   ├── frontend/
│   │   ├── package.json      ← react, zustand, vite 등
│   │   ├── vite.config.ts    ← ✅ 확정: frontend 안으로 이동
│   │   ├── index.html
│   │   ├── src/
│   │   └── tsconfig.json
│   │
│   ├── backend/
│   │   ├── package.json      ← express, better-sqlite3, claude-sdk 등
│   │   ├── index.ts          ← 엔트리포인트
│   │   ├── config.ts
│   │   ├── services/
│   │   ├── routes/
│   │   ├── db/
│   │   └── tsconfig.json
│   │
│   └── shared/
│       ├── package.json      ← ⚠️ 불변 조건: dependencies 0개 (순수 타입)
│       ├── types/
│       │   ├── session.ts    ← SessionMeta
│       │   ├── message.ts    ← ChatMessage
│       │   ├── project.ts    ← Project (base + extended)
│       │   ├── user.ts       ← User
│       │   ├── task.ts       ← TaskMeta, WorkflowMode
│       │   ├── file.ts       ← FileEntry (base)
│       │   ├── pin.ts        ← Pin (base), PromptItem
│       │   ├── git.ts        ← GitCommitInfo
│       │   └── index.ts      ← barrel export
│       └── tsconfig.json
│
├── data/                      ← SQLite DB (변경 없음)
├── dist/                      ← 빌드 출력 (변경 없음)
├── start.sh                   ← 프로덕션 스크립트 (경로 업데이트 필요)
└── ecosystem.config.cjs       ← PM2 설정 (경로 업데이트 필요)
```

---

## 3. 비목표 (What NOT)

- ❌ Git 레포 분리 (폴리레포 전환) — 시기상조
- ❌ 마이크로서비스 분리 — SQLite 단일 DB 구조와 맞지 않음
- ❌ Nx/Turborepo 도입 — 패키지 3개에 오버킬
- ❌ npm 레지스트리 배포 — private 패키지로 충분
- ❌ skills 패키지화 — 마크다운 파일이라 npm 패키지 불필요
- ❌ pnpm/yarn 전환 — npm workspaces가 3패키지 규모에 충분
- ❌ shared에 런타임 코드 추가 — 순수 타입만 (불변 조건)

---

## 4. 상세 설계

### 4.1 루트 package.json

```json
{
  "name": "tower",
  "version": "0.1.0",
  "private": true,
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "predev": "fuser -k 32354/tcp 32355/tcp 2>/dev/null; true",
    "dev": "concurrently \"npm run dev -w @tower/backend\" \"npm run dev -w @tower/frontend\"",
    "build": "tsc -b && npm run build -w @tower/frontend && npm run build -w @tower/backend",
    "test": "vitest run",
    "test:frontend": "vitest run --project frontend",
    "test:backend": "vitest run --project backend"
  },
  "devDependencies": {
    "concurrently": "^9.0.0",
    "typescript": "^5.6.0",
    "vitest": "^4.0.18"
  }
}
```

> **주의**: `dev` 에서 shared의 별도 watch 프로세스는 불필요.
> Vite는 TS 소스를 직접 읽고, tsx는 tsconfig references로 shared 소스를 해석한다.

### 4.2 packages/shared/package.json

```json
{
  "name": "@tower/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./types/index.ts",
      "default": "./types/index.ts"
    }
  },
  "devDependencies": {
    "typescript": "^5.6.0"
  }
}
```

**불변 조건 (이 패키지가 지켜야 할 계약)**:
- `dependencies`: 항상 비어 있어야 함 (런타임 의존성 0개)
- 순수 TypeScript 타입/인터페이스만 포함 — validation 함수, 상수, 유틸리티 금지
- 이 조건을 깨는 순간이 **아키텍처 재검토 tripwire**

> **설계 결정**: shared는 `dist/` 빌드 없이 **소스 직접 참조** 방식 사용.
> `exports` 필드가 `.ts` 소스를 직접 가리키고, Vite와 tsx 모두 TS 소스를 네이티브로 해석.
> 프로덕션 빌드 시에만 tsconfig `composite` + `tsc -b`로 `.d.ts` 생성.

### 4.3 packages/frontend/package.json

```json
{
  "name": "@tower/frontend",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --host 0.0.0.0 --port 32354",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@tower/shared": "*",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-markdown": "^9.0.0",
    "zustand": "^5.0.0",
    "sonner": "^2.0.7",
    "uuid": "^10.0.0",
    "mermaid": "^11.12.3",
    "@codemirror/lang-javascript": "^6.2.0",
    "@codemirror/lang-json": "^6.0.0",
    "@codemirror/lang-markdown": "^6.3.0",
    "@codemirror/lang-python": "^6.1.0",
    "@codemirror/theme-one-dark": "^6.1.0",
    "@uiw/react-codemirror": "^4.23.0",
    "@dnd-kit/core": "^6.3.1",
    "@dnd-kit/sortable": "^10.0.0",
    "@dnd-kit/utilities": "^3.2.2",
    "rehype-highlight": "^7.0.0",
    "rehype-raw": "^7.0.0",
    "remark-gfm": "^4.0.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.0",
    "@tailwindcss/vite": "^4.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@types/uuid": "^10.0.0",
    "@testing-library/react": "^16.3.2",
    "@testing-library/jest-dom": "^6.9.1",
    "jsdom": "^28.1.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0",
    "tailwindcss": "^4.0.0",
    "vite": "^6.0.0",
    "vite-plugin-pwa": "^1.2.0"
  }
}
```

> **변경점**: `workspace:*` → `*`. npm은 `workspace:` 프로토콜을 지원하지 않음 (pnpm/yarn 전용).
> npm workspaces에서 `*`는 자동으로 로컬 workspace symlink로 해석된다.

### 4.4 packages/backend/package.json

```json
{
  "name": "@tower/backend",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "PORT=32355 HOST=0.0.0.0 GIT_AUTO_COMMIT=true WORKSPACE_ROOT=$HOME/workspace DEFAULT_CWD=$HOME/workspace tsx watch --ignore './db/schema.ts' index.ts",
    "build": "tsc"
  },
  "dependencies": {
    "@tower/shared": "*",
    "@anthropic-ai/claude-agent-sdk": "^0.2.50",
    "@modelcontextprotocol/sdk": "^1.27.1",
    "better-sqlite3": "^11.0.0",
    "bcryptjs": "^2.4.3",
    "chokidar": "^4.0.0",
    "cors": "^2.8.5",
    "express": "^4.21.0",
    "express-rate-limit": "^8.2.1",
    "helmet": "^8.1.0",
    "jsonwebtoken": "^9.0.0",
    "multer": "^2.0.2",
    "uuid": "^10.0.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/bcryptjs": "^2.4.0",
    "@types/better-sqlite3": "^7.6.0",
    "@types/cors": "^2.8.0",
    "@types/express": "^5.0.0",
    "@types/jsonwebtoken": "^9.0.0",
    "@types/multer": "^2.0.0",
    "@types/node": "^22.0.0",
    "@types/uuid": "^10.0.0",
    "@types/ws": "^8.5.0",
    "tsx": "^4.19.0"
  }
}
```

> **better-sqlite3 주의**: native addon이므로 hoisting 후 바이너리 경로 문제 가능.
> Step 3에서 `npm ls better-sqlite3`로 설치 위치 반드시 확인.

### 4.5 Shared Types — 통합 대상 (전수 조사 결과)

코드베이스 전수 조사로 발견된 **8개 중복 타입**:

```
┌──────────────┬─────────────────────────────────┬──────────────────────────────────┬──────────────┐
│ Type         │ Frontend 위치                     │ Backend 위치                      │ 필드 차이      │
├──────────────┼─────────────────────────────────┼──────────────────────────────────┼──────────────┤
│ SessionMeta  │ stores/session-store.ts:4       │ services/session-manager.ts:8   │ 동일           │
│ Project      │ stores/project-store.ts:3       │ services/project-manager.ts:14  │ BE +userId   │
│ TaskMeta     │ stores/kanban-store.ts:5        │ services/task-manager.ts:7      │ BE +userId   │
│              │                                 │                                  │ BE +projectId│
│ FileEntry    │ stores/file-store.ts:3          │ services/file-system.ts:17      │ FE +children │
│              │                                 │                                  │ FE +isExpanded│
│              │                                 │                                  │ FE +isLoading│
│ Pin          │ stores/pin-store.ts:3           │ services/pin-manager.ts:4       │ BE +pin_type │
│              │                                 │                                  │ BE +content  │
│              │                                 │                                  │ BE +user_id  │
│ PromptItem   │ stores/prompt-store.ts:3        │ services/pin-manager.ts:16      │ 동일           │
│ GitCommitInfo│ stores/git-store.ts:3           │ services/git-manager.ts:8       │ 동일           │
│ WorkflowMode │ stores/kanban-store.ts:3        │ services/task-manager.ts:5      │ 동일           │
└──────────────┴─────────────────────────────────┴──────────────────────────────────┴──────────────┘
```

### 4.6 Shared Types 설계 전략: Base + Extended 패턴

필드가 다른 4개 타입은 **base 타입을 shared에, 확장 타입을 각 패키지에** 두는 전략:

```typescript
// ── packages/shared/types/project.ts ──
// API 경계를 오가는 필드만 (HTTP response shape)
export interface Project {
  id: string;
  name: string;
  description: string | null;
  rootPath: string | null;
  color: string;
  sortOrder: number;
  collapsed: number;
  archived: number;
  createdAt: string;
}

// ── packages/backend/services/project-manager.ts ──
import type { Project } from '@tower/shared';

// DB row에는 userId가 추가됨
interface ProjectRow extends Project {
  userId: number | null;
}

// ── packages/frontend/src/stores/file-store.ts ──
import type { FileEntry as FileEntryBase } from '@tower/shared';

// UI 트리 상태가 추가됨
interface FileEntry extends FileEntryBase {
  children?: FileEntry[];
  isExpanded?: boolean;
  isLoading?: boolean;
}
```

**원칙**: shared에는 **API 경계를 오가는 필드만** 정의. DB 전용 필드(userId)나 UI 전용 상태(isExpanded)는 각 패키지에서 extends.

### 4.7 vite.config.ts (packages/frontend/로 이동 확정)

```typescript
// packages/frontend/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss(), VitePWA(/* ... */)],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  optimizeDeps: {
    // workspace 패키지는 prebundle 제외 → HMR 활성화
    exclude: ['@tower/shared'],
  },
  server: {
    port: 32354,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/api': 'http://localhost:32355',
      '/ws': { target: 'ws://localhost:32355', ws: true },
      '/hub': 'http://localhost:32400',
      '/sites': 'http://localhost:80',
    },
  },
  build: {
    outDir: '../../dist/frontend',
    emptyOutDir: true,
  },
});
```

> **결정 근거**: frontend 패키지 독립성이 이 전환의 핵심 목표.
> vite.config를 root에 두면 frontend가 root에 의존하게 되어 목적에 반한다.
> `/hub`, `/sites` 프록시도 현행 유지 (누락 방지).

### 4.8 tsconfig 구조

```
tower/
├── tsconfig.base.json          ← 공통 설정 (target, strict, module 등)
├── tsconfig.json               ← solution file (references만)
├── packages/
│   ├── shared/tsconfig.json    ← extends base, composite: true
│   ├── frontend/tsconfig.json  ← extends base, references: [shared]
│   └── backend/tsconfig.json   ← extends base, references: [shared]
```

```json
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}

// tsconfig.json (root solution file)
{
  "files": [],
  "references": [
    { "path": "packages/shared" },
    { "path": "packages/frontend" },
    { "path": "packages/backend" }
  ]
}

// packages/shared/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": "types",
    "outDir": "dist"
  },
  "include": ["types/**/*"]
}
```

> **핵심**: `composite: true`를 shared에만 설정. `tsc -b`가 빌드 순서를 자동 해석.
> 개발 중에는 Vite/tsx가 TS 소스 직접 해석하므로 `tsc -b`는 프로덕션 빌드에서만 실행.

### 4.9 vitest.config.ts 업데이트

```typescript
// vitest.config.ts (루트 유지)
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    workspace: [
      {
        extends: true,
        test: {
          name: 'frontend',
          environment: 'jsdom',
          include: ['packages/frontend/**/*.test.{ts,tsx}'],
          setupFiles: ['packages/frontend/src/test-setup.ts'],
        },
        resolve: {
          alias: { '@': path.resolve(__dirname, 'packages/frontend/src') },
        },
      },
      {
        extends: true,
        test: {
          name: 'backend',
          environment: 'node',
          include: ['packages/backend/**/*.test.ts'],
        },
      },
    ],
  },
});
```

### 4.10 프로덕션 설정 업데이트

```javascript
// ecosystem.config.cjs (변경 사항)
module.exports = {
  apps: [{
    name: 'tower',
    script: 'dist/backend/index.js',  // ← 변경 없음 (dist는 root 기준)
    // ...
  }]
};
```

```bash
# start.sh (변경 사항)
# 빌드 명령어만 변경
npx tsc -b && npx vite build --config packages/frontend/vite.config.ts
```

---

## 5. 사전 정리 (마이그레이션 전 필수)

코드베이스 조사에서 발견된 **마이그레이션을 방해할 수 있는 기존 문제**. Step 1 전에 해결.

### 5.1 process.cwd() 하드코딩 수정

```typescript
// backend/services/claude-sdk.ts:119 — 현재
const SESSION_BACKUP_DIR = path.join(process.cwd(), 'data', 'session-backups');

// 수정 → config.ts의 PROJECT_ROOT 사용
import { config } from '../config.js';
const SESSION_BACKUP_DIR = path.join(config.projectRoot, 'data', 'session-backups');
```

**이유**: 패키지 이동 후 cwd가 `packages/backend/`이 될 수 있음. `process.cwd()` 대신 config 기반 절대경로 필수.

### 5.2 WORKSPACE_ROOT 중복 정의 제거

```typescript
// backend/services/project-manager.ts:8 — 현재 (중복 정의)
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.join(process.env.HOME || '/tmp', 'workspace');

// 수정 → config.ts에서 import
import { config } from '../config.js';
// config.workspaceRoot 사용
```

### 5.3 미사용 path alias 삭제

```json
// tsconfig.json — 삭제 대상
"@backend/*": ["backend/*"]   // 사용처 0건
```

---

## 6. 마이그레이션 계획

### Step 0: 사전 정리 (위험도: 낮음)

1. Section 5의 3개 수정 적용
2. `npm run dev` + `npm test` 통과 확인
3. **커밋**: "refactor: fix hardcoded paths before workspace migration"

**검증 명령어**:
```bash
npm run dev          # 32354, 32355 둘 다 뜨는지
npm test             # 기존 테스트 통과
grep -r "process.cwd()" backend/ --include="*.ts" | grep -v node_modules
# → SESSION_BACKUP_DIR 외에 process.cwd() 사용처 없는지 확인
```

### Step 1: shared 패키지 생성 (위험도: 낮음)

1. `packages/shared/` 디렉토리 + package.json + tsconfig.json 생성
2. 8개 중복 타입 추출 → `packages/shared/types/`에 정의
3. **이 시점에서 기존 코드는 변경하지 않음** (아직 import 안 바꿈)
4. shared 타입에 대한 `tsc` 통과 확인

**검증 명령어**:
```bash
cd packages/shared && npx tsc --noEmit  # 타입 에러 없는지
ls packages/shared/types/               # 8개 파일 + index.ts
```

### Step 2: 디렉토리 이동 (위험도: 높음 ← 상향)

1. `frontend/` → `packages/frontend/`
2. `backend/` → `packages/backend/`
3. `vite.config.ts` → `packages/frontend/vite.config.ts`
4. `index.html` → `packages/frontend/index.html` (Vite 엔트리)
5. 경로 참조 업데이트:
   - tsconfig.json → tsconfig.base.json + solution tsconfig
   - vite.config.ts 내부 경로 (alias, outDir, proxy)
   - vitest.config.ts 테스트 경로
   - package.json 스크립트 (dev:backend, dev:frontend, build)
6. **start.sh, ecosystem.config.cjs 빌드 경로 업데이트**

**검증 명령어**:
```bash
npm run dev                            # frontend :32354, backend :32355
curl -s http://localhost:32354 | head  # frontend HTML 응답
curl -s http://localhost:32355/api/health  # backend 응답 (있다면)
npm test                               # 테스트 통과
```

> **위험도를 '높음'으로 상향한 이유**: vite.config 이동, index.html 이동,
> vitest 경로, start.sh, ecosystem.config 등 동시에 여러 경로가 바뀜.
> git으로 각 파일 이동을 추적하려면 `git mv` 사용 권장.

### Step 3: package.json 분리 (위험도: 중간)

1. 루트 package.json에 `workspaces` 선언
2. 각 패키지별 package.json 생성 + 의존성 분배
3. `rm -rf node_modules package-lock.json && npm install`
4. **better-sqlite3 hoisting 확인**: `npm ls better-sqlite3` → backend에 설치되었는지
5. **React 싱글톤 확인**: `npm ls react` → 단일 복사본인지
6. 전체 빌드 + 실행 확인

**검증 명령어**:
```bash
npm ls better-sqlite3               # hoisting 위치 확인
npm ls react                        # 단일 버전인지
npm ls @tower/shared                # symlink 확인
ls -la node_modules/@tower/         # symlink → packages/* 연결
npm run dev                         # 전체 동작
```

### Step 4: import 전환 (위험도: 낮음)

1. frontend/backend의 중복 타입 정의 삭제
2. `import type { SessionMeta } from '@tower/shared'`로 교체
3. 필드 차이가 있는 4개 타입은 Base + Extended 패턴 적용 (Section 4.6)
4. 타입 체크 통과 확인

**검증 명령어**:
```bash
npx tsc --noEmit                    # 전체 타입 체크
# 중복 정의가 남아있지 않은지 확인:
grep -rn "interface SessionMeta" packages/frontend/ packages/backend/
grep -rn "interface Project " packages/frontend/ packages/backend/
# → shared에서만 정의되어야 함 (extended 제외)
```

### Step 5: 검증 (위험도: 없음)

1. `npm run dev` — 개발 서버 정상 기동 (frontend :32354, backend :32355)
2. `npm run build` — 프로덕션 빌드 성공 (dist/frontend + dist/backend)
3. `npm test` — 테스트 통과
4. `./start.sh start` — PM2 프로덕션 모드 기동
5. 수동 테스트: 채팅 전송, 파일 관리, 태스크 보드, admin 패널

---

## 7. 리스크 및 대응

### 7.1 확인된 리스크 (코드베이스 조사 기반)

| # | 리스크 | 확률 | 영향 | 대응 |
|---|--------|------|------|------|
| R1 | **경로 이동 후 import 깨짐** | 높음 | 높음 | `git mv`로 이동 → git이 rename 추적. grep으로 잔여 경로 검색 |
| R2 | **better-sqlite3 hoisting 실패** | 중간 | 높음 | native addon은 hoisting 민감. `npm ls`로 확인, 문제 시 `overrides`로 강제 설치 위치 지정 |
| R3 | **tsx watch cwd 변경** | 중간 | 중간 | backend dev script가 `packages/backend/` 기준으로 실행됨. `--ignore` 경로, DB 경로 등 상대경로 전부 점검 |
| R4 | **vitest 경로 깨짐** | 높음 | 중간 | vitest.config.ts의 include 패턴 + alias 전부 업데이트 (Section 4.9) |
| R5 | **React 중복 인스턴스** | 낮음 | 높음 | React가 2개 설치되면 hooks 에러. `npm ls react`로 단일 복사본 확인 |
| R6 | **PM2 프로덕션 깨짐** | 중간 | 높음 | `ecosystem.config.cjs`의 script 경로 + `start.sh` 빌드 명령어 업데이트 |
| R7 | **config.ts의 PROJECT_ROOT 해석** | 중간 | 높음 | `PROJECT_ROOT`가 `__dirname` 기반 → backend가 `packages/backend/`로 이동하면 2단계 상위가 project root. 로직 확인 필수 |
| R8 | **frontend static serve 경로** | 낮음 | 중간 | `backend/index.ts:47`에서 `config.frontendDir` 기준으로 static 파일 서빙 → dist 경로 확인 |
| R9 | **Vite HMR에서 shared 변경 미감지** | 낮음 | 낮음 | `optimizeDeps.exclude: ['@tower/shared']` 설정으로 해결 (Section 4.7) |

### 7.2 롤백 계획

각 Step은 독립 커밋. 문제 발생 시:

```bash
# 특정 Step으로 롤백
git log --oneline  # 커밋 해시 확인
git revert <hash>  # 해당 Step 되돌리기

# 전체 롤백 (최악의 경우)
git reset --hard <migration-start-hash>
rm -rf node_modules package-lock.json
npm install
```

**핵심**: Step 2(디렉토리 이동)와 Step 3(package.json 분리)를 **같은 커밋에 묶지 않는다**. 롤백 단위를 작게 유지.

---

## 8. 불변 조건 (Invariants)

마이그레이션 전후로 반드시 유지되어야 하는 계약:

| # | 불변 조건 | 검증 방법 |
|---|-----------|----------|
| I1 | frontend → backend 직접 import 0건 | `grep -r "from.*@tower/backend\|from.*packages/backend" packages/frontend/` |
| I2 | backend → frontend 직접 import 0건 | `grep -r "from.*@tower/frontend\|from.*packages/frontend" packages/backend/` |
| I3 | shared 패키지 런타임 의존성 0개 | `cat packages/shared/package.json \| jq '.dependencies'` → null 또는 {} |
| I4 | 포트 32354 (frontend), 32355 (backend) 유지 | `curl localhost:32354`, `curl localhost:32355` |
| I5 | data/tower.db 경로 변경 없음 | DB는 project root의 `data/` 디렉토리에 유지 |
| I6 | `~/.claude/` 참조 정상 동작 | Skills, commands, session .jsonl 파일 접근 확인 |

---

## 9. 성공 기준

- [ ] `npm install` — 루트에서 한 번으로 전체 의존성 설치
- [ ] `npm run dev` — frontend :32354, backend :32355 정상 기동
- [ ] `npm run build` — dist/frontend + dist/backend 출력
- [ ] `npm test` — 기존 테스트 전체 통과
- [ ] `./start.sh start` — PM2 프로덕션 모드 정상 기동
- [ ] 중복 타입 정의 0건 (8개 타입 모두 shared에서 관리)
- [ ] frontend package.json에 backend 전용 패키지 없음 (better-sqlite3, express 등)
- [ ] backend package.json에 frontend 전용 패키지 없음 (react, zustand 등)
- [ ] `npm ls react` — 단일 복사본
- [ ] `npm ls better-sqlite3` — backend에서 정상 로드
- [ ] 불변 조건 I1~I6 모두 통과

---

## 10. 의존성 분배 상세 (조사 결과)

코드베이스 전수 조사로 확인된 정확한 분류:

### Frontend 전용 (24개)
```
react, react-dom, react-markdown, zustand, sonner, mermaid,
@codemirror/lang-{javascript,json,markdown,python}, @codemirror/theme-one-dark,
@uiw/react-codemirror, @dnd-kit/{core,sortable,utilities},
rehype-highlight, rehype-raw, remark-gfm,
@vitejs/plugin-react, @tailwindcss/vite, vite, vite-plugin-pwa,
@testing-library/{react,jest-dom}, jsdom
```

### Backend 전용 (16개)
```
express, express-rate-limit, helmet, cors, better-sqlite3,
multer, chokidar, @anthropic-ai/claude-agent-sdk,
@modelcontextprotocol/sdk, bcryptjs, jsonwebtoken, ws,
tsx, @types/{express,cors,multer,better-sqlite3,bcryptjs,
jsonwebtoken,ws}
```

### 양쪽 공용 (루트 devDependencies)
```
typescript, vitest, uuid, @types/uuid, @types/node, concurrently
```

> **주의**: `uuid`는 frontend/backend 모두 사용하지만 크기가 작고 tree-shakeable이므로
> 각 패키지 dependencies에 개별 선언해도 무방 (hoisting이 알아서 dedup).

---

## 11. 향후 확장 (Phase 2 트리거)

이 전환 이후, 다음 신호가 오면 폴리레포(별도 Git) 전환을 검토:

- 팀 3명 이상 → PR 충돌 빈번
- frontend/backend 릴리스 주기 분리 필요
- Skills를 외부 기여자가 개발
- CI 빌드 시간이 5분 이상
- shared 패키지에 런타임 의존성 추가 필요 → **아키텍처 재검토 시점**

---

## Appendix A: 조사에서 발견된 기존 코드 이슈

마이그레이션과 직접 관련은 없지만, 발견된 기술 부채:

| 이슈 | 위치 | 설명 |
|------|------|------|
| `process.cwd()` 하드코딩 | `claude-sdk.ts:119` | SESSION_BACKUP_DIR — Step 0에서 수정 |
| WORKSPACE_ROOT 중복 정의 | `project-manager.ts:8` | config.ts와 이중 정의 — Step 0에서 수정 |
| 미사용 path alias | `tsconfig.json` | `@backend/*` 정의되었으나 사용처 0건 — Step 0에서 삭제 |
| 포트 하드코딩 분산 | `task-runner.ts:313`, `workflow-prompts.ts:114` | `localhost:32355`가 여러 파일에 산재 — 향후 config 통합 |
| `/tmp/tower-bwrap-*.sh` | `bwrap-sandbox.ts:119` | /tmp에 임시 스크립트 생성 — read-only /tmp 환경에서 실패 가능 |

## Appendix B: 참고 자료

- [npm Workspaces 공식 문서](https://docs.npmjs.com/cli/v7/using-npm/workspaces/)
- [TypeScript Project References](https://www.typescriptlang.org/docs/handbook/project-references.html)
- [Vite + Monorepo 설정](https://vite.dev/guide/dep-pre-bundling)
- [Simple Monorepos via npm Workspaces and TypeScript Project References — 2ality](https://2ality.com/2021/07/simple-monorepos.html)
- [npm hoisting 문제 분석](https://www.jonathancreamer.com/inside-the-pain-of-monorepos-and-hoisting/)
