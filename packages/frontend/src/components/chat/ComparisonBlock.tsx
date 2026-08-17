import { useMemo } from 'react';
import { useSettingsStore } from '../../stores/settings-store';
import { parseLooseJson, safeStr } from '../shared/parse-loose-json';
import { BlockFallback } from '../shared/RichContent';

interface ComparisonItem {
  name: string;
  badge?: string;
  pros?: string[];
  cons?: string[];
  score?: number;
  details?: Record<string, string>;
}

interface ComparisonSpec {
  title?: string;
  items: ComparisonItem[];
}

interface Props {
  raw: string;
  fallbackCode: string;
}

export default function ComparisonBlock({ raw, fallbackCode }: Props) {
  const theme = useSettingsStore((s) => s.theme);
  const isDark = theme !== 'light';

  const parsed = useMemo(() => {
    const r = parseLooseJson(raw);
    if (!r.ok) return { ok: false as const, error: r.error };
    const spec = r.data as ComparisonSpec;
    if (!spec.items || !Array.isArray(spec.items)) return { ok: false as const, error: 'Missing "items" array' };
    return { ok: true as const, spec };
  }, [raw]);

  if (!parsed.ok) return <BlockFallback raw={fallbackCode} error={parsed.error} />;
  const { spec } = parsed;
  const maxScore = Math.max(...spec.items.map(i => i.score || 0), 10);

  return (
    <div className="my-3 rounded-lg border border-surface-700/40 bg-surface-900/40 p-3">
      {spec.title && (
        <div className="text-base font-medium text-gray-300 mb-3">{spec.title}</div>
      )}
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(spec.items.length, 3)}, 1fr)` }}>
        {spec.items.map((item, i) => (
          <div
            key={i}
            className={`rounded-lg border p-3 ${
              item.badge
                ? (isDark ? 'border-primary-500/40 bg-primary-900/10' : 'border-primary-400/40 bg-primary-50')
                : (isDark ? 'border-surface-700/40 bg-surface-800/30' : 'border-gray-200 bg-white')
            }`}
          >
            {/* Header */}
            <div className="flex items-center justify-between mb-2">
              <span className={`text-base font-semibold ${isDark ? 'text-gray-200' : 'text-gray-800'}`}>
                {safeStr(item.name)}
              </span>
              {item.badge && (
                <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-primary-500/20 text-primary-400 font-medium">
                  {item.badge}
                </span>
              )}
            </div>

            {/* Score bar */}
            {item.score != null && (
              <div className="mb-2">
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-1.5 rounded-full bg-surface-700/40 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        item.badge ? 'bg-primary-500' : 'bg-gray-500'
                      }`}
                      style={{ width: `${(item.score / maxScore) * 100}%` }}
                    />
                  </div>
                  <span className="text-[12px] text-gray-500 font-mono w-5 text-right">{item.score}</span>
                </div>
              </div>
            )}

            {/* Pros */}
            {item.pros && item.pros.length > 0 && (
              <div className="mb-1.5">
                {item.pros.map((p, pi) => (
                  <div key={pi} className="flex items-start gap-1 text-[13px] tone-success tone-text mb-0.5">
                    <span className="flex-shrink-0 mt-0.5">+</span>
                    <span className={isDark ? 'text-gray-300' : 'text-gray-700'}>{safeStr(p)}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Cons */}
            {item.cons && item.cons.length > 0 && (
              <div>
                {item.cons.map((c, ci) => (
                  <div key={ci} className="flex items-start gap-1 text-[13px] tone-danger tone-text mb-0.5">
                    <span className="flex-shrink-0 mt-0.5">-</span>
                    <span className={isDark ? 'text-gray-400' : 'text-gray-500'}>{safeStr(c)}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Extra details */}
            {item.details && Object.keys(item.details).length > 0 && (
              <div className="mt-2 pt-1.5 border-t border-surface-700/30">
                {Object.entries(item.details).map(([k, v]) => (
                  <div key={k} className="flex justify-between text-[12px] mb-0.5">
                    <span className="text-gray-500">{k}</span>
                    <span className={isDark ? 'text-gray-300' : 'text-gray-700'}>{v}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
