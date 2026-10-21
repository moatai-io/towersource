// @vitest-environment jsdom
import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import ts from 'typescript';
import { useMessageAnchorHistory } from '../../features/conversation-viewport/useMessageAnchorHistory';
import { useConversationViewport } from '../../features/conversation-viewport/useConversationViewport';

// Exercise the production effect, not a second implementation of its policy.
const source = fs.readFileSync('packages/frontend/src/components/chat/ChatPanel.tsx', 'utf8');
const start = source.indexOf('  const bottomSettledSessionRef =');
const end = source.indexOf('  useEffect(() => {\n    const scroller = scrollWrapRef.current?.querySelector<HTMLElement>', start);
const body = source.slice(start, end);

afterEach(() => vi.unstubAllGlobals());

describe('ChatPanel restoration effect lifecycle', () => {
  for (const kind of ['bottom', 'anchor']) {
    it(`${kind}: retains work across same-count refresh; disposes on session switch/unmount`, () => {
      let next = 0;
      const frames = new Map<number, FrameRequestCallback>();
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++next, cb); return next; });
      vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
      let currentSession = 'A';
      let refs: Record<string, any>;
      const pin = vi.fn(() => Date.now());
      function Harness({ sessionId, messages }: { sessionId: string; messages: { id: string }[] }) {
        const conversationViewport = useConversationViewport({ activeSessionId: sessionId, messageCount: messages.length });
        const viewportVisitRef = useRef(0);
        const restoreInProgressRef = useRef(false);
        const restoredSessionRef = useRef(null);
        const restoreAttemptRef = useRef(0);
        const userScrolledUp = useRef(false);
        const isAtBottom = useRef(true);
        const settleUntil = useRef(0);
        const switchSettleUntil = useRef(0);
        const settleRafRef = useRef(0);
        const scrollInteractionGeneration = useRef(0);
        const scrollWrapRef = useRef(null);
        const virtuosoRef = useRef(null);
        const scrollToBottom = useCallback(() => {}, []);
        const startSettleLoop = useCallback(() => { settleRafRef.current = requestAnimationFrame(() => {}); }, []);
        const updateVisibleRangeFromDom = useCallback(() => {}, []);
        const env = { useRef, useEffect, useLayoutEffect, activeSessionId: sessionId, isChatForeground: true, mergedMessages: messages,
          sessionRestorePlan: kind === 'anchor' && sessionId === 'A' ? { kind, anchorIndex: 0, snapshot: { anchorMessageId: 'm1', anchorOffsetPx: 0 } } : { kind: 'bottom', reason: 'snapshot-bottom' },
          renderSessionLoading: false, onLoadMore: undefined, useMessageAnchorHistory, messageAnchorHash: '', hasExplicitMessageAnchor: false, viewportVisitRef, conversationViewport, restoreInProgressRef, restoredSessionRef, restoreAttemptRef,
          userScrolledUp, isAtBottom, settleUntil, switchSettleUntil, settleRafRef, scrollInteractionGeneration, scrollWrapRef, virtuosoRef,
          markPinnedToBottom: pin, scrollToBottom, startSettleLoop, updateVisibleRangeFromDom, setShowJumpToLatest: () => {},
          PLAIN_MESSAGE_LIMIT: 40, RESTORE_ANCHOR_SETTLE_MAX_MS: 2400, RESTORE_ANCHOR_STABLE_FRAMES: 4,
          traceChatScroll: () => {}, useSessionStore: { getState: () => ({ activeSessionId: currentSession }) } };
        new Function(...Object.keys(env), ts.transpile(body, { target: ts.ScriptTarget.ES2022 }))(...Object.values(env));
        refs = { restoreInProgressRef, settleRafRef };
        return null;
      }
      const view = render(<Harness sessionId="A" messages={[{ id: 'm1' }]} />);
      const initial = [...frames.keys()];
      expect(initial.length).toBeGreaterThan(0);
      view.rerender(<Harness sessionId="A" messages={[{ id: 'm1' }]} />);
      expect([...frames.keys()]).toEqual(initial);
      act(() => { currentSession = 'B'; });
      view.rerender(<Harness sessionId="B" messages={[{ id: 'b1' }]} />);
      expect(refs!.restoreInProgressRef.current).toBe(false);
      expect([...frames.keys()].some(id => initial.includes(id))).toBe(false);
      expect(frames.size).toBeGreaterThan(0);
      view.unmount();
      expect(frames.size).toBe(0);
      expect(refs!.settleRafRef.current).toBe(0);
    });
  }
});
