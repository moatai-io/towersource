import { useMemo } from 'react';
import { useSettingsStore } from '../../stores/settings-store';
import { parseLooseJson, safeStr } from '../shared/parse-loose-json';
import { BlockFallback } from '../shared/RichContent';

interface TimelineItem {
  date?: string;
  title: string;
  description?: string;
  desc?: string;
  status?: 'done' | 'active' | 'pending' | 'error';
  tag?: string;
}

interface TimelineSpec {
  title?: string;
  items: TimelineItem[];
}

interface Props {
  raw: string;
  fallbackCode: string;
}

const STATUS_COLORS: Record<string, { tone: string; dot: string; line: string; text: string }> = {
  done:    { tone: 'tone-success', dot: 'tone-bg', line: 'tone-line', text: 'tone-text' },
  active:  { tone: 'tone-accent', dot: 'tone-bg animate-pulse', line: 'tone-line', text: 'tone-text' },
  pending: { tone: 'tone-muted', dot: 'tone-bg', line: 'tone-line', text: 'tone-text' },
  error:   { tone: 'tone-danger', dot: 'tone-bg', line: 'tone-line', text: 'tone-text' },
};

export default function TimelineBlock({ raw, fallbackCode }: Props) {
  const theme = useSettingsStore((s) => s.theme);
  const isDark = theme !== 'light';

  const parsed = useMemo(() => {
    const r = parseLooseJson(raw);
    if (!r.ok) return { ok: false as const, error: r.error };
    const spec = r.data as TimelineSpec;
    if (!spec.items || !Array.isArray(spec.items)) return { ok: false as const, error: 'Missing "items" array' };
    return { ok: true as const, spec };
  }, [raw]);

  if (!parsed.ok) return <BlockFallback raw={fallbackCode} error={parsed.error} />;
  const { spec } = parsed;

  return (
    <div className="my-3 rounded-lg border border-surface-700/40 bg-surface-900/40 p-4">
      {spec.title && (
        <div className="text-base font-medium text-gray-300 mb-3">{safeStr(spec.title)}</div>
      )}
      <div className="relative">
        {spec.items.map((item, i) => {
          const status = item.status || 'pending';
          const colors = STATUS_COLORS[status] || STATUS_COLORS.pending;
          const isLast = i === spec.items.length - 1;
          const desc = item.description || item.desc;

          return (
            <div key={i} className="flex gap-3 pb-4 last:pb-0">
              {/* Timeline rail */}
              <div className={`flex flex-col items-center w-4 flex-shrink-0 ${colors.tone}`}>
                <div className={`w-3 h-3 rounded-full ${colors.dot} mt-0.5 flex-shrink-0 ring-2 ring-surface-900/80`} />
                {!isLast && <div className={`w-0.5 flex-1 ${colors.line} mt-1`} />}
              </div>
              {/* Content */}
              <div className="flex-1 min-w-0 -mt-0.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-base font-medium ${isDark ? 'text-gray-200' : 'text-gray-800'}`}>
                    {safeStr(item.title)}
                  </span>
                  {item.tag && (
                    <span className="text-[12px] px-1.5 py-0.5 rounded-full bg-surface-700/50 text-gray-400">
                      {item.tag}
                    </span>
                  )}
                  {item.date && (
                    <span className={`text-[13px] ${colors.tone} ${colors.text}`}>{item.date}</span>
                  )}
                </div>
                {desc && (
                  <p className={`text-sm mt-0.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                    {safeStr(desc)}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
