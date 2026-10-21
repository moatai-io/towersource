// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultBindings, useShortcutStore } from '../../stores/shortcut-store';
import { ShortcutSettings } from './ShortcutSettings';

const locale = vi.hoisted(() => ({ language: 'ko' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { language: locale.language, resolvedLanguage: locale.language } }),
}));

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('userId', 'shortcut-settings-test');
  locale.language = 'ko';
  useShortcutStore.setState({ bindings: { ...defaultBindings } });
});
afterEach(cleanup);

const voiceInput = () => screen.getByRole('textbox', { name: /음성 입력 시작·종료/ });

function record(target: HTMLElement, key: string, modifiers: Record<string, boolean> = {}) {
  fireEvent.focus(target);
  fireEvent.keyDown(target, { key, ...modifiers });
}

describe('ShortcutSettings', () => {
  it('shows current shortcuts and explains browser-local per-user storage', () => {
    render(<ShortcutSettings />);
    expect((voiceInput() as HTMLInputElement).readOnly).toBe(true);
    expect(voiceInput().closest('[data-shortcut-settings]')).toBeTruthy();
    expect(screen.getByText('이 브라우저에서 로그인한 사용자별로 저장됩니다.')).toBeTruthy();
    expect((voiceInput() as HTMLInputElement).value).toContain('V');
  });

  it('records and persists a key without triggering document shortcuts', () => {
    const globalHandler = vi.fn();
    document.addEventListener('keydown', globalHandler);
    try {
      render(<ShortcutSettings />);
      fireEvent.focus(voiceInput());
      const event = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
      fireEvent(voiceInput(), event);
      expect(event.defaultPrevented).toBe(true);
      expect(globalHandler).not.toHaveBeenCalled();
      expect(useShortcutStore.getState().bindings['voice.toggle']).toBe('Mod+Shift+K');
      expect(JSON.parse(localStorage.getItem('tower-shortcuts:shortcut-settings-test')!)['voice.toggle']).toBe('Mod+Shift+K');
    } finally {
      document.removeEventListener('keydown', globalHandler);
    }
  });

  it('cancels with Escape without changing the binding', () => {
    render(<ShortcutSettings />);
    record(voiceInput(), 'Escape');
    expect(useShortcutStore.getState().bindings['voice.toggle']).toBe(defaultBindings['voice.toggle']);
    expect((voiceInput() as HTMLInputElement).value).not.toContain('누르세요');
  });

  it.each(['Backspace', 'Delete'])('disables a binding with %s', (key) => {
    render(<ShortcutSettings />);
    record(voiceInput(), key);
    expect(useShortcutStore.getState().bindings['voice.toggle']).toBe('');
    expect((voiceInput() as HTMLInputElement).value).toBe('사용 안 함');
  });

  it('keeps recording on modifier-only, composing and repeated events', () => {
    render(<ShortcutSettings />);
    record(voiceInput(), 'Control', { ctrlKey: true });
    fireEvent.keyDown(voiceInput(), { key: 'k', ctrlKey: true, isComposing: true });
    fireEvent.keyDown(voiceInput(), { key: 'k', ctrlKey: true, repeat: true });
    expect(useShortcutStore.getState().bindings['voice.toggle']).toBe(defaultBindings['voice.toggle']);
    expect((voiceInput() as HTMLInputElement).value).toContain('누르세요');
  });

  it('announces duplicate and reserved-key errors and allows retry', () => {
    render(<ShortcutSettings />);
    record(voiceInput(), 'ArrowUp', { altKey: true, shiftKey: true });
    expect(screen.getByRole('alert').textContent).toContain('이미 지정');
    expect(voiceInput().getAttribute('aria-invalid')).toBe('true');
    expect(voiceInput().getAttribute('aria-describedby')).toContain(screen.getByRole('alert').id);
    fireEvent.keyDown(voiceInput(), { key: 't', ctrlKey: true });
    expect(screen.getByRole('alert').textContent).toContain('브라우저');
    expect(useShortcutStore.getState().bindings['voice.toggle']).toBe(defaultBindings['voice.toggle']);
    fireEvent.keyDown(voiceInput(), { key: 'k', ctrlKey: true, shiftKey: true });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(useShortcutStore.getState().bindings['voice.toggle']).toBe('Mod+Shift+K');
  });

  it('restores an individual binding and all bindings', () => {
    render(<ShortcutSettings />);
    record(voiceInput(), 'k', { ctrlKey: true, shiftKey: true });
    fireEvent.click(screen.getByRole('button', { name: '음성 입력 시작·종료 기본값 복원' }));
    expect(useShortcutStore.getState().bindings['voice.toggle']).toBe(defaultBindings['voice.toggle']);
    record(voiceInput(), 'Delete');
    record(screen.getByRole('textbox', { name: /이전 세션/ }), 'k', { altKey: true });
    fireEvent.click(screen.getByRole('button', { name: '전체 기본값 복원' }));
    expect(useShortcutStore.getState().bindings).toEqual(defaultBindings);
  });

  it('renders English labels, help and accessible errors', () => {
    locale.language = 'en';
    render(<ShortcutSettings />);
    expect(screen.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeTruthy();
    expect(screen.getByText('Saved per signed-in user in this browser.')).toBeTruthy();
    const input = screen.getByRole('textbox', { name: /Start \/ stop voice input/ });
    record(input, 't', { ctrlKey: true });
    expect(screen.getByRole('alert').textContent).toBe('This key is reserved for typing or browser actions.');
    expect(screen.getByRole('button', { name: 'Reset all shortcuts' })).toBeTruthy();
  });
});
