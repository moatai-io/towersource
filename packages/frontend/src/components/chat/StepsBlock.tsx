import { useMemo, useState } from 'react';
import { useSettingsStore } from '../../stores/settings-store';
import { parseLooseJson, safeStr } from '../shared/parse-loose-json';
import { BlockFallback } from '../shared/RichContent';

interface StepItem {
  title: string;
  desc?: string;
  description?: string;
  status?: 'done' | 'active' | 'pending' | 'error';
}

interface StepsSpec {
  title?: string;
  current?: number;
  steps: StepItem[];
}

interface Props {
  raw: string;
  fallbackCode: string;
}

const STATUS_ICON: Record<string, { icon: string; tone: string }> = {
  done:    { icon: '✓', tone: 'tone-success' },
  active:  { icon: '●', tone: 'tone-accent' },
  pending: { icon: '', tone: 'tone-muted' },
  error:   { icon: '✗', tone: 'tone-danger' },
};

export default function StepsBlock({ raw, fallbackCode }: Props) {
  const theme = useSettingsStore((s) => s.theme);
  const isDark = theme !== 'light';
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const parsed = useMemo(() => {
    const r = parseLooseJson(raw);
    if (!r.ok) return { ok: false as const, error: r.error };
    const spec = r.data as StepsSpec;
    if (!spec.steps || !Array.isArray(spec.steps)) return { ok: false as const, error: 'Missing "steps" array' };
    // Apply current index if statuses not explicitly set
    if (spec.current != null) {
      spec.steps = spec.steps.map((s, i) => ({
        ...s,
        status: s.status || (i < spec.current! ? 'done' : i === spec.current! ? 'active' : 'pending'),
      }));
    }
    return { ok: true as const, spec };
  }, [raw]);

  if (!parsed.ok) return <BlockFallback raw={fallbackCode} error={parsed.error} />;
  const { spec } = parsed;

  return (
    <div className="my-3 rounded-lg border border-surface-700/40 bg-surface-900/40 p-4">
      {spec.title && (
        <div className="text-ui-block-size font-medium text-gray-300 mb-3">{spec.title}</div>
      )}
      <div className="flex items-start gap-0 overflow-x-auto">
        {spec.steps.map((step, i) => {
          const status = step.status || 'pending';
          const st = STATUS_ICON[status] || STATUS_ICON.pending;
          const desc = step.desc || step.description;
          const isExpanded = expandedIdx === i;
          const isLast = i === spec.steps.length - 1;

          return (
            <div key={i} className="flex items-start flex-shrink-0" style={{ minWidth: 120 }}>
              {/* Step node */}
              <div
                className="flex flex-col items-center cursor-pointer"
                onClick={() => setExpandedIdx(isExpanded ? null : i)}
              >
                <div
                  className={`w-7 h-7 rounded-full flex items-center justify-center text-ui-block-meta-size font-bold border-2 ${st.tone} ${
                    status === 'active' ? 'tone-node animate-pulse ring-2 ring-primary-500/30' : status === 'done' || status === 'error' ? 'tone-node' : 'tone-pill'
                  }`}
                >
                  {st.icon || (i + 1)}
                </div>
                <div className={`mt-1.5 text-center max-w-[100px] ${
                  status === 'active'
                    ? 'text-primary-400 font-medium'
                    : status === 'done'
                    ? (isDark ? 'text-gray-300' : 'text-gray-700')
                    : (isDark ? 'text-gray-500' : 'text-gray-400')
                }`}>
                  <div className="text-ui-block-size leading-tight">{safeStr(step.title)}</div>
                  {isExpanded && desc && (
                    <div className={`text-ui-block-meta-size mt-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                      {desc}
                    </div>
                  )}
                </div>
              </div>
              {/* Connector line */}
              {!isLast && (
                <div className="flex-1 min-w-[24px] flex items-center mt-3.5 px-1">
                  <div className={`h-0.5 w-full ${
                    status === 'done' ? 'tone-success tone-line' : 'bg-surface-700/60'
                  }`} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
