/**
 * Pi engine — watchdog abort persists the Korean reason to messages DB.
 *
 * Bug pattern: prior to this fix, watchdog aborts (idle / thinking-stuck /
 * text-stuck / toolcall-stuck) only pushed an `engine_error` event onto the
 * eventQueue. The ws-handler forwards that to the client as a transient
 * 'resume_failed' notification, but nothing ever lands in the `messages`
 * table — so once the user reloads the session or another viewer opens it,
 * they have *no record* of why the turn ended. The session looks like an
 * unexplained silent stop.
 *
 * Acceptance: for every watchdog StuckReason, pi-engine.ts MUST also call
 * `callbacks.saveMessage(...)` with the Korean reason text so the DB row
 * survives reloads and surfaces the abort cause in history.
 *
 * Tier:
 *   - Source-contract tests (regex over pi-engine.ts) following the
 *     pi-engine.test.ts pattern: cheap, catch refactors that delete the
 *     persist call.
 *
 * Refs:
 *   - workspace/decisions/2026-05-26-pi-sdk-upgrade-policy.md (결정 3, Test 2)
 *   - incident session 474d2679-033f-45d0-918e-52fbc67b9975 (idle 602s)
 *   - GitHub issue #22
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const PI_ENGINE_PATH = path.resolve(import.meta.dirname, '../pi-engine.ts');
const SRC = fs.readFileSync(PI_ENGINE_PATH, 'utf-8');

// Slice covering both watchdog-handling branches (.then / .catch). We keep
// the slice tight so other unrelated saveMessage calls in the file (e.g. the
// assistant-content path at L1132, the silent-exit branch at L1462) don't
// leak into the regex and produce false positives.
function extractWatchdogBlocks(src: string): string {
  // The watchdog persistence now lives in the shared `surfaceWatchdogAbort`
  // helper, while both prompt resolution/rejection branches call that helper.
  // Slice from the helper through the prompt finally cleanup so refactors that
  // drop either the persistence or either call site are caught.
  const start = src.indexOf('const surfaceWatchdogAbort = async () => {');
  expect(start, 'pi-engine.ts must contain a watchdog handling block').toBeGreaterThan(-1);
  const end = src.indexOf('promptSettled = true;', start);
  expect(end, 'pi-engine.ts watchdog handling must precede the prompt finally cleanup').toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('Pi engine — watchdog reason persistence', () => {
  it('still surfaces engine_error so the user sees the abort live', () => {
    // Sanity guard: we are *adding* DB persistence on top of the existing
    // engine_error event, not replacing it.
    const blocks = extractWatchdogBlocks(SRC);
    expect(blocks).toMatch(/type:\s*'engine_error'/);
    expect(blocks).toMatch(/Pi 스트림 watchdog/);
  });

  it('persists the Korean reason via callbacks.saveMessage or updateMessageContent in the shared watchdog helper', () => {
    const blocks = extractWatchdogBlocks(SRC);
    const helperStart = blocks.indexOf('const surfaceWatchdogAbort');
    const helperEnd = blocks.indexOf('const surfaceTransientAbortFailure', helperStart);
    expect(helperEnd).toBeGreaterThan(helperStart);
    const helperBlock = blocks.slice(helperStart, helperEnd);
    expect(helperBlock).toMatch(/callbacks\.saveMessage\s*\(/);
    expect(helperBlock).toMatch(/callbacks\.updateMessageContent\s*\(/);
    expect(helperBlock).toMatch(/Pi 스트림 watchdog/);
  });

  it('calls the watchdog persistence helper from both resolved and rejected prompt branches', () => {
    const blocks = extractWatchdogBlocks(SRC);
    const thenBranch = blocks.match(/if \(watchdogAborted\) \{[\s\S]*?await surfaceWatchdogAbort\(\);[\s\S]*?await emitTurnDone\('error'\);[\s\S]*?return;/);
    expect(thenBranch, 'resolved prompt branch must surface and persist watchdog abort').toBeTruthy();
    const catchBranch = blocks.match(/catch \(err: any\) \{[\s\S]*?if \(watchdogAborted\) \{[\s\S]*?await surfaceWatchdogAbort\(\);/);
    expect(catchBranch, 'rejected prompt branch must surface and persist watchdog abort').toBeTruthy();
  });

  it('reuses formatWatchdogReason output (covers all 4 StuckReason variants)', () => {
    // formatWatchdogReason is the single source of truth for the four Korean
    // strings (idle / thinking-stuck / text-stuck / toolcall-stuck). The
    // persistence call must feed from it, not duplicate strings, otherwise
    // any future reason added to the switch wouldn't reach the DB.
    const blocks = extractWatchdogBlocks(SRC);
    // The shared helper computes the formatted reason once and feeds both the
    // live engine_error event and the persisted saveMessage payload from it.
    const reasonAssign = blocks.match(/const reason = formatWatchdogReason\(/g) || [];
    expect(reasonAssign.length, 'watchdog helper should compute `reason` exactly once').toBe(1);
    expect(blocks).toMatch(/eventQueue\.push[\s\S]*\$\{reason\}/);
    expect(blocks).toMatch(/watchdogNote[\s\S]*\$\{reason\}/);
    expect(blocks).toMatch(/saveMessage[\s\S]*watchdogNote/);
    expect(blocks).toMatch(/updateMessageContent[\s\S]*contentWithReason/);
  });

  it('saves the message with role=assistant + a text content block (SavedMessage contract)', () => {
    // SavedMessage.role is 'user' | 'assistant' (see engines/types.ts). The
    // silent-exit branch at L1462 already established the precedent of using
    // role=assistant for engine-internal error notes so the bubble renders in
    // the chat thread the same as a normal assistant reply. The watchdog
    // persistence must follow the same shape, otherwise the frontend's
    // message renderer can't display it.
    const blocks = extractWatchdogBlocks(SRC);
    // Both branches use the same shape, so we check on the combined slice.
    expect(blocks).toMatch(/role:\s*'assistant'/);
    // Content shape: at least one text block carrying the Korean reason.
    expect(blocks).toMatch(/type:\s*'text'/);
  });

  it('stamps watchdog metadata so downstream queries can filter abort rows', () => {
    // The DB row needs to be machine-distinguishable from a normal assistant
    // reply. The content block carries watchdogReason whether the helper creates
    // a fresh assistant row or appends to an already-saved partial row.
    const blocks = extractWatchdogBlocks(SRC);
    expect(blocks).toMatch(/watchdogReason/);
    expect(blocks).toMatch(/contentWithReason/);
  });
});
