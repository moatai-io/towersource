/**
 * Integration tests for PiEngine.rehydrateFromMessages.
 *
 * Goes further than the pure conversion unit tests (tower-to-pi.test.ts) —
 * actually writes a Pi sessionFile to a temp dir and re-opens it with the
 * real SessionManager.open() to verify the chain Tower DB → conversion →
 * SessionManager.appendMessage() → on-disk JSONL → SessionManager.open()
 * round-trips correctly.
 *
 * No LLM call, no Pi agent runtime — only the file persistence path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { PiEngine } from '../pi-engine.js';
import type { RehydrateInputMessage } from '../types.js';

const T0 = 1_700_000_000_000;

let tmpCwd: string;
let engine: PiEngine;

beforeEach(() => {
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-rehydrate-test-'));
  engine = new PiEngine();
});

afterEach(() => {
  try { fs.rmSync(tmpCwd, { recursive: true, force: true }); } catch {}
});

describe('PiEngine.rehydrateFromMessages — file persistence round-trip', () => {
  // ── SDK invariant: SessionManager._persist defers writing to disk until the
  // first assistant entry arrives (see node_modules/.../session-manager.js
  // around _persist).  Production hard-switch always rehydrates at an idle
  // boundary where the last entry IS assistant text, so this is a non-issue
  // in practice.  Tests that intentionally produce user-only sequences must
  // therefore NOT assert fs.existsSync; the path is committed, the bytes
  // land when the next assistant turn does.  Tower DB stays source-of-truth.
  it('returns a sessionFile path under <cwd>/.pi/sessions/ (file flushed once an assistant entry is appended)', async () => {
    const messages: RehydrateInputMessage[] = [
      { id: 'u-1', role: 'user', content: [{ type: 'text', text: '안녕' }], timestamp: T0 },
      { id: 'a-1', role: 'assistant', content: [{ type: 'text', text: '네' }], timestamp: T0 + 1 },
    ];

    const sessionFile = await engine.rehydrateFromMessages('sess-1', messages, tmpCwd);

    expect(sessionFile).toMatch(/\.pi\/sessions\/.+\.jsonl$/);
    expect(fs.existsSync(sessionFile)).toBe(true);
    expect(sessionFile.startsWith(path.join(tmpCwd, '.pi', 'sessions'))).toBe(true);
  });

  it('round-trips a classic 3-turn conversation through SessionManager.open()', async () => {
    const messages: RehydrateInputMessage[] = [
      { id: 'u-1', role: 'user', content: [{ type: 'text', text: '파일 보여줘' }], timestamp: T0 },
      {
        id: 'a-1', role: 'assistant',
        content: [
          { type: 'text', text: '확인 중' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a.txt' } },
        ],
        timestamp: T0 + 1000,
      },
      {
        id: 'u-2', role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents' }],
        timestamp: T0 + 2000,
      },
      { id: 'a-2', role: 'assistant', content: [{ type: 'text', text: '내용은 ...' }], timestamp: T0 + 3000 },
    ];

    const sessionFile = await engine.rehydrateFromMessages('sess-1', messages, tmpCwd);

    // Re-open with the real SessionManager — this is what PiEngine.run()
    // does on resume. If anything is wrong, open() throws.
    const piSessionDir = path.join(tmpCwd, '.pi', 'sessions');
    const reopened = SessionManager.open(sessionFile, piSessionDir);

    const ctx = reopened.buildSessionContext();
    // 4 messages in, 4 entries out (no expansion since there's only 1 tool_result per row).
    expect(ctx.messages).toHaveLength(4);

    expect(ctx.messages[0].role).toBe('user');
    expect(ctx.messages[1].role).toBe('assistant');
    expect(ctx.messages[2].role).toBe('toolResult');
    expect(ctx.messages[3].role).toBe('assistant');

    // tool_use_id preserved across the boundary
    if (ctx.messages[1].role === 'assistant') {
      const toolCall = ctx.messages[1].content.find((c: any) => c.type === 'toolCall');
      expect(toolCall).toBeDefined();
      expect((toolCall as any).id).toBe('toolu_1');
    }
    if (ctx.messages[2].role === 'toolResult') {
      expect(ctx.messages[2].toolCallId).toBe('toolu_1');
    }
  });

  it('a user row with multiple tool_results becomes multiple toolResult entries on disk', async () => {
    const messages: RehydrateInputMessage[] = [
      {
        id: 'a-1', role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a' } },
          { type: 'tool_use', id: 't2', name: 'Read', input: { path: 'b' } },
        ],
        timestamp: T0,
      },
      {
        id: 'u-1', role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'a content' },
          { type: 'tool_result', tool_use_id: 't2', content: 'b content' },
        ],
        timestamp: T0 + 100,
      },
    ];

    const sessionFile = await engine.rehydrateFromMessages('sess-2', messages, tmpCwd);
    const reopened = SessionManager.open(sessionFile, path.join(tmpCwd, '.pi', 'sessions'));
    const ctx = reopened.buildSessionContext();

    // 1 assistant + 2 toolResult entries = 3 messages in context
    expect(ctx.messages).toHaveLength(3);
    expect(ctx.messages[0].role).toBe('assistant');
    expect(ctx.messages[1].role).toBe('toolResult');
    expect(ctx.messages[2].role).toBe('toolResult');
    if (ctx.messages[1].role === 'toolResult' && ctx.messages[2].role === 'toolResult') {
      expect(ctx.messages[1].toolCallId).toBe('t1');
      expect(ctx.messages[2].toolCallId).toBe('t2');
    }
  });

  it('empty messages array returns a valid path even though file is not yet on disk (lazy flush)', async () => {
    const sessionFile = await engine.rehydrateFromMessages('sess-empty', [], tmpCwd);
    // Path is committed; bytes will land when the next assistant entry arrives.
    expect(sessionFile).toMatch(/\.pi\/sessions\/.+\.jsonl$/);
    // Caller will start a fresh PiEngine.run() — if file is missing,
    // preparePiResumeSession() returns undefined and Pi starts a clean session.
    // That's the correct behaviour for "rehydrate had nothing to carry over".
  });

  it('two consecutive rehydrates produce different sessionFiles (each creates a fresh session)', async () => {
    // Both messages end with an assistant entry so the file is flushed for the
    // existence check below.
    const m: RehydrateInputMessage[] = [
      { id: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: T0 },
      { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'hello' }], timestamp: T0 + 1 },
    ];

    const f1 = await engine.rehydrateFromMessages('sess-a', m, tmpCwd);
    const f2 = await engine.rehydrateFromMessages('sess-b', m, tmpCwd);

    expect(f1).not.toBe(f2);
    expect(fs.existsSync(f1)).toBe(true);
    expect(fs.existsSync(f2)).toBe(true);
  });

  it('cwd without .pi/sessions/ is auto-created (no ENOENT)', async () => {
    // tmpCwd is fresh — no .pi/ at all.
    expect(fs.existsSync(path.join(tmpCwd, '.pi'))).toBe(false);

    await expect(
      engine.rehydrateFromMessages('sess-x', [], tmpCwd)
    ).resolves.toBeTruthy();

    expect(fs.existsSync(path.join(tmpCwd, '.pi', 'sessions'))).toBe(true);
  });

  it('Korean text and tool arguments survive the file round-trip byte-for-byte', async () => {
    const messages: RehydrateInputMessage[] = [
      { id: 'u-1', role: 'user', content: [{ type: 'text', text: '한국어 메시지 — 특수 문자 ✨ 포함' }], timestamp: T0 },
      {
        id: 'a-1', role: 'assistant',
        content: [
          { type: 'text', text: '답변입니다 🎯' },
          { type: 'tool_use', id: 'toolu_kor', name: 'Bash', input: { command: 'echo "한글"' } },
        ],
        timestamp: T0 + 1,
      },
    ];

    const sessionFile = await engine.rehydrateFromMessages('sess-kor', messages, tmpCwd);
    const reopened = SessionManager.open(sessionFile, path.join(tmpCwd, '.pi', 'sessions'));
    const ctx = reopened.buildSessionContext();

    if (ctx.messages[0].role === 'user' && Array.isArray(ctx.messages[0].content)) {
      expect((ctx.messages[0].content[0] as any).text).toBe('한국어 메시지 — 특수 문자 ✨ 포함');
    }
    if (ctx.messages[1].role === 'assistant') {
      const tc = ctx.messages[1].content.find((c: any) => c.type === 'toolCall') as any;
      expect(tc.arguments).toEqual({ command: 'echo "한글"' });
    }
  });
});
