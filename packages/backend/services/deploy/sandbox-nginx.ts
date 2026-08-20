/**
 * sandbox-nginx.ts — Phase 2a-2 nginx config 자동 생성 + reload.
 *
 * 부트스트랩 (operator 1회 sudo): scripts/sandbox/setup-nginx-tools.sh
 *   - /etc/nginx/sandbox-tools/ 디렉토리 (tower user 소유)
 *   - /etc/nginx/conf.d/sandbox-tools-include.conf (include 한 줄)
 *   - /etc/sudoers.d/tower-sandbox-nginx (NOPASSWD: nginx -t, nginx -s reload)
 *
 * 이 모듈:
 *   - writeAuthRequiredConfig(tool) — 한 도구의 server block 작성
 *   - removeToolConfig(tool) — server block 제거
 *   - reloadNginx() — sudo nginx -t + sudo nginx -s reload
 *   - assertNginxBootstrap() — 부트스트랩 확인 (sites-enabled/sandbox-tools/ 존재)
 *
 * 결정:
 *   workspace/decisions/2026-05-07-execution-sandbox-q14a-nginx-mvp.md
 *   workspace/decisions/2026-04-29-execution-sandbox-q14-nginx-proxy.md
 *   workspace/decisions/2026-05-02-execution-sandbox-q18-public-tools.md (visibility)
 */

import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { spawn } from 'child_process';
import * as pathLib from 'path';
import { config } from '../../config.js';
import { SandboxDeniedError } from './sandbox.js';

const NGINX_DIR = '/etc/nginx/sandbox-tools';
const INCLUDE_FILE = '/etc/nginx/conf.d/sandbox-tools-include.conf';

// ssh alias → hostname 캐시 (process lifetime)
let cachedExecVmHost: string | null = null;

async function resolveExecVmHost(): Promise<string> {
  if (cachedExecVmHost) return cachedExecVmHost;

  // 우선 명시적 ENV (운영자가 .env 에 IP 박아둔 경우)
  const explicit = process.env.SANDBOX_TOOL_EXEC_VM_IP;
  if (explicit && explicit.trim()) {
    cachedExecVmHost = explicit.trim();
    return cachedExecVmHost;
  }

  // ssh -G 로 hostname 추출 (alias → 실제 host)
  const alias = config.sandbox.vmHost;
  if (!alias) {
    throw new Error('EXECUTION_VM_HOST not set');
  }
  // alias 가 user@host 면 user 떼고
  const aliasOnly = alias.includes('@') ? alias.split('@')[1] : alias;
  const ssh = await runCmd('ssh', ['-G', aliasOnly]);
  if (ssh.exit_code !== 0) {
    cachedExecVmHost = aliasOnly; // fallback
    return cachedExecVmHost;
  }
  for (const line of ssh.stdout.split('\n')) {
    if (line.startsWith('hostname ')) {
      cachedExecVmHost = line.slice('hostname '.length).trim();
      return cachedExecVmHost;
    }
  }
  cachedExecVmHost = aliasOnly;
  return cachedExecVmHost;
}

export async function getExecVmHostForNginx(): Promise<string> {
  return resolveExecVmHost();
}

export interface ToolForNginx {
  id: number;
  owner_username: string;            // resolved from users.username
  name: string;
  port: number;                      // 컨테이너 internal port (entrypoint 가 listen 하는)
  host_port: number;                 // sibling VM host port (publish 대상)
  visibility: 'auth-required' | 'unlisted' | 'public';
  slug_suffix?: string | null;       // unlisted 시 6자 hex (DB 056). 없으면 build 시 throw.
}

/**
 * DNS / nginx server_name 예약어 — public visibility 의 slug 충돌 방지.
 * 결정: workspace/decisions/2026-05-13-execution-sandbox-phase2a3-unlisted-public.md
 */
const PUBLIC_RESERVED_SLUGS = new Set([
  'api', 'admin', 'www', 'mail', 'ftp', 'dev', 'staging', 'tower', 'desk',
  'demo', 'demo-server', 'demo-org', 'app', 'auth', 'login', 'logout',
  'register', 'oauth', 'health', 'status', 'metrics', 'static', 'assets',
  'public', 'private', 'internal', 'localhost', 'docs', 'help', 'support',
]);

/**
 * 부트스트랩 검사 — setup-nginx-tools.sh 가 실행됐는지.
 * 안 되어있으면 명시적 에러 + 안내.
 */
export function assertNginxBootstrap(): void {
  if (!existsSync(NGINX_DIR)) {
    throw new SandboxDeniedError(
      `nginx not bootstrapped — run on operator host: sudo bash ~/tower/scripts/sandbox/setup-nginx-tools.sh`,
    );
  }
  if (!existsSync(INCLUDE_FILE)) {
    throw new SandboxDeniedError(
      `nginx include missing (${INCLUDE_FILE}) — run setup-nginx-tools.sh`,
    );
  }
}

/**
 * Slug 충돌 검사 — 두 종류:
 *   1. publishing/sites/<slug>/ 와 같은 이름이면 거부 (정적 사이트 우선)
 *   2. nginx sandbox-tools 디렉토리에 다른 도구의 <slug>.conf 가 있으면 거부
 *      (다른 사용자의 public 도구 + 본인의 새 도구 충돌 케이스 — DB-level 도
 *       sandbox-tools.ts 의 SQL 에서 검증하지만 파일시스템 검사 추가로 빠른 fail)
 *
 * 결정: workspace/decisions/2026-05-13-execution-sandbox-phase2a3-unlisted-public.md
 */
export function checkSlugConflict(slug: string, currentConfigPath?: string): void {
  const publishedDir = pathLib.join(config.workspaceRoot, 'published', 'sites', slug);
  if (existsSync(publishedDir)) {
    throw new SandboxDeniedError(
      `slug "${slug}" conflicts with published site at workspace/published/sites/${slug}/`,
    );
  }
  const existingConf = pathLib.join(NGINX_DIR, `${slug}.conf`);
  if (existsSync(existingConf) && existingConf !== currentConfigPath) {
    throw new SandboxDeniedError(
      `slug "${slug}" already in use by another sandbox tool (${existingConf})`,
    );
  }
}

/**
 * Visibility 별 슬러그 생성.
 *   auth-required: `<owner>-<name>` — owner namespace 안 unique
 *   unlisted:      `<owner>-<name>-<6hex>` — owner + 추측 불가 suffix
 *   public:        `<name>` — owner 없음, 글로벌 unique + reserved 검사
 *   private:       slug 없음 (nginx 등록 X) — caller 가 호출 안 함
 *
 * 결정: workspace/decisions/2026-05-13-execution-sandbox-phase2a3-unlisted-public.md
 */
export function buildToolSlug(
  ownerUsername: string,
  toolName: string,
  visibility: 'auth-required' | 'unlisted' | 'public',
  slugSuffix?: string | null,
): string {
  const owner = ownerUsername.toLowerCase();
  const name = toolName.toLowerCase();

  let raw: string;
  switch (visibility) {
    case 'auth-required':
      raw = `${owner}-${name}`;
      break;
    case 'unlisted':
      if (!slugSuffix || !/^[a-f0-9]{6}$/.test(slugSuffix)) {
        throw new SandboxDeniedError(`unlisted slug requires 6-char hex suffix (got "${slugSuffix ?? ''}")`);
      }
      raw = `${owner}-${name}-${slugSuffix}`;
      break;
    case 'public':
      raw = name;
      if (PUBLIC_RESERVED_SLUGS.has(raw)) {
        throw new SandboxDeniedError(`public slug "${raw}" is DNS/nginx reserved`);
      }
      break;
  }

  const slug = raw
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
    throw new SandboxDeniedError(`invalid slug "${slug}" derived from "${ownerUsername}/${toolName}/${visibility}"`);
  }
  return slug;
}

/**
 * 한 도구의 nginx server block 작성.
 *
 * Visibility 별 분기:
 *   auth-required: Tower 세션 쿠키 인증 (auth_request) + noindex
 *   unlisted:      인증 X, suffix 로 URL 추측 차단 + noindex + rate limit (per-IP)
 *   public:        인증 X, 인덱싱 OK + rate limit (per-IP + per-tool + global cap)
 *   private:       호출 안 함 (slug 없음)
 *
 * Rate limit zones 는 setup-nginx-tools.sh 의 http {} 레벨에 정의됨.
 * 결정:
 *   workspace/decisions/2026-05-07-execution-sandbox-q14a-nginx-mvp.md
 *   workspace/decisions/2026-05-13-execution-sandbox-phase2a3-unlisted-public.md
 */
export async function writeNginxConfig(tool: ToolForNginx): Promise<{ slug: string; configPath: string; url: string }> {
  assertNginxBootstrap();

  const slug = buildToolSlug(tool.owner_username, tool.name, tool.visibility, tool.slug_suffix);
  checkSlugConflict(slug);

  const configPath = pathLib.join(NGINX_DIR, `${slug}.conf`);
  let publicHost = '';
  try {
    publicHost = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).hostname : '';
  } catch {}
  const baseDomain = process.env.SANDBOX_TOOL_BASE_DOMAIN?.trim() || publicHost;
  if (!baseDomain) {
    throw new Error('SANDBOX_TOOL_BASE_DOMAIN or PUBLIC_URL is required for externally visible sandbox tools');
  }
  const certDomain = process.env.SANDBOX_TOOL_CERT_DOMAIN || baseDomain;
  // ssh tunnel 모델 (Q14a): 본체 127.0.0.1:host_port → sibling 127.0.0.1:host_port.
  const execVmHost = '127.0.0.1';

  // Tower 본체 backend 포트 (auth_request 가 호출). dev 는 32355, prod 는 32364.
  const backendPort = process.env.PORT || process.env.TOWER_BACKEND_PORT || '32364';

  // ── noindex header ────────────────────────────────────────────────────
  const robotsHeader = tool.visibility === 'public'
    ? '# (public visibility — indexable; /robots.txt 는 컨테이너가 직접 응답)'
    : 'add_header X-Robots-Tag "noindex, nofollow, noarchive" always;';

  // ── 인증 블록 (auth-required only) ────────────────────────────────────
  const authBlock = tool.visibility === 'auth-required'
    ? `    auth_request /_internal/check-session;
    auth_request_set $auth_user_id $upstream_http_x_user_id;
`
    : '';

  const proxyHeaders = tool.visibility === 'auth-required'
    ? `        proxy_set_header X-Tower-User-Id $auth_user_id;\n`
    : '';

  const internalLocation = tool.visibility === 'auth-required'
    ? `    location = /_internal/check-session {
        internal;
        proxy_pass http://127.0.0.1:${backendPort}/api/auth/check;
        proxy_set_header X-Original-URI $request_uri;
        proxy_set_header Cookie $http_cookie;
    }
`
    : '';

  // ── Rate limit (unlisted/public) ──────────────────────────────────────
  // zone 정의는 setup-nginx-tools.sh 의 sandbox-tools-rate-limit.conf (http {} 레벨).
  //   - sandbox_tool_ip:    per-IP across all sandbox tools (10MB ≈ 160k IPs)
  //   - sandbox_tool_each:  per-tool burst (도구마다 별도 key)
  //   - sandbox_tool_global: 글로벌 cap (50 req/sec)
  // burst = 짧은 spike 흡수, nodelay = 즉시 처리 (queue 안 함).
  let rateLimitBlock = '';
  if (tool.visibility === 'unlisted') {
    rateLimitBlock = `    limit_req zone=sandbox_tool_ip burst=10 nodelay;
    limit_conn sandbox_tool_conn 10;
`;
  } else if (tool.visibility === 'public') {
    rateLimitBlock = `    limit_req zone=sandbox_tool_ip burst=10 nodelay;
    limit_req zone=sandbox_tool_global burst=20 nodelay;
    limit_conn sandbox_tool_conn 10;
`;
  }

  const conf = `# AUTO-GENERATED by Tower backend — DO NOT EDIT MANUALLY.
# tool_id=${tool.id} owner=${tool.owner_username} name=${tool.name}
# visibility=${tool.visibility} host_port=${tool.host_port} slug_suffix=${tool.slug_suffix ?? ''}
# 결정: workspace/decisions/2026-05-13-execution-sandbox-phase2a3-unlisted-public.md

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name ${slug}.${baseDomain};

    ssl_certificate     /etc/letsencrypt/live/${certDomain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${certDomain}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

${authBlock}    ${robotsHeader}

${rateLimitBlock}    location / {
        proxy_pass http://${execVmHost}:${tool.host_port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
${proxyHeaders}        # WebSocket / SSE 지원 (Phase 2c 검증)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $http_connection;
        proxy_read_timeout 300s;
    }

${internalLocation}}
`;

  writeFileSync(configPath, conf, { mode: 0o644 });

  return {
    slug,
    configPath,
    url: `https://${slug}.${baseDomain}/`,
  };
}

/**
 * Deprecated alias — Phase 2a-2 시절 이름. provisionTool 이 이미 이걸 호출하므로
 * 외부 호출자에겐 영향 없음. 코드 정리 시 제거.
 */
export const writeAuthRequiredConfig = writeNginxConfig;

/**
 * 도구의 server block 제거.
 */
export function removeToolConfig(slug: string): boolean {
  assertNginxBootstrap();
  const configPath = pathLib.join(NGINX_DIR, `${slug}.conf`);
  if (!existsSync(configPath)) return false;
  unlinkSync(configPath);
  return true;
}

/**
 * sudo nginx -t (검증) → 통과하면 sudo nginx -s reload.
 * 실패 시 throw (호출자가 conf 파일 rollback 책임).
 */
export async function reloadNginx(): Promise<void> {
  // 1) syntax check
  const test = await runCmd('sudo', ['/usr/sbin/nginx', '-t']);
  if (test.exit_code !== 0) {
    throw new Error(`nginx -t failed (exit ${test.exit_code}): ${test.stderr}${test.stdout}`);
  }
  // 2) graceful reload
  const reload = await runCmd('sudo', ['/usr/sbin/nginx', '-s', 'reload']);
  if (reload.exit_code !== 0) {
    throw new Error(`nginx -s reload failed (exit ${reload.exit_code}): ${reload.stderr}${reload.stdout}`);
  }
}

/**
 * Tool 의 server block 작성 + reload. reload 실패 시 conf 파일 rollback.
 */
export async function provisionTool(tool: ToolForNginx): Promise<{ slug: string; url: string }> {
  const { slug, configPath, url } = await writeNginxConfig(tool);
  try {
    await reloadNginx();
  } catch (e) {
    // rollback
    try { unlinkSync(configPath); } catch { /* best effort */ }
    throw new Error(`nginx provision failed for ${slug}: ${(e as Error).message}`);
  }
  return { slug, url };
}

/**
 * Tool 제거 + reload. reload 실패해도 *파일은* 이미 삭제 (best-effort).
 */
export async function deprovisionTool(slug: string): Promise<void> {
  removeToolConfig(slug);
  try {
    await reloadNginx();
  } catch {
    // 파일 이미 삭제됐고 nginx 는 다음 정상 reload 까지 옛 config 유지 — 안전 영역.
  }
}

// ── helpers ──────────────────────────────────────────────────────────────
async function runCmd(
  cmd: string,
  args: string[],
): Promise<{ exit_code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      resolve({ exit_code: code ?? -1, stdout, stderr });
    });
  });
}
