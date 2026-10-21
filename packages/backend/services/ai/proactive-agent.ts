/**
 * Proactive Agent — AI가 먼저 말을 거는 시스템.
 *
 * 트리거(cron, heartbeat, 수동)에 의해 세션을 생성하고,
 * Claude를 실행해 첫 메시지를 받은 뒤, 사용자에게 알림을 보낸다.
 *
 * 두 가지 모드:
 *   1. 새 세션 생성 (기본) — 독립적 대화 시작
 *   2. 기존 세션 주입 — 맥락 연속 (targetSessionId 지정)
 *
 * Current execution contract:
 * - Resolve the active run-as account; reuse Session-send/Project/path access helpers.
 * - Injection inherits the target Session's Project, cwd, engine and config snapshot.
 * - Explicit Project/model-engine mismatches fail before Session/message writes.
 * - Project roots come from projects.root_path, not a derived UUID directory.
 * Regression: proactive-agent.authority.test.ts.
 *
 * Historical design: docs/plans/arch_0412_proactive-agent.md
 */

import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { claimEngineSessionId, createSession, getEngineSessionId, getSession } from '../session/session-manager.js';
import { notify } from '../notification-hub.js';
import { saveMessage } from '../message-store.js';
import { getEngine } from '../../engines/index.js';
import { getAllRunningSessionIds } from '../../engines/index.js';
import type { TowerMessage, EngineCallbacks, SavedMessage } from '../../engines/types.js';
import { config, getModelDefaults } from '../../config.js';
import { queryOne } from '../../db/pg-repo.js';
import { canCreateInProject, canSendSessionMessage, getUserAccessiblePaths, isPathAccessible, resolveSessionProjectRoot } from '../pm/project-access.js';
import { getUserAllowedPath, getUserAuthState } from '../auth/auth.js';
import { isTowerRole } from '../authority/authorization-policy.js';
import { isPiPresetMappingReady } from '../model-policy/session-alias.js';
import { selectSystemPromptFragmentsForMessage } from '../system-prompt-fragments.js';
import { recordPiUsageEvent } from '../ai-usage/usage-ledger.js';
import { isModelPolicyId } from './litellm-model-catalog.js';

// ── Types ──

export interface ProactiveTemplate {
  id: string;
  name: string;             // "모닝 브리핑", "태스크 후속"
  prompt: string;           // AI에게 줄 프롬프트
  model?: string;           // default: Admin Core model for autonomous work
  maxTurns?: number;        // default: 1 (첫 메시지만)
  projectId?: string;
}

export interface ProactiveContext {
  /** 자유 형식 맥락. 프롬프트에 삽입 */
  summary?: string;
  /** 관련 파일 경로들 */
  files?: string[];
  /** 트리거 소스 메타데이터 */
  triggerMeta?: Record<string, unknown>;
}

export interface ProactiveOptions {
  /** 기존 세션에 주입할 때 사용. 미지정 시 새 세션 생성 */
  targetSessionId?: string;
  /** Legacy automation source identifier retained in Notification metadata. */
  automationId?: string;
  /** The Automation/Schedule caller emits the terminal Notification itself. */
  suppressCompletionNotification?: boolean;
}

interface FireResult {
  sessionId: string;
  notificationId: string;
  firstMessage: string;
}

// ── System prompt wrapper ──

const SYSTEM_WRAPPER = `\
당신은 Tower AI 어시스턴트입니다. 지금 사용자에게 **먼저 말을 거는** 상황입니다.
사용자가 아직 아무 말도 하지 않았습니다.

규칙:
- 자연스럽고 친근하게 인사하세요.
- 왜 말을 걸었는지 간결하게 설명하세요.
- 구체적인 정보나 제안을 포함하세요 (빈 인사만 하지 마세요).
- 사용자가 답장하고 싶도록 열린 질문으로 끝내세요.
- 3~5문장 이내로 짧게.

---

`;

const INJECT_WRAPPER = `\
[시스템 자동 메시지] 아래 맥락에 기반하여 사용자에게 후속 메시지를 보내세요.
이전 대화의 흐름을 자연스럽게 이어가되, 새로운 정보를 전달하세요.
3~5문장 이내로 짧게.

---

`;

// ── Broadcast function (set by initProactiveAgent) ──

type BroadcastFn = (type: string, data: any) => void;
let broadcastFn: BroadcastFn | null = null;

export function initProactiveAgent(broadcast: BroadcastFn) {
  broadcastFn = broadcast;
  console.log('[proactive] Agent initialized');
}

// ── Rate limiting ──

const DAILY_LIMIT = 5;
const dailyCounts = new Map<string, { date: string; count: number }>();

function checkDailyLimit(userId: number): boolean {
  const today = new Date().toISOString().slice(0, 10);
  const key = `${userId}`;
  const entry = dailyCounts.get(key);

  if (!entry || entry.date !== today) {
    dailyCounts.set(key, { date: today, count: 0 });
    return true;
  }

  return entry.count < DAILY_LIMIT;
}

function incrementDailyCount(userId: number): void {
  const today = new Date().toISOString().slice(0, 10);
  const key = `${userId}`;
  const entry = dailyCounts.get(key);

  if (!entry || entry.date !== today) {
    dailyCounts.set(key, { date: today, count: 1 });
  } else {
    entry.count++;
  }
}

// ── Core ──

/**
 * Proactive 세션을 실행하고 알림을 보낸다.
 *
 * @param userId    대상 사용자 ID
 * @param template  프롬프트 템플릿
 * @param context   선택적 맥락 (summary, files)
 * @param options   기존 세션 주입 등 옵션
 */
export async function fireProactive(
  userId: number,
  template: ProactiveTemplate,
  context?: ProactiveContext,
  options?: ProactiveOptions,
): Promise<FireResult> {
  // Reuse current-account and Session-send boundaries from interactive chat.
  // A background template is not an authority grant.
  const account = await getUserAuthState(userId);
  if (!account || account.disabled || account.approvalStatus !== 'active' || !isTowerRole(account.role)) {
    throw new Error('Proactive run requires an active account');
  }
  const user = await queryOne<{ username: string }>('SELECT username FROM users WHERE id = $1', [userId]);
  if (!user?.username) throw new Error('Proactive run user not found');
  const userRole = account.role;
  const [allowedPath, accessiblePaths] = await Promise.all([
    getUserAllowedPath(userId),
    getUserAccessiblePaths(userId, userRole),
  ]);

  let cwd: string;
  let projectId = template.projectId;
  let sessionProjectRoot: string | undefined;
  let sessionId!: string;
  let engineSessionId: string | undefined;
  let configDir: string | null | undefined;
  let engineName = config.defaultEngine || 'pi';
  let model: string;
  let isInjection = false;

  const projectRoot = async (id: string): Promise<string> => {
    const project = await queryOne<{ root_path: string | null }>(
      'SELECT root_path FROM projects WHERE id = $1', [id],
    );
    if (!project?.root_path || !path.isAbsolute(project.root_path)) {
      throw new Error('Proactive project has no canonical root');
    }
    return path.resolve(project.root_path);
  };
  // Same model/engine shape guard as the Session creation boundary.
  const validateModel = (choice: string, engine: string): void => {
    const matches = engine === 'pi' ? choice.includes('/')
      : engine === 'claude' ? choice.startsWith('claude-')
      : !choice.includes('/') && !choice.startsWith('claude-');
    if (!matches) throw new Error('Proactive model does not match Session engine');
  };

  // ── Mode 1: existing Session is the authority for execution context ──
  if (options?.targetSessionId) {
    const access = await canSendSessionMessage(options.targetSessionId, userId, userRole);
    if (!access.allowed) throw new Error(access.message);
    const existing = await getSession(options.targetSessionId);
    if (!existing) throw new Error(`Target session not found: ${options.targetSessionId}`);
    if (getAllRunningSessionIds().includes(options.targetSessionId)) {
      throw new Error(`Target session is currently streaming: ${options.targetSessionId}`);
    }
    if (template.projectId !== undefined && template.projectId !== (existing.projectId || undefined)) {
      throw new Error('Proactive target Session project mismatch');
    }
    projectId = existing.projectId || undefined;
    if (!existing.cwd || !path.isAbsolute(existing.cwd)) throw new Error('Proactive target Session cwd is invalid');
    cwd = path.resolve(existing.cwd);
    sessionProjectRoot = projectId ? await projectRoot(projectId) : resolveSessionProjectRoot(cwd) ?? undefined;
    if (sessionProjectRoot && cwd !== sessionProjectRoot && !cwd.startsWith(sessionProjectRoot + path.sep)) {
      throw new Error('Proactive target Session cwd does not match its Project');
    }
    if (!(await isPathAccessible(cwd, userId, userRole))) throw new Error('Proactive target cwd access denied');
    sessionId = existing.id;
    engineName = existing.engine || engineName;
    engineSessionId = getEngineSessionId(existing);
    configDir = existing.configDir;
    model = template.model || existing.modelUsed || getModelDefaults().session;
    validateModel(model, engineName);
    isInjection = true;
  } else {
    // ── Mode 2: new Session uses the registered Project root, never projects/<uuid> ──
    const access = await canCreateInProject(projectId, userId, userRole);
    if (!access.allowed) throw new Error(access.message);
    sessionProjectRoot = projectId ? await projectRoot(projectId) : undefined;
    cwd = sessionProjectRoot || path.resolve(config.workspaceRoot);
    if (!(await isPathAccessible(cwd, userId, userRole))) throw new Error('Proactive cwd access denied');
    model = template.model || getModelDefaults().session;
    validateModel(model, engineName);
  }

  // Preserve selection intent for the engine's pinned Harness/model resolver,
  // but reject unavailable preset mappings before any Session/message writes.
  if (engineName === 'pi' && !isPiPresetMappingReady(model)) {
    throw new Error(`MODEL_PRESET_UNAVAILABLE: ${model}`);
  }
  // All access/context validation precedes message writes and new Sessions.
  if (!checkDailyLimit(userId)) {
    throw new Error(`Daily proactive limit reached (${DAILY_LIMIT}/day) for user ${userId}`);
  }
  if (!isInjection) {
    const session = await createSession(
      `💬 ${template.name}`, cwd, userId, projectId || null, engineName,
      undefined, undefined, undefined, 'proactive', model,
    );
    sessionId = session.id;
    configDir = session.configDir;
    // Proactive sessions are autonomous runs, not the user's ongoing chat.
    try {
      const { updateSession } = await import('../session/session-manager.js');
      await updateSession(sessionId, { kind: 'autonomous_run' });
    } catch (err: any) {
      console.warn(`[proactive] Failed to mark session ${sessionId.slice(0, 8)} as autonomous_run:`, err.message);
    }
  }

  // ── 프롬프트 조립 ──
  const wrapper = isInjection ? INJECT_WRAPPER : SYSTEM_WRAPPER;
  const contextBlock = context?.summary || '(특별한 맥락 없음)';
  const filesBlock = context?.files?.length
    ? `\n관련 파일:\n${context.files.map(f => `- ${f}`).join('\n')}`
    : '';
  const fullPrompt = wrapper + template.prompt + '\n\n' + contextBlock + filesBlock;

  // ── Engine 실행 ──
  if (engineName === 'claude' && !config.claudeEnabled) {
    console.log(`[proactive] skip: Claude disabled (session=${sessionId})`);
    return {
      sessionId,
      notificationId: 'skip-claude-disabled',
      firstMessage: 'Claude engine is disabled'
    };
  }
  if (engineName === 'pi' && !config.piEnabled) {
    console.log(`[proactive] skip: Pi disabled (session=${sessionId})`);
    return {
      sessionId,
      notificationId: 'skip-pi-disabled',
      firstMessage: 'Pi engine is disabled'
    };
  }

  const engine = await getEngine(engineName);
  let firstMsgPreview = '';
  let finalAssistantText = '';
  const rootTurnId = uuidv4();
  await saveMessage(sessionId, {
    id: rootTurnId,
    role: 'user',
    content: [{ type: 'text', text: fullPrompt }],
    metadata: { sourceType: 'proactive_agent' },
  });

  const callbacks: EngineCallbacks = {
    saveMessage: async (msg: SavedMessage) => {
      await saveMessage(sessionId, {
        id: msg.id,
        role: msg.role,
        content: msg.content,
        parentToolUseId: msg.parentToolUseId,
      });
    },
    updateMessageContent: async () => {},
    updateMessageMetrics: async () => {},
    claimSessionId: async (engSid: string) => {
      try {
        await claimEngineSessionId(sessionId, engineName, engSid);
      } catch {
        // non-critical
      }
    },
    askUser: async () => {
      // Proactive 모드에서는 사용자 질문 불가 — 자동 스킵
      return 'skip';
    },
    attachToolResult: async () => {},
  };

  const runOpts = {
    cwd,
    model,
    userId,
    username: user.username,
    userRole,
    allowedPath,
    accessiblePaths,
    configDir,
    sessionProjectRoot,
    projectId,
    engineSessionId,
    systemPromptFragments: selectSystemPromptFragmentsForMessage(fullPrompt),
    rootTurnId,
  };

  try {
    for await (const towerMsg of engine.run(sessionId, fullPrompt, runOpts, callbacks)) {
      if (towerMsg.type === 'turn_done') {
        await recordPiUsageEvent({
          sessionId,
          rootTurnId,
          messageId: towerMsg.msgId,
          usage: towerMsg.usage,
          requestedModel: runOpts.model,
          modelPolicyId: isModelPolicyId(runOpts.model) ? runOpts.model.split('/')[1] : undefined,
        }).catch((error: any) => {
          console.warn(`[proactive] AI usage ledger write failed: session=${sessionId.slice(0, 8)} error=${error?.message || error}`);
        });
      }
      if (towerMsg.type === 'assistant') {
        const text = towerMsg.content
          ?.filter((block) => block.type === 'text' && 'text' in block)
          .map((block) => 'text' in block ? block.text : '')
          .join('\n')
          .trim();
        if (text) {
          finalAssistantText = text;
          if (!firstMsgPreview) firstMsgPreview = text.slice(0, 200);
        }
      }

      // Broadcast tower_message to session viewers (if user has it open)
      broadcastFn?.('tower_message_session', {
        sessionId,
        message: towerMsg,
      });

      // Consume until engine_done
    }
  } catch (err) {
    console.error(`[proactive] Engine error for session ${sessionId}:`, err);
    // 새 세션이었으면 실패 로그만, 기존 세션이면 영향 없음
    throw err;
  }

  // ── 카운터 증가 + 알림 전송 ──
  incrementDailyCount(userId);

  const notificationId = options?.suppressCompletionNotification
    ? ''
    : await notify(
      userId,
      null,
      'proactive',
      `💬 ${template.name}`,
      firstMsgPreview || 'AI가 먼저 대화를 시작했습니다.',
      { sessionId, templateId: template.id, isInjection },
      {
        projectId: projectId ?? null,
        sessionId,
        actionUrl: `/s/${sessionId}`,
      },
    );

  // 외부 메시징(Telegram/Kakao) push 는 #58 Phase 2 에서 제거됨.
  // proactive 알림은 in-app notification 으로만 전달.

  console.log(`[proactive] Fired "${template.name}" → session ${sessionId} (${isInjection ? 'injection' : 'new'})`);

  return {
    sessionId,
    notificationId,
    firstMessage: firstMsgPreview,
  };
}
