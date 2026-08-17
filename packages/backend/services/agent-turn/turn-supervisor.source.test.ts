import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const src = fs.readFileSync(path.resolve(import.meta.dirname, './turn-supervisor.ts'), 'utf8');
const engine = fs.readFileSync(path.resolve(import.meta.dirname, '../../engines/pi-engine.ts'), 'utf8');
const ws = fs.readFileSync(path.resolve(import.meta.dirname, '../../routes/ws-handler.ts'), 'utf8');
const classifier = fs.readFileSync(path.resolve(import.meta.dirname, '../../engines/pi-failure-classifier.ts'), 'utf8');

describe('durable agent turn supervisor', () => {
  it('uses one fenced state row and bounded retry scheduling', () => {
    expect(src).toContain('FOR UPDATE');
    expect(src).toContain("state = 'running'");
    expect(src).toContain("$3 = 'waiting_retry'");
    expect(src).toContain('next_attempt_at');
    expect(src).toContain('owner_token = $2');
    expect(src).toContain('renewAgentTurnClaim');
    expect(engine).toContain('recoveryLeaseHeartbeat');
    expect(engine).toContain('Pi session creation failed');
    expect(src).toContain('getActiveAgentTurnTiming');
    expect(src).toContain('setAgentTurnWaitingUser');
    expect(src).toContain('waiting_user_ms = waiting_user_ms + CASE');
  });

  it('does not treat the root user message itself as a newer superseding turn', () => {
    const rootExclusions = src.match(/newer_user\.id <> t\.root_turn_id/g) || [];
    expect(rootExclusions).toHaveLength(2);
    expect(src).toContain("newer_user.role = 'user'");
    expect(src).toContain('newer_user.created_at > COALESCE(t.accepted_at, t.created_at)');
  });

  it('schedules durable retry only after releasing the in-flight session fence', () => {
    expect(ws).toContain('let durableRetryScheduled = false');
    expect(ws).toContain('durableRetryScheduled = true');
    expect(ws).toMatch(/autoResumeSessionsInFlight\.delete\(sessionId\);[\s\S]*if \(durableRetryScheduled\)[\s\S]*wakeAgentTurnDispatcher\(21_000\)/);
    expect(ws).not.toMatch(/setTimeout\(\(\) => \{[\s\S]*resumeInterruptedDetails[\s\S]*\}, 21_000\)/);
  });

  it('claims foreground turns with the same fence without consuming recovery attempts', () => {
    expect(src).toContain('claimForegroundAgentTurn');
    expect(src).toContain("recovery_source = 'foreground'");
    expect(src).toContain("state = 'running'");
    expect(src).toContain('owner_token IS NULL');
    const foregroundClaimSource = src.slice(src.indexOf('export async function claimForegroundAgentTurn'), src.indexOf('/** Claim one automatic recovery attempt'));
    expect(foregroundClaimSource).not.toMatch(/attempt_count\s*=/);
    expect(engine).toContain('tryClaimForegroundAgentTurn');
    expect(engine).toMatch(/opts\.autoResume[\s\S]*tryClaimAgentTurnRecovery[\s\S]*tryClaimForegroundAgentTurn/);
    expect(engine).toContain('if (recoveryClaimToken) {');
  });

  it('discovers due retries without bypassing the existing fenced recovery path', () => {
    expect(src).toContain('findDueAgentTurnRetries');
    expect(src).toContain("t.state = 'waiting_retry'");
    expect(src).toContain('(t.next_attempt_at IS NULL OR t.next_attempt_at <= NOW())');
    expect(src).toContain('t.owner_token IS NULL');
    expect(src).toContain("COALESCE(t.accepted_at, t.created_at) >= NOW() - ($2::int * INTERVAL '1 hour')");
    expect(src).toContain('NOT EXISTS (\n          SELECT 1 FROM messages newer_user');
    expect(ws).toContain('dispatchDueAgentTurnRetries');
    expect(ws).toContain("recoverySource: 'durable-dispatcher'");
    expect(ws).toContain('await resumeInterruptedDetails(candidates.map');
  });

  it('fails stale or superseded restart recovery closed before model execution', () => {
    expect(src).toContain('expireUnsafeRestartRecoveryTurns');
    expect(src).toContain("t.state IN ('running', 'waiting_retry', 'stop_requested')");
    expect(src).toContain("last_failure_class = CASE candidates.reason");
    expect(src).toContain("WHEN 'superseded' THEN 'restart_recovery_superseded'");
    expect(src).toContain("ELSE 'restart_recovery_stale'");
    expect(src).toContain("Automatic recovery skipped because this turn has been inactive for more than 24 hours.");
  });

  it('fails interrupted AskUserQuestion waits closed across backend restart', () => {
    expect(src).toContain('interruptRestartedWaitingUserTurns');
    expect(src).toContain("last_failure_class = 'ask_user_restart_interrupted'");
    expect(src).toContain("state = 'needs_attention'");
    expect(src).toContain('WHERE waiting_user_started_at IS NOT NULL');
  });

  it('returns the latest durable turn outcome without treating it as live runtime authority', () => {
    expect(src).toContain('ORDER BY accepted_at DESC');
    expect(src).not.toContain("AND state IN ('waiting_retry', 'needs_attention')");
    expect(ws).toContain('isStreaming: durableTiming.state === \'running\'');
    expect(ws).toContain('if (remoteSnapshot?.isStreaming || remoteSnapshot?.pendingQuestion) return remoteSnapshot');
  });

  it('does not confuse engine closure with durable completion', () => {
    expect(engine).toContain("outcome: durableOutcome");
    expect(engine).toContain("durableAssistant: Boolean(lastSavedAssistantMsgId)");
    expect(ws).toContain('const durableAssistantMessageId = towerMsg.assistantMessageId');
    expect(ws).toContain("const completed = terminalDecision.outcome === 'completed'");
    expect(ws).toContain("status: completed ? 'completed' : (recoveryOutcome === 'retryable_failure' ? 'waiting_retry' : 'needs_attention')");
    expect(ws).toContain('durableRetryScheduled = true');
    expect(ws).toContain('wakeAgentTurnDispatcher(21_000)');
    expect(ws).toContain("recoverySource: 'durable-dispatcher'");
    expect(engine).toContain('Pi turn ended after tool calls without a final assistant answer.');
    expect(engine).toContain("durableOutcome = 'retryable_failure'");
    expect(ws).toContain("towerMsg.outcome === 'claim_denied'");
    expect(ws).toContain("const completedForSideEffects = terminalDecision.outcome === 'completed'");
    expect(ws).toContain("status: terminalDecision.outcome === 'completed'");
    expect(ws).toContain("completedForSideEffects && client.userId");
  });

  it('classifies the observed router timeout as transient transport', () => {
    expect(classifier).toContain('upstream_unavailable');
    expect(classifier).toContain('request (?:to upstream )?timed out');
  });
});
