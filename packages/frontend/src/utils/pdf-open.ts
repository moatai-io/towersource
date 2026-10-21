import { towerHttpUrl, readBrowserAuthToken } from '../features/client-connection/connection';
/**
 * Owns: opening Tower-local PDFs outside iframe previews.
 * Public API: buildPdfServeUrl, openPdfInBrowserTab, isPdfPath.
 *
 * PDF files are intentionally opened in the browser's top-level PDF viewer
 * instead of Tower iframe previews. See:
 * workspace/decisions/2026-07-06-pdf-open-in-browser-tab.md
 */
/** Return true when a path or URL points to a PDF file. */
export function isPdfPath(pathOrUrl: string): boolean {
  return pathOrUrl.split(/[?#]/, 1)[0].toLowerCase().endsWith('.pdf');
}

/** Build the internal file-serve URL used for top-level PDF viewing. */
export function buildPdfServeUrl(filePath: string, options?: { download?: boolean; revision?: string; includeToken?: boolean }): string {
  const includeToken = options?.includeToken !== false;
  const token = includeToken ? readBrowserAuthToken() || '' : '';
  const params = new URLSearchParams({ path: filePath });
  if (token) params.set('token', token);
  if (options?.download) params.set('download', '1');
  if (options?.revision) params.set('v', options.revision);
  return towerHttpUrl(`/api/files/serve?${params.toString()}`);
}

/** Open a Tower-local PDF in the browser's top-level PDF viewer. */
export function openPdfInBrowserTab(filePath: string, options?: { revision?: string }) {
  window.open(buildPdfServeUrl(filePath, { revision: options?.revision }), '_blank', 'noopener,noreferrer');
}
