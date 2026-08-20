import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const src = fs.readFileSync(path.resolve(import.meta.dirname, './recovery-coordinator.ts'), 'utf8');
const supervisor = fs.readFileSync(path.resolve(import.meta.dirname, './turn-supervisor.ts'), 'utf8');
const engine = fs.readFileSync(path.resolve(import.meta.dirname, '../../engines/pi-engine.ts'), 'utf8');
const ws = fs.readFileSync(path.resolve(import.meta.dirname, '../../routes/ws-handler.ts'), 'utf8');
const backend = fs.readFileSync(path.resolve(import.meta.dirname, '../../index.ts'), 'utf8');

describe('root turn recovery ownership', () => {
  it('claims with a DB row lock, lease, attempt and fencing token', () => {
    expect(supervisor).toContain('FOR UPDATE');
    expect(supervisor).toContain("state = 'running'");
    expect(supervisor).toContain('attempt_count');
    expect(supervisor).toContain('owner_token');
    expect(supervisor).toContain('lease_until');
    expect(supervisor).toContain('owner_token = $2');
    expect(supervisor).toContain("state NOT IN ('completed', 'failed', 'needs_attention')");
    expect(supervisor).toContain('auto_resume_attempts_exhausted');
    expect(supervisor).toContain('attempt_count < $7::int');
    expect(src).toContain("state: exhausted ? 'needs_attention' : 'waiting_retry'");
  });

  it('routes foreground execution and automatic recovery through one durable owner contract', () => {
    expect(engine).toContain('runPiContinuationRecovery({');
    expect(engine).toContain('claim: tryClaimRecovery');
    expect(engine).toContain("trigger: 'post_compact'");
    expect(engine).toContain("trigger: 'transient'");
    expect(engine).toContain("trigger: 'incomplete'");
    expect(engine).toContain('const initialClaim = opts.autoResume');
    expect(engine).toContain('? await tryClaimAgentTurnRecovery({');
    expect(engine).toContain(': await tryClaimForegroundAgentTurn({');
    expect(engine).toContain('if (recoveryClaimToken)');
    expect(ws).toContain('rootTurnId: userMsgId');
    expect(ws).toContain('rootTurnId: userMessageId');
    expect(ws).toContain('findRecoverableAgentTurnForSession(sessionId)');
    expect(ws).toContain('PI_AUTO_RESUME_MAX_SESSION_FILE_BYTES');
    expect(ws).toContain('pi_session_file_too_large');
  });

  it('removes unsafe turns before generic startup auto-resume', () => {
    expect(backend).toContain('await interruptRestartedWaitingUserTurns()');
    expect(backend).toContain('interruptedAuqSessions.has(interruptedSessions[i].id)');
    expect(backend).toContain('await expireUnsafeRestartRecoveryTurns({ maxAgeHours: 24 })');
    expect(backend).toContain('expiredRootIds.has(interruptedSessions[i].userMessageId!)');
    expect(backend.indexOf('await interruptRestartedWaitingUserTurns()')).toBeLessThan(
      backend.indexOf('await expireUnsafeRestartRecoveryTurns'),
    );
    expect(backend.indexOf('await expireUnsafeRestartRecoveryTurns')).toBeLessThan(
      backend.indexOf('await findOrphanedStartedAgentTurns'),
    );
  });

  it('fails closed when foreground execution or automatic recovery has no durable root identity', () => {
    expect(engine).toContain('if (!opts.rootTurnId)');
    expect(engine).toContain('Pi execution skipped because the durable root turn identity is missing.');
    expect(engine).toContain('recovery skipped without rootTurnId');
  });

  it('terminally fences a retry turn when its native engine session identity is missing', () => {
    expect(ws).toContain('stop reason=missing_engine_session_id');
    expect(ws).toContain("failureClass: 'missing_engine_session_id'");
    expect(ws).toContain("status: 'needs_attention'");
    expect(ws).toContain('forceNeedsAttention: true');
    expect(ws).not.toContain('has no engineSessionId for engine=${engineName} — skipping');
  });
});
