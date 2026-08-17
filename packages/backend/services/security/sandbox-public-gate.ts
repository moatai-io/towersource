/**
 * Owns: PreToolUse hook for sandbox public-visibility gate.
 * Public API:
 *   - preToolUseSandboxPublicGate — SDK PreToolUse hook callback
 *
 * Why this exists:
 *   visibility="public" 은 인증 없는 외부 노출 + 검색 인덱싱 OK 영역. AI 자율
 *   판단으로 박히면 안 되고 (Q18 정책), SDK PreToolUse hook 안에선 AskUserQuestion
 *   인터랙티브 카드를 띄울 수 없음 (동기 deny/allow 만). 따라서 hook 은 모든
 *   `visibility:'public'` 시도를 *deny* 하고, 2단계 승격을 안내한다:
 *     1. AI 가 unlisted 로 먼저 띄우기
 *     2. 사용자가 직접 명령으로 tool_update_visibility 승격
 *
 * 매칭:
 *   - mcp__sandbox__tool_start         + tool_input.visibility === 'public'
 *   - mcp__sandbox__tool_update_visibility + tool_input.visibility === 'public'
 *
 * 결정:
 *   workspace/decisions/2026-05-13-execution-sandbox-phase2a3-unlisted-public.md
 *   workspace/decisions/2026-05-02-execution-sandbox-q18-public-tools.md
 */
import type { HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

const GUARDED_TOOLS = new Set([
  'mcp__sandbox__tool_start',
  'mcp__sandbox__tool_update_visibility',
]);

const DENY_REASON = [
  'visibility="public" (인증 없는 외부 노출 + 검색 인덱싱) 은 AI 자율로 박을 수 없음.',
  '대신 2단계로 진행하세요:',
  '  1) visibility="unlisted" 로 먼저 띄움 — 외부 호출 가능, URL 추측 차단 (6자 hex suffix).',
  '  2) 사용자가 직접 검증 후 명시적으로 "이거 public 으로 승격해" 라고 지시하면',
  '     mcp__sandbox__tool_update_visibility(id, "public") 호출.',
  'AI 가 사용자 발화 없이 단독으로 public 박으면 안 됩니다.',
  '정책: workspace/decisions/2026-05-13-execution-sandbox-phase2a3-unlisted-public.md',
].join(' ');

/**
 * SDK PreToolUse callback. Returns deny when the requested sandbox tool is
 * trying to set visibility=public. Other visibility values pass through.
 */
export async function preToolUseSandboxPublicGate(
  input: HookInput,
  _toolUseID: string | undefined,
  _opts: { signal: AbortSignal },
): Promise<HookJSONOutput> {
  if (input.hook_event_name !== 'PreToolUse') return { continue: true };
  const toolName = input.tool_name ?? '';
  if (!GUARDED_TOOLS.has(toolName)) return { continue: true };

  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
  const visibility = toolInput.visibility;
  if (visibility !== 'public') return { continue: true };

  const targetName = typeof toolInput.name === 'string'
    ? toolInput.name
    : typeof toolInput.tool_id === 'number'
      ? `tool_id=${toolInput.tool_id}`
      : '(unknown)';
  console.warn(`[sandbox-public-gate] blocked ${toolName} for ${targetName} visibility=public`);

  return {
    decision: 'block',
    reason: DENY_REASON,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: DENY_REASON,
    },
  };
}
