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
 * 설계서: docs/plans/arch_0412_proactive-agent.md
 */

import { v4 as uuidv4 } from 'uuid';
import { claimEngineSessionId, createSession, getEngineSessionId, getSession } from '../session/session-manager.js';
import { notify } from '../notification-hub.js';
import { saveMessage } from '../message-store.js';
import { getEngine } from '../../engines/index.js';
import { getAllRunningSessionIds } from '../../engines/index.js';
import type { TowerMessage, EngineCallbacks, SavedMessage } from '../../engines/types.js';
import { config, getModelDefaults } from '../../config.js';
import { queryOne } from '../../db/pg-repo.js';
import { resolveSessionProjectRoot } from '../pm/project-access.js';
import { selectSystemPromptFragmentsForMessage } from '../system-prompt-fragments.js';

// ── Types ──

export interface ProactiveTemplate {
  id: string;
  name: string;             // "모닝 브리핑", "태스크 후속"
  prompt: string;           // AI에게 줄 프롬프트
  model?: string;           // default: Admin AI reply model (Pi GPT by default)
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
  // Rate limit check
  if (!checkDailyLimit(userId)) {
    throw new Error(`Daily proactive limit reached (${DAILY_LIMIT}/day) for user ${userId}`);
  }

  const cwd = template.projectId
    ? `${config.workspaceRoot}/projects/${template.projectId}`
    : config.workspaceRoot;

  let sessionId: string;
  let engineSessionId: string | undefined;
  let engineName = config.defaultEngine || 'pi';
  let isInjection = false;

  // ── Mode 1: 기존 세션에 주입 ──
  if (options?.targetSessionId) {
    const existing = await getSession(options.targetSessionId);
    if (!existing) {
      throw new Error(`Target session not found: ${options.targetSessionId}`);
    }

    // 세션이 현재 streaming 중이면 스킵
    const runningIds = getAllRunningSessionIds();
    if (runningIds.includes(options.targetSessionId)) {
      throw new Error(`Target session is currently streaming: ${options.targetSessionId}`);
    }

    sessionId = existing.id;
    engineName = existing.engine || engineName;
    engineSessionId = getEngineSessionId(existing);
    isInjection = true;
  }
  // ── Mode 2: 새 세션 생성 (기본) ──
  else {
    const session = await createSession(
      `💬 ${template.name}`,
      cwd,
      userId,
      template.projectId || null,
      config.defaultEngine || 'pi',
      null,       // roomId
      null,       // sourceMessageId
      null,       // parentSessionId
      'proactive',
    );
    sessionId = session.id;
    // Tag as autonomous_run for Mission Control aggregation. Failure is
    // non-fatal — we'd rather have an unmarked session than abort the run.
    // See: workspace/decisions/2026-05-04-tower-channel-and-persona.md
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

  const sessionProjectRoot = resolveSessionProjectRoot(cwd)
    ?? (template.projectId
      ? (await queryOne<{ root_path: string | null }>('SELECT root_path FROM projects WHERE id = $1', [template.projectId]))?.root_path ?? undefined
      : undefined);

  const runOpts = {
    cwd,
    model: template.model || getModelDefaults().ai_reply,
    userId,
    userRole: 'admin',
    engineSessionId,
    projectId: template.projectId,
    sessionProjectRoot,
    systemPromptFragments: selectSystemPromptFragmentsForMessage(fullPrompt),
    rootTurnId,
  };

  try {
    for await (const towerMsg of engine.run(sessionId, fullPrompt, runOpts, callbacks)) {
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
        projectId: template.projectId ?? null,
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
