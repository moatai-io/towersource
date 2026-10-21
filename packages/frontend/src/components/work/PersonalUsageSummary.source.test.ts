import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const summary = fs.readFileSync(path.resolve(import.meta.dirname, './PersonalUsageSummary.tsx'), 'utf8');
const timeline = fs.readFileSync(path.resolve(import.meta.dirname, './ChallengeTimelinePanel.tsx'), 'utf8');
const api = fs.readFileSync(path.resolve(import.meta.dirname, '../../../../backend/routes/api.ts'), 'utf8');
const personalUsageApi = api.slice(api.indexOf("router.get('/metrics/my-ai-usage'"), api.indexOf("router.get('/metrics/usage-heatmap'"));

describe('personal AI usage summary', () => {
  it('keeps usage metrics available without placing them above actual work progress', () => {
    expect(timeline).not.toContain('<PersonalUsageSummary />');
    expect(timeline).toContain('<WorkstreamList');
    expect(timeline).toContain("tr('challenge.timeline.currentProgress')");
    expect(summary).toContain('/api/metrics/my-ai-usage?days=');
    expect(summary).toContain("t('personalUsage.title')");
    expect(summary).toContain("t('personalUsage.estimatedCost')");
    expect(summary).toContain("t('personalUsage.heatmapTitle')");
    expect(summary).toContain('HEATMAP_LEGEND_LEVELS');
    expect(summary).toContain("t('personalUsage.legend')");
    expect(summary).toContain('hover:scale-125');
    expect(summary).toContain('bg-cyan-200/20');
    expect(summary).toContain('bg-cyan-300');
    expect(summary).toContain('scale-[0.42]');
    expect(summary).toContain("t('personalUsage.maxTurnsPerDay', { count: max })");
    expect(summary).toContain("data.costAvailable ? formatCost(data.totals.costUsd) : t('personalUsage.unavailable')");
  });

  it('scopes the backend query to the authenticated session owner', () => {
    expect(personalUsageApi).toContain("router.get('/metrics/my-ai-usage'");
    expect(personalUsageApi).toContain("const userId = (req as any).user?.userId");
    expect(personalUsageApi).toContain('WHERE s.user_id = $1');
    expect(personalUsageApi).not.toContain("router.get('/metrics/my-ai-usage', operatorOrAboveMiddleware");
    expect(personalUsageApi).toContain("m.metadata->'usage'->>'cost_usd'");
    expect(personalUsageApi).toContain("costBasis: 'message-provider-metadata'");
    expect(personalUsageApi).toContain('costAvailable: daily.some((row) => Number(row.cost_samples) > 0)');
    expect(personalUsageApi).toContain('const window = utcUsageWindow(days)');
    expect(personalUsageApi).toContain('m.created_at >= $2::timestamptz');
    expect(personalUsageApi).toContain('m.created_at < $3::timestamptz');
    expect(personalUsageApi).not.toContain('session-estimate');
    expect(personalUsageApi).not.toContain('sessionCost');
    expect(personalUsageApi).not.toContain('updated_at');
  });
});
