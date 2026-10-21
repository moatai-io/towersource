// @vitest-environment jsdom
import { renderHook, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSessionShortcuts } from './useSessionShortcuts';
import { useShortcutStore } from '../stores/shortcut-store';
beforeEach(() => useShortcutStore.getState().reset());
afterEach(cleanup);
const sessions = [{ id: 'first' }, { id: 'second' }, { id: 'third' }];
it('selects adjacent sessions in filtered order and does not wrap', () => {
  const select = vi.fn();
  const { rerender } = renderHook(({ id }) => useSessionShortcuts(sessions, id, select), { initialProps: { id: 'second' } });
  fireEvent.keyDown(window, { key: 'ArrowUp', altKey: true, shiftKey: true });
  expect(select).toHaveBeenLastCalledWith(sessions[0]);
  fireEvent.keyDown(window, { key: 'ArrowDown', altKey: true, shiftKey: true });
  expect(select).toHaveBeenLastCalledWith(sessions[2]);
  select.mockClear(); rerender({ id: 'first' });
  fireEvent.keyDown(window, { key: 'ArrowUp', altKey: true, shiftKey: true });
  fireEvent.keyDown(window, { key: 'ArrowDown' });
  expect(select).not.toHaveBeenCalled();
});
it('protects IME, repeats and modal/settings interaction', () => {
  const select = vi.fn(); renderHook(() => useSessionShortcuts(sessions, 'first', select));
  const event = { key: 'ArrowDown', altKey: true, shiftKey: true };
  fireEvent.keyDown(window, { ...event, isComposing: true });
  fireEvent.keyDown(window, { ...event, repeat: true });
  const modal = document.createElement('div'); modal.setAttribute('aria-modal', 'true'); document.body.append(modal);
  fireEvent.keyDown(window, event); modal.remove();
  expect(select).not.toHaveBeenCalled();
});
it('uses customized keys', () => {
  useShortcutStore.getState().setBinding('session.next', 'Mod+Shift+J');
  const select = vi.fn(); renderHook(() => useSessionShortcuts(sessions, 'first', select));
  fireEvent.keyDown(window, { key: 'J', ctrlKey: true, shiftKey: true });
  expect(select).toHaveBeenCalledWith(sessions[1]);
});
