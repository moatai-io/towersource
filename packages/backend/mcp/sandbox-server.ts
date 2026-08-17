/**
 * sandbox-server.ts — In-process MCP server exposing sandbox tools to Claude.
 *
 * Phase 1b 시점부터 이 파일은 *얇은 어댑터* 역할만:
 *   AI 가 호출 → MCP 가 인자 검증 → services/sandbox.ts::sandboxRun() 위임
 *
 * 4계층 토글, 동시 실행 cap, DB 감사, ssh exec, base64 escaping —
 * 전부 services/sandbox.ts 가 책임. 이 파일은 closure 로 userId/sessionId 만
 * 주입해서 AI 가 위조 못 하도록 하는 보안 layer.
 *
 * 결정:
 *   workspace/decisions/2026-04-24-execution-sandbox-scope.md (D6, D7)
 *   workspace/decisions/2026-04-28-execution-sandbox-q4-package-scope.md (runtime variants)
 *   workspace/decisions/2026-04-28-execution-sandbox-d1-revisited.md (Phase 2 hint)
 *
 * 자원 부담:
 *   - Stdio MCP 가 아닌 In-process — 별도 프로세스 0
 *   - 세션마다 createSandboxMcpServer() 호출 → 객체 1개 (~수 KB)
 *   - sandboxEnabled 사용자 세션에만 mount (claude-engine.ts) → 비활성 사용자엔 객체 X
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { sandboxRun, SandboxDeniedError, type SandboxRuntime } from '../services/deploy/sandbox.js';
import {
  sandboxToolStart,
  sandboxToolStop,
  sandboxToolList,
  sandboxToolLogs,
  sandboxToolRestart,
  sandboxToolUpdateVisibility,
  type ToolVisibility,
} from '../services/deploy/sandbox-tools.js';

export interface SandboxMcpContext {
  userId: number;
  sessionId: string;
}

/**
 * 세션마다 1회 호출. ctx.userId / ctx.sessionId 를 closure 에 가둬서
 * AI 가 호출 인자로 위조 못 하게 함.
 */
export function createSandboxMcpServer(ctx: SandboxMcpContext) {
  return createSdkMcpServer({
    name: 'sandbox',
    version: '0.2.0',
    tools: [
      tool(
        'run',
        [
          'Run short Python/Node/bash code in an isolated container on the execution VM.',
          'Two modes:',
          '  A) inline `code` — quick computation/verification (workspace not mounted).',
          '  B) workspace file — pass `workspace_path` (e.g. "projects/foo") + `entrypoint`',
          '     (e.g. "python main.py"). The folder is read-only mounted at /workspace,',
          '     and any files the script writes to /scratch are recovered to the user',
          '     workspace under .sandbox/runs/<id>/ for download.',
          'Limits per call: timeout 60s default (max 300), memory 512MB, CPU 0.5 vCPU,',
          'network blocked, /workspace ro / /scratch rw / /tmp tmpfs.',
          'Do NOT use for: long-running services (use sandbox.tool.start in Phase 2),',
          'anything needing internet, or pip/npm install (Q4 — pre-installed images only).',
        ].join(' '),
        {
          runtime: z
            .enum(['python', 'python-data', 'python-web', 'python-tools', 'node', 'node-utils', 'bash'])
            .describe('Runtime image. python=stdlib, python-data=numpy/pandas/matplotlib, python-web=fastapi/uvicorn/httpx/pydantic/requests, python-tools=Python + FFmpeg/LibreOffice/Tesseract/Pandoc/GS/ImageMagick + 한글 폰트, node=stdlib, bash=shell.'),
          code: z
            .string()
            .min(1)
            .max(50_000)
            .optional()
            .describe('Mode A: source code to execute directly. Mutually exclusive with workspace_path.'),
          workspace_path: z
            .string()
            .min(1)
            .max(500)
            .optional()
            .describe('Mode B: workspace-relative folder (e.g. "projects/foo"). Mounted ro at /workspace inside container. Requires `entrypoint`.'),
          entrypoint: z
            .string()
            .min(1)
            .max(500)
            .optional()
            .describe('Mode B: command to run inside /workspace (e.g. "python main.py", "node server.js"). Requires `workspace_path`.'),
          timeout_sec: z
            .number()
            .int()
            .min(1)
            .max(300)
            .optional()
            .describe('Hard timeout in seconds. Default 60, max 300.'),
          secrets: z
            .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/))
            .max(10)
            .optional()
            .describe('Secret names (NOT values) to inject as ENV vars. Tower vault decrypts on demand and injects via docker -e. Audit log keeps names only. Example: ["OPENAI_API_KEY"]. Permission denied → SecretAccessDeniedError.'),
          allow_outbound: z
            .boolean()
            .optional()
            .describe('D10 outbound — true 면 화이트리스트 도메인 (pypi.org, files.pythonhosted.org, npmjs.org, github.com, githubusercontent.com 의 GET/HEAD/CONNECT) 호출 허용. 기본 false (--network none, 모든 외부 차단). 다른 도메인이나 POST/PUT/DELETE 는 squid 가 403. 새 도메인 필요 시 결정 문서로 추가 후 squid.conf 갱신.'),
          host_mounts: z
            .array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/))
            .max(8)
            .optional()
            .describe('D15 host_mounts — sandbox VM 호스트의 /opt/sandbox-tools/<name>/ 을 컨테이너에 /opt/<name>:ro 로 read-only mount. 큰/드문 third-party binary 도구 (QCAD, Blender, ODA File Converter 등). 흔한 도구 (FFmpeg, LibreOffice, Tesseract, Pandoc 등) 는 runtime:"python-tools" 사용. 설치 카탈로그: /opt/sandbox-tools/.registry.json. admin/operator 가 ~/workspace/scripts/sandbox-tool-install.sh 로 설치.'),
        },
        async (args, _extra) => {
          try {
            // 핵심: services/sandbox.ts 에 위임. closure 로 userId/sessionId 주입.
            const result = await sandboxRun({
              userId: ctx.userId,
              sessionId: ctx.sessionId,
              runtime: args.runtime as SandboxRuntime,
              code: args.code,
              workspace_path: args.workspace_path,
              entrypoint: args.entrypoint,
              timeout_sec: args.timeout_sec,
              secrets: args.secrets,
              allow_outbound: args.allow_outbound,
              host_mounts: args.host_mounts,
            });

            // Phase 1c 응답: JSON 한 덩어리 (mode 포함). 향후 WS 스트리밍으로 분리.
            const payload = {
              run_id: result.run_id,
              mode: result.mode,
              user_id: ctx.userId,
              session_id: ctx.sessionId,
              runtime: args.runtime,
              exit_code: result.exit_code,
              duration_ms: result.duration_ms,
              oom_killed: result.oom_killed,
              timed_out: result.timed_out,
              stdout: result.stdout,
              stderr: result.stderr,
              scratch_files: result.scratch_files,
            };

            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(payload, null, 2),
                },
              ],
              isError: result.exit_code !== 0,
            };
          } catch (e) {
            // 4계층 토글 거부, 동시 실행 cap, ssh 실패 등 — 모두 SandboxDeniedError or generic Error.
            const isDenied = e instanceof SandboxDeniedError;
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: (e as Error).message,
                    error_type: isDenied ? 'denied' : 'execution_error',
                  }),
                },
              ],
              isError: true,
            };
          }
        },
      ),

      // ── Phase 2a-1: long-running internal containers ──────────────────
      // 결정: workspace/decisions/2026-04-29-execution-sandbox-q13-tool-start-api.md
      // Phase 2a-1 은 visibility='private' 만. auth-required/unlisted/public 은 후속.

      tool(
        'tool_start',
        [
          'Start a LONG-RUNNING container (FastAPI mini-backend, worker, crawler) on the',
          'execution VM. Lifecycle: --restart=unless-stopped + expires_at (default 7d).',
          'Phase 2a-1 supports visibility="private" only — no external URL, callers must',
          'use docker exec or the container_id. (auth-required/unlisted/public coming.)',
          'Caps: 10 running tools globally, 3 per user, expires max 30d.',
        ].join(' '),
        {
          name: z.string().min(1).max(32).regex(/^[a-z0-9][a-z0-9-]{0,31}$/)
            .describe('Tool name, unique per user. Lowercase a-z 0-9 - only.'),
          runtime: z.enum(['python', 'python-data', 'python-web', 'python-tools', 'node', 'node-utils', 'bash'])
            .describe('Image variant. python-web has fastapi/uvicorn pre-installed. python-tools adds FFmpeg/LibreOffice/Tesseract/Pandoc/GS/ImageMagick + 한글 폰트.'),
          workspace_path: z.string().min(1).max(500)
            .describe('Workspace-relative folder (e.g. "projects/foo"). Mounted ro at /workspace.'),
          entrypoint: z.string().min(1).max(500)
            .describe('Command to run (e.g. "uvicorn main:app --host 0.0.0.0 --port 8000").'),
          port: z.number().int().min(1).max(65535).optional()
            .describe('Container internal port (Phase 2a-1 metadata only — no external publish yet).'),
          cpu_limit: z.number().min(0.05).max(1.0).optional()
            .describe('vCPU cap. Default 0.25, max 1.0.'),
          memory_mb: z.number().int().min(64).max(1024).optional()
            .describe('Memory cap MB. Default 256, max 1024.'),
          expires_in_days: z.number().int().min(1).max(30).optional()
            .describe('Auto-stop after N days. Default 7, max 30.'),
          env: z.record(z.string(), z.string()).optional()
            .describe('Plain env vars (logged in audit). Keys must be UPPER_SNAKE.'),
          visibility: z.enum(['private', 'auth-required', 'unlisted', 'public']).optional()
            .describe([
              'External exposure level (Phase 2a-3 — all 4 active):',
              '  private (default): no external URL, docker exec only.',
              '  auth-required: https://<owner>-<name>.tower.tower.example.com/, Tower session cookie required.',
              '  unlisted: https://<owner>-<name>-<6hex>.tower.tower.example.com/, no auth, URL-guess-resistant + rate limited + noindex.',
              '  public: https://<name>.tower.tower.example.com/, no auth, indexable, rate limited. REQUIRES explicit user confirmation (AskUserQuestion gate in PreToolUse hook).',
              'visibility != "private" requires `port`.',
            ].join(' ')),
          host_mounts: z
            .array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/))
            .max(8)
            .optional()
            .describe('D15 host_mounts — /opt/sandbox-tools/<name> → /opt/<name>:ro. Same rules as sandbox.run host_mounts.'),
        },
        async (args) => {
          try {
            const result = await sandboxToolStart({
              userId: ctx.userId,
              name: args.name,
              runtime: args.runtime as SandboxRuntime,
              workspace_path: args.workspace_path,
              entrypoint: args.entrypoint,
              port: args.port,
              cpu_limit: args.cpu_limit,
              memory_mb: args.memory_mb,
              expires_in_days: args.expires_in_days,
              env: args.env,
              visibility: args.visibility as ToolVisibility | undefined,
              host_mounts: args.host_mounts,
            });
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            };
          } catch (e) {
            const isDenied = e instanceof SandboxDeniedError;
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  error: (e as Error).message,
                  error_type: isDenied ? 'denied' : 'execution_error',
                }),
              }],
              isError: true,
            };
          }
        },
      ),

      tool(
        'tool_stop',
        'Stop a running internal tool (docker stop + rm). Owner or admin/operator only.',
        {
          tool_id: z.number().int().positive().describe('internal_tools.id from tool_start.'),
        },
        async (args) => {
          try {
            const result = await sandboxToolStop(args.tool_id, ctx.userId);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          } catch (e) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ error: (e as Error).message }),
              }],
              isError: true,
            };
          }
        },
      ),

      tool(
        'tool_list',
        'List internal tools owned by the current user (or all, if owner_only=false and admin/operator).',
        {
          owner_only: z.boolean().optional().describe('Default true. Set false to list all (admin/operator only).'),
        },
        async (args) => {
          try {
            const tools = await sandboxToolList({
              userId: ctx.userId,
              ownerOnly: args.owner_only,
            });
            // 가벼운 요약 — 큰 컬럼은 잘라서 응답
            const summary = tools.map(t => ({
              id: t.id,
              owner_user_id: t.owner_user_id,
              name: t.name,
              status: t.status,
              runtime: t.runtime,
              entrypoint: t.entrypoint,
              port: t.port,
              host_port: t.host_port,
              visibility: t.visibility,
              expires_at: t.expires_at,
              container_id: t.container_id?.slice(0, 12),
              last_error: t.last_error?.slice(0, 200),
            }));
            return { content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }] };
          } catch (e) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ error: (e as Error).message }),
              }],
              isError: true,
            };
          }
        },
      ),

      tool(
        'tool_logs',
        'Tail recent logs from an internal tool container (docker logs --tail N). Owner only.',
        {
          tool_id: z.number().int().positive().describe('internal_tools.id'),
          tail: z.number().int().min(1).max(5000).optional().describe('Lines to tail. Default 200, max 5000.'),
        },
        async (args) => {
          try {
            const logs = await sandboxToolLogs(args.tool_id, ctx.userId, { tail: args.tail });
            // last 100KB cap (text payload)
            const trimmed = logs.length > 100_000 ? logs.slice(-100_000) : logs;
            return { content: [{ type: 'text' as const, text: trimmed }] };
          } catch (e) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ error: (e as Error).message }),
              }],
              isError: true,
            };
          }
        },
      ),

      // ── Phase 2a-3: restart + update_visibility ──────────────────────────
      // 결정: workspace/decisions/2026-05-13-execution-sandbox-phase2a3-unlisted-public.md

      tool(
        'tool_restart',
        [
          'Docker restart of a running internal tool. Container stays the same — host_port, URL,',
          'secrets, nginx config all preserved. workspace mount is re-mounted so any code edits',
          'in the source folder are picked up. ~5s downtime.',
          'Typical flow: 1) edit main.py in workspace, 2) tool_restart(id), 3) new code is live.',
          'Returns { ok, container_id, restarted_at, url }. Owner / admin / operator only.',
        ].join(' '),
        {
          tool_id: z.number().int().positive().describe('internal_tools.id from tool_start.'),
        },
        async (args) => {
          try {
            const result = await sandboxToolRestart(args.tool_id, ctx.userId);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
          } catch (e) {
            const isDenied = e instanceof SandboxDeniedError;
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  error: (e as Error).message,
                  error_type: isDenied ? 'denied' : 'execution_error',
                }),
              }],
              isError: true,
            };
          }
        },
      ),

      tool(
        'tool_update_visibility',
        [
          "Change a running tool's external exposure level. Container stays the same — only the",
          'nginx server block + ssh tunnel change. URL changes accordingly:',
          '  auth-required → <owner>-<name>.tower.tower.example.com/ (Tower login)',
          '  unlisted      → <owner>-<name>-<6hex>.tower.tower.example.com/ (no auth, suffix saved for reuse)',
          '  public        → <name>.tower.tower.example.com/ (no auth, indexed; REQUIRES user confirmation gate)',
          '  private       → no external URL, ssh tunnel torn down',
          'unlisted suffix is created once and reused across visibility changes (URL stability).',
          'public has no owner namespace — DNS reserved names + global uniqueness checked.',
          'Owner / admin / operator only.',
        ].join(' '),
        {
          tool_id: z.number().int().positive().describe('internal_tools.id'),
          visibility: z.enum(['private', 'auth-required', 'unlisted', 'public'])
            .describe('Target visibility. See tool_start for semantics.'),
        },
        async (args) => {
          try {
            const result = await sandboxToolUpdateVisibility(
              args.tool_id,
              ctx.userId,
              args.visibility as ToolVisibility,
            );
            return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
          } catch (e) {
            const isDenied = e instanceof SandboxDeniedError;
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  error: (e as Error).message,
                  error_type: isDenied ? 'denied' : 'execution_error',
                }),
              }],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
