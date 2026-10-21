// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultBindings, matchesShortcut, serializeShortcut, useShortcutStore } from './shortcut-store';
beforeEach(() => { localStorage.clear(); localStorage.setItem('userId', 'alice'); useShortcutStore.getState().reset(); });
describe('personal shortcuts', () => {
  it('matches modifiers exactly and ignores repeat/composition/default handling', () => {
    const event = (extra = {}) => new KeyboardEvent('keydown', { key: 'M', ctrlKey: true, shiftKey: true, ...extra });
    expect(matchesShortcut(event(), 'Mod+Shift+M')).toBe(true);
    expect(matchesShortcut(event({ ctrlKey: false, metaKey: true }), 'Mod+Shift+M')).toBe(true);
    expect(matchesShortcut(event({ altKey: true }), 'Mod+Shift+M')).toBe(false);
    expect(matchesShortcut(event({ repeat: true }), 'Mod+Shift+M')).toBe(false);
    expect(matchesShortcut(event({ isComposing: true }), 'Mod+Shift+M')).toBe(false);
    expect(serializeShortcut(event())).toBe('Mod+Shift+M');
  });
  it('saves per user, reloads, and restores defaults', () => {
    const store = useShortcutStore.getState();
    expect(store.setBinding('voice.toggle', 'Mod+Shift+Y')).toBeNull();
    localStorage.setItem('userId', 'bob'); store.reload();
    expect(useShortcutStore.getState().bindings['voice.toggle']).toBe(defaultBindings['voice.toggle']);
    localStorage.setItem('userId', 'alice'); store.reload();
    expect(useShortcutStore.getState().bindings['voice.toggle']).toBe('Mod+Shift+Y');
    store.reset('voice.toggle');
    expect(useShortcutStore.getState().bindings['voice.toggle']).toBe('Alt+V');
  });
  it('rejects conflicting, reserved and unmodified global typing keys', () => {
    const store = useShortcutStore.getState();
    expect(store.setBinding('voice.toggle', 'Mod+S')).toBeTruthy();
    expect(store.setBinding('voice.toggle', 'Alt+ArrowUp')).toBeTruthy();
    expect(store.setBinding('voice.toggle', 'M')).toBeTruthy();
    expect(store.setBinding('voice.toggle', '')).toBeNull();
  });
  it('restores a default without leaving duplicate bindings', () => {
    const store = useShortcutStore.getState();
    store.setBinding('voice.toggle', '');
    store.setBinding('session.next', 'Alt+V');
    store.reset('voice.toggle');
    expect(useShortcutStore.getState().bindings['session.next']).toBe('');
    store.reset(); expect(useShortcutStore.getState().bindings).toEqual(defaultBindings);
  });
});

it('matches macOS Option special characters and blocks the Chrome profile key', () => {
  expect(matchesShortcut(new KeyboardEvent('keydown', { key: '√', code: 'KeyV', altKey: true }), 'Alt+V')).toBe(true);
  expect(useShortcutStore.getState().setBinding('voice.toggle', 'Mod+Shift+M')).toBeTruthy();
});
it('migrates the obsolete voice binding without changing other choices', () => {
  localStorage.setItem('tower-shortcuts:alice', JSON.stringify({ 'voice.toggle': 'Mod+Shift+M', 'session.next': 'Mod+Shift+J' }));
  useShortcutStore.getState().reload();
  expect(useShortcutStore.getState().bindings['voice.toggle']).toBe('Alt+V');
  expect(useShortcutStore.getState().bindings['session.next']).toBe('Mod+Shift+J');
});
