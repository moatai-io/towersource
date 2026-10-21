/**
 * runtime-box-server.ts — Project Runtime Box MCP server.
 *
 * AI 에게 project_shell / service_list / service_start / service_stop
 * 네 가지 도구를 제공.
 *
 * 핵심 원칙:
 *   - 이 서버의 도구는 항상 Project Runtime Box 를 통해 실행됨.
 *     host Bash (admin Bash tool) 와 이름·개념이 명확히 분리.
 *   - AI 는 project_shell 을 쓰면 자동으로 올바른 project box 에 라우팅됨.
 *   - RuntimeContext banner 가 응답에 포함 → AI 가 host와 box 혼동 방지.
 *
 * 결정:
 *   workspace/decisions/2026-06-02-project-runtime-box-product-framing.md
 *   workspace/decisions/2026-06-01-project-runtime-plane-stress-test.md §9.2
 *
 * ⚠️ v1 현재 상태:
 *   - 도구 정의 + 라우팅 로직은 완성.
 *   - 실제 Docker exec 는 STUB (execInBox 내부 TODO #3).
 *   - 서비스 start/stop 는 registry 등록만 함 (Docker 프로세스 제어 TODO #4).
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  getOrCreateBox,
  execInBox,
  RuntimeBoxError,
} from '../services/runtime-box/runtime-box-manager.js';
import {
  listServices,
  registerService,
  stopService,
  formatServiceList,
} from '../services/runtime-box/service-registry.js';
import {
  classifyCommand,
  extractPortFromCommand,
} from '../services/execution/command-classifier.js';
import { RUNTIME_BOX_EXEC_TIMEOUT_MAX_SEC } from '../services/runtime-box/types.js';
import type { RuntimeContext } from '../services/runtime-box/types.js';

// ── Context 타입 (sandbox-server.ts 와 동일 패턴) ────────────────────────

export interface RuntimeBoxMcpContext {
  userId: number;
  sessionId: string;
  projectId: string;   // 현재 세션의 프로젝트 ID (없으면 도구 미마운트)
  projectName: string; // 사람이 읽는 이름 (banner 용)
}

// ── 응답 포맷 헬퍼 ────────────────────────────────────────────────────────

/**
 * RuntimeContext 를 AI 가 읽기 쉬운 텍스트 banner 로 변환.
 * 결정: workspace/decisions/2026-06-01-project-runtime-plane-stress-test.md §9.1
 */
function formatBanner(ctx: RuntimeContext): string {
  const svcLine = ctx.services_running.length > 0
    ? ctx.services_running.map(s => `${s.name}${s.port ? `:${s.port}` : ''}`).join(', ')
    : '없음';

  const readinessLine = ctx.readiness
    ? `${ctx.readiness.baseline}: ${ctx.readiness.capabilities.join(', ')}; doctor: ${ctx.readiness.doctor_command}`
    : 'unknown';
  const harnessLine = ctx.readiness?.harness_preferred?.length
    ? ctx.readiness.harness_preferred.join('; ')
    : '없음';

  return [
    `Runtime: project-runtime-box`,
    `Project: ${ctx.project_id}`,
    `CWD: ${ctx.cwd}`,
    `Mount: ${ctx.mount}`,
    `Services: ${svcLine}`,
    `Readiness: ${readinessLine}`,
    `Harness preferred: ${harnessLine}`,
    `Limits: ${ctx.box_limits.memory_mb}MB RAM / ${ctx.box_limits.cpu} CPU / idle stop ${ctx.box_limits.idle_stop_minutes}m`,
  ].join('\n');
}

// ── MCP 서버 생성 ─────────────────────────────────────────────────────────

/**
 * 세션마다 1회 호출. ctx.userId / ctx.projectId 를 closure 에 가둬서
 * AI 가 호출 인자로 위조 못 하게 함.
 *
 * 프로젝트 컨텍스트가 없는 세션에는 마운트하지 말 것 — projectId 가 없으면
 * Box 를 어느 프로젝트에 귀속시킬지 알 수 없음.
 */
export function createRuntimeBoxMcpServer(ctx: RuntimeBoxMcpContext) {
  return createSdkMcpServer({
    name: 'runtime-box',
    version: '0.1.0',
    tools: [

      // ── project_shell ────────────────────────────────────────────────

      tool(
        'project_shell',
        [
          `Run a command inside the Project Runtime Box for project "${ctx.projectName}".`,
          'The box has your project folder mounted at /workspace (read-write).',
          'npm install, npm test, python script.py, git status — all work like local.',
          '',
          'IMPORTANT: This is NOT host bash. Commands run inside the project box,',
          'not on the Tower server itself. You cannot access other projects, host',
          'config, or Tower secrets from here.',
          '',
          'For long-running servers (npm run dev, uvicorn, etc.) — consider using',
          'service_start instead so Tower can track logs, ports, and TTL.',
          '',
          'Response includes a runtime_context banner — use it to verify you are',
          'inside the correct project box.',
        ].join(' '),
        {
          cmd: z.string().min(1).max(2000)
            .describe('Shell command to run. Executed in /workspace (project root). Examples: "npm install", "python main.py", "ls -la src/"'),
          cwd: z.string().optional()
            .describe('Working directory inside the box. Must be /workspace or a subdirectory. Default: /workspace'),
          timeout_sec: z.number().int().min(1).max(RUNTIME_BOX_EXEC_TIMEOUT_MAX_SEC).optional()
            .describe(`Timeout in seconds. Default 60, max ${RUNTIME_BOX_EXEC_TIMEOUT_MAX_SEC} (15 min). For long-running servers use service_start.`),
          env: z.record(z.string(), z.string()).optional()
            .describe('Extra environment variables. Tower host secrets (API keys etc.) are NOT available here by design.'),
        },
        async ({ cmd, cwd, timeout_sec, env }) => {
          // 명령 분류 (사용자/AI 에게 힌트 제공)
          const classification = classifyCommand(cmd);

          // long-running 경고 (차단하지는 않음 — v1 에서는 허용)
          const longRunningHint = classification.cls === 'long-running'
            ? `\n\n⚠️ 장기 실행 명령으로 감지됨. service_start 도구를 쓰면 Tower 가 ` +
              `포트·로그·TTL 을 추적합니다. (추천 서비스명: '${classification.suggested_service_name}')`
            : '';

          // risky 경고
          const riskyHint = classification.cls === 'risky'
            ? `\n\n⚠️ 고위험 명령 패턴 감지됨. 이 명령은 future 버전에서 Secure Run 으로 승격 예정.`
            : '';

          try {
            const box = await getOrCreateBox(ctx.projectId, ctx.userId);
            const result = await execInBox({
              boxId: box.id,
              userId: ctx.userId,
              sessionId: ctx.sessionId,
              cmd,
              cwd,
              timeout_sec,
              env: env as Record<string, string> | undefined,
            });

            const banner = formatBanner(result.runtime_context);
            const exitLine = result.exit_code !== 0
              ? `\n\n[Exit: ${result.exit_code}${result.timed_out ? ', TIMEOUT' : ''}${result.oom_killed ? ', OOM' : ''}]`
              : '';

            return {
              content: [{
                type: 'text' as const,
                text: [
                  '--- Runtime Context ---',
                  banner,
                  '--- Output ---',
                  result.stdout || '(no stdout)',
                  result.stderr ? `\n--- Stderr ---\n${result.stderr}` : '',
                  exitLine,
                  longRunningHint,
                  riskyHint,
                ].join('\n').trim(),
              }],
            };
          } catch (e) {
            const msg = e instanceof RuntimeBoxError ? e.reason : (e as Error).message;
            return {
              content: [{ type: 'text' as const, text: `[RuntimeBox Error] ${msg}` }],
              isError: true,
            };
          }
        },
      ),

      // ── service_list ─────────────────────────────────────────────────

      tool(
        'service_list',
        `List running services in the project "${ctx.projectName}" Runtime Box. ` +
        'Shows name, port, status, command, and whether pinned.',
        {},
        async () => {
          try {
            const services = await listServices(ctx.projectId);
            return {
              content: [{
                type: 'text' as const,
                text: `Project "${ctx.projectName}" 서비스:\n${formatServiceList(services)}`,
              }],
            };
          } catch (e) {
            return {
              content: [{ type: 'text' as const, text: `[Error] ${(e as Error).message}` }],
              isError: true,
            };
          }
        },
      ),

      // ── service_start ─────────────────────────────────────────────────

      tool(
        'service_start',
        [
          `Register and start a long-running service in the "${ctx.projectName}" Runtime Box.`,
          'Use this for servers (npm run dev, uvicorn, node server.js) so Tower can',
          'track the port, logs, TTL, and optionally expose a preview URL.',
          '',
          'After calling this, use service_list to see the service URL and status.',
        ].join(' '),
        {
          name: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/)
            .describe('Service name. Lowercase, alphanumeric + hyphen. E.g. "dev", "api", "worker"'),
          command: z.string().min(1).max(500)
            .describe('Command to run. E.g. "npm run dev", "uvicorn main:app --host 0.0.0.0 --port 8000"'),
          port: z.number().int().min(1024).max(65535).optional()
            .describe('Port the service listens on inside the box. Auto-detected from command if omitted.'),
          pinned: z.boolean().optional()
            .describe('If true, service is not stopped by TTL. Requires purpose.'),
          purpose: z.string().optional()
            .describe('Required when pinned=true. Describe why this service should be kept running.'),
          ttl_hours: z.number().int().min(1).max(168).optional()
            .describe('Time-to-live in hours (default 2). After this, service is expired. Ignored if pinned=true.'),
        },
        async ({ name, command, port, pinned, purpose, ttl_hours }) => {
          if (pinned && !purpose?.trim()) {
            return {
              content: [{
                type: 'text' as const,
                text: '[Error] pinned 서비스에는 purpose (사용 목적) 가 필수입니다.',
              }],
              isError: true,
            };
          }

          try {
            const box = await getOrCreateBox(ctx.projectId, ctx.userId);

            // 포트 자동 감지
            const detectedPort = port ?? extractPortFromCommand(command);

            const svc = await registerService({
              boxId: box.id,
              projectId: ctx.projectId,
              userId: ctx.userId,
              name,
              command,
              internalPort: detectedPort,
              visibility: 'project-internal',
              pinned: pinned ?? false,
              purpose,
              ttlHours: ttl_hours,
            });

            const portLine = svc.internal_port ? ` (port ${svc.internal_port})` : '';
            const pinLine = svc.pinned ? ` [PINNED — review after ${svc.review_after?.slice(0, 10)}]` : ` [TTL: ${svc.ttl_hours}h]`;

            return {
              content: [{
                type: 'text' as const,
                text: [
                  `✅ 서비스 '${name}' 등록됨${portLine}${pinLine}`,
                  `명령: ${command}`,
                  `⚠️ NOTE: v1 STUB — 실제 Docker 프로세스 시작은 TODO #4 구현 후 동작.`,
                  `현재는 레지스트리 등록만 됨.`,
                ].join('\n'),
              }],
            };
          } catch (e) {
            const msg = e instanceof RuntimeBoxError ? e.reason : (e as Error).message;
            return {
              content: [{ type: 'text' as const, text: `[Error] ${msg}` }],
              isError: true,
            };
          }
        },
      ),

      // ── service_stop ─────────────────────────────────────────────────

      tool(
        'service_stop',
        `Stop a running service in the "${ctx.projectName}" Runtime Box.`,
        {
          service_id: z.number().int().positive()
            .describe('Service ID (from service_list output).'),
        },
        async ({ service_id }) => {
          try {
            await stopService(service_id);
            return {
              content: [{
                type: 'text' as const,
                text: `서비스 ${service_id} 중지됨.`,
              }],
            };
          } catch (e) {
            const msg = e instanceof RuntimeBoxError ? e.reason : (e as Error).message;
            return {
              content: [{ type: 'text' as const, text: `[Error] ${msg}` }],
              isError: true,
            };
          }
        },
      ),

    ], // end tools
  });
}

export type RuntimeBoxMcpServer = ReturnType<typeof createRuntimeBoxMcpServer>;
