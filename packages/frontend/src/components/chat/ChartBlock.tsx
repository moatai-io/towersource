import { useMemo, useRef, useState, useEffect } from 'react';
import {
  BarChart, Bar,
  LineChart, Line,
  AreaChart, Area,
  PieChart, Pie, Cell,
  ScatterChart, Scatter,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  ComposedChart,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { useSettingsStore } from '../../stores/settings-store';
import { parseLooseJson } from '../shared/parse-loose-json';
import { BlockFallback } from '../shared/RichContent';
import { getChartColors, getTheme } from './charts/chart-theme';
import { inferKeys, fmtNumber } from './charts/chart-utils';

interface ChartSpec {
  type: string;
  title?: string;
  data: Record<string, any>[];
  xKey?: string;
  yKey?: string | string[];
  horizontal?: boolean;
  stacked?: boolean;
  colors?: string[];
}

interface ChartBlockProps {
  raw: string;
  fallbackCode: string;
}

/** Use ResizeObserver instead of Recharts' ResponsiveContainer to avoid
 *  context-null errors when lazy-loaded inside Suspense boundaries. */
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

export default function ChartBlock({ raw, fallbackCode }: ChartBlockProps) {
  const theme = useSettingsStore((s) => s.theme);
  const isLight = theme === 'light';
  const t = getTheme(theme);
  const { ref: containerRef, width: chartWidth } = useContainerWidth();

  const parsed = useMemo(() => {
    const result = parseLooseJson(raw);
    if (!result.ok) return { ok: false as const, error: result.error };
    const spec = result.data as ChartSpec;
    if (!spec.data || !Array.isArray(spec.data)) {
      return { ok: false as const, error: 'Missing or invalid "data" array' };
    }
    if (!spec.type) {
      return { ok: false as const, error: 'Missing "type" field' };
    }
    return { ok: true as const, spec };
  }, [raw]);

  if (!parsed.ok) {
    return <BlockFallback raw={fallbackCode} error={parsed.error} />;
  }

  const { spec } = parsed;
  const colors = getChartColors(spec.colors, theme);
  const { xKey, yKeys: inferredYKeys } = inferKeys(spec.data);
  const resolvedXKey = spec.xKey || xKey;
  const resolvedYKeys = spec.yKey
    ? (Array.isArray(spec.yKey) ? spec.yKey : [spec.yKey])
    : inferredYKeys;

  const tooltipStyle = {
    contentStyle: { backgroundColor: t.tooltip.bg, border: `1px solid ${t.tooltip.border}`, borderRadius: 8, fontSize: 12 },
    labelStyle: { color: t.tooltip.text, fontWeight: 600 },
    itemStyle: { color: t.tooltip.text },
  };

  const commonAxisProps = {
    tick: { fill: t.text, fontSize: 11 },
    axisLine: { stroke: t.grid },
    tickLine: { stroke: t.grid },
  };
  const legendProps = {
    wrapperStyle: { color: t.text, fontSize: 12 },
  };

  const dims = { width: chartWidth, height: 280 };

  function renderChart(): React.ReactElement {
    switch (spec.type) {
      case 'bar': {
        const layout = spec.horizontal ? 'vertical' as const : 'horizontal' as const;
        return (
          <BarChart {...dims} data={spec.data} layout={layout}>
            <CartesianGrid strokeDasharray="3 3" stroke={t.grid} />
            {layout === 'vertical' ? (
              <>
                <XAxis type="number" {...commonAxisProps} tickFormatter={fmtNumber} />
                <YAxis type="category" dataKey={resolvedXKey} {...commonAxisProps} width={80} />
              </>
            ) : (
              <>
                <XAxis dataKey={resolvedXKey} {...commonAxisProps} />
                <YAxis {...commonAxisProps} tickFormatter={fmtNumber} />
              </>
            )}
            <Tooltip {...tooltipStyle} />
            {resolvedYKeys.length > 1 && <Legend {...legendProps} />}
            {resolvedYKeys.map((key, i) => (
              <Bar key={key} dataKey={key} fill={colors[i % colors.length]} stackId={spec.stacked ? 'stack' : undefined} radius={[4, 4, 0, 0]} />
            ))}
          </BarChart>
        );
      }

      case 'line':
        return (
          <LineChart {...dims} data={spec.data}>
            <CartesianGrid strokeDasharray="3 3" stroke={t.grid} />
            <XAxis dataKey={resolvedXKey} {...commonAxisProps} />
            <YAxis {...commonAxisProps} tickFormatter={fmtNumber} />
            <Tooltip {...tooltipStyle} />
            {resolvedYKeys.length > 1 && <Legend {...legendProps} />}
            {resolvedYKeys.map((key, i) => (
              <Line key={key} type="monotone" dataKey={key} stroke={colors[i % colors.length]} strokeWidth={2} dot={{ r: 3 }} />
            ))}
          </LineChart>
        );

      case 'area':
        return (
          <AreaChart {...dims} data={spec.data}>
            <CartesianGrid strokeDasharray="3 3" stroke={t.grid} />
            <XAxis dataKey={resolvedXKey} {...commonAxisProps} />
            <YAxis {...commonAxisProps} tickFormatter={fmtNumber} />
            <Tooltip {...tooltipStyle} />
            {resolvedYKeys.length > 1 && <Legend {...legendProps} />}
            {resolvedYKeys.map((key, i) => (
              <Area key={key} type="monotone" dataKey={key} stroke={colors[i % colors.length]} fill={colors[i % colors.length]} fillOpacity={0.15} stackId={spec.stacked ? 'stack' : undefined} />
            ))}
          </AreaChart>
        );

      case 'pie':
        return (
          <PieChart {...dims}>
            <Pie
              data={spec.data}
              dataKey={resolvedYKeys[0]}
              nameKey={resolvedXKey}
              cx="50%" cy="50%"
              outerRadius="80%"
              label={({ name, percent, x, y, textAnchor }: any) => (
                <text x={x} y={y} textAnchor={textAnchor} fill={t.text} fontSize={11} fontWeight={500}>
                  {`${name ?? ''} ${((percent ?? 0) * 100).toFixed(0)}%`}
                </text>
              )}
              labelLine={{ stroke: t.text }}
            >
              {spec.data.map((_, i) => (
                <Cell key={i} fill={colors[i % colors.length]} />
              ))}
            </Pie>
            <Tooltip {...tooltipStyle} />
          </PieChart>
        );

      case 'scatter':
        return (
          <ScatterChart {...dims}>
            <CartesianGrid strokeDasharray="3 3" stroke={t.grid} />
            <XAxis dataKey={resolvedXKey} {...commonAxisProps} name={resolvedXKey} />
            <YAxis dataKey={resolvedYKeys[0]} {...commonAxisProps} name={resolvedYKeys[0]} />
            <Tooltip {...tooltipStyle} />
            <Scatter data={spec.data} fill={colors[0]} />
          </ScatterChart>
        );

      case 'radar':
        return (
          <RadarChart {...dims} data={spec.data} cx="50%" cy="50%" outerRadius="80%">
            <PolarGrid stroke={t.grid} />
            <PolarAngleAxis dataKey={resolvedXKey} tick={{ fill: t.text, fontSize: 11 }} />
            <PolarRadiusAxis tick={{ fill: t.text, fontSize: 10 }} />
            {resolvedYKeys.map((key, i) => (
              <Radar key={key} dataKey={key} stroke={colors[i % colors.length]} fill={colors[i % colors.length]} fillOpacity={0.2} />
            ))}
            <Tooltip {...tooltipStyle} />
            {resolvedYKeys.length > 1 && <Legend {...legendProps} />}
          </RadarChart>
        );

      case 'composed':
        return (
          <ComposedChart {...dims} data={spec.data}>
            <CartesianGrid strokeDasharray="3 3" stroke={t.grid} />
            <XAxis dataKey={resolvedXKey} {...commonAxisProps} />
            <YAxis {...commonAxisProps} tickFormatter={fmtNumber} />
            <Tooltip {...tooltipStyle} />
            <Legend {...legendProps} />
            {resolvedYKeys.map((key, i) => {
              if (i === 0) return <Bar key={key} dataKey={key} fill={colors[0]} radius={[4, 4, 0, 0]} />;
              return <Line key={key} type="monotone" dataKey={key} stroke={colors[i % colors.length]} strokeWidth={2} />;
            })}
          </ComposedChart>
        );

      default:
        return <BlockFallback raw={fallbackCode} error={`Unknown chart type: ${spec.type}`} />;
    }
  }

  return (
    <div ref={containerRef} className="my-3 rounded-lg border border-surface-700/40 bg-surface-900/40 p-3">
      {spec.title && (
        <div className={`text-base font-medium mb-2 px-1 ${isLight ? 'text-gray-700' : 'text-gray-300'}`}>{spec.title}</div>
      )}
      {renderChart()}
    </div>
  );
}
