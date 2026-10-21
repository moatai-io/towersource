// @vitest-environment jsdom
import React, { useEffect } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import ts from 'typescript';
const source = fs.readFileSync('packages/frontend/src/components/chat/ChatPanel.tsx', 'utf8');
const start = source.indexOf('  const hasMessagesForAttribution =');
const end = source.indexOf('  // Auto-resume banner', start);
const js = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 });
afterEach(() => vi.unstubAllGlobals());
it('keeps a pending response across message growth and rejects old-session responses', async () => {
  const pending: ((v: any) => void)[] = [];
  const fetchMock = vi.fn(() => new Promise(resolve => pending.push(resolve)));
  vi.stubGlobal('fetch', fetchMock);
  const setState = vi.fn();
  const run = new Function('useEffect', 'messages', 'activeSessionId', 'sessionMismatch', 'useChatStore', js);
  function Harness({ session, count }: { session: string; count: number }) {
    run(useEffect, Array(count), session, false, { setState });
    return null;
  }
  const view = render(<Harness session="a" count={1} />);
  view.rerender(<Harness session="a" count={2} />);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const response = { ok: true, json: async () => [{ id: 'u', role: 'user', username: 'owner' }] };
  await act(async () => { pending[0](response); });
  expect(setState).toHaveBeenCalledTimes(1);
  view.rerender(<Harness session="b" count={1} />);
  view.rerender(<Harness session="c" count={1} />);
  await act(async () => { pending[1](response); });
  expect(setState).toHaveBeenCalledTimes(1);
  await act(async () => { pending[2](response); });
  expect(setState).toHaveBeenCalledTimes(2);
  view.unmount();
});

it('StrictMode ignores disposed requests and applies only the surviving mount', async () => {
  const pending: ((v: any) => void)[] = [];
  vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => pending.push(resolve))));
  const setState = vi.fn();
  const run = new Function('useEffect', 'messages', 'activeSessionId', 'sessionMismatch', 'useChatStore', js);
  function Harness() {
    run(useEffect, [{}], 'a', false, { setState });
    return null;
  }
  const view = render(<React.StrictMode><Harness /></React.StrictMode>);
  expect(pending).toHaveLength(2);
  const response = { ok: true, json: async () => [{ id: 'u', role: 'user', username: 'owner' }] };
  await act(async () => { pending[0](response); });
  expect(setState).not.toHaveBeenCalled();
  await act(async () => { pending[1](response); });
  expect(setState).toHaveBeenCalledTimes(1);
  const apply = setState.mock.calls[0][0];
  expect(apply({ sessionId: 'other', messages: [] })).toEqual({ sessionId: 'other', messages: [] });
  expect(apply({ sessionId: 'a', messages: [{ id: 'u', role: 'user', username: 'old' }] })).toEqual({ messages: [{ id: 'u', role: 'user', username: 'owner' }] });
  view.unmount();
});
