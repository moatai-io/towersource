import { towerHttpUrl } from '../../features/client-connection/connection';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { PreviewCell, SheetPreview } from './XlsxPreview.worker';

const XLSX_PARSE_TIMEOUT_MS = 8000;
const XLSX_MAX_PREVIEW_BYTES = 15 * 1024 * 1024;

type WorkerResponse =
  | {
      id: number;
      ok: true;
      sheetNames: string[];
      activeSheet: string;
      sheets: Record<string, SheetPreview>;
      truncated: boolean;
    }
  | {
      id: number;
      ok: false;
      error: string;
    };

function renderCellContent(cell: PreviewCell) {
  if (!cell.href) return cell.text;
  return (
    <a href={cell.href} target="_blank" rel="noreferrer">
      {cell.text}
    </a>
  );
}

/**
 * XLSX/XLS Preview using SheetJS inside a dedicated Web Worker.
 *
 * Security/robustness notes:
 * - SheetJS `xlsx` currently has no npm-audit fix for prototype pollution/ReDoS.
 * - Tower limits preview size and parsing time, and runs workbook parsing outside
 *   the main UI thread so malformed spreadsheets cannot freeze the app shell.
 * - This is a preview path only; finance analysis tools use server-side paths.
 */
export function XlsxPreview({ filePath, cacheKey }: { filePath: string; cacheKey?: string }) {
  const { t } = useTranslation('files');
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState('');
  const [sheets, setSheets] = useState<Record<string, SheetPreview>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [truncated, setTruncated] = useState(false);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!filePath) return;
    let cancelled = false;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const worker = new Worker(new URL('./XlsxPreview.worker.ts', import.meta.url), { type: 'module' });
    let timeout: ReturnType<typeof setTimeout> | undefined;

    (async () => {
      try {
        setLoading(true);
        setError('');
        setTruncated(false);

        const token = localStorage.getItem('token') || '';
        const res = await fetch(
          towerHttpUrl(`/api/files/serve?path=${encodeURIComponent(filePath)}&token=${encodeURIComponent(token)}${cacheKey ? `&v=${encodeURIComponent(cacheKey)}` : ''}`),
        );
        if (!res.ok) throw new Error(`Failed to load file (${res.status})`);

        const sizeHeader = Number(res.headers.get('content-length') || 0);
        if (sizeHeader > XLSX_MAX_PREVIEW_BYTES) {
          throw new Error('Spreadsheet is too large for safe in-browser preview. Download it or use the Excel analysis tool instead.');
        }

        const arrayBuffer = await res.arrayBuffer();
        if (arrayBuffer.byteLength > XLSX_MAX_PREVIEW_BYTES) {
          throw new Error('Spreadsheet is too large for safe in-browser preview. Download it or use the Excel analysis tool instead.');
        }
        if (cancelled) return;

        await new Promise<void>((resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new Error('Spreadsheet preview timed out. Download it or use the Excel analysis tool instead.'));
          }, XLSX_PARSE_TIMEOUT_MS);

          worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
            if (event.data.id !== requestId) return;
            if (timeout) clearTimeout(timeout);
            if (!event.data.ok) {
              reject(new Error(event.data.error));
              return;
            }
            if (!cancelled) {
              setSheetNames(event.data.sheetNames);
              setActiveSheet(event.data.activeSheet);
              setSheets(event.data.sheets);
              setTruncated(event.data.truncated);
            }
            resolve();
          };

          worker.onerror = () => {
            if (timeout) clearTimeout(timeout);
            reject(new Error('Spreadsheet worker failed while rendering preview'));
          };

          worker.postMessage({ id: requestId, buffer: arrayBuffer }, [arrayBuffer]);
        });
      } catch (err: any) {
        if (!cancelled) setError(err.message || 'Failed to render spreadsheet');
      } finally {
        if (timeout) clearTimeout(timeout);
        worker.terminate();
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
      worker.terminate();
    };
  }, [filePath, cacheKey]);

  const currentSheet = useMemo(() => sheets[activeSheet], [sheets, activeSheet]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-base">
        <svg className="w-5 h-5 animate-spin mr-2" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        {t('loadingSpreadsheet')}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center p-6 text-center text-red-400 text-base">
        {error}
      </div>
    );
  }

  return (
    <div className="xlsx-preview-root flex-1 flex flex-col overflow-hidden">
      {sheetNames.length > 1 && (
        <div className="flex items-center gap-0.5 px-3 py-1.5 bg-surface-850 border-b border-surface-700 overflow-x-auto shrink-0">
          {sheetNames.map((name) => (
            <button
              key={name}
              onClick={() => setActiveSheet(name)}
              className={`px-3 py-1 text-sm rounded-md transition-colors whitespace-nowrap ${
                activeSheet === name
                  ? 'tone-success tone-bg-soft tone-text font-medium'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-surface-700'
              }`}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {truncated && (
        <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          {t('spreadsheetPreviewTruncated')}
        </div>
      )}

      <div className="xlsx-scroll flex-1 overflow-auto bg-white">
        {!currentSheet || currentSheet.empty ? (
          <div className="h-full flex items-center justify-center text-gray-400 text-base">
            {t('emptySheet')}
          </div>
        ) : (
          <table className="xlsx-table">
            <colgroup>
              {currentSheet.cols.map((col) => (
                <col key={col.key} style={{ width: col.widthPx, display: col.hidden ? 'none' : undefined }} />
              ))}
            </colgroup>
            <tbody>
              {currentSheet.rows.map((row) => (
                <tr key={row.key} style={{ height: row.heightPx, display: row.hidden ? 'none' : undefined }}>
                  {row.cells.map((cell) => (
                    <td
                      key={cell.key}
                      className={cell.className}
                      style={cell.style as CSSProperties}
                      colSpan={cell.colSpan}
                      rowSpan={cell.rowSpan}
                      title={cell.title}
                    >
                      {renderCellContent(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <style>{`
        .xlsx-preview-root .xlsx-table {
          border-collapse: collapse;
          width: max-content;
          min-width: 100%;
          table-layout: fixed;
          font-family: 'Noto Sans KR', 'Malgun Gothic', -apple-system, sans-serif;
          font-size: 15px;
          color: #1f2937;
          background: #ffffff;
        }
        .xlsx-preview-root .xlsx-cell {
          border: 1px solid #e5e7eb;
          padding: 3px 6px;
          height: inherit;
          min-width: 0;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          vertical-align: middle;
          background-clip: padding-box;
        }
        .xlsx-preview-root .xlsx-cell-number,
        .xlsx-preview-root .xlsx-cell-date {
          text-align: right;
        }
        .xlsx-preview-root .xlsx-cell-empty {
          color: transparent;
        }
        .xlsx-preview-root .xlsx-cell a {
          color: #2563eb;
          text-decoration: underline;
        }
        .xlsx-preview-root .xlsx-table tr:hover .xlsx-cell {
          background-image: linear-gradient(rgba(14, 165, 233, 0.08), rgba(14, 165, 233, 0.08));
        }
      `}</style>
    </div>
  );
}
