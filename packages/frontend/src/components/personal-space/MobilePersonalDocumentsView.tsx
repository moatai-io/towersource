import React from 'react';
import { toastError } from '../../utils/toast';
import {
  importLocalPersonalDocumentPreferences,
  loadPersonalDocumentPreferences,
  PERSONAL_DOCUMENT_PINS_KEY,
  readRecentPersonalDocumentUris,
  recordRecentPersonalDocument,
  recordServerPersonalDocumentOpened,
  setServerPersonalDocumentPinned,
} from './personalDocumentRecents';

interface PersonalDocument {
  id: string;
  uri: string;
  name: string;
  kind: 'note' | 'file';
  mimeType?: string | null;
  updatedAt: string;
}

function readStringList(key: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function openPersonalPath(path: string) {
  window.dispatchEvent(new CustomEvent('tower-open-path', { detail: { path, split: 'right' } }));
}

function formatRecentDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric' }).format(date);
}

function documentGlyph(document: PersonalDocument): string {
  if (document.kind === 'note') return '▤';
  if (document.mimeType?.includes('pdf') || document.name.toLowerCase().endsWith('.pdf')) return 'PDF';
  return '□';
}

/** Mobile-first reading surface: pinned and recent personal documents, not storage folders. */
export function MobilePersonalDocumentsView() {
  const [documents, setDocuments] = React.useState<PersonalDocument[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [query, setQuery] = React.useState('');
  const [pinnedUris, setPinnedUris] = React.useState<string[]>(() => readStringList(PERSONAL_DOCUMENT_PINS_KEY));
  const [recentUris, setRecentUris] = React.useState<string[]>(readRecentPersonalDocumentUris);

  React.useEffect(() => {
    const token = localStorage.getItem('token');
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    void Promise.all([
      fetch('/api/personal-space/files', { headers }).then(async response => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || '내 문서를 불러오지 못했습니다.');
        setDocuments(Array.isArray(data.files) ? data.files : []);
      }),
      importLocalPersonalDocumentPreferences()
        .then(imported => imported || loadPersonalDocumentPreferences())
        .then(preferences => {
          setPinnedUris(preferences.pinnedUris);
          setRecentUris(preferences.recentUris);
          localStorage.setItem(PERSONAL_DOCUMENT_PINS_KEY, JSON.stringify(preferences.pinnedUris));
          localStorage.setItem('tower.personalDocuments.recent', JSON.stringify(preferences.recentUris));
        }),
    ])
      .catch(error => toastError(error instanceof Error ? error.message : '내 문서를 불러오지 못했습니다.'))
      .finally(() => setLoading(false));
  }, []);

  const byUri = React.useMemo(() => new Map(documents.map(document => [document.uri, document])), [documents]);
  const pinned = pinnedUris.map(uri => byUri.get(uri)).filter((item): item is PersonalDocument => !!item);
  const recent = recentUris.map(uri => byUri.get(uri)).filter((item): item is PersonalDocument => !!item && !pinnedUris.includes(item.uri)).slice(0, 6);
  const fallbackRecent = documents.filter(item => !pinnedUris.includes(item.uri)).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 6);
  const recentDocuments = recent.length ? recent : fallbackRecent;
  const normalizedQuery = query.trim().toLowerCase();
  const searchResults = normalizedQuery ? documents.filter(document => document.name.toLowerCase().includes(normalizedQuery)) : [];

  const togglePinned = (uri: string) => {
    const pinned = !pinnedUris.includes(uri);
    const optimistic = pinned ? [uri, ...pinnedUris] : pinnedUris.filter(item => item !== uri);
    setPinnedUris(optimistic);
    localStorage.setItem(PERSONAL_DOCUMENT_PINS_KEY, JSON.stringify(optimistic));
    void setServerPersonalDocumentPinned(uri, pinned)
      .then(preferences => {
        setPinnedUris(preferences.pinnedUris);
        setRecentUris(preferences.recentUris);
        localStorage.setItem(PERSONAL_DOCUMENT_PINS_KEY, JSON.stringify(preferences.pinnedUris));
      })
      .catch(error => {
        setPinnedUris(pinnedUris);
        toastError(error instanceof Error ? error.message : '고정 문서를 변경하지 못했습니다.');
      });
  };

  const openDocument = (document: PersonalDocument) => {
    setRecentUris(recordRecentPersonalDocument(document.uri));
    void recordServerPersonalDocumentOpened(document.uri)
      .then(preferences => setRecentUris(preferences.recentUris))
      .catch(() => {});
    openPersonalPath(document.uri);
  };

  const documentRow = (document: PersonalDocument, showPin = true) => (
    <div key={document.id} className="flex min-w-0 items-center gap-3 border-b border-surface-800/70 py-3 last:border-b-0">
      <button type="button" onClick={() => openDocument(document)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-900 text-[11px] font-bold text-primary-300" aria-hidden="true">{documentGlyph(document)}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-semibold text-surface-100">{document.name}</span>
          <span className="mt-0.5 block text-[11px] text-surface-500">{document.kind === 'note' ? '문서' : '파일'} · {formatRecentDate(document.updatedAt)}</span>
        </span>
      </button>
      {showPin && <button type="button" onClick={() => togglePinned(document.uri)} className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-lg ${pinnedUris.includes(document.uri) ? 'text-amber-300' : 'text-surface-600 hover:bg-surface-900 hover:text-surface-300'}`} aria-label={pinnedUris.includes(document.uri) ? `${document.name} 고정 해제` : `${document.name} 자주 보는 문서로 고정`}>{pinnedUris.includes(document.uri) ? '★' : '☆'}</button>}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-950 text-surface-100">
      <header className="shrink-0 border-b border-surface-800 px-4 pb-3 pt-4">
        <div><h2 className="text-xl font-bold">내 문서</h2><p className="mt-1 text-[12px] text-surface-500">자주 보거나 최근에 연 문서를 바로 엽니다.</p></div>
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="내 문서 검색" className="mt-3 h-10 w-full rounded-xl border border-surface-700 bg-surface-900 px-3 text-sm text-surface-100 outline-none placeholder:text-surface-600 focus:border-primary-500" />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {loading ? <p className="py-12 text-center text-sm text-surface-500">내 문서를 불러오는 중…</p> : normalizedQuery ? (
          <section><h3 className="mb-2 text-[12px] font-bold text-surface-500">검색 결과 {searchResults.length}</h3>{searchResults.length ? searchResults.map(document => documentRow(document)) : <p className="py-10 text-center text-sm text-surface-500">찾는 문서가 없습니다.</p>}</section>
        ) : (
          <>
            <section>
              <div className="flex items-center justify-between"><h3 className="text-[12px] font-bold text-surface-400">자주 보는 문서</h3><span className="text-[11px] text-surface-600">별표로 고정</span></div>
              <div className="mt-2">{pinned.length ? pinned.map(document => documentRow(document)) : <p className="rounded-xl border border-dashed border-surface-800 px-4 py-5 text-center text-[12px] leading-5 text-surface-500">최근 문서의 ☆를 누르면<br/>여기에 고정됩니다.</p>}</div>
            </section>
            <section className="mt-6">
              <h3 className="text-[12px] font-bold text-surface-400">최근 문서</h3>
              <div className="mt-2">{recentDocuments.length ? recentDocuments.map(document => documentRow(document)) : <p className="py-8 text-center text-sm text-surface-500">아직 저장된 문서가 없습니다.</p>}</div>
            </section>
          </>
        )}
      </div>
      <footer className="shrink-0 border-t border-surface-800 p-3">
        <button type="button" onClick={() => openPersonalPath('personal://materials')} className="w-full rounded-xl border border-surface-700 py-3 text-sm font-semibold text-surface-200 hover:border-primary-500/50">전체 내 파일 보기</button>
      </footer>
    </div>
  );
}
