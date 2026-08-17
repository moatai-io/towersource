export const PERSONAL_DOCUMENT_PINS_KEY = 'tower.personalDocuments.pinned';
export const PERSONAL_DOCUMENT_RECENTS_KEY = 'tower.personalDocuments.recent';
export const PERSONAL_DOCUMENT_RECENTS_LIMIT = 20;
export const PERSONAL_DOCUMENT_PREFERENCES_IMPORTED_KEY = 'tower.personalDocuments.preferencesImported.v1';

export interface PersonalDocumentPreferences {
  pinnedUris: string[];
  recentUris: string[];
}

function readStringList(key: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function authHeaders(json = false): Record<string, string> {
  const headers: Record<string, string> = json ? { 'Content-Type': 'application/json' } : {};
  const token = localStorage.getItem('token');
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function normalizePreferences(value: unknown): PersonalDocumentPreferences {
  const data = value as Partial<PersonalDocumentPreferences> | null;
  return {
    pinnedUris: Array.isArray(data?.pinnedUris) ? data.pinnedUris.filter(uri => typeof uri === 'string') : [],
    recentUris: Array.isArray(data?.recentUris) ? data.recentUris.filter(uri => typeof uri === 'string').slice(0, PERSONAL_DOCUMENT_RECENTS_LIMIT) : [],
  };
}

export function readRecentPersonalDocumentUris(): string[] {
  return readStringList(PERSONAL_DOCUMENT_RECENTS_KEY);
}

export function recordRecentPersonalDocument(uri: string): string[] {
  const next = [uri, ...readRecentPersonalDocumentUris().filter(item => item !== uri)].slice(0, PERSONAL_DOCUMENT_RECENTS_LIMIT);
  localStorage.setItem(PERSONAL_DOCUMENT_RECENTS_KEY, JSON.stringify(next));
  return next;
}

export async function loadPersonalDocumentPreferences(): Promise<PersonalDocumentPreferences> {
  const response = await fetch('/api/personal-space/document-preferences', { headers: authHeaders() });
  if (!response.ok) throw new Error('문서 선호도를 불러오지 못했습니다.');
  return normalizePreferences(await response.json().catch(() => ({})));
}

export async function setServerPersonalDocumentPinned(uri: string, pinned: boolean): Promise<PersonalDocumentPreferences> {
  const response = await fetch('/api/personal-space/document-preferences/pinned', {
    method: 'PUT', headers: authHeaders(true), body: JSON.stringify({ uri, pinned }),
  });
  if (!response.ok) throw new Error('고정 문서를 변경하지 못했습니다.');
  return normalizePreferences(await response.json().catch(() => ({})));
}

export async function recordServerPersonalDocumentOpened(uri: string): Promise<PersonalDocumentPreferences> {
  const response = await fetch('/api/personal-space/document-preferences/opened', {
    method: 'POST', headers: authHeaders(true), body: JSON.stringify({ uri }),
  });
  if (!response.ok) throw new Error('최근 문서를 기록하지 못했습니다.');
  return normalizePreferences(await response.json().catch(() => ({})));
}

export async function importLocalPersonalDocumentPreferences(): Promise<PersonalDocumentPreferences | null> {
  if (localStorage.getItem(PERSONAL_DOCUMENT_PREFERENCES_IMPORTED_KEY) === '1') return null;
  const pinnedUris = readStringList(PERSONAL_DOCUMENT_PINS_KEY);
  const recentUris = readRecentPersonalDocumentUris();
  const response = await fetch('/api/personal-space/document-preferences/import', {
    method: 'POST', headers: authHeaders(true), body: JSON.stringify({ pinnedUris, recentUris }),
  });
  if (!response.ok) throw new Error('기존 문서 선호도를 이전하지 못했습니다.');
  localStorage.setItem(PERSONAL_DOCUMENT_PREFERENCES_IMPORTED_KEY, '1');
  return normalizePreferences(await response.json().catch(() => ({})));
}
