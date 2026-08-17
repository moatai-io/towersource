import { describe, expect, it } from 'vitest';
import { DARK_CHART_COLORS, LIGHT_CHART_COLORS, SEMANTIC_CHART_COLORS, getChartColors } from './chart-theme';

describe('Tower chart theme', () => {
  it('uses Tower teal/slate defaults instead of rainbow categorical colors', () => {
    expect(getChartColors(undefined, 'dark')).toEqual(DARK_CHART_COLORS);
    expect(getChartColors(undefined, 'light')).toEqual(LIGHT_CHART_COLORS);
    expect(DARK_CHART_COLORS.slice(0, 3)).toEqual(['#14b8a6', '#2dd4bf', '#5eead4']);
    expect(LIGHT_CHART_COLORS.slice(0, 3)).toEqual(['#0d9488', '#0f766e', '#14b8a6']);
    expect(DARK_CHART_COLORS).not.toContain('#6366f1');
    expect(DARK_CHART_COLORS).not.toContain('#ec4899');
  });

  it('keeps explicit custom chart colors and semantic status colors separate', () => {
    expect(getChartColors(['#111111'], 'dark')).toEqual(['#111111']);
    expect(SEMANTIC_CHART_COLORS).toMatchObject({
      success: '#10b981',
      warning: '#f59e0b',
      danger: '#ef4444',
      info: '#60a5fa',
    });
  });
});
