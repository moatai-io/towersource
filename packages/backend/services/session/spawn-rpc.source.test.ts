import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = fs.readFileSync(path.resolve(import.meta.dirname, './spawn-rpc.ts'), 'utf-8');

describe('spawn-rpc spawn idempotency contract', () => {
  it('serializes an equivalent parent request and reuses a recent child', () => {
    expect(SRC).toContain('buildSpawnRequestFingerprint(req)');
    expect(SRC).toContain('pg_advisory_lock(hashtextextended($1, 0))');
    expect(SRC).toContain('sc.request_fingerprint = $3');
    expect(SRC).toContain("interval '1 second'");
    expect(SRC).toContain('deduplicated: true');
  });

  it('persists request identity with the callback before returning success', () => {
    expect(SRC).toContain('persistCallback(cb, requestFingerprint, req.rootTurnId ?? null, operationId)');
    expect(SRC).toContain('request_fingerprint');
  });

  it('prefers durable root-turn operation identity over the bounded semantic fallback', () => {
    expect(SRC).toContain('const operationId = req.operationId?.trim() || null');
    expect(SRC).toContain('sc.operation_id = $2');
    expect(SRC).toContain('sc.root_turn_id = $5 AND sc.request_fingerprint = $3');
    expect(SRC).toContain('root_turn_id, operation_id');
    expect(SRC).toContain('const lockIdentity = operationId || requestFingerprint');
  });
});

describe('spawn-rpc runner start acknowledgement contract', () => {
  it('does not report spawn success until the background runner reaches engine.run', () => {
    expect(SRC).toContain('createRunnerStartAcknowledgement(`spawn ${child.id.slice(0, 8)}`)');
    expect(SRC).toMatch(/runChildSessionInBackground\(child\.id, req, cwd, projectId, startAck\)/);
    expect(SRC).toMatch(/await startAck\.started;[\s\S]*return \{ sessionId: child\.id, spawnId \}/);
    expect(SRC).toMatch(/runSessionTurnStream\(\{[\s\S]*sessionId: childSessionId,[\s\S]*startAcknowledgement: startAck/);
  });

  it('does not report send success until the target runner reaches engine.run', () => {
    expect(SRC).toContain('createRunnerStartAcknowledgement(`send ${req.targetSessionId.slice(0, 8)}`)');
    expect(SRC).toMatch(/runSendInBackground\(req, target, wrappedPrompt, userMsgId, startAck, sendShadow\?\.deliveryId, durableClaim\)/);
    expect(SRC).toMatch(/await startAck\.started;[\s\S]*return \{ ok: true \}/);
    expect(SRC).toMatch(/runSessionTurnStream\(\{[\s\S]*sessionId: req\.targetSessionId,[\s\S]*startAcknowledgement: startAck/);
  });

  it('returns explicit start failure or timeout instead of leaving silent idle children', () => {
    expect(SRC).toContain('RUNNER_START_FAILED');
    expect(SRC).toContain('RUNNER_START_TIMEOUT');
    expect(SRC).toContain('startAck.fail(topErr)');
    expect(SRC).toMatch(/catch \(err\) \{[\s\S]*await onSpawnError\(child\.id,[\s\S]*throw err/);
  });
});

describe('spawn-rpc session-send authority contract', () => {
  it('delegates target authorization to the shared send-access policy with diagnostics', () => {
    expect(SRC).toContain("import { canSendSessionMessage, getUserAccessiblePaths, resolveSessionProjectRoot } from '../pm/project-access.js'");
    expect(SRC).toContain('const access = await canSendSessionMessage(req.targetSessionId, req.callerUserId, req.callerRole)');
    expect(SRC).toContain('SEND_PERMISSION_DENIED (${access.reason}): ${access.message}');
    expect(SRC).toContain('reason: access.reason');
    expect(SRC).not.toContain("const isAdmin = req.callerRole === 'admin'");
  });
});

describe('spawn-rpc authority inheritance contract', () => {
  it('inherits private visibility into a child instead of the shared project default', () => {
    expect(SRC).toContain("{ visibility: parent.visibility === 'private' ? 'private' : 'project' }");
  });
  it('runs spawned children with the parent role and scoped paths', () => {
    expect(SRC).toContain('parentRole: string');
    expect(SRC).toContain('getUserAccessiblePaths(req.parentUserId, req.parentRole)');
    expect(SRC).toContain('userRole: req.parentRole');
    expect(SRC).toMatch(/allowedPath: req\.parentRole === 'admin' \|\| req\.parentRole === 'operator'[\s\S]*: cwd/);
    expect(SRC).not.toContain("userRole: 'admin'");
    expect(SRC).not.toContain('accessiblePaths: null as string[] | null');
  });

  it('re-resolves the parent role for autonomous wake runs', () => {
    expect(SRC).toContain("SELECT role FROM users WHERE id = $1");
    expect(SRC).toContain("?.role || 'member'");
    expect(SRC).toContain('userRole: parentRole');
    expect(SRC).toContain('getUserAccessiblePaths(parentUserId, parentRole)');
  });
});

describe('spawn-rpc legacy delivery shadow settlement contract', () => {
  it('records active steer, idle turn start, completion, and failure without changing runner authority', () => {
    expect(SRC).toContain("import { settleDeliveryShadow } from '../agent-communication/delivery-shadow.js'");
    expect(SRC).toMatch(/await engine\.steer\(req\.targetSessionId,[\s\S]*state: 'injected_active',[\s\S]*mode: 'steer'/);
    expect(SRC).toMatch(/await startAck\.started;[\s\S]*state: 'started_turn',[\s\S]*mode: 'new-turn'/);
    expect(SRC).toMatch(/async function runSendInBackground[\s\S]*state: 'completed',[\s\S]*recipientRootTurnId: rootTurnId/);
    expect(SRC).toMatch(/catch \(err: any\)[\s\S]*state: 'failed',[\s\S]*error: err\?\.message \|\| String\(err\)/);
  });

  it('settles completion inject and wake only after legacy delivery accepts the report', () => {
    const done = SRC.slice(SRC.indexOf('async function onSpawnDone'), SRC.indexOf('async function onSpawnError'));
    expect(done).toMatch(/await injectIntoCallerDirect[\s\S]*state: 'completed',[\s\S]*mode: 'stored'/);
    expect(done).toMatch(/await injectAndWake[\s\S]*state: 'completed',[\s\S]*mode: 'new-turn'/);
    expect(done.indexOf('await injectIntoCallerDirect')).toBeLessThan(done.indexOf("state: 'completed'"));
    expect(done.indexOf('await injectAndWake')).toBeLessThan(done.lastIndexOf("state: 'completed'"));
  });
});

describe('spawn-rpc durable completion shadow contract', () => {
  it('records inject and wake child completions before consuming the durable callback', () => {
    const done = SRC.slice(SRC.indexOf('async function onSpawnDone'), SRC.indexOf('async function onSpawnError'));
    expect(SRC).toContain("import { recordCompletionReportShadow } from '../agent-communication/completion-shadow.js'");
    expect(done).toMatch(/if \(mode === 'inject-only' \|\| mode === 'inject-and-wake'\) \{[\s\S]*await recordCompletionReportShadow\(\{/);
    expect(done).toContain('spawnId: cb.spawnId');
    expect(done).toContain('await claimDeliveryById({ deliveryId: completionShadow.deliveryId');
    expect(done.indexOf('await recordCompletionReportShadow')).toBeLessThan(done.indexOf('await claimDeliveryById'));
    expect(done.indexOf('await recordCompletionReportShadow')).toBeLessThan(done.indexOf('await injectIntoCallerDirect'));
    expect(done.indexOf('await recordCompletionReportShadow')).toBeLessThan(done.indexOf('await injectAndWake'));
    expect(done.indexOf('await recordCompletionReportShadow')).toBeLessThan(done.indexOf('pending.delete(childSessionId)', done.indexOf('await recordCompletionReportShadow')));
  });
});

describe('spawn-rpc durable send shadow contract', () => {
  it('records accepted send provenance after the legacy user message is durable and before delivery starts', () => {
    expect(SRC).toContain("import { recordSessionSendShadow } from '../agent-communication/send-shadow.js'");
    expect(SRC).toMatch(/await saveMessage\(req\.targetSessionId,[\s\S]*await recordSessionSendShadow\(\{[\s\S]*sourceRootTurnId: userMsgId,[\s\S]*broadcastFn\?\.\('tower_message'/);
    expect(SRC).toContain("onComplete: req.onComplete || 'wake'");
    expect(SRC).toContain('workerId: req.agentReport?.workerId');
    expect(SRC).toContain('agentRunId: req.agentReport?.runId');
  });
});

describe('spawn-rpc agent report steering contract', () => {
  it('steers send-to-session follow-ups into busy Pi targets instead of TARGET_STREAMING', () => {
    expect(SRC).toMatch(/const targetIsRunning = getAllRunningSessionIds\(\)\.includes\(req\.targetSessionId\)/);
    expect(SRC).toMatch(/if \(targetIsRunning\) \{[\s\S]*if \(engineName === 'pi' && engine\.steer\) \{[\s\S]*await engine\.steer\(req\.targetSessionId, wrappedPrompt, userMsgId, req\.callerSessionName\)/);
    expect(SRC).toContain('steer into the active run; its normal completion callback carries the updated context');
  });

  it('does not consume a durable completion callback before wake runner start is acknowledged', () => {
    const done = SRC.slice(SRC.indexOf('async function onSpawnDone'), SRC.indexOf('async function onSpawnError'));
    expect(done.indexOf('await injectAndWake')).toBeLessThan(done.indexOf('pending.delete(childSessionId)', done.indexOf('await injectAndWake')));
    expect(done).toContain('scheduleSpawnCompletionRetry(childSessionId)');
    expect(SRC).toContain('const startAck = createRunnerStartAcknowledgement(`wake ${parentSessionId.slice(0, 8)}`)');
    expect(SRC).toContain('await startAck.started');
    expect(SRC).toContain("runSessionTurnStream");
    expect(SRC).toMatch(/runSessionTurnStream\(\{[\s\S]*sessionId: parentSessionId,[\s\S]*startAcknowledgement: startAck/);
  });

  it('tries Pi steering for agent-origin wake reports while parent is already running', () => {
    expect(SRC).toContain('async function trySteerAgentReport');
    expect(SRC).toMatch(/if \(wakeRunsStartingOrActive\.has\(parentSessionId\) \|\| getAllRunningSessionIds\(\)\.includes\(parentSessionId\)\) \{[\s\S]*if \(agentReport\) \{[\s\S]*trySteerAgentReport\(parentSessionId, fromName, injected\.prompt, injected\.msgId\)/);
    expect(SRC).toMatch(/await engine\.steer\(parentSessionId, prompt, msgId, fromName\)/);
  });

  it('falls back to a queued post-turn wake without saving a second agent report card', () => {
    expect(SRC).toContain('preInjectedPrompt?: string');
    expect(SRC).toContain('preInjectedRootTurnId?: string');
    expect(SRC).toMatch(/queue\.push\(\{[\s\S]*preInjectedPrompt: injected\.prompt,[\s\S]*preInjectedRootTurnId: injected\.msgId/);
    expect(SRC).toMatch(/if \(next\.preInjectedPrompt\) \{[\s\S]*runWakeInBackground\([\s\S]*next\.preInjectedPrompt,[\s\S]*next\.preInjectedRootTurnId!/);
  });

  it('serializes simultaneous worker wake starts before engine running state becomes visible', () => {
    expect(SRC).toContain('const wakeRunsStartingOrActive = new Set<string>()');
    expect(SRC).toMatch(/wakeRunsStartingOrActive\.has\(parentSessionId\) \|\| getAllRunningSessionIds\(\)\.includes\(parentSessionId\)/);
    expect(SRC).toMatch(/async function performWake[\s\S]*wakeRunsStartingOrActive\.add\(parentSessionId\);[\s\S]*const injected = await injectAgentWakeMessage/);
    expect(SRC).toMatch(/\.finally\(\(\) => \{[\s\S]*wakeRunsStartingOrActive\.delete\(parentSessionId\);[\s\S]*schedulePendingWakeFlush\(parentSessionId\)/);
  });

  it('persists a started checkpoint before spawn/send/wake background Pi runs claim their root turn', () => {
    expect(SRC).toContain('rootTurnId: userMsgId');
    expect(SRC).toContain('runSendInBackground(req, target, wrappedPrompt, userMsgId, startAck, sendShadow?.deliveryId, durableClaim)');
    expect(SRC).toMatch(/async function runSendInBackground\([\s\S]*rootTurnId: string[\s\S]*rootTurnId,[\s\S]*\};/);
    expect(SRC).toContain('runWakeInBackground(parentSessionId, parentUserId, injected.prompt, injected.msgId, startAck, deliveryClaim)');
    expect(SRC).toMatch(/await saveMessage\(childSessionId,[\s\S]*await markAgentTurnCheckpoint\(userMsgId,[\s\S]*status: 'started'[\s\S]*runSessionTurnStream\(\{[\s\S]*sessionId: childSessionId/);
    expect(SRC).toMatch(/async function runSendInBackground[\s\S]*await markAgentTurnCheckpoint\(rootTurnId,[\s\S]*status: 'started'[\s\S]*runSessionTurnStream\(\{[\s\S]*sessionId: req\.targetSessionId/);
    expect(SRC).toMatch(/async function runWakeInBackground[\s\S]*await markAgentTurnCheckpoint\(rootTurnId,[\s\S]*status: 'started'[\s\S]*runSessionTurnStream\(\{[\s\S]*sessionId: parentSessionId/);
  });

  it('settles the idle wake checkpoint when the parent engine reaches engine_done', () => {
    expect(SRC).toMatch(/if \(towerMsg\.type === 'engine_done'\) \{[\s\S]*await markAgentTurnCheckpoint\(rootTurnId,[\s\S]*status: !outcome \|\| outcome === 'completed' \? 'completed' : 'failed'/);
  });

  it('keeps auto-wake budget consumption at actual parent auto-run points', () => {
    expect(SRC).toMatch(/Do NOT[\s\S]*consume auto-wake budget here/);
    expect(SRC).toMatch(/if \(!consumeAutoWakeBudget\(parentSessionId\)\) \{[\s\S]*await injectAgentWakeMessage\(parentSessionId, fromName, text, 'cap-fallback', agentReport\)/);
    expect(SRC).toMatch(/if \(next\.preInjectedPrompt\) \{[\s\S]*if \(!consumeAutoWakeBudget\(parentSessionId\)\)/);
  });

  it('recovers existing persistent worker responses as exactly-once parent reports without replaying the worker task', () => {
    expect(SRC).toContain('export async function ensureAgentRunReportDelivered');
    expect(SRC).toContain('function hasParentAgentReportForRun');
    expect(SRC).toMatch(/metadata->'agentWake'->>'runId' = \$2/);
    expect(SRC).toMatch(/metadata->'agentReport'->>'runId' = \$2/);
    expect(SRC).toContain("if (!input.text.trim()) return { delivered: false, skipped: 'empty_text' }");
    expect(SRC).toContain("return { delivered: false, skipped: 'duplicate' }");
    expect(SRC).toContain("deliveryPolicy: 'wake'");
    expect(SRC).toContain('Accept the report before attempting the wake');
    expect(SRC).toMatch(/await injectAndWake\(input\.parentSessionId/);
    expect(SRC).toContain("state: 'retry_wait'");
  });

  it('injects persistent agent reports as compact parent-facing summaries, not full transcripts', () => {
    expect(SRC).toContain('function buildAgentReportAssistantContent');
    expect(SRC).toMatch(/agentReport[\s\S]*\? buildAgentReportAssistantContent\(fromName, text, agentReport\)/);
    expect(SRC).toContain('Full result: open the backing session, listed detail artifacts, or use persistent_agent_status when more detail is needed.');
    expect(SRC).toContain('function sessionDeepLink');
    expect(SRC).toContain('config.sharePublicUrl || config.publicUrl');
    expect(SRC).toMatch(/mode: 'inject'/);
    expect(SRC).toMatch(/Summary: \$\{summary\}/);
    expect(SRC).toContain('stripOptionalReportSections');
    expect(SRC).toContain('agent_report');
    expect(SRC).toContain('parseAgentReportRef');
    expect(SRC).toContain('parentSessionId?: string');
    expect(SRC).toContain('parentSessionName?: string');
    expect(SRC).toContain('Parent session:');
  });

  it('preserves structured pointers for progressive disclosure of long subagent work', () => {
    expect(SRC).toContain('detailArtifactPaths?: string[]');
    expect(SRC).toContain('detailArtifactSummary?: string');
    expect(SRC).toContain('retrievalHint?: string');
    expect(SRC).toContain('function collectReportPointers');
    expect(SRC).toContain('extractArtifactPathsFromSection');
    expect(SRC).toContain("extractReportSection(text, 'DETAIL_ARTIFACTS')");
    expect(SRC).toContain("extractReportSection(text, 'READ_IF_NEEDED')");
    expect(SRC).toContain('Detail artifact paths:');
    expect(SRC).toContain('Detail artifact summary:');
    expect(SRC).toContain('Read if needed:');
    expect(SRC).toContain('listed detail artifacts');
    expect(SRC).toContain('detailArtifacts');
    expect(SRC).toContain('detailArtifactPaths');
    expect(SRC).toContain('readIfNeeded');
  });
});

// Execute the small production budget block without importing DB/engine services.
describe('auto-wake chain budget', () => {
  function budget() {
    const start = SRC.indexOf('const MAX_AUTO_WAKE_CHAIN =');
    const end = SRC.indexOf('// ── Pending wake queue', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const code = ts.transpile(SRC.slice(start, end).replace('export function', 'function'));
    return vm.runInNewContext(code + '\n({ consumeAutoWakeBudget, resetAutoWakeCount, max: MAX_AUTO_WAKE_CHAIN })') as {
      consumeAutoWakeBudget(id: string): boolean; resetAutoWakeCount(id: string): void; max: number;
    };
  }
  it('permits 10 automatic resumes and blocks the 11th', () => {
    const b = budget(); expect(b.max).toBe(10);
    for (let i = 0; i < 10; i++) expect(b.consumeAutoWakeBudget('parent')).toBe(true);
    expect(b.consumeAutoWakeBudget('parent')).toBe(false);
    expect(b.consumeAutoWakeBudget('parent')).toBe(false);
  });
  it('isolates parents and restores the full budget on user reset', () => {
    const b = budget();
    for (let i = 0; i < 10; i++) b.consumeAutoWakeBudget('a');
    expect(b.consumeAutoWakeBudget('b')).toBe(true);
    b.resetAutoWakeCount('a');
    for (let i = 0; i < 10; i++) expect(b.consumeAutoWakeBudget('a')).toBe(true);
    expect(b.consumeAutoWakeBudget('a')).toBe(false);
  });
});

describe('persistent completion delivery convergence', () => {
  it('routes run-bearing callbacks through the same delivery helper as recovery', () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, 'spawn-rpc.ts'), 'utf8');
    const start = source.indexOf('if (agentReport?.runId &&');
    expect(start).toBeGreaterThan(0);
    const branch = source.slice(start, source.indexOf("const child = await getSession", start));
    expect(branch).toContain('await ensureAgentRunReportDelivered(');
    expect(branch).toContain('await markCallbackFired(cb.spawnId)');
    expect(branch).toContain('return;');
  });
});

describe('durable report startup order', () => {
  it('does not wait for a runner-owned acknowledgement before starting the runner', () => {
    const start = SRC.indexOf('async function runWakeInBackground');
    const wake = SRC.slice(start);
    const runner = wake.indexOf('await runSessionTurnStream(');
    expect(runner).toBeGreaterThan(0);
    expect(wake.slice(0, runner)).not.toContain('await startAck.started');
    expect(wake.slice(runner)).toContain('await markClaimedDeliveryStarted(');
  });
});
