// @vitest-environment node
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const CHAT_PANEL_PATH = path.resolve(__dirname, 'ChatPanel.tsx');
const APP_PATH = path.resolve(__dirname, '../../App.tsx');

describe('ChatPanel scroll source guards', () => {
  it('runs the session-bottom settle once per loaded session, not on every message-count change', () => {
    const src = fs.readFileSync(CHAT_PANEL_PATH, 'utf-8');

    expect(src).toContain('bottomSettledSessionRef');
    expect(src).toContain('scroll-lock shape reported in #120');
    expect(src).toMatch(/if \(bottomSettledSessionRef\.current === activeSessionId\) return;/);
    expect(src).toMatch(/bottomSettledSessionRef\.current = activeSessionId;/);
  });

  it('uses real viewport DOM measurement for user-message navigation instead of Virtuoso overscan range', () => {
    const src = fs.readFileSync(CHAT_PANEL_PATH, 'utf-8');

    expect(src).toContain('updateVisibleRangeFromDom');
    expect(src).toContain("querySelectorAll('[data-msg-index]')");
    expect(src).toContain('Virtuoso\'s rangeChanged reports the rendered/overscanned range');
    expect(src).toMatch(/itemContent=\{\(index\) => \(/);
    expect(src).toMatch(/<div data-msg-index=\{index\} data-msg-id=\{mergedMessages\[index\]\?\.id\} className="min-w-0 max-w-full overflow-x-hidden">/);
    expect(src).toMatch(/updateVisibleRangeFromDom\(\{ startIndex, endIndex \}\);/);
  });

  it('keeps a larger top overhang so fast upward history scrolling does not expose blank rows', () => {
    const src = fs.readFileSync(CHAT_PANEL_PATH, 'utf-8');

    expect(src).toContain('VIRTUOSO_VIEWPORT_OVERHANG');
    expect(src).toContain('top: 5000');
    expect(src).toContain('increaseViewportBy={VIRTUOSO_VIEWPORT_OVERHANG}');
  });

  it('does not force GPU transforms or overscan state updates on every mobile scroll tick', () => {
    const src = fs.readFileSync(CHAT_PANEL_PATH, 'utf-8');

    expect(src).not.toContain("transform: 'translateZ(0)'");
    expect(src).not.toContain("willChange: 'transform'");
    expect(src).toContain("rangeChanged includes overscan, so don't push it into React");
  });

  it('refreshes user-message navigation state after initial bottom settle and explicit jumps', () => {
    const src = fs.readFileSync(CHAT_PANEL_PATH, 'utf-8');

    expect(src).toContain('updateVisibleRangeFromDom({ startIndex: index, endIndex: index })');
    expect(src).toContain('const last = Math.max(0, mergedMessages.length - 1);');
    expect(src).toContain('updateVisibleRangeFromDom({ startIndex: last, endIndex: last });');
  });

  it('routes both Virtuoso and PlainMessageList scroll intent through conversation viewport state', () => {
    const src = fs.readFileSync(CHAT_PANEL_PATH, 'utf-8');

    expect(src).toContain('useChatScrollController');
    expect(src).toContain('conversationViewport.shouldAutoFollow()');
    expect(src).toContain('onViewportScroll={conversationViewport.onUserScroll}');
    expect(src).toContain('markUserReadingHistory,');
    expect(src).toContain("markPinnedToBottom('jump-latest')");
  });

  it('centralizes history-reading intent before future ref removal', () => {
    const src = fs.readFileSync(CHAT_PANEL_PATH, 'utf-8');

    expect(src).toContain('markUserReadingHistory,');
    expect(src).toContain('const markHistoryReadingIntent = useCallback');
    expect(src).toContain("markHistoryReadingIntent('jump')");
    expect(src).toContain("markHistoryReadingIntent('scroll')");
  });

  it('does not re-arm bottom following while a streaming upward-read lock is active', () => {
    const src = fs.readFileSync(CHAT_PANEL_PATH, 'utf-8');

    expect(src).toContain('USER_SCROLL_UP_REARM_GRACE_MS');
    expect(src).toContain('bottomRearmSuppressedUntil');
    expect(src).toContain('streamingHistoryReadLock');
    expect(src).toContain('if (isStreaming) streamingHistoryReadLock.current = true;');
    expect(src).toContain('const isWithinUserScrollUpGesture = userScrolledUp.current && atBottom && now < bottomRearmSuppressedUntil.current;');
    expect(src).toContain('const isStreamingHistoryReadLocked = userScrolledUp.current && atBottom && isStreaming && streamingHistoryReadLock.current;');
    expect(src).toContain('if (metrics && (userScrolledUp.current || (atBottom && metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < 80)) && !isWithinUserScrollUpGesture && !isStreamingHistoryReadLocked) conversationViewport.onUserScroll(metrics);');
    expect(src).toContain('if (now < bottomRearmSuppressedUntil.current || (isStreaming && streamingHistoryReadLock.current))');
    expect(src).toContain('streamingHistoryReadLock.current = false;');
  });

  it('claims PlainMessageList history intent before its streaming interval can tug the viewport', () => {
    const src = fs.readFileSync(CHAT_PANEL_PATH, 'utf-8');

    expect(src).toContain('const markPlainHistoryReadingIntent = useCallback');
    expect(src).toContain('if (event.deltaY < 0) markPlainHistoryReadingIntent();');
    expect(src).toContain('if (y - plainTouchStartY.current > 24) markPlainHistoryReadingIntent();');
    expect(src).toContain('if (atBottom && userScrolledUpRef.current && !isStreaming)');
  });

  it('restores open-tab history by stable message anchor without Virtuoso full snapshots', () => {
    const src = fs.readFileSync(CHAT_PANEL_PATH, 'utf-8');

    expect(src).toContain('chooseSessionViewportRestorePlan');
    expect(src).toContain("sessionRestorePlan.kind === 'anchor'");
    expect(src).toContain('sessionRestorePlan.snapshot.anchorOffsetPx');
    expect(src).toContain('conversationViewport.onRestoreAnchorStart()');
    expect(src).toContain('conversationViewport.onRestoreAnchorEnd(metrics)');
    expect(src).not.toContain('restoreStateFrom=');
  });

  it('cancels stale A→B→A restore callbacks and keeps the anchor stable while rows finish measuring', () => {
    const src = fs.readFileSync(CHAT_PANEL_PATH, 'utf-8');

    expect(src).toContain('restoreAttemptRef');
    expect(src).toContain('restoreAttemptRef.current !== restoreAttempt');
    expect(src).toContain('RESTORE_ANCHOR_SETTLE_MAX_MS');
    expect(src).toContain('RESTORE_ANCHOR_STABLE_FRAMES');
    expect(src).toContain('const keepAnchorStable = () =>');
    expect(src).toContain('if (elapsed < 650) issueAnchorScroll();');
    expect(src).toContain('cancelAnimationFrame(innerRaf)');
    expect(src).toContain('cancelAnimationFrame(settleRaf)');
  });

  it('lets explicit message anchors and history readers block bottom writers', () => {
    const src = fs.readFileSync(CHAT_PANEL_PATH, 'utf-8');

    expect(src).toContain('if (hasExplicitMessageAnchor)');
    expect(src).toContain("() => !userScrolledUp.current && !restoreInProgressRef.current");
    expect(src).toContain('if (!userScrolledUp.current)');
  });

  it('offers a clickable fallback when automatic older-message loading does not fire', () => {
    const src = fs.readFileSync(CHAT_PANEL_PATH, 'utf-8');

    expect(src).toContain('onClick={() => { void handleStartReached(); }}');
    expect(src).toContain("{t('scrollForOlderMessages')}");
  });

  it('places explicit deep-link targets near the top and highlights the exact message', () => {
    const src = fs.readFileSync(CHAT_PANEL_PATH, 'utf-8');

    expect(src).toContain("scrollTop += targetRect.top - scrollerRect.top - 24");
    expect(src).toContain("scrollToIndex({ index: currentLinkIndex(), align: 'start', behavior: 'auto' })");
    expect(src).toContain("target.classList.add('ring-1', 'ring-primary-500/25', 'bg-primary-500/5', 'rounded-xl')");
    expect(src).toContain("target.setAttribute('data-deep-link-highlight', 'true')");
    expect(src).toContain("target.focus({ preventScroll: true })");
    expect(src).toContain("}, 1_500)");
    expect(src).not.toContain("scrollToIndex({ index: idx, align: 'center', behavior: 'auto' })");
  });

  it('centralizes bottom-pinning intent before future ref removal', () => {
    const src = fs.readFileSync(CHAT_PANEL_PATH, 'utf-8');

    expect(src).toContain('markPinnedToBottom,');
    expect(src).toContain("markPinnedToBottom('session')");
    expect(src).toContain("const restoreReady = mergedMessages.length > 0;");
    expect(src).toContain("markPinnedToBottom('jump-latest')");
  });

  it('captures synchronously before App clears the previous session on tab switch', () => {
    const src = fs.readFileSync(CHAT_PANEL_PATH, 'utf-8');
    const selection = fs.readFileSync(path.resolve(import.meta.dirname, '../../hooks/useSessionSelection.ts'), 'utf-8');

    expect(src).toContain("window.addEventListener('tower-capture-chat-viewport', captureActiveViewportBeforeSwitch)");
    expect(src).toContain('cancelAnimationFrame(visibleRangeRafRef.current)');
    expect(src).toContain('viewportCaptureTokenRef.current !== viewportCaptureToken');
    expect(src).toContain('useSessionStore.getState().activeSessionId !== activeSessionId');
    expect(src).toContain("traceChatScroll('snapshot-before-switch'");
    expect(selection).toContain("window.dispatchEvent(new CustomEvent('tower-capture-chat-viewport'))");
    expect(selection.indexOf("window.dispatchEvent(new CustomEvent('tower-capture-chat-viewport'))")).toBeLessThan(selection.indexOf('clearMessages();', selection.indexOf('const handleSelectSession')));
  });

  it('captures native Virtuoso scroll even when the rendered range does not change', () => {
    const src = fs.readFileSync(CHAT_PANEL_PATH, 'utf-8');

    expect(src).toContain("scroller.addEventListener('scroll', onScroll, { passive: true })");
    expect(src).toContain('updateVisibleRangeFromDom({ startIndex: topVisibleIndex, endIndex: bottomVisibleIndex })');
  });

  it('treats file and system tab detours as distinct chat viewport visits', () => {
    const src = fs.readFileSync(CHAT_PANEL_PATH, 'utf-8');

    expect(src).toContain('const isChatForeground = !!activeSessionId && visibleChatSessionId === activeSessionId;');
    expect(src).toContain("${isChatForeground ? 'foreground' : 'background'}");
    expect(src).toContain('if (!isChatForeground) return;');
    expect(src).toContain('return () => captureActiveViewportBeforeSwitch();');
    expect(src).toContain('useSessionStore.getState().visibleChatSessionId !== activeSessionId');
  });

  it('keeps the saved history anchor stable when the chat viewport is resized', () => {
    const src = fs.readFileSync(CHAT_PANEL_PATH, 'utf-8');

    expect(src).toContain('const observer = new ResizeObserver(() => {');
    expect(src).toContain('if (!userScrolledUp.current || restoreInProgressRef.current) return;');
    expect(src).toContain('snapshot.anchorMessageId');
    expect(src).toContain("traceChatScroll('layout-anchor-corrected'");
  });

  it('feeds Virtuoso atBottomStateChange scroller metrics into conversation viewport unless history reading still owns the viewport', () => {
    const src = fs.readFileSync(CHAT_PANEL_PATH, 'utf-8');

    expect(src).toContain('getCurrentScrollerMetrics,');
    expect(src).toContain('const metrics = getCurrentScrollerMetrics();');
    expect(src).toContain('if (metrics && (userScrolledUp.current || (atBottom && metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < 80)) && !isWithinUserScrollUpGesture && !isStreamingHistoryReadLocked) conversationViewport.onUserScroll(metrics);');
  });

  it('uses activeAssistantMessageId as the live assistant gate when available', () => {
    const src = fs.readFileSync(CHAT_PANEL_PATH, 'utf-8');

    expect(src).toMatch(/const isLatestAssistant =[\s\S]*activeAssistantMessageId[\s\S]*\? msg\.id === activeAssistantMessageId[\s\S]*: index === latestAssistantAfterLatestUserIndex/);
    expect(src).not.toMatch(/!!activeAssistantMessageId && msg\.id === activeAssistantMessageId\)[\s\S]*\|\| index === latestAssistantAfterLatestUserIndex/);
  });

  it('keeps flicker debug tracing opt-in and wired to high-risk scroll events', () => {
    const src = fs.readFileSync(CHAT_PANEL_PATH, 'utf-8');

    expect(src).toContain('traceChatScroll');
    expect(src).toContain("traceChatScroll('range-changed'");
    expect(src).toContain("traceChatScroll('at-bottom-change'");
    expect(src).toContain("traceChatScroll('visible-range-dom'");
    expect(src).toContain("traceChatScroll('scroll-generation'");
  });
});
