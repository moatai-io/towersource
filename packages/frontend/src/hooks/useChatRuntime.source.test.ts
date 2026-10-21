import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const HOOK_PATH = path.resolve(import.meta.dirname, './useChatRuntime.ts');

describe('useChatRuntime source contracts', () => {
  it('filters session-scoped frames against the visible active session', () => {
    const src = fs.readFileSync(HOOK_PATH, 'utf-8');
    expect(src).toContain('shouldDropSessionMessage(currentSid, data.sessionId, useSessionStore.getState().activeSessionId)');
    expect(src).toContain('shouldDropSessionMessage(_currentSid, data.sessionId, useSessionStore.getState().activeSessionId)');
  });

  it('routes user-scoped present_file intents before session transcript filtering', () => {
    const src = fs.readFileSync(HOOK_PATH, 'utf-8');
    const intentCase = src.indexOf("case 'present_file_intent':");
    const towerMessageCase = src.indexOf("case 'tower_message':");
    expect(intentCase).toBeGreaterThan(-1);
    expect(intentCase).toBeLessThan(towerMessageCase);
    expect(src.slice(intentCase, towerMessageCase)).toContain("new CustomEvent('tower-present-file'");
  });

  it('rechecks transcript ownership before async DB merges write messages', () => {
    const src = fs.readFileSync(HOOK_PATH, 'utf-8');
    expect(src).toMatch(/currentStore\.sessionId !== sessionId \|\| useSessionStore\.getState\(\)\.activeSessionId !== sessionId/);
    expect(src).toMatch(/destinationStore\.sessionId !== sessionId \|\| useSessionStore\.getState\(\)\.activeSessionId !== sessionId/);
  });

  it('clears streaming immediately on abort so user can send next message', () => {
    const src = fs.readFileSync(HOOK_PATH, 'utf-8');
    const abortBlock = src.match(/const abort = useCallback\([\s\S]*?\n  \}, \[send.*?\]\);/);
    expect(abortBlock?.[0]).toBeTruthy();
    // Abort should immediately clear streaming so user isn't stuck waiting
    expect(abortBlock?.[0]).toContain('setStreaming(false)');
    expect(abortBlock?.[0]).toContain('setTurnStartTime(null)');
  });

  it('re-marks the session as streaming when SESSION_BUSY arrives', () => {
    const src = fs.readFileSync(HOOK_PATH, 'utf-8');
    expect(src).toMatch(/SESSION_BUSY[\s\S]*markSessionRunQueued\(data\.sessionId\)/);
    expect(src).toMatch(/SESSION_BUSY[\s\S]*setStreaming\(true\)/);
  });

  it('does not reset the current assistant accumulator for Pi steering sends', () => {
    const src = fs.readFileSync(HOOK_PATH, 'utf-8');
    expect(src).toMatch(/const isPiSteering =/);
    expect(src).toMatch(/if \(!isPiSteering\) \{[\s\S]*currentAssistantMsg\.current = null/);
    expect(src).toMatch(/function isPiSessionForSend/);
  });

  it('coalesces inbox last-turn preview writes outside the active chat stream', () => {
    const src = fs.readFileSync(HOOK_PATH, 'utf-8');
    expect(src).toMatch(/LAST_TURN_TEXT_FLUSH_MS/);
    expect(src).toMatch(/pendingLastTurnTextBySession/);
    expect(src).toMatch(/function queueLastTurnText/);
    expect(src).toMatch(/towerMsg\.type === 'assistant'[\s\S]*queueLastTurnText/);
    expect(src).toMatch(/towerMsg\.type === 'turn_terminal'[\s\S]*towerMsg\.outcome === 'completed'[\s\S]*flushPendingLastTurnText\(data\.sessionId\)/);
  });

  it('requests authoritative Session refresh before filtering background session transcripts', () => {
    const src = fs.readFileSync(HOOK_PATH, 'utf-8');
    const terminalIndex = src.indexOf("if (towerMsg?.type === 'turn_terminal' && data.sessionId)");
    const dropIndex = src.indexOf('if (shouldDropSessionMessage(currentSid, data.sessionId');
    expect(terminalIndex).toBeGreaterThan(-1);
    expect(dropIndex).toBeGreaterThan(terminalIndex);
    expect(src.slice(terminalIndex, dropIndex)).toContain("tower:session-ai-response-completed");
    expect(src.slice(terminalIndex, dropIndex)).not.toContain('markSessionCompleted(data.sessionId)');
  });

  it('requests server unread refresh from the global terminal event, not session status', () => {
    const src = fs.readFileSync(HOOK_PATH, 'utf-8');
    const terminalStart = src.indexOf("case 'turn_terminal': {");
    const messageStart = src.indexOf("case 'tower_message': {", terminalStart);
    expect(terminalStart).toBeGreaterThan(-1);
    expect(messageStart).toBeGreaterThan(terminalStart);
    const terminalBlock = src.slice(terminalStart, messageStart);
    expect(terminalBlock).toContain('setTurnTerminal(data.sessionId, data)');
    expect(terminalBlock).toContain("tower:session-ai-response-completed");
    expect(terminalBlock).not.toContain('markSessionCompleted(data.sessionId)');

    const statusStart = src.indexOf("case 'session_status': {");
    const statusEnd = src.indexOf("case 'session_status_check': {", statusStart);
    expect(src.slice(statusStart, statusEnd)).not.toContain("data.outcome === 'completed'");
  });

  it('parks mid-turn injections as pending chips instead of inserting at input time', () => {
    const src = fs.readFileSync(HOOK_PATH, 'utf-8');
    // Mid-turn (steering) sends must NOT addMessage immediately — they go to the
    // per-session pending list and are spliced in at the injection point on
    // steer_delivered. See GitHub issue #17.
    expect(src).toMatch(/if \(isPiSteering\) \{[\s\S]*addPendingInjection\(activeSid, messageId, message\)/);
    expect(src).toMatch(/case 'steer_delivered':|towerMsg\.type === 'steer_delivered'/);
    expect(src).toMatch(/removePendingInjection\(data\.sessionId, towerMsg\.msgId\)/);
  });

  it('restores failed Pi steering text to the composer instead of dropping it', () => {
    const src = fs.readFileSync(HOOK_PATH, 'utf-8');
    expect(src).toMatch(/if \(isPiSteering\) \{[\s\S]*removePendingInjection\(activeSid, messageId\)[\s\S]*source: 'steer-cancel'/);
    expect(src).toContain("i18n.t('chat:runtime.steeringRestoredAfterFailure')");
  });

  it('tombstones cancelled steers so delayed delivery cannot resurrect them', () => {
    const src = fs.readFileSync(HOOK_PATH, 'utf-8');
    expect(src).toMatch(/cancelledSteerMessageIds = new Set<string>/);
    expect(src).toMatch(/case 'steer_cancelled':[\s\S]*cancelledSteerMessageIds\.add\(data\.messageId\)/);
    expect(src).toMatch(/towerMsg\.type === 'steer_delivered'[\s\S]*cancelledSteerMessageIds\.has\(towerMsg\.msgId\)/);
    expect(src).toMatch(/setMessages\(store\.messages\.filter\(\(m\) => m\.id !== data\.messageId\)\)/);
  });

  it('re-marks sessions as streaming on authoritative active snapshots', () => {
    const src = fs.readFileSync(HOOK_PATH, 'utf-8');
    expect(src).toMatch(/case 'reconnect_result':[\s\S]*data\.status === 'streaming'[\s\S]*markSessionRunActive\(data\.sessionId, 'preparing'\)/);
    expect(src).toMatch(/case 'set_active_session_ack':[\s\S]*if \(data\.isStreaming\)[\s\S]*markSessionRunActive\(data\.sessionId, 'preparing'\)/);
    expect(src).toMatch(/case 'session_status_check':[\s\S]*data\.sessionId && data\.status === 'streaming'[\s\S]*markSessionRunActive\(data\.sessionId, 'preparing'/);
  });

  it('projects durable retry and attention states instead of clearing them as idle', () => {
    const src = fs.readFileSync(HOOK_PATH, 'utf-8');
    expect(src).toMatch(/case 'reconnect_result':[\s\S]*durableTurnState === 'waiting_retry'[\s\S]*markSessionRunWaitingRetry/);
    expect(src).toMatch(/case 'reconnect_result':[\s\S]*durableTurnState === 'needs_attention'[\s\S]*markSessionRunFinished\(data\.sessionId, 'error'/);
    expect(src).toMatch(/case 'set_active_session_ack':[\s\S]*durableTurnState === 'waiting_retry'[\s\S]*markSessionRunWaitingRetry/);
    expect(src).toMatch(/case 'session_status_check':[\s\S]*durableTurnState === 'needs_attention'[\s\S]*markSessionRunFinished\(data\.sessionId, 'error'/);
    expect(src).toMatch(/case 'reconnect_result':[\s\S]*durableTurnState === 'needs_attention'[\s\S]*markSessionRunFinished[\s\S]*else \{[\s\S]*markSessionRunIdle/);
  });

  it('keeps runtime diagnostics out of the transcript and uses stable user messages', () => {
    const src = fs.readFileSync(HOOK_PATH, 'utf-8');
    const block = src.match(/case 'error': \{[\s\S]*?\n      case 'resume_failed':/);
    expect(block?.[0]).toBeTruthy();
    expect(block?.[0]).toContain('presentChatRuntimeError(data.errorCode)');
    expect(block?.[0]).toContain('errorMessage: presentation.message');
    expect(block?.[0]).not.toContain('`Error: ${data.message}`');
    expect(block?.[0]).not.toContain('Session limit exceeded:');
    expect(block?.[0]).not.toContain('SDK response timed out');
    expect(block?.[0]).not.toContain('addMessage({');
  });

  it('keeps resume failures silent instead of creating another recovery surface', () => {
    const src = fs.readFileSync(HOOK_PATH, 'utf-8');
    const block = src.match(/case 'resume_failed':[\s\S]*?\n      case 'task_sdk_message':/);
    expect(block?.[0]).toBeTruthy();
    expect(block?.[0]).toContain('diagnostic lifecycle events');
    expect(block?.[0]).not.toContain('toastInfo(');
    expect(block?.[0]).not.toContain('toastWarning(');
    expect(block?.[0]).not.toContain('data.message');
    expect(block?.[0]).not.toContain('addMessage({');
    expect(block?.[0]).not.toContain('markSessionRunWaitingRetry');
    expect(block?.[0]).not.toContain("markSessionRunFinished(sessionId, 'error'");
  });

  it('keeps background AUQ attention visible in Latest and open chat tabs', () => {
    const src = fs.readFileSync(HOOK_PATH, 'utf-8');
    expect(src).toMatch(/case 'session_awaiting_user':[\s\S]*if \(data\.awaiting\)[\s\S]*markSessionRunAwaitingUser\(data\.sessionId, data\.questionId\)/);
    expect(src).toContain('resolveSessionQuestion(data.sessionId, data.questionId)');
  });

  it('keeps approval questions pending until an answer ACK and restores failed submissions', () => {
    const src = fs.readFileSync(HOOK_PATH, 'utf-8');
    expect(src).toContain("case 'answer_question_ack':");
    expect(src).toContain("case 'answer_question_error':");
    expect(src).toContain("submissionStatus: 'submitting'");
    expect(src).toContain("submissionStatus: 'send_failed'");
    expect(src).toMatch(/const sendResult = send\(\{ type: 'answer_question'[\s\S]*if \(!sendResult\)/);
  });

  it('does not let generic streaming or idle status erase a newer AUQ phase', () => {
    const src = fs.readFileSync(HOOK_PATH, 'utf-8');
    expect(src).toContain("runState?.phase !== 'awaiting_user'");
    expect(src).toContain("turnStateBySession[data.sessionId]?.phase !== 'awaiting_user'");
  });

  it('does not recover mobile/background streaming from intermediate tool-use completion', () => {
    const src = fs.readFileSync(HOOK_PATH, 'utf-8');
    expect(src).toMatch(/function isTerminalAssistantMessage/);
    expect(src).toMatch(/m\.stopReason === 'toolUse'\) return false/);
    expect(src).toMatch(/latestTurnHasTerminalAssistant\(useChatStore\.getState\(\)\.messages\)/);
    expect(src).not.toContain('latestTurnHasCompletedAssistant(useChatStore.getState().messages)');
  });

  it('drains stale steer chips on all authoritative idle paths', () => {
    const src = fs.readFileSync(HOOK_PATH, 'utf-8');
    expect(src).toMatch(/function flushStalePendingInjectionsForIdleSession\(sessionId: string\)/);
    expect(src).toMatch(/case 'session_status':[\s\S]*if \(!isStreamingNow && data\.sessionId\) \{[\s\S]*flushStalePendingInjectionsForIdleSession\(data\.sessionId\)/);
    expect(src).toMatch(/case 'session_status_check':[\s\S]*flushStalePendingInjectionsForIdleSession\(data\.sessionId\)/);
    expect(src).toMatch(/case 'sdk_done':[\s\S]*flushStalePendingInjectionsForIdleSession\(data\.sessionId\)/);
    expect(src).toMatch(/case 'set_active_session_ack':[\s\S]*if \(data\.sessionId\) \{[\s\S]*flushStalePendingInjectionsForIdleSession\(data\.sessionId\)/);
    expect(src).toMatch(/reconnect sync:[\s\S]*flushStalePendingInjectionsForIdleSession\(sid\)/);
  });

  it('accepts chat frames queued during a websocket reconnect', () => {
    const src = fs.readFileSync(HOOK_PATH, 'utf-8');
    expect(src).toMatch(/const sent = send\(\{[\s\S]*type: 'chat'/);
    expect(src).toMatch(/if \(!sent\) \{[\s\S]*client_send_failed/);
  });

  it('routes run-state mutations through session-run-state actions', () => {
    const src = fs.readFileSync(HOOK_PATH, 'utf-8');
    expect(src).toMatch(/markSessionRunActive/);
    expect(src).toMatch(/markSessionRunAwaitingUser/);
    expect(src).toMatch(/markSessionRunQueued/);
    expect(src).toMatch(/markSessionRunFinished/);
    expect(src).toMatch(/markSessionRunIdle/);
    expect(src).not.toMatch(/setSessionStreaming\(/);
    expect(src.match(/setTurnPhase\(/g)).toHaveLength(2);
    expect(src).toMatch(/case 'turn_stop_state':[\s\S]*setTurnPhase\([\s\S]*setTurnPhase\(/);
  });
});

 describe('native compaction visibility', () => {
  it('keeps explicit Tower compaction visible across assistant thinking frames', () => {
    const src = fs.readFileSync(HOOK_PATH, 'utf-8');
    expect(src).toContain('nativeCompactingSessionRef.current = sid');
    expect(src).toContain('nativeCompactingSessionRef.current !== data.sessionId');
    for (const phase of ['done', 'skipped', 'failed']) {
      const start = src.indexOf(`towerMsg.phase === '${phase}') {`);
      expect(start).toBeGreaterThan(-1);
      const next = src.indexOf('} else if (towerMsg.phase', start + 1);
      const branch = src.slice(start, next < 0 ? src.indexOf('break;', start) : next);
      expect(branch).toContain('nativeCompactingSessionRef.current = null;');
      expect(branch).toContain('useChatStore.getState().setCompacting(null);');
      expect(branch.indexOf('nativeCompactingSessionRef.current = null;'))
        .toBeLessThan(branch.indexOf('useChatStore.getState().setCompacting(null);'));
      if (phase === 'done') expect(branch).toContain('setCost({ contextSnapshot:');
    }
  });
});
