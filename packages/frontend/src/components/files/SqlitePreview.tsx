import { useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

/**
 * SQLite Preview using sql.js (WebAssembly SQLite in the browser).
 *
 * - Fetches the .db / .sqlite / .sqlite3 file as an ArrayBuffer.
 * - Opens it fully in-memory; nothing is sent back to the server.
 * - Lists user tables and renders the first N rows per table.
 *
 * Hard limits (to protect the tab from OOM):
 *   - File size  : 100 MB
 *   - Rows/table : 1,000
 */

const MAX_SIZE = 100 * 1024 * 1024; // 100 MB
const ROW_LIMIT = 1000;

type TableData = {
  columns: string[];
  rows: any[][];
  total: number;
};

export function SqlitePreview({ filePath }: { filePath: string }) {
  const { t } = useTranslation('files');
  const [tables, setTables] = useState<string[]>([]);
  const [activeTable, setActiveTable] = useState('');
  const [tableData, setTableData] = useState<TableData | null>(null);
  const [schema, setSchema] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const dbRef = useRef<any>(null);

  // ── Load database once ──
  useEffect(() => {
    if (!filePath) return;
    let cancelled = false;

    (async () => {
      try {
        setLoading(true);
        setError('');

        const token = localStorage.getItem('token') || '';
        const res = await fetch(
          `/api/files/serve?path=${encodeURIComponent(filePath)}&token=${encodeURIComponent(token)}`
        );
        if (!res.ok) throw new Error(`Failed to load file (${res.status})`);

        const contentLen = Number(res.headers.get('Content-Length') || 0);
        if (contentLen && contentLen > MAX_SIZE) {
          throw new Error(
            `File too large to preview (${(contentLen / 1024 / 1024).toFixed(1)} MB). ` +
            `Max ${MAX_SIZE / 1024 / 1024} MB.`
          );
        }

        const arrayBuffer = await res.arrayBuffer();
        if (cancelled) return;

        if (arrayBuffer.byteLength > MAX_SIZE) {
          throw new Error(
            `File too large to preview (${(arrayBuffer.byteLength / 1024 / 1024).toFixed(1)} MB). ` +
            `Max ${MAX_SIZE / 1024 / 1024} MB.`
          );
        }

        // Magic-byte sanity check: SQLite files start with "SQLite format 3\0"
        const header = new TextDecoder().decode(new Uint8Array(arrayBuffer.slice(0, 15)));
        if (!header.startsWith('SQLite format 3')) {
          throw new Error(
            'This file is not a valid SQLite database (missing "SQLite format 3" header). ' +
            'It may be a different binary format that happens to use the .db extension.'
          );
        }

        // Dynamic import — keeps sql.js out of the main bundle.
        const initSqlJs = (await import('sql.js')).default;
        if (cancelled) return;

        const SQL = await initSqlJs({ locateFile: () => sqlWasmUrl });
        if (cancelled) return;

        const db = new SQL.Database(new Uint8Array(arrayBuffer));
        dbRef.current = db;

        // Enumerate user tables (skip sqlite_* internal).
        const result = db.exec(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        );
        const names: string[] = result[0]?.values.map((r: any[]) => String(r[0])) || [];

        if (cancelled) return;
        setTables(names);
        if (names.length > 0) {
          setActiveTable(names[0]);
        } else {
          setError(t('databaseHasNoUserTables'));
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message || 'Failed to open SQLite database');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (dbRef.current) {
        try { dbRef.current.close(); } catch { /* noop */ }
        dbRef.current = null;
      }
    };
  }, [filePath, t]);

  // ── Load rows whenever activeTable changes ──
  useEffect(() => {
    if (!activeTable || !dbRef.current) return;
    const db = dbRef.current;
    try {
      const quoted = `"${activeTable.replace(/"/g, '""')}"`;

      // Schema (CREATE TABLE statement)
      const schemaRes = db.exec(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`,
        [activeTable]
      );
      setSchema(schemaRes[0]?.values[0]?.[0] as string || '');

      // Row count
      const countRes = db.exec(`SELECT COUNT(*) FROM ${quoted}`);
      const total = Number(countRes[0]?.values[0][0] ?? 0);

      // First N rows
      const dataRes = db.exec(`SELECT * FROM ${quoted} LIMIT ${ROW_LIMIT}`);
      if (dataRes.length === 0) {
        setTableData({ columns: [], rows: [], total });
      } else {
        setTableData({
          columns: dataRes[0].columns,
          rows: dataRes[0].values,
          total,
        });
      }
    } catch (err: any) {
      setError(t('sqliteQueryFailed', { table: activeTable, error: err.message }));
    }
  }, [activeTable, t]);

  // ── Render ──
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-base">
        <svg className="w-5 h-5 animate-spin mr-2" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        {t('loadingSqliteDatabase')}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-md text-base text-red-400 text-center whitespace-pre-wrap">
          {error}
        </div>
      </div>
    );
  }

  const formatCell = (v: any): string => {
    if (v === null || v === undefined) return 'NULL';
    if (v instanceof Uint8Array) return `<BLOB ${v.length} bytes>`;
    if (typeof v === 'string' && v.length > 200) return v.slice(0, 200) + '…';
    return String(v);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-surface-900">
      {/* Table tabs */}
      {tables.length > 0 && (
        <div className="flex items-center gap-0.5 px-3 py-1.5 bg-surface-850 border-b border-surface-700 overflow-x-auto shrink-0">
          {tables.map((name) => (
            <button
              key={name}
              onClick={() => setActiveTable(name)}
              className={`px-3 py-1 text-sm rounded-md transition-colors whitespace-nowrap ${
                activeTable === name
                  ? 'bg-primary-600/30 text-primary-300 font-medium'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-surface-700'
              }`}
              title={name}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {/* Table meta + schema */}
      {tableData && (
        <div className="px-3 py-2 bg-surface-850 border-b border-surface-700 shrink-0 flex items-center gap-4 text-sm text-gray-400">
          <span>
            <span className="text-gray-500">{t('rows')}:</span>{' '}
            <span className="text-gray-200 font-medium">{tableData.total.toLocaleString()}</span>
            {tableData.total > ROW_LIMIT && (
              <span className="tone-warning tone-text"> {t('showingFirstRows', { count: ROW_LIMIT.toLocaleString() })}</span>
            )}
          </span>
          <span>
            <span className="text-gray-500">{t('columns')}:</span>{' '}
            <span className="text-gray-200 font-medium">{tableData.columns.length}</span>
          </span>
          {schema && (
            <details className="ml-auto">
              <summary className="cursor-pointer text-gray-500 hover:text-gray-300 select-none">{t('schema')}</summary>
              <pre className="absolute right-3 mt-1 p-3 bg-surface-950 border border-surface-700 rounded text-sm text-gray-300 max-w-lg overflow-auto z-10 whitespace-pre-wrap">
                {schema}
              </pre>
            </details>
          )}
        </div>
      )}

      {/* Data grid */}
      <div className="flex-1 overflow-auto">
        {tableData && tableData.columns.length > 0 ? (
          <table className="sqlite-preview-table">
            <thead>
              <tr>
                {tableData.columns.map((col, i) => (
                  <th key={i}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableData.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => {
                    const val = formatCell(cell);
                    const isNull = cell === null || cell === undefined;
                    return (
                      <td key={ci} className={isNull ? 'sqlite-null' : ''} title={val}>
                        {val}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="p-6 text-base text-gray-500">
            {tableData ? t('emptyTable') : t('selectTableToView')}
          </div>
        )}
      </div>

      <style>{`
        .sqlite-preview-table {
          border-collapse: collapse;
          width: max-content;
          min-width: 100%;
          font-family: 'ui-monospace', 'SF Mono', 'Menlo', 'Consolas', monospace;
          font-size: 14px;
          color: #e5e7eb;
        }
        .sqlite-preview-table td,
        .sqlite-preview-table th {
          border: 1px solid rgb(55 55 62);
          padding: 5px 10px;
          white-space: nowrap;
          max-width: 360px;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .sqlite-preview-table th {
          background: rgb(30 30 34);
          font-weight: 600;
          position: sticky;
          top: 0;
          z-index: 1;
          color: #f3f4f6;
          text-align: left;
        }
        .sqlite-preview-table tr:hover td {
          background: rgb(40 40 45);
        }
        .sqlite-preview-table td.sqlite-null {
          color: #6b7280;
          font-style: italic;
        }
      `}</style>
    </div>
  );
}
