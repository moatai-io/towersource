import { useMemo, useState } from 'react';
import { useSettingsStore } from '../../stores/settings-store';
import { parseLooseJson, safeStr } from '../shared/parse-loose-json';
import { BlockFallback } from '../shared/RichContent';

interface KanbanCard {
  title: string;
  column: string;
  tag?: string;
  assignee?: string;
  description?: string;
  desc?: string;
}

interface KanbanSpec {
  title?: string;
  columns: string[];
  cards: KanbanCard[];
}

interface Props {
  raw: string;
  fallbackCode: string;
}

const COLUMN_COLORS = [
  'border-t-gray-500',
  'border-t-blue-500',
  'border-t-emerald-500',
  'border-t-amber-500',
  'border-t-purple-500',
  'border-t-rose-500',
];

export default function KanbanBlock({ raw, fallbackCode }: Props) {
  const theme = useSettingsStore((s) => s.theme);
  const isDark = theme !== 'light';
  const [expandedCard, setExpandedCard] = useState<string | null>(null);

  const parsed = useMemo(() => {
    const r = parseLooseJson(raw);
    if (!r.ok) return { ok: false as const, error: r.error };
    const spec = r.data as KanbanSpec;
    if (!spec.columns || !Array.isArray(spec.columns)) return { ok: false as const, error: 'Missing "columns" array' };
    if (!spec.cards || !Array.isArray(spec.cards)) return { ok: false as const, error: 'Missing "cards" array' };
    return { ok: true as const, spec };
  }, [raw]);

  if (!parsed.ok) return <BlockFallback raw={fallbackCode} error={parsed.error} />;
  const { spec } = parsed;

  const cardsByCol = useMemo(() => {
    const map: Record<string, KanbanCard[]> = {};
    for (const col of spec.columns) map[col] = [];
    for (const card of spec.cards) {
      const col = card.column || spec.columns[0];
      if (!map[col]) map[col] = [];
      map[col].push(card);
    }
    return map;
  }, [spec]);

  return (
    <div className="my-3 rounded-lg border border-surface-700/40 bg-surface-900/40 p-3 overflow-hidden">
      {spec.title && (
        <div className="text-base font-medium text-gray-300 mb-2">{safeStr(spec.title)}</div>
      )}
      <div className="flex gap-2 overflow-x-auto pb-1" style={{ minHeight: 120 }}>
        {spec.columns.map((col, ci) => {
          const cards = cardsByCol[col] || [];
          return (
            <div
              key={col}
              className={`flex-shrink-0 rounded-lg border-t-2 ${COLUMN_COLORS[ci % COLUMN_COLORS.length]} ${
                isDark ? 'bg-surface-800/40' : 'bg-gray-50'
              }`}
              style={{ width: Math.max(180, 100 / spec.columns.length + '%' as any), minWidth: 160 }}
            >
              <div className="flex items-center justify-between px-2.5 py-1.5">
                <span className={`text-sm font-medium uppercase tracking-wider ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                  {col}
                </span>
                <span className={`text-[12px] px-1.5 py-0.5 rounded-full ${isDark ? 'bg-surface-700/60 text-gray-500' : 'bg-gray-200 text-gray-500'}`}>
                  {cards.length}
                </span>
              </div>
              <div className="px-1.5 pb-1.5 space-y-1.5">
                {cards.map((card, ki) => {
                  const cardId = `${col}-${ki}`;
                  const isExpanded = expandedCard === cardId;
                  const desc = card.description || card.desc;
                  return (
                    <div
                      key={ki}
                      onClick={() => setExpandedCard(isExpanded ? null : cardId)}
                      className={`rounded-md p-2 cursor-pointer transition-colors ${
                        isDark
                          ? 'bg-surface-900/60 hover:bg-surface-700/40 border border-surface-700/30'
                          : 'bg-white hover:bg-gray-50 border border-gray-200'
                      }`}
                    >
                      <div className="text-sm font-medium text-gray-200">{safeStr(card.title)}</div>
                      <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                        {card.tag && (
                          <span className="text-[11px] px-1 py-0.5 rounded bg-primary-900/30 text-primary-400">
                            {card.tag}
                          </span>
                        )}
                        {card.assignee && (
                          <span className="text-[11px] text-gray-500">{card.assignee}</span>
                        )}
                      </div>
                      {isExpanded && desc && (
                        <div className="mt-1.5 text-[13px] text-gray-400 border-t border-surface-700/30 pt-1.5">
                          {desc}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
