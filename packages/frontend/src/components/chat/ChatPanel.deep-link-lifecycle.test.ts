// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import ts from 'typescript';
const source = fs.readFileSync('packages/frontend/src/components/chat/ChatPanel.tsx', 'utf8');
const begin = source.indexOf('  useEffect(() => {\n    let disposed = false;');
const end = source.indexOf('  // ─── /Phase 3', begin);
const effect = source.slice(begin, end);

function setup(hash = '#m-abcdefgh') {
  let cleanup = () => {};
  let sequence = 0;
  let active = 'A';
  const scheduled = new Map<number, () => void>();
  const captured: (() => void)[] = [];
  const schedule = (cb: () => void) => { const id = ++sequence; const run = () => { scheduled.delete(id); cb(); }; scheduled.set(id, run); captured.push(run); return id; };
  const scrollToIndex = vi.fn();
  const messages = Array.from({ length: 60 }, (_, index) => ({ id: `m${index}`, shortId: index === 20 ? 'abcdefgh' : `${index}` }));
  const env = {
    useEffect: (run: () => () => void) => { cleanup = run(); },
    window: { location: { hash }, addEventListener: vi.fn(), removeEventListener: vi.fn(), clearTimeout: vi.fn(), setTimeout: schedule },
    renderSessionLoading: false, isChatForeground: true, messageAnchorHash: hash, viewportVisitRef: { current: 1 }, activeSessionId: 'A', deepLinkTargetReady: true, anchorProcessedRef: { current: null as string | null },
    scrollInteractionGeneration: { current: 0 }, restoreLatest: { current: { mergedMessages: messages } },
    userScrolledUp: { current: false }, isAtBottom: { current: true }, conversationViewport: { onRestoreAnchorStart: vi.fn() },
    settleUntil: { current: 0 }, switchSettleUntil: { current: 0 }, scrollWrapRef: { current: null },
    anchorHighlightTimerRef: { current: null }, PLAIN_MESSAGE_LIMIT: 40, virtuosoRef: { current: { scrollToIndex } },
    useSessionStore: { getState: () => ({ activeSessionId: active }) },
    requestAnimationFrame: schedule, setTimeout: schedule,
    cancelAnimationFrame: (id: number) => scheduled.delete(id), clearTimeout: (id: number) => scheduled.delete(id),
  };
  const run = () => new Function(...Object.keys(env), ts.transpile(effect, { target: ts.ScriptTarget.ES2022 }))(...Object.values(env));
  run();
  return { env, run, scrollToIndex, scheduled, captured, cleanup: () => cleanup(), switchSession: () => { active = 'B'; } };
}

describe('ChatPanel deep-link task lifetime', () => {
  it('starts a loaded message link from hash state without a competing hashchange writer', () => {
    const h = setup(''); expect(h.scheduled.size).toBe(0);
    expect(h.env.window.addEventListener).not.toHaveBeenCalled();
    h.cleanup(); h.env.window.location.hash = '#m-abcdefgh'; h.env.messageAnchorHash = '#m-abcdefgh';
    h.run(); expect(h.scheduled.size).toBe(5); h.captured[0]();
    expect(h.scrollToIndex).toHaveBeenCalledWith({ index: 20, align: 'start', behavior: 'auto' }); h.cleanup();
  });
  it('waits for the cold-open loading skeleton to leave before claiming the anchor', () => {
    const h = setup(''); h.cleanup();
    h.env.window.location.hash = '#m-abcdefgh';
    h.env.renderSessionLoading = true;
    h.run(); expect(h.scheduled.size).toBe(0);
    expect(h.env.anchorProcessedRef.current).toBeNull();
    h.cleanup(); h.env.renderSessionLoading = false;
    h.run(); for (const callback of [...h.scheduled.values()]) callback();
    expect(h.scrollToIndex).toHaveBeenCalledWith({ index: 20, align: 'start', behavior: 'auto' });
    h.cleanup();
  });
  it('releases a cancelled request when the viewport becomes foreground', () => {
    const h = setup(); h.cleanup();
    expect(h.env.anchorProcessedRef.current).toBeNull();
    h.env.isChatForeground = false; h.run();
    expect(h.scheduled.size).toBe(0);
    h.cleanup(); h.env.isChatForeground = true; h.run();
    expect(h.scheduled.size).toBe(5); h.cleanup();
  });
  it('cancels all scheduled retries and fences even already-delivered callbacks', () => {
    const h = setup(); expect(h.scheduled.size).toBe(5);
    h.cleanup(); h.switchSession(); h.env.window.location.hash = '';
    expect(h.scheduled.size).toBe(0);
    h.captured.forEach(cb => cb()); expect(h.scrollToIndex).not.toHaveBeenCalled();
  });
  it('does not revive a user-cancelled link on same-session message refresh', () => {
    const h = setup(); h.env.scrollInteractionGeneration.current++;
    h.captured.forEach(cb => cb()); expect(h.scrollToIndex).not.toHaveBeenCalled();
    h.cleanup(); h.env.restoreLatest.current.mergedMessages = [...h.env.restoreLatest.current.mergedMessages];
    h.run(); expect(h.scheduled.size).toBe(0); expect(h.scrollToIndex).not.toHaveBeenCalled();
  });
  it('resolves the same message ID after prepend rather than reusing its old index', () => {
    const h = setup(); h.env.restoreLatest.current.mergedMessages = [{ id: 'new', shortId: 'new' }, ...h.env.restoreLatest.current.mergedMessages];
    h.captured[0](); expect(h.scrollToIndex).toHaveBeenCalledWith({ index: 21, align: 'start', behavior: 'auto' }); h.cleanup();
  });
  it('honors latest/history interaction generation before any pending scroll write', () => {
    const h = setup(); h.env.scrollInteractionGeneration.current++;
    h.captured[0](); expect(h.scrollToIndex).not.toHaveBeenCalled(); h.cleanup();
  });
});
