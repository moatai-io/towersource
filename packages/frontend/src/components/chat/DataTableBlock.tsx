import { useMemo, useState } from 'react';
import { useSettingsStore } from '../../stores/settings-store';
import { parseLooseJson } from '../shared/parse-loose-json';
import { BlockFallback } from '../shared/RichContent';

interface DataTableSpec {
  title?: string;
  columns: string[];
  data: any[][];
  sortable?: boolean;
  pageSize?: number;
}

interface Props {
  raw: string;
  fallbackCode: string;
}

export default function DataTableBlock({ raw, fallbackCode }: Props) {
  const theme = useSettingsStore((s) => s.theme);
  const isDark = theme !== 'light';
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortAsc, setSortAsc] = useState(true);
  const [page, setPage] = useState(0);

  const parsed = useMemo(() => {
    const r = parseLooseJson(raw);
    if (!r.ok) return { ok: false as const, error: r.error };
    const spec = r.data as DataTableSpec;
    if (!spec.columns || !Array.isArray(spec.columns)) return { ok: false as const, error: 'Missing "columns" array' };
    if (!spec.data || !Array.isArray(spec.data)) return { ok: false as const, error: 'Missing "data" array' };
    return { ok: true as const, spec };
  }, [raw]);

  if (!parsed.ok) return <BlockFallback raw={fallbackCode} error={parsed.error} />;

  const { spec } = parsed;
  const pageSize = spec.pageSize || 20;

  const sorted = useMemo(() => {
    const rows = [...spec.data];
    if (sortCol !== null) {
      rows.sort((a, b) => {
        const va = a[sortCol], vb = b[sortCol];
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        if (typeof va === 'number' && typeof vb === 'number') return sortAsc ? va - vb : vb - va;
        return sortAsc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
      });
    }
    return rows;
  }, [spec.data, sortCol, sortAsc]);

  const totalPages = Math.ceil(sorted.length / pageSize);
  const pageRows = sorted.slice(page * pageSize, (page + 1) * pageSize);

  const handleSort = (i: number) => {
    if (spec.sortable === false) return;
    if (sortCol === i) setSortAsc(!sortAsc);
    else { setSortCol(i); setSortAsc(true); }
  };

  return (
    <div className="my-3 rounded-lg border border-surface-700/40 bg-surface-900/40 overflow-hidden">
      {spec.title && (
        <div className="text-ui-block-size font-medium text-gray-300 px-3 pt-3 pb-1">{spec.title}</div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-ui-table-size">
          <thead>
            <tr className={isDark ? 'bg-surface-800/60' : 'bg-gray-100'}>
              {spec.columns.map((col, i) => (
                <th
                  key={i}
                  onClick={() => handleSort(i)}
                  className={`px-3 py-2 text-left font-medium text-ui-table-header-size uppercase tracking-wider ${
                    isDark ? 'text-gray-400' : 'text-gray-600'
                  } ${spec.sortable !== false ? 'cursor-pointer hover:text-gray-200 select-none' : ''}`}
                >
                  {col}
                  {sortCol === i && (
                    <span className="ml-1">{sortAsc ? '▲' : '▼'}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, ri) => (
              <tr
                key={ri}
                className={`border-t ${isDark ? 'border-surface-700/30' : 'border-gray-200'} ${
                  ri % 2 === 0
                    ? (isDark ? 'bg-surface-900/20' : 'bg-white')
                    : (isDark ? 'bg-surface-800/20' : 'bg-gray-50')
                }`}
              >
                {spec.columns.map((_, ci) => (
                  <td key={ci} className={`px-3 py-1.5 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                    {row[ci] != null ? String(row[ci]) : ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-3 py-2 text-ui-block-meta-size text-gray-500">
          <span>{sorted.length} rows</span>
          <div className="flex gap-1">
            <button
              onClick={() => setPage(Math.max(0, page - 1))}
              disabled={page === 0}
              className="px-2 py-0.5 rounded bg-surface-800/60 hover:bg-surface-700/60 disabled:opacity-30"
            >
              ‹
            </button>
            <span className="px-2 py-0.5">{page + 1} / {totalPages}</span>
            <button
              onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
              disabled={page >= totalPages - 1}
              className="px-2 py-0.5 rounded bg-surface-800/60 hover:bg-surface-700/60 disabled:opacity-30"
            >
              ›
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
