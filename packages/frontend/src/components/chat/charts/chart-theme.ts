// Tower chart defaults should feel like the rest of the product: calm teal,
// slate neutrals, and semantic colors only when the data carries status meaning.
// Keep custom colors supported for explicit user-authored charts, but do not make
// rainbow categorical colors the default visual language.
export const DARK_CHART_COLORS = [
  '#14b8a6', // primary teal
  '#2dd4bf', // accent teal
  '#5eead4', // light teal
  '#86a3a2', // muted slate-teal
  '#42656a', // border slate
  '#263f43', // deep slate
];

export const LIGHT_CHART_COLORS = [
  '#0d9488', // primary teal
  '#0f766e', // strong teal
  '#14b8a6', // accent teal
  '#829c98', // muted slate-teal
  '#b9ccc8', // soft slate
  '#dfeae7', // pale surface
];

export const SEMANTIC_CHART_COLORS = {
  success: '#10b981',
  warning: '#f59e0b',
  danger: '#ef4444',
  info: '#60a5fa',
};

export const CHART_COLORS = DARK_CHART_COLORS;

export function getChartColors(custom?: string[], mode: string = 'dark'): string[] {
  if (custom && custom.length > 0) return custom;
  return mode === 'light' ? LIGHT_CHART_COLORS : DARK_CHART_COLORS;
}

export const DARK_THEME = {
  background: 'transparent',
  text: '#b2c9c8',
  grid: 'rgba(134, 163, 162, 0.22)',
  tooltip: {
    bg: '#0b171a',
    border: '#42656a',
    text: '#edf7f6',
  },
};

export const LIGHT_THEME = {
  background: 'transparent',
  text: '#4b5563',
  grid: '#e2e8f0',
  tooltip: {
    bg: '#ffffff',
    border: '#b9ccc8',
    text: '#111827',
  },
};

export function getTheme(mode: string) {
  return mode === 'light' ? LIGHT_THEME : DARK_THEME;
}
