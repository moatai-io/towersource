import { useMemo, useRef, useState, useEffect } from 'react';
import { Treemap, Tooltip } from 'recharts';
import { useSettingsStore } from '../../stores/settings-store';
import { parseLooseJson } from '../shared/parse-loose-json';
import { BlockFallback } from '../shared/RichContent';
import { getTheme } from './charts/chart-theme';

interface TreeNode {
  name: string;
  value?: number;
  children?: TreeNode[];
}

interface TreemapSpec {
  title?: string;
  data: TreeNode[];
}

interface Props {
  raw: string;
  fallbackCode: string;
}

const COLORS = ['#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#06b6d4', '#84cc16'];

function flattenForRecharts(nodes: TreeNode[], depth = 0): any[] {
  return nodes.map((n, i) => {
    if (n.children && n.children.length > 0) {
      return { name: n.name, children: flattenForRecharts(n.children, depth + 1) };
    }
    return { name: n.name, size: n.value || 0, fill: COLORS[(depth + i) % COLORS.length] };
  });
}

function useContainerWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(400);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (w && w > 0) setWidth(Math.floor(w));
    });
    ro.observe(el);
    setWidth(el.clientWidth || 400);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

export default function TreemapBlock({ raw, fallbackCode }: Props) {
  const theme = useSettingsStore((s) => s.theme);
  const t = getTheme(theme);
  const { ref, width } = useContainerWidth();

  const parsed = useMemo(() => {
    const r = parseLooseJson(raw);
    if (!r.ok) return { ok: false as const, error: r.error };
    const spec = r.data as TreemapSpec;
    if (!spec.data || !Array.isArray(spec.data)) return { ok: false as const, error: 'Missing "data" array' };
    return { ok: true as const, spec };
  }, [raw]);

  if (!parsed.ok) return <BlockFallback raw={fallbackCode} error={parsed.error} />;
  const { spec } = parsed;

  const treeData = useMemo(() => flattenForRecharts(spec.data), [spec.data]);

  const tooltipStyle = {
    contentStyle: { backgroundColor: t.tooltip.bg, border: `1px solid ${t.tooltip.border}`, borderRadius: 8, fontSize: 12 },
    labelStyle: { color: t.tooltip.text, fontWeight: 600 },
  };

  return (
    <div ref={ref} className="my-3 rounded-lg border border-surface-700/40 bg-surface-900/40 p-3">
      {spec.title && (
        <div className="text-base font-medium text-gray-300 mb-2 px-1">{spec.title}</div>
      )}
      <Treemap
        width={width}
        height={250}
        data={treeData}
        dataKey="size"
        aspectRatio={4 / 3}
        stroke={t.grid}
        content={({ x, y, width: w, height: h, name, fill }: any) => (
          <g>
            <rect x={x} y={y} width={w} height={h} fill={fill || '#8b5cf6'} stroke={t.grid} strokeWidth={1} rx={2} />
            {w > 40 && h > 18 && (
              <text x={x + w / 2} y={y + h / 2} textAnchor="middle" dominantBaseline="central" fill="#fff" fontSize={11} fontWeight={500}>
                {name}
              </text>
            )}
          </g>
        )}
      >
        <Tooltip {...tooltipStyle} />
      </Treemap>
    </div>
  );
}
