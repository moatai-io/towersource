import { create } from 'zustand';

export const SHORTCUTS = [
  { id: 'voice.toggle', label: '음성 입력 시작·종료', defaultBinding: 'Alt+V' },
  { id: 'session.previous', label: '이전 세션', defaultBinding: 'Alt+Shift+ArrowUp' },
  { id: 'session.next', label: '다음 세션', defaultBinding: 'Alt+Shift+ArrowDown' },
  { id: 'chat.previous', label: '이전 사용자 메시지', defaultBinding: 'Alt+ArrowUp' },
  { id: 'chat.next', label: '다음 사용자 메시지', defaultBinding: 'Alt+ArrowDown' },
  ...Array.from({ length: 9 }, (_, i) => ({ id: `question.option${i + 1}`, label: `질문 선택지 ${i + 1}`, defaultBinding: `${i + 1}` })),
  { id: 'question.submit', label: '질문 답변 제출', defaultBinding: 'Enter' },
];
export const defaultBindings = Object.fromEntries(SHORTCUTS.map(s => [s.id, s.defaultBinding]));
const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform);
export function formatShortcut(value: string) { return value ? value.replace('Mod', isMac() ? '⌘' : 'Ctrl').replace('ArrowUp', '↑').replace('ArrowDown', '↓').split('+').join(' + ') : '—'; }
export function serializeShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'> & { code?: string }): string {
  if (['Control', 'Meta', 'Alt', 'Shift', 'Dead', 'Process', 'Unidentified'].includes(event.key)) return '';
  // Option may emit special characters (e.g. √ on macOS); preserve the physical letter.
  const letter = event.altKey && /^Key[A-Z]$/.test(event.code || '') ? event.code!.slice(3) : event.key;
  const key = letter.length === 1 ? letter.toUpperCase() : letter;
  return [...(event.ctrlKey || event.metaKey ? ['Mod'] : []), ...(event.altKey ? ['Alt'] : []), ...(event.shiftKey ? ['Shift'] : []), key === ' ' ? 'Space' : key].join('+');
}
export function matchesShortcut(event: KeyboardEvent, binding?: string): boolean {
  if (!binding || event.isComposing || event.repeat || event.defaultPrevented) return false;
  if (event.ctrlKey && event.metaKey) return false;
  return serializeShortcut(event) === binding;
}
function storageKey() { const id = localStorage.getItem('userId'); return id ? `tower-shortcuts:${id}` : null; }
function read() {
  try { const key = storageKey(); const saved = key ? JSON.parse(localStorage.getItem(key) || '{}') : {}; if (saved['question.submit'] === 'Mod+Enter') saved['question.submit'] = 'Enter'; if (saved['voice.toggle'] === 'Mod+Shift+M') saved['voice.toggle'] = 'Alt+V'; return { ...defaultBindings, ...Object.fromEntries(Object.entries(saved).filter(([k, v]) => k in defaultBindings && typeof v === 'string')) } as Record<string, string>; }
  catch { return { ...defaultBindings }; }
}
function save(bindings: Record<string, string>) { try { const key = storageKey(); if (key) localStorage.setItem(key, JSON.stringify(bindings)); } catch { /* Private browsing/storage quota: keep this run usable. */ } }
export function shortcutConflict(id: string, value: string, bindings: Record<string, string>): string | null {
  if (!value || (id === 'question.submit' && value === 'Enter')) return null;
  const reserved = ['Mod+S', 'Mod+T', 'Mod+W', 'Mod+N', 'Mod+L', 'Mod+R', 'Mod+Shift+M', 'Mod+Shift+T', 'Mod+Shift+N', 'Alt+F4', 'Escape', 'Enter', 'Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
  if (reserved.includes(value) || (!value.includes('+') && !/^question\.option[1-9]$/.test(id))) return '이 키는 기본 입력 또는 브라우저 동작에 사용됩니다.';
  if (Object.entries(bindings).some(([other, key]) => other !== id && key === value)) return '다른 기능에 이미 지정된 단축키입니다.';
  return null;
}
export const useShortcutStore = create<{
  bindings: Record<string, string>; reload: () => void;
  setBinding: (id: string, value: string) => string | null;
  reset: (id?: string) => void;
}>((set, get) => ({
  bindings: read(),
  reload: () => set({ bindings: read() }),
  setBinding: (id, value) => {
    if (!(id in defaultBindings)) return '알 수 없는 기능입니다.';
    const error = shortcutConflict(id, value, get().bindings); if (error) return error;
    const bindings = { ...get().bindings, [id]: value }; save(bindings); set({ bindings }); return null;
  },
  reset: (id) => {
    const bindings = id ? { ...get().bindings } : { ...defaultBindings };
    if (id && id in defaultBindings) {
      const original = defaultBindings[id];
      for (const other of Object.keys(bindings)) if (other !== id && bindings[other] === original) bindings[other] = '';
      bindings[id] = original;
    }
    save(bindings); set({ bindings });
  },
}));
