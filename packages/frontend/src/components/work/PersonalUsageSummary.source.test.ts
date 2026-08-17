import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const summary = fs.readFileSync(path.resolve(import.meta.dirname, './PersonalUsageSummary.tsx'), 'utf8');
const timeline = fs.readFileSync(path.resolve(import.meta.dirname, './ChallengeTimelinePanel.tsx'), 'utf8');
const api = fs.readFileSync(path.resolve(import.meta.dirname, '../../../../backend/routes/api.ts'), 'utf8');

describe('personal AI usage summary', () => {
  it('shows the authenticated user usage and estimated cost in work history', () => {
    expect(timeline).toContain('<PersonalUsageSummary />');
    expect(summary).toContain('/api/metrics/my-ai-usage?days=');
    expect(summary).toContain('내 AI 사용량');
    expect(summary).toContain('추정 비용');
    expect(summary).toContain('프로젝트별 대화 강도');
    expect(summary).toContain('HEATMAP_LEGEND_LEVELS');
    expect(summary).toContain('대화 강도 범례');
    expect(summary).toContain('hover:scale-125');
    expect(summary).toContain('bg-cyan-200/20');
    expect(summary).toContain('bg-cyan-300');
    expect(summary).toContain('scale-[0.42]');
    expect(summary).toContain('최대 {max}턴/일');
    expect(summary).toContain("data.costAvailable ? formatCost(data.totals.costUsd) : '집계 없음'");
  });

  it('scopes the backend query to the authenticated session owner', () => {
    expect(api).toContain("router.get('/metrics/my-ai-usage'");
    expect(api).toContain("const userId = (req as any).user?.userId");
    expect(api).toContain('WHERE user_id = $1');
    expect(api).toContain('WHERE s.user_id = $1');
    expect(api).not.toContain("router.get('/metrics/my-ai-usage', operatorOrAboveMiddleware");
    expect(api).toContain("m.metadata->'usage'->>'cost_usd'");
    expect(api).toContain("costBasis: dailyCost > 0 ? 'message-provider-metadata' : 'session-estimate'");
    expect(api).toContain('costAvailable: dailyCost > 0 || sessionCost > 0');
  });
});
