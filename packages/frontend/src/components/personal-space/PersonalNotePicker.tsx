import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n';

export interface PersonalNoteSummary {
  id: string;
  uri: string;
  relativePath: string;
  name: string;
  updatedAt: string;
}

interface PersonalNotePickerProps {
  token: string | null;
  onClose: () => void;
  onCreate: () => void;
  onOpen: (uri: string) => void;
}

/** Search and open user-owned Personal Space Markdown notes. */
export function PersonalNotePicker({ token, onClose, onCreate, onOpen }: PersonalNotePickerProps) {
  const { t } = useTranslation('layout');
  const [notes, setNotes] = useState<PersonalNoteSummary[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    fetch('/api/personal-space/files', { headers, signal: controller.signal })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || t('personalNotePicker.loadFailedWithStatus', { status: res.status }));
        setNotes(Array.isArray(data.files) ? data.files : []);
      })
      .catch((err) => {
        if (err?.name !== 'AbortError') setError(err instanceof Error ? err.message : t('personalNotePicker.loadFailed'));
      })
      .finally(() => setLoading(false));
    window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => controller.abort();
  }, [token, t]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return notes;
    return notes.filter((note) => `${note.name} ${note.relativePath}`.toLocaleLowerCase().includes(needle));
  }, [notes, query]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 px-4 pt-[12vh] backdrop-blur-sm" onMouseDown={onClose}>
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-surface-700 bg-surface-950 shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-surface-800 px-4 py-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary-300">Personal Space</div>
            <h2 className="mt-0.5 text-base font-bold text-surface-100">{t('personalNotePicker.title')}</h2>
          </div>
          <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-surface-400 hover:bg-surface-800 hover:text-surface-100" aria-label={t('personalNotePicker.close')}>×</button>
        </div>
        <div className="border-b border-surface-800 p-3">
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('personalNotePicker.searchPlaceholder')}
            className="h-10 w-full rounded-lg border border-surface-700 bg-surface-900 px-3 text-sm text-surface-100 outline-none placeholder:text-surface-500 focus:border-primary-500"
          />
        </div>
        <div className="max-h-[52vh] overflow-y-auto p-2">
          {loading ? (
            <div className="px-3 py-10 text-center text-sm text-surface-500">{t('personalNotePicker.loading')}</div>
          ) : error ? (
            <div className="px-3 py-10 text-center text-sm text-red-300">{error}</div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-10 text-center text-sm text-surface-500">{t('personalNotePicker.empty')}</div>
          ) : filtered.map((note) => (
            <button
              key={note.id}
              type="button"
              onClick={() => { onOpen(note.uri); onClose(); }}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-surface-800"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-500/10 text-base" aria-hidden="true">👤</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-surface-100">{note.name}</span>
                <span className="mt-0.5 block truncate text-[12px] text-surface-500">{note.relativePath}</span>
              </span>
              <span className="shrink-0 text-[11px] text-surface-500">{new Date(note.updatedAt).toLocaleDateString(i18n.resolvedLanguage || i18n.language)}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between border-t border-surface-800 px-3 py-3">
          <span className="text-[12px] text-surface-500">{t('personalNotePicker.privateSpace')}</span>
          <button type="button" onClick={() => { onCreate(); onClose(); }} className="rounded-lg bg-primary-500 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-400">
            {t('personalNotePicker.newNote')}
          </button>
        </div>
      </div>
    </div>
  );
}
