import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { countPiCompactionEntries, countPiLocalFallbackMarkersInFile, createPiCompactRecoverySessionFile, createPiLocalFallbackCompaction, createPiOversizedRecoveryEpochFromFile, isPiContextLengthExceededMessage, parsePiPreflightContextMetrics, piRecoveryKeepBudgets, sanitizePiMessagesForRecovery, shouldCreatePiOversizedRecoveryEpoch } from '../pi/compaction-recovery.js';
import { isPiCompactionNoOpMessage } from '../pi/compaction-outcome.js';

describe('Pi compact recovery session file', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recognizes Responses preflight/context overflow messages', () => {
    expect(isPiContextLengthExceededMessage('400 context_length_exceeded')).toBe(true);
    expect(isPiContextLengthExceededMessage('preflightFloor=232560')).toBe(true);
    expect(isPiContextLengthExceededMessage('ordinary error')).toBe(false);
  });

  it('parses authoritative Responses preflight context measurements', () => {
    expect(parsePiPreflightContextMetrics('bodyEstimatedPromptTokens=595723 >= preflightFloor=318060 (ratio=0.9, context=353400)')).toEqual({
      bodyTokens: 595723,
      contextWindow: 353400,
      safeTargetTokens: 176700,
    });
    expect(parsePiPreflightContextMetrics('context_length_exceeded')).toBeNull();
    expect(piRecoveryKeepBudgets(353400)).toEqual([53010, 17670]);
  });

  it('sanitizes binary and caps tool payloads before recovery compaction', () => {
    const payload = 'A'.repeat(9000);
    const messages = sanitizePiMessagesForRecovery([
      { role: 'toolResult', content: [{ type: 'text', text: `<svg href="data:image/png;base64,${payload}">${'x'.repeat(6000)}</svg>` }] },
      { role: 'assistant', content: [{ type: 'toolCall', name: 'read', arguments: { raw: 'y'.repeat(5000) } }, { type: 'image', data: payload, mimeType: 'image/png' }] },
    ]);
    const serialized = JSON.stringify(messages);
    expect(serialized).toContain('embedded binary omitted');
    expect(serialized).toContain('image omitted during context recovery');
    expect(serialized).not.toContain(payload);
    expect(serialized).not.toContain('y'.repeat(3000));
  });

  it('separates compact no-op messages from real provider failures', () => {
    expect(isPiCompactionNoOpMessage('Nothing to compact (session too small)')).toBe(true);
    expect(isPiCompactionNoOpMessage('no useful prefix to compact')).toBe(true);
    expect(isPiCompactionNoOpMessage('external service connection error')).toBe(false);
    expect(isPiCompactionNoOpMessage('context_length_exceeded')).toBe(false);
  });

  it('counts persisted Pi compaction entries', () => {
    expect(countPiCompactionEntries({ getEntries: () => [
      { type: 'message' },
      { type: 'compaction', summary: 'one' },
      { type: 'compaction', summary: 'two' },
    ] } as any)).toBe(2);
    expect(countPiCompactionEntries(null)).toBe(0);
  });

  it('creates a local fallback compaction entry when SDK compaction reports no persisted result', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-pi-local-compact-'));
    tempDirs.push(cwd);
    const sessionDir = path.join(cwd, '.pi', 'sessions');
    fs.mkdirSync(sessionDir, { recursive: true });
    const source = path.join(sessionDir, 'source.jsonl');
    const entries = [
      { type: 'session', version: 3, id: 'sess-local', timestamp: '2026-01-01T00:00:00.000Z', cwd },
      { type: 'model_change', id: 'm1', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', provider: 'litellm-responses', modelId: 'smartest' },
      { type: 'thinking_level_change', id: 't1', parentId: 'm1', timestamp: '2026-01-01T00:00:01.500Z', thinkingLevel: 'high' },
      { type: 'message', id: 'u1', parentId: 't1', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'user', content: [{ type: 'text', text: 'old request details ' + 'x'.repeat(4000) }], timestamp: 1 } },
      { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-01-01T00:00:03.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'old answer ' + 'y'.repeat(4000) }], stopReason: 'stop', timestamp: 2 } },
      { type: 'message', id: 'u2', parentId: 'a1', timestamp: '2026-01-01T00:00:04.000Z', message: { role: 'user', content: [{ type: 'text', text: 'recent request' }], timestamp: 3 } },
      { type: 'message', id: 'a2', parentId: 'u2', timestamp: '2026-01-01T00:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'recent answer' }], stopReason: 'stop', timestamp: 4 } },
    ];
    fs.writeFileSync(source, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

    const manager = SessionManager.open(source, sessionDir);
    const agent = { state: { messages: manager.buildSessionContext().messages } };
    const result = createPiLocalFallbackCompaction({ session: manager as any, agent, reason: 'test no-result', keepRecentTokens: 50 });

    expect(result.succeeded).toBe(true);
    expect(result.after).toBe(1);
    expect(fs.readFileSync(source, 'utf8')).toContain('Tower local fallback compaction');
    expect(agent.state.messages.some((m: any) => m.role === 'compactionSummary')).toBe(true);
  });

  it('streams an oversized source into a bounded recovery epoch without retaining huge payloads', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-pi-oversized-'));
    tempDirs.push(cwd);
    const sessionDir = path.join(cwd, '.pi', 'sessions');
    fs.mkdirSync(sessionDir, { recursive: true });
    const source = path.join(sessionDir, 'oversized.jsonl');
    const huge = 'A'.repeat(5 * 1024 * 1024);
    const lines = [
      { type: 'session', version: 3, id: 'sess-huge', timestamp: '2026-01-01T00:00:00.000Z', cwd },
      { type: 'model_change', id: 'm1', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', provider: 'litellm-responses', modelId: 'smartest' },
      { type: 'compaction', id: 'c1', parentId: 'm1', timestamp: '2026-01-01T00:00:02.000Z', summary: 'Known compact state', firstKeptEntryId: 'm1', tokensBefore: 900000 },
      { type: 'message', id: 'img', parentId: 'c1', timestamp: '2026-01-01T00:00:03.000Z', message: { role: 'toolResult', content: [{ type: 'image', data: huge, mimeType: 'image/png' }] } },
      { type: 'message', id: 'u2', parentId: 'img', timestamp: '2026-01-01T00:00:04.000Z', message: { role: 'user', content: [{ type: 'text', text: 'latest bounded request' }] } },
    ];
    fs.writeFileSync(source, `${lines.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

    expect(shouldCreatePiOversizedRecoveryEpoch(source, 1024)).toBe(true);
    const recovered = await createPiOversizedRecoveryEpochFromFile(source, 'test oversized startup');
    expect(recovered).toBeTruthy();
    expect(fs.statSync(recovered!).size).toBeLessThan(64 * 1024);
    const text = fs.readFileSync(recovered!, 'utf8');
    expect(text).toContain('Known compact state');
    expect(text).toContain('latest bounded request');
    expect(text).toContain('Skipped oversized lines: 1');
    expect(text).not.toContain(huge.slice(0, 10_000));
    expect(fs.statSync(source).size).toBeGreaterThan(5 * 1024 * 1024);
    const reopened = SessionManager.open(recovered!, sessionDir);
    expect(reopened.buildSessionContext().messages.map((m: any) => m.role)).toEqual(['compactionSummary']);
  });

  it('keeps normal files below the recovery threshold on the ordinary resume path', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-pi-normal-'));
    tempDirs.push(cwd);
    const source = path.join(cwd, 'normal.jsonl');
    fs.writeFileSync(source, '{}\n');
    expect(shouldCreatePiOversizedRecoveryEpoch(source, 1024)).toBe(false);
  });

  it('escalates a small session after repeated local fallback compactions', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-pi-fallback-loop-'));
    tempDirs.push(cwd);
    const source = path.join(cwd, 'fallback-loop.jsonl');
    fs.writeFileSync(source, [
      JSON.stringify({ type: 'session', id: 's1' }),
      JSON.stringify({ type: 'compaction', id: 'c1', details: { localFallback: true } }),
      JSON.stringify({ type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'continue' }] } }),
      JSON.stringify({ type: 'compaction', id: 'c2', details: { localFallback: true } }),
    ].join('\n') + '\n');

    expect(fs.statSync(source).size).toBeLessThan(1024);
    expect(countPiLocalFallbackMarkersInFile(source)).toBe(2);
    expect(shouldCreatePiOversizedRecoveryEpoch(source, 1024)).toBe(true);
  });

  it('does not escalate after only one local fallback compaction', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-pi-single-fallback-'));
    tempDirs.push(cwd);
    const source = path.join(cwd, 'single-fallback.jsonl');
    fs.writeFileSync(source, JSON.stringify({ type: 'compaction', details: { localFallback: true } }) + '\n');
    expect(countPiLocalFallbackMarkersInFile(source)).toBe(1);
    expect(shouldCreatePiOversizedRecoveryEpoch(source, 1024)).toBe(false);
  });

  it('creates a summary-only recovery file from latest compaction', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-pi-recover-'));
    tempDirs.push(cwd);
    const sessionDir = path.join(cwd, '.pi', 'sessions');
    fs.mkdirSync(sessionDir, { recursive: true });
    const source = path.join(sessionDir, 'source.jsonl');
    const entries = [
      { type: 'session', version: 3, id: 'sess-recover', timestamp: '2026-01-01T00:00:00.000Z', cwd },
      { type: 'model_change', id: 'm1', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', provider: 'litellm-responses', modelId: 'smartest' },
      { type: 'message', id: 'u1', parentId: 'm1', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'user', content: [{ type: 'text', text: 'start' }], timestamp: 1 } },
      { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-01-01T00:00:03.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(1000) }], timestamp: 2 } },
      { type: 'compaction', id: 'c1', parentId: 'a1', timestamp: '2026-01-01T00:00:04.000Z', summary: '## Summary\nKeep this only.', firstKeptEntryId: 'u1', tokensBefore: 1234, details: {}, fromHook: false },
      { type: 'message', id: 'a2', parentId: 'c1', timestamp: '2026-01-01T00:00:05.000Z', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'context_length_exceeded', timestamp: 3 } },
    ];
    fs.writeFileSync(source, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

    const manager = SessionManager.open(source, sessionDir);
    const recovered = createPiCompactRecoverySessionFile(manager as any, 'context_length_exceeded after compact');

    expect(recovered).toBeTruthy();
    expect(fs.existsSync(recovered!)).toBe(true);
    const reopened = SessionManager.open(recovered!, sessionDir);
    const ctx = reopened.buildSessionContext();
    expect(ctx.messages.map((m: any) => m.role)).toEqual(['compactionSummary']);
    expect(JSON.stringify(ctx.messages)).toContain('Keep this only');
    expect(JSON.stringify(ctx.messages)).not.toContain('x'.repeat(100));
  });
});
