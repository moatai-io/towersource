import { createSleepMcpServer } from '../mcp/sleep-server.js';
/**
 * Claude Code engine — wraps @anthropic-ai/claude-agent-sdk.
 *
 * Absorbs all Claude-specific logic from claude-sdk.ts and ws-handler.ts.
 * ws-handler.ts only sees the Engine interface; it never imports this file directly.
 *
 * To remove Claude: delete this file + remove 'claude' case from engines/index.ts.
 */

import { v4 as uuidv4 } from 'uuid';
import type { Engine, RunOpts, EngineCallbacks, TowerMessage, TowerContentBlock, QuickReplyOpts, ChannelReplyOpts, ChannelReplyResult } from './types.js';
import {
  executeQuery,
  abortSession,
  cleanupSession,
  getSessionAbortSignal,
  getClaudeSessionId,
  getActiveSessionCount,
  getRunningSessionIds as sdkGetRunningSessionIds,
  getSession as getSDKSession,
  backupSessionFile,
  cleanupOrphanedSdkProcesses,
  stopOrphanMonitor,
  gracefulShutdown,
} from '../services/ai/claude-sdk.js';
import { config, getPermissionMode } from '../config.js';
import { buildSystemPrompt } from '../services/system-prompt.js';
import { buildToolGuard, resolveSessionProjectRoot, type ToolGuard } from '../services/pm/project-access.js';
import { autoCommit } from '../services/git/git-manager.js';
import { getConfigDir } from '../services/auth/credential-store.js';

// CRITICAL: Remove CLAUDECODE env var to prevent SDK conflicts
delete process.env.CLAUDECODE;

function extractThinkingTitle(raw?: string): string | undefined {
  if (!raw) return undefined;

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const firstLine = lines[0];
  if (!firstLine) return undefined;

  const boldTitle = firstLine.match(/^\*\*(.+?)\*\*[：:]?$/);
  if (boldTitle?.[1]) return boldTitle[1].trim();

  const headingTitle = firstLine.match(/^#{1,6}\s+(.+)$/);
  if (headingTitle?.[1]) return headingTitle[1].trim();

  return undefined;
}

export class ClaudeEngine implements Engine {

  // ═══════════════════════════════════════════════════════════════
  // Engine.run() — main entry point, replaces handleChat() logic
  //
  // 🔀 AI 실행 경로 3종 중 하나 (Session). 다른 둘:
  //   - Channel AI (@ai) → channelReply() 아래
  //   - Task (@task)     → packages/backend/services/task-runner.ts
  // 셋 비교표 + 드리프트 핫스팟: docs/tower-guide/ai-execution-paths.md
  // 옵션/가드/시스템프롬프트 모드 변경 시 셋 다 검토 필요.
  // ═══════════════════════════════════════════════════════════════

  async *run(
    sessionId: string,
    prompt: string,
    opts: RunOpts,
    callbacks: EngineCallbacks,
  ): AsyncGenerator<TowerMessage> {
    const permissionMode = getPermissionMode(opts.userRole);

    // Build unified tool guard (damage control + session write guard + path enforcement + project ACL)
    const sessionProjectRoot = resolveSessionProjectRoot(opts.cwd) ?? undefined;
    const guard = buildToolGuard({
      role: opts.userRole || 'member',
      allowedPath: opts.allowedPath,
      accessiblePaths: opts.accessiblePaths,
      readOnlyPaths: opts.readOnlyPaths,
      denyImplicitBash: opts.denyImplicitBash,
      channelSafeToolsOnly: opts.channelSafeToolsOnly,
      sessionProjectRoot,
      maintenanceGrant: opts.maintenanceGrant,
    });
    if (sessionProjectRoot) {
      console.log(`[Claude] Session write guard active: ${sessionProjectRoot}`);
    }

    // Build canUseTool interceptor (guard + AskUserQuestion → callbacks.askUser)
    const canUseTool = this.createCanUseTool(sessionId, guard, callbacks);

    // Build system prompt (Layer 2: team rules + role context)
    // Phase 5 (D12 활성, 2026-05-04) — sandbox 가 모든 프로필 (full + managed)
    // 의 기본 호스팅 모델. 단 standalone 은 운영자가 자기 인프라 가져오는
    // 경우라 EXECUTION_VM_HOST 가 비면 자연스럽게 비활성. towerRole gate 제거.
    // 결정: workspace/decisions/2026-05-02-execution-sandbox-d12-sibling-sandbox-mandatory.md
    const { config: srvCfgForPrompt } = await import('../config.js');
    const sandboxAvailable =
      srvCfgForPrompt.sandbox.enabled &&
      !!srvCfgForPrompt.sandbox.vmHost &&
      !!opts.userId;
    // Cacheable build (2026-05-14): returns `[staticBlock, BOUNDARY, dynamicBlock]`
    // so the SDK applies cache_control to the static prefix (core + orgPolicy).
    // Cross-session cache hit eliminates ~15-20K cache_creation tokens per new
    // session. See: workspace/decisions/2026-05-14-sdk-credit-economy.md
    const baseSystemPromptBlocks = await buildSystemPrompt(
      {
        userId: opts.userId,
        username: opts.username || 'anonymous',
        role: opts.userRole || 'member',
        allowedPath: opts.allowedPath,
        sessionProjectRoot,
        projectId: opts.projectId,
        sandboxEnabled: sandboxAvailable,
        optionalFragments: opts.systemPromptFragments,
        sessionId,  // 2026-05-10: surfaces session UUID + _team/people/<u>.md profile
      },
      { cacheable: true },
    );

    // baseSystemPromptBlocks = [staticBlock, BOUNDARY, dynamicBlock].
    // The retired PM/Ideas feed is no longer injected into active Claude runs.
    const systemPrompt: string[] = baseSystemPromptBlocks;

    // Resolve credential directory for this project (multi-account rotation)
    const configDir = await getConfigDir(opts.projectId);

    let engineSessionId: string | undefined;
    let currentAssistantId: string | null = null;
    const editedFiles = new Set<string>();
    let isCompacting = false;

    // Phase 5 (D12 활성) — sandbox MCP server (in-process). 4계층 토글:
    //   1. 서버: config.sandbox.enabled (.env)
    //   2. 호스트 도달: config.sandbox.vmHost 가 비어있지 않음 (standalone 안전망)
    //   3. 사용자: users.sandbox_enabled — sandbox.ts 호출 시점에 검사 (방어적 layer)
    //   4. 세션: AI tool 호출 시점 (자동 충족)
    // mount 자체는 1+2 만 보고 결정. 사용자 토글은 매 turn DB 조회를 피하기 위해
    // 호출 시점에 검사. 비활성 사용자는 도구 호출 시 SandboxDeniedError 받음.
    // self-hosted VM 도 자기 형제 execution VM 이 있으면 활성 (D12).
    // 결정: workspace/decisions/2026-05-02-execution-sandbox-d12-sibling-sandbox-mandatory.md
    const towerMcpServers: Record<string, any> = {
      wait: createSleepMcpServer({ sessionId, rootTurnId: opts.rootTurnId, getSignal: () => getSessionAbortSignal(sessionId) }),
    };

    // Sandbox MCP (D11/D12 — execution isolation, gated by 4 toggles)
    try {
      if (sandboxAvailable) {
        const { createSandboxMcpServer } = await import('../mcp/sandbox-server.js');
        towerMcpServers.sandbox = createSandboxMcpServer({ userId: opts.userId!, sessionId });
      }
    } catch (err) {
      console.warn('[claude-engine] sandbox MCP mount failed:', err);
    }

    // Session control MCP — thin current-session metadata primitives.
    // Thick skills decide when to use this; the MCP server only executes the
    // closure-bound current-session operation after the model has user consent.
    try {
      if (opts.userId) {
        const { createSessionControlMcpServer } = await import('../mcp/session-control-server.js');
        towerMcpServers['session-control'] = createSessionControlMcpServer({
          sessionId,
          userId: opts.userId,
          userRole: opts.userRole,
        });
      }
    } catch (err) {
      console.warn('[claude-engine] session-control MCP mount failed:', err);
    }

    // Schedule MCP — create low-risk AI prompt schedules using closure-bound
    // Tower user/project identity. Keeps API tokens out of AI/runtime boxes.
    try {
      if (opts.userId) {
        const { createScheduleMcpServer } = await import('../mcp/schedule-server.js');
        towerMcpServers.schedule = createScheduleMcpServer({
          sessionId,
          userId: opts.userId,
          userRole: opts.userRole,
          projectId: opts.projectId,
          cwd: opts.cwd,
        });
      }
    } catch (err) {
      console.warn('[claude-engine] schedule MCP mount failed:', err);
    }

    // Issue MCP — file Tower feedback using VM service credentials, not
    // per-user/runtime GH_TOKEN.
    try {
      if (opts.userId) {
        const { createIssueMcpServer } = await import('../mcp/issue-server.js');
        towerMcpServers.issue = createIssueMcpServer({
          sessionId,
          userId: opts.userId,
          username: opts.username,
          userRole: opts.userRole,
          projectId: opts.projectId,
          cwd: opts.cwd,
        });
      }
    } catch (err) {
      console.warn('[claude-engine] issue MCP mount failed:', err);
    }

    // L3 session-spawn MCP — parent → sidebar peer + soft delete
    // Mounted for every authenticated session (the closure binds parentSessionId/userId
    // so the AI cannot forge a different parent). Tool description carries the
    // policy: do NOT self-spawn, only on user request or skill invocation.
    // Decision: workspace/decisions/2026-05-09-l3-session-spawn-rpc.md
    try {
      if (opts.userId) {
        const { createSpawnMcpServer } = await import('../mcp/spawn-server.js');
        towerMcpServers['tower-spawn'] = createSpawnMcpServer({
          parentSessionId: sessionId,
          parentUserId: opts.userId,
          parentUsername: opts.username,
          parentRole: opts.userRole,
        });
      }
    } catch (err) {
      console.warn('[claude-engine] spawn MCP mount failed:', err);
    }

    const mcpServers = Object.keys(towerMcpServers).length > 0 ? towerMcpServers : undefined;
    const convertContent = this.convertContent.bind(this);

    const runClaudeQuery = async function* (
      resumeSessionId: string | undefined,
    ): AsyncGenerator<TowerMessage> {
      for await (const message of executeQuery(sessionId, prompt, {
        cwd: opts.cwd,
        resumeSessionId,
        permissionMode,
        model: opts.model,
        effort: opts.effort,
        canUseTool,
        systemPrompt,
        userRole: opts.userRole,
        configDir,
        userId: opts.userId,        // Tier 1 capture: TOWER_API_TOKEN env injection
        username: opts.username,
        ...(mcpServers ? { mcpServers } : {}),
      })) {
        // Track Claude session ID (in-memory only — DB claim deferred to engine_done
        // so that abort/crash leaves the previous verified ID in DB for safe resume)
        if ('session_id' in message && message.session_id) {
          engineSessionId = message.session_id;
        }

        // ── Autocompact lifecycle events ──
        if ((message as any).type === 'system') {
          const subtype = (message as any).subtype;
          const status = (message as any).status;

          if (subtype === 'compact_boundary') {
            isCompacting = true;
            // Persist that this assistant turn crossed the autoCompact threshold
            // (SDK Options.settings.autoCompactWindow=500_000). Lands in
            // messages.metadata.compact_boundary_at — countable via:
            //   SELECT count(*) FROM messages WHERE metadata ? 'compact_boundary_at'
            // Background: workspace/decisions/2026-05-14-sdk-credit-economy.md
            if (currentAssistantId && callbacks.markCompactBoundary) {
              const preservedSegment = !!(message as any).compactMetadata?.preservedSegment;
              Promise.resolve(callbacks.markCompactBoundary(currentAssistantId, { preservedSegment }))
                .catch(err => console.error('[compact_boundary] DB write failed:', err?.message));
            } else if (!currentAssistantId) {
              console.warn(`[compact_boundary] no currentAssistantId; sessionId=${sessionId}`);
            }
            yield { type: 'compact', sessionId, phase: 'boundary' };
            continue;
          }
          if (subtype === 'status') {
            if (status !== 'compacting') isCompacting = false;
            yield {
              type: 'compact',
              sessionId,
              phase: status === 'compacting' ? 'compacting' : 'done',
            };
            continue;
          }
        }

        // SDK may not send explicit status:null after compaction —
        // auto-close compacting when the first non-system message arrives
        if (isCompacting && (message as any).type !== 'system') {
          isCompacting = false;
          yield { type: 'compact', sessionId, phase: 'done' };
        }

        // Handle resume failure
        if ((message as any).type === 'system' && (message as any).subtype === 'resume_failed') {
          yield {
            type: 'engine_error',
            sessionId,
            message: (message as any).message || 'Previous conversation context could not be restored.',
            recoverable: true,
          };
          continue;
        }

        // Save tool results to DB (from SDK user messages)
        if ((message as any).type === 'user') {
          const userContent = (message as any).message?.content;
          if (Array.isArray(userContent)) {
            for (const block of userContent) {
              if (block.type === 'tool_result' && block.tool_use_id) {
                const resultText = typeof block.content === 'string'
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content.map((c: any) => c.text || '').join('\n')
                    : JSON.stringify(block.content);
                const structured = (message as any).tool_use_result;
                const finalResult = structured?.stdout || structured?.stderr
                  ? [structured.stdout, structured.stderr].filter(Boolean).join('\n')
                  : resultText;
                try { callbacks.attachToolResult(block.tool_use_id, finalResult); } catch {}
              }
            }

            // Save user tool_result message to DB
            const parentToolUseId = userContent.find((b: any) => b.tool_use_id)?.tool_use_id || null;
            if (parentToolUseId) {
              const msgId = (message as any).uuid || uuidv4();
              try {
                callbacks.saveMessage({
                  id: msgId,
                  role: 'user',
                  content: userContent,
                  parentToolUseId,
                });
              } catch {}
            }
          }
        }

        // Save assistant messages to DB + yield TowerMessage
        if ((message as any).type === 'assistant') {
          const msgId = (message as any).uuid || uuidv4();
          const content = (message as any).message?.content || [];

          if (msgId !== currentAssistantId) {
            // New assistant message
            currentAssistantId = msgId;
            try {
              callbacks.saveMessage({
                id: msgId,
                role: 'assistant',
                content,
                parentToolUseId: (message as any).parent_tool_use_id,
              });
            } catch {}
          } else {
            // Streaming update
            try { callbacks.updateMessageContent(msgId, content); } catch {}
          }

          // Track edited files
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_use') {

                const toolName = block.name?.toLowerCase() || '';
                if ((toolName === 'write' || toolName === 'edit') && block.input?.file_path) {
                  editedFiles.add(block.input.file_path);
                }
              }
            }
          }

          // Yield TowerMessage
          yield {
            type: 'assistant',
            sessionId,
            msgId,
            content: convertContent(content),
            parentToolUseId: (message as any).parent_tool_use_id || null,
          };
        }

        // Turn metrics
        if ((message as any).type === 'result' && currentAssistantId) {
          const usage = (message as any).usage;
          const modelUsage = (message as any).modelUsage as Record<string, { contextWindow?: number }> | undefined;

          // Cumulative tokens across all iterations (for cost tracking)
          const cumulativeInputTokens = (usage?.input_tokens || 0)
            + (usage?.cache_read_input_tokens || 0)
            + (usage?.cache_creation_input_tokens || 0);

          // Context window usage = last iteration's input (= actual context size right now)
          // If iterations not available, contextInputTokens = 0 → frontend uses its own fallback with cap
          const iterations: Array<{ input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; type?: string }> | null = usage?.iterations;
          const lastIter = iterations?.filter(it => it.type === 'message').pop();
          const contextInputTokens = lastIter
            ? (lastIter.input_tokens || 0) + (lastIter.cache_read_input_tokens || 0) + (lastIter.cache_creation_input_tokens || 0)
            : 0; // no iterations → let frontend fallback with cap
          const contextOutputTokens = lastIter?.output_tokens ?? 0;

          // Model's context window size from SDK
          const contextWindowSize = modelUsage
            ? Math.max(...Object.values(modelUsage).map(m => m.contextWindow || 0)) || 0
            : 0;

          // Per-message metrics: prefer context (last iteration) for accurate display.
          // When iterations unavailable, estimate ≈ cumulative / numIterations.
          const iterCount = iterations?.filter(it => it.type === 'message').length || 1;
          const estimatedInput = contextInputTokens || Math.round(cumulativeInputTokens / iterCount);
          const estimatedOutput = contextOutputTokens || Math.round((usage?.output_tokens || 0) / iterCount);
          try {
            // 1h vs 5m breakdown — SDK 0.2.112 의 cache_creation 객체 안에
            // ephemeral_1h_input_tokens / ephemeral_5m_input_tokens 분리.
            // ENABLE_PROMPT_CACHING_1H=1 활성 후 효과 측정의 핵심 지표.
            const cacheCreationObj = (usage?.cache_creation || {}) as {
              ephemeral_1h_input_tokens?: number;
              ephemeral_5m_input_tokens?: number;
            };
            callbacks.updateMessageMetrics(currentAssistantId, {
              durationMs: (message as any).duration_ms,
              inputTokens: estimatedInput,
              outputTokens: estimatedOutput,
              // Cache breakdown — for SDK-credit-era cost analysis.
              // Cumulative across the whole turn (matches inputTokens semantic).
              cacheReadTokens: usage?.cache_read_input_tokens || 0,
              cacheCreationTokens: usage?.cache_creation_input_tokens || 0,
              cacheCreation1hTokens: cacheCreationObj.ephemeral_1h_input_tokens || 0,
              cacheCreation5mTokens: cacheCreationObj.ephemeral_5m_input_tokens || 0,
            });
          } catch {}

          yield {
            type: 'turn_done',
            sessionId,
            msgId: currentAssistantId,
            usage: {
              inputTokens: cumulativeInputTokens,
              outputTokens: usage?.output_tokens || 0,
              cacheReadTokens: usage?.cache_read_input_tokens || 0,
              cacheCreationTokens: usage?.cache_creation_input_tokens || 0,
              durationMs: (message as any).duration_ms || 0,
              // Context window tracking (last iteration = real context size)
              contextInputTokens,
              contextOutputTokens,
              contextWindowSize,
              numIterations: iterations?.filter(it => it.type === 'message').length || 1,
            },
          };
        }
      }
    };

    try {
      yield* runClaudeQuery(opts.engineSessionId);

      // Claude Code sometimes consumes the first post-model-change prompt as a
      // session/model handshake: init/result arrive, but no assistant message.
      // Retry the SAME prompt once inside the engine so the user input is not
      // swallowed. The user message was already saved by ws-handler, so this
      // retry must stay internal (no duplicate transcript bubble).
      let retriedNoAssistantTurn = false;
      if (!currentAssistantId) {
        retriedNoAssistantTurn = true;
        yield {
          type: 'engine_error',
          sessionId,
          message: '모델 변경을 감지했습니다. 방금 입력을 자동으로 한 번 더 전달합니다.',
          recoverable: true,
          retryable: true,
        };
        yield* runClaudeQuery(getClaudeSessionId(sessionId) || engineSessionId || opts.engineSessionId);
      }

      // Get final engine session ID
      const finalSessionId = getClaudeSessionId(sessionId) || engineSessionId;
      if (finalSessionId) {
        callbacks.claimSessionId(finalSessionId);
        backupSessionFile(finalSessionId, opts.cwd, configDir);
      }

      // Auto-commit edited files — fire-and-forget so the Haiku call (up to
      // 60s, see GIT_AUTO_COMMIT_AI_TIMEOUT_MS) doesn't block engine_done.
      // The user already has their reply at this point; commit happens
      // asynchronously in the background. Concurrent commits across sessions
      // are serialized by git-manager.ts's withGitLock().
      if (config.gitAutoCommit && editedFiles.size > 0) {
        const files = [...editedFiles];
        const author = opts.username || 'anonymous';
        void (async () => {
          try {
            const { generateAutoCommitMessage } = await import('../services/git/auto-commit-message.js');
            const message = await generateAutoCommitMessage(author, sessionId, files);
            await autoCommit(
              config.workspaceRoot,
              author,
              sessionId,
              files,
              { message, coAuthor: true },
            );
          } catch (err) {
            console.error('[Claude Engine] Background auto-commit failed:', err);
          }
        })();
      }

      // If the automatic retry also produced no assistant content, surface a
      // final toast-only notice. This should be rare; it keeps the old explicit
      // fallback without polluting the transcript.
      if (!currentAssistantId && retriedNoAssistantTurn) {
        yield {
          type: 'engine_error',
          sessionId,
          message: '자동 재전송 후에도 응답이 없어 멈췄습니다. 다시 한 번 보내주세요.',
          recoverable: true,
          retryable: true,
        };
      }

      // Engine done
      yield {
        type: 'engine_done',
        sessionId,
        engineSessionId: finalSessionId,
        editedFiles: [...editedFiles],
        model: opts.model,
        outcome: 'completed',
      };

    } catch (error: any) {
      const isAbort = /aborted by user|abort/i.test(error.message || '') || error.name === 'AbortError';

      // NEVER clear claude_session_id on error. Clearing it causes permanent context loss —
      // every subsequent turn starts a fresh SDK session, and the user sees AI responses
      // with no memory of prior conversation. It's better to keep the stale ID and let
      // the next resume attempt fail explicitly, so the user knows to start a new session.

      if (!isAbort) {
        yield {
          type: 'engine_error',
          sessionId,
          message: error.message || 'Claude query failed',
        };
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Engine interface methods
  // ═══════════════════════════════════════════════════════════════

  async quickReply(prompt: string, opts: QuickReplyOpts): Promise<string> {
    const { query: sdkQuery } = await import('@anthropic-ai/claude-agent-sdk');
    const abortController = new AbortController();
    let fullContent = '';

    const response = sdkQuery({
      prompt,
      options: {
        abortController,
        pathToClaudeCodeExecutable: config.claudeExecutable,
        cwd: config.defaultCwd,
        permissionMode: 'bypassPermissions',  // allow tool execution (read/write/bash)
        allowDangerouslySkipPermissions: true,
        model: opts.model,
        systemPrompt: opts.systemPrompt,
        maxTurns: 5,  // allow multi-turn tool usage
      },
    });

    for await (const message of response) {
      if (message.type === 'assistant' && message.message?.content) {
        // SDK yields full accumulated content on each update (not deltas).
        // Extract all text blocks and compute delta from previous state.
        const currentText = (message.message.content as any[])
          .filter((b: any) => b.type === 'text' && b.text)
          .map((b: any) => b.text)
          .join('');

        if (currentText && currentText.length > fullContent.length) {
          const chunk = currentText.slice(fullContent.length);
          fullContent = currentText;
          opts.onChunk(chunk, fullContent);
        }
      }
    }

    return fullContent;
  }

  /**
   * Persistent channel reply — wraps executeQuery with resume support.
   * Streams only text content; tool_use triggers onToolUse callback.
   * Returns content + engineSessionId for next resume.
   *
   * 🔀 AI 실행 경로 3종 중 하나 (Channel AI, @ai). 다른 둘:
   *   - Session → Engine.run() 위
   *   - Task    → packages/backend/services/task-runner.ts
   * 셋 비교표: docs/tower-guide/ai-execution-paths.md
   *
   * Permission model (2026-04-29 부터): opts.userRole / allowedPath /
   * accessiblePaths 가 주어지면 buildToolGuard 동일 적용 + AskUserQuestion·
   * EnterWorktree 차단. 미제공 시 (예: 합성 테스트 콜) 레거시 무가드 동작.
   * 변경 시 비교표 §1 + §4 드리프트 핫스팟 갱신.
   */
  async channelReply(prompt: string, opts: ChannelReplyOpts): Promise<ChannelReplyResult> {
    // Use a unique internal session ID for the channel AI query
    // Date.now() alone has 1ms resolution — concurrent calls can collide.
    // Adding random suffix ensures uniqueness even at sub-millisecond intervals.
    const internalSessionId = `channel-ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let fullContent = '';
    let engineSessionId: string | undefined;
    const tools: Array<{ name: string; input?: Record<string, unknown> }> = [];

    // ── Tool guard (Tier 1) ────────────────────────────────────────────
    // Build only when caller supplied identity fields. This keeps
    // back-compat for any legacy/test caller that omits them while
    // production paths (ws-handler → ai-quick-reply) always provide them.
    const cwd = opts.cwd || config.defaultCwd;
    const sessionProjectRoot = opts.sessionProjectRoot
      ?? resolveSessionProjectRoot(cwd) ?? undefined;
    const haveIdentity = !!(opts.userRole || opts.allowedPath || opts.accessiblePaths !== undefined);
    const canUseTool = haveIdentity
      ? (() => {
          const guard = buildToolGuard({
            role: opts.userRole || 'member',
            allowedPath: opts.allowedPath,
            accessiblePaths: opts.accessiblePaths,
            readOnlyPaths: opts.readOnlyPaths,
            denyImplicitBash: opts.denyImplicitBash,
            channelSafeToolsOnly: opts.channelSafeToolsOnly,
            sessionProjectRoot,
          });
          return async (toolName: string, input: Record<string, unknown>, _o: { signal: AbortSignal }) => {
            const check = guard(toolName, input);
            if (!check.allowed) return { behavior: 'deny' as const, message: check.message };
            // Channel AI has no UI for AskUserQuestion (no interactive popup) —
            // tell the model to make assumptions instead of stalling on a prompt
            // that will never be answered.
            if (toolName === 'AskUserQuestion') {
              return {
                behavior: 'deny' as const,
                message: 'Channel AI has no interactive prompt UI — make a reasonable assumption and state it in your reply, or ask the user in plain text.',
              };
            }
            // Worktree is task-runner territory; channel AI shouldn't fork the repo.
            if (toolName === 'EnterWorktree') {
              return {
                behavior: 'deny' as const,
                message: 'EnterWorktree is reserved for task-runner. Channel AI works directly in cwd.',
              };
            }
            return { behavior: 'allow' as const, updatedInput: input };
          };
        })()
      : undefined;

    try {
      for await (const message of executeQuery(internalSessionId, prompt, {
        cwd,
        resumeSessionId: opts.resumeSessionId,
        permissionMode: 'bypassPermissions',
        model: opts.model,
        systemPrompt: opts.systemPrompt,
        // PR-3 (2026-05-09) — channel session's pinned configDir forwarded
        // to the SDK so it spawns with the right account credentials and
        // writes turn jsonl under that account's projects/<cwd>/ dir.
        configDir: opts.configDir ?? undefined,
        ...(canUseTool ? { canUseTool } : {}),
        ...(opts.userRole ? { userRole: opts.userRole } : {}),
        ...(opts.userId ? { userId: opts.userId } : {}),
        ...(opts.username ? { username: opts.username } : {}),
        // Only forward maxTurns if caller set it — otherwise unlimited (like regular sessions)
        ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
      })) {
        // Track session ID for resume
        if ('session_id' in message && (message as any).session_id) {
          engineSessionId = (message as any).session_id;
        }

        // Handle autocompact lifecycle
        if ((message as any).type === 'system') {
          const subtype = (message as any).subtype;
          const status = (message as any).status;
          if (subtype === 'compact_boundary') {
            opts.onCompact?.('boundary');
            continue;
          }
          if (subtype === 'status') {
            opts.onCompact?.(status === 'compacting' ? 'compacting' : 'done');
            continue;
          }
        }

        // Extract text from assistant messages
        if ((message as any).type === 'assistant' && (message as any).message?.content) {
          const content = (message as any).message.content as any[];

          // Notify tool use for status indicators
          for (const block of content) {
            if (block.type === 'tool_use' && block.name) {
              const input = block.input as Record<string, unknown> | undefined;
              tools.push({ name: block.name, input });
              opts.onToolUse?.(block.name, input);
            }
          }

          // Extract text and compute delta
          const currentText = content
            .filter((b: any) => b.type === 'text' && b.text)
            .map((b: any) => b.text)
            .join('');

          if (currentText && currentText.length > fullContent.length) {
            const chunk = currentText.slice(fullContent.length);
            fullContent = currentText;
            opts.onChunk(chunk, fullContent);
          }
        }
      }
    } finally {
      // Clean up the internal session tracking (but don't kill the SDK process — it's done)
      cleanupSession(internalSessionId);
    }

    // Get the final session ID from SDK tracking
    const finalSessionId = getClaudeSessionId(internalSessionId) || engineSessionId;

    // Backup session file for resilience. PR-3 (2026-05-09): forward the
    // channel session's pinned configDir so the backup reads the right
    // account directory. cwd uses opts.cwd (falling back to defaultCwd) so
    // the encoded-cwd path matches what executeQuery just wrote to.
    if (finalSessionId) {
      backupSessionFile(finalSessionId, opts.cwd || config.defaultCwd, opts.configDir ?? undefined);
    }

    return {
      content: fullContent,
      engineSessionId: finalSessionId,
      provenance: {
        authorityFingerprint: opts.authorityFingerprint || '',
        tools,
      },
    };
  }

  abort(sessionId: string): void {
    abortSession(sessionId);
  }

  dispose(sessionId: string): void {
    cleanupSession(sessionId);
  }

  isRunning(sessionId: string): boolean {
    return getSDKSession(sessionId)?.isRunning || false;
  }

  getActiveCount(): number {
    return getActiveSessionCount();
  }

  getRunningSessionIds(): string[] {
    return sdkGetRunningSessionIds();
  }

  init(): void {
    cleanupOrphanedSdkProcesses();
  }

  shutdown(): void {
    gracefulShutdown('shutdown');
    stopOrphanMonitor();
  }

  // ═══════════════════════════════════════════════════════════════
  // Claude-specific internals
  // ═══════════════════════════════════════════════════════════════

  /**
   * Create canUseTool interceptor for Claude SDK.
   * Delegates to unified ToolGuard, then handles AskUserQuestion.
   */
  private createCanUseTool(
    _sessionId: string,
    guard: ToolGuard,
    callbacks: EngineCallbacks,
  ) {
    return async (toolName: string, input: Record<string, unknown>, _options: { signal: AbortSignal }) => {
      // Unified guard: damage control + path enforcement + project ACL + TeamCreate block
      const check = guard(toolName, input);
      if (!check.allowed) {
        return { behavior: 'deny' as const, message: check.message };
      }

      // Allow all non-AskUserQuestion tools
      if (toolName !== 'AskUserQuestion') {
        return { behavior: 'allow' as const, updatedInput: input };
      }

      // ── AskUserQuestion: delegate to ws-handler via callbacks ──
      const questionId = `q-${uuidv4()}`;
      const questions = (input as any).questions || [];

      const buildAnswersInput = (answersObj: Record<string, string>) => ({
        behavior: 'allow' as const,
        updatedInput: { ...input, answers: answersObj },
      });

      try {
        // callbacks.askUser broadcasts to session and waits for answer
        const answer = await callbacks.askUser(questionId, questions);

        // Parse structured "question: answer" lines
        const answersObj: Record<string, string> = {};
        const lines = answer.split('\n');
        for (const line of lines) {
          const colonIdx = line.indexOf(': ');
          if (colonIdx > -1) {
            answersObj[line.substring(0, colonIdx)] = line.substring(colonIdx + 2);
          }
        }
        return buildAnswersInput(answersObj);
      } catch {
        // Abort or timeout — deny
        return { behavior: 'deny' as const, message: 'Session aborted', interrupt: true };
      }
    };
  }

  /** Convert Claude SDK content blocks → TowerContentBlock[] */
  private convertContent(content: any[]): TowerContentBlock[] {
    if (!Array.isArray(content)) return [];
    return content.map(block => {
      if (block.type === 'text') return { type: 'text' as const, text: block.text || '' };
      if (block.type === 'thinking') {
        const thinkingText = block.thinking || block.text || '';
        const thinkingTitle = typeof block.title === 'string'
          ? block.title
          : extractThinkingTitle(thinkingText);
        return { type: 'thinking' as const, text: thinkingText, title: thinkingTitle };
      }
      if (block.type === 'tool_use') return {
        type: 'tool_use' as const,
        id: block.id || '',
        name: block.name || '',
        input: block.input || {},
      };
      // Fallback: render as text
      return { type: 'text' as const, text: JSON.stringify(block) };
    });
  }
}
