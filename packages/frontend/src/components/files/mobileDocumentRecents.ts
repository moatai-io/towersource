const MOBILE_DOCUMENT_RECENTS_KEY = 'tower:mobile-document-recents';
const MOBILE_DOCUMENT_RECENTS_LIMIT = 8;
export const MOBILE_DOCUMENT_RECENTS_CHANGED = 'tower-mobile-document-recents-changed';

export interface MobileDocumentRecent {
  path: string;
  name: string;
  openedAt: number;
}

/** Read documents explicitly opened through the mobile Viewer, newest first. */
export function readMobileDocumentRecents(): MobileDocumentRecent[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(MOBILE_DOCUMENT_RECENTS_KEY) || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((item): item is MobileDocumentRecent => !!item && typeof item.path === 'string' && typeof item.name === 'string' && typeof item.openedAt === 'number')
      : [];
  } catch {
    return [];
  }
}

/** Move a mobile-opened document to the front and notify mounted file hubs. */
export function recordMobileDocumentRecent(path: string, name?: string): MobileDocumentRecent[] {
  const next = [
    { path, name: name || path.split('/').pop() || path, openedAt: Date.now() },
    ...readMobileDocumentRecents().filter((item) => item.path !== path),
  ].slice(0, MOBILE_DOCUMENT_RECENTS_LIMIT);
  localStorage.setItem(MOBILE_DOCUMENT_RECENTS_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent(MOBILE_DOCUMENT_RECENTS_CHANGED));
  return next;
}
