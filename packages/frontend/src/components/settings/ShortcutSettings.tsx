import { useId, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SHORTCUTS,
  formatShortcut,
  serializeShortcut,
  useShortcutStore,
} from '../../stores/shortcut-store';

type ShortcutId = (typeof SHORTCUTS)[number]['id'];

function englishLabel(id: string, fallback: string) {
  const labels: Record<string, string> = {
    'voice.toggle': 'Start / stop voice input',
    'session.previous': 'Previous session',
    'session.next': 'Next session',
    'chat.previous': 'Previous user message',
    'chat.next': 'Next user message',
    'question.submit': 'Submit question answer',
  };
  const option = /^question\.option([1-9])$/.exec(id);
  return option ? `Question option ${option[1]}` : labels[id] ?? fallback;
}

function englishError(message: string) {
  const errors: Record<string, string> = {
    '이 키는 기본 입력 또는 브라우저 동작에 사용됩니다.': 'This key is reserved for typing or browser actions.',
    '다른 기능에 이미 지정된 단축키입니다.': 'This shortcut is already assigned to another action.',
    '알 수 없는 기능입니다.': 'Unknown action.',
  };
  return errors[message] ?? message;
}

export function ShortcutSettings() {
  const { i18n } = useTranslation('settings');
  const ko = (i18n.resolvedLanguage ?? i18n.language).startsWith('ko');
  const bindings = useShortcutStore((s) => s.bindings);
  const setBinding = useShortcutStore((s) => s.setBinding);
  const reset = useShortcutStore((s) => s.reset);
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  const [error, setError] = useState<{ id: ShortcutId; message: string } | null>(null);
  const prefix = useId();
  const helpId = `${prefix}-help`;
  const errorId = `${prefix}-error`;

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>, id: ShortcutId) => {
    // Recording must never execute an application shortcut or a browser default.
    event.preventDefault();
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.repeat) return;
    if (event.key === 'Escape') {
      setError(null);
      setRecording(null);
      event.currentTarget.blur();
      return;
    }
    const clear = event.key === 'Backspace' || event.key === 'Delete';
    const value = clear ? '' : serializeShortcut(event.nativeEvent);
    // Modifier-only events do not finish recording or disable the shortcut.
    if (!clear && !value) return;
    const message = setBinding(id, value);
    if (message) {
      setError({ id, message });
      return;
    }
    setError(null);
    setRecording(null);
    event.currentTarget.blur();
  };

  return (
    <section data-shortcut-settings aria-labelledby={`${prefix}-title`} className="mt-6 border-t border-surface-800 pt-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
        <h3 id={`${prefix}-title`} className="text-[14px] font-semibold text-surface-200">
          {ko ? '키보드 단축키' : 'Keyboard shortcuts'}
        </h3>
        <button
          type="button"
          onClick={() => { reset(); setError(null); setRecording(null); }}
          className="rounded-lg border border-surface-700 px-3 py-1.5 text-xs text-surface-400 hover:text-surface-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500"
        >
          {ko ? '전체 기본값 복원' : 'Reset all shortcuts'}
        </button>
      </div>
      <p className="text-xs text-surface-500 mb-2">
        {ko ? '이 브라우저에서 로그인한 사용자별로 저장됩니다.' : 'Saved per signed-in user in this browser.'}
      </p>
      <p id={helpId} className="text-xs leading-relaxed text-surface-400 mb-4">
        {ko
          ? '입력란을 선택하고 새 키 조합을 누르세요. Esc로 취소하고 Backspace 또는 Delete로 단축키를 해제합니다.'
          : 'Select a field and press a new key combination. Esc cancels; Backspace or Delete disables the shortcut.'}
      </p>
      <div className="space-y-3">
        {SHORTCUTS.map(({ id, label: originalLabel, defaultBinding }) => {
          const label = ko ? originalLabel : englishLabel(id, originalLabel);
          return (
          <div key={id} className="flex flex-wrap items-center gap-2">
            <label htmlFor={`${prefix}-${id}`} className="min-w-0 flex-1 basis-36 text-sm text-surface-300">
              {label}
              <span className="block text-xs text-surface-500 mt-0.5">
                {ko ? '기본값: ' : 'Default: '}{formatShortcut(defaultBinding)}
              </span>
            </label>
            <input
              id={`${prefix}-${id}`}
              readOnly
              value={recording === id
                ? (ko ? '키 조합을 누르세요…' : 'Press a key combination…')
                : (bindings[id] === '' ? (ko ? '사용 안 함' : 'Disabled') : formatShortcut(bindings[id] ?? defaultBinding))}
              onFocus={() => { setRecording(id); setError(null); }}
              onClick={() => { setRecording(id); setError(null); }}
              onBlur={() => setRecording(null)}
              onKeyDown={(event) => handleKeyDown(event, id)}
              aria-describedby={error?.id === id ? `${helpId} ${errorId}` : helpId}
              aria-invalid={error?.id === id || undefined}
              className="w-48 max-w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-surface-200 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
            <button
              type="button"
              onClick={() => { reset(id); setError(null); setRecording(null); }}
              aria-label={ko ? `${label} 기본값 복원` : `Reset ${label}`}
              className="rounded px-2 py-2 text-xs text-surface-400 hover:text-surface-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500"
            >
              {ko ? '기본값' : 'Reset'}
            </button>
          </div>
          );
        })}
      </div>
      {error && <p id={errorId} role="alert" className="mt-3 text-sm text-red-400">{ko ? error.message : englishError(error.message)}</p>}
    </section>
  );
}
